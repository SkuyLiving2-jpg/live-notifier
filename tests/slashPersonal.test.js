require("./helpers/setupTestEnv");

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { MessageFlags } = require("discord.js");
const { handleSlashCommand, EPHEMERAL_COMMANDS, getCommandDefinitionsJSON } = require("../src/chat/slashCommands");
const { getUserPrefs } = require("../src/storage/userPrefs");
const { recordLiveCompleted } = require("../src/storage/liveCount");
const { activeLives } = require("../src/storage/activeLives");

// Interaction palsu: nyimpen argumen deferReply (buat cek ephemeral) dan isi balasan akhir.
function fake({ commandName, subcommand = null, strings = {}, integers = {}, userId = "slash-u1" }) {
  const state = { deferArgs: "belum", replies: [] };
  return {
    commandName,
    channelId: "slash-c",
    user: { id: userId },
    replied: false,
    deferred: false,
    options: {
      getString: (name) => (name in strings ? strings[name] : null),
      getInteger: (name) => (name in integers ? integers[name] : null),
      getSubcommand: () => subcommand,
    },
    deferReply: async (args) => {
      state.deferArgs = args;
    },
    editReply: async (payload) => state.replies.push(payload),
    reply: async (payload) => state.replies.push(payload),
    state,
  };
}
const contentOf = (i) => i.state.replies.at(-1).content;

test("daftar command personal ada, nama sah (huruf kecil/angka/strip, <= 32), deskripsi <= 100 karakter, opsi/subcommand valid", () => {
  const defs = getCommandDefinitionsJSON();
  const names = defs.map((d) => d.name);
  for (const expected of ["oshi", "kelewat", "pengaturan", "tebak", "wrapped", "grafik-penonton"]) assert.ok(names.includes(expected), expected);
  for (const def of defs) {
    assert.match(def.name, /^[a-z0-9-]{1,32}$/);
    assert.ok(def.description.length >= 1 && def.description.length <= 100, def.name);
    assert.ok((def.options || []).length <= 25);
  }
  const pengaturan = defs.find((d) => d.name === "pengaturan");
  assert.deepEqual(
    pengaturan.options.map((o) => o.name),
    ["lihat", "notif", "jam-tenang", "jam-tenang-mati", "ringkasan"],
  );
});

test("ephemeral: command personal dijawab ephemeral, command publik tetap publik (deferReply tanpa argumen)", async () => {
  for (const name of ["oshi", "kelewat", "pengaturan", "tebak"]) assert.ok(EPHEMERAL_COMMANDS.has(name), name);
  for (const name of ["wrapped", "grafik-penonton", "live", "rekap", "grafik"]) assert.equal(EPHEMERAL_COMMANDS.has(name), false, name);

  const personal = fake({ commandName: "pengaturan", subcommand: "lihat" });
  await handleSlashCommand(personal);
  assert.deepEqual(personal.state.deferArgs, { flags: MessageFlags.Ephemeral });

  const publicOne = fake({ commandName: "live" });
  await handleSlashCommand(publicOne);
  assert.equal(publicOne.state.deferArgs, undefined, "perilaku lama: deferReply() polos");
});

test("/oshi - tambah, lihat, hapus", async () => {
  recordLiveCompleted("jkt48_slashoshi", "Slashoshi JKT48");
  const user = "slash-oshi-user";
  const add = fake({ commandName: "oshi", subcommand: "tambah", strings: { member: "jkt48_slashoshi" }, userId: user });
  await handleSlashCommand(add);
  assert.match(contentOf(add), /sekarang oshi kamu/);
  assert.deepEqual(getUserPrefs(user).oshis, ["jkt48_slashoshi"]);

  const view = fake({ commandName: "oshi", subcommand: "lihat", userId: user });
  await handleSlashCommand(view);
  assert.match(contentOf(view), /Slashoshi JKT48/);

  const remove = fake({ commandName: "oshi", subcommand: "hapus", strings: { member: "jkt48_slashoshi" }, userId: user });
  await handleSlashCommand(remove);
  assert.match(contentOf(remove), /dihapus dari oshi/);
  assert.deepEqual(getUserPrefs(user).oshis, []);
});

