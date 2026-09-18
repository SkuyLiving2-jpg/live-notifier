const path = require("path");
const { CACHE_DIR } = require("../config");
const { createJsonStore } = require("./jsonStore");
const { matchesNameFragment } = require("../utils");

// Riwayat durasi live per username (dalam ms), disimpan biar bisa dipakai
// ngitung rata-rata durasi live seseorang - dasar buat nebak "kemungkinan
// mendekati akhir". Cuma nyimpen 10 data terakhir per orang biar file-nya
// nggak membengkak dan makin relevan sama pola live terbarunya.
const DURATION_HISTORY_FILE = path.join(CACHE_DIR, "live-duration-history.json");
const store = createJsonStore(DURATION_HISTORY_FILE, {}, { errorLabel: "riwayat durasi" });

function loadDurationHistory() {
  return store.load();
}

function saveDurationHistory(history) {
  store.save(history);
}

// Tiap entry nyimpen { name, durationMs, at } - nama-nya kepake buat fitur
// stats & pengumuman rekor, biar bisa nyari riwayat orang yang LAGI NGGAK
// live (activeLives udah kehapus begitu dia selesai live).
function recordLiveDuration(username, name, durationMs) {
  const history = loadDurationHistory();
  const list = history[username] || [];
  list.push({ name, durationMs, at: new Date().toISOString() });
  history[username] = list.slice(-10);
  saveDurationHistory(history);
}

function getAverageDuration(durationHistory, username) {
  const list = durationHistory[username] || [];
  if (list.length === 0) return null;
  return list.reduce((total, item) => total + item.durationMs, 0) / list.length;
}

// Rekor durasi live TERLAMA sebelum live yang baru aja selesai ini (buat
// bandingin apakah ini rekor baru). Return null kalau belum ada riwayat.
function getPreviousMaxDuration(durationHistory, username) {
  const list = durationHistory[username] || [];
  if (list.length === 0) return null;
  return Math.max(...list.map((item) => item.durationMs));
}

function findDurationHistoryByNameFragment(fragment) {
  const needle = (fragment || "").trim().toLowerCase();
  if (!needle) return null;

  const history = loadDurationHistory();
  for (const [username, entries] of Object.entries(history)) {
    if (entries.length === 0) continue;
    const displayName = entries[entries.length - 1].name || username;
    const givenName = displayName.split(/[\s|]+/)[0].toLowerCase();
    if (matchesNameFragment(needle, givenName)) {
      return { username, displayName, entries };
    }
  }
  return null;
}

module.exports = {
  loadDurationHistory,
  saveDurationHistory,
  recordLiveDuration,
  getAverageDuration,
  getPreviousMaxDuration,
  findDurationHistoryByNameFragment,
};
