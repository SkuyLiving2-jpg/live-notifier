// Membaca tanggal / bulan / hari / periode relatif dari teks chat bebas.

const { shiftDateWIB } = require("../../../streakMath");
const { getTodayWIB, formatLongDateWIB, formatMonthLabel, containsWholeWord } = require("../../../utils");

// ==== Parsing tanggal/bulan/hari spesifik dari teks chat (dipake router.js
// buat "cok rekap 25 september", "cok rekap september", "cok rekap senin",
// dst - §10's thirty-sixth item) ====
//
// Semua parser di bawah ini murni TEKS -> data terstruktur, gak pernah
// nyentuh storage sama sekali - biar gampang dites sendiri-sendiri, sama
// filosofinya kayak encodeRecapRange/decodeRecapRange di bawah.
const MONTH_NAMES_ID = ["januari", "februari", "maret", "april", "mei", "juni", "juli", "agustus", "september", "oktober", "november", "desember"];

const MONTH_NAME_ALTERNATION = MONTH_NAMES_ID.join("|");

function daysInMonth(year, monthIndex0) {
  // Date(year, month+1, 0) manfaatin overflow BAWAAN konstruktor Date buat
  // "mundur 1 hari dari tanggal 1 bulan BERIKUTNYA" - otomatis bener buat
  // tahun kabisat, gak perlu tabel manual.
  return new Date(year, monthIndex0 + 1, 0).getDate();
}

// "25 september"/"september 25" (urutan bebas), tahun opsional di belakang
// (default TAHUN SEKARANG kalau gak disebut). Balikin null kalau gak ada
// pasangan angka-hari + nama-bulan di teksnya SAMA SEKALI, ATAU kalau angka
// harinya di luar jumlah hari bulan itu (mis. "31 februari") - dua kasus itu
// BUKAN tanggal spesifik yang valid, biar pemanggilnya (router.js) lanjut
// coba pola lain daripada maksa lanjut ke tanggal yang gak mungkin valid
// (`new Date("...-02-31...")` bakal jadi Invalid Date, dan
// Intl.DateTimeFormat.format() THROW kalau dikasih itu - sama kelas bug yang
// udah dibenerin di replySpecificMember).
function parseSpecificDateFromText(text) {
  // Bentuk ISO ("2026-09-25") - dulu gak dikenali sama sekali, "rekap
  // 2026-09-25" jatuh ke menu rekap seolah gak ngerti maksudnya.
  const isoMatch = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (isoMatch) {
    const [, y, m, d] = isoMatch.map(Number);
    if (m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m - 1)) return null;
    return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
  }

  const dayMonthMatch = text.match(new RegExp(`\\b(\\d{1,2})\\s+(${MONTH_NAME_ALTERNATION})\\b(?:\\s+(\\d{4}))?`, "i"));
  const monthDayMatch = !dayMonthMatch && text.match(new RegExp(`\\b(${MONTH_NAME_ALTERNATION})\\s+(\\d{1,2})\\b(?:\\s+(\\d{4}))?`, "i"));

  let day;
  let monthName;
  let yearRaw;
  if (dayMonthMatch) {
    [, day, monthName, yearRaw] = dayMonthMatch;
  } else if (monthDayMatch) {
    [, monthName, day, yearRaw] = monthDayMatch;
  } else {
    return null;
  }

  const monthIndex0 = MONTH_NAMES_ID.indexOf(monthName.toLowerCase());
  const dayNum = Number(day);
  const year = yearRaw ? Number(yearRaw) : Number(getTodayWIB().split("-")[0]);
  if (dayNum < 1 || dayNum > daysInMonth(year, monthIndex0)) return null;

  const pad2 = (n) => String(n).padStart(2, "0");
  return `${year}-${pad2(monthIndex0 + 1)}-${pad2(dayNum)}`;
}

