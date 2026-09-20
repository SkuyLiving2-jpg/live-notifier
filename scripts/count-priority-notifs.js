// Tool CLI MANUAL, READ-ONLY - dijalanin sendiri di komputermu, BUKAN bagian
// dari bot Discord yang jalan 24 jam di Railway (sama kategorinya kayak
// backfill-live-history.js/repair-live-history.js).
//
// KENAPA INI ADA: owner pengen tau ada berapa banyak notif flashy "JANGAN
// SAMPE KETINGGALAN!" (member prioritas mulai live) yang pernah kekirim di
// CHANNEL (BUKAN DM - owner sengaja minta DM dilewatin). Script ini CUMA
// MEMBACA histori pesan channel dan ngitung, TANPA nulis/ngirim apa-apa ke
// mana pun - beda dari backfill-live-history.js (yang ngirim hasil ke bot)
// atau repair-live-history.js (yang beneran ngubah data) - script ini murni
// laporan.
//
// Dua cara ngitung yang dipake bareng buat saling ngecek:
// 1. Keyword search MENTAH - cari teks "JANGAN SAMPE KETINGGALAN" langsung
//    di message.content, dari SIAPAPUN pengirimnya (paling literal, sesuai
//    yang diminta owner).
// 2. Parse TERSTRUKTUR (parsePriorityEmbedEvent, sama persis yang dipake
//    backfill-live-history.js) - cuma pesan dari WEBHOOK bot ini (bukan
//    orang iseng ngetik teks mirip) yang embed-nya valid, dipecah per
//    member. Kalau angka #1 dan #2 beda jauh, kemungkinan ada pesan yang
//    keyword-nya nyantol tapi embed-nya rusak/beda, atau dari webhook lain -
//    layak dicek manual.
//
// Jalanin: npm run count-priority-notifs
// Butuh di .env: DISCORD_BOT_TOKEN, DISCORD_WEBHOOK_URL.

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const { createDiscordClient } = require("../src/discordClient");
const { extractWebhookIds, resolveWebhookChannelId, fetchAllMessages, parsePriorityEmbedEvent } = require("./backfill-live-history");

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || "";
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || "";

const KEYWORD_RE = /jangan sampe ketinggalan/i;

async function main() {
  const missing = [
    ["DISCORD_BOT_TOKEN", DISCORD_BOT_TOKEN],
    ["DISCORD_WEBHOOK_URL", DISCORD_WEBHOOK_URL],
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
    console.log("Narik histori channel (bisa agak lama kalau channel-nya rame)...");
    const channel = await client.channels.fetch(channelId);
    const messages = await fetchAllMessages(channel);
    console.log(`Total ${messages.length} pesan ditarik dari channel.\n`);

    const keywordMatches = messages.filter((m) => KEYWORD_RE.test(m.content || ""));
    console.log(`=== Keyword search mentah: "${keywordMatches.length}" pesan ngandung "JANGAN SAMPE KETINGGALAN" ===`);
    const byAuthor = new Map();
    for (const m of keywordMatches) {
      const key = m.webhookId ? `webhook:${m.webhookId === webhookId ? "bot ini" : m.webhookId}` : `user:${m.author?.id || "?"}`;
      byAuthor.set(key, (byAuthor.get(key) || 0) + 1);
    }
    for (const [key, count] of byAuthor.entries()) {
      console.log(`  - ${key}: ${count}x`);
    }

    const botKeywordMatches = keywordMatches.filter((m) => m.webhookId === webhookId);
    const parsedByMsg = new Map(botKeywordMatches.map((m) => [m, parsePriorityEmbedEvent(m)]));
    const startEvents = [...parsedByMsg.values()].filter((ev) => ev && ev.type === "start");
    const byName = new Map();
    for (const ev of startEvents) {
      byName.set(ev.name, (byName.get(ev.name) || 0) + 1);
    }
    const structuredTotal = [...byName.values()].reduce((a, b) => a + b, 0);

    console.log(`\n=== Parse terstruktur (embed valid, dari webhook bot ini doang): ${structuredTotal} notif "mulai live" prioritas ===`);
    console.log("Nama member yang ketemu di keyword ini:");
    [...byName.entries()].sort((a, b) => b[1] - a[1]).forEach(([name, count]) => console.log(`  - ${name}: ${count}x`));

    // Buat pesan yang keyword-nya nyantol TAPI parsePriorityEmbedEvent masih
    // gagal (embed.description formatnya beda dari yang udah dikenal) - dump
    // detail mentahnya di sini, biar kecek manual bukannya diem-diem ilang
    // dari hitungan.
    const unparsed = botKeywordMatches.filter((m) => !parsedByMsg.get(m));
    if (unparsed.length > 0) {
      console.log(`\n=== ${unparsed.length} pesan keyword yang MASIH gagal ke-parse - detail mentahnya ===`);
      unparsed.forEach((m, i) => {
        const embed = m.embeds && m.embeds[0];
        console.log(`[${i + 1}] ${new Date(m.createdTimestamp).toISOString()}`);
        console.log(`    content: ${m.content}`);
        console.log(`    embed.title: ${embed?.title}`);
        console.log(`    embed.description: ${embed?.description}`);
        console.log(`    embed.url: ${embed?.url}`);
      });
    }

    if (keywordMatches.length !== structuredTotal) {
      console.log(
        `\nCatatan: angka keyword (${keywordMatches.length}) beda sama angka terstruktur (${structuredTotal}) - ${unparsed.length > 0 ? "lihat detail pesan yang gagal ke-parse di atas" : "kemungkinan ada yang bukan dari webhook bot ini, lihat daftar per-pengirim di atas"}.`,
      );
    }
  } finally {
    client.destroy();
  }
}

main().catch((error) => {
  console.error("Gagal:", error.message);
  process.exit(1);
});
