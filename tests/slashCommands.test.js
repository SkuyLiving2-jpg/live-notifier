require("./helpers/setupTestEnv");
// Sama pola-nya kayak router.test.js/replies.test.js - override DI SINI
// (bukan di setupTestEnv, yang sengaja ngosongin ini) biar jalur owner vs
// bukan-owner buat command khusus-owner (tambah-prioritas dkk) bisa dites
// dua-duanya.
process.env.PRIORITY_PING_USER_ID = "owner-slash-test-id";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { activeLives } = require("../src/storage/activeLives");
const { recordLiveCompleted } = require("../src/storage/liveCount");
const { recordLiveDuration } = require("../src/storage/durationHistory");
const {
  getCommandDefinitionsJSON,
  handleSlashCommand,
  handleSlashAutocomplete,
  getMemberAutocompleteChoices,
  replyCekMember,
} = require("../src/chat/slashCommands");

const OWNER = "owner-slash-test-id";

// Fake ChatInputCommandInteraction - handleSlashCommand cuma pernah nyentuh
// .commandName/.options.getString/.getSubcommand/.channelId/.user.id/
// .deferReply/.editReply/.reply/.replied/.deferred, jadi gak butuh library
// mocking discord.js beneran (sama filosofinya kayak fakeInteraction di
// tests/menu.test.js buat button interaction). `replies` nampung isi balesan
// yang AKHIRNYA keliatan user - lewat editReply() (jalur normal abis
// deferReply) maupun reply() (jalur command gak dikenal / defer gagal).
function fakeCommandInteraction({ commandName, options = {}, subcommand = null, channelId = "c1", authorId = "u1" }) {
  const replies = [];
  const calls = [];
  const interaction = {
    commandName,
    channelId,
    user: { id: authorId },
    replied: false,
    deferred: false,
    options: {
      getString: (name) => (name in options ? options[name] : null),
      getSubcommand: () => subcommand,
    },
    deferReply: async () => {
      calls.push("deferReply");
      interaction.deferred = true;
    },
    editReply: async (payload) => {
      calls.push("editReply");
      replies.push(payload);
    },
    reply: async (payload) => {
      calls.push("reply");
      replies.push(payload);
    },
    replies,
    calls,
  };
  return interaction;
}

function fakeAutocompleteInteraction({ focusedName, focusedValue = "" }) {
  const responses = [];
  return {
    options: { getFocused: () => ({ name: focusedName, value: focusedValue }) },
    respond: async (choices) => {
      responses.push(choices);
    },
    responses,
  };
}

test("getCommandDefinitionsJSON - semua 32 command valid (SlashCommandBuilder#toJSON() gak throw), nama unik", () => {
  const defs = getCommandDefinitionsJSON();
  assert.equal(defs.length, 32);
  const names = defs.map((d) => d.name);
  assert.equal(new Set(names).size, names.length, "gak boleh ada nama command yang dobel");
  assert.ok(names.includes("live"));
  assert.ok(names.includes("rekap"));
  assert.ok(names.includes("grafik"), "fitur grafik/chart harus punya slash command juga");
});

test("handleSlashCommand - command zero-parameter ('/live', '/status') balikin jawaban langsung lewat interaction.reply()", async () => {
  const liveInteraction = fakeCommandInteraction({ commandName: "live" });
  await handleSlashCommand(liveInteraction);
  assert.equal(liveInteraction.replies.length, 1);
  assert.match(liveInteraction.replies[0].content, /nggak ada member JKT48 yang live|live/i);

  const statusInteraction = fakeCommandInteraction({ commandName: "status" });
  await handleSlashCommand(statusInteraction);
  assert.match(statusInteraction.replies[0].content, /Bot jalan normal/);
});

test("handleSlashCommand - '/cek member:<...>' member yang gak dikenal -> replyMemberNotFound", async () => {
  const interaction = fakeCommandInteraction({ commandName: "cek", options: { member: "slashcekgakada" } });
  await handleSlashCommand(interaction);
  assert.match(interaction.replies[0].content, /nggak nemu member "slashcekgakada"/);
});

test("handleSlashCommand - '/cek member:<...>' member yang LAGI LIVE -> replySpecificMember", async () => {
  activeLives.set("jkt48_slashcektest", {
    name: "Slashcektest",
    username: "jkt48_slashcektest",
    slug: "s",
    liveAt: new Date().toISOString(),
  });
  try {
    const interaction = fakeCommandInteraction({ commandName: "cek", options: { member: "slashcektest" } });
    await handleSlashCommand(interaction);
    assert.match(interaction.replies[0].content, /\*\*Slashcektest\*\* lagi live/);
  } finally {
    activeLives.delete("jkt48_slashcektest");
  }
});

