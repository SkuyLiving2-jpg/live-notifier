const fs = require("fs");
const path = require("path");

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const IDN_API_URL = "https://api.idn.app/graphql";
const POLL_INTERVAL_MS = 30000;

// CACHE_DIR bisa di-override lewat environment variable (misalnya diarahkan
// ke mount point Railway Volume) biar cache-nya tahan lintas redeploy juga.
// Kalau nggak diset, default-nya folder data/ di root project.
const CACHE_DIR = process.env.CACHE_DIR || path.join(__dirname, "..", "data");
const CACHE_FILE = path.join(CACHE_DIR, "active-lives-cache.json");
const DURATION_HISTORY_FILE = path.join(CACHE_DIR, "live-duration-history.json");

// Token bot Discord buat fitur tanya-jawab interaktif (opsional). Beda sama
// DISCORD_WEBHOOK_URL yang cuma bisa kirim, bukan baca pesan. Kalau nggak
// diset, notifikasi tetap jalan normal, cuma fitur tanya-jawabnya mati.
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || "";

// Perkiraan "kemungkinan mendekati akhir" buat member prioritas dipicu kalau
// durasi live udah ngelewatin ambang ini (kalau belum ada riwayat durasi
// buat member itu). Bisa di-override lewat env var, satuannya menit.
const DEFAULT_ENDING_SOON_THRESHOLD_MS = (Number(process.env.ENDING_SOON_THRESHOLD_MINUTES) || 40) * 60 * 1000;

if (!DISCORD_WEBHOOK_URL) {
  console.error("DISCORD_WEBHOOK_URL belum diset di environment variable. Bot berhenti.");
  process.exit(1);
}

// Kalau ada member JKT48 yang nama/bio IDN-nya kebetulan nggak nyantumin
// kata "JKT48", tambahin username IDN-nya di sini biar tetap kedeteksi.
const JKT48_USERNAME_WHITELIST = [
  // "username_idn_member",
];

// Member prioritas: notifikasinya dibikin jauh lebih flashy/urgent (embed +
// opsional mention) dibanding member JKT48 lain. Diurutkan dari yang paling
// emergency ke bawah - urutan ini nentuin intensitas warna & tone pesannya.
const PRIORITY_MEMBERS = [
  { rank: 1, keyword: "nala", label: "NALA", color: 0xff0000, sirens: "🚨🔥🚨" },
  { rank: 2, keyword: "levi", label: "LEVI", color: 0xff8c00, sirens: "🚨⚡🚨" },
  { rank: 3, keyword: "lily", label: "LILY", color: 0xffd700, sirens: "🚨✨🚨" },
];

// ID user Discord yang mau di-mention khusus buat notif prioritas (opsional).
// Cara dapetinnya: di Discord, aktifin Developer Mode di Settings > Advanced,
// terus klik kanan nama kamu sendiri > Copy User ID.
const PRIORITY_PING_USER_ID = process.env.PRIORITY_PING_USER_ID || "";

function getPriorityConfig(memberName, username) {
  const text = `${memberName || ""} ${username || ""}`.toLowerCase();
  return PRIORITY_MEMBERS.find((p) => text.includes(p.keyword)) || null;
}

// Cache buat nyimpen member yang lagi live: username -> { name, username, slug }
// Disimpan juga ke file (CACHE_FILE) biar kalau proses restart (crash, atau
// container-nya di-restart), bot nggak ngirim ulang notif "mulai live" buat
// member yang sebenernya udah live dari sebelum restart.
function loadActiveLives() {
  try {
    const raw = fs.readFileSync(CACHE_FILE, "utf-8");
    return new Map(Object.entries(JSON.parse(raw)));
  } catch (error) {
    return new Map();
  }
}

function saveActiveLives() {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(Object.fromEntries(activeLives), null, 2));
  } catch (error) {
    console.error("Gagal nyimpen cache ke file:", error.message);
  }
}

const activeLives = loadActiveLives();

