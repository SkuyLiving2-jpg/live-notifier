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
