const path = require("path");

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

// Helper buat baca env var numerik dengan fallback - BUKAN sekadar
// `Number(process.env.X) || fallback`, yang punya bug halus: `0 || fallback`
// di JS balikin `fallback` (0 itu falsy), jadi env var yang SENGAJA di-set
// ke "0" (misalnya DAILY_RECAP_HOUR=0 buat rekap jam 00:00 WIB tepat)
// diam-diam ke-timpa fallback-nya, bukan beneran kepake. Ditemukan pas
// nulis test buat fitur rekap embed (butuh angka jam yang kepastian ke-pick
// SELALU lolos gerbang "getHourWIBOf() < DAILY_RECAP_HOUR" apapun jam
// aslinya) - env var unset/string kosong/bukan angka valid tetap fallback
// seperti biasa, cuma "0" doang yang sebelumnya salah kena timpa.
function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const IDN_API_URL = "https://api.idn.app/graphql";
// Diturunin dari 30 -> 20 detik (default) buat ngurangin jeda deteksi live
// baru - dibikin configurable (bukan angka mati) biar owner bisa nyetel
// sendiri trade-off-nya (makin kecil = makin cepet kedetek, tapi makin
// sering nembak API IDN) tanpa perlu ubah kode/redeploy tiap kali mau
// nyoba-nyoba angka lain.
const POLL_INTERVAL_MS = envInt("POLL_INTERVAL_SECONDS", 20) * 1000;

// Secret buat sistem signature (API_KEY + HMAC-SHA256) yang ngelindungin
// endpoint API kita dari akses sembarangan - dipakai kalau nanti nambah
// endpoint yang nyajiin data (bukan buat health-check, itu sengaja tetap
// publik biar Railway/UptimeRobot bisa akses tanpa signature).
const API_SECRET = process.env.API_SECRET || "";

// CACHE_DIR nentuin di mana semua file data (rekap, prioritas, subscription,
// dll) disimpen. Urutan prioritas:
//   1. CACHE_DIR - kalau mau nunjuk manual ke folder tertentu.
//   2. RAILWAY_VOLUME_MOUNT_PATH - Railway ngisi ini OTOMATIS begitu kamu
//      nempelin Volume ke service ini (gak perlu diisi manual sama sekali,
//      cukup attach Volume-nya doang di dashboard Railway) - biar data-nya
//      TAHAN lintas redeploy, bukan ke-reset tiap kali ada kode baru di-push.
//   3. Kalau dua-duanya kosong (mis. lagi jalan di komputer lokal), fallback
//      ke folder data/ di root project. __dirname di sini adalah src/, jadi
//      ".." tetap ke root project sama persis kayak waktu ini masih di js/.
const CACHE_DIR = process.env.CACHE_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, "..", "data");
// Log ini sengaja dicetak paling awal pas boot - cara paling gampang buat
// mastiin (lewat Deploy Logs di Railway) apakah data beneran kesimpen di
// Volume yang persistent, atau diam-diam masih fallback ke folder lokal
// yang bakal ke-reset tiap redeploy.
console.log(
  `CACHE_DIR aktif: ${CACHE_DIR} ${process.env.RAILWAY_VOLUME_MOUNT_PATH ? "(dari Railway Volume - persistent ✓)" : "(BUKAN dari Volume - bakal ke-reset tiap redeploy!)"}`,
);

// Token bot Discord buat fitur tanya-jawab interaktif DAN buat kirim DM
// notifikasi prioritas ke pemilik bot (opsional). Beda sama DISCORD_WEBHOOK_URL
// yang cuma bisa kirim ke channel, bukan baca pesan ATAU kirim DM. Kalau
// nggak diset, notifikasi channel tetap jalan normal, cuma fitur tanya-jawab
// DAN versi flashy/DM notif prioritas-nya mati (prioritas tetap dapet notif
// biasa doang di channel, kayak member lain).
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
const DEFAULT_ENDING_SOON_THRESHOLD_MS = envInt("ENDING_SOON_THRESHOLD_MINUTES", 40) * 60 * 1000;

