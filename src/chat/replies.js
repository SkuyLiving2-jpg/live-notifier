const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
  AttachmentBuilder,
} = require("discord.js");
const { deleteInteractionMessage } = require("./interactionHelpers");
const { activeLives, getSortedActiveLives } = require("../storage/activeLives");
const {
  getCompletedSessionsToday,
  getCompletedSessionsForDate,
  getCompletedSessionsSince,
  getCompletedSessionsForMonth,
  getDistinctSessionMonths,
  getEarliestSessionDate,
  fetchExternalTodayLiveHistory,
} = require("../storage/dailyLog");
const { findDurationHistoryByNameFragment } = require("../storage/durationHistory");
const { findLiveCountByNameFragment, getLiveCountLeaderboard } = require("../storage/liveCount");
const { loadSubscriptions, addSubscription, removeSubscription } = require("../storage/subscriptions");
const { loadGifterSnapshot, findGifterSnapshotByNameFragment } = require("../storage/gifterSnapshot");
const { getAllPriorityMembers, addCustomPriorityMember, removeCustomPriorityMember } = require("../priority");
const { PRIORITY_PING_USER_ID } = require("../config");
const {
  formatDuration,
  formatRelativeTime,
  formatViewCount,
  formatClockWIB,
  getTodayWIB,
  getDateWIB,
  formatShortDateWIB,
  formatLongDateWIB,
  formatMonthLabel,
  describeElapsed,
  getTimeOfDayBucket,
  getHourWIBOf,
  WEEKDAY_FORMATTER_WIB,
  stripTrailingLiveWord,
  matchesNameFragment,
  containsWholeWord,
  safeReplyOptions,
  YES_PATTERN,
  NO_PATTERN,
  NEXT_PAGE_PATTERN,
  PREV_PAGE_PATTERN,
} = require("../utils");

function replyListLive() {
  const sorted = getSortedActiveLives();
  if (sorted.length === 0) return "Cok, lagi nggak ada member JKT48 yang live nih.";

  const lines = sorted.map((entry, i) => {
    const elapsedText = describeElapsed(Date.now() - new Date(entry.liveAt).getTime());
    const viewText = entry.viewCount != null ? ` | 👁️ ${formatViewCount(entry.viewCount)}` : "";
    return `${i + 1}. **${entry.name}** - ${elapsedText}${viewText}`;
  });

  return `Cok, ini yang lagi live (urut dari paling lama):\n${lines.join("\n")}`;
}

// Dulu cuma bandingin member yang LAGI live sekarang - jadi kalau ada yang
// live 3 jam terus SELESAI, terus member lain baru mulai live 5 menit,
// yang kesebut "paling lama" malah yang baru mulai itu (soalnya yang udah
// selesai udah ilang dari activeLives). Sekarang gabungin durasi live yang
// LAGI JALAN (activeLives) SAMA sesi yang UDAH SELESAI hari ini (daily log)
// biar rekap-nya beneran akurat sepanjang hari, bukan cuma potret sesaat.
//
// §10's fortieth item: diekstrak jadi replyLongestLiveForRange(rangeDays,
// label) biar "paling lama live" bisa nanya rentang laen juga (minggu ini/
// bulan ini/tanggal spesifik), bukan cuma "hari ini" - reuse getSessionsForRange
// yang SAMA persis dipake fitur rekap, jadi "paling lama live bulan ini" dan
// "rekap bulan ini" narik dari sumber data yang identik. Sesi yang MASIH LIVE
// (endedAtUnix null, dari getOngoingSessionsForRecap) durationMs-nya SENGAJA
// null di situ (belum final) - dihitung ULANG di sini dari startedAtUnix biar
// tetep bisa dibandingin ke sesi yang udah selesai.
function replyLongestLiveForRange(rangeDays, label) {
  const sessions = getSessionsForRange(rangeDays);
  if (sessions.length === 0) return `Cok, belum ada data live ${label}.`;

  const candidates = sessions.map((s) => ({
    name: s.name,
    isLive: s.endedAtUnix === null,
    durationMs: s.endedAtUnix === null ? Date.now() - s.startedAtUnix * 1000 : s.durationMs,
  }));

  const longest = candidates.reduce((max, c) => (c.durationMs > max.durationMs ? c : max), candidates[0]);
  const statusText = longest.isLive ? "masih live sekarang" : "udah selesai";
  return `Paling lama live ${label}: **${longest.name}**, ${formatDuration(longest.durationMs)} (${statusText}).`;
}

function replyLongestLive() {
  return replyLongestLiveForRange(null, "hari ini");
}

// Sama kayak replyLongestLive - dulu cuma liat viewCount member yang LAGI
// live sekarang, jadi member yang tadi rame banget tapi udah selesai live
// bakal ilang gitu aja dari ranking. Sekarang bandingin PUNCAK penonton
// (peakViewCount, dicatet tiap polling selama live-nya jalan) dari live
// yang lagi jalan MAUPUN yang udah selesai hari ini, terus ambil puncak
// tertinggi per member (kalau dia live 2x hari ini, yang diitung yang
// paling rame di antara keduanya).
//
// Sama alasannya kayak replyLongestLiveForRange di atas (§10's fortieth
// item) - `peakViewCount` sesi yang MASIH LIVE udah keisi (getOngoingSessionsForRecap
// narik dari activeLives-nya langsung), jadi gak butuh perlakuan khusus
// kayak durationMs di atas.
function replyTopViewersForRange(rangeDays, label) {
  const sessions = getSessionsForRange(rangeDays);
  const peakByUsername = new Map();

  for (const s of sessions) {
    if (s.peakViewCount == null) continue;
    const prev = peakByUsername.get(s.username);
    if (!prev || s.peakViewCount > prev.peak) {
      peakByUsername.set(s.username, { name: s.name, peak: s.peakViewCount });
    }
  }

  if (peakByUsername.size === 0) return `Cok, belum ada data penonton buat ${label}.`;

  const sorted = [...peakByUsername.values()].sort((a, b) => b.peak - a.peak);
  const medals = ["🥇", "🥈", "🥉"];
  const lines = sorted.map((entry, i) => {
    const medal = medals[i] || `${i + 1}.`;
    return `${medal} **${entry.name}** - 👁️ ${formatViewCount(entry.peak)} (puncak)`;
  });

  return `👀 Paling rame ditonton ${label} (puncak penonton):\n${lines.join("\n")}`;
}

