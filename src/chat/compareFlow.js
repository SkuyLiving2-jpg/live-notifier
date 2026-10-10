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
const {
  replyCompareMembersByUsername,
  replyCompareMembersMultiByUsername,
  describeMissingMember,
  sameMemberMessage,
  buildCompareCloseRow,
  COMPARE_CLOSE_ID,
  MAX_COMPARE_MEMBERS,
} = require("./replies");
const { deleteInteractionMessage } = require("./interactionHelpers");
const { safeReplyOptions } = require("../utils");

// Flow dropdown/search buat "cok bandingin" yang diketik POLOS, tanpa nama
// member sama sekali (owner ngeluh: dulu flow ini cuma nanya "Member A" dan
// "Member B", jadi kesannya bandingin cuma bisa 2 orang - padahal bisa sampai
// MAX_COMPARE_MEMBERS). Alurnya satu pesan yang SAMA terus di-edit di tempat
// (interaction.update) di tiap langkah:
//   1. Dropdown "mau bandingin berapa member?" (2 sampai MAX_COMPARE_MEMBERS).
//   2. Diulang sebanyak jumlah itu: tombol "🔍 Cari Member k" -> modal cari nama
//      -> (0 match: coba lagi, 1 match: langsung kepilih, >1 match: dropdown).
//      Member yang SAMA kayak yang udah dipilih ditolak dengan pesan jelas.
//   3. Begitu jumlahnya terpenuhi, hasil perbandingan muncul (tombol Tutup
//      nempel dari replies/compare.js's buildCompareReply/buildCompareReplyMulti).
// "Tutup" ada di SETIAP langkah.
//
// State (jumlah target + username yang udah dipilih) dibawa lewat customId di
// tiap komponen - sengaja STATELESS, sama alasan kayak versi lama: gak ada Map
// yang perlu di-TTL-in atau dibersihin pas "Tutup". Format customId:
//   compare_pick:search:<n>:<daftar>   (tombol cari)
//   compare_modal:<n>:<daftar>         (modal cari)
//   compare_select:<n>:<daftar>        (dropdown hasil cari)
// <daftar> = username dipisah koma, awalan "jkt48_" dibuang biar 4 username
// (langkah ke-5) tetep muat di batas 100 karakter customId Discord.
//
// customId LAMA ("compare_pick:searchA", "searchB:<username>", "compare_modal:A",
// "compare_modal:B:<username>", "compare_select:A"/"B:<username>") dari pesan
// yang masih nongkrong di channel tetep dikenali, dianggap perbandingan 2 member.
const COUNT_SELECT_ID = "compare_count";

function encodePicked(usernames) {
  return usernames.map((u) => (u.startsWith("jkt48_") ? u.slice(6) : `!${u}`)).join(",");
}

function decodePicked(text) {
  if (!text) return [];
  return text.split(",").map((t) => (t.startsWith("!") ? t.slice(1) : `jkt48_${t}`));
}

// `parts` = potongan customId SETELAH awalan komponennya ("compare_modal"/
// "compare_select"/"compare_pick:search"), mis. ["3", "nala,levi"] atau bentuk
// lama ["A"] / ["B", "jkt48_nala"].
function parseState(parts) {
  if (parts[0] === "A") return { n: 2, picked: [] };
  if (parts[0] === "B") return { n: 2, picked: parts[1] ? [parts[1]] : [] };
  const n = Math.min(Math.max(Number(parts[0]) || 2, 2), MAX_COMPARE_MEMBERS);
  return { n, picked: decodePicked(parts[1]) };
}

function nameOf(username) {
  return loadLiveCount()[username]?.name || username;
}

function buildCloseButton() {
  return new ButtonBuilder().setCustomId(COMPARE_CLOSE_ID).setLabel("Tutup").setStyle(ButtonStyle.Danger);
}

function buildSearchButtonRow(state) {
  const slot = state.picked.length + 1;
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`compare_pick:search:${state.n}:${encodePicked(state.picked)}`)
      .setLabel(`🔍 Cari Member ${slot}`)
      .setStyle(ButtonStyle.Primary),
    buildCloseButton(),
  );
}

// Langkah 1: "bandingin" polos. Dipanggil chat/router.js.
function replyStartComparePick() {
  const options = [];
  for (let n = 2; n <= MAX_COMPARE_MEMBERS; n++) options.push({ label: `${n} member`, value: String(n) });
  const select = new StringSelectMenuBuilder().setCustomId(COUNT_SELECT_ID).setPlaceholder("Pilih jumlah member...").addOptions(options);
  return {
    content: `Mau bandingin berapa member, cok? (2 sampai ${MAX_COMPARE_MEMBERS})`,
    components: [new ActionRowBuilder().addComponents(select), buildCompareCloseRow()],
  };
}

function buildPickPrompt(state, intro) {
  const slot = state.picked.length + 1;
  const pickedLine = state.picked.length > 0 ? `Udah dipilih: ${state.picked.map((u) => `**${nameOf(u)}**`).join(", ")} ✅\n` : "";
  return {
    content: `${intro ? `${intro}\n` : ""}${pickedLine}Sekarang cari Member ${slot} dari ${state.n}.`,
    components: [buildSearchButtonRow(state)],
  };
}

