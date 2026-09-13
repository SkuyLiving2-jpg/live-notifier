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

if (!DISCORD_WEBHOOK_URL) {
  console.error("DISCORD_WEBHOOK_URL belum diset di environment variable. Bot berhenti.");
  process.exit(1);
}

// Kalau ada member JKT48 yang nama/bio IDN-nya kebetulan nggak nyantumin
// kata "JKT48", tambahin username IDN-nya di sini biar tetap kedeteksi.
const JKT48_USERNAME_WHITELIST = [
  // "username_idn_member",
];

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

function isJkt48Member(creator) {
  if (!creator) return false;
  if (JKT48_USERNAME_WHITELIST.includes(creator.username)) return true;

  const text = `${creator.name || ""} ${creator.bio_description || ""}`.toLowerCase();
  return text.includes("jkt48");
}

async function checkLiveMembers() {
  const query = `
    query GetLivestreams {
      getLivestreams {
        creator {
          username
          name
          bio_description
        }
        title
        slug
      }
    }
  `;

  try {
    const response = await fetch(IDN_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query }),
    });

    if (!response.ok) {
      throw new Error(`IDN API balikin status ${response.status}`);
    }

    const result = await response.json();

    if (result.errors) {
      throw new Error(`GraphQL error: ${JSON.stringify(result.errors)}`);
    }

    const currentLives = result?.data?.getLivestreams || [];
    const currentLiveUsernames = new Set();

    for (const live of currentLives) {
      const username = live?.creator?.username;
      if (!username) continue; // skip entry yang datanya nggak lengkap
      if (!isJkt48Member(live.creator)) continue; // cuma peduli member JKT48

      currentLiveUsernames.add(username);

      // Kirim notif cuma kalo member baru mulai live
      if (!activeLives.has(username)) {
        const terkirim = await sendDiscordNotif(live.creator.name, live.creator.username, live.slug, "start");
        if (terkirim) {
          activeLives.set(username, { name: live.creator.name, username, slug: live.slug });
          saveActiveLives();
        }
        // kalau gagal kirim, username sengaja nggak ditambahin
        // biar dicoba lagi di polling berikutnya
      }
    }

    // Kirim notif "sudah selesai" + bersihkan cache kalau member udah selesai live
    for (const [username, memberData] of activeLives) {
      if (!currentLiveUsernames.has(username)) {
        const terkirim = await sendDiscordNotif(memberData.name, memberData.username, memberData.slug, "end");
        if (terkirim) {
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

async function sendDiscordNotif(memberName, username, slug, status = "start") {
  const liveUrl = `https://www.idn.app/${username}/live/${slug}`;
  const payload =
    status === "end"
      ? { content: `✅ **${memberName}** udah selesai live di IDN Live.` }
      : { content: `🚨 **${memberName}** lagi live di IDN Live!\nNonton di sini: ${liveUrl}` };

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

console.log("Bot notifikasi IDN Live jalan...");
pollLoop();
