// Tool CLI MANUAL, SEKALI PAKAI - dijalanin sendiri di komputermu, BUKAN
// bagian dari bot Discord yang jalan 24 jam di Railway (sama kategorinya
// kayak cek-top-gifter.js/backup-data.js).
//
// KENAPA INI ADA: daily-log.json (arsip live yang dipake buat "cok rekap
// minggu/bulan ini") baru jadi arsip beneran (nggak reset tiap hari) sejak
// 2026-09-19 - lihat ARCHITECTURE.md §10's bug-history keempat. Nggak ada
// cara "benerin kode" buat nutup celah itu, soalnya datanya emang beneran
// nggak pernah kesimpen. TAPI - selama kamu belum pernah hapus histori
// chat-nya, channel notifikasi Discord kamu SENDIRI masih nyimpen tiap
// pesan "🚨 X lagi live" / "✅ X udah selesai live" dari awal bot jalan.
// Script ini baca histori pesan itu, rekonstruksi jadi sesi live
// (start+end per member), dan kirim hasilnya ke bot yang lagi jalan di
// Railway lewat endpoint /api/backfill-live-history yang nyimpennya ke
// Volume beneran (script ini SENDIRI nggak bisa nulis langsung ke situ,
// makanya lewat endpoint - sama pola kayak cek-top-gifter.js/backup-data.js).
//
// Aman dijalanin berkali-kali (idempotent) - lihat komentar di
// src/server.js's handleBackfillLiveHistory buat kenapa.
//
// Jalanin: npm run backfill-live-history           (DRY RUN, cuma preview, gak nulis apa-apa)
//          npm run backfill-live-history -- --apply (BENERAN nulis ke Railway)
//
// Butuh di .env: DISCORD_BOT_TOKEN, DISCORD_WEBHOOK_URL (buat baca histori
// pesan), BOT_API_URL, API_SECRET (buat ngirim hasilnya ke bot - sama env
// var yang dipake cek-top-gifter.js/backup-data.js).

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const { signPayload } = require("../src/security");
const { createDiscordClient } = require("../src/discordClient");

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || "";
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || "";
const BOT_API_URL = process.env.BOT_API_URL || "";
const API_SECRET = process.env.API_SECRET || "";

// Persis format buildNormalPayload() di src/notify/liveNotify.js - kalau itu
// berubah, regex ini juga perlu di-update. "start" nyantumin liveUrl (jadi
// bisa ditarik username IDN-nya dari situ); "end" CUMA nama doang, jadi
// username-nya diambil dari pasangan "start"-nya (lihat reconstructSessions).
const START_RE = /^🚨 \*\*(.+?)\*\* lagi live di IDN Live!\nNonton di sini: https:\/\/idn\.app\/([^/]+)\/live\/\S+/;
const END_RE = /^✅ \*\*(.+?)\*\* udah selesai live di IDN Live\./;

function extractWebhookIds(webhookUrl) {
  const match = webhookUrl.match(/\/webhooks\/(\d+)\/([^/?]+)/);
  if (!match) throw new Error("DISCORD_WEBHOOK_URL formatnya nggak dikenali (harusnya .../webhooks/<id>/<token>)");
  return { webhookId: match[1], webhookToken: match[2] };
}

// GET webhook itu sendiri - endpoint publik Discord, gak butuh bot token,
// dipake CUMA buat narik channel_id-nya (satu-satunya info yang gak
// kebaca dari URL webhook-nya sendiri).
async function resolveWebhookChannelId(webhookId, webhookToken) {
  const res = await fetch(`https://discord.com/api/webhooks/${webhookId}/${webhookToken}`);
  if (!res.ok) throw new Error(`Gagal resolve webhook (status ${res.status}) - webhook-nya masih valid?`);
  const data = await res.json();
  return data.channel_id;
}

async function fetchAllMessages(channel) {
  const all = [];
  let before;
  while (true) {
    const batch = await channel.messages.fetch({ limit: 100, before });
    if (batch.size === 0) break;
    all.push(...batch.values());
    if (all.length % 500 === 0) console.log(`  ...udah narik ${all.length} pesan...`);
    before = batch.last().id;
    if (batch.size < 100) break;
  }
  return all;
}

// Cuma percaya pesan yang BENERAN dari webhook ini (message.webhookId cocok)
// - biar gak ketipu kalau ada orang iseng ngetik teks yang mirip formatnya.
function parseEvents(messages, webhookId) {
  const events = [];
  for (const msg of messages) {
    if (msg.webhookId !== webhookId) continue;
    const content = (msg.content || "").trim();

    const startMatch = content.match(START_RE);
    if (startMatch) {
      events.push({ type: "start", name: startMatch[1], username: startMatch[2], atMs: msg.createdTimestamp });
      continue;
    }
    const endMatch = content.match(END_RE);
    if (endMatch) {
      events.push({ type: "end", name: endMatch[1], atMs: msg.createdTimestamp });
    }
  }
  events.sort((a, b) => a.atMs - b.atMs);
  return events;
}

