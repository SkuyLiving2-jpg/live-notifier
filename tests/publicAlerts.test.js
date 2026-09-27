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
  maybeSendPublicHeadsUpAlerts,
} = require("../src/notify/publicAlerts");
const { DAILY_RECAP_COLOR } = require("../src/config");
const { saveDurationHistory } = require("../src/storage/durationHistory");
const { activeLives } = require("../src/storage/activeLives");
const { addSubscription } = require("../src/storage/subscriptions");

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

// ==== Saran fitur ke-4 (§10's kelimapuluh+item): heads-up jadwal PUBLIK ====
// Beda dari priorityDm.test.js's maybeSendHeadsUpAlerts (DM ke owner, cuma
// member prioritas) - ini buat member MANAPUN yang punya subscriber, dikirim
// ke channel (postToWebhook) sambil nge-tag subscriber-nya. Recipe waktu
// yang sama persis kayak priorityDm.test.js (5 riwayat di jam 13:00+07:00,
// durasi 1 jam -> rentang perkiraan 12:00-12:00 WIB) biar gampang
// dibandingin, member-nya beda nama biar gak numpang state test lain.
function fiveHeadsUpEntries(name) {
  return [1, 2, 3, 4, 5].map((day) => ({ name, durationMs: 60 * 60_000, at: `2026-09-0${day}T13:00:00+07:00` }));
}
const PUBLIC_INSIDE_WINDOW_NOW = new Date("2026-09-20T12:30:00+07:00"); // jam 12 WIB - di dalem rentang 12-12
const PUBLIC_OUTSIDE_WINDOW_NOW = new Date("2026-09-20T18:00:00+07:00"); // jam 18 WIB - jelas di luar

test("maybeSendPublicHeadsUpAlerts - pola kuat + jam masuk rentang + ada subscriber + belum live -> post ke channel, nge-tag SEMUA subscriber", async () => {
  saveDurationHistory({ jkt48_headsuppub1: fiveHeadsUpEntries("Headsuppub1") });
  addSubscription("headsuppub1", "sub-user-1");
  addSubscription("headsuppub1", "sub-user-2");

  const original = global.fetch;
  let capturedBody = null;
  global.fetch = async (url, options) => {
    capturedBody = JSON.parse(options.body);
    return { ok: true, json: async () => ({}) };
  };
  try {
    await maybeSendPublicHeadsUpAlerts(PUBLIC_INSIDE_WINDOW_NOW);
    assert.match(capturedBody.content, /\*\*Headsuppub1\*\* biasanya live sekitar jam segini/);
    assert.match(capturedBody.content, /<@sub-user-1>/);
    assert.match(capturedBody.content, /<@sub-user-2>/);
    assert.deepEqual(new Set(capturedBody.allowed_mentions.users), new Set(["sub-user-1", "sub-user-2"]));
  } finally {
    global.fetch = original;
  }
});

test("maybeSendPublicHeadsUpAlerts - dipanggil 2x hari yang sama -> post cuma SEKALI (dedup harian, key 'sub:' terpisah dari versi DM)", async () => {
  saveDurationHistory({ jkt48_headsuppub2: fiveHeadsUpEntries("Headsuppub2") });
  addSubscription("headsuppub2", "sub-user-3");

  let sendCount = 0;
  const original = global.fetch;
  global.fetch = async () => {
    sendCount++;
    return { ok: true, json: async () => ({}) };
  };
  try {
    await maybeSendPublicHeadsUpAlerts(PUBLIC_INSIDE_WINDOW_NOW);
    await maybeSendPublicHeadsUpAlerts(new Date("2026-09-20T13:00:00+07:00")); // masih hari yang sama, masih dalem rentang
    assert.equal(sendCount, 1);
  } finally {
    global.fetch = original;
  }
});

