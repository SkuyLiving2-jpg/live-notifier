require("./helpers/setupTestEnv");

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { addViewerSample, computeViewerStats, downsample, MAX_LIVE_SAMPLES } = require("../src/viewerTimeline");
const { recordViewerTimeline, getViewerTimelines, MAX_SESSIONS_PER_MEMBER } = require("../src/storage/viewerTimelines");
const { checkLiveMembers } = require("../src/monitor");
const { activeLives } = require("../src/storage/activeLives");
const { replyViewerChart, drawViewerChart, niceCeil, describePeakVsTypical } = require("../src/chat/viewerChart");
const { buildChatReply } = require("../src/chat/router");

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test("addViewerSample - menambah sampel, melewati nilai bukan angka dan sampel yang terlalu rapat", () => {
  const entry = {};
  addViewerSample(entry, 100, 1000);
  addViewerSample(entry, null, 1020);
  addViewerSample(entry, undefined, 1030);
  addViewerSample(entry, -5, 1040);
  addViewerSample(entry, 110, 1002); // < 5 detik dari sampel terakhir -> dilewati
  addViewerSample(entry, 150, 1020);
  assert.deepEqual(entry.viewSamples, [
    [1000, 100],
    [1020, 150],
  ]);
});

test("addViewerSample - lewat batas sampel dipadatkan jadi separuh, titik pertama & terakhir tetap", () => {
  const entry = {};
  for (let i = 0; i <= MAX_LIVE_SAMPLES; i++) addViewerSample(entry, i, 1000 + i * 20);
  assert.ok(entry.viewSamples.length <= MAX_LIVE_SAMPLES / 2 + 1);
  assert.deepEqual(entry.viewSamples[0], [1000, 0]);
  assert.deepEqual(entry.viewSamples.at(-1), [1000 + MAX_LIVE_SAMPLES * 20, MAX_LIVE_SAMPLES]);
});

test("downsample - merata, ujung-ujungnya ikut; di bawah batas dikembalikan apa adanya", () => {
  const input = Array.from({ length: 11 }, (_, i) => [i, i]);
  assert.equal(downsample(input, 20), input);
  const out = downsample(input, 3);
  assert.deepEqual(out, [
    [0, 0],
    [5, 5],
    [10, 10],
  ]);
});

test("computeViewerStats - puncak, waktu puncak, rata-rata berbobot waktu; < 2 sampel -> null; sampel rusak disaring", () => {
  assert.equal(computeViewerStats([]), null);
  assert.equal(computeViewerStats([[1, 1]]), null);
  assert.equal(computeViewerStats("bukan array"), null);

  const stats = computeViewerStats([
    [1000, 100],
    [1100, 300], // puncak
    [1200, 200],
    ["rusak", 5],
    [null, null],
  ]);
  assert.equal(stats.peak, 300);
  assert.equal(stats.peakOffsetSec, 100);
  assert.equal(stats.startViews, 100);
  assert.equal(stats.endViews, 200);
  assert.equal(stats.count, 3);
  assert.equal(stats.avg, 225); // trapesium: ((100+300)/2*100 + (300+200)/2*100) / 200
});

test("niceCeil - dibulatkan ke 1/2/5 x 10^n dengan headroom", () => {
  assert.equal(niceCeil(3), 10);
  assert.equal(niceCeil(95), 100);
  assert.equal(niceCeil(100), 200); // butuh headroom di atas puncak
  assert.equal(niceCeil(1337), 2000);
  assert.equal(niceCeil(4500), 5000);
  assert.equal(niceCeil(4700), 10000); // 4700 + headroom 8% > 5000
});

test("recordViewerTimeline/getViewerTimelines - simpan, buang yang < 3 sampel, batasi jumlah sesi per member", () => {
  const username = "jkt48_vt_store";
  const nowSec = Math.floor(Date.now() / 1000);
  const entry = (i) => ({
    liveAt: new Date((nowSec - 3600 + i) * 1000).toISOString(),
    viewSamples: [
      [nowSec - 3600 + i, 10],
      [nowSec - 3000 + i, 50],
      [nowSec - 2400 + i, 30],
    ],
  });
  assert.equal(recordViewerTimeline(username, { liveAt: new Date().toISOString(), viewSamples: [[1, 1]] }), false, "terlalu sedikit sampel");
  assert.equal(recordViewerTimeline(username, { viewSamples: entry(0).viewSamples }), false, "tanpa liveAt");
  for (let i = 0; i < MAX_SESSIONS_PER_MEMBER + 3; i++) assert.equal(recordViewerTimeline(username, entry(i)), true);
  const stored = getViewerTimelines(username);
  assert.equal(stored.length, MAX_SESSIONS_PER_MEMBER);
  assert.equal(stored.at(-1).startedAtUnix, nowSec - 3600 + (MAX_SESSIONS_PER_MEMBER + 2));
  assert.deepEqual(getViewerTimelines("__proto__"), []);
  assert.deepEqual(getViewerTimelines("jkt48_tidakada"), []);
});

