require("./helpers/setupTestEnv");
// Env harus di-set SETELAH setupTestEnv dan SEBELUM config.js ke-load.
process.env.PRIORITY_PING_USER_ID = "owner-audit";
process.env.DISCORD_BOT_TOKEN = "token-palsu";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { PermissionFlagsBits } = require("discord.js");
const { createDiscordClient } = require("../src/discordClient");
const { buildChatReply } = require("../src/chat/router");
const { syncRolePanel, handleRoleFlowButton, buildRolePanel } = require("../src/chat/roleFlow");
const { saveRolePanelState, loadRolePanelState } = require("../src/storage/rolePanelState");
const { setRoleIdFor, getRoleIdFor, clearRoleFor, ALL_MEMBERS_KEY } = require("../src/storage/memberRoles");
const { recordLiveCompleted } = require("../src/storage/liveCount");

const ROLE_ID = "123456789012345678";
const OWNER = "owner-audit";

// Client discord.js asli (gak login); `user` dan `channels` diganti fake.
const client = createDiscordClient();
Object.defineProperty(client, "user", { value: { id: "bot-1" }, configurable: true });

const button = (customId) => ({ customId });
function panelMessage({ id, authorId = "bot-1", content = buildRolePanel().content, buttons = ["role_flow:all", "role_flow:open"], ts }) {
  const log = { edits: [], deleted: false };
  return {
    id,
    log,
    author: { id: authorId },
    content,
    createdTimestamp: ts,
    components: [{ components: buttons.map(button) }],
    edit: async (payload) => log.edits.push(payload),
    delete: async () => {
      log.deleted = true;
    },
  };
}

function fakeChannel(messages, { guild = null, everyoneCanView = true } = {}) {
  const byId = new Map(messages.map((m) => [m.id, m]));
  const sent = [];
  return {
    sent,
    guild,
    id: "chan-x",
    isTextBased: () => true,
    permissionsFor: () => ({ has: () => everyoneCanView }),
    messages: {
      fetch: async (arg) => {
        if (typeof arg === "string") {
          if (!byId.has(arg)) throw new Error("Unknown Message");
          return byId.get(arg);
        }
        return new Map(messages.map((m) => [m.id, m]));
      },
    },
    send: async (payload) => {
      const id = `new${sent.length + 1}`;
      sent.push(payload);
      return { id };
    },
  };
}

function useChannels(map) {
  client.channels = { fetch: async (id) => map[id] || null };
}

// ==== panel: ID pesan hilang -> panel yang udah ada dipakai lagi, gak bikin baru ====
test("syncRolePanel - ID pesan panel hilang (data ke-reset): panel bot yang udah ada di channel DI-EDIT, bukan bikin baru", async () => {
  const existing = panelMessage({ id: "p1", ts: 100 });
  const channel = fakeChannel([existing]);
  useChannels({ "chan-audit": channel });
  saveRolePanelState({});
  const result = await syncRolePanel(client, "chan-audit");
  assert.deepEqual([result.ok, result.action], [true, "edited"]);
  assert.equal(channel.sent.length, 0, "gak ada pesan panel baru");
  assert.equal(existing.log.edits.length, 1);
  assert.deepEqual(loadRolePanelState(), { channelId: "chan-audit", messageId: "p1" });
});

test("syncRolePanel - panel udah numpuk: yang TERBARU dipakai, sisanya dihapus; balasan 'cok role' (ada Tutup) dan pesan orang lain gak disentuh", async () => {
  const oldest = panelMessage({ id: "a", ts: 1 });
  const newest = panelMessage({ id: "b", ts: 3 });
  const middle = panelMessage({ id: "c", ts: 2 });
  const temporary = panelMessage({ id: "d", ts: 4, buttons: ["role_flow:all", "role_flow:open", "reply_close"] });
  const someoneElse = panelMessage({ id: "e", ts: 5, authorId: "user-lain" });
  const plainBotMessage = panelMessage({ id: "f", ts: 6, content: "pesan bot biasa" });
  const channel = fakeChannel([oldest, newest, middle, temporary, someoneElse, plainBotMessage]);
  useChannels({ "chan-audit": channel });
  saveRolePanelState({});
  const result = await syncRolePanel(client, "chan-audit");
  assert.equal(result.action, "edited");
  assert.equal(loadRolePanelState().messageId, "b");
  assert.equal(newest.log.edits.length, 1);
  assert.equal(oldest.log.deleted, true);
  assert.equal(middle.log.deleted, true);
  for (const untouched of [temporary, someoneElse, plainBotMessage]) {
    assert.equal(untouched.log.deleted, false);
    assert.equal(untouched.log.edits.length, 0);
  }
});