test("maybeSendPublicHeadsUpAlerts - member LAGI LIVE SEKARANG -> gak ngirim apa-apa, walau pola/jam-nya cocok", async () => {
  saveDurationHistory({ jkt48_headsuppub3: fiveHeadsUpEntries("Headsuppub3") });
  addSubscription("headsuppub3", "sub-user-4");
  activeLives.set("jkt48_headsuppub3", { name: "Headsuppub3", username: "jkt48_headsuppub3", slug: "s", liveAt: new Date().toISOString() });

  let sent = false;
  const original = global.fetch;
  global.fetch = async () => {
    sent = true;
    return { ok: true, json: async () => ({}) };
  };
  try {
    await maybeSendPublicHeadsUpAlerts(PUBLIC_INSIDE_WINDOW_NOW);
    assert.equal(sent, false);
  } finally {
    global.fetch = original;
    activeLives.delete("jkt48_headsuppub3");
  }
});

test("maybeSendPublicHeadsUpAlerts - dua keyword subscribe BEDA yang resolve ke member yang SAMA -> digabung jadi SATU alert (union subscriber), bukan dua kali kirim", async () => {
  saveDurationHistory({ jkt48_headsuppub5: fiveHeadsUpEntries("Headsuppub5") });
  addSubscription("headsuppub5", "sub-user-6");
  addSubscription("headsuppub5 jkt48", "sub-user-7"); // ejaan beda, member IDN yang SAMA

  let callCount = 0;
  let capturedBody = null;
  const original = global.fetch;
  global.fetch = async (url, options) => {
    callCount++;
    capturedBody = JSON.parse(options.body);
    return { ok: true, json: async () => ({}) };
  };
  try {
    await maybeSendPublicHeadsUpAlerts(PUBLIC_INSIDE_WINDOW_NOW);
    assert.equal(callCount, 1, "harus SATU alert doang, bukan sekali per keyword yang match ke member yang sama");
    assert.deepEqual(new Set(capturedBody.allowed_mentions.users), new Set(["sub-user-6", "sub-user-7"]));
  } finally {
    global.fetch = original;
  }
});

test("maybeSendPublicHeadsUpAlerts - riwayat kurang dari 5x (di bawah ambang) -> gak ngirim", async () => {
  saveDurationHistory({ jkt48_headsuppub6: fiveHeadsUpEntries("Headsuppub6").slice(0, 3) });
  addSubscription("headsuppub6", "sub-user-8");

  let sent = false;
  const original = global.fetch;
  global.fetch = async () => {
    sent = true;
    return { ok: true, json: async () => ({}) };
  };
  try {
    await maybeSendPublicHeadsUpAlerts(PUBLIC_INSIDE_WINDOW_NOW);
    assert.equal(sent, false);
  } finally {
    global.fetch = original;
  }
});

test("maybeSendPublicHeadsUpAlerts - jam sekarang di LUAR rentang perkiraan -> gak ngirim", async () => {
  saveDurationHistory({ jkt48_headsuppub7: fiveHeadsUpEntries("Headsuppub7") });
  addSubscription("headsuppub7", "sub-user-9");

  let sent = false;
  const original = global.fetch;
  global.fetch = async () => {
    sent = true;
    return { ok: true, json: async () => ({}) };
  };
  try {
    await maybeSendPublicHeadsUpAlerts(PUBLIC_OUTSIDE_WINDOW_NOW);
    assert.equal(sent, false);
  } finally {
    global.fetch = original;
  }
});

test("maybeSendPublicHeadsUpAlerts - member yang gak punya subscriber sama sekali gak ikut diproses (gak nyentuh network)", async () => {
  saveDurationHistory({ jkt48_headsuppub8nosub: fiveHeadsUpEntries("Headsuppub8nosub") });
  // Sengaja TANPA addSubscription

  let sent = false;
  const original = global.fetch;
  global.fetch = async () => {
    sent = true;
    return { ok: true, json: async () => ({}) };
  };
  try {
    await maybeSendPublicHeadsUpAlerts(PUBLIC_INSIDE_WINDOW_NOW);
    assert.equal(sent, false);
  } finally {
    global.fetch = original;
  }
});

