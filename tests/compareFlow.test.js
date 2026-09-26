require("./helpers/setupTestEnv");

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { recordLiveCompleted } = require("../src/storage/liveCount");
const { replyStartComparePick, handleComparePickButton, handleCompareModalSubmit, handleCompareSelect } = require("../src/chat/compareFlow");

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
test("replyStartComparePick - teks ngajak cari member A dulu, satu tombol cari + satu tombol tutup", () => {
  const reply = replyStartComparePick();
  assert.match(reply.content, /cari member a/i);
  const customIds = reply.components[0].components.map((b) => b.data.custom_id);
  assert.deepEqual(customIds, ["compare_pick:searchA", "compare_pick:close"]);
});

test("handleComparePickButton - action 'close' -> deferUpdate + message.delete (deleteInteractionMessage), BUKAN update biasa", async () => {
  const interaction = fakeInteraction({ customId: "compare_pick:close" });
  await handleComparePickButton(interaction);
  assert.equal(interaction.deferUpdateCalls.length, 1);
  assert.deepEqual(interaction.deletedMessageIds, ["fake-compare-msg"]);
  assert.equal(interaction.updates.length, 0);
});

test("handleComparePickButton - action 'searchA' -> munculin modal compare_modal:A", async () => {
  const interaction = fakeInteraction({ customId: "compare_pick:searchA" });
  await handleComparePickButton(interaction);
  assert.equal(interaction.modals.length, 1);
  assert.equal(interaction.modals[0].data.custom_id, "compare_modal:A");
});

test("handleComparePickButton - action 'searchB:<usernameA>' -> munculin modal compare_modal:B:<usernameA> (bawa usernameA)", async () => {
  const interaction = fakeInteraction({ customId: "compare_pick:searchB:jkt48_nala" });
  await handleComparePickButton(interaction);
  assert.equal(interaction.modals[0].data.custom_id, "compare_modal:B:jkt48_nala");
});

test("handleCompareModalSubmit - step A, nama yang gak ada di IDN sama sekali -> 'gak nemu member JKT48', tombol cari lagi + Tutup nempel", async () => {
  await withFakeIdn({}, async () => {
    const interaction = fakeInteraction({ customId: "compare_modal:A", fieldValue: "member-yang-gak-ada" });
    await handleCompareModalSubmit(interaction);

    assert.equal(interaction.updates.length, 1);
    assert.match(interaction.updates[0].content, /gak nemu member JKT48 bernama "member-yang-gak-ada"/i);
    const customIds = interaction.updates[0].components[0].components.map((b) => b.data.custom_id);
    assert.deepEqual(customIds, ["compare_pick:searchA", "compare_pick:close"]);
  });
});

// Regresi (dilaporin owner): "Kimmy" beneran member JKT48 tapi belum pernah
// live semenjak bot ini jalan - dulu dibilang "gak ketemu member Kimmy".
test("handleCompareModalSubmit - member JKT48 asli yang BELUM PERNAH live (Kimmy) -> bilang 'belum pernah live', bukan 'gak ketemu'", async () => {
  await withFakeIdn({ jkt48_kimmy: { name: "Kimmy JKT48" } }, async () => {
    const interaction = fakeInteraction({ customId: "compare_modal:A", fieldValue: "Kimmy" });
    await handleCompareModalSubmit(interaction);

    assert.match(interaction.updates[0].content, /\*\*Kimmy JKT48\*\* belum pernah live/);
    assert.doesNotMatch(interaction.updates[0].content, /gak nemu/);
    const customIds = interaction.updates[0].components[0].components.map((b) => b.data.custom_id);
    assert.deepEqual(customIds, ["compare_pick:searchA", "compare_pick:close"]);
  });
});

test("handleCompareModalSubmit - step A, TEPAT 1 match -> langsung lanjut ke prompt cari Member B (gak perlu dropdown buat 1 opsi)", async () => {
  recordLiveCompleted("jkt48_cfsingle", "Cfsingle");
  const interaction = fakeInteraction({ customId: "compare_modal:A", fieldValue: "cfsingle" });
  await handleCompareModalSubmit(interaction);

  assert.equal(interaction.updates.length, 1);
  assert.match(interaction.updates[0].content, /Member A: \*\*Cfsingle\*\* ✅/);
  const customIds = interaction.updates[0].components[0].components.map((b) => b.data.custom_id);
  assert.deepEqual(customIds, ["compare_pick:searchB:jkt48_cfsingle", "compare_pick:close"]);
});

test("handleCompareModalSubmit - step A, LEBIH dari 1 match -> dropdown select buat milih, plus tombol tutup di baris terpisah", async () => {
  recordLiveCompleted("jkt48_cfmultapple", "Cfmultapple");
  recordLiveCompleted("jkt48_cfmultbanana", "Cfmultbanana");
  const interaction = fakeInteraction({ customId: "compare_modal:A", fieldValue: "cfmult" });
  await handleCompareModalSubmit(interaction);

  assert.equal(interaction.updates.length, 1);
  const [selectRow, closeRow] = interaction.updates[0].components;
  const select = selectRow.components[0];
  assert.equal(select.data.custom_id, "compare_select:A");
  assert.deepEqual(
    select.options.map((o) => o.data.value),
    ["jkt48_cfmultapple", "jkt48_cfmultbanana"],
  );
  assert.equal(closeRow.components[0].data.custom_id, "compare_pick:close");
});

