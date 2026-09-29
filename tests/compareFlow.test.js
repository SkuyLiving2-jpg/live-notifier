require("./helpers/setupTestEnv");

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { recordLiveCompleted } = require("../src/storage/liveCount");
const {
  replyStartComparePick,
  handleComparePickButton,
  handleCompareModalSubmit,
  handleCompareSelect,
  handleCompareCountSelect,
} = require("../src/chat/compareFlow");

// Fake discord.js interaction - sama pola kayak tests/menu.test.js/tests/replies.test.js's
// fakeInteraction, compareFlow.js cuma pernah nyentuh .customId/.channelId/
// .user.id/.values/.update()/.deferUpdate()/.message.delete()/.showModal()/
// .fields.getTextInputValue(), jadi gak butuh library mocking discord.js beneran.
function fakeInteraction({ customId, channelId = "c-compare", authorId = "u-compare", fieldValue = "", values = [] } = {}) {
  const updates = [];
  const modals = [];
  const deferUpdateCalls = [];
  const deletedMessageIds = [];
  return {
    customId,
    channelId,
    user: { id: authorId },
    values,
    fields: { getTextInputValue: () => fieldValue },
    message: { id: "fake-compare-msg", delete: async () => deletedMessageIds.push("fake-compare-msg") },
    update: async (payload) => updates.push(payload),
    deferUpdate: async () => deferUpdateCalls.push(true),
    showModal: async (modal) => modals.push(modal),
    updates,
    modals,
    deferUpdateCalls,
    deletedMessageIds,
  };
}

// Mock fetch ala IDN (bentuk ASLI respons-nya): username di `profiles` balikin
// profil, sisanya error "User Not found". Test unit gak boleh nembak IDN beneran.
async function withFakeIdn(profiles, fn) {
  const original = global.fetch;
  global.fetch = async (url, options) => {
    const { variables } = JSON.parse(options.body);
    const profile = profiles[variables.username];
    if (!profile) return { ok: true, json: async () => ({ errors: [{ message: "IDNAccount: User Not found" }], data: null }) };
    return { ok: true, json: async () => ({ data: { getPublicProfileByUsername: { username: variables.username, ...profile } } }) };
  };
  try {
    await fn();
  } finally {
    global.fetch = original;
  }
}

// Data dites ini SEMUA numpang di satu file test yang sama (gak ada
// "fresh"-reload per test kayak tests/liveCount.test.js) - jadi tiap test di
// bawah dikasih nama member yang beneran BEDA (bukan cuma beda akhiran dari
// prefix yang sama - pencocokan nama itu fuzzy-awalan, query "compareflow"
// dulu nyangkut ke SEMUA member yang dicatet test LAIN).
const ids = (row) => row.components.map((c) => c.data.custom_id);

test("replyStartComparePick - nanya JUMLAH member dulu: dropdown 2 sampai 5 + Tutup di baris terpisah", () => {
  const reply = replyStartComparePick();
  assert.match(reply.content, /berapa member/i);
  const [selectRow, closeRow] = reply.components;
  const select = selectRow.components[0];
  assert.equal(select.data.custom_id, "compare_count");
  assert.deepEqual(
    select.options.map((o) => o.data.value),
    ["2", "3", "4", "5"],
  );
  assert.deepEqual(ids(closeRow), ["compare_pick:close"]);
});

test("handleCompareCountSelect - pilih jumlah -> prompt cari Member 1 dari N (tombol cari + Tutup)", async () => {
  const interaction = fakeInteraction({ customId: "compare_count", values: ["4"] });
  await handleCompareCountSelect(interaction);
  const reply = interaction.updates[0];
  assert.match(reply.content, /bandingin 4 member/);
  assert.match(reply.content, /Member 1 dari 4/);
  assert.deepEqual(ids(reply.components[0]), ["compare_pick:search:4:", "compare_pick:close"]);
});

