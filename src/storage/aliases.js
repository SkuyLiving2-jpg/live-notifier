const path = require("path");
const { CACHE_DIR } = require("../config");
const { createJsonStore } = require("./jsonStore");

// Saran fitur ke-5 (§10's kelimapuluh item, alias/nickname buat pencarian)
// - fans sering manggil member pakai panggilan sehari-hari yang beda dari
// nama depan akun IDN-nya (yang dipakai `matchesNameFragment` di semua
// modul storage/ buat nyocokin fragment ketikan user), jadi ketikan yang
// sebenarnya bener (cuma beda panggilan) bisa keliatan "gak ketemu" padahal
// membernya jelas ada. Bukan hardcode ditebak sendiri di kode (nama panggung
// fans itu FAKTA soal orang beneran, salah tebak lebih buruk daripada gak
// ada) - kosong by default, diisi OWNER lewat chat ("cok tambah alias <alias>
// = <nama asli>", lihat chat/replies.js's handleAddAlias), sama pola
// owner-managed-nya kayak storage/priorityStore.js.
//
// Keyed persis { "<alias lowercase>": "<nama asli/fragment lowercase>" } -
// resolveAliasInFragment DI BAWAH nge-substitusi tiap KATA di fragment yang
// dicari (bukan exact-match seluruh fragment), soalnya fragment yang masuk
// ke find*ByNameFragment sering ngandung kata tambahan ("kimkim jkt48",
// bukan cuma "kimkim").
//
// PENGECUALIAN SENGAJA dari kebiasaan storage/ modules gak saling require
// (lihat komentar getLongestNotLiveLeaderboard di liveCount.js) - modul ini
// sendiri MURNI leaf (gak require modul storage/ lain), persis kelasnya
// jsonStore.js yang emang DIRANCANG buat di-require modul storage/ lain.
// Alias itu concern lintas-lookup (harus konsisten dipakai di SEMUA
// find*ByNameFragment: live-count, activeLives, duration history, gifter
// snapshot), jadi kalau resolusinya cuma ditaro di layer chat/ (kayak
// getSessionsForRange yang gabungin beberapa sumber), gampang kelewatan
// nempelin di satu tempat dan bikin bug "sebagian command ngerti alias,
// sebagian nggak" - lebih aman dijamin SATU tempat yang dipanggil semua
// find*ByNameFragment daripada diulang manual di tiap pemanggilnya.
const ALIASES_FILE = path.join(CACHE_DIR, "aliases.json");
const store = createJsonStore(ALIASES_FILE, {}, { errorLabel: "alias/panggilan member" });

function loadAliases() {
  return store.load();
}

function saveAliases(map) {
  store.save(map);
}

// Alias/target dinormalisasi SEKALI di sini (lowercase+trim) - satu-satunya
// tempat yang nulis ke file ini (handleAddAlias/handleRemoveAlias di
// chat/replies.js), jadi gak perlu diulang normalisasi di pemanggil.
// Lookup alias HARUS pakai hasOwnProperty - kata biasa kayak "constructor" atau
// "toString" di kalimat user dulu ngambil fungsi bawaan Object ("in"/[] ikut
// nelusur prototype) dan ketulis "function Object() { [native code] }" ke nama
// yang dicari.
function hasAlias(map, key) {
  return Object.prototype.hasOwnProperty.call(map, key) && typeof map[key] === "string";
}

function normalizeAliasKey(text) {
  return (text || "").trim().toLowerCase();
}

// resolveAliasInFragment di bawah nyocokin PER KATA (fragment dipecah di
// karakter non-alfanumerik), jadi alias yang ngandung spasi/tanda baca
// ("kim kim", "kim-kim") gak akan PERNAH kecocokan - dulu tetep disimpen dan
// dilaporin "✅ ditambahin" padahal gak pernah jalan. Batas panjang juga
// jaga-jaga customId/label dropdown Discord (maks 100 karakter) di
// chat/aliasFlow.js's tombol hapus alias.
const ALIAS_MAX_LENGTH = 32;

function validateAliasKey(alias) {
  const key = normalizeAliasKey(alias);
  if (!key) return "empty";
  if (key.length < 2) return "too_short";
  if (key.length > ALIAS_MAX_LENGTH) return "too_long";
  if (!/^[a-z0-9]+$/.test(key)) return "invalid_format";
  return null;
}

function addAlias(alias, target) {
  const key = normalizeAliasKey(alias);
  const value = normalizeAliasKey(target);
  if (!key || !value) return { ok: false, reason: "empty" };
  const invalidReason = validateAliasKey(key);
  if (invalidReason) return { ok: false, reason: invalidReason };

  const map = loadAliases();
  const previous = hasAlias(map, key) ? map[key] : null;
  map[key] = value;
  saveAliases(map);
  return { ok: true, previous };
}

function removeAlias(alias) {
  const key = normalizeAliasKey(alias);
  const map = loadAliases();
  if (!hasAlias(map, key)) return { ok: false };
  delete map[key];
  saveAliases(map);
  return { ok: true };
}

// Dipanggil dari SETIAP find*ByNameFragment/search*ByNameFragment di
// storage/ (liveCount.js, activeLives.js, durationHistory.js,
// gifterSnapshot.js) SEBAGAI GANTI baris normalisasi `(fragment ||
// "").trim().toLowerCase()` yang sebelumnya ada di masing-masing fungsi
// itu - balikin fragment yang UDAH dinormalisasi (lowercase+trim) DAN
// tiap katanya yang kebetulan cocok sebuah alias disubstitusi ke nama
// aslinya, sebelum diteruskan ke matchesNameFragment seperti biasa. Fast
// path (belum ada alias yang keisi sama sekali, kondisi DEFAULT sebelum
// owner nambahin apa-apa) skip split/map-nya sama sekali.
function resolveAliasInFragment(fragment) {
  const raw = (fragment || "").trim().toLowerCase();
  if (!raw) return raw;

  const map = loadAliases();
  if (Object.keys(map).length === 0) return raw;

  return raw
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map((word) => (hasAlias(map, word) ? map[word] : word))
    .join(" ");
}

module.exports = { loadAliases, saveAliases, addAlias, removeAlias, resolveAliasInFragment, validateAliasKey, ALIAS_MAX_LENGTH };
