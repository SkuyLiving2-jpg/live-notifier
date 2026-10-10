// Penanganan tombol navigasi rekap (recap_nav:*), pintasan ketik nomor halaman, dan modal lompat halaman.

const { ActionRowBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } = require("discord.js");
const { deleteInteractionMessage } = require("../../interactionHelpers");
const { safeReplyOptions, YES_PATTERN, NO_PATTERN, NEXT_PAGE_PATTERN, PREV_PAGE_PATTERN } = require("../../../utils");

const { buildLiveCountBlockForUsername } = require("../liveCount");
const { buildRecapPageBlock, isLiveCountOrigin, usernameFromLiveCountOrigin, withOrigin } = require("./components");
const { buildMemberRecapFromUsername } = require("./member");
const { buildSearchResultCloseRow, replyRecapMenu } = require("./screens");
const { pendingRecapPage, PENDING_RECAP_PAGE_TTL_MS, getSessionsForRange, decodeRecapRange } = require("./sessions");

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
  return buildRecapPageBlock(sessions, targetPage, channelId, authorId, pending.rangeDays, pending.origin);
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
// Aksi tombol "recap_nav:<aksi>:..." - satu fungsi per aksi (dulu satu fungsi ~145 baris). Semua fungsi menerima
// (interaction, parts) dengan parts = customId.split(":"), jadi parts[1] = aksi.

// "Tutup rekap". Bersihin pending state teks juga - abis "tutup rekap", jawaban "y"/"mundur" nyasar berikutnya
// (misal orangnya lupa) gak boleh diem-diem nerusin ke halaman rekap yang udah "ditutup". BENERAN ngehapus pesannya
// (deleteInteractionMessage), sama logika "tutup" yang konsisten di seluruh bot.
async function navClose(interaction) {
  pendingRecapPage.delete(`${interaction.channelId}:${interaction.user.id}`);
  await deleteInteractionMessage(interaction);
}

// Tutup balesan PENCARIAN member (buildSearchResultCloseRow) - gak ada pending state yang perlu dibersihin.
async function navCloseSearch(interaction) {
  await deleteInteractionMessage(interaction);
}

// Diklik dari tombol "Ya, biarin"/"Enggak, hapus aja" di BALESAN PENCARIAN (buildKeepOrDeleteRecapComponents):
// owner ngeluh tabel rekap ASLI (yang tombol "🔍 Cari member"-nya diklik) tetep numpang di channel walau yang
// dicari udah ketemu, jadi ditanya eksplisit abis nunjukkin hasil cari. customId bawa ID pesan rekap ASLI itu
// (parts[2]) - "delrecap" hapus pesan itu by ID (channel.messages.delete nerima ID langsung), "keeprecap" gak
// ngapa-ngapain selain nutup pertanyaannya. Dua-duanya ngedit BALESAN PENCARIAN ini sendiri (update, bukan pesan
// baru) buat ngilangin tombol Ya/Enggak-nya, dengan tombol "Tutup" TETEP nempel.
async function navKeepOrDeleteRecap(interaction, parts) {
  if (parts[1] === "delrecap") {
    const originalMessageId = parts[2];
    pendingRecapPage.delete(`${interaction.channelId}:${interaction.user.id}`);
    if (originalMessageId && interaction.channel) {
      await interaction.channel.messages.delete(originalMessageId).catch(() => {});
    }
  }
  await interaction.update(safeReplyOptions({ content: interaction.message.content, components: [buildSearchResultCloseRow()] }));
}

// Tombol "🔙 Kembali ke ..." (buildBackRow). customId "recap_nav:backto:<origin>" - parts[2] LANGSUNG origin-nya
// (bukan encoded range kayak aksi lain), soalnya balik ke menu asalnya gak butuh tau lagi tabel yang lagi
// ditampilin isinya apa. Nge-clear pendingRecapPage juga (sama kayak "close") - jawaban "y"/"mundur" yang nyasar
// gak boleh diem-diem nerusin ke tabel rekap yang udah ditinggalin.
async function navBackTo(interaction, parts) {
  const origin = parts[2];
  pendingRecapPage.delete(`${interaction.channelId}:${interaction.user.id}`);
  if (isLiveCountOrigin(origin)) {
    // Balik ke jawaban jumlah live member itu (lengkap dengan tombol "Lihat rekap").
    const block = buildLiveCountBlockForUsername(usernameFromLiveCountOrigin(origin));
    await interaction.update(safeReplyOptions(block || replyRecapMenu()));
    return;
  }
  if (origin === "fallback") {
    // require lazy (bukan di atas file) - chat/menu.js require dari sini (chat/replies/) buat reply builder-nya,
    // jadi require balik di ATAS file bakal circular. Sama pola-nya kayak menu.js's lazy require("./pendingState").
    const { replyFallbackMenu } = require("../../menu");
    await interaction.update(safeReplyOptions(replyFallbackMenu()));
    return;
  }
  await interaction.update(safeReplyOptions(replyRecapMenu()));
}

