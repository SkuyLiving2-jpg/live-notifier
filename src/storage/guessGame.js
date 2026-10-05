const path = require("path");
const { CACHE_DIR } = require("../config");
const { createJsonStore } = require("./jsonStore");

// Mini-game tebak-tebakan (chat/guessFlow.js, notify/guessGame.js). State:
//   duration: { [username]: { liveAtUnix, name, guesses: { [userId]: { minutes, at } } } }
//       ronde "tebak durasi" yang lagi buka - satu per member yang lagi live
//   next:     { openedAt, guesses: { [userId]: username } } | null
//       ronde "siapa yang live berikutnya" - satu ronde global, selesai begitu ada member yang mulai live
//   scores:   { [userId]: { points, wins, plays } }
//   monthly:  { "YYYY-MM": { [userId]: points } }  (cuma MONTHS_KEPT bulan terakhir)
const GUESS_GAME_FILE = path.join(CACHE_DIR, "guess-game.json");
const store = createJsonStore(GUESS_GAME_FILE, {}, { errorLabel: "tebak-tebakan" });

const GUESS_WINDOW_MS = 15 * 60 * 1000; // tebakan durasi dikunci 15 menit sejak live mulai (cegah nebak pas udah keliatan)
const MIN_GUESS_MINUTES = 1;
const MAX_GUESS_MINUTES = 12 * 60; // sama dengan MAX_PLAUSIBLE_LIVE_DURATION_MS
const MIN_DURATION_PLAYERS = 2; // sendirian = gak ada lawan, gak dihitung (cegah farming poin)
const NEXT_ROUND_TTL_MS = 6 * 60 * 60 * 1000; // ronde "berikutnya" basi kalau gak ada yang live selama ini
const MONTHS_KEPT = 3;
const POINTS = { first: 3, second: 2, third: 1, exactBonus: 2, nextCorrect: 2 };
const EXACT_DIFF_MINUTES = 2;

const isId = (id) => typeof id === "string" && id.length > 0 && id !== "__proto__";
const isPlain = (v) => v && typeof v === "object" && !Array.isArray(v);

const num = (v) => (Number.isFinite(v) ? v : 0);

// File bisa diedit tangan / rusak sebagian (JSON valid tapi bentuknya salah):
// entri yang bentuknya tidak masuk akal dibuang supaya satu entri jelek tidak
// merusak papan skor atau menyetop penghitungan ronde.
function cleanScores(raw) {
  const out = {};
  for (const [id, s] of Object.entries(isPlain(raw) ? raw : {})) {
    if (isId(id) && isPlain(s)) out[id] = { points: num(s.points), wins: num(s.wins), plays: num(s.plays) };
  }
  return out;
}

function cleanMonthly(raw) {
  const out = {};
  for (const [month, perUser] of Object.entries(isPlain(raw) ? raw : {})) {
    if (!isPlain(perUser)) continue;
    out[month] = {};
    for (const [id, points] of Object.entries(perUser)) if (isId(id) && Number.isFinite(points)) out[month][id] = points;
  }
  return out;
}

function cleanDuration(raw) {
  const out = {};
  for (const [username, round] of Object.entries(isPlain(raw) ? raw : {})) {
    if (!isId(username) || !isPlain(round) || !Number.isFinite(round.liveAtUnix)) continue;
    const guesses = {};
    for (const [id, g] of Object.entries(isPlain(round.guesses) ? round.guesses : {})) {
      if (isId(id) && isPlain(g) && Number.isFinite(g.minutes)) guesses[id] = { minutes: g.minutes, at: num(g.at) };
    }
    out[username] = { liveAtUnix: round.liveAtUnix, name: typeof round.name === "string" ? round.name : username, guesses };
  }
  return out;
}

function cleanNext(raw) {
  if (!isPlain(raw) || !Number.isFinite(raw.openedAt) || !isPlain(raw.guesses)) return null;
  const guesses = {};
  for (const [id, username] of Object.entries(raw.guesses)) if (isId(id) && typeof username === "string" && username) guesses[id] = username;
  return { openedAt: raw.openedAt, guesses };
}