// ==== Saran fitur ke-5 (§10's kelimapuluh+item): LIVE STREAK milestone ====
// freshPublicAlerts() dipake di sini (bukan cuma top-level maybeSendPublicHeadsUpAlerts
// yang gak nyentuh dailyLog sama sekali) - maybeAnnounceStreakMilestone
// manggil getDistinctSessionDatesForMember (storage/dailyLog.js), dan file
// ini nge-fresh-reload dailyLog+publicAlerts bareng di test-test LAIN, jadi
// referensi top-level yang di-capture di awal file udah gak konsisten lagi
// sama instance dailyLog TERBARU begitu ada test freshPublicAlerts() lain
// yang jalan duluan - sama pola freshDailyLog()-nya kayak tests di atas.
function recordConsecutiveDays(recordLiveEnded, name, username, daysAgoList) {
  const now = Date.now();
  for (const daysAgo of daysAgoList) {
    const endedAt = new Date(now - daysAgo * 24 * 60 * 60 * 1000);
    recordLiveEnded(name, username, new Date(endedAt.getTime() - 60_000), endedAt, 5);
  }
}

test("maybeAnnounceStreakMilestone - streak nyampe milestone pertama (3 hari) -> alert kekirim SEKALI, gak diulang buat streak yang SAMA", async () => {
  freshPublicAlerts();
  const { recordLiveEnded } = require("../src/storage/dailyLog");
  const { maybeAnnounceStreakMilestone } = require("../src/notify/publicAlerts");
  recordConsecutiveDays(recordLiveEnded, "Streakmilea", "jkt48_streakmilea", [0, 1, 2]);

  let sendCount = 0;
  let capturedBody = null;
  const original = global.fetch;
  global.fetch = async (url, options) => {
    sendCount++;
    capturedBody = JSON.parse(options.body);
    return { ok: true, json: async () => ({}) };
  };
  try {
    await maybeAnnounceStreakMilestone("jkt48_streakmilea", "Streakmilea");
    assert.equal(sendCount, 1);
    assert.match(capturedBody.content, /\*\*Streakmilea\*\* lagi live \*\*3 hari berturut-turut\*\*/);

    await maybeAnnounceStreakMilestone("jkt48_streakmilea", "Streakmilea"); // streak masih 3, milestone 3 udah diumumin
    assert.equal(sendCount, 1, "gak boleh ngirim ulang buat streak yang sama persis");
  } finally {
    global.fetch = original;
  }
});

test("maybeAnnounceStreakMilestone - streak di BAWAH milestone pertama -> gak ngirim apa-apa", async () => {
  freshPublicAlerts();
  const { recordLiveEnded } = require("../src/storage/dailyLog");
  const { maybeAnnounceStreakMilestone } = require("../src/notify/publicAlerts");
  recordConsecutiveDays(recordLiveEnded, "Streakmileb", "jkt48_streakmileb", [0, 1]); // streak 2, milestone pertama 3

  let sent = false;
  const original = global.fetch;
  global.fetch = async () => {
    sent = true;
    return { ok: true, json: async () => ({}) };
  };
  try {
    await maybeAnnounceStreakMilestone("jkt48_streakmileb", "Streakmileb");
    assert.equal(sent, false);
  } finally {
    global.fetch = original;
  }
});

test("maybeAnnounceStreakMilestone - streak LONCAT ngelewatin beberapa milestone sekaligus -> cuma SATU alert (milestone TERTINGGI yang kelewatan)", async () => {
  freshPublicAlerts();
  const { recordLiveEnded } = require("../src/storage/dailyLog");
  const { maybeAnnounceStreakMilestone } = require("../src/notify/publicAlerts");
  recordConsecutiveDays(recordLiveEnded, "Streakmilec", "jkt48_streakmilec", [0, 1, 2, 3, 4]); // streak 5 - lewatin milestone 3 DAN 5 sekaligus

  let sendCount = 0;
  let capturedBody = null;
  const original = global.fetch;
  global.fetch = async (url, options) => {
    sendCount++;
    capturedBody = JSON.parse(options.body);
    return { ok: true, json: async () => ({}) };
  };
  try {
    await maybeAnnounceStreakMilestone("jkt48_streakmilec", "Streakmilec");
    assert.equal(sendCount, 1);
    assert.match(capturedBody.content, /\*\*5 hari berturut-turut\*\*/);
  } finally {
    global.fetch = original;
  }
});

