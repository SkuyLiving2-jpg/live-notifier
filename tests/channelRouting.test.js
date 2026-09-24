require("./helpers/setupTestEnv");

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadChannelRouting, saveChannelRouting, getChannelWebhookFor, getUsernameForChannel } = require("../src/storage/channelRouting");

test("loadChannelRouting - default kosong kalau belum pernah disimpen", () => {
  assert.deepEqual(loadChannelRouting(), {});
});

test("saveChannelRouting - full REPLACE, bukan merge (push kedua nge-ilangin entry dari push pertama)", () => {
  saveChannelRouting({ jkt48_aralie: "https://discord.com/api/webhooks/111/token-a" });
  assert.deepEqual(loadChannelRouting(), { jkt48_aralie: "https://discord.com/api/webhooks/111/token-a" });

  saveChannelRouting({ jkt48_delynn: "https://discord.com/api/webhooks/222/token-b" });
  assert.deepEqual(loadChannelRouting(), { jkt48_delynn: "https://discord.com/api/webhooks/222/token-b" });
});

test("getChannelWebhookFor - exact username match balikin webhook URL-nya, username lain/kosong/null balikin null", () => {
  saveChannelRouting({ jkt48_intan: "https://discord.com/api/webhooks/333/token-c" });

  assert.equal(getChannelWebhookFor("jkt48_intan"), "https://discord.com/api/webhooks/333/token-c");
  assert.equal(getChannelWebhookFor("jkt48_lain"), null, "username yang gak ada di pemetaan balikin null");
  assert.equal(getChannelWebhookFor(""), null);
  assert.equal(getChannelWebhookFor(null), null);
});

// Regresi anti-fuzzy-match: beda sama priority/subscriptions yang cocokin
// keyword parsial (containsWholeWord), channelRouting HARUS exact key doang -
// di skala ~40+ member, keyword parsial bisa nabrak (mis. "intan" nyantol ke
// "jkt48_intannia" kalau dicocokin parsial).
test("getChannelWebhookFor - EXACT match doang, bukan fuzzy/prefix kayak priority/subscriptions", () => {
  saveChannelRouting({ jkt48_intan: "https://discord.com/api/webhooks/333/token-c" });
  assert.equal(getChannelWebhookFor("jkt48_intannia"), null, "username lain yang cuma MIRIP/prefix-nya sama harus TETEP null");
});

// Regresi nyata: owner ngisi channel-routing.local.json manual pake "jkt48_Aralie"
// (huruf besar), padahal username ASLI dari IDN (yang dipake buat manggil
// getChannelWebhookFor pas ada live) hampir pasti lowercase - tanpa
// normalisasi ini, notif ke channel khususnya DIEM-DIEM gak pernah kekirim.
// Bentuk BARU (fitur "Q3" - fallback chat khusus channel per-member): value-nya
// object { webhookUrl, channelId }, bukan cuma string webhook URL polos.
test("getChannelWebhookFor - entry bentuk object { webhookUrl, channelId } tetep balikin webhookUrl-nya", () => {
  saveChannelRouting({ jkt48_objecttest: { webhookUrl: "https://discord.com/api/webhooks/666/token-f", channelId: "111222333444555666" } });
  assert.equal(getChannelWebhookFor("jkt48_objecttest"), "https://discord.com/api/webhooks/666/token-f");
});

test("getUsernameForChannel - channelId yang ke-mapping (entry bentuk object) balikin username-nya", () => {
  saveChannelRouting({
    jkt48_reversetest: { webhookUrl: "https://discord.com/api/webhooks/777/token-g", channelId: "999888777666555444" },
  });
  assert.equal(getUsernameForChannel("999888777666555444"), "jkt48_reversetest");
});

test("getUsernameForChannel - channelId yang gak ke-mapping/kosong/null balikin null", () => {
  saveChannelRouting({
    jkt48_reversetest2: { webhookUrl: "https://discord.com/api/webhooks/777/token-g", channelId: "999888777666555444" },
  });
  assert.equal(getUsernameForChannel("channel-lain-yang-gak-ada"), null);
  assert.equal(getUsernameForChannel(""), null);
  assert.equal(getUsernameForChannel(null), null);
});

// Entry bentuk STRING lama (webhook doang, gak ada channelId) HARUS TETEP
// jalan buat notif (getChannelWebhookFor), tapi gak pernah nyantol di
// getUsernameForChannel - bot emang gak tau channel Discord-nya yang mana.
test("getUsernameForChannel - entry bentuk string lama (webhook polos, gak ada channelId) TIDAK PERNAH match", () => {
  saveChannelRouting({ jkt48_legacytest: "https://discord.com/api/webhooks/888/token-h" });
  assert.equal(getUsernameForChannel("https://discord.com/api/webhooks/888/token-h"), null);
  assert.equal(getChannelWebhookFor("jkt48_legacytest"), "https://discord.com/api/webhooks/888/token-h");
});

test("saveChannelRouting/getChannelWebhookFor - case-insensitive, entry huruf besar di file lokal tetep kesambung ke username lowercase dari IDN", () => {
  saveChannelRouting({ jkt48_Aralie: "https://discord.com/api/webhooks/444/token-d" });

  assert.deepEqual(
    loadChannelRouting(),
    { jkt48_aralie: "https://discord.com/api/webhooks/444/token-d" },
    "key HARUS ke-normalize lowercase pas disimpen",
  );
  assert.equal(getChannelWebhookFor("jkt48_aralie"), "https://discord.com/api/webhooks/444/token-d");

  // Kebalikannya juga - kalau yang disimpen lowercase tapi lookup-nya (yang
  // manggil) kebetulan dikasih campuran huruf, tetep harus nyambung.
  saveChannelRouting({ jkt48_delynn: "https://discord.com/api/webhooks/555/token-e" });
  assert.equal(getChannelWebhookFor("Jkt48_Delynn"), "https://discord.com/api/webhooks/555/token-e");
});
