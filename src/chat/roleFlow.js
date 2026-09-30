const { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, MessageFlags } = require("discord.js");
const { loadLiveCount } = require("../storage/liveCount");
const { loadMemberRoles, getRoleIdFor, setRoleIdFor } = require("../storage/memberRoles");
const { safeReplyOptions } = require("../utils");

// Panel role notif live: user milih member yang mau dia dapet notifnya, dan
// bot nge-assign/cabut role per member (role "🔔 <Nama>") - liveNotify.js
// nge-ping role itu pas member mulai live. Beda dari "cok ingetin" (tag
// pribadi per user via ID), ini pake role Discord biasa jadi kelihatan di
// daftar member dan gampang diatur owner dari pengaturan server.
//
// Alurnya:
//   1. Owner ngetik "cok pasang panel role" di channel role -> bot ngirim
//      panel (buildRolePanel) berisi tombol "🔔 Atur notif live saya".
//   2. User klik tombol -> pesan EPHEMERAL (cuma dia yang lihat) berisi
//      dropdown member (25 per dropdown, maks 4 dropdown = 100 member), member
//      yang rolenya udah dia punya udah tercentang.
//   3. Pilih/lepas centang -> bot nambah/cabut role yang sesuai di dropdown
//      itu. Role dibikin bot OTOMATIS (lazy) pas pertama kali ada yang milih
//      member itu, jadi gak perlu bikin puluhan role manual.
// State-nya stateless: yang jadi sumber kebenaran adalah role yang beneran
// dipunya user di Discord, bukan Map di memori bot.
//
// Bot butuh izin "Manage Roles" di server; role bikinan bot otomatis ada di
// bawah role tertinggi bot, jadi bot bisa nge-assign-nya.
const MEMBERS_PER_MENU = 25;
const MAX_MENUS = 4;
const ROLE_REASON = "Notif live JKT48 (panel role)";

function cleanName(name, username) {
  return (name || username).replace(/\s*JKT48\s*$/i, "").trim() || username;
}

// Daftar member yang bisa dipilih: semua yang pernah tercatat live oleh bot
// (live-count.json), urut abjad, dibatesin 4 dropdown x 25.
function getRoleRoster() {
  const entries = Object.entries(loadLiveCount()).map(([username, value]) => ({ username, label: cleanName(value?.name, username) }));
  entries.sort((a, b) => a.label.localeCompare(b.label));
  return entries.slice(0, MEMBERS_PER_MENU * MAX_MENUS);
}

function roleNameFor(label) {
  return `🔔 ${label}`.slice(0, 100);
}

function buildRolePanel({ closable = false } = {}) {
  const buttons = [new ButtonBuilder().setCustomId("role_flow:open").setLabel("🔔 Atur notif live saya").setStyle(ButtonStyle.Primary)];
  if (closable) buttons.push(new ButtonBuilder().setCustomId("reply_close").setLabel("Tutup").setStyle(ButtonStyle.Danger));
  return {
    content:
      "🔔 **Notif live per member**\nKlik tombol di bawah, pilih member yang mau kamu dapet notif live-nya. Kamu otomatis dapet role member itu dan di-tag tiap dia mulai live. Lepas centang kapan aja buat berhenti.",
    components: [new ActionRowBuilder().addComponents(buttons)],
  };
}

function memberHasRole(member, roleId) {
  if (!member || !roleId) return false;
  const roles = member.roles;
  if (Array.isArray(roles)) return roles.includes(roleId);
  return Boolean(roles?.cache?.has(roleId));
}

// `hasRole` (opsional) nimpa cara ngecek role - dipake abis nambah/cabut role,
// soalnya cache role member belum tentu udah ke-update pas layar dibangun ulang.
function buildSettingsScreen(member, note = "", hasRole = (roleId) => memberHasRole(member, roleId)) {
  const closeRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("role_flow:close").setLabel("Tutup").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("role_flow:clearall").setLabel("🔕 Matikan semua").setStyle(ButtonStyle.Secondary),
  );
  const roster = getRoleRoster();
  if (roster.length === 0) {
    return {
      content: `${note ? `${note}\n\n` : ""}Cok, belum ada member yang kecatet live, jadi belum ada yang bisa dipilih.`,
      components: [closeRow],
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
      .setCustomId(`role_select:${page}`)
      .setPlaceholder(`${chunk[0].label} - ${chunk[chunk.length - 1].label}`.slice(0, 150))
      .setMinValues(0)
      .setMaxValues(options.length)
      .addOptions(options);
    rows.push(new ActionRowBuilder().addComponents(select));
  }

  const intro = `🔔 Pilih member yang mau kamu dapet notif live-nya (centang = aktif, lepas centang = berhenti). Sekarang aktif: **${active}** member.`;
  return { content: `${note ? `${note}\n\n` : ""}${intro}`, components: [...rows, closeRow] };
}

