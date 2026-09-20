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
const { PRIORITY_PING_USER_ID, MAX_PLAUSIBLE_LIVE_DURATION_MS } = require("../src/config");

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

// FORMAT LAMA (sebelum commit 0bd317e, 2026-09-18 11:40 WIB): notif flashy
// buat member PRIORITAS (Nala/Levi/Lily/custom) DULU keposting ke channel
// bersama ini juga (bukan DM kayak sekarang), pake EMBED (priority/index.js's
// buildPriorityPayload) - bukan plain `content` kayak buildNormalPayload.
// Histori live member prioritas dari SEBELUM tanggal itu nggak kebaca sama
// sekali kalau cuma ngecek `content` doang (persis bug yang dilaporin user:
// "Nala" keliatan gak pernah live padahal jelas udah sering) - jadi embed-nya
// juga perlu dicek. Nama member ada di embeds[0].description (bukan title -
// itu isinya label/rank generik, bukan nama), username ditarik dari
// embeds[0].url (link live-nya, format sama kayak yang di START_RE).
//
// PENTING soal PRIORITY_START_DESC_RE: SENGAJA gak dikasih jangkar `$` di
// akhir - embeds[0].description-nya sendiri berubah bentuk 2x sepanjang
// histori fitur ini (dites lewat "git log -S" di src/priority/index.js):
// dari commit 73ddeba (2026-09-13 19:13 WIB, fitur ini pertama ada) sampai
// b595d90 (2026-09-17 21:49 WIB), deskripsinya masih nyantumin baris link
// manual di belakang nama ("...di IDN Live.\n\n[🔴 **TONTON SEKARANG**](url)")
// - baru abis b595d90 (link-nya pindah jadi tombol beneran) deskripsinya jadi
// CUMA "...di IDN Live." doang. Versi SEBELUMNYA ini yang awalnya kelewat -
// regex lama pake `$` di ujung, jadi CUMA cocok buat format PENDEK yang lebih
// baru; format PANJANG (4 hari pertama fitur ini jalan) gagal ke-match sama
// sekali, dan durasi 4 hari itu sendiri makes it high-impact (channel jadi 0
// notif prioritas ke-parse walau keyword-nya jelas ada, lihat ARCHITECTURE.md
// §10's bug kesepuluh).
const PRIORITY_START_TITLE_RE = /^⚡ PRIORITAS #\d+: .+ LIVE SEKARANG! ⚡$/;
const PRIORITY_START_DESC_RE = /^\*\*(.+?)\*\* baru aja mulai live di IDN Live\./;
const PRIORITY_END_TITLE_RE = /sudah selesai live/;
const PRIORITY_EMBED_URL_RE = /^https:\/\/idn\.app\/([^/]+)\/live\//;

function parsePriorityEmbedEvent(msg) {
  const embed = msg.embeds && msg.embeds[0];
  if (!embed || typeof embed.title !== "string") return null;

  const urlMatch = typeof embed.url === "string" && embed.url.match(PRIORITY_EMBED_URL_RE);

  if (PRIORITY_START_TITLE_RE.test(embed.title) && typeof embed.description === "string" && urlMatch) {
    const descMatch = embed.description.match(PRIORITY_START_DESC_RE);
    if (descMatch) {
      return { type: "start", name: descMatch[1], username: urlMatch[1], atMs: msg.createdTimestamp };
    }
  }

  if (PRIORITY_END_TITLE_RE.test(embed.title) && typeof embed.description === "string" && embed.description.trim()) {
    return { type: "end", name: embed.description.trim(), atMs: msg.createdTimestamp };
  }

  return null;
}

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
// Dicek 2 format: plain (buildNormalPayload, SEMUA member sejak 0bd317e) dan
// embed lama (buildPriorityPayload, CUMA member prioritas, CUMA sebelum
// 0bd317e) - lihat komentar di parsePriorityEmbedEvent buat kenapa dua-duanya
// perlu, bukan cuma salah satu.
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
      continue;
    }

    const priorityEvent = parsePriorityEmbedEvent(msg);
    if (priorityEvent) events.push(priorityEvent);
  }
  events.sort((a, b) => a.atMs - b.atMs);
  return events;
}

// SEJAK commit 0bd317e (2026-09-18 11:40 WIB), notif flashy "JANGAN SAMPE
// KETINGGALAN!" buat member prioritas UDAH GAK diposting ke channel bersama
// sama sekali - dipindah jadi DM PRIBADI dari bot ke PRIORITY_PING_USER_ID
// (lihat notify/priorityDm.js's sendPriorityDM). Artinya histori live
// prioritas dari tanggal itu DAN SETERUSNYA cuma ada di thread DM ini, bukan
// di channel yang dibaca parseEvents() di atas - makanya sebelum fix ini,
// backfill selalu ngasih 0 buat live prioritas yang terjadi SETELAH tanggal
// itu (histori SEBELUM tanggal itu tetep kebaca normal lewat parseEvents,
// soalnya dulu masih diposting ke channel).
//
// DM-nya SELALU pake format embed (buildPriorityPayload - gak pernah plain
// content kayak buildNormalPayload), jadi parsePriorityEmbedEvent yang sama
// dipake lagi di sini, cuma bedanya "siapa yang dipercaya" ngirim pesannya:
// author-nya bot sendiri (client.user.id), BUKAN webhookId (DM gak lewat
// webhook sama sekali).
function parseDmEvents(messages, botUserId) {
  const events = [];
  for (const msg of messages) {
    if (msg.author?.id !== botUserId) continue;
    const priorityEvent = parsePriorityEmbedEvent(msg);
    if (priorityEvent) events.push(priorityEvent);
  }
  events.sort((a, b) => a.atMs - b.atMs);
  return events;
}

