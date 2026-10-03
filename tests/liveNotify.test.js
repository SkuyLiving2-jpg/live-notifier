require("./helpers/setupTestEnv");

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { buildNormalPayload, sendDiscordNotif } = require("../src/notify/liveNotify");
const { formatClockWIB } = require("../src/utils");
const { saveChannelRouting } = require("../src/storage/channelRouting");

// Jam tetap (bukan `new Date()` langsung) biar assert isi teksnya deterministik.
const FIXED_TIME = new Date("2026-09-22T08:50:00.000Z");
const FIXED_CLOCK = formatClockWIB(FIXED_TIME);

test("buildNormalPayload - status end nyantumin jam selesai (member prioritas sama saja)", () => {
  const payload = buildNormalPayload("Nala", "https://idn.app/x", "end", null, FIXED_TIME);
  assert.equal(payload.content, `✅ **Nala** udah selesai live di IDN Live.\nSelesai jam ${FIXED_CLOCK}`);
});

test("buildNormalPayload - status end TETEP gak ada gambar walau imageUrl dikasih (thumbnail cuma buat notif start)", () => {
  const payload = buildNormalPayload("Gabby", "https://idn.app/x", "end", "https://cdn.example/gabby.jpg", FIXED_TIME);
  assert.equal(payload.embeds, undefined);
});

test("buildNormalPayload - status start dikasih imageUrl -> muncul embeds[0].image, content-nya nyantumin jam mulai", () => {
  const payload = buildNormalPayload("Gabby", "https://idn.app/x", "start", "https://cdn.example/gabby.jpg", FIXED_TIME);
  assert.equal(payload.content, `🚨 **Gabby** lagi live di IDN Live!\nNonton di sini: https://idn.app/x\nMulai jam ${FIXED_CLOCK}`);
  assert.deepEqual(payload.embeds, [{ image: { url: "https://cdn.example/gabby.jpg" } }]);
});

test("buildNormalPayload - status start TANPA imageUrl (null, mis. IDN belum sempet generate thumbnail) gak nambahin embeds sama sekali", () => {
  const payload = buildNormalPayload("Gabby", "https://idn.app/x", "start", null, FIXED_TIME);
  assert.equal(payload.embeds, undefined);
});

test("buildNormalPayload - status start buat member BUKAN prioritas (priority null) tetep format standar + jam mulai", () => {
  const payload = buildNormalPayload("Gabby", "https://idn.app/x", "start", null, FIXED_TIME);
  assert.equal(payload.content, `🚨 **Gabby** lagi live di IDN Live!\nNonton di sini: https://idn.app/x\nMulai jam ${FIXED_CLOCK}`);
});

test("buildNormalPayload - timestamp default (gak dikasih argumen) tetep aman, jatuh ke waktu sekarang", () => {
  const payload = buildNormalPayload("Gabby", "https://idn.app/x", "start");
  assert.match(payload.content, /\nMulai jam \d{2}\.\d{2}\.\d{2} WIB$/);
});

// BUG yang dilaporin owner: notif channel Nala nampilin intro + "#NaLex" - itu
// sentuhan khusus DM owner (priority/index.js), bukan buat channel publik.
test("buildNormalPayload - status start buat Nala TIDAK bawa startIntro/#NaLex: format standar sama kayak member lain", () => {
  const payload = buildNormalPayload("Nala", "https://idn.app/x", "start", null, FIXED_TIME);
  assert.equal(
    payload.content,
    `🚨 **Nala** lagi live di IDN Live!
Nonton di sini: https://idn.app/x
Mulai jam ${FIXED_CLOCK}`,
  );
  assert.doesNotMatch(payload.content, /NaLex|Best Friend/);
  assert.equal(payload.embeds, undefined, "notif channel harus tetep plain content, bukan embed");
});

test("sendDiscordNotif - live Nala (prioritas) ke channel: gak ada #NaLex/intro, format standar; versi flashy tetap cuma buat DM", async () => {
  const bodies = [];
  const original = global.fetch;
  global.fetch = async (url, options) => {
    bodies.push(JSON.parse(options.body));
    return { ok: true, json: async () => ({}) };
  };
  try {
    await sendDiscordNotif("Nala JKT48", "jkt48_nala", "slug", "start", null, null);
  } finally {
    global.fetch = original;
  }
  assert.equal(bodies.length, 1);
  assert.doesNotMatch(bodies[0].content, /NaLex|Best Friend/);
  assert.match(bodies[0].content, /^🚨 \*\*Nala JKT48\*\* lagi live di IDN Live!/);
});

// Regresi: live_at datang MENTAH dari API IDN (idnApi.js gak validasi
// format-nya sama sekali). Kalau suatu saat itu bukan string tanggal yang
// keparse, `new Date(liveAt)` jadi Invalid Date - formatClockWIB()
// (Intl.DateTimeFormat) THROW kalau dikasih itu, beda dari
// formatDuration/describeElapsed yang cuma ngasih teks aneh ("NaN") tanpa
// throw. Tanpa validasi di sendDiscordNotif, satu live_at yang rusak bikin
// checkLiveMembers()'s siklus polling itu keputus lebih awal (member LAIN
// yang belum sempet diproses di siklus yang sama ikut kelewat).
test("sendDiscordNotif - liveAt RUSAK (bukan tanggal valid) gak bikin throw, jam mulai jatuh ke waktu sekarang", async () => {
  const original = global.fetch;
  let capturedBody = null;
  global.fetch = async (url, options) => {
    capturedBody = JSON.parse(options.body);
    return { ok: true, json: async () => ({}) };
  };
  try {
    await assert.doesNotReject(sendDiscordNotif("Gabby", "jkt48_gabby", "slug-x", "start", null, "bukan-tanggal-valid"));
    assert.match(capturedBody.content, /\nMulai jam \d{2}\.\d{2}\.\d{2} WIB$/, "tetep nyantumin jam mulai, jatuh ke waktu sekarang");
  } finally {
    global.fetch = original;
  }
});

