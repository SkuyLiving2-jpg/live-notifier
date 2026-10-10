// Tabel teks rekap (satu halaman) dan ukuran halamannya.

const { formatClockWIB, getTodayWIB, getDateWIB, formatShortDateWIB } = require("../../../utils");

// Discord ngerender fenced code block (```) monospace - dipake buat nyusun
// tabel yang kolomnya rapi rata kiri-kanan, bukan cuma daftar baris teks.
// Dipecah per PAGE_SIZE baris biar sesi yang buanyak hari ini nggak numbrung
// ngelewatin limit 2000 karakter per pesan Discord - sebelumnya kelebihan
// cuma di-buang diem-diem (cuma dikasih catetan "+N sesi lainnya"), sekarang
// bisa diminta liat halaman berikutnya lewat "cok rekap" -> jawab "y".
const RECAP_TABLE_PAGE_SIZE = 20;

// Anggaran karakter buat TABEL rekap (bukan seluruh pesan): batas pesan Discord
// 2000, sisanya ~450 buat ringkasan/footer. Dulu nama panjang (mis. "Jesslyn
// Elly Maharani JKT48") bikin balasan rekap sampe ~2200 karakter dan DITOLAK
// Discord tanpa pesan apapun. Kolom nama dipotong SEADAANYA (bukan selalu)
// sampai tabel muat, tapi gak lebih pendek dari RECAP_TABLE_NAME_MIN.
const RECAP_TABLE_BUDGET = 1550;

const RECAP_TABLE_NAME_MIN = 8;

function truncateTableName(name, max) {
  return name.length > max ? `${name.slice(0, max - 1)}…` : name;
}

function buildRecapTablePage(sessions, page, hideName = false) {
  const sorted = [...sessions].sort((a, b) => a.startedAtUnix - b.startedAtUnix);
  const totalPages = Math.max(1, Math.ceil(sorted.length / RECAP_TABLE_PAGE_SIZE));
  const clampedPage = Math.min(Math.max(page, 0), totalPages - 1);
  const start = clampedPage * RECAP_TABLE_PAGE_SIZE;
  const pageSessions = sorted.slice(start, start + RECAP_TABLE_PAGE_SIZE);

  // Kolom terakhir tadinya "Durasi" (mis. "1j 23m") - owner minta diganti
  // jadi jam BERAKHIR-nya, soalnya yang lebih kepake itu jam mulai & jam
  // selesai, bukan lama durasinya. Sama pola penandaan "(DD/MM)"-nya kayak
  // kolom Mulai di bawah, buat kasus live yang baru KELAR sesudah lewat
  // tengah malam WIB.
  const header = ["No", "Member", "Status", "Mulai", "Berakhir"];
  const rows = pageSessions.map((s, i) => {
    const startedAt = new Date(s.startedAtUnix * 1000);
    // Live yang mulai sebelum tengah malam WIB tapi baru selesai/kecatet
    // SETELAH lewat tengah malam (mis. mulai 22:50 kemarin, kelar 00:39 hari
    // ini) tetep numpang di tabel rekap "hari ini" (soalnya log harian
    // ngikutin tanggal WIB pas sesi itu SELESAI/kecatet, bukan pas mulai) -
    // tanpa penanda ini, jam mulainya keliatan kayak jam mulai HARI INI juga,
    // padahal bukan. Ditambahin "(DD/MM)" di sebelah jam kalau tanggal WIB
    // mulainya beda dari tanggal "hari ini".
    const startedOnDifferentDay = getDateWIB(startedAt) !== getTodayWIB();
    const mulaiText = startedOnDifferentDay ? `${formatClockWIB(startedAt)} (${formatShortDateWIB(startedAt)})` : formatClockWIB(startedAt);

    let berakhirText = "-";
    if (s.endedAtUnix !== null) {
      const endedAt = new Date(s.endedAtUnix * 1000);
      const endedOnDifferentDay = getDateWIB(endedAt) !== getTodayWIB();
      berakhirText = endedOnDifferentDay ? `${formatClockWIB(endedAt)} (${formatShortDateWIB(endedAt)})` : formatClockWIB(endedAt);
    }

    return [String(start + i + 1), s.name, s.endedAtUnix !== null ? "Selesai" : "Live", mulaiText, berakhirText];
  });

  // Tampilan per member: kolom Member isinya nama yang SAMA di semua baris (dan
  // udah ada di judul), jadi dibuang.
  const columns = header.map((_, col) => col).filter((col) => !(hideName && col === 1));
  const shownHeader = columns.map((col) => header[col]);
  const render = (nameMax) => {
    const shownRows = rows.map((r) => columns.map((col) => (col === 1 ? truncateTableName(r[col], nameMax) : r[col])));
    const widths = shownHeader.map((h, col) => Math.max(h.length, ...shownRows.map((r) => r[col].length)));
    const formatRow = (cols) => cols.map((c, i) => c.padEnd(widths[i])).join(" | ");
    const separator = widths.map((w) => "-".repeat(w)).join("-+-");
    return ["```", formatRow(shownHeader), separator, ...shownRows.map(formatRow), "```"].join("\n");
  };

  let nameMax = Math.max(RECAP_TABLE_NAME_MIN, ...rows.map((r) => r[1].length));
  let text = render(nameMax);
  while (!hideName && text.length > RECAP_TABLE_BUDGET && nameMax > RECAP_TABLE_NAME_MIN) {
    nameMax -= 1;
    text = render(nameMax);
  }
  return { text, page: clampedPage, totalPages, hasMore: clampedPage < totalPages - 1 };
}

module.exports = {
  RECAP_TABLE_PAGE_SIZE,
  buildRecapTablePage,
};