// Live IDN paling lama yang REALISTIS masih masuk akal (generous - live
// beneran hampir gak pernah lebih dari beberapa jam). Dipake buat nyaring
// sesi yang durasinya jelas-jelas ngaco (ratusan jam) - baik pas backfill
// ngerekonstruksi sesi dari histori pesan Discord (scripts/backfill-live-history.js)
// maupun pas server nerima hasilnya (server.js's handleBackfillLiveHistory),
// biar data korup gak ke-simpen dua kali di dua tempat yang beda. Lihat
// ARCHITECTURE.md §10 buat cerita lengkap bug-nya.
const MAX_PLAUSIBLE_LIVE_DURATION_MS = 12 * 60 * 60 * 1000;

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
// tombol link + opsional mention) dibanding member JKT48 lain. Diurutkan
// dari yang paling emergency ke bawah - urutan ini nentuin intensitas warna
// & tone pesannya.
//
// buttonLabel opsional - teks tombol "tonton sekarang" yang nempel di notif
// "mulai live" (lihat priority/index.js's buildPriorityPayload). Kalau
// nggak diisi, dipakein default netral. Nala (#1, paling emergency) sengaja
// dikasih buttonLabel custom yang lebih "mendesak" (ada tanda panah) biar
// kerasa beda urgensinya dibanding Levi/Lily yang tetap prioritas tapi
// nggak se-emergency itu.
//
// endMessagePool opsional - kalau diisi, notif "SELESAI live" buat member
// itu dikasih sentuhan khusus (embed field pesan + footer beda) yang
// kalimatnya DIRACIK ACAK tiap kali (lihat priority/index.js's
// generateEndMessage), bukan 1 kalimat fixed yang keliatan robotic kalau
// dibaca berkali-kali. Cuma Nala yang dikasih ini sekarang - Levi/Lily
// sengaja dibiarin default (notif selesainya tetep plain).
//
// PENTING: kalimat-kalimat di pool ini teks generik gaya fan-idol yang
// hangat/sweet, BUKAN hasil niru/nyontek gaya nulis Nala yang asli dari
// media sosialnya - sengaja dibikin gitu, bukan ngarang-ngarang kalimat
// yang seolah-olah beneran kata-kata pribadi dia.
const NALA_END_MESSAGE_POOL = {
  openers: ["Makasih banyak", "Terima kasih ya", "Makasih banget", "Big thanks buat kalian semua", "Thank you so much", "Makasih ya"],
  bodies: [
    "udah nemenin live aku hari ini",
    "udah setia nontonin sampai akhir",
    "buat semangat yang kalian kasih terus",
    "buat semua chat dan gift-nya",
    "karena kalian selalu ada buat aku",
    "udah nemenin dari awal sampai selesai",
  ],
  closers: [
    "Sampai jumpa di live berikutnya ya! 💚",
    "Jaga kesehatan, sampai ketemu lagi! ✨",
    "Love you all, sampai jumpa lagi~ 🥰",
    "See you next live! 😊",
    "Semoga hari kalian menyenangkan! 💫",
    "Istirahat yang cukup ya, sampai jumpa lagi! 🌷",
  ],
};

const PRIORITY_MEMBERS = [
  {
    rank: 1,
    keyword: "nala",
    label: "NALA",
    color: 0x1abc9c,
    sirens: "🚨🔥🚨",
    buttonLabel: "➡️ GAS, INI LIVE PALING URGENT SEDUNIA! ➡️",
    endMessagePool: NALA_END_MESSAGE_POOL,
    // startIntro/startHashtag (opsional, lihat priority/index.js's
    // buildPriorityPayload) - sentuhan khusus di notif "mulai live" DM,
    // sama kayak endMessagePool cuma di-opt-in buat Nala doang. Levi/Lily
    // sengaja dibiarin kosong (undefined), jadi notif mereka tetap format
    // standar.
    startIntro: "Nala, si Best Friend mu lagi Live",
    startHashtag: "#NaLex",
  },
  { rank: 2, keyword: "levi", label: "LEVI", color: 0xff0000, sirens: "🚨⚡🚨" },
  { rank: 3, keyword: "lily", label: "LILY", color: 0x3498db, sirens: "🚨✨🚨" },
];

// ID user Discord yang mau di-mention khusus buat notif prioritas (opsional).
// Cara dapetinnya: di Discord, aktifin Developer Mode di Settings > Advanced,
// terus klik kanan nama kamu sendiri > Copy User ID. ID yang sama ini juga
// dipake buat nentuin siapa "owner" yang boleh kelola daftar prioritas lewat
// chat, dan siapa yang nerima DM notif prioritas.
const PRIORITY_PING_USER_ID = process.env.PRIORITY_PING_USER_ID || "";

// Palette warna buat member prioritas CUSTOM (ditambah lewat chat "cok tambah
// prioritas <nama>"). Sengaja HINDARIN warna Nala (0x1abc9c teal) & Lily
// (0x3498db biru) di sini - dulu palette ini masukin dua warna itu, jadi
// member prioritas custom pertama/ketiga yang ditambahin lewat chat bisa
// dapet warna PERSIS SAMA kayak Nala/Lily (keliatan "salah orang" di embed
// Discord).
const PRIORITY_COLOR_PALETTE = [0x9b59b6, 0x2ecc71, 0xe91e63, 0xe67e22, 0xf1c40f];

const DAILY_RECAP_HOUR = envInt("DAILY_RECAP_HOUR", 23); // jam WIB

// Warna embed rekap harian otomatis (notify/publicAlerts.js's
// maybeSendDailyRecap) - Discord "blurple", netral/gak nyerempet warna
// member prioritas manapun (teal Nala 0x1abc9c, merah Levi 0xff0000, biru
// Lily 0x3498db, atau PRIORITY_COLOR_PALETTE di atas), soalnya rekap ini
// ngerangkum SEMUA member bareng, bukan punya satu orang.
const DAILY_RECAP_COLOR = 0x5865f2;

const PORT = process.env.PORT || 3000;

module.exports = {
  DISCORD_WEBHOOK_URL,
  IDN_API_URL,
  POLL_INTERVAL_MS,
  API_SECRET,
  CACHE_DIR,
  DISCORD_BOT_TOKEN,
  BOT_CHANNEL_ID,
  DEFAULT_ENDING_SOON_THRESHOLD_MS,
  MAX_PLAUSIBLE_LIVE_DURATION_MS,
  JKT48_USERNAME_WHITELIST,
  NALA_END_MESSAGE_POOL,
  PRIORITY_MEMBERS,
  PRIORITY_PING_USER_ID,
  PRIORITY_COLOR_PALETTE,
  DAILY_RECAP_HOUR,
  DAILY_RECAP_COLOR,
  PORT,
};