// Pasangin "start" -> "end" PER NAMA - SATU sesi terbuka per nama di satu
// waktu (member yang sama gak mungkin live 2x bersamaan), BUKAN antrian FIFO
// kayak versi sebelumnya. Versi FIFO lama nyimpen SEMUA "start" yang belum
// kepasangin dalam array per nama, dan "end" berikutnya selalu masangin ke
// yang PALING TUA di antrian itu - kalau ada 2 "start" numpuk tanpa "end" di
// antaranya (mis. bot sempet restart di tengah live terus notif "mulai live"
// kekirim ULANG buat live yang sama, atau notif "selesai" yang lama kehapus
// manual), "end" yang beneran buat "start" YANG BARU malah kepasangin ke
// "start" YANG LAMA - durasinya jadi ngaco parah (bisa ratusan jam), dan
// "start" yang baru masih nyangkut di antrian buat "end" SETERUSNYA, jadi
// makin lama makin ngaco (efek berantai). Ini PERSIS bug fatal yang
// dilaporin user (rekap nunjukkin durasi 121 jam, 122 jam, dll).
//
// Sekarang: "start" baru buat nama yang UDAH punya sesi terbuka nge-CLOSE
// (buang, bukan pasangin) sesi lama itu ke unmatchedStarts - lebih baik
// kehilangan satu histori yang emang gak lengkap (gak ada "end"-nya) daripada
// masangin ke "end" yang salah dan ngerusak durasi.
function reconstructSessions(events) {
  const openByName = new Map(); // name -> { username, atMs } - CUMA satu slot per nama
  const sessions = [];
  const discardedSessions = [];
  const unmatchedEnds = [];
  const unmatchedStarts = [];

  for (const ev of events) {
    if (ev.type === "start") {
      const orphaned = openByName.get(ev.name);
      if (orphaned) unmatchedStarts.push({ name: ev.name, ...orphaned });
      openByName.set(ev.name, { username: ev.username, atMs: ev.atMs });
      continue;
    }

    const open = openByName.get(ev.name);
    if (!open) {
      unmatchedEnds.push(ev);
      continue;
    }
    openByName.delete(ev.name);

    const session = {
      name: ev.name,
      username: open.username,
      startedAtUnix: Math.floor(open.atMs / 1000),
      endedAtUnix: Math.floor(ev.atMs / 1000),
    };
    // Jaring pengaman TERAKHIR - bahkan dengan pairing satu-slot di atas,
    // durasi implausible (mis. dari kombinasi pesan yang aneh/rusak) tetap
    // dibuang di sini, bukan diloloskan ke server (yang juga ngecek ulang,
    // tapi mending dicegah sedini mungkin & kelihatan di log lokal).
    const durationMs = (session.endedAtUnix - session.startedAtUnix) * 1000;
    if (durationMs > 0 && durationMs <= MAX_PLAUSIBLE_LIVE_DURATION_MS) {
      sessions.push(session);
    } else {
      discardedSessions.push(session);
    }
  }

  for (const [name, open] of openByName.entries()) {
    unmatchedStarts.push({ name, ...open });
  }
  unmatchedStarts.sort((a, b) => a.atMs - b.atMs);

  return { sessions, discardedSessions, unmatchedStarts, unmatchedEnds };
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
  if (!PRIORITY_PING_USER_ID) {
    console.log("PRIORITY_PING_USER_ID belum diset di .env - histori DM prioritas bakal dilewatin (channel biasa tetep dibaca normal).");
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

    // Histori DM prioritas ("JANGAN SAMPE KETINGGALAN!") - lihat komentar di
    // parseDmEvents buat kenapa ini thread TERPISAH dari channel di atas.
    if (PRIORITY_PING_USER_ID) {
      console.log("Narik histori DM prioritas dari pemilik bot...");
      const owner = await client.users.fetch(PRIORITY_PING_USER_ID);
      const dmChannel = await owner.createDM();
      const dmMessages = await fetchAllMessages(dmChannel);
      console.log(`Total ${dmMessages.length} pesan ditarik dari DM.`);

      const dmEvents = parseDmEvents(dmMessages, client.user.id);
      console.log(`${dmEvents.length} event prioritas ketemu di DM.`);
      events.push(...dmEvents);
      events.sort((a, b) => a.atMs - b.atMs);
    }

    const { sessions, discardedSessions, unmatchedStarts, unmatchedEnds } = reconstructSessions(events);

    console.log(`\n${sessions.length} sesi live berhasil direkonstruksi (start+end kepasangin).`);
    if (discardedSessions.length > 0) {
      console.log(
        `${discardedSessions.length} sesi DIBUANG karena durasinya gak masuk akal (>${MAX_PLAUSIBLE_LIVE_DURATION_MS / 3600000} jam - kemungkinan pairing start/end yang salah, mis. notif "selesai"-nya sempet kehapus manual):`,
      );
      discardedSessions.forEach((s) =>
        console.log(`  - ${s.name}: ${new Date(s.startedAtUnix * 1000).toISOString()} -> ${new Date(s.endedAtUnix * 1000).toISOString()}`),
      );
    }
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

module.exports = {
  extractWebhookIds,
  resolveWebhookChannelId,
  fetchAllMessages,
  parseEvents,
  parseDmEvents,
  parsePriorityEmbedEvent,
  reconstructSessions,
};
