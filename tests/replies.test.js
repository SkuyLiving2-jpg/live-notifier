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
const { getTodayWIB, getDateWIB, WEEKDAY_FORMATTER_WIB } = require("../src/utils");
const { tempCacheDir } = require("./helpers/setupTestEnv");
const { activeLives } = require("../src/storage/activeLives");
const { recordLiveEnded } = require("../src/storage/dailyLog");
const { saveDurationHistory } = require("../src/storage/durationHistory");
const { recordLiveCompleted } = require("../src/storage/liveCount");
const {
  buildRecapTablePage,
  buildRecapPageBlock,
  buildRecapDateSelectRow,
  getTodaySessionsForRecap,
  replyMemberStats,
  replyLiveCount,
  replyLiveCountLeaderboard,
  replyCompareMembers,
  replyCompareMembersByUsername,
  describeMissingMember,
  normalizeMemberFragment,
  replySchedulePattern,
  replyPriorityList,
  replySpecificMember,
  replyHelp,
  replyRecapMenu,
  replyRecapDatePicker,
  buildRecapMonthSelectRow,
  parseSpecificDateFromText,
  parseMonthOnlyFromText,
  parseWeekdayFromText,
  resolveStatRangeFromText,
  buildExportCsv,
  handleSubscribe,
  handleUnsubscribe,
  isOwner,
  handleAddPriority,
  handleRemovePriority,
  handleRecapNavButton,
  handleRecapSearchModalSubmit,
  handleRecapMenuButton,
  handleRecapDateSelect,
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
    handleRecapJumpModalSubmit: replies.handleRecapJumpModalSubmit,
    handleRecapMenuButton: replies.handleRecapMenuButton,
    handleRecapDateSelect: replies.handleRecapDateSelect,
    handleRecapMonthSelect: replies.handleRecapMonthSelect,
    buildRecapDateSelectRow: replies.buildRecapDateSelectRow,
    buildWeekdayDateSelectRow: replies.buildWeekdayDateSelectRow,
    replyRecapMonth: replies.replyRecapMonth,
    replyRecapMonthGeneric: replies.replyRecapMonthGeneric,
    replyRecapSpecificDate: replies.replyRecapSpecificDate,
    replyRecapWeekdayPicker: replies.replyRecapWeekdayPicker,
    getAvailableRecapMonths: replies.getAvailableRecapMonths,
    replyLongestLiveForRange: replies.replyLongestLiveForRange,
    replyTopViewersForRange: replies.replyTopViewersForRange,
    resolveStatRangeFromText: replies.resolveStatRangeFromText,
    replyExportRecap: replies.replyExportRecap,
    buildExportCsv: replies.buildExportCsv,
  };
}

