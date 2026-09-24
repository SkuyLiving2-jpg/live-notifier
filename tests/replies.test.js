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
  replyLiveCountLeaderboard,
  replySchedulePattern,
  replyPriorityList,
  replySpecificMember,
  replyHelp,
  handleSubscribe,
  handleUnsubscribe,
  isOwner,
  handleAddPriority,
  handleRemovePriority,
  handleRecapNavButton,
  handleRecapSearchModalSubmit,
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
    handleRecapNavButton: replies.handleRecapNavButton,
    handleRecapSearchModalSubmit: replies.handleRecapSearchModalSubmit,
  };
}

// Fake discord.js interaction - sama pola kayak tests/menu.test.js's
// fakeInteraction, handleRecapNavButton/handleRecapSearchModalSubmit cuma
// pernah nyentuh .customId/.channelId/.user.id/.reply()/.showModal()/
// .fields.getTextInputValue(), jadi gak butuh library mocking discord.js beneran.
function fakeInteraction({ customId, channelId = "c-recapbtn", authorId = "u-recapbtn", fieldValue = "" } = {}) {
  const calls = [];
  const modals = [];
  return {
    customId,
    channelId,
    user: { id: authorId },
    fields: { getTextInputValue: () => fieldValue },
    reply: async (payload) => calls.push(payload),
    showModal: async (modal) => modals.push(modal),
    calls,
    modals,
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

  assert.match(text, /Nala.*22\.50\.00 WIB \(\d{2}\/\d{2}\)/);
  assert.match(text, /Levi.*10\.00\.00 WIB(?! \()/); // Levi TANPA tanda kurung tanggal
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

// Nama membernya sengaja unik (bukan dipake test lain di file ini) - file
// ini numpuk state live-count.json lintas test (gak ada fresh-reset kayak
// tests/liveCount.test.js's freshLiveCount()), jadi assert-nya fokus ke
// URUTAN RELATIF dua entry ini doang, bukan "siapa persis di posisi 1"
// (yang bisa keganggu count dari test lain di file yang sama).
test("replyLiveCountLeaderboard - diurutin dari yang paling sering live, format sesuai count-nya", () => {
  for (let i = 0; i < 5; i++) recordLiveCompleted("jkt48_leaderboardtest_a", "LeaderboardTestA");
  for (let i = 0; i < 3; i++) recordLiveCompleted("jkt48_leaderboardtest_b", "LeaderboardTestB");

  const reply = replyLiveCountLeaderboard();
  const posA = reply.indexOf("LeaderboardTestA");
  const posB = reply.indexOf("LeaderboardTestB");
  assert.ok(posA !== -1 && posB !== -1, "dua-duanya harus muncul di leaderboard");
  assert.ok(posA < posB, "yang count-nya lebih banyak (5x) harus muncul LEBIH DULU dari yang lebih sedikit (3x)");
  assert.match(reply, /LeaderboardTestA\*\* - 5x live/);
  assert.match(reply, /LeaderboardTestB\*\* - 3x live/);
});

test("replySpecificMember - liveAt normal nyantumin jam mulai & elapsed time", () => {
  const entry = {
    name: "JamTest",
    username: "jkt48_jamtest",
    slug: "slug-jamtest",
    liveAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    viewCount: 42,
  };
  const reply = replySpecificMember(entry);
  assert.match(reply, /\*\*JamTest\*\* lagi live/);
  assert.match(reply, /mulai jam \d{2}\.\d{2}\.\d{2} WIB/);
});

// Regresi: entry.liveAt datang mentah dari live_at API IDN (idnApi.js gak
// validasi format-nya) - formatClockWIB() (Intl.DateTimeFormat) THROW kalau
// dikasih Invalid Date, beda dari formatDuration/describeElapsed yang cuma
// ngasih teks "NaN" kalau dikasih angka aneh. Tanpa validasi ini, "cok siapa
// yang live <nama>" bakal gagal total (gak ada balesan sama sekali, ke-catch
// diem-diem sama router.js's try/catch) kalau live_at member itu kebetulan
// rusak. Sama kelas bug yang ketemu di notify/liveNotify.js's sendDiscordNotif.
test("replySpecificMember - liveAt RUSAK (bukan tanggal valid) gak bikin throw, jam mulai cuma di-skip dari balesan", () => {
  const entry = {
    name: "RusakTest",
    username: "jkt48_rusaktest",
    slug: "slug-rusaktest",
    liveAt: "bukan-tanggal-valid",
    viewCount: 10,
  };
  assert.doesNotThrow(() => replySpecificMember(entry));
  const reply = replySpecificMember(entry);
  assert.match(reply, /\*\*RusakTest\*\* lagi live/);
  assert.doesNotMatch(reply, /mulai jam/, "jam mulai harus di-skip, bukan dipaksain nampilin data rusak");
});

test("replySpecificMember - liveAt null (member ada tapi belum sempet kecatet jam mulainya) gak throw juga", () => {
  const entry = { name: "NullTest", username: "jkt48_nulltest", slug: "slug-nulltest", liveAt: null, viewCount: null };
  assert.doesNotThrow(() => replySpecificMember(entry));
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

// Tip notification settings - dilaporin owner kalau notif "kadang gak
// langsung keluar/gak muncul", ketauan kemungkinan besar penyebabnya
// setting channel Discord ("Only @mentions" ngeblokir notif live biasa yang
// emang gak nge-tag siapa-siapa), bukan bug di bot. Ditambahin ke
// replyHelp() biar user nemu sendiri jawabannya tanpa perlu nanya owner.
test("replyHelp - nyantumin tips soal setting notifikasi channel (All Messages vs Only @mentions)", () => {
  const reply = replyHelp();
  assert.match(reply, /All Messages/);
  assert.match(reply, /Only @mentions/);
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
    assert.match(reply.content, /Rekap minggu ini/);
    assert.match(reply.content, /Total sesi: 2x dari 2 member/);
    assert.doesNotMatch(reply.content, /Rangetestongoing/);
    assert.ok(reply.components, "sesi ada -> harus ada tombol navigasi/tutup/cari member");
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
  assert.match(reply.content, /pencatatan multi-hari baru mulai/);
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
  assert.doesNotMatch(reply.content, /pencatatan multi-hari baru mulai/);
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
  assert.match(page0.content, /Halaman 1\/2/);
  // Halaman PERTAMA dari 2 (bukan halaman terakhir juga) - cuma "Maju" +
  // "Tutup rekap" + "Cari member", TANPA "Mundur" (sesuai spek: gak ada
  // halaman sebelumnya buat dibalik).
  const page0CustomIds = page0.components[0].components.map((b) => b.data.custom_id);
  assert.deepEqual(page0CustomIds, ["recap_nav:next:7:0", "recap_nav:close", "recap_nav:search:7"]);

  const page1 = await tryHandleRecapPageShortcut("y", channelId, authorId);
  assert.match(page1.content, /Halaman 2\/2/);
  // Halaman TERAKHIR (dari 2) - cuma "Mundur" + "Tutup rekap" + "Cari
  // member", TANPA "Maju" (gak ada halaman berikutnya).
  const page1CustomIds = page1.components[0].components.map((b) => b.data.custom_id);
  assert.deepEqual(page1CustomIds, ["recap_nav:prev:7:1", "recap_nav:close", "recap_nav:search:7"]);

  // Coba maju lagi dari halaman terakhir - harus ditolak dengan sopan, BUKAN
  // dianggap gak ngerti (null) atau nge-crash.
  const pastLast = await tryHandleRecapPageShortcut("y", channelId, authorId);
  assert.match(pastLast, /udah halaman paling akhir/);

  // Mundur balik ke halaman 1.
  const backToPage0 = await tryHandleRecapPageShortcut("mundur", channelId, authorId);
  assert.match(backToPage0.content, /Halaman 1\/2/);

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
  assert.match(page0.content, /Halaman 1\/3/);

  const page1 = await tryHandleRecapPageShortcut("maju", channelId, authorId);
  assert.match(page1.content, /Halaman 2\/3/);
  // Halaman TENGAH (2 dari 3, bukan pertama/terakhir) - ketiga tombol nav
  // sekaligus muncul: "Maju", "Mundur", DAN "Tutup rekap" (+ "Cari member").
  const page1CustomIds = page1.components[0].components.map((b) => b.data.custom_id);
  assert.deepEqual(page1CustomIds, ["recap_nav:next:7:1", "recap_nav:prev:7:1", "recap_nav:close", "recap_nav:search:7"]);

  const page2 = await tryHandleRecapPageShortcut("forward", channelId, authorId);
  assert.match(page2.content, /Halaman 3\/3/);
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

// Fitur "buatkan fungsi button buat rekap" yang diminta owner - dulu maju/
// mundur/tutup CUMA bisa lewat ngetik ("y"/"mundur"/"n", dites di atas),
// padahal infrastruktur tombol Discord udah dipake fitur lain. Beda dari
// tryHandleRecapPageShortcut (nunggu balesan TEKS abis halaman TERAKHIR
// ditampilin), handleRecapNavButton nyimpen SEMUA konteksnya sendiri di
// customId (self-contained), jadi dites langsung lewat customId-nya, bukan
// lewat urutan chat kayak di atas.
test("handleRecapNavButton - action 'next'/'prev' render ulang halaman sesuai target di customId, allowedMentions ke-set", async () => {
  const now = Date.now();
  const threeDaysAgo = Math.floor(now / 1000) - 3 * 24 * 60 * 60;
  for (let i = 0; i < 25; i++) {
    recordLiveEnded(`Navbtn${i}`, `jkt48_navbtntest${i}`, new Date((threeDaysAgo + i * 60) * 1000), new Date((threeDaysAgo + i * 60 + 30) * 1000), 5);
  }

  // "recap_nav:next:7:0" - lagi di halaman 0 (index), diklik "Maju" -> harus
  // render halaman 1 (index), bukan halaman 0 lagi.
  const next = fakeInteraction({ customId: "recap_nav:next:7:0" });
  await handleRecapNavButton(next);
  assert.match(next.calls[0].content, /Halaman 2\/2/);
  assert.deepEqual(next.calls[0].allowedMentions, { parse: [] });

  // "recap_nav:prev:7:1" - lagi di halaman 1 (index), diklik "Mundur" ->
  // harus render halaman 0 (index) lagi.
  const prev = fakeInteraction({ customId: "recap_nav:prev:7:1" });
  await handleRecapNavButton(prev);
  assert.match(prev.calls[0].content, /Halaman 1\/2/);
});

test("handleRecapNavButton - action 'close' balesin ucapan terima kasih, gak butuh konteks range/page sama sekali", async () => {
  const interaction = fakeInteraction({ customId: "recap_nav:close" });
  await handleRecapNavButton(interaction);
  assert.match(interaction.calls[0].content, /Terima kasih, enjoy ya, cok/);
});

// Abis "tutup rekap" diklik, jawaban "y"/"mundur" yang nyasar berikutnya
// (misal orangnya lupa) gak boleh diem-diem nerusin ke halaman yang udah
// "ditutup" - handleRecapNavButton's close branch harus bersihin
// pendingRecapPage yang sama persis dipake tryHandleRecapPageShortcut.
// Butuh module INSTANCE yang sama (freshRepliesForRecapRange), soalnya
// pendingRecapPage itu state module-level yang gak di-share ke require
// biasa di atas file ini.
test("handleRecapNavButton - action 'close' nge-clear pendingRecapPage, jadi 'y' abis itu gak lanjut halaman lagi", async () => {
  const {
    recordLiveEnded: freshRecordLiveEnded,
    replyRecapRange: freshReplyRecapRange,
    tryHandleRecapPageShortcut: freshTryHandleRecapPageShortcut,
    handleRecapNavButton: freshHandleRecapNavButton,
  } = freshRepliesForRecapRange();

  const now = Date.now();
  const threeDaysAgo = Math.floor(now / 1000) - 3 * 24 * 60 * 60;
  for (let i = 0; i < 25; i++) {
    freshRecordLiveEnded(
      `Close${i}`,
      `jkt48_closetest${i}`,
      new Date((threeDaysAgo + i * 60) * 1000),
      new Date((threeDaysAgo + i * 60 + 30) * 1000),
      5,
    );
  }

  const channelId = "c-closebtn";
  const authorId = "u-closebtn";
  await freshReplyRecapRange(7, "minggu ini", channelId, authorId); // nge-set pendingRecapPage

  const closeInteraction = fakeInteraction({ customId: "recap_nav:close", channelId, authorId });
  await freshHandleRecapNavButton(closeInteraction);
  assert.match(closeInteraction.calls[0].content, /Terima kasih, enjoy ya, cok/);

  const afterClose = await freshTryHandleRecapPageShortcut("y", channelId, authorId);
  assert.equal(afterClose, null, "pendingRecapPage harus udah kehapus abis 'tutup rekap' diklik");
});

test("handleRecapNavButton - action 'search' munculin modal (showModal), BUKAN balesan biasa (reply)", async () => {
  const interaction = fakeInteraction({ customId: "recap_nav:search:7" });
  await handleRecapNavButton(interaction);
  assert.equal(interaction.calls.length, 0, "search gak boleh manggil reply() - munculin modal doang");
  assert.equal(interaction.modals.length, 1);
  assert.equal(interaction.modals[0].data.custom_id, "recap_search_modal:7");
});

test("handleRecapSearchModalSubmit - nama ketemu -> tabel hasil filter cuma nunjukkin sesi member itu", async () => {
  const now = Date.now();
  const threeDaysAgo = Math.floor(now / 1000) - 3 * 24 * 60 * 60;
  recordLiveEnded("Searchtarget", "jkt48_searchtarget", new Date(threeDaysAgo * 1000), new Date((threeDaysAgo + 60) * 1000), 5);
  recordLiveEnded("Searchother", "jkt48_searchother", new Date(threeDaysAgo * 1000), new Date((threeDaysAgo + 60) * 1000), 5);

  const interaction = fakeInteraction({ customId: "recap_search_modal:7", fieldValue: "searchtarget" });
  await handleRecapSearchModalSubmit(interaction);
  assert.match(interaction.calls[0].content, /Hasil cari "searchtarget"/);
  assert.match(interaction.calls[0].content, /Searchtarget/);
  assert.doesNotMatch(interaction.calls[0].content, /Searchother/);
});

test("handleRecapSearchModalSubmit - nama gak ketemu -> pesan gak ketemu, bukan tabel kosong", async () => {
  const interaction = fakeInteraction({ customId: "recap_search_modal:7", fieldValue: "member-yang-beneran-gak-ada-di-rekap" });
  await handleRecapSearchModalSubmit(interaction);
  assert.match(interaction.calls[0].content, /gak nemu member "member-yang-beneran-gak-ada-di-rekap"/);
});

// rangeDays "today" (rekap harian) beda encoding dari angka (mingguan/
// bulanan) di customId - dites biar gak ketuker gara-gara nyari sesi dari
// sumber yang salah (getTodaySessionsForRecap vs getCompletedSessionsSince).
test("handleRecapSearchModalSubmit - range 'today' nyari dari getTodaySessionsForRecap (gabungan sesi selesai + lagi live), bukan getCompletedSessionsSince", async () => {
  activeLives.set("jkt48_searchtoday", { name: "Searchtoday", username: "jkt48_searchtoday", slug: "s", liveAt: new Date().toISOString() });
  try {
    const interaction = fakeInteraction({ customId: "recap_search_modal:today", fieldValue: "searchtoday" });
    await handleRecapSearchModalSubmit(interaction);
    assert.match(interaction.calls[0].content, /Searchtoday/);
  } finally {
    activeLives.delete("jkt48_searchtoday");
  }
});