function replyTopViewers() {
  return replyTopViewersForRange(null, "hari ini");
}

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
function replyExportRecap(text) {
  const range = resolveStatRangeFromText(text);
  const rangeDays = range ? range.rangeDays : null;
  const label = range ? range.label : "hari ini";

  const sessions = getSessionsForRange(rangeDays);
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

function replyBotStatus() {
  return `✅ Bot jalan normal. Lagi mantau ${activeLives.size} member yang live sekarang.`;
}

function replySpecificMember(entry) {
  // entry.liveAt datang MENTAH dari live_at API IDN (idnApi.js gak validasi
  // format-nya) - divalidasi eksplisit di sini soalnya formatClockWIB()
  // (Intl.DateTimeFormat) THROW kalau dikasih Invalid Date (bukan ngasih
  // teks aneh kayak formatDuration/describeElapsed dengan NaN) - tanpa ini,
  // satu live_at yang kebetulan rusak bikin "cok siapa yang live <nama>"
  // gagal total tanpa balesan sama sekali (lihat notify/liveNotify.js's
  // sendDiscordNotif buat bug sekelas ini yang ketemu duluan).
  const liveAtDate = entry.liveAt ? new Date(entry.liveAt) : null;
  const liveAtValid = liveAtDate && !Number.isNaN(liveAtDate.getTime());
  const elapsedText = describeElapsed(liveAtValid ? Date.now() - liveAtDate.getTime() : 0);
  const startText = liveAtValid ? `, mulai jam ${formatClockWIB(liveAtDate)}` : "";
  const viewText = entry.viewCount != null ? ` | 👁️ ${formatViewCount(entry.viewCount)} penonton` : "";
  const liveUrl = `https://idn.app/${entry.username}/live/${entry.slug}`;
  return `**${entry.name}** lagi live, ${elapsedText}${startText}${viewText}. ${liveUrl}`;
}

function replyMemberNotFound(fragment) {
  return `Cok, nggak nemu member "${fragment}" yang lagi live. Coba cek ejaannya, atau tanya "cok siapa yang live" buat liat daftarnya.`;
}

function replyHelp() {
  const ownerContact = PRIORITY_PING_USER_ID ? `<@${PRIORITY_PING_USER_ID}>` : "owner channel ini";
  return [
    "Cok bisa jawab ini:",
    '- "cok ini yang masih live siapa aja?"',
    '- "cok siapa yang paling lama live" / "cok siapa yang paling rame ditonton" - tambahin "minggu ini"/"bulan ini"/nama bulan/tanggal buat rentang laen, default hari ini',
    '- "cok status"',
    '- "cok <nama member> masih live?"',
    '- "cok stats <nama member>" - statistik durasi live-nya',
    '- "cok berapa kali <nama member> live" - total berapa kali dia udah live semenjak bot ini jalan',
    '- "cok siapa yang paling sering live" - leaderboard total live count semua member',
    '- "cok kapan <nama member> biasanya live?" / "cok jadwal <nama>" - pola jam/hari dari histori (bukan jadwal resmi)',
    '- "cok gifter <nama member>" - top gifter (snapshot terakhir dari "npm run cek-gifter", bukan real-time)',
    '- "cok rekap hari ini" - rekap live yang udah selesai hari ini',
    '- "cok rekap minggu ini" (7 hari terakhir) / "cok rekap bulan ini" / "cok rekap <nama bulan>" / "cok rekap <tanggal>" / "cok rekap <nama hari>"',
    '- "cok export rekap ..." - sama rentangnya kayak "cok rekap ...", dikirim jadi file CSV yang bisa didownload',
    '- "cok daftar prioritas" - lihat member prioritas',
    '- "cok ingetin <nama member>" - kamu di-tag pribadi kalau dia mulai live',
    '- "cok berhenti ingetin <nama member>" - matiin reminder itu',
    '- "cok reminder aku" - lihat kamu subscribe reminder siapa aja',
    '- (khusus owner) "cok tambah prioritas <nama>" / "cok hapus prioritas <nama>"',
    "",
    'Kalau abis muncul menu tombol, kamu juga bisa cukup balas angkanya doang (misal "1" atau "4 Nala") tanpa perlu klik.',
    '💡 Notif kerasa suka telat/gak keluar? Cek setting notifikasi channel-nya - klik nama channel > Notification Settings, pastiin di "All Messages" (bukan "Only @mentions"), soalnya notif live biasa emang gak nge-tag siapa-siapa kecuali kamu subscribe ("cok ingetin <nama>").',
    `Ada yang belum kejawab? Hubungi ${ownerContact}.`,
  ].join("\n");
}

// Daftar SEMUA member prioritas (bawaan Nala/Levi/Lily + custom yang
// ditambahin owner lewat chat) - siapa aja boleh nanya ini, bukan cuma owner.
function replyPriorityList() {
  const all = getAllPriorityMembers().sort((a, b) => a.rank - b.rank);
  if (all.length === 0) return "Cok, belum ada member prioritas yang diset.";
  const lines = all.map((p) => `${p.rank}. **${p.label}** (keyword: "${p.keyword}")`);
  return `⭐ Daftar member prioritas:\n${lines.join("\n")}`;
}

// Kebalikan dari handleSubscribe/handleUnsubscribe - buat user nanya "aku
// subscribe siapa aja sih" tanpa harus inget-inget sendiri.
function replyMySubscriptions(authorId) {
  const subs = loadSubscriptions();
  const keywords = Object.entries(subs)
    .filter(([, ids]) => ids.includes(authorId))
    .map(([keyword]) => keyword);

  if (keywords.length === 0) {
    return 'Cok, kamu belum subscribe reminder buat siapa pun. Ketik "cok ingetin <nama member>" buat mulai.';
  }
  return `🔔 Kamu subscribe reminder buat: ${keywords.map((k) => `"${k}"`).join(", ")}`;
}

// Discord ngerender fenced code block (```) monospace - dipake buat nyusun
// tabel yang kolomnya rapi rata kiri-kanan, bukan cuma daftar baris teks.
// Dipecah per PAGE_SIZE baris biar sesi yang buanyak hari ini nggak numbrung
// ngelewatin limit 2000 karakter per pesan Discord - sebelumnya kelebihan
// cuma di-buang diem-diem (cuma dikasih catetan "+N sesi lainnya"), sekarang
// bisa diminta liat halaman berikutnya lewat "cok rekap" -> jawab "y".
const RECAP_TABLE_PAGE_SIZE = 20;

function buildRecapTablePage(sessions, page) {
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

  const widths = header.map((h, col) => Math.max(h.length, ...rows.map((r) => r[col].length)));
  const formatRow = (cols) => cols.map((c, i) => c.padEnd(widths[i])).join(" | ");
  const separator = widths.map((w) => "-".repeat(w)).join("-+-");

  const text = ["```", formatRow(header), separator, ...rows.map(formatRow), "```"].join("\n");
  return { text, page: clampedPage, totalPages, hasMore: clampedPage < totalPages - 1 };
}

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

// Sesi yang MASIH LIVE SEKARANG (dari activeLives), dibentuk jadi baris
// ala-sesi (endedAtUnix/durationMs null) biar bisa numpang bareng sesi yang
// UDAH SELESAI di tabel/hitungan yang sama. Dipisah dari getTodaySessionsForRecap
// biar bisa dipake juga di rekap mingguan/bulanan (lihat getSessionsForRange
// & replyRecapRange di bawah, §10's thirty-third item) - bukan cuma "hari
// ini" doang.
function getOngoingSessionsForRecap() {
  return [...activeLives.values()].map((entry) => ({
    name: entry.name,
    username: entry.username,
    startedAtUnix: Math.floor(new Date(entry.liveAt).getTime() / 1000),
    endedAtUnix: null,
    durationMs: null,
    peakViewCount: entry.peakViewCount ?? entry.viewCount ?? null,
  }));
}

// Gabungan "gambaran lengkap hari ini" - sesi yang UDAH SELESAI hari ini
// (dari daily-log.json) + yang MASIH LIVE SEKARANG. Sama pola-nya kayak
// replyLongestLive()/replyTopViewers() (yang udah lebih dulu gabungin dua
// sumber ini) - diexport biar bisa dites langsung, sama kayak buildRecapTablePage.
function getTodaySessionsForRecap() {
  return [...getCompletedSessionsToday(), ...getOngoingSessionsForRecap()];
}

// Gabungan sesi PER BULAN - sesi yang UDAH SELESAI di bulan itu, DITAMBAH
// sesi yang MASIH LIVE SEKARANG kalau `monthWIB` kebetulan bulan BERJALAN
// (sama alasannya kayak getTodaySessionsForRecap) - bulan-bulan LAIN (yang
// udah lewat) gak mungkin punya sesi yang "masih live", jadi gak pernah
// digabung buat itu.
function getMonthSessionsForRecap(monthWIB) {
  const completed = getCompletedSessionsForMonth(monthWIB);
  if (monthWIB !== getTodayWIB().slice(0, 7)) return completed;
  return [...completed, ...getOngoingSessionsForRecap()];
}

// Semua bulan ("YYYY-MM") yang layak ditawarin di dropdown "cok rekap bulan"
// polos (replyRecapMonthGeneric di bawah) - gabungan bulan yang BENERAN ada
// sesi selesainya (getDistinctSessionMonths) DITAMBAH bulan BERJALAN selalu
// dipaksa masuk walau belum ada sesi yang selesai sama sekali di situ (mis.
// baru mulai ada yang live, belum ada yang kelar) - urut dari yang paling
// baru.
function getAvailableRecapMonths() {
  const months = new Set(getDistinctSessionMonths());
  months.add(getTodayWIB().slice(0, 7));
  return [...months].sort().reverse();
}

// "channelId:authorId" -> { currentPage, totalPages, at, rangeDays } - nunggu
// jawaban y/mundur/n abis nunjukkin 1 halaman tabel rekap. Sama pola-nya
// kayak pendingWatchConfirm (di chat/menu.js, di-key per orang bukan per
// channel, biar jawaban orang lain di channel yang sama gak nyasar ke
// halaman punya orang ini). `rangeDays` (null = "hari ini", gabungan sama
// activeLives; angka = rekap mingguan/bulanan, cuma sesi yang UDAH selesai;
// string "YYYY-MM-DD" = rekap TANGGAL SPESIFIK, lihat getSessionsForRange)
// dicatet biar halaman lain tau harus narik dari daftar sesi yang SAMA,
// bukan default balik ke rekap hari ini - dulu (sebelum rekap mingguan/
// bulanan ada) cuma ada 1 jenis rekap jadi ini gak masalah, sekarang WAJIB
// biar navigasi halaman rekap minggu ini gak diem-diem ganti jadi nunjukkin
// rekap hari ini.
//
// SENGAJA nyimpen currentPage (bukan cuma nextPage kayak sebelumnya) dan
// nyimpen pending state SELAMA totalPages > 1 - BUKAN cuma pas hasMore true
// (ada halaman berikutnya). Sebelumnya, begitu user nyampe halaman TERAKHIR,
// pending state-nya gak pernah kebentuk (hasMore-nya udah false), jadi user
// yang lagi di halaman terakhir gak punya cara mundur balik ke halaman
// sebelumnya sama sekali - itu bug yang dilaporin owner: "list-nya gak bisa
// dimundurin ya?".
const pendingRecapPage = new Map();
const PENDING_RECAP_PAGE_TTL_MS = 2 * 60000;

// Satu titik keputusan buat narik SESI yang sesuai sebuah `rangeDays` - dulu
// ternary `rangeDays == null ? getTodaySessionsForRecap() : getCompletedSessionsSince(rangeDays)`
// ini ditulis ULANG di 3 tempat (tryHandleRecapPageShortcut,
// handleRecapNavButton, handleRecapSearchModalSubmit), jadi pas nambahin
// jenis rentang BARU (rekap per tanggal) gampang kelewatan salah satu -
// digabung di sini biar nambah jenis rentang lagi ke depannya cukup di 1
// tempat. `rangeDays`: null = hari ini (gabungan activeLives), number = N
// hari terakhir, string "YYYY-MM-DD" = tanggal spesifik.
//
// String tanggal yang KEBETULAN sama persis sama hari ini di-treat SAMA
// kayak rangeDays null (gabungan activeLives juga, bukan cuma
// getCompletedSessionsForDate) - dulu (sebelum buildRecapDateSelectRow ikut
// nawarin hari ini sebagai opsi, lihat komen di situ) ini gak mungkin
// kejadian soalnya dropdown-nya sengaja gak pernah ngasih value hari ini.
// Begitu hari ini jadi bisa dipilih, tanpa special-case ini milih "hari ini"
// dari dropdown per-tanggal bakal ngasih hasil BEDA dari tombol "Rekap hari
// ini" (kelewatan sesi yang MASIH LIVE, cuma nunjukkin yang udah selesai) -
// kelihatan kayak bug baru ("kok yang lagi live sekarang gak muncul").
//
// BUG SEBELUMNYA (dilaporin owner, §10's thirty-third item): rentang N-hari
// (rekap minggu/bulan) dulu CUMA narik getCompletedSessionsSince - sesi yang
// masih LIVE SEKARANG gak pernah ikut ke-gabung, jadi "cok rekap minggu ini"
// nunjukkin tabel yang kelewatan siapapun yang lagi live pas ditanya, padahal
// live itu jelas-jelas bagian dari "minggu ini" juga (dia mulainya paling
// nggak hari ini, yang termasuk 7/30 hari terakhir). Sekarang ikut digabung
// sama getOngoingSessionsForRecap(), sama kayak rangeDays null/hari-ini di atas.
//
// String `rangeDays` sekarang ada DUA bentuk, dibedain dari PANJANGNYA
// (fixed-width, gak ambigu): "YYYY-MM-DD" (10 karakter) = tanggal spesifik,
// "YYYY-MM" (7 karakter) = bulan spesifik (§10's thirty-sixth item, rekap per
// nama bulan/dropdown "rekap bulan" polos) - lihat getMonthSessionsForRecap
// buat kenapa bulan BERJALAN ikut digabung sama activeLives juga, sama
// alasannya kayak tanggal hari ini.
function getSessionsForRange(rangeDays) {
  if (rangeDays == null || rangeDays === getTodayWIB()) return getTodaySessionsForRecap();
  if (typeof rangeDays === "string") {
    if (rangeDays.length === 7) return getMonthSessionsForRecap(rangeDays);
    // Tanggal yang di-TAG weekday-nya (buildWeekdayDateSelectRow, mis.
    // "2026-09-14#1") harus dilucutin dulu tag-nya sebelum di-query - date
    // yang beneran dicari cuma bagian sebelum "#"-nya.
    const { date } = parseDateRangeValue(rangeDays);
    return date === getTodayWIB() ? getTodaySessionsForRecap() : getCompletedSessionsForDate(date);
  }
  return [...getCompletedSessionsSince(rangeDays), ...getOngoingSessionsForRecap()];
}

// "null" gak bisa lewat customId Discord (harus string) - "today" dipake
// sebagai stand-in buat rangeDays null (rekap hari ini), dikonversi balik
// lewat decodeRecapRange. Rentang TANGGAL SPESIFIK ("YYYY-MM-DD") dikasih
// awalan "d" (gak bisa ke-tabrak "today" atau angka hari-mundur manapun,
// keduanya gak pernah diawalin huruf) biar tetep 1 segmen doang pas
// nyambung ke customId yang di-split(":") posisional - TANPA awalan ini,
// tanda "-" di dalem tanggalnya aman (bukan pemisah), tapi kalau dulu dicoba
// pake ":" bakal numbuhin segmen ekstra dan ngerusak parts[n] di bawah.
// Simetris, dipake baik buat NULIS customId (buildRecapNavComponents)
// maupun BACA-nya balik (handleRecapNavButton/handleRecapSearchModalSubmit).
//
// Rentang BULAN SPESIFIK ("YYYY-MM", §10's thirty-sixth item) dikasih awalan
// "m" - beda dari "d" (tanggal) soalnya begitu udah didekode balik jadi
// string polos, getSessionsForRange butuh cara buat bedain "YYYY-MM-DD" dari
// "YYYY-MM" (dibedain dari PANJANG string-nya di situ - lihat komen di sana).
function encodeRecapRange(rangeDays) {
  if (rangeDays == null) return "today";
  if (typeof rangeDays === "string") return rangeDays.length === 7 ? `m${rangeDays}` : `d${rangeDays}`;
  return String(rangeDays);
}
function decodeRecapRange(range) {
  if (range === "today") return null;
  if (range.startsWith("d") || range.startsWith("m")) return range.slice(1);
  return Number(range);
}

// Discord StringSelectMenu maksimal 25 opsi - dropdown "rekap per tanggal"
// nunjukkin sampai 25 hari TERAKHIR mundur dari HARI INI (dulu mulai dari
// KEMARIN, lihat komen BUG SEBELUMNYA di bawah), dipotong di SALAH SATU dari
// dua batas, mana yang lebih deket: SESSION_RETENTION_DAYS punya dailyLog.js
// (35 hari - lewat itu datanya emang udah kebuang) ATAU tanggal sesi
// PALING TUA yang beneran ada di arsip (getEarliestSessionDate) - owner
// laporin dropdown-nya nunjukkin tanggal jauh ke belakang dari sebelum bot
// ini bahkan mulai jalan/nge-track (mis. bot baru mulai 13 September, tapi
// dropdown-nya nawarin sampe akhir Agustus), yang klik ke situ ujung-ujungnya
// cuma "belum ada live yang kecatet" - bukan salah, tapi ngebuang opsi buat
// tanggal yang emang gak mungkin ada datanya sama sekali.
const RECAP_DATE_OPTIONS_COUNT = 25;

// BUG SEBELUMNYA (dilaporin owner): loop-nya mulai dari i=1 (KEMARIN),
// sengaja NGELEWATIN hari ini - alasannya dulu "hari ini udah ada tombol
// 'Rekap hari ini' sendiri di replyRecapMenu", TAPI itu cuma bener kalau
// dropdown ini kebuka LEWAT tombol "Rekap per tanggal" di replyRecapMenu.
// Begitu "cok rekap tanggal"/"cok rekap per tanggal" (chat/router.js) manggil
// buildRecapDatePickerBlock() LANGSUNG, gak pernah ada tombol "Rekap hari
// ini" yang nempel sama sekali - jadi hari ini beneran gak bisa dipilih dari
// dropdown ini lewat jalur itu, cuma "ilang" tanpa penjelasan. Sekarang
// mulai dari i=0 (HARI INI ikut jadi salah satu opsi).
function buildRecapDateSelectRow(selectedDate = null) {
  const todayStartMs = new Date(`${getTodayWIB()}T00:00:00+07:00`).getTime();
  const earliestDate = getEarliestSessionDate(); // null kalau arsipnya masih kosong sama sekali - gak ada batas tambahan buat kasus itu
  const options = [];
  for (let i = 0; i < RECAP_DATE_OPTIONS_COUNT; i++) {
    const d = new Date(todayStartMs - i * 24 * 60 * 60 * 1000);
    const value = getDateWIB(d);
    if (earliestDate && value < earliestDate) break; // mundur lebih jauh dari sesi paling tua yang ada - stop, gak ada gunanya nawarin tanggal yang pasti kosong
    options.push({ label: formatLongDateWIB(d), value, default: value === selectedDate });
  }
  const selectMenu = new StringSelectMenuBuilder().setCustomId("recap_date_select").setPlaceholder("Pilih tanggal buat rekap").addOptions(options);
  return new ActionRowBuilder().addComponents(selectMenu);
}

// Tanggal-tanggal (mundur dari hari ini, dibatesin batas yang SAMA kayak
// buildRecapDateSelectRow di atas - retensi 35 hari ATAU sesi paling tua yang
// beneran ada, mana yang lebih deket) yang HARI-nya (WIB) cocok sama
// `weekdayIndex` (0=Minggu...6=Sabtu) - dasar dropdown "cok rekap hari
// senin"/"cok rekap senin" dkk (§10's thirty-sixth item). Weekday-nya
// dihitung lewat WEEKDAY_FORMATTER_WIB (Intl timeZone Asia/Jakarta), BUKAN
// Date.prototype.getDay() - getDay() ngikutin zona waktu LOKAL SERVER (bukan
// WIB), dan Railway biasanya jalan di UTC, jadi getDay() bisa nunjuk hari
// yang SALAH (mundur 1 hari) buat instant tengah-malam WIB - sama kelas bug
// timezone yang codebase ini udah konsisten hindarin di tempat lain
// (getDateWIB dkk, semua lewat Intl timeZone eksplisit, gak pernah pake
// method Date yang zona-lokal-server-dependent).
const WEEKDAY_LOOKBACK_DAYS = 90; // ~13 minggu ke belakang, cukup generous - dibatesin lebih ketat lagi sama earliestDate kalau arsipnya ada isinya
function findRecentDatesForWeekday(weekdayIndex) {
  const todayStartMs = new Date(`${getTodayWIB()}T00:00:00+07:00`).getTime();
  const earliestDate = getEarliestSessionDate();
  const targetName = WEEKDAY_NAMES_ID[weekdayIndex];
  const dates = [];
  for (let i = 0; i < WEEKDAY_LOOKBACK_DAYS && dates.length < RECAP_DATE_OPTIONS_COUNT; i++) {
    const d = new Date(todayStartMs - i * 24 * 60 * 60 * 1000);
    const value = getDateWIB(d);
    if (earliestDate && value < earliestDate) break;
    if (WEEKDAY_FORMATTER_WIB.format(d) === targetName) dates.push(d);
  }
  return dates;
}

// BUG SEBELUMNYA (dilaporin owner): milih tanggal dari dropdown weekday
// ("cok rekap senin") nunjukkin tabelnya bener, TAPI dropdown yang nempel di
// tabel itu (buat ganti-ganti tanggal tanpa nutup dulu, lihat
// buildRecapNavComponents) balik ke dropdown SEMUA tanggal (buildRecapDateSelectRow),
// bukan tetep ke dropdown khusus hari Senin - soalnya rangeDays yang
// nge-alir ke situ cuma tanggal POLOS ("YYYY-MM-DD"), gak ada jejak sama
// sekali "ini dipilih lewat filter weekday yang mana". Fix-nya: tanggal yang
// dipilih dari dropdown weekday di-TAG sekalian sama weekday-nya di NILAI
// opsinya sendiri ("YYYY-MM-DD#W", W = 0-6 - encodeWeekdayTaggedDate) - beda
// dari tanggal biasa yang value-nya tetep polos 10 karakter. Tag ini ngalir
// transparan lewat semua tempat yang udah nganggep rangeDays date "cuma
// string" (getSessionsForRange, encodeRecapRange/decodeRecapRange,
// pendingRecapPage) TANPA perlu diubah - satu-satunya tempat yang perlu
// SADAR ada tag ini ya buildRecapNavComponents (buat milih dropdown yang mana
// yang ditempelin balik) dan handleRecapDateSelect (buat misahin tanggal
// asli dari tag-nya pas format label/bikin Date). Tanggal yang dipilih dari
// dropdown "rekap tanggal" biasa TETEP polos, gak pernah ke-tag - dropdown
// itu emang didesain buat lompat ke tanggal MANAPUN, bukan dibatesin ke 1 hari.
function encodeWeekdayTaggedDate(dateWIB, weekdayIndex) {
  return `${dateWIB}#${weekdayIndex}`;
}
function parseDateRangeValue(rangeValue) {
  const hashIndex = rangeValue.indexOf("#");
  if (hashIndex === -1) return { date: rangeValue, weekdayIndex: null };
  return { date: rangeValue.slice(0, hashIndex), weekdayIndex: Number(rangeValue.slice(hashIndex + 1)) };
}

function buildWeekdayDateSelectRow(weekdayIndex, selectedRangeValue = null) {
  const options = findRecentDatesForWeekday(weekdayIndex).map((d) => {
    const value = encodeWeekdayTaggedDate(getDateWIB(d), weekdayIndex);
    return { label: formatLongDateWIB(d), value, default: value === selectedRangeValue };
  });
  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId("recap_date_select")
    .setPlaceholder(`Pilih tanggal hari ${WEEKDAY_NAMES_ID[weekdayIndex]}`)
    .addOptions(options);
  return new ActionRowBuilder().addComponents(selectMenu);
}

// Dropdown "cok rekap bulan" polos (replyRecapMonthGeneric di bawah) DAN
// baris navigasi tabel rekap PER BULAN (buildRecapNavComponents, biar bisa
// ganti bulan tanpa nutup dulu, sama pola-nya kayak buildRecapDateSelectRow
// buat tanggal).
function buildRecapMonthSelectRow(months, selectedMonth = null) {
  const options = months.map((m) => ({ label: formatMonthLabel(m), value: m, default: m === selectedMonth }));
  const selectMenu = new StringSelectMenuBuilder().setCustomId("recap_month_select").setPlaceholder("Pilih bulan buat rekap").addOptions(options);
  return new ActionRowBuilder().addComponents(selectMenu);
}

function buildCloseOnlyRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("recap_nav:close").setLabel("Tutup rekap").setStyle(ButtonStyle.Danger),
  );
}

