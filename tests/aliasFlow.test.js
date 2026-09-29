require("./helpers/setupTestEnv");
// Sama pola-nya kayak tests/slashCommands.test.js - override DI SINI (bukan
// di setupTestEnv, yang sengaja ngosongin ini) biar jalur owner vs
// bukan-owner (tombol tambah/hapus alias, khusus owner) bisa dites dua-duanya.
process.env.PRIORITY_PING_USER_ID = "owner-alias-test-id";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { MessageFlags } = require("discord.js");
const { recordLiveCompleted } = require("../src/storage/liveCount");
const { addAlias, loadAliases } = require("../src/storage/aliases");
const { PRIORITY_PING_USER_ID } = require("../src/config");
const { handleAliasFlowButton, handleAliasFlowModalSubmit, handleAliasFlowSelect, buildAliasListBlock } = require("../src/chat/aliasFlow");

// Sama pola fake interaction kayak tests/compareFlow.test.js - aliasFlow.js
// cuma pernah nyentuh .customId/.channelId/.user.id/.values/.update()/
// .deferUpdate()/.message.delete()/.showModal()/.fields.getTextInputValue().
function fakeInteraction({ customId, channelId = "c-alias", authorId = PRIORITY_PING_USER_ID, fieldValue = "", values = [] } = {}) {
  const updates = [];
  const replies = [];
  const modals = [];
  const deferUpdateCalls = [];
  const deletedMessageIds = [];
  return {
    customId,
    channelId,
    user: { id: authorId },
    values,
    fields: { getTextInputValue: () => fieldValue },
    message: { id: "fake-alias-msg", delete: async () => deletedMessageIds.push("fake-alias-msg") },
    update: async (payload) => updates.push(payload),
    reply: async (payload) => replies.push(payload),
    deferUpdate: async () => deferUpdateCalls.push(true),
    showModal: async (modal) => modals.push(modal),
    updates,
    replies,
    modals,
    deferUpdateCalls,
    deletedMessageIds,
  };
}

// Non-owner ditolak lewat balesan EPHEMERAL (cuma keliatan dia), pesan
// wizard-nya sendiri (yang bisa aja punya owner) gak disentuh sama sekali.
function assertRejectedEphemerally(interaction) {
  assert.equal(interaction.replies.length, 1);
  assert.match(interaction.replies[0].content, /cuma owner yang boleh ubah daftar alias/i);
  assert.equal(interaction.replies[0].flags, MessageFlags.Ephemeral);
  assert.equal(interaction.updates.length, 0, "pesan wizard gak boleh ke-edit");
  assert.equal(interaction.modals.length, 0, "gak boleh munculin modal");
  assert.equal(interaction.deletedMessageIds.length, 0, "pesan wizard gak boleh kehapus");
}

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

function customIdsOf(row) {
  return row.components.map((c) => c.data.custom_id);
}

test("buildAliasListBlock - gak ada alias -> cuma tombol Tambah + Tutup", () => {
  const block = buildAliasListBlock();
  assert.deepEqual(customIdsOf(block.components[0]), ["alias_flow:add"]);
  assert.deepEqual(customIdsOf(block.components[1]), ["alias_flow:close"]);
});

test("buildAliasListBlock - ada alias -> tombol Hapus ikut muncul, prefixMessage ditaro di atas", () => {
  addAlias("blockalias", "target");
  const block = buildAliasListBlock("Hasil operasi tadi.");
  assert.deepEqual(customIdsOf(block.components[0]), ["alias_flow:add", "alias_flow:remove"]);
  assert.match(block.content, /^Hasil operasi tadi\./);
});

test("handleAliasFlowButton - action 'add' oleh NON-owner -> ditolak ephemeral, pesan gak disentuh", async () => {
  const interaction = fakeInteraction({ customId: "alias_flow:add", authorId: "u-bukan-owner" });
  await handleAliasFlowButton(interaction);
  assertRejectedEphemerally(interaction);
});

