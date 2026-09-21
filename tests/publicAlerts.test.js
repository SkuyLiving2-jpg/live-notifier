const { tempCacheDir } = require("./helpers/setupTestEnv");
// DAILY_RECAP_HOUR di-set ke "0" SEBELUM src/config.js sempet ke-require
// (lewat require publicAlerts/dailyLog di bawah) - getHourWIBOf() (0-23)
// gak akan pernah lebih kecil dari 0, jadi maybeSendDailyRecap()'s gerbang
// "getHourWIBOf() < DAILY_RECAP_HOUR" SELALU lolos apapun jam beneran pas
// test ini dijalanin - determinstik tanpa perlu mock Date/Intl sama sekali.
process.env.DAILY_RECAP_HOUR = "0";

const fs = require("fs");
const path = require("path");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { buildDailyRecapPayload } = require("../src/notify/publicAlerts");
const { DAILY_RECAP_COLOR } = require("../src/config");

const DAILY_LOG_FILE = path.join(tempCacheDir, "daily-log.json");
const DAILY_LOG_MODULE_PATH = require.resolve("../src/storage/dailyLog");
const PUBLIC_ALERTS_MODULE_PATH = require.resolve("../src/notify/publicAlerts");

// Sama pola freshDailyLog() kayak tests/dailyLog.test.js - dailyLog.js's
// jsonStore nge-cache di memori, dan publicAlerts.js sendiri nyimpen
// referensi ke fungsi-fungsi dailyLog.js pas di-require, jadi keduanya perlu
// di-fresh bareng biar test gak numpang sisa state test lain.
function freshPublicAlerts() {
  delete require.cache[DAILY_LOG_MODULE_PATH];
  delete require.cache[PUBLIC_ALERTS_MODULE_PATH];
  try {
    fs.unlinkSync(DAILY_LOG_FILE);
  } catch {
    // wajar kalau belum pernah ada file-nya
  }
  return require("../src/notify/publicAlerts");
}

function session(name, username, startedAtUnix, durationMs, peakViewCount = null) {
  return {
    name,
    username,
    startedAtUnix,
    endedAtUnix: startedAtUnix + Math.floor(durationMs / 1000),
    durationMs,
    peakViewCount,
  };
}

test("buildDailyRecapPayload - embed dengan title/color/fields/timestamp, total & paling lama bener", () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const completed = [
    session("Nala", "jkt48_nala", nowSec - 3600, 30 * 60_000),
    session("Levi", "jkt48_levi", nowSec - 7200, 90 * 60_000), // paling lama
    session("Nala", "jkt48_nala", nowSec - 1800, 20 * 60_000), // Nala live lagi hari yang sama
  ];

  const payload = buildDailyRecapPayload(completed, "2026-09-21");

  assert.equal(payload.content, undefined, "harus embed, bukan content teks polos lagi");
  assert.equal(payload.embeds.length, 1);
  const embed = payload.embeds[0];
  assert.equal(embed.title, "📋 Rekap live hari ini (2026-09-21)");
  assert.equal(embed.color, DAILY_RECAP_COLOR);
  assert.ok(embed.timestamp);

  const fieldByName = Object.fromEntries(embed.fields.map((f) => [f.name, f.value]));
  assert.equal(fieldByName["Total live"], "3x dari 2 member"); // Nala 2x + Levi 1x = 3 sesi, 2 member unik
  assert.equal(fieldByName["Total durasi gabungan"], "2j 20m"); // 30+90+20 menit = 140 menit = 2j 20m
  assert.match(fieldByName["Paling lama"], /Levi/); // 90 menit > 30 menit > 20 menit
});

test("buildDailyRecapPayload - satu sesi doang tetep kebentuk bener (gak ada divide-by-zero/undefined)", () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const payload = buildDailyRecapPayload([session("Lily", "jkt48_lily", nowSec - 600, 10 * 60_000)], "2026-09-21");
  const fieldByName = Object.fromEntries(payload.embeds[0].fields.map((f) => [f.name, f.value]));
  assert.equal(fieldByName["Total live"], "1x dari 1 member");
  assert.equal(fieldByName["Total durasi gabungan"], "10m");
  assert.match(fieldByName["Paling lama"], /Lily/);
});

test("buildDailyRecapPayload - array kosong balikin null, BUKAN throw (completed.reduce(..., completed[0]) bahaya kalau kosong)", () => {
  assert.equal(buildDailyRecapPayload([], "2026-09-21"), null);
});

test("maybeSendDailyRecap - ada sesi hari ini -> kirim embed lewat webhook, recapSentDate ke-update, gak kekirim dobel", async () => {
  freshPublicAlerts();
  const { recordLiveEnded } = require("../src/storage/dailyLog");
  const { maybeSendDailyRecap } = require("../src/notify/publicAlerts");

  const now = Date.now();
  recordLiveEnded("Nala", "jkt48_nala", new Date(now - 3600_000), new Date(now), 500);

  const original = global.fetch;
  let callCount = 0;
  let capturedBody = null;
  global.fetch = async (url, options) => {
    callCount++;
    capturedBody = JSON.parse(options.body);
    return { ok: true, json: async () => ({}) };
  };
  try {
    await maybeSendDailyRecap();
    assert.equal(callCount, 1);
    assert.equal(capturedBody.embeds[0].title.startsWith("📋 Rekap live hari ini"), true);

    // Dipanggil lagi hari yang sama - recapSentDate udah keisi, gak kirim dobel.
    await maybeSendDailyRecap();
    assert.equal(callCount, 1, "gak boleh kekirim 2x buat hari yang sama");
  } finally {
    global.fetch = original;
  }
});

test("maybeSendDailyRecap - belum ada sesi sama sekali hari ini -> gak ngirim apa-apa, tapi recapSentDate tetep ke-set (nyegah re-check tiap siklus)", async () => {
  freshPublicAlerts();
  const { maybeSendDailyRecap } = require("../src/notify/publicAlerts");
  const { loadDailyLog } = require("../src/storage/dailyLog");

  const original = global.fetch;
  let callCount = 0;
  global.fetch = async () => {
    callCount++;
    return { ok: true, json: async () => ({}) };
  };
  try {
    await maybeSendDailyRecap();
    assert.equal(callCount, 0);
    assert.ok(loadDailyLog().recapSentDate);
  } finally {
    global.fetch = original;
  }
});