// Role yang lagi dibikin (username -> Promise) - dua user yang milih member
// yang sama BARENGAN gak boleh bikin dua role kembar.
const inflightRoles = new Map();

async function ensureRole(guild, entry) {
  const known = getRoleIdFor(entry.username);
  if (known) {
    const role = guild.roles.cache.get(known) || (await guild.roles.fetch(known).catch(() => null));
    if (role) return role.id;
  }
  if (inflightRoles.has(entry.username)) return inflightRoles.get(entry.username);

  const promise = (async () => {
    try {
      const name = roleNameFor(entry.label);
      // Owner mungkin udah bikin role bernama sama - dipake aja, jangan dobel.
      const existing = guild.roles.cache.find((r) => r.name === name);
      const role = existing || (await guild.roles.create({ name, mentionable: true, reason: ROLE_REASON }));
      setRoleIdFor(entry.username, role.id);
      return role.id;
    } finally {
      inflightRoles.delete(entry.username);
    }
  })();
  inflightRoles.set(entry.username, promise);
  return promise;
}

function describeRoleError(error) {
  if (error?.code === 50013) {
    return "Cok, bot belum punya izin **Manage Roles** (atau role bot-nya terlalu rendah) di server ini, jadi gak bisa ngatur role. Minta admin nambahin izin itu ke role bot ya.";
  }
  return "Cok, gagal ngatur role kamu barusan. Coba lagi bentar ya.";
}

async function handleRoleOpen(interaction) {
  await interaction.reply(safeReplyOptions({ ...buildSettingsScreen(interaction.member), flags: MessageFlags.Ephemeral }));
}

async function handleRoleFlowButton(interaction) {
  const action = interaction.customId.split(":")[1];
  if (action === "open") return handleRoleOpen(interaction);
  if (action === "close") {
    await interaction.update(safeReplyOptions({ content: "Oke, ditutup. 🔔", components: [] }));
    return;
  }
  if (action === "clearall") return handleRoleClearAll(interaction);
}

async function handleRoleClearAll(interaction) {
  await interaction.deferUpdate();
  const member = interaction.member;
  const owned = new Set(Object.values(loadMemberRoles()).filter((id) => memberHasRole(member, id)));
  let note = "🔕 Semua notif member dimatiin.";
  try {
    if (owned.size > 0) await member.roles.remove([...owned], ROLE_REASON);
    else note = "Kamu emang belum aktif di member manapun.";
  } catch (error) {
    console.error("Gagal cabut semua role notif:", error.message);
    note = describeRoleError(error);
  }
  await interaction.editReply(safeReplyOptions(buildSettingsScreen(member, note, (roleId) => memberHasRole(member, roleId) && !owned.has(roleId))));
}

async function handleRoleFlowSelect(interaction) {
  const page = Number(interaction.customId.split(":")[1]) || 0;
  await interaction.deferUpdate();

  const { member, guild } = interaction;
  if (!member || !guild) {
    await interaction.editReply(safeReplyOptions({ content: "Cok, panel role cuma jalan di dalam server.", components: [] }));
    return;
  }

  const roster = getRoleRoster();
  const chosen = new Set(interaction.values);
  const chunk = roster.slice(page * MEMBERS_PER_MENU, (page + 1) * MEMBERS_PER_MENU);
  // Kalau daftar member bergeser sejak dropdown ini dibikin (ada member baru),
  // pilihan yang gak lagi ada di halaman ini tetep diproses, gak diam-diam hilang.
  const inChunk = new Set(chunk.map((m) => m.username));
  const entries = [...chunk, ...roster.filter((m) => chosen.has(m.username) && !inChunk.has(m.username))];

  const toAdd = [];
  const toRemove = [];
  const added = [];
  const removed = [];
  let note = "";
  try {
    for (const entry of entries) {
      if (chosen.has(entry.username)) {
        const roleId = await ensureRole(guild, entry);
        if (!memberHasRole(member, roleId)) {
          toAdd.push(roleId);
          added.push(entry.label);
        }
      } else {
        const roleId = getRoleIdFor(entry.username);
        if (roleId && memberHasRole(member, roleId)) {
          toRemove.push(roleId);
          removed.push(entry.label);
        }
      }
    }
    if (toAdd.length > 0) await member.roles.add(toAdd, ROLE_REASON);
    if (toRemove.length > 0) await member.roles.remove(toRemove, ROLE_REASON);

    const parts = [];
    if (added.length > 0) parts.push(`✅ Aktif: ${added.join(", ")}`);
    if (removed.length > 0) parts.push(`🔕 Dimatiin: ${removed.join(", ")}`);
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
  await interaction.editReply(safeReplyOptions(buildSettingsScreen(member, note, hasRole)));
}

module.exports = { buildRolePanel, buildSettingsScreen, handleRoleFlowButton, handleRoleFlowSelect, getRoleRoster, roleNameFor };
