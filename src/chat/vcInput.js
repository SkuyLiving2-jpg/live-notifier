// Parser isian form "input VC" (chat/vcFlow.js). Murni: tiap fungsi balikin { ok: true, value } atau
// { ok: false, error } dengan pesan berbahasa Indonesia yang langsung bisa ditampilkan ke owner, supaya form yang
// salah isi bisa dijelaskan SEMUA kesalahannya sekaligus (bukan satu-satu).

const { getTodayWIB, formatLongDateWIB, WEEKDAY_FORMATTER_WIB } = require("../utils");
const { shiftDateWIB } = require("../streakMath");
const { checkSession } = require("./vcSlots");

const ok = (value) => ({ ok: true, value });
const fail = (error) => ({ ok: false, error });

// ------------------------------- jam -----------------------------------------

// "12.45", "12:45", "1245", "945", "12" (-> 12:00), "12.45 wib" -> "HH:MM". Jam 0-23, menit 0-59.
function parseTime(raw, label = "Jam") {
  const text = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s*wib$/, "")
    .replace(/\s+/g, "");
  let hour;
  let minute;
  let m;
  if ((m = text.match(/^(\d{1,2})[.:,](\d{2})$/))) {
    hour = Number(m[1]);
    minute = Number(m[2]);
  } else if ((m = text.match(/^(\d{1,2})$/))) {
    hour = Number(m[1]);
    minute = 0;
  } else if ((m = text.match(/^(\d{1,2})(\d{2})$/))) {
    hour = Number(m[1]);
    minute = Number(m[2]);
  } else {
    return fail(`${label} "${String(raw ?? "").trim()}" gak kebaca - tulis kayak 12.45 atau 1245.`);
  }
  if (hour > 23 || minute > 59) return fail(`${label} "${String(raw).trim()}" gak valid (jam 0-23, menit 0-59).`);
  return ok(`${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`);
}

// "12:45" -> "12.45" (gaya yang dipakai owner).
const formatTime = (hhmm) => hhmm.replace(":", ".");

// Jendela jam buka: "16:15","16:30" -> "16.15-16.30". Tanpa ujung (data lama / sesi tanpa jendela) -> "16.15".
const formatOpenWindow = (open, openEnd) => (openEnd ? `${formatTime(open)}-${formatTime(openEnd)}` : formatTime(open));

// ------------------------------- tanggal -------------------------------------

