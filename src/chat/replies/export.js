// Ekspor rekap ke file CSV ("cok export rekap ...").

const { AttachmentBuilder } = require("discord.js");
const { SESSION_RETENTION_DAYS } = require("../../storage/dailyLog");
const { formatDuration, formatClockWIB, getDateWIB } = require("../../utils");

const { resolveRecapMember, describeMissingMember } = require("./memberLookup");
const { parseWeekdayFromText, resolveStatRangeFromText } = require("./recap/dateParsing");
const {
  extractMemberFromPeriodText,
  findMultipleKnownMembers,
  replyOneMemberOnly,
  replyMemberWeekdayUnsupported,
  resolveMemberPeriod,
} = require("./recap/memberText");
const { getSessionsForRange } = require("./recap/sessions");

// §10's forty-first item, owner minta ("Q2" fitur ke-3): export rekap ke
// file CSV yang bisa didownload, buat dibuka di luar Discord (spreadsheet/
// laporan) - beda dari tabel `cok rekap` yang cuma keliatan di Discord doang.
//
// Dua hal yang owner sengaja pesen dijaga ("jangan sampai terlalu mahal di
// storage"): (1) file-nya dibikin MURNI di memori (`Buffer.from(csvText)`)
// terus langsung dilampirin ke balesan - GAK PERNAH ditulis ke disk bot ini
// sama sekali (beda dari fitur lain yang nulis ke CACHE_DIR), jadi gak nambah
// beban storage Railway Volume-nya sedikit pun, walau dipanggil berkali-kali.
// (2) formatnya CSV polos (bukan JSON/PDF/gambar) - paling ringkes buat
// jumlah baris yang sama, dan `EXPORT_MAX_ROWS` jadi jaring pengaman kalau
// suatu saat data separah apapun tetap gak bisa ngasilin file yang
// kegedean buat di-download (di skala member JKT48 + retensi 35 hari
// `dailyLog.js`, jumlah sesi realistisnya gak bakal deket-deket batas ini
// sama sekali - ini murni jaga-jaga, bukan batasan yang bakal kena beneran).
const EXPORT_MAX_ROWS = 10000;

// "," / "\"" / baris baru di dalem sebuah value HARUS dibungkus tanda kutip
// (standar format CSV) - member name teoretisnya bisa aja ngandung koma,
// dan biarpun kemungkinannya kecil, mendingan CSV-nya tetep valid dibuka di
// Excel/Sheets manapun daripada kolom-nya geser gara-gara 1 koma nyempil.
function csvEscape(value) {
  const str = String(value);
  return /[",\r\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

function formatSessionMomentWIB(unixSec) {
  const d = new Date(unixSec * 1000);
  return `${getDateWIB(d)} ${formatClockWIB(d)}`;
}

function buildExportCsv(sessions) {
  const sorted = [...sessions].sort((a, b) => a.startedAtUnix - b.startedAtUnix).slice(0, EXPORT_MAX_ROWS);
  const header = ["No", "Member", "Username", "Status", "Mulai (WIB)", "Berakhir (WIB)", "Durasi", "Puncak Penonton"];
  const rows = sorted.map((s, i) => [
    i + 1,
    s.name,
    s.username,
    s.endedAtUnix !== null ? "Selesai" : "Live",
    formatSessionMomentWIB(s.startedAtUnix),
    s.endedAtUnix !== null ? formatSessionMomentWIB(s.endedAtUnix) : "-",
    s.endedAtUnix !== null ? formatDuration(s.durationMs) : "-",
    s.peakViewCount != null ? s.peakViewCount : "",
  ]);
  return [header, ...rows].map((row) => row.map(csvEscape).join(",")).join("\r\n");
}

// Nama file-nya dilucutin dari karakter yang bukan huruf/angka/tanda hubung
// biar aman dipake sebagai nama file lintas OS (spasi/tanda baca di label
// rentang, mis. "tanggal 25 September 2026", jadi "tanggal-25-september-2026").
function sanitizeExportFileNamePart(label) {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Dipanggil "cok export rekap ..." (chat/router.js) - reuse resolveStatRangeFromText
// yang SAMA persis dipake "paling lama live"/"paling rame ditonton" (§10's
// fortieth item), biar rentang yang didukung/gak didukung (mis. nama hari)
// konsisten di ketiga fitur ini, bukan nulis parser rentang yang keempat.
//
// BUG: "export rekap nala"/"export rekap nala minggu ini" dulu MENGABAIKAN nama
// membernya dan ngeexport semua member. Sekarang satu kata sisa (di luar kata
// rentang/pelengkap) dianggep nama member: tanpa rentang -> semua arsip member
// itu, dengan rentang -> sesi member itu di rentang tsb.
async function replyExportRecap(text) {
  const multiple = findMultipleKnownMembers(text);
  if (multiple) return replyOneMemberOnly(multiple);

  const fragment = extractMemberFromPeriodText(text);
  if (fragment && parseWeekdayFromText(text) !== null) return replyMemberWeekdayUnsupported(fragment);

  // Ada member -> "hari ini" juga dihitung rentang (resolveMemberPeriod), biar
  // "export rekap nala hari ini" gak jatuh jadi semua arsip.
  const range = fragment ? resolveMemberPeriod(text) : resolveStatRangeFromText(text);
  let rangeDays = range ? range.rangeDays : null;
  let label = range ? range.label : "hari ini";

  let member = null;
  if (fragment) {
    const resolved = resolveRecapMember(fragment);
    if (resolved.status === "ambiguous") {
      return `Cok, ada beberapa member yang cocok sama "${fragment}": ${resolved.names.join(", ")}. Ketik nama yang lebih lengkap ya.`;
    }
    if (resolved.status === "none") return await describeMissingMember(fragment, "diexport");
    member = resolved;
    label = range ? `${resolved.name} - ${range.label}` : `${resolved.name} (semua arsip ${SESSION_RETENTION_DAYS} hari)`;
    if (!range) rangeDays = `@${resolved.username}`;
  }

  let sessions = getSessionsForRange(rangeDays);
  if (member) sessions = sessions.filter((s) => s.username === member.username);
  if (sessions.length === 0) {
    return `Cok, belum ada data live buat diexport (${label}).`;
  }

  const csv = buildExportCsv(sessions);
  const truncatedNote = sessions.length > EXPORT_MAX_ROWS ? `\n_(dibatesin ${EXPORT_MAX_ROWS} baris pertama dari ${sessions.length} sesi)_` : "";
  const fileName = `rekap-${sanitizeExportFileNamePart(label)}.csv`;

  return {
    content: `📄 Rekap ${label} (${sessions.length} sesi) - diexport ke CSV, cok.${truncatedNote}`,
    files: [new AttachmentBuilder(Buffer.from(csv, "utf-8"), { name: fileName })],
  };
}

module.exports = {
  buildExportCsv,
  replyExportRecap,
};
