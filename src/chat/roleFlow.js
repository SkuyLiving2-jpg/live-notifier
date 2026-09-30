const { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, MessageFlags } = require("discord.js");
const { loadLiveCount, findLiveCountByNameFragment } = require("../storage/liveCount");
const { loadMemberRoles, getRoleIdFor, setRoleIdFor, clearRoleFor, ALL_MEMBERS_KEY } = require("../storage/memberRoles");
const { fetchPublicProfileByUsername, isJkt48Member } = require("../idnApi");
const { normalizeMemberFragment, isOwner } = require("./replies");
const { safeReplyOptions } = require("../utils");
const { loadRolePanelState, saveRolePanelState } = require("../storage/rolePanelState");
const { getDiscordClient } = require("../discordClient");
const { ROLE_CHANNEL_ID, ALL_LIVE_CHANNEL_ID, DISCORD_WEBHOOK_URL } = require("../config");
const { deleteInteractionMessage } = require("./interactionHelpers");

// Panel role notif live. Tiap member yang punya channel privat (mis.
// #aralie-jkt48) punya role bernama member itu (mis. "Aralie") yang OWNER
// atur: role itu boleh lihat channel privatnya, dan didaftarin ke bot lewat
// "cok tambah role aralie @Aralie". Milih member di panel = dapet role itu =
// dapet akses channel privat member itu + di-tag (liveNotify.js) tiap dia
// mulai live. Ada juga role "semua member" (di-tag tiap SIAPAPUN live).
//
// Alurnya:
//   1. Panel = SATU pesan permanen di channel role (syncRolePanel): bot masang
//      sendiri pas boot dan tiap kali daftar role berubah, SELALU ngedit pesan
//      yang sama (gak pernah numpuk). Discord gak ngasih tau bot kapan orang
//      "buka" sebuah channel, jadi panelnya dibikin selalu ada di situ. Isinya
//      dua tombol:
//        🔔 Semua member       -> dapet role "semua member".
//        🎯 Pilih member       -> layar pribadi (ephemeral) berisi dropdown
//                                 member (25 per dropdown, maks 4) yang
//                                 rolenya udah didaftarin owner.
//   2. Centang/lepas centang = bot nambah/cabut role member itu. Sumber
//      kebenaran = role yang beneran dipunya user di Discord, bukan state bot.
// Bot butuh izin "Manage Roles", dan role bot harus DI ATAS role-role member.
const MEMBERS_PER_MENU = 25;
const MAX_MENUS = 4;
const ROLE_REASON = "Notif live JKT48 (panel role)";
const ALL_ROLE_NAME = "all-live";

// Owner udah bisa lihat semua channel, jadi role "semua member" gak ada gunanya
// dan gak boleh kepencet ("kepencet ke semua member" - laporan owner).
const OWNER_NO_ALL_ROLE_NOTE = '👑 Kamu owner - udah bisa lihat semua channel, jadi gak perlu role "semua member" (gak aku kasih ya).';

// Channel live semua member (buat link "<#id>" abis user aktifin notif semua).
// Dari env ALL_LIVE_CHANNEL_ID, atau dicari dari DISCORD_WEBHOOK_URL - info
// webhook (GET tanpa auth) ngasih channel_id-nya. Gagal -> null, link-nya aja
// yang dilewat.
let cachedAllLiveChannelId = null;

async function resolveAllLiveChannelId() {
  if (ALL_LIVE_CHANNEL_ID) return ALL_LIVE_CHANNEL_ID;
  if (cachedAllLiveChannelId) return cachedAllLiveChannelId;
  if (!DISCORD_WEBHOOK_URL) return null;
  try {
    const response = await fetch(DISCORD_WEBHOOK_URL, { signal: AbortSignal.timeout(2000) });
    if (!response.ok) return null;
    const data = await response.json();
    cachedAllLiveChannelId = data.channel_id || null;
    return cachedAllLiveChannelId;
  } catch {
    return null;
  }
}

async function allLiveChannelLine() {
  const channelId = await resolveAllLiveChannelId();
  return channelId ? `\nLangsung cek channel live semua member: <#${channelId}>` : "";
}