test("syncRolePanel - channel benar-benar belum punya panel: dibikin baru (scan riwayat gak ngalangin)", async () => {
  const channel = fakeChannel([panelMessage({ id: "x", ts: 1, authorId: "user-lain" })]);
  useChannels({ "chan-audit": channel });
  saveRolePanelState({});
  const result = await syncRolePanel(client, "chan-audit");
  assert.deepEqual([result.ok, result.action], [true, "created"]);
  assert.equal(channel.sent.length, 1);
});

// ==== perintah owner: nama member lebih dari satu kata, format salah ====
const ask = (text, authorId = OWNER, channelId = "chan-audit") => buildChatReply(text, { isBotChannel: true, channelId, authorId });

test("'tambah role' - nama member lebih dari satu kata ('marsha audit') ketangkep", async () => {
  useChannels({ "chan-audit": fakeChannel([]) });
  recordLiveCompleted("jkt48_marshaaudit", "Marsha Audit JKT48");
  const reply = await ask(`cok tambah role marsha audit <@&${ROLE_ID}>`);
  assert.match(reply, /didaftarin buat \*\*Marsha Audit\*\*/);
  assert.equal(getRoleIdFor("jkt48_marshaaudit"), ROLE_ID);
  clearRoleFor("jkt48_marshaaudit");
});

test("'tambah role' / 'hapus role' dengan format kurang -> petunjuk format, bukan jatuh ke menu bot", async () => {
  useChannels({ "chan-audit": fakeChannel([]) });
  const noRole = await ask("cok tambah role aralie");
  assert.match(noRole, /Formatnya: "cok tambah role <nama member> <@Role>"/);
  assert.match(await ask("cok tambah role"), /Formatnya/);
  assert.match(await ask("cok hapus role"), /Formatnya: "cok hapus role <nama member>"/);
});

test("'tambah role' / 'hapus role' / 'cek role' dari bukan owner tetap ditolak", async () => {
  assert.match(await ask(`cok tambah role aralie <@&${ROLE_ID}>`, "user-biasa"), /cuma owner/);
  assert.match(await ask("cok hapus role aralie", "user-biasa"), /cuma owner/);
  assert.match(await ask("cok cek role", "user-biasa"), /cuma owner/);
});

// ==== validasi role saat didaftarin ====
function fakeGuild(roles, id = "guild-1") {
  const cache = new Map(roles.map((r) => [r.id, r]));
  cache.find = (fn) => [...cache.values()].find(fn);
  return {
    id,
    roles: { cache, fetch: async (roleId) => cache.get(roleId) || null, everyone: { id } },
    channels: { fetch: async () => null },
    members: { me: { permissions: { has: () => true } } },
  };
}

test("daftarin role yang GAK ADA di server -> ditolak, gak tersimpan", async () => {
  recordLiveCompleted("jkt48_validasiaudit", "Validasiaudit JKT48");
  useChannels({ "chan-audit": fakeChannel([], { guild: fakeGuild([]) }) });
  const reply = await ask(`cok tambah role validasiaudit <@&${ROLE_ID}>`);
  assert.match(reply, /gak ketemu di server ini/);
  assert.equal(getRoleIdFor("jkt48_validasiaudit"), null);
});

test("daftarin role @everyone / role bot (managed) -> ditolak", async () => {
  recordLiveCompleted("jkt48_validasiaudit", "Validasiaudit JKT48");
  const everyoneId = "555555555555555555";
  const guild = fakeGuild(
    [
      { id: everyoneId, name: "@everyone", editable: true },
      { id: ROLE_ID, name: "BotRole", managed: true, editable: false },
    ],
    everyoneId,
  );
  useChannels({ "chan-audit": fakeChannel([], { guild }) });
  assert.match(await ask(`cok tambah role validasiaudit ${everyoneId}`), /role @everyone/);
  assert.match(await ask(`cok tambah role validasiaudit <@&${ROLE_ID}>`), /role milik bot/);
  assert.equal(getRoleIdFor("jkt48_validasiaudit"), null);
});

test("daftarin role yang posisinya di atas role bot -> tetap didaftarin tapi ada PERINGATAN hierarki", async () => {
  recordLiveCompleted("jkt48_validasiaudit", "Validasiaudit JKT48");
  const guild = fakeGuild([{ id: ROLE_ID, name: "Tinggi", editable: false }]);
  useChannels({ "chan-audit": fakeChannel([], { guild }) });
  const reply = await ask(`cok tambah role validasiaudit <@&${ROLE_ID}>`);
  assert.match(reply, /didaftarin buat/);
  assert.match(reply, /role bot harus DI ATAS/);
  assert.equal(getRoleIdFor("jkt48_validasiaudit"), ROLE_ID);
  clearRoleFor("jkt48_validasiaudit");
});

