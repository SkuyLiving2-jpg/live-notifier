const fs = require("fs");
const path = require("path");
const { requireSignedRequest } = require("./security");

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const IDN_API_URL = "https://api.idn.app/graphql";
const POLL_INTERVAL_MS = 30000;

// Secret buat sistem signature (API_KEY + HMAC-SHA256) yang ngelindungin
// endpoint API kita dari akses sembarangan - dipakai kalau nanti nambah
// endpoint yang nyajiin data (bukan buat health-check, itu sengaja tetap
// publik biar Railway/UptimeRobot bisa akses tanpa signature).
const API_SECRET = process.env.API_SECRET || "";

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

// Opsional - ID channel Discord tempat bot boleh lebih "agresif" balas
// (hampir semua pesan yang gak dikenali dibalas menu options, gak perlu
// nyebut "cok"/"live"). Channel lain tetap butuh wake word biar gak ganggu
// obrolan biasa. Cara dapetin ID channel: Developer Mode di Discord Settings
// > Advanced, terus klik kanan nama channel-nya > Copy Channel ID.
const BOT_CHANNEL_ID = process.env.BOT_CHANNEL_ID || "";

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
// terus klik kanan nama kamu sendiri > Copy User ID. ID yang sama ini juga
// dipake buat nentuin siapa "owner" yang boleh kelola daftar prioritas lewat chat.
const PRIORITY_PING_USER_ID = process.env.PRIORITY_PING_USER_ID || "";

// Fitur: owner bisa nambah/hapus member prioritas lewat chat ("cok tambah
// prioritas <nama>") tanpa perlu ubah kode. Yang custom disimpen di file
// terpisah dari 3 bawaan (Nala/Levi/Lily), jadi ketiga itu nggak bisa
// kehapus via chat. Di-cache di memori biar nggak baca file berkali-kali
// tiap kali dicek (sama kayak fix performa riwayat durasi sebelumnya).
const CUSTOM_PRIORITY_FILE = path.join(CACHE_DIR, "custom-priority.json");
const PRIORITY_COLOR_PALETTE = [0x1abc9c, 0x9b59b6, 0x3498db, 0x2ecc71, 0xe91e63];
let customPriorityCache = null;

function loadCustomPriorityMembers() {
  if (customPriorityCache === null) {
    try {
      customPriorityCache = JSON.parse(fs.readFileSync(CUSTOM_PRIORITY_FILE, "utf-8"));
    } catch (error) {
      customPriorityCache = [];
    }
  }
  return customPriorityCache;
}

function saveCustomPriorityMembers(list) {
  customPriorityCache = list;
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(CUSTOM_PRIORITY_FILE, JSON.stringify(list, null, 2));
  } catch (error) {
    console.error("Gagal nyimpen daftar prioritas custom:", error.message);
  }
}

function getAllPriorityMembers() {
  return [...PRIORITY_MEMBERS, ...loadCustomPriorityMembers()];
}

function addCustomPriorityMember(rawKeyword) {
  const keyword = (rawKeyword || "").trim().toLowerCase();
  if (!keyword) return { ok: false, reason: "empty" };

  const all = getAllPriorityMembers();
  if (all.some((p) => p.keyword === keyword)) return { ok: false, reason: "exists" };

  const custom = loadCustomPriorityMembers();
  custom.push({
    rank: all.length + 1,
    keyword,
    label: keyword.toUpperCase(),
    color: PRIORITY_COLOR_PALETTE[custom.length % PRIORITY_COLOR_PALETTE.length],
    sirens: "🚨💥🚨",
  });
  saveCustomPriorityMembers(custom);
  return { ok: true };
}

function removeCustomPriorityMember(rawKeyword) {
  const keyword = (rawKeyword || "").trim().toLowerCase();
  const custom = loadCustomPriorityMembers();
  const filtered = custom.filter((p) => p.keyword !== keyword);
  if (filtered.length === custom.length) return { ok: false, reason: "not_found" };
  saveCustomPriorityMembers(filtered);
  return { ok: true };
}