test("maybeAnnounceStreakMilestone - streak SEKARANG putus (gak ada aktivitas hari ini/kemarin) -> penanda lama ke-reset ke 0, walau dulu sempet nyampe milestone", async () => {
  freshPublicAlerts();
  const { recordLiveEnded } = require("../src/storage/dailyLog");
  const { maybeAnnounceStreakMilestone } = require("../src/notify/publicAlerts");
  const { setLastAlertedStreak, getLastAlertedStreak } = require("../src/storage/streaks");

  // Sesi LAMA (5 hari lalu) - streak yang PERNAH ada tapi UDAH putus sekarang
  // (gak ada aktivitas hari ini/kemarin).
  const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
  recordLiveEnded("Streakmileputus", "jkt48_streakmileputus", new Date(fiveDaysAgo.getTime() - 60_000), fiveDaysAgo, 5);
  setLastAlertedStreak("jkt48_streakmileputus", 3); // pura-pura dulu sempet ngelewatin milestone 3

  let sent = false;
  const original = global.fetch;
  global.fetch = async () => {
    sent = true;
    return { ok: true, json: async () => ({}) };
  };
  try {
    await maybeAnnounceStreakMilestone("jkt48_streakmileputus", "Streakmileputus");
    assert.equal(sent, false, "streak-nya 0 sekarang, gak ada milestone baru buat diumumin");
    assert.equal(getLastAlertedStreak("jkt48_streakmileputus"), 0, "penanda lama harus ke-reset begitu streak-nya putus");
  } finally {
    global.fetch = original;
  }
});

// ==== BUG YANG DITEMUKAN (debug pass): maybeAnnounceStreakMilestone SATU-
// SATUNYA jalan yang manggil clearStreakAlert, tapi cuma dipanggil monitor.js
// pas member itu BARUSAN SELESAI live - kalau streak-nya putus gara-gara
// member VAKUM (gak live sama sekali), gak ada apapun yang manggil fungsi itu
// buat dia, jadi lastAlertedStreak nyangkut permanen dan milestone yang sama
// di streak BARU ke-skip diem-diem. maybeCleanupBrokenStreaks (dipanggil
// monitor.js tiap siklus, terpisah dari maybeAnnounceStreakMilestone) adalah
// fix-nya - lihat komen lengkapnya di src/notify/publicAlerts.js. ====
test("maybeCleanupBrokenStreaks - member VAKUM (streak putus TANPA baru aja selesai live) -> penanda lama ke-reset, milestone yang sama bisa dirayain lagi", async () => {
  freshPublicAlerts();
  const { recordLiveEnded } = require("../src/storage/dailyLog");
  const { maybeCleanupBrokenStreaks, maybeAnnounceStreakMilestone } = require("../src/notify/publicAlerts");
  const { setLastAlertedStreak, getLastAlertedStreak } = require("../src/storage/streaks");

  // Streak LAMA (5 hari berturut-turut, berakhir 10 hari lalu) udah sempet
  // ngelewatin milestone 3 DAN 5 - lastAlertedStreak jadi 5. Terus member
  // ini VAKUM 10 hari (gak ada satupun sesi baru) - TIDAK PERNAH ada
  // panggilan maybeAnnounceStreakMilestone buat dia selama vakum itu (beda
  // dari test "streak SEKARANG putus" di atas yang manggil fungsi itu
  // LANGSUNG - di sini kita simulasiin "gak pernah dipanggil sama sekali").
  recordConsecutiveDays(recordLiveEnded, "Streakvakum", "jkt48_streakvakum", [14, 13, 12, 11, 10]);
  setLastAlertedStreak("jkt48_streakvakum", 5);

  await maybeCleanupBrokenStreaks();
  assert.equal(getLastAlertedStreak("jkt48_streakvakum"), 0, "streak yang beneran udah putus (vakum) harus ke-reset ke 0 oleh cleanup");

  // Streak BARU mulai dari sekarang, nyampe milestone 3 lagi - TANPA fix ini,
  // lastAlertedStreak yang nyangkut di 5 bakal bikin alert ini DIEM
  // (lastAlerted(5) < milestone(3) => false).
  recordConsecutiveDays(recordLiveEnded, "Streakvakum", "jkt48_streakvakum", [0, 1, 2]);

  let sendCount = 0;
  let capturedBody = null;
  const original = global.fetch;
  global.fetch = async (url, options) => {
    sendCount++;
    capturedBody = JSON.parse(options.body);
    return { ok: true, json: async () => ({}) };
  };
  try {
    await maybeAnnounceStreakMilestone("jkt48_streakvakum", "Streakvakum");
    assert.equal(sendCount, 1, "milestone 3 di streak BARU harus dirayain lagi, bukan ke-skip gara-gara penanda lama");
    assert.match(capturedBody.content, /\*\*3 hari berturut-turut\*\*/);
  } finally {
    global.fetch = original;
  }
});

