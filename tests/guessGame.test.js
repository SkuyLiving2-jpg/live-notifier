require("./helpers/setupTestEnv");

const { test } = require("node:test");
const assert = require("node:assert/strict");
const game = require("../src/storage/guessGame");
const { parseGuessMinutes } = require("../src/chat/guessFlow");
const { buildDurationResultText, buildNextResultText } = require("../src/notify/guessGame");
const { activeLives } = require("../src/storage/activeLives");
const { recordLiveCompleted } = require("../src/storage/liveCount");
const { checkLiveMembers } = require("../src/monitor");
const { buildChatReply } = require("../src/chat/router");

const textOf = (reply) => (typeof reply === "string" ? reply : reply.content);
const say = async (message, authorId) => textOf(await buildChatReply(message, { isBotChannel: true, authorId, channelId: "chan-g" }));

test("parseGuessMinutes - menit polos, jam, jam+menit, pecahan; sampah -> null", () => {
  assert.equal(parseGuessMinutes("90"), 90);
  assert.equal(parseGuessMinutes("90 menit"), 90);
  assert.equal(parseGuessMinutes("90m"), 90);
  assert.equal(parseGuessMinutes("1 jam"), 60);
  assert.equal(parseGuessMinutes("1.5 jam"), 90);
  assert.equal(parseGuessMinutes("1,5 jam"), 90);
  assert.equal(parseGuessMinutes("1 jam 30 menit"), 90);
  assert.equal(parseGuessMinutes("1j30m"), 90);
  assert.equal(parseGuessMinutes("2j"), 120);
  assert.equal(parseGuessMinutes("abc"), null);
  assert.equal(parseGuessMinutes(""), null);
  assert.equal(parseGuessMinutes("90 detik"), null);
});

// ---------- storage: tebak durasi ----------
test("tebak durasi - urutan terdekat dapat 3/2/1, bonus +2 untuk selisih <= 2 menit, ronde dihapus setelah selesai", () => {
  const liveAtUnix = 1_800_000_000;
  const place = (userId, minutes, now) => game.placeDurationGuess({ username: "jkt48_gd1", name: "Gd1", liveAtUnix, userId, minutes, now });
  assert.equal(place("g-a", 60, 1000).ok, true);
  assert.equal(place("g-b", 90, 2000).ok, true);
  assert.equal(place("g-c", 30, 3000).ok, true);
  assert.equal(place("g-d", 200, 4000).ok, true);
  assert.equal(place("g-b", 88, 5000).replaced, true, "mengganti tebakan sendiri");

  const result = game.resolveDurationRound("jkt48_gd1", liveAtUnix, 89 * 60_000);
  assert.deepEqual(
    result.ranking.map((r) => [r.userId, r.points]),
    [
      ["g-b", 5], // selisih 1 menit: 3 + bonus 2
      ["g-a", 2], // selisih 29
      ["g-c", 1], // selisih 59
      ["g-d", 0],
    ],
  );
  assert.equal(result.ranking[0].exact, true);
  assert.equal(game.getDurationRound("jkt48_gd1", liveAtUnix), null, "ronde sudah ditutup");
  assert.equal(game.resolveDurationRound("jkt48_gd1", liveAtUnix, 89 * 60_000), null, "tidak bisa dihitung dua kali");
  assert.deepEqual(game.getUserScore("g-b"), { points: 5, wins: 1, plays: 1 });
  assert.deepEqual(game.getUserScore("g-d"), { points: 0, wins: 0, plays: 1 });
});