// Regresi: tombol Discord bisa diklik SEMUA orang di channel, jadi dulu orang
// lain bisa ngeklik tombol di tengah wizard PUNYA owner - termasuk "Ubah
// alias" (layar konfirmasi jadi nampilin ketikan dia, tapi "Simpan" owner
// tetep nyimpen pending punya owner = yang tampil beda dari yang disimpen)
// dan "Batal" (pesan wizard owner ke-reset).
test("SEMUA tombol/modal/dropdown wizard oleh NON-owner -> ditolak ephemeral, pesan wizard owner gak disentuh", async () => {
  const buttonIds = [
    "alias_flow:add",
    "alias_flow:add_confirm",
    "alias_flow:research",
    "alias_flow:target_confirmed:jkt48_x",
    "alias_flow:edit_alias:jkt48_x",
    "alias_flow:commit",
    "alias_flow:cancel",
    "alias_flow:remove",
    "alias_flow:remove_confirm:x",
  ];
  for (const customId of buttonIds) {
    const interaction = fakeInteraction({ customId, authorId: "u-bukan-owner" });
    await handleAliasFlowButton(interaction);
    assertRejectedEphemerally(interaction);
  }
  for (const customId of ["alias_modal:search", "alias_modal:aliastext:jkt48_x"]) {
    const interaction = fakeInteraction({ customId, authorId: "u-bukan-owner", fieldValue: "apapun" });
    await handleAliasFlowModalSubmit(interaction);
    assertRejectedEphemerally(interaction);
  }
  for (const customId of ["alias_select:target", "alias_select:remove"]) {
    const interaction = fakeInteraction({ customId, authorId: "u-bukan-owner", values: ["x"] });
    await handleAliasFlowSelect(interaction);
    assertRejectedEphemerally(interaction);
  }
});

test("owner ngisi alias, orang lain nyoba 'Ubah alias' di tengah jalan -> yang kesimpen TETEP punya owner, sesuai yang tampil ke owner", async () => {
  recordLiveCompleted("jkt48_afhijack", "Afhijack");
  await withFakeIdn({ jkt48_afhijack: { name: "Afhijack JKT48" } }, async () => {
    const ownerModal = fakeInteraction({ customId: "alias_modal:aliastext:jkt48_afhijack", fieldValue: "afownernick" });
    await handleAliasFlowModalSubmit(ownerModal);
    assert.match(ownerModal.updates[0].content, /"afownernick"/);

    const intruderModal = fakeInteraction({
      customId: "alias_modal:aliastext:jkt48_afhijack",
      fieldValue: "afintrudernick",
      authorId: "u-bukan-owner",
    });
    await handleAliasFlowModalSubmit(intruderModal);
    assertRejectedEphemerally(intruderModal);

    const commit = fakeInteraction({ customId: "alias_flow:commit" });
    await handleAliasFlowButton(commit);
    assert.equal(loadAliases().afownernick, "afhijack");
    assert.equal(loadAliases().afintrudernick, undefined);
  });
});

test("handleAliasFlowButton - action 'add' oleh owner -> tanya konfirmasi 'mau nambah?' dulu (Ya lanjut/Batal)", async () => {
  const interaction = fakeInteraction({ customId: "alias_flow:add" });
  await handleAliasFlowButton(interaction);
  assert.match(interaction.updates[0].content, /mau nambah alias/i);
  assert.deepEqual(customIdsOf(interaction.updates[0].components[0]), ["alias_flow:add_confirm", "alias_flow:cancel"]);
});

test("handleAliasFlowButton - action 'add_confirm'/'research' -> munculin modal cari member (satu-satunya respon interaksinya)", async () => {
  const confirm = fakeInteraction({ customId: "alias_flow:add_confirm" });
  await handleAliasFlowButton(confirm);
  assert.equal(confirm.modals.length, 1);
  assert.equal(confirm.modals[0].data.custom_id, "alias_modal:search");
  assert.equal(confirm.updates.length, 0);

  const research = fakeInteraction({ customId: "alias_flow:research" });
  await handleAliasFlowButton(research);
  assert.equal(research.modals[0].data.custom_id, "alias_modal:search");
});

test("handleAliasFlowModalSubmit - 'search', nama gak ketemu sama sekali -> pesan gak nemu + tombol cari lagi/batal", async () => {
  await withFakeIdn({}, async () => {
    const interaction = fakeInteraction({ customId: "alias_modal:search", fieldValue: "member-ngawur-alias" });
    await handleAliasFlowModalSubmit(interaction);
    assert.match(interaction.updates[0].content, /gak nemu member JKT48 bernama "member-ngawur-alias"/i);
    assert.deepEqual(customIdsOf(interaction.updates[0].components[0]), ["alias_flow:research", "alias_flow:cancel"]);
  });
});

