const path = require("path");
const { CACHE_DIR } = require("../config");
const { createJsonStore } = require("./jsonStore");

// Saran fitur ke-7 (§10's kelimapuluh+item, paling susah dari batch ini):
// dashboard "lagi live sekarang" yang NEMPEL satu pesan aja (di-EDIT terus
// di tempat, bukan bikin pesan baru tiap ada perubahan) - lihat
// notify/dashboard.js buat logic-nya. Modul ini cuma nyimpen DUA hal:
// - messageId: ID pesan Discord yang lagi "dipegang" sebagai dashboard.
//   null kalau belum pernah dibikin SAMA SEKALI, atau abis pesannya ilang
//   (dihapus manual/dsb, lihat notify/dashboard.js's "gone" case) - null
//   jadi sinyal "kali berikutnya, BIKIN BARU, jangan nyoba edit".
// - lastUsernamesKey: snapshot SIAPA AJA yang lagi live pas terakhir kali
//   dashboard-nya di-render (daftar username, diurutin+digabung jadi satu
//   string) - dibandingin tiap siklus polling buat mutusin PERLU di-update
//   apa enggak. SENGAJA bukan snapshot teks lengkapnya (yang ada "X menit
//   lalu"/viewer count di dalemnya, yang berubah TERUS-MENERUS walau gak
//   ada satupun yang mulai/selesai live) - kalau iya, dashboard bakal
//   ke-edit ulang TIAP siklus polling (~20 detik) selama ada yang masih
//   live, nyaris terus-terusan, padahal SATU-SATUNYA yang owner minta
//   ("update pas ada PERUBAHAN") adalah pas roster-nya beneran berubah
//   (ada yang mulai/selesai). Konsekuensinya: jam "X menit lalu" di dalem
//   dashboard nunjukkin kondisi pas TERAKHIR di-update, bukan jam tik-tik
//   real-time - trade-off yang disengaja, bukan bug.
const DASHBOARD_FILE = path.join(CACHE_DIR, "dashboard.json");
const store = createJsonStore(DASHBOARD_FILE, { messageId: null, lastUsernamesKey: "" }, { errorLabel: "dashboard live" });

function loadDashboardState() {
  const raw = store.load();
  return { messageId: raw.messageId || null, lastUsernamesKey: raw.lastUsernamesKey || "" };
}

function saveDashboardState(state) {
  store.save({ messageId: state.messageId || null, lastUsernamesKey: state.lastUsernamesKey || "" });
}

module.exports = { loadDashboardState, saveDashboardState };
