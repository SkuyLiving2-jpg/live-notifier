require("./helpers/setupTestEnv");
// PRIORITY_PING_USER_ID harus di-set SETELAH setupTestEnv (yang mengosongkannya) dan
// SEBELUM config.js ke-load lewat require router di bawah.
process.env.PRIORITY_PING_USER_ID = "owner-role-test";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { buildChatReply } = require("../src/chat/router");

const ids = (reply) => reply.components.flatMap((row) => row.toJSON().components.map((c) => c.custom_id));
const ask = (text, authorId) => buildChatReply(text, { isBotChannel: true, channelId: "c-role", authorId });

test("owner: 'pasang panel role' -> panel PERMANEN (tombol buka aja, tanpa Tutup)", async () => {
  const reply = await ask("cok pasang panel role", "owner-role-test");
  assert.match(reply.content, /Notif live per member/);
  assert.deepEqual(ids(reply), ["role_flow:all", "role_flow:open"]);
});

test("bukan owner: 'pasang panel role' ditolak, gak ada panel", async () => {
  const reply = await ask("cok pasang panel role", "bukan-owner");
  assert.equal(typeof reply, "string");
  assert.match(reply, /cuma owner yang boleh masang panel role/);
});

test("siapa aja: 'role' / 'atur role' / 'role notif' -> panel sementara dengan tombol Tutup", async () => {
  for (const text of ["role", "cok role", "atur role", "role notif", "cok ambil role notif?"]) {
    const reply = await ask(text, "user-biasa");
    assert.deepEqual(ids(reply), ["role_flow:all", "role_flow:open", "reply_close"], text);
  }
});

test("kalimat lain yang kebetulan ada kata 'role' TIDAK dibajak jadi panel", async () => {
  const reply = await ask("cok role apa yang paling keren", "user-biasa");
  assert.doesNotMatch(JSON.stringify(reply), /role_flow:open/);
});

test("owner: 'tambah role <nama> @Role' / 'daftar role' / 'hapus role <nama>' jalan lewat ketikan; bukan owner ditolak", async () => {
  const { recordLiveCompleted } = require("../src/storage/liveCount");
  const { getRoleIdFor } = require("../src/storage/memberRoles");
  recordLiveCompleted("jkt48_routerrole", "Routerrole JKT48");

  assert.match(await ask("cok tambah role routerrole <@&123456789012345678>", "bukan-owner"), /cuma owner/);
  assert.equal(getRoleIdFor("jkt48_routerrole"), null);

  assert.match(await ask("cok tambah role routerrole <@&123456789012345678>", "owner-role-test"), /didaftarin buat \*\*Routerrole\*\*/);
  assert.equal(getRoleIdFor("jkt48_routerrole"), "123456789012345678");

  assert.match(await ask("cok daftar role", "user-biasa"), /Routerrole -> <@&123456789012345678>/);
  assert.match(await ask("cok hapus role routerrole", "owner-role-test"), /dilepas dari daftar role/);
  assert.equal(getRoleIdFor("jkt48_routerrole"), null);
});

test("'notif live semua' (dan variasinya) di channel MANAPUN tanpa 'cok' -> pertanyaan 'Yakin?' dengan tombol Ya/Tidak buat orang itu", async () => {
  for (const text of [
    "notif live semua",
    "Notif Live Semua",
    "notif semua",
    "notifikasi live semua member",
    "cok notif live semua",
    "tolong notif live semua?",
  ]) {
    const reply = await buildChatReply(text, { isBotChannel: false, channelId: "c-biasa", authorId: "user-x" });
    assert.match(reply.content, /Yakin mau dapet notif live \*\*SEMUA\*\* member/, text);
    assert.deepEqual(ids(reply), ["role_flow:confirmyes:user-x", "role_flow:confirmno:user-x"], text);
  }
});

test("kalimat lain yang cuma MENGANDUNG 'notif live semua' TIDAK dibajak jadi konfirmasi", async () => {
  for (const text of ["gimana caranya notif live semua member itu ya", "aku mau notif live semua tapi bingung"]) {
    const reply = await buildChatReply(text, { isBotChannel: false, channelId: "c-biasa", authorId: "user-x" });
    assert.doesNotMatch(JSON.stringify(reply), /confirmyes/, text);
  }
});
