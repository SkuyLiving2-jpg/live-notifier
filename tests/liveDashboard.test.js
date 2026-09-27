require("./helpers/setupTestEnv");
// DASHBOARD_WEBHOOK_URL harus di-set SEBELUM src/config.js sempet ke-require
// (lewat require apapun di bawah) - config.js nge-capture nilai env var ini
// jadi constant SEKALI doang pas pertama kali di-load, jadi kalau di-set
// belakangan gak ngaruh sama sekali (lihat komen lengkapnya di
// tests/liveDashboardDisabled.test.js, yang justru sengaja GAK nge-set ini).
process.env.DASHBOARD_WEBHOOK_URL = "https://discord.com/api/webhooks/1/dashboard-token";

const fs = require("fs");
const path = require("path");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { tempCacheDir } = require("./helpers/setupTestEnv");
const { activeLives } = require("../src/storage/activeLives");
const { buildDashboardPayload } = require("../src/notify/dashboard");

const DASHBOARD_FILE = path.join(tempCacheDir, "dashboard.json");
const DASHBOARD_STORAGE_MODULE_PATH = require.resolve("../src/storage/dashboard");
const DASHBOARD_NOTIFY_MODULE_PATH = require.resolve("../src/notify/dashboard");

// storage/dashboard.js nyimpen SATU state global (bukan keyed per-username
// kayak kebanyakan storage/ lain di codebase ini), jadi gak bisa diandelin
// nama member yang unik buat isolasi antar-test - HARUS fresh-reload
// (sama pola freshPublicAlerts() di tests/publicAlerts.test.js), dan
// notify/dashboard.js DIIKUTIN di-fresh bareng soalnya dia nyimpen referensi
// ke fungsi-fungsi storage/dashboard.js pas di-require.
function freshDashboard() {
  delete require.cache[DASHBOARD_STORAGE_MODULE_PATH];
  delete require.cache[DASHBOARD_NOTIFY_MODULE_PATH];
  try {
    fs.unlinkSync(DASHBOARD_FILE);
  } catch {
    // wajar kalau belum pernah ada file-nya
  }
  return require("../src/notify/dashboard");
}

test("buildDashboardPayload - roster kosong -> pesan 'gak ada yang live'", () => {
  const payload = buildDashboardPayload([]);
  assert.match(payload.embeds[0].description, /Gak ada member JKT48 yang lagi live saat ini/);
});

test("buildDashboardPayload - roster ada isinya -> satu baris per member, nomor urut + elapsed + viewer", () => {
  const payload = buildDashboardPayload([
    { name: "Nala", username: "jkt48_nala", liveAt: new Date(Date.now() - 5 * 60_000).toISOString(), viewCount: 1234 },
    { name: "Levi", username: "jkt48_levi", liveAt: new Date(Date.now() - 60_000).toISOString(), viewCount: null },
  ]);
  assert.match(payload.embeds[0].description, /1\. \*\*Nala\*\* - .*\| 👁️ 1[.,]?2\d\d/);
  assert.match(payload.embeds[0].description, /2\. \*\*Levi\*\* -/);
  assert.doesNotMatch(payload.embeds[0].description.split("\n")[1], /👁️/); // Levi gak punya viewCount, gak boleh ada bagian viewer
});

test("maybeUpdateDashboard - belum pernah ada dashboard sama sekali -> BIKIN pesan baru (POST ?wait=true), simpen ID + roster-nya", async () => {
  const { maybeUpdateDashboard } = freshDashboard();
  const { loadDashboardState } = require("../src/storage/dashboard");
  activeLives.set("jkt48_dashfirst", { name: "Dashfirst", username: "jkt48_dashfirst", slug: "s", liveAt: new Date().toISOString() });

  let calledMethod = null;
  let calledUrl = null;
  const original = global.fetch;
  global.fetch = async (url, options) => {
    calledUrl = url;
    calledMethod = options.method;
    return { ok: true, json: async () => ({ id: "dash-msg-1" }) };
  };
  try {
    await maybeUpdateDashboard();
    assert.equal(calledMethod, "POST");
    assert.match(calledUrl, /\?wait=true$/);
    assert.deepEqual(loadDashboardState(), { messageId: "dash-msg-1", lastUsernamesKey: "jkt48_dashfirst" });
  } finally {
    global.fetch = original;
    activeLives.delete("jkt48_dashfirst");
  }
});

