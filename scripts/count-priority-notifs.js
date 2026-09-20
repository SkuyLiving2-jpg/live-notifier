// Tool CLI MANUAL, READ-ONLY - dijalanin sendiri di komputermu, BUKAN bagian
// dari bot Discord yang jalan 24 jam di Railway (sama kategorinya kayak
// backfill-live-history.js/repair-live-history.js).
//
// KENAPA INI ADA: owner pengen tau ada berapa banyak notif flashy "JANGAN
// SAMPE KETINGGALAN!" (member prioritas mulai live) yang pernah kekirim
// sepanjang histori bot ini. Script ini CUMA MEMBACA histori pesan Discord
// (channel + DM prioritas - lihat scripts/backfill-live-history.js's
// komentar soal kenapa dua-duanya, dipisah di 0bd317e) dan ngitung, TANPA
// nulis/ngirim apa-apa ke mana pun - beda dari backfill-live-history.js
// (yang ngirim hasil ke bot) atau repair-live-history.js (yang beneran
// ngubah data) - script ini murni laporan.
//
// Jalanin: npm run count-priority-notifs
//
// Butuh di .env: DISCORD_BOT_TOKEN, DISCORD_WEBHOOK_URL (buat baca histori
// channel). PRIORITY_PING_USER_ID opsional tapi disaranin diisi - tanpa itu,
// histori DM (notif prioritas SETELAH 2026-09-18, lihat 0bd317e) gak ke-baca
// sama sekali, dan angkanya bakal keliatan lebih kecil dari yang sebenarnya.

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const { createDiscordClient } = require("../src/discordClient");
const { PRIORITY_PING_USER_ID } = require("../src/config");
const { extractWebhookIds, resolveWebhookChannelId, fetchAllMessages, parsePriorityEmbedEvent } = require("./backfill-live-history");

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || "";
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || "";

function countStartsByName(events) {
  const byName = new Map();
  for (const ev of events) {
    if (ev.type !== "start") continue;
    byName.set(ev.name, (byName.get(ev.name) || 0) + 1);
  }
  return byName;
}

function mergeCounts(...maps) {
  const merged = new Map();
  for (const map of maps) {
    for (const [name, count] of map.entries()) {
      merged.set(name, (merged.get(name) || 0) + count);
    }
  }
  return merged;
}

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
  if (!PRIORITY_PING_USER_ID) {
    console.log("PRIORITY_PING_USER_ID belum diset - histori DM prioritas (sejak 2026-09-18) bakal DILEWATIN, angkanya jadi gak lengkap.\n");
  }

  const { webhookId, webhookToken } = extractWebhookIds(DISCORD_WEBHOOK_URL);

  console.log("Nyari channel dari DISCORD_WEBHOOK_URL...");
  const channelId = await resolveWebhookChannelId(webhookId, webhookToken);

  console.log("Login bot Discord...");
  const client = createDiscordClient();
  await client.login(DISCORD_BOT_TOKEN);
  await new Promise((resolve) => client.once("clientReady", resolve));

  try {
    console.log("Narik histori channel (format embed lama, sebelum 2026-09-18)...");
    const channel = await client.channels.fetch(channelId);
    const channelMessages = await fetchAllMessages(channel);
    const channelEvents = channelMessages
      .filter((m) => m.webhookId === webhookId)
      .map(parsePriorityEmbedEvent)
      .filter(Boolean);
    const channelCounts = countStartsByName(channelEvents);
    const channelTotal = [...channelCounts.values()].reduce((a, b) => a + b, 0);
    console.log(`  ${channelTotal} notif "mulai live" prioritas ketemu di channel.`);

    let dmCounts = new Map();
    let dmTotal = 0;
    if (PRIORITY_PING_USER_ID) {
      console.log("Narik histori DM prioritas (sejak 2026-09-18)...");
      const owner = await client.users.fetch(PRIORITY_PING_USER_ID);
      const dmChannel = await owner.createDM();
      const dmMessages = await fetchAllMessages(dmChannel);
      const dmEvents = dmMessages
        .filter((m) => m.author?.id === client.user.id)
        .map(parsePriorityEmbedEvent)
        .filter(Boolean);
      dmCounts = countStartsByName(dmEvents);
      dmTotal = [...dmCounts.values()].reduce((a, b) => a + b, 0);
      console.log(`  ${dmTotal} notif "mulai live" prioritas ketemu di DM.`);
    }

    const totalCounts = mergeCounts(channelCounts, dmCounts);
    const grandTotal = channelTotal + dmTotal;

    console.log(`\n=== TOTAL notif "JANGAN SAMPE KETINGGALAN!" (mulai live prioritas): ${grandTotal} ===`);
    console.log(`  Dari channel (sebelum 18 Sep 2026): ${channelTotal}`);
    console.log(`  Dari DM (18 Sep 2026 dan seterusnya): ${dmTotal}`);

    if (totalCounts.size > 0) {
      console.log("\nRincian per member:");
      [...totalCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .forEach(([name, count]) => {
          const c = channelCounts.get(name) || 0;
          const d = dmCounts.get(name) || 0;
          console.log(`  - ${name}: ${count}x (channel: ${c}, DM: ${d})`);
        });
    }
  } finally {
    client.destroy();
  }
}

main().catch((error) => {
  console.error("Gagal:", error.message);
  process.exit(1);
});