test("handleCompareCountSelect - nilai di luar 2..5 dijepit (gak bisa 1 atau 9)", async () => {
  const tooMany = fakeInteraction({ customId: "compare_count", values: ["9"] });
  await handleCompareCountSelect(tooMany);
  assert.match(tooMany.updates[0].content, /bandingin 5 member/);
  const tooFew = fakeInteraction({ customId: "compare_count", values: ["1"] });
  await handleCompareCountSelect(tooFew);
  assert.match(tooFew.updates[0].content, /bandingin 2 member/);
});

test("handleComparePickButton - close -> deferUpdate + message.delete, BUKAN update biasa", async () => {
  const interaction = fakeInteraction({ customId: "compare_pick:close" });
  await handleComparePickButton(interaction);
  assert.equal(interaction.deferUpdateCalls.length, 1);
  assert.deepEqual(interaction.deletedMessageIds, ["fake-compare-msg"]);
  assert.equal(interaction.updates.length, 0);
});

test("handleComparePickButton - search:<n>:<daftar> -> modal bawa n dan daftar yang udah dipilih, judul sesuai slot", async () => {
  const interaction = fakeInteraction({ customId: "compare_pick:search:4:nala,levi" });
  await handleComparePickButton(interaction);
  assert.equal(interaction.modals[0].data.custom_id, "compare_modal:4:nala,levi");
  assert.equal(interaction.modals[0].data.title, "Cari Member 3");
});

test("handleComparePickButton - customId LAMA (searchA / searchB:<u>) tetep jalan sebagai perbandingan 2 member", async () => {
  const a = fakeInteraction({ customId: "compare_pick:searchA" });
  await handleComparePickButton(a);
  assert.equal(a.modals[0].data.custom_id, "compare_modal:2:");
  const b = fakeInteraction({ customId: "compare_pick:searchB:jkt48_nala" });
  await handleComparePickButton(b);
  assert.equal(b.modals[0].data.custom_id, "compare_modal:2:nala");
});

test("handleCompareModalSubmit - nama gak ada di IDN -> 'gak nemu', tombol cari lagi (slot sama) + Tutup", async () => {
  await withFakeIdn({}, async () => {
    const interaction = fakeInteraction({ customId: "compare_modal:3:", fieldValue: "member-yang-gak-ada" });
    await handleCompareModalSubmit(interaction);
    assert.match(interaction.updates[0].content, /gak nemu member JKT48 bernama "member-yang-gak-ada"/i);
    assert.deepEqual(ids(interaction.updates[0].components[0]), ["compare_pick:search:3:", "compare_pick:close"]);
  });
});

test("handleCompareModalSubmit - member JKT48 asli yang BELUM PERNAH live (Kimmy) -> 'belum pernah live', bukan 'gak ketemu'", async () => {
  await withFakeIdn({ jkt48_kimmy: { name: "Kimmy JKT48" } }, async () => {
    const interaction = fakeInteraction({ customId: "compare_modal:2:", fieldValue: "Kimmy" });
    await handleCompareModalSubmit(interaction);
    assert.match(interaction.updates[0].content, /\*\*Kimmy JKT48\*\* belum pernah live/);
    assert.doesNotMatch(interaction.updates[0].content, /gak nemu/);
    assert.deepEqual(ids(interaction.updates[0].components[0]), ["compare_pick:search:2:", "compare_pick:close"]);
  });
});

test("handleCompareModalSubmit - 1 match, target 3 -> lanjut ke Member 2 dari 3 dengan daftar terkumpul (gak perlu dropdown)", async () => {
  recordLiveCompleted("jkt48_cfsingle", "Cfsingle");
  const interaction = fakeInteraction({ customId: "compare_modal:3:", fieldValue: "cfsingle" });
  await handleCompareModalSubmit(interaction);
  const reply = interaction.updates[0];
  assert.match(reply.content, /Udah dipilih: \*\*Cfsingle\*\* ✅/);
  assert.match(reply.content, /Member 2 dari 3/);
  assert.deepEqual(ids(reply.components[0]), ["compare_pick:search:3:cfsingle", "compare_pick:close"]);
});

