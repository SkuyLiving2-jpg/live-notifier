require("./helpers/setupTestEnv");

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { saveDurationHistory } = require("../src/storage/durationHistory");
const { replyDurationChart, computeDurationChartMetrics, drawDurationChart } = require("../src/chat/chartReply");

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