test("maybeCleanupBrokenStreaks - streak yang MASIH JALAN (belum putus) -> penanda dibiarin apa adanya", async () => {
  freshPublicAlerts();
  const { recordLiveEnded } = require("../src/storage/dailyLog");
  const { maybeCleanupBrokenStreaks } = require("../src/notify/publicAlerts");
  const { setLastAlertedStreak, getLastAlertedStreak } = require("../src/storage/streaks");

  recordConsecutiveDays(recordLiveEnded, "Streakjalan", "jkt48_streakjalan", [0, 1, 2]); // streak masih 3, masih "hidup" (hari ini keisi)
  setLastAlertedStreak("jkt48_streakjalan", 3);

  await maybeCleanupBrokenStreaks();
  assert.equal(getLastAlertedStreak("jkt48_streakjalan"), 3, "streak yang belum putus gak boleh ke-reset");
});

test("maybeCleanupBrokenStreaks - member LAGI LIVE sekarang (belum ada sesi selesai hari ini) -> dilewatin, penanda dibiarin apa adanya", async () => {
  freshPublicAlerts();
  const { recordLiveEnded } = require("../src/storage/dailyLog");
  const { maybeCleanupBrokenStreaks } = require("../src/notify/publicAlerts");
  const { setLastAlertedStreak, getLastAlertedStreak } = require("../src/storage/streaks");

  // Streak lama 3 hari, berakhir KEMARIN (jadi hari ini belum ada sesi
  // SELESAI yang kecatet) - tapi membernya lagi LIVE sekarang, jadi streak-nya
  // SEBENARNYA masih "hidup" (isLiveNow ikut ke-hitung, computeCurrentStreak).
  recordConsecutiveDays(recordLiveEnded, "Streaklive", "jkt48_streaklive", [1, 2, 3]);
  setLastAlertedStreak("jkt48_streaklive", 3);
  activeLives.set("jkt48_streaklive", { name: "Streaklive", username: "jkt48_streaklive", slug: "s", liveAt: new Date().toISOString() });

  try {
    await maybeCleanupBrokenStreaks();
    assert.equal(getLastAlertedStreak("jkt48_streaklive"), 3, "member yang lagi live gak boleh ke-anggep putus streak-nya");
  } finally {
    activeLives.delete("jkt48_streaklive");
  }
});

// ==== Saran fitur ke-6 (§10's kelimapuluh+item): "prediksi jadwal hari ini" ====
// 2026-09-27 (WIB) = Minggu (dipakai juga sama A_SUNDAY di atas) - entries di
// bawah SEMUANYA jatuh di hari Minggu (interval 7 hari, weekday konsisten)
// jam 13:00 (mulai jam 12:00, bucket "siang"), biar topWeekdayName/topBucketName
// dua-duanya dominan penuh (5/5).
function sundayEntries(name) {
  return ["2026-08-30", "2026-09-06", "2026-09-13", "2026-09-20", "2026-09-27"].map((date) => ({
    name,
    durationMs: 60 * 60_000,
    at: `${date}T13:00:00+07:00`,
  }));
}
const DIGEST_ON_SUNDAY_MORNING = new Date("2026-09-27T08:00:00+07:00"); // jam 8 WIB, lewat gerbang SCHEDULE_DIGEST_HOUR (default 7)
const DIGEST_ON_SUNDAY_TOO_EARLY = new Date("2026-09-27T05:00:00+07:00"); // jam 5 WIB, belum lewat gerbang

