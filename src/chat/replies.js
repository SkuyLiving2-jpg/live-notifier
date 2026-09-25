const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
} = require("discord.js");
const { activeLives, getSortedActiveLives } = require("../storage/activeLives");
const {
  getCompletedSessionsToday,
  getCompletedSessionsForDate,
  getCompletedSessionsSince,
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
  describeElapsed,
  getTimeOfDayBucket,
  getHourWIBOf,
  WEEKDAY_FORMATTER_WIB,
  stripTrailingLiveWord,
  matchesNameFragment,
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
function replyLongestLive() {
  const candidates = [];

  for (const entry of activeLives.values()) {
    candidates.push({
      name: entry.name,
      durationMs: Date.now() - new Date(entry.liveAt).getTime(),
      isLive: true,
    });
  }
  for (const session of getCompletedSessionsToday()) {
    candidates.push({ name: session.name, durationMs: session.durationMs, isLive: false });
  }

  if (candidates.length === 0) return "Cok, belum ada data live hari ini.";

  const longest = candidates.reduce((max, c) => (c.durationMs > max.durationMs ? c : max), candidates[0]);
  const statusText = longest.isLive ? "masih live sekarang" : "udah selesai";
  return `Paling lama live hari ini: **${longest.name}**, ${formatDuration(longest.durationMs)} (${statusText}).`;
}

// Sama kayak replyLongestLive - dulu cuma liat viewCount member yang LAGI
// live sekarang, jadi member yang tadi rame banget tapi udah selesai live
// bakal ilang gitu aja dari ranking. Sekarang bandingin PUNCAK penonton
// (peakViewCount, dicatet tiap polling selama live-nya jalan) dari live
// yang lagi jalan MAUPUN yang udah selesai hari ini, terus ambil puncak
// tertinggi per member (kalau dia live 2x hari ini, yang diitung yang
// paling rame di antara keduanya).
function replyTopViewers() {
  const peakByUsername = new Map();

  for (const session of getCompletedSessionsToday()) {
    if (session.peakViewCount == null) continue;
    const prev = peakByUsername.get(session.username);
    if (!prev || session.peakViewCount > prev.peak) {
      peakByUsername.set(session.username, { name: session.name, peak: session.peakViewCount });
    }
  }
  for (const entry of activeLives.values()) {
    if (entry.peakViewCount == null) continue;
    const prev = peakByUsername.get(entry.username);
    if (!prev || entry.peakViewCount > prev.peak) {
      peakByUsername.set(entry.username, { name: entry.name, peak: entry.peakViewCount });
    }
  }

  if (peakByUsername.size === 0) return "Cok, belum ada data penonton buat hari ini.";

  const sorted = [...peakByUsername.values()].sort((a, b) => b.peak - a.peak);
  const medals = ["🥇", "🥈", "🥉"];
  const lines = sorted.map((entry, i) => {
    const medal = medals[i] || `${i + 1}.`;
    return `${medal} **${entry.name}** - 👁️ ${formatViewCount(entry.peak)} (puncak)`;
  });

  return `👀 Paling rame ditonton hari ini (puncak penonton):\n${lines.join("\n")}`;
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
    '- "cok siapa yang paling lama live hari ini?"',
    '- "cok siapa yang paling rame ditonton hari ini?"',
    '- "cok status"',
    '- "cok <nama member> masih live?"',
    '- "cok stats <nama member>" - statistik durasi live-nya',
    '- "cok berapa kali <nama member> live" - total berapa kali dia udah live semenjak bot ini jalan',
    '- "cok siapa yang paling sering live" - leaderboard total live count semua member',
    '- "cok kapan <nama member> biasanya live?" / "cok jadwal <nama>" - pola jam/hari dari histori (bukan jadwal resmi)',
    '- "cok gifter <nama member>" - top gifter (snapshot terakhir dari "npm run cek-gifter", bukan real-time)',
    '- "cok rekap hari ini" - rekap live yang udah selesai hari ini',
    '- "cok rekap minggu ini" / "cok rekap bulan ini" - rekap 7/30 hari terakhir',
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

// Gabungan "gambaran lengkap hari ini" - sesi yang UDAH SELESAI hari ini
// (dari daily-log.json) + yang MASIH LIVE SEKARANG (dari activeLives,
// dibentuk jadi baris ala-sesi biar bisa numpang bareng di tabel/hitungan
// yang sama). Sama pola-nya kayak replyLongestLive()/replyTopViewers()
// (yang udah lebih dulu gabungin dua sumber ini) - diexport biar bisa dites
// langsung, sama kayak buildRecapTablePage.
function getTodaySessionsForRecap() {
  const completed = getCompletedSessionsToday();
  const ongoing = [...activeLives.values()].map((entry) => ({
    name: entry.name,
    username: entry.username,
    startedAtUnix: Math.floor(new Date(entry.liveAt).getTime() / 1000),
    endedAtUnix: null,
    durationMs: null,
    peakViewCount: entry.peakViewCount ?? entry.viewCount ?? null,
  }));
  return [...completed, ...ongoing];
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
function getSessionsForRange(rangeDays) {
  if (rangeDays == null || rangeDays === getTodayWIB()) return getTodaySessionsForRecap();
  if (typeof rangeDays === "string") return getCompletedSessionsForDate(rangeDays);
  return getCompletedSessionsSince(rangeDays);
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
function encodeRecapRange(rangeDays) {
  if (rangeDays == null) return "today";
  if (typeof rangeDays === "string") return `d${rangeDays}`;
  return String(rangeDays);
}
function decodeRecapRange(range) {
  if (range === "today") return null;
  if (range.startsWith("d")) return range.slice(1);
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
// Rekap TANGGAL SPESIFIK (rangeDays berupa string "YYYY-MM-DD") dapet baris
// EKSTRA di atas baris tombol - dropdown buat ganti tanggal tanpa perlu
// nutup dulu terus buka "rekap tanggal" dari nol. Milih tanggal lain lewat
// dropdown ini nge-EDIT pesan yang sama (lihat handleRecapDateSelect), sama
// pola in-place-edit-nya kayak tombol Maju/Mundur - biar gak numpuk beberapa
// tabel tanggal beda-beda di channel.
function buildRecapNavComponents(page, totalPages, rangeDays) {
  const range = encodeRecapRange(rangeDays);
  const buttons = [];
  if (page < totalPages - 1) {
    buttons.push(new ButtonBuilder().setCustomId(`recap_nav:next:${range}:${page}`).setLabel("Maju ▶").setStyle(ButtonStyle.Primary));
  }
  if (page > 0) {
    buttons.push(new ButtonBuilder().setCustomId(`recap_nav:prev:${range}:${page}`).setLabel("◀ Mundur").setStyle(ButtonStyle.Secondary));
  }
  buttons.push(new ButtonBuilder().setCustomId("recap_nav:close").setLabel("Tutup rekap").setStyle(ButtonStyle.Danger));
  buttons.push(new ButtonBuilder().setCustomId(`recap_nav:search:${range}`).setLabel("🔍 Cari member").setStyle(ButtonStyle.Secondary));

  const rows = [];
  if (typeof rangeDays === "string") rows.push(buildRecapDateSelectRow(rangeDays));
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
    await interaction.update(safeReplyOptions({ content: "Terima kasih, enjoy ya, cok! 🎉", components: [] }));
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
// kesusahan mikirin mau ketik apa buat tiap jenis rekap.
function replyRecapMenu() {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("recap_menu:today").setLabel("Rekap hari ini").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("recap_menu:week").setLabel("Rekap minggu ini").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("recap_menu:month").setLabel("Rekap bulan ini").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("recap_menu:date").setLabel("Rekap per tanggal").setStyle(ButtonStyle.Secondary),
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
  else if (choice === "month") reply = await replyRecapRange(30, "bulan ini", interaction.channelId, interaction.user.id);
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
async function handleRecapDateSelect(interaction) {
  const selectedDate = interaction.values[0];
  pendingRecapPage.delete(`${interaction.channelId}:${interaction.user.id}`);

  // getSessionsForRange (bukan getCompletedSessionsForDate langsung) - kalau
  // selectedDate kebetulan HARI INI (sekarang bisa dipilih, lihat komen di
  // buildRecapDateSelectRow), ini otomatis ikut gabung sesi yang MASIH LIVE
  // dari activeLives juga, sama kayak tombol "Rekap hari ini".
  const sessions = getSessionsForRange(selectedDate);
  const label = formatLongDateWIB(new Date(`${selectedDate}T00:00:00+07:00`));

  if (sessions.length === 0) {
    await interaction.update(
      safeReplyOptions({
        content: `Cok, belum ada live yang kecatet tanggal ${label}.`,
        components: [buildRecapDateSelectRow(selectedDate), buildCloseOnlyRow()],
      }),
    );
    return;
  }

  const block = buildRecapPageBlock(sessions, 0, interaction.channelId, interaction.user.id, selectedDate);
  await interaction.update(safeReplyOptions({ content: `📋 **Rekap tanggal ${label}**\n${block.content}`, components: block.components }));
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

// Rekap mingguan/bulanan - beda dari replyTodayRecapSoFar dalam 2 hal: (1)
// ini jendela waktu yang UDAH LEWAT/tertutup, jadi gak perlu digabung sama
// activeLives (member yang lagi live sekarang bukan bagian dari "7 hari
// terakhir", itu bagian dari HARI INI, yang bakal numpang di sini juga
// begitu dia beneran selesai), dan (2) gak perlu cek arsip eksternal
// (JKT48Live-Record) - itu arsipnya emang cuma nyimpen bulan berjalan,
// gak didesain buat query rentang lebih lebar.
async function replyRecapRange(daysBack, label, channelId, authorId) {
  const sessions = getCompletedSessionsSince(daysBack);
  if (sessions.length === 0) {
    return `Cok, belum ada live yang kecatet dalam ${label}.`;
  }

  const totalDurationMs = sessions.reduce((sum, s) => sum + s.durationMs, 0);
  const uniqueMembers = new Set(sessions.map((s) => s.name)).size;
  const longest = sessions.reduce((max, s) => (s.durationMs > max.durationMs ? s : max), sessions[0]);

  const summaryLines = [
    `📋 **Rekap ${label}**`,
    `Total sesi: ${sessions.length}x dari ${uniqueMembers} member`,
    `Total durasi gabungan: ${formatDuration(totalDurationMs)} | Paling lama: **${longest.name}** (${formatDuration(longest.durationMs)})`,
  ];

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
  replyTopViewers,
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
  getTodaySessionsForRecap,
  buildRecapTablePage,
  buildRecapPageBlock,
  buildRecapDateSelectRow,
  tryHandleRecapPageShortcut,
  handleRecapNavButton,
  handleRecapSearchModalSubmit,
  handleRecapMenuButton,
  handleRecapDateSelect,
  isOwner,
  handleAddPriority,
  handleRemovePriority,
  handleSubscribe,
  handleUnsubscribe,
};
