const path = require("path");
const { CACHE_DIR } = require("../config");
const { createJsonStore } = require("./jsonStore");
const { getTodayWIB, getDateWIB } = require("../utils");

// --- Arsip sesi live yang UDAH SELESAI (append-only, dipangkas per SESSION_RETENTION_DAYS) ---
//
// BUG SEBELUMNYA (2x kejadian beneran sebelum ini ditulis ulang): dulu file
// ini juga nyimpen sesi yang MASIH LIVE (endedAtUnix: null), jadi ada 2
// representasi "siapa yang lagi live" yang harus disinkronin manual -
// activeLives.has(username) (lihat storage/activeLives.js) VS sesi di sini
// yang endedAtUnix-nya null. Dua-duanya bisa nyimpang (rollover tengah
// malam ngewipe salah satu doang, dll) - udah pernah kejadian 2x.
//
// Sekarang activeLives SATU-SATUNYA sumber kebenaran buat "siapa yang lagi
// live" - file ini CUMA nyimpen sesi yang UDAH SELESAI, gak pernah lagi
// nyimpen apapun yang "terbuka". Pemanggil yang butuh gambaran LENGKAP hari
// ini (lagi live + udah selesai) gabungin sendiri di layer-nya (lihat
// chat/replies.js) dari getCompletedSessionsToday() di sini + activeLives.
const DAILY_LOG_FILE = path.join(CACHE_DIR, "daily-log.json");
const store = createJsonStore(DAILY_LOG_FILE, { sessions: [], recapSentDate: null }, { errorLabel: "log harian" });

// Berapa lama sesi yang udah selesai disimpen sebelum otomatis dibuang -
// generous banget buat kebutuhan "hari ini"/beberapa minggu terakhir, tapi
// tetep dibatesin biar file-nya nggak numpuk gede tanpa akhir selama
// bot jalan bertahun-tahun (dulu ini otomatis "reset" tiap hari, sekarang
// nggak lagi - jadi pruning ini gantiin peran itu).
const SESSION_RETENTION_DAYS = 35;

// Awal & akhir "hari ini" (WIB, UTC+7 tetap sepanjang tahun - gak ada DST)
// dalam Unix SECONDS, buat nyaring entri arsip eksternal yang live_at_unix-nya
// jatuh di hari ini.
function getTodayWIBRangeUnix() {
  const startMs = new Date(`${getTodayWIB()}T00:00:00+07:00`).getTime();
  return { startSec: Math.floor(startMs / 1000), endSec: Math.floor(startMs / 1000) + 24 * 60 * 60 };
}

// PENTING soal CACHE_DIR/Railway: rekap harian kita ("data/daily-log.json")
// cuma nyatet live yang kita SENDIRI pantau start-sampai-selesai. Kalau bot
// sempet mati/restart di tengah hari (misal abis redeploy, dan CACHE_DIR-nya
// nggak diarahin ke storage yang persist lintas redeploy), live yang
// kejadian pas bot lagi off bakal "kelewatan" - bukan salah IDN, tapi karena
// kita cuma bisa nyatet apa yang kita amati sendiri secara real-time.
//
// IDN sendiri gak nyediain API histori sama sekali (udah di-cek langsung ke
// schema GraphQL-nya). Jadi buat nutup celah itu, kita baca (READ-ONLY, gak
// nulis/redistribusi apa-apa) dari arsip publik JKT48Live-Record
// (github.com/rznive/JKT48Live-Record) - project auto-scraper pihak ketiga
// yang ngerekam tiap live IDN JKT48 lewat GitHub Actions, datanya disimpen
// per-bulan di data/idn/YYYY-MM.json. Ini CUMA pelengkap informasi (siapa aja
// yang sempet live + jam berapa) - repo itu gak punya LICENSE file jadi kita
// nggak nyalin/nyimpen kodenya, cuma baca file JSON publiknya on-the-fly,
// sama kayak kita manggil endpoint publik IDN sendiri. Kalau lagi gak bisa
// diakses (jaringan/repo pindah/dll), rekap tetap jalan normal pakai data
// lokal doang - ini FITUR TAMBAHAN, bukan dependency yang bisa bikin bot mati.
const EXTERNAL_LIVE_HISTORY_BASE_URL = "https://raw.githubusercontent.com/rznive/JKT48Live-Record/main/data/idn";