// Baris tombol yang nempel di SETIAP halaman tabel rekap - dulu satu-satunya
// cara maju/mundur/berenti cuma lewat ngetik "y"/"mundur"/"n" (masih jalan,
// tryHandleRecapPageShortcut di bawah gak diubah), padahal infrastruktur
// tombol Discord udah ada di fitur lain (menu.js). Beda dari pendingRecapPage
// (state yang nunggu balesan TEKS abis halaman PALING BARU ditampilin, per
// orang, TTL 2 menit) - customId tombol ini SELF-CONTAINED (action + rentang
// rekap + halaman sekarang semua ada di customId-nya), jadi tombol di pesan
// LAMA manapun tetep valid diklik kapan aja, gak ada TTL/staleness kayak
// jalur teks.
//
// Rekap TANGGAL SPESIFIK (rangeDays berupa string "YYYY-MM-DD", 10 karakter)
// dapet baris EKSTRA di atas baris tombol - dropdown buat ganti tanggal
// tanpa perlu nutup dulu terus buka "rekap tanggal" dari nol. Rekap BULAN
// SPESIFIK (rangeDays string "YYYY-MM", 7 karakter, §10's thirty-sixth item)
// dapet perlakuan sama tapi dropdown-nya nawarin BULAN, bukan tanggal.
// Milih lewat dropdown ini nge-EDIT pesan yang sama (lihat handleRecapDateSelect/
// handleRecapMonthSelect), sama pola in-place-edit-nya kayak tombol
// Maju/Mundur - biar gak numpuk beberapa tabel beda-beda di channel.
//
// Rekap MINGGUAN/BULANAN (rangeDays berupa number ATAU string bulan "YYYY-MM")
// DENGAN lebih dari 1 halaman dapet tombol tambahan "🔢 Lompat halaman"
// (§10's thirty-third item, owner minta) - rentang segitu bisa nyampe
// puluhan halaman kalau membernya banyak yang live tiap hari, dan Maju/Mundur
// satu-satu kelamaan buat lompat jauh (mis. dari halaman 1 ke halaman
// terakhir). BUKAN buat tanggal spesifik/"hari ini" - dua jenis rekap itu
// biasanya jauh lebih pendek (1 hari doang), jarang butuh lompat jauh.
// Dibatesin ke totalPages > 1 doang (nggak ada gunanya nawarin "lompat
// halaman" kalau cuma ada 1 halaman buat dilompatin).
function buildRecapNavComponents(page, totalPages, rangeDays) {
  const range = encodeRecapRange(rangeDays);
  const isMonthRange = typeof rangeDays === "string" && rangeDays.length === 7;
  const buttons = [];
  if (page < totalPages - 1) {
    buttons.push(new ButtonBuilder().setCustomId(`recap_nav:next:${range}:${page}`).setLabel("Maju ▶").setStyle(ButtonStyle.Primary));
  }
  if (page > 0) {
    buttons.push(new ButtonBuilder().setCustomId(`recap_nav:prev:${range}:${page}`).setLabel("◀ Mundur").setStyle(ButtonStyle.Secondary));
  }
  buttons.push(new ButtonBuilder().setCustomId("recap_nav:close").setLabel("Tutup rekap").setStyle(ButtonStyle.Danger));
  buttons.push(new ButtonBuilder().setCustomId(`recap_nav:search:${range}`).setLabel("🔍 Cari member").setStyle(ButtonStyle.Secondary));
  if ((typeof rangeDays === "number" || isMonthRange) && totalPages > 1) {
    buttons.push(new ButtonBuilder().setCustomId(`recap_nav:jump:${range}:${page}`).setLabel("🔢 Lompat halaman").setStyle(ButtonStyle.Secondary));
  }

  const rows = [];
  if (typeof rangeDays === "string") {
    if (isMonthRange) {
      rows.push(buildRecapMonthSelectRow(getAvailableRecapMonths(), rangeDays));
    } else {
      // Tanggal yang di-TAG weekday-nya (dipilih lewat dropdown "cok rekap
      // senin" dkk, lihat komen di buildWeekdayDateSelectRow) harus TETEP
      // nempelin dropdown yang di-filter ke hari itu juga di sini, BUKAN
      // balik ke dropdown semua tanggal - itu bug yang dilaporin owner:
      // dropdown-nya nunjukkin semua hari lagi begitu tabelnya nge-render,
      // padahal user udah eksplisit milih dari dropdown yang di-filter.
      const { date, weekdayIndex } = parseDateRangeValue(rangeDays);
      rows.push(weekdayIndex !== null ? buildWeekdayDateSelectRow(weekdayIndex, rangeDays) : buildRecapDateSelectRow(date));
    }
  }
  rows.push(new ActionRowBuilder().addComponents(buttons));
  return rows;
}

