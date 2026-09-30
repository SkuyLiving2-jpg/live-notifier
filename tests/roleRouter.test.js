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
  assert.deepEqual(ids(reply), ["role_flow:open"]);
});

test("bukan owner: 'pasang panel role' ditolak, gak ada panel", async () => {
  const reply = await ask("cok pasang panel role", "bukan-owner");
  assert.equal(typeof reply, "string");
  assert.match(reply, /cuma owner yang boleh masang panel role/);
});

test("siapa aja: 'role' / 'atur role' / 'role notif' -> panel sementara dengan tombol Tutup", async () => {
  for (const text of ["role", "cok role", "atur role", "role notif", "cok ambil role notif?"]) {
    const reply = await ask(text, "user-biasa");
    assert.deepEqual(ids(reply), ["role_flow:open", "reply_close"], text);
  }
});

test("kalimat lain yang kebetulan ada kata 'role' TIDAK dibajak jadi panel", async () => {
  const reply = await ask("cok role apa yang paling keren", "user-biasa");
  assert.doesNotMatch(JSON.stringify(reply), /role_flow:open/);
});
