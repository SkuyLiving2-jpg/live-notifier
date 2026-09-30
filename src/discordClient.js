const { Client, GatewayIntentBits } = require("discord.js");
const { DISCORD_BOT_TOKEN } = require("./config");

// Instance discord.js Client BERSAMA, dipakai baik buat kirim DM notif
// prioritas (notify/priorityDm.js) maupun buat nerima pesan chat & tombol
// (chat/router.js). `client` sengaja tetap null sampai createDiscordClient()
// beneran dipanggil dari src/app.js's start() - biar require() modul ini aja
// gak langsung bikin efek samping (buka koneksi ke Discord).
let client = null;

function createDiscordClient() {
  if (!DISCORD_BOT_TOKEN) return null;
  client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  });
  return client;
}

function getDiscordClient() {
  return client;
}

module.exports = { createDiscordClient, getDiscordClient };
