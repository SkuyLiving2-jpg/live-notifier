require("./helpers/setupTestEnv");

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { deletePreviousReplyIfRepeated, rememberReply } = require("../src/chat/repeatedReplyGuard");

// Fake discord.js Message - deletePreviousReplyIfRepeated/rememberReply cuma
// pernah nyentuh .channel.id/.channel.messages.delete()/.author.id, jadi gak
// butuh library mocking discord.js beneran.
function fakeMessage({ channelId = "c-guard", authorId = "u-guard" } = {}) {
  const deletedIds = [];
  return {
    channel: { id: channelId, messages: { delete: async (id) => deletedIds.push(id) } },
    author: { id: authorId },
    deletedIds,
  };
}

test("deletePreviousReplyIfRepeated - belum pernah ada balesan sebelumnya buat channel+author ini -> gak ada yang dihapus", async () => {
  const message = fakeMessage({ channelId: "c-fresh", authorId: "u-fresh" });
  await deletePreviousReplyIfRepeated(message, "bandingin");
  assert.deepEqual(message.deletedIds, []);
});

test("rememberReply + deletePreviousReplyIfRepeated - teks yang SAMA PERSIS diketik lagi -> balesan bot LAMA dihapus", async () => {
  const first = fakeMessage({ channelId: "c-repeat", authorId: "u-repeat" });
  rememberReply(first, "bandingin", { id: "bot-msg-1" });

  const second = fakeMessage({ channelId: "c-repeat", authorId: "u-repeat" });
  await deletePreviousReplyIfRepeated(second, "bandingin");
  assert.deepEqual(second.deletedIds, ["bot-msg-1"]);
});

test("deletePreviousReplyIfRepeated - teks BEDA dari sebelumnya -> gak dihapus (bukan pengulangan)", async () => {
  const first = fakeMessage({ channelId: "c-diff", authorId: "u-diff" });
  rememberReply(first, "bandingin", { id: "bot-msg-2" });

  const second = fakeMessage({ channelId: "c-diff", authorId: "u-diff" });
  await deletePreviousReplyIfRepeated(second, "cok bantuan");
  assert.deepEqual(second.deletedIds, []);
});

test("deletePreviousReplyIfRepeated - orang BEDA ngetik teks yang sama di channel yang sama -> gak saling kehapus (kunci per author)", async () => {
  const first = fakeMessage({ channelId: "c-multiuser", authorId: "u-a" });
  rememberReply(first, "bandingin", { id: "bot-msg-3" });

  const second = fakeMessage({ channelId: "c-multiuser", authorId: "u-b" });
  await deletePreviousReplyIfRepeated(second, "bandingin");
  assert.deepEqual(second.deletedIds, []);
});

test("rantai berulang: diulang 3x teks yang sama -> tiap ulangan hapus balesan SEBELUMNYA doang (rantai, bukan numpuk)", async () => {
  const channelId = "c-chain";
  const authorId = "u-chain";

  const m1 = fakeMessage({ channelId, authorId });
  rememberReply(m1, "bandingin", { id: "bot-1" });

  const m2 = fakeMessage({ channelId, authorId });
  await deletePreviousReplyIfRepeated(m2, "bandingin");
  assert.deepEqual(m2.deletedIds, ["bot-1"]);
  rememberReply(m2, "bandingin", { id: "bot-2" });

  const m3 = fakeMessage({ channelId, authorId });
  await deletePreviousReplyIfRepeated(m3, "bandingin");
  assert.deepEqual(m3.deletedIds, ["bot-2"]);
  rememberReply(m3, "bandingin", { id: "bot-3" });
});

test("deletePreviousReplyIfRepeated - message.channel.messages.delete() gagal (mis. udah dihapus manual/lewat tombol Tutup) -> gak throw", async () => {
  const first = fakeMessage({ channelId: "c-fail", authorId: "u-fail" });
  rememberReply(first, "bandingin", { id: "bot-msg-gone" });

  const second = fakeMessage({ channelId: "c-fail", authorId: "u-fail" });
  second.channel.messages.delete = async () => {
    throw new Error("Unknown Message (simulasi udah dihapus duluan)");
  };

  await assert.doesNotReject(deletePreviousReplyIfRepeated(second, "bandingin"));
});
