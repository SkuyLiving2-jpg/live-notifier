require("./helpers/setupTestEnv");

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { saveDurationHistory, recordLiveDurationAt } = require("../src/storage/durationHistory");
const { recordLiveEnded } = require("../src/storage/dailyLog");
const { recordLiveCompleted } = require("../src/storage/liveCount");
const { activeLives } = require("../src/storage/activeLives");
const {
  replyDurationChart,
  computeDurationChartMetrics,
  drawDurationChart,
  mergeChartEntries,
  handleChartButton,
} = require("../src/chat/chartReply");

// PNG file selalu diawali 8 byte "magic number" ini - cara paling gampang
// mastiin drawDurationChart beneran ngasilin PNG valid tanpa perlu decode
// pixel-nya satu-satu (yang gak praktis dites di unit test).
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test("computeDurationChartMetrics - max/rata-rata/index rekor dari riwayat durasi", () => {
  const entries = [
    { name: "X", durationMs: 60 * 60_000, at: "2026-09-01T10:00:00.000Z" }, // 1j
    { name: "X", durationMs: 90 * 60_000, at: "2026-09-03T10:00:00.000Z" }, // 1j30m - rekor
    { name: "X", durationMs: 30 * 60_000, at: "2026-09-05T10:00:00.000Z" }, // 30m
  ];
  const metrics = computeDurationChartMetrics(entries);
  assert.equal(metrics.maxDurationMs, 90 * 60_000);
  assert.equal(metrics.avgDurationMs, 60 * 60_000); // (60+90+30)/3 = 60 menit
  assert.equal(metrics.recordIndex, 1, "sesi ke-2 (index 1) yang paling lama");
  assert.ok(metrics.scaleMaxMs > metrics.maxDurationMs, "skala Y dikasih headroom di atas nilai maksimal, biar bar/labelnya gak mentok ke tepi atas");
});

// Jaga-jaga murni - durasi 0 gak akan kejadian di praktik beneran (live yang
// SUKSES kecatet pasti > 0ms), tapi kalau somehow kejadian, skala Y gak
// boleh jadi 0 (bakal bikin valueToY ngebagi 0 -> NaN/Infinity, chart-nya
// rusak total).
test("computeDurationChartMetrics - semua durasi 0 -> scaleMaxMs tetap ada floor-nya, gak jadi 0", () => {
  const metrics = computeDurationChartMetrics([{ name: "X", durationMs: 0, at: "2026-09-01T10:00:00.000Z" }]);
  assert.ok(metrics.scaleMaxMs > 0);
});

test("drawDurationChart - balikin PNG buffer valid (signature bener) buat 1 sesi maupun banyak sesi", () => {
  const oneEntry = [{ name: "Chartsatu", durationMs: 45 * 60_000, at: "2026-09-10T10:00:00.000Z" }];
  const bufOne = drawDurationChart("Chartsatu", oneEntry);
  assert.ok(Buffer.isBuffer(bufOne));
  assert.deepEqual(bufOne.subarray(0, 8), PNG_SIGNATURE);
  assert.ok(bufOne.length > 100, "harus beneran ada isinya, bukan PNG kosong");

  const tenEntries = Array.from({ length: 10 }, (_, i) => ({
    name: "Chartsepuluh",
    durationMs: (30 + i * 5) * 60_000,
    at: `2026-09-${String(i + 1).padStart(2, "0")}T10:00:00.000Z`,
  }));
  const bufTen = drawDurationChart("Chartsepuluh", tenEntries);
  assert.deepEqual(bufTen.subarray(0, 8), PNG_SIGNATURE);
});

test("replyDurationChart - member ketemu di riwayat durasi -> balikin {content, files} dengan PNG attachment yang namanya bener", async () => {
  saveDurationHistory({
    jkt48_chartreplytest: [
      { name: "Chartreplytest", durationMs: 60 * 60_000, at: "2026-09-10T10:00:00.000Z" },
      { name: "Chartreplytest", durationMs: 90 * 60_000, at: "2026-09-12T10:00:00.000Z" },
    ],
  });

  const reply = await replyDurationChart("chartreplytest");
  assert.match(reply.content, /Grafik durasi live \*\*Chartreplytest\*\*/);
  assert.match(reply.content, /2 sesi terakhir/);
  assert.equal(reply.files.length, 1);
  assert.equal(reply.files[0].name, "grafik-jkt48_chartreplytest.png");
  assert.ok(Buffer.isBuffer(reply.files[0].attachment));
  assert.deepEqual(reply.files[0].attachment.subarray(0, 8), PNG_SIGNATURE);
});

