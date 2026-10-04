require("./helpers/setupTestEnv");

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { computeServerWrapped, computeMemberWrapped, totalsByMember, busiestHour } = require("../src/wrapped");
const { replyWrapped, drawWrappedCard, buildServerCard, buildMemberCard, hoursText } = require("../src/chat/wrappedCard");
const { recordLiveEnded } = require("../src/storage/dailyLog");
const { recordLiveCompleted } = require("../src/storage/liveCount");
const { buildChatReply } = require("../src/chat/router");

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Sesi: mulai jam 20.00 WIB (13:00 UTC) di hari-hari tertentu. 2026-09-01 = Selasa.
const session = (username, name, startIso, minutes, peak = null) => {
  const startedAtUnix = Math.floor(new Date(startIso).getTime() / 1000);
  return { name, username, startedAtUnix, endedAtUnix: startedAtUnix + minutes * 60, durationMs: minutes * 60_000, peakViewCount: peak };
};
const SESSIONS = [
  session("jkt48_wa", "Wa", "2026-09-01T20:00:00+07:00", 60, 300),
  session("jkt48_wa", "Wa", "2026-09-08T20:30:00+07:00", 120, 500), // Selasa lagi
  session("jkt48_wa", "Wa", "2026-09-15T21:00:00+07:00", 30, null),
  session("jkt48_wb", "Wb", "2026-09-03T10:00:00+07:00", 45, 900),
  session("jkt48_wc", "Wc", "2026-09-04T20:00:00+07:00", 10, 50),
];

test("computeServerWrapped - total, top member, terpanjang, puncak penonton, jam & hari tersibuk, streak terpanjang; kosong -> null", () => {
  assert.equal(computeServerWrapped([]), null);
  const w = computeServerWrapped(SESSIONS, { jkt48_wa: 3, jkt48_wb: 7, jkt48_wc: 0 });
  assert.equal(w.sessionCount, 5);
  assert.equal(w.memberCount, 3);
  assert.equal(w.totalDurationMs, (60 + 120 + 30 + 45 + 10) * 60_000);
  assert.deepEqual(
    w.topMembers.map((m) => m.username),
    ["jkt48_wa", "jkt48_wb", "jkt48_wc"],
  );
  assert.equal(w.mostSessions.username, "jkt48_wa");
  assert.equal(w.longest.durationMs, 120 * 60_000);
  assert.equal(w.peak.name, "Wb");
  assert.equal(w.peak.peakViewCount, 900);
  assert.equal(w.busiestHour, 20);
  assert.equal(w.topWeekday, "Selasa");
  assert.deepEqual(w.topStreak, { name: "Wb", days: 7 });
  assert.equal(computeServerWrapped(SESSIONS).topStreak, null, "tanpa data streak");
});

test("computeMemberWrapped - rata-rata, peringkat, jam favorit; member tanpa sesi -> null", () => {
  const w = computeMemberWrapped(SESSIONS, "jkt48_wa", 4);
  assert.equal(w.sessionCount, 3);
  assert.equal(w.totalDurationMs, 210 * 60_000);
  assert.equal(w.avgDurationMs, 70 * 60_000);
  assert.equal(w.rank, 1);
  assert.equal(w.memberCount, 3);
  assert.equal(w.busiestHour, 20);
  assert.equal(w.peak.peakViewCount, 500);
  assert.equal(w.streak, 4);
  assert.equal(computeMemberWrapped(SESSIONS, "jkt48_wc").rank, 3);
  assert.equal(computeMemberWrapped(SESSIONS, "jkt48_tidakada"), null);
});

test("totalsByMember / busiestHour - urutan & kosong", () => {
  assert.equal(totalsByMember(SESSIONS)[0].username, "jkt48_wa");
  assert.equal(busiestHour(Array.from({ length: 24 }, () => 0)), null);
});

test("hoursText - satu desimal, koma", () => {
  assert.equal(hoursText(90 * 60_000), "1,5 jam");
  assert.equal(hoursText(0), "0 jam");
});

test("drawWrappedCard - PNG valid untuk kartu server (batang) dan member (histogram), nama sangat panjang tidak error", () => {
  const server = drawWrappedCard(buildServerCard(computeServerWrapped(SESSIONS, { jkt48_wa: 2 })));
  assert.deepEqual(server.subarray(0, 8), PNG_SIGNATURE);
  const member = drawWrappedCard(buildMemberCard(computeMemberWrapped(SESSIONS, "jkt48_wb", 0)));
  assert.deepEqual(member.subarray(0, 8), PNG_SIGNATURE);
  const longName = computeMemberWrapped([session("jkt48_x", "N".repeat(200), "2026-09-01T10:00:00+07:00", 5)], "jkt48_x");
  assert.ok(drawWrappedCard(buildMemberCard(longName)).length > 100);
});

test("replyWrapped - kosong / member / tidak dikenal; router 'cok wrapped' & 'cok wrapped <nama>'", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ data: null }) });
  try {
    // Arsip kosong di awal file test ini.
    assert.match(await replyWrapped(""), /belum ada sesi live/);

    const now = Date.now();
    recordLiveCompleted("jkt48_wrapa", "Wrapa JKT48");
    recordLiveCompleted("jkt48_wrapb", "Wrapb JKT48");
    recordLiveEnded("Wrapa JKT48", "jkt48_wrapa", new Date(now - 3 * 3600_000), new Date(now - 2 * 3600_000), 120);
    recordLiveEnded("Wrapb JKT48", "jkt48_wrapb", new Date(now - 5 * 3600_000), new Date(now - 4 * 3600_000), 80);

    const server = await replyWrapped("");
    assert.match(server.content, /JKT48 Live Wrapped/);
    assert.equal(server.files.length, 1);
    assert.equal(server.components.length, 1);

    const member = await replyWrapped("wrapa");
    assert.match(member.content, /Wrapped Wrapa JKT48/);

    recordLiveCompleted("jkt48_wrapkosong", "Wrapkosong JKT48"); // dikenal, tapi tak ada sesi di arsip
    assert.match(await replyWrapped("wrapkosong"), /belum punya sesi live/);
    assert.match(await replyWrapped("zzznamangawur"), /zzznamangawur/);

    const viaRouter = await buildChatReply("cok wrapped", { isBotChannel: true, authorId: "w-u" });
    assert.match(viaRouter.content, /Live Wrapped/);
    const viaRouterMember = await buildChatReply("cok wrapped wrapb", { isBotChannel: true, authorId: "w-u" });
    assert.match(viaRouterMember.content, /Wrapped Wrapb JKT48/);
    const viaKartu = await buildChatReply("cok kartu wrapped wrapa", { isBotChannel: true, authorId: "w-u" });
    assert.match(viaKartu.content, /Wrapped Wrapa JKT48/);
  } finally {
    global.fetch = originalFetch;
  }
});
