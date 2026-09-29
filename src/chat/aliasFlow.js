const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
} = require("discord.js");
const { loadAliases, resolveAliasInFragment } = require("../storage/aliases");
const { searchLiveCountByNameFragment, loadLiveCount } = require("../storage/liveCount");
const { fetchPublicProfileByUsername, isJkt48Member } = require("../idnApi");
const { normalizeMemberFragment, isOwner, handleAddAlias, handleRemoveAlias, replyAliasList } = require("./replies");
const { deleteInteractionMessage } = require("./interactionHelpers");
const { safeReplyOptions } = require("../utils");

// Owner nemu 2 hal janggal di layar "📖 Daftar alias" (dulu cuma teks
// read-only, replyAliasList() apa adanya): (1) gak ada cara NAMBAH alias
// lewat tombol sama sekali (cuma keyword-only "cok tambah alias <a> = <b>",
// disebutin di dropdown "🔧 Kelola alias" EXTRA_FEATURES tapi user harus
// hafal formatnya sendiri), dan (2) demikian juga buat HAPUS. Owner minta
// wizard berlangkah: tanya dulu "mau nambah alias?", search bar buat CARI
// member aslinya (bukan asal user ngetik nama sembarangan - divalidasi ke
// data member yang beneran dikenal bot ATAU ke IDN langsung), BARU minta
// ketik alias-nya, dengan tombol Tutup/Kembali di TIAP langkah biar user gak
// kejebak kalau salah pencet. Tombol hapus CUMA muncul kalau udah ada alias
// yang bisa dihapus (list kosong = tombol itu gak usah nongol sama sekali).
//
// Layar daftar alias bisa dibuka dari DUA tempat, dan "Batal"/hasil akhir
// wizard balik ke layar ASAL-nya (lihat buildReturnScreen):
// - tombol "📖 Daftar alias" di menu fallback ber-halaman (menu.js's
//   buildAliasListMenuScreen) -> balik ke daftar alias + menu halaman itu
//   lagi. BUG YANG DILAPORIN OWNER: dulu "Batal" selalu balik ke layar
//   standalone, jadi menu halaman terakhir yang tadinya ada tiba-tiba ilang.
// - ketikan "alias"/"cok alias"/"cok daftar alias" (chat/router.js) ->
//   buildAliasListBlock di bawah, standalone dengan tombol Tutup sendiri.
//
// Alur (semua stateless lewat customId KECUALI satu langkah - lihat
// pendingAliasFlow di bawah buat alasannya):
//   1. Tombol "➕ Tambah alias" -> owner-gate -> "Yakin mau nambah?" (Ya/Batal)
//   2. "Ya, lanjut" -> modal cari nama member (SAMA POLA kayak
//      compareFlow.js's search modal: 0 match coba IDN langsung [member real
//      tapi belum pernah live tetep valid, sama kayak describeMissingMember],
//      1 match auto-lanjut, >1 match dropdown).
//   3. Target kepilih -> "Target ketemu: X, lanjut isi alias?" (Isi
//      alias/Cari lagi/Batal).
//   4. "Isi alias" -> modal ketik alias/panggilan -> "Alias 'x' -> 'X',
//      simpan?" (Simpan/Ubah alias/Ganti target/Batal).
//   5. "Simpan" -> commit via handleAddAlias (replies.js) - REUSE fungsi yang
//      SAMA persis dipake command teks "cok tambah alias", bukan ditulis
//      ulang. Sama pola keamanan yang dipake slashCommands.js: owner-gate
//      nempel DI DALEM handleAddAlias sendiri, jadi mustahil kelupaan
//      dipasang di jalur tombol ini.
//
// Owner-gate KEDUA di tiap dispatcher di bawah (rejectNonOwner) - tombol
// Discord keliatan & bisa diklik SEMUA orang di channel, jadi tanpa ini
// orang lain bisa ngeklik "Ubah alias"/"Batal" dkk di pesan wizard PUNYA
// owner: pesan owner ke-edit, dan (bug beneran) layar konfirmasi bisa
// nampilin alias ketikan orang lain sementara "Simpan" owner nyimpen alias
// pending punya owner sendiri - yang tampil beda dari yang disimpen.
// Penolakannya EPHEMERAL (cuma keliatan si pengklik), pesan owner gak
// disentuh sama sekali. PENGECUALIAN: "Tutup" (cuma ada di layar daftar
// alias standalone, bukan di langkah wizard manapun) boleh siapa aja - daftar
// alias itu read-only buat semua orang, dan owner minta tombol Tutup buat
// yang salah ketik "alias", sama kayak Tutup di menu lain di bot ini.
//
// Hapus alias: tombol "🗑️ Hapus alias" (CUMA muncul kalau daftar aliasnya gak
// kosong) -> owner-gate -> dropdown pilih alias yang mana -> "Yakin hapus
// 'x'?" (Ya/Batal) -> commit via handleRemoveAlias (replies.js, sama alasan
// reuse-nya kayak di atas).