// Pasangin "start" -> "end" PER NAMA, FIFO (start paling tua dipasangin ke
// end paling tua berikutnya buat nama yang sama) - cukup buat pola normal
// (1 live berjalan per member di satu waktu). "start" tanpa "end" (mis. live
// yang masih jalan pas histori diambil) dan "end" tanpa "start" (mis. pesan
// start-nya kehapus manual) SENGAJA dilewatin, bukan ditebak-tebak.
function reconstructSessions(events) {
  const openByName = new Map();
  const sessions = [];
  const unmatchedEnds = [];

  for (const ev of events) {
    if (ev.type === "start") {
      if (!openByName.has(ev.name)) openByName.set(ev.name, []);
      openByName.get(ev.name).push({ username: ev.username, atMs: ev.atMs });
      continue;
    }
    const queue = openByName.get(ev.name);
    if (queue && queue.length > 0) {
      const start = queue.shift();
      sessions.push({
        name: ev.name,
        username: start.username,
        startedAtUnix: Math.floor(start.atMs / 1000),
        endedAtUnix: Math.floor(ev.atMs / 1000),
      });
    } else {
      unmatchedEnds.push(ev);
    }
  }

  const unmatchedStarts = [...openByName.entries()].flatMap(([name, queue]) => queue.map((s) => ({ name, ...s })));
  return { sessions, unmatchedStarts, unmatchedEnds };
}

async function pushToBot(sessions, dryRun) {
  const bodyString = JSON.stringify({ sessions, dryRun });
  const timestamp = Date.now().toString();
  const signature = signPayload(API_SECRET, timestamp, bodyString);

  const res = await fetch(`${BOT_API_URL.replace(/\/+$/, "")}/api/backfill-live-history`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Api-Timestamp": timestamp, "X-Api-Signature": signature },
    body: bodyString,
  });

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`Bot balikin status ${res.status}: ${data ? JSON.stringify(data) : "(gak ada detail)"}`);
  }
  return data;
}

async function main() {
  const apply = process.argv.includes("--apply");

  const missing = [
    ["DISCORD_BOT_TOKEN", DISCORD_BOT_TOKEN],
    ["DISCORD_WEBHOOK_URL", DISCORD_WEBHOOK_URL],
    ["BOT_API_URL", BOT_API_URL],
    ["API_SECRET", API_SECRET],
  ]
    .filter(([, value]) => !value)
    .map(([key]) => key);
  if (missing.length > 0) {
    console.error(`Env var berikut harus diisi di .env dulu: ${missing.join(", ")}`);
    process.exit(1);
  }

  const { webhookId, webhookToken } = extractWebhookIds(DISCORD_WEBHOOK_URL);

  console.log("Nyari channel dari DISCORD_WEBHOOK_URL...");
  const channelId = await resolveWebhookChannelId(webhookId, webhookToken);

  console.log("Login bot Discord...");
  const client = createDiscordClient();
  await client.login(DISCORD_BOT_TOKEN);
  await new Promise((resolve) => client.once("clientReady", resolve));

  try {
    console.log("Narik histori pesan (bisa agak lama kalau channel-nya rame)...");
    const channel = await client.channels.fetch(channelId);
    const messages = await fetchAllMessages(channel);
    console.log(`Total ${messages.length} pesan ditarik dari channel.`);

    const events = parseEvents(messages, webhookId);
    const { sessions, unmatchedStarts, unmatchedEnds } = reconstructSessions(events);

    console.log(`\n${sessions.length} sesi live berhasil direkonstruksi (start+end kepasangin).`);
    if (unmatchedStarts.length > 0) {
      console.log(`${unmatchedStarts.length} "mulai live" tanpa pasangan "selesai" (dilewatin, mis. live yang masih jalan pas histori diambil):`);
      unmatchedStarts.forEach((s) => console.log(`  - ${s.name} (${new Date(s.atMs).toISOString()})`));
    }
    if (unmatchedEnds.length > 0) {
      console.log(`${unmatchedEnds.length} "selesai live" tanpa pasangan "mulai" (dilewatin):`);
      unmatchedEnds.forEach((e) => console.log(`  - ${e.name} (${new Date(e.atMs).toISOString()})`));
    }

    if (sessions.length === 0) {
      console.log("\nGak ada sesi yang bisa direkonstruksi - gak ada yang dikirim ke bot.");
      return;
    }

    console.log(`\nNgirim ke bot (${apply ? "BENERAN NULIS" : "DRY RUN, preview doang"})...`);
    const result = await pushToBot(sessions, !apply);
    console.log("\nHasil dari bot:");
    console.log(JSON.stringify(result, null, 2));

    if (!apply) {
      console.log('\nIni baru PREVIEW - jalanin lagi dengan "npm run backfill-live-history -- --apply" buat beneran nulis ke Railway.');
    } else {
      console.log("\nSelesai. Coba tanya bot 'cok berapa kali <nama> live' atau 'cok rekap minggu ini' buat verifikasi.");
    }
  } finally {
    client.destroy();
  }
}

// Guard biar file ini bisa di-require dari test (tests/backfillLiveHistory.test.js
// nge-tes parseEvents/reconstructSessions/extractWebhookIds langsung - fungsi
// pure, gak nyentuh Discord/network) TANPA otomatis nge-trigger main() (yang
// butuh kredensial beneran & nembak Discord API sungguhan).
if (require.main === module) {
  main().catch((error) => {
    console.error("Gagal:", error.message);
    process.exit(1);
  });
}

module.exports = { extractWebhookIds, parseEvents, reconstructSessions };
