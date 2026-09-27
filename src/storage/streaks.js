const path = require("path");
const { CACHE_DIR } = require("../config");
const { createJsonStore } = require("./jsonStore");

// { username: lastAlertedStreak } - milestone TERTINGGI (angka hari, lihat
// streakMath.js's STREAK_MILESTONES) yang udah diumumin buat STREAK YANG
// LAGI JALAN sekarang (bukan buat selama-lamanya). Begitu streak-nya keputus
// (notify/publicAlerts.js's maybeAnnounceStreakMilestone ngitung 0 lewat
// computeCurrentStreak), entry-nya DIHAPUS (clearStreakAlert) - biar streak
// BARU yang mulai dari 0 lagi bisa ngelewatin milestone yang SAMA dan tetep
// dirayain lagi, bukan didiemin selamanya cuma gara-gara pernah kesentuh
// sebelum streak lamanya putus.
const STREAKS_FILE = path.join(CACHE_DIR, "streak-alerts.json");
const store = createJsonStore(STREAKS_FILE, {}, { errorLabel: "milestone streak live" });

function loadStreakAlerts() {
  return store.load();
}

function saveStreakAlerts(map) {
  store.save(map);
}

function getLastAlertedStreak(username) {
  return loadStreakAlerts()[username] || 0;
}

function setLastAlertedStreak(username, value) {
  const map = loadStreakAlerts();
  map[username] = value;
  saveStreakAlerts(map);
}

function clearStreakAlert(username) {
  const map = loadStreakAlerts();
  if (username in map) {
    delete map[username];
    saveStreakAlerts(map);
  }
}

module.exports = { loadStreakAlerts, saveStreakAlerts, getLastAlertedStreak, setLastAlertedStreak, clearStreakAlert };