// "channelId:authorId" -> { username, aliasText, at } - state SATU-SATUNYA
// yang butuh nampung antar-interaction di wizard ini: alias/panggilan yang
// diketik user di modal langkah 4 harus "nyambung" ke tombol "Simpan" di
// langkah 5, TAPI teks bebas ketikan modal gak aman dititipin lewat customId
// (bisa ngandung ":" yang dipake sebagai delimiter parsing di sini, dan ada
// batas 100 karakter customId Discord) - beda dari username target (langkah
// 2-4) yang aman dititip di customId soalnya format IDN-nya selalu
// alfanumerik+underscore doang, gak pernah ngandung ":". Sama pola TTL-nya
// kayak menu.js's pendingWatchConfirm.
const pendingAliasFlow = new Map();
const PENDING_ALIAS_FLOW_TTL_MS = 5 * 60000;

function pendingKey(channelId, authorId) {
  return `${channelId}:${authorId}`;
}

function setPendingAliasFlow(channelId, authorId, data) {
  pendingAliasFlow.set(pendingKey(channelId, authorId), { ...data, at: Date.now() });
}

function getPendingAliasFlow(channelId, authorId) {
  const key = pendingKey(channelId, authorId);
  const entry = pendingAliasFlow.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at > PENDING_ALIAS_FLOW_TTL_MS) {
    pendingAliasFlow.delete(key);
    return null;
  }
  return entry;
}

function clearPendingAliasFlow(channelId, authorId) {
  pendingAliasFlow.delete(pendingKey(channelId, authorId));
}

function displayNameForUsername(username) {
  return loadLiveCount()[username]?.name || username.replace(/^jkt48_/, "");
}

function buildCloseButton() {
  return new ButtonBuilder().setCustomId("alias_flow:close").setLabel("Tutup").setStyle(ButtonStyle.Danger);
}

function buildCancelButton() {
  return new ButtonBuilder().setCustomId("alias_flow:cancel").setLabel("❌ Batal").setStyle(ButtonStyle.Danger);
}

function buildAliasActionButtonsRow(hasAliases) {
  const buttons = [new ButtonBuilder().setCustomId("alias_flow:add").setLabel("➕ Tambah alias").setStyle(ButtonStyle.Success)];
  if (hasAliases) {
    buttons.push(new ButtonBuilder().setCustomId("alias_flow:remove").setLabel("🗑️ Hapus alias").setStyle(ButtonStyle.Danger));
  }
  return new ActionRowBuilder().addComponents(buttons);
}

function aliasListContent(prefixMessage) {
  return prefixMessage ? `${prefixMessage}\n\n${replyAliasList()}` : replyAliasList();
}

function hasAnyAlias() {
  return Object.keys(loadAliases()).length > 0;
}

// Layar "daftar alias" STANDALONE (dari ketikan "alias", lihat komen di
// atas) - tombol Tutup-nya beneran ngehapus pesan. `prefixMessage` opsional
// (hasil operasi sebelumnya) ditaro DI ATAS daftar alias-nya.
function buildAliasListBlock(prefixMessage) {
  return {
    content: aliasListContent(prefixMessage),
    components: [buildAliasActionButtonsRow(hasAnyAlias()), new ActionRowBuilder().addComponents(buildCloseButton())],
  };
}

// ID pesan yang wizard-nya dimulai dari menu fallback. Dideteksi pas tombol
// Tambah/Hapus diklik (pesannya MASIH nampilin tombol "fallback_menu:..."
// di titik itu), soalnya langkah-langkah wizard berikutnya ngedit pesan yang
// SAMA dan tombol menunya udah gak ada lagi buat dicek. Dihapus lagi begitu
// balik ke layar daftar alias, jadi isinya cuma wizard yang lagi jalan.
const menuOriginMessageIds = new Set();

function isShowingFallbackMenu(message) {
  return Boolean(message?.components?.some((row) => row.components?.some((c) => c.customId?.startsWith("fallback_menu:"))));
}