function getPriorityConfig(memberName, username) {
  const text = `${memberName || ""} ${username || ""}`.toLowerCase();
  return getAllPriorityMembers().find((p) => text.includes(p.keyword)) || null;
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

// Tiap entry nyimpen { name, durationMs, at } - nama-nya kepake buat fitur
// stats & pengumuman rekor, biar bisa nyari riwayat orang yang LAGI NGGAK
// live (activeLives udah kehapus begitu dia selesai live).
function recordLiveDuration(username, name, durationMs) {
  const history = loadDurationHistory();
  const list = history[username] || [];
  list.push({ name, durationMs, at: new Date().toISOString() });
  history[username] = list.slice(-10);
  saveDurationHistory(history);
}

function getAverageDuration(durationHistory, username) {
  const list = durationHistory[username] || [];
  if (list.length === 0) return null;
  return list.reduce((total, item) => total + item.durationMs, 0) / list.length;
}

// Rekor durasi live TERLAMA sebelum live yang baru aja selesai ini (buat
// bandingin apakah ini rekor baru). Return null kalau belum ada riwayat.
function getPreviousMaxDuration(durationHistory, username) {
  const list = durationHistory[username] || [];
  if (list.length === 0) return null;
  return Math.max(...list.map((item) => item.durationMs));
}

// Cocokin fragment ke nama depan per KATA, bukan substring bebas - soalnya
// substring bebas ("nama.includes(needle)") bikin huruf tunggal kayak "a"
// ke-anggep cocok ke nama siapa aja yang kebetulan ada huruf "a"-nya (mis.
// "Fahira"). Kata di needle harus PERSIS sama sama nama depannya, ATAU
// minimal 3 huruf dan jadi prefix/typo-toleran dari nama depannya.
function matchesNameFragment(needle, givenName) {
  if (!needle || !givenName) return false;
  const words = needle.split(/[^a-z0-9]+/).filter(Boolean);
  return words.some((word) => {
    if (word === givenName) return true;
    if (word.length >= 3 && givenName.startsWith(word)) return true;
    if (givenName.length >= 3 && word.startsWith(givenName)) return true;
    return false;
  });
}

function findDurationHistoryByNameFragment(fragment) {
  const needle = (fragment || "").trim().toLowerCase();
  if (!needle) return null;

  const history = loadDurationHistory();
  for (const [username, entries] of Object.entries(history)) {
    if (entries.length === 0) continue;
    const displayName = entries[entries.length - 1].name || username;
    const givenName = displayName.split(/[\s|]+/)[0].toLowerCase();
    if (matchesNameFragment(needle, givenName)) {
      return { username, displayName, entries };
    }
  }
  return null;
}

function formatDuration(ms) {
  const totalMinutes = Math.max(0, Math.floor(ms / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}j ${minutes}m` : `${minutes}m`;
}

// --- Rekap harian: sekali sehari, ringkasan siapa aja yang live hari itu ---
const DAILY_LOG_FILE = path.join(CACHE_DIR, "daily-log.json");
const DAILY_RECAP_HOUR = Number(process.env.DAILY_RECAP_HOUR) || 23; // jam WIB

function getTodayWIB() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(new Date());
}

function getHourWIB() {
  return Number(
    new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Jakarta", hour: "numeric", hour12: false }).format(new Date()),
  );
}

function loadDailyLog() {
  const today = getTodayWIB();
  try {
    const data = JSON.parse(fs.readFileSync(DAILY_LOG_FILE, "utf-8"));
    if (data.date !== today) return { date: today, entries: [], recapSentDate: data.recapSentDate || null };
    return data;
  } catch (error) {
    return { date: today, entries: [], recapSentDate: null };
  }
}

function saveDailyLog(log) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(DAILY_LOG_FILE, JSON.stringify(log, null, 2));
  } catch (error) {
    console.error("Gagal nyimpen log harian:", error.message);
  }
}

function recordDailyEntry(name, durationMs) {
  const log = loadDailyLog();
  log.entries.push({ name, durationMs });
  saveDailyLog(log);
}

async function maybeSendDailyRecap() {
  if (getHourWIB() < DAILY_RECAP_HOUR) return;

  const log = loadDailyLog();
  if (log.recapSentDate === log.date) return; // udah kekirim hari ini

  if (log.entries.length > 0) {
    const totalLives = log.entries.length;
    const totalDurationMs = log.entries.reduce((sum, e) => sum + e.durationMs, 0);
    const longest = log.entries.reduce((max, e) => (e.durationMs > max.durationMs ? e : max), log.entries[0]);
    const uniqueMembers = new Set(log.entries.map((e) => e.name)).size;

    const payload = {
      content: [
        `📋 **Rekap live hari ini (${log.date})**`,
        `Total live: ${totalLives}x dari ${uniqueMembers} member`,
        `Total durasi gabungan: ${formatDuration(totalDurationMs)}`,
        `Paling lama: **${longest.name}** (${formatDuration(longest.durationMs)})`,
      ].join("\n"),
    };

    try {
      const response = await fetch(DISCORD_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) throw new Error(`Discord webhook balikin status ${response.status}`);
      console.log("Rekap harian terkirim");
    } catch (error) {
      console.error("Gagal ngirim rekap harian:", error.message);
    }
  }

  log.recapSentDate = log.date;
  saveDailyLog(log);
}

// Selebrasi kalau live yang baru aja selesai itu rekor durasi TERLAMA buat
// member itu (dibanding riwayat sebelumnya). Dicek SEBELUM live barusan
// dicatet ke riwayat, biar dibandingin ke rekor LAMA-nya, bukan diri sendiri.
async function maybeAnnounceNewRecord(username, memberName, durationMs, durationHistory) {
  const previousMax = getPreviousMaxDuration(durationHistory, username);
  if (previousMax === null || durationMs <= previousMax) return;

  const payload = {
    content: `🏆 **${memberName}** baru aja pecahin rekor durasi live-nya sendiri! Sebelumnya paling lama ${formatDuration(previousMax)}, sekarang ${formatDuration(durationMs)} 🎉`,
  };

  try {
    const response = await fetch(DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) throw new Error(`Discord webhook balikin status ${response.status}`);
    console.log(`Notif rekor baru terkirim untuk ${memberName}`);
  } catch (error) {
    console.error("Gagal ngirim notif rekor:", error.message);
  }
}

function isJkt48Member(creator) {
  if (!creator) return false;
  if (JKT48_USERNAME_WHITELIST.includes(creator.username)) return true;

  // Semua akun IDN resmi member JKT48 konsisten pakai username berawalan
  // "jkt48_" (misal jkt48_levi, jkt48_nala). Sebelumnya kode ini nge-cek
  // apakah kata "jkt48" muncul di bio profil - itu rapuh, soalnya akun fans
  // atau reaction channel juga sering nyebut "JKT48" di bio mereka padahal
  // bukan member asli, jadi nembus filter dan ikut kekirim notifikasi.
  return typeof creator.username === "string" && creator.username.toLowerCase().startsWith("jkt48_");
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
            await maybeAnnounceNewRecord(username, memberData.name, durationMs, durationHistory);
            recordLiveDuration(username, memberData.name, durationMs);
            recordDailyEntry(memberData.name, durationMs);
          }
          activeLives.delete(username);
          saveActiveLives();
        }
        // kalau gagal kirim, sengaja nggak dihapus dari cache
        // biar dicoba lagi di polling berikutnya
      }
    }

    await maybeSendDailyRecap();
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

// Endpoint contoh yang dilindungi signature - nunjukkin data internal bot
// yang lebih detail dibanding health-check publik. Pola ini yang dipake
// kalau nanti nambah endpoint lain yang nyajiin data beneran.
function handleProtectedStatus(req, res) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      status: "ok",
      uptimeSeconds: Math.floor(process.uptime()),
      activeLivesCount: activeLives.size,
      activeLives: [...activeLives.values()].map((entry) => ({
        name: entry.name,
        username: entry.username,
        liveAt: entry.liveAt,
      })),
    }),
  );
}

// Railway (dan platform hosting sejenis) ngecek apakah service "sehat" dengan
// nunggu ada port yang kebuka. Bot ini murni background process tanpa server
// HTTP, jadi tanpa ini Railway bisa nganggep container-nya nggak sehat dan
// restart terus-menerus. Server kecil ini cuma buat "ngasih tanda hidup".
//
// /api/status sengaja dipisah dan dilindungi signature - health-check di "/"
// TETAP publik tanpa signature, karena Railway & UptimeRobot manggil itu
// tanpa tahu cara nge-sign request.
const PORT = process.env.PORT || 3000;
require("http")
  .createServer((req, res) => {
    if (req.url === "/api/status") {
      if (!API_SECRET) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "API_SECRET belum diset di server" }));
        return;
      }
      requireSignedRequest(API_SECRET, handleProtectedStatus)(req, res);
      return;
    }

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
// Kata-kata yang nunjukkin pesannya kemungkinan nanya soal live, walau nggak
// nyebut "cok" sama sekali (misal "siapa yang live?"). Supaya nggak ke-trigger
// tiap kali kata "live" muncul di obrolan biasa, ini cuma dianggap "nanya ke
// bot" kalau ada tanda tanya atau kata tanya juga di pesannya.
const TOPIC_WORDS = ["live"];
const QUESTION_HINTS = ["?", "siapa", "apa", "gimana", "kapan", "berapa"];

function getGreeting() {
  const hourWIB = Number(
    new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Jakarta", hour: "numeric", hour12: false }).format(new Date()),
  );
  if (hourWIB >= 4 && hourWIB < 11) return "pagi";
  if (hourWIB >= 11 && hourWIB < 15) return "siang";
  if (hourWIB >= 15 && hourWIB < 18) return "sore";
  return "malam";
}

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

function replyMemberNotFound(fragment) {
  return `Cok, nggak nemu member "${fragment}" yang lagi live. Coba cek ejaannya, atau tanya "cok siapa yang live" buat liat daftarnya.`;
}

// Nama akun IDN biasanya "Nala JKT48" atau "Piya | Karafuru Idol Group" -
// yang orang beneran ketik biasanya cuma nama depannya ("Nala", "Piya"),
// bukan nama lengkap persis. Jadi cocokin ke kata pertama dari nama-nya,
// bukan nyari nama lengkap sebagai substring persis (itu penyebab bug-nya).
function findMemberByNameFragment(fragment) {
  const needle = (fragment || "").trim().toLowerCase();
  if (!needle) return null;

  for (const entry of activeLives.values()) {
    if (!entry.name) continue;
    const givenName = entry.name.split(/[\s|]+/)[0].toLowerCase();
    if (matchesNameFragment(needle, givenName)) {
      return entry;
    }
  }
  return null;
}

function replyHelp() {
  return [
    "Cok bisa jawab ini:",
    '- "cok ini yang masih live siapa aja?"',
    '- "cok siapa yang paling lama live?"',
    '- "cok status"',
    '- "cok <nama member> masih live?"',
    '- "cok stats <nama member>" - statistik durasi live-nya',
    '- (khusus owner) "cok tambah prioritas <nama>" / "cok hapus prioritas <nama>"',
  ].join("\n");
}

function replyMemberStats(fragment) {
  const found = findDurationHistoryByNameFragment(fragment);
  if (!found || found.entries.length === 0) {
    return `Cok, belum ada data riwayat live buat "${fragment.trim()}".`;
  }

  const durations = found.entries.map((e) => e.durationMs);
  const total = durations.reduce((a, b) => a + b, 0);
  const avg = total / durations.length;
  const max = Math.max(...durations);

  return [
    `📊 Statistik **${found.displayName}** (${durations.length} live terakhir yang ke-track):`,
    `- Rata-rata durasi: ${formatDuration(avg)}`,
    `- Rekor terlama: ${formatDuration(max)}`,
  ].join("\n");
}

function isOwner(authorId) {
  return Boolean(PRIORITY_PING_USER_ID) && authorId === PRIORITY_PING_USER_ID;
}

function handleAddPriority(nameFragment, authorId) {
  if (!isOwner(authorId)) return "Cok, cuma owner yang boleh ubah daftar prioritas.";
  const name = nameFragment.trim();
  const result = addCustomPriorityMember(name);
  if (!result.ok && result.reason === "exists") return `"${name}" udah ada di daftar prioritas.`;
  if (!result.ok) return "Gagal nambahin, coba lagi.";
  return `✅ "${name}" ditambahin ke daftar prioritas, notif live-nya bakal jadi flashy sekarang.`;
}

function handleRemovePriority(nameFragment, authorId) {
  if (!isOwner(authorId)) return "Cok, cuma owner yang boleh ubah daftar prioritas.";
  const name = nameFragment.trim();
  const result = removeCustomPriorityMember(name);
  if (!result.ok) return `"${name}" nggak ketemu di daftar prioritas custom (Nala/Levi/Lily nggak bisa dihapus lewat chat).`;
  return `✅ "${name}" dihapus dari daftar prioritas.`;
}

// Channel -> kapan terakhir menu fallback ditampilin di situ. Dipake biar
// user bisa balas cukup ketik angkanya doang (1-4) abis menu-nya muncul -
// tapi CUMA kalau menu-nya baru aja beneran ditampilin duluan, biar ketik
// angka "mentah" tanpa konteks tetap nunjukkin menu-nya dulu (bukan nebak).
const pendingMenuByChannel = new Map();
const PENDING_MENU_TTL_MS = 3 * 60000;

// Dipanggil kalau pesannya kedetect nanya soal live tapi nggak match
// pertanyaan yang udah dikenali - dikasih menu daripada bot diem aja.
function replyFallbackMenu() {
  const ownerContact = PRIORITY_PING_USER_ID ? `<@${PRIORITY_PING_USER_ID}>` : "owner channel ini";
  return [
    `Halo, selamat ${getGreeting()}! Apa yang ingin kamu tanyakan?`,
    "1. Siapa saja yang masih live?",
    "2. Status live sekarang",
    "3. Siapa yang paling lama live per hari ini?",
    "4. Apakah <nama member> masih live?",
    "",
    '(Abis ini kamu bisa balas cukup ketik angkanya aja, misal "1" atau "4 Nala")',
    "",
    `Kalau ada pertanyaan lain, silakan hubungi ${ownerContact}.`,
  ].join("\n");
}

function tryHandleMenuShortcut(text, channelId) {
  if (!channelId) return null;

  const shownAt = pendingMenuByChannel.get(channelId);
  const isPending = shownAt && Date.now() - shownAt <= PENDING_MENU_TTL_MS;
  if (!isPending) return null;

  const match = text.match(/^([1-4])\s*(.*)$/);
  if (!match) return null;

  const [, choice, rest] = match;
  pendingMenuByChannel.delete(channelId); // sekali pake abis itu clear

  if (choice === "1") return replyListLive();
  if (choice === "2") return replyBotStatus();
  if (choice === "3") return replyLongestLive();

  // choice === "4"
  if (!rest) return 'Member yang mana? Ketik nama membernya juga ya, misal "4 Nala".';
  const found = findMemberByNameFragment(rest);
  return found ? replySpecificMember(found) : replyMemberNotFound(rest);
}

function buildChatReply(rawContent, { isBotChannel = false, channelId = null, authorId = null } = {}) {
  const text = (rawContent || "").toLowerCase().trim();

  const shortcutReply = tryHandleMenuShortcut(text, channelId);
  if (shortcutReply) return shortcutReply;

  // Di channel khusus bot, hampir semua pesan dianggap "ditujukan ke bot" -
  // gak perlu nyebut "cok" atau "live" dulu.
  const mentionsBot = isBotChannel || CHAT_WAKE_WORDS.some((w) => text.includes(w));
  const looksLikeLiveQuestion =
    TOPIC_WORDS.some((w) => text.includes(w)) && QUESTION_HINTS.some((w) => text.includes(w));

  if (!mentionsBot && !looksLikeLiveQuestion) return null;

  const addPriorityMatch = text.match(/tambah(?:in)?\s+prioritas\s+(.+)/);
  if (addPriorityMatch) {
    return handleAddPriority(addPriorityMatch[1], authorId);
  }

  const removePriorityMatch = text.match(/hapus\s+prioritas\s+(.+)/);
  if (removePriorityMatch) {
    return handleRemovePriority(removePriorityMatch[1], authorId);
  }

  const statsMatch = text.match(/stat(?:s|istik)\s+(.+)/);
  if (statsMatch) {
    return replyMemberStats(statsMatch[1]);
  }

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

  const matchedMember = findMemberByNameFragment(text);
  if (matchedMember) {
    return replySpecificMember(matchedMember);
  }

  // Nyebut bot/nanya soal live tapi nggak match pola yang dikenal -> kasih
  // menu daripada diem aja, dan inget channel ini abis dikasih menu.
  if (channelId) pendingMenuByChannel.set(channelId, Date.now());
  return replyFallbackMenu();
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
      const isBotChannel = Boolean(BOT_CHANNEL_ID) && message.channel.id === BOT_CHANNEL_ID;
      const reply = buildChatReply(message.content, {
        isBotChannel,
        channelId: message.channel.id,
        authorId: message.author.id,
      });
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
