const { activeLives, findMemberByNameFragment } = require("../storage/activeLives");
const {
  GUESS_WINDOW_MS,
  MIN_GUESS_MINUTES,
  MAX_GUESS_MINUTES,
  MIN_DURATION_PLAYERS,
  POINTS,
  placeDurationGuess,
  getDurationRound,
  listDurationRounds,
  placeNextGuess,
  getNextRound,
  getScoreboard,
  getUserScore,
} = require("../storage/guessGame");
const { formatDuration } = require("../utils");
const { resolveRecapMember, describeMissingMember } = require("./replies");

// Mini-game tebak-tebakan lewat chat:
//   cok tebak <nama> <menit>        - tebak berapa lama member yang LAGI live bakal live (dikunci 15 menit pertama)
//   cok tebak berikutnya <nama>     - tebak siapa yang bakal mulai live berikutnya
//   cok tebak                       - lihat ronde yang lagi buka + cara main
//   cok papan tebak                 - papan skor
// Hasilnya diumumin otomatis ke channel (notify/guessGame.js) pas live selesai / ada yang mulai live.

const NEED_USER = "Cok, mini-game ini cuma bisa dimainin lewat chat biasa (bot perlu tau kamu siapa).";

// "90", "90 menit", "1 jam", "1.5 jam", "1 jam 30 menit", "1j30m" -> menit (bulat) atau null.
function parseGuessMinutes(raw) {
  const t = String(raw || "")
    .trim()
    .toLowerCase()
    .replace(",", ".");
  let minutes = null;
  let m = t.match(/^(\d+(?:\.\d+)?)\s*(?:jam|j)\s*(?:(\d+)\s*(?:menit|mnt|m)?)?$/);
  if (m) minutes = Number(m[1]) * 60 + (m[2] ? Number(m[2]) : 0);
  else if ((m = t.match(/^(\d+(?:\.\d+)?)\s*(?:menit|mnt|m)?$/))) minutes = Number(m[1]);
  if (minutes === null || !Number.isFinite(minutes)) return null;
  return Math.round(minutes);
}

const minutesText = (minutes) => formatDuration(minutes * 60000);

function liveNamesHint() {
  const names = [...activeLives.values()].map((e) => e.name);
  return names.length > 0 ? ` Yang lagi live sekarang: ${names.join(", ")}.` : " Lagi gak ada yang live sekarang.";
}

async function handleDurationGuess(nameFragment, durationText, authorId, now = Date.now()) {
  if (!authorId) return NEED_USER;
  const shown = nameFragment.trim();
  const minutes = parseGuessMinutes(durationText);
  if (minutes === null) return 'Durasinya gak kebaca. Contoh: "cok tebak nala 90" (menit) atau "cok tebak nala 1 jam 30 menit".';
  if (minutes < MIN_GUESS_MINUTES || minutes > MAX_GUESS_MINUTES)
    return `Tebakannya harus antara ${MIN_GUESS_MINUTES} menit sampai ${MAX_GUESS_MINUTES / 60} jam ya.`;

  const live = findMemberByNameFragment(shown);
  if (!live) {
    const known = resolveRecapMember(shown);
    if (known.status === "ok")
      return `**${known.name}** lagi gak live. Tebak durasi cuma bisa pas dia lagi live (15 menit pertama).${liveNamesHint()}`;
    if (known.status === "ambiguous")
      return `Cok, ada beberapa member yang cocok sama "${shown}": ${known.names.join(", ")}. Ketik nama yang lebih lengkap ya.`;
    return `Cok, gak ada member "${shown}" yang lagi live.${liveNamesHint()}`;
  }

  const liveAtMs = new Date(live.liveAt).getTime();
  if (!Number.isFinite(liveAtMs)) return `Cok, waktu mulai live **${live.name}** gak kebaca, jadi gak bisa dibuka tebakannya.`;
  const elapsed = now - liveAtMs;
  if (elapsed > GUESS_WINDOW_MS)
    return `Tebakan buat **${live.name}** udah ditutup (cuma dibuka ${GUESS_WINDOW_MS / 60000} menit pertama sejak mulai live, biar adil). Coba di live berikutnya!`;

  const result = placeDurationGuess({
    username: live.username,
    name: live.name,
    liveAtUnix: Math.floor(liveAtMs / 1000),
    userId: authorId,
    minutes,
    now,
  });
  if (!result.ok) return "Gagal nyimpen tebakan, coba lagi ya.";

  const remaining = Math.max(1, Math.ceil((GUESS_WINDOW_MS - elapsed) / 60000));
  const needMore =
    result.guessers < MIN_DURATION_PLAYERS ? ` Poin baru dihitung kalau minimal ${MIN_DURATION_PLAYERS} orang nebak - ajak temen!` : "";
  return `🎯 ${result.replaced ? "Tebakan kamu diganti" : "Tebakan kamu masuk"}: **${live.name}** live **${minutesText(minutes)}**. Sekarang ${result.guessers} penebak, boleh ganti tebakan ${remaining} menit lagi. Hasil diumumin pas dia selesai live.${needMore}`;
}

