require("./helpers/setupTestEnv");

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { extractWebhookIds, parseEvents, parseDmEvents, parsePriorityEmbedEvent, reconstructSessions } = require("../scripts/backfill-live-history");

test("extractWebhookIds - narik id & token dari DISCORD_WEBHOOK_URL, error kalau formatnya gak dikenali", () => {
  const { webhookId, webhookToken } = extractWebhookIds("https://discord.com/api/webhooks/123456789/abcDEF-token_123");
  assert.equal(webhookId, "123456789");
  assert.equal(webhookToken, "abcDEF-token_123");

  assert.throws(() => extractWebhookIds("https://discord.com/not-a-webhook-url"));
});

function fakeMessage({ webhookId = "wh-1", content, createdTimestamp }) {
  return { webhookId, content, createdTimestamp };
}

test("parseEvents - matching pesan start/end sesuai format buildNormalPayload, plus mention subscriber di ekor start", () => {
  const messages = [
    fakeMessage({
      content: "🚨 **Aralie** lagi live di IDN Live!\nNonton di sini: https://idn.app/jkt48_aralie/live/slug-123",
      createdTimestamp: 1000,
    }),
    fakeMessage({
      // start dengan tag subscriber di ekornya - harus tetep ke-parse walau ada teks tambahan
      content:
        "🚨 **Erine** lagi live di IDN Live!\nNonton di sini: https://idn.app/jkt48_erine/live/slug-456\n<@123> kamu subscribe notif buat member ini!",
      createdTimestamp: 2000,
    }),
    fakeMessage({ content: "✅ **Aralie** udah selesai live di IDN Live.", createdTimestamp: 3000 }),
  ];

  const events = parseEvents(messages, "wh-1");
  assert.equal(events.length, 3);
  assert.deepEqual(
    events.map((e) => e.type),
    ["start", "start", "end"],
  );
  assert.equal(events[1].name, "Erine");
  assert.equal(events[1].username, "jkt48_erine");
});

test("parseEvents - pesan dari webhook LAIN (mis. orang ngetik teks mirip) diabaikan", () => {
  const messages = [
    fakeMessage({
      webhookId: "wh-BEDA",
      content: "🚨 **Palsu** lagi live di IDN Live!\nNonton di sini: https://idn.app/jkt48_palsu/live/x",
      createdTimestamp: 1000,
    }),
  ];
  assert.equal(parseEvents(messages, "wh-1").length, 0);
});

test("parseEvents - pesan chat biasa (bukan format notif) diabaikan", () => {
  const messages = [fakeMessage({ content: "cok siapa yang live?", createdTimestamp: 1000 })];
  assert.equal(parseEvents(messages, "wh-1").length, 0);
});

// FORMAT LAMA (sebelum commit 0bd317e, 2026-09-18 11:40 WIB): notif channel
// buat member PRIORITAS (Nala/Levi/Lily/custom) dulu pake EMBED
// (priority/index.js's buildPriorityPayload), bukan plain content kayak
// buildNormalPayload - persis bug yang dilaporin user (histori Nala gak
// ke-track sama sekali walau jelas sering live, soalnya SEMUA live-nya
// sebelum tanggal itu make format ini).
function fakePriorityStartMessage({ name = "Nala", username = "jkt48_nala", createdTimestamp = 1000 } = {}) {
  return {
    webhookId: "wh-1",
    content: `<@owner-id> 🚨🔥🚨🚨🔥🚨 **JANGAN SAMPE KETINGGALAN!** 🚨🔥🚨🚨🔥🚨`,
    embeds: [
      {
        title: "⚡ PRIORITAS #1: NALA LIVE SEKARANG! ⚡",
        description: `**${name}** baru aja mulai live di IDN Live.`,
        url: `https://idn.app/${username}/live/slug-abc`,
        color: 0x1abc9c,
      },
    ],
    createdTimestamp,
  };
}