function buildRecapPageBlock(sessions, page, channelId, authorId, rangeDays = null) {
  const result = buildRecapTablePage(sessions, page);
  const footer = `_(Halaman ${result.page + 1}/${result.totalPages})_`;

  if (result.totalPages > 1 && channelId && authorId) {
    pendingRecapPage.set(`${channelId}:${authorId}`, { currentPage: result.page, totalPages: result.totalPages, at: Date.now(), rangeDays });
  }

  return { content: `${result.text}\n${footer}`, components: buildRecapNavComponents(result.page, result.totalPages, rangeDays) };
}

// Dicek di awal chat/router.js's buildChatReply (sama pola kayak
// menu.js's tryHandleWatchConfirmShortcut) - jawaban "y"/"maju"/"mundur"/"n"
// polos buat navigasi halaman rekap gak nyebut "cok"/"live", jadi harus
// ditangkep sebelum gerbang wake-word.
async function tryHandleRecapPageShortcut(text, channelId, authorId) {
  if (!channelId || !authorId) return null;
  const key = `${channelId}:${authorId}`;
  const pending = pendingRecapPage.get(key);
  if (!pending) return null;

  if (Date.now() - pending.at > PENDING_RECAP_PAGE_TTL_MS) {
    pendingRecapPage.delete(key);
    return null;
  }

  // "y" tetep didukung (biar gak ngerusak kebiasaan lama) - NEXT_PAGE_PATTERN
  // ("maju"/"forward"/dst) itu TAMBAHAN, bukan gantiin. Lihat komentar di
  // NEXT_PAGE_PATTERN (utils.js) buat kenapa dipisah dari YES_PATTERN.
  const isNext = YES_PATTERN.test(text) || NEXT_PAGE_PATTERN.test(text);
  const isPrev = PREV_PAGE_PATTERN.test(text);
  const isStop = NO_PATTERN.test(text);
  if (!isNext && !isPrev && !isStop) return null;

  if (isStop) {
    pendingRecapPage.delete(key);
    return "Oke, segitu aja ya.";
  }

  if (isNext && pending.currentPage >= pending.totalPages - 1) {
    return 'Cok, ini udah halaman paling akhir. Balas "mundur" kalau mau balik.';
  }
  if (isPrev && pending.currentPage <= 0) {
    return 'Cok, ini udah halaman pertama, gak bisa mundur lagi. Balas "y"/"maju" kalau mau lanjut.';
  }

  const targetPage = isNext ? pending.currentPage + 1 : pending.currentPage - 1;
  const sessions = getSessionsForRange(pending.rangeDays);
  return buildRecapPageBlock(sessions, targetPage, channelId, authorId, pending.rangeDays);
}

// Diklik dari salah satu tombol buildRecapNavComponents() bikin (customId
// "recap_nav:<next|prev>:<range>:<page>", "recap_nav:search:<range>", atau
// "recap_nav:close" buat tombol tutup yang emang gak butuh konteks apa-apa).
//
// "next"/"prev"/"close" pake interaction.update() (EDIT pesan yang tombolnya
// nempel), BUKAN interaction.reply() (pesan BARU) - beda dari tombol lain di
// codebase ini (menu.js). Dulu dipake reply() juga di sini, tapi owner
// laporin itu bikin channel numpuk 1 pesan tabel PER klik maju/mundur -
// keliatan kayak nge-reply ke pesan yang salah/lama padahal cuma pesan baru
// numpuk di bawahnya. update() nge-edit di tempat, jadi cuma ADA SATU pesan
// tabel per sesi rekap sepanjang orangnya masih maju-mundur, mau berapa kali
// pun diklik.
async function handleRecapNavButton(interaction) {
  const parts = interaction.customId.split(":");
  const action = parts[1];

  if (action === "close") {
    // Bersihin pending state teks juga - abis "tutup rekap", jawaban "y"/
    // "mundur" nyasar berikutnya (misal orangnya lupa) gak boleh diem-diem
    // nerusin ke halaman rekap yang udah "ditutup".
    pendingRecapPage.delete(`${interaction.channelId}:${interaction.user.id}`);
    // §10's thirty-fifth item - dulu diedit jadi teks "Terima kasih..." +
    // components:[], sekarang BENERAN ngehapus pesannya (deleteInteractionMessage),
    // sama logika "tutup" yang sekarang konsisten di seluruh bot (menu 9-opsi,
    // dropdown 4/9, watch-confirm, channel khusus member).
    await deleteInteractionMessage(interaction);
    return;
  }

  // Diklik dari tombol "Ya, biarin"/"Enggak, hapus aja" yang nempel di
  // BALESAN PENCARIAN (lihat buildKeepOrDeleteRecapComponents di bawah) -
  // owner ngeluh tabel rekap ASLI (yang tombol "🔍 Cari member"-nya diklik)
  // tetep numpang di channel walau yang dicari udah ketemu, jadi ditanya
  // eksplisit abis nunjukkin hasil cari. customId-nya bawa ID pesan rekap
  // ASLI itu (dari interaction.message punya modal submission, lihat
  // handleRecapSearchModalSubmit) - "delrecap" hapus pesan itu by ID
  // (gak perlu fetch dulu, channel.messages.delete nerima ID langsung),
  // "keeprecap" gak ngapa-ngapain selain nutup pertanyaannya. Dua-duanya
  // ngedit BALESAN PENCARIAN ini sendiri (interaction.update, bukan pesan
  // baru) buat ngilangin tombol Ya/Enggak-nya abis dijawab - konsisten sama
  // pola "close" di atas.
  if (action === "keeprecap" || action === "delrecap") {
    if (action === "delrecap") {
      const originalMessageId = parts[2];
      pendingRecapPage.delete(`${interaction.channelId}:${interaction.user.id}`);
      if (originalMessageId && interaction.channel) {
        await interaction.channel.messages.delete(originalMessageId).catch(() => {});
      }
    }
    await interaction.update(safeReplyOptions({ content: interaction.message.content, components: [] }));
    return;
  }

  const rangeDays = decodeRecapRange(parts[2]);

  if (action === "search") {
    const modal = new ModalBuilder()
      .setCustomId(`recap_search_modal:${parts[2]}`)
      .setTitle("Cari member di rekap")
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId("member_name")
            .setLabel("Nama member")
            .setStyle(TextInputStyle.Short)
            .setPlaceholder("misal: Nala")
            .setRequired(true),
        ),
      );
    await interaction.showModal(modal);
    return;
  }

  // "🔢 Lompat halaman" (§10's thirty-third item) - customId-nya bawa
  // halaman SEKARANG (parts[3]) buat modal-nya, dipake sebagai fallback kalau
  // input yang diketik ternyata gak keparse (lihat handleRecapJumpModalSubmit)
  // biar gagal parse gak numpuk pesan baru ATAU nge-reset ke halaman 1.
  if (action === "jump") {
    const modal = new ModalBuilder()
      .setCustomId(`recap_jump_modal:${parts[2]}:${parts[3]}`)
      .setTitle("Lompat ke halaman")
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId("page_number")
            .setLabel("Halaman berapa?")
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('Angka (misal "5"), atau "awal"/"akhir"')
            .setRequired(true),
        ),
      );
    await interaction.showModal(modal);
    return;
  }

  // Sesi-nya di-ambil ULANG dari sumbernya (bukan snapshot lama) - sama
  // alasannya kayak tryHandleRecapPageShortcut di atas, dan buildRecapTablePage
  // sendiri udah nge-clamp target page ke totalPages TERKINI, jadi aman
  // walau datanya berubah (mis. ada live yang baru aja selesai) sejak
  // tombol ini pertama kali ditampilin.
  const sessions = getSessionsForRange(rangeDays);
  const currentPage = Number(parts[3]);
  const targetPage = action === "next" ? currentPage + 1 : currentPage - 1;
  await interaction.update(safeReplyOptions(buildRecapPageBlock(sessions, targetPage, interaction.channelId, interaction.user.id, rangeDays)));
}

