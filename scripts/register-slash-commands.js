// Tool CLI MANUAL - dijalanin sendiri di komputermu, BUKAN bagian dari bot
// Discord yang jalan 24 jam di Railway (sama kategorinya kayak
// set-channel-routing.js/backup-data.js). Sekali jalan buat DAFTARIN slash
// command ("/live", "/rekap", dst - lihat chat/slashCommands.js) ke Discord;
// jalanin ULANG tiap kali daftar command-nya berubah (nambah/hapus/ubah
// opsi) - Discord nyimpen daftar command di sisi mereka, kode di bot doang gak
// otomatis nge-sync-in.
//
// DUA MODE:
//
// 1. GUILD-SCOPED (DEFAULT) - `npm run register-slash-commands`
//    PUT ke /applications/{id}/guilds/{guild}/commands. Propagasi LANGSUNG
//    kelihatan, dan command-nya kekunci ke SATU server ini doang. TAPI command
//    per-server TIDAK PERNAH muncul di DM dengan bot (aturan Discord).
//
// 2. GLOBAL (+ DM) - `npm run register-slash-commands:global`
//    PUT ke /applications/{id}/commands dengan contexts [Guild, BotDM], jadi command
//    muncul di server DAN di DM dengan bot. Kekurangan: Discord butuh sampai sekitar 1 jam
//    sampai perubahan global kelihatan di semua klien. Karena command global dan command
//    per-server sama-sama tampil, mode ini OTOMATIS mengosongkan command per-server di
//    DISCORD_GUILD_ID (kalau diisi) supaya tiap command gak muncul dobel di server.
//    Mau balik ke mode default? Jalanin versi biasa: dia mendaftarkan ulang command per-server
//    (command global lama tetap ada sampai dikosongkan lewat Developer Portal/PUT [] ke
//    /applications/{id}/commands, jadi di server sempat dobel - makanya ini sengaja
//    bukan perubahan sembarangan).
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
// Butuh di .env: DISCORD_BOT_TOKEN, DISCORD_CLIENT_ID, dan DISCORD_GUILD_ID
// (wajib di mode default; di mode global opsional - dipakai cuma buat bersihin
// command per-server lama).

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const { REST, Routes } = require("discord.js");
const { getCommandDefinitionsJSON } = require("../src/chat/slashCommands");

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || "";
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || "";
const DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID || "";
const GLOBAL_MODE = process.argv.includes("--global") || process.env.SLASH_SCOPE === "global";

function checkEnv() {
  const required = [
    ["DISCORD_BOT_TOKEN", DISCORD_BOT_TOKEN],
    ["DISCORD_CLIENT_ID", DISCORD_CLIENT_ID],
  ];
  if (!GLOBAL_MODE) required.push(["DISCORD_GUILD_ID", DISCORD_GUILD_ID]);
  const missing = required.filter(([, value]) => !value).map(([key]) => key);
  if (missing.length > 0) {
    console.error(`Env var berikut harus diisi di .env dulu: ${missing.join(", ")}`);
    console.error(
      "DISCORD_CLIENT_ID: Developer Portal > General Information > Application ID.\n" +
        "DISCORD_GUILD_ID: klik kanan nama server (Developer Mode aktif dulu) > Copy Server ID.",
    );
    process.exit(1);
  }
}

function explainFailure(error) {
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
}

async function registerGuild(rest) {
  const commands = getCommandDefinitionsJSON();
  console.log(`Daftarin ${commands.length} slash command ke server ${DISCORD_GUILD_ID} (mode per-server, TIDAK muncul di DM)...`);
  commands.forEach((c) => console.log(`  - /${c.name}`));
  const result = await rest.put(Routes.applicationGuildCommands(DISCORD_CLIENT_ID, DISCORD_GUILD_ID), { body: commands });
  console.log(`\n✅ Berhasil - ${result.length} command aktif sekarang. Langsung kelihatan di server (gak perlu nunggu propagasi).`);
}

async function registerGlobal(rest) {
  const commands = getCommandDefinitionsJSON({ includeDm: true });
  console.log(`Daftarin ${commands.length} slash command GLOBAL (muncul di server DAN di DM dengan bot)...`);
  commands.forEach((c) => console.log(`  - /${c.name}`));
  const result = await rest.put(Routes.applicationCommands(DISCORD_CLIENT_ID), { body: commands });
  console.log(`\n✅ Berhasil - ${result.length} command global terdaftar. Discord butuh sampai sekitar 1 jam sampai kelihatan di semua klien.`);

  if (!DISCORD_GUILD_ID) {
    console.log("DISCORD_GUILD_ID kosong - command per-server lama (kalau ada) TIDAK dibersihkan, jadi di server bisa muncul dobel.");
    return;
  }
  // Tanpa ini tiap command tampil dua kali di server (versi per-server + versi global).
  try {
    await rest.put(Routes.applicationGuildCommands(DISCORD_CLIENT_ID, DISCORD_GUILD_ID), { body: [] });
    console.log(`🧹 Command per-server di ${DISCORD_GUILD_ID} dikosongkan supaya gak muncul dobel.`);
  } catch (error) {
    console.error(
      `⚠️ Command global sukses, tapi gagal mengosongkan command per-server (${error.message}). Di server mungkin muncul dobel sementara.`,
    );
  }
}

async function main() {
  checkEnv();
  const rest = new REST({ version: "10" }).setToken(DISCORD_BOT_TOKEN);
  try {
    if (GLOBAL_MODE) await registerGlobal(rest);
    else await registerGuild(rest);
  } catch (error) {
    explainFailure(error);
    process.exit(1);
  }
}

main();