function fakePriorityEndMessage({ name = "Nala", username = "jkt48_nala", createdTimestamp = 2000, withThankYou = false } = {}) {
  return {
    webhookId: "wh-1",
    content: `<@owner-id> 🚨🔥🚨 Live prioritas **#1 NALA** udah selesai.${withThankYou ? " 💌" : ""}`,
    embeds: [
      {
        title: withThankYou ? "💚 NALA sudah selesai live - makasih ya!" : "NALA sudah selesai live",
        description: name,
        color: 0x1abc9c,
        url: `https://idn.app/${username}/live/slug-abc`,
        ...(withThankYou ? { fields: [{ name: "💌 Pesan dari NALA", value: "Makasih ya!" }] } : {}),
      },
    ],
    createdTimestamp,
  };
}

test("parsePriorityEmbedEvent - format embed lama buat start/end member prioritas ke-parse bener (nama + username dari embed, bukan content)", () => {
  const startEvent = parsePriorityEmbedEvent(fakePriorityStartMessage({ name: "Nala", username: "jkt48_nala", createdTimestamp: 1000 }));
  assert.deepEqual(startEvent, { type: "start", name: "Nala", username: "jkt48_nala", atMs: 1000 });

  const endEvent = parsePriorityEmbedEvent(fakePriorityEndMessage({ name: "Nala", createdTimestamp: 2000 }));
  assert.deepEqual(endEvent, { type: "end", name: "Nala", atMs: 2000 });

  // Varian "makasih ya" (endMessagePool, khusus Nala) - title-nya beda tapi tetep harus ke-parse.
  const endWithThankYou = parsePriorityEmbedEvent(fakePriorityEndMessage({ name: "Nala", createdTimestamp: 3000, withThankYou: true }));
  assert.deepEqual(endWithThankYou, { type: "end", name: "Nala", atMs: 3000 });
});

test("parsePriorityEmbedEvent - pesan tanpa embed atau embed yang gak cocok pola balikin null", () => {
  assert.equal(parsePriorityEmbedEvent({ embeds: [], content: "halo" }), null);
  assert.equal(parsePriorityEmbedEvent({ embeds: [{ title: "Judul random", description: "apa aja" }] }), null);
});

// BUG (ditemuin owner lewat scripts/count-priority-notifs.js: keyword search
// nemu 10 pesan "JANGAN SAMPE KETINGGALAN" di channel, tapi parse terstruktur
// cuma dapet 0). 4 HARI PERTAMA fitur notif prioritas jalan (73ddeba,
// 2026-09-13 19:13 WIB, sampai b595d90, 2026-09-17 21:49 WIB - sebelum link
// "TONTON SEKARANG" dipindah jadi tombol), embeds[0].description masih
// nyantumin baris link manual DI BELAKANG nama member. PRIORITY_START_DESC_RE
// lama pake jangkar `$` di ujung, jadi HANYA cocok buat format PENDEK yang
// lebih baru - format PANJANG (4 hari pertama) gagal total, bukan sebagian.
test("parsePriorityEmbedEvent - format description LAMA (4 hari pertama fitur ini, masih nyantumin link 'TONTON SEKARANG' manual) tetap ke-parse", () => {
  const msg = {
    embeds: [
      {
        title: "⚡ PRIORITAS #1: NALA LIVE SEKARANG! ⚡",
        description: "**Nala** baru aja mulai live di IDN Live.\n\n[🔴 **TONTON SEKARANG**](https://idn.app/jkt48_nala/live/slug-abc)",
        url: "https://idn.app/jkt48_nala/live/slug-abc",
      },
    ],
    createdTimestamp: 1000,
  };

  const event = parsePriorityEmbedEvent(msg);
  assert.deepEqual(event, { type: "start", name: "Nala", username: "jkt48_nala", atMs: 1000 });
});