function resetAllLiveChannelCache() {
  cachedAllLiveChannelId = null;
}

function cleanName(name) {
  return (name || "").replace(/\s*JKT48\s*$/i, "").trim();
}

function labelFor(username) {
  const known = cleanName(loadLiveCount()[username]?.name);
  if (known) return known;
  const token = username.replace(/^jkt48_/, "");
  return token.charAt(0).toUpperCase() + token.slice(1);
}

// Member yang bisa dipilih = yang rolenya didaftarin owner (memberRoles.js,
// tanpa kunci "semua"), urut abjad, dibatesin 4 dropdown x 25.
function getRoleRoster() {
  const entries = Object.keys(loadMemberRoles())
    .filter((username) => username !== ALL_MEMBERS_KEY)
    .map((username) => ({ username, label: labelFor(username) }));
  entries.sort((a, b) => a.label.localeCompare(b.label));
  return entries.slice(0, MEMBERS_PER_MENU * MAX_MENUS);
}

function buildChoiceButtons({ closable }) {
  const buttons = [
    new ButtonBuilder().setCustomId("role_flow:all").setLabel("🔔 Semua member").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("role_flow:open").setLabel("🎯 Pilih member tertentu").setStyle(ButtonStyle.Primary),
  ];
  if (closable) buttons.push(new ButtonBuilder().setCustomId("reply_close").setLabel("Tutup").setStyle(ButtonStyle.Danger));
  return new ActionRowBuilder().addComponents(buttons);
}

const PANEL_MEMBER_LIST_MAX = 1000;

const PANEL_TEXT =
  "Selamat datang! 👋 Mau dapet notif tiap ada member JKT48 yang live? Pilih salah satu:\n" +
  "🔔 **Semua member** - di-tag tiap SIAPAPUN mulai live.\n" +
  "🎯 **Pilih member tertentu** - cuma member yang kamu pilih (kamu juga dapet akses ke channel privat member itu).\n" +
  "Bisa diubah kapan aja, tinggal klik lagi.";

// Daftar member yang lagi tersedia ikut ditulis di panel - jadi tiap owner
// daftarin/lepas role, panelnya di-edit otomatis (refreshRolePanel).
function buildRolePanel({ closable = false } = {}) {
  const labels = getRoleRoster().map((m) => m.label);
  // Dibatesin biar pesan panel gak nembus 2000 karakter kalau member-nya banyak.
  let shown = labels;
  while (shown.length > 1 && shown.join(", ").length > PANEL_MEMBER_LIST_MAX) shown = shown.slice(0, -1);
  const rest = labels.length - shown.length;
  const memberLine = labels.length > 0 ? `\n\n**Member yang tersedia:** ${shown.join(", ")}${rest > 0 ? ` dan ${rest} lainnya` : ""}` : "";
  return { content: `🔔 **Notif live per member**\n${PANEL_TEXT}${memberLine}`, components: [buildChoiceButtons({ closable })] };
}

// Pasang/perbarui panel permanen di `channelId`. Kalau panel udah ada (ID
// pesannya tersimpan) pesan itu DI-EDIT; baru kalau belum ada/udah dihapus,
// dibikin baru. Panel yang pindah channel: pesan lama dihapus (best-effort).
// Balikin { ok, action: "edited" | "created", moved } atau { ok: false, error }.
async function syncRolePanel(client, channelId) {
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) return { ok: false, error: "channel gak ketemu atau bukan channel teks" };

    const payload = buildRolePanel();
    const state = loadRolePanelState();
    const sameChannel = state.channelId === channelId;
    if (state.messageId && sameChannel) {
      const existing = await channel.messages.fetch(state.messageId).catch(() => null);
      if (existing) {
        await existing.edit(payload);
        return { ok: true, action: "edited", moved: false };
      }
    }

    let moved = false;
    if (state.messageId && state.channelId && !sameChannel) {
      const oldChannel = await client.channels.fetch(state.channelId).catch(() => null);
      const oldMessage = oldChannel ? await oldChannel.messages.fetch(state.messageId).catch(() => null) : null;
      if (oldMessage) {
        await oldMessage.delete().catch(() => {});
        moved = true;
      }
    }
    const sent = await channel.send(payload);
    saveRolePanelState({ channelId, messageId: sent.id });
    return { ok: true, action: "created", moved };
  } catch (error) {
    console.error("Gagal sinkron panel role:", error.message);
    return { ok: false, error: error.message };
  }
}