test("handleSlashCommand - '/grafik member:<...>' balikin {content, files} dengan PNG attachment", async () => {
  recordLiveDuration("jkt48_slashcharttest", "Slashcharttest", 45 * 60_000);
  const interaction = fakeCommandInteraction({ commandName: "grafik", options: { member: "slashcharttest" } });
  await handleSlashCommand(interaction);
  assert.match(interaction.replies[0].content, /Grafik durasi live \*\*Slashcharttest\*\*/);
  assert.equal(interaction.replies[0].files.length, 1);
});

test("handleSlashCommand - '/bandingin' 2 member -> replyCompareMembers, 3+ member -> replyCompareMembersMulti", async () => {
  recordLiveCompleted("jkt48_slashcmp1", "Slashcmp1");
  recordLiveCompleted("jkt48_slashcmp2", "Slashcmp2");
  recordLiveCompleted("jkt48_slashcmp3", "Slashcmp3");

  const twoMember = fakeCommandInteraction({ commandName: "bandingin", options: { member1: "slashcmp1", member2: "slashcmp2" } });
  await handleSlashCommand(twoMember);
  assert.match(twoMember.replies[0].content, /\*\*Slashcmp1\*\* dan \*\*Slashcmp2\*\*/);

  const threeMember = fakeCommandInteraction({
    commandName: "bandingin",
    options: { member1: "slashcmp1", member2: "slashcmp2", member3: "slashcmp3" },
  });
  await handleSlashCommand(threeMember);
  assert.match(threeMember.replies[0].content, /Slashcmp1.*Slashcmp2.*Slashcmp3/s);
});

test("handleSlashCommand - '/paling-lama' tanpa rentang -> replyLongestLive (hari ini), dengan rentang -> replyLongestLiveForRange", async () => {
  const noRange = fakeCommandInteraction({ commandName: "paling-lama" });
  await handleSlashCommand(noRange);
  assert.match(noRange.replies[0].content, /hari ini/i);

  const withRange = fakeCommandInteraction({ commandName: "paling-lama", options: { rentang: "minggu ini" } });
  await handleSlashCommand(withRange);
  assert.match(withRange.replies[0].content, /minggu ini/i);
});

test("handleSlashCommand - '/rekap' subcommand 'hari-ini'/'menu' dispatch ke fungsi yang bener", async () => {
  const hariIni = fakeCommandInteraction({ commandName: "rekap", subcommand: "hari-ini" });
  await handleSlashCommand(hariIni);
  assert.ok(hariIni.replies[0], "harus ada balesan (string atau object, tergantung ada sesi atau enggak)");

  const menu = fakeCommandInteraction({ commandName: "rekap", subcommand: "menu" });
  await handleSlashCommand(menu);
  assert.match(menu.replies[0].content, /Mau rekap yang mana/);
});

// Test PALING PENTING dari batch ini (owner nanya eksplisit "apakah
// berbahaya") - command khusus-owner HARUS nolak non-owner, PERSIS sama
// pesannya kayak command teks (soalnya sama-sama manggil handleAddPriority
// yang sama, isOwner() checknya nempel DI DALAM fungsi itu, bukan
// diduplikasi di sini - lihat komen panjang di slashCommands.js).
test("handleSlashCommand - '/tambah-prioritas' DITOLAK buat non-owner, DIIZININ buat owner (PRIORITY_PING_USER_ID)", async () => {
  const nonOwner = fakeCommandInteraction({ commandName: "tambah-prioritas", options: { member: "slashprioritas1" }, authorId: "bukan-owner" });
  await handleSlashCommand(nonOwner);
  assert.match(nonOwner.replies[0].content, /cuma owner yang boleh ubah daftar prioritas/);

  const owner = fakeCommandInteraction({ commandName: "tambah-prioritas", options: { member: "slashprioritas2" }, authorId: OWNER });
  await handleSlashCommand(owner);
  assert.match(owner.replies[0].content, /ditambahin ke daftar prioritas/);
});

test("handleSlashCommand - '/tambah-alias' DITOLAK buat non-owner (gate yang sama kayak /tambah-prioritas)", async () => {
  const interaction = fakeCommandInteraction({
    commandName: "tambah-alias",
    options: { alias: "panggilanslash", target: "targetslash" },
    authorId: "bukan-owner",
  });
  await handleSlashCommand(interaction);
  assert.match(interaction.replies[0].content, /cuma owner yang boleh ubah daftar alias/);
});

test("handleSlashCommand - command yang gak dikenal (harusnya gak mungkin lewat Discord beneran) -> pesan fallback, bukan crash", async () => {
  const interaction = fakeCommandInteraction({ commandName: "command-ngawur-gak-terdaftar" });
  await handleSlashCommand(interaction);
  assert.match(interaction.replies[0].content, /belum dikenalin bot/);
});

