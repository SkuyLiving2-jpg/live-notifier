require("./helpers/setupTestEnv");
// setupTestEnv mematikan pengingat VC di semua test; file ini justru mengujinya, jadi dinyalakan SEBELUM config.js dimuat.
process.env.VC_REMINDER_DM = "on";
process.env.PRIORITY_PING_USER_ID = "999000999000999000";

// Client Discord palsu - dipasang SEBELUM vcReminder/ownerAlert di-require (mereka mengambil getDiscordClient lewat destructuring).
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
const { maybeSendVcReminders, buildReminderText, REMIND_BEFORE_MS, GRACE_AFTER_MS, RETRY_AFTER_MS } = require("../src/notify/vcReminder");
const { addVcSession, updateVcSession, saveVc, loadVc } = require("../src/storage/vcSchedule");
const { getRegisteredStore } = require("../src/storage/jsonStore");

// Sabtu 31 Okt 2026, sesi 1: jam mulai 11.15 WIB (= 04:15 UTC).
const START = Date.parse("2026-10-31T11:15:00+07:00");
const FIELDS = {
  username: "jkt48_lily",
  name: "Lily JKT48",
  session: 1,
  date: "2026-10-31",
  open: "11:30",
  openEnd: "11:45",
  start: "11:15",
  tickets: 3,
  link: "https://us02web.zoom.us/j/81331441967?pwd=abc",
  passcode: "388756",
  note: "x",
};

beforeEach(() => {
  sent.length = 0;
  failNext = false;
  ready = true;
  saveVc({ title: "VC", opener: "o", sessions: [], nicknames: {}, nextId: 1, message: null });
  getRegisteredStore("vc-reminders.json").store.save({ sent: {}, attempts: {} });
});

test("5 menit sebelum jam mulai: DM owner berisi link, sandi, tiket, jam buka", async () => {
  addVcSession(FIELDS);
  assert.equal(await maybeSendVcReminders(START - REMIND_BEFORE_MS), 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].id, "999000999000999000");
  const text = sent[0].payload.content;
  assert.match(text, /Pengingat VC\*\* - Lily · Sesi 1/);
  assert.match(text, /Mulai 11\.15 WIB \(5 menit lagi\) · Buka 11\.30-11\.45/);
  assert.match(text, /🔗 <https:\/\/us02web\.zoom\.us\/j\/81331441967\?pwd=abc>/);
  assert.match(text, /Sandi: 388756/);
  assert.match(text, /3 tiket/);
});

test("terlalu awal -> belum; sesudah dikirim -> tidak dikirim ulang; hari/sesi lain tidak ikut", async () => {
  addVcSession(FIELDS);
  addVcSession({ ...FIELDS, date: "2026-11-01", link: "https://us02web.zoom.us/j/1" });
  assert.equal(await maybeSendVcReminders(START - REMIND_BEFORE_MS - 60_000), 0);
  assert.equal(await maybeSendVcReminders(START - 60_000), 1);
  assert.equal(await maybeSendVcReminders(START), 0);
  assert.equal(await maybeSendVcReminders(START + 1000), 0);
  assert.equal(sent.length, 1);
});

test("toleransi setelah jam mulai (restart); lewat batas -> tidak diingatkan", async () => {
  addVcSession(FIELDS);
  assert.equal(await maybeSendVcReminders(START + GRACE_AFTER_MS + 60_000), 0);
  assert.equal(await maybeSendVcReminders(START + GRACE_AFTER_MS - 1000), 1);
  assert.match(sent[0].payload.content, /\(sekarang\)/);
});

test("dua sesi bersamaan: dua DM berurutan; jam mulai yang diubah owner diingatkan lagi untuk jam barunya", async () => {
  const a = addVcSession(FIELDS);
  addVcSession({ ...FIELDS, name: "Nala JKT48", username: "jkt48_nala", link: "https://us02web.zoom.us/j/2" });
  assert.equal(await maybeSendVcReminders(START - 60_000), 2);
  updateVcSession(a.id, { start: "11:20" });
  assert.equal(await maybeSendVcReminders(START + 4 * 60_000), 1, "jam baru 11.20 -> pengingat baru");
  assert.equal(sent.length, 3);
});

test("DM gagal: dicoba lagi paling cepat setelah RETRY_AFTER_MS, tidak tiap siklus; berhasil lalu tidak diulang", async () => {
  addVcSession(FIELDS);
  failNext = true;
  assert.equal(await maybeSendVcReminders(START - 60_000), 0);
  failNext = false;
  assert.equal(await maybeSendVcReminders(START - 60_000 + 20_000), 0, "siklus polling berikutnya (20 dtk) menunggu");
  assert.equal(await maybeSendVcReminders(START - 60_000 + RETRY_AFTER_MS + 1), 1);
  assert.equal(await maybeSendVcReminders(START), 0);
});

test("client belum ready -> tidak mengirim dan tidak mencatat percobaan; sesi tanpa jadwal hari ini -> tidak apa-apa", async () => {
  addVcSession(FIELDS);
  ready = false;
  assert.equal(await maybeSendVcReminders(START - 60_000), 0);
  ready = true;
  assert.equal(await maybeSendVcReminders(START - 60_000), 1);
  assert.equal(loadVc().sessions.length, 1);
  assert.equal(await maybeSendVcReminders(Date.parse("2026-01-01T00:00:00+07:00")), 0);
});

test("jendela melewati tengah malam WIB tetap dihitung (sesi tanggal kemarin)", async () => {
  addVcSession({ ...FIELDS, start: "23:58", date: "2026-10-30", link: "https://us02web.zoom.us/j/3" });
  const at = Date.parse("2026-10-31T00:03:00+07:00");
  assert.equal(await maybeSendVcReminders(at), 1);
});

test("teks: tanpa sandi/tiket tidak ada baris kosong; nama bermarkdown di-escape", () => {
  const text = buildReminderText({ ...FIELDS, passcode: null, tickets: null, name: "A*B JKT48" }, START);
  assert.ok(!/Sandi|tiket/.test(text));
  assert.ok(text.includes("A\\*B"));
});