// Sama pola-nya kayak replyStreak/replyMemberStats dkk (describeMissingMember,
// dites lewat mocked fetch) - member yang GAK ketemu di riwayat durasi lokal
// dicek dulu ke IDN buat mbedain "member beneran belum pernah live" vs
// "bukan member JKT48 sama sekali", BUKAN langsung ngasih pesan generik.
test("replyDurationChart - member gak ketemu di riwayat lokal, tapi IDN bilang dia beneran member JKT48 -> pesan 'belum pernah live', bukan chart", async () => {
  const original = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ data: { getPublicProfileByUsername: { name: "Chartbelumlive JKT48", username: "jkt48_chartbelumlive" } } }),
  });
  try {
    const reply = await replyDurationChart("chartbelumlive");
    assert.match(reply, /\*\*Chartbelumlive JKT48\*\* belum pernah live/);
  } finally {
    global.fetch = original;
  }
});

test("replyDurationChart - nama yang bener-bener gak ketemu di IDN sama sekali -> pesan 'gak nemu member', bukan chart", async () => {
  const original = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ errors: [{ message: "User Not found" }] }) });
  try {
    const reply = await replyDurationChart("chartgakada");
    assert.match(reply, /gak nemu member JKT48 bernama "chartgakada"/);
  } finally {
    global.fetch = original;
  }
});

// ==== Bug "grafik dan rekap gak sinkron" + tombol Tutup ====
const HOUR = 3600_000;
const DAY = 24 * HOUR;

function archiveSession(username, name, endedAgoMs, durationMs) {
  const end = new Date(Date.now() - endedAgoMs);
  recordLiveEnded(name, username, new Date(end.getTime() - durationMs), end, 50);
  recordLiveCompleted(username, name);
}

test("mergeChartEntries - DALAM jendela rekap arsip berlaku penuh, riwayat durasi yang nyelip di jendela itu diabaikan; yang LEBIH TUA dari jendela ditambahin", () => {
  const now = Date.now();
  const archive = [
    { name: "M", username: "u", endedAtUnix: Math.floor((now - 2 * DAY) / 1000), durationMs: 3 * HOUR },
    { name: "M", username: "u", endedAtUnix: Math.floor((now - 1 * DAY) / 1000), durationMs: 4 * HOUR },
  ];
  const history = [
    { name: "M", durationMs: 9 * HOUR, at: new Date(now - 50 * DAY).toISOString() }, // lebih tua dari 35 hari -> ikut
    { name: "M", durationMs: 8 * HOUR, at: new Date(now - 10 * DAY).toISOString() }, // di jendela tapi gak ada di arsip -> diabaikan
    { name: "M", durationMs: 7 * HOUR, at: new Date(now - 2 * DAY).toISOString() }, // sesi yang sama kayak arsip -> gak dobel
  ];
  const { entries, olderFromHistory, fallbackToHistory } = mergeChartEntries(archive, history, { now });
  assert.deepEqual(
    entries.map((e) => e.durationMs),
    [9 * HOUR, 3 * HOUR, 4 * HOUR],
    "kronologis: 1 sesi tua dari riwayat, lalu 2 sesi arsip persis",
  );
  assert.equal(olderFromHistory, 1);
  assert.equal(fallbackToHistory, false);
});

test("mergeChartEntries - arsip kosong -> cadangan penuh dari riwayat durasi; cuma 10 sesi terakhir yang dipake, kronologis", () => {
  const now = Date.now();
  const history = Array.from({ length: 12 }, (_, i) => ({ name: "M", durationMs: (i + 1) * HOUR, at: new Date(now - (12 - i) * DAY).toISOString() }));
  const { entries, fallbackToHistory } = mergeChartEntries([], history, { now });
  assert.equal(fallbackToHistory, true);
  assert.equal(entries.length, 10);
  assert.equal(entries[0].durationMs, 3 * HOUR, "2 sesi paling lama kepotong");
  assert.equal(entries[9].durationMs, 12 * HOUR);
});

test("mergeChartEntries - sesi arsip yang belum selesai/durasi 0 gak ikut", () => {
  const { entries } = mergeChartEntries(
    [
      { name: "M", endedAtUnix: null, durationMs: null },
      { name: "M", endedAtUnix: Math.floor(Date.now() / 1000), durationMs: 0 },
    ],
    [],
  );
  assert.deepEqual(entries, []);
});

