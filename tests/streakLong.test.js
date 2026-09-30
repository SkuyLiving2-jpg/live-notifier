const { tempCacheDir } = require("./helpers/setupTestEnv");
process.env.DAILY_RECAP_HOUR = "0";

const fs = require("fs");
const path = require("path");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { computeStreakStartDate, computeCurrentStreak, shiftDateWIB, STREAK_MILESTONES } = require("../src/streakMath");
const { getTodayWIB, getDateWIB } = require("../src/utils");

const DAY = 24 * 60 * 60 * 1000;
const RELOAD = ["../src/storage/dailyLog", "../src/notify/publicAlerts", "../src/chat/replies"].map((p) => require.resolve(p));

function fresh() {
  RELOAD.forEach((p) => delete require.cache[p]);
  fs.rmSync(path.join(tempCacheDir, "daily-log.json"), { force: true });
  return {
    log: require("../src/storage/dailyLog"),
    alerts: require("../src/notify/publicAlerts"),
    replies: require("../src/chat/replies"),
  };
}

// Isi streakDates langsung (simulasi catatan yang udah numpuk berbulan-bulan) - sesi lengkapnya
// sendiri sudah lama ke-prune dari arsip 35 hari.
function seedStreakDates(log, username, days) {
  const data = log.loadDailyLog();
  const today = getTodayWIB();
  data.streakDates[username] = Array.from({ length: days }, (_, i) => shiftDateWIB(today, -i)).sort();
  log.saveDailyLog(data);
}

test("computeStreakStartDate - tanggal hari pertama streak; null kalau streak 0; ikut logika 'hari ini belum tapi kemarin ada'", () => {
  const today = "2026-09-30";
  assert.equal(computeStreakStartDate(new Set(["2026-09-28", "2026-09-29", "2026-09-30"]), today), "2026-09-28");
  assert.equal(computeStreakStartDate(new Set(["2026-09-28", "2026-09-29"]), today), "2026-09-28", "hari ini belum, kemarin ada -> masih hidup");
  assert.equal(computeStreakStartDate(new Set(["2026-09-20"]), today), null);
  assert.equal(
    computeStreakStartDate(new Set(["2026-09-29"]), today, true),
    "2026-09-29",
    "lagi live sekarang: hari ini ikut ke-hitung, jadi streak = kemarin + hari ini",
  );
});

test("STREAK_MILESTONES - sekarang nyampe 200 dan 365, tetap urut menaik", () => {
  assert.ok(STREAK_MILESTONES.includes(100) && STREAK_MILESTONES.includes(365));
  for (let i = 1; i < STREAK_MILESTONES.length; i++) assert.ok(STREAK_MILESTONES[i] > STREAK_MILESTONES[i - 1]);
});

test("recordLiveEnded - nyatet tanggal live (dedup per hari) di streakDates, dan pangkas tanggal > 400 hari", () => {
  const { log } = fresh();
  const now = Date.now();
  log.recordLiveEnded("Tanggal", "jkt48_tanggal", new Date(now - 3600_000), new Date(now), 1);
  log.recordLiveEnded("Tanggal", "jkt48_tanggal", new Date(now - 7200_000), new Date(now - 3700_000), 1); // hari yang sama
  const data = log.loadDailyLog();
  const expected = [...new Set([getDateWIB(new Date(now)), getDateWIB(new Date(now - 3700_000))])].sort();
  assert.deepEqual(data.streakDates.jkt48_tanggal, expected);
  assert.equal(new Set(data.streakDates.jkt48_tanggal).size, data.streakDates.jkt48_tanggal.length, "tanggal unik");

  // tanggal kuno (450 hari) yang nyelip ke daftar dibuang di simpan berikutnya
  data.streakDates.jkt48_tanggal.unshift(getDateWIB(new Date(now - 450 * DAY)));
  log.saveDailyLog(data);
  log.recordLiveEnded("Tanggal", "jkt48_tanggal", new Date(now - 3600_000), new Date(now), 1);
  assert.ok(log.loadDailyLog().streakDates.jkt48_tanggal.every((d) => d >= getDateWIB(new Date(now - 400 * DAY))));
});

test("loadDailyLog - file lama tanpa streakDates -> {} (kompatibel), dan streakDates ikut tersimpan lewat save/load biasa", () => {
  const { log } = fresh();
  fs.writeFileSync(path.join(tempCacheDir, "daily-log.json"), JSON.stringify({ sessions: [], recapSentDate: null }));
  delete require.cache[require.resolve("../src/storage/dailyLog")];
  const reloaded = require("../src/storage/dailyLog");
  assert.deepEqual(reloaded.loadDailyLog().streakDates, {});
  assert.ok(log);
});

test("getStreakDatesForMember - gabungan arsip sesi (35 hari) + catatan tanggal; streak 60 hari kebaca PENUH (dulu mentok 35)", () => {
  const { log } = fresh();
  seedStreakDates(log, "jkt48_maraton", 60);
  const dates = log.getStreakDatesForMember("jkt48_maraton");
  assert.equal(computeCurrentStreak(dates, getTodayWIB()), 60);
});

test("'cok streak' - streak > 35 hari dilaporin utuh dengan tanggal mulai; datanya yang mentok di tanggal tertua dikasih catatan jujur", async () => {
  const { log, replies } = fresh();
  log.recordLiveEnded("Maraton", "jkt48_maraton", new Date(Date.now() - 3600_000), new Date(), 1);
  const { recordLiveCompleted } = require("../src/storage/liveCount");
  recordLiveCompleted("jkt48_maraton", "Maraton JKT48");
  seedStreakDates(log, "jkt48_maraton", 60);

  const reply = await replies.replyStreak("maraton");
  assert.match(reply, /streak \*\*60 hari\*\*/);
  assert.match(reply, /Mulai \d/);
  assert.match(reply, /baru kecatet sejak/, "streak nempel di tanggal tertua yang kita punya -> bisa lebih panjang");

  // streak yang jelas KEPUTUS sebelum data tertua -> tanpa catatan 'bisa lebih panjang'
  const data = log.loadDailyLog();
  const today = getTodayWIB();
  data.streakDates.jkt48_maraton = [shiftDateWIB(today, -40), shiftDateWIB(today, -2), shiftDateWIB(today, -1), today].sort();
  log.saveDailyLog(data);
  const short = await replies.replyStreak("maraton");
  assert.match(short, /streak \*\*3 hari\*\*/);
  assert.doesNotMatch(short, /baru kecatet sejak/);
});

test("milestone 50 hari sekarang BISA kekirim (dulu mustahil karena arsip 35 hari), tepat sekali", async () => {
  const { log, alerts } = fresh();
  seedStreakDates(log, "jkt48_lima50", 52);
  const bodies = [];
  const original = global.fetch;
  global.fetch = async (url, options) => {
    bodies.push(JSON.parse(options.body));
    return { ok: true, json: async () => ({}) };
  };
  try {
    await alerts.maybeAnnounceStreakMilestone("jkt48_lima50", "Lima50");
    await alerts.maybeAnnounceStreakMilestone("jkt48_lima50", "Lima50");
  } finally {
    global.fetch = original;
  }
  assert.equal(bodies.length, 1);
  assert.match(bodies[0].content, /52 hari berturut-turut/);
});
