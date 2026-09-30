require("./helpers/setupTestEnv");
// Env harus di-set SETELAH setupTestEnv dan SEBELUM config.js ke-load lewat router.
process.env.PRIORITY_PING_USER_ID = "owner-welcome";
process.env.ROLE_WELCOME_ENABLED = "true";
process.env.ROLE_CHANNEL_ID = "chan-role";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { wireDiscordEvents } = require("../src/chat/router");

function wire() {
  const handlers = {};
  const client = { once: () => {}, on: (event, fn) => (handlers[event] = fn), login: () => ({ catch: () => {} }) };
  wireDiscordEvents(client);
  return handlers;
}

function fakeMemberAdd({ id, bot = false, sent, fetchError = null }) {
  return {
    id,
    user: { bot },
    guild: {
      channels: {
        fetch: async (channelId) => {
          if (fetchError) throw fetchError;
          assert.equal(channelId, "chan-role");
          return { isTextBased: () => true, send: async (payload) => sent.push(payload) };
        },
      },
    },
  };
}

test("guildMemberAdd - member baru disambut di channel role (tag orangnya, dua tombol pilihan, mention dibatasi ke dia)", async () => {
  const sent = [];
  await wire().guildMemberAdd(fakeMemberAdd({ id: "new-user", sent }));
  assert.equal(sent.length, 1);
  assert.match(sent[0].content, /Selamat datang <@new-user>/);
  assert.deepEqual(sent[0].allowedMentions, { users: ["new-user"] });
  const ids = sent[0].components[0].toJSON().components.map((c) => c.custom_id);
  assert.deepEqual(ids, ["role_flow:all", "role_flow:open", "reply_close"]);
});

test("guildMemberAdd - bot dan owner TIDAK disambut", async () => {
  const sent = [];
  const handler = wire().guildMemberAdd;
  await handler(fakeMemberAdd({ id: "some-bot", bot: true, sent }));
  await handler(fakeMemberAdd({ id: "owner-welcome", sent }));
  assert.equal(sent.length, 0);
});

test("guildMemberAdd - channel role gak bisa diambil (dihapus/izin hilang) -> error dicatat, gak throw", async () => {
  const sent = [];
  await assert.doesNotReject(wire().guildMemberAdd(fakeMemberAdd({ id: "new-user", sent, fetchError: new Error("Unknown Channel") })));
  assert.equal(sent.length, 0);
});