test("parseEvents - format embed prioritas LAMA dan format plain BARU bisa ketangkep bareng dalam 1 channel yang sama", () => {
  const messages = [
    fakePriorityStartMessage({ name: "Nala", username: "jkt48_nala", createdTimestamp: 1000 }),
    fakePriorityEndMessage({ name: "Nala", createdTimestamp: 2000 }),
    fakeMessage({
      content: "🚨 **Aralie** lagi live di IDN Live!\nNonton di sini: https://idn.app/jkt48_aralie/live/slug-123",
      createdTimestamp: 3000,
    }),
    fakeMessage({ content: "✅ **Aralie** udah selesai live di IDN Live.", createdTimestamp: 4000 }),
  ];

  const { sessions } = reconstructSessions(parseEvents(messages, "wh-1"));
  assert.equal(sessions.length, 2);
  const byName = Object.fromEntries(sessions.map((s) => [s.name, s]));
  assert.equal(byName.Nala.username, "jkt48_nala");
  assert.equal(byName.Aralie.username, "jkt48_aralie");
});

// SEJAK 0bd317e, notif flashy prioritas dikirim lewat DM (bot -> pemilik),
// bukan lewat webhook ke channel - author-nya si bot sendiri, bukan
// webhookId. parseDmEvents yang nge-handle ini (lihat komentarnya di
// scripts/backfill-live-history.js).
function fakeDmMessage({ botUserId = "bot-1", embeds, createdTimestamp }) {
  return { author: { id: botUserId }, embeds, content: "", createdTimestamp };
}

test("parseDmEvents - pesan DM dari bot sendiri (author.id cocok) ke-parse, pesan dari user lain diabaikan", () => {
  const startEmbed = fakePriorityStartMessage({ name: "Nala", username: "jkt48_nala", createdTimestamp: 5000 }).embeds;
  const endEmbed = fakePriorityEndMessage({ name: "Nala", createdTimestamp: 6000 }).embeds;

  const messages = [
    fakeDmMessage({ botUserId: "bot-1", embeds: startEmbed, createdTimestamp: 5000 }),
    fakeDmMessage({ botUserId: "bot-1", embeds: endEmbed, createdTimestamp: 6000 }),
    // pesan dari user (bukan bot) - author.id BEDA, harus diabaikan walau embed-nya kebetulan mirip
    fakeDmMessage({ botUserId: "user-lain", embeds: startEmbed, createdTimestamp: 7000 }),
  ];

  const events = parseDmEvents(messages, "bot-1");
  assert.equal(events.length, 2);
  assert.deepEqual(
    events.map((e) => e.type),
    ["start", "end"],
  );
  assert.equal(events[0].username, "jkt48_nala");
});

test("reconstructSessions - pasangin start->end per nama, termasuk 2x live berturut-turut buat member yang SAMA", () => {
  const events = [
    { type: "start", name: "Nala", username: "jkt48_nala", atMs: 1000 },
    { type: "end", name: "Nala", atMs: 2000 },
    { type: "start", name: "Nala", username: "jkt48_nala", atMs: 3000 },
    { type: "end", name: "Nala", atMs: 4000 },
  ];

  const { sessions, unmatchedStarts, unmatchedEnds } = reconstructSessions(events);
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].startedAtUnix, 1);
  assert.equal(sessions[0].endedAtUnix, 2);
  assert.equal(sessions[1].startedAtUnix, 3);
  assert.equal(sessions[1].endedAtUnix, 4);
  assert.equal(unmatchedStarts.length, 0);
  assert.equal(unmatchedEnds.length, 0);
});

test("reconstructSessions - 'start' tanpa 'end' (live yang masih jalan pas histori diambil) masuk unmatchedStarts, BUKAN dipaksa jadi sesi", () => {
  const events = [{ type: "start", name: "Levi", username: "jkt48_levi", atMs: 1000 }];
  const { sessions, unmatchedStarts } = reconstructSessions(events);
  assert.equal(sessions.length, 0);
  assert.equal(unmatchedStarts.length, 1);
  assert.equal(unmatchedStarts[0].name, "Levi");
});

