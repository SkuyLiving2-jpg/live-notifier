const { tempCacheDir } = require("./helpers/setupTestEnv");
const fs = require("fs");
const path = require("path");
const { test } = require("node:test");
const assert = require("node:assert/strict");

const STREAKS_FILE = path.join(tempCacheDir, "streak-alerts.json");
const MODULE_PATH = require.resolve("../src/storage/streaks");

// Sama pola freshHeadsUpAlerts() di tests/headsUpAlerts.test.js - jsonStore-nya
// nge-cache di memori, jadi tiap test butuh module instance FRESH + file
// bersih biar independen.
function freshStreaks() {
  delete require.cache[MODULE_PATH];
  try {
    fs.unlinkSync(STREAKS_FILE);
  } catch {
    // wajar kalau belum pernah ada file-nya
  }
  return require("../src/storage/streaks");
}

test("getLastAlertedStreak - belum pernah di-set sama sekali -> 0", () => {
  const { getLastAlertedStreak } = freshStreaks();
  assert.equal(getLastAlertedStreak("jkt48_nala"), 0);
});

test("setLastAlertedStreak lalu getLastAlertedStreak -> nilai yang di-set", () => {
  const { setLastAlertedStreak, getLastAlertedStreak } = freshStreaks();
  setLastAlertedStreak("jkt48_nala", 7);
  assert.equal(getLastAlertedStreak("jkt48_nala"), 7);
});

test("setLastAlertedStreak per-username independen", () => {
  const { setLastAlertedStreak, getLastAlertedStreak } = freshStreaks();
  setLastAlertedStreak("jkt48_nala", 7);
  assert.equal(getLastAlertedStreak("jkt48_levi"), 0);
});

test("clearStreakAlert - ngehapus entry yang ada (getLastAlertedStreak balik ke 0), aman dipanggil buat yang gak ada entry-nya", () => {
  const { setLastAlertedStreak, clearStreakAlert, getLastAlertedStreak, loadStreakAlerts } = freshStreaks();
  setLastAlertedStreak("jkt48_nala", 7);

  clearStreakAlert("jkt48_nala");
  assert.equal(getLastAlertedStreak("jkt48_nala"), 0);
  assert.deepEqual(loadStreakAlerts(), {}); // entry-nya beneran DIHAPUS, bukan cuma di-set ke 0

  assert.doesNotThrow(() => clearStreakAlert("member-yang-gak-pernah-ada"));
});
