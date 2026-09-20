require("./helpers/setupTestEnv");
// Override abis setupTestEnv (yang sengaja ngosongin ini) - dites di sini
// biar isOwner/handleAddPriority/handleRemovePriority's gate ke owner bisa
// diverifikasi beneran. Harus di-set SEBELUM require apapun yang nembus ke
// config.js (termasuk require("../src/chat/replies") di bawah).
process.env.PRIORITY_PING_USER_ID = "owner-id-replies-test";

const fs = require("fs");
const path = require("path");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { getTodayWIB } = require("../src/utils");
const { tempCacheDir } = require("./helpers/setupTestEnv");
const { activeLives } = require("../src/storage/activeLives");
const { recordLiveEnded } = require("../src/storage/dailyLog");
const { saveDurationHistory } = require("../src/storage/durationHistory");
const { recordLiveCompleted } = require("../src/storage/liveCount");
const {
  buildRecapTablePage,
  getTodaySessionsForRecap,
  replyMemberStats,
  replyLiveCount,
  replySchedulePattern,
  replyPriorityList,
  handleSubscribe,
  handleUnsubscribe,
  isOwner,
  handleAddPriority,
  handleRemovePriority,
} = require("../src/chat/replies");

// daily-log.json's jsonStore caches in-memory for the whole life of this
// test FILE (same reasoning as tests/dailyLog.test.js), and every other
// test above accumulates sessions into it too - so replyRecapRange's own
// tests (which assert on exact totals, not just "does this one username
// show up") need a truly clean store, not just unique usernames. Clears
// BOTH storage/dailyLog's AND chat/replies's require cache (replies.js
// captures its own reference to dailyLog's functions at require-time, so
// resetting only dailyLog's cache wouldn't be enough - replies.js would
// still be holding the stale one) and re-requires both fresh.
const DAILYLOG_MODULE_PATH = require.resolve("../src/storage/dailyLog");
const REPLIES_MODULE_PATH = require.resolve("../src/chat/replies");
const DAILY_LOG_FILE = path.join(tempCacheDir, "daily-log.json");

function freshRepliesForRecapRange() {
  delete require.cache[DAILYLOG_MODULE_PATH];
  delete require.cache[REPLIES_MODULE_PATH];
  try {
    fs.unlinkSync(DAILY_LOG_FILE);
  } catch {
    // wajar kalau belum pernah ada file-nya
  }
  const dailyLog = require("../src/storage/dailyLog");
  const replies = require("../src/chat/replies");
  return {
    recordLiveEnded: dailyLog.recordLiveEnded,
    replyRecapRange: replies.replyRecapRange,
    tryHandleRecapPageShortcut: replies.tryHandleRecapPageShortcut,
  };
}

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

test("replyLiveCount - total hitungan live (beda dari replyMemberStats yang dibatesin 10 data terakhir)", () => {
  // Sengaja BUKAN nama yang diawali "live" (mis. "livecounttest") - kata
  // "live" sendiri bisa fuzzy-match ke nama kayak gitu lewat prefix match di
  // matchesNameFragment, dan bikin test "belum ada catatan" di bawah
  // (fragment-nya ngandung kata "live") ketuker nyantol ke sini.
  recordLiveCompleted("jkt48_hitungtest", "Hitungtest");
  recordLiveCompleted("jkt48_hitungtest", "Hitungtest");
  recordLiveCompleted("jkt48_hitungtest", "Hitungtest");

  const reply = replyLiveCount("hitungtest");
  assert.match(reply, /\*\*Hitungtest\*\* udah live \*\*3x\*\*/);
});

test("replyLiveCount - belum ada catatan sama sekali", () => {
  assert.match(replyLiveCount("member-tanpa-live-sama-sekali"), /belum ada catatan live/);
});

