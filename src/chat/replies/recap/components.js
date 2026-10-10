// Komponen Discord rekap: dropdown tanggal/bulan/member, tombol navigasi Maju/Mundur/Tutup, tag asal (origin), dan satu blok halaman rekap.

const { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } = require("discord.js");
const { getEarliestSessionDate, SESSION_RETENTION_DAYS } = require("../../../storage/dailyLog");
const { getTodayWIB, getDateWIB, formatLongDateWIB, formatMonthLabel } = require("../../../utils");

const { WEEKDAY_NAMES_ID } = require("./dateParsing");
const {
  RECAP_DATE_OPTIONS_COUNT,
  getMemberSessionDates,
  findRecentDatesForWeekday,
  encodeWeekdayTaggedDate,
  getAvailableRecapMonths,
  isMemberRange,
  parseMemberRange,
  encodeRecapRange,
  parseDateRangeValue,
  pendingRecapPage,
} = require("./sessions");
const { buildRecapTablePage } = require("./table");

// BUG SEBELUMNYA (dilaporin owner): loop-nya mulai dari i=1 (KEMARIN),
// sengaja NGELEWATIN hari ini - alasannya dulu "hari ini udah ada tombol
// 'Rekap hari ini' sendiri di replyRecapMenu", TAPI itu cuma bener kalau
// dropdown ini kebuka LEWAT tombol "Rekap per tanggal" di replyRecapMenu.
// Begitu "cok rekap tanggal"/"cok rekap per tanggal" (chat/router.js) manggil
// buildRecapDatePickerBlock() LANGSUNG, gak pernah ada tombol "Rekap hari
// ini" yang nempel sama sekali - jadi hari ini beneran gak bisa dipilih dari
// dropdown ini lewat jalur itu, cuma "ilang" tanpa penjelasan. Sekarang
// mulai dari i=0 (HARI INI ikut jadi salah satu opsi).
function buildRecapDateSelectRow(selectedDate = null, origin = "") {
  const todayStartMs = new Date(`${getTodayWIB()}T00:00:00+07:00`).getTime();
  const earliestDate = getEarliestSessionDate(); // null kalau arsipnya masih kosong sama sekali - gak ada batas tambahan buat kasus itu
  const options = [];
  for (let i = 0; i < RECAP_DATE_OPTIONS_COUNT; i++) {
    const d = new Date(todayStartMs - i * 24 * 60 * 60 * 1000);
    const value = getDateWIB(d);
    if (earliestDate && value < earliestDate) break; // mundur lebih jauh dari sesi paling tua yang ada - stop, gak ada gunanya nawarin tanggal yang pasti kosong
    options.push({ label: formatLongDateWIB(d), value, default: value === selectedDate });
  }
  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId(withOrigin("recap_date_select", origin))
    .setPlaceholder("Pilih tanggal buat rekap")
    .addOptions(options);
  return new ActionRowBuilder().addComponents(selectMenu);
}

// Dropdown "📅 Cari tanggal" di rekap PER MEMBER (menggantikan tombol "🔍 Cari member" yang
// gak ada gunanya di rekap satu orang). Isinya HANYA tanggal yang beneran ada sesi member
// itu (bukan semua hari kayak buildRecapDateSelectRow), ditambah opsi "Semua sesi" buat
// balik ke rekap lengkap. Memilih nge-EDIT pesan yang sama (handleRecapMemberDateSelect).
const MEMBER_DATE_ALL = "all";

const MEMBER_DATE_OPTIONS_MAX = 24; // + opsi "Semua sesi" = 25, batas keras Discord per dropdown

function buildMemberDateSelectRow(username, selectedDate = null, origin = "") {
  const all = getMemberSessionDates(username);
  let shown = all.slice(0, MEMBER_DATE_OPTIONS_MAX);
  if (selectedDate && !shown.some(([date]) => date === selectedDate)) {
    // Tanggal yang lagi dilihat harus tetap kelihatan terpilih walau lebih tua dari 24 tanggal terbaru.
    const selected = all.find(([date]) => date === selectedDate);
    if (selected) shown = [...shown.slice(0, MEMBER_DATE_OPTIONS_MAX - 1), selected].sort((a, b) => (a[0] < b[0] ? 1 : -1));
  }
  const options = [{ label: `Semua sesi (${SESSION_RETENTION_DAYS} hari terakhir)`, value: MEMBER_DATE_ALL, default: !selectedDate }];
  for (const [date, count] of shown) {
    options.push({
      label: formatLongDateWIB(new Date(`${date}T00:00:00+07:00`)),
      description: `${count} sesi live`,
      value: date,
      default: date === selectedDate,
    });
  }
  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId(withOrigin(`recap_member_date:${username}`, origin))
    .setPlaceholder("📅 Cari tanggal")
    .addOptions(options);
  return new ActionRowBuilder().addComponents(selectMenu);
}

