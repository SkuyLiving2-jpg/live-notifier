const path = require("path");
const { CACHE_DIR } = require("../config");
const { createJsonStore } = require("./jsonStore");

// Pemetaan username IDN -> webhook URL channel KHUSUS member itu (fitur
// "Q2": selain channel gabungan semua member yang udah ada, member tertentu
// bisa punya channel-nya sendiri, mis. #aralie-jkt48). Dikelola lewat
// scripts/set-channel-routing.js (push dari file lokal via endpoint
// /api/channel-routing di server.js), BUKAN lewat chat kayak
// priorityStore.js/subscriptions.js - webhook URL itu SECRET (siapapun yang
// pegang bisa posting ke channel itu), jadi sengaja gak pernah lewat teks
// chat Discord (bakal nyangkut di histori pesan channel-nya).
//
// Keyed PERSIS sama username (bukan fuzzy keyword kayak priority/subscriptions)
// - di skala ~40+ member, exact key jauh lebih aman (nggak ada resiko
// tabrakan whole-word yang mulai kerasa nyata di jumlah segitu) dan lebih
// simpel (lookup O(1) langsung, gak perlu scan+containsWholeWord).
const CHANNEL_ROUTING_FILE = path.join(CACHE_DIR, "channel-routing.json");
const store = createJsonStore(CHANNEL_ROUTING_FILE, {}, { errorLabel: "pemetaan channel per-member" });

function loadChannelRouting() {
  return store.load();
}

// Full REPLACE, bukan merge - file lokal yang di-push (scripts/set-channel-routing.js)
// selalu dianggap sumber kebenaran yang lengkap, bukan tambahan parsial.
function saveChannelRouting(map) {
  store.save(map);
}

function getChannelWebhookFor(username) {
  if (!username) return null;
  return loadChannelRouting()[username] || null;
}

module.exports = { loadChannelRouting, saveChannelRouting, getChannelWebhookFor };