async function fetchExternalTodayLiveHistory() {
  try {
    const [year, month] = getTodayWIB().split("-");
    const url = `${EXTERNAL_LIVE_HISTORY_BASE_URL}/${year}-${month}.json`;
    const response = await fetch(url);
    if (!response.ok) return null; // wajar kalau bulan berjalan belum ke-commit filenya

    const allEntries = await response.json();
    if (!Array.isArray(allEntries)) return null;

    const { startSec, endSec } = getTodayWIBRangeUnix();
    return allEntries.filter(
      (e) =>
        typeof e?.username === "string" &&
        e.username.toLowerCase().startsWith("jkt48_") &&
        typeof e.live_at_unix === "number" &&
        e.live_at_unix >= startSec &&
        e.live_at_unix < endSec,
    );
  } catch (error) {
    console.error("Gagal ambil arsip live eksternal (nggak fatal, rekap tetap jalan pakai data lokal):", error.message);
    return null;
  }
}

function loadDailyLog() {
  const raw = store.load();
  // Migrasi otomatis dari bentuk file yang LAMA (sebelum ditulis ulang jadi
  // append-only-completed-doang): dulu bisa ada sesi yang MASIH LIVE
  // (endedAtUnix: null) nyangkut di sini. Itu sekarang basi/redundan -
  // activeLives satu-satunya sumber kebenaran buat itu - jadi dibuang aja
  // di sini, gak pernah ditulis lagi ke file ini sejak sekarang.
  const sessions = (raw.sessions || []).filter((s) => s.endedAtUnix !== null);
  // recapSentWeek/recapSentMonth - penanda "hari apa (WIB) rekap mingguan/
  // bulanan OTOMATIS terakhir kekirim" (notify/publicAlerts.js's
  // maybeSendWeeklyRecap/maybeSendMonthlyRecap), sama pola-nya kayak
  // recapSentDate buat rekap harian - dipisah jadi 2 field beda soalnya
  // ketiganya independen (bisa aja rekap harian udah kekirim tapi mingguan
  // belum, dst).
  return {
    sessions,
    recapSentDate: raw.recapSentDate || null,
    recapSentWeek: raw.recapSentWeek || null,
    recapSentMonth: raw.recapSentMonth || null,
  };
}

function saveDailyLog(log) {
  store.save(log);
}

// Sesi yang UDAH SELESAI dan tanggal WIB pas dia SELESAI itu jatuh di
// `dateWIB` ("YYYY-MM-DD") - dasar buat getCompletedSessionsToday() di bawah
// (today = getTodayWIB()) DAN buat rekap "per tanggal" (chat/replies.js's
// getCompletedSessionsForDate re-export), yang butuh nge-query tanggal
// SEMBARANG, bukan cuma hari ini.
function getCompletedSessionsForDate(dateWIB) {
  return loadDailyLog().sessions.filter((s) => getDateWIB(new Date(s.endedAtUnix * 1000)) === dateWIB);
}

// Sesi yang UDAH SELESAI dan tanggal WIB pas dia SELESAI itu "hari ini" -
// dipake buat semua query "hari ini" (rekap, paling lama, paling rame).
// Sesi yang MASIH LIVE SEKARANG itu tanggung jawab activeLives (lihat
// storage/activeLives.js), BUKAN di sini - pemanggil yang butuh gabungan
// keduanya gabungin sendiri di layernya (lihat chat/replies.js).
function getCompletedSessionsToday() {
  return getCompletedSessionsForDate(getTodayWIB());
}

// Versi lebih lebar dari getCompletedSessionsToday() - sesi yang SELESAI-nya
// jatuh dalam `daysBack` hari terakhir (dari sekarang), dipake buat rekap
// mingguan/bulanan. Cuma jadi bisa dibikin gara-gara daily-log.json sekarang
// arsip append-only (bukan di-reset tiap hari kayak dulu) - jadi query
// rentang-lebih-lebar tinggal filter tanggal yang lebih longgar, bukan
// konsep penyimpanan baru.
function getCompletedSessionsSince(daysBack) {
  const cutoffUnix = Math.floor(Date.now() / 1000) - daysBack * 24 * 60 * 60;
  return loadDailyLog().sessions.filter((s) => s.endedAtUnix >= cutoffUnix);
}

