const { Client, GatewayIntentBits } = require("discord.js");
const { DISCORD_BOT_TOKEN, ROLE_WELCOME_ENABLED } = require("./config");

// Instance discord.js Client BERSAMA, dipakai baik buat kirim DM notif
// prioritas (notify/priorityDm.js) maupun buat nerima pesan chat & tombol
// (chat/router.js). `client` sengaja tetap null sampai createDiscordClient()
// beneran dipanggil dari src/app.js's start() - biar require() modul ini aja
// gak langsung bikin efek samping (buka koneksi ke Discord).
let client = null;

function createDiscordClient() {
  if (!DISCORD_BOT_TOKEN) return null;
  const intents = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent];
  // Privileged - cuma diminta kalau sambutan member baru diaktifin (lihat
  // config.js's ROLE_WELCOME_ENABLED); tanpa toggle di Developer Portal, Discord
  // nolak login-nya.
  if (ROLE_WELCOME_ENABLED) intents.push(GatewayIntentBits.GuildMembers);
  client = new Client({ intents });
  return client;
}

function getDiscordClient() {
  return client;
}

module.exports = { createDiscordClient, getDiscordClient };
