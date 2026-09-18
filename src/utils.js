// Kumpulan helper murni (formatting, text-matching, waktu WIB) yang dipakai
// lintas-modul (storage, notify, chat) - sengaja gak nyimpen state atau
// nyentuh file/network, biar gampang di-require di mana aja tanpa efek samping.

function formatDuration(ms) {
  const totalMinutes = Math.max(0, Math.floor(ms / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}j ${minutes}m` : `${minutes}m`;
}

function formatRelativeTime(date) {
  const diffMin = Math.max(0, Math.floor((Date.now() - date.getTime()) / 60000));
  if (diffMin < 60) return `${diffMin} menit lalu`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour} jam lalu`;
  const diffDay = Math.floor(diffHour / 24);
  return `${diffDay} hari lalu`;
}

function formatViewCount(n) {
  return Number(n).toLocaleString("id-ID");
}

function formatClockWIB(date) {
  return `${new Intl.DateTimeFormat("id-ID", { timeZone: "Asia/Jakarta", hour: "2-digit", minute: "2-digit" }).format(date)} WIB`;
}

function getTodayWIB() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(new Date());
}

// Jam WIB (0-23) dari sebuah Date - default ke sekarang kalau dipanggil
// tanpa argumen. Satu-satunya tempat yang ngitung ini (dulu ada 3 versi
// nyaris identik yang ditulis manual: getHourWIB() tanpa argumen buat rekap
// harian, getHourWIBOf(date) buat pola jadwal, dan versi inline lagi di
// dalam getGreeting() - digabung di sini).
function getHourWIBOf(date = new Date()) {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Jakarta", hour: "numeric", hour12: false }).format(date));
}

// Bucket waktu WIB (4-11 pagi, 11-15 siang, 15-18 sore, sisanya malam) -
// dipake buat sapaan (getGreeting) DAN buat ngelompokin histori jam mulai
// live per member (replySchedulePattern).
function getTimeOfDayBucket(hourWIB) {
  if (hourWIB >= 4 && hourWIB < 11) return "pagi";
  if (hourWIB >= 11 && hourWIB < 15) return "siang";
  if (hourWIB >= 15 && hourWIB < 18) return "sore";
  return "malam";
}

function getGreeting() {
  return getTimeOfDayBucket(getHourWIBOf());
}

const WEEKDAY_FORMATTER_WIB = new Intl.DateTimeFormat("id-ID", { weekday: "long", timeZone: "Asia/Jakarta" });

// Di bawah 30 menit dianggap "baru live", 30 menit ke atas "udah live".
const NEW_LIVE_THRESHOLD_MS = 30 * 60000;

function describeElapsed(ms) {
  const prefix = ms < NEW_LIVE_THRESHOLD_MS ? "baru live" : "udah live";
  return `${prefix} ${formatDuration(ms)}`;
}

// Cocokin fragment ke nama depan per KATA, bukan substring bebas - soalnya
// substring bebas ("nama.includes(needle)") bikin huruf tunggal kayak "a"
// ke-anggep cocok ke nama siapa aja yang kebetulan ada huruf "a"-nya (mis.
// "Fahira"). Kata di needle harus PERSIS sama sama nama depannya, ATAU
// minimal 3 huruf dan jadi prefix/typo-toleran dari nama depannya.
function matchesNameFragment(needle, givenName) {
  if (!needle || !givenName) return false;
  const words = needle.split(/[^a-z0-9]+/).filter(Boolean);
  return words.some((word) => {
    if (word === givenName) return true;
    if (word.length >= 3 && givenName.startsWith(word)) return true;
    if (givenName.length >= 3 && word.startsWith(givenName)) return true;
    return false;
  });
}

// Cek apakah `phrase` (bisa 1 kata atau beberapa kata, misal keyword custom
// prioritas/subscription) muncul di `text` sebagai KATA/FRASE UTUH, bukan
// nyempil di tengah kata lain. Sebelumnya beberapa tempat (getPriorityConfig,
// getSubscribersFor, deteksi wake word "cok"/"live") pakai text.includes()
// biasa - itu bug yang sama kelasnya kayak yang udah dibenerin di
// matchesNameFragment: keyword "cok" ke-anggep nyantol ke "cokelat", keyword
// "live" ke-anggep nyantol ke "delivery", keyword prioritas "lily" ke-anggep
// nyantol ke member lain yang kebetulan namanya mengandung "lily" di tengah.
function containsWholeWord(text, phrase) {
  if (!text || !phrase) return false;
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, "i").test(` ${text} `);
}

// Dipake buat bersihin ekor kayak "nala live" / "nala live?" jadi cuma
// "nala" - orang sering nulis kalimat lengkap ("tambah prioritas nala live")
// padahal yang dibutuhin cuma nama/keyword-nya doang.
function stripTrailingLiveWord(raw) {
  return (raw || "").trim().replace(/\s+live\??$/i, "").trim();
}

// Pilih 1 elemen acak dari sebuah array - dipake buat ngeracik pesan akhir
// live Nala (lihat priority/index.js's generateEndMessage).
function pickRandom(list) {
  return list[Math.floor(Math.random() * list.length)];
}

// Jawaban "y"/"n" polos (buat konfirmasi nonton, lanjut halaman rekap, dst) -
// satu tempat biar konsisten di semua flow yang butuh y/n.
const YES_PATTERN = /^(y|ya|iya|iyah|iy|yes|yup|yoi|oke|ok|gas|mau|boleh)$/i;
const NO_PATTERN = /^(n|no|ga|gak|kaga|nggak|enggak|tidak|males|ga\s*mau|nggak\s*mau)$/i;

module.exports = {
  formatDuration,
  formatRelativeTime,
  formatViewCount,
  formatClockWIB,
  getTodayWIB,
  getHourWIBOf,
  getTimeOfDayBucket,
  getGreeting,
  WEEKDAY_FORMATTER_WIB,
  NEW_LIVE_THRESHOLD_MS,
  describeElapsed,
  matchesNameFragment,
  containsWholeWord,
  stripTrailingLiveWord,
  pickRandom,
  YES_PATTERN,
  NO_PATTERN,
};