// Balesan buat "cok rekap tanggal" DAN buat tombol "Rekap per tanggal"
// (lihat replyRecapMenu/handleRecapMenuButton di bawah) - dua-duanya
// nunjukkin dropdown yang SAMA persis, jadi digabung ke satu fungsi biar
// gak didobelin. Belum ada tabel apa-apa di sini (belum ada tanggal
// kepilih) - cuma dropdown + tombol tutup, tabelnya baru muncul abis milih
// lewat handleRecapDateSelect.
function buildRecapDatePickerBlock() {
  return { content: "Rekap tanggal berapa nih, cok?", components: [buildRecapDateSelectRow(), buildCloseOnlyRow()] };
}

function replyRecapDatePicker() {
  return buildRecapDatePickerBlock();
}

// Balesan buat "cok rekap" POLOS (gak nyebut "minggu"/"bulan"/"tanggal"/
// "hari ini" sama sekali) - owner minta ini dikasih pilihan tombol dulu
// daripada langsung nembak rekap hari ini kayak sebelumnya, biar user gak
// kesusahan mikirin mau ketik apa buat tiap jenis rekap. Tombol "Tutup"
// (§10's thirty-sixth item) numpang di baris yang sama - masih di bawah
// limit 5 tombol/baris Discord (4 opsi + 1 tutup) - biar user yang salah
// pencet/salah ketik bisa langsung nutup tanpa harus milih salah satu opsi
// rekap dulu. customId-nya "recap_nav:close" (bukan bikin varian baru) biar
// nyambung ke logika tutup yang SAMA (deleteInteractionMessage) kayak semua
// tombol Tutup lain di bot ini - router.js dispatch berdasarkan PREFIX
// customId ("recap_nav:"), jadi tombol ini valid dipencet walau nempel di
// pesan menu 4-opsi, bukan di tabel rekap.
function replyRecapMenu() {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("recap_menu:today").setLabel("Rekap hari ini").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("recap_menu:week").setLabel("Rekap minggu ini").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("recap_menu:month").setLabel("Rekap bulan ini").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("recap_menu:date").setLabel("Rekap per tanggal").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("recap_nav:close").setLabel("Tutup").setStyle(ButtonStyle.Danger),
  );
  return { content: "Mau rekap yang mana, cok?", components: [row] };
}

// Diklik dari salah satu tombol replyRecapMenu() bikin (customId
// "recap_menu:<today|week|month|date>") - EDIT pesan menu-nya sendiri jadi
// hasil rekap yang dipilih (interaction.update, sama pola-nya kayak
// handleRecapNavButton), bukan pesan baru. pendingRecapPage dibersihin dulu
// SEBELUM manggil fungsi rekapnya - jaga-jaga kalau orangnya sebelumnya lagi
// di tengah nge-page-in rekap laen di channel+author yang sama (state lama
// itu bakal ke-timpa otomatis kalau hasil rekap baru ini multi-halaman, tapi
// KALAU ternyata cuma 1 halaman, state lama bisa nyangkut basi - dibersihin
// eksplisit di sini biar gak ada celah itu sama sekali).
async function handleRecapMenuButton(interaction) {
  const choice = interaction.customId.split(":")[1];
  pendingRecapPage.delete(`${interaction.channelId}:${interaction.user.id}`);

  if (choice === "date") {
    await interaction.update(safeReplyOptions(buildRecapDatePickerBlock()));
    return;
  }

  let reply;
  if (choice === "today") reply = await replyTodayRecapSoFar(interaction.channelId, interaction.user.id);
  else if (choice === "week") reply = await replyRecapRange(7, "minggu ini", interaction.channelId, interaction.user.id);
  else if (choice === "month") reply = await replyRecapMonth(getTodayWIB().slice(0, 7), interaction.channelId, interaction.user.id);
  else return;

  await interaction.update(safeReplyOptions(reply));
}

// Diklik dari dropdown buildRecapDateSelectRow() bikin (customId
// "recap_date_select", nempel baik di balesan buildRecapDatePickerBlock()
// MAUPUN di tabel rekap tanggal yang lagi ditampilin, lihat
// buildRecapNavComponents). Milih tanggal (lagi/baru) NGE-EDIT pesan yang
// sama (interaction.update) - itu persis yang owner minta: "kalo misalnya
// pengen ubah tanggal dari dropdown itu, maka tabel tanggal sebelumnya
// di-delete biar pesannya gak berganda" - di sini "dihapus"-nya dengan cara
// DI-TIMPA di tempat, bukan pesan lama dihapus + pesan baru dikirim (sama
// filosofinya kayak Maju/Mundur di atas).
//
// Kalau tanggal yang dipilih ternyata gak ada sesi sama sekali, dropdown +
// tombol tutup TETEP ditampilin (bukan diganti pesan polos tanpa komponen)
// biar user bisa langsung coba tanggal lain tanpa harus ngetik "rekap
// tanggal" dari awal lagi.
//
// `interaction.values[0]` bisa berupa tanggal POLOS ("YYYY-MM-DD", dari
// dropdown "rekap tanggal" biasa) ATAU tanggal yang di-TAG weekday-nya
// ("YYYY-MM-DD#W", dari dropdown "cok rekap senin" dkk - lihat
// buildWeekdayDateSelectRow/parseDateRangeValue) - `selectedRange` di bawah
// nyimpen NILAI MENTAHNYA (buat diterusin apa adanya ke getSessionsForRange/
// buildRecapPageBlock, biar tag-nya ikut ke-bawa ke tombol Maju/Mundur/dst),
// sementara `date` udah dilucutin tag-nya (buat format label/Date beneran -
// nge-parse "2026-09-14#1T00:00:00+07:00" bakal jadi Invalid Date dan bikin
// Intl.DateTimeFormat.format() THROW).
async function handleRecapDateSelect(interaction) {
  const selectedRange = interaction.values[0];
  const { date, weekdayIndex } = parseDateRangeValue(selectedRange);
  pendingRecapPage.delete(`${interaction.channelId}:${interaction.user.id}`);

  // getSessionsForRange (bukan getCompletedSessionsForDate langsung) - kalau
  // selectedDate kebetulan HARI INI (sekarang bisa dipilih, lihat komen di
  // buildRecapDateSelectRow), ini otomatis ikut gabung sesi yang MASIH LIVE
  // dari activeLives juga, sama kayak tombol "Rekap hari ini".
  const sessions = getSessionsForRange(selectedRange);
  const label = formatLongDateWIB(new Date(`${date}T00:00:00+07:00`));

  if (sessions.length === 0) {
    // BUG SEBELUMNYA (dilaporin owner): dropdown fallback di sini SELALU
    // buildRecapDateSelectRow (semua tanggal), walau tanggal yang barusan
    // dipilih datang dari dropdown weekday - begitu tabelnya "kosong",
    // filter weekday-nya ilang. Sekarang nempelin balik dropdown yang SAMA
    // (di-filter ke weekday itu lagi) kalau memang asalnya dari situ.
    const dateRow = weekdayIndex !== null ? buildWeekdayDateSelectRow(weekdayIndex, selectedRange) : buildRecapDateSelectRow(date);
    await interaction.update(
      safeReplyOptions({
        content: `Cok, belum ada live yang kecatet tanggal ${label}.`,
        components: [dateRow, buildCloseOnlyRow()],
      }),
    );
    return;
  }

  const block = buildRecapPageBlock(sessions, 0, interaction.channelId, interaction.user.id, selectedRange);
  await interaction.update(safeReplyOptions({ content: `📋 **Rekap tanggal ${label}**\n${block.content}`, components: block.components }));
}

// Diklik dari dropdown buildRecapMonthSelectRow() bikin (customId
// "recap_month_select", nempel baik di balesan dropdown "cok rekap bulan"
// polos MAUPUN di tabel rekap bulan yang lagi ditampilin, lihat
// buildRecapNavComponents) - §10's thirty-sixth item. Sama pola in-place-edit-nya
// kayak handleRecapDateSelect di atas, cuma granularitasnya bulan.
async function handleRecapMonthSelect(interaction) {
  const selectedMonth = interaction.values[0];
  pendingRecapPage.delete(`${interaction.channelId}:${interaction.user.id}`);
  const reply = await replyRecapMonth(selectedMonth, interaction.channelId, interaction.user.id);
  await interaction.update(safeReplyOptions(reply));
}

