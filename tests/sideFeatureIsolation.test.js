require("./helpers/setupTestEnv");

// Fungsi fitur sampingan sengaja dibuat melempar error SEBELUM modul yang memakainya
// (monitor, router, ...) di-require - mereka ngambil fungsinya lewat destructuring.
const boom = () => {
  throw new Error("boom sengaja");
};
const guessStorage = require("../src/storage/guessGame");
const viewerStorage = require("../src/storage/viewerTimelines");
const prefsStorage = require("../src/storage/userPrefs");
const realSplit = require("../src/notify/personalDelivery");
guessStorage.resolveDurationRound = boom;
guessStorage.resolveNextRound = boom;
guessStorage.discardDurationRound = boom;
viewerStorage.recordViewerTimeline = boom;
prefsStorage.touchLastSeen = boom;
realSplit.splitByPreference = boom;

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { checkLiveMembers } = require("../src/monitor");
const { activeLives } = require("../src/storage/activeLives");
const { getCompletedSessionsToday } = require("../src/storage/dailyLog");
const { saveSubscriptions } = require("../src/storage/subscriptions");
const { buildChatReply } = require("../src/chat/router");

function withIdnCycles(cycles, bodies) {
  const originalFetch = global.fetch;
  let cycle = -1;
  global.fetch = async (url, options) => {
    if (String(url).includes("idn.app")) {
      const page = JSON.parse(options.body).variables.page;
      if (page === 1) cycle++;
      const lives = page === 1 ? cycles[Math.min(cycle, cycles.length - 1)] : [];
      return { ok: true, json: async () => ({ data: { getLivestreams: lives } }) };
    }
    bodies.push(JSON.parse(options.body));
    return { ok: true, json: async () => ({}) };
  };
  return () => {
    global.fetch = originalFetch;
  };
}

test("fitur sampingan error semua: live tetap terdeteksi, subscriber tetap di-tag, sesi selesai tetap dicatat & dibersihkan, notif selesai cuma sekali", async () => {
  const username = "jkt48_isolasi";
  const realNow = Date.now;
  const base = realNow();
  let tick = 0;
  Date.now = () => base + tick * 20_000;
  const liveAt = new Date(base - 10 * 60_000).toISOString();
  const live = [{ creator: { username, name: "Isolasi", bio_description: "" }, slug: "slug-iso", live_at: liveAt, view_count: 10, image_url: null }];
  const bodies = [];
  const restore = withIdnCycles([live, live, [], []], bodies);
  saveSubscriptions({ isolasi: ["sub-iso"] });
  const originalErr = console.error;
  const errors = [];
  console.error = (...args) => errors.push(args.join(" "));
  try {
    for (tick = 0; tick < 4; tick++) await checkLiveMembers();

    const starts = bodies.filter((b) => /lagi live di IDN Live/.test(b.content || ""));
    assert.equal(starts.length, 1, "notif mulai kekirim sekali");
    assert.match(starts[0].content, /<@sub-iso>/, "preferensi error -> subscriber tetap di-tag (perilaku lama)");

    const ends = bodies.filter((b) => /udah selesai live/.test(b.content || ""));
    assert.equal(ends.length, 1, "notif selesai TIDAK berulang tiap siklus");
    assert.equal(activeLives.has(username), false, "sesi dibersihkan walau hook sampingan error");
    assert.equal(getCompletedSessionsToday().filter((s) => s.username === username).length, 1, "sesi tetap tercatat di rekap");
    assert.ok(
      errors.some((e) => /nggak fatal/.test(e)),
      "error sampingan dicatat di log",
    );
  } finally {
    Date.now = realNow;
    console.error = originalErr;
    restore();
    saveSubscriptions({});
    activeLives.delete(username);
  }
});

test("router: pencatatan waktu aktif error tidak menggagalkan balasan", async () => {
  const originalErr = console.error;
  console.error = () => {};
  try {
    const reply = await buildChatReply("cok status", { isBotChannel: true, authorId: "iso-user" });
    assert.notEqual(reply, null);
  } finally {
    console.error = originalErr;
  }
});

test("guess-game: entri rusak di file (null, string, bentuk salah) dibuang saat dimuat - papan skor & ronde tetap jalan", () => {
  const fs = require("fs");
  fs.writeFileSync(
    guessStorage.GUESS_GAME_FILE,
    JSON.stringify({
      duration: { jkt48_r1: { liveAtUnix: 1, guesses: { a: null, b: "x", c: { minutes: "abc" }, d: { minutes: 30 } } }, jkt48_r2: null },
      next: { openedAt: "x", guesses: [1] },
      scores: { u1: null, u2: "str", u3: { points: 7, wins: "x" } },
      monthly: { "2026-10": [], "2026-09": { u3: 7, u4: "x" } },
    }),
  );
  // store.load() meng-cache; paksa baca ulang dengan modul segar.
  delete require.cache[require.resolve("../src/storage/guessGame")];
  const fresh = require("../src/storage/guessGame");
  const data = fresh.load();
  assert.deepEqual(Object.keys(data.duration), ["jkt48_r1"]);
  assert.deepEqual(data.duration.jkt48_r1.guesses, { d: { minutes: 30, at: 0 } });
  assert.equal(data.next, null);
  assert.deepEqual(data.scores, { u3: { points: 7, wins: 0, plays: 0 } });
  assert.deepEqual(data.monthly, { "2026-09": { u3: 7 } }, "bulan berisi array dibuang, nilai bukan angka dibuang");
  assert.doesNotThrow(() => fresh.getScoreboard());
  assert.equal(fresh.getScoreboard().allTime[0].userId, "u3");
});
