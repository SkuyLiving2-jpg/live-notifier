require("./helpers/setupTestEnv");

const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const {
  loadVc,
  saveVc,
  defaultVcTitle,
  addVcSession,
  getVcSession,
  updateVcSession,
  removeVcSession,
  setVcNickname,
  resetVcPeriod,
} = require("../src/storage/vcSchedule");
const { getRegisteredStore } = require("../src/storage/jsonStore");
const { SECTIONS, planRestore, buildBackupSnapshot } = require("../src/backup");
const { getTodayWIB, formatMonthLabel } = require("../src/utils");

const store = () => getRegisteredStore("vc-schedule.json").store;
const FIELDS = {
  username: "jkt48_lily",
  name: "Lily JKT48",
  session: 1,
  date: "2026-10-18",
  open: "12:45",
  start: "13:00",
  tickets: null,
  link: "https://zoom.us/j/81331441967",
  passcode: null,
  note: "n",
};

beforeEach(() => store().save({ title: null, opener: null, sessions: [], nicknames: {}, nextId: 1, message: null }));

test("defaultVcTitle - 'VC <Bulan> <Tahun>' bulan berjalan WIB", () => {
  assert.equal(defaultVcTitle(), `VC ${formatMonthLabel(getTodayWIB().slice(0, 7))}`);
  assert.match(defaultVcTitle(), /^VC [A-Z][a-z]+ \d{4}$/);
});

test("addVcSession - id unik bertambah, tersimpan; id tidak dipakai ulang walau sesi dihapus", () => {
  const a = addVcSession(FIELDS);
  const b = addVcSession({ ...FIELDS, session: 2 });
  assert.deepEqual([a.id, b.id], [1, 2]);
  assert.equal(removeVcSession(b.id), true);
  const c = addVcSession({ ...FIELDS, session: 3 });
  assert.equal(c.id, 3, "id 2 tidak dipakai ulang (tombol lama di Discord tidak boleh menunjuk sesi lain)");
  assert.deepEqual(
    loadVc().sessions.map((s) => s.id),
    [1, 3],
  );
});

test("getVcSession / updateVcSession / removeVcSession - id bisa angka atau string; id tidak ada -> null/false", () => {
  const a = addVcSession(FIELDS);
  assert.equal(getVcSession(String(a.id)).name, "Lily JKT48");
  assert.equal(updateVcSession(a.id, { session: 9 }).session, 9);
  assert.equal(getVcSession(a.id).session, 9);
  assert.equal(getVcSession(999), null);
  assert.equal(updateVcSession(999, { session: 1 }), null);
  assert.equal(removeVcSession(999), false);
  assert.equal(removeVcSession(String(a.id)), true);
  assert.equal(getVcSession(a.id), null);
});

test("setVcNickname - set, timpa, dan hapus (teks kosong/null)", () => {
  setVcNickname("jkt48_lily", "Cece");
  assert.equal(loadVc().nicknames.jkt48_lily, "Cece");
  setVcNickname("jkt48_lily", "Cece Baru");
  assert.equal(loadVc().nicknames.jkt48_lily, "Cece Baru");
  setVcNickname("jkt48_lily", null);
  assert.deepEqual(loadVc().nicknames, {});
  setVcNickname("jkt48_lily", "");
  assert.deepEqual(loadVc().nicknames, {});
});

test("resetVcPeriod - sesi kosong, judul bawaan, pembuka baru; julukan dan referensi pesan rangkuman TETAP", () => {
  addVcSession(FIELDS);
  setVcNickname("jkt48_lily", "Cece");
  const data = loadVc();
  data.title = "Judul Lama";
  data.message = { channelId: "dm-1", ids: ["m1"] };
  saveVc(data);

  const after = resetVcPeriod("Pembuka baru.");
  assert.deepEqual(after.sessions, []);
  assert.equal(after.title, defaultVcTitle());
  assert.equal(after.opener, "Pembuka baru.");
  assert.deepEqual(after.nicknames, { jkt48_lily: "Cece" });
  assert.deepEqual(after.message, { channelId: "dm-1", ids: ["m1"] });
});

test("loadVc - file rusak/diedit tangan: bentuk dipaksa lengkap (tidak melempar)", () => {
  const cases = [
    { sessions: "bukan array", nicknames: [], nextId: "x", title: 5, opener: {}, message: { ids: "x" } },
    {},
    { sessions: [{ id: 7 }, { id: 3 }] },
  ];
  for (const raw of cases) {
    store().save(raw);
    const v = loadVc();
    assert.ok(Array.isArray(v.sessions));
    assert.ok(v.nicknames && typeof v.nicknames === "object" && !Array.isArray(v.nicknames));
    assert.ok(Number.isInteger(v.nextId) && v.nextId >= 1);
    assert.ok(v.title === null || typeof v.title === "string");
    assert.ok(v.opener === null || typeof v.opener === "string");
    assert.ok(v.message === null || Array.isArray(v.message.ids));
  }
  store().save({ sessions: [{ id: 7 }, { id: 3 }] });
  assert.equal(loadVc().nextId, 8, "nextId dipulihkan dari id terbesar yang ada");

  store().save(["bukan", "object"]);
  assert.deepEqual(loadVc().sessions, []);
  store().save(null);
  assert.deepEqual(loadVc().sessions, []);
});

test("backup: vcSchedule ikut di snapshot (termasuk link) dan bisa dipulihkan; bentuk salah ditolak seluruhnya", () => {
  addVcSession(FIELDS);
  setVcNickname("jkt48_lily", "Cece");
  assert.ok(SECTIONS.some((s) => s.key === "vcSchedule"));

  const snapshot = buildBackupSnapshot();
  assert.equal(snapshot.vcSchedule.sessions[0].link, FIELDS.link);
  const plan = planRestore(JSON.parse(JSON.stringify({ vcSchedule: snapshot.vcSchedule })));
  assert.deepEqual(plan.invalid, []);
  assert.equal(plan.sections[0].incoming, "1 sesi", "pratinjau restore menampilkan jumlah sesi, bukan jumlah kunci");

  const bad = [
    { sessions: "x" },
    { sessions: [{ id: "1", name: "x", session: 1, date: "d", open: "12:00", start: "13:00", link: "l" }] },
    { sessions: [{ id: 1, name: "x", session: 1, date: "d", open: "12.00", start: "13:00", link: "l" }] },
    { sessions: [{ id: 1, name: "x", session: 1, date: "d", open: "12:00", start: "13:00" }] },
    { sessions: [], nicknames: { a: 5 } },
  ];
  for (const vc of bad) assert.equal(planRestore({ vcSchedule: vc }).invalid.length, 1, JSON.stringify(vc).slice(0, 60));
  assert.deepEqual(planRestore({ vcSchedule: { sessions: [], nicknames: {} } }).invalid, [], "periode kosong valid (volume baru)");
});

test("backup mingguan lewat DM: data VC (berisi link Zoom) ikut karena DM itu privat milik owner, tapi tetap bukan 'secret' seperti webhook", () => {
  const section = SECTIONS.find((s) => s.key === "vcSchedule");
  assert.notEqual(section.secret, true);
  addVcSession(FIELDS);
  assert.ok(buildBackupSnapshot({ excludeSecrets: true }).vcSchedule.sessions.length === 1);
});