// Riwayat durasi live per username (dalam ms), disimpan biar bisa dipakai
// ngitung rata-rata durasi live seseorang - dasar buat nebak "kemungkinan
// mendekati akhir". Cuma nyimpen 10 data terakhir per orang biar file-nya
// nggak membengkak dan makin relevan sama pola live terbarunya.
function loadDurationHistory() {
  try {
    const raw = fs.readFileSync(DURATION_HISTORY_FILE, "utf-8");
    return JSON.parse(raw);
  } catch (error) {
    return {};
  }
}

function saveDurationHistory(history) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(DURATION_HISTORY_FILE, JSON.stringify(history, null, 2));
  } catch (error) {
    console.error("Gagal nyimpen riwayat durasi:", error.message);
  }
}

function recordLiveDuration(username, durationMs) {
  const history = loadDurationHistory();
  const list = history[username] || [];
  list.push(durationMs);
  history[username] = list.slice(-10);
  saveDurationHistory(history);
}

function getAverageDuration(durationHistory, username) {
  const list = durationHistory[username] || [];
  if (list.length === 0) return null;
  return list.reduce((total, ms) => total + ms, 0) / list.length;
}

function formatDuration(ms) {
  const totalMinutes = Math.max(0, Math.floor(ms / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}j ${minutes}m` : `${minutes}m`;
}

function isJkt48Member(creator) {
  if (!creator) return false;
  if (JKT48_USERNAME_WHITELIST.includes(creator.username)) return true;

  const text = `${creator.name || ""} ${creator.bio_description || ""}`.toLowerCase();
  return text.includes("jkt48");
}

// getLivestreams IDN itu di-paging (halaman 1 cuma nampilin ~12 live
// teratas). Kalo cuma ambil halaman pertama, live yang penontonnya sedikit
// (biasanya yang lebih baru mulai) bisa nangkring di halaman 2+ dan nggak
// pernah kedeteksi. Jadi kita ambil terus tiap halaman sampai kosong.
const MAX_LIVESTREAM_PAGES = 20; // jaga-jaga biar nggak infinite loop

async function fetchAllLivestreams() {
  const query = `
    query GetLivestreams($page: Int) {
      getLivestreams(page: $page) {
        creator {
          username
          name
          bio_description
        }
        title
        slug
        live_at
        view_count
      }
    }
  `;

  const allLives = [];

  for (let page = 1; page <= MAX_LIVESTREAM_PAGES; page++) {
    const response = await fetch(IDN_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables: { page } }),
    });

    if (!response.ok) {
      throw new Error(`IDN API balikin status ${response.status} (halaman ${page})`);
    }

    const result = await response.json();

    if (result.errors) {
      throw new Error(`GraphQL error (halaman ${page}): ${JSON.stringify(result.errors)}`);
    }

    const lives = result?.data?.getLivestreams || [];
    if (lives.length === 0) break; // udah abis halamannya

    allLives.push(...lives);
  }

  return allLives;
}

async function checkLiveMembers() {
  try {
    const currentLives = await fetchAllLivestreams();
    const currentLiveUsernames = new Set();
    // Dibaca sekali per siklus polling (bukan sekali per member yang live)
    // biar nggak buka file yang sama berkali-kali kalau lagi banyak yang live.
    const durationHistory = loadDurationHistory();

    for (const live of currentLives) {
      const username = live?.creator?.username;
      if (!username) continue; // skip entry yang datanya nggak lengkap
      if (!isJkt48Member(live.creator)) continue; // cuma peduli member JKT48

      currentLiveUsernames.add(username);

      // Kirim notif cuma kalo member baru mulai live
      if (!activeLives.has(username)) {
        const terkirim = await sendDiscordNotif(live.creator.name, live.creator.username, live.slug, "start");
        if (terkirim) {
          activeLives.set(username, {
            name: live.creator.name,
            username,
            slug: live.slug,
            liveAt: live.live_at,
            viewCount: live.view_count,
            endingSoonAlerted: false,
          });
          saveActiveLives();
        }
        // kalau gagal kirim, username sengaja nggak ditambahin
        // biar dicoba lagi di polling berikutnya
      } else {
        // udah live dari sebelumnya - update data terbaru & cek heuristik
        // "kemungkinan mendekati akhir" (cuma buat member prioritas)
        const entry = activeLives.get(username);
        entry.viewCount = live.view_count;
        await maybeAlertEndingSoon(entry, durationHistory);
      }
    }

    // Kirim notif "sudah selesai" + bersihkan cache kalau member udah selesai live
    for (const [username, memberData] of activeLives) {
      if (!currentLiveUsernames.has(username)) {
        const terkirim = await sendDiscordNotif(memberData.name, memberData.username, memberData.slug, "end");
        if (terkirim) {
          if (memberData.liveAt) {
            const durationMs = Date.now() - new Date(memberData.liveAt).getTime();
            recordLiveDuration(username, durationMs);
          }
          activeLives.delete(username);
          saveActiveLives();
        }
        // kalau gagal kirim, sengaja nggak dihapus dari cache
        // biar dicoba lagi di polling berikutnya
      }
    }
  } catch (error) {
    console.error("Gagal ngecek IDN Live:", error.message);
  }
}

function buildNormalPayload(memberName, liveUrl, status) {
  return status === "end"
    ? { content: `✅ **${memberName}** udah selesai live di IDN Live.` }
    : { content: `🚨 **${memberName}** lagi live di IDN Live!\nNonton di sini: ${liveUrl}` };
}

function buildPriorityPayload(memberName, liveUrl, status, priority) {
  const mention = PRIORITY_PING_USER_ID ? `<@${PRIORITY_PING_USER_ID}> ` : "";

  if (status === "end") {
    return {
      content: `${mention}${priority.sirens} Live prioritas **#${priority.rank} ${priority.label}** udah selesai.`,
      embeds: [
        {
          title: `${priority.label} sudah selesai live`,
          description: memberName,
          color: priority.color,
          url: liveUrl,
        },
      ],
    };
  }

  return {
    content: `${mention}${priority.sirens.repeat(2)} **JANGAN SAMPE KETINGGALAN!** ${priority.sirens.repeat(2)}`,
    embeds: [
      {
        title: `⚡ PRIORITAS #${priority.rank}: ${priority.label} LIVE SEKARANG! ⚡`,
        description: `**${memberName}** baru aja mulai live di IDN Live.\n\n[🔴 **TONTON SEKARANG**](${liveUrl})`,
        url: liveUrl,
        color: priority.color,
        footer: { text: "IDN Live Priority Alert" },
        timestamp: new Date().toISOString(),
      },
    ],
  };
}