const MONTHS = {
  januari: 1, jan: 1, februari: 2, feb: 2, pebruari: 2, maret: 3, mar: 3, april: 4, apr: 4, mei: 5, juni: 6, jun: 6,
  juli: 7, jul: 7, agustus: 8, agu: 8, ags: 8, agt: 8, agst: 8, september: 9, sep: 9, sept: 9, oktober: 10, okt: 10,
  november: 11, nov: 11, nop: 11, desember: 12, des: 12,
}; // prettier-ignore
const WEEKDAY_WORDS = /^(?:senin|selasa|rabu|kamis|jumat|jum'at|sabtu|minggu|ahad)[,\s]+/;

// Tanggal kalender yang NYATA ("31 februari" ditolak), balikin "YYYY-MM-DD" atau null.
function buildRealDate(year, month, day) {
  if (!Number.isInteger(year) || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// Tanpa tahun: pakai tahun ini, kecuali tanggalnya sudah lewat lebih dari 60 hari - itu pasti maksudnya tahun depan
// (mis. mengetik "5/1" di bulan Desember). Tanggal yang baru lewat (<= 60 hari) tetap boleh, buat mencatat VC kemarin.
function inferYear(month, day, todayWIB) {
  const thisYear = Number(todayWIB.slice(0, 4));
  const candidate = buildRealDate(thisYear, month, day);
  if (candidate && candidate < shiftDateWIB(todayWIB, -60)) return thisYear + 1;
  return thisYear;
}

// "hari ini", "besok", "lusa", "18/10", "18-10-2026", "18 oktober", "18 okt 2026", "sabtu 18 oktober", "2026-10-18".
function parseDateInput(raw, todayWIB = getTodayWIB()) {
  const text = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(WEEKDAY_WORDS, "")
    .replace(/\s+/g, " ");
  const bad = () => fail(`Tanggal "${String(raw ?? "").trim()}" gak kebaca - tulis kayak 18/10, 18 oktober, besok, atau 2026-10-18.`);
  if (!text) return bad();

  if (text === "hari ini" || text === "hr ini") return ok(todayWIB);
  if (text === "besok") return ok(shiftDateWIB(todayWIB, 1));
  if (text === "lusa") return ok(shiftDateWIB(todayWIB, 2));

  let m;
  let year;
  let month;
  let day;
  if ((m = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) {
    [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  } else if ((m = text.match(/^(\d{1,2})[/\-.](\d{1,2})(?:[/\-.](\d{2}|\d{4}))?$/))) {
    [day, month] = [Number(m[1]), Number(m[2])];
    year = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : inferYear(month, day, todayWIB);
  } else if ((m = text.match(/^(\d{1,2}) ([a-z]+)(?: (\d{4}))?$/)) && MONTHS[m[2]]) {
    [day, month] = [Number(m[1]), MONTHS[m[2]]];
    year = m[3] ? Number(m[3]) : inferYear(month, day, todayWIB);
  } else {
    return bad();
  }
  const date = buildRealDate(year, month, day);
  return date ? ok(date) : fail(`Tanggal "${String(raw).trim()}" gak ada di kalender.`);
}

// "2026-10-18" -> "Minggu, 18 Oktober 2026".
function formatDateDisplay(dateWIB) {
  const at = new Date(`${dateWIB}T12:00:00+07:00`);
  return `${WEEKDAY_FORMATTER_WIB.format(at)}, ${formatLongDateWIB(at)}`;
}

// ------------------------------ sesi & tiket ---------------------------------

function parseSessionNumber(raw) {
  const m = String(raw ?? "")
    .trim()
    .toLowerCase()
    .match(/^(?:sesi\s*)?(\d{1,2})$/);
  const n = m ? Number(m[1]) : NaN;
  return n >= 1 && n <= 99 ? ok(n) : fail(`Sesi "${String(raw ?? "").trim()}" harus angka 1-99.`);
}

// Kosong = tidak ada info tiket (null). Selain itu 1-999, boleh dengan kata "tiket".
function parseTickets(raw) {
  const text = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (!text) return ok(null);
  const m = text.match(/^(\d{1,3})(?:\s*tiket)?$/);
  const n = m ? Number(m[1]) : NaN;
  return n >= 1 && n <= 999 ? ok(n) : fail(`Jumlah tiket "${String(raw).trim()}" harus angka 1-999 (atau kosongkan).`);
}

// ----------------------------- link & sandi ----------------------------------

// Isian satu kolom: "<link>" atau "<link> <kode sandi>". Link harus http(s). Kode sandi 3-12 huruf/angka (boleh diawali
// "kode"/"sandi"/"pass"). Dibatasi 300 karakter - link Zoom biasa ~100.
function parseLinkField(raw) {
  const tokens = String(raw ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length === 0) return fail("Link Zoom wajib diisi.");
  if (tokens.length > 2) return fail("Kolom link cuma boleh: link, lalu (opsional) kode sandi - dipisah spasi.");

  const link = tokens[0].replace(/^<|>$/g, "");
  let url;
  try {
    url = new URL(link);
  } catch {
    return fail(`"${tokens[0].slice(0, 60)}" bukan link yang valid - harus diawali https://`);
  }
  if (!/^https?:$/.test(url.protocol)) return fail("Link harus diawali http:// atau https://");
  if (link.length > 300) return fail("Link kepanjangan (maks 300 karakter).");

  let passcode = null;
  if (tokens[1]) {
    passcode = tokens[1].replace(/^(?:kode|sandi|passcode|pass|pwd)[:=]?/i, "");
    if (!/^[A-Za-z0-9]{3,12}$/.test(passcode)) return fail(`Kode sandi "${tokens[1]}" gak valid (3-12 huruf/angka).`);
  }
  return ok({ link, passcode });
}

// ID rapat Zoom dari link ("/j/87197929985?pwd=..." -> "87197929985"), atau null (bukan Zoom / tidak ada ID).
function extractZoomId(link) {
  let url;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  if (!/(^|\.)zoom(?:gov)?\.(?:us|com)$/i.test(url.hostname)) return null;
  const m = url.pathname.match(/\/(?:j|wc\/join|wc\/\d+\/join)\/(\d{9,11})(?:\/|$)/);
  return m ? m[1] : null;
}

// Kunci pembanding link buat cek "link ini sudah dipakai sesi lain": link Zoom dibandingkan lewat ID rapatnya (host us02web/zoom.us,
// ada/tidaknya ?pwd=, garis miring penutup, huruf besar/kecil tidak membuatnya dianggap beda); link lain lewat host+path+query.
function linkKey(link) {
  const zoomId = extractZoomId(link);
  if (zoomId) return `zoom:${zoomId}`;
  try {
    const url = new URL(link);
    return `${url.hostname.toLowerCase()}${url.pathname.replace(/\/+$/, "")}${url.search}`;
  } catch {
    return String(link).trim().toLowerCase();
  }
}

// "87197929985" -> "871 9792 9985" (11 digit: 3-4-4, 10 digit: 3-3-4, 9 digit: 3-3-3), format ID Rapat Zoom.
function formatZoomId(digits) {
  if (digits.length === 11) return `${digits.slice(0, 3)} ${digits.slice(3, 7)} ${digits.slice(7)}`;
  if (digits.length === 10) return `${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6)}`;
  return `${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6)}`;
}

// ------------------------------- gabungan ------------------------------------

// Validasi semua kolom sekaligus. `fields`: { sesi?, tanggal?, mulai?, link?, tiket? } (teks mentah dari modal; kolom yang
// undefined dilewati karena tiap modal hanya membawa sebagian). Jam BUKA tidak diketik: ia ditentukan oleh (tanggal, sesi)
// lewat vcSlots - tanggal/sesi diambil dari `fields` kalau ada, kalau tidak dari `context` ({ date, session }, mis. pilihan
// di dropdown sebelumnya). Sesi yang tidak ada di hari itu (mis. sesi 4 di hari Senin) jadi kesalahan. Balikin { ok, value, errors }.
function validateSessionForm(fields, todayWIB = getTodayWIB(), context = {}) {
  const errors = [];
  const value = {};
  const take = (key, result, target = key) => {
    if (result.ok) value[target] = result.value;
    else errors.push(result.error);
  };
  if (fields.sesi !== undefined) take("sesi", parseSessionNumber(fields.sesi), "session");
  if (fields.tanggal !== undefined) take("tanggal", parseDateInput(fields.tanggal, todayWIB), "date");
  if (fields.mulai !== undefined) take("mulai", parseTime(fields.mulai, "Jam mulai"), "start");
  if (fields.tiket !== undefined) take("tiket", parseTickets(fields.tiket), "tickets");
  if (fields.link !== undefined) {
    const result = parseLinkField(fields.link);
    if (result.ok) Object.assign(value, result.value);
    else errors.push(result.error);
  }
  const date = value.date ?? context.date;
  const session = value.session ?? context.session;
  if (date && session) {
    const slot = checkSession(date, session);
    if (slot.ok) {
      value.open = slot.value.open;
      value.openEnd = slot.value.openEnd;
    } else {
      errors.push(slot.error);
    }
  }
  if (value.open && value.start && value.start < value.open) {
    errors.push(`Jam mulai ${formatTime(value.start)} gak boleh lebih awal dari jam buka sesi ${session} (${formatTime(value.open)}).`);
  }
  return { ok: errors.length === 0, value, errors };
}

module.exports = {
  parseTime,
  formatTime,
  formatOpenWindow,
  parseDateInput,
  formatDateDisplay,
  parseSessionNumber,
  parseTickets,
  parseLinkField,
  extractZoomId,
  linkKey,
  formatZoomId,
  validateSessionForm,
};
