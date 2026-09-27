const { tempCacheDir } = require("./helpers/setupTestEnv");
const fs = require("fs");
const path = require("path");
const { test } = require("node:test");
const assert = require("node:assert/strict");

const DASHBOARD_FILE = path.join(tempCacheDir, "dashboard.json");
const MODULE_PATH = require.resolve("../src/storage/dashboard");

// Sama pola freshHeadsUpAlerts()/freshStreaks() di tests lain - jsonStore-nya
// nge-cache di memori, jadi tiap test butuh module instance FRESH + file
// bersih biar independen.
function freshDashboard() {
  delete require.cache[MODULE_PATH];
  try {
    fs.unlinkSync(DASHBOARD_FILE);
  } catch {
    // wajar kalau belum pernah ada file-nya
  }
  return require("../src/storage/dashboard");
}

test("loadDashboardState - belum pernah disimpen sama sekali -> messageId null, lastUsernamesKey string kosong", () => {
  const { loadDashboardState } = freshDashboard();
  assert.deepEqual(loadDashboardState(), { messageId: null, lastUsernamesKey: "" });
});

test("saveDashboardState lalu loadDashboardState -> nilai yang di-save persis", () => {
  const { saveDashboardState, loadDashboardState } = freshDashboard();
  saveDashboardState({ messageId: "12345", lastUsernamesKey: "jkt48_nala,jkt48_levi" });
  assert.deepEqual(loadDashboardState(), { messageId: "12345", lastUsernamesKey: "jkt48_nala,jkt48_levi" });
});

test("saveDashboardState - messageId/lastUsernamesKey yang gak dikasih (undefined) jatuh ke default null/string kosong", () => {
  const { saveDashboardState, loadDashboardState } = freshDashboard();
  saveDashboardState({});
  assert.deepEqual(loadDashboardState(), { messageId: null, lastUsernamesKey: "" });
});

test("saveDashboardState dipanggil berkali-kali -> nilai TERAKHIR yang menang (full replace, bukan merge)", () => {
  const { saveDashboardState, loadDashboardState } = freshDashboard();
  saveDashboardState({ messageId: "111", lastUsernamesKey: "jkt48_a" });
  saveDashboardState({ messageId: "222", lastUsernamesKey: "jkt48_a,jkt48_b" });
  assert.deepEqual(loadDashboardState(), { messageId: "222", lastUsernamesKey: "jkt48_a,jkt48_b" });
});