// ---- integrasi dengan monitor.js: sampel dikumpulkan tiap siklus, kurva disimpan pas live selesai ----
function withIdnCycles(cycles) {
  const originalFetch = global.fetch;
  let cycle = -1;
  global.fetch = async (url, options) => {
    if (String(url).includes("idn.app")) {
      // fetchAllLivestreams minta halaman 1, 2, ... sampai kosong: satu siklus = beberapa fetch.
      const page = JSON.parse(options.body).variables.page;
      if (page === 1) cycle++;
      const lives = page === 1 ? cycles[Math.min(cycle, cycles.length - 1)] : [];
      return { ok: true, json: async () => ({ data: { getLivestreams: lives } }) };
    }
    return { ok: true, json: async () => ({}) };
  };
  return () => {
    global.fetch = originalFetch;
  };
}

test("monitor - sampel penonton dikumpulkan tiap siklus lalu kurva tersimpan begitu live selesai", async () => {
  const username = "jkt48_vt_monitor";
  const realNow = Date.now;
  const base = realNow();
  let tick = 0;
  Date.now = () => base + tick * 20_000;
  const liveAt = new Date(base - 10 * 60_000).toISOString();
  const liveWith = (views) => [
    { creator: { username, name: "VtMonitor", bio_description: "" }, slug: "slug-vt", live_at: liveAt, view_count: views, image_url: null },
  ];
  const restore = withIdnCycles([liveWith(10), liveWith(40), liveWith(25), [], []]);
  const originalErr = console.error;
  console.error = () => {};
  try {
    for (tick = 0; tick < 5; tick++) await checkLiveMembers();
    assert.equal(activeLives.has(username), false, "sesi sudah ditutup setelah 2 siklus absen");
    const stored = getViewerTimelines(username);
    assert.equal(stored.length, 1);
    assert.deepEqual(
      stored[0].samples.map(([, v]) => v),
      [10, 40, 25],
    );
    assert.equal(computeViewerStats(stored[0].samples).peak, 40);
  } finally {
    Date.now = realNow;
    console.error = originalErr;
    restore();
    activeLives.delete(username);
  }
});

// ---- grafik + balasan chat ----
test("drawViewerChart - PNG valid; < 2 sampel melempar error", () => {
  const samples = Array.from({ length: 30 }, (_, i) => [1000 + i * 60, 100 + Math.round(80 * Math.sin(i / 4)) + i * 5]);
  const buffer = drawViewerChart("Vtgambar", samples);
  assert.ok(Buffer.isBuffer(buffer));
  assert.deepEqual(buffer.subarray(0, 8), PNG_SIGNATURE);
  assert.ok(drawViewerChart("Vtgambar", samples, { inProgress: true }).length > 100);
  assert.throws(() => drawViewerChart("X", [[1, 1]]));
});

test("describePeakVsTypical - lebih ramai / lebih sepi / sekitar biasa / tanpa pembanding", () => {
  assert.match(describePeakVsTypical(150, 100), /50% LEBIH ramai/);
  assert.match(describePeakVsTypical(50, 100), /50% lebih sepi/);
  assert.match(describePeakVsTypical(101, 100), /sekitar biasanya/);
  assert.equal(describePeakVsTypical(100, null), "");
});

test("replyViewerChart - member gak dikenal / belum ada kurva / lagi live tapi baru mulai / ada kurva -> gambar", async () => {
  const { recordLiveCompleted } = require("../src/storage/liveCount");
  const username = "jkt48_vtreply";
  recordLiveCompleted(username, "Vtreply JKT48"); // biar member ini dikenal resolveRecapMember

  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ data: null }) });
  try {
    const none = await replyViewerChart("vtreply");
    assert.match(none, /belum ada kurva penonton/);

    activeLives.set(username, { name: "Vtreply JKT48", username, slug: "s", liveAt: new Date().toISOString(), viewSamples: [[1, 1]] });
    assert.match(await replyViewerChart("vtreply"), /belum cukup titik/);

    const nowSec = Math.floor(Date.now() / 1000);
    activeLives.get(username).viewSamples = [
      [nowSec - 120, 20],
      [nowSec - 60, 80],
      [nowSec, 50],
    ];
    const live = await replyViewerChart("vtreply");
    assert.match(live.content, /lagi live/);
    assert.match(live.content, /Puncak \*\*80\*\*/);
    assert.equal(live.files.length, 1);
    activeLives.delete(username);

    recordViewerTimeline(username, {
      liveAt: new Date((nowSec - 600) * 1000).toISOString(),
      viewSamples: [
        [nowSec - 600, 5],
        [nowSec - 300, 90],
        [nowSec - 10, 40],
      ],
    });
    const done = await replyViewerChart("vtreply");
    assert.match(done.content, /sesi terakhir yang udah selesai/);
    assert.match(done.content, /Puncak \*\*90\*\*/);
    assert.equal(done.components.length, 1);
  } finally {
    global.fetch = originalFetch;
    activeLives.delete(username);
  }
});

test("router - 'grafik penonton <nama>' dialihkan ke kurva penonton (bukan grafik durasi); tanpa nama -> petunjuk", async () => {
  const hint = await buildChatReply("cok grafik penonton");
  assert.match(hint, /grafik penonton <nama member>/);

  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ data: null }) });
  try {
    const reply = await buildChatReply("cok grafik penonton namayangtidakada123");
    const text = typeof reply === "string" ? reply : reply.content;
    assert.match(text, /namayangtidakada123/);
  } finally {
    global.fetch = originalFetch;
  }
});
