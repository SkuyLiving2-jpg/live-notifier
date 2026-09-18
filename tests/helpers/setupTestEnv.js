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

module.exports = { tempCacheDir };
