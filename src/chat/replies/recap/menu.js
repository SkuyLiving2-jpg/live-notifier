// Penanganan tombol menu rekap, dropdown tanggal/bulan, dan modal cari dari rekap.

const { resolveAliasInFragment } = require("../../../storage/aliases");
const { getTodayWIB, formatLongDateWIB, matchesNameFragment, safeReplyOptions } = require("../../../utils");

const {
  buildRecapDateSelectRow,
  buildWeekdayDateSelectRow,
  buildCloseOnlyRow,
  originFromCustomId,
  buildBackRow,
  buildRecapPageBlock,
} = require("./components");
const { buildRecapDatePickerBlock, buildRecapMemberModal, withRecapMenu, buildKeepOrDeleteRecapComponents } = require("./screens");
const { pendingRecapPage, getSessionsForRange, parseDateRangeValue, decodeRecapRange } = require("./sessions");
const { buildRecapTablePage } = require("./table");
const { replyTodayRecapSoFar, replyRecapRange, replyRecapMonth } = require("./views");

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
    // "recapmenu" (bukan gak dikasih origin sama sekali) - BUG YANG
    // DILAPORIN OWNER, lihat komen panjangnya di buildBackRow/withOrigin:
    // tabel yang KELUAR abis milih tanggal dari dropdown ini butuh tetep
    // "inget" dibuka dari menu 5-opsi, biar tombol "🔙 Kembali ke menu
    // rekap" nempel di situ juga, bukan cuma di tabel today/week/month.
    await interaction.update(safeReplyOptions(buildRecapDatePickerBlock("recapmenu")));
    return;
  }

  // "Rekap member" butuh nama member dulu - modal (input teks), bukan langsung
  // balesan. Submit-nya ditangani handleRecapMemberModalSubmit (ngedit pesan
  // menu ini jadi tabel rekap member, sama pola in-place-edit tombol lain) -
  // origin-nya (§10's ini, "recapmenu") di-hardcode DI SITU, bukan di sini,
  // soalnya modal ini SATU-SATUNYA jalan buat munculin tabel rekap member
  // (gak ada jalur ngetik langsung yang lewat modal ini juga).
  if (choice === "member") {
    await interaction.showModal(buildRecapMemberModal());
    return;
  }

  // BUG YANG DILAPORIN OWNER: tombol menu 5-opsi rekap ("Rekap hari ini"/
  // "minggu ini"/"bulan ini") nembak tabel yang SEBELUM INI cuma punya
  // Maju/Mundur/Tutup/Cari member/Lompat halaman - gak ada jalan balik ke
  // menu 5-opsi ini sendiri. `origin: "recapmenu"` di bawah nandain itu,
  // lihat buildBackRow/withOrigin buat detail lengkapnya.
  let reply;
  if (choice === "today") reply = await replyTodayRecapSoFar(interaction.channelId, interaction.user.id, "recapmenu");
  else if (choice === "week") reply = await replyRecapRange(7, "minggu ini", interaction.channelId, interaction.user.id, "recapmenu");
  else if (choice === "month") reply = await replyRecapMonth(getTodayWIB().slice(0, 7), interaction.channelId, interaction.user.id, "recapmenu");
  else return;

  // Balesan "belum ada live yang kecatet ..." (0 sesi) balik STRING polos
  // (gak ada tombol apapun, termasuk balik ke menu) - withRecapMenu nempelin
  // menu 5-opsi ini lagi di bawahnya, SAMA pola yang chat/menu.js's
  // handleFallbackMenuButton udah pakai buat kasus serupa (reply string dari
  // resolveBareMenuChoice), biar user tetep bisa lanjut milih opsi lain
  // tanpa harus ngetik ulang "cok rekap" dari nol.
  if (typeof reply === "string") {
    await interaction.update(safeReplyOptions(withRecapMenu(reply)));
    return;
  }
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
  // Origin (§10's ini - lihat komen panjang di buildBackRow/withOrigin)
  // dibawa lewat customId dropdown-nya sendiri ("recap_date_select" polos,
  // atau "recap_date_select:<origin>") - dropdown yang SAMA ini nempel baik
  // di picker berdiri sendiri (buildRecapDatePickerBlock) MAUPUN di tabel
  // yang lagi ditampilin (buildRecapNavComponents), jadi origin-nya harus
  // dibaca DARI SINI, bukan dari pendingRecapPage (dropdown ini valid
  // diklik kapan aja, gak bergantung state per-orang yang ada TTL-nya).
  const origin = originFromCustomId(interaction.customId, 1);
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
    const dateRow = weekdayIndex !== null ? buildWeekdayDateSelectRow(weekdayIndex, selectedRange, origin) : buildRecapDateSelectRow(date, origin);
    const rows = [dateRow, buildCloseOnlyRow()];
    if (origin) rows.push(buildBackRow(origin));
    await interaction.update(
      safeReplyOptions({
        content: `Cok, belum ada live yang kecatet tanggal ${label}.`,
        components: rows,
      }),
    );
    return;
  }

  const block = buildRecapPageBlock(sessions, 0, interaction.channelId, interaction.user.id, selectedRange, origin);
  await interaction.update(safeReplyOptions({ content: `📋 **Rekap tanggal ${label}**\n${block.content}`, components: block.components }));
}

// Diklik dari dropdown buildRecapMonthSelectRow() bikin (customId
// "recap_month_select", nempel baik di balesan dropdown "cok rekap bulan"
// polos MAUPUN di tabel rekap bulan yang lagi ditampilin, lihat
// buildRecapNavComponents) - §10's thirty-sixth item. Sama pola in-place-edit-nya
// kayak handleRecapDateSelect di atas, cuma granularitasnya bulan.
async function handleRecapMonthSelect(interaction) {
  const origin = originFromCustomId(interaction.customId, 1);
  const selectedMonth = interaction.values[0];
  pendingRecapPage.delete(`${interaction.channelId}:${interaction.user.id}`);
  const reply = await replyRecapMonth(selectedMonth, interaction.channelId, interaction.user.id, origin);
  await interaction.update(safeReplyOptions(reply));
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
  // resolveAliasInFragment (§10's kelimapuluh item) - ini nge-loop
  // matchesNameFragment MANUAL (bukan lewat salah satu find*ByNameFragment
  // di storage/), jadi alias-nya harus diresolve EKSPLISIT di sini juga,
  // biar "🔍 Cari member" di tabel rekap ikut ngenalin panggilan yang
  // owner udah daftarin, konsisten sama pencarian di tempat lain.
  const needle = resolveAliasInFragment(query);
  const matched = sessions.filter((s) => s.name && matchesNameFragment(needle, s.name.split(/[\s|]+/)[0].toLowerCase()));

  const components = buildKeepOrDeleteRecapComponents(interaction.message?.id);
  const askText = interaction.message?.id ? "\n\nRekap sebelumnya masih mau ditampilin?" : "";

  if (matched.length === 0) {
    await interaction.reply(safeReplyOptions({ content: `Cok, gak nemu member "${query}" di rekap ini.${askText}`, components }));
    return;
  }

  const { text, hasMore } = buildRecapTablePage(matched, 0);
  const moreNote = hasMore ? `\n_(cuma nunjukkin 20 sesi pertama dari ${matched.length})_` : "";
  await interaction.reply(safeReplyOptions({ content: `🔍 Hasil cari "${query}":\n${text}${moreNote}${askText}`, components }));
}

module.exports = {
  handleRecapMenuButton,
  handleRecapDateSelect,
  handleRecapMonthSelect,
  handleRecapSearchModalSubmit,
};