// Fake discord.js interaction - sama pola kayak tests/menu.test.js's
// fakeInteraction, handleRecapNavButton/handleRecapSearchModalSubmit cuma
// pernah nyentuh .customId/.channelId/.user.id/.reply()/.showModal()/
// .fields.getTextInputValue(), jadi gak butuh library mocking discord.js beneran.
function fakeInteraction({
  customId,
  channelId = "c-recapbtn",
  authorId = "u-recapbtn",
  fieldValue = "",
  message = undefined,
  deletedMessageIds = [],
  values = [],
} = {}) {
  const calls = [];
  const modals = [];
  const updates = [];
  const deferUpdateCalls = [];
  // Kalau `message` dikasih (buat test yang butuh, mis. "delrecap"/"keeprecap"
  // yang baca .id/.content-nya, ATAU "close" yang sekarang manggil
  // .delete()-nya lewat deleteInteractionMessage - lihat replies.js), auto
  // ditempelin .delete() yang nyatet ke deletedMessageIds yang SAMA kayak
  // channel.messages.delete di bawah, biar satu assertion array-nya nyakup
  // dua-duanya. Kalau `message` GAK dikasih (default undefined), TETEP
  // undefined - beberapa test (mis. search TANPA interaction.message)
  // sengaja butuh ini buat nguji jalur defensifnya.
  const finalMessage = message && typeof message === "object" ? { ...message, delete: async () => deletedMessageIds.push(message.id) } : message;
  return {
    customId,
    channelId,
    user: { id: authorId },
    fields: { getTextInputValue: () => fieldValue },
    values,
    message: finalMessage,
    // channel.messages.delete(id) - satu-satunya method discord.js yang
    // dipake handleRecapNavButton's "delrecap" (lihat replies.js), gak
    // perlu mock library beneran.
    channel: { messages: { delete: async (id) => deletedMessageIds.push(id) } },
    reply: async (payload) => calls.push(payload),
    update: async (payload) => updates.push(payload),
    deferUpdate: async () => deferUpdateCalls.push(true),
    showModal: async (modal) => modals.push(modal),
    calls,
    modals,
    updates,
    deferUpdateCalls,
    deletedMessageIds,
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

test("buildRecapTablePage - kolom terakhir nunjukkin jam Berakhir (bukan durasi), '-' kalau masih live", () => {
  const completed = {
    name: "Levi",
    startedAtUnix: unixAt(getTodayWIB(), "10:00"),
    endedAtUnix: unixAt(getTodayWIB(), "11:30"),
    durationMs: 90 * 60_000,
  };
  const ongoing = { name: "Nala", startedAtUnix: unixAt(getTodayWIB(), "09:00"), endedAtUnix: null, durationMs: null };

  const { text } = buildRecapTablePage([completed, ongoing], 0);

  assert.match(text, /Berakhir/);
  assert.doesNotMatch(text, /Durasi/);
  assert.match(text, /Levi\s*\|\s*Selesai\s*\|\s*10\.00\.00 WIB\s*\|\s*11\.30\.00 WIB/);
  assert.match(text, /Nala\s*\|\s*Live\s*\|\s*09\.00\.00 WIB\s*\|\s*-/);
});

test("buildRecapTablePage - sesi yang BARU SELESAI sesudah nyebrang tengah malam dikasih penanda (DD/MM) di kolom Berakhir", () => {
  const crossMidnight = {
    name: "Nala",
    startedAtUnix: unixAt(yesterdayWIB(), "22:50"),
    endedAtUnix: unixAt(getTodayWIB(), "00:39"),
    durationMs: 109 * 60_000,
  };

  const { text } = buildRecapTablePage([crossMidnight], 0);

  assert.match(text, /00\.39\.00 WIB(?! \()/); // berakhir HARI INI, jadi TANPA tanda kurung tanggal
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

// ==== §10's forty-second/forty-sixth item: "cok bandingin <A> dan <B>" ====

// Mock fetch ala IDN: nama yang ada di `profiles` balikin profil, sisanya
// balikin error "User Not found" (bentuk ASLI respons IDN buat username yang
// gak ada). Semua test di bawah yang ujungnya nyentuh IDN pake ini - test
// unit gak boleh nembak network beneran.
function fakeIdnFetch(profiles = {}) {
  return async (url, options) => {
    const { variables } = JSON.parse(options.body);
    const profile = profiles[variables.username];
    if (!profile) {
      return { ok: true, json: async () => ({ errors: [{ message: "client.IDNAccountGetPublicProfileByUsername: User Not found" }], data: null }) };
    }
    return { ok: true, json: async () => ({ data: { getPublicProfileByUsername: { username: variables.username, ...profile } } }) };
  };
}

test("replyCompareMembers - dua member ketemu -> content 'dan', 2 embed (masing-masing thumbnail foto), pemenang total-live dikasih 🏆, plus tombol Tutup", async () => {
  recordLiveCompleted("jkt48_comparea", "CompareA");
  recordLiveCompleted("jkt48_comparea", "CompareA");
  recordLiveCompleted("jkt48_comparea", "CompareA");
  recordLiveCompleted("jkt48_compareb", "CompareB");
  saveDurationHistory({
    jkt48_comparea: [{ name: "CompareA", durationMs: 60 * 60_000, at: new Date().toISOString() }],
    jkt48_compareb: [{ name: "CompareB", durationMs: 30 * 60_000, at: new Date().toISOString() }],
  });

  const original = global.fetch;
  global.fetch = async (url, options) => {
    const { variables } = JSON.parse(options.body);
    const avatar = `https://cdn.example/${variables.username}.webp`;
    return { ok: true, json: async () => ({ data: { getPublicProfileByUsername: { username: variables.username, avatar } } }) };
  };
  try {
    const reply = await replyCompareMembers("comparea", "compareb");
    assert.equal(reply.content, "⚔️ **CompareA** dan **CompareB**");
    assert.doesNotMatch(reply.content, /\bvs\b/i);
    assert.equal(reply.embeds.length, 2);
    assert.equal(reply.embeds[0].title, "🏆 CompareA"); // 3x > 1x live
    assert.equal(reply.embeds[1].title, "CompareB");
    assert.equal(reply.embeds[0].thumbnail.url, "https://cdn.example/jkt48_comparea.webp");
    assert.equal(reply.embeds[1].thumbnail.url, "https://cdn.example/jkt48_compareb.webp");
    const fieldA = Object.fromEntries(reply.embeds[0].fields.map((f) => [f.name, f.value]));
    assert.equal(fieldA["Total live"], "3x");
    assert.equal(fieldA["Rata-rata durasi"], "1j 0m");

    // Regresi (dilaporin owner): ketikan langsung "bandingin <A> dan <B>"
    // dulu gak punya tombol Tutup sama sekali.
    assert.equal(reply.components.length, 1);
    assert.equal(reply.components[0].components.length, 1);
    assert.equal(reply.components[0].components[0].data.custom_id, "compare_pick:close");
    assert.equal(reply.components[0].components[0].data.label, "Tutup");
  } finally {
    global.fetch = original;
  }
});

test("replyCompareMembers - gagal ambil foto profil (network/IDN API error) -> perbandingan TETEP jalan, cuma tanpa thumbnail", async () => {
  recordLiveCompleted("jkt48_comparec", "CompareC");
  recordLiveCompleted("jkt48_compared", "CompareD");

  const original = global.fetch;
  global.fetch = async () => {
    throw new Error("network down (simulasi)");
  };
  try {
    const reply = await replyCompareMembers("comparec", "compared");
    assert.equal(reply.embeds.length, 2);
    assert.equal(reply.embeds[0].thumbnail, undefined);
    assert.equal(reply.embeds[1].thumbnail, undefined);
  } finally {
    global.fetch = original;
  }
});

// Regresi (dilaporin owner): "Kimmy" beneran member JKT48 (ada akun IDN
// jkt48_kimmy) tapi belum pernah live semenjak bot ini jalan - dulu dibilang
// gak ketemu seolah bukan member. Sekarang dicek ke IDN dulu.
test("replyCompareMembers - member JKT48 asli yang BELUM PERNAH live (ada akun IDN, gak ada di live-count) -> bilang 'belum pernah live', bukan 'gak ketemu'", async () => {
  recordLiveCompleted("jkt48_alphaone", "Alphaone");

  const original = global.fetch;
  global.fetch = fakeIdnFetch({ jkt48_belumpernahlive: { name: "Belumpernahlive JKT48" } });
  try {
    const reply = await replyCompareMembers("alphaone", "belumpernahlive");
    assert.match(reply, /\*\*Belumpernahlive JKT48\*\* belum pernah live/);
    assert.doesNotMatch(reply, /gak nemu/);
  } finally {
    global.fetch = original;
  }
});

test("replyCompareMembers - nama yang GAK ADA di IDN sama sekali -> 'gak nemu member JKT48 bernama ...', beda dari 'belum pernah live'", async () => {
  recordLiveCompleted("jkt48_alphatwo", "Alphatwo");

  const original = global.fetch;
  global.fetch = fakeIdnFetch({});
  try {
    const reply = await replyCompareMembers("alphatwo", "member-yang-gak-pernah-ada");
    assert.match(reply, /gak nemu member JKT48 bernama "member-yang-gak-pernah-ada"/);
    assert.doesNotMatch(reply, /belum pernah live/);
  } finally {
    global.fetch = original;
  }
});

test("replyCompareMembers - profil ada tapi BUKAN akun member JKT48 (username gak berawalan jkt48_) -> tetep 'gak nemu', bukan 'belum pernah live'", async () => {
  recordLiveCompleted("jkt48_alphathree", "Alphathree");

  const original = global.fetch;
  // describeMissingMember selalu nanya username "jkt48_<token>", jadi profil
  // yang balik dengan username LAIN (defensif) gak boleh dianggep member.
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ data: { getPublicProfileByUsername: { username: "fanaccount_xyz", name: "Fan Account" } } }),
  });
  try {
    const reply = await replyCompareMembers("alphathree", "xyz");
    assert.match(reply, /gak nemu member JKT48 bernama "xyz"/);
  } finally {
    global.fetch = original;
  }
});

test("replyCompareMembers - IDN gagal dihubungi pas ngecek nama yang gak ada di catatan -> pesan jujur 'gak bisa ngecek', bukan nebak", async () => {
  recordLiveCompleted("jkt48_alphafour", "Alphafour");

  const original = global.fetch;
  global.fetch = async () => {
    throw new Error("network down (simulasi)");
  };
  try {
    const reply = await replyCompareMembers("alphafour", "siapasaja");
    assert.match(reply, /gak bisa ngecek ke IDN/);
    assert.doesNotMatch(reply, /belum pernah live/);
  } finally {
    global.fetch = original;
  }
});

test("replyCompareMembers - dua-duanya gak ada di catatan -> dua-duanya dijelasin sekaligus (satu baris per nama)", async () => {
  const original = global.fetch;
  global.fetch = fakeIdnFetch({ jkt48_duabelumlive: { name: "Duabelumlive JKT48" } });
  try {
    const reply = await replyCompareMembers("duabelumlive", "namangawur");
    const lines = reply.split("\n");
    assert.equal(lines.length, 2);
    assert.match(lines[0], /Duabelumlive JKT48\*\* belum pernah live/);
    assert.match(lines[1], /gak nemu member JKT48 bernama "namangawur"/);
  } finally {
    global.fetch = original;
  }
});

test("replyCompareMembers - dibandingin sama diri sendiri (nama yang sama persis) -> ditolak SEBELUM nyentuh storage/network", async () => {
  recordLiveCompleted("jkt48_alphafive", "Alphafive");
  const original = global.fetch;
  global.fetch = async () => {
    throw new Error("gak boleh ada panggilan network buat kasus ini");
  };
  try {
    const reply = await replyCompareMembers("alphafive", "alphafive");
    assert.match(reply, /gak bisa dibandingin sama diri sendiri/);
  } finally {
    global.fetch = original;
  }
});

test("replyCompareMembers - nama yang sama tapi beda huruf besar/spasi/'JKT48' ('Nala' vs ' nala JKT48 ') tetep dianggep member yang sama", async () => {
  recordLiveCompleted("jkt48_alphasix", "Alphasix JKT48");
  const reply = await replyCompareMembers("Alphasix", " alphasix JKT48 ");
  assert.match(reply, /gak bisa dibandingin sama diri sendiri/);
});

test("replyCompareMembers - dua fragment BEDA yang ternyata nunjuk member yang sama (mis. 'qwertyu' dan 'qwertyux') -> tetep ditolak", async () => {
  recordLiveCompleted("jkt48_qwertyu", "Qwertyu");
  const reply = await replyCompareMembers("qwertyu", "qwertyux");
  // "qwertyux" gak sama persis, tapi fuzzy match (awalan) nunjuk ke Qwertyu juga
  assert.match(reply, /gak bisa dibandingin sama diri sendiri/);
});

test("describeMissingMember - input kosong/kependekan -> minta ketik nama yang jelas, tanpa nyentuh network", async () => {
  const original = global.fetch;
  global.fetch = async () => {
    throw new Error("gak boleh ada panggilan network");
  };
  try {
    assert.match(await describeMissingMember(""), /ketik nama membernya yang jelas/);
    assert.match(await describeMissingMember("a"), /ketik nama membernya yang jelas/);
  } finally {
    global.fetch = original;
  }
});

test("normalizeMemberFragment - lowercase, buang 'JKT48' & tanda baca, rapiin spasi", () => {
  assert.equal(normalizeMemberFragment("  Nala JKT48 "), "nala");
  assert.equal(normalizeMemberFragment("nala"), "nala");
  assert.equal(normalizeMemberFragment("Nala!!"), "nala");
  assert.equal(normalizeMemberFragment(""), "");
});

// Dipake chat/compareFlow.js (dropdown pencarian "cok bandingin" polos) -
// usernameA/usernameB di sini DIJAMIN ada di live-count.json (hasil
// dropdown/pencarian) - cukup dites hasil embednya kebentuk bener dari
// username langsung, termasuk tombol Tutup-nya.
test("replyCompareMembersByUsername - langsung dari username (bukan fragment) -> hasil embed sama lengkapnya kayak replyCompareMembers", async () => {
  recordLiveCompleted("jkt48_compareg", "CompareG");
  recordLiveCompleted("jkt48_compareg", "CompareG");
  recordLiveCompleted("jkt48_compareh", "CompareH");

  const original = global.fetch;
  global.fetch = fakeIdnFetch({});
  try {
    const reply = await replyCompareMembersByUsername("jkt48_compareg", "jkt48_compareh");
    assert.equal(reply.content, "⚔️ **CompareG** dan **CompareH**");
    assert.equal(reply.embeds.length, 2);
    assert.equal(reply.embeds[0].title, "🏆 CompareG"); // 2x > 1x live
    assert.equal(reply.components[0].components[0].data.custom_id, "compare_pick:close");
  } finally {
    global.fetch = original;
  }
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

test("replyRecapRange - agregasi sesi dalam rentang waktu, sesi yang UDAH SELESAI doang buat total durasi/paling lama", async () => {
  const { recordLiveEnded: freshRecordLiveEnded, replyRecapRange: freshReplyRecapRange } = freshRepliesForRecapRange();

  const now = Date.now();
  const threeDaysAgo = new Date(now - 3 * 24 * 60 * 60 * 1000);
  freshRecordLiveEnded("Nala", "jkt48_rangetest1", new Date(threeDaysAgo.getTime() - 3600_000), threeDaysAgo, 50);
  freshRecordLiveEnded("Levi", "jkt48_rangetest2", new Date(threeDaysAgo.getTime() - 1800_000), new Date(threeDaysAgo.getTime() + 60_000), 30);

  const reply = await freshReplyRecapRange(7, "minggu ini", "c-range", "u-range");
  assert.match(reply.content, /Rekap minggu ini/);
  assert.match(reply.content, /Total sesi: 2x dari 2 member \(2 udah selesai, 0 masih live\)/);
  assert.ok(reply.components, "sesi ada -> harus ada tombol navigasi/tutup/cari member");
});

// BUG SEBELUMNYA (dilaporin owner, §10's thirty-third item): sesi yang MASIH
// LIVE SEKARANG dulu SENGAJA gak digabung ke rekap minggu/bulan ("rentang
// waktu yang udah tertutup") - alasan itu salah, sebuah live yang lagi
// berlangsung pasti mulai dalam beberapa jam terakhir, yang jelas masuk 7/30
// hari terakhir juga. Sekarang ikut digabung (tampil di tabel), TAPI angka
// ringkasan (total durasi/paling lama) tetep dihitung dari yang udah selesai
// doang - durasi yang masih jalan belum final.
test("replyRecapRange - sesi yang MASIH LIVE ikut digabung ke tabel, tapi TIDAK ikut ke total durasi/paling lama", async () => {
  const { recordLiveEnded: freshRecordLiveEnded, replyRecapRange: freshReplyRecapRange } = freshRepliesForRecapRange();

  const now = Date.now();
  const threeDaysAgo = new Date(now - 3 * 24 * 60 * 60 * 1000);
  freshRecordLiveEnded("Nala", "jkt48_rangetest1", new Date(threeDaysAgo.getTime() - 3600_000), threeDaysAgo, 50);

  activeLives.set("jkt48_rangetest_ongoing", {
    name: "Rangetestongoing",
    username: "jkt48_rangetest_ongoing",
    slug: "s",
    liveAt: new Date().toISOString(),
  });

  try {
    const reply = await freshReplyRecapRange(7, "minggu ini", "c-range-ongoing", "u-range-ongoing");
    assert.match(reply.content, /Total sesi: 2x dari 2 member \(1 udah selesai, 1 masih live\)/);
    assert.match(reply.content, /Rangetestongoing/, "harus muncul di TABEL-nya");
    assert.match(reply.content, /Paling lama: \*\*Nala\*\*/, "'paling lama' harus tetep dari yang udah selesai doang, bukan si ongoing");
  } finally {
    activeLives.delete("jkt48_rangetest_ongoing");
  }
});

test("replyRecapRange - CUMA ada sesi yang masih live, belum ada yang selesai sama sekali -> tetep muncul, tanpa baris 'Paling lama'", async () => {
  const { replyRecapRange: freshReplyRecapRange } = freshRepliesForRecapRange();

  activeLives.set("jkt48_rangetest_onlyongoing", {
    name: "Rangetestonlyongoing",
    username: "jkt48_rangetest_onlyongoing",
    slug: "s",
    liveAt: new Date().toISOString(),
  });

  try {
    const reply = await freshReplyRecapRange(7, "minggu ini", "c-range-onlyongoing", "u-range-onlyongoing");
    assert.match(reply.content, /Total sesi: 1x dari 1 member \(0 udah selesai, 1 masih live\)/);
    assert.match(reply.content, /Rangetestonlyongoing/);
    assert.doesNotMatch(reply.content, /Paling lama/);
  } finally {
    activeLives.delete("jkt48_rangetest_onlyongoing");
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
  // Halaman PERTAMA dari 2 (bukan halaman terakhir juga) - "Maju" + "Tutup
  // rekap" + "Cari member" + "Lompat halaman" (rangeDays number, >1 halaman
  // - §10's thirty-third item), TANPA "Mundur" (sesuai spek: gak ada
  // halaman sebelumnya buat dibalik).
  const page0CustomIds = page0.components[0].components.map((b) => b.data.custom_id);
  assert.deepEqual(page0CustomIds, ["recap_nav:next:7:0", "recap_nav:close", "recap_nav:search:7", "recap_nav:jump:7:0"]);

  const page1 = await tryHandleRecapPageShortcut("y", channelId, authorId);
  assert.match(page1.content, /Halaman 2\/2/);
  // Halaman TERAKHIR (dari 2) - "Mundur" + "Tutup rekap" + "Cari member" +
  // "Lompat halaman", TANPA "Maju" (gak ada halaman berikutnya).
  const page1CustomIds = page1.components[0].components.map((b) => b.data.custom_id);
  assert.deepEqual(page1CustomIds, ["recap_nav:prev:7:1", "recap_nav:close", "recap_nav:search:7", "recap_nav:jump:7:1"]);

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
  // Halaman TENGAH (2 dari 3, bukan pertama/terakhir) - semua 5 tombol
  // sekaligus muncul: "Maju", "Mundur", "Tutup rekap", "Cari member", DAN
  // "Lompat halaman" - persis batas maksimal Discord (5 tombol/baris).
  const page1CustomIds = page1.components[0].components.map((b) => b.data.custom_id);
  assert.deepEqual(page1CustomIds, ["recap_nav:next:7:1", "recap_nav:prev:7:1", "recap_nav:close", "recap_nav:search:7", "recap_nav:jump:7:1"]);

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
// Owner laporin: klik "maju"/"mundur" bikin PESAN BARU tiap kali, jadi
// channel numpuk 1 pesan tabel per klik - keliatan kayak nge-reply ke pesan
// yang salah. Fix-nya interaction.update() (EDIT pesan yang tombolnya
// nempel), BUKAN interaction.reply() (pesan baru) - dites eksplisit di sini
// (.updates, bukan .calls) plus mastiin reply() BENERAN gak kepanggil sama
// sekali, biar gak keulang diem-diem balik ke reply().
test("handleRecapNavButton - action 'next'/'prev' EDIT pesan yang ada (update), BUKAN kirim pesan baru (reply)", async () => {
  const now = Date.now();
  const threeDaysAgo = Math.floor(now / 1000) - 3 * 24 * 60 * 60;
  for (let i = 0; i < 25; i++) {
    recordLiveEnded(`Navbtn${i}`, `jkt48_navbtntest${i}`, new Date((threeDaysAgo + i * 60) * 1000), new Date((threeDaysAgo + i * 60 + 30) * 1000), 5);
  }

  // "recap_nav:next:7:0" - lagi di halaman 0 (index), diklik "Maju" -> harus
  // render halaman 1 (index), bukan halaman 0 lagi.
  const next = fakeInteraction({ customId: "recap_nav:next:7:0" });
  await handleRecapNavButton(next);
  assert.equal(next.calls.length, 0, "gak boleh kirim pesan baru (reply)");
  assert.match(next.updates[0].content, /Halaman 2\/2/);
  assert.deepEqual(next.updates[0].allowedMentions, { parse: [] });

  // "recap_nav:prev:7:1" - lagi di halaman 1 (index), diklik "Mundur" ->
  // harus render halaman 0 (index) lagi.
  const prev = fakeInteraction({ customId: "recap_nav:prev:7:1" });
  await handleRecapNavButton(prev);
  assert.equal(prev.calls.length, 0);
  assert.match(prev.updates[0].content, /Halaman 1\/2/);
});

// §10's thirty-fifth item: dulu diedit jadi teks "Terima kasih..." +
// components:[], sekarang BENERAN ngehapus pesannya - sama logika "tutup"
// yang konsisten di semua tombol Tutup lain di bot ini.
test("handleRecapNavButton - action 'close' BENERAN ngehapus pesannya (message.delete), BUKAN diedit jadi teks ucapan terima kasih", async () => {
  const interaction = fakeInteraction({ customId: "recap_nav:close", message: { id: "recap-close-msg-id" } });
  await handleRecapNavButton(interaction);
  assert.equal(interaction.calls.length, 0, "gak boleh kirim pesan baru (reply)");
  assert.equal(interaction.updates.length, 0, "gak boleh update() jadi teks apapun - pesannya beneran hilang");
  assert.equal(interaction.deferUpdateCalls.length, 1, "harus deferUpdate() dulu biar Discord gak nunjukkin 'interaction failed'");
  assert.deepEqual(interaction.deletedMessageIds, ["recap-close-msg-id"]);
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

  const closeInteraction = fakeInteraction({ customId: "recap_nav:close", channelId, authorId, message: { id: "recap-close-pending-msg-id" } });
  await freshHandleRecapNavButton(closeInteraction);
  assert.deepEqual(closeInteraction.deletedMessageIds, ["recap-close-pending-msg-id"]);

  const afterClose = await freshTryHandleRecapPageShortcut("y", channelId, authorId);
  assert.equal(afterClose, null, "pendingRecapPage harus udah kehapus abis 'tutup rekap' diklik");
});

test("handleRecapNavButton - action 'search' munculin modal (showModal), BUKAN balesan biasa (reply/update)", async () => {
  const interaction = fakeInteraction({ customId: "recap_nav:search:7" });
  await handleRecapNavButton(interaction);
  assert.equal(interaction.calls.length, 0, "search gak boleh manggil reply() - munculin modal doang");
  assert.equal(interaction.updates.length, 0, "search gak boleh manggil update() - munculin modal doang");
  assert.equal(interaction.modals.length, 1);
  assert.equal(interaction.modals[0].data.custom_id, "recap_search_modal:7");
});

// §10's thirty-third item - "🔢 Lompat halaman", owner minta buat rekap
// minggu/bulan yang bisa nyampe banyak halaman.
test("handleRecapNavButton - action 'jump' munculin modal (showModal), BUKAN balesan biasa (reply/update), customId modal bawa range+halaman sekarang", async () => {
  const interaction = fakeInteraction({ customId: "recap_nav:jump:7:1" });
  await handleRecapNavButton(interaction);
  assert.equal(interaction.calls.length, 0);
  assert.equal(interaction.updates.length, 0);
  assert.equal(interaction.modals.length, 1);
  assert.equal(interaction.modals[0].data.custom_id, "recap_jump_modal:7:1");
});

test("buildRecapPageBlock - tombol 'Lompat halaman' CUMA muncul buat rangeDays number (minggu/bulan) DENGAN lebih dari 1 halaman", () => {
  const manySessions = Array.from({ length: 25 }, (_, i) => ({
    name: `Jump${i}`,
    username: `jkt48_jumptest${i}`,
    startedAtUnix: 1000 + i,
    endedAtUnix: 1030 + i,
    durationMs: 30000,
    peakViewCount: 5,
  }));

  const weekBlock = buildRecapPageBlock(manySessions, 0, "c-jumpcheck", "u-jumpcheck", 7);
  const weekCustomIds = weekBlock.components[0].components.map((b) => b.data.custom_id);
  assert.ok(weekCustomIds.includes("recap_nav:jump:7:0"), "rangeDays number, >1 halaman -> harus ada");

  const singlePageBlock = buildRecapPageBlock([manySessions[0]], 0, "c-jumpcheck2", "u-jumpcheck2", 7);
  const singlePageCustomIds = singlePageBlock.components[0].components.map((b) => b.data.custom_id);
  assert.ok(!singlePageCustomIds.some((id) => id.startsWith("recap_nav:jump")), "rangeDays number, cuma 1 halaman -> gak ada gunanya, jangan muncul");

  const todayBlock = buildRecapPageBlock(manySessions, 0, "c-jumpcheck3", "u-jumpcheck3", null);
  const todayCustomIds = todayBlock.components[0].components.map((b) => b.data.custom_id);
  assert.ok(
    !todayCustomIds.some((id) => id.startsWith("recap_nav:jump")),
    "rekap hari ini di luar scope permintaan owner, gak ikut dapet tombol ini",
  );

  const dateBlock = buildRecapPageBlock(manySessions, 0, "c-jumpcheck4", "u-jumpcheck4", "2026-09-01");
  const dateButtonRow = dateBlock.components[dateBlock.components.length - 1];
  const dateCustomIds = dateButtonRow.components.map((b) => b.data.custom_id);
  assert.ok(!dateCustomIds.some((id) => id.startsWith("recap_nav:jump")), "rekap tanggal spesifik juga di luar scope, gak ikut dapet tombol ini");
});

test("handleRecapJumpModalSubmit - input angka -> EDIT pesan yang sama (update) ke halaman itu, bukan pesan baru", async () => {
  const { recordLiveEnded: freshRecordLiveEnded, handleRecapJumpModalSubmit: freshHandleRecapJumpModalSubmit } = freshRepliesForRecapRange();

  const now = Date.now();
  const threeDaysAgo = Math.floor(now / 1000) - 3 * 24 * 60 * 60;
  for (let i = 0; i < 65; i++) {
    freshRecordLiveEnded(`Jm${i}`, `jkt48_jumpmodal${i}`, new Date((threeDaysAgo + i * 60) * 1000), new Date((threeDaysAgo + i * 60 + 30) * 1000), 5);
  }
  // 65 sesi / RECAP_TABLE_PAGE_SIZE 20 -> 4 halaman.

  const interaction = fakeInteraction({ customId: "recap_jump_modal:7:0", fieldValue: "3" });
  await freshHandleRecapJumpModalSubmit(interaction);
  assert.equal(interaction.calls.length, 0, "gak boleh reply() pesan baru");
  assert.match(interaction.updates[0].content, /Halaman 3\/4/);
});

test("handleRecapJumpModalSubmit - 'awal'/'akhir' alias buat halaman pertama/terakhir, gak perlu tau nomor halaman terakhirnya berapa", async () => {
  const { recordLiveEnded: freshRecordLiveEnded, handleRecapJumpModalSubmit: freshHandleRecapJumpModalSubmit } = freshRepliesForRecapRange();

  const now = Date.now();
  const threeDaysAgo = Math.floor(now / 1000) - 3 * 24 * 60 * 60;
  for (let i = 0; i < 65; i++) {
    freshRecordLiveEnded(`Al${i}`, `jkt48_jumpalias${i}`, new Date((threeDaysAgo + i * 60) * 1000), new Date((threeDaysAgo + i * 60 + 30) * 1000), 5);
  }

  const lastInteraction = fakeInteraction({ customId: "recap_jump_modal:7:0", fieldValue: "akhir" });
  await freshHandleRecapJumpModalSubmit(lastInteraction);
  assert.match(lastInteraction.updates[0].content, /Halaman 4\/4/);

  const firstInteraction = fakeInteraction({ customId: "recap_jump_modal:7:3", fieldValue: "awal" });
  await freshHandleRecapJumpModalSubmit(firstInteraction);
  assert.match(firstInteraction.updates[0].content, /Halaman 1\/4/);
});

test("handleRecapJumpModalSubmit - angka melebihi total halaman -> otomatis ke-clamp ke halaman terakhir (bukan error)", async () => {
  const { recordLiveEnded: freshRecordLiveEnded, handleRecapJumpModalSubmit: freshHandleRecapJumpModalSubmit } = freshRepliesForRecapRange();

  const now = Date.now();
  const threeDaysAgo = Math.floor(now / 1000) - 3 * 24 * 60 * 60;
  for (let i = 0; i < 25; i++) {
    freshRecordLiveEnded(`Ov${i}`, `jkt48_jumpover${i}`, new Date((threeDaysAgo + i * 60) * 1000), new Date((threeDaysAgo + i * 60 + 30) * 1000), 5);
  }

  const interaction = fakeInteraction({ customId: "recap_jump_modal:7:0", fieldValue: "999" });
  await freshHandleRecapJumpModalSubmit(interaction);
  assert.match(interaction.updates[0].content, /Halaman 2\/2/);
});

test("handleRecapJumpModalSubmit - input gak keparse sama sekali -> tetep di halaman SEKARANG (dari customId) plus catetan, TETEP update() bukan reply()", async () => {
  const { recordLiveEnded: freshRecordLiveEnded, handleRecapJumpModalSubmit: freshHandleRecapJumpModalSubmit } = freshRepliesForRecapRange();

  const now = Date.now();
  const threeDaysAgo = Math.floor(now / 1000) - 3 * 24 * 60 * 60;
  for (let i = 0; i < 25; i++) {
    freshRecordLiveEnded(`Bad${i}`, `jkt48_jumpbad${i}`, new Date((threeDaysAgo + i * 60) * 1000), new Date((threeDaysAgo + i * 60 + 30) * 1000), 5);
  }

  const interaction = fakeInteraction({ customId: "recap_jump_modal:7:1", fieldValue: "halaman gaib" });
  await freshHandleRecapJumpModalSubmit(interaction);
  assert.equal(interaction.calls.length, 0);
  assert.match(interaction.updates[0].content, /Halaman 2\/2/, "tetep di halaman sekarang (index 1 dari customId -> halaman ke-2)");
  assert.match(interaction.updates[0].content, /Gak ngerti "halaman gaib"/);
});

// Diklik dari tombol "Enggak, hapus aja" yang nempel di balesan pencarian -
// harus BENERAN hapus pesan rekap ASLI (by ID, dari customId), bukan cuma
// ngasih kesan doang. Pesan pencarian ITU SENDIRI diedit (bukan dihapus)
// buat ngilangin tombol Ya/Enggak-nya abis dijawab.
test("handleRecapNavButton - action 'delrecap' beneran hapus pesan rekap ASLI by ID, dan ngilangin tombol Ya/Enggak dari balesan pencarian", async () => {
  const interaction = fakeInteraction({ customId: "recap_nav:delrecap:original-recap-message-id", message: { content: "hasil cari xxx" } });
  await handleRecapNavButton(interaction);

  assert.deepEqual(interaction.deletedMessageIds, ["original-recap-message-id"]);
  assert.equal(interaction.calls.length, 0, "gak boleh kirim pesan baru");
  assert.equal(interaction.updates[0].content, "hasil cari xxx", "konten balesan pencarian tetep sama, cuma tombolnya yang ilang");
  assert.deepEqual(interaction.updates[0].components, []);
});

test("handleRecapNavButton - action 'delrecap' juga nge-clear pendingRecapPage (rekap aslinya udah dihapus, jawaban 'y' abis itu gak boleh nyasar)", async () => {
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
      `Del${i}`,
      `jkt48_delbtntest${i}`,
      new Date((threeDaysAgo + i * 60) * 1000),
      new Date((threeDaysAgo + i * 60 + 30) * 1000),
      5,
    );
  }

  const channelId = "c-delbtn";
  const authorId = "u-delbtn";
  await freshReplyRecapRange(7, "minggu ini", channelId, authorId); // nge-set pendingRecapPage

  const deleteInteraction = fakeInteraction({ customId: "recap_nav:delrecap:some-id", channelId, authorId, message: { content: "x" } });
  await freshHandleRecapNavButton(deleteInteraction);

  const afterDelete = await freshTryHandleRecapPageShortcut("y", channelId, authorId);
  assert.equal(afterDelete, null, "pendingRecapPage harus udah kehapus abis 'delrecap'");
});

// Diklik dari tombol "Ya, biarin" - kebalikan dari delrecap, GAK boleh
// ngehapus apa-apa, cuma ngilangin tombol Ya/Enggak-nya doang.
test("handleRecapNavButton - action 'keeprecap' GAK ngehapus pesan apapun, cuma ngilangin tombol Ya/Enggak dari balesan pencarian", async () => {
  const interaction = fakeInteraction({ customId: "recap_nav:keeprecap:original-recap-message-id", message: { content: "hasil cari xxx" } });
  await handleRecapNavButton(interaction);

  assert.deepEqual(interaction.deletedMessageIds, [], "keeprecap gak boleh ngehapus pesan apapun");
  assert.equal(interaction.calls.length, 0);
  assert.equal(interaction.updates[0].content, "hasil cari xxx");
  assert.deepEqual(interaction.updates[0].components, []);
});

test("handleRecapSearchModalSubmit - nama ketemu -> tabel hasil filter cuma nunjukkin sesi member itu, TANPA tombol kalau interaction.message gak keisi", async () => {
  const now = Date.now();
  const threeDaysAgo = Math.floor(now / 1000) - 3 * 24 * 60 * 60;
  recordLiveEnded("Searchtarget", "jkt48_searchtarget", new Date(threeDaysAgo * 1000), new Date((threeDaysAgo + 60) * 1000), 5);
  recordLiveEnded("Searchother", "jkt48_searchother", new Date(threeDaysAgo * 1000), new Date((threeDaysAgo + 60) * 1000), 5);

  const interaction = fakeInteraction({ customId: "recap_search_modal:7", fieldValue: "searchtarget" });
  await handleRecapSearchModalSubmit(interaction);
  assert.match(interaction.calls[0].content, /Hasil cari "searchtarget"/);
  assert.match(interaction.calls[0].content, /Searchtarget/);
  assert.doesNotMatch(interaction.calls[0].content, /Searchother/);
  assert.equal(interaction.calls[0].components, undefined, "gak ada messageId buat dihapus/dipertahanin -> gak ada tombol");
});

test("handleRecapSearchModalSubmit - nama gak ketemu -> pesan gak ketemu, bukan tabel kosong", async () => {
  const interaction = fakeInteraction({ customId: "recap_search_modal:7", fieldValue: "member-yang-beneran-gak-ada-di-rekap" });
  await handleRecapSearchModalSubmit(interaction);
  assert.match(interaction.calls[0].content, /gak nemu member "member-yang-beneran-gak-ada-di-rekap"/);
});

// Fitur yang diminta owner: "kenapa rekap aslinya tetep muncul abis cari
// member?" - sekarang ditanya eksplisit "masih mau ditampilin?" lewat tombol
// Ya/Enggak, TAPI cuma kalau ada pesan buat ditanyain (interaction.message
// dari modal submission cuma keisi kalau modal-nya dibuka dari tombol yang
// nempel di sebuah pesan - persis kasus "🔍 Cari member").
test("handleRecapSearchModalSubmit - interaction.message keisi -> nanya 'masih mau ditampilin?' + tombol Ya/Enggak bawa ID pesan rekap aslinya", async () => {
  const now = Date.now();
  const threeDaysAgo = Math.floor(now / 1000) - 3 * 24 * 60 * 60;
  recordLiveEnded("Searchbtn", "jkt48_searchbtntest", new Date(threeDaysAgo * 1000), new Date((threeDaysAgo + 60) * 1000), 5);

  const interaction = fakeInteraction({
    customId: "recap_search_modal:7",
    fieldValue: "searchbtntest",
    message: { id: "original-recap-message-id" },
  });
  await handleRecapSearchModalSubmit(interaction);
  assert.match(interaction.calls[0].content, /Rekap sebelumnya masih mau ditampilin\?/);
  const customIds = interaction.calls[0].components[0].components.map((b) => b.data.custom_id);
  assert.deepEqual(customIds, ["recap_nav:keeprecap:original-recap-message-id", "recap_nav:delrecap:original-recap-message-id"]);
});

test("handleRecapSearchModalSubmit - interaction.message keisi TAPI gak ketemu member -> tetep nanya 'masih mau ditampilin?'", async () => {
  const interaction = fakeInteraction({
    customId: "recap_search_modal:7",
    fieldValue: "member-yang-beneran-gak-ada-di-rekap",
    message: { id: "original-recap-message-id-2" },
  });
  await handleRecapSearchModalSubmit(interaction);
  assert.match(interaction.calls[0].content, /gak nemu member.*Rekap sebelumnya masih mau ditampilin\?/s);
  assert.ok(interaction.calls[0].components, "tombol Ya/Enggak tetep muncul walau hasil pencarian kosong");
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

// --- Rekap per tanggal + menu 4-tombol "cok rekap" polos ---

// BUG SEBELUMNYA (dilaporin owner, dua-duanya sekaligus): (1) loop-nya dulu
// mulai dari KEMARIN (bukan hari ini), jadi hari ini beneran gak pernah bisa
// dipilih lewat dropdown ini - kentara pas dibuka lewat "cok rekap tanggal"
// langsung, yang gak pernah nempelin tombol "Rekap hari ini" terpisah. (2)
// dropdown-nya selalu nawarin 25 hari ke belakang APAPUN kondisinya, walau
// bot-nya baru mulai nge-track beberapa hari lalu - milih tanggal sebelum
// itu ujung-ujungnya cuma "belum ada live yang kecatet". Dua-duanya dites di
// environment TERISOLASI (freshRepliesForRecapRange) biar hasilnya
// deterministik, gak kebawa sesi dari test lain di file yang sama.
test("buildRecapDateSelectRow - arsip kosong sama sekali -> 25 opsi PENUH, opsi pertama HARI INI", () => {
  const fresh = freshRepliesForRecapRange();
  const row = fresh.buildRecapDateSelectRow();
  const options = row.components[0].options.map((o) => o.data);
  assert.equal(options.length, 25);
  assert.match(options[0].value, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(options[0].value, getTodayWIB(), "opsi pertama harus HARI INI");
  assert.match(options[0].label, /^\d{1,2} [A-Za-z]+ \d{4}$/); // "13 September 2026"
  assert.equal(options[1].value, getDateWIB(new Date(Date.now() - 24 * 60 * 60 * 1000)), "opsi kedua kemarin");
});

test("buildRecapDateSelectRow - sesi paling tua cuma 3 hari lalu -> dropdown dipotong di situ, gak nawarin tanggal sebelum bot mulai nge-track", () => {
  const fresh = freshRepliesForRecapRange();
  const threeDaysAgo = Math.floor(Date.now() / 1000) - 3 * 24 * 60 * 60;
  fresh.recordLiveEnded("Datecutoff", "jkt48_datecutoff", new Date(threeDaysAgo * 1000), new Date((threeDaysAgo + 60) * 1000), 5);

  const row = fresh.buildRecapDateSelectRow();
  const options = row.components[0].options.map((o) => o.data);
  const earliestExpected = getDateWIB(new Date(threeDaysAgo * 1000));
  // hari ini + kemarin + H-2 + H-3(paling tua yang ada) = 4 opsi, BUKAN 25
  assert.equal(options.length, 4);
  assert.equal(options[0].value, getTodayWIB());
  assert.equal(options[options.length - 1].value, earliestExpected);
  assert.ok(
    options.every((o) => o.value >= earliestExpected),
    "gak boleh ada opsi yang lebih tua dari sesi paling tua yang beneran ada",
  );
});

test("buildRecapDateSelectRow - opsi yang cocok sama selectedDate ditandain default:true", () => {
  const row = buildRecapDateSelectRow();
  const someDate = row.components[0].options[3].data.value;
  const marked = buildRecapDateSelectRow(someDate).components[0].options.map((o) => o.data);
  const found = marked.find((o) => o.value === someDate);
  assert.equal(found.default, true);
  const others = marked.filter((o) => o.value !== someDate);
  assert.ok(others.every((o) => !o.default));
});

test("replyRecapMenu - 4 tombol pilihan rekap + 1 tombol Tutup, dengan customId recap_menu:<today|week|month|date> + recap_nav:close", () => {
  const reply = replyRecapMenu();
  assert.equal(reply.content, "Mau rekap yang mana, cok?");
  const customIds = reply.components[0].components.map((c) => c.data.custom_id);
  assert.deepEqual(customIds, ["recap_menu:today", "recap_menu:week", "recap_menu:month", "recap_menu:date", "recap_nav:close"]);
});

test("replyRecapDatePicker - dropdown tanggal + tombol tutup, belum ada tabel apa-apa", () => {
  const reply = replyRecapDatePicker();
  assert.equal(reply.content, "Rekap tanggal berapa nih, cok?");
  assert.equal(reply.components.length, 2);
  assert.equal(reply.components[0].components[0].data.custom_id, "recap_date_select");
  assert.equal(reply.components[1].components[0].data.custom_id, "recap_nav:close");
});

// ==== §10's thirty-sixth item: "cok rekap 25 september"/"cok rekap
// september"/"cok rekap bulan"/"cok rekap senin" dkk ====

const WEEKDAY_NAMES_ID_TEST = ["Minggu", "Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu"];
function todayWeekdayIndex() {
  return WEEKDAY_NAMES_ID_TEST.indexOf(WEEKDAY_FORMATTER_WIB.format(new Date()));
}
function currentYear() {
  return Number(getTodayWIB().split("-")[0]);
}

test("parseSpecificDateFromText - 'hari nama-bulan' ATAU 'nama-bulan hari' (urutan bebas), tahun default TAHUN SEKARANG kalau gak disebut", () => {
  const year = currentYear();
  assert.equal(parseSpecificDateFromText("cok rekap 25 september"), `${year}-09-25`);
  assert.equal(parseSpecificDateFromText("cok rekap september 25"), `${year}-09-25`);
  assert.equal(parseSpecificDateFromText("cok rekap 5 januari"), `${year}-01-05`);
  assert.equal(parseSpecificDateFromText("cok rekap 25 september 2025"), "2025-09-25");
});

test("parseSpecificDateFromText - tanggal yang gak mungkin valid (di luar jumlah hari bulan itu, mis. 31 Februari) balikin null, BUKAN Invalid Date", () => {
  assert.equal(parseSpecificDateFromText("cok rekap 31 februari"), null);
  assert.equal(parseSpecificDateFromText("cok rekap 32 september"), null);
});

test("parseSpecificDateFromText - gak ada angka hari + nama bulan sama sekali -> null", () => {
  assert.equal(parseSpecificDateFromText("cok rekap september"), null);
  assert.equal(parseSpecificDateFromText("cok rekap bulan ini"), null);
  assert.equal(parseSpecificDateFromText("cok rekap"), null);
});

test("parseMonthOnlyFromText - nama bulan TANPA angka hari, tahun default TAHUN SEKARANG kalau gak disebut", () => {
  const year = currentYear();
  assert.equal(parseMonthOnlyFromText("cok rekap september"), `${year}-09`);
  assert.equal(parseMonthOnlyFromText("cok rekap oktober 2027"), "2027-10");
  assert.equal(parseMonthOnlyFromText("cok rekap bulan ini"), null, "gak nyebut nama bulan sama sekali -> null");
});

test("parseWeekdayFromText - 'senin'..'sabtu' gak ambigu, ketangkep di mana pun di teksnya", () => {
  assert.equal(parseWeekdayFromText("cok rekap senin"), 1);
  assert.equal(parseWeekdayFromText("cok rekap hari senin"), 1);
  assert.equal(parseWeekdayFromText("cok rekap sabtu"), 6);
});

test("parseWeekdayFromText - 'minggu' (Minggu/Sunday) CUMA ketangkep kalau kata 'hari' JUGA disebut, biar gak nabrak 'rekap minggu ini' (rentang 7 hari)", () => {
  assert.equal(parseWeekdayFromText("cok rekap hari minggu"), 0);
  assert.equal(parseWeekdayFromText("cok rekap minggu ini"), null);
  assert.equal(parseWeekdayFromText("cok rekap minggu"), null);
});

test("parseWeekdayFromText - teks tanpa nama hari sama sekali -> null", () => {
  assert.equal(parseWeekdayFromText("cok rekap bulan ini"), null);
  assert.equal(parseWeekdayFromText("cok rekap"), null);
});

// ==== §10's fortieth item: "paling lama live"/"paling rame ditonton" bisa
// dikasih rentang (minggu ini/bulan ini/nama bulan/tanggal spesifik) ====

test("resolveStatRangeFromText - tanggal spesifik ('25 september') dicek DULUAN, gak kepotong jadi nama bulan polos", () => {
  const year = currentYear();
  const result = resolveStatRangeFromText("cok siapa yang paling lama live 25 september");
  assert.equal(result.rangeDays, `${year}-09-25`);
  assert.match(result.label, /^tanggal 25 September/);
});

test("resolveStatRangeFromText - nama bulan polos ('september') -> rangeDays 'YYYY-MM'", () => {
  const year = currentYear();
  const result = resolveStatRangeFromText("cok siapa yang paling rame ditonton september");
  assert.equal(result.rangeDays, `${year}-09`);
  assert.equal(result.label, `bulan September ${year}`);
});

test("resolveStatRangeFromText - 'bulan' TANPA nama spesifik (dengan/tanpa 'ini') -> selalu bulan BERJALAN", () => {
  const thisMonth = getTodayWIB().slice(0, 7);
  assert.equal(resolveStatRangeFromText("cok siapa yang paling lama live bulan ini").rangeDays, thisMonth);
  assert.equal(resolveStatRangeFromText("cok siapa yang paling lama live bulan").rangeDays, thisMonth);
});

test("resolveStatRangeFromText - 'minggu' -> rangeDays 7 (rolling 7 hari, sama kayak rekap minggu ini)", () => {
  const result = resolveStatRangeFromText("cok siapa yang paling rame ditonton minggu ini");
  assert.equal(result.rangeDays, 7);
  assert.equal(result.label, "minggu ini");
});

test("resolveStatRangeFromText - gak nyebut rentang apapun -> null (pemanggil default ke hari ini)", () => {
  assert.equal(resolveStatRangeFromText("cok siapa yang paling lama live hari ini"), null);
  assert.equal(resolveStatRangeFromText("cok siapa yang paling rame ditonton"), null);
});

test("replyLongestLiveForRange - bulan BERJALAN ikut gabung sesi yang MASIH LIVE, durasinya dihitung dari startedAtUnix (bukan null)", async () => {
  const fresh = freshRepliesForRecapRange();
  const thisMonth = getTodayWIB().slice(0, 7);
  fresh.recordLiveEnded("Shortlive", "jkt48_shortlive", new Date(Date.now() - 10 * 60_000), new Date(), 5);
  activeLives.set("jkt48_longlive", {
    name: "Longlive",
    username: "jkt48_longlive",
    slug: "s",
    liveAt: new Date(Date.now() - 3 * 60 * 60_000).toISOString(),
  });
  try {
    const reply = fresh.replyLongestLiveForRange(thisMonth, "bulan ini");
    assert.match(reply, /Paling lama live bulan ini: \*\*Longlive\*\*/);
    assert.match(reply, /masih live sekarang/);
  } finally {
    activeLives.delete("jkt48_longlive");
  }
});

test("replyLongestLiveForRange - rentang yang kosong sama sekali -> pesan 'belum ada data', bukan throw", () => {
  const fresh = freshRepliesForRecapRange();
  assert.equal(fresh.replyLongestLiveForRange(7, "minggu ini"), "Cok, belum ada data live minggu ini.");
});

test("replyTopViewersForRange - bulan BERJALAN ikut gabung peak penonton dari sesi yang MASIH LIVE", async () => {
  const fresh = freshRepliesForRecapRange();
  const thisMonth = getTodayWIB().slice(0, 7);
  fresh.recordLiveEnded("Quietviewer", "jkt48_quietviewer", new Date(Date.now() - 60_000), new Date(), 100);
  activeLives.set("jkt48_loudviewer", {
    name: "Loudviewer",
    username: "jkt48_loudviewer",
    slug: "s",
    liveAt: new Date().toISOString(),
    peakViewCount: 9999,
  });
  try {
    const reply = fresh.replyTopViewersForRange(thisMonth, "bulan ini");
    assert.match(reply, /Paling rame ditonton bulan ini \(puncak penonton\)/);
    assert.match(reply, /🥇 \*\*Loudviewer\*\*/);
  } finally {
    activeLives.delete("jkt48_loudviewer");
  }
});

test("replyTopViewersForRange - rentang yang kosong sama sekali -> pesan 'belum ada data', bukan throw", () => {
  const fresh = freshRepliesForRecapRange();
  assert.equal(fresh.replyTopViewersForRange(7, "minggu ini"), "Cok, belum ada data penonton buat minggu ini.");
});

// ==== §10's forty-first item: "cok export rekap ..." -> file CSV ====

test("buildExportCsv - header + baris sesuai data, sesi yang masih live tetep kebentuk ('Live'/'-' bukan crash)", () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const sessions = [
    { name: "Nala", username: "jkt48_nala", startedAtUnix: nowSec - 3600, endedAtUnix: nowSec, durationMs: 3600_000, peakViewCount: 500 },
    { name: "Levi", username: "jkt48_levi", startedAtUnix: nowSec - 600, endedAtUnix: null, durationMs: null, peakViewCount: 10 },
  ];
  const csv = buildExportCsv(sessions);
  const lines = csv.split("\r\n");
  assert.equal(lines[0], "No,Member,Username,Status,Mulai (WIB),Berakhir (WIB),Durasi,Puncak Penonton");
  assert.match(lines[1], /^1,Nala,jkt48_nala,Selesai,/);
  assert.match(lines[2], /^2,Levi,jkt48_levi,Live,.*,-,-,10$/);
});

test("buildExportCsv - value yang ngandung koma dibungkus tanda kutip (CSV valid)", () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const csv = buildExportCsv([
    { name: "Nama, Dengan Koma", username: "jkt48_test", startedAtUnix: nowSec - 60, endedAtUnix: nowSec, durationMs: 60_000, peakViewCount: 5 },
  ]);
  assert.match(csv.split("\r\n")[1], /^1,"Nama, Dengan Koma",jkt48_test,/);
});

test("replyExportRecap - ada sesi hari ini (default, gak nyebut rentang) -> balesan bawa 1 file CSV, nama file & isi bener", async () => {
  const fresh = freshRepliesForRecapRange();
  fresh.recordLiveEnded("Exportme", "jkt48_exportme", new Date(Date.now() - 60_000), new Date(), 5);

  const reply = fresh.replyExportRecap("cok export rekap");
  assert.match(reply.content, /📄 Rekap hari ini \(1 sesi\) - diexport ke CSV, cok\./);
  assert.equal(reply.files.length, 1);
  assert.equal(reply.files[0].name, "rekap-hari-ini.csv");
  assert.match(reply.files[0].attachment.toString("utf-8"), /Exportme/);
});

test("replyExportRecap - rentang bulan ini (via resolveStatRangeFromText) -> nama file & label ikut rentangnya", async () => {
  const fresh = freshRepliesForRecapRange();
  fresh.recordLiveEnded("Exportmonth", "jkt48_exportmonth", new Date(Date.now() - 60_000), new Date(), 5);

  const reply = fresh.replyExportRecap("cok export rekap bulan ini");
  assert.match(reply.content, /Rekap bulan .* - diexport ke CSV/);
  assert.match(reply.files[0].name, /^rekap-bulan-/);
});

test("replyExportRecap - rentang yang kosong sama sekali -> pesan 'belum ada data', TANPA file sama sekali", async () => {
  const fresh = freshRepliesForRecapRange();
  const reply = fresh.replyExportRecap("cok export rekap minggu ini");
  assert.equal(reply, "Cok, belum ada data live buat diexport (minggu ini).");
});

test("buildRecapMonthSelectRow - customId recap_month_select, label via formatMonthLabel, default:true buat bulan terpilih", () => {
  const row = buildRecapMonthSelectRow(["2026-09", "2026-08"], "2026-08");
  assert.equal(row.components[0].data.custom_id, "recap_month_select");
  const options = row.components[0].options.map((o) => o.data);
  assert.equal(options[0].label, "September 2026");
  assert.equal(options[0].default, false);
  assert.equal(options[1].label, "Agustus 2026");
  assert.equal(options[1].default, true);
});

test("replyRecapMonth - bulan yang diminta kosong DAN cuma 1 bulan yang punya data (kasus arsip baru) -> fallback ke menu 4-opsi biasa", async () => {
  const fresh = freshRepliesForRecapRange();
  const thisMonth = getTodayWIB().slice(0, 7);
  const reply = await fresh.replyRecapMonth(thisMonth, "c-monthempty", "u-monthempty");
  assert.match(reply.content, /Cok, belum ada live yang kecatet buat bulan/);
  assert.match(reply.content, /Mau rekap yang mana, cok\?/);
  const customIds = reply.components[0].components.map((c) => c.data.custom_id);
  assert.deepEqual(customIds, ["recap_menu:today", "recap_menu:week", "recap_menu:month", "recap_menu:date", "recap_nav:close"]);
});

test("replyRecapMonth - bulan yang diminta kosong TAPI ada bulan LAIN yang punya data -> dropdown bulan lain, bukan menu 4-opsi", async () => {
  const fresh = freshRepliesForRecapRange();
  // 32 hari lalu: JAMINAN jatuh di bulan KALENDER yang beda dari sekarang
  // (bulan paling panjang 31 hari), TAPI masih dalem retensi 35 hari
  // (dailyLog.js's SESSION_RETENTION_DAYS) biar gak ke-prune diem-diem
  // sebelum sempet ke-assert.
  const otherMonthUnix = Math.floor(Date.now() / 1000) - 32 * 24 * 60 * 60;
  fresh.recordLiveEnded("Oldmonth", "jkt48_oldmonth", new Date(otherMonthUnix * 1000), new Date((otherMonthUnix + 60) * 1000), 5);

  const reply = await fresh.replyRecapMonth("1999-01", "c-monthdropdown", "u-monthdropdown");
  assert.match(reply.content, /Cok, belum ada live yang kecatet buat bulan/);
  assert.match(reply.content, /Coba bulan lain/);
  assert.equal(reply.components[0].components[0].data.custom_id, "recap_month_select");
  assert.equal(reply.components[1].components[0].data.custom_id, "recap_nav:close");
});

test("replyRecapMonth - bulan BERJALAN (sekarang) ikut gabung sesi yang MASIH LIVE (activeLives), bulan LAIN yang udah lewat enggak", async () => {
  const fresh = freshRepliesForRecapRange();
  const thisMonth = getTodayWIB().slice(0, 7);
  activeLives.set("jkt48_monthongoing", { name: "Monthongoing", username: "jkt48_monthongoing", slug: "s", liveAt: new Date().toISOString() });
  try {
    const reply = await fresh.replyRecapMonth(thisMonth, "c-monthongoing", "u-monthongoing");
    assert.match(reply.content, /📋 \*\*Rekap bulan/);
    assert.match(reply.content, /Monthongoing/);
    assert.match(reply.content, /1 masih live/);
  } finally {
    activeLives.delete("jkt48_monthongoing");
  }
});

test("replyRecapMonth - bulan yang punya sesi SELESAI -> ringkasan + tabel, dan nempelin dropdown bulan buat ganti-ganti", async () => {
  const fresh = freshRepliesForRecapRange();
  const thisMonth = getTodayWIB().slice(0, 7);
  fresh.recordLiveEnded("Monthdata", "jkt48_monthdata", new Date(Date.now() - 60_000), new Date(), 5);

  const reply = await fresh.replyRecapMonth(thisMonth, "c-monthdata", "u-monthdata");
  assert.match(reply.content, /Monthdata/);
  assert.equal(reply.components[0].components[0].data.custom_id, "recap_month_select");
});

test("replyRecapMonthGeneric - cuma 1 bulan yang punya data (kasus arsip baru) -> LANGSUNG tunjukkin bulan itu, gak nanya dropdown", async () => {
  const fresh = freshRepliesForRecapRange();
  const reply = await fresh.replyRecapMonthGeneric("c-monthgeneric1", "u-monthgeneric1");
  assert.doesNotMatch(reply.content, /Rekap bulan berapa nih/);
});

test("replyRecapMonthGeneric - lebih dari 1 bulan yang punya data -> dropdown milih bulan", async () => {
  const fresh = freshRepliesForRecapRange();
  const otherMonthUnix = Math.floor(Date.now() / 1000) - 32 * 24 * 60 * 60; // lihat komen di test sebelumnya soal kenapa 32 hari
  fresh.recordLiveEnded("Oldmonth2", "jkt48_oldmonth2", new Date(otherMonthUnix * 1000), new Date((otherMonthUnix + 60) * 1000), 5);

  const reply = await fresh.replyRecapMonthGeneric("c-monthgeneric2", "u-monthgeneric2");
  assert.equal(reply.content, "Rekap bulan berapa nih, cok?");
  assert.equal(reply.components[0].components[0].data.custom_id, "recap_month_select");
  assert.equal(reply.components[1].components[0].data.custom_id, "recap_nav:close");
});

test("replyRecapSpecificDate - tanggal yang ada sesinya -> langsung tabel rekap tanggal itu", async () => {
  const fresh = freshRepliesForRecapRange();
  const threeDaysAgo = Math.floor(Date.now() / 1000) - 3 * 24 * 60 * 60;
  const targetDate = getDateWIB(new Date(threeDaysAgo * 1000));
  fresh.recordLiveEnded("Specdate", "jkt48_specdate", new Date(threeDaysAgo * 1000), new Date((threeDaysAgo + 60) * 1000), 5);

  const reply = await fresh.replyRecapSpecificDate(targetDate, "c-specdate", "u-specdate");
  assert.match(reply.content, /📋 \*\*Rekap tanggal/);
  assert.match(reply.content, /Specdate/);
});

test("replyRecapSpecificDate - tanggal yang gak ada datanya (sebelum bot mulai/emang kosong) -> 'gak ada data' + fallback menu 4-opsi", async () => {
  const fresh = freshRepliesForRecapRange();
  const reply = await fresh.replyRecapSpecificDate("2000-01-01", "c-specdateempty", "u-specdateempty");
  assert.match(reply.content, /Cok, gak ada data rekap buat tanggal/);
  assert.match(reply.content, /Mau rekap yang mana, cok\?/);
  const customIds = reply.components[0].components.map((c) => c.data.custom_id);
  assert.deepEqual(customIds, ["recap_menu:today", "recap_menu:week", "recap_menu:month", "recap_menu:date", "recap_nav:close"]);
});

test("replyRecapWeekdayPicker - hari yang beneran ada tanggalnya di rentang yang kecatet -> dropdown tanggal buat hari itu + tombol tutup", async () => {
  const fresh = freshRepliesForRecapRange();
  const idx = todayWeekdayIndex();
  const reply = await fresh.replyRecapWeekdayPicker(idx);
  assert.equal(reply.content, `${WEEKDAY_NAMES_ID_TEST[idx]} tanggal berapa nih, cok?`);
  assert.equal(reply.components[0].components[0].data.custom_id, "recap_date_select");
  assert.equal(reply.components[1].components[0].data.custom_id, "recap_nav:close");
  // Hari ini sendiri (weekday-nya PASTI cocok ke idx) harus jadi salah satu
  // opsi - value-nya di-TAG weekday-nya ("YYYY-MM-DD#W", §10's thirty-
  // seventh item), BUKAN tanggal polos, biar milih dari sini "inget" filter
  // weekday-nya pas tabelnya muncul (lihat parseDateRangeValue).
  const values = reply.components[0].components[0].options.map((o) => o.data.value);
  assert.ok(values.includes(`${getTodayWIB()}#${idx}`));
});

test("replyRecapWeekdayPicker - arsip dibatesin sampe HARI INI doang (earliestDate = hari ini) DAN hari ini BUKAN hari yang diminta -> gak ada tanggal ketemu, dikasih tau jujur", async () => {
  const fresh = freshRepliesForRecapRange();
  fresh.recordLiveEnded("Weekdaybound", "jkt48_weekdaybound", new Date(Date.now() - 60_000), new Date(), 5); // earliestSessionDate jadi HARI INI

  const otherIdx = (todayWeekdayIndex() + 1) % 7;
  const reply = await fresh.replyRecapWeekdayPicker(otherIdx);
  assert.equal(typeof reply, "string");
  assert.match(reply, new RegExp(`belum ada tanggal hari ${WEEKDAY_NAMES_ID_TEST[otherIdx]} yang kecatet`));
});

test("handleRecapMonthSelect - EDIT pesan (update) ke rekap bulan yang dipilih, BUKAN kirim pesan baru", async () => {
  const fresh = freshRepliesForRecapRange();
  const thisMonth = getTodayWIB().slice(0, 7);
  fresh.recordLiveEnded("Monthselect", "jkt48_monthselect", new Date(Date.now() - 60_000), new Date(), 5);

  const interaction = fakeInteraction({ customId: "recap_month_select", values: [thisMonth] });
  await fresh.handleRecapMonthSelect(interaction);

  assert.equal(interaction.calls.length, 0);
  assert.equal(interaction.updates.length, 1);
  assert.match(interaction.updates[0].content, /Monthselect/);
});

// Rekap bulan yang isinya BANYAK (>1 halaman) harus dapet tombol "🔢 Lompat
// halaman" juga, sama kayak rekap minggu/bulan-rolling (number) - bulan
// KALENDER (string "YYYY-MM") secara logis bisa sama panjangnya, jadi harus
// diperlakukan sama.
test("replyRecapMonth - bulan dengan lebih dari 1 halaman dapet tombol '🔢 Lompat halaman' juga (bukan cuma rentang N-hari)", async () => {
  const fresh = freshRepliesForRecapRange();
  const thisMonth = getTodayWIB().slice(0, 7);
  for (let i = 0; i < 25; i++) {
    fresh.recordLiveEnded(`Monthpage${i}`, `jkt48_monthpagetest${i}`, new Date(Date.now() - 120_000), new Date(Date.now() - 60_000), 5);
  }

  const reply = await fresh.replyRecapMonth(thisMonth, "c-monthjump", "u-monthjump");
  const navRow = reply.components[1];
  const jumpButton = navRow.components.find((b) => b.data.custom_id.startsWith("recap_nav:jump:"));
  assert.ok(jumpButton, "harus ada tombol lompat halaman");
  assert.equal(jumpButton.data.custom_id, `recap_nav:jump:m${thisMonth}:0`);
});

test("handleRecapMenuButton - pilihan 'today'/'week'/'month' EDIT pesan menu-nya (update), BUKAN kirim pesan baru", async () => {
  for (const choice of ["today", "week", "month"]) {
    const interaction = fakeInteraction({ customId: `recap_menu:${choice}` });
    await handleRecapMenuButton(interaction);
    assert.equal(interaction.calls.length, 0, `${choice}: gak boleh reply()`);
    assert.equal(interaction.updates.length, 1, `${choice}: harus update() sekali`);
    assert.ok(interaction.updates[0].content, `${choice}: harus ada konten`);
  }
});

test("handleRecapMenuButton - pilihan 'date' EDIT pesan jadi dropdown tanggal (buildRecapDatePickerBlock), BUKAN kirim pesan baru", async () => {
  const interaction = fakeInteraction({ customId: "recap_menu:date" });
  await handleRecapMenuButton(interaction);
  assert.equal(interaction.calls.length, 0);
  assert.equal(interaction.updates[0].content, "Rekap tanggal berapa nih, cok?");
  assert.equal(interaction.updates[0].components[0].components[0].data.custom_id, "recap_date_select");
});

test("handleRecapMenuButton - nge-clear pendingRecapPage SEBELUM render, biar rekap laen yang lagi di-page-in sebelumnya gak nyangkut basi", async () => {
  const {
    recordLiveEnded: freshRecordLiveEnded,
    replyRecapRange: freshReplyRecapRange,
    tryHandleRecapPageShortcut: freshTryHandleRecapPageShortcut,
    handleRecapMenuButton: freshHandleRecapMenuButton,
  } = freshRepliesForRecapRange();

  const now = Date.now();
  const threeDaysAgo = Math.floor(now / 1000) - 3 * 24 * 60 * 60;
  for (let i = 0; i < 25; i++) {
    freshRecordLiveEnded(
      `Menubtn${i}`,
      `jkt48_menubtntest${i}`,
      new Date((threeDaysAgo + i * 60) * 1000),
      new Date((threeDaysAgo + i * 60 + 30) * 1000),
      5,
    );
  }

  const channelId = "c-menubtn";
  const authorId = "u-menubtn";
  await freshReplyRecapRange(7, "minggu ini", channelId, authorId); // nge-set pendingRecapPage (multi-halaman)

  // Pilihan "date" gak nge-set pendingRecapPage sama sekali (belum ada
  // tabel) - jadi state lama dari rekap minggu ini di atas HARUS kehapus,
  // bukan nyangkut.
  const dateChoice = fakeInteraction({ customId: "recap_menu:date", channelId, authorId });
  await freshHandleRecapMenuButton(dateChoice);

  const afterChoice = await freshTryHandleRecapPageShortcut("y", channelId, authorId);
  assert.equal(afterChoice, null, "pendingRecapPage harus udah kehapus, bukan nerusin halaman rekap minggu ini yang lama");
});

test("handleRecapDateSelect - tanggal yang ada sesinya -> tabel rekap tanggal itu, EDIT pesan (update), bukan pesan baru", async () => {
  const { recordLiveEnded: freshRecordLiveEnded, handleRecapDateSelect: freshHandleRecapDateSelect } = freshRepliesForRecapRange();

  const now = Date.now();
  const threeDaysAgo = Math.floor(now / 1000) - 3 * 24 * 60 * 60;
  const targetDate = getDateWIB(new Date(threeDaysAgo * 1000));
  freshRecordLiveEnded("Datepicked", "jkt48_datepicked", new Date(threeDaysAgo * 1000), new Date((threeDaysAgo + 60) * 1000), 5);

  const interaction = fakeInteraction({ customId: "recap_date_select", values: [targetDate] });
  await freshHandleRecapDateSelect(interaction);

  assert.equal(interaction.calls.length, 0, "gak boleh kirim pesan baru (reply)");
  assert.match(interaction.updates[0].content, /Rekap tanggal/);
  assert.match(interaction.updates[0].content, /Datepicked/);
  // Dropdown-nya harus tetep nempel (baris pertama) biar bisa ganti tanggal lagi.
  assert.equal(interaction.updates[0].components[0].components[0].data.custom_id, "recap_date_select");
});

// BUG SEBELUMNYA: buildRecapDateSelectRow dulu SENGAJA gak pernah nawarin
// hari ini sebagai opsi (lihat komen di situ) - begitu itu dibenerin,
// handleRecapDateSelect masih manggil getCompletedSessionsForDate langsung
// (bukan getSessionsForRange), yang CUMA nyakup sesi yang UDAH SELESAI. Milih
// hari ini dari dropdown ini bakal kelewatan sesi yang MASIH LIVE detik ini -
// beda dari tombol "Rekap hari ini" yang emang udah gabung activeLives dari
// awal - kelihatan kayak bug baru ("kok yang lagi live gak muncul").
test("handleRecapDateSelect - milih HARI INI dari dropdown -> ikut gabung sesi yang MASIH LIVE (activeLives), sama kayak tombol 'Rekap hari ini'", async () => {
  const fresh = freshRepliesForRecapRange();
  activeLives.set("jkt48_datetoday", { name: "Datetoday", username: "jkt48_datetoday", slug: "s", liveAt: new Date().toISOString() });
  try {
    const interaction = fakeInteraction({ customId: "recap_date_select", values: [getTodayWIB()] });
    await fresh.handleRecapDateSelect(interaction);
    assert.match(interaction.updates[0].content, /Datetoday/);
  } finally {
    activeLives.delete("jkt48_datetoday");
  }
});

test("handleRecapDateSelect - tanggal yang KOSONG (gak ada sesi) -> pesan 'belum ada', TAPI dropdown+tombol tutup tetep ada biar bisa coba tanggal lain", async () => {
  const interaction = fakeInteraction({ customId: "recap_date_select", values: ["2000-01-01"] });
  await handleRecapDateSelect(interaction);

  assert.match(interaction.updates[0].content, /Cok, belum ada live yang kecatet tanggal/);
  assert.equal(interaction.updates[0].components.length, 2, "dropdown + tombol tutup harus tetep ada");
  assert.equal(interaction.updates[0].components[0].components[0].data.custom_id, "recap_date_select");
  assert.equal(interaction.updates[0].components[1].components[0].data.custom_id, "recap_nav:close");
});

test("handleRecapDateSelect - customId tombol Maju/Mundur/Cari di tabel yang dihasilin pake encoding tanggal 'd<YYYY-MM-DD>', bukan angka hari-mundur", async () => {
  const now = Date.now();
  const threeDaysAgo = Math.floor(now / 1000) - 3 * 24 * 60 * 60;
  const targetDate = getDateWIB(new Date(threeDaysAgo * 1000));
  recordLiveEnded("Datepicked2", "jkt48_datepicked2", new Date(threeDaysAgo * 1000), new Date((threeDaysAgo + 60) * 1000), 5);

  const interaction = fakeInteraction({ customId: "recap_date_select", values: [targetDate] });
  await handleRecapDateSelect(interaction);

  const navRow = interaction.updates[0].components[1]; // baris ke-2: dropdown di baris ke-1
  const searchButton = navRow.components.find((b) => b.data.custom_id.startsWith("recap_nav:search:"));
  assert.equal(searchButton.data.custom_id, `recap_nav:search:d${targetDate}`);
});

// §10's thirty-seventh item, bug beneran yang dilaporin owner: milih
// tanggal dari dropdown weekday ("cok rekap senin") nunjukkin tabelnya
// bener, TAPI dropdown yang nempel di tabel itu (buat ganti-ganti tanggal)
// balik nunjukkin SEMUA tanggal, bukan tetep di-filter ke hari itu doang.
test("handleRecapDateSelect - milih tanggal dari dropdown WEEKDAY (ke-tag '#W') -> dropdown yang nempel di tabelnya TETEP di-filter ke hari itu, BUKAN balik ke semua tanggal", async () => {
  const fresh = freshRepliesForRecapRange();
  const threeDaysAgo = Math.floor(Date.now() / 1000) - 3 * 24 * 60 * 60;
  const targetDate = getDateWIB(new Date(threeDaysAgo * 1000));
  const weekdayIdx = WEEKDAY_NAMES_ID_TEST.indexOf(WEEKDAY_FORMATTER_WIB.format(new Date(threeDaysAgo * 1000)));
  fresh.recordLiveEnded("Weekdaytagged", "jkt48_weekdaytagged", new Date(threeDaysAgo * 1000), new Date((threeDaysAgo + 60) * 1000), 5);

  const interaction = fakeInteraction({ customId: "recap_date_select", values: [`${targetDate}#${weekdayIdx}`] });
  await fresh.handleRecapDateSelect(interaction);

  // Label/isi tabelnya harus make sense (tag-nya kelucutin, BUKAN nyoba
  // bikin Date dari "2026-09-14#1T00:00:00+07:00" yang bakal Invalid Date).
  assert.match(interaction.updates[0].content, /Weekdaytagged/);
  assert.doesNotMatch(interaction.updates[0].content, /Invalid Date/);

  // Dropdown yang nempel HARUS placeholder-nya masih "Pilih tanggal hari
  // <X>" (buildWeekdayDateSelectRow), BUKAN "Pilih tanggal buat rekap"
  // (buildRecapDateSelectRow, dropdown semua tanggal) - ini persis bug-nya.
  const dateRow = interaction.updates[0].components[0];
  assert.equal(dateRow.components[0].data.custom_id, "recap_date_select");
  assert.match(dateRow.components[0].data.placeholder, /^Pilih tanggal hari /);
  const optionValues = dateRow.components[0].options.map((o) => o.data.value);
  assert.ok(
    optionValues.every((v) => v.endsWith(`#${weekdayIdx}`)),
    "semua opsi di dropdown harus tetep ke-tag weekday yang sama, bukan tanggal bebas",
  );
});

test("handleRecapDateSelect - tanggal WEEKDAY yang kosong (gak ada sesi) -> dropdown fallback-nya TETEP yang di-filter weekday, bukan dropdown semua tanggal", async () => {
  const fresh = freshRepliesForRecapRange();
  const idx = todayWeekdayIndex();
  const interaction = fakeInteraction({ customId: "recap_date_select", values: [`2000-01-01#${idx}`] });
  await fresh.handleRecapDateSelect(interaction);

  assert.match(interaction.updates[0].content, /Cok, belum ada live yang kecatet tanggal/);
  const dateRow = interaction.updates[0].components[0];
  assert.match(dateRow.components[0].data.placeholder, /^Pilih tanggal hari /);
});

test("handleRecapDateSelect - milih tanggal LAIN nge-clear pendingRecapPage tanggal SEBELUMNYA (ganti-ganti tanggal gak nyisain state basi)", async () => {
  const {
    recordLiveEnded: freshRecordLiveEnded,
    tryHandleRecapPageShortcut: freshTryHandleRecapPageShortcut,
    handleRecapDateSelect: freshHandleRecapDateSelect,
  } = freshRepliesForRecapRange();

  const now = Date.now();
  const threeDaysAgo = Math.floor(now / 1000) - 3 * 24 * 60 * 60;
  const firstDate = getDateWIB(new Date(threeDaysAgo * 1000));
  for (let i = 0; i < 25; i++) {
    freshRecordLiveEnded(
      `Multi${i}`,
      `jkt48_multidatetest${i}`,
      new Date((threeDaysAgo + i * 60) * 1000),
      new Date((threeDaysAgo + i * 60 + 30) * 1000),
      5,
    );
  }

  const channelId = "c-datepick";
  const authorId = "u-datepick";
  const firstPick = fakeInteraction({ customId: "recap_date_select", channelId, authorId, values: [firstDate] });
  await freshHandleRecapDateSelect(firstPick); // 25 sesi di 1 tanggal -> 2 halaman -> nge-set pendingRecapPage

  const secondPick = fakeInteraction({ customId: "recap_date_select", channelId, authorId, values: ["2000-01-01"] }); // kosong
  await freshHandleRecapDateSelect(secondPick);

  const afterSecondPick = await freshTryHandleRecapPageShortcut("y", channelId, authorId);
  assert.equal(afterSecondPick, null, "pendingRecapPage tanggal PERTAMA harus udah kehapus, gak boleh nyangkut ke tanggal kedua yang kosong");
});
