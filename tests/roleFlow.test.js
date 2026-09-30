require("./helpers/setupTestEnv");

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { recordLiveCompleted } = require("../src/storage/liveCount");
const { loadMemberRoles, setRoleIdFor, getRoleIdFor } = require("../src/storage/memberRoles");
const { addSubscription } = require("../src/storage/subscriptions");
const { sendDiscordNotif } = require("../src/notify/liveNotify");
const {
  buildRolePanel,
  buildSettingsScreen,
  handleRoleFlowButton,
  handleRoleFlowSelect,
  getRoleRoster,
  roleNameFor,
} = require("../src/chat/roleFlow");

// Guild/member palsu: cukup yang dipakai roleFlow.js - roles.cache (Map + find),
// roles.create/fetch, member.roles.add/remove/cache. Gak nyentuh Discord asli.
function fakeGuild({ existingRoles = [] } = {}) {
  const cache = new Map(existingRoles.map((r) => [r.id, r]));
  cache.find = (fn) => [...cache.values()].find(fn);
  let nextId = 1000;
  const created = [];
  return {
    created,
    roles: {
      cache,
      create: async ({ name, mentionable }) => {
        const role = { id: String(nextId++), name, mentionable };
        cache.set(role.id, role);
        created.push(role);
        return role;
      },
      fetch: async (id) => cache.get(id) || null,
    },
  };
}

function fakeMember(initialRoleIds = [], { failWith = null } = {}) {
  const cache = new Map(initialRoleIds.map((id) => [id, { id }]));
  const calls = { add: [], remove: [] };
  return {
    calls,
    roles: {
      cache,
      add: async (ids) => {
        if (failWith) throw failWith;
        calls.add.push(ids);
        for (const id of ids) cache.set(id, { id });
      },
      remove: async (ids) => {
        if (failWith) throw failWith;
        calls.remove.push(ids);
        for (const id of ids) cache.delete(id);
      },
    },
  };
}

function fakeInteraction({ customId, values = [], member, guild } = {}) {
  const log = { replies: [], edits: [], updates: [], deferred: 0 };
  return {
    customId,
    values,
    member,
    guild,
    user: { id: "u-role" },
    log,
    reply: async (p) => log.replies.push(p),
    update: async (p) => log.updates.push(p),
    deferUpdate: async () => {
      log.deferred += 1;
    },
    editReply: async (p) => log.edits.push(p),
  };
}

const ids = (row) => row.toJSON().components.map((c) => c.custom_id);

// Data dites numpang di satu proses/file yang sama - member dites pake nama unik.
recordLiveCompleted("jkt48_rolealpha", "Rolealpha JKT48");
recordLiveCompleted("jkt48_rolebeta", "Rolebeta JKT48");

test("getRoleRoster - nama dibersihin dari 'JKT48', urut abjad, cuma member yang pernah tercatat live", () => {
  const roster = getRoleRoster();
  const alpha = roster.find((m) => m.username === "jkt48_rolealpha");
  assert.equal(alpha.label, "Rolealpha");
  const labels = roster.map((m) => m.label);
  assert.deepEqual(
    labels,
    [...labels].sort((a, b) => a.localeCompare(b)),
  );
  assert.equal(roleNameFor("Nala"), "🔔 Nala");
});

test("buildRolePanel - panel permanen cuma tombol buka; versi closable nambah Tutup (reply_close)", () => {
  assert.deepEqual(ids(buildRolePanel().components[0]), ["role_flow:open"]);
  assert.deepEqual(ids(buildRolePanel({ closable: true }).components[0]), ["role_flow:open", "reply_close"]);
});

test("buildSettingsScreen - dropdown maks 25 opsi, opsi yang rolenya udah dipunya ke-centang, ada Tutup + Matikan semua, total baris <= 5", () => {
  setRoleIdFor("jkt48_rolealpha", "role-alpha-id");
  const member = fakeMember(["role-alpha-id"]);
  const screen = buildSettingsScreen(member);
  assert.ok(screen.components.length <= 5);
  const last = ids(screen.components[screen.components.length - 1]);
  assert.deepEqual(last, ["role_flow:close", "role_flow:clearall"]);

  const select = screen.components[0].toJSON().components[0];
  assert.match(select.custom_id, /^role_select:0$/);
  assert.ok(select.options.length <= 25);
  assert.equal(select.min_values, 0);
  const alphaOption = select.options.find((o) => o.value === "jkt48_rolealpha");
  assert.equal(alphaOption.default, true);
  const betaOption = select.options.find((o) => o.value === "jkt48_rolebeta");
  assert.equal(betaOption.default, false);
  assert.match(screen.content, /Sekarang aktif: \*\*1\*\* member/);
});

