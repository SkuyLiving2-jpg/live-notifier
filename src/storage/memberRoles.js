const path = require("path");
const { CACHE_DIR } = require("../config");
const { createJsonStore } = require("./jsonStore");

// Role Discord per member buat notif live (chat/roleFlow.js): username IDN
// ("jkt48_nala") -> ID role di server. Role-nya dibikin bot SECARA LAZY (pas
// ada user yang milih member itu di panel role), jadi file ini cuma nyimpen
// yang udah pernah dibikin/diadopsi. liveNotify.js ngebaca ini buat nge-ping
// role-nya pas member mulai live.
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

module.exports = { loadMemberRoles, getRoleIdFor, setRoleIdFor };