// Ditempelin di balesan hasil pencarian (handleRecapSearchModalSubmit di
// bawah) - owner ngeluh tabel rekap ASLI tetep numpang di channel padahal
// yang dicari udah ketemu lewat hasil pencarian ini. `originalMessageId`
// datang dari interaction.message punya MODAL SUBMISSION (cuma keisi kalau
// modal-nya dibuka dari tombol yang NEMPEL DI SEBUAH PESAN - persis kasus
// kita, "🔍 Cari member" nempel di tabel rekap) - null kalau entah gimana
// gak keisi (defensif), jadi baris tombolnya dilewatin aja (gak ada apa-apa
// buat dihapus/dipertahanin kalau ID pesannya sendiri gak ke-ketahuan).
function buildKeepOrDeleteRecapComponents(originalMessageId) {
  if (!originalMessageId) return null;
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`recap_nav:keeprecap:${originalMessageId}`).setLabel("Ya, biarin").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`recap_nav:delrecap:${originalMessageId}`).setLabel("Enggak, hapus aja").setStyle(ButtonStyle.Danger),
  );
  return [row];
}

// Diklik abis submit modal yang dimunculin tombol "🔍 Cari member" di atas -
// filter sesi dari RENTANG yang SAMA kayak tabel asalnya (dibawa lewat
// customId modal-nya, bukan ditebak ulang) ke satu member doang, dicari
// lewat nama depan (pola matching yang sama kayak findDurationHistoryByNameFragment
// dkk di storage/). Balesan ini SENGAJA gak dikasih tombol navigasi lagi -
// hasil pencarian 1 member jarang lebih dari 1 halaman, jadi diringkes,
// beda dari tabel rekap penuh yang emang perlu navigasi banyak halaman.
// Nanya "rekap sebelumnya masih mau ditampilin?" abis nunjukkin hasil -
// baik ketemu MAUPUN gak ketemu, soalnya di dua-duanya tabel rekap ASLI
// masih numpang di atasnya kalau gak dibersihin.
async function handleRecapSearchModalSubmit(interaction) {
  const range = interaction.customId.split(":")[1];
  const rangeDays = decodeRecapRange(range);
  const query = interaction.fields.getTextInputValue("member_name").trim();

  const sessions = getSessionsForRange(rangeDays);
  const needle = query.toLowerCase();
  const matched = sessions.filter((s) => s.name && matchesNameFragment(needle, s.name.split(/[\s|]+/)[0].toLowerCase()));

  const components = buildKeepOrDeleteRecapComponents(interaction.message?.id);
  const askText = components ? "\n\nRekap sebelumnya masih mau ditampilin?" : "";

  if (matched.length === 0) {
    const reply = { content: `Cok, gak nemu member "${query}" di rekap ini.${askText}` };
    if (components) reply.components = components;
    await interaction.reply(safeReplyOptions(reply));
    return;
  }

  const { text, hasMore } = buildRecapTablePage(matched, 0);
  const moreNote = hasMore ? `\n_(cuma nunjukkin 20 sesi pertama dari ${matched.length})_` : "";
  const reply = { content: `🔍 Hasil cari "${query}":\n${text}${moreNote}${askText}` };
  if (components) reply.components = components;
  await interaction.reply(safeReplyOptions(reply));
}

// "awal"/"pertama" dan "akhir"/"terakhir" (Indonesia) DAN "first"/"last"
// (jaga-jaga ada yang ngetik Inggris) diterima sebagai alias, biar gak harus
// ngitung sendiri "halaman terakhir itu halaman berapa" - "akhir" ditangani
// dengan cukup ngasih angka BESAR (bukan hitung totalPages di sini juga),
// buildRecapTablePage sendiri udah nge-clamp ke totalPages-1 apapun angka
// yang dikasih, jadi angka gede itu otomatis kepotong pas ke halaman
// terakhir yang beneran ada - gak perlu tau totalPages duluan di sini.
const JUMP_FIRST_WORDS = ["awal", "pertama", "first"];
const JUMP_LAST_WORDS = ["akhir", "terakhir", "last"];

// Diklik dari tombol "🔢 Lompat halaman" (buildRecapNavComponents) abis
// submit modal-nya. Diklik dari MODAL (bukan tombol langsung) soalnya
// Discord gak punya cara nerima input teks bebas dari sebuah tombol -
// modal cuma cara buat itu, sama pola-nya kayak "🔍 Cari member" di atas.
// BEDA dari search modal: search SENGAJA pake interaction.reply() (pesan
// BARU, biar tabel asalnya masih keliatan buat dibandingin) - lompat
// halaman JUSTRU maksudnya NAVIGASI tabel yang sama ke halaman lain, jadi
// pake interaction.update() (EDIT pesan yang sama), sama pola-nya kayak
// tombol Maju/Mundur, BUKAN kayak search.
//
// Input yang gak keparse SAMA SEKALI (bukan angka, bukan salah satu alias
// di atas) TETEP interaction.update() balik ke HALAMAN SEKARANG (dibawa
// lewat customId-nya, parts[2] - lihat handleRecapNavButton's "jump"
// branch) plus catetan singkat kenapa gak pindah, bukan reply() pesan error
// terpisah - biar tetep 1 pesan yang sama yang keurus, konsisten sama
// prinsip in-place-edit fitur rekap ini secara keseluruhan.
async function handleRecapJumpModalSubmit(interaction) {
  const parts = interaction.customId.split(":");
  const rangeDays = decodeRecapRange(parts[1]);
  const currentPage = Number(parts[2]);
  const raw = interaction.fields.getTextInputValue("page_number").trim().toLowerCase();

  const sessions = getSessionsForRange(rangeDays);

  let targetPage;
  let note = "";
  if (JUMP_FIRST_WORDS.includes(raw)) {
    targetPage = 0;
  } else if (JUMP_LAST_WORDS.includes(raw)) {
    targetPage = Number.MAX_SAFE_INTEGER; // di-clamp ke halaman terakhir yang beneran ada oleh buildRecapTablePage
  } else {
    const parsed = Number(raw);
    if (Number.isInteger(parsed) && parsed >= 1) {
      targetPage = parsed - 1; // input user 1-based, index halaman internal 0-based
    } else {
      targetPage = currentPage;
      note = `\n_(Gak ngerti "${interaction.fields.getTextInputValue("page_number").trim()}" - tetep di halaman sekarang. Ketik angka halaman, "awal", atau "akhir".)_`;
    }
  }

  const block = buildRecapPageBlock(sessions, targetPage, interaction.channelId, interaction.user.id, rangeDays);
  await interaction.update(safeReplyOptions({ content: `${block.content}${note}`, components: block.components }));
}

// Versi on-demand dari rekap harian otomatis (yang ngirim sendiri jam 23:00
// WIB) - ini dipanggil kapan aja user nanya, nunjukkin progress SEJAUH INI
// (live yang masih berlangsung belum ikut ke-hitung, baru masuk pas selesai).
// Async karena nyoba lengkapin data lokal pakai arsip eksternal. Kalau
// arsipnya gak keambil (network error/dll), fungsi ini tetep balikin rekap
// versi lokal doang - gak pernah gagal total gara-gara sumber tambahan ini.
async function replyTodayRecapSoFar(channelId, authorId) {
  const sessions = getTodaySessionsForRecap();
  const completed = sessions.filter((s) => s.endedAtUnix !== null);
  const ongoingCount = sessions.length - completed.length;

  // Member yang KETAUAN live hari ini dari arsip eksternal, tapi beneran gak
  // ke-track lokal sama sekali (bukan cuma "masih live", tapi bot-nya emang
  // kelewatan momennya - mis. sempet mati/restart pas dia live).
  const trackedNames = new Set(sessions.map((s) => s.name));
  const external = await fetchExternalTodayLiveHistory();
  const missedByMember = new Map();
  for (const e of external || []) {
    if (trackedNames.has(e.creator_name) || activeLives.has(e.username)) continue;
    if (!missedByMember.has(e.creator_name)) missedByMember.set(e.creator_name, e);
  }
  const missedNote =
    missedByMember.size > 0
      ? `\n\n📡 Dari arsip publik JKT48Live-Record, ketauan juga live hari ini yang kelewatan bot: ${[...missedByMember.entries()]
          .map(([name, e]) => `**${name}** (${formatClockWIB(new Date(e.live_at_unix * 1000))})`)
          .join(", ")} - durasinya belum ke-track soalnya bot nggak nyaksiin dari awal sampai selesai.`
      : "";

  if (sessions.length === 0) {
    return `Cok, belum ada yang live hari ini (${getTodayWIB()}).${missedNote}`;
  }

  const totalDurationMs = completed.reduce((sum, s) => sum + s.durationMs, 0);
  const uniqueMembers = new Set(sessions.map((s) => s.name)).size;
  const longest = completed.length > 0 ? completed.reduce((max, s) => (s.durationMs > max.durationMs ? s : max), completed[0]) : null;

  const summaryLines = [
    `📋 **Rekap live hari ini (${getTodayWIB()})**`,
    `Total sesi: ${sessions.length}x dari ${uniqueMembers} member (${completed.length} udah selesai, ${ongoingCount} masih live)`,
  ];
  if (longest) {
    summaryLines.push(
      `Total durasi (yang udah selesai): ${formatDuration(totalDurationMs)} | Paling lama: **${longest.name}** (${formatDuration(longest.durationMs)})`,
    );
  }

  const block = buildRecapPageBlock(sessions, 0, channelId, authorId);
  return { content: [summaryLines.join("\n"), block.content].join("\n") + missedNote, components: block.components };
}

