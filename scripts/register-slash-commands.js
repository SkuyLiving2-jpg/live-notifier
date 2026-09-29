// Tool CLI MANUAL - dijalanin sendiri di komputermu, BUKAN bagian dari bot
// Discord yang jalan 24 jam di Railway (sama kategorinya kayak
// set-channel-routing.js/backup-data.js). Sekali jalan buat DAFTARIN slash
// command ("/live", "/rekap", dst - lihat chat/slashCommands.js) ke Discord;
// jalanin ULANG tiap kali daftar command-nya berubah (nambah/hapus/ubah
// opsi) - Discord nyimpen daftar command per-guild, kode di bot doang gak
// otomatis nge-sync-in.
//
// GUILD-SCOPED (bukan global) - PUT ke /applications/{id}/guilds/{guild}/commands,
// bukan /applications/{id}/commands. Alasannya (lihat komen DISCORD_GUILD_ID
// di config.js): propagasi LANGSUNG kelihatan (global butuh sampai 1 jam),
// dan command-nya kekunci ke SATU server ini doang.
//
// SEBELUM jalanin ini, PENTING: bot HARUS udah pernah di-invite ke server
// dengan scope "applications.commands" (bukan cuma "bot") - kalau invite
// link lama cuma scope "bot", generate ulang invite link-nya di Discord
// Developer Portal > OAuth2 > URL Generator (centang "bot" DAN
// "applications.commands"), terus buka link itu buat re-authorize bot-nya
// ke server yang sama (gak perlu kick/invite ulang dari nol, cukup
// re-authorize). Command yang di-PUT lewat script ini TETEP gak nongol di
// Discord kalau scope ini belum ada, walau request-nya sendiri sukses.
//
// Jalanin: npm run register-slash-commands
// Butuh di .env: DISCORD_BOT_TOKEN, DISCORD_CLIENT_ID, DISCORD_GUILD_ID.

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const { REST, Routes } = require("discord.js");
const { getCommandDefinitionsJSON } = require("../src/chat/slashCommands");

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || "";
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || "";
const DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID || "";

async function main() {
  const missing = [
    ["DISCORD_BOT_TOKEN", DISCORD_BOT_TOKEN],
    ["DISCORD_CLIENT_ID", DISCORD_CLIENT_ID],
    ["DISCORD_GUILD_ID", DISCORD_GUILD_ID],
  ]
    .filter(([, value]) => !value)
    .map(([key]) => key);
  if (missing.length > 0) {
    console.error(`Env var berikut harus diisi di .env dulu: ${missing.join(", ")}`);
    console.error(
      "DISCORD_CLIENT_ID: Developer Portal > General Information > Application ID.\n" +
        "DISCORD_GUILD_ID: klik kanan nama server (Developer Mode aktif dulu) > Copy Server ID.",
    );
    process.exit(1);
  }

  const commands = getCommandDefinitionsJSON();
  console.log(`Daftarin ${commands.length} slash command ke server ${DISCORD_GUILD_ID}...`);
  commands.forEach((c) => console.log(`  - /${c.name}`));

  const rest = new REST({ version: "10" }).setToken(DISCORD_BOT_TOKEN);
  try {
    const result = await rest.put(Routes.applicationGuildCommands(DISCORD_CLIENT_ID, DISCORD_GUILD_ID), { body: commands });
    console.log(`\n✅ Berhasil - ${result.length} command aktif sekarang. Langsung kelihatan di server (gak perlu nunggu propagasi).`);
  } catch (error) {
    console.error("\n❌ Gagal daftarin command:", error.message);
    if (error.status === 401) {
      console.error("Status 401 - DISCORD_BOT_TOKEN kemungkinan salah/expired.");
    } else if (error.status === 403) {
      console.error(
        'Status 403 - bot ini kemungkinan belum pernah di-invite ke server itu dengan scope "applications.commands". Lihat komen di atas file ini buat cara benerinnya.',
      );
    } else if (error.status === 404) {
      console.error("Status 404 - DISCORD_CLIENT_ID atau DISCORD_GUILD_ID kemungkinan salah/gak valid.");
    }
    process.exit(1);
  }
}

main();
