const { tempCacheDir } = require("./helpers/setupTestEnv");
const fs = require("fs");
const path = require("path");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { getTodayWIB } = require("../src/utils");

const DAILY_LOG_FILE = path.join(tempCacheDir, "daily-log.json");
const MODULE_PATH = require.resolve("../src/storage/dailyLog");

// storage/dailyLog.js's jsonStore caches in memory abis load() pertama -
// kalau semua test numpang 1 module instance yang sama, test belakangan
// bisa keliru "baca" state sisa test sebelumnya, bukan file yang beneran
// baru ditulis/dihapus. Jadi tiap test dikasih module instance FRESH (cache
// require-nya dihapus dulu) + file daily-log.json bersih, biar tiap test
// bener-bener independen gak peduli urutan jalannya.
function freshDailyLog() {
  delete require.cache[MODULE_PATH];
  try {
    fs.unlinkSync(DAILY_LOG_FILE);
  } catch (error) {
    // wajar kalau belum pernah ada file-nya
  }
  return require("../src/storage/dailyLog");
}

test("recordLiveStartedToday lalu recordLiveEndedToday nge-update SESI YANG SAMA, bukan bikin baru", () => {
  const { loadDailyLog, recordLiveStartedToday, recordLiveEndedToday } = freshDailyLog();

  recordLiveStartedToday("Nala", "jkt48_nala", new Date(), 100);
  assert.equal(loadDailyLog().sessions.length, 1);
  assert.equal(loadDailyLog().sessions[0].endedAtUnix, null);

  recordLiveEndedToday("Nala", "jkt48_nala", 60_000, new Date(), 200);
  const sessions = loadDailyLog().sessions;
  assert.equal(sessions.length, 1); // tetep 1, bukan 2
  assert.notEqual(sessions[0].endedAtUnix, null);
  assert.equal(sessions[0].durationMs, 60_000);
});

// Ini bug yang udah dibenerin sesi sebelumnya: "Math.max(a ?? 0, b ?? 0) || null"
// nganggep peak 0 (valid tapi falsy) sebagai "nggak ada data". Filter+Math.max
// yang sekarang dipake harus bener buat SEMUA kombinasi null/0/angka biasa.
const peakScenarios = [
  { startPeak: 0, endPeak: 0, expected: 0 },
  { startPeak: null, endPeak: 0, expected: 0 },
  { startPeak: 0, endPeak: null, expected: 0 },
  { startPeak: 5, endPeak: null, expected: 5 },
  { startPeak: null, endPeak: null, expected: null },
  { startPeak: 3, endPeak: 7, expected: 7 },
];

for (const { startPeak, endPeak, expected } of peakScenarios) {
  test(`peakViewCount merge: start=${startPeak}, end=${endPeak} -> ${expected}`, () => {
    const { loadDailyLog, recordLiveStartedToday, recordLiveEndedToday } = freshDailyLog();

    recordLiveStartedToday("Nala", "jkt48_nala", new Date(), startPeak);
    recordLiveEndedToday("Nala", "jkt48_nala", 60_000, new Date(), endPeak);
    const [session] = loadDailyLog().sessions;
    assert.equal(session.peakViewCount, expected);
  });
}

test("recordLiveEndedToday TANPA sesi 'mulai' yang cocok -> bikin entry baru dengan startedAtUnix dimundurin dari durasi", () => {
  const { loadDailyLog, recordLiveEndedToday } = freshDailyLog();

  const endedAt = new Date("2026-01-15T10:00:00+07:00");
  const durationMs = 45 * 60_000; // 45 menit

  recordLiveEndedToday("Levi", "jkt48_levi", durationMs, endedAt, 999);

  const [session] = loadDailyLog().sessions;
  assert.equal(session.endedAtUnix, Math.floor(endedAt.getTime() / 1000));
  assert.equal(session.startedAtUnix, Math.floor(endedAt.getTime() / 1000) - Math.round(durationMs / 1000));
  assert.equal(session.peakViewCount, 999);
});

test("loadDailyLog() reset sessions kalau tanggal WIB di file beda dari hari ini (rollover)", () => {
  freshDailyLog(); // mastiin file lama kehapus & module fresh, sebelum kita tulis manual
  fs.mkdirSync(tempCacheDir, { recursive: true });
  fs.writeFileSync(
    DAILY_LOG_FILE,
    JSON.stringify({
      date: "2000-01-01", // pasti beda dari "hari ini"
      sessions: [{ name: "Old", username: "jkt48_old", startedAtUnix: 0, endedAtUnix: 100, durationMs: 100000, peakViewCount: 1 }],
      recapSentDate: "2000-01-01",
    }),
  );

  delete require.cache[MODULE_PATH]; // pastiin module fresh baca file yang barusan ditulis manual
  const { loadDailyLog } = require("../src/storage/dailyLog");
  const log = loadDailyLog();
  assert.equal(log.date, getTodayWIB());
  assert.deepEqual(log.sessions, []);
});