test("maybeSendScheduleDigest - member pola KUAT (jam+hari) match hari ini -> kirim embed, dedup harian", async () => {
  freshPublicAlerts();
  saveDurationHistory({ jkt48_digesta: sundayEntries("Digesta") });
  const { maybeSendScheduleDigest } = require("../src/notify/publicAlerts");

  let sendCount = 0;
  let capturedBody = null;
  const original = global.fetch;
  global.fetch = async (url, options) => {
    sendCount++;
    capturedBody = JSON.parse(options.body);
    return { ok: true, json: async () => ({}) };
  };
  try {
    await maybeSendScheduleDigest(DIGEST_ON_SUNDAY_MORNING);
    assert.equal(sendCount, 1);
    assert.match(capturedBody.embeds[0].title, /Prediksi jadwal hari Minggu/);
    assert.match(capturedBody.embeds[0].description, /\*\*Digesta\*\* sekitar jam 12-12 WIB/);

    await maybeSendScheduleDigest(new Date("2026-09-27T20:00:00+07:00")); // masih hari Minggu yang sama
    assert.equal(sendCount, 1, "gak boleh kekirim dobel hari yang sama");
  } finally {
    global.fetch = original;
  }
});

test("maybeSendScheduleDigest - jam WIB belum lewat SCHEDULE_DIGEST_HOUR -> gerbang ketutup, gak ngirim apa-apa", async () => {
  freshPublicAlerts();
  saveDurationHistory({ jkt48_digestb: sundayEntries("Digestb") });
  const { maybeSendScheduleDigest } = require("../src/notify/publicAlerts");
  const { loadDailyLog } = require("../src/storage/dailyLog");

  let sent = false;
  const original = global.fetch;
  global.fetch = async () => {
    sent = true;
    return { ok: true, json: async () => ({}) };
  };
  try {
    await maybeSendScheduleDigest(DIGEST_ON_SUNDAY_TOO_EARLY);
    assert.equal(sent, false);
    assert.equal(loadDailyLog().digestSentDate, null, "gerbang ketutup - dedup-nya juga gak boleh ke-set");
  } finally {
    global.fetch = original;
  }
});

test("maybeSendScheduleDigest - pola harinya BEDA dari hari ini -> member itu gak ikut ke-daftar, gak ngirim (gak ada kandidat sama sekali)", async () => {
  freshPublicAlerts();
  // Sama persis kekuatan pola-nya kayak sundayEntries, tapi jatuh di hari
  // SABTU (mundur 1 hari dari tiap tanggal di atas), bukan Minggu.
  const saturdayEntries = ["2026-08-29", "2026-09-05", "2026-09-12", "2026-09-19", "2026-09-26"].map((date) => ({
    name: "Digestc",
    durationMs: 60 * 60_000,
    at: `${date}T13:00:00+07:00`,
  }));
  saveDurationHistory({ jkt48_digestc: saturdayEntries });
  const { maybeSendScheduleDigest } = require("../src/notify/publicAlerts");

  let sent = false;
  const original = global.fetch;
  global.fetch = async () => {
    sent = true;
    return { ok: true, json: async () => ({}) };
  };
  try {
    await maybeSendScheduleDigest(DIGEST_ON_SUNDAY_MORNING); // dicek hari MINGGU, historinya Sabtu semua
    assert.equal(sent, false);
  } finally {
    global.fetch = original;
  }
});

test("maybeSendScheduleDigest - member LAGI LIVE SEKARANG dikecualiin dari daftar (walau pola-nya kuat match hari ini)", async () => {
  freshPublicAlerts();
  saveDurationHistory({ jkt48_digestd: sundayEntries("Digestd") });
  activeLives.set("jkt48_digestd", { name: "Digestd", username: "jkt48_digestd", slug: "s", liveAt: new Date().toISOString() });
  const { maybeSendScheduleDigest } = require("../src/notify/publicAlerts");

  let sent = false;
  const original = global.fetch;
  global.fetch = async () => {
    sent = true;
    return { ok: true, json: async () => ({}) };
  };
  try {
    await maybeSendScheduleDigest(DIGEST_ON_SUNDAY_MORNING);
    assert.equal(sent, false);
  } finally {
    global.fetch = original;
    activeLives.delete("jkt48_digestd");
  }
});

test("buildScheduleDigestPayload - array kandidat kosong -> null (bukan embed kosong)", () => {
  const { buildScheduleDigestPayload } = require("../src/notify/publicAlerts");
  assert.equal(buildScheduleDigestPayload([], "Minggu"), null);
});
