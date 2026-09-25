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
  return `${new Intl.DateTimeFormat("id-ID", { timeZone: "Asia/Jakarta", hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(date)} WIB`;
}

// Tanggal WIB ("YYYY-MM-DD") dari sebuah Date - default ke sekarang. Dipisah
// dari getTodayWIB() (yang sekarang cuma delegasi ke sini tanpa argumen)
// biar bisa dipake buat ngecek tanggal WIB dari waktu LAIN, bukan cuma
// sekarang - misalnya buat bandingin tanggal mulai sebuah sesi live ke
// tanggal "hari ini", pas sesi itu mulai H-1 tapi baru kecatet/selesai
// setelah lewat tengah malam WIB (lihat chat/replies.js's buildRecapTablePage).
function getDateWIB(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(date);
}

function getTodayWIB() {
  return getDateWIB();
}

// "DD/MM" dari sebuah Date (WIB) - versi singkat buat nempel di sebelah jam
// pas perlu nunjukkin sesi itu mulai di HARI LAIN, bukan cuma jamnya doang.
function formatShortDateWIB(date) {
  const [, month, day] = getDateWIB(date).split("-");
  return `${day}/${month}`;
}

// "13 September 2026" dari sebuah Date (WIB) - versi PANJANG/gampang dibaca,
// beda dari formatShortDateWIB ("13/09") yang emang didesain buat nempel
// ringkes di sebelah jam. Dipake buat label opsi dropdown "rekap per
// tanggal" (chat/replies.js) dan buat nyebut tanggal yang dipilih di teks
// balesannya - orang milih dari dropdown ngeliat "13 September 2026", jadi
// balesannya juga harus nyebut tanggal yang sama persis biar nggak keliatan
// kayak nunjuk tanggal yang beda.
function formatLongDateWIB(date) {
  return new Intl.DateTimeFormat("id-ID", { timeZone: "Asia/Jakarta", day: "numeric", month: "long", year: "numeric" }).format(date);
}

// "September 2026" dari sebuah string bulan "YYYY-MM" - dipake buat rekap
// PER BULAN (chat/replies.js's replyRecapMonth dkk), sama tujuannya kayak
// formatLongDateWIB tapi granularitasnya BULAN, bukan tanggal spesifik.
// Dianchor ke tanggal 1 bulan itu lewat Date.UTC (bukan WIB) - kita cuma
// butuh bulan+tahunnya doang buat label ini, jadi zona waktu gak ngaruh sama
// sekali (beda dari formatLongDateWIB yang emang butuh WIB buat nentuin
// TANGGAL yang bener kalau instant-nya deket tengah malam).
function formatMonthLabel(monthWIB) {
  const [year, month] = monthWIB.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, 1));
  return new Intl.DateTimeFormat("id-ID", { timeZone: "UTC", month: "long", year: "numeric" }).format(date);
}

// Jam WIB (0-23) dari sebuah Date - default ke sekarang kalau dipanggil
// tanpa argumen. Satu-satunya tempat yang ngitung ini (dulu ada 3 versi
// nyaris identik yang ditulis manual: getHourWIB() tanpa argumen buat rekap
// harian, getHourWIBOf(date) buat pola jadwal, dan versi inline lagi di
// dalam getGreeting() - digabung di sini).
function getHourWIBOf(date = new Date()) {
  // "% 24" BUKAN basa-basi - Intl dengan hour12:false punya kuirk ICU yang
  // ngebalikin "24" (bukan "0") buat SELURUH jam 00:00-00:59 WIB (kecatet
  // pas nulis automated test buat fungsi ini, ketauan tengah malam yang
  // dites nyata-nyata balikin 24). Tanpa modulo ini, "getHourWIBOf() < 23"
  // di publicAlerts.js's maybeSendDailyRecap() jadi SALAH nganggep tengah
  // malam itu "udah lewat jam rekap" - bikin recapSentDate ke-set duluan
  // sebelum sesi hari itu sempet ada, jadi rekap otomatis jam 23:00 yang
  // BENERAN nggak pernah kekirim buat hari itu (skip diem-diem, gak ada
  // error). 24 % 24 = 0, dan buat jam 0-23 lainnya modulo ini gak ngubah
  // apa-apa (n % 24 === n).
  return Number(new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Jakarta", hour: "numeric", hour12: false }).format(date)) % 24;
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
  return (raw || "")
    .trim()
    .replace(/\s+live\??$/i, "")
    .trim();
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

// Khusus buat navigasi MAJU/MUNDUR di halaman rekap (chat/replies.js's
// tryHandleRecapPageShortcut) - dipisah dari YES_PATTERN/NO_PATTERN (yang
// tetep dipake apa adanya di flow konfirmasi LAIN, mis. watch-confirm di
// chat/menu.js) biar gak nabrak arti "y"/"n" di situ ("mau nonton?"/"gak
// jadi nonton", BUKAN "maju/mundur halaman"). NEXT_PAGE_PATTERN ini
// TAMBAHAN buat "y" (bukan gantiin) - "y" tetep jalan biar gak ngerusak
// kebiasaan yang udah ada, cuma sekarang "maju"/"forward"/dst juga diterima.
const NEXT_PAGE_PATTERN = /^(maju|forward|lanjut|lanjutkan|next|berikutnya)$/i;
const PREV_PAGE_PATTERN = /^(mundur|balik|kembali|sebelumnya|prev|previous|back)$/i;

// Dipake di TIAP message.reply()/interaction.reply() di chat/router.js dan
// chat/menu.js - nyegah pesan bot ke-abuse buat mention massal. Banyak
// balesan bot nge-echo teks ketikan user MENTAH ke dalam content (nama
// member yang gak ketemu, keyword subscribe/prioritas, dst - lihat
// chat/replies.js's replyMemberNotFound/replyMemberStats/replyLiveCount/
// replyGifterSnapshot/replySchedulePattern/replyMySubscriptions dst), dan
// SIAPA AJA di channel (bukan cuma owner - mis. "cok ingetin <apa aja>" gak
// di-gate) bisa ngetik apapun sebagai argumennya. Tanpa allowedMentions,
// discord.js by default TETEP parse & trigger @everyone/@here/mention role
// di teks manapun yang kebetulan nyangkut di content - jadi orang bisa
// nyuruh bot mention @everyone cuma dengan ngetik "cok ingetin @everyone"
// (balesannya ngutip ulang argumennya mentah-mentah). `parse: []` matiin
// SEMUA jenis mention implisit (everyone/here/role/user) dari teks - satu-
// satunya mention yang beneran dimaksud dikirim explicit lewat field
// `users`/`roles` di allowedMentions itu sendiri kalau memang perlu (gak
// ada kasus itu di jalur chat-reply ini sekarang).
function safeReplyOptions(reply) {
  const base = typeof reply === "string" ? { content: reply } : reply;
  return { ...base, allowedMentions: { parse: [] } };
}

module.exports = {
  formatDuration,
  formatRelativeTime,
  formatViewCount,
  formatClockWIB,
  getTodayWIB,
  getDateWIB,
  formatShortDateWIB,
  formatLongDateWIB,
  formatMonthLabel,
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
  NEXT_PAGE_PATTERN,
  PREV_PAGE_PATTERN,
  safeReplyOptions,
};
