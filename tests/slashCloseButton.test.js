require("./helpers/setupTestEnv");
process.env.PRIORITY_PING_USER_ID = "owner-close-test";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { activeLives } = require("../src/storage/activeLives");
const { recordLiveCompleted } = require("../src/storage/liveCount");
const { recordLiveDuration } = require("../src/storage/durationHistory");
const { getCommandDefinitionsJSON, handleSlashCommand, EPHEMERAL_COMMANDS } = require("../src/chat/slashCommands");
const { handleReplyCloseButton } = require("../src/chat/interactionHelpers");

activeLives.set("jkt48_nala", {
  name: "Nala JKT48",
  username: "jkt48_nala",
  slug: "s1",
  liveAt: new Date(Date.now() - 3600e3).toISOString(),
  viewCount: 10,
  peakViewCount: 20,
});
for (const [username, name] of [
  ["jkt48_nala", "Nala JKT48"],
  ["jkt48_lily", "Lily JKT48"],
]) {
  for (let i = 0; i < 4; i++) {
    recordLiveDuration(username, name, (40 + i) * 60000);
    recordLiveCompleted(username, name);
  }
}

// Fake ChatInputCommandInteraction (sama pola-nya dengan tests/slashCommands.test.js).
// `throwOnString` memaksa handler melempar error, buat menguji jalur error.
function fakeSlash(commandName, { subcommand = null, throwOnString = false } = {}) {
  const sent = { defer: null, payload: null };
  const interaction = {
    commandName,
    channelId: "c1",
    user: { id: "u-close" },
    replied: false,
    deferred: false,
    options: {
      getString: (name) => {
        if (throwOnString) throw new Error("boom");
        return name === "rentang" ? null : name === "alias" ? "zzalias" : "nala";
      },
      getInteger: () => 30,
      getSubcommand: () => subcommand,
    },
    deferReply: async (options) => {
      sent.defer = options ?? null;
      interaction.deferred = true;
    },
    editReply: async (payload) => {
      sent.payload = payload;
    },
    reply: async (payload) => {
      sent.payload = payload;
    },
  };
  return { interaction, sent };
}

function buttonIds(payload) {
  const rows = (payload && typeof payload === "object" && payload.components) || [];
  const ids = [];
  for (const row of rows) {
    const json = typeof row.toJSON === "function" ? row.toJSON() : row;
    for (const c of json.components || []) ids.push(c.custom_id);
  }
  return ids;
}

const hasCloseButton = (payload) => buttonIds(payload).some((id) => /close|reply_close/.test(id));

function publicCases() {
  const cases = [];
  for (const def of getCommandDefinitionsJSON()) {
    if (EPHEMERAL_COMMANDS.has(def.name)) continue;
    const subs = (def.options || []).filter((o) => o.type === 1).map((o) => o.name);
    for (const sub of subs.length ? subs : [null]) cases.push({ name: def.name, sub });
  }
  return cases;
}

test("semua slash command publik membalas dengan tombol penutup (milik sendiri atau reply_close)", async () => {
  const cases = publicCases();
  assert.ok(cases.length >= 30);
  for (const { name, sub } of cases) {
    const { interaction, sent } = fakeSlash(name, { subcommand: sub });
    await handleSlashCommand(interaction);
    assert.ok(sent.payload, `/${name} ${sub ?? ""} harus membalas`);
    assert.ok(hasCloseButton(sent.payload), `/${name} ${sub ?? ""} tidak punya tombol penutup: ${JSON.stringify(buttonIds(sent.payload))}`);
    assert.equal(sent.defer, null, `/${name} publik tidak boleh ephemeral`);
  }
});

test("tombol Tutup tidak dobel - balasan yang sudah punya tombol sendiri tidak ditambah reply_close", async () => {
  for (const [name, sub] of [
    ["grafik", null],
    ["rekap", "hari-ini"],
    ["rekap", "menu"],
  ]) {
    const { interaction, sent } = fakeSlash(name, { subcommand: sub });
    await handleSlashCommand(interaction);
    assert.ok(hasCloseButton(sent.payload), `/${name} ${sub ?? ""} harus punya penutup`);
    assert.ok(!buttonIds(sent.payload).includes("reply_close"), `/${name} ${sub ?? ""} sudah punya Tutup sendiri, jangan ditambah lagi`);
  }
  // dan yang polos mendapat tepat SATU reply_close
  const { interaction, sent } = fakeSlash("berapa-kali");
  await handleSlashCommand(interaction);
  assert.deepEqual(buttonIds(sent.payload), ["reply_close"]);
  assert.match(sent.payload.content, /\S/, "isi balasan tetap ada");
});

test("command ephemeral tidak diberi reply_close (bot tidak bisa menghapus pesan ephemeral)", async () => {
  for (const [name, sub] of [
    ["oshi", "lihat"],
    ["kelewat", null],
    ["pengaturan", "lihat"],
    ["tebak", "lihat"],
  ]) {
    assert.ok(EPHEMERAL_COMMANDS.has(name), `${name} seharusnya ephemeral`);
    const { interaction, sent } = fakeSlash(name, { subcommand: sub });
    await handleSlashCommand(interaction);
    assert.ok(sent.defer && sent.defer.flags, `/${name} harus defer ephemeral`);
    assert.ok(!buttonIds(sent.payload).includes("reply_close"), `/${name} ephemeral tidak boleh bertombol reply_close`);
  }
});

test("jalur error - pesan error di command publik juga bisa ditutup, di ephemeral tidak", async () => {
  const errorPublic = fakeSlash("stats", { throwOnString: true });
  await handleSlashCommand(errorPublic.interaction);
  assert.match(errorPublic.sent.payload.content, /ada error/);
  assert.deepEqual(buttonIds(errorPublic.sent.payload), ["reply_close"]);

  const errorEphemeral = fakeSlash("oshi", { subcommand: "tambah", throwOnString: true });
  await handleSlashCommand(errorEphemeral.interaction);
  const payload = errorEphemeral.sent.payload;
  assert.match(typeof payload === "string" ? payload : payload.content, /ada error/);
  assert.deepEqual(buttonIds(payload), []);
});

test("klik Tutup menghapus pesan balasan slash (deferUpdate dulu, lalu delete)", async () => {
  const order = [];
  const interaction = {
    deferUpdate: async () => order.push("deferUpdate"),
    message: { delete: async () => order.push("delete") },
  };
  await handleReplyCloseButton(interaction);
  assert.deepEqual(order, ["deferUpdate", "delete"]);
});