// Dipanggil pas bot boot: channel dari ROLE_CHANNEL_ID, atau channel panel yang
// terakhir dipasang owner. Gak ada dua-duanya -> gak ngapa-ngapain.
async function syncRolePanelOnBoot(client) {
  const channelId = ROLE_CHANNEL_ID || loadRolePanelState().channelId;
  if (!channelId) return null;
  const result = await syncRolePanel(client, channelId);
  console.log(
    result.ok
      ? `Panel role ${result.action === "edited" ? "diperbarui" : "dipasang"} di channel ${channelId}.`
      : `Panel role gagal disinkron: ${result.error}`,
  );
  return result;
}

// Dipanggil abis daftar role berubah - best-effort, gak pernah bikin perintah
// owner-nya gagal. Gak ada client (mis. bot belum login/tes) atau belum ada
// panel yang dipasang -> lewat.
async function refreshRolePanel() {
  const client = getDiscordClient();
  const channelId = loadRolePanelState().channelId;
  if (!client || !channelId) return;
  await syncRolePanel(client, channelId);
}

function memberHasRole(member, roleId) {
  if (!member || !roleId) return false;
  const roles = member.roles;
  if (Array.isArray(roles)) return roles.includes(roleId);
  return Boolean(roles?.cache?.has(roleId));
}

async function resolveRole(guild, roleId) {
  return guild.roles.cache.get(roleId) || (await guild.roles.fetch(roleId).catch(() => null));
}

// Layar pengaturan pribadi. `hasRole` (opsional) nimpa cara ngecek role - dipake
// abis nambah/cabut role, soalnya cache role member belum tentu udah ke-update.
// `askAll` (default true): kalau user belum punya role "semua member", layar
// nanya "mau sekalian akses live SEMUA member?" (tombol Ya / Tidak). Abis
// jawab "Tidak" layar dibangun ulang dengan askAll=false (dibawa lewat suffix
// ":q0" di customId dropdown/tombol, jadi stateless) dan gantinya cuma ada
// petunjuk "ketik notif live semua" - gak nanya lagi terus-terusan.
function buildSettingsScreen(member, note = "", hasRole = (roleId) => memberHasRole(member, roleId), { askAll = true, owner = false } = {}) {
  const allOn = hasRole(getRoleIdFor(ALL_MEMBERS_KEY));
  const showAsk = askAll && !allOn && !owner;
  const suffix = askAll ? "" : ":q0";
  const buttons = [
    new ButtonBuilder().setCustomId("role_flow:close").setLabel("Tutup").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`role_flow:clearall${suffix}`).setLabel("🔕 Matikan semua").setStyle(ButtonStyle.Secondary),
  ];
  if (owner) {
    // Owner: gak ada pertanyaan/toggle "semua member" sama sekali.
  } else if (showAsk) {
    buttons.push(
      new ButtonBuilder().setCustomId("role_flow:allyes").setLabel("✅ Ya, sekalian semua member").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("role_flow:allno").setLabel("Tidak, cukup segini").setStyle(ButtonStyle.Secondary),
    );
  } else {
    buttons.push(
      new ButtonBuilder()
        .setCustomId("role_flow:alltoggle")
        .setLabel(allOn ? "🔔 Semua member: AKTIF" : "🔔 Semua member: mati")
        .setStyle(allOn ? ButtonStyle.Success : ButtonStyle.Secondary),
    );
  }
  const buttonRow = new ActionRowBuilder().addComponents(buttons);
  const prefix = note ? `${note}\n\n` : "";
  const roster = getRoleRoster();
  if (roster.length === 0) {
    return {
      content: `${prefix}Cok, belum ada member yang bisa dipilih (owner belum daftarin role member). Kamu masih bisa aktifin "Semua member" di bawah.`,
      components: [buttonRow],
    };
  }

  const rows = [];
  let active = 0;
  for (let start = 0, page = 0; start < roster.length; start += MEMBERS_PER_MENU, page++) {
    const chunk = roster.slice(start, start + MEMBERS_PER_MENU);
    const options = chunk.map((m) => {
      const on = hasRole(getRoleIdFor(m.username));
      if (on) active += 1;
      return { label: m.label.slice(0, 100), value: m.username, default: on };
    });
    const select = new StringSelectMenuBuilder()
      .setCustomId(`role_select:${page}${suffix}`)
      .setPlaceholder(`${chunk[0].label} - ${chunk[chunk.length - 1].label}`.slice(0, 150))
      .setMinValues(0)
      .setMaxValues(options.length)
      .addOptions(options);
    rows.push(new ActionRowBuilder().addComponents(select));
  }

  const allNote = allOn ? ' Kamu juga lagi aktif di "Semua member".' : "";
  let extra = "";
  if (showAsk) {
    extra =
      "\n\n❓ Mau sekalian dapet notif live **SEMUA** member (dan akses channel-nya)? Kalau nggak mau, gak apa-apa - kamu tetap dapet member pilihanmu.";
  } else if (owner) {
    extra = `\n\n👑 Kamu owner - udah bisa lihat semua channel, jadi role "semua member" gak perlu.${allOn ? ' Kamu masih megang role-nya - klik "🔕 Matikan semua" buat ngelepas.' : ""}`;
  } else if (!allOn) {
    extra = '\n\n💡 Kepo sama live member lain? Ketik "notif live semua" kapan aja, nanti ditanya lagi dan bisa langsung aktif.';
  }
  const intro = `🎯 Pilih member yang mau kamu dapet notif live-nya (centang = aktif, lepas centang = berhenti). Sekarang aktif: **${active}** member.${allNote}${extra}`;
  return { content: `${prefix}${intro}`, components: [...rows, buttonRow] };
}

