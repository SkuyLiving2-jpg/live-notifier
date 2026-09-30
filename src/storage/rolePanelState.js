const path = require("path");
const { CACHE_DIR } = require("../config");
const { createJsonStore } = require("./jsonStore");

// Panel role notif itu SATU pesan permanen di satu channel (chat/roleFlow.js's
// syncRolePanel) - ID pesan + channel-nya disimpen di sini biar tiap sinkronisasi
// (bot boot, role baru didaftarin, perintah "pasang panel role") ngedit pesan
// yang SAMA, bukan bikin pesan baru yang numpuk.
const ROLE_PANEL_FILE = path.join(CACHE_DIR, "role-panel.json");
const store = createJsonStore(ROLE_PANEL_FILE, {}, { errorLabel: "state panel role" });

function loadRolePanelState() {
  return store.load();
}

function saveRolePanelState(state) {
  store.save(state);
}

module.exports = { loadRolePanelState, saveRolePanelState };
