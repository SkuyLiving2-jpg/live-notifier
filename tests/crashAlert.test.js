require("./helpers/setupTestEnv");

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { sendCrashAlert } = require("../src/notify/crashAlert");

// sendCrashAlert() itu upaya TERAKHIR sebelum proses mati - kontrak
// terpentingnya adalah dia GAK BOLEH nge-throw apapun yang terjadi (DM
// gagal, webhook gagal, dua-duanya gagal), soalnya dipanggil dari
// uncaughtException/unhandledRejection handler yang lagi buru-buru mau
// keluar. Di test ini gak ada Discord bot token yang login beneran
// (getDiscordClient() balikin null - createDiscordClient() emang gak
// pernah dipanggil di proses test), jadi ini otomatis nguji jalur fallback
// ke webhook channel - DISCORD_WEBHOOK_URL-nya dummy (lihat
// helpers/setupTestEnv.js), jadi network call-nya emang bakal ditolak sama
// Discord (bukan lambat/gak nentu kayak nembak pihak ketiga beneran), yang
// justru pas buat verifikasi "gagal ngirim tetep gak nge-throw".
test("sendCrashAlert - gak pernah nge-throw walau DM & webhook dua-duanya gagal (Error object)", async () => {
  await assert.doesNotReject(sendCrashAlert("test-uncaughtException", new Error("boom")));
});

test("sendCrashAlert - nerima reason yang BUKAN Error object (mis. string polos dari unhandledRejection)", async () => {
  await assert.doesNotReject(sendCrashAlert("test-unhandledRejection", "cuma string biasa"));
});
