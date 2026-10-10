// Layar statis menu rekap (menu utama, pemilih tanggal, modal cari member) dan komponen penutup hasil pencarian.

const { ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle } = require("discord.js");

const { buildRecapDateSelectRow, buildCloseOnlyRow, buildBackRow } = require("./components");

// Balesan buat "cok rekap tanggal" DAN buat tombol "Rekap per tanggal"
// (lihat replyRecapMenu/handleRecapMenuButton di bawah) - dua-duanya
// nunjukkin dropdown yang SAMA persis, jadi digabung ke satu fungsi biar
// gak didobelin. Belum ada tabel apa-apa di sini (belum ada tanggal
// kepilih) - cuma dropdown + tombol tutup, tabelnya baru muncul abis milih
// lewat handleRecapDateSelect.
function buildRecapDatePickerBlock(origin = "") {
  const rows = [buildRecapDateSelectRow(null, origin), buildCloseOnlyRow()];
  if (origin) rows.push(buildBackRow(origin));
  return { content: "Rekap tanggal berapa nih, cok?", components: rows };
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
    new ButtonBuilder().setCustomId("recap_menu:member").setLabel("Rekap member").setStyle(ButtonStyle.Success),
  );
  // Maksimal 5 tombol per baris Discord - "Rekap member" (§10's forty-eighth
  // item) jadi tombol ke-5, jadi "Tutup" pindah ke baris sendiri.
  const closeRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("recap_nav:close").setLabel("Tutup").setStyle(ButtonStyle.Danger),
  );
  return { content: "Mau rekap yang mana, cok?", components: [row, closeRow] };
}

// Ditempelin di balesan hasil pencarian (handleRecapSearchModalSubmit di
// bawah) - owner ngeluh tabel rekap ASLI tetep numpang di channel padahal
// yang dicari udah ketemu lewat hasil pencarian ini. `originalMessageId`
// datang dari interaction.message punya MODAL SUBMISSION (cuma keisi kalau
// modal-nya dibuka dari tombol yang NEMPEL DI SEBUAH PESAN - persis kasus
// kita, "🔍 Cari member" nempel di tabel rekap) - null kalau entah gimana
// gak keisi (defensif), jadi baris tombolnya dilewatin aja (gak ada apa-apa
// buat dihapus/dipertahanin kalau ID pesannya sendiri gak ke-ketahuan).
//
// BUG SEBELUMNYA (dilaporin owner): balesan pencarian ini gak punya tombol
// "Tutup" sama sekali - baris Ya/Enggak-nya ILANG total abis dijawab
// (handleRecapNavButton's keeprecap/delrecap ngedit jadi components: []), dan
// kalau originalMessageId gak keisi malah gak pernah ada tombol apapun. Jadi
// hasil pencarian yang udah selesai dibaca gak bisa ditutup. Sekarang tombol
// "Tutup" (customId "recap_nav:closesearch" - logika tutup yang SAMA kayak
// semua tombol tutup lain, deleteInteractionMessage, ngehapus BALESAN
// PENCARIAN-nya sendiri) SELALU nempel: satu baris bareng Ya/Enggak selama
// pertanyaannya masih ada, dan sendirian abis pertanyaannya dijawab. Beda
// dari "recap_nav:close" (Tutup rekap) yang juga nge-clear pendingRecapPage -
// nutup hasil pencarian gak boleh diem-diem mematikan navigasi "y"/"mundur"
// buat tabel rekap ASLI yang mungkin masih dipertahanin ("Ya, biarin").
function buildSearchResultCloseButton() {
  return new ButtonBuilder().setCustomId("recap_nav:closesearch").setLabel("Tutup").setStyle(ButtonStyle.Danger);
}

function buildSearchResultCloseRow() {
  return new ActionRowBuilder().addComponents(buildSearchResultCloseButton());
}

function buildKeepOrDeleteRecapComponents(originalMessageId) {
  if (!originalMessageId) return [buildSearchResultCloseRow()];
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`recap_nav:keeprecap:${originalMessageId}`).setLabel("Ya, biarin").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`recap_nav:delrecap:${originalMessageId}`).setLabel("Enggak, hapus aja").setStyle(ButtonStyle.Danger),
    buildSearchResultCloseButton(),
  );
  return [row];
}

// "awal"/"pertama" dan "akhir"/"terakhir" (Indonesia) DAN "first"/"last"
// (jaga-jaga ada yang ngetik Inggris) diterima sebagai alias, biar gak harus
// ngitung sendiri "halaman terakhir itu halaman berapa" - "akhir" ditangani
// dengan cukup ngasih angka BESAR (bukan hitung totalPages di sini juga),
// buildRecapTablePage sendiri udah nge-clamp ke totalPages-1 apapun angka
// yang dikasih, jadi angka gede itu otomatis kepotong pas ke halaman
// terakhir yang beneran ada - gak perlu tau totalPages duluan di sini.
// ==== Rekap PER MEMBER (§10's forty-eighth item): "cok rekap <nama member>"
// dan tombol "Rekap member" di menu "cok rekap" ====

function buildRecapMemberModal() {
  return new ModalBuilder()
    .setCustomId("recap_member_modal:x")
    .setTitle("Rekap member")
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("member_name")
          .setLabel("Nama member")
          .setStyle(TextInputStyle.Short)
          .setPlaceholder("misal: Aralie")
          .setRequired(true),
      ),
    );
}

function withRecapMenu(message) {
  const menu = replyRecapMenu();
  return { content: `${message}\n\n${menu.content}`, components: menu.components };
}

module.exports = {
  buildRecapDatePickerBlock,
  replyRecapDatePicker,
  replyRecapMenu,
  buildSearchResultCloseRow,
  buildKeepOrDeleteRecapComponents,
  buildRecapMemberModal,
  withRecapMenu,
};
