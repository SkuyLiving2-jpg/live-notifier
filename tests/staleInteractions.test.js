require("./helpers/setupTestEnv");

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { findInteractionRoute } = require("../src/chat/interactionRoutes");

// Tombol di pesan LAMA atau customId palsu/rusak tidak boleh menimbulkan error: cukup di-acknowledge tanpa mengubah
// pesan. (Dulu "recap_nav:" tanpa aksi jatuh ke TypeError tak sengaja di decodeRecapRange.)

function fakeButton(customId) {
  const log = [];
  const rec = (type) => async () => {
    log.push(type);
  };
  return {
    customId,
    channelId: "c-stale",
    user: { id: "u-stale" },
    isButton: () => true,
    isStringSelectMenu: () => false,
    isModalSubmit: () => false,
    update: rec("update"),
    reply: rec("reply"),
    showModal: rec("showModal"),
    deferUpdate: rec("deferUpdate"),
    message: { id: "m1", content: "x", delete: rec("message.delete") },
    channel: { messages: { delete: rec("channel.messages.delete") } },
    log,
  };
}

async function click(customId) {
  const interaction = fakeButton(customId);
  const route = findInteractionRoute(interaction);
  assert.ok(route, `${customId} harus punya rute`);
  await route.handler(interaction);
  return interaction.log;
}

test("recap_nav rusak/tak dikenal - hanya di-acknowledge (deferUpdate), tidak melempar, pesan tidak diubah", async () => {
  for (const id of [
    "recap_nav:",
    "recap_nav:unknownaction",
    "recap_nav:foo:7:0",
    "recap_nav:next",
    "recap_nav:prev",
    "recap_nav:search",
    "recap_nav:jump",
    "recap_nav:next:",
  ]) {
    assert.deepEqual(await click(id), ["deferUpdate"], id);
  }
});

test("recap_nav yang sah tetap bekerja (perbaikan customId rusak tidak mengganggu yang benar)", async () => {
  assert.deepEqual(await click("recap_nav:next:7:0"), ["update"]);
  assert.deepEqual(await click("recap_nav:prev:7:1"), ["update"]);
  assert.deepEqual(await click("recap_nav:search:7"), ["showModal"]);
  assert.deepEqual(await click("recap_nav:jump:7:0"), ["showModal"]);
  assert.deepEqual(await click("recap_nav:backto:recapmenu"), ["update"]);
  assert.deepEqual(await click("recap_nav:close"), ["deferUpdate", "message.delete"]);
});

test("fallback_menu dengan opsi asing/kosong tidak melempar", async () => {
  for (const id of ["fallback_menu:", "fallback_menu:zzz", "fallback_menu:goto", "fallback_menu:back:abc"]) {
    await assert.doesNotReject(() => click(id), id);
  }
});

test("kunci prototipe di customId ('constructor', '__proto__') diperlakukan sebagai aksi asing, bukan memanggil properti Object", async () => {
  for (const id of [
    "recap_nav:constructor:7:0",
    "recap_nav:__proto__",
    "recap_nav:toString:7:0",
    "fallback_menu:constructor",
    "fallback_menu:__proto__",
  ]) {
    await assert.doesNotReject(() => click(id), id);
  }
  assert.deepEqual(await click("recap_nav:constructor:7:0"), ["deferUpdate"]);
});