test("tombol 'open' - balas EPHEMERAL (cuma yang klik yang lihat) dengan layar pengaturan", async () => {
  const interaction = fakeInteraction({ customId: "role_flow:open", member: fakeMember() });
  await handleRoleFlowButton(interaction);
  assert.equal(interaction.log.replies.length, 1);
  assert.equal(interaction.log.replies[0].flags, 64);
  assert.ok(interaction.log.replies[0].components.length >= 2);
});

test("tombol 'close' - ngedit pesan jadi dismiss tanpa komponen (bukan delete, ephemeral gak bisa dihapus)", async () => {
  const interaction = fakeInteraction({ customId: "role_flow:close" });
  await handleRoleFlowButton(interaction);
  assert.deepEqual(interaction.log.updates[0].components, []);
});

test("select - milih member yang belum punya role -> role DIBIKIN bot (mentionable) + di-assign + layar ke-update dengan centang", async () => {
  const guild = fakeGuild();
  const member = fakeMember();
  const roster = getRoleRoster();
  const page = Math.floor(roster.findIndex((m) => m.username === "jkt48_rolebeta") / 25);
  const interaction = fakeInteraction({ customId: `role_select:${page}`, values: ["jkt48_rolebeta"], member, guild });
  await handleRoleFlowSelect(interaction);

  assert.equal(interaction.log.deferred, 1, "harus deferUpdate dulu (bikin role bisa lama)");
  assert.equal(guild.created.length, 1);
  assert.equal(guild.created[0].name, "🔔 Rolebeta");
  assert.equal(guild.created[0].mentionable, true);
  const roleId = getRoleIdFor("jkt48_rolebeta");
  assert.equal(roleId, guild.created[0].id, "role ke-simpen buat dipake liveNotify");
  assert.deepEqual(member.calls.add, [[roleId]]);

  const edit = interaction.log.edits[0];
  assert.match(edit.content, /✅ Aktif: Rolebeta/);
  const select = edit.components[page].toJSON().components[0];
  assert.equal(select.options.find((o) => o.value === "jkt48_rolebeta").default, true);
});

test("select - lepas centang member yang rolenya dipunya -> role DICABUT (role-nya sendiri gak dihapus)", async () => {
  const guild = fakeGuild();
  setRoleIdFor("jkt48_rolealpha", "role-alpha-id");
  const member = fakeMember(["role-alpha-id"]);
  const roster = getRoleRoster();
  const page = Math.floor(roster.findIndex((m) => m.username === "jkt48_rolealpha") / 25);
  const interaction = fakeInteraction({ customId: `role_select:${page}`, values: [], member, guild });
  await handleRoleFlowSelect(interaction);

  assert.deepEqual(member.calls.remove, [["role-alpha-id"]]);
  assert.equal(guild.created.length, 0);
  assert.match(interaction.log.edits[0].content, /🔕 Dimatiin: Rolealpha/);
});

test("select - role bernama sama yang udah dibikin owner di server DIPAKE, gak bikin duplikat", async () => {
  recordLiveCompleted("jkt48_roleadopt", "Roleadopt JKT48");
  const guild = fakeGuild({ existingRoles: [{ id: "owner-made", name: "🔔 Roleadopt" }] });
  const member = fakeMember();
  const roster = getRoleRoster();
  const page = Math.floor(roster.findIndex((m) => m.username === "jkt48_roleadopt") / 25);
  await handleRoleFlowSelect(fakeInteraction({ customId: `role_select:${page}`, values: ["jkt48_roleadopt"], member, guild }));
  assert.equal(guild.created.length, 0);
  assert.equal(getRoleIdFor("jkt48_roleadopt"), "owner-made");
});

test("select - role yang tersimpan tapi udah dihapus dari server -> dibikin ulang", async () => {
  recordLiveCompleted("jkt48_rolegone", "Rolegone JKT48");
  setRoleIdFor("jkt48_rolegone", "deleted-role-id");
  const guild = fakeGuild();
  const member = fakeMember();
  const roster = getRoleRoster();
  const page = Math.floor(roster.findIndex((m) => m.username === "jkt48_rolegone") / 25);
  await handleRoleFlowSelect(fakeInteraction({ customId: `role_select:${page}`, values: ["jkt48_rolegone"], member, guild }));
  assert.equal(guild.created.length, 1);
  assert.notEqual(getRoleIdFor("jkt48_rolegone"), "deleted-role-id");
});

