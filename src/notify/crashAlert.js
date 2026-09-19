const { getDiscordClient } = require("../discordClient");
const { PRIORITY_PING_USER_ID } = require("../config");
const { postToWebhook } = require("./webhook");

// Dipanggil dari src/app.js's uncaughtException/unhandledRejection handler -
// upaya TERAKHIR ngasih tau sebelum proses mati beneran, jadi fungsi ini
// SENGAJA gak boleh nge-throw apapun (kalau sampai gagal ngirim alert-nya
// pun, itu gak boleh nyebabin proses shutdown-nya sendiri malah nyangkut).
//
// Coba DM ke owner dulu (sama kayak pola notify/priorityDm.js - crash cuma
// relevan buat pemilik bot, orang lain di channel gak perlu tau) - kalau
// DISCORD_BOT_TOKEN/PRIORITY_PING_USER_ID belum diset (jadi DM gak bisa),
// fallback ke webhook channel publik, biar alert-nya TETEP punya jalan
// keluar - DISCORD_WEBHOOK_URL itu satu-satunya env var yang wajib diisi,
// jadi ini jalur yang paling bisa diandelin buat selalu berhasil kekirim.
async function sendCrashAlert(context, error) {
  const message = error && error.message ? error.message : String(error);
  const content = `🔴 **Bot crash** (${context}): \`${message}\`\nProses bakal keluar sekarang - kalau lagi di Railway, biasanya otomatis di-restart.`;

  try {
    const client = getDiscordClient();
    if (client && PRIORITY_PING_USER_ID) {
      const user = await client.users.fetch(PRIORITY_PING_USER_ID);
      await user.send({ content });
      return;
    }
    await postToWebhook({ content }, "Gagal ngirim alert crash ke channel:");
  } catch (sendError) {
    console.error("Gagal ngirim alert crash (nggak fatal, proses tetep lanjut keluar):", sendError.message);
  }
}

module.exports = { sendCrashAlert };