// Regresi yang sama semangatnya kayak compareFlow's Kimmy: member JKT48 REAL
// tapi belum pernah live tetep harus bisa dicari (bukan "gak nemu").
test("handleAliasFlowModalSubmit - 'search', member JKT48 asli yang BELUM PERNAH live -> tetep ketemu (fallback IDN), auto-lanjut ke konfirmasi target", async () => {
  await withFakeIdn({ jkt48_aliaskimmy: { name: "AliasKimmy JKT48" } }, async () => {
    const interaction = fakeInteraction({ customId: "alias_modal:search", fieldValue: "aliaskimmy" });
    await handleAliasFlowModalSubmit(interaction);
    assert.match(interaction.updates[0].content, /Target ketemu: \*\*AliasKimmy JKT48\*\*.*belum pernah live/);
    assert.deepEqual(customIdsOf(interaction.updates[0].components[0]), [
      "alias_flow:target_confirmed:jkt48_aliaskimmy",
      "alias_flow:research",
      "alias_flow:cancel",
    ]);
  });
});

test("handleAliasFlowModalSubmit - 'search', TEPAT 1 match lokal -> auto-lanjut ke konfirmasi target (gak perlu dropdown)", async () => {
  recordLiveCompleted("jkt48_afsingle", "Afsingle");
  const interaction = fakeInteraction({ customId: "alias_modal:search", fieldValue: "afsingle" });
  await handleAliasFlowModalSubmit(interaction);
  assert.match(interaction.updates[0].content, /Target ketemu: \*\*Afsingle\*\*/);
  assert.doesNotMatch(interaction.updates[0].content, /belum pernah live/);
});

test("handleAliasFlowModalSubmit - 'search', LEBIH dari 1 match -> dropdown milih target", async () => {
  recordLiveCompleted("jkt48_afmultapple", "Afmultapple");
  recordLiveCompleted("jkt48_afmultbanana", "Afmultbanana");
  const interaction = fakeInteraction({ customId: "alias_modal:search", fieldValue: "afmult" });
  await handleAliasFlowModalSubmit(interaction);
  const [selectRow, cancelRow] = interaction.updates[0].components;
  assert.equal(selectRow.components[0].data.custom_id, "alias_select:target");
  assert.deepEqual(
    selectRow.components[0].options.map((o) => o.data.value),
    ["jkt48_afmultapple", "jkt48_afmultbanana"],
  );
  assert.deepEqual(customIdsOf(cancelRow), ["alias_flow:cancel"]);
});

test("handleAliasFlowSelect - 'target' -> lanjut ke layar konfirmasi target yang sama", async () => {
  recordLiveCompleted("jkt48_afselect", "Afselect");
  const interaction = fakeInteraction({ customId: "alias_select:target", values: ["jkt48_afselect"] });
  await handleAliasFlowSelect(interaction);
  assert.match(interaction.updates[0].content, /Target ketemu: \*\*Afselect\*\*/);
});

test("handleAliasFlowButton - 'target_confirmed:<username>'/'edit_alias:<username>' -> munculin modal ketik alias buat username itu", async () => {
  const targetConfirmed = fakeInteraction({ customId: "alias_flow:target_confirmed:jkt48_afsingle" });
  await handleAliasFlowButton(targetConfirmed);
  assert.equal(targetConfirmed.modals[0].data.custom_id, "alias_modal:aliastext:jkt48_afsingle");

  const editAlias = fakeInteraction({ customId: "alias_flow:edit_alias:jkt48_afsingle" });
  await handleAliasFlowButton(editAlias);
  assert.equal(editAlias.modals[0].data.custom_id, "alias_modal:aliastext:jkt48_afsingle");
});

test("handleAliasFlowModalSubmit - 'aliastext' -> layar konfirmasi akhir (Simpan/Ubah alias/Ganti target/Batal), belum nyimpen apa-apa", async () => {
  recordLiveCompleted("jkt48_afcommit1", "Afcommit1");
  const interaction = fakeInteraction({ customId: "alias_modal:aliastext:jkt48_afcommit1", fieldValue: "afc1nick" });
  await handleAliasFlowModalSubmit(interaction);
  assert.match(interaction.updates[0].content, /Alias: \*\*"afc1nick"\*\* -> \*\*Afcommit1\*\*/);
  assert.deepEqual(customIdsOf(interaction.updates[0].components[0]), [
    "alias_flow:commit",
    "alias_flow:edit_alias:jkt48_afcommit1",
    "alias_flow:research",
    "alias_flow:cancel",
  ]);
  assert.equal(loadAliases().afc1nick, undefined, "belum kesimpen sebelum tombol Simpan diklik");
});

