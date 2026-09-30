const path = require("path");
const { CACHE_DIR } = require("../config");
const { createJsonStore } = require("./jsonStore");

// Role Discord per member buat notif live (chat/roleFlow.js): username IDN
// ("jkt48_aralie") -> ID role di server. Role member ini didaftarin OWNER
// ("cok tambah role aralie @Aralie") - itu role yang sama yang ngatur akses ke
// channel privat member tsb, jadi milih member = dapet akses + di-ping. Kunci
// khusus ALL_MEMBERS_KEY nyimpen role "notif semua member". liveNotify.js
// ngebaca ini buat nge-ping role pas member mulai live.
const MEMBER_ROLES_FILE = path.join(CACHE_DIR, "member-roles.json");
const store = createJsonStore(MEMBER_ROLES_FILE, {}, { errorLabel: "daftar role member" });

function loadMemberRoles() {
  return store.load();
}

// Kunci di-lowercase (sama kayak storage/channelRouting.js) - gak percaya
// kapitalisasi username dari IDN selalu konsisten.
function getRoleIdFor(username) {
  return loadMemberRoles()[String(username).toLowerCase()] || null;
}

function setRoleIdFor(username, roleId) {
  store.save({ ...loadMemberRoles(), [String(username).toLowerCase()]: roleId });
}

function clearRoleFor(username) {
  const next = { ...loadMemberRoles() };
  const key = String(username).toLowerCase();
  if (!(key in next)) return false;
  delete next[key];
  store.save(next);
  return true;
}

// Kunci khusus buat role "notif SEMUA member" (bukan username member manapun).
const ALL_MEMBERS_KEY = "__all__";

module.exports = { loadMemberRoles, getRoleIdFor, setRoleIdFor, clearRoleFor, ALL_MEMBERS_KEY };