test("select - bot gak punya izin Manage Roles (50013) -> pesan jelas + layar tetap muncul, gak crash", async () => {
  recordLiveCompleted("jkt48_roleperm", "Roleperm JKT48");
  const guild = fakeGuild();
  const member = fakeMember([], { failWith: Object.assign(new Error("Missing Permissions"), { code: 50013 }) });
  const roster = getRoleRoster();
  const page = Math.floor(roster.findIndex((m) => m.username === "jkt48_roleperm") / 25);
  const interaction = fakeInteraction({ customId: `role_select:${page}`, values: ["jkt48_roleperm"], member, guild });
  await handleRoleFlowSelect(interaction);
  assert.match(interaction.log.edits[0].content, /Manage Roles/);
  assert.ok(interaction.log.edits[0].components.length >= 2);
});

test("select di luar server (gak ada member/guild) -> dijawab jelas, gak throw", async () => {
  const interaction = fakeInteraction({ customId: "role_select:0", values: [] });
  await handleRoleFlowSelect(interaction);
  assert.match(interaction.log.edits[0].content, /cuma jalan di dalam server/);
});

test("clearall - semua role notif yang dipunya dicabut sekaligus, role non-notif gak disentuh", async () => {
  setRoleIdFor("jkt48_rolealpha", "role-alpha-id");
  setRoleIdFor("jkt48_rolebeta", "role-beta-id");
  const member = fakeMember(["role-alpha-id", "role-beta-id", "role-lain-bukan-notif"]);
  const interaction = fakeInteraction({ customId: "role_flow:clearall", member });
  await handleRoleFlowButton(interaction);
  assert.equal(member.calls.remove.length, 1);
  assert.deepEqual(member.calls.remove[0].sort(), ["role-alpha-id", "role-beta-id"]);
  assert.ok(member.roles.cache.has("role-lain-bukan-notif"));
  assert.match(interaction.log.edits[0].content, /Semua notif member dimatiin/);
  assert.match(interaction.log.edits[0].content, /Sekarang aktif: \*\*0\*\*/);
});

test("storage - setRoleIdFor nyimpen tanpa ngehapus role member lain", () => {
  setRoleIdFor("jkt48_storea", "ra");
  setRoleIdFor("jkt48_storeb", "rb");
  const all = loadMemberRoles();
  assert.equal(all.jkt48_storea, "ra");
  assert.equal(all.jkt48_storeb, "rb");
});

// ==== Ping role di notif live ====
async function captureNotif(name, username) {
  const original = global.fetch;
  const bodies = [];
  global.fetch = async (url, options) => {
    bodies.push(JSON.parse(options.body));
    return { ok: true, json: async () => ({}) };
  };
  try {
    await sendDiscordNotif(name, username, "slug", "start", null, null);
    await sendDiscordNotif(name, username, "slug", "end", null, null);
  } finally {
    global.fetch = original;
  }
  return bodies;
}

test("sendDiscordNotif - member yang punya role -> notif START nge-ping role itu (allowed_mentions.roles), notif END TIDAK", async () => {
  setRoleIdFor("jkt48_pingrole", "555");
  const [start, end] = await captureNotif("Pingrole", "jkt48_pingrole");
  assert.match(start.content, /<@&555> lagi live nih!/);
  assert.deepEqual(start.allowed_mentions, { roles: ["555"] });
  assert.doesNotMatch(end.content, /<@&555>/);
});

test("sendDiscordNotif - role + subscriber 'cok ingetin' -> dua-duanya di-ping, allowed_mentions bawa users DAN roles", async () => {
  setRoleIdFor("jkt48_pingboth", "777");
  addSubscription("pingboth", "u-sub-1");
  const [start] = await captureNotif("Pingboth", "jkt48_pingboth");
  assert.match(start.content, /<@u-sub-1> kamu subscribe notif buat member ini!/);
  assert.match(start.content, /<@&777> lagi live nih!/);
  assert.deepEqual(start.allowed_mentions, { users: ["u-sub-1"], roles: ["777"] });
});

test("sendDiscordNotif - member TANPA role dan tanpa subscriber -> gak ada mention sama sekali (perilaku lama)", async () => {
  const [start] = await captureNotif("Noping", "jkt48_nopingrole");
  assert.doesNotMatch(start.content, /<@/);
  assert.deepEqual(start.allowed_mentions, { parse: [] });
});