// "september"/"rekap september" (TANPA angka hari) - dipanggil router.js
// SETELAH parseSpecificDateFromText gagal, biar "rekap 25 september"
// ketangkep sebagai tanggal spesifik duluan, bukan kepotong jadi "rekap
// bulan september polos" gara-gara nama bulannya kebaca doang di teksnya.
function parseMonthOnlyFromText(text) {
  const match = text.match(new RegExp(`\\b(${MONTH_NAME_ALTERNATION})\\b(?:\\s+(\\d{4}))?`, "i"));
  if (!match) return null;
  const monthIndex0 = MONTH_NAMES_ID.indexOf(match[1].toLowerCase());
  const year = match[2] ? Number(match[2]) : Number(getTodayWIB().split("-")[0]);
  return `${year}-${String(monthIndex0 + 1).padStart(2, "0")}`;
}

// Kata waktu relatif yang sering diketik orang tapi dulu gak dikenali: "kemarin"
// (-> tanggal kemarin WIB), "bulan lalu" (-> bulan sebelum bulan berjalan), dan
// "minggu lalu" ("unsupported" - rentang "7 hari yang lalu sampai 14 hari yang
// lalu" gak ada di model rentang rekap yang cuma kenal "N hari terakhir",
// jadi ditolak eksplisit alih-alih diam-diam dijawab pake "minggu ini").
// "minggu/bulan kemarin" dicek DULUAN sebelum "kemarin" polos biar gak
// kebaca jadi "kemarin" doang.
function parseRelativePeriodFromText(text) {
  if (/\b(?:minggu|pekan)\s+(?:lalu|kemarin|kemaren)\b/.test(text)) return { kind: "unsupported" };
  if (/\bbulan\s+(?:lalu|kemarin|kemaren)\b/.test(text)) {
    const [year, month] = getTodayWIB().split("-").map(Number);
    const prev = month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
    return { kind: "month", month: `${prev.year}-${String(prev.month).padStart(2, "0")}` };
  }
  if (/\b(?:kemarin|kemaren)\b/.test(text)) return { kind: "date", date: shiftDateWIB(getTodayWIB(), -1) };
  return null;
}

// Tanggal yang KELIHATAN kayak tanggal tapi mustahil ("31 februari", "2026-02-30")
// - parseSpecificDateFromText balikin null buat itu, dan dulu "rekap 31 februari"
// jatuh diam-diam jadi "rekap bulan Februari" (nama bulannya doang yang kebaca).
// Balikin teks tanggalnya buat ditampilin di pesan penolakan, atau null.
function findImpossibleDateInText(text) {
  if (parseSpecificDateFromText(text) !== null) return null;
  const iso = text.match(/\b\d{4}-\d{2}-\d{2}\b/);
  if (iso) return iso[0];
  const dayMonth = text.match(new RegExp(`\\b(\\d{1,2})\\s+(${MONTH_NAME_ALTERNATION})\\b(?:\\s+(\\d{4}))?`, "i"));
  if (dayMonth) return dayMonth[0].replace(/\s+/g, " ");
  const monthDay = text.match(new RegExp(`\\b(${MONTH_NAME_ALTERNATION})\\s+(\\d{1,2})\\b(?:\\s+(\\d{4}))?`, "i"));
  if (monthDay) return monthDay[0].replace(/\s+/g, " ");
  return null;
}

function replyImpossibleDate(shown) {
  return `Cok, tanggal "${shown}" itu gak ada di kalender. Cek lagi ya (contoh: "rekap 25 september").`;
}

function replyUnsupportedPeriod() {
  return 'Cok, "minggu lalu" belum bisa dijawab. Yang tersedia: hari ini, "kemarin", "minggu ini" (7 hari terakhir), "bulan ini", "bulan lalu", atau tanggal tertentu (misal "rekap 25 september").';
}

// Index hari (konvensi Intl/JS: 0=Minggu...6=Sabtu). "senin".."sabtu" gak
// ambigu, ditangkep begitu ketemu kata itu di mana pun di teksnya. "minggu"
// SENGAJA beda perlakuan - itu kata yang SAMA PERSIS dipake buat "rentang 7
// hari terakhir" ("cok rekap minggu ini"/"cok rekap minggu"), jadi cuma
// dianggep "hari Minggu" kalau kata "hari" JUGA eksplisit disebut ("cok
// rekap hari minggu") - tanpa syarat ini, "cok rekap minggu ini" bakal salah
// kebaca sebagai nanya hari Minggu, bukan rentang mingguan yang udah ada
// dari dulu.
const WEEKDAY_NAMES_ID = ["Minggu", "Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu"];

