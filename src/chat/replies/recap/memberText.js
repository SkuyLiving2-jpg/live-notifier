// Membaca nama member dan periode dari teks "rekap <nama> <rentang>" / "export rekap <nama>".

const { containsWholeWord } = require("../../../utils");

const { isKnownMemberFragment } = require("../memberLookup");
const { MONTH_NAMES_ID, WEEKDAY_NAMES_ID, parseWeekdayFromText, resolveStatRangeFromText } = require("./dateParsing");

// Kata-kata pelengkap yang wajar nempel di "rekap <nama>" tapi BUKAN bagian
// dari nama ("rekap aralie dong", "rekap member aralie", "rekap aralie live").
const RECAP_MEMBER_FILLER_WORDS = new Set([
  "member",
  "live",
  "nya",
  "dong",
  "donk",
  "deh",
  "aja",
  "saja",
  "si",
  "kak",
  "ka",
  "kk",
  "tolong",
  "tlg",
  "ya",
  "yah",
  "dari",
  "punya",
  "milik",
  "jkt48",
  "cok",
  "lah",
  "sih",
  "pls",
  "plis",
  "please",
  "bang",
  "bro",
]);

// Ngambil nama member dari teks "rekap ..." yang UDAH gak nyebut hari/minggu/
// bulan/tanggal/nama bulan/nama hari (semuanya ditangkep duluan di router.js).
// Sengaja ketat: harus tepat SATU kata nama (abis kata pelengkap dibuang) -
// kalimat panjang/gak jelas ("cok rekap dong banget kemarin") tetep jatuh ke
// menu biasa, bukan disangka nama member. null = bukan permintaan rekap member.
function extractRecapMemberFragment(text) {
  const match = (text || "").toLowerCase().match(/\brekap\s+(.+)/);
  if (!match) return null;
  const tokens = match[1]
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .filter((t) => !RECAP_MEMBER_FILLER_WORDS.has(t));
  if (tokens.length !== 1 || tokens[0].length < 2) return null;
  return tokens[0];
}

// Kata rentang/perintah yang bukan nama member, dipake extractMemberFromPeriodText.
const PERIOD_TEXT_WORDS = new Set([
  "rekap",
  "export",
  "csv",
  "file",
  "hari",
  "ini",
  "minggu",
  "pekan",
  "bulan",
  "tanggal",
  "tgl",
  "per",
  "pada",
  "kemarin",
  "kemaren",
  "lalu",
  "semua",
  "semuanya",
  "all",
  "data",
  "lengkap",
  ...MONTH_NAMES_ID,
  ...WEEKDAY_NAMES_ID.map((d) => d.toLowerCase()),
]);

// Kata sisa dari teks "rekap ..."/"export rekap ..." setelah dibuang kata
// rentang/perintah, angka, dan kata pelengkap - kandidat nama member.
function periodTextLeftoverTokens(text) {
  return (text || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .filter((t) => !PERIOD_TEXT_WORDS.has(t) && !RECAP_MEMBER_FILLER_WORDS.has(t) && !/^\d+$/.test(t))
    .filter((t) => t.length >= 2);
}

// Buat "rekap nala minggu ini"/"export rekap nala": ambil nama member dari teks
// yang JUGA nyebut rentang. Satu kata sisa = nama member (sama ketatnya kayak
// extractRecapMemberFragment). Kalau sisanya beberapa kata, cuma dipake kalau
// TEPAT SATU yang dikenali sebagai member ("rekap tolong nala minggu ini") -
// selain itu null (bukan permintaan per-member).
function extractMemberFromPeriodText(text) {
  const tokens = periodTextLeftoverTokens(text);
  if (tokens.length === 1) return tokens[0];
  const known = tokens.filter((t) => isKnownMemberFragment(t));
  return known.length === 1 ? known[0] : null;
}

// "rekap nala lily minggu ini" - dua member sekaligus di rekap/export per
// member gak didukung. Dulu nama-namanya diam-diam diabaikan dan yang keluar
// rekap SEMUA member. Balikin daftar nama (>= 2 yang dikenali) atau null.
function findMultipleKnownMembers(text) {
  const known = periodTextLeftoverTokens(text).filter((t) => isKnownMemberFragment(t));
  return known.length >= 2 ? known : null;
}

function replyOneMemberOnly(names) {
  return `Cok, rekap/export per member cuma bisa SATU nama sekali jalan (kamu nyebut ${names.map((n) => `"${n}"`).join(", ")}). Coba satu-satu, mis. "rekap ${names[0]} minggu ini".`;
}

// "rekap nala senin" - nama hari butuh dropdown buat milih tanggal pastinya, dan
// dropdown itu belum bisa difilter per member. Ditolak jelas daripada nama
// member-nya diam-diam dibuang.
function replyMemberWeekdayUnsupported(fragment) {
  return `Cok, rekap "${fragment}" per nama hari belum bisa. Coba pakai "minggu ini", "bulan ini", "kemarin", atau tanggal (mis. "rekap ${fragment} 25 september").`;
}

// Rentang yang disebut di "rekap <nama> <rentang>": resolveStatRangeFromText
// (minggu/bulan/nama bulan/tanggal/kemarin) plus "hari ini" (rangeDays null).
// null kalau gak nyebut rentang apapun, atau nyebut nama hari (butuh dropdown
// buat milih tanggalnya - ditangani jalur lama).
function resolveMemberPeriod(text) {
  if (parseWeekdayFromText(text) !== null) return null;
  const range = resolveStatRangeFromText(text);
  if (range) return range;
  if (containsWholeWord(text, "hari")) return { rangeDays: null, label: "hari ini" };
  return null;
}

module.exports = {
  extractRecapMemberFragment,
  extractMemberFromPeriodText,
  findMultipleKnownMembers,
  replyOneMemberOnly,
  replyMemberWeekdayUnsupported,
  resolveMemberPeriod,
};