// Role "semua member" (default bernama "all-live"): dipake yang didaftarin owner,
// atau dibikin bot sendiri (lazy) kalau belum ada. Role bikinan bot cuma nge-ping;
// akses ke channel live semua member harus diatur owner di permission channel-nya.
const inflightAllRole = { promise: null };

async function ensureAllRole(guild) {
  const known = getRoleIdFor(ALL_MEMBERS_KEY);
  if (known) {
    const role = await resolveRole(guild, known);
    if (role) return role.id;
  }
  if (inflightAllRole.promise) return inflightAllRole.promise;

  inflightAllRole.promise = (async () => {
    try {
      const existing = guild.roles.cache.find((r) => r.name === ALL_ROLE_NAME);
      const role = existing || (await guild.roles.create({ name: ALL_ROLE_NAME, mentionable: true, reason: ROLE_REASON }));
      setRoleIdFor(ALL_MEMBERS_KEY, role.id);
      return role.id;
    } finally {
      inflightAllRole.promise = null;
    }
  })();
  return inflightAllRole.promise;
}

function describeRoleError(error) {
  if (error?.code === 50013) {
    return "Cok, bot belum punya izin **Manage Roles**, atau role bot-nya lebih rendah dari role yang mau di-assign, jadi gak bisa ngatur role. Minta admin naikin role bot di atas role member ya.";
  }
  return "Cok, gagal ngatur role kamu barusan. Coba lagi bentar ya.";
}

async function handleRoleFlowButton(interaction) {
  const [, action, extra] = interaction.customId.split(":");
  if (action === "open") {
    await interaction.reply(
      safeReplyOptions({
        ...buildSettingsScreen(interaction.member, "", undefined, { owner: isOwner(interaction.user.id) }),
        flags: MessageFlags.Ephemeral,
      }),
    );
    return;
  }
  if (action === "close") {
    await interaction.update(safeReplyOptions({ content: "Oke, ditutup. 🔔", components: [] }));
    return;
  }
  if (action === "all") return handleAllFromPanel(interaction);
  if (action === "alltoggle") return handleAllToggle(interaction);
  if (action === "allyes") return handleAllYes(interaction);
  if (action === "allno") return handleAllNo(interaction);
  if (action === "clearall") return handleRoleClearAll(interaction, extra !== "q0");
  if (action === "confirmyes") return handleAllConfirm(interaction, extra, true);
  if (action === "confirmno") return handleAllConfirm(interaction, extra, false);
}

