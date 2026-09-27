// Dipanggil (di-require) PALING ATAS di tiap test file yang butuh modul
// dari src/ - modul-modul itu semua nembus ke src/config.js entah langsung
// atau nggak langsung (lihat ARCHITECTURE.md §2), dan config.js baca
// CACHE_DIR/DISCORD_WEBHOOK_URL dari process.env pas pertama kali di-require.
//
// Node's test runner ("node --test") ngejalanin TIAP FILE test sebagai
// child process terpisah - jadi require cache-nya juga kepisah per file,
// dan preset env var di sini gak bakal bocor ke file test lain. Ini yang
// bikin aman ngeset CACHE_DIR ke folder temp KHUSUS buat proses test ini
// doang, tanpa risiko nyenggol data/ asli punya bot yang beneran jalan.
//
// PENTING: ini harus di-require SEBELUM require apapun dari src/ (termasuk
// transitif) - kalau src/config.js udah kadung ke-require duluan sama
// modul lain, CACHE_DIR-nya udah kepatok ke nilai lama (module cache),
// preset di sini jadi percuma.
const fs = require("fs");
const os = require("os");
const path = require("path");

const tempCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "jkt48-bot-test-"));

process.env.CACHE_DIR = tempCacheDir;
// Dummy - cuma biar config.js's validasi wajib gak process.exit(1), test
// gak pernah beneran ngirim apa-apa ke URL ini.
if (!process.env.DISCORD_WEBHOOK_URL) {
  process.env.DISCORD_WEBHOOK_URL = "https://discord.com/api/webhooks/test/dummy-for-tests";
}
// Kosongin biar test gak kebawa nilai asli dari .env lokal punya siapapun
// yang jalanin test-nya (mis. PRIORITY_PING_USER_ID beneran punya owner).
process.env.DISCORD_BOT_TOKEN = "";
process.env.PRIORITY_PING_USER_ID = "";
process.env.BOT_CHANNEL_ID = "";
// BUG YANG DITEMUKAN (debug pass, fitur ke-7/dashboard live): begitu owner
// beneran ngisi DASHBOARD_WEBHOOK_URL di .env lokalnya (buat ngaktifin
// fiturnya di bot beneran), config.js's dotenv.config() (yang gak override
// process.env yang UDAH keisi - lihat 3 baris di atas) diam-diam nyerap
// nilai ASLI itu ke SEMUA proses test, soalnya var ini gak ikut dikosongin
// di sini kayak 3 var lain di atas. Akibatnya DUA jenis test rusak: (1)
// tests/liveDashboardDisabled.test.js (yang eksplisit sengaja GAK nge-set
// DASHBOARD_WEBHOOK_URL, buat mastiin fiturnya mati "by default") jadi
// nemuin fiturnya NYALA gara-gara nilai asli itu, gak sesuai namanya sendiri;
// (2) test LAIN manapun yang mock fetch buat ngitung PERSIS berapa kali
// notif kekirim (mis. tests/monitor.test.js) jadi keitung EKSTRA panggilan
// fetch dari maybeUpdateDashboard yang diem-diem ikut jalan. Dikosongin di
// sini (sama pola kayak 3 var di atas) - tests/liveDashboard.test.js yang
// SENGAJA nguji jalur "nyala" nyetel ulang ke nilai dummy-nya SENDIRI di
// awal file itu (sebelum src/config.js sempet ke-require), jadi gak
// kesentuh/gak konflik sama pengosongan default ini.
process.env.DASHBOARD_WEBHOOK_URL = "";

module.exports = { tempCacheDir };
