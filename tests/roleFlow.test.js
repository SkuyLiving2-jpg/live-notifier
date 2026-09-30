require("./helpers/setupTestEnv");
// PRIORITY_PING_USER_ID harus di-set SETELAH setupTestEnv dan SEBELUM config.js ke-load.
process.env.PRIORITY_PING_USER_ID = "owner-role";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { recordLiveCompleted } = require("../src/storage/liveCount");
const { loadMemberRoles, setRoleIdFor, getRoleIdFor, clearRoleFor, ALL_MEMBERS_KEY } = require("../src/storage/memberRoles");
const { addSubscription } = require("../src/storage/subscriptions");
const { sendDiscordNotif } = require("../src/notify/liveNotify");
const {
  buildRolePanel,
  syncRolePanel,
  syncRolePanelOnBoot,
  buildSettingsScreen,
  handleRoleFlowButton,
  handleRoleFlowSelect,
  getRoleRoster,
  handleAddMemberRole,
  handleRemoveMemberRole,
  replyRoleList,
  parseRoleRef,
} = require("../src/chat/roleFlow");

// Guild/member palsu: cukup yang dipakai roleFlow.js. Gak nyentuh Discord asli.
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
        const list = [].concat(ids);
        calls.add.push(list);
        for (const id of list) cache.set(id, { id });
      },
      remove: async (ids) => {
        if (failWith) throw failWith;
        const list = [].concat(ids);
        calls.remove.push(list);
        for (const id of list) cache.delete(id);
      },
    },
  };
}

function fakeInteraction({ customId, values = [], member, guild } = {}) {
  const log = { replies: [], edits: [], updates: [], deferred: 0, deferredReply: 0 };
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
    deferReply: async () => {
      log.deferredReply += 1;
    },
    editReply: async (p) => log.edits.push(p),
  };
}

const ids = (row) => row.toJSON().components.map((c) => c.custom_id);

function resetRoles() {
  for (const key of Object.keys(loadMemberRoles())) clearRoleFor(key);
}

// Member uji: dua yang "punya channel privat" (rolenya didaftarin owner).
function seedRoles() {
  resetRoles();
  recordLiveCompleted("jkt48_rolealpha", "Rolealpha JKT48");
  setRoleIdFor("jkt48_rolealpha", "role-alpha");
  setRoleIdFor("jkt48_rolebeta", "role-beta"); // gak pernah tercatat live: label diturunin dari username
}

function guildWithMemberRoles() {
  return fakeGuild({
    existingRoles: [
      { id: "role-alpha", name: "Rolealpha" },
      { id: "role-beta", name: "Rolebeta" },
    ],
  });
}

test("getRoleRoster - cuma member yang rolenya didaftarin owner, kunci 'semua' gak ikut, label rapi, urut abjad", () => {
  seedRoles();
  setRoleIdFor(ALL_MEMBERS_KEY, "role-all");
  const roster = getRoleRoster();
  assert.deepEqual(
    roster.map((m) => m.label),
    ["Rolealpha", "Rolebeta"],
  );
});

test("panel - dua tombol pilihan (Semua member / Pilih member tertentu); permanen tanpa Tutup, versi 'cok role' pakai Tutup; memuat daftar member tersedia", () => {
  seedRoles();
  assert.deepEqual(ids(buildRolePanel().components[0]), ["role_flow:all", "role_flow:open"]);
  assert.deepEqual(ids(buildRolePanel({ closable: true }).components[0]), ["role_flow:all", "role_flow:open", "reply_close"]);
  const panel = buildRolePanel();
  assert.match(panel.content, /Selamat datang/);
  assert.match(panel.content, /Member yang tersedia:\*\* Rolealpha, Rolebeta/);
  resetRoles();
  assert.doesNotMatch(buildRolePanel().content, /Member yang tersedia/);
});

