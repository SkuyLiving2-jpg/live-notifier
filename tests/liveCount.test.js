const { tempCacheDir } = require("./helpers/setupTestEnv");
const fs = require("fs");
const path = require("path");
const { test } = require("node:test");
const assert = require("node:assert/strict");

const LIVE_COUNT_FILE = path.join(tempCacheDir, "live-count.json");
const MODULE_PATH = require.resolve("../src/storage/liveCount");

// Sama alasannya kayak freshDailyLog() di tests/dailyLog.test.js -
// storage/liveCount.js's jsonStore nge-cache di memori abis load() pertama,
// jadi tiap test dikasih module instance FRESH + file bersih biar independen
// gak peduli urutan jalannya.
function freshLiveCount() {
  delete require.cache[MODULE_PATH];
  try {
    fs.unlinkSync(LIVE_COUNT_FILE);
  } catch {
    // wajar kalau belum pernah ada file-nya
  }
  return require("../src/storage/liveCount");
}

test("recordLiveCompleted - pertama kali: count 1, firstLiveAt == lastLiveAt", () => {
  const { recordLiveCompleted, loadLiveCount } = freshLiveCount();

  recordLiveCompleted("jkt48_nala", "Nala");
  const data = loadLiveCount();

  assert.equal(data.jkt48_nala.name, "Nala");
  assert.equal(data.jkt48_nala.count, 1);
  assert.equal(data.jkt48_nala.firstLiveAt, data.jkt48_nala.lastLiveAt);
});

test("recordLiveCompleted - dipanggil berkali-kali: count naik terus, firstLiveAt TETEP dari yang pertama, lastLiveAt ke-update", () => {
  const { recordLiveCompleted, loadLiveCount } = freshLiveCount();

  recordLiveCompleted("jkt48_levi", "Levi");
  const firstAt = loadLiveCount().jkt48_levi.firstLiveAt;

  recordLiveCompleted("jkt48_levi", "Levi");
  recordLiveCompleted("jkt48_levi", "Levi");
  const data = loadLiveCount();

  assert.equal(data.jkt48_levi.count, 3);
  assert.equal(data.jkt48_levi.firstLiveAt, firstAt); // gak pernah berubah abis yang pertama
});

test("recordLiveCompleted - member lain gak saling ganggu hitungannya (per-username, bukan global)", () => {
  const { recordLiveCompleted, loadLiveCount } = freshLiveCount();

  recordLiveCompleted("jkt48_nala", "Nala");
  recordLiveCompleted("jkt48_nala", "Nala");
  recordLiveCompleted("jkt48_lily", "Lily");

  const data = loadLiveCount();
  assert.equal(data.jkt48_nala.count, 2);
  assert.equal(data.jkt48_lily.count, 1);
});

test("recordLiveCompleted - nama IDN ganti belakangan, count TETEP kebawa (di-update ke nama terbaru)", () => {
  const { recordLiveCompleted, loadLiveCount } = freshLiveCount();

  recordLiveCompleted("jkt48_gantinama", "Nama Lama");
  recordLiveCompleted("jkt48_gantinama", "Nama Baru");

  const entry = loadLiveCount().jkt48_gantinama;
  assert.equal(entry.count, 2);
  assert.equal(entry.name, "Nama Baru");
});

test("findLiveCountByNameFragment - fuzzy match by nama depan, null kalau gak ketemu/fragment kosong", () => {
  const { recordLiveCompleted, findLiveCountByNameFragment } = freshLiveCount();

  recordLiveCompleted("jkt48_erine", "Erine");

  const found = findLiveCountByNameFragment("erine");
  assert.equal(found.username, "jkt48_erine");
  assert.equal(found.count, 1);

  assert.equal(findLiveCountByNameFragment("member-yang-gak-ada"), null);
  assert.equal(findLiveCountByNameFragment(""), null);
});