// Regresi: dulu langsung reply() tanpa defer - handler yang nunggu IDN
// (timeout 2 detik) + latensi Discord bisa lewat batas 3 detik Discord buat
// balesan pertama, user dapet "The application did not respond".
test("handleSlashCommand - deferReply() DULUAN sebelum handler jalan, jawabannya lewat editReply()", async () => {
  const interaction = fakeCommandInteraction({ commandName: "status" });
  await handleSlashCommand(interaction);
  assert.deepEqual(interaction.calls, ["deferReply", "editReply"]);
  assert.match(interaction.replies[0].content, /Bot jalan normal/);
});

test("handleSlashCommand - handler yang throw -> ketangkep, balesan error generik (editReply kalau udah defer, reply kalau defer-nya sendiri gagal)", async () => {
  // Semua fungsi reply di replies/ udah didesain defensif (gak throw buat
  // input aneh - "cek" tanpa member pun cuma jatuh ke replyMemberNotFound
  // biasa), jadi buat mancing jalur catch di sini interaction-nya sendiri
  // yang dibikin rusak (options.getString throw) - simulasi "ada exception
  // gak terduga di suatu tempat", independen dari command/business logic
  // manapun, murni mastiin try/catch-nya beneran nangkep APAPUN.
  const brokenOptions = { getString: () => { throw new Error("simulasi interaction rusak"); }, getSubcommand: () => null }; // prettier-ignore

  const deferred = fakeCommandInteraction({ commandName: "cek" });
  deferred.options = brokenOptions;
  await handleSlashCommand(deferred);
  assert.deepEqual(deferred.calls, ["deferReply", "editReply"], "udah defer -> pesan 'lagi mikir' diganti lewat editReply, bukan reply baru");
  assert.match(deferred.replies[0].content, /ada error pas ngejalanin command ini/);

  const deferFailed = fakeCommandInteraction({ commandName: "cek" });
  deferFailed.deferReply = async () => {
    throw new Error("simulasi defer gagal");
  };
  await handleSlashCommand(deferFailed);
  assert.deepEqual(deferFailed.calls, ["reply"]);
  assert.match(deferFailed.replies[0].content, /ada error pas ngejalanin command ini/);
});

test("replyCekMember - diekspor langsung, sama perilakunya kayak lewat handleSlashCommand", () => {
  const reply = replyCekMember("membergakadareplyCekMember");
  assert.match(reply, /nggak nemu member "membergakadareplyCekMember"/);
});

test("getMemberAutocompleteChoices - gabungin activeLives + liveCount, filter substring case-insensitive, urut alfabetis", () => {
  recordLiveCompleted("jkt48_autoa", "Autoalpha");
  recordLiveCompleted("jkt48_autob", "Autobeta");
  activeLives.set("jkt48_autoc", { name: "Autogamma", username: "jkt48_autoc", slug: "s", liveAt: new Date().toISOString() });
  try {
    const all = getMemberAutocompleteChoices("auto");
    const names = all.map((c) => c.name);
    assert.ok(names.includes("Autoalpha") && names.includes("Autobeta") && names.includes("Autogamma"));
    assert.deepEqual(
      [...names].sort((a, b) => a.localeCompare(b)),
      names,
      "harus keurut alfabetis",
    );

    const filtered = getMemberAutocompleteChoices("ALPHA"); // uppercase - harus tetep match (case-insensitive)
    assert.deepEqual(
      filtered.map((c) => c.value),
      ["jkt48_autoa"],
    );
  } finally {
    activeLives.delete("jkt48_autoc");
  }
});

test("handleSlashAutocomplete - opsi 'member'/'target' dikasih saran, opsi lain (bukan nama-nama itu) dikasih array kosong", async () => {
  recordLiveCompleted("jkt48_autocompletetest", "Autocompletetest");

  const memberOpt = fakeAutocompleteInteraction({ focusedName: "member", focusedValue: "autocompletetest" });
  await handleSlashAutocomplete(memberOpt);
  assert.equal(memberOpt.responses[0].length, 1);
  assert.equal(memberOpt.responses[0][0].value, "jkt48_autocompletetest");

  const otherOpt = fakeAutocompleteInteraction({ focusedName: "rentang", focusedValue: "minggu" });
  await handleSlashAutocomplete(otherOpt);
  assert.deepEqual(otherOpt.responses[0], []);
});

test("handleSlashAutocomplete - interaction.respond() yang throw gak nge-crash (di-log doang)", async () => {
  const interaction = {
    options: { getFocused: () => ({ name: "member", value: "" }) },
    respond: async () => {
      throw new Error("simulasi Discord API telat/gagal");
    },
  };
  await assert.doesNotReject(handleSlashAutocomplete(interaction));
});