test("panel - daftar member panjang dipotong ('dan N lainnya'), pesan tetap di bawah 2000 karakter", () => {
  resetRoles();
  for (let i = 0; i < 100; i++) setRoleIdFor(`jkt48_panjangbanget${String(i).padStart(3, "0")}`, `r${i}`);
  const { content } = buildRolePanel();
  assert.ok(content.length < 2000, `panel ${content.length} karakter`);
  assert.match(content, /dan \d+ lainnya/);
  resetRoles();
});

// ==== Panel permanen: selalu DI-EDIT, gak numpuk ====
function fakeDiscordClient({ existing = {} } = {}) {
  const messages = new Map(Object.entries(existing)); // id -> {content,...}
  const log = { sent: [], edited: [], deleted: [], fetchedChannels: [] };
  let nextId = 1;
  const makeChannel = (channelId) => ({
    isTextBased: () => true,
    messages: {
      fetch: async (id) => {
        const msg = messages.get(id);
        if (!msg || msg.channelId !== channelId) throw new Error("Unknown Message");
        return {
          id,
          edit: async (payload) => {
            log.edited.push({ id, payload });
            return msg;
          },
          delete: async () => {
            log.deleted.push(id);
            messages.delete(id);
          },
        };
      },
    },
    send: async (payload) => {
      const id = `msg-${nextId++}`;
      messages.set(id, { channelId, payload });
      log.sent.push({ channelId, id, payload });
      return { id };
    },
  });
  return {
    log,
    messages,
    channels: {
      fetch: async (channelId) => {
        log.fetchedChannels.push(channelId);
        if (channelId === "chan-hilang") throw new Error("Unknown Channel");
        return makeChannel(channelId);
      },
    },
  };
}

function resetPanelState() {
  const { saveRolePanelState } = require("../src/storage/rolePanelState");
  saveRolePanelState({});
}

test("syncRolePanel - pertama kali: pesan panel DIKIRIM sekali dan ID-nya disimpan; sinkron berikutnya cuma NGEDIT pesan yang sama (gak numpuk)", async () => {
  seedRoles();
  resetPanelState();
  const client = fakeDiscordClient();

  const first = await syncRolePanel(client, "chan-role");
  assert.deepEqual(first, { ok: true, action: "created", moved: false });
  assert.equal(client.log.sent.length, 1);
  assert.deepEqual(ids(client.log.sent[0].payload.components[0]), ["role_flow:all", "role_flow:open"]);

  const second = await syncRolePanel(client, "chan-role");
  const third = await syncRolePanel(client, "chan-role");
  assert.equal(second.action, "edited");
  assert.equal(third.action, "edited");
  assert.equal(client.log.sent.length, 1, "TETAP cuma 1 pesan terkirim, gak numpuk");
  assert.equal(client.log.edited.length, 2);
  assert.equal(client.log.edited[0].id, client.log.sent[0].id);
});

test("syncRolePanel - pesan panel dihapus manual di Discord -> dibikin ulang (bukan error)", async () => {
  seedRoles();
  resetPanelState();
  const client = fakeDiscordClient();
  await syncRolePanel(client, "chan-role");
  client.messages.clear(); // dihapus orang
  const again = await syncRolePanel(client, "chan-role");
  assert.equal(again.action, "created");
  assert.equal(client.log.sent.length, 2);
});

test("syncRolePanel - panel dipindah ke channel lain -> pesan lama DIHAPUS, yang baru dibikin", async () => {
  seedRoles();
  resetPanelState();
  const client = fakeDiscordClient();
  await syncRolePanel(client, "chan-lama");
  const moved = await syncRolePanel(client, "chan-baru");
  assert.deepEqual(moved, { ok: true, action: "created", moved: true });
  assert.equal(client.log.deleted.length, 1);
  assert.equal(client.messages.size, 1);
});

test("syncRolePanel - channel gak bisa diambil -> { ok:false } dengan alasan, gak throw", async () => {
  resetPanelState();
  const result = await syncRolePanel(fakeDiscordClient(), "chan-hilang");
  assert.equal(result.ok, false);
  assert.match(result.error, /Unknown Channel/);
});

