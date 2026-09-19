require("./helpers/setupTestEnv");
// Override abis setupTestEnv (yang sengaja ngosongin ini) - dites di sini
// biar isOwner/handleAddPriority/handleRemovePriority's gate ke owner bisa
// diverifikasi beneran. Harus di-set SEBELUM require apapun yang nembus ke
// config.js (termasuk require("../src/chat/replies") di bawah).
process.env.PRIORITY_PING_USER_ID = "owner-id-replies-test";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { getTodayWIB } = require("../src/utils");
const { activeLives } = require("../src/storage/activeLives");
const { recordLiveEnded } = require("../src/storage/dailyLog");
const { saveDurationHistory } = require("../src/storage/durationHistory");
const {
  buildRecapTablePage,
  getTodaySessionsForRecap,
  replyMemberStats,
  replySchedulePattern,
  replyPriorityList,
  handleSubscribe,
  handleUnsubscribe,
  isOwner,
  handleAddPriority,
  handleRemovePriority,
} = require("../src/chat/replies");

function unixAt(dateWIB, timeHHMM) {
  return Math.floor(new Date(`${dateWIB}T${timeHHMM}:00+07:00`).getTime() / 1000);
}

function yesterdayWIB() {
  const d = new Date(`${getTodayWIB()}T00:00:00+07:00`);
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

test("buildRecapTablePage - sesi yang nyebrang tengah malam dikasih penanda (DD/MM) di kolom Mulai", () => {
  const crossMidnight = {
    name: "Nala",
    startedAtUnix: unixAt(yesterdayWIB(), "22:50"),
    endedAtUnix: unixAt(getTodayWIB(), "00:39"),
    durationMs: 109 * 60_000,
  };
  const sameDay = {
    name: "Levi",
    startedAtUnix: unixAt(getTodayWIB(), "10:00"),
    endedAtUnix: unixAt(getTodayWIB(), "11:00"),
    durationMs: 60 * 60_000,
  };

  const { text } = buildRecapTablePage([crossMidnight, sameDay], 0);

  assert.match(text, /Nala.*22\.50 WIB \(\d{2}\/\d{2}\)/);
  assert.match(text, /Levi.*10\.00 WIB(?! \()/); // Levi TANPA tanda kurung tanggal
});

test("buildRecapTablePage - sesi diurutin ascending berdasarkan startedAtUnix, bukan urutan input", () => {
  const later = { name: "Lily", startedAtUnix: unixAt(getTodayWIB(), "20:00"), endedAtUnix: null, durationMs: null };
  const earlier = { name: "Nala", startedAtUnix: unixAt(getTodayWIB(), "08:00"), endedAtUnix: null, durationMs: null };

  const { text } = buildRecapTablePage([later, earlier], 0); // sengaja dibalik urutan inputnya

  const nalaIndex = text.indexOf("Nala");
  const lilyIndex = text.indexOf("Lily");
  assert.ok(nalaIndex < lilyIndex, "Nala (jam 08:00) harus muncul duluan sebelum Lily (jam 20:00)");
});

test("buildRecapTablePage - pagination: 25 sesi kepecah 2 halaman (20 per halaman)", () => {
  const sessions = Array.from({ length: 25 }, (_, i) => ({
    name: `Member${i}`,
    startedAtUnix: unixAt(getTodayWIB(), "01:00") + i * 60,
    endedAtUnix: null,
    durationMs: null,
  }));

  const page0 = buildRecapTablePage(sessions, 0);
  assert.equal(page0.totalPages, 2);
  assert.equal(page0.hasMore, true);
  // \d+ biar gak ikut kehitung "Member" di header kolom tabelnya sendiri
  assert.equal(page0.text.match(/Member\d+/g).length, 20);

  const page1 = buildRecapTablePage(sessions, 1);
  assert.equal(page1.hasMore, false);
  assert.equal(page1.text.match(/Member\d+/g).length, 5);
});

test("buildRecapTablePage - status Live (belum selesai) vs Selesai", () => {
  const ongoing = { name: "Nala", startedAtUnix: unixAt(getTodayWIB(), "09:00"), endedAtUnix: null, durationMs: null };
  const { text } = buildRecapTablePage([ongoing], 0);
  assert.match(text, /Nala\s*\|\s*Live/);
});

// getTodaySessionsForRecap() gabungin 2 sumber yang beda: sesi yang UDAH
// SELESAI hari ini (dari daily-log.json, lewat recordLiveEnded) SAMA yang
// MASIH LIVE SEKARANG (dari activeLives langsung) - ini persis fix buat bug
// yang dilaporin user ("member online tapi gak masuk rekap"), jadi dites
// langsung biar gak keulang lagi.
test("getTodaySessionsForRecap - gabungin sesi yang udah selesai hari ini SAMA yang masih live sekarang", () => {
  activeLives.clear();
  try {
    const now = new Date();
    recordLiveEnded("Levi", "jkt48_levi_test", new Date(now.getTime() - 3600_000), new Date(now.getTime() - 1800_000), 50);

    activeLives.set("jkt48_nala_test", {
      name: "Nala",
      username: "jkt48_nala_test",
      slug: "live-slug",
      liveAt: new Date(now.getTime() - 600_000).toISOString(),
      viewCount: 30,
      peakViewCount: 77,
    });

    const sessions = getTodaySessionsForRecap();
    const byUsername = Object.fromEntries(sessions.map((s) => [s.username, s]));

    assert.ok(byUsername["jkt48_levi_test"], "sesi yang udah selesai harus ikut");
    assert.notEqual(byUsername["jkt48_levi_test"].endedAtUnix, null);

    assert.ok(byUsername["jkt48_nala_test"], "member yang masih live SEKARANG harus ikut juga, bukan cuma yang udah selesai");
    assert.equal(byUsername["jkt48_nala_test"].endedAtUnix, null);
    assert.equal(byUsername["jkt48_nala_test"].peakViewCount, 77);
  } finally {
    activeLives.clear();
  }
});

test("replyMemberStats - rata-rata & rekor durasi dari riwayat", () => {
  saveDurationHistory({
    jkt48_statstest2: [
      { name: "Statstest2", durationMs: 60 * 60_000, at: "2026-06-01T21:00:00+07:00" },
      { name: "Statstest2", durationMs: 120 * 60_000, at: "2026-06-02T21:00:00+07:00" },
    ],
  });
  const reply = replyMemberStats("statstest2");
  assert.match(reply, /Statistik \*\*Statstest2\*\*/);
  assert.match(reply, /Rata-rata durasi: 1j 30m/); // rata-rata 60 & 120 menit
  assert.match(reply, /Rekor terlama: 2j 0m/);
});

test("replyMemberStats - belum ada riwayat sama sekali", () => {
  assert.match(replyMemberStats("member-tanpa-riwayat-sama-sekali"), /belum ada data riwayat live/);
});

test("replySchedulePattern - kurang dari 3 riwayat -> 'masih kurang', minimal 3 -> nebak pola jam", () => {
  saveDurationHistory({ jkt48_scheduletest: [{ name: "Scheduletest", durationMs: 3600_000, at: "2026-06-01T21:00:00+07:00" }] });
  assert.match(replySchedulePattern("scheduletest"), /masih kurang/);

  // 3 riwayat, semua mulai sekitar jam 20:00 WIB (durasi 1 jam, selesai jam 21:00) -> bucket "malam"
  saveDurationHistory({
    jkt48_scheduletest: [
      { name: "Scheduletest", durationMs: 3600_000, at: "2026-06-01T21:00:00+07:00" },
      { name: "Scheduletest", durationMs: 3600_000, at: "2026-06-08T21:00:00+07:00" },
      { name: "Scheduletest", durationMs: 3600_000, at: "2026-06-03T21:00:00+07:00" },
    ],
  });
  const reply = replySchedulePattern("scheduletest");
  assert.match(reply, /Paling sering \*\*malam\*\*/);
  assert.match(reply, /BUKAN jadwal resmi/);
});

test("replyPriorityList - urut rank, format '<rank>. **LABEL** (keyword: \"...\")'", () => {
  const reply = replyPriorityList();
  assert.match(reply, /1\. \*\*NALA\*\* \(keyword: "nala"\)/);
  assert.match(reply, /2\. \*\*LEVI\*\* \(keyword: "levi"\)/);
  assert.match(reply, /3\. \*\*LILY\*\* \(keyword: "lily"\)/);
});

test("handleSubscribe / handleUnsubscribe - validasi & pesan", () => {
  assert.match(handleSubscribe("ab", "u-subtest"), /kependekan/); // <3 huruf
  assert.match(handleSubscribe("subtest1", "u-subtest"), /Sip, kamu bakal di-tag/);
  assert.match(handleSubscribe("subtest1", "u-subtest"), /udah subscribe/); // subscribe 2x -> "already"

  assert.match(handleUnsubscribe("subtest1", "u-subtest"), /notif buat "subtest1" dimatiin/);
  assert.match(handleUnsubscribe("subtest1", "u-subtest"), /belum subscribe/); // unsubscribe 2x -> gak ketemu
});

test("isOwner / handleAddPriority / handleRemovePriority - gated ke PRIORITY_PING_USER_ID", () => {
  assert.equal(isOwner("owner-id-replies-test"), true);
  assert.equal(isOwner("bukan-owner"), false);

  assert.match(handleAddPriority("repliestestmember", "bukan-owner"), /cuma owner yang boleh/);
  assert.match(handleAddPriority("repliestestmember", "owner-id-replies-test"), /ditambahin ke daftar prioritas/);
  assert.match(handleRemovePriority("repliestestmember", "owner-id-replies-test"), /dihapus dari daftar prioritas/);
});