// Klik "🔔 Semua member" di panel/sambutan (pesan PUBLIK) -> balasan ephemeral baru.
async function handleAllFromPanel(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const { member, guild } = interaction;
  if (!member || !guild) {
    await interaction.editReply(safeReplyOptions({ content: "Cok, panel role cuma jalan di dalam server." }));
    return;
  }
  if (isOwner(interaction.user.id)) {
    await interaction.editReply(safeReplyOptions(buildSettingsScreen(member, OWNER_NO_ALL_ROLE_NOTE, undefined, { askAll: false, owner: true })));
    return;
  }
  let note;
  let allRoleId = null;
  try {
    allRoleId = await ensureAllRole(guild);
    if (!memberHasRole(member, allRoleId)) await member.roles.add(allRoleId, ROLE_REASON);
    note = `✅ Beres! Kamu bakal di-tag tiap SIAPAPUN member mulai live.${await allLiveChannelLine()}`;
  } catch (error) {
    console.error("Gagal ngasih role semua member:", error.message);
    note = describeRoleError(error);
    allRoleId = null;
  }
  const hasRole = (roleId) => memberHasRole(member, roleId) || (allRoleId !== null && roleId === allRoleId);
  await interaction.editReply(safeReplyOptions(buildSettingsScreen(member, note, hasRole, { askAll: false })));
}

// Klik tombol toggle "Semua member" di layar pengaturan (pesan ephemeral) -> edit di tempat.
async function handleAllToggle(interaction) {
  await interaction.deferUpdate();
  const { member, guild } = interaction;
  if (!member || !guild) {
    await interaction.editReply(safeReplyOptions({ content: "Cok, panel role cuma jalan di dalam server.", components: [] }));
    return;
  }
  const currentId = getRoleIdFor(ALL_MEMBERS_KEY);
  const isOn = memberHasRole(member, currentId);
  // Owner gak boleh NGAKTIFIN role ini (tapi kalau udah kepegang, boleh dilepas).
  if (isOwner(interaction.user.id) && !isOn) {
    await interaction.editReply(safeReplyOptions(buildSettingsScreen(member, OWNER_NO_ALL_ROLE_NOTE, undefined, { askAll: false, owner: true })));
    return;
  }
  let note;
  let finalOn = isOn;
  try {
    if (isOn) {
      await member.roles.remove(currentId, ROLE_REASON);
      finalOn = false;
      note = '🔕 "Semua member" dimatiin.';
    } else {
      const roleId = await ensureAllRole(guild);
      await member.roles.add(roleId, ROLE_REASON);
      finalOn = true;
      note = `✅ "Semua member" aktif - kamu di-tag tiap SIAPAPUN mulai live.${await allLiveChannelLine()}`;
    }
  } catch (error) {
    console.error("Gagal toggle role semua member:", error.message);
    note = describeRoleError(error);
  }
  const allRoleId = getRoleIdFor(ALL_MEMBERS_KEY);
  const hasRole = (roleId) => (roleId === allRoleId ? finalOn : memberHasRole(member, roleId));
  await interaction.editReply(safeReplyOptions(buildSettingsScreen(member, note, hasRole, { askAll: false })));
}

