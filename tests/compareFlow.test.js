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

// Data dites ini SEMUA numpang di satu file test yang sama (gak ada
// "fresh"-reload per test kayak tests/liveCount.test.js) - jadi tiap test di
// bawah dikasih nama member yang beneran BEDA (bukan cuma beda akhiran dari
// prefix yang sama, mis. "compareflowa"/"compareflowb"/"compareflowsingle"
// dulu nyangkut, query "compareflow" ke-match semuanya termasuk yang dicatet
// test LAIN) biar query fragment di satu test gak keceplos nyangkut ke data
// yang dicatet test lain.
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

test("handleCompareModalSubmit - step A, 0 match -> update balik nempelin tombol cari lagi (customId sama, step A)", async () => {
  const interaction = fakeInteraction({ customId: "compare_modal:A", fieldValue: "member-yang-gak-ada" });
  await handleCompareModalSubmit(interaction);

  assert.equal(interaction.updates.length, 1);
  assert.match(interaction.updates[0].content, /gak ketemu member "member-yang-gak-ada"/i);
  const customIds = interaction.updates[0].components[0].components.map((b) => b.data.custom_id);
  assert.deepEqual(customIds, ["compare_pick:searchA", "compare_pick:close"]);
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

test("handleCompareModalSubmit - step B nge-exclude usernameA dari kandidat, walau namanya juga cocok sama query", async () => {
  recordLiveCompleted("jkt48_cfexcl", "Cfexcl");
  const interaction = fakeInteraction({ customId: "compare_modal:B:jkt48_cfexcl", fieldValue: "cfexcl" });
  await handleCompareModalSubmit(interaction);

  assert.match(interaction.updates[0].content, /gak ketemu member "cfexcl" buat Member B/i);
});

test("handleCompareModalSubmit - step B, 1 match -> LANGSUNG tampilin hasil perbandingan lengkap + tombol tutup", async () => {
  recordLiveCompleted("jkt48_cfmodalc", "Cfmodalc");
  recordLiveCompleted("jkt48_cfmodald", "Cfmodald");

  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ data: { getPublicProfileByUsername: null } }) });
  try {
    const interaction = fakeInteraction({ customId: "compare_modal:B:jkt48_cfmodalc", fieldValue: "cfmodald" });
    await handleCompareModalSubmit(interaction);

    assert.equal(interaction.updates.length, 1);
    const reply = interaction.updates[0];
    assert.equal(reply.content, "⚔️ **Cfmodalc** vs **Cfmodald**");
    assert.equal(reply.embeds.length, 2);
    assert.equal(reply.components.length, 1);
    assert.equal(reply.components[0].components[0].data.custom_id, "compare_pick:close");
  } finally {
    global.fetch = originalFetch;
  }
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

  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ data: { getPublicProfileByUsername: null } }) });
  try {
    const interaction = fakeInteraction({ customId: "compare_select:B:jkt48_cfselectb1", values: ["jkt48_cfselectb2"] });
    await handleCompareSelect(interaction);

    const reply = interaction.updates[0];
    assert.equal(reply.content, "⚔️ **Cfselectb1** vs **Cfselectb2**");
    assert.equal(reply.embeds.length, 2);
  } finally {
    global.fetch = originalFetch;
  }
});
