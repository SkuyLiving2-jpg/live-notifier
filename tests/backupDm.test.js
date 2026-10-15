require("./helpers/setupTestEnv");
// setupTestEnv mematikan backup mingguan di semua test; file ini justru mengujinya, jadi dinyalakan SEBELUM config.js dimuat.
process.env.WEEKLY_BACKUP_DM = "on";
process.env.PRIORITY_PING_USER_ID = "999000999000999000";

// Client Discord palsu - dipasang di modul discordClient SEBELUM backupDm/ownerAlert di-require (mereka mengambil
// getDiscordClient lewat destructuring).
const sent = [];
let failNext = false;
let ready = true;
const fakeClient = {
  isReady: () => ready,
  users: {
    fetch: async (id) => ({
      send: async (payload) => {
        if (failNext) throw new Error("Cannot send messages to this user (simulasi DM ditutup)");
        sent.push({ id, payload });
        return {};
      },
    }),
  },
};
require("../src/discordClient").getDiscordClient = () => fakeClient;

const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { maybeSendWeeklyBackup, BACKUP_INTERVAL_MS, RETRY_AFTER_MS, MAX_ATTACHMENT_BYTES } = require("../src/notify/backupDm");
const { planRestore } = require("../src/backup");
const { recordLiveCompleted } = require("../src/storage/liveCount");
const { saveChannelRouting } = require("../src/storage/channelRouting");
const { getRegisteredStore } = require("../src/storage/jsonStore");
const { activeLives } = require("../src/storage/activeLives");
const { checkLiveMembers } = require("../src/monitor");

const WEBHOOK = "https://discord.com/api/webhooks/123456789012345678/RAHASIA-token";

beforeEach(() => {
  sent.length = 0;
  failNext = false;
  ready = true;
  getRegisteredStore("backup-dm-state.json").store.save({ lastSentAt: null, lastAttemptAt: null });
});

function attachmentJson(call) {
  return JSON.parse(call.payload.files[0].attachment.toString("utf-8"));
}

test("backup pertama: terkirim ke owner sebagai lampiran .json, TANPA webhook channel dan TANPA activeLives", async () => {
  recordLiveCompleted("jkt48_nala", "Nala JKT48");
  saveChannelRouting({ jkt48_nala: WEBHOOK });
  activeLives.set("jkt48_sedang", { name: "Sedang", username: "jkt48_sedang", slug: "s", liveAt: new Date().toISOString() });

  assert.equal(await maybeSendWeeklyBackup(Date.now()), true);
  activeLives.delete("jkt48_sedang");

  assert.equal(sent.length, 1);
  assert.equal(sent[0].id, "999000999000999000");
  assert.match(sent[0].payload.content, /Backup data bot \(mingguan, \d{4}-\d{2}-\d{2}\)/);
  assert.match(sent[0].payload.files[0].name, /^backup-\d{4}-\d{2}-\d{2}\.json$/);

  const snapshot = attachmentJson(sent[0]);
  assert.ok(snapshot.liveCount.jkt48_nala, "data ikut");
  assert.equal("channelRouting" in snapshot, false, "webhook (rahasia) tidak boleh masuk riwayat DM");
  assert.equal("activeLives" in snapshot, false);
  assert.equal(JSON.stringify(snapshot).includes("RAHASIA-token"), false);
});

test("file backup di DM benar-benar bisa dipulihkan (lolos planRestore tanpa section salah bentuk)", async () => {
  recordLiveCompleted("jkt48_levi", "Levi JKT48");
  await maybeSendWeeklyBackup(Date.now());
  const plan = planRestore(attachmentJson(sent[0]));
  assert.equal(plan.error, undefined);
  assert.deepEqual(plan.invalid, []);
  assert.ok(plan.sections.length >= 10);
});

test("tidak dikirim lagi sebelum 7 hari; sesudah 7 hari dikirim lagi", async () => {
  const t0 = Date.now();
  assert.equal(await maybeSendWeeklyBackup(t0), true);
  assert.equal(await maybeSendWeeklyBackup(t0 + BACKUP_INTERVAL_MS - 1000), false);
  assert.equal(sent.length, 1);
  assert.equal(await maybeSendWeeklyBackup(t0 + BACKUP_INTERVAL_MS + 1000), true);
  assert.equal(sent.length, 2);
});

test("DM gagal -> tidak dianggap terkirim, dan percobaan ulang ditahan 1 jam (bukan tiap siklus 20 detik)", async () => {
  const originalError = console.error;
  console.error = () => {};
  try {
    const t0 = Date.now();
    failNext = true;
    assert.equal(await maybeSendWeeklyBackup(t0), false);
    failNext = false;
    assert.equal(await maybeSendWeeklyBackup(t0 + 20_000), false, "siklus berikutnya tidak mencoba lagi");
    assert.equal(sent.length, 0);
    assert.equal(await maybeSendWeeklyBackup(t0 + RETRY_AFTER_MS + 1000), true, "setelah 1 jam dicoba lagi dan berhasil");
    assert.equal(sent.length, 1);
  } finally {
    console.error = originalError;
  }
});

test("bot belum ready (baru boot) -> menunggu TANPA mencatat percobaan; begitu ready langsung terkirim", async () => {
  ready = false;
  const t0 = Date.now();
  assert.equal(await maybeSendWeeklyBackup(t0), false);
  assert.equal(await maybeSendWeeklyBackup(t0 + 5000), false);
  ready = true;
  assert.equal(await maybeSendWeeklyBackup(t0 + 10_000), true, "tidak terhalang jeda 1 jam karena percobaan tadi tidak dicatat");
});

test("data > batas lampiran -> DM teks berisi peringatan (bukan gagal diam-diam), dan dihitung terkirim", async () => {
  const big = {};
  for (let i = 0; i < 40; i++) big[`jkt48_besar${i}`] = { name: "B", count: 1, pad: "x".repeat(MAX_ATTACHMENT_BYTES / 30) };
  const entry = getRegisteredStore("live-count.json");
  const keep = entry.store.load();
  entry.store.save(big);
  try {
    assert.equal(await maybeSendWeeklyBackup(Date.now()), true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].payload.files, undefined, "tidak melampirkan file raksasa");
    assert.match(sent[0].payload.content, /terlalu besar.*npm run backup-data/);
  } finally {
    entry.store.save(keep);
  }
});

test("terpasang di siklus polling: checkLiveMembers mengirim backup 1x (dan tidak mengulang di siklus berikutnya)", async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).includes("idn.app")) return { ok: true, json: async () => ({ data: { getLivestreams: [] } }) };
    return { ok: true, json: async () => ({}) };
  };
  try {
    await checkLiveMembers();
    await checkLiveMembers();
    assert.equal(sent.filter((s) => s.payload.files).length, 1);
  } finally {
    global.fetch = originalFetch;
  }
});