// Rekap mingguan/bulanan - beda dari replyTodayRecapSoFar cuma dalam 1 hal
// sekarang (dulu ada 2, lihat BUG SEBELUMNYA di bawah): gak perlu cek arsip
// eksternal (JKT48Live-Record) - itu arsipnya emang cuma nyimpen bulan
// berjalan, gak didesain buat query rentang lebih lebar.
//
// BUG SEBELUMNYA (dilaporin owner, §10's thirty-third item): dulu memang
// SENGAJA gak digabung sama activeLives - alasannya "member yang lagi live
// sekarang bukan bagian dari '7 hari terakhir', itu bagian dari HARI INI,
// bakal numpang di sini juga begitu dia beneran selesai". Alasan itu salah:
// live yang lagi berlangsung SEKARANG sudah pasti mulai dalam beberapa jam
// terakhir, yang jelas-jelas masuk 7/30 hari terakhir juga - nunggu dia
// selesai dulu baru muncul di rekap minggu/bulan ini bikin tabelnya
// keliatan "kelewatan" siapa yang lagi live pas ditanya. Sekarang sesi yang
// masih live ikut digabung (getSessionsForRange, bukan getCompletedSessionsSince
// langsung) - tapi cuma buat DITAMPILIN di tabel; angka ringkasan (total
// durasi, siapa yang paling lama) TETEP dihitung dari yang UDAH SELESAI
// doang (`completed`, bukan `sessions`) - sesi yang masih jalan durasinya
// belum final, sama pola-nya kayak replyTodayRecapSoFar yang udah lebih
// dulu misahin `completed`/`sessions` buat alasan yang sama.
async function replyRecapRange(daysBack, label, channelId, authorId) {
  const completed = getCompletedSessionsSince(daysBack);
  const ongoing = getOngoingSessionsForRecap();
  const sessions = [...completed, ...ongoing];
  if (sessions.length === 0) {
    return `Cok, belum ada live yang kecatet dalam ${label}.`;
  }

  const totalDurationMs = completed.reduce((sum, s) => sum + s.durationMs, 0);
  const uniqueMembers = new Set(sessions.map((s) => s.name)).size;
  const longest = completed.length > 0 ? completed.reduce((max, s) => (s.durationMs > max.durationMs ? s : max), completed[0]) : null;

  const summaryLines = [
    `📋 **Rekap ${label}**`,
    `Total sesi: ${sessions.length}x dari ${uniqueMembers} member (${completed.length} udah selesai, ${ongoing.length} masih live)`,
  ];
  if (longest) {
    summaryLines.push(
      `Total durasi gabungan: ${formatDuration(totalDurationMs)} | Paling lama: **${longest.name}** (${formatDuration(longest.durationMs)})`,
    );
  }

  // Arsip multi-hari ini masih baru (lihat storage/dailyLog.js's
  // getEarliestSessionDate) - kalau rentang yang diminta (7/30 hari) mundur
  // lebih jauh dari data paling tua yang beneran ada, kasih tau KENAPA
  // rekapnya keliatan pendek daripada diem-diem keliatan kayak ada yang bug.
  const windowStartDate = getDateWIB(new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000));
  const earliestDate = getEarliestSessionDate();
  if (earliestDate && earliestDate > windowStartDate) {
    summaryLines.push(
      `_(Catatan: pencatatan multi-hari baru mulai ${earliestDate}, jadi rentang ${daysBack} hari ini belum penuh - bakal lengkap sendirinya seiring bot jalan terus.)_`,
    );
  }

  const block = buildRecapPageBlock(sessions, 0, channelId, authorId, daysBack);
  return { content: [summaryLines.join("\n"), block.content].join("\n"), components: block.components };
}

// Rekap PER BULAN SPESIFIK (§10's thirty-sixth item) - dipanggil baik dari
// teks yang nyebut nama bulan langsung ("cok rekap september"), dari tombol
// "Rekap bulan ini" di replyRecapMenu (selalu bulan BERJALAN), MAUPUN dari
// dropdown bulan (replyRecapMonthGeneric/handleRecapMonthSelect) - satu
// fungsi buat semua jalur itu, sama filosofinya kayak getSessionsForRange
// buat sumber sesinya.
//
// Kalau bulan yang diminta ternyata kosong (belum ada live yang kecatet sama
// sekali di situ), fallback-nya BEDA tergantung ada berapa banyak bulan lain
// yang punya data: kalau lebih dari 1, tawarin dropdown bulan lain (lebih
// membantu daripada nyuruh user nebak-nebak lagi) - kalau cuma bulan ini
// doang yang ada (kasus paling umum sekarang, arsipnya masih baru), gak ada
// gunanya nawarin dropdown isi 1 opsi, jadi jatuh ke menu 4-opsi biasa.
async function replyRecapMonth(monthWIB, channelId, authorId) {
  pendingRecapPage.delete(`${channelId}:${authorId}`);
  const label = formatMonthLabel(monthWIB);
  const sessions = getSessionsForRange(monthWIB);

  if (sessions.length === 0) {
    const months = getAvailableRecapMonths();
    if (months.length > 1) {
      return {
        content: `Cok, belum ada live yang kecatet buat bulan ${label}. Coba bulan lain, cok:`,
        components: [buildRecapMonthSelectRow(months, monthWIB), buildCloseOnlyRow()],
      };
    }
    const menu = replyRecapMenu();
    return { content: `Cok, belum ada live yang kecatet buat bulan ${label}.\n\n${menu.content}`, components: menu.components };
  }

  const completed = sessions.filter((s) => s.endedAtUnix !== null);
  const ongoingCount = sessions.length - completed.length;
  const totalDurationMs = completed.reduce((sum, s) => sum + s.durationMs, 0);
  const uniqueMembers = new Set(sessions.map((s) => s.name)).size;
  const longest = completed.length > 0 ? completed.reduce((max, s) => (s.durationMs > max.durationMs ? s : max), completed[0]) : null;

  const summaryLines = [
    `📋 **Rekap bulan ${label}**`,
    `Total sesi: ${sessions.length}x dari ${uniqueMembers} member (${completed.length} udah selesai, ${ongoingCount} masih live)`,
  ];
  if (longest) {
    summaryLines.push(
      `Total durasi gabungan: ${formatDuration(totalDurationMs)} | Paling lama: **${longest.name}** (${formatDuration(longest.durationMs)})`,
    );
  }

  const block = buildRecapPageBlock(sessions, 0, channelId, authorId, monthWIB);
  return { content: [summaryLines.join("\n"), block.content].join("\n"), components: block.components };
}

// Balesan buat "cok rekap bulan" POLOS (nyebut "bulan" tapi TANPA nama bulan
// spesifik DAN tanpa "ini") - §10's thirty-sixh item, owner minta: kalau
// arsipnya cuma punya 1 bulan (kasus sekarang, baru mulai September),
// langsung tunjukkin bulan itu tanpa nanya-nanya - begitu ada lebih dari 1
// bulan yang punya data (bot-nya udah jalan lebih dari sebulan), baru
// ditawarin dropdown milih bulan yang mana.
async function replyRecapMonthGeneric(channelId, authorId) {
  const months = getAvailableRecapMonths();
  if (months.length === 1) {
    return await replyRecapMonth(months[0], channelId, authorId);
  }
  return { content: "Rekap bulan berapa nih, cok?", components: [buildRecapMonthSelectRow(months), buildCloseOnlyRow()] };
}

// Rekap TANGGAL SPESIFIK yang lengkap disebut user sendiri di teksnya (mis.
// "cok rekap 25 september") - §10's thirty-sixth item, laporan owner:
// sebelumnya kalimat kayak gitu diem-diem jatuh ke "rekap polos" (menu
// 4-opsi), padahal user udah eksplisit nyebut tanggalnya, jadi harusnya
// langsung ditunjukkin tabelnya. Kalau tanggalnya ternyata gak ada datanya
// (di luar rentang yang kecatet - baik KESELURUHAN bot baru mulai 13
// September, ATAU sekadar tanggal itu kebetulan gak ada yang live), dikasih
// tau jujur + fallback ke menu 4-opsi biasa (persis diminta owner), BUKAN
// diem-diem nunjukkin tabel kosong.
async function replyRecapSpecificDate(dateWIB, channelId, authorId) {
  pendingRecapPage.delete(`${channelId}:${authorId}`);
  const label = formatLongDateWIB(new Date(`${dateWIB}T00:00:00+07:00`));
  const sessions = getSessionsForRange(dateWIB);

  if (sessions.length === 0) {
    const menu = replyRecapMenu();
    return {
      content: `Cok, gak ada data rekap buat tanggal ${label} (di luar rentang yang kecatet, atau emang belum ada yang live). ${menu.content}`,
      components: menu.components,
    };
  }

  const block = buildRecapPageBlock(sessions, 0, channelId, authorId, dateWIB);
  return { content: `📋 **Rekap tanggal ${label}**\n${block.content}`, components: block.components };
}

// Balesan buat "cok rekap hari senin"/"cok rekap senin" dkk (§10's
// thirty-sixth item) - BUKAN langsung nunjukkin tabel (beda dari tanggal
// spesifik di atas), soalnya "Senin" itu sendiri gak nunjuk ke SATU tanggal
// pasti - bisa Senin minggu ini, minggu lalu, dst. Jadi ditawarin dropdown
// tanggal-tanggal Senin yang beneran ada di rentang yang kecatet
// (findRecentDatesForWeekday), user tinggal milih yang mana. Kalau ternyata
// gak ada SATU PUN tanggal hari itu yang kecatet (arsipnya masih terlalu
// baru), dikasih tau jujur - dropdown gak mungkin ditampilin kosong
// (StringSelectMenu Discord butuh minimal 1 opsi).
async function replyRecapWeekdayPicker(weekdayIndex) {
  const dayLabel = WEEKDAY_NAMES_ID[weekdayIndex];
  const dates = findRecentDatesForWeekday(weekdayIndex);
  if (dates.length === 0) {
    return `Cok, belum ada tanggal hari ${dayLabel} yang kecatet (arsipnya masih terlalu baru).`;
  }
  return { content: `${dayLabel} tanggal berapa nih, cok?`, components: [buildWeekdayDateSelectRow(weekdayIndex), buildCloseOnlyRow()] };
}

function replyMemberStats(fragment) {
  const found = findDurationHistoryByNameFragment(fragment);
  if (!found || found.entries.length === 0) {
    return `Cok, belum ada data riwayat live buat "${fragment.trim()}".`;
  }

  const durations = found.entries.map((e) => e.durationMs);
  const total = durations.reduce((a, b) => a + b, 0);
  const avg = total / durations.length;
  const max = Math.max(...durations);

  return [
    `📊 Statistik **${found.displayName}** (${durations.length} live terakhir yang ke-track):`,
    `- Rata-rata durasi: ${formatDuration(avg)}`,
    `- Rekor terlama: ${formatDuration(max)}`,
  ].join("\n");
}

// Beda dari replyMemberStats di atas (yang datanya dibatesin 10 live
// TERAKHIR buat ngitung rata-rata/rekor) - ini counter TOTAL yang gak
// pernah di-prune/reset (storage/liveCount.js), jadi bisa jawab "udah
// berapa kali live SEMENJAK bot ini jalan", bukan cuma dari histori terbatas.
function replyLiveCount(fragment) {
  const name = (fragment || "").trim();
  if (!name) return 'Live count siapa? Ketik nama membernya juga ya, misal "cok berapa kali nala live".';

  const found = findLiveCountByNameFragment(name);
  if (!found) return `Cok, belum ada catatan live buat "${name}" semenjak bot ini jalan.`;

  const sinceText = getDateWIB(new Date(found.firstLiveAt));
  const lastText = formatRelativeTime(new Date(found.lastLiveAt));
  return `📊 **${found.name}** udah live **${found.count}x** semenjak bot ini mulai mantau (dari ${sinceText}). Terakhir live ${lastText}.`;
}