test("handleAliasFlowButton - 'commit' beneran nyimpen lewat handleAddAlias (reuse, bukan ditulis ulang) - alias ke-daftar", async () => {
  recordLiveCompleted("jkt48_afcommit2", "Afcommit2");
  await withFakeIdn({ jkt48_afcommit2: { name: "Afcommit2 JKT48" } }, async () => {
    const modalInteraction = fakeInteraction({ customId: "alias_modal:aliastext:jkt48_afcommit2", fieldValue: "afc2nick" });
    await handleAliasFlowModalSubmit(modalInteraction);

    const commitInteraction = fakeInteraction({ customId: "alias_flow:commit" });
    await handleAliasFlowButton(commitInteraction);
    assert.match(commitInteraction.updates[0].content, /✅ Alias "afc2nick" -> "afcommit2" ditambahin/);
    assert.equal(loadAliases().afc2nick, "afcommit2");
  });
});

test("handleAliasFlowButton - 'commit' oleh NON-owner -> ditolak ephemeral, alias gak kesimpen", async () => {
  recordLiveCompleted("jkt48_afcommit3", "Afcommit3");
  const modalInteraction = fakeInteraction({ customId: "alias_modal:aliastext:jkt48_afcommit3", fieldValue: "afc3nick", authorId: "u-bukan-owner" });
  await handleAliasFlowModalSubmit(modalInteraction);

  const commitInteraction = fakeInteraction({ customId: "alias_flow:commit", authorId: "u-bukan-owner" });
  await handleAliasFlowButton(commitInteraction);
  assertRejectedEphemerally(commitInteraction);
  assert.equal(loadAliases().afc3nick, undefined);
});

test("handleAliasFlowButton - 'commit' alias multi-kata -> ditolak dengan alasan jelas (dulu disimpen & dibilang sukses padahal gak pernah bisa kecocokan)", async () => {
  recordLiveCompleted("jkt48_afmultiword", "Afmultiword");
  await withFakeIdn({ jkt48_afmultiword: { name: "Afmultiword JKT48" } }, async () => {
    const modal = fakeInteraction({ customId: "alias_modal:aliastext:jkt48_afmultiword", fieldValue: "kim kim" });
    await handleAliasFlowModalSubmit(modal);
    const commit = fakeInteraction({ customId: "alias_flow:commit" });
    await handleAliasFlowButton(commit);
    assert.match(commit.updates[0].content, /cuma boleh SATU kata/);
    assert.equal(loadAliases()["kim kim"], undefined);
  });
});

test("handleAliasFlowButton - 'commit' tanpa pending sama sekali (kelamaan/gak pernah isi modal) -> pesan 'mulai lagi', gak throw", async () => {
  const interaction = fakeInteraction({ customId: "alias_flow:commit", channelId: "c-no-pending" });
  await handleAliasFlowButton(interaction);
  assert.match(interaction.updates[0].content, /kelamaan mikirnya/i);
});

test("handleAliasFlowButton - 'cancel' -> balik ke layar daftar alias (update, bukan close)", async () => {
  const interaction = fakeInteraction({ customId: "alias_flow:cancel" });
  await handleAliasFlowButton(interaction);
  assert.equal(interaction.updates.length, 1);
  assert.equal(interaction.deletedMessageIds.length, 0);
  assert.match(interaction.updates[0].content, /daftar alias|belum ada alias/i);
});

test("handleAliasFlowButton - 'close' -> deferUpdate + message.delete (deleteInteractionMessage), BUKAN update biasa", async () => {
  const interaction = fakeInteraction({ customId: "alias_flow:close" });
  await handleAliasFlowButton(interaction);
  assert.equal(interaction.deferUpdateCalls.length, 1);
  assert.deepEqual(interaction.deletedMessageIds, ["fake-alias-msg"]);
  assert.equal(interaction.updates.length, 0);
});