function buildWeekdayDateSelectRow(weekdayIndex, selectedRangeValue = null, origin = "") {
  const options = findRecentDatesForWeekday(weekdayIndex).map((d) => {
    const value = encodeWeekdayTaggedDate(getDateWIB(d), weekdayIndex);
    return { label: formatLongDateWIB(d), value, default: value === selectedRangeValue };
  });
  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId(withOrigin("recap_date_select", origin))
    .setPlaceholder(`Pilih tanggal hari ${WEEKDAY_NAMES_ID[weekdayIndex]}`)
    .addOptions(options);
  return new ActionRowBuilder().addComponents(selectMenu);
}

// Dropdown "cok rekap bulan" polos (replyRecapMonthGeneric di bawah) DAN
// baris navigasi tabel rekap PER BULAN (buildRecapNavComponents, biar bisa
// ganti bulan tanpa nutup dulu, sama pola-nya kayak buildRecapDateSelectRow
// buat tanggal).
function buildRecapMonthSelectRow(months, selectedMonth = null, origin = "") {
  const options = months.map((m) => ({ label: formatMonthLabel(m), value: m, default: m === selectedMonth }));
  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId(withOrigin("recap_month_select", origin))
    .setPlaceholder("Pilih bulan buat rekap")
    .addOptions(options);
  return new ActionRowBuilder().addComponents(selectMenu);
}

function buildCloseOnlyRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("recap_nav:close").setLabel("Tutup rekap").setStyle(ButtonStyle.Danger),
  );
}

// BUG YANG DILAPORIN OWNER: tabel rekap yang dibuka dari menu 9-opsi
// fallback-nya "Rekap hari ini" (opsi 8), ATAU dari salah satu tombol menu
// 5-opsi rekap (replyRecapMenu), gak punya jalan balik ke menu asalnya sama
// sekali - cuma Maju/Mundur/Tutup/Cari member/Lompat halaman, jadi user
// kepaksa nutup dulu terus manggil ulang "cok bantuan"/"cok rekap" dari nol
// kalau mau pilih opsi LAIN. `origin` (di bawah dan di seluruh
// buildRecapNavComponents/buildRecapPageBlock dst) nandain DARI MANA sebuah
// tabel/dropdown rekap dibuka:
//   - ""          (default/kosong) - ngetik langsung ("cok rekap ..."),
//                 TIDAK dikasih tombol balik (gak ada menu buat dibalikin
//                 ke situ) - SAMA PERSIS perilaku sebelum fitur ini ada,
//                 biar semua test/kebiasaan lama gak kesentuh sedikit pun.
//   - "fallback"  - dibuka dari menu 9-opsi (menu.js's replyFallbackMenu).
//   - "recapmenu" - dibuka dari menu 5-opsi rekap (replyRecapMenu di bawah).
// Origin ini HARUS ikut "nempel" di customId tombol Maju/Mundur/Lompat
// halaman dan customId dropdown tanggal/bulan (persis kayak `rangeDays`/
// `page` yang udah lebih dulu nempel di situ - lihat komen di
// buildRecapNavComponents) - kalau enggak, tombol "🔙 Kembali" bakal ilang
// lagi begitu user maju/mundur halaman atau ganti tanggal/bulan sekali aja.
function withOrigin(base, origin) {
  return origin ? `${base}:${origin}` : base;
}

//   - "lc-<username>" - dibuka dari tombol "📋 Lihat rekap" di jawaban jumlah live
//                 ("cok berapa kali nala live" / "/berapa-kali"). Username ikut di origin
//                 karena tombol "Kembali" (recap_nav:backto:<origin>) gak bawa range apa pun,
//                 padahal harus tau jumlah live SIAPA yang ditampilkan lagi.
const LIVE_COUNT_ORIGIN_PREFIX = "lc-";

const liveCountOrigin = (username) => `${LIVE_COUNT_ORIGIN_PREFIX}${username}`;

const isLiveCountOrigin = (origin) =>
  typeof origin === "string" && origin.startsWith(LIVE_COUNT_ORIGIN_PREFIX) && origin.length > LIVE_COUNT_ORIGIN_PREFIX.length;

const usernameFromLiveCountOrigin = (origin) => origin.slice(LIVE_COUNT_ORIGIN_PREFIX.length);

// Kebalikan dari withOrigin - buat customId FIXED (bukan yang udah bawa
// range/page sendiri kayak "recap_nav:..."), origin-nya nempel PERSIS di
// index tetap (mis. "recap_date_select:recapmenu" -> index 1). Dropdown
// yang gak dikasih origin balik "" (bukan undefined) - `if (origin)`/
// `withOrigin` di pemanggil nanganin string kosong itu sebagai "gak ada
// tombol kembali", identik kayak sebelum fitur ini ada.
function originFromCustomId(customId, index) {
  return customId.split(":")[index] || "";
}

