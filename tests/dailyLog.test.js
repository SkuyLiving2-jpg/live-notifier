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
  } catch {
    // wajar kalau belum pernah ada file-nya
  }
  return require("../src/storage/dailyLog");
}

function writeRawFile(raw) {
  fs.mkdirSync(tempCacheDir, { recursive: true });
  fs.writeFileSync(DAILY_LOG_FILE, JSON.stringify(raw));
}

// PENTING: dates di test file ini dibikin RELATIF ke Date.now() (bukan
// tanggal fixed kayak "2026-01-15"), soalnya recordLiveEnded motong sesi
// yang lebih tua dari SESSION_RETENTION_DAYS (35 hari) - tanggal fixed yang
// kebetulan lebih dari 35 hari dari kapan test ini BENERAN dijalanin bakal
// ke-prune diem-diem sebelum sempet ke-assert (persis bug yang kejadian pas
// nulis test ini pertama kali).
test("recordLiveEnded nyimpen startedAtUnix/endedAtUnix/durationMs dari Date yang dikasih (bukan ditebak/dimundurin)", () => {
  const { loadDailyLog, recordLiveEnded } = freshDailyLog();

  const endedAt = new Date();
  const startedAt = new Date(endedAt.getTime() - 90 * 60_000); // 90 menit sebelumnya
  recordLiveEnded("Nala", "jkt48_nala", startedAt, endedAt, 123);

  const [session] = loadDailyLog().sessions;
  assert.equal(session.startedAtUnix, Math.floor(startedAt.getTime() / 1000));
  assert.equal(session.endedAtUnix, Math.floor(endedAt.getTime() / 1000));
  assert.equal(session.durationMs, endedAt.getTime() - startedAt.getTime());
  assert.equal(session.peakViewCount, 123);
});

test("recordLiveEnded dipanggil 2x -> APPEND, bukan nimpa/nyari sesi lama (gak ada lagi konsep 'openSession')", () => {
  const { loadDailyLog, recordLiveEnded } = freshDailyLog();

  const now = Date.now();
  recordLiveEnded("Nala", "jkt48_nala", new Date(now - 3 * 60_000), new Date(now - 2 * 60_000), 10);
  recordLiveEnded("Nala", "jkt48_nala", new Date(now - 2 * 60_000), new Date(now - 1 * 60_000), 20);

  assert.equal(loadDailyLog().sessions.length, 2);
});

test("getCompletedSessionsToday - nyaring berdasarkan tanggal WIB pas SELESAI-nya (endedAtUnix), termasuk sesi yang MULAI kemarin", () => {
  const { recordLiveEnded, getCompletedSessionsToday } = freshDailyLog();

  // Dibikin RELATIF ke tanggal sekarang (bukan tanggal fixed) biar test-nya
  // gak flaky/salah tanggal tergantung kapan test ini dijalanin.
  const today = getTodayWIB();
  const yesterdayDate = new Date(`${today}T00:00:00+07:00`);
  yesterdayDate.setDate(yesterdayDate.getDate() - 1);
  const yesterday = yesterdayDate.toISOString().slice(0, 10);

  // Sesi yang mulai kemarin 22:50, kelar hari ini 00:39 - kasus persis yang
  // dilaporin user (live nyebrang tengah malam WIB). Harus MASUK hitungan
  // "hari ini" soalnya SELESAI-nya hari ini.
  recordLiveEnded("Nala", "jkt48_nala", new Date(`${yesterday}T22:50:00+07:00`), new Date(`${today}T00:39:00+07:00`), 40);
  // Sesi yang beneran kemarin doang (mulai & selesai kemarin) - HARUS gak
  // ikut kehitung "hari ini".
  recordLiveEnded("Levi", "jkt48_levi", new Date(`${yesterday}T10:00:00+07:00`), new Date(`${yesterday}T11:00:00+07:00`), 5);

  const completed = getCompletedSessionsToday();
  assert.equal(completed.length, 1);
  assert.equal(completed[0].username, "jkt48_nala");
});

test("getCompletedSessionsToday - sesi yang beneran selesai HARI INI (relatif ke jam sistem) ikut kehitung", () => {
  const { recordLiveEnded, getCompletedSessionsToday } = freshDailyLog();

  const now = new Date();
  const startedAt = new Date(now.getTime() - 60_000);
  recordLiveEnded("Nala", "jkt48_nala", startedAt, now, 40);

  const completed = getCompletedSessionsToday();
  assert.equal(completed.length, 1);
  assert.equal(completed[0].username, "jkt48_nala");
});

test("loadDailyLog() migrasi otomatis - buang sesi lama yang masih ke-tag endedAtUnix:null (bentuk file SEBELUM refactor ini)", () => {
  freshDailyLog();
  writeRawFile({
    date: "2000-01-01", // field lama, harus diabaikan/gak bikin error
    sessions: [
      { name: "StillLive", username: "jkt48_stilllive", startedAtUnix: 0, endedAtUnix: null, durationMs: null, peakViewCount: 50 },
      { name: "AlreadyDone", username: "jkt48_done", startedAtUnix: 0, endedAtUnix: 100, durationMs: 100000, peakViewCount: 1 },
    ],
    recapSentDate: "2000-01-01",
  });

  delete require.cache[MODULE_PATH];
  const { loadDailyLog } = require("../src/storage/dailyLog");
  const log = loadDailyLog();

  assert.equal(log.sessions.length, 1);
  assert.equal(log.sessions[0].username, "jkt48_done");
  assert.equal(log.recapSentDate, "2000-01-01"); // recapSentDate TETEP kebawa, bukan field yang dibuang
});

test("recordLiveEnded motong sesi yang lebih tua dari retensi (SESSION_RETENTION_DAYS)", () => {
  const { loadDailyLog, recordLiveEnded } = freshDailyLog();

  const veryOld = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000); // 40 hari lalu, ngelewatin retensi 35 hari
  recordLiveEnded("Old", "jkt48_old", new Date(veryOld.getTime() - 60_000), veryOld, 1);

  const recent = new Date();
  recordLiveEnded("Recent", "jkt48_recent", new Date(recent.getTime() - 60_000), recent, 2);

  const sessions = loadDailyLog().sessions;
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].username, "jkt48_recent");
});