// Tombol "📋 Lihat rekap" di jawaban jumlah live (buildLiveCountRow) - customId "recap_nav:memberrecap:<username>".
// Nge-EDIT pesan yang sama jadi rekap member itu (tabel + Maju/Mundur/Tutup + dropdown tanggal + "Kembali ke jumlah live").
async function navOpenMemberRecap(interaction, parts) {
  const view = buildMemberRecapFromUsername(parts[2], interaction.channelId, interaction.user.id);
  await interaction.update(safeReplyOptions(view));
}

// "🔍 Cari member" - buka modal input nama; customId modal bawa range supaya hasil pencarian tahu tabel mana yang dicari.
async function navSearchMember(interaction, parts) {
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
}

// "🔢 Lompat halaman" - customId-nya bawa halaman SEKARANG (parts[3]) buat modal-nya, dipake sebagai fallback kalau
// input yang diketik ternyata gak keparse (lihat handleRecapJumpModalSubmit). `origin` (parts[4], opsional - lihat
// withOrigin) ikut ditempelin ke customId modal juga, biar tombol "🔙 Kembali" tetep nempel di tabel hasil lompat.
async function navJumpPage(interaction, parts) {
  const origin = parts[4] || "";
  const modal = new ModalBuilder()
    .setCustomId(withOrigin(`recap_jump_modal:${parts[2]}:${parts[3]}`, origin))
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
}

// "Maju ▶" / "◀ Mundur". Sesi-nya di-ambil ULANG dari sumbernya (bukan snapshot lama) - buildRecapTablePage sendiri
// udah nge-clamp target page ke totalPages TERKINI, jadi aman walau datanya berubah (mis. ada live yang baru
// selesai) sejak tombol ini pertama kali ditampilin. Aksi selain "next" diperlakukan sebagai "prev".
async function navChangePage(interaction, parts, rangeDays) {
  const origin = parts[4] || "";
  const sessions = getSessionsForRange(rangeDays);
  const currentPage = Number(parts[3]);
  const targetPage = parts[1] === "next" ? currentPage + 1 : currentPage - 1;
  await interaction.update(
    safeReplyOptions(buildRecapPageBlock(sessions, targetPage, interaction.channelId, interaction.user.id, rangeDays, origin)),
  );
}

// Aksi yang TIDAK butuh range di parts[2].
const RECAP_NAV_PLAIN_ACTIONS = new Map([
  ["close", navClose],
  ["closesearch", navCloseSearch],
  ["keeprecap", navKeepOrDeleteRecap],
  ["delrecap", navKeepOrDeleteRecap],
  ["backto", navBackTo],
  ["memberrecap", navOpenMemberRecap],
]);

// Aksi yang membawa range (parts[2]) - dan modal-nya sendiri. "next"/"prev" (dan aksi lain) jatuh ke navChangePage.
const RECAP_NAV_MODAL_ACTIONS = new Map([
  ["search", navSearchMember],
  ["jump", navJumpPage],
]);

async function handleRecapNavButton(interaction) {
  const parts = interaction.customId.split(":");

  const plain = RECAP_NAV_PLAIN_ACTIONS.get(parts[1]);
  if (plain) return plain(interaction, parts);

  // Sisanya (search/jump/next/prev) wajib membawa range di parts[2]. customId yang rusak atau aksinya tidak dikenal
  // (tombol di pesan lama, customId palsu) cukup di-acknowledge tanpa mengubah pesan - dulu jatuh ke TypeError tak
  // sengaja di decodeRecapRange dan user melihat pesan error.
  const modalAction = RECAP_NAV_MODAL_ACTIONS.get(parts[1]);
  const isPaging = parts[1] === "next" || parts[1] === "prev";
  if ((!modalAction && !isPaging) || !parts[2]) {
    await interaction.deferUpdate();
    return;
  }

  if (modalAction) return modalAction(interaction, parts);
  return navChangePage(interaction, parts, decodeRecapRange(parts[2]));
}

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
  const origin = parts[3] || "";
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

  const block = buildRecapPageBlock(sessions, targetPage, interaction.channelId, interaction.user.id, rangeDays, origin);
  await interaction.update(safeReplyOptions({ content: `${block.content}${note}`, components: block.components }));
}

module.exports = {
  tryHandleRecapPageShortcut,
  handleRecapNavButton,
  handleRecapJumpModalSubmit,
};