// Baris tombol "🔙 Kembali ke ..." - CUMA muncul kalau origin-nya keisi
// (tabel/dropdown ini beneran dibuka dari salah satu menu tombol). "backto"
// (dibaca handleRecapNavButton) sengaja gak butuh bawa rangeDays/halaman
// sama sekali di customId-nya - balik ke menu itu gak butuh tau lagi tabel
// yang lagi ditampilin isinya apa.
function buildBackRow(origin) {
  const label = origin === "fallback" ? "🔙 Kembali ke menu" : isLiveCountOrigin(origin) ? "🔙 Kembali ke jumlah live" : "🔙 Kembali ke menu rekap";
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`recap_nav:backto:${origin}`).setLabel(label).setStyle(ButtonStyle.Secondary),
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
function buildRecapNavComponents(page, totalPages, rangeDays, origin = "") {
  const range = encodeRecapRange(rangeDays);
  const memberRange = isMemberRange(rangeDays);
  const isMonthRange = typeof rangeDays === "string" && !memberRange && rangeDays.length === 7;
  const buttons = [];
  if (page < totalPages - 1) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(withOrigin(`recap_nav:next:${range}:${page}`, origin))
        .setLabel("Maju ▶")
        .setStyle(ButtonStyle.Primary),
    );
  }
  if (page > 0) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(withOrigin(`recap_nav:prev:${range}:${page}`, origin))
        .setLabel("◀ Mundur")
        .setStyle(ButtonStyle.Secondary),
    );
  }
  buttons.push(new ButtonBuilder().setCustomId("recap_nav:close").setLabel("Tutup rekap").setStyle(ButtonStyle.Danger));
  // Rekap PER MEMBER (§10's forty-eighth item) cuma isinya satu orang, jadi
  // "🔍 Cari member" gak ada gunanya di situ (owner minta dihilangkan) - diganti
  // dropdown "📅 Cari tanggal" (buildMemberDateSelectRow) di baris atas.
  if (!memberRange) {
    buttons.push(new ButtonBuilder().setCustomId(`recap_nav:search:${range}`).setLabel("🔍 Cari member").setStyle(ButtonStyle.Secondary));
  }
  if ((typeof rangeDays === "number" || isMonthRange || memberRange) && totalPages > 1) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(withOrigin(`recap_nav:jump:${range}:${page}`, origin))
        .setLabel("🔢 Lompat halaman")
        .setStyle(ButtonStyle.Secondary),
    );
  }

  const rows = [];
  if (typeof rangeDays === "string" && !memberRange) {
    if (isMonthRange) {
      rows.push(buildRecapMonthSelectRow(getAvailableRecapMonths(), rangeDays, origin));
    } else {
      // Tanggal yang di-TAG weekday-nya (dipilih lewat dropdown "cok rekap
      // senin" dkk, lihat komen di buildWeekdayDateSelectRow) harus TETEP
      // nempelin dropdown yang di-filter ke hari itu juga di sini, BUKAN
      // balik ke dropdown semua tanggal - itu bug yang dilaporin owner:
      // dropdown-nya nunjukkin semua hari lagi begitu tabelnya nge-render,
      // padahal user udah eksplisit milih dari dropdown yang di-filter.
      const { date, weekdayIndex } = parseDateRangeValue(rangeDays);
      rows.push(weekdayIndex !== null ? buildWeekdayDateSelectRow(weekdayIndex, rangeDays, origin) : buildRecapDateSelectRow(date, origin));
    }
  }
  if (memberRange) {
    const { username, date } = parseMemberRange(rangeDays);
    rows.push(buildMemberDateSelectRow(username, date, origin));
  }
  rows.push(new ActionRowBuilder().addComponents(buttons));
  // BUG YANG DILAPORIN OWNER (lihat komen panjang di buildBackRow) - baris
  // "🔙 Kembali" TERPISAH (bukan numpang di baris tombol Maju/Mundur/dst di
  // atas) soalnya baris itu udah bisa nyampe 5 tombol (limit Discord per
  // baris) dengan sendirinya (Maju+Mundur+Tutup+Cari member+Lompat halaman).
  if (origin) rows.push(buildBackRow(origin));
  return rows;
}

function buildRecapPageBlock(sessions, page, channelId, authorId, rangeDays = null, origin = "") {
  const result = buildRecapTablePage(sessions, page, isMemberRange(rangeDays));
  const footer = `_(Halaman ${result.page + 1}/${result.totalPages})_`;

  if (result.totalPages > 1 && channelId && authorId) {
    pendingRecapPage.set(`${channelId}:${authorId}`, {
      currentPage: result.page,
      totalPages: result.totalPages,
      at: Date.now(),
      rangeDays,
      origin,
    });
  }

  return { content: `${result.text}\n${footer}`, components: buildRecapNavComponents(result.page, result.totalPages, rangeDays, origin) };
}

module.exports = {
  buildRecapDateSelectRow,
  buildWeekdayDateSelectRow,
  buildRecapMonthSelectRow,
  buildCloseOnlyRow,
  withOrigin,
  liveCountOrigin,
  isLiveCountOrigin,
  usernameFromLiveCountOrigin,
  originFromCustomId,
  buildBackRow,
  buildRecapNavComponents,
  buildRecapPageBlock,
};