test("handleCompareModalSubmit - >1 match -> dropdown yang bawa n + daftar, Tutup di baris terpisah", async () => {
  recordLiveCompleted("jkt48_cfmultapple", "Cfmultapple");
  recordLiveCompleted("jkt48_cfmultbanana", "Cfmultbanana");
  const interaction = fakeInteraction({ customId: "compare_modal:4:", fieldValue: "cfmult" });
  await handleCompareModalSubmit(interaction);
  const [selectRow, closeRow] = interaction.updates[0].components;
  const select = selectRow.components[0];
  assert.equal(select.data.custom_id, "compare_select:4:");
  assert.deepEqual(
    select.options.map((o) => o.data.value),
    ["jkt48_cfmultapple", "jkt48_cfmultbanana"],
  );
  assert.deepEqual(ids(closeRow), ["compare_pick:close"]);
});

test("handleCompareModalSubmit - query cuma cocok member yang UDAH dipilih -> 'member yang sama' (bukan 'gak ketemu'), gak nampilin perbandingan", async () => {
  recordLiveCompleted("jkt48_cfexcl", "Cfexcl");
  const interaction = fakeInteraction({ customId: "compare_modal:2:cfexcl", fieldValue: "cfexcl" });
  await handleCompareModalSubmit(interaction);
  assert.match(interaction.updates[0].content, /member yang sama, gak bisa dibandingin sama diri sendiri/);
  assert.doesNotMatch(interaction.updates[0].content, /gak nemu|gak ketemu/);
  assert.equal(interaction.updates[0].embeds, undefined);
  assert.deepEqual(ids(interaction.updates[0].components[0]), ["compare_pick:search:2:cfexcl", "compare_pick:close"]);
});

test("handleCompareModalSubmit - target 3+, member yang udah dipilih ditolak dengan pesan yang sesuai (bukan 'dua member')", async () => {
  recordLiveCompleted("jkt48_cfdup1", "Cfdup1");
  const interaction = fakeInteraction({ customId: "compare_modal:3:cfdup1", fieldValue: "cfdup1" });
  await handleCompareModalSubmit(interaction);
  assert.match(interaction.updates[0].content, /"cfdup1" itu \*\*Cfdup1\*\* yang udah kamu pilih tadi/);
  assert.doesNotMatch(interaction.updates[0].content, /dua member/);
});

test("handleCompareModalSubmit - query cocok yang udah dipilih DAN member lain -> yang udah dipilih dibuang, sisanya lanjut", async () => {
  recordLiveCompleted("jkt48_cfpairone", "Cfpairone");
  recordLiveCompleted("jkt48_cfpairtwo", "Cfpairtwo");
  await withFakeIdn({}, async () => {
    const interaction = fakeInteraction({ customId: "compare_modal:2:cfpairone", fieldValue: "cfpair" });
    await handleCompareModalSubmit(interaction);
    assert.equal(interaction.updates[0].content, "⚔️ **Cfpairone** dan **Cfpairtwo**");
  });
});

test("handleCompareModalSubmit - member terakhir (2 dari 2) -> LANGSUNG hasil perbandingan + Tutup", async () => {
  recordLiveCompleted("jkt48_cfmodalc", "Cfmodalc");
  recordLiveCompleted("jkt48_cfmodald", "Cfmodald");
  await withFakeIdn({}, async () => {
    const interaction = fakeInteraction({ customId: "compare_modal:2:cfmodalc", fieldValue: "cfmodald" });
    await handleCompareModalSubmit(interaction);
    const reply = interaction.updates[0];
    assert.equal(reply.content, "⚔️ **Cfmodalc** dan **Cfmodald**");
    assert.equal(reply.embeds.length, 2);
    assert.deepEqual(ids(reply.components[0]), ["compare_pick:close"]);
  });
});

