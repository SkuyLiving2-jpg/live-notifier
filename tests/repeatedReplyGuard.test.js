require("./helpers/setupTestEnv");

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { registerExchange, pruneRepeatedExchange, REPEAT_KEEP_LIMIT, REPEAT_WINDOW_MS } = require("../src/chat/repeatedReplyGuard");

// Fake discord.js Message - guard-nya cuma pernah nyentuh .id/.author.id/
// .channel.id/.channel.messages.delete(), jadi gak butuh library mocking
// discord.js beneran. `deleted` nyatet ID yang dihapus lewat channel.messages.delete.
function fakeMessage({ id, channelId, authorId, deleteImpl }) {
  const deleted = [];
  return {
    id,
    author: { id: authorId },
    channel: {
      id: channelId,
      messages: {
        delete: async (messageId) => {
          if (deleteImpl) return deleteImpl(messageId);
          deleted.push(messageId);
        },
      },
    },
    deleted,
  };
}

// Tiap test pake channel+author sendiri (state guard-nya per "channel:author"
// dan numpang di satu proses test) biar gak saling ganggu.
function exchange(ids, opts = {}) {
  return registerExchange({ channelId: "c", authorId: "u", text: "bandingin", now: 1_000_000, ...ids, ...opts });
}

test("REPEAT_KEEP_LIMIT = 2: ketikan ke-1 dan ke-2 dibiarin (gak ada yang dihapus)", () => {
  assert.equal(REPEAT_KEEP_LIMIT, 2);
  const opts = { channelId: "c-limit", authorId: "u-limit" };
  assert.deepEqual(exchange({ userMessageId: "u1", botReplyId: "b1" }, opts), []);
  assert.deepEqual(exchange({ userMessageId: "u2", botReplyId: "b2" }, opts), []);
});

// Ini persis kasus yang dilaporin owner: ngetik "bandingin" 5x, pesan
// ketikannya (dan balesan bot-nya) gak pernah kehapus.
test("ketikan ke-3 (LEBIH DARI 2x) menghapus SEMUA ketikan + balesan bot sebelumnya, ke-4 dst cuma menghapus yang tepat sebelumnya", () => {
  const opts = { channelId: "c-five", authorId: "u-five" };
  assert.deepEqual(exchange({ userMessageId: "u1", botReplyId: "b1" }, opts), []);
  assert.deepEqual(exchange({ userMessageId: "u2", botReplyId: "b2" }, opts), []);
  assert.deepEqual(exchange({ userMessageId: "u3", botReplyId: "b3" }, opts), ["u1", "b1", "u2", "b2"]);
  assert.deepEqual(exchange({ userMessageId: "u4", botReplyId: "b4" }, opts), ["u3", "b3"]);
  assert.deepEqual(exchange({ userMessageId: "u5", botReplyId: "b5" }, opts), ["u4", "b4"]);
});

test("teks BEDA di tengah rangkaian mereset hitungan - ketikan lama TIDAK dihapus (bukan pengulangan)", () => {
  const opts = { channelId: "c-reset", authorId: "u-reset" };
  exchange({ userMessageId: "u1", botReplyId: "b1" }, opts);
  exchange({ userMessageId: "u2", botReplyId: "b2" }, opts);
  // ketikan beda memutus rangkaian
  assert.deepEqual(exchange({ userMessageId: "u3", botReplyId: "b3", text: "cok bantuan" }, opts), []);
  // "bandingin" lagi = mulai hitungan dari 1, bukan lanjutan yang tadi
  assert.deepEqual(exchange({ userMessageId: "u4", botReplyId: "b4" }, opts), []);
  assert.deepEqual(exchange({ userMessageId: "u5", botReplyId: "b5" }, opts), []);
  assert.deepEqual(exchange({ userMessageId: "u6", botReplyId: "b6" }, opts), ["u4", "b4", "u5", "b5"]);
});