test("syncRolePanelOnBoot - pakai channel panel yang terakhir dipasang; belum ada sama sekali -> gak ngapa-ngapain", async () => {
  seedRoles();
  resetPanelState();
  const client = fakeDiscordClient();
  assert.equal(await syncRolePanelOnBoot(client), null);
  assert.equal(client.log.fetchedChannels.length, 0);

  await syncRolePanel(client, "chan-role");
  const boot = await syncRolePanelOnBoot(client);
  assert.equal(boot.action, "edited", "boot ngedit panel yang ada, gak kirim baru");
  assert.equal(client.log.sent.length, 1);
});

test("buildSettingsScreen - dropdown maks 25, role yang dipunya ke-centang, 3 tombol (Tutup/Matikan semua/toggle semua), baris <= 5", () => {
  seedRoles();
  const screen = buildSettingsScreen(fakeMember(["role-alpha"]));
  assert.ok(screen.components.length <= 5);
  assert.deepEqual(ids(screen.components[screen.components.length - 1]), ["role_flow:close", "role_flow:clearall", "role_flow:alltoggle"]);
  const select = screen.components[0].toJSON().components[0];
  assert.equal(select.custom_id, "role_select:0");
  assert.equal(select.min_values, 0);
  assert.equal(select.options.find((o) => o.value === "jkt48_rolealpha").default, true);
  assert.equal(select.options.find((o) => o.value === "jkt48_rolebeta").default, false);
  assert.match(screen.content, /Sekarang aktif: \*\*1\*\* member/);
});

test("buildSettingsScreen - belum ada role yang didaftarin owner -> pesan jelas, tombol 'semua member' tetap ada", () => {
  resetRoles();
  const screen = buildSettingsScreen(fakeMember());
  assert.match(screen.content, /owner belum daftarin role member/);
  assert.deepEqual(ids(screen.components[0]), ["role_flow:close", "role_flow:clearall", "role_flow:alltoggle"]);
});

test("tombol 'open' - balas EPHEMERAL dengan layar pengaturan", async () => {
  seedRoles();
  const interaction = fakeInteraction({ customId: "role_flow:open", member: fakeMember() });
  await handleRoleFlowButton(interaction);
  assert.equal(interaction.log.replies[0].flags, 64);
  assert.ok(interaction.log.replies[0].components.length >= 2);
});

test("tombol 'close' - edit jadi dismiss tanpa komponen", async () => {
  const interaction = fakeInteraction({ customId: "role_flow:close" });
  await handleRoleFlowButton(interaction);
  assert.deepEqual(interaction.log.updates[0].components, []);
});

test("tombol 'all' (dari panel/sambutan) - role 'semua member' dibikin bot (mentionable), di-assign, balasan ephemeral menunjukkan AKTIF", async () => {
  seedRoles();
  const guild = fakeGuild();
  const member = fakeMember();
  const interaction = fakeInteraction({ customId: "role_flow:all", member, guild });
  await handleRoleFlowButton(interaction);

  assert.equal(interaction.log.deferredReply, 1);
  assert.equal(guild.created.length, 1);
  assert.equal(guild.created[0].name, "🔔 Semua Member");
  assert.equal(guild.created[0].mentionable, true);
  assert.equal(getRoleIdFor(ALL_MEMBERS_KEY), guild.created[0].id);
  assert.deepEqual(member.calls.add, [[guild.created[0].id]]);
  const edit = interaction.log.edits[0];
  assert.match(edit.content, /di-tag tiap SIAPAPUN/);
  assert.match(edit.components[edit.components.length - 1].toJSON().components[2].label, /Semua member: AKTIF/);
});

test("tombol 'all' - role 'semua member' yang udah didaftarin owner DIPAKE, gak bikin baru; klik ulang gak nambah dobel", async () => {
  seedRoles();
  setRoleIdFor(ALL_MEMBERS_KEY, "role-all");
  const guild = fakeGuild({ existingRoles: [{ id: "role-all", name: "Notif Semua" }] });
  const member = fakeMember(["role-all"]);
  await handleRoleFlowButton(fakeInteraction({ customId: "role_flow:all", member, guild }));
  assert.equal(guild.created.length, 0);
  assert.equal(member.calls.add.length, 0, "udah punya role-nya, gak ditambah lagi");
});