test("tebak durasi - seri selisih: yang menebak lebih dulu menang; penebak tunggal tidak dihitung; sesi beda/durasi aneh dibuang", () => {
  const liveAtUnix = 1_800_100_000;
  game.placeDurationGuess({ username: "jkt48_gd2", name: "Gd2", liveAtUnix, userId: "t-late", minutes: 70, now: 9000 });
  game.placeDurationGuess({ username: "jkt48_gd2", name: "Gd2", liveAtUnix, userId: "t-early", minutes: 50, now: 1000 });
  const tie = game.resolveDurationRound("jkt48_gd2", liveAtUnix, 60 * 60_000);
  assert.equal(tie.ranking[0].userId, "t-early");

  game.placeDurationGuess({ username: "jkt48_gd3", name: "Gd3", liveAtUnix, userId: "solo", minutes: 60 });
  assert.equal(game.resolveDurationRound("jkt48_gd3", liveAtUnix, 60 * 60_000), null, "satu penebak: tidak ada lawan");
  assert.equal(game.getUserScore("solo").plays, 0);

  game.placeDurationGuess({ username: "jkt48_gd4", name: "Gd4", liveAtUnix, userId: "x1", minutes: 60 });
  game.placeDurationGuess({ username: "jkt48_gd4", name: "Gd4", liveAtUnix, userId: "x2", minutes: 61 });
  assert.equal(game.resolveDurationRound("jkt48_gd4", liveAtUnix + 999, 60 * 60_000), null, "liveAt beda = sesi lain");
  game.placeDurationGuess({ username: "jkt48_gd5", name: "Gd5", liveAtUnix, userId: "y1", minutes: 60 });
  game.placeDurationGuess({ username: "jkt48_gd5", name: "Gd5", liveAtUnix, userId: "y2", minutes: 61 });
  assert.equal(game.resolveDurationRound("jkt48_gd5", liveAtUnix, Number.NaN), null);
  assert.equal(game.getDurationRound("jkt48_gd5", liveAtUnix), null);
});

test("tebak durasi - sesi baru menggantikan ronde lama; input tidak valid ditolak; username berbahaya aman", () => {
  const base = { username: "jkt48_gd6", name: "Gd6", userId: "v1" };
  game.placeDurationGuess({ ...base, liveAtUnix: 100, minutes: 30 });
  game.placeDurationGuess({ ...base, liveAtUnix: 200, minutes: 40, userId: "v2" });
  assert.equal(game.getDurationRound("jkt48_gd6", 100), null);
  assert.deepEqual(Object.keys(game.getDurationRound("jkt48_gd6", 200).guesses), ["v2"]);
  game.discardDurationRound("jkt48_gd6");
  assert.equal(game.getDurationRound("jkt48_gd6", 200), null);

  assert.equal(game.placeDurationGuess({ ...base, liveAtUnix: 1, minutes: 0 }).ok, false);
  assert.equal(game.placeDurationGuess({ ...base, liveAtUnix: 1, minutes: 99999 }).ok, false);
  assert.equal(game.placeDurationGuess({ ...base, liveAtUnix: 1, minutes: Number.NaN }).ok, false);
  assert.equal(game.placeDurationGuess({ ...base, userId: "__proto__", liveAtUnix: 1, minutes: 5 }).ok, false);
  assert.equal(game.placeDurationGuess({ ...base, username: "__proto__", liveAtUnix: 1, minutes: 5 }).ok, false);
  assert.equal(game.getDurationRound("__proto__", 1), null);
});

// ---------- storage: tebak berikutnya ----------
test("tebak berikutnya - yang benar +2, yang meleset 0 poin, ronde selesai; ronde basi (> 6 jam) dibuang tanpa poin", () => {
  const t0 = 2_000_000_000_000;
  game.placeNextGuess({ userId: "n-a", username: "jkt48_nx1", now: t0 });
  game.placeNextGuess({ userId: "n-b", username: "jkt48_nx2", now: t0 + 1000 });
  assert.equal(game.placeNextGuess({ userId: "n-b", username: "jkt48_nx1", now: t0 + 2000 }).replaced, true);
  assert.equal(game.getNextRound(t0 + 3000).guesses["n-b"], "jkt48_nx1");

  const result = game.resolveNextRound("jkt48_nx1", t0 + 5000);
  assert.deepEqual(result.winners.sort(), ["n-a", "n-b"]);
  assert.equal(result.losers.length, 0);
  assert.equal(game.getUserScore("n-a").points, 2);
  assert.equal(game.getNextRound(t0 + 6000), null);
  assert.equal(game.resolveNextRound("jkt48_nx1", t0 + 6000), null, "tidak ada ronde terbuka");

  game.placeNextGuess({ userId: "n-c", username: "jkt48_nx3", now: t0 });
  assert.equal(game.resolveNextRound("jkt48_nx3", t0 + game.NEXT_ROUND_TTL_MS + 1), null, "ronde basi");
  assert.equal(game.getUserScore("n-c").points, 0);
});

test("papan skor - urut poin, bulan ini terpisah, bulan lama dipangkas", () => {
  const board = game.getScoreboard();
  assert.ok(board.allTime.length > 0);
  for (let i = 1; i < board.allTime.length; i++) assert.ok(board.allTime[i - 1].points >= board.allTime[i].points);
  assert.ok(game.load().monthly[game.monthKeyOf(Date.now())] || board.month.length === 0);
  assert.ok(Object.keys(game.load().monthly).length <= 3);
});