test("role yang valid didaftarin tanpa peringatan; 'semua' juga divalidasi", async () => {
  recordLiveCompleted("jkt48_validasiaudit", "Validasiaudit JKT48");
  const guild = fakeGuild([{ id: ROLE_ID, name: "Bagus", editable: true }]);
  useChannels({ "chan-audit": fakeChannel([], { guild }) });
  const ok = await ask(`cok tambah role validasiaudit <@&${ROLE_ID}>`);
  assert.doesNotMatch(ok, /⚠️/);
  clearRoleFor("jkt48_validasiaudit");
  assert.match(await ask("cok tambah role semua <@&999999999999999999>"), /gak ketemu di server ini/);
  assert.match(await ask(`cok tambah role semua <@&${ROLE_ID}>`), /Role "Semua member" diset/);
  clearRoleFor(ALL_MEMBERS_KEY);
});

// ==== "cok cek role" ====
test("'cek role' - laporin izin, role hilang/hierarki, akses channel live semua member, panel", async () => {
  setRoleIdFor("jkt48_cekbagus", "r-bagus");
  setRoleIdFor("jkt48_cekhilang", "r-hilang");
  setRoleIdFor("jkt48_cektinggi", "r-tinggi");
  setRoleIdFor(ALL_MEMBERS_KEY, "r-all");
  process.env.ALL_LIVE_CHANNEL_ID = "";
  const guild = fakeGuild([
    { id: "r-bagus", editable: true },
    { id: "r-tinggi", editable: false },
    { id: "r-all", name: "all-live", editable: true },
  ]);
  guild.members.me = { permissions: { has: (flag) => flag !== PermissionFlagsBits.ManageRoles } };
  const allChannel = { id: "chan-all", permissionsFor: () => ({ has: () => false }) };
  saveRolePanelState({ channelId: "chan-audit", messageId: "gone" });
  const chan = fakeChannel([], { guild, everyoneCanView: false });
  guild.channels.fetch = async (id) => (id === "chan-all" ? allChannel : id === "chan-audit" ? chan : null);
  useChannels({ "chan-audit": chan });

  const original = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ channel_id: "chan-all" }) });
  let reply;
  try {
    reply = await ask("cok cek role");
  } finally {
    global.fetch = original;
    for (const key of ["jkt48_cekbagus", "jkt48_cekhilang", "jkt48_cektinggi", ALL_MEMBERS_KEY]) clearRoleFor(key);
  }
  assert.match(reply, /❌ Bot belum punya izin \*\*Manage Roles\*\*/);
  assert.match(reply, /Role member beres: 1\/3/);
  assert.match(reply, /Cekhilang: role <@&r-hilang> gak ketemu/);
  assert.match(reply, /Cektinggi: role bot masih di BAWAH/);
  assert.match(reply, /BELUM bisa lihat <#chan-all>/);
  assert.match(reply, /Pesan panel di <#chan-audit> gak ketemu/);
  assert.match(reply, /@everyone gak bisa lihat channel role/);
  assert.ok(reply.length < 2000);
});

test("'cek role' - semua sehat -> centang semua, tanpa ❌/⚠️", async () => {
  setRoleIdFor("jkt48_cekbagus", "r-bagus");
  setRoleIdFor(ALL_MEMBERS_KEY, "r-all");
  const guild = fakeGuild([
    { id: "r-bagus", editable: true },
    { id: "r-all", name: "all-live", editable: true },
  ]);
  const allChannel = { id: "chan-all", permissionsFor: () => ({ has: () => true }) };
  guild.channels.fetch = async (id) => (id === "chan-all" ? allChannel : null);
  const panel = panelMessage({ id: "ok-panel", ts: 1 });
  saveRolePanelState({ channelId: "chan-audit", messageId: "ok-panel" });
  const chan = fakeChannel([panel], { guild });
  guild.channels.fetch = async (id) => (id === "chan-all" ? allChannel : id === "chan-audit" ? chan : null);
  useChannels({ "chan-audit": chan });
  const original = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ channel_id: "chan-all" }) });
  try {
    const reply = await ask("cok cek role");
    assert.doesNotMatch(reply, /❌|⚠️/);
    assert.match(reply, /Role member beres: 1\/1/);
    assert.match(reply, /Panel terpasang di <#chan-audit>/);
  } finally {
    global.fetch = original;
    clearRoleFor("jkt48_cekbagus");
    clearRoleFor(ALL_MEMBERS_KEY);
  }
});

// ==== error tak terduga di tombol -> user dapet pesan, bukan "interaksi gagal" ====
test("error tak terduga di handler tombol role -> user dikasih pesan pribadi (followUp), gak throw", async () => {
  const followUps = [];
  const interaction = {
    customId: "role_flow:alltoggle",
    user: { id: "user-x" },
    member: { roles: { cache: new Map() } },
    guild: {},
    deferred: false,
    replied: false,
    deferUpdate: async function () {
      this.deferred = true;
    },
    editReply: async () => {
      throw new Error("Unknown interaction");
    },
    followUp: async (payload) => followUps.push(payload),
  };
  await handleRoleFlowButton(interaction);
  assert.equal(followUps.length, 1);
  assert.match(followUps[0].content, /ada error pas ngurus role/);
  assert.equal(followUps[0].flags, 64);
});