// "✅ Ya, sekalian semua member" di layar pengaturan - SELALU ngaktifin (beda dari
// toggle yang bisa matiin kalau ternyata udah aktif).
async function handleAllYes(interaction) {
  await interaction.deferUpdate();
  const { member, guild } = interaction;
  if (!member || !guild) {
    await interaction.editReply(safeReplyOptions({ content: "Cok, panel role cuma jalan di dalam server.", components: [] }));
    return;
  }
  if (isOwner(interaction.user.id)) {
    await interaction.editReply(safeReplyOptions(buildSettingsScreen(member, OWNER_NO_ALL_ROLE_NOTE, undefined, { askAll: false, owner: true })));
    return;
  }
  let note;
  let allRoleId = getRoleIdFor(ALL_MEMBERS_KEY);
  try {
    allRoleId = await ensureAllRole(guild);
    if (!memberHasRole(member, allRoleId)) await member.roles.add(allRoleId, ROLE_REASON);
    note = `✅ Sip! Kamu juga dapet notif live SEMUA member.${await allLiveChannelLine()}`;
  } catch (error) {
    console.error("Gagal ngasih role semua member:", error.message);
    note = describeRoleError(error);
    allRoleId = null;
  }
  const hasRole = (roleId) => memberHasRole(member, roleId) || (allRoleId !== null && roleId === allRoleId);
  await interaction.editReply(safeReplyOptions(buildSettingsScreen(member, note, hasRole, { askAll: false })));
}

// "Tidak, cukup segini" - dibiarin, tapi dikasih petunjuk cara minta lagi nanti.
async function handleAllNo(interaction) {
  const note =
    'Oke, gak masalah! 👍 Kalau nanti kepo sama live member lain, tinggal ketik "notif live semua" - nanti ditanya lagi dan bisa langsung aktif.';
  await interaction.update(
    safeReplyOptions(buildSettingsScreen(interaction.member, note, undefined, { askAll: false, owner: isOwner(interaction.user.id) })),
  );
}

// Konfirmasi "notif live semua" yang DIKETIK ("Yakin?" + Ya/Tidak). customId
// bawa ID orang yang minta - tombolnya cuma buat dia (pesannya publik).
function buildAllLiveConfirm(userId) {
  return {
    content:
      "🔔 Yakin mau dapet notif live **SEMUA** member? Kamu bakal di-tag tiap ada member yang live, dan dapet akses ke channel live semua member. (Bisa dimatiin kapan aja lewat panel role.)",
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`role_flow:confirmyes:${userId}`).setLabel("Ya").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`role_flow:confirmno:${userId}`).setLabel("Tidak").setStyle(ButtonStyle.Secondary),
      ),
    ],
  };
}

async function handleAllConfirm(interaction, askerId, isYes) {
  if (interaction.user.id !== askerId) {
    await interaction.reply(safeReplyOptions({ content: "Cok, tombol ini buat orang yang minta notif tadi ya.", flags: MessageFlags.Ephemeral }));
    return;
  }
  // "Tidak" -> ditutup (pesannya dihapus); bisa minta lagi kapan aja.
  if (!isYes) {
    await deleteInteractionMessage(interaction);
    return;
  }

  await interaction.deferUpdate();
  const { member, guild } = interaction;
  if (!member || !guild) {
    await interaction.editReply(safeReplyOptions({ content: "Cok, ini cuma jalan di dalam server.", components: [] }));
    return;
  }
  const closeRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("reply_close").setLabel("Tutup").setStyle(ButtonStyle.Danger),
  );
  if (isOwner(interaction.user.id)) {
    await interaction.editReply(safeReplyOptions({ content: OWNER_NO_ALL_ROLE_NOTE, components: [closeRow] }));
    return;
  }
  let content;
  try {
    const allRoleId = await ensureAllRole(guild);
    if (memberHasRole(member, allRoleId)) {
      content = `Kamu udah aktif di notif live SEMUA member kok. 👍${await allLiveChannelLine()}`;
    } else {
      await member.roles.add(allRoleId, ROLE_REASON);
      content = `✅ Beres! Sekarang kamu dapet notif live SEMUA member.${await allLiveChannelLine()}`;
    }
  } catch (error) {
    console.error("Gagal ngasih role semua member:", error.message);
    content = describeRoleError(error);
  }
  await interaction.editReply(safeReplyOptions({ content, components: [closeRow] }));
}