test("/pengaturan - notif, jam-tenang, jam-tenang-mati, ringkasan, lihat", async () => {
  const user = "slash-set-user";
  const run = async (subcommand, extra = {}) => {
    const i = fake({ commandName: "pengaturan", subcommand, userId: user, ...extra });
    await handleSlashCommand(i);
    return contentOf(i);
  };
  assert.match(await run("notif", { strings: { cara: "dm" } }), /lewat \*\*DM\*\*/);
  assert.equal(getUserPrefs(user).delivery, "dm");
  assert.match(await run("jam-tenang", { integers: { mulai: 23, selesai: 6 } }), /23\.00-06\.00 WIB/);
  assert.equal(getUserPrefs(user).quietStart, 23);
  assert.match(await run("jam-tenang", { integers: { mulai: 8, selesai: 8 } }), /jangan sama/);
  assert.match(await run("ringkasan", { strings: { status: "mati" } }), /dimatiin/);
  assert.equal(getUserPrefs(user).digestOff, true);
  assert.match(await run("lihat"), /Pengaturan notif kamu/);
  assert.match(await run("jam-tenang-mati"), /dimatiin/);
  assert.equal(getUserPrefs(user).quietStart, null);
});

test("/kelewat - dengan dan tanpa opsi jam", async () => {
  const withHours = fake({ commandName: "kelewat", integers: { jam: 3 }, userId: "slash-k1" });
  await handleSlashCommand(withHours);
  assert.match(contentOf(withHours), /Yang kelewat 3 jam terakhir/);
  const plain = fake({ commandName: "kelewat", userId: "slash-k2" });
  await handleSlashCommand(plain);
  assert.match(contentOf(plain), /Yang kelewat 12 jam terakhir/);
});

test("/tebak - lihat, papan, durasi (member live), berikutnya", async () => {
  activeLives.set("jkt48_slashtebak", {
    name: "Slashtebak JKT48",
    username: "jkt48_slashtebak",
    slug: "s",
    liveAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    viewCount: 1,
  });
  recordLiveCompleted("jkt48_slashnext", "Slashnext JKT48");
  try {
    const overview = fake({ commandName: "tebak", subcommand: "lihat", userId: "slash-t1" });
    await handleSlashCommand(overview);
    assert.match(contentOf(overview), /Tebak-tebakan/);

    const board = fake({ commandName: "tebak", subcommand: "papan", userId: "slash-t1" });
    await handleSlashCommand(board);
    assert.match(contentOf(board), /Papan skor/);

    const duration = fake({
      commandName: "tebak",
      subcommand: "durasi",
      strings: { member: "jkt48_slashtebak" },
      integers: { menit: 75 },
      userId: "slash-t1",
    });
    await handleSlashCommand(duration);
    assert.match(contentOf(duration), /Tebakan kamu masuk.*1j 15m/s);

    const next = fake({ commandName: "tebak", subcommand: "berikutnya", strings: { member: "jkt48_slashnext" }, userId: "slash-t1" });
    await handleSlashCommand(next);
    assert.match(contentOf(next), /yang live berikutnya = \*\*Slashnext JKT48\*\*/);
  } finally {
    activeLives.delete("jkt48_slashtebak");
    require("../src/storage/guessGame").discardDurationRound("jkt48_slashtebak");
    require("../src/storage/guessGame").resolveNextRound("jkt48_slashnext");
  }
});

test("/wrapped dan /grafik-penonton - jawaban sopan saat belum ada data / member tak dikenal, tidak error", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ data: null }) });
  try {
    const wrapped = fake({ commandName: "wrapped" });
    await handleSlashCommand(wrapped);
    assert.match(String(wrapped.state.replies.at(-1).content), /belum ada sesi live|Wrapped/);

    const chart = fake({ commandName: "grafik-penonton", strings: { member: "zzznamangawur" } });
    await handleSlashCommand(chart);
    assert.match(contentOf(chart), /zzznamangawur/);
  } finally {
    global.fetch = originalFetch;
  }
});
