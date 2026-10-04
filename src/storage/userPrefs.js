const path = require("path");
const { CACHE_DIR } = require("../config");
const { createJsonStore } = require("./jsonStore");

// Preferensi & profil PER PENGGUNA Discord (bukan per member JKT48), satu file:
//   { [userId]: {
//       oshis: [username IDN, ...],        // member favorit (maks MAX_OSHIS) - profil + ringkasan mingguan
//       delivery: "tag" | "dm",            // cara dikabari pas member yang di-"ingetin" mulai live
//       quietStart / quietEnd: 0-23 | null // jam tenang (WIB): tidak di-tag/DM di rentang ini (akhir eksklusif)
//       digestOff: true | undefined        // true = tidak mau ringkasan mingguan oshi
//       digestWeek: "YYYY-MM-DD" | null    // minggu (tanggal Minggu WIB) ringkasan terakhir yang sudah dikirim
//       lastSeenAt: epoch ms | null        // terakhir kali bot ngebales dia (dasar "cok kelewat")
//   } }
const USER_PREFS_FILE = path.join(CACHE_DIR, "user-prefs.json");
const store = createJsonStore(USER_PREFS_FILE, {}, { errorLabel: "preferensi pengguna" });

const MAX_OSHIS = 5;
// lastSeenAt cuma ditulis ulang kalau sudah lewat segini - biar tiap ketikan user
// tidak jadi tulis ke disk.
const LAST_SEEN_WRITE_INTERVAL_MS = 10 * 60 * 1000;

function loadAll() {
  const raw = store.load();
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
}

const isHour = (n) => Number.isInteger(n) && n >= 0 && n <= 23;

// Bentuk yang SELALU lengkap & tervalidasi (file bisa diedit tangan/rusak).
function normalize(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const quiet = isHour(r.quietStart) && isHour(r.quietEnd) && r.quietStart !== r.quietEnd;
  return {
    oshis: Array.isArray(r.oshis) ? [...new Set(r.oshis.filter((u) => typeof u === "string" && u))].slice(0, MAX_OSHIS) : [],
    delivery: r.delivery === "dm" ? "dm" : "tag",
    quietStart: quiet ? r.quietStart : null,
    quietEnd: quiet ? r.quietEnd : null,
    digestOff: r.digestOff === true,
    digestWeek: typeof r.digestWeek === "string" ? r.digestWeek : null,
    lastSeenAt: Number.isFinite(r.lastSeenAt) ? r.lastSeenAt : null,
  };
}

function getUserPrefs(userId) {
  if (typeof userId !== "string" || !userId) return normalize(null);
  const all = loadAll();
  return normalize(Object.prototype.hasOwnProperty.call(all, userId) ? all[userId] : null);
}

// Ubah prefs satu user lewat fungsi `mutate(prefs)` (dapat salinan ter-normalisasi,
// boleh dimutasi langsung). Balikin prefs hasil akhir.
function updateUserPrefs(userId, mutate) {
  if (typeof userId !== "string" || !userId || userId === "__proto__") return normalize(null);
  const all = loadAll();
  const prefs = getUserPrefs(userId);
  mutate(prefs);
  const next = normalize(prefs);
  all[userId] = next;
  store.save(all);
  return next;
}

// Cuma buat user yang sudah PUNYA entri atau yang memang butuh dilacak - tapi
// "kelewat" butuh lastSeen buat SEMUA pengguna, jadi entri dibuat kalau belum ada.
function touchLastSeen(userId, now = Date.now()) {
  if (typeof userId !== "string" || !userId) return;
  const current = getUserPrefs(userId).lastSeenAt;
  if (current && now - current < LAST_SEEN_WRITE_INTERVAL_MS) return;
  updateUserPrefs(userId, (p) => {
    p.lastSeenAt = now;
  });
}

// Jam `hour` (WIB) kena jam tenang? Rentang boleh nyebrang tengah malam (mis. 23-6).
function isQuietHour(prefs, hour) {
  if (prefs.quietStart === null || prefs.quietEnd === null) return false;
  const { quietStart: s, quietEnd: e } = prefs;
  return s < e ? hour >= s && hour < e : hour >= s || hour < e;
}

// Semua userId yang punya minimal satu oshi - dasar ringkasan mingguan.
function listUsersWithOshis() {
  const all = loadAll();
  return Object.keys(all).filter((id) => getUserPrefs(id).oshis.length > 0);
}

module.exports = { USER_PREFS_FILE, MAX_OSHIS, loadAll, getUserPrefs, updateUserPrefs, touchLastSeen, isQuietHour, listUsersWithOshis };
