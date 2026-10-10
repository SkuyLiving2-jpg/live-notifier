// Tampilan rekap: hari ini, N hari terakhir, per bulan, per tanggal, dan pemilih hari dalam pekan.

const { activeLives } = require("../../../storage/activeLives");
const { getCompletedSessionsSince, getEarliestSessionDate, fetchExternalTodayLiveHistory } = require("../../../storage/dailyLog");
const { formatDuration, formatClockWIB, getTodayWIB, getDateWIB, formatLongDateWIB, formatMonthLabel } = require("../../../utils");

const { buildRecapPageBlock, buildRecapMonthSelectRow, buildCloseOnlyRow, buildBackRow, buildWeekdayDateSelectRow } = require("./components");
const { WEEKDAY_NAMES_ID } = require("./dateParsing");
const { replyRecapMenu } = require("./screens");
const {
  getTodaySessionsForRecap,
  getOngoingSessionsForRecap,
  getAvailableRecapMonths,
  pendingRecapPage,
  getSessionsForRange,
  findRecentDatesForWeekday,
} = require("./sessions");

// Versi on-demand dari rekap harian otomatis (yang ngirim sendiri jam 23:00
// WIB) - ini dipanggil kapan aja user nanya, nunjukkin progress SEJAUH INI
// (live yang masih berlangsung belum ikut ke-hitung, baru masuk pas selesai).
// Async karena nyoba lengkapin data lokal pakai arsip eksternal. Kalau
// arsipnya gak keambil (network error/dll), fungsi ini tetep balikin rekap
// versi lokal doang - gak pernah gagal total gara-gara sumber tambahan ini.
async function replyTodayRecapSoFar(channelId, authorId, origin = "") {
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

  const block = buildRecapPageBlock(sessions, 0, channelId, authorId, null, origin);
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
async function replyRecapRange(daysBack, label, channelId, authorId, origin = "") {
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

  const block = buildRecapPageBlock(sessions, 0, channelId, authorId, daysBack, origin);
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
async function replyRecapMonth(monthWIB, channelId, authorId, origin = "") {
  pendingRecapPage.delete(`${channelId}:${authorId}`);
  const label = formatMonthLabel(monthWIB);
  const sessions = getSessionsForRange(monthWIB);

  if (sessions.length === 0) {
    const months = getAvailableRecapMonths();
    if (months.length > 1) {
      const rows = [buildRecapMonthSelectRow(months, monthWIB, origin), buildCloseOnlyRow()];
      if (origin) rows.push(buildBackRow(origin));
      return {
        content: `Cok, belum ada live yang kecatet buat bulan ${label}. Coba bulan lain, cok:`,
        components: rows,
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

  const block = buildRecapPageBlock(sessions, 0, channelId, authorId, monthWIB, origin);
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

module.exports = {
  replyTodayRecapSoFar,
  replyRecapRange,
  replyRecapMonth,
  replyRecapMonthGeneric,
  replyRecapSpecificDate,
  replyRecapWeekdayPicker,
};