function rememberOrigin(interaction) {
  if (interaction.message?.id && isShowingFallbackMenu(interaction.message)) menuOriginMessageIds.add(interaction.message.id);
}

// Tujuan balik "Batal" dan hasil akhir tambah/hapus - layar ASAL wizard-nya.
// menu.js di-require LAZY (di dalem function, bukan di atas file) soalnya
// menu.js sendiri require modul ini di atasnya - sama trik yang dipake
// menu.js's handleFallbackMenuButton buat pendingState.js.
function buildReturnScreen(interaction, prefixMessage) {
  const messageId = interaction.message?.id;
  if (messageId && menuOriginMessageIds.delete(messageId)) {
    const { buildAliasListMenuScreen } = require("./menu");
    return buildAliasListMenuScreen(prefixMessage);
  }
  return buildAliasListBlock(prefixMessage);
}

function buildAddSearchModal() {
  return new ModalBuilder()
    .setCustomId("alias_modal:search")
    .setTitle("Cari member buat dikasih alias")
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("member_query")
          .setLabel("Nama member aslinya")
          .setStyle(TextInputStyle.Short)
          .setPlaceholder("misal: Nala")
          .setRequired(true),
      ),
    );
}

function buildAliasTextModal(username) {
  return new ModalBuilder()
    .setCustomId(`alias_modal:aliastext:${username}`)
    .setTitle("Ketik alias/panggilannya")
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("alias_text")
          .setLabel("Alias/panggilan barunya")
          .setStyle(TextInputStyle.Short)
          .setPlaceholder("misal: kimkim")
          .setRequired(true),
      ),
    );
}

function buildSearchRetryBlock(message) {
  return {
    content: `${message}\nCoba cari lagi, atau batal kalau gak jadi.`,
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("alias_flow:research").setLabel("🔍 Cari lagi").setStyle(ButtonStyle.Primary),
        buildCancelButton(),
      ),
    ],
  };
}

function buildTargetSelectBlock(matches) {
  const truncated = matches.slice(0, 25);
  const select = new StringSelectMenuBuilder()
    .setCustomId("alias_select:target")
    .setPlaceholder("Pilih member...")
    .addOptions(truncated.map((m) => ({ label: m.name, value: m.username, description: m.neverLive ? "belum pernah live" : `${m.count}x live` })));
  const truncNote = matches.length > 25 ? `\n_(cuma nunjukkin 25 dari ${matches.length} hasil - coba kata kunci lebih spesifik)_` : "";
  return {
    content: `🔍 Ketemu ${matches.length} member. Yang mana yang mau dikasih alias, cok?${truncNote}`,
    components: [new ActionRowBuilder().addComponents(select), new ActionRowBuilder().addComponents(buildCancelButton())],
  };
}

function buildTargetConfirmedBlock(match) {
  const note = match.neverLive ? " (belum pernah live semenjak bot ini mantau, tapi member JKT48 beneran)" : "";
  return {
    content: `Target ketemu: **${match.name}**${note}.\nLanjut isi alias/panggilannya?`,
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`alias_flow:target_confirmed:${match.username}`).setLabel("✏️ Isi alias").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId("alias_flow:research").setLabel("🔍 Cari lagi").setStyle(ButtonStyle.Secondary),
        buildCancelButton(),
      ),
    ],
  };
}

function buildCommitConfirmBlock(username, aliasText) {
  const name = displayNameForUsername(username);
  return {
    content: `Alias: **"${aliasText}"** -> **${name}**\nSimpan?`,
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("alias_flow:commit").setLabel("✅ Simpan").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`alias_flow:edit_alias:${username}`).setLabel("✏️ Ubah alias").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("alias_flow:research").setLabel("🔁 Ganti target").setStyle(ButtonStyle.Secondary),
        buildCancelButton(),
      ),
    ],
  };
}

