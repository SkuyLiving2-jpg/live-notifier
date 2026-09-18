const { DISCORD_BOT_TOKEN } = require("./config");
const { createDiscordClient } = require("./discordClient");
const { wireDiscordEvents } = require("./chat/router");
const { startServer } = require("./server");
const { pollLoop } = require("./monitor");

// Titik masuk tunggal buat nyalain seluruh bot - dipanggil dari js/new.js.
// Sengaja dipisah dari require-time (bukan langsung jalan begitu file ini
// di-require) biar modul-modul lain (storage, notify, priority, dst) bisa
// di-require sendiri-sendiri buat dites/diperiksa tanpa ikut nyalain server
// HTTP, login Discord, atau mulai polling IDN.
function start() {
  startServer();

  // Fitur tanya-jawab DAN DM notif prioritas ini opsional - kalau
  // DISCORD_BOT_TOKEN nggak diset, notifikasi channel tetap jalan normal,
  // cuma bot nggak bisa dichat dan member prioritas gak dapet perlakuan
  // flashy/DM (bakal dapet notif biasa doang, sama kayak member lain).
  if (DISCORD_BOT_TOKEN) {
    const client = createDiscordClient();
    wireDiscordEvents(client);
  } else {
    console.log(
      "DISCORD_BOT_TOKEN nggak diset - fitur tanya-jawab DAN DM notif prioritas dimatiin (notif channel tetap jalan normal, member prioritas dapet notif biasa kayak member lain).",
    );
  }

  console.log("Bot notifikasi IDN Live jalan...");
  pollLoop();
}

module.exports = { start };