test("getLiveCountLeaderboard - diurutin count DESC, dibatesin limit-nya, kosong kalau belum ada data sama sekali", () => {
  const { recordLiveCompleted, getLiveCountLeaderboard } = freshLiveCount();

  assert.deepEqual(getLiveCountLeaderboard(), []);

  recordLiveCompleted("jkt48_nala", "Nala");
  recordLiveCompleted("jkt48_nala", "Nala");
  recordLiveCompleted("jkt48_nala", "Nala");
  recordLiveCompleted("jkt48_levi", "Levi");
  recordLiveCompleted("jkt48_levi", "Levi");
  recordLiveCompleted("jkt48_lily", "Lily");

  const top = getLiveCountLeaderboard();
  assert.deepEqual(
    top.map((e) => [e.username, e.count]),
    [
      ["jkt48_nala", 3],
      ["jkt48_levi", 2],
      ["jkt48_lily", 1],
    ],
  );

  const top2 = getLiveCountLeaderboard(2);
  assert.equal(top2.length, 2);
  assert.equal(top2[0].username, "jkt48_nala");
  assert.equal(top2[1].username, "jkt48_levi");
});

// §10 item baru (dropdown pencarian "cok bandingin" polos, chat/compareFlow.js)
test("searchLiveCountByNameFragment - balikin SEMUA kandidat yang cocok (bukan cuma satu), diurutin nama", () => {
  const { recordLiveCompleted, searchLiveCountByNameFragment } = freshLiveCount();

  recordLiveCompleted("jkt48_freya", "Freya");
  recordLiveCompleted("jkt48_frelyn", "Frelyn");
  recordLiveCompleted("jkt48_nala", "Nala");

  const matches = searchLiveCountByNameFragment("fre");
  // Diurutin ALFABETIS by name ("Frelyn" < "Freya" - 'l' duluan ketimbang
  // 'y' di karakter ke-4), BUKAN urutan insersi/count.
  assert.deepEqual(
    matches.map((m) => m.username),
    ["jkt48_frelyn", "jkt48_freya"],
  );
});

test("searchLiveCountByNameFragment - nama lengkap dengan 'JKT48' + huruf besar tetep ketemu (cocok nama depan, gak case-sensitive)", () => {
  const { recordLiveCompleted, searchLiveCountByNameFragment } = freshLiveCount();
  recordLiveCompleted("jkt48_kimmy", "Kimmy JKT48");

  assert.deepEqual(
    searchLiveCountByNameFragment("KIMMY").map((m) => m.username),
    ["jkt48_kimmy"],
  );
  assert.deepEqual(
    searchLiveCountByNameFragment("kimmy jkt48").map((m) => m.username),
    ["jkt48_kimmy"],
  );
});

test("searchLiveCountByNameFragment - fragment kosong/gak ketemu -> array kosong", () => {
  const { recordLiveCompleted, searchLiveCountByNameFragment } = freshLiveCount();
  recordLiveCompleted("jkt48_nala", "Nala");

  assert.deepEqual(searchLiveCountByNameFragment(""), []);
  assert.deepEqual(searchLiveCountByNameFragment("member-yang-gak-ada"), []);
});

// Saran fitur ke-2 (§10's kelimapuluh item): "siapa yang paling lama gak
// live" - kebalikan getLiveCountLeaderboard. saveLiveCount dipake langsung
// (bukan recordLiveCompleted) biar lastLiveAt-nya BENERAN kekontrol manual -
// recordLiveCompleted pake Date.now() beneran, dua panggilan balik-balikan
// bisa aja kebetulan sama persis ke milidetik kalau mesinnya kenceng, bikin
// urutan hasil sortir jadi gak deterministik buat dites.
test("getLongestNotLiveLeaderboard - diurutin lastLiveAt NAIK (paling lama duluan), kosong kalau belum ada data", () => {
  const { saveLiveCount, getLongestNotLiveLeaderboard } = freshLiveCount();

  assert.deepEqual(getLongestNotLiveLeaderboard(), []);

  saveLiveCount({
    jkt48_nala: { name: "Nala", count: 5, firstLiveAt: "2026-01-01T00:00:00.000Z", lastLiveAt: "2026-09-20T00:00:00.000Z" },
    jkt48_levi: { name: "Levi", count: 3, firstLiveAt: "2026-01-01T00:00:00.000Z", lastLiveAt: "2026-08-01T00:00:00.000Z" },
    jkt48_lily: { name: "Lily", count: 2, firstLiveAt: "2026-01-01T00:00:00.000Z", lastLiveAt: "2026-09-25T00:00:00.000Z" },
  });

  const ranked = getLongestNotLiveLeaderboard();
  assert.deepEqual(
    ranked.map((e) => e.username),
    ["jkt48_levi", "jkt48_nala", "jkt48_lily"], // Levi paling lama gak live (Agustus), Lily paling baru (25 Sept)
  );
});