function load() {
  const raw = store.load();
  const data = isPlain(raw) ? raw : {};
  return {
    duration: cleanDuration(data.duration),
    next: cleanNext(data.next),
    scores: cleanScores(data.scores),
    monthly: cleanMonthly(data.monthly),
  };
}

function save(data) {
  store.save(data);
}

const own = (obj, key) => (Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined);

// ---------- tebak durasi ----------

// Pasang/ganti tebakan `minutes` buat sesi live `username` yang mulai di `liveAtUnix`.
// Pemanggil sudah mastiin member itu lagi live & masih di jendela tebakan.
function placeDurationGuess({ username, name, liveAtUnix, userId, minutes, now = Date.now() }) {
  if (!isId(userId) || !isId(username)) return { ok: false, reason: "invalid" };
  if (!Number.isFinite(minutes) || minutes < MIN_GUESS_MINUTES || minutes > MAX_GUESS_MINUTES) return { ok: false, reason: "range" };

  const data = load();
  let round = own(data.duration, username);
  if (!round || round.liveAtUnix !== liveAtUnix) {
    round = { liveAtUnix, name, guesses: {} }; // sesi baru -> ronde baru (yang lama basi)
    data.duration[username] = round;
  }
  const replaced = Object.prototype.hasOwnProperty.call(round.guesses, userId);
  round.guesses[userId] = { minutes, at: now };
  save(data);
  return { ok: true, replaced, guessers: Object.keys(round.guesses).length };
}

function getDurationRound(username, liveAtUnix) {
  const round = own(load().duration, username);
  return round && round.liveAtUnix === liveAtUnix ? round : null;
}

// Semua ronde durasi yang masih tersimpan (pemanggil menyaring yang lagi live).
function listDurationRounds() {
  return load().duration;
}

function addPoints(data, userId, points, { win = false } = {}) {
  const score = isPlain(own(data.scores, userId)) ? data.scores[userId] : { points: 0, wins: 0, plays: 0 };
  score.points += points;
  score.plays += 1;
  if (win) score.wins += 1;
  data.scores[userId] = score;
}