function parseWeekdayFromText(text) {
  for (let i = 1; i <= 6; i++) {
    if (containsWholeWord(text, WEEKDAY_NAMES_ID[i].toLowerCase())) return i;
  }
  if (containsWholeWord(text, "hari") && containsWholeWord(text, "minggu")) return 0;
  return null;
}

// §10's fortieth item: dipake "paling lama live"/"paling rame ditonton"
// (chat/router.js) buat ngedeteksi rentang waktu yang disebut di kalimatnya,
// biar bisa nanya "minggu ini"/"bulan ini"/nama bulan/tanggal spesifik, gak
// cuma "hari ini" - null kalau gak nyebut rentang apapun (pemanggil default
// ke "hari ini" sendiri). SENGAJA gak dukung nama hari ("senin" dst) kayak
// fitur rekap - "Senin yang mana" butuh dropdown buat resolve ke SATU
// tanggal pasti dulu, di luar scope jawaban satu baris kayak fitur ini.
// Tanggal spesifik dicek DULUAN (sebelum cek nama bulan polos), sama urutan
// alesannya kayak chat/router.js's "rekap" dispatch - biar "25 september"
// kebaca sebagai tanggal, bukan kepotong jadi "bulan september polos".
// "bulan" dicek TANPA syarat "ini" (beda dari rekap yang punya jalur
// dropdown-per-bulan tersendiri buat "bulan" bener-bener polos) - di sini
// gak ada dropdown yang bisa ditawarin buat jawaban satu baris, jadi
// default-nya SELALU bulan berjalan begitu kata "bulan" disebut tanpa nama
// bulan spesifik.
function resolveStatRangeFromText(text) {
  // "kemarin"/"bulan lalu" - BUG: dulu gak dikenali sama sekali, jadi "paling
  // rame kemarin"/"export rekap kemarin" DIAM-DIAM dijawab pake data HARI INI
  // (dan "bulan lalu" pake bulan ini, karena kata "bulan"-nya doang yang
  // kebaca) - jawaban salah tanpa ada tanda apapun. "minggu lalu" gak
  // didukung, ditolak eksplisit di router.js (replyUnsupportedPeriod).
  const relative = parseRelativePeriodFromText(text);
  if (relative?.kind === "date") return { rangeDays: relative.date, label: "kemarin" };
  if (relative?.kind === "month") return { rangeDays: relative.month, label: `bulan ${formatMonthLabel(relative.month)}` };

  const specificDate = parseSpecificDateFromText(text);
  if (specificDate) {
    return { rangeDays: specificDate, label: `tanggal ${formatLongDateWIB(new Date(`${specificDate}T00:00:00+07:00`))}` };
  }

  const monthOnly = parseMonthOnlyFromText(text);
  if (monthOnly) {
    return { rangeDays: monthOnly, label: `bulan ${formatMonthLabel(monthOnly)}` };
  }

  if (containsWholeWord(text, "bulan")) {
    const thisMonth = getTodayWIB().slice(0, 7);
    return { rangeDays: thisMonth, label: `bulan ${formatMonthLabel(thisMonth)}` };
  }

  if (containsWholeWord(text, "minggu")) {
    return { rangeDays: 7, label: "minggu ini" };
  }

  return null;
}

module.exports = {
  MONTH_NAMES_ID,
  parseSpecificDateFromText,
  parseMonthOnlyFromText,
  parseRelativePeriodFromText,
  findImpossibleDateInText,
  replyImpossibleDate,
  replyUnsupportedPeriod,
  WEEKDAY_NAMES_ID,
  parseWeekdayFromText,
  resolveStatRangeFromText,
};