test("teks pengumuman - peringkat, bonus, dan 'dan N penebak lain' untuk daftar panjang", () => {
  const ranking = Array.from({ length: 12 }, (_, i) => ({ userId: `u${i}`, minutes: 60 + i, diff: i, points: i === 0 ? 5 : 0, exact: i === 0 }));
  const text = buildDurationResultText({ name: "Nala", durationMs: 61 * 60_000, ranking });
  assert.match(text, /Hasil tebak durasi live Nala/);
  assert.match(text, /1j 1m/);
  assert.match(text, /🥇 <@u0>.*\+5 poin.*tepat banget/);
  assert.match(text, /dan 4 penebak lain/);
  assert.ok(text.length < 2000);
  assert.match(buildNextResultText("Levi", { winners: ["a"], losers: ["b", "c"], total: 3 }), /Levi.*berikutnya[\s\S]*<@a>[\s\S]*2 orang meleset/);
  assert.match(buildNextResultText("Levi", { winners: [], losers: ["b"], total: 1 }), /Gak ada yang nebak bener/);
});

// ---------- chat ----------
test("chat - tebak durasi: sukses, ganti tebakan, ditutup setelah 15 menit, bukan live, durasi tak terbaca, tanpa user", async () => {
  const now = Date.now();
  activeLives.set("jkt48_gchat", {
    name: "Gchat JKT48",
    username: "jkt48_gchat",
    slug: "s",
    liveAt: new Date(now - 3 * 60_000).toISOString(),
    viewCount: 5,
  });
  activeLives.set("jkt48_gtelat", {
    name: "Gtelat JKT48",
    username: "jkt48_gtelat",
    slug: "s",
    liveAt: new Date(now - 30 * 60_000).toISOString(),
    viewCount: 5,
  });
  recordLiveCompleted("jkt48_gtidak", "Gtidak JKT48");
  try {
    const first = await say("cok tebak gchat 90", "chat-u1");
    assert.match(first, /Tebakan kamu masuk/);
    assert.match(first, /1j 30m/);
    assert.match(first, /minimal 2 orang/);
    assert.match(await say("cok tebak gchat 1 jam", "chat-u1"), /Tebakan kamu diganti.*1j 0m/);
    assert.match(await say("cok tebak gchat 45", "chat-u2"), /2 penebak/);

    assert.match(await say("cok tebak gtelat 60", "chat-u1"), /udah ditutup/);
    assert.match(await say("cok tebak gtidak 60", "chat-u1"), /lagi gak live/);
    assert.match(await say("cok tebak gchat 5 detik", "chat-u1"), /Durasinya gak kebaca/);
    assert.match(await say("cok tebak gchat 99999", "chat-u1"), /antara 1 menit sampai 12 jam/);

    const overview = await say("cok tebak", "chat-u1");
    assert.match(overview, /Gchat JKT48.*menit lagi \(2 penebak\).*tebakanmu: 1j 0m/s);
    assert.doesNotMatch(overview, /Gtelat JKT48 - tebakan dibuka/);

    const noUser = textOf(await buildChatReply("cok tebak gchat 60", { isBotChannel: true, authorId: null }));
    assert.match(noUser, /perlu tau kamu siapa/);
  } finally {
    activeLives.delete("jkt48_gchat");
    activeLives.delete("jkt48_gtelat");
    game.discardDurationRound("jkt48_gchat");
  }
});