function monthKeyOf(now) {
  const d = new Date(now + 7 * 60 * 60 * 1000); // WIB
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function addMonthly(data, userId, points, now) {
  const key = monthKeyOf(now);
  if (!isPlain(data.monthly[key])) data.monthly[key] = {};
  data.monthly[key][userId] = (data.monthly[key][userId] || 0) + points;
  const keys = Object.keys(data.monthly).sort();
  for (const old of keys.slice(0, Math.max(0, keys.length - MONTHS_KEPT))) delete data.monthly[old];
}

// Tutup ronde durasi `username` (selalu dihapus). Kalau sesi cocok, durasinya
// masuk akal, dan penebaknya >= MIN_DURATION_PLAYERS -> kasih poin & balikin
// hasil; selain itu balikin null (ronde dibuang tanpa poin).
function resolveDurationRound(username, liveAtUnix, durationMs, now = Date.now()) {
  const data = load();
  const round = own(data.duration, username);
  if (!round) return null;
  delete data.duration[username];

  const guesses = Object.entries(round.guesses || {});
  const valid = round.liveAtUnix === liveAtUnix && Number.isFinite(durationMs) && durationMs > 0 && guesses.length >= MIN_DURATION_PLAYERS;
  if (!valid) {
    save(data);
    return null;
  }

  const actualMinutes = durationMs / 60000;
  const ranking = guesses
    .map(([userId, g]) => ({ userId, minutes: g.minutes, at: g.at, diff: Math.abs(g.minutes - actualMinutes) }))
    .sort((a, b) => a.diff - b.diff || a.at - b.at);
  const rankPoints = [POINTS.first, POINTS.second, POINTS.third];
  ranking.forEach((entry, i) => {
    entry.points = (rankPoints[i] || 0) + (entry.diff <= EXACT_DIFF_MINUTES ? POINTS.exactBonus : 0);
    entry.exact = entry.diff <= EXACT_DIFF_MINUTES;
    addPoints(data, entry.userId, entry.points, { win: i === 0 });
    if (entry.points > 0) addMonthly(data, entry.userId, entry.points, now);
  });
  save(data);
  return { name: round.name, durationMs, actualMinutes, ranking };
}

// Buang ronde durasi tanpa poin (sesi dibuang karena durasinya gak masuk akal, dst).
function discardDurationRound(username) {
  const data = load();
  if (own(data.duration, username) === undefined) return;
  delete data.duration[username];
  save(data);
}

// ---------- tebak siapa live berikutnya ----------

function placeNextGuess({ userId, username, now = Date.now() }) {
  if (!isId(userId) || !isId(username)) return { ok: false, reason: "invalid" };
  const data = load();
  if (!data.next || now - data.next.openedAt > NEXT_ROUND_TTL_MS) data.next = { openedAt: now, guesses: {} };
  const replaced = Object.prototype.hasOwnProperty.call(data.next.guesses, userId);
  data.next.guesses[userId] = username;
  save(data);
  return { ok: true, replaced, players: Object.keys(data.next.guesses).length };
}

function getNextRound(now = Date.now()) {
  const { next } = load();
  return next && now - next.openedAt <= NEXT_ROUND_TTL_MS ? next : null;
}

// `starterUsername` = member yang BARU mulai live. Ronde ditutup; yang nebak benar dapat poin.
function resolveNextRound(starterUsername, now = Date.now()) {
  const data = load();
  const round = data.next;
  if (!round) return null;
  data.next = null;
  if (now - round.openedAt > NEXT_ROUND_TTL_MS) {
    save(data);
    return null;
  }
  const entries = Object.entries(round.guesses);
  const winners = entries.filter(([, u]) => u === starterUsername).map(([id]) => id);
  const losers = entries.filter(([, u]) => u !== starterUsername).map(([id]) => id);
  for (const id of winners) {
    addPoints(data, id, POINTS.nextCorrect, { win: true });
    addMonthly(data, id, POINTS.nextCorrect, now);
  }
  for (const id of losers) addPoints(data, id, 0);
  save(data);
  return { winners, losers, total: entries.length };
}

// ---------- papan skor ----------

function topBy(entries, limit) {
  return entries
    .filter((e) => e.points > 0)
    .sort((a, b) => b.points - a.points || (b.wins ?? 0) - (a.wins ?? 0))
    .slice(0, limit);
}

function getScoreboard(now = Date.now(), limit = 10) {
  const data = load();
  const allTime = topBy(
    Object.entries(data.scores).map(([userId, s]) => ({ userId, points: s.points || 0, wins: s.wins || 0, plays: s.plays || 0 })),
    limit,
  );
  const month = topBy(
    Object.entries(own(data.monthly, monthKeyOf(now)) || {}).map(([userId, points]) => ({ userId, points })),
    limit,
  );
  return { allTime, month };
}

function getUserScore(userId) {
  const s = own(load().scores, userId);
  return s ? { points: s.points || 0, wins: s.wins || 0, plays: s.plays || 0 } : { points: 0, wins: 0, plays: 0 };
}

module.exports = {
  GUESS_GAME_FILE,
  GUESS_WINDOW_MS,
  MIN_GUESS_MINUTES,
  MAX_GUESS_MINUTES,
  MIN_DURATION_PLAYERS,
  NEXT_ROUND_TTL_MS,
  POINTS,
  load,
  placeDurationGuess,
  getDurationRound,
  listDurationRounds,
  resolveDurationRound,
  discardDurationRound,
  placeNextGuess,
  getNextRound,
  resolveNextRound,
  getScoreboard,
  getUserScore,
  monthKeyOf,
};