async function sendDiscordNotif(memberName, username, slug, status = "start") {
  // Tanpa "www" biar konsisten sama link yang di-generate tombol Share di
  // app IDN sendiri (lebih besar kemungkinan ke-handle sebagai App
  // Link/Universal Link, alias langsung buka app di HP kalau appnya
  // udah ke-install, bukan buka browser).
  const liveUrl = `https://idn.app/${username}/live/${slug}`;
  const priority = getPriorityConfig(memberName, username);
  const payload = priority
    ? buildPriorityPayload(memberName, liveUrl, status, priority)
    : buildNormalPayload(memberName, liveUrl, status);

  try {
    const response = await fetch(DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`Discord webhook balikin status ${response.status}`);
    }

    console.log(`Notif ${status} terkirim untuk ${memberName}`);
    return true;
  } catch (error) {
    console.error("Gagal ngirim notif ke Discord:", error.message);
    return false;
  }
}

// PENTING: ini PERKIRAAN, bukan deteksi beneran. API IDN nggak nyediain data
// gift/podium sama sekali, jadi kita cuma bisa nebak dari durasi live
// dibanding rata-rata durasi live orang itu sebelumnya (atau ambang default
// kalau belum ada riwayat). Bisa aja meleset - dipicu sekali doang per sesi
// live biar nggak spam.
async function maybeAlertEndingSoon(entry, durationHistory) {
  const priority = getPriorityConfig(entry.name, entry.username);
  if (!priority) return; // heuristik ini cuma buat 3 member prioritas
  if (entry.endingSoonAlerted || !entry.liveAt) return;

  const elapsedMs = Date.now() - new Date(entry.liveAt).getTime();
  const avgMs = getAverageDuration(durationHistory, entry.username);
  const thresholdMs = avgMs ? avgMs * 0.8 : DEFAULT_ENDING_SOON_THRESHOLD_MS;

  if (elapsedMs >= thresholdMs) {
    entry.endingSoonAlerted = true;
    saveActiveLives();
    await sendEndingSoonAlert(entry, priority, elapsedMs, avgMs);
  }
}

