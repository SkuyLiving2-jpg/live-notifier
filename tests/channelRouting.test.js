require("./helpers/setupTestEnv");

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadChannelRouting, saveChannelRouting, getChannelWebhookFor } = require("../src/storage/channelRouting");

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
