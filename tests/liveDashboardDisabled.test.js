require("./helpers/setupTestEnv");
// DASHBOARD_WEBHOOK_URL SENGAJA gak di-set di sini (beda dari
// tests/liveDashboard.test.js) - defaultnya harus string kosong (config.js),
// dan maybeUpdateDashboard() harus diem total begitu itu kosong. Ini file
// KHUSUS buat nguji "mati by default" itu - kalau digabung ke
// tests/liveDashboard.test.js (yang nge-set env var itu duluan), config.js's
// DASHBOARD_WEBHOOK_URL bakal kepatok ke nilai yang di-set itu SELAMANYA
// buat proses/file itu (constant di-capture sekali pas modul pertama
// di-load) - gak ada cara nguji jalur "mati" di file yang sama.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { activeLives } = require("../src/storage/activeLives");
const { maybeUpdateDashboard } = require("../src/notify/dashboard");

test("maybeUpdateDashboard - DASHBOARD_WEBHOOK_URL kosong (default) -> diem total, gak nyentuh network sama sekali", async () => {
  activeLives.set("jkt48_dashdisabledtest", {
    name: "Dashdisabledtest",
    username: "jkt48_dashdisabledtest",
    slug: "s",
    liveAt: new Date().toISOString(),
  });

  let touched = false;
  const original = global.fetch;
  global.fetch = async () => {
    touched = true;
    return { ok: true, json: async () => ({}) };
  };
  try {
    await assert.doesNotReject(maybeUpdateDashboard());
    assert.equal(touched, false);
  } finally {
    global.fetch = original;
    activeLives.delete("jkt48_dashdisabledtest");
  }
});