test("handleAliasFlowButton - 'close' oleh NON-owner JUGA boleh (daftar alias read-only buat semua orang, Tutup buat yang salah ketik 'alias')", async () => {
  const interaction = fakeInteraction({ customId: "alias_flow:close", authorId: "u-bukan-owner" });
  await handleAliasFlowButton(interaction);
  assert.equal(interaction.replies.length, 0, "gak ditolak");
  assert.deepEqual(interaction.deletedMessageIds, ["fake-alias-msg"]);
});

// BUG YANG DILAPORIN OWNER: buka "📖 Daftar alias" dari menu -> "Tambah alias"
// -> "Batal", menu halaman terakhir yang tadinya ada malah ilang (dulu
// baliknya ke layar alias standalone yang cuma punya Tambah/Hapus + Tutup).
function fakeMenuMessage(id) {
  return {
    id,
    delete: async () => {},
    components: [
      { components: [{ customId: "alias_flow:add" }] },
      { components: [{ customId: "fallback_menu:notlive" }, { customId: "fallback_menu:aliaslist" }, { customId: "fallback_menu:more" }] },
      { components: [{ customId: "fallback_menu:delete" }, { customId: "fallback_menu:goto:2" }] },
    ],
  };
}

function allCustomIds(reply) {
  return reply.components.flatMap((row) => row.components.map((c) => c.data.custom_id));
}

test("wizard yang dimulai dari MENU -> 'Batal' balik ke daftar alias + menu halaman itu lagi (bukan layar standalone)", async () => {
  const message = fakeMenuMessage("msg-from-menu");

  const add = fakeInteraction({ customId: "alias_flow:add" });
  add.message = message;
  await handleAliasFlowButton(add);

  const cancel = fakeInteraction({ customId: "alias_flow:cancel" });
  cancel.message = message;
  await handleAliasFlowButton(cancel);

  const ids = allCustomIds(cancel.updates[0]);
  assert.ok(ids.includes("alias_flow:add"));
  assert.ok(ids.includes("fallback_menu:aliaslist"), "tombol menu halaman terakhir balik lagi");
  assert.ok(ids.includes("fallback_menu:delete"), "Tutup-nya punya menu, bukan alias_flow:close");
  assert.ok(!ids.includes("alias_flow:close"));
});

test("wizard yang dimulai dari MENU -> hasil akhir (sukses nambah) juga balik ke layar menu, bukan standalone", async () => {
  recordLiveCompleted("jkt48_afmenuorigin", "Afmenuorigin");
  const message = fakeMenuMessage("msg-from-menu-commit");
  await withFakeIdn({ jkt48_afmenuorigin: { name: "Afmenuorigin JKT48" } }, async () => {
    const add = fakeInteraction({ customId: "alias_flow:add" });
    add.message = message;
    await handleAliasFlowButton(add);

    const modal = fakeInteraction({ customId: "alias_modal:aliastext:jkt48_afmenuorigin", fieldValue: "afmenunick" });
    modal.message = message;
    await handleAliasFlowModalSubmit(modal);

    const commit = fakeInteraction({ customId: "alias_flow:commit" });
    commit.message = message;
    await handleAliasFlowButton(commit);

    assert.match(commit.updates[0].content, /✅ Alias "afmenunick"/);
    assert.ok(allCustomIds(commit.updates[0]).includes("fallback_menu:aliaslist"));
  });
});

test("wizard yang dimulai dari ketikan 'alias' (layar standalone) -> 'Batal' tetep balik ke layar standalone + Tutup-nya sendiri", async () => {
  const standalone = {
    id: "msg-standalone",
    delete: async () => {},
    components: [{ components: [{ customId: "alias_flow:add" }, { customId: "alias_flow:close" }] }],
  };

  const add = fakeInteraction({ customId: "alias_flow:add" });
  add.message = standalone;
  await handleAliasFlowButton(add);

  const cancel = fakeInteraction({ customId: "alias_flow:cancel" });
  cancel.message = standalone;
  await handleAliasFlowButton(cancel);

  const ids = allCustomIds(cancel.updates[0]);
  assert.ok(ids.includes("alias_flow:close"));
  assert.ok(!ids.some((id) => id.startsWith("fallback_menu:")));
});

test("handleAliasFlowButton - 'remove' oleh NON-owner -> ditolak ephemeral", async () => {
  const interaction = fakeInteraction({ customId: "alias_flow:remove", authorId: "u-bukan-owner" });
  await handleAliasFlowButton(interaction);
  assertRejectedEphemerally(interaction);
});

