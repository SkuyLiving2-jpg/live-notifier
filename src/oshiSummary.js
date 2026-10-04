const { activeLives } = require("./storage/activeLives");
const { getCompletedSessionsSince, getStreakDatesForMember, SESSION_RETENTION_DAYS } = require("./storage/dailyLog");
const { loadLiveCount } = require("./storage/liveCount");
const { loadDurationHistory } = require("./storage/durationHistory");
const { computeCurrentStreak } = require("./streakMath");
const { computeSchedulePattern, HEADS_UP_MIN_ENTRIES, HEADS_UP_MIN_DOMINANCE } = require("./schedulePattern");
const { describeElapsed, formatDuration, formatRelativeTime, formatViewCount, getTodayWIB } = require("./utils");

const DAY_SEC = 24 * 60 * 60;

const sumDuration = (sessions) => sessions.reduce((total, s) => total + (s.durationMs || 0), 0);

// Nama tampilan member dari data yang paling baru kita punya.
function displayNameFor(username) {
  const live = activeLives.get(username);
  if (live?.name) return live.name;
  const counted = loadLiveCount()[username];
  if (counted?.name) return counted.name;
  const history = loadDurationHistory()[username];
  return history?.at(-1)?.name || username;
}

// Gambaran SATU member buat profil oshi & ringkasan mingguan. Murni baca data
// yang sudah ada (arsip rekap 35 hari, streak, riwayat durasi) - gak nambah
// pencatatan baru. `nowMs` bisa dioper buat test.
function summarizeMember(username, nowMs = Date.now()) {
  const nowSec = Math.floor(nowMs / 1000);
  const sessions = getCompletedSessionsSince(SESSION_RETENTION_DAYS)
    .filter((s) => s.username === username)
    .sort((a, b) => b.endedAtUnix - a.endedAtUnix);

  const weekStart = nowSec - 7 * DAY_SEC;
  const week = sessions.filter((s) => s.endedAtUnix >= weekStart);
  const prevWeek = sessions.filter((s) => s.endedAtUnix < weekStart && s.endedAtUnix >= weekStart - 7 * DAY_SEC);
  const weekPeaks = week.map((s) => s.peakViewCount).filter((v) => typeof v === "number");

  const live = activeLives.get(username) || null;
  const streak = computeCurrentStreak(getStreakDatesForMember(username), getTodayWIB(), Boolean(live));

  const entries = loadDurationHistory()[username] || [];
  const pattern = computeSchedulePattern(entries);
  const strongPattern =
    pattern && pattern.total >= HEADS_UP_MIN_ENTRIES && pattern.topBucketCount / pattern.total >= HEADS_UP_MIN_DOMINANCE ? pattern : null;

  return {
    username,
    name: displayNameFor(username),
    live,
    last: sessions[0] || null,
    weekCount: week.length,
    weekDurationMs: sumDuration(week),
    weekPeak: weekPeaks.length > 0 ? Math.max(...weekPeaks) : null,
    prevWeekCount: prevWeek.length,
    prevWeekDurationMs: sumDuration(prevWeek),
    streak,
    totalLives: loadLiveCount()[username]?.count || 0,
    pattern: strongPattern,
  };
}

function formatPatternHint(pattern) {
  const pad2 = (n) => String(n).padStart(2, "0");
  const hours = pattern.rangeMin === pattern.rangeMax ? `jam ${pad2(pattern.rangeMin)}` : `jam ${pad2(pattern.rangeMin)}-${pad2(pattern.rangeMax)}`;
  return `biasanya sekitar ${hours} WIB (paling sering hari ${pattern.topWeekdayName})`;
}

function describeTrend(current, previous, unit) {
  if (previous === 0 && current === 0) return "";
  if (previous === 0) return ` (minggu lalu gak ada)`;
  if (current === previous) return ` (sama kayak minggu lalu)`;
  return current > previous ? ` (naik dari ${previous}${unit} minggu lalu)` : ` (turun dari ${previous}${unit} minggu lalu)`;
}

// Blok teks satu member (dipakai profil oshi). `nowMs` buat waktu relatif.
function formatMemberBlock(summary, nowMs = Date.now()) {
  const lines = [];
  if (summary.live) {
    const elapsed = describeElapsed(nowMs - new Date(summary.live.liveAt).getTime());
    const viewers = summary.live.viewCount != null ? `, 👁️ ${formatViewCount(summary.live.viewCount)} penonton` : "";
    lines.push(`⭐ **${summary.name}** - 🔴 **LAGI LIVE** (${elapsed}${viewers})`);
  } else if (summary.last) {
    lines.push(
      `⭐ **${summary.name}** - terakhir live ${formatRelativeTime(new Date(summary.last.endedAtUnix * 1000))} (${formatDuration(summary.last.durationMs)})`,
    );
  } else {
    lines.push(`⭐ **${summary.name}** - belum ada live yang kecatet di ${SESSION_RETENTION_DAYS} hari terakhir`);
  }

  const details = [];
  if (summary.streak > 0) details.push(`🔥 streak ${summary.streak} hari`);
  details.push(
    `📅 7 hari terakhir: ${summary.weekCount}x live, ${formatDuration(summary.weekDurationMs)}${summary.weekPeak ? `, puncak 👁️ ${formatViewCount(summary.weekPeak)}` : ""}`,
  );
  if (summary.totalLives > 0) details.push(`🎬 total ${summary.totalLives}x live sejak bot mantau`);
  if (!summary.live && summary.pattern) details.push(`🕒 ${formatPatternHint(summary.pattern)}`);
  lines.push(...details.map((d) => `   ${d}`));
  return lines.join("\n");
}

// Satu baris ringkasan mingguan per oshi (dipakai DM mingguan).
function formatWeeklyLine(summary) {
  if (summary.weekCount === 0) {
    return `⭐ **${summary.name}** - minggu ini gak live${summary.last ? ` (terakhir ${formatRelativeTime(new Date(summary.last.endedAtUnix * 1000))})` : ""}`;
  }
  const peak = summary.weekPeak ? `, puncak 👁️ ${formatViewCount(summary.weekPeak)}` : "";
  return `⭐ **${summary.name}** - ${summary.weekCount}x live${describeTrend(summary.weekCount, summary.prevWeekCount, "x")}, total ${formatDuration(summary.weekDurationMs)}${peak}${summary.streak >= 2 ? `, 🔥 streak ${summary.streak} hari` : ""}`;
}

module.exports = { summarizeMember, displayNameFor, formatMemberBlock, formatWeeklyLine, formatPatternHint };