// Beda lagi dari replyLiveCount (satu member spesifik) - ini leaderboard
// SEMUA member sekaligus, diurutin dari yang paling sering live. Sumbernya
// sama (storage/liveCount.js, counter TOTAL yang gak pernah di-prune).
function replyLiveCountLeaderboard() {
  const top = getLiveCountLeaderboard(10);
  if (top.length === 0) return "Cok, belum ada catatan live sama sekali semenjak bot ini jalan.";

  const medals = ["🥇", "🥈", "🥉"];
  const lines = top.map((entry, i) => `${medals[i] || `${i + 1}.`} **${entry.name}** - ${entry.count}x live`);
  return `📊 Paling sering live semenjak bot ini jalan:\n${lines.join("\n")}`;
}

// PENTING: IDN nggak nyediain jadwal live resmi sama sekali (udah dicek
// langsung ke API-nya). Jadi ini PURE statistik dari histori kita SENDIRI
// (live-duration-history.json, maks 10 entry terakhir per orang) - bukan
// jaminan/jadwal pasti, bisa aja meleset kalau pola live-nya emang nggak
// tetap. live-duration-history.json cuma nyimpen timestamp SELESAI (`at`)
// + durasinya, BUKAN timestamp mulai eksplisit - jadi waktu MULAI live
// diperkirakan mundur (at - durationMs), bukan dibaca langsung dari field.
function replySchedulePattern(fragment) {
  const found = findDurationHistoryByNameFragment(fragment);
  if (!found || found.entries.length === 0) {
    return `Cok, belum ada riwayat live buat "${fragment.trim()}" - belum bisa nebak polanya.`;
  }

  const { entries, displayName } = found;
  if (entries.length < 3) {
    return `Cok, riwayat **${displayName}** baru ada ${entries.length}x - masih kurang buat nebak pola jadwalnya (minimal 3x live yang ke-track). Coba tanya lagi lain kali.`;
  }

  const startTimes = entries.map((e) => new Date(new Date(e.at).getTime() - e.durationMs));
  const total = startTimes.length;

  const bucketCounts = {};
  const weekdayCounts = {};
  const hoursByBucket = {};
  for (const startDate of startTimes) {
    const hourWIB = getHourWIBOf(startDate);
    const bucket = getTimeOfDayBucket(hourWIB);
    bucketCounts[bucket] = (bucketCounts[bucket] || 0) + 1;
    (hoursByBucket[bucket] = hoursByBucket[bucket] || []).push(hourWIB);

    const weekday = WEEKDAY_FORMATTER_WIB.format(startDate);
    weekdayCounts[weekday] = (weekdayCounts[weekday] || 0) + 1;
  }

  const [topBucketName, topBucketCount] = Object.entries(bucketCounts).sort((a, b) => b[1] - a[1])[0];
  const [topWeekdayName, topWeekdayCount] = Object.entries(weekdayCounts).sort((a, b) => b[1] - a[1])[0];

  // "malam" ngerangkum jam 18-23 SAMA 0-3 (lewat tengah malam) - kalau
  // dihitung range min/max mentah, itu bisa keliatan salah ("00-23", nutupin
  // seharian) padahal beneran cuma sekelompok jam malam yang nyambung lewat
  // pergantian hari. Digeser +24 dulu buat jam dini hari (0-3) biar urutannya
  // bener secara matematis, baru di-mod 24 lagi pas ditampilin.
  const rawHours = hoursByBucket[topBucketName];
  const rangeHours = topBucketName === "malam" ? rawHours.map((h) => (h < 4 ? h + 24 : h)) : rawHours;
  const rangeMin = Math.min(...rangeHours) % 24;
  const rangeMax = Math.max(...rangeHours) % 24;
  const pad2 = (n) => String(n).padStart(2, "0");

  const lines = [
    `📅 Pola live **${displayName}** (dari ${total} live terakhir yang ke-track):`,
    `- Paling sering **${topBucketName}**, sekitar jam ${pad2(rangeMin)}-${pad2(rangeMax)} WIB (${topBucketCount}/${total}x)`,
  ];
  if (topWeekdayCount / total >= 0.4) {
    lines.push(`- Hari yang sering: **${topWeekdayName}** (${topWeekdayCount}/${total}x)`);
  }
  lines.push("_(Pola dari histori doang, BUKAN jadwal resmi - IDN nggak nyediain jadwal, jadi bisa aja meleset.)_");

  return lines.join("\n");
}

// PENTING: ini SNAPSHOT (foto sesaat), bukan live/real-time. Bot ini sendiri
// nggak pernah manggil API top-gifter (butuh login pribadi) - datanya cuma
// seakurat terakhir kali kamu jalanin "npm run cek-gifter" manual, jadi
// selalu dikasih tau "dicek X lalu" biar orang gak salah kira ini real-time.
function formatGifterSnapshotReply(found) {
  const checkedText = formatRelativeTime(new Date(found.checkedAt));
  if (!found.gifters || found.gifters.length === 0) {
    return `Cok, **${found.name}** belum ada gifter di data terakhir (dicek ${checkedText}, bukan live real-time).`;
  }

  const medals = ["🥇", "🥈", "🥉"];
  const lines = found.gifters
    .slice(0, 10)
    .map((g, i) => `${medals[i] || `${i + 1}.`} ${g.name} - ${Number(g.total_gold).toLocaleString("id-ID")} Gold`);

  return [`🏆 **Top Gifter ${found.name}** (dicek ${checkedText}, BUKAN live real-time)`, ...lines].join("\n");
}

function replyGifterSnapshot(fragment) {
  const name = (fragment || "").trim();
  if (!name) return 'Gifter siapa? Ketik nama membernya juga ya, misal "cok gifter kathrina".';

  const found = findGifterSnapshotByNameFragment(name);
  if (!found) {
    return `Cok, belum ada data top gifter buat "${name}". Yang pegang akun IDN-nya bisa jalanin "npm run cek-gifter" dulu di komputernya biar ke-update.`;
  }
  return formatGifterSnapshotReply(found);
}

// Dipake dari dropdown tombol (fallback_select:9) - beda dari replyGifterSnapshot
// yang nyari lewat FRAGMEN nama (bisa ambigu kalau ada 2 member namanya mirip),
// ini langsung ambil dari username yang UDAH PASTI dipilih user dari dropdown,
// gak perlu nebak-nebak lagi.
function replyGifterSnapshotByUsername(username) {
  const { members } = loadGifterSnapshot();
  const data = members[username];
  if (!data) {
    return `Cok, belum ada data top gifter buat member ini. Yang pegang akun IDN-nya bisa jalanin "npm run cek-gifter" dulu biar ke-update.`;
  }
  return formatGifterSnapshotReply({ username, ...data });
}

function isOwner(authorId) {
  return Boolean(PRIORITY_PING_USER_ID) && authorId === PRIORITY_PING_USER_ID;
}

function handleAddPriority(nameFragment, authorId) {
  if (!isOwner(authorId)) return "Cok, cuma owner yang boleh ubah daftar prioritas.";
  const name = stripTrailingLiveWord(nameFragment);
  const result = addCustomPriorityMember(name);
  if (!result.ok && result.reason === "exists") return `"${name}" udah ada di daftar prioritas.`;
  if (!result.ok && result.reason === "too_short") return "Nama/keyword-nya kependekan, minimal 3 huruf ya.";
  if (!result.ok) return "Gagal nambahin, coba lagi.";
  return `✅ "${name}" ditambahin ke daftar prioritas, notif live-nya bakal jadi flashy sekarang.`;
}

function handleRemovePriority(nameFragment, authorId) {
  if (!isOwner(authorId)) return "Cok, cuma owner yang boleh ubah daftar prioritas.";
  const name = stripTrailingLiveWord(nameFragment);
  const result = removeCustomPriorityMember(name);
  if (!result.ok) return `"${name}" nggak ketemu di daftar prioritas custom (Nala/Levi/Lily nggak bisa dihapus lewat chat).`;
  return `✅ "${name}" dihapus dari daftar prioritas.`;
}

// Beda dari priority list (khusus owner), subscribe ini SIAPA AJA boleh -
// personal reminder buat di-tag pas member manapun mulai live.
function handleSubscribe(rawName, authorId) {
  const name = stripTrailingLiveWord(rawName);
  const result = addSubscription(name, authorId);
  if (!result.ok && result.reason === "too_short") return "Nama membernya kependekan, minimal 3 huruf ya.";
  if (!result.ok && result.reason === "already") return `Kamu udah subscribe notif buat "${name}" kok.`;
  if (!result.ok) return "Gagal subscribe, coba lagi.";
  return `🔔 Sip, kamu bakal di-tag tiap kali "${name}" mulai live!`;
}

function handleUnsubscribe(rawName, authorId) {
  const name = stripTrailingLiveWord(rawName);
  const result = removeSubscription(name, authorId);
  if (!result.ok) return `Kamu belum subscribe "${name}".`;
  return `🔕 Oke, notif buat "${name}" dimatiin.`;
}

module.exports = {
  replyListLive,
  replyLongestLive,
  replyLongestLiveForRange,
  replyTopViewers,
  replyTopViewersForRange,
  resolveStatRangeFromText,
  replyExportRecap,
  buildExportCsv,
  replyBotStatus,
  replySpecificMember,
  replyMemberNotFound,
  replyHelp,
  replyPriorityList,
  replyMySubscriptions,
  replyMemberStats,
  replyLiveCount,
  replyLiveCountLeaderboard,
  replySchedulePattern,
  formatGifterSnapshotReply,
  replyGifterSnapshot,
  replyGifterSnapshotByUsername,
  replyTodayRecapSoFar,
  replyRecapRange,
  replyRecapMenu,
  replyRecapDatePicker,
  replyRecapMonth,
  replyRecapMonthGeneric,
  replyRecapSpecificDate,
  replyRecapWeekdayPicker,
  parseSpecificDateFromText,
  parseMonthOnlyFromText,
  parseWeekdayFromText,
  getTodaySessionsForRecap,
  getAvailableRecapMonths,
  buildRecapTablePage,
  buildRecapPageBlock,
  buildRecapDateSelectRow,
  buildWeekdayDateSelectRow,
  buildRecapMonthSelectRow,
  tryHandleRecapPageShortcut,
  handleRecapNavButton,
  handleRecapSearchModalSubmit,
  handleRecapJumpModalSubmit,
  handleRecapMenuButton,
  handleRecapDateSelect,
  handleRecapMonthSelect,
  isOwner,
  handleAddPriority,
  handleRemovePriority,
  handleSubscribe,
  handleUnsubscribe,
};
