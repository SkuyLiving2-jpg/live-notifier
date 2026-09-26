const { tempCacheDir } = require("./helpers/setupTestEnv");
const fs = require("fs");
const path = require("path");
const { test } = require("node:test");
const assert = require("node:assert/strict");

const HEADS_UP_ALERTS_FILE = path.join(tempCacheDir, "heads-up-alerts.json");
const MODULE_PATH = require.resolve("../src/storage/headsUpAlerts");

// Sama pola freshDailyLog()/freshLiveCount() di tests/dailyLog.test.js dan
// tests/liveCount.test.js - jsonStore-nya nge-cache di memori, jadi tiap
// test butuh module instance FRESH + file bersih biar independen.
function freshHeadsUpAlerts() {
  delete require.cache[MODULE_PATH];
  try {
    fs.unlinkSync(HEADS_UP_ALERTS_FILE);
  } catch {
    // wajar kalau belum pernah ada file-nya
  }
  return require("../src/storage/headsUpAlerts");
}

test("wasAlertedToday - belum pernah di-mark sama sekali -> false", () => {
  const { wasAlertedToday } = freshHeadsUpAlerts();
  assert.equal(wasAlertedToday("jkt48_nala", "2026-09-26"), false);
});

test("markAlertedToday lalu wasAlertedToday hari yang SAMA -> true", () => {
  const { markAlertedToday, wasAlertedToday } = freshHeadsUpAlerts();
  markAlertedToday("jkt48_nala", "2026-09-26");
  assert.equal(wasAlertedToday("jkt48_nala", "2026-09-26"), true);
});

test("markAlertedToday hari X, tapi wasAlertedToday dicek buat hari LAIN -> false (reset otomatis tiap hari WIB)", () => {
  const { markAlertedToday, wasAlertedToday } = freshHeadsUpAlerts();
  markAlertedToday("jkt48_nala", "2026-09-26");
  assert.equal(wasAlertedToday("jkt48_nala", "2026-09-27"), false);
});

test("markAlertedToday per-username independen - member lain gak ke-anggep udah di-alert", () => {
  const { markAlertedToday, wasAlertedToday } = freshHeadsUpAlerts();
  markAlertedToday("jkt48_nala", "2026-09-26");
  assert.equal(wasAlertedToday("jkt48_levi", "2026-09-26"), false);
});
