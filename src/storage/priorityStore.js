const path = require("path");
const { CACHE_DIR } = require("../config");
const { createJsonStore } = require("./jsonStore");

// Persistensi MENTAH doang buat member prioritas custom (ditambah/dihapus
// lewat chat "cok tambah/hapus prioritas <nama>") - validasi & logika
// gabungan sama 3 member bawaan (Nala/Levi/Lily) ada di priority/index.js,
// bukan di sini.
const CUSTOM_PRIORITY_FILE = path.join(CACHE_DIR, "custom-priority.json");
const store = createJsonStore(CUSTOM_PRIORITY_FILE, [], { errorLabel: "daftar prioritas custom" });

function loadCustomPriorityMembers() {
  return store.load();
}

function saveCustomPriorityMembers(list) {
  store.save(list);
}

module.exports = { loadCustomPriorityMembers, saveCustomPriorityMembers };