test("reconstructSessions - 'end' tanpa 'start' sebelumnya masuk unmatchedEnds, BUKAN ditebak waktu mulainya", () => {
  const events = [{ type: "end", name: "Lily", atMs: 1000 }];
  const { sessions, unmatchedEnds } = reconstructSessions(events);
  assert.equal(sessions.length, 0);
  assert.equal(unmatchedEnds.length, 1);
});

test("reconstructSessions - dua member BEDA live bersamaan gak saling ketuker pasangannya", () => {
  const events = [
    { type: "start", name: "Nala", username: "jkt48_nala", atMs: 1000 },
    { type: "start", name: "Levi", username: "jkt48_levi", atMs: 1500 },
    { type: "end", name: "Levi", atMs: 2000 },
    { type: "end", name: "Nala", atMs: 2500 },
  ];

  const { sessions } = reconstructSessions(events);
  assert.equal(sessions.length, 2);
  const byName = Object.fromEntries(sessions.map((s) => [s.name, s]));
  assert.equal(byName.Nala.startedAtUnix, 1);
  assert.equal(byName.Nala.endedAtUnix, 2);
  assert.equal(byName.Levi.startedAtUnix, 1);
  assert.equal(byName.Levi.endedAtUnix, 2);
});

// BUG FATAL yang dilaporin user: rekap nunjukkin durasi ratusan jam (121j,
// 122j, dll). Root cause-nya versi FIFO lama - kalau ada 2 "start" numpuk
// tanpa "end" di antaranya buat member yang SAMA (mis. bot sempet restart di
// tengah live, notif "mulai live" kekirim ULANG), "end" berikutnya kepasangin
// ke "start" YANG PALING TUA di antrian, bukan yang paling relevan (paling
// baru) - durasinya jadi ngaco parah. Regresi ini mastiin start KEDUA (bukan
// yang pertama) yang menang, dan start pertama yang "ke-orphan" masuk
// unmatchedStarts, BUKAN diam-diam ilang atau kepasangin salah.
test("reconstructSessions - 2 'start' numpuk tanpa 'end' di antaranya (member sama) TIDAK kepasangin ke end yang salah - ini bug fatal yang dilaporin user", () => {
  const events = [
    { type: "start", name: "Aralie", username: "jkt48_aralie", atMs: 1000 },
    { type: "start", name: "Aralie", username: "jkt48_aralie", atMs: 2000 }, // start kedua numpuk, gak ada 'end' di antara 1000 dan ini
    { type: "end", name: "Aralie", atMs: 3000 },
  ];

  const { sessions, unmatchedStarts } = reconstructSessions(events);

  // Sesi yang kebentuk HARUS pasangan start KEDUA (2000) + end (3000), BUKAN
  // start PERTAMA (1000) + end (3000) - versi lama bakal ngasilin durasi 2
  // detik yang salah (dari start 1000), bukan 1 detik yang bener (dari start
  // kedua, 2000).
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].startedAtUnix, 2);
  assert.equal(sessions[0].endedAtUnix, 3);

  // Start pertama yang ke-orphan HARUS kecatet di unmatchedStarts, bukan
  // ilang diem-diem atau kepasangin ke end yang salah.
  assert.equal(unmatchedStarts.length, 1);
  assert.equal(unmatchedStarts[0].atMs, 1000);
});

test("reconstructSessions - sesi dengan durasi implausible (>12 jam) dibuang ke discardedSessions, bukan diloloskan sebagai sesi beneran", () => {
  const events = [
    { type: "start", name: "Indah", username: "jkt48_indah", atMs: 0 },
    { type: "end", name: "Indah", atMs: 13 * 60 * 60 * 1000 }, // 13 jam - implausible
    { type: "start", name: "Jessi", username: "jkt48_jessi", atMs: 0 },
    { type: "end", name: "Jessi", atMs: 60 * 60 * 1000 }, // 1 jam - wajar
  ];

  const { sessions, discardedSessions } = reconstructSessions(events);

  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].name, "Jessi");

  assert.equal(discardedSessions.length, 1);
  assert.equal(discardedSessions[0].name, "Indah");
});