test("replyLiveCount - fragment kosong nanya nama duluan", () => {
  assert.match(replyLiveCount(""), /Live count siapa\?/);
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

test("replyRecapRange - belum ada live yang kecatet dalam rentang itu", async () => {
  const { replyRecapRange: freshReplyRecapRange } = freshRepliesForRecapRange();
  const reply = await freshReplyRecapRange(7, "minggu ini (kosong)", "c-range-empty", "u-range-empty");
  assert.match(reply, /belum ada live yang kecatet dalam minggu ini \(kosong\)/);
});

test("replyRecapRange - agregasi sesi dalam rentang waktu, TANPA gabung activeLives (beda dari rekap hari ini)", async () => {
  const { recordLiveEnded: freshRecordLiveEnded, replyRecapRange: freshReplyRecapRange } = freshRepliesForRecapRange();

  const now = Date.now();
  const threeDaysAgo = new Date(now - 3 * 24 * 60 * 60 * 1000);
  freshRecordLiveEnded("Nala", "jkt48_rangetest1", new Date(threeDaysAgo.getTime() - 3600_000), threeDaysAgo, 50);
  freshRecordLiveEnded("Levi", "jkt48_rangetest2", new Date(threeDaysAgo.getTime() - 1800_000), new Date(threeDaysAgo.getTime() + 60_000), 30);

  // Member yang LAGI live sekarang - harus TETEP GAK IKUT ke rekap rentang
  // (bukan "hari ini", jendela waktu yang udah tertutup).
  activeLives.set("jkt48_rangetest_ongoing", {
    name: "Rangetestongoing",
    username: "jkt48_rangetest_ongoing",
    slug: "s",
    liveAt: new Date().toISOString(),
  });

  try {
    const reply = await freshReplyRecapRange(7, "minggu ini", "c-range", "u-range");
    assert.match(reply, /Rekap minggu ini/);
    assert.match(reply, /Total sesi: 2x dari 2 member/);
    assert.doesNotMatch(reply, /Rangetestongoing/);
  } finally {
    activeLives.delete("jkt48_rangetest_ongoing");
  }
});

// Bug yang dilaporin user: "rekap minggu ini" cuma nunjukkin beberapa hari
// terakhir walau bot udah jalan lebih dari 7 hari - ternyata BUKAN bug
// filter (getCompletedSessionsSince beneran benar), tapi arsip multi-harinya
// sendiri baru mulai kecatet belakangan (lihat git history: dailyLog.js
// dulu reset session-nya TIAP HARI sampai ditulis ulang jadi arsip
// beneran). Fix-nya bukan "benerin filter" (gak ada yang salah), tapi
// nambahin catatan yang jujur ngejelasin kenapa rentangnya keliatan pendek.
test("replyRecapRange - arsip belum nyakup rentang penuh -> dikasih catatan penjelasan, BUKAN diem-diem kayak bug", async () => {
  const { recordLiveEnded: freshRecordLiveEnded, replyRecapRange: freshReplyRecapRange } = freshRepliesForRecapRange();

  const now = Date.now();
  const threeDaysAgo = new Date(now - 3 * 24 * 60 * 60 * 1000);
  // Arsip cuma punya data dari 3 hari lalu - user minta rekap 7 hari, jadi
  // 4 hari paling awal dari rentang itu emang beneran gak ada datanya.
  freshRecordLiveEnded("Nala", "jkt48_shortarchive", new Date(threeDaysAgo.getTime() - 3600_000), threeDaysAgo, 50);

  const reply = await freshReplyRecapRange(7, "minggu ini", "c-shortarchive", "u-shortarchive");
  assert.match(reply, /pencatatan multi-hari baru mulai/);
});

test("replyRecapRange - arsip UDAH nyakup rentang penuh -> TANPA catatan penjelasan", async () => {
  const { recordLiveEnded: freshRecordLiveEnded, replyRecapRange: freshReplyRecapRange } = freshRepliesForRecapRange();

  const now = Date.now();
  // Sesi PALING TUA di arsip lebih tua dari rentang 7 hari yang diminta
  // (10 hari lalu) - walau sesi ini sendiri gak ikut kehitung di rekap
  // 7-harinya, KEBERADAANNYA nunjukkin arsip udah nyakup penuh, jadi gak
  // perlu ada catatan "belum penuh".
  const tenDaysAgo = new Date(now - 10 * 24 * 60 * 60 * 1000);
  const twoDaysAgo = new Date(now - 2 * 24 * 60 * 60 * 1000);
  freshRecordLiveEnded("Old", "jkt48_fullarchive_old", new Date(tenDaysAgo.getTime() - 3600_000), tenDaysAgo, 5);
  freshRecordLiveEnded("Recent", "jkt48_fullarchive_recent", new Date(twoDaysAgo.getTime() - 3600_000), twoDaysAgo, 50);

  const reply = await freshReplyRecapRange(7, "minggu ini", "c-fullarchive", "u-fullarchive");
  assert.doesNotMatch(reply, /pencatatan multi-hari baru mulai/);
});

// Bug yang dilaporin owner: "list-nya gak bisa dimundurin ya, kembali ke
// halaman sebelumnya gitu?" - sebelumnya cuma ada navigasi MAJU ("y" buat
// halaman berikutnya), dan begitu nyampe halaman TERAKHIR, pending state-nya
// gak kebentuk sama sekali (nextPage-based, cuma diset pas hasMore true) -
// jadi user yang lagi di halaman terakhir gak punya cara balik ke halaman
// sebelumnya. Sekarang pending state-nya nyimpen currentPage dan tetep ada
// selama totalPages > 1, jadi bisa mundur dari halaman manapun termasuk
// yang terakhir.
test("tryHandleRecapPageShortcut - bisa maju ('y') DAN mundur ('mundur') bolak-balik antar halaman", async () => {
  const { recordLiveEnded: freshRecordLiveEnded, replyRecapRange: freshReplyRecapRange, tryHandleRecapPageShortcut } = freshRepliesForRecapRange();

  const now = Date.now();
  const threeDaysAgo = Math.floor(now / 1000) - 3 * 24 * 60 * 60;
  // 25 sesi -> 2 halaman (RECAP_TABLE_PAGE_SIZE = 20).
  for (let i = 0; i < 25; i++) {
    freshRecordLiveEnded(
      `Member${i}`,
      `jkt48_pagetest${i}`,
      new Date((threeDaysAgo + i * 60) * 1000),
      new Date((threeDaysAgo + i * 60 + 30) * 1000),
      5,
    );
  }

  const channelId = "c-pagetest";
  const authorId = "u-pagetest";

  const page0 = await freshReplyRecapRange(7, "minggu ini", channelId, authorId);
  assert.match(page0, /Halaman 1\/2/);
  assert.match(page0, /mau liat halaman berikutnya\? Balas "y"/);

  const page1 = await tryHandleRecapPageShortcut("y", channelId, authorId);
  assert.match(page1, /Halaman 2\/2/);
  assert.match(page1, /udah paling akhir\. Balas "mundur"/);

  // Coba maju lagi dari halaman terakhir - harus ditolak dengan sopan, BUKAN
  // dianggap gak ngerti (null) atau nge-crash.
  const pastLast = await tryHandleRecapPageShortcut("y", channelId, authorId);
  assert.match(pastLast, /udah halaman paling akhir/);

  // Mundur balik ke halaman 1.
  const backToPage0 = await tryHandleRecapPageShortcut("mundur", channelId, authorId);
  assert.match(backToPage0, /Halaman 1\/2/);
  assert.match(backToPage0, /mau liat halaman berikutnya\? Balas "y"/);

  // Coba mundur lagi dari halaman pertama - harus ditolak dengan sopan juga.
  const pastFirst = await tryHandleRecapPageShortcut("mundur", channelId, authorId);
  assert.match(pastFirst, /halaman pertama, gak bisa mundur lagi/);
});

// Owner minta "y" bisa diganti jadi kata yang lebih jelas kayak "maju"/
// "forward" - ditambahin sebagai ALTERNATIF (bukan gantiin "y", biar gak
// ngerusak kebiasaan lama).
test("tryHandleRecapPageShortcut - 'maju'/'forward' juga jalan buat ke halaman berikutnya (alternatif dari 'y')", async () => {
  const { recordLiveEnded: freshRecordLiveEnded, replyRecapRange: freshReplyRecapRange, tryHandleRecapPageShortcut } = freshRepliesForRecapRange();

  const now = Date.now();
  const threeDaysAgo = Math.floor(now / 1000) - 3 * 24 * 60 * 60;
  for (let i = 0; i < 45; i++) {
    freshRecordLiveEnded(`Fwd${i}`, `jkt48_fwdtest${i}`, new Date((threeDaysAgo + i * 60) * 1000), new Date((threeDaysAgo + i * 60 + 30) * 1000), 5);
  }

  const channelId = "c-fwdtest";
  const authorId = "u-fwdtest";

  const page0 = await freshReplyRecapRange(7, "minggu ini", channelId, authorId);
  assert.match(page0, /Halaman 1\/3/);

  const page1 = await tryHandleRecapPageShortcut("maju", channelId, authorId);
  assert.match(page1, /Halaman 2\/3/);

  const page2 = await tryHandleRecapPageShortcut("forward", channelId, authorId);
  assert.match(page2, /Halaman 3\/3/);
});

test("tryHandleRecapPageShortcut - 'n' tetep ngebatalin navigasi sepenuhnya (beda dari 'mundur')", async () => {
  const { recordLiveEnded: freshRecordLiveEnded, replyRecapRange: freshReplyRecapRange, tryHandleRecapPageShortcut } = freshRepliesForRecapRange();

  const now = Date.now();
  const threeDaysAgo = Math.floor(now / 1000) - 3 * 24 * 60 * 60;
  for (let i = 0; i < 25; i++) {
    freshRecordLiveEnded(
      `Batal${i}`,
      `jkt48_stoptest${i}`,
      new Date((threeDaysAgo + i * 60) * 1000),
      new Date((threeDaysAgo + i * 60 + 30) * 1000),
      5,
    );
  }

  const channelId = "c-stoptest";
  const authorId = "u-stoptest";
  await freshReplyRecapRange(7, "minggu ini", channelId, authorId);

  const stopped = await tryHandleRecapPageShortcut("n", channelId, authorId);
  assert.match(stopped, /segitu aja ya/);

  // Pending state-nya harus udah kehapus - "y" abis "n" gak boleh dianggep lanjut halaman lagi.
  const afterStop = await tryHandleRecapPageShortcut("y", channelId, authorId);
  assert.equal(afterStop, null);
});