test("tombol 'alltoggle' - matiin kalau aktif, aktifin kalau mati, edit di tempat (deferUpdate + editReply)", async () => {
  seedRoles();
  setRoleIdFor(ALL_MEMBERS_KEY, "role-all");
  const guild = fakeGuild({ existingRoles: [{ id: "role-all", name: "Notif Semua" }] });
  const member = fakeMember(["role-all"]);

  const off = fakeInteraction({ customId: "role_flow:alltoggle", member, guild });
  await handleRoleFlowButton(off);
  assert.deepEqual(
    member.calls.remove,
    [["role-all"]].map((x) => x.map((y) => y)),
  );
  assert.match(off.log.edits[0].content, /"Semua member" dimatiin/);
  assert.match(off.log.edits[0].components[off.log.edits[0].components.length - 1].toJSON().components[2].label, /mati/);

  const on = fakeInteraction({ customId: "role_flow:alltoggle", member, guild });
  await handleRoleFlowButton(on);
  assert.match(on.log.edits[0].content, /"Semua member" aktif/);
  assert.equal(member.roles.cache.has("role-all"), true);
});

test("select - centang member -> role yang DIDAFTARIN OWNER di-assign (gak ada role baru dibikin), layar ke-update", async () => {
  seedRoles();
  const guild = guildWithMemberRoles();
  const member = fakeMember();
  const interaction = fakeInteraction({ customId: "role_select:0", values: ["jkt48_rolebeta"], member, guild });
  await handleRoleFlowSelect(interaction);

  assert.equal(interaction.log.deferred, 1);
  assert.equal(guild.created.length, 0, "role member gak boleh dibikin otomatis");
  assert.deepEqual(member.calls.add, [["role-beta"]]);
  const edit = interaction.log.edits[0];
  assert.match(edit.content, /✅ Aktif: Rolebeta/);
  const select = edit.components[0].toJSON().components[0];
  assert.equal(select.options.find((o) => o.value === "jkt48_rolebeta").default, true);
});

test("select - lepas centang member yang rolenya dipunya -> role DICABUT, role lain (non-notif) gak disentuh", async () => {
  seedRoles();
  const guild = guildWithMemberRoles();
  const member = fakeMember(["role-alpha", "role-vip-bukan-notif"]);
  const interaction = fakeInteraction({ customId: "role_select:0", values: [], member, guild });
  await handleRoleFlowSelect(interaction);
  assert.deepEqual(member.calls.remove, [["role-alpha"]]);
  assert.ok(member.roles.cache.has("role-vip-bukan-notif"));
  assert.match(interaction.log.edits[0].content, /🔕 Dimatiin: Rolealpha/);
});

test("select - role terdaftar tapi udah dihapus dari server -> dilewati dengan peringatan ke user, gak crash, gak ada yang di-assign", async () => {
  seedRoles();
  const guild = fakeGuild(); // role-alpha/role-beta gak ada di server
  const member = fakeMember();
  const interaction = fakeInteraction({ customId: "role_select:0", values: ["jkt48_rolealpha"], member, guild });
  await handleRoleFlowSelect(interaction);
  assert.equal(member.calls.add.length, 0);
  assert.match(interaction.log.edits[0].content, /Role Rolealpha gak ketemu di server/);
});

test("select - bot gak punya izin Manage Roles (50013) -> pesan jelas + layar tetap muncul, gak crash", async () => {
  seedRoles();
  const guild = guildWithMemberRoles();
  const member = fakeMember([], { failWith: Object.assign(new Error("Missing Permissions"), { code: 50013 }) });
  const interaction = fakeInteraction({ customId: "role_select:0", values: ["jkt48_rolealpha"], member, guild });
  await handleRoleFlowSelect(interaction);
  assert.match(interaction.log.edits[0].content, /Manage Roles/);
  assert.ok(interaction.log.edits[0].components.length >= 2);
});

