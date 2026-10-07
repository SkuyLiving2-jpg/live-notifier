require("./helpers/setupTestEnv");
process.env.DISCORD_BOT_TOKEN = "token-palsu";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { GatewayIntentBits, Partials } = require("discord.js");
const { createDiscordClient } = require("../src/discordClient");
const { wireDiscordEvents, buildChatReply } = require("../src/chat/router");

test("client Discord: intent DirectMessages dan partial Channel aktif (tanpa itu pesan DM tidak diterima)", () => {
  const client = createDiscordClient();
  assert.ok(client.options.intents.has(GatewayIntentBits.DirectMessages));
  assert.ok(client.options.intents.has(GatewayIntentBits.Guilds), "intent lama tetap ada");
  assert.ok(client.options.intents.has(GatewayIntentBits.MessageContent));
  assert.ok(client.options.partials.includes(Partials.Channel));
  client.destroy();
});

test("buildChatReply isDm - perintah role ditolak sopan; perintah lain (pengaturan, oshi) tetap jalan; di server perilaku role tidak berubah", async () => {
  const dmRole = await buildChatReply("cok role", { isBotChannel: true, isDm: true, authorId: "dm-u", channelId: "dm-c" });
  assert.match(dmRole, /role cuma bisa dipakai di server/);
  const dmNotifAll = await buildChatReply("notif live semua", { isBotChannel: true, isDm: true, authorId: "dm-u", channelId: "dm-c" });
  assert.match(dmNotifAll, /role cuma bisa dipakai di server/);
  const dmSettings = await buildChatReply("pengaturan", { isBotChannel: true, isDm: true, authorId: "dm-u", channelId: "dm-c" });
  assert.match(dmSettings.content, /Pengaturan notif kamu/);

  const guildRole = await buildChatReply("cok role", { isBotChannel: true, authorId: "g-u", channelId: "g-c" });
  assert.doesNotMatch(typeof guildRole === "string" ? guildRole : guildRole.content, /role cuma bisa dipakai di server/);
});

function makeMessage({ content, guildId, channelId, sentLog, deleted }) {
  return {
    author: { bot: false, id: "msg-user" },
    content,
    guildId,
    id: `m-${Math.random()}`,
    channel: { id: channelId, name: "x", messages: { delete: async (id) => deleted.push(id) } },
    reply: async (options) => {
      sentLog.push(options);
      return { id: `b-${Math.random()}` };
    },
  };
}

test("messageCreate - DM dibalas tanpa wake-word, ketikan berulang di DM TIDAK memicu penghapusan; di server tetap memicu", async () => {
  const fake = new EventEmitter();
  fake.login = () => Promise.resolve();
  wireDiscordEvents(fake);
  const handler = fake.listeners("messageCreate")[0];
  const sent = [];
  const deleted = [];
  const originalErr = console.error;
  console.error = () => {};
  try {
    // DM: "pengaturan" tanpa "cok" tetap dijawab; 4x berturut-turut (lewat batas 2) tidak ada penghapusan.
    for (let i = 0; i < 4; i++) await handler(makeMessage({ content: "pengaturan", guildId: null, channelId: "dm-chan", sentLog: sent, deleted }));
    assert.equal(sent.length, 4);
    assert.match(sent[0].content, /Pengaturan notif kamu/);
    assert.equal(deleted.length, 0, "di DM bot tidak boleh mencoba menghapus pesan");

    // Server (channel biasa): tanpa wake-word -> diabaikan.
    const ignored = [];
    await handler(makeMessage({ content: "pengaturan", guildId: "guild-1", channelId: "guild-chan", sentLog: ignored, deleted }));
    assert.equal(ignored.length, 0);

    // Server: ketikan yang sama diulang > 2x tetap memicu penghapusan (perilaku lama tidak berubah).
    const guildSent = [];
    for (let i = 0; i < 3; i++)
      await handler(makeMessage({ content: "cok pengaturan", guildId: "guild-1", channelId: "guild-chan2", sentLog: guildSent, deleted }));
    assert.equal(guildSent.length, 3);
    assert.ok(deleted.length > 0, "di server penghapusan ketikan berulang tetap jalan");
  } finally {
    console.error = originalErr;
  }
});