async function handleRoleClearAll(interaction, askAll = true) {
  await interaction.deferUpdate();
  const member = interaction.member;
  const owned = new Set(Object.values(loadMemberRoles()).filter((id) => memberHasRole(member, id)));
  let note = "🔕 Semua notif dimatiin.";
  try {
    if (owned.size > 0) await member.roles.remove([...owned], ROLE_REASON);
    else note = "Kamu emang belum aktif di notif manapun.";
  } catch (error) {
    console.error("Gagal cabut semua role notif:", error.message);
    note = describeRoleError(error);
    owned.clear();
  }
  await interaction.editReply(
    safeReplyOptions(
      buildSettingsScreen(member, note, (roleId) => memberHasRole(member, roleId) && !owned.has(roleId), {
        askAll,
        owner: isOwner(interaction.user.id),
      }),
    ),
  );
}

async function handleRoleFlowSelect(interaction) {
  const idParts = interaction.customId.split(":");
  const page = Number(idParts[1]) || 0;
  const askAll = idParts[2] !== "q0";
  await interaction.deferUpdate();

  const { member, guild } = interaction;
  if (!member || !guild) {
    await interaction.editReply(safeReplyOptions({ content: "Cok, panel role cuma jalan di dalam server.", components: [] }));
    return;
  }

  const roster = getRoleRoster();
  const chosen = new Set(interaction.values);
  const chunk = roster.slice(page * MEMBERS_PER_MENU, (page + 1) * MEMBERS_PER_MENU);
  // Kalau daftar member bergeser sejak dropdown ini dibikin, pilihan yang gak
  // lagi ada di halaman ini tetep diproses, gak diam-diam hilang.
  const inChunk = new Set(chunk.map((m) => m.username));
  const entries = [...chunk, ...roster.filter((m) => chosen.has(m.username) && !inChunk.has(m.username))];

  const toAdd = [];
  const toRemove = [];
  const added = [];
  const removed = [];
  const missing = [];
  let note = "";
  try {
    for (const entry of entries) {
      const roleId = getRoleIdFor(entry.username);
      if (chosen.has(entry.username)) {
        if (!roleId || !(await resolveRole(guild, roleId))) {
          missing.push(entry.label);
          continue;
        }
        if (!memberHasRole(member, roleId)) {
          toAdd.push(roleId);
          added.push(entry.label);
        }
      } else if (roleId && memberHasRole(member, roleId)) {
        toRemove.push(roleId);
        removed.push(entry.label);
      }
    }
    if (toAdd.length > 0) await member.roles.add(toAdd, ROLE_REASON);
    if (toRemove.length > 0) await member.roles.remove(toRemove, ROLE_REASON);

    const parts = [];
    if (added.length > 0) parts.push(`✅ Aktif: ${added.join(", ")}`);
    if (removed.length > 0) parts.push(`🔕 Dimatiin: ${removed.join(", ")}`);
    if (missing.length > 0) parts.push(`⚠️ Role ${missing.join(", ")} gak ketemu di server - minta owner daftarin ulang ("cok tambah role ...").`);
    note = parts.join("\n");
  } catch (error) {
    console.error("Gagal ngatur role notif:", error.message);
    note = describeRoleError(error);
    toAdd.length = 0;
    toRemove.length = 0;
  }

  const addSet = new Set(toAdd);
  const removeSet = new Set(toRemove);
  const hasRole = (roleId) => (memberHasRole(member, roleId) || addSet.has(roleId)) && !removeSet.has(roleId);
  await interaction.editReply(safeReplyOptions(buildSettingsScreen(member, note, hasRole, { askAll, owner: isOwner(interaction.user.id) })));
}

// ==== Perintah owner: daftarin role member ====

function parseRoleRef(ref) {
  const match = String(ref || "")
    .trim()
    .match(/^<@&(\d{15,25})>$|^(\d{15,25})$/);
  return match ? match[1] || match[2] : null;
}