test("select di luar server (gak ada member/guild) -> dijawab jelas, gak throw", async () => {
  const interaction = fakeInteraction({ customId: "role_select:0", values: [] });
  await handleRoleFlowSelect(interaction);
  assert.match(interaction.log.edits[0].content, /cuma jalan di dalam server/);
});

test("clearall - semua role notif (member + semua member) dicabut sekaligus, role non-notif gak disentuh", async () => {
  seedRoles();
  setRoleIdFor(ALL_MEMBERS_KEY, "role-all");
  const member = fakeMember(["role-alpha", "role-beta", "role-all", "role-lain-bukan-notif"]);
  const interaction = fakeInteraction({ customId: "role_flow:clearall", member });
  await handleRoleFlowButton(interaction);
  assert.equal(member.calls.remove.length, 1);
  assert.deepEqual(member.calls.remove[0].sort(), ["role-all", "role-alpha", "role-beta"]);
  assert.ok(member.roles.cache.has("role-lain-bukan-notif"));
  assert.match(interaction.log.edits[0].content, /Semua notif dimatiin/);
  assert.match(interaction.log.edits[0].content, /Sekarang aktif: \*\*0\*\*/);
});

// ==== Perintah owner ====
test("parseRoleRef - mention <@&id> atau ID polos; selain itu null", () => {
  assert.equal(parseRoleRef("<@&123456789012345678>"), "123456789012345678");
  assert.equal(parseRoleRef("123456789012345678"), "123456789012345678");
  assert.equal(parseRoleRef("@Aralie"), null);
  assert.equal(parseRoleRef("123"), null);
});

test("handleAddMemberRole - bukan owner ditolak; owner sukses (member dikenal bot), role nongol di panel & daftar", async () => {
  resetRoles();
  recordLiveCompleted("jkt48_cmdaralie", "Cmdaralie JKT48");
  assert.match(await handleAddMemberRole("cmdaralie", "<@&111111111111111111>", "bukan-owner"), /cuma owner/);
  assert.equal(getRoleIdFor("jkt48_cmdaralie"), null);

  const ok = await handleAddMemberRole("cmdaralie", "<@&111111111111111111>", "owner-role");
  assert.match(ok, /didaftarin buat \*\*Cmdaralie\*\*/);
  assert.equal(getRoleIdFor("jkt48_cmdaralie"), "111111111111111111");
  assert.deepEqual(
    getRoleRoster().map((m) => m.label),
    ["Cmdaralie"],
  );
  assert.match(replyRoleList(), /Cmdaralie -> <@&111111111111111111>/);

  const replaced = await handleAddMemberRole("cmdaralie", "222222222222222222", "owner-role");
  assert.match(replaced, /gantiin role lama/);
});

test("handleAddMemberRole - role bukan mention/ID ditolak dengan contoh; nama ngawur dicek ke IDN dan ditolak", async () => {
  resetRoles();
  assert.match(await handleAddMemberRole("aralie", "Aralie", "owner-role"), /harus di-mention/);
  const original = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ errors: [{ message: "User Not found" }], data: null }) });
  try {
    assert.match(await handleAddMemberRole("zzzzngawur", "<@&111111111111111111>", "owner-role"), /gak ketemu sebagai member JKT48/);
  } finally {
    global.fetch = original;
  }
});

test("handleAddMemberRole - member yang belum pernah live tapi ada di IDN (mis. member baru) tetap bisa didaftarin", async () => {
  resetRoles();
  const original = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ data: { getPublicProfileByUsername: { username: "jkt48_newbiexyz", name: "Newbiexyz JKT48", avatar: null } } }),
  });
  try {
    const reply = await handleAddMemberRole("newbiexyz", "<@&111111111111111111>", "owner-role");
    assert.match(reply, /didaftarin buat \*\*Newbiexyz\*\*/);
    assert.equal(getRoleIdFor("jkt48_newbiexyz"), "111111111111111111");
  } finally {
    global.fetch = original;
  }
});

