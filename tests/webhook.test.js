require("./helpers/setupTestEnv");

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { postToWebhook, withDefaultMentionGuard } = require("../src/notify/webhook");

test("withDefaultMentionGuard - default matiin SEMUA mention implisit kalau payload gak nyetel sendiri", () => {
  const guarded = withDefaultMentionGuard({ content: "halo @everyone" });
  assert.deepEqual(guarded.allowed_mentions, { parse: [] });
  assert.equal(guarded.content, "halo @everyone"); // teksnya tetep apa adanya, cuma parsing mention-nya yang dimatiin
});

test("withDefaultMentionGuard - allowed_mentions custom dari pemanggil (mis. subscriber ping) TETEP menang, gak ketiban default", () => {
  const guarded = withDefaultMentionGuard({ content: "x", allowed_mentions: { users: ["123"] } });
  assert.deepEqual(guarded.allowed_mentions, { users: ["123"] });
});

// Regresi buat celah mention-abuse yang ketemu pas audit: SEBELUM ini,
// postToWebhook ngirim payload apa adanya ke Discord tanpa allowed_mentions
// sama sekali - kalau content-nya (mis. nama member dari IDN) kebetulan
// ngandung "@everyone"/"@here"/mention role, Discord beneran nge-ping itu.
// Dites lewat mock global.fetch (bukan network beneran) - nangkep body yang
// DIKIRIM postToWebhook, mastiin allowed_mentions udah nyangkut di situ.
test("postToWebhook - body yang beneran dikirim ke Discord SELALU punya allowed_mentions, default parse:[] kalau payload gak nyetel sendiri", async () => {
  const original = global.fetch;
  let capturedBody = null;
  global.fetch = async (url, options) => {
    capturedBody = JSON.parse(options.body);
    return { ok: true, json: async () => ({}) };
  };
  try {
    const ok = await postToWebhook({ content: "**Someone** lagi live!" });
    assert.equal(ok, true);
    assert.deepEqual(capturedBody.allowed_mentions, { parse: [] });
    assert.equal(capturedBody.content, "**Someone** lagi live!");
  } finally {
    global.fetch = original;
  }
});

test("postToWebhook - allowed_mentions custom dari payload (subscriber ping) tetep sampe utuh ke body yang dikirim", async () => {
  const original = global.fetch;
  let capturedBody = null;
  global.fetch = async (url, options) => {
    capturedBody = JSON.parse(options.body);
    return { ok: true, json: async () => ({}) };
  };
  try {
    await postToWebhook({ content: "x", allowed_mentions: { users: ["999"] } });
    assert.deepEqual(capturedBody.allowed_mentions, { users: ["999"] });
  } finally {
    global.fetch = original;
  }
});