async function sendEndingSoonAlert(entry, priority, elapsedMs, avgMs) {
  const mention = PRIORITY_PING_USER_ID ? `<@${PRIORITY_PING_USER_ID}> ` : "";
  const liveUrl = `https://idn.app/${entry.username}/live/${entry.slug}`;
  const elapsedText = formatDuration(elapsedMs);
  const basis = avgMs
    ? `rata-rata live dia biasanya ${formatDuration(avgMs)}`
    : `belum ada cukup riwayat, pakai perkiraan umum ${formatDuration(DEFAULT_ENDING_SOON_THRESHOLD_MS)}`;

  const payload = {
    content: `${mention}${priority.sirens} **${priority.label} udah live ${elapsedText}** - kemungkinan mendekati akhir/mau baca podium (${basis}). Ini perkiraan doang, bisa meleset!`,
    embeds: [
      {
        title: `⏳ Kemungkinan ${priority.label} bakal segera akhirin live`,
        description: `**PERKIRAAN, bukan kepastian** - cek langsung buat mastiin.\n\n[🔴 **BUKA LIVE-NYA**](${liveUrl})`,
        color: priority.color,
        footer: { text: "Heuristik durasi live, bisa meleset" },
        timestamp: new Date().toISOString(),
      },
    ],
  };

  try {
    const response = await fetch(DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      throw new Error(`Discord webhook balikin status ${response.status}`);
    }
    console.log(`Alert 'ending soon' terkirim untuk ${entry.name}`);
  } catch (error) {
    console.error("Gagal ngirim alert ending-soon:", error.message);
  }
}

// Jalankan polling tiap 30 detik (self-scheduling biar nggak tumpang tindih
// kalau checkLiveMembers kebetulan lebih lambat dari interval-nya)
async function pollLoop() {
  await checkLiveMembers();
  setTimeout(pollLoop, POLL_INTERVAL_MS);
}

// Railway (dan platform hosting sejenis) ngecek apakah service "sehat" dengan
// nunggu ada port yang kebuka. Bot ini murni background process tanpa server
// HTTP, jadi tanpa ini Railway bisa nganggep container-nya nggak sehat dan
// restart terus-menerus. Server kecil ini cuma buat "ngasih tanda hidup".
const PORT = process.env.PORT || 3000;
require("http")
  .createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("JKT48 IDN Live notifier is running.\n");
  })
  .listen(PORT, () => {
    console.log(`Health check server listening on port ${PORT}`);
  });

// Kata kunci buat manggil bot di chat (contoh: "Cok, ini yang masih live
// siapa aja?"). Pesan yang nggak nyebut salah satu kata ini bakal diabaikan,
// biar bot nggak ikut respon ke obrolan biasa di channel.
const CHAT_WAKE_WORDS = ["cok"];

function getSortedActiveLives() {
  return [...activeLives.values()].sort((a, b) => new Date(a.liveAt) - new Date(b.liveAt));
}

// Di bawah 30 menit dianggap "baru live", 30 menit ke atas "udah live".
const NEW_LIVE_THRESHOLD_MS = 30 * 60000;

