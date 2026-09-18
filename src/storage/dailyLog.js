const path = require("path");
const { CACHE_DIR } = require("../config");
const { createJsonStore } = require("./jsonStore");
const { getTodayWIB } = require("../utils");

// --- Rekap harian: sekali sehari, ringkasan siapa aja yang live hari itu ---
const DAILY_LOG_FILE = path.join(CACHE_DIR, "daily-log.json");
// date: null sentinel biar SELALU dianggep "hari lain" (raw.date !== today)
// pas file belum pernah ada - loadDailyLog() di bawah bakal masuk ke cabang
// reset dan hasilnya persis sama kayak versi lama yang catch-error.
const store = createJsonStore(DAILY_LOG_FILE, { date: null, sessions: [], recapSentDate: null }, { errorLabel: "log harian" });

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
  const today = getTodayWIB();
  const raw = store.load();
  if (raw.date !== today) {
    // BUG SEBELUMNYA: pas tanggal WIB berganti hari, SEMUA sesi kemarin
    // dibuang - termasuk sesi yang MASIH LIVE (belum ada endedAtUnix). Jadi
    // kalau ada member yang mulai live sebelum tengah malam dan masih live
    // sampai lewat tengah malam, dia "ilang" dari rekap hari ini walau
    // beneran masih live SEKARANG - baru numpang lagi nanti pas dia SELESAI
    // (lewat jalur fallback di recordLiveEndedToday, bukan sebagai baris
    // "Live" yang harusnya kelihatan dari tadi).
    //
    // Sekarang sesi yang masih live (endedAtUnix === null) di-CARRY OVER ke
    // hari yang baru, biar tetep numpang di rekap "hari ini" sampai dia
    // beneran selesai - openSession lookup di recordLiveEndedToday bakal
    // ketemu sesi ini juga (referensi objeknya sama), jadi peak-viewer merge
    // & durasi akuratnya tetap jalan normal, bukan direkonstruksi ulang dari
    // fallback. Sesi yang UDAH selesai dari hari kemarin sengaja TETEP
    // dibuang (bukan tanggung jawab rekap hari ini lagi).
    const carriedOverSessions = (raw.sessions || []).filter((s) => s.endedAtUnix === null);
    return { date: today, sessions: carriedOverSessions, recapSentDate: raw.recapSentDate || null };
  }
  raw.sessions = raw.sessions || [];
  return raw;
}

function saveDailyLog(log) {
  store.save(log);
}

// Dulu rekap CUMA nyatet pas live SELESAI - jadi kalau kamu nanya "cok rekap
// hari ini" pas ada member yang MASIH live (belum kelar), dia bakal keliatan
// "zonk" walau bot JELAS-JELAS abis ngirim notif "mulai live" buat orang itu.
// Sekarang tiap notif "mulai live" yang berhasil kekirim LANGSUNG dicatet
// sebagai sesi (status masih live), terus pas dia selesai sesi yang SAMA
// di-update (bukan bikin entry baru) biar rekap bisa nunjukkin siapa aja
// yang live hari ini - baik yang udah selesai maupun yang masih berlangsung.
function recordLiveStartedToday(name, username, startedAtDate, peakViewCount = null) {
  const log = loadDailyLog();
  log.sessions.push({
    name,
    username,
    startedAtUnix: Math.floor(startedAtDate.getTime() / 1000),
    endedAtUnix: null,
    durationMs: null,
    peakViewCount,
  });
  saveDailyLog(log);
}

function recordLiveEndedToday(name, username, durationMs, endedAtDate, peakViewCount = null) {
  const log = loadDailyLog();
  const endedAtUnix = Math.floor(endedAtDate.getTime() / 1000);
  // Cari sesi "masih live" TERAKHIR buat username ini - biasanya emang itu
  // yang barusan mulai. [...].reverse() bukan .findLast() biar tetep jalan
  // di runtime Node yang lebih lama.
  const openSession = [...log.sessions].reverse().find((s) => s.username === username && s.endedAtUnix === null);
  if (openSession) {
    openSession.endedAtUnix = endedAtUnix;
    openSession.durationMs = durationMs;
    // Ambil peak TERBESAR antara yang kecatet pas mulai vs yang kekumpul
    // sepanjang live-nya jalan, biar gak ketimpa turun kalau penontonnya
    // sempet surut pas mau selesai. Ditulis pake filter+Math.max (BUKAN
    // "Math.max(a ?? 0, b ?? 0) || null") soalnya versi lama itu nganggep
    // peak 0 (kasus langka tapi valid, mis. live keburu selesai sebelum
    // sempet ke-poll sekali pun) sebagai "nggak ada data" - 0 itu falsy di
    // JS, jadi ketimpa null padahal datanya sebenernya ada.
    const knownPeaks = [openSession.peakViewCount, peakViewCount].filter((v) => v != null);
    openSession.peakViewCount = knownPeaks.length > 0 ? Math.max(...knownPeaks) : null;
  } else {
    // Sesi "mulai"-nya kelewat kecatet (mis. live-nya kepotong pergantian
    // hari WIB, atau bot baru restart tengah live) - tetep catet daripada
    // rekap kehilangan data, walau jam mulainya cuma perkiraan mundur dari
    // durasi yang kita tau.
    log.sessions.push({
      name,
      username,
      startedAtUnix: endedAtUnix - Math.round(durationMs / 1000),
      endedAtUnix,
      durationMs,
      peakViewCount,
    });
  }
  saveDailyLog(log);
}

module.exports = {
  loadDailyLog,
  saveDailyLog,
  getTodayWIBRangeUnix,
  fetchExternalTodayLiveHistory,
  recordLiveStartedToday,
  recordLiveEndedToday,
};