test("maybeUpdateDashboard - roster GAK berubah dari terakhir kali -> gak nyentuh network sama sekali", async () => {
  const { maybeUpdateDashboard } = freshDashboard();
  const { saveDashboardState } = require("../src/storage/dashboard");
  activeLives.set("jkt48_dashsame", { name: "Dashsame", username: "jkt48_dashsame", slug: "s", liveAt: new Date().toISOString() });
  saveDashboardState({ messageId: "dash-msg-old", lastUsernamesKey: "jkt48_dashsame" }); // udah "kekinian" dari awal

  let touched = false;
  const original = global.fetch;
  global.fetch = async () => {
    touched = true;
    return { ok: true, json: async () => ({}) };
  };
  try {
    await maybeUpdateDashboard();
    assert.equal(touched, false);
  } finally {
    global.fetch = original;
    activeLives.delete("jkt48_dashsame");
  }
});

test("maybeUpdateDashboard - roster BERUBAH, dashboard udah ada -> EDIT (PATCH) pesan yang sama, roster ke-update", async () => {
  const { maybeUpdateDashboard } = freshDashboard();
  const { saveDashboardState, loadDashboardState } = require("../src/storage/dashboard");
  saveDashboardState({ messageId: "dash-msg-existing", lastUsernamesKey: "" }); // dulu kosong
  activeLives.set("jkt48_dashchanged", { name: "Dashchanged", username: "jkt48_dashchanged", slug: "s", liveAt: new Date().toISOString() });

  let calledMethod = null;
  let calledUrl = null;
  const original = global.fetch;
  global.fetch = async (url, options) => {
    calledMethod = options.method;
    calledUrl = url;
    return { ok: true, json: async () => ({}) };
  };
  try {
    await maybeUpdateDashboard();
    assert.equal(calledMethod, "PATCH");
    assert.match(calledUrl, /\/messages\/dash-msg-existing$/);
    assert.deepEqual(loadDashboardState(), { messageId: "dash-msg-existing", lastUsernamesKey: "jkt48_dashchanged" });
  } finally {
    global.fetch = original;
    activeLives.delete("jkt48_dashchanged");
  }
});

test("maybeUpdateDashboard - edit balikin 404 (pesan lama udah ilang) -> bikin pesan BARU, ID ke-update ke yang baru", async () => {
  const { maybeUpdateDashboard } = freshDashboard();
  const { saveDashboardState, loadDashboardState } = require("../src/storage/dashboard");
  saveDashboardState({ messageId: "dash-msg-gone", lastUsernamesKey: "" });
  activeLives.set("jkt48_dashgone", { name: "Dashgone", username: "jkt48_dashgone", slug: "s", liveAt: new Date().toISOString() });

  let patchCalled = false;
  let postCalled = false;
  const original = global.fetch;
  global.fetch = async (url, options) => {
    if (options.method === "PATCH") {
      patchCalled = true;
      return { ok: false, status: 404, json: async () => ({}) };
    }
    postCalled = true;
    return { ok: true, json: async () => ({ id: "dash-msg-recreated" }) };
  };
  try {
    await maybeUpdateDashboard();
    assert.equal(patchCalled, true);
    assert.equal(postCalled, true);
    assert.deepEqual(loadDashboardState(), { messageId: "dash-msg-recreated", lastUsernamesKey: "jkt48_dashgone" });
  } finally {
    global.fetch = original;
    activeLives.delete("jkt48_dashgone");
  }
});

test("maybeUpdateDashboard - edit GAGAL (bukan 404) -> state DIBIARIN apa adanya (bukan 'gone', gak bikin pesan baru)", async () => {
  const { maybeUpdateDashboard } = freshDashboard();
  const { saveDashboardState, loadDashboardState } = require("../src/storage/dashboard");
  saveDashboardState({ messageId: "dash-msg-flaky", lastUsernamesKey: "" });
  activeLives.set("jkt48_dashflaky", { name: "Dashflaky", username: "jkt48_dashflaky", slug: "s", liveAt: new Date().toISOString() });

  let postCalled = false;
  const original = global.fetch;
  global.fetch = async (url, options) => {
    if (options.method === "PATCH") return { ok: false, status: 500, json: async () => ({}) };
    postCalled = true;
    return { ok: true, json: async () => ({ id: "should-not-happen" }) };
  };
  try {
    await maybeUpdateDashboard();
    assert.equal(postCalled, false, "gangguan sesaat gak boleh bikin pesan baru (bisa dobel)");
    assert.deepEqual(
      loadDashboardState(),
      { messageId: "dash-msg-flaky", lastUsernamesKey: "" },
      "state dibiarin persis kayak sebelumnya, dicoba lagi siklus berikutnya",
    );
  } finally {
    global.fetch = original;
    activeLives.delete("jkt48_dashflaky");
  }
});
