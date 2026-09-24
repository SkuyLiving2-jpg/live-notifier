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
//
// VALUE bisa 2 bentuk (fitur "Q3": fallback reply simpel di channel khusus
// member itu sendiri - lihat chat/memberChannelReply.js):
// - String polos (BENTUK LAMA): cuma webhook URL, channel-nya CUMA nerima
//   notif live (duplikasi dari channel gabungan), gak ada fallback chat -
//   bot gak tau channel Discord-nya yang mana, cuma punya URL buat POST.
// - Object { webhookUrl, channelId }: sama kayak di atas TAPI channelId-nya
//   (ID channel Discord-nya, dari klik kanan channel > Copy Channel ID)
//   dicatet juga, jadi getUsernameForChannel() bisa nyambungin balik pesan
//   yang MASUK dari channel itu ke member yang punya channel itu.
//   channelId sengaja TERPISAH dari webhook URL (bukan di-parse dari
//   ID webhook-nya) - ID webhook != ID channel, dan resolve via API Discord
//   butuh extra network call tiap kali; nyuruh owner tinggal COPY channel ID
//   (workflow yang UDAH biasa dia pake buat BOT_CHANNEL_ID/PRIORITY_PING_USER_ID
//   di .env) jauh lebih simpel dan gak nambah dependency runtime.
//   Backward compatible - entry lama (string polos) TETEP jalan buat notif,
//   cuma gak dapet fallback chat sampai owner nambahin channelId-nya.
const CHANNEL_ROUTING_FILE = path.join(CACHE_DIR, "channel-routing.json");
const store = createJsonStore(CHANNEL_ROUTING_FILE, {}, { errorLabel: "pemetaan channel per-member" });

function loadChannelRouting() {
  return store.load();
}

// Full REPLACE, bukan merge - file lokal yang di-push (scripts/set-channel-routing.js)
// selalu dianggap sumber kebenaran yang lengkap, bukan tambahan parsial.
//
// Key-nya di-lowercase-in DI SINI (bukan ngandelin file lokal yang di-isi
// manual sama owner selalu lowercase) - idnApi.js's isJkt48Member juga
// nge-lowercase creator.username sebelum dibandingin, jadi udah ada preseden
// kalau casing dari IDN nggak bisa dipercaya konsisten. Tanpa normalisasi
// ini, entry kayak "jkt48_Aralie" (huruf besar) bakal DIEM-DIEM gak pernah
// nyantol ke getChannelWebhookFor (yang dipanggil pake username asli dari
// IDN, hampir pasti lowercase) - bukan error, notifnya cuma gak pernah
// kekirim ke channel khusus tanpa penjelasan kenapa.
function saveChannelRouting(map) {
  const normalized = Object.fromEntries(Object.entries(map).map(([username, url]) => [username.toLowerCase(), url]));
  store.save(normalized);
}

function getChannelWebhookFor(username) {
  if (!username) return null;
  const entry = loadChannelRouting()[username.toLowerCase()];
  if (!entry) return null;
  return typeof entry === "string" ? entry : entry.webhookUrl;
}

// Kebalikan dari getChannelWebhookFor - dari ID channel Discord (yang datang
// dari pesan MASUK, lihat chat/router.js's wireDiscordEvents), cari username
// member yang channel khusus-nya itu. CUMA nyantol ke entry bentuk object
// yang punya channelId (lihat komen di atas) - entry bentuk string lama
// gak pernah match di sini, soalnya bot emang gak tau channel Discord-nya
// yang mana. Linear scan (bukan Map kebalikan yang di-cache) - di skala
// ~40+ member ini murah banget, dan lebih simpel daripada jaga cache lain
// yang harus disinkronin tiap kali file routing-nya di-push ulang.
function getUsernameForChannel(channelId) {
  if (!channelId) return null;
  for (const [username, entry] of Object.entries(loadChannelRouting())) {
    if (typeof entry === "object" && entry !== null && entry.channelId === channelId) return username;
  }
  return null;
}

module.exports = { loadChannelRouting, saveChannelRouting, getChannelWebhookFor, getUsernameForChannel };