// Persis kasus yang dilaporin owner: rekap bilang N sesi, grafik nunjukkin
// sesi lain (riwayat durasi cuma nyimpen 2 sesi lama yang beda dari arsip).
test("replyDurationChart - SINKRON sama rekap member: jumlah sesi grafik = jumlah sesi di tabel rekap (arsip), bukan riwayat durasi yang beda", async () => {
  const { replyRecapMember } = require("../src/chat/replies");
  for (let i = 6; i >= 1; i--) archiveSession("jkt48_chartsync", "Chartsync JKT48", i * DAY, i * HOUR);
  recordLiveDurationAt("jkt48_chartsync", "Chartsync JKT48", 9 * HOUR, new Date(Date.now() - 30 * DAY));
  recordLiveDurationAt("jkt48_chartsync", "Chartsync JKT48", 8 * HOUR, new Date(Date.now() - 29 * DAY));

  const rekap = await replyRecapMember("chartsync", "c-chart-sync", "u-chart-sync");
  assert.match(rekap.content, /Total sesi: 6x/);

  const chart = await replyDurationChart("chartsync");
  assert.match(chart.content, /(6 sesi terakhir yang udah selesai)/, "sama-sama 6 sesi");
  assert.doesNotMatch(chart.content, /riwayat durasi/, "gak ada catatan tambahan karena gak ada sesi yang lebih tua dari jendela rekap");
});

test("replyDurationChart - ada sesi lebih tua dari jendela rekap di riwayat durasi -> ikut, dengan catatan jelas", async () => {
  for (let i = 3; i >= 1; i--) archiveSession("jkt48_chartold", "Chartold JKT48", i * DAY, i * HOUR);
  recordLiveDurationAt("jkt48_chartold", "Chartold JKT48", 9 * HOUR, new Date(Date.now() - 60 * DAY));

  const chart = await replyDurationChart("chartold");
  assert.match(chart.content, /(4 sesi terakhir yang udah selesai)/);
  assert.match(chart.content, /1 sesi yang lebih tua dari 35 hari/);
});

test("replyDurationChart - nama cocok ke BEBERAPA member -> ditanyain balik (sama kayak rekap), bukan diem-diem milih yang pertama", async () => {
  archiveSession("jkt48_chartambigone", "Chartambigone JKT48", DAY, HOUR);
  archiveSession("jkt48_chartambigtwo", "Chartambigtwo JKT48", DAY, HOUR);
  const reply = await replyDurationChart("chartambig");
  assert.equal(typeof reply, "string");
  assert.match(reply, /ada beberapa member yang cocok sama "chartambig".*Chartambigone JKT48.*Chartambigtwo JKT48/);
});

test("replyDurationChart - member lagi live sekarang -> catatan sesi berjalan belum ikut; belum ada sesi selesai sama sekali -> pesan jelas, bukan chart kosong", async () => {
  archiveSession("jkt48_chartlivenow", "Chartlivenow JKT48", DAY, HOUR);
  activeLives.set("jkt48_chartlivenow", { username: "jkt48_chartlivenow", name: "Chartlivenow JKT48", liveAt: new Date().toISOString() });
  const withNote = await replyDurationChart("chartlivenow");
  assert.match(withNote.content, /Sesi yang lagi live sekarang belum ikut/);

  recordLiveCompleted("jkt48_chartonlylive", "Chartonlylive JKT48");
  activeLives.set("jkt48_chartonlylive", { username: "jkt48_chartonlylive", name: "Chartonlylive JKT48", liveAt: new Date().toISOString() });
  const none = await replyDurationChart("chartonlylive");
  assert.equal(typeof none, "string");
  assert.match(none, /belum punya sesi live yang udah selesai buat digrafikin.*lagi live sekarang/);
  activeLives.delete("jkt48_chartlivenow");
  activeLives.delete("jkt48_chartonlylive");
});

// Owner minta: "grafik <member>" belum ada tombol tutupnya.
test("replyDurationChart - balesan grafik punya tombol Tutup (chart_flow:close) di bawahnya", async () => {
  archiveSession("jkt48_chartclose", "Chartclose JKT48", DAY, HOUR);
  const reply = await replyDurationChart("chartclose");
  assert.equal(reply.components.length, 1);
  const buttons = reply.components[0].components;
  assert.deepEqual(
    buttons.map((b) => [b.data.custom_id, b.data.label]),
    [["chart_flow:close", "Tutup"]],
  );
});

test("handleChartButton - 'chart_flow:close' beneran ngehapus pesannya (deferUpdate + message.delete), siapa aja boleh nutup", async () => {
  const deleted = [];
  const deferred = [];
  const interaction = {
    customId: "chart_flow:close",
    user: { id: "siapa-aja" },
    message: { id: "msg-chart", delete: async () => deleted.push("msg-chart") },
    deferUpdate: async () => deferred.push(true),
  };
  await handleChartButton(interaction);
  assert.equal(deferred.length, 1);
  assert.deepEqual(deleted, ["msg-chart"]);
});
