// Tool CLI MANUAL - push pemetaan "username IDN -> webhook URL channel
// KHUSUS member itu" (fitur "Q2": selain notif di channel gabungan yang
// udah ada, member tertentu bisa punya channel-nya sendiri, mis.
// #aralie-jkt48) ke endpoint /api/channel-routing yang jalan di Railway.
// BUKAN bagian dari bot 24 jam (sama kategorinya kayak cek-top-gifter.js/
// backup-data.js) - dijalanin sendiri tiap kali mau nambah/ubah channel.
//
// KENAPA LEWAT SCRIPT, BUKAN CHAT: webhook URL itu SECRET (siapapun yang
// pegang bisa posting ke channel itu, ngaku-ngaku jadi bot). Ngetik/nempel
// puluhan URL kayak gitu ke chat Discord (walau ke bot sendiri) bakal
// nyangkut di histori pesan channel-nya selamanya - jauh lebih aman lewat
// file lokal yang di-push sekali jalan.
//
// Cara pakai:
//   1. Bikin channel-nya di Discord, buka Settings > Integrations > Webhooks
//      > New Webhook, copy URL-nya.
//   2. (OPSIONAL, buat fallback reply/tombol khusus member itu di channel-nya
//      sendiri - lihat src/chat/memberChannelReply.js) Aktifin Developer Mode
//      di Discord (Settings > Advanced), klik kanan nama channel-nya > Copy
//      Channel ID.
//   3. Isi/update channel-routing.local.json (di root project, SEJAJAR sama
//      .env - lihat channel-routing.local.json.example buat contoh formatnya).
//      Value-nya boleh string webhook URL polos (notif doang), ATAU object
//      { "webhookUrl": "...", "channelId": "..." } (notif + fallback chat).
//      File ini SENGAJA di-gitignore, jangan pernah di-commit.
//   4. Jalanin: npm run set-channel-routing
//
// SELALU full REPLACE (bukan nambahin) - isi file lokal dianggep daftar
// LENGKAP yang paling baru. Kalau mau hapus channel khusus member tertentu,
// cukup hapus barisnya dari file lokal terus jalanin lagi.
//
// Butuh di .env: BOT_API_URL, API_SECRET - env var yang SAMA PERSIS kayak
// yang dipake scripts/cek-top-gifter.js/backup-data.js.

const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const { signPayload } = require("../src/security");

const BOT_API_URL = process.env.BOT_API_URL || "";
const API_SECRET = process.env.API_SECRET || "";
const ROUTING_FILE = path.join(__dirname, "..", "channel-routing.local.json");

// Sama pola validasinya kayak server.js's handleChannelRoutingUpload (termasuk
// nerima domain lama discordapp.com juga, masih beneran jalan, DAN nerima
// dua bentuk value - string webhook URL polos, atau { webhookUrl, channelId })
// - dicek juga di sini (bukan cuma ngandelin server) biar typo ketauan
// LANGSUNG di komputer sendiri, bukan abis nunggu roundtrip network ke
// Railway dulu.
const DISCORD_WEBHOOK_URL_RE = /^https:\/\/discord(app)?\.com\/api\/webhooks\/\d+\/[^/?]+$/;
const DISCORD_SNOWFLAKE_RE = /^\d{17,20}$/;
function isValidRoutingEntry(entry) {
  if (typeof entry === "string") return DISCORD_WEBHOOK_URL_RE.test(entry);
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false;
  return typeof entry.webhookUrl === "string" && DISCORD_WEBHOOK_URL_RE.test(entry.webhookUrl) && DISCORD_SNOWFLAKE_RE.test(entry.channelId);
}

async function main() {
  if (!BOT_API_URL || !API_SECRET) {
    console.error("BOT_API_URL dan API_SECRET harus diisi di .env dulu (env var yang sama kayak buat cek-top-gifter.js - lihat .env.example).");
    process.exit(1);
  }

  if (!fs.existsSync(ROUTING_FILE)) {
    console.error(
      `Belum ada ${path.basename(ROUTING_FILE)} di root project. Bikin dulu, isinya { "jkt48_username": "https://discord.com/api/webhooks/.../..." }.`,
    );
    process.exit(1);
  }

  let mapping;
  try {
    mapping = JSON.parse(fs.readFileSync(ROUTING_FILE, "utf-8"));
  } catch (error) {
    console.error(`${path.basename(ROUTING_FILE)} bukan JSON valid:`, error.message);
    process.exit(1);
  }

  if (typeof mapping !== "object" || mapping === null || Array.isArray(mapping)) {
    console.error(`${path.basename(ROUTING_FILE)} harus berupa object { "username": "webhookUrl", ... }.`);
    process.exit(1);
  }

  const invalidUsernames = Object.entries(mapping)
    .filter(([, entry]) => !isValidRoutingEntry(entry))
    .map(([username]) => username);
  if (invalidUsernames.length > 0) {
    console.error(
      `Value bukan webhook URL Discord yang valid (atau { webhookUrl, channelId } dengan channelId bukan snowflake Discord) buat: ${invalidUsernames.join(", ")}`,
    );
    process.exit(1);
  }

  // BUG SEBELUMNYA: cuma nge-log pertanyaan ("lanjut push?") tanpa beneran
  // nunggu jawaban - script tetep lanjut push apapun kondisinya. Kalau file
  // lokal kebetulan kosong gak sengaja (kehapus isinya, typo nutup kurung
  // kurawal kepencet, dll), itu diam-diam NGOSONGIN semua channel khusus
  // yang udah keset di bot (full replace, lihat komen di atas), tanpa
  // beneran ada gerbang konfirmasi. Sekarang DIBATALKAN by default kalau
  // hasil parsing-nya kosong - harus eksplisit pake --allow-empty kalau
  // memang sengaja mau ngosongin semuanya.
  const count = Object.keys(mapping).length;
  if (count === 0 && !process.argv.includes("--allow-empty")) {
    console.error(
      `${path.basename(ROUTING_FILE)} kosong - dibatalkan, BUKAN dipush. Ini bakal ngosongin SEMUA channel khusus yang udah keset di bot kalau beneran dipush. Kalau memang sengaja mau ngosongin semuanya, jalanin lagi: npm run set-channel-routing -- --allow-empty`,
    );
    process.exit(1);
  }

  const bodyString = JSON.stringify(mapping);
  const timestamp = Date.now().toString();
  const signature = signPayload(API_SECRET, timestamp, bodyString);

  const res = await fetch(`${BOT_API_URL.replace(/\/+$/, "")}/api/channel-routing`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Api-Timestamp": timestamp,
      "X-Api-Signature": signature,
    },
    body: bodyString,
  });

  if (!res.ok) {
    const errBody = await res.json().catch(() => null);
    console.error(`Bot balikin status ${res.status}: ${errBody ? JSON.stringify(errBody) : "(gak ada detail)"}`);
    process.exit(1);
  }

  const data = await res.json();
  console.log(`Pemetaan channel ke-update di bot - ${data.count} member punya channel khusus sekarang.`);
}

main().catch((error) => {
  console.error("Gagal push pemetaan channel:", error.message);
  process.exit(1);
});