test("sendDiscordNotif - liveAt null/kosong (belum ada data live_at) gak throw juga, jatuh ke waktu sekarang", async () => {
  const original = global.fetch;
  let capturedBody = null;
  global.fetch = async (url, options) => {
    capturedBody = JSON.parse(options.body);
    return { ok: true, json: async () => ({}) };
  };
  try {
    await assert.doesNotReject(sendDiscordNotif("Gabby", "jkt48_gabby", "slug-x", "start", null, null));
    assert.match(capturedBody.content, /\nMulai jam \d{2}\.\d{2}\.\d{2} WIB$/);
  } finally {
    global.fetch = original;
  }
});

// Fitur "Q2": member yang punya channel khusus (storage/channelRouting.js)
// harus dapet notif di DUA tempat - channel gabungan (default) DAN channel
// khususnya, payload yang SAMA persis di dua-duanya (duplikat, bukan
// pengganti - sesuai keputusan owner).
test("sendDiscordNotif - member yang punya channel khusus -> notif kekirim ke DUA webhook (gabungan + khusus), payload sama persis", async () => {
  saveChannelRouting({ jkt48_dualtest: "https://discord.com/api/webhooks/999/channel-dualtest" });
  const original = global.fetch;
  const calledUrls = [];
  const calledBodies = [];
  global.fetch = async (url, options) => {
    calledUrls.push(url);
    calledBodies.push(JSON.parse(options.body));
    return { ok: true, json: async () => ({}) };
  };
  try {
    const ok = await sendDiscordNotif("DualTest", "jkt48_dualtest", "slug-x", "start", null, null);
    assert.equal(ok, true);
    assert.equal(calledUrls.length, 2, "harus ada 2 kali POST - channel gabungan + channel khusus");
    assert.ok(calledUrls.includes(process.env.DISCORD_WEBHOOK_URL), "salah satu POST harus ke channel gabungan (default)");
    assert.ok(calledUrls.includes("https://discord.com/api/webhooks/999/channel-dualtest"), "salah satu POST harus ke channel khusus member ini");
    assert.equal(calledBodies[0].content, calledBodies[1].content, "isi notif harus SAMA PERSIS di dua-duanya (duplikat, bukan versi beda)");
  } finally {
    global.fetch = original;
    saveChannelRouting({});
  }
});

test("sendDiscordNotif - member yang GAK punya channel khusus -> cuma 1x POST (ke channel gabungan doang), perilaku lama gak berubah", async () => {
  const original = global.fetch;
  let callCount = 0;
  global.fetch = async () => {
    callCount++;
    return { ok: true, json: async () => ({}) };
  };
  try {
    await sendDiscordNotif("SoloTest", "jkt48_solotest_notmapped", "slug-x", "start", null, null);
    assert.equal(callCount, 1);
  } finally {
    global.fetch = original;
  }
});

// Regresi kunci: channel khusus itu BEST-EFFORT - kegagalannya TIDAK BOLEH
// bikin sendDiscordNotif keliatan gagal (yang nentuin activeLives bookkeeping
// di monitor.js), sama kayak sendPriorityDM's failure yang juga non-fatal.
test("sendDiscordNotif - channel khusus GAGAL kirim (mis. webhook-nya udah keburu dihapus) TETEP balikin true kalau channel gabungan sukses", async () => {
  saveChannelRouting({ jkt48_failtest: "https://discord.com/api/webhooks/999/channel-yang-gagal" });
  const original = global.fetch;
  global.fetch = async (url) => {
    if (String(url).includes("channel-yang-gagal")) {
      return { ok: false, status: 404, json: async () => ({}) };
    }
    return { ok: true, json: async () => ({}) };
  };
  try {
    const ok = await sendDiscordNotif("FailTest", "jkt48_failtest", "slug-x", "start", null, null);
    assert.equal(ok, true, "channel gabungan tetep sukses -> hasil keseluruhan HARUS true, walau channel khususnya gagal");
  } finally {
    global.fetch = original;
    saveChannelRouting({});
  }
});

// Regresi: Discord nolak (400) payload dengan > 100 id di allowed_mentions.users atau content
// > 2000 karakter. Notif yang gagal diulang tiap siklus tanpa pernah sukses, jadi member yang
// subscribernya banyak gak akan pernah ke-notif ke siapapun.
test("sendDiscordNotif - subscriber ratusan: yang di-tag dibatasi 50, content < 2000, allowed_mentions.users <= 50, sisanya disebut jumlahnya", async () => {
  const { saveSubscriptions } = require("../src/storage/subscriptions");
  const ids = Array.from({ length: 300 }, (_, i) => String(100000000000000000n + BigInt(i)));
  saveSubscriptions({ banyakfans: ids });
  const original = global.fetch;
  let body = null;
  global.fetch = async (url, options) => {
    body = JSON.parse(options.body);
    return { ok: true, json: async () => ({}) };
  };
  try {
    const ok = await sendDiscordNotif("BanyakFans", "jkt48_banyakfans", "slug-x", "start", null, null);
    assert.equal(ok, true);
    assert.ok(body.content.length < 2000, `content ${body.content.length} harus < 2000`);
    assert.equal(body.allowed_mentions.users.length, 50);
    assert.match(body.content, /\(\+250 subscriber lain\)/);
  } finally {
    global.fetch = original;
    saveSubscriptions({});
  }
});