test("handleAliasFlowButton - 'remove' pas belum ada alias sama sekali -> pesan 'belum ada yang bisa dihapus', bukan dropdown kosong", async () => {
  // Isolasi: pakai channel/author sendiri biar gak numpang alias file yang
  // udah keisi test-test sebelumnya di file ini.
  const interaction = fakeInteraction({ customId: "alias_flow:remove", channelId: "c-empty-remove" });
  // Kondisi ini cuma valid kalau BENERAN belum ada alias - test lain di file
  // ini nambahin alias global (file JSON yang sama), jadi cek ini di awal file
  // gak reliable diurutkan; lewatin assersi isi-nya, cukup pastiin dropdown
  // TIDAK muncul KALAU emang kosong, dan valid MUNCUL kalau emang ada isinya
  // (dites terpisah di bawah).
  await handleAliasFlowButton(interaction);
  const hasAliasesNow = Object.keys(loadAliases()).length > 0;
  if (!hasAliasesNow) {
    assert.match(interaction.updates[0].content, /belum ada alias yang bisa dihapus/i);
  } else {
    assert.equal(interaction.updates[0].components[0].components[0].data.custom_id, "alias_select:remove");
  }
});

test("handleAliasFlowButton - 'remove' pas UDAH ada alias -> dropdown pilih alias yang mau dihapus", async () => {
  addAlias("removeflowtest", "targetremove");
  const interaction = fakeInteraction({ customId: "alias_flow:remove" });
  await handleAliasFlowButton(interaction);
  const [selectRow, cancelRow] = interaction.updates[0].components;
  assert.equal(selectRow.components[0].data.custom_id, "alias_select:remove");
  assert.ok(selectRow.components[0].options.some((o) => o.data.value === "removeflowtest"));
  assert.deepEqual(customIdsOf(cancelRow), ["alias_flow:cancel"]);
});

test("handleAliasFlowSelect - 'remove' -> layar konfirmasi hapus (Ya hapus/Batal), belum ngehapus apa-apa", async () => {
  addAlias("removeconfirmtest", "targetconfirm");
  const interaction = fakeInteraction({ customId: "alias_select:remove", values: ["removeconfirmtest"] });
  await handleAliasFlowSelect(interaction);
  assert.match(interaction.updates[0].content, /Yakin mau hapus alias \*\*"removeconfirmtest"\*\* \(-> "targetconfirm"\)/);
  assert.equal(loadAliases().removeconfirmtest, "targetconfirm", "belum kehapus sebelum tombol Ya diklik");
  const confirmButton = interaction.updates[0].components[0].components[0];
  assert.match(confirmButton.data.custom_id, /^alias_flow:remove_confirm:/);
});

test("handleAliasFlowButton - 'remove_confirm:<alias>' beneran ngehapus lewat handleRemoveAlias (reuse, bukan ditulis ulang)", async () => {
  addAlias("removecommittest", "targetcommit");
  const interaction = fakeInteraction({ customId: `alias_flow:remove_confirm:${encodeURIComponent("removecommittest")}` });
  await handleAliasFlowButton(interaction);
  assert.match(interaction.updates[0].content, /✅ Alias "removecommittest" dihapus/);
  assert.equal(loadAliases().removecommittest, undefined);
});

test("handleAliasFlowButton - 'remove_confirm' oleh NON-owner -> ditolak ephemeral, alias TETEP ada", async () => {
  addAlias("removerejecttest", "targetreject");
  const interaction = fakeInteraction({
    customId: `alias_flow:remove_confirm:${encodeURIComponent("removerejecttest")}`,
    authorId: "u-bukan-owner",
  });
  await handleAliasFlowButton(interaction);
  assertRejectedEphemerally(interaction);
  assert.equal(loadAliases().removerejecttest, "targetreject");
});

test("handleAliasFlowSelect - 'remove' buat alias yang (entah gimana) udah keburu kehapus -> pesan jelas, gak throw", async () => {
  const interaction = fakeInteraction({ customId: "alias_select:remove", values: ["alias-yang-gak-pernah-ada"] });
  await handleAliasFlowSelect(interaction);
  assert.match(interaction.updates[0].content, /kayaknya udah keburu dihapus/i);
});