test("chat - tebak berikutnya: member dikenal, yang sudah live ditolak, ganti tebakan; papan skor tampil", async () => {
  recordLiveCompleted("jkt48_gnext", "Gnext JKT48");
  recordLiveCompleted("jkt48_glive", "Glive JKT48");
  activeLives.set("jkt48_glive", { name: "Glive JKT48", username: "jkt48_glive", slug: "s", liveAt: new Date().toISOString(), viewCount: 1 });
  try {
    assert.match(await say("cok tebak berikutnya gnext", "next-u1"), /Tebakan kamu masuk.*Gnext JKT48/);
    assert.match(await say("cok tebak berikutnya gnext", "next-u1"), /diganti/);
    assert.match(await say("cok tebak berikutnya glive", "next-u1"), /udah live sekarang/);
    assert.match(await say("cok tebak", "next-u1"), /siapa live berikutnya" lagi buka: 1 penebak/);
    assert.match(await say("cok papan tebak", "next-u1"), /Papan skor tebak-tebakan[\s\S]*Bulan ini[\s\S]*Sepanjang masa/);
    assert.match(await say("cok skor tebak", "next-u1"), /Papan skor/);
  } finally {
    activeLives.delete("jkt48_glive");
    game.resolveNextRound("jkt48_gnext");
  }
});

// ---------- integrasi monitor ----------
function withIdnCycles(cycles, bodies) {
  const originalFetch = global.fetch;
  let cycle = -1;
  global.fetch = async (url, options) => {
    if (String(url).includes("idn.app")) {
      const page = JSON.parse(options.body).variables.page;
      if (page === 1) cycle++;
      const lives = page === 1 ? cycles[Math.min(cycle, cycles.length - 1)] : [];
      return { ok: true, json: async () => ({ data: { getLivestreams: lives } }) };
    }
    bodies.push(JSON.parse(options.body));
    return { ok: true, json: async () => ({}) };
  };
  return () => {
    global.fetch = originalFetch;
  };
}

test("monitor - live selesai: hasil tebak durasi diumumkan sekali & poin masuk; member lain mulai live: tebak berikutnya diumumkan", async () => {
  const username = "jkt48_gmon";
  const other = "jkt48_gmon2";
  const realNow = Date.now;
  const base = realNow();
  let tick = 0;
  Date.now = () => base + tick * 20_000;
  const liveAt = new Date(base - 10 * 60_000).toISOString();
  const liveAtUnix = Math.floor(new Date(liveAt).getTime() / 1000);
  const entry = (u, name, at) => ({
    creator: { username: u, name, bio_description: "" },
    slug: `slug-${u}`,
    live_at: at,
    view_count: 10,
    image_url: null,
  });
  const bodies = [];
  const restore = withIdnCycles(
    [
      [entry(username, "Gmon", liveAt)],
      [entry(username, "Gmon", liveAt), entry(other, "Gmon2", new Date(base).toISOString())],
      [entry(other, "Gmon2", new Date(base).toISOString())],
      [entry(other, "Gmon2", new Date(base).toISOString())],
    ],
    bodies,
  );
  const originalErr = console.error;
  console.error = () => {};
  try {
    tick = 0;
    await checkLiveMembers(); // Gmon mulai live
    game.placeDurationGuess({ username, name: "Gmon", liveAtUnix, userId: "m-a", minutes: 9 });
    game.placeDurationGuess({ username, name: "Gmon", liveAtUnix, userId: "m-b", minutes: 40 });
    game.placeNextGuess({ userId: "m-n1", username: other, now: base });
    game.placeNextGuess({ userId: "m-n2", username: "jkt48_orang_lain", now: base });

    tick = 1;
    await checkLiveMembers(); // Gmon2 mulai live -> tebak berikutnya diumumkan
    const nextAnnounce = bodies.filter((b) => /yang live berikutnya/.test(b.content || ""));
    assert.equal(nextAnnounce.length, 1);
    assert.match(nextAnnounce[0].content, /Gmon2/);
    assert.match(nextAnnounce[0].content, /<@m-n1>/);
    assert.doesNotMatch(nextAnnounce[0].content.split("\n")[1], /<@m-n2>/, "yang meleset cuma dihitung, tidak ditampilkan");
    assert.equal(game.getUserScore("m-n1").points, 2);

    tick = 2;
    await checkLiveMembers(); // Gmon absen 1x (masih toleransi)
    assert.equal(bodies.filter((b) => /Hasil tebak durasi/.test(b.content || "")).length, 0);
    tick = 3;
    await checkLiveMembers(); // absen 2x -> selesai
    const durationAnnounce = bodies.filter((b) => /Hasil tebak durasi/.test(b.content || ""));
    assert.equal(durationAnnounce.length, 1);
    assert.match(durationAnnounce[0].content, /Gmon/);
    assert.match(durationAnnounce[0].content, /🥇 <@m-a>/, "tebakan 9 menit vs durasi ~10 menit paling dekat");
    assert.equal(game.getUserScore("m-a").points, 5);
    assert.equal(game.getUserScore("m-b").points, 2);
    assert.equal(game.getDurationRound(username, liveAtUnix), null);
  } finally {
    Date.now = realNow;
    console.error = originalErr;
    restore();
    activeLives.delete(username);
    activeLives.delete(other);
  }
});
