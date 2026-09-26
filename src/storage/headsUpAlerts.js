const path = require("path");
const { CACHE_DIR } = require("../config");
const { createJsonStore } = require("./jsonStore");

// "channelId" gak relevan di sini (beda dari kebanyakan pending-state di
// chat/) - ini per USERNAME doang: { username: "YYYY-MM-DD" (WIB) terakhir
// alert heads-up jadwal live-nya kekirim }. Dipake notify/priorityDm.js's
// maybeSendHeadsUpAlerts (§10's forty-third item) buat mastiin alert cuma
// kekirim SEKALI per member per HARI - tanpa ini, begitu jendela jam
// perkiraannya kebuka, tiap siklus polling (~20 detik) bakal ngirim ulang
// DM yang sama ke owner selama jendelanya masih berlangsung (bisa jadi
// ratusan DM sepanjang beberapa jam).
const HEADS_UP_ALERTS_FILE = path.join(CACHE_DIR, "heads-up-alerts.json");
const store = createJsonStore(HEADS_UP_ALERTS_FILE, {}, { errorLabel: "heads-up jadwal live" });

function loadHeadsUpAlerts() {
  return store.load();
}

function saveHeadsUpAlerts(data) {
  store.save(data);
}

function wasAlertedToday(username, todayWIB) {
  return loadHeadsUpAlerts()[username] === todayWIB;
}

function markAlertedToday(username, todayWIB) {
  const data = loadHeadsUpAlerts();
  data[username] = todayWIB;
  saveHeadsUpAlerts(data);
}

module.exports = { loadHeadsUpAlerts, saveHeadsUpAlerts, wasAlertedToday, markAlertedToday };
