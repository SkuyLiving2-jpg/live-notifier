require("./helpers/setupTestEnv");
// Env harus di-set SETELAH setupTestEnv dan SEBELUM config.js ke-load.
process.env.PRIORITY_PING_USER_ID = "owner-poll";
process.env.DISCORD_BOT_TOKEN = "token-palsu";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createDiscordClient } = require("../src/discordClient");
const { checkLiveMembers, pollHealth, pollFailureThreshold } = require("../src/monitor");

// Client discord.js asli (gak login); cuma `users` yang diganti fake buat nangkep DM.
const client = createDiscordClient();
const dms = [];
client.users = { fetch: async (id) => ({ send: async (payload) => dms.push({ id, content: payload.content }) }) };

function withIdn(handler) {
  const original = global.fetch;
  const originalError = console.error;
  global.fetch = handler;
  console.error = () => {};
  return () => {
    global.fetch = original;
    console.error = originalError;
  };
}

test("polling IDN gagal beruntun -> owner di-DM SEKALI setelah ambang menit (bukan tiap siklus), lalu DM 'pulih' sekali pas berhasil lagi", async () => {
  pollHealth.failures = 0;
  pollHealth.alerted = false;
  dms.length = 0;
  let idnUp = false;
  const restore = withIdn(async () => {
    if (!idnUp) return { ok: false, status: 502, json: async () => ({}) };
    return { ok: true, json: async () => ({ data: { getLivestreams: [] } }) };
  });
  try {
    const threshold = pollFailureThreshold();
    for (let i = 0; i < threshold - 1; i++) await checkLiveMembers();
    assert.equal(dms.length, 0, "belum sampai ambang - jangan berisik");

    await checkLiveMembers(); // siklus ke-N (ambang)
    assert.equal(dms.length, 1);
    assert.equal(dms[0].id, "owner-poll");
    assert.match(dms[0].content, /Polling IDN gagal/);
    assert.match(dms[0].content, /status 502/);

    await checkLiveMembers();
    await checkLiveMembers();
    assert.equal(dms.length, 1, "sudah dikabarin, gak diulang tiap siklus");

    idnUp = true;
    await checkLiveMembers();
    assert.equal(dms.length, 2);
    assert.match(dms[1].content, /pulih/);
    assert.equal(pollHealth.failures, 0);

    await checkLiveMembers();
    assert.equal(dms.length, 2, "pulih cuma dikabarin sekali");
  } finally {
    restore();
  }
});

test("gagal sesekali yang pulih sebelum ambang -> gak ada DM sama sekali", async () => {
  pollHealth.failures = 0;
  pollHealth.alerted = false;
  dms.length = 0;
  let idnUp = false;
  const restore = withIdn(async () =>
    idnUp ? { ok: true, json: async () => ({ data: { getLivestreams: [] } }) } : { ok: false, status: 500, json: async () => ({}) },
  );
  try {
    await checkLiveMembers();
    await checkLiveMembers();
    idnUp = true;
    await checkLiveMembers();
    assert.equal(dms.length, 0);
    assert.equal(pollHealth.failures, 0, "counter di-reset begitu berhasil");
  } finally {
    restore();
  }
});

test("'cok status' jujur: polling IDN gagal beruntun -> peringatan (bukan 'jalan normal'), pulih -> normal lagi; /api/status ikut memuat kondisi polling", async () => {
  const { buildChatReply } = require("../src/chat/router");
  const { pollHealth: shared } = require("../src/pollHealth");
  assert.equal(shared, pollHealth, "monitor & pollHealth.js berbagi state yang sama");

  shared.failures = 5;
  assert.match(await buildChatReply("cok status"), /polling ke IDN lagi gagal 5x/);
  shared.failures = 0;
  assert.match(await buildChatReply("cok status"), /Bot jalan normal/);
});