test("handleAddMemberRole/handleRemoveMemberRole - 'semua' ngatur role notif semua member", async () => {
  resetRoles();
  assert.match(await handleAddMemberRole("semua", "<@&333333333333333333>", "owner-role"), /Role "Semua member" diset/);
  assert.equal(getRoleIdFor(ALL_MEMBERS_KEY), "333333333333333333");
  assert.match(await handleRemoveMemberRole("semua", "owner-role"), /dilepas dari daftar/);
  assert.equal(getRoleIdFor(ALL_MEMBERS_KEY), null);
  assert.match(await handleRemoveMemberRole("semua", "owner-role"), /emang belum didaftarin/);
});

test("handleRemoveMemberRole - owner-only; hapus dari daftar (role di server gak dihapus)", async () => {
  resetRoles();
  recordLiveCompleted("jkt48_cmdremove", "Cmdremove JKT48");
  setRoleIdFor("jkt48_cmdremove", "444444444444444444");
  assert.match(await handleRemoveMemberRole("cmdremove", "bukan-owner"), /cuma owner/);
  assert.match(await handleRemoveMemberRole("cmdremove", "owner-role"), /dilepas dari daftar role/);
  assert.equal(getRoleIdFor("jkt48_cmdremove"), null);
  assert.match(await handleRemoveMemberRole("cmdremove", "owner-role"), /emang belum didaftarin/);
});

test("replyRoleList - kosong -> petunjuk cara daftarin", () => {
  resetRoles();
  assert.match(replyRoleList(), /belum ada role member yang didaftarin/);
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
  resetRoles();
  setRoleIdFor("jkt48_pingrole", "555");
  const [start, end] = await captureNotif("Pingrole", "jkt48_pingrole");
  assert.match(start.content, /<@&555> lagi live nih!/);
  assert.deepEqual(start.allowed_mentions, { roles: ["555"] });
  assert.doesNotMatch(end.content, /<@&555>/);
});

test("sendDiscordNotif - role 'semua member' di-ping buat SIAPAPUN yang live, gabung sama role member dalam satu baris (gak dobel kalau sama)", async () => {
  resetRoles();
  setRoleIdFor(ALL_MEMBERS_KEY, "999");
  const [plain] = await captureNotif("Anyone", "jkt48_anyone");
  assert.match(plain.content, /<@&999> lagi live nih!/);
  assert.deepEqual(plain.allowed_mentions, { roles: ["999"] });

  setRoleIdFor("jkt48_bothroles", "555");
  const [both] = await captureNotif("Bothroles", "jkt48_bothroles");
  assert.match(both.content, /<@&555> <@&999> lagi live nih!/);
  assert.deepEqual(both.allowed_mentions, { roles: ["555", "999"] });

  setRoleIdFor("jkt48_samerole", "999");
  const [same] = await captureNotif("Samerole", "jkt48_samerole");
  assert.deepEqual(same.allowed_mentions, { roles: ["999"] });
});

test("sendDiscordNotif - role + subscriber 'cok ingetin' -> dua-duanya di-ping, allowed_mentions bawa users DAN roles", async () => {
  resetRoles();
  setRoleIdFor("jkt48_pingboth", "777");
  addSubscription("pingboth", "u-sub-1");
  const [start] = await captureNotif("Pingboth", "jkt48_pingboth");
  assert.match(start.content, /<@u-sub-1> kamu subscribe notif buat member ini!/);
  assert.match(start.content, /<@&777> lagi live nih!/);
  assert.deepEqual(start.allowed_mentions, { users: ["u-sub-1"], roles: ["777"] });
});

test("sendDiscordNotif - tanpa role apapun dan tanpa subscriber -> gak ada mention sama sekali (perilaku lama)", async () => {
  resetRoles();
  const [start] = await captureNotif("Noping", "jkt48_nopingrole");
  assert.doesNotMatch(start.content, /<@/);
  assert.deepEqual(start.allowed_mentions, { parse: [] });
});
