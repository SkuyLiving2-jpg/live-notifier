require("./helpers/setupTestEnv");

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { postToWebhook, withDefaultMentionGuard, MAX_RATE_LIMIT_RETRIES } = require("../src/notify/webhook");

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

// Fitur baru: retry/backoff kalau kena rate limit Discord (429). retry_after
// di body respons mock-nya dibikin KECIL (0.01 detik) biar test-nya cepet -
// postToWebhook nge-cap tunggu maksimal (MAX_RATE_LIMIT_WAIT_MS) tapi tetep
// nunggu SEBERAPA LAMA yang diminta respons (bukan 0), jadi angka kecil di
// sini penting biar test gak lambat tanpa perlu mock timer.
test("postToWebhook - kena 429 sekali lalu sukses -> retry otomatis, akhirnya balikin true", async () => {
  const original = global.fetch;
  let callCount = 0;
  global.fetch = async () => {
    callCount++;
    if (callCount === 1) {
      return { ok: false, status: 429, json: async () => ({ message: "rate limited", retry_after: 0.01 }) };
    }
    return { ok: true, json: async () => ({}) };
  };
  try {
    const ok = await postToWebhook({ content: "x" });
    assert.equal(ok, true);
    assert.equal(callCount, 2, "harus nyoba 2x - gagal 429 sekali, sukses di percobaan kedua");
  } finally {
    global.fetch = original;
  }
});

test("postToWebhook - kena 429 TERUS-MENERUS -> nyerah abis MAX_RATE_LIMIT_RETRIES tambahan, balikin false", async () => {
  const original = global.fetch;
  let callCount = 0;
  global.fetch = async () => {
    callCount++;
    return { ok: false, status: 429, json: async () => ({ message: "rate limited", retry_after: 0.01 }) };
  };
  try {
    const ok = await postToWebhook({ content: "x" });
    assert.equal(ok, false);
    // Percobaan pertama + MAX_RATE_LIMIT_RETRIES kali retry tambahan.
    assert.equal(callCount, MAX_RATE_LIMIT_RETRIES + 1);
  } finally {
    global.fetch = original;
  }
});

test("postToWebhook - status GAGAL yang BUKAN 429 (mis. 500) TIDAK di-retry sama sekali, langsung balikin false", async () => {
  const original = global.fetch;
  let callCount = 0;
  global.fetch = async () => {
    callCount++;
    return { ok: false, status: 500, json: async () => ({}) };
  };
  try {
    const ok = await postToWebhook({ content: "x" });
    assert.equal(ok, false);
    assert.equal(callCount, 1, "500 bukan rate-limit - gak ada gunanya diulang persis sama, harus cuma 1x coba");
  } finally {
    global.fetch = original;
  }
});

// Body respons 429 yang RUSAK bikin fallback delay 1 detik penuh (lihat
// getRetryAfterMs di webhook.js) - global.setTimeout di-mock biar test ini
// gak beneran nunggu 1 detik, TETAP kefungsi (retry-nya beneran kejadian,
// gak nyangkut selamanya), cuma gak makan waktu test suite.
test("postToWebhook - 429 dengan body respons YANG RUSAK (bukan JSON valid) tetep jalan, gak nyangkut - retry pakai fallback delay", async () => {
  const originalFetch = global.fetch;
  const originalSetTimeout = global.setTimeout;
  let callCount = 0;
  global.fetch = async () => {
    callCount++;
    if (callCount === 1) {
      return {
        ok: false,
        status: 429,
        json: async () => {
          throw new Error("bukan JSON valid");
        },
      };
    }
    return { ok: true, json: async () => ({}) };
  };
  global.setTimeout = (fn) => originalSetTimeout(fn, 0); // skip nunggu beneran, retry-nya tetep kejadian
  try {
    const ok = await postToWebhook({ content: "x" });
    assert.equal(ok, true);
    assert.equal(callCount, 2);
  } finally {
    global.fetch = originalFetch;
    global.setTimeout = originalSetTimeout;
  }
});