// Nama member -> username IDN yang valid: dikenal bot (live-count, alias-aware),
// atau dicek langsung ke IDN (member yang belum pernah live tetep bisa didaftarin).
async function resolveMemberUsername(fragment) {
  const found = findLiveCountByNameFragment(fragment);
  if (found) return { username: found.username };
  const token = normalizeMemberFragment(fragment).split(" ")[0];
  if (!token || token.length < 2) return { error: `Cok, "${fragment}" bukan nama member yang valid.` };
  try {
    const profile = await fetchPublicProfileByUsername(`jkt48_${token}`);
    if (!profile || !isJkt48Member(profile)) return { error: `Cok, "${fragment}" gak ketemu sebagai member JKT48 di IDN - cek lagi ejaannya.` };
    return { username: `jkt48_${token}` };
  } catch (error) {
    console.error(`Gagal ngecek member "${fragment}" ke IDN:`, error.message);
    return { error: "Cok, bot lagi gak bisa ngecek ke IDN. Coba lagi bentar." };
  }
}

const ALL_NAME_WORDS = new Set(["semua", "all"]);

async function handleAddMemberRole(nameFragment, roleRef, authorId) {
  if (!isOwner(authorId)) return "Cok, cuma owner yang boleh ngatur daftar role.";
  const roleId = parseRoleRef(roleRef);
  if (!roleId) return 'Cok, role-nya harus di-mention (@NamaRole) atau ID role-nya. Contoh: "cok tambah role aralie @Aralie".';

  const name = (nameFragment || "").trim();
  if (ALL_NAME_WORDS.has(name.toLowerCase())) {
    setRoleIdFor(ALL_MEMBERS_KEY, roleId);
    return `✅ Role "Semua member" diset ke <@&${roleId}>.`;
  }

  const resolved = await resolveMemberUsername(name);
  if (resolved.error) return resolved.error;
  const existing = getRoleIdFor(resolved.username);
  setRoleIdFor(resolved.username, roleId);
  await refreshRolePanel();
  const replaced = existing && existing !== roleId ? " (gantiin role lama)" : "";
  return `✅ Role <@&${roleId}> didaftarin buat **${labelFor(resolved.username)}**${replaced}. Sekarang member ini muncul di panel role, dan role itu di-tag tiap dia mulai live.`;
}

async function handleRemoveMemberRole(nameFragment, authorId) {
  if (!isOwner(authorId)) return "Cok, cuma owner yang boleh ngatur daftar role.";
  const name = (nameFragment || "").trim();
  if (ALL_NAME_WORDS.has(name.toLowerCase())) {
    return clearRoleFor(ALL_MEMBERS_KEY) ? '✅ Role "Semua member" dilepas dari daftar.' : 'Role "Semua member" emang belum didaftarin.';
  }
  const resolved = await resolveMemberUsername(name);
  if (resolved.error) return resolved.error;
  const removedOne = clearRoleFor(resolved.username);
  if (removedOne) await refreshRolePanel();
  return removedOne
    ? `✅ **${labelFor(resolved.username)}** dilepas dari daftar role (role di server-nya sendiri gak dihapus).`
    : `**${labelFor(resolved.username)}** emang belum didaftarin.`;
}

function replyRoleList() {
  const map = loadMemberRoles();
  const lines = getRoleRoster().map((m) => `- ${m.label} -> <@&${map[m.username]}>`);
  const allId = map[ALL_MEMBERS_KEY];
  lines.push(`- Semua member -> ${allId ? `<@&${allId}>` : "(dibikin otomatis pas ada yang milih)"}`);
  return lines.length === 1 && !allId
    ? 'Cok, belum ada role member yang didaftarin. Owner: "cok tambah role aralie @Aralie".'
    : `🔔 Daftar role notif:\n${lines.join("\n")}`;
}

module.exports = {
  buildRolePanel,
  syncRolePanel,
  syncRolePanelOnBoot,
  buildAllLiveConfirm,
  resetAllLiveChannelCache,
  OWNER_NO_ALL_ROLE_NOTE,
  buildSettingsScreen,
  handleRoleFlowButton,
  handleRoleFlowSelect,
  getRoleRoster,
  handleAddMemberRole,
  handleRemoveMemberRole,
  replyRoleList,
  parseRoleRef,
};