// Cek member lokal (activeLives/liveCount, lewat searchLiveCountByNameFragment
// yang UDAH ngerti alias - lihat storage/aliases.js's resolveAliasInFragment)
// dulu. Kalau nihil, fallback ke IDN LANGSUNG (sama persis logika
// replies.js's describeMissingMember) - member yang REAL tapi belum pernah
// live (kayak Kimmy) tetep harus bisa didaftarin alias-nya, bukan cuma yang
// udah pernah kecatet live.
async function searchTargetCandidates(query) {
  const localMatches = searchLiveCountByNameFragment(query);
  if (localMatches.length > 0) return { matches: localMatches, idnError: null };

  const token = normalizeMemberFragment(resolveAliasInFragment(query)).split(" ")[0];
  if (!token || token.length < 2) return { matches: [], idnError: null };

  try {
    const username = `jkt48_${token}`;
    const profile = await fetchPublicProfileByUsername(username);
    if (profile && isJkt48Member(profile)) {
      return { matches: [{ username, name: profile.name, neverLive: true }], idnError: null };
    }
    return { matches: [], idnError: null };
  } catch (error) {
    return { matches: [], idnError: error };
  }
}

async function rejectNonOwner(interaction) {
  if (isOwner(interaction.user.id)) return false;
  await interaction.reply(safeReplyOptions({ content: "Cok, cuma owner yang boleh ubah daftar alias.", flags: MessageFlags.Ephemeral }));
  return true;
}

async function handleAliasAddButton(interaction) {
  rememberOrigin(interaction);
  await interaction.update(
    safeReplyOptions({
      content: "Mau nambah alias/panggilan baru buat member? Nanti kamu cari dulu member aslinya, baru ketik alias-nya.",
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId("alias_flow:add_confirm").setLabel("✅ Ya, lanjut").setStyle(ButtonStyle.Success),
          buildCancelButton(),
        ),
      ],
    }),
  );
}

// "add_confirm" (baru mulai) DAN "research" (cari ulang dari langkah manapun)
// sama-sama cuma munculin modal cari nama - showModal() HARUS jadi
// satu-satunya respon buat interaction tombolnya, gak bisa didahului
// interaction.update() (sama aturan yang compareFlow.js udah ikutin).
async function handleAliasResearchButton(interaction) {
  await interaction.showModal(buildAddSearchModal());
}

// "target_confirmed:<username>" (abis target kepilih) DAN "edit_alias:<username>"
// (mau ganti alias-nya doang, target tetep) sama-sama munculin modal ketik
// alias buat username yang sama.
async function handleAliasTextButton(interaction) {
  const username = interaction.customId.split(":")[2];
  await interaction.showModal(buildAliasTextModal(username));
}

async function handleAliasSearchModalSubmit(interaction) {
  const query = interaction.fields.getTextInputValue("member_query").trim();
  const { matches, idnError } = await searchTargetCandidates(query);

  if (idnError) {
    await interaction.update(
      safeReplyOptions(
        buildSearchRetryBlock(
          `Cok, "${query}" belum ada di catatan bot, dan bot lagi gak bisa ngecek ke IDN buat mastiin dia member atau bukan. Coba lagi bentar.`,
        ),
      ),
    );
    return;
  }
  if (matches.length === 0) {
    await interaction.update(
      safeReplyOptions(
        buildSearchRetryBlock(`Cok, gak nemu member JKT48 bernama "${query}" - cek lagi ejaan namanya (atau mungkin dia belum punya akun IDN).`),
      ),
    );
    return;
  }
  if (matches.length === 1) {
    await interaction.update(safeReplyOptions(buildTargetConfirmedBlock(matches[0])));
    return;
  }
  await interaction.update(safeReplyOptions(buildTargetSelectBlock(matches)));
}

async function handleAliasTargetSelect(interaction) {
  const username = interaction.values[0];
  await interaction.update(safeReplyOptions(buildTargetConfirmedBlock({ username, name: displayNameForUsername(username) })));
}

async function handleAliasTextModalSubmit(interaction) {
  const username = interaction.customId.split(":")[2];
  const aliasText = interaction.fields.getTextInputValue("alias_text").trim();
  setPendingAliasFlow(interaction.channelId, interaction.user.id, { username, aliasText });
  await interaction.update(safeReplyOptions(buildCommitConfirmBlock(username, aliasText)));
}

async function handleAliasCommitButton(interaction) {
  const pending = getPendingAliasFlow(interaction.channelId, interaction.user.id);
  clearPendingAliasFlow(interaction.channelId, interaction.user.id);
  if (!pending) {
    await interaction.update(
      safeReplyOptions(buildReturnScreen(interaction, "Cok, kelamaan mikirnya - kalau masih mau nambah alias, mulai lagi ya.")),
    );
    return;
  }
  const targetToken = pending.username.replace(/^jkt48_/, "");
  const resultMessage = await handleAddAlias(pending.aliasText, targetToken, interaction.user.id);
  await interaction.update(safeReplyOptions(buildReturnScreen(interaction, resultMessage)));
}

