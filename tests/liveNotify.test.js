require("./helpers/setupTestEnv");

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { buildNormalPayload, sendDiscordNotif } = require("../src/notify/liveNotify");
const { getAllPriorityMembers } = require("../src/priority");
const { formatClockWIB } = require("../src/utils");

// Jam tetap (bukan `new Date()` langsung) biar assert isi teksnya deterministik.
const FIXED_TIME = new Date("2026-09-22T08:50:00.000Z");
const FIXED_CLOCK = formatClockWIB(FIXED_TIME);

test("buildNormalPayload - status end nyantumin jam selesai, priority gak ngaruh sama sekali", () => {
  const nala = getAllPriorityMembers().find((m) => m.keyword === "nala");
  const payload = buildNormalPayload("Nala", "https://idn.app/x", "end", nala, null, FIXED_TIME);
  assert.equal(payload.content, `✅ **Nala** udah selesai live di IDN Live.\nSelesai jam ${FIXED_CLOCK}`);
});

test("buildNormalPayload - status end TETEP gak ada gambar walau imageUrl dikasih (thumbnail cuma buat notif start)", () => {
  const payload = buildNormalPayload("Gabby", "https://idn.app/x", "end", null, "https://cdn.example/gabby.jpg", FIXED_TIME);
  assert.equal(payload.embeds, undefined);
});

test("buildNormalPayload - status start dikasih imageUrl -> muncul embeds[0].image, content-nya nyantumin jam mulai", () => {
  const payload = buildNormalPayload("Gabby", "https://idn.app/x", "start", null, "https://cdn.example/gabby.jpg", FIXED_TIME);
  assert.equal(payload.content, `🚨 **Gabby** lagi live di IDN Live!\nNonton di sini: https://idn.app/x\nMulai jam ${FIXED_CLOCK}`);
  assert.deepEqual(payload.embeds, [{ image: { url: "https://cdn.example/gabby.jpg" } }]);
});

test("buildNormalPayload - status start TANPA imageUrl (null, mis. IDN belum sempet generate thumbnail) gak nambahin embeds sama sekali", () => {
  const payload = buildNormalPayload("Gabby", "https://idn.app/x", "start", null, null, FIXED_TIME);
  assert.equal(payload.embeds, undefined);
});

test("buildNormalPayload - status start buat member BUKAN prioritas (priority null) tetep format standar + jam mulai", () => {
  const payload = buildNormalPayload("Gabby", "https://idn.app/x", "start", null, null, FIXED_TIME);
  assert.equal(payload.content, `🚨 **Gabby** lagi live di IDN Live!\nNonton di sini: https://idn.app/x\nMulai jam ${FIXED_CLOCK}`);
});

test("buildNormalPayload - timestamp default (gak dikasih argumen) tetep aman, jatuh ke waktu sekarang", () => {
  const payload = buildNormalPayload("Gabby", "https://idn.app/x", "start");
  assert.match(payload.content, /\nMulai jam \d{2}\.\d{2} WIB$/);
});

// Notif CHANNEL Nala tetep plain content (bukan embed/tombol - itu cuma di
// DM, lihat priority/index.js's buildPriorityPayload) - startIntro/
// startHashtag cuma nempel di teksnya doang, struktur pesannya sama kayak
// member lain.
test("buildNormalPayload - status start buat Nala nempelin startIntro/startHashtag TAPI tetep plain content, bukan embed", () => {
  const nala = getAllPriorityMembers().find((m) => m.keyword === "nala");
  const payload = buildNormalPayload("Nala", "https://idn.app/x", "start", nala, null, FIXED_TIME);
  assert.equal(
    payload.content,
    `Nala, si Best Friend mu lagi Live\n🚨 **Nala** lagi live di IDN Live!\nNonton di sini: https://idn.app/x #NaLex\nMulai jam ${FIXED_CLOCK}`,
  );
  assert.equal(payload.embeds, undefined, "notif channel harus tetep plain content, bukan embed");
});

test("buildNormalPayload - status start buat Levi (prioritas tapi TANPA startIntro/startHashtag) tetep format standar + jam mulai", () => {
  const levi = getAllPriorityMembers().find((m) => m.keyword === "levi");
  const payload = buildNormalPayload("Levi", "https://idn.app/x", "start", levi, null, FIXED_TIME);
  assert.equal(payload.content, `🚨 **Levi** lagi live di IDN Live!\nNonton di sini: https://idn.app/x\nMulai jam ${FIXED_CLOCK}`);
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
    assert.match(capturedBody.content, /\nMulai jam \d{2}\.\d{2} WIB$/, "tetep nyantumin jam mulai, jatuh ke waktu sekarang");
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
    assert.match(capturedBody.content, /\nMulai jam \d{2}\.\d{2} WIB$/);
  } finally {
    global.fetch = original;
  }
});
