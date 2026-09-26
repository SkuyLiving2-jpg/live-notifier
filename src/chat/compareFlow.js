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
const { replyCompareMembersByUsername, describeMissingMember, sameMemberMessage, buildCompareCloseRow, COMPARE_CLOSE_ID } = require("./replies");
const { deleteInteractionMessage } = require("./interactionHelpers");
const { safeReplyOptions } = require("../utils");

// Flow dropdown/search buat "cok bandingin" yang diketik POLOS, tanpa
// "<A> dan <B>" sekaligus (owner ngeluh kalau gitu doang, kepentok jatuh ke
// menu fallback 9-opsi generik, padahal maksudnya emang mau bandingin -
// cuma belum mutusin siapa dan siapa). Alurnya 2 langkah, satu pesan yang
// SAMA terus di-edit di tempat (interaction.update) di tiap langkah - biar
// gak numpuk beberapa pesan di channel cuma buat satu proses milih member:
//   1. Tombol "🔍 Cari Member A" -> modal cari nama -> (0 match: coba lagi,
//      1 match: langsung lanjut ke langkah 2, >1 match: dropdown milih).
//   2. Sama persis buat "Member B", tapi member yang SAMA kayak A ditolak
//      (gak masuk akal nge-compare 1 orang sama dirinya sendiri) dengan pesan
//      yang jelas, bukan pura-pura "gak ketemu".
// Username A dibawa lewat customId di tiap komponen (bukan disimpen di
// pendingState.js) - sengaja STATELESS: gak ada Map yang perlu di-TTL-in
// atau dibersihin manual pas "Tutup" dipencet, dan flow-nya juga cuma nempel
// ke SATU pesan (gak butuh channel+author sebagai kunci state terpisah).
function buildSearchButtonRow(step, usernameA) {
  const customId = step === "A" ? "compare_pick:searchA" : `compare_pick:searchB:${usernameA}`;
  const label = step === "A" ? "🔍 Cari Member A" : "🔍 Cari Member B";
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(customId).setLabel(label).setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(COMPARE_CLOSE_ID).setLabel("Tutup").setStyle(ButtonStyle.Danger),
  );
}

// Dipanggil dari chat/router.js pas user ketik "bandingin" tanpa pola
// "<A> dan <B>" yang lengkap (lihat compareMatch di router.js) - ganti dari
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

// `message` udah jadi teks jadi (dari describeMissingMember/sameMemberMessage) -
// tombol "cari lagi" + "Tutup" ditempelin biar salah ketik gak bikin buntu.
function buildRetryBlock(step, usernameA, message) {
  return {
    content: `${message}\nCoba cari lagi Member ${step}, atau tutup kalau gak jadi.`,
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

// Langkah TERAKHIR (member B udah kepilih). Tombol Tutup di hasilnya (owner
// minta eksplisit: "kalo perbandingan nya sudah muncul, berikan juga tombol
// tutup") udah nempel dari replies.js's buildCompareReply - sama persis
// kayak ketikan langsung "bandingin <A> dan <B>". Member B yang ternyata SAMA
// kayak A (mis. dari dropdown lama yang masih kepencet) ditolak di sini.
async function finishCompare(usernameA, memberB) {
  if (memberB.username === usernameA) {
    const name = loadLiveCount()[usernameA]?.name || usernameA;
    return buildRetryBlock("B", usernameA, sameMemberMessage(name, memberB.name));
  }
  return replyCompareMembersByUsername(usernameA, memberB.username);
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

  const allMatches = searchLiveCountByNameFragment(query);
  // Member B gak boleh sama kayak A - yang cocok query tapi = A dibuang, dan
  // kalau SEMUA yang cocok cuma A, bilang terus terang itu member yang sama
  // (bukan "gak ketemu", yang salah: dia jelas ada).
  const matches = step === "B" ? allMatches.filter((m) => m.username !== usernameA) : allMatches;

  if (matches.length === 0) {
    const message =
      allMatches.length > 0 ? sameMemberMessage(loadLiveCount()[usernameA]?.name || usernameA, query) : await describeMissingMember(query);
    await interaction.update(safeReplyOptions(buildRetryBlock(step, usernameA, message)));
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