test("handleCompareSelect - member ke-2 dari 3 -> prompt Member 3 (daftar dibawa)", async () => {
  recordLiveCompleted("jkt48_cfselecta", "Cfselecta");
  recordLiveCompleted("jkt48_cfselectb", "Cfselectb");
  const interaction = fakeInteraction({ customId: "compare_select:3:cfselecta", values: ["jkt48_cfselectb"] });
  await handleCompareSelect(interaction);
  const reply = interaction.updates[0];
  assert.match(reply.content, /Udah dipilih: \*\*Cfselecta\*\*, \*\*Cfselectb\*\* ✅/);
  assert.match(reply.content, /Member 3 dari 3/);
  assert.deepEqual(ids(reply.components[0]), ["compare_pick:search:3:cfselecta,cfselectb", "compare_pick:close"]);
});

test("alur penuh 4 member: hitung mundur slot sampai hasil perbandingan 4 embed + Tutup", async () => {
  const names = ["Flowaa", "Flowbb", "Flowcc", "Flowdd"];
  for (const n of names) recordLiveCompleted(`jkt48_${n.toLowerCase()}`, n);

  await withFakeIdn({}, async () => {
    let interaction = fakeInteraction({ customId: "compare_count", values: ["4"] });
    await handleCompareCountSelect(interaction);
    let reply = interaction.updates[0];

    for (let step = 0; step < 4; step++) {
      const buttonId = ids(reply.components[0])[0];
      const button = fakeInteraction({ customId: buttonId });
      await handleComparePickButton(button);
      const modalId = button.modals[0].data.custom_id;

      interaction = fakeInteraction({ customId: modalId, fieldValue: names[step].toLowerCase() });
      await handleCompareModalSubmit(interaction);
      reply = interaction.updates[0];
    }

    assert.equal(reply.content, "⚔️ **Flowaa**, **Flowbb**, **Flowcc**, dan **Flowdd**");
    assert.equal(reply.embeds.length, 4);
    assert.deepEqual(ids(reply.components[0]), ["compare_pick:close"]);
  });
});

test("alur 5 member: customId di setiap langkah tetap <= 100 karakter (batas Discord), termasuk username panjang", async () => {
  const names = ["longnamealpha", "longnamebravo", "longnamecharlie", "longnamedelta", "longnameecho"];
  for (const n of names) recordLiveCompleted(`jkt48_${n}`, n);
  for (let i = 0; i < 4; i++) {
    const interaction = fakeInteraction({ customId: `compare_modal:5:${names.slice(0, i).join(",")}`, fieldValue: names[i] });
    await handleCompareModalSubmit(interaction);
    for (const row of interaction.updates[0].components) {
      for (const c of row.components) assert.ok(c.data.custom_id.length <= 100, c.data.custom_id);
    }
  }
});

test("handleCompareSelect - customId LAMA (compare_select:B:<u>) tetep nampilin perbandingan 2 member", async () => {
  recordLiveCompleted("jkt48_cfselectb1", "Cfselectb1");
  recordLiveCompleted("jkt48_cfselectb2", "Cfselectb2");
  await withFakeIdn({}, async () => {
    const interaction = fakeInteraction({ customId: "compare_select:B:jkt48_cfselectb1", values: ["jkt48_cfselectb2"] });
    await handleCompareSelect(interaction);
    assert.equal(interaction.updates[0].content, "⚔️ **Cfselectb1** dan **Cfselectb2**");
  });
});

test("handleCompareSelect - milih member yang udah ada di daftar (dropdown lama kepencet ulang) -> ditolak, gak nampilin perbandingan", async () => {
  recordLiveCompleted("jkt48_cfselfsel", "Cfselfsel");
  const interaction = fakeInteraction({ customId: "compare_select:2:cfselfsel", values: ["jkt48_cfselfsel"] });
  await handleCompareSelect(interaction);
  assert.match(interaction.updates[0].content, /gak bisa dibandingin sama diri sendiri/);
  assert.equal(interaction.updates[0].embeds, undefined);
});