// Sesi yang UDAH SELESAI dan tanggal WIB pas dia SELESAI itu jatuh di bulan
// `monthWIB` ("YYYY-MM") - dasar buat rekap PER BULAN (chat/replies.js's
// replyRecapMonth), mirip getCompletedSessionsForDate di atas tapi
// granularitasnya bulan, bukan tanggal spesifik.
function getCompletedSessionsForMonth(monthWIB) {
  return loadDailyLog().sessions.filter((s) => getDateWIB(new Date(s.endedAtUnix * 1000)).startsWith(`${monthWIB}-`));
}

// Daftar bulan ("YYYY-MM") yang PUNYA sesi selesai di arsip, urut dari yang
// paling baru - dasar buat dropdown "cok rekap bulan" polos (chat/replies.js's
// replyRecapMonthGeneric) pas user gak nyebut bulan/tahun spesifik sama sekali.
function getDistinctSessionMonths() {
  const months = new Set(loadDailyLog().sessions.map((s) => getDateWIB(new Date(s.endedAtUnix * 1000)).slice(0, 7)));
  return [...months].sort().reverse();
}

// Tanggal WIB (YYYY-MM-DD) sesi TERTUA yang ada di arsip SAAT INI - dipake
// chat/replies.js's replyRecapRange buat ngasih tau kalau arsipnya belum
// nyakup rentang yang diminta secara penuh (mis. arsip baru mulai kecatet
// H-3, tapi user nanya rekap 7 hari) - biar recap-nya jujur ngasih tau
// KENAPA rentangnya keliatan pendek, bukan diem-diem keliatan kayak bug.
// Null kalau arsipnya masih kosong sama sekali.
function getEarliestSessionDate() {
  const sessions = loadDailyLog().sessions;
  if (sessions.length === 0) return null;
  const earliestUnix = Math.min(...sessions.map((s) => s.endedAtUnix));
  return getDateWIB(new Date(earliestUnix * 1000));
}

// Dipanggil monitor.js pas sebuah live SELESAI. startedAtDate/endedAtDate
// dari activeLives's liveAt (udah akurat, independen total dari file ini -
// gak pernah kena bug rollover/reset apapun yang sempet kejadian di sini).
// peakViewCount juga langsung dari activeLives's running peak - satu-satunya
// sumber, gak ada lagi "gabungin 2 angka peak" kayak versi lama (itu source
// of truth ganda-nya udah ilang sekalian bareng openSession).
function recordLiveEnded(name, username, startedAtDate, endedAtDate, peakViewCount = null) {
  const log = loadDailyLog();
  const startedAtUnix = Math.floor(startedAtDate.getTime() / 1000);
  const endedAtUnix = Math.floor(endedAtDate.getTime() / 1000);
  log.sessions.push({
    name,
    username,
    startedAtUnix,
    endedAtUnix,
    durationMs: endedAtDate.getTime() - startedAtDate.getTime(),
    peakViewCount,
  });

  // Pangkas sesi yang lebih tua dari retensi, biar file gak numpuk gede
  // tanpa batas (dulu ini "otomatis" kejadian tiap hari lewat reset -
  // sekarang perannya digantiin pruning ini).
  const cutoffUnix = Math.floor(Date.now() / 1000) - SESSION_RETENTION_DAYS * 24 * 60 * 60;
  log.sessions = log.sessions.filter((s) => s.endedAtUnix >= cutoffUnix);

  saveDailyLog(log);
}

module.exports = {
  SESSION_RETENTION_DAYS,
  loadDailyLog,
  saveDailyLog,
  getTodayWIBRangeUnix,
  fetchExternalTodayLiveHistory,
  getCompletedSessionsToday,
  getCompletedSessionsForDate,
  getCompletedSessionsSince,
  getCompletedSessionsForMonth,
  getDistinctSessionMonths,
  getEarliestSessionDate,
  recordLiveEnded,
};
