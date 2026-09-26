const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
} = require("discord.js");
const { loadLiveCount, searchLiveCountByNameFragment } = require("../storage/liveCount");
const { replyCompareMembersByUsername } = require("./replies");
const { deleteInteractionMessage } = require("./interactionHelpers");
const { safeReplyOptions } = require("../utils");

// Flow dropdown/search buat "cok bandingin" yang diketik POLOS, tanpa
// "<A> vs <B>" sekaligus (owner ngeluh kalau gitu doang, kepentok jatuh ke
// menu fallback 9-opsi generik, padahal maksudnya emang mau bandingin -
// cuma belum mutusin siapa vs siapa). Alurnya 2 langkah, satu pesan yang
// SAMA terus di-edit di tempat (interaction.update) di tiap langkah - biar
// gak numpuk beberapa pesan di channel cuma buat satu proses milih member:
//   1. Tombol "🔍 Cari Member A" -> modal cari nama -> (0 match: coba lagi,
//      1 match: langsung lanjut ke langkah 2, >1 match: dropdown milih).
//   2. Sama persis buat "Member B", CUMA username A udah kepilih di-exclude
//      dari kandidat pencarian (gak masuk akal nge-compare 1 orang sama
//      dirinya sendiri, dan itu sekarang dicegah dari SINI, bukan dicek
//      belakangan kayak replyCompareMembers versi fragment).
// Username A dibawa lewat customId di tiap komponen (bukan disimpen di
// pendingState.js) - sengaja STATELESS: gak ada Map yang perlu di-TTL-in
// atau dibersihin manual pas "Tutup" dipencet, dan flow-nya juga cuma nempel
// ke SATU pesan (gak butuh channel+author sebagai kunci state terpisah).
const COMPARE_CLOSE_ID = "compare_pick:close";

function buildCompareCloseRow() {
  return new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(COMPARE_CLOSE_ID).setLabel("Tutup").setStyle(ButtonStyle.Danger));
}

function buildSearchButtonRow(step, usernameA) {
  const customId = step === "A" ? "compare_pick:searchA" : `compare_pick:searchB:${usernameA}`;
  const label = step === "A" ? "🔍 Cari Member A" : "🔍 Cari Member B";
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(customId).setLabel(label).setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(COMPARE_CLOSE_ID).setLabel("Tutup").setStyle(ButtonStyle.Danger),
  );
}

// Dipanggil dari chat/router.js pas user ketik "bandingin" tanpa pola
// "<A> vs <B>" yang lengkap (lihat compareMatch di router.js) - ganti dari
// jatuh ke fallback menu generik.
function replyStartComparePick() {
  return {
    content: "Mau bandingin siapa lawan siapa nih, cok? Cari member A dulu.",
    components: [buildSearchButtonRow("A", null)],
  };
}

function buildCompareSearchModal(step, usernameA) {
  const customId = step === "A" ? "compare_modal:A" : `compare_modal:B:${usernameA}`;
  return new ModalBuilder()
    .setCustomId(customId)
    .setTitle(step === "A" ? "Cari Member A" : "Cari Member B")
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("member_query")
          .setLabel("Nama member")
          .setStyle(TextInputStyle.Short)
          .setPlaceholder("misal: Nala")
          .setRequired(true),
      ),
    );
}

function buildNoMatchBlock(step, usernameA, query) {
  const label = step === "A" ? "A" : "B";
  return {
    content: `Cok, gak ketemu member "${query}" buat Member ${label}. Coba kata kunci lain.`,
    components: [buildSearchButtonRow(step, usernameA)],
  };
}

function buildSelectBlock(step, usernameA, matches) {
  const truncated = matches.slice(0, 25);
  const customId = step === "A" ? "compare_select:A" : `compare_select:B:${usernameA}`;
  const select = new StringSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder("Pilih member...")
    .addOptions(truncated.map((m) => ({ label: m.name, value: m.username, description: `${m.count}x live` })));
  const truncNote = matches.length > 25 ? `\n_(cuma nunjukkin 25 dari ${matches.length} hasil - coba kata kunci lebih spesifik)_` : "";
  const label = step === "A" ? "A" : "B";

  return {
    content: `🔍 Ketemu ${matches.length} member buat Member ${label}. Pilih yang mana, cok?${truncNote}`,
    components: [new ActionRowBuilder().addComponents(select), buildCompareCloseRow()],
  };
}

function buildPickBPromptBlock(memberA) {
  return {
    content: `Member A: **${memberA.name}** ✅\nSekarang cari member B buat dibandingin.`,
    components: [buildSearchButtonRow("B", memberA.username)],
  };
}

// Langkah TERAKHIR (member B udah kepilih) - hasil replyCompareMembersByUsername
// ditempelin tombol Tutup (owner minta ini eksplisit: "kalo perbandingan nya
// sudah muncul, berikan juga tombol tutup supaya tidak ngeload terlalu
// banyak pesan di channel tersebut") - beda dari replyCompareMembers versi
// teks ("cok bandingin <A> vs <B>" langsung), yang gak lewat flow interaktif
// ini jadi gak ada tombolnya sama sekali.
async function finishCompare(usernameA, memberB) {
  const reply = await replyCompareMembersByUsername(usernameA, memberB.username);
  const components = [buildCompareCloseRow()];
  if (typeof reply === "string") return { content: reply, components };
  return { ...reply, components };
}

// Dipake abis modal search cuma nemu SATU kandidat (langsung dianggep
// kepilih, gak perlu dropdown cuma buat 1 opsi) MAUPUN abis user beneran
// milih dari dropdown (>1 kandidat) - dua jalur itu ujungnya sama: lanjut ke
// langkah B (kalau baru selesai milih A) atau langsung tampilin hasil
// perbandingan (kalau baru selesai milih B).
async function resolvePicked(step, usernameA, picked) {
  if (step === "A") return buildPickBPromptBlock(picked);
  return finishCompare(usernameA, picked);
}

async function handleComparePickButton(interaction) {
  const parts = interaction.customId.split(":");
  const action = parts[1];

  if (action === "close") {
    await deleteInteractionMessage(interaction);
    return;
  }

  const step = action === "searchA" ? "A" : "B";
  const usernameA = step === "B" ? parts[2] : null;
  await interaction.showModal(buildCompareSearchModal(step, usernameA));
}

async function handleCompareModalSubmit(interaction) {
  const parts = interaction.customId.split(":");
  const step = parts[1];
  const usernameA = step === "B" ? parts[2] : null;
  const query = interaction.fields.getTextInputValue("member_query").trim();

  const matches = searchLiveCountByNameFragment(query, step === "B" ? usernameA : null);

  if (matches.length === 0) {
    await interaction.update(safeReplyOptions(buildNoMatchBlock(step, usernameA, query)));
    return;
  }
  if (matches.length === 1) {
    await interaction.update(safeReplyOptions(await resolvePicked(step, usernameA, matches[0])));
    return;
  }
  await interaction.update(safeReplyOptions(buildSelectBlock(step, usernameA, matches)));
}

async function handleCompareSelect(interaction) {
  const parts = interaction.customId.split(":");
  const step = parts[1];
  const usernameA = step === "B" ? parts[2] : null;
  const chosenUsername = interaction.values[0];

  const data = loadLiveCount();
  const picked = { username: chosenUsername, name: data[chosenUsername]?.name || chosenUsername };
  await interaction.update(safeReplyOptions(await resolvePicked(step, usernameA, picked)));
}

module.exports = {
  replyStartComparePick,
  handleComparePickButton,
  handleCompareModalSubmit,
  handleCompareSelect,
};