function describeElapsed(ms) {
  const prefix = ms < NEW_LIVE_THRESHOLD_MS ? "baru live" : "udah live";
  return `${prefix} ${formatDuration(ms)}`;
}

function replyListLive() {
  const sorted = getSortedActiveLives();
  if (sorted.length === 0) return "Cok, lagi nggak ada member JKT48 yang live nih.";

  const lines = sorted.map((entry, i) => {
    const elapsedText = describeElapsed(Date.now() - new Date(entry.liveAt).getTime());
    const viewText = entry.viewCount != null ? ` | 👁️ ${entry.viewCount}` : "";
    return `${i + 1}. **${entry.name}** - ${elapsedText}${viewText}`;
  });

  return `Cok, ini yang lagi live (urut dari paling lama):\n${lines.join("\n")}`;
}

function replyLongestLive() {
  const sorted = getSortedActiveLives();
  if (sorted.length === 0) return "Cok, lagi nggak ada yang live.";
  const longest = sorted[0];
  const elapsedText = describeElapsed(Date.now() - new Date(longest.liveAt).getTime());
  return `Yang paling lama live sekarang: **${longest.name}**, ${elapsedText}.`;
}

function replyBotStatus() {
  return `✅ Bot jalan normal. Lagi mantau ${activeLives.size} member yang live sekarang.`;
}

function replySpecificMember(entry) {
  const elapsedText = describeElapsed(Date.now() - new Date(entry.liveAt).getTime());
  const liveUrl = `https://idn.app/${entry.username}/live/${entry.slug}`;
  return `**${entry.name}** lagi live, ${elapsedText}. ${liveUrl}`;
}

function replyHelp() {
  return [
    "Cok bisa jawab ini:",
    '- "cok ini yang masih live siapa aja?"',
    '- "cok siapa yang paling lama live?"',
    '- "cok status"',
    '- "cok <nama member> masih live?"',
  ].join("\n");
}

function buildChatReply(rawContent) {
  const text = (rawContent || "").toLowerCase();
  const isAddressedToBot = CHAT_WAKE_WORDS.some((w) => text.includes(w));
  if (!isAddressedToBot) return null;

  if (text.includes("live") && (text.includes("paling lama") || text.includes("udah lama"))) {
    return replyLongestLive();
  }

  if (text.includes("live") && (text.includes("siapa") || text.includes("list") || text.includes("apa aja") || text.includes("ada berapa"))) {
    return replyListLive();
  }

  if (text.includes("status") || text.includes("sehat") || text.includes("masih jalan")) {
    return replyBotStatus();
  }

  if (text.includes("help") || text.includes("bantuan") || text.includes("bisa apa")) {
    return replyHelp();
  }

  for (const entry of activeLives.values()) {
    if (entry.name && text.includes(entry.name.toLowerCase()) && text.includes("live")) {
      return replySpecificMember(entry);
    }
  }

  return null;
}

// Fitur tanya-jawab ini opsional - kalau DISCORD_BOT_TOKEN nggak diset,
// notifikasi tetap jalan normal, cuma bot nggak bisa dichat.
if (DISCORD_BOT_TOKEN) {
  const { Client, GatewayIntentBits } = require("discord.js");
  const chatClient = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  });

  chatClient.once("ready", () => {
    console.log(`Bot tanya-jawab login sebagai ${chatClient.user.tag}`);
  });

  chatClient.on("messageCreate", async (message) => {
    try {
      if (message.author.bot) return;
      const reply = buildChatReply(message.content);
      if (reply) await message.reply(reply);
    } catch (error) {
      console.error("Gagal balas chat:", error.message);
    }
  });

  chatClient.login(DISCORD_BOT_TOKEN).catch((error) => {
    console.error("Gagal login bot Discord (cek DISCORD_BOT_TOKEN):", error.message);
  });
} else {
  console.log("DISCORD_BOT_TOKEN nggak diset - fitur tanya-jawab dimatiin (notifikasi tetap jalan normal).");
}

console.log("Bot notifikasi IDN Live jalan...");
pollLoop();
