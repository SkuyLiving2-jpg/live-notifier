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
const {
  buildDailyRecapPayload,
  buildWeeklyRecapPayload,
  buildMonthlyRecapPayload,
  isSundayWIB,
  isLastDayOfMonthWIB,
} = require("../src/notify/publicAlerts");
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

// ==== §10's thirty-ninth item: rekap mingguan/bulanan OTOMATIS ====

test("buildWeeklyRecapPayload/buildMonthlyRecapPayload - embed sama strukturnya kayak buildDailyRecapPayload, cuma title beda", () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const completed = [session("Nala", "jkt48_nala", nowSec - 3600, 30 * 60_000), session("Levi", "jkt48_levi", nowSec - 7200, 90 * 60_000)];

  const weekly = buildWeeklyRecapPayload(completed);
  assert.equal(weekly.embeds[0].title, "📋 Rekap live mingguan (7 hari terakhir)");
  assert.equal(weekly.embeds[0].color, DAILY_RECAP_COLOR);
  assert.match(Object.fromEntries(weekly.embeds[0].fields.map((f) => [f.name, f.value]))["Paling lama"], /Levi/);

  const monthly = buildMonthlyRecapPayload(completed, "2026-09");
  assert.equal(monthly.embeds[0].title, "📋 Rekap live bulanan (September 2026)");
  assert.equal(monthly.embeds[0].color, DAILY_RECAP_COLOR);

  assert.equal(buildWeeklyRecapPayload([]), null, "array kosong balikin null, sama kayak buildDailyRecapPayload");
  assert.equal(buildMonthlyRecapPayload([], "2026-09"), null);
});

test("isSundayWIB - true cuma buat instant yang hari WIB-nya beneran Minggu", () => {
  assert.equal(isSundayWIB(new Date("2026-09-27T12:00:00+07:00")), true); // 27 Sept 2026 = Minggu
  assert.equal(isSundayWIB(new Date("2026-09-28T12:00:00+07:00")), false); // Senin
});

test("isLastDayOfMonthWIB - true cuma buat tanggal TERAKHIR bulan kalender WIB, termasuk Februari kabisat", () => {
  assert.equal(isLastDayOfMonthWIB(new Date("2026-09-30T12:00:00+07:00")), true);
  assert.equal(isLastDayOfMonthWIB(new Date("2026-09-29T12:00:00+07:00")), false);
  assert.equal(isLastDayOfMonthWIB(new Date("2024-02-29T12:00:00+07:00")), true); // 2024 kabisat, Feb 29 hari
  assert.equal(isLastDayOfMonthWIB(new Date("2023-02-28T12:00:00+07:00")), true); // 2023 bukan kabisat, Feb cuma 28 hari
});

// `now` di sini SENGAJA tanggal "palsu" (bukan hari beneran sekarang) - cuma
// dipake buat gerbang/kunci-dedup (lihat komen di maybeSendWeeklyRecap),
// sesi yang direkap tetep ditarik dari waktu BENERAN sekarang lewat
// recordLiveEnded (persis pola tes maybeSendDailyRecap di atas).
const A_SUNDAY = new Date("2026-09-27T23:30:00+07:00");
const NOT_A_SUNDAY = new Date("2026-09-28T23:30:00+07:00");
const A_LAST_DAY_OF_MONTH = new Date("2026-09-30T23:30:00+07:00");
const NOT_A_LAST_DAY_OF_MONTH = new Date("2026-09-29T23:30:00+07:00");

test("maybeSendWeeklyRecap - hari Minggu + ada sesi 7 hari terakhir -> kirim embed, recapSentWeek ke-update, gak kekirim dobel buat 'Minggu' yang sama", async () => {
  freshPublicAlerts();
  const { recordLiveEnded } = require("../src/storage/dailyLog");
  const { maybeSendWeeklyRecap } = require("../src/notify/publicAlerts");

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
    await maybeSendWeeklyRecap(A_SUNDAY);
    assert.equal(callCount, 1);
    assert.equal(capturedBody.embeds[0].title, "📋 Rekap live mingguan (7 hari terakhir)");

    await maybeSendWeeklyRecap(A_SUNDAY); // "Minggu" yang sama lagi - gak boleh kekirim dobel
    assert.equal(callCount, 1);
  } finally {
    global.fetch = original;
  }
});

test("maybeSendWeeklyRecap - BUKAN hari Minggu -> gerbang ketutup, gak ngirim apa-apa sama sekali (recapSentWeek juga gak ke-set)", async () => {
  freshPublicAlerts();
  const { recordLiveEnded } = require("../src/storage/dailyLog");
  const { maybeSendWeeklyRecap } = require("../src/notify/publicAlerts");
  const { loadDailyLog } = require("../src/storage/dailyLog");

  recordLiveEnded("Nala", "jkt48_nala", new Date(Date.now() - 3600_000), new Date(), 500);

  const original = global.fetch;
  let callCount = 0;
  global.fetch = async () => {
    callCount++;
    return { ok: true, json: async () => ({}) };
  };
  try {
    await maybeSendWeeklyRecap(NOT_A_SUNDAY);
    assert.equal(callCount, 0);
    assert.equal(loadDailyLog().recapSentWeek, null, "gerbang ketutup - dedup key gak boleh ke-set sama sekali");
  } finally {
    global.fetch = original;
  }
});

test("maybeSendMonthlyRecap - hari terakhir bulan + ada sesi bulan ini -> kirim embed, recapSentMonth ke-update, gak kekirim dobel", async () => {
  freshPublicAlerts();
  const { recordLiveEnded } = require("../src/storage/dailyLog");
  const { maybeSendMonthlyRecap } = require("../src/notify/publicAlerts");

  const now = Date.now();
  recordLiveEnded("Levi", "jkt48_levi", new Date(now - 3600_000), new Date(now), 500);

  const original = global.fetch;
  let callCount = 0;
  let capturedBody = null;
  global.fetch = async (url, options) => {
    callCount++;
    capturedBody = JSON.parse(options.body);
    return { ok: true, json: async () => ({}) };
  };
  try {
    await maybeSendMonthlyRecap(A_LAST_DAY_OF_MONTH);
    assert.equal(callCount, 1);
    assert.match(capturedBody.embeds[0].title, /^📋 Rekap live bulanan \(/);

    await maybeSendMonthlyRecap(A_LAST_DAY_OF_MONTH); // hari terakhir bulan yang sama lagi - gak boleh dobel
    assert.equal(callCount, 1);
  } finally {
    global.fetch = original;
  }
});

test("maybeSendMonthlyRecap - BUKAN hari terakhir bulan -> gerbang ketutup, gak ngirim apa-apa sama sekali (recapSentMonth juga gak ke-set)", async () => {
  freshPublicAlerts();
  const { recordLiveEnded } = require("../src/storage/dailyLog");
  const { maybeSendMonthlyRecap } = require("../src/notify/publicAlerts");
  const { loadDailyLog } = require("../src/storage/dailyLog");

  recordLiveEnded("Levi", "jkt48_levi", new Date(Date.now() - 3600_000), new Date(), 500);

  const original = global.fetch;
  let callCount = 0;
  global.fetch = async () => {
    callCount++;
    return { ok: true, json: async () => ({}) };
  };
  try {
    await maybeSendMonthlyRecap(NOT_A_LAST_DAY_OF_MONTH);
    assert.equal(callCount, 0);
    assert.equal(loadDailyLog().recapSentMonth, null);
  } finally {
    global.fetch = original;
  }
});
