require("./helpers/setupTestEnv");
// Env harus di-set SETELAH setupTestEnv dan SEBELUM config.js ke-load.
process.env.PRIORITY_PING_USER_ID = "owner-panel";
process.env.DISCORD_BOT_TOKEN = "token-palsu";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createDiscordClient } = require("../src/discordClient");
const { buildChatReply } = require("../src/chat/router");
const { saveRolePanelState, loadRolePanelState } = require("../src/storage/rolePanelState");
const { setRoleIdFor } = require("../src/storage/memberRoles");

// Client discord.js asli (gak login), cuma `channels` yang diganti fake.
const client = createDiscordClient();
const sent = [];
const edited = [];
const store = new Map();
let failSend = false;
client.channels = {
  fetch: async (channelId) => ({
    isTextBased: () => true,
    messages: {
      fetch: async (id) => {
        if (!store.has(id)) throw new Error("Unknown Message");
        return { id, edit: async (payload) => edited.push({ id, payload }), delete: async () => store.delete(id) };
      },
    },
    send: async (payload) => {
      if (failSend) throw new Error("Missing Access");
      const id = `m${sent.length + 1}`;
      store.set(id, channelId);
      sent.push({ channelId, id, payload });
      return { id };
    },
  }),
};

const ask = (text, authorId, channelId) => buildChatReply(text, { isBotChannel: true, channelId, authorId });

test("'pasang panel role' (owner) - pertama kali masang di channel tempat diketik; ngetik lagi cuma NGEDIT, gak numpuk", async () => {
  saveRolePanelState({});
  const first = await ask("cok pasang panel role", "owner-panel", "chan-role");
  assert.match(first, /Panel role dipasang/);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].channelId, "chan-role");
  assert.equal(loadRolePanelState().messageId, sent[0].id);

  const again = await ask("cok pasang panel role", "owner-panel", "chan-role");
  assert.match(again, /di-edit, gak dobel/);
  assert.equal(sent.length, 1, "gak ada pesan panel baru");
  assert.equal(edited.length, 1);
});

test("'pasang panel role' - dipindah ke channel lain: panel lama dihapus, yang baru dipasang", async () => {
  const before = sent.length;
  const moved = await ask("cok pasang panel role", "owner-panel", "chan-lain");
  assert.match(moved, /panel lama di channel sebelumnya dihapus/);
  assert.equal(sent.length, before + 1);
  assert.equal(loadRolePanelState().channelId, "chan-lain");
});

test("'pasang panel role' - bukan owner ditolak, panel gak disentuh", async () => {
  const before = { sent: sent.length, edited: edited.length };
  assert.match(await ask("cok pasang panel role", "bukan-owner", "chan-lain"), /cuma owner/);
  assert.deepEqual({ sent: sent.length, edited: edited.length }, before);
});

test("'pasang panel role' - bot gak punya izin kirim di channel -> pesan jelas soal izin, bukan diam", async () => {
  saveRolePanelState({});
  failSend = true;
  try {
    const reply = await ask("cok pasang panel role", "owner-panel", "chan-tanpa-izin");
    assert.match(reply, /gagal masang panel/i);
    assert.match(reply, /Send Messages/);
  } finally {
    failSend = false;
  }
});

test("daftarin role baru -> panel yang udah terpasang di-EDIT otomatis (daftar member ikut update), bukan pesan baru", async () => {
  saveRolePanelState({});
  await ask("cok pasang panel role", "owner-panel", "chan-auto");
  const sentBefore = sent.length;
  const editedBefore = edited.length;

  const { recordLiveCompleted } = require("../src/storage/liveCount");
  recordLiveCompleted("jkt48_autorefresh", "Autorefresh JKT48");
  assert.match(await ask("cok tambah role autorefresh <@&123456789012345678>", "owner-panel", "chan-auto"), /didaftarin buat/);

  assert.equal(sent.length, sentBefore, "gak ada pesan baru");
  assert.equal(edited.length, editedBefore + 1);
  assert.match(edited[edited.length - 1].payload.content, /Autorefresh/);
  setRoleIdFor("jkt48_autorefresh", "");
});