function buildCompareSearchModal(state) {
  const slot = state.picked.length + 1;
  return new ModalBuilder()
    .setCustomId(`compare_modal:${state.n}:${encodePicked(state.picked)}`)
    .setTitle(`Cari Member ${slot}`)
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

// `message` udah jadi teks jadi (dari describeMissingMember/pesan duplikat) -
// tombol "cari lagi" + "Tutup" ditempelin biar salah ketik gak bikin buntu.
function buildRetryBlock(state, message) {
  return {
    content: `${message}\nCoba cari lagi Member ${state.picked.length + 1}, atau tutup kalau gak jadi.`,
    components: [buildSearchButtonRow(state)],
  };
}

function buildSelectBlock(state, matches) {
  const truncated = matches.slice(0, 25);
  const select = new StringSelectMenuBuilder()
    .setCustomId(`compare_select:${state.n}:${encodePicked(state.picked)}`)
    .setPlaceholder("Pilih member...")
    .addOptions(truncated.map((m) => ({ label: m.name, value: m.username, description: `${m.count}x live` })));
  const truncNote = matches.length > 25 ? `\n_(cuma nunjukkin 25 dari ${matches.length} hasil - coba kata kunci lebih spesifik)_` : "";

  return {
    content: `🔍 Ketemu ${matches.length} member buat Member ${state.picked.length + 1}. Pilih yang mana, cok?${truncNote}`,
    components: [new ActionRowBuilder().addComponents(select), buildCompareCloseRow()],
  };
}

// Pesan penolakan buat member yang udah dipilih. Buat 2 member tetep pesan lama
// (sameMemberMessage); buat 3+ disesuaiin ("dua member" gak pas lagi).
function duplicateMessage(state, dupUsername, shown) {
  if (state.n === 2) return sameMemberMessage(nameOf(dupUsername), shown);
  return `Cok, "${shown}" itu **${nameOf(dupUsername)}** yang udah kamu pilih tadi. Pilih member yang BEDA ya.`;
}

// Abis satu member kepilih: lanjut ke slot berikutnya, atau tampilin hasil
// kalau jumlahnya udah terpenuhi. Member yang udah ada di daftar ditolak (jaga
// juga dari dropdown lama yang kepencet ulang).
async function acceptPick(state, picked) {
  if (state.picked.includes(picked.username)) {
    return buildRetryBlock(state, duplicateMessage(state, picked.username, picked.name));
  }
  const next = { n: state.n, picked: [...state.picked, picked.username] };
  if (next.picked.length < next.n) return buildPickPrompt(next);
  return next.n === 2 ? replyCompareMembersByUsername(next.picked[0], next.picked[1]) : replyCompareMembersMultiByUsername(next.picked);
}

async function handleCompareCountSelect(interaction) {
  const n = Math.min(Math.max(Number(interaction.values[0]) || 2, 2), MAX_COMPARE_MEMBERS);
  await interaction.update(safeReplyOptions(buildPickPrompt({ n, picked: [] }, `Oke, bandingin ${n} member.`)));
}

async function handleComparePickButton(interaction) {
  const parts = interaction.customId.split(":");
  const action = parts[1];

  if (action === "close") {
    await deleteInteractionMessage(interaction);
    return;
  }

  // Bentuk baru: "search:<n>:<daftar>". Bentuk lama: "searchA" / "searchB:<u>".
  let state;
  if (action === "search") state = parseState(parts.slice(2));
  else if (action === "searchA") state = parseState(["A"]);
  else state = parseState(["B", parts[2]]);
  await interaction.showModal(buildCompareSearchModal(state));
}

async function handleCompareModalSubmit(interaction) {
  const state = parseState(interaction.customId.split(":").slice(1));
  const query = interaction.fields.getTextInputValue("member_query").trim();

  const allMatches = searchLiveCountByNameFragment(query);
  // Member yang udah dipilih dibuang dari hasil, dan kalau SEMUA yang cocok
  // udah dipilih, bilang terus terang (bukan "gak ketemu", yang salah: dia
  // jelas ada).
  const matches = allMatches.filter((m) => !state.picked.includes(m.username));

  if (matches.length === 0) {
    const message = allMatches.length > 0 ? duplicateMessage(state, allMatches[0].username, query) : await describeMissingMember(query);
    await interaction.update(safeReplyOptions(buildRetryBlock(state, message)));
    return;
  }
  if (matches.length === 1) {
    await interaction.update(safeReplyOptions(await acceptPick(state, matches[0])));
    return;
  }
  await interaction.update(safeReplyOptions(buildSelectBlock(state, matches)));
}

async function handleCompareSelect(interaction) {
  const state = parseState(interaction.customId.split(":").slice(1));
  const chosenUsername = interaction.values[0];
  const picked = { username: chosenUsername, name: nameOf(chosenUsername) };
  await interaction.update(safeReplyOptions(await acceptPick(state, picked)));
}

module.exports = {
  replyStartComparePick,
  handleComparePickButton,
  handleCompareModalSubmit,
  handleCompareSelect,
  handleCompareCountSelect,
};