async function handleNextGuess(nameFragment, authorId, now = Date.now()) {
  if (!authorId) return NEED_USER;
  const shown = nameFragment.trim();
  const resolved = resolveRecapMember(shown);
  if (resolved.status === "ambiguous")
    return `Cok, ada beberapa member yang cocok sama "${shown}": ${resolved.names.join(", ")}. Ketik nama yang lebih lengkap ya.`;
  if (resolved.status !== "ok") return await describeMissingMember(shown, "ditebak");
  if (activeLives.has(resolved.username))
    return `**${resolved.name}** udah live sekarang - yang ditebak itu member yang bakal MULAI live berikutnya.`;

  const result = placeNextGuess({ userId: authorId, username: resolved.username, now });
  if (!result.ok) return "Gagal nyimpen tebakan, coba lagi ya.";
  return `🔮 ${result.replaced ? "Tebakan kamu diganti" : "Tebakan kamu masuk"}: yang live berikutnya = **${resolved.name}**. Sekarang ${result.players} penebak. Yang bener dapet +${POINTS.nextCorrect} poin, diumumin pas ada yang mulai live.`;
}

function replyGuessOverview(authorId, now = Date.now()) {
  const lines = [];
  const rounds = listDurationRounds();
  for (const entry of activeLives.values()) {
    const round = Object.prototype.hasOwnProperty.call(rounds, entry.username)
      ? getDurationRound(entry.username, Math.floor(new Date(entry.liveAt).getTime() / 1000))
      : null;
    const left = GUESS_WINDOW_MS - (now - new Date(entry.liveAt).getTime());
    if (left <= 0) continue;
    const count = round ? Object.keys(round.guesses).length : 0;
    lines.push(
      `- **${entry.name}** - tebakan dibuka ${Math.ceil(left / 60000)} menit lagi (${count} penebak)${round && authorId && round.guesses[authorId] ? ` - tebakanmu: ${minutesText(round.guesses[authorId].minutes)}` : ""}`,
    );
  }
  const next = getNextRound(now);
  const nextLine = next
    ? `🔮 Ronde "siapa live berikutnya" lagi buka: ${Object.keys(next.guesses).length} penebak.`
    : '🔮 Belum ada ronde "siapa live berikutnya".';

  return [
    "🎮 **Tebak-tebakan**",
    lines.length > 0
      ? `**Tebak durasi yang lagi buka:**\n${lines.join("\n")}`
      : "Lagi gak ada tebakan durasi yang buka (cuma dibuka 15 menit pertama tiap ada yang mulai live).",
    nextLine,
    "",
    `- Tebak durasi: "cok tebak nala 90" (menit) - 1st +${POINTS.first}, 2nd +${POINTS.second}, 3rd +${POINTS.third}, selisih <= 2 menit bonus +${POINTS.exactBonus} (minimal ${MIN_DURATION_PLAYERS} penebak)`,
    `- Tebak berikutnya: "cok tebak berikutnya levi" - bener +${POINTS.nextCorrect}`,
    '- Skor: "cok papan tebak"',
  ].join("\n");
}

function replyScoreboard(authorId, now = Date.now()) {
  const { allTime, month } = getScoreboard(now);
  const fmt = (list, withWins) =>
    list.length > 0
      ? list.map((e, i) => `${i + 1}. <@${e.userId}> - ${e.points} poin${withWins ? ` (${e.wins}x menang)` : ""}`).join("\n")
      : "_belum ada_";
  const mine = authorId ? getUserScore(authorId) : null;
  return [
    "🏆 **Papan skor tebak-tebakan**",
    `**Bulan ini**\n${fmt(month, false)}`,
    `**Sepanjang masa**\n${fmt(allTime, true)}`,
    mine && mine.plays > 0 ? `_Skor kamu: ${mine.points} poin, ${mine.wins}x menang dari ${mine.plays} ronde._` : '_Ikut main: "cok tebak"._',
  ].join("\n\n");
}

async function tryHandleGuessCommand(commandText, authorId) {
  const t = commandText;

  if (
    /^(?:papan|skor|leaderboard|peringkat|ranking)\s+tebak(?:an|-tebakan)?[?!.\s]*$/.test(t) ||
    /^tebak(?:an|-tebakan)?\s+(?:papan|skor|leaderboard|peringkat|ranking)[?!.\s]*$/.test(t)
  ) {
    return replyScoreboard(authorId);
  }

  const next = t.match(/^tebak\s+(?:berikutnya|selanjutnya|next|duluan)\s+(.+?)[?!.\s]*$/);
  if (next) return await handleNextGuess(next[1], authorId);

  const duration = t.match(/^tebak\s+([^\d]+?)\s+(\d.*?)[?!.\s]*$/);
  if (duration) return await handleDurationGuess(duration[1], duration[2], authorId);

  if (/^tebak(?:-tebakan|an)?(?:\s+.*)?$/.test(t)) return replyGuessOverview(authorId);

  return null;
}

module.exports = { tryHandleGuessCommand, parseGuessMinutes, handleDurationGuess, handleNextGuess, replyGuessOverview, replyScoreboard };
