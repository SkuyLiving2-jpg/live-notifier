require("./helpers/setupTestEnv");
// Harus di-set SEBELUM config.js ke-require (lewat modul src/ apa pun di bawah).
process.env.PRIORITY_PING_USER_ID = "owner-retry";

const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

// Client Discord palsu: getDiscordClient() asli selalu null tanpa token, jadi DM dipalsukan lewat require.cache.
// Mencatat semua DM yang "terkirim" ke tiap user.
const dms = [];
const failDmFor = new Set();
const fakeClient = {
  users: {
    fetch: async (id) => ({
      send: async (payload) => {
        if (failDmFor.has(id)) throw new Error("DM ditutup");
        dms.push({ to: id, content: String(payload.content ?? payload.embeds?.[0]?.title ?? "") });
      },
    }),
  },
};
const clientPath = require.resolve("../src/discordClient");
require.cache[clientPath] = {
  id: clientPath,
  filename: clientPath,
  loaded: true,
  exports: { getDiscordClient: () => fakeClient, createDiscordClient: () => null },
};

const { sendDiscordNotif } = require("../src/notify/liveNotify");
const { clearDeliveryLedger } = require("../src/notify/deliveryLedger");
const { addSubscription } = require("../src/storage/subscriptions");
const { updateUserPrefs } = require("../src/storage/userPrefs");
const { saveChannelRouting } = require("../src/storage/channelRouting");

const SHARED_URL = process.env.DISCORD_WEBHOOK_URL;
const DEDICATED_URL = "https://discord.com/api/webhooks/111/dedicated-token";

// Webhook palsu per URL: tiap URL bisa disetel sukses/gagal, dan semua POST dicatat.
const hooks = new Map();
let posts;
function setHook(url, ok) {
  hooks.set(url, ok);
}
const originalFetch = global.fetch;
global.fetch = async (url) => {
  const key = String(url).split("?")[0];
  posts.push(key);
  const ok = hooks.get(key) ?? true;
  return ok
    ? { ok: true, status: 200, json: async () => ({}), text: async () => "" }
    : { ok: false, status: 500, json: async () => ({}), text: async () => "x" };
};
const postsTo = (url) => posts.filter((u) => u === url).length;

const originalError = console.error;
const originalLog = console.log;
beforeEach(() => {
  posts = [];
  dms.length = 0;
  failDmFor.clear();
  hooks.clear();
  clearDeliveryLedger();
  saveChannelRouting({});
  console.error = () => {};
  console.log = () => {};
});
process.on("exit", () => {
  global.fetch = originalFetch;
  console.error = originalError;
  console.log = originalLog;
});

// Pemanggil asli (monitor.js) mengulang notif yang gagal tiap siklus polling dengan argumen yang sama.
const startNotif = (name, username, slug) => sendDiscordNotif(name, username, slug, "start", null, new Date().toISOString());

test("webhook channel gagal berulang - DM prioritas ke pemilik terkirim SEKALI, bukan tiap siklus (dulu 1 DM per siklus polling)", async () => {
  setHook(SHARED_URL, false);
  for (let i = 0; i < 5; i++) assert.equal(await startNotif("Nala JKT48", "jkt48_nala", "s-nala"), false);
  assert.equal(postsTo(SHARED_URL), 5, "notif channel tetap dicoba ulang tiap siklus");
  assert.equal(dms.filter((d) => d.to === "owner-retry").length, 1);

  setHook(SHARED_URL, true);
  assert.equal(await startNotif("Nala JKT48", "jkt48_nala", "s-nala"), true);
  assert.equal(dms.filter((d) => d.to === "owner-retry").length, 1, "begitu channel pulih tidak ada DM tambahan");
});

test("DM prioritas yang GAGAL dicoba lagi di percobaan berikutnya (hanya DM yang berhasil yang dicatat)", async () => {
  setHook(SHARED_URL, false);
  failDmFor.add("owner-retry");
  await startNotif("Nala JKT48", "jkt48_nala", "s-nala2");
  await startNotif("Nala JKT48", "jkt48_nala", "s-nala2");
  assert.equal(dms.length, 0);

  failDmFor.clear();
  await startNotif("Nala JKT48", "jkt48_nala", "s-nala2");
  assert.equal(dms.filter((d) => d.to === "owner-retry").length, 1, "DM terkirim begitu bisa, lalu tidak diulang");
  await startNotif("Nala JKT48", "jkt48_nala", "s-nala2");
  assert.equal(dms.filter((d) => d.to === "owner-retry").length, 1);
});

test("notif SELESAI member prioritas juga tidak mengulang DM saat channel gagal", async () => {
  setHook(SHARED_URL, false);
  for (let i = 0; i < 4; i++) await sendDiscordNotif("Nala JKT48", "jkt48_nala", "s-end", "end");
  assert.equal(dms.filter((d) => d.to === "owner-retry").length, 1);
});