async function handleAliasCancelButton(interaction) {
  clearPendingAliasFlow(interaction.channelId, interaction.user.id);
  await interaction.update(safeReplyOptions(buildReturnScreen(interaction)));
}

async function handleAliasCloseButton(interaction) {
  if (isOwner(interaction.user.id)) clearPendingAliasFlow(interaction.channelId, interaction.user.id);
  menuOriginMessageIds.delete(interaction.message?.id);
  await deleteInteractionMessage(interaction);
}

async function handleAliasRemoveButton(interaction) {
  rememberOrigin(interaction);
  const entries = Object.entries(loadAliases()).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) {
    await interaction.update(safeReplyOptions(buildReturnScreen(interaction, "Cok, belum ada alias yang bisa dihapus.")));
    return;
  }

  const truncated = entries.slice(0, 25);
  const select = new StringSelectMenuBuilder()
    .setCustomId("alias_select:remove")
    .setPlaceholder("Pilih alias yang mau dihapus...")
    .addOptions(truncated.map(([alias, target]) => ({ label: alias, description: `-> ${target}`, value: alias })));
  const truncNote = entries.length > 25 ? `\n_(cuma nunjukkin 25 dari ${entries.length} alias)_` : "";
  await interaction.update(
    safeReplyOptions({
      content: `Alias yang mana yang mau dihapus, cok?${truncNote}`,
      components: [new ActionRowBuilder().addComponents(select), new ActionRowBuilder().addComponents(buildCancelButton())],
    }),
  );
}

async function handleAliasRemoveSelect(interaction) {
  const alias = interaction.values[0];
  const target = loadAliases()[alias];
  if (!target) {
    await interaction.update(safeReplyOptions(buildReturnScreen(interaction, `Cok, alias "${alias}" kayaknya udah keburu dihapus.`)));
    return;
  }
  await interaction.update(
    safeReplyOptions({
      content: `Yakin mau hapus alias **"${alias}"** (-> "${target}")?`,
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`alias_flow:remove_confirm:${encodeURIComponent(alias)}`)
            .setLabel("✅ Ya, hapus")
            .setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId("alias_flow:cancel").setLabel("❌ Batal").setStyle(ButtonStyle.Secondary),
        ),
      ],
    }),
  );
}

async function handleAliasRemoveConfirmButton(interaction) {
  const alias = decodeURIComponent(interaction.customId.split(":")[2]);
  const resultMessage = handleRemoveAlias(alias, interaction.user.id);
  await interaction.update(safeReplyOptions(buildReturnScreen(interaction, resultMessage)));
}

// Dispatcher tunggal per jenis interaction - dipanggil router.js's
// interactionCreate lewat prefix customId ("alias_flow:"/"alias_modal:"/
// "alias_select:"), sama pola persis kayak compareFlow.js punya.
async function handleAliasFlowButton(interaction) {
  const action = interaction.customId.split(":")[1];
  if (action === "close") return handleAliasCloseButton(interaction);
  if (await rejectNonOwner(interaction)) return;
  if (action === "add") return handleAliasAddButton(interaction);
  if (action === "add_confirm" || action === "research") return handleAliasResearchButton(interaction);
  if (action === "target_confirmed" || action === "edit_alias") return handleAliasTextButton(interaction);
  if (action === "remove") return handleAliasRemoveButton(interaction);
  if (action === "remove_confirm") return handleAliasRemoveConfirmButton(interaction);
  if (action === "commit") return handleAliasCommitButton(interaction);
  if (action === "cancel") return handleAliasCancelButton(interaction);
}

async function handleAliasFlowModalSubmit(interaction) {
  if (await rejectNonOwner(interaction)) return;
  const action = interaction.customId.split(":")[1];
  if (action === "search") return handleAliasSearchModalSubmit(interaction);
  if (action === "aliastext") return handleAliasTextModalSubmit(interaction);
}

async function handleAliasFlowSelect(interaction) {
  if (await rejectNonOwner(interaction)) return;
  const action = interaction.customId.split(":")[1];
  if (action === "target") return handleAliasTargetSelect(interaction);
  if (action === "remove") return handleAliasRemoveSelect(interaction);
}

module.exports = {
  buildAliasListBlock,
  buildAliasActionButtonsRow,
  handleAliasFlowButton,
  handleAliasFlowModalSubmit,
  handleAliasFlowSelect,
};
