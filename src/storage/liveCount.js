const path = require("path");
const { CACHE_DIR } = require("../config");
const { createJsonStore } = require("./jsonStore");
const { matchesNameFragment } = require("../utils");

// Total berapa kali tiap member SELESAI live semenjak bot ini pertama kali
// jalan - append-only, GAK PERNAH di-prune/reset (beda sama
// durationHistory.js yang cuma nyimpen 10 data TERAKHIR buat ngitung
// rata-rata, dan beda sama dailyLog.js yang di-prune di 35 hari buat rekap).
// Ini murni counter ringan, gak nyimpen tiap sesi satu-satu:
// { username: { name, count, firstLiveAt, lastLiveAt } }.
const LIVE_COUNT_FILE = path.join(CACHE_DIR, "live-count.json");
const store = createJsonStore(LIVE_COUNT_FILE, {}, { errorLabel: "hitungan total live" });

function loadLiveCount() {
  return store.load();
}

function saveLiveCount(data) {
  store.save(data);
}

// Dipanggil sekali tiap sebuah sesi live BENERAN selesai (bareng
// recordLiveDuration/recordLiveEnded di monitor.js) - name di-update tiap
// kali biar ganti nama IDN kepake yang terbaru, count-nya yang gak pernah
// disentuh/direset.
function recordLiveCompleted(username, name) {
  const data = loadLiveCount();
  const existing = data[username];
  const now = new Date().toISOString();
  data[username] = {
    name,
    count: (existing?.count || 0) + 1,
    firstLiveAt: existing?.firstLiveAt || now,
    lastLiveAt: now,
  };
  saveLiveCount(data);
}

// Nge-set ULANG seluruh live-count.json dari daftar sesi LENGKAP yang
// direkonstruksi dari histori pesan notif Discord (lihat
// scripts/backfill-live-history.js + server.js's handleBackfillLiveHistory)
// - REPLACE total, BUKAN nambahin di atas data yang ada. Ini sengaja beda
// dari recordLiveCompleted (yang nambahin satu-satu tiap live beneran
// selesai): histori pesan Discord nyakup SELURUH linimasa dari awal bot
// jalan (bukan cuma sejak fitur ini ada), jadi lebih otoritatif - hasil
// rebuild dari situ SEHARUSNYA nggantiin counter yang mungkin baru mulai
// kehitung belakangan, bukan ditambahin ke atasnya (nanti dobel).
function rebuildLiveCountFromSessions(sessions) {
  const data = {};
  for (const session of sessions) {
    if (!session.username || typeof session.endedAtUnix !== "number") continue;
    const endedAtIso = new Date(session.endedAtUnix * 1000).toISOString();
    const existing = data[session.username];
    data[session.username] = {
      name: session.name,
      count: (existing?.count || 0) + 1,
      firstLiveAt: existing && existing.firstLiveAt < endedAtIso ? existing.firstLiveAt : endedAtIso,
      lastLiveAt: existing && existing.lastLiveAt > endedAtIso ? existing.lastLiveAt : endedAtIso,
    };
  }
  saveLiveCount(data);
  return data;
}

// Top N member berdasarkan TOTAL live count (bukan cuma yang lagi live
// sekarang) - beda dari findLiveCountByNameFragment yang nyari SATU member
// spesifik, ini buat "cok siapa yang paling sering live" (leaderboard semua
// member sekaligus). Diurutin count DESC; kalau count-nya SAMA, urutannya
// ngikutin urutan insersi di live-count.json (Array.prototype.sort JS
// dijamin stabil sejak ES2019 - jadi deterministik, bukan random tiap kali
// dipanggil).
function getLiveCountLeaderboard(limit = 10) {
  return Object.entries(loadLiveCount())
    .map(([username, entry]) => ({ username, name: entry.name, count: entry.count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

function findLiveCountByNameFragment(fragment) {
  const needle = (fragment || "").trim().toLowerCase();
  if (!needle) return null;

  const data = loadLiveCount();
  for (const [username, entry] of Object.entries(data)) {
    const givenName = (entry.name || username).split(/[\s|]+/)[0].toLowerCase();
    if (matchesNameFragment(needle, givenName)) {
      return { username, ...entry };
    }
  }
  return null;
}

// Beda dari findLiveCountByNameFragment di atas (balikin SATU match PERTAMA
// doang, buat "cok bandingin <A> dan <B>" yang teksnya udah jelas nyebut satu
// nama spesifik) - ini buat dropdown pencarian "cok bandingin" POLOS
// (chat/compareFlow.js), yang perlu nunjukkin SEMUA kandidat yang cocok
// (fragment pendek/ambigu bisa kena banyak member) biar usernya milih
// sendiri lewat dropdown, bukan asal kepilih yang pertama ketemu di urutan
// Object.entries (yang gak dijamin match paling relevan). Diurutin
// alfabetis by nama biar dropdown-nya rapi/konsisten.
function searchLiveCountByNameFragment(fragment) {
  const needle = (fragment || "").trim().toLowerCase();
  if (!needle) return [];

  const data = loadLiveCount();
  const results = [];
  for (const [username, entry] of Object.entries(data)) {
    const givenName = (entry.name || username).split(/[\s|]+/)[0].toLowerCase();
    if (matchesNameFragment(needle, givenName)) {
      results.push({ username, name: entry.name, count: entry.count });
    }
  }
  return results.sort((a, b) => a.name.localeCompare(b.name));
}

module.exports = {
  loadLiveCount,
  saveLiveCount,
  recordLiveCompleted,
  rebuildLiveCountFromSessions,
  findLiveCountByNameFragment,
  searchLiveCountByNameFragment,
  getLiveCountLeaderboard,
};