test("subscriber yang memilih notif lewat DM - DM sekali walau notif channel diulang, dan tidak di-tag di channel setelah berhasil di-DM", async () => {
  addSubscription("gabby", "user-dm");
  updateUserPrefs("user-dm", (p) => {
    p.delivery = "dm";
  });
  setHook(SHARED_URL, false);
  await startNotif("Gabby JKT48", "jkt48_gabby", "s-g1");
  await startNotif("Gabby JKT48", "jkt48_gabby", "s-g1");
  await startNotif("Gabby JKT48", "jkt48_gabby", "s-g1");
  assert.equal(dms.filter((d) => d.to === "user-dm").length, 1);
});

test("subscriber yang DM-nya GAGAL jatuh balik ke tag di channel, dan tidak ada DM terkirim", async () => {
  addSubscription("marsha", "user-dm-closed");
  updateUserPrefs("user-dm-closed", (p) => {
    p.delivery = "dm";
  });
  failDmFor.add("user-dm-closed");
  const bodies = [];
  const prev = global.fetch;
  global.fetch = async (url, options) => {
    bodies.push(options?.body ? JSON.parse(options.body) : null);
    return prev(url, options);
  };
  try {
    assert.equal(await startNotif("Marsha JKT48", "jkt48_marsha", "s-l1"), true);
  } finally {
    global.fetch = prev;
  }
  assert.equal(dms.length, 0);
  assert.match(bodies[0].content, /<@user-dm-closed>/);
});

test("channel khusus member - tidak dikirimi duplikat tiap siklus saat channel GABUNGAN yang gagal", async () => {
  saveChannelRouting({ jkt48_aralie: DEDICATED_URL });
  setHook(SHARED_URL, false);
  setHook(DEDICATED_URL, true);
  for (let i = 0; i < 4; i++) await startNotif("Aralie JKT48", "jkt48_aralie", "s-a1");
  assert.equal(postsTo(SHARED_URL), 4);
  assert.equal(postsTo(DEDICATED_URL), 1, "channel khusus menerima notif sekali saja");
});

test("channel khusus yang GAGAL dicoba lagi di siklus berikutnya selama channel gabungan juga masih diulang", async () => {
  saveChannelRouting({ jkt48_aralie: DEDICATED_URL });
  setHook(SHARED_URL, false);
  setHook(DEDICATED_URL, false);
  await startNotif("Aralie JKT48", "jkt48_aralie", "s-a2");
  await startNotif("Aralie JKT48", "jkt48_aralie", "s-a2");
  assert.equal(postsTo(DEDICATED_URL), 2);
  setHook(DEDICATED_URL, true);
  await startNotif("Aralie JKT48", "jkt48_aralie", "s-a2");
  await startNotif("Aralie JKT48", "jkt48_aralie", "s-a2");
  assert.equal(postsTo(DEDICATED_URL), 3, "begitu berhasil tidak diulang lagi");
});

test("notif berhasil di percobaan pertama - catatan sesi dibersihkan, live berikutnya dengan slug SAMA tetap dapat DM dan channel khusus", async () => {
  saveChannelRouting({ jkt48_nala: DEDICATED_URL });
  assert.equal(await startNotif("Nala JKT48", "jkt48_nala", "s-same"), true);
  assert.equal(await startNotif("Nala JKT48", "jkt48_nala", "s-same"), true);
  assert.equal(dms.filter((d) => d.to === "owner-retry").length, 2, "dua live terpisah -> dua DM");
  assert.equal(postsTo(DEDICATED_URL), 2);
});

test("member non-prioritas tanpa langganan - perilaku lama tidak berubah (satu post per notif, tanpa DM)", async () => {
  assert.equal(await startNotif("Zee JKT48", "jkt48_zee", "s-z"), true);
  assert.equal(postsTo(SHARED_URL), 1);
  assert.equal(dms.length, 0);
});

test("catatan pengiriman kedaluwarsa setelah TTL (Map tidak tumbuh selamanya) dan forgetSession hanya menghapus sesi itu", () => {
  const { deliveryKey, wasDelivered, markDelivered, forgetSession, LEDGER_TTL_MS } = require("../src/notify/deliveryLedger");
  const t0 = Date.now();
  const a = deliveryKey("jkt48_x:s1:start", "dm", "u1");
  const b = deliveryKey("jkt48_y:s2:start", "dm", "u1");
  markDelivered(a, t0);
  markDelivered(b, t0);
  assert.equal(wasDelivered(a, t0 + LEDGER_TTL_MS - 1), true);
  forgetSession("jkt48_x:s1:start");
  assert.equal(wasDelivered(a, t0 + 1), false, "sesi yang dibersihkan hilang");
  assert.equal(wasDelivered(b, t0 + 1), true, "sesi lain tidak ikut terhapus");
  assert.equal(wasDelivered(b, t0 + LEDGER_TTL_MS + 1), false, "lewat TTL -> dibuang");
});