test("orang BEDA (atau channel BEDA) yang ngetik teks sama gak saling menghapus - rangkaian dihitung per channel+author", () => {
  const a = { channelId: "c-multi", authorId: "u-a" };
  const b = { channelId: "c-multi", authorId: "u-b" };
  const elsewhere = { channelId: "c-multi-2", authorId: "u-a" };
  exchange({ userMessageId: "a1", botReplyId: "ba1" }, a);
  exchange({ userMessageId: "a2", botReplyId: "ba2" }, a);
  assert.deepEqual(exchange({ userMessageId: "b1", botReplyId: "bb1" }, b), []);
  assert.deepEqual(exchange({ userMessageId: "e1", botReplyId: "be1" }, elsewhere), []);
  // a-3 tetep cuma nghapus punya a
  assert.deepEqual(exchange({ userMessageId: "a3", botReplyId: "ba3" }, a), ["a1", "ba1", "a2", "ba2"]);
});

test("ketikan yang jaraknya lewat REPEAT_WINDOW_MS dari yang sebelumnya dianggep rangkaian BARU (pesan lama gak disentuh)", () => {
  const opts = { channelId: "c-window", authorId: "u-window" };
  exchange({ userMessageId: "u1", botReplyId: "b1", now: 1_000 }, opts);
  exchange({ userMessageId: "u2", botReplyId: "b2", now: 2_000 }, opts);
  // ketikan ke-3 tapi udah lewat window -> hitungan mulai dari 1 lagi
  assert.deepEqual(exchange({ userMessageId: "u3", botReplyId: "b3", now: 2_000 + REPEAT_WINDOW_MS + 1 }, opts), []);
  // pas di batas window masih dianggep rangkaian yang sama
  const edge = { channelId: "c-window-edge", authorId: "u-window-edge" };
  exchange({ userMessageId: "u1", botReplyId: "b1", now: 0 }, edge);
  exchange({ userMessageId: "u2", botReplyId: "b2", now: REPEAT_WINDOW_MS }, edge);
  assert.deepEqual(exchange({ userMessageId: "u3", botReplyId: "b3", now: REPEAT_WINDOW_MS * 2 }, edge), ["u1", "b1", "u2", "b2"]);
});

test("pruneRepeatedExchange - ketikan ke-3 beneran manggil channel.messages.delete buat semua pesan lama (ketikan user + balesan bot)", async () => {
  const ids = { channelId: "c-prune", authorId: "u-prune" };
  const m1 = fakeMessage({ id: "um1", ...ids });
  const m2 = fakeMessage({ id: "um2", ...ids });
  const m3 = fakeMessage({ id: "um3", ...ids });

  await pruneRepeatedExchange(m1, "bandingin", { id: "bot1" });
  await pruneRepeatedExchange(m2, "bandingin", { id: "bot2" });
  assert.deepEqual(m2.deleted, []);
  await pruneRepeatedExchange(m3, "bandingin", { id: "bot3" });
  assert.deepEqual(m3.deleted.sort(), ["bot1", "bot2", "um1", "um2"]);
});

test("pruneRepeatedExchange - gagal hapus (udah kehapus duluan / bot gak punya Manage Messages) gak pernah throw dan gak ngerusak hitungan", async () => {
  const ids = { channelId: "c-fail", authorId: "u-fail" };
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args.join(" "));
  try {
    const failing = (code) => async () => {
      const error = new Error("simulasi");
      error.code = code;
      throw error;
    };
    await pruneRepeatedExchange(fakeMessage({ id: "f1", ...ids }), "ulang", { id: "fb1" });
    await pruneRepeatedExchange(fakeMessage({ id: "f2", ...ids }), "ulang", { id: "fb2" });
    // 10008 = Unknown Message (udah dihapus duluan) -> diem-diem aman
    await assert.doesNotReject(pruneRepeatedExchange(fakeMessage({ id: "f3", ...ids, deleteImpl: failing(10008) }), "ulang", { id: "fb3" }));
    assert.equal(errors.length, 0);

    // 50013 = Missing Permissions -> di-log SEKALI (penjelasan butuh "Manage Messages"), gak ke-spam
    await assert.doesNotReject(pruneRepeatedExchange(fakeMessage({ id: "f4", ...ids, deleteImpl: failing(50013) }), "ulang", { id: "fb4" }));
    await assert.doesNotReject(pruneRepeatedExchange(fakeMessage({ id: "f5", ...ids, deleteImpl: failing(50013) }), "ulang", { id: "fb5" }));
    const permissionLogs = errors.filter((e) => /Manage Messages/.test(e));
    assert.equal(permissionLogs.length, 1);
  } finally {
    console.error = originalError;
  }
});