// Regresi (dicurigai owner): Member B = Member A gak boleh lanjut. Dulu
// dibuang diem-diem dari kandidat dan dilaporin "gak ketemu" - padahal
// jelas ketemu, cuma orangnya sama.
test("handleCompareModalSubmit - step B, query cuma cocok member A sendiri -> pesan 'member yang sama' (BUKAN 'gak ketemu'), tombol cari lagi + Tutup", async () => {
  recordLiveCompleted("jkt48_cfexcl", "Cfexcl");
  const interaction = fakeInteraction({ customId: "compare_modal:B:jkt48_cfexcl", fieldValue: "cfexcl" });
  await handleCompareModalSubmit(interaction);

  assert.match(interaction.updates[0].content, /member yang sama, gak bisa dibandingin sama diri sendiri/);
  assert.doesNotMatch(interaction.updates[0].content, /gak nemu|gak ketemu/);
  assert.equal(interaction.updates[0].embeds, undefined, "gak boleh sampai nampilin perbandingan");
  const customIds = interaction.updates[0].components[0].components.map((b) => b.data.custom_id);
  assert.deepEqual(customIds, ["compare_pick:searchB:jkt48_cfexcl", "compare_pick:close"]);
});

test("handleCompareModalSubmit - step B, query cocok A DAN member lain -> A dibuang dari kandidat, sisanya lanjut", async () => {
  recordLiveCompleted("jkt48_cfpairone", "Cfpairone");
  recordLiveCompleted("jkt48_cfpairtwo", "Cfpairtwo");

  await withFakeIdn({}, async () => {
    const interaction = fakeInteraction({ customId: "compare_modal:B:jkt48_cfpairone", fieldValue: "cfpair" });
    await handleCompareModalSubmit(interaction);

    // sisa 1 kandidat (Cfpairtwo) -> langsung ke hasil perbandingan
    assert.equal(interaction.updates[0].content, "⚔️ **Cfpairone** dan **Cfpairtwo**");
  });
});

test("handleCompareModalSubmit - step B, member JKT48 yang belum pernah live juga dijelasin 'belum pernah live'", async () => {
  recordLiveCompleted("jkt48_cfneverpair", "Cfneverpair");
  await withFakeIdn({ jkt48_kimmy: { name: "Kimmy JKT48" } }, async () => {
    const interaction = fakeInteraction({ customId: "compare_modal:B:jkt48_cfneverpair", fieldValue: "kimmy" });
    await handleCompareModalSubmit(interaction);
    assert.match(interaction.updates[0].content, /\*\*Kimmy JKT48\*\* belum pernah live/);
    const customIds = interaction.updates[0].components[0].components.map((b) => b.data.custom_id);
    assert.deepEqual(customIds, ["compare_pick:searchB:jkt48_cfneverpair", "compare_pick:close"]);
  });
});

test("handleCompareModalSubmit - step B, 1 match -> LANGSUNG tampilin hasil perbandingan lengkap + tombol tutup", async () => {
  recordLiveCompleted("jkt48_cfmodalc", "Cfmodalc");
  recordLiveCompleted("jkt48_cfmodald", "Cfmodald");

  await withFakeIdn({}, async () => {
    const interaction = fakeInteraction({ customId: "compare_modal:B:jkt48_cfmodalc", fieldValue: "cfmodald" });
    await handleCompareModalSubmit(interaction);

    assert.equal(interaction.updates.length, 1);
    const reply = interaction.updates[0];
    assert.equal(reply.content, "⚔️ **Cfmodalc** dan **Cfmodald**");
    assert.equal(reply.embeds.length, 2);
    assert.equal(reply.components.length, 1);
    assert.equal(reply.components[0].components[0].data.custom_id, "compare_pick:close");
  });
});

test("handleCompareSelect - step A -> lanjut prompt Member B (sama kayak jalur 1-match otomatis)", async () => {
  recordLiveCompleted("jkt48_cfselecta", "Cfselecta");
  const interaction = fakeInteraction({ customId: "compare_select:A", values: ["jkt48_cfselecta"] });
  await handleCompareSelect(interaction);

  assert.match(interaction.updates[0].content, /Member A: \*\*Cfselecta\*\* ✅/);
});

test("handleCompareSelect - step B -> tampilin hasil perbandingan lengkap", async () => {
  recordLiveCompleted("jkt48_cfselectb1", "Cfselectb1");
  recordLiveCompleted("jkt48_cfselectb2", "Cfselectb2");

  await withFakeIdn({}, async () => {
    const interaction = fakeInteraction({ customId: "compare_select:B:jkt48_cfselectb1", values: ["jkt48_cfselectb2"] });
    await handleCompareSelect(interaction);

    const reply = interaction.updates[0];
    assert.equal(reply.content, "⚔️ **Cfselectb1** dan **Cfselectb2**");
    assert.equal(reply.embeds.length, 2);
    assert.equal(reply.components[0].components[0].data.custom_id, "compare_pick:close");
  });
});

test("handleCompareSelect - step B yang (entah gimana) milih member SAMA kayak A -> ditolak, gak nampilin perbandingan", async () => {
  recordLiveCompleted("jkt48_cfselfsel", "Cfselfsel");
  const interaction = fakeInteraction({ customId: "compare_select:B:jkt48_cfselfsel", values: ["jkt48_cfselfsel"] });
  await handleCompareSelect(interaction);

  assert.match(interaction.updates[0].content, /gak bisa dibandingin sama diri sendiri/);
  assert.equal(interaction.updates[0].embeds, undefined);
});
