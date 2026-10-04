const { getHourWIBOf, WEEKDAY_FORMATTER_WIB } = require("./utils");

// Perhitungan murni buat kartu "Wrapped" (chat/wrappedCard.js): ringkasan
// 30 hari terakhir seluruh member, atau satu member. Masukan = sesi dari arsip
// rekap ({ name, username, startedAtUnix, endedAtUnix, durationMs, peakViewCount }).

const mostCommon = (counts) => {
  const entries = Object.entries(counts);
  if (entries.length === 0) return null;
  return entries.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
};

function tally(sessions) {
  const hourCounts = Array.from({ length: 24 }, () => 0);
  const weekdayCounts = {};
  for (const s of sessions) {
    const start = new Date(s.startedAtUnix * 1000);
    hourCounts[getHourWIBOf(start)] += 1;
    const weekday = WEEKDAY_FORMATTER_WIB.format(start);
    weekdayCounts[weekday] = (weekdayCounts[weekday] || 0) + 1;
  }
  return { hourCounts, topWeekday: mostCommon(weekdayCounts)?.[0] ?? null };
}

function busiestHour(hourCounts) {
  let best = -1;
  let hour = null;
  hourCounts.forEach((count, h) => {
    if (count > best) {
      best = count;
      hour = h;
    }
  });
  return best > 0 ? hour : null;
}

function longestSession(sessions) {
  return sessions.reduce((best, s) => (!best || s.durationMs > best.durationMs ? s : best), null);
}

function peakSession(sessions) {
  return sessions.reduce((best, s) => (typeof s.peakViewCount === "number" && (!best || s.peakViewCount > best.peakViewCount) ? s : best), null);
}

// Total per member: { username, name, count, durationMs }, urut waktu live terbanyak.
function totalsByMember(sessions) {
  const byUser = new Map();
  for (const s of sessions) {
    const row = byUser.get(s.username) || { username: s.username, name: s.name, count: 0, durationMs: 0 };
    row.count += 1;
    row.durationMs += s.durationMs;
    row.name = s.name;
    byUser.set(s.username, row);
  }
  return [...byUser.values()].sort((a, b) => b.durationMs - a.durationMs || b.count - a.count);
}

// streaks = { [username]: hariStreakSekarang } (opsional) buat "streak terpanjang".
function computeServerWrapped(sessions, streaks = {}) {
  if (sessions.length === 0) return null;
  const members = totalsByMember(sessions);
  const { hourCounts, topWeekday } = tally(sessions);
  const streakEntries = Object.entries(streaks).filter(([, n]) => n > 0);
  const topStreak = streakEntries.sort((a, b) => b[1] - a[1])[0] || null;
  const topStreakMember = topStreak ? members.find((m) => m.username === topStreak[0]) : null;
  return {
    sessionCount: sessions.length,
    totalDurationMs: sessions.reduce((t, s) => t + s.durationMs, 0),
    memberCount: members.length,
    topMembers: members.slice(0, 5),
    mostSessions: [...members].sort((a, b) => b.count - a.count || b.durationMs - a.durationMs)[0],
    longest: longestSession(sessions),
    peak: peakSession(sessions),
    busiestHour: busiestHour(hourCounts),
    topWeekday,
    hourCounts,
    topStreak: topStreakMember ? { name: topStreakMember.name, days: topStreak[1] } : null,
  };
}

// Wrapped satu member; `allSessions` (semua member) dipakai buat peringkat.
function computeMemberWrapped(allSessions, username, streak = 0) {
  const sessions = allSessions.filter((s) => s.username === username);
  if (sessions.length === 0) return null;
  const members = totalsByMember(allSessions);
  const rank = members.findIndex((m) => m.username === username) + 1;
  const { hourCounts, topWeekday } = tally(sessions);
  const totalDurationMs = sessions.reduce((t, s) => t + s.durationMs, 0);
  return {
    username,
    name: sessions[sessions.length - 1].name,
    sessionCount: sessions.length,
    totalDurationMs,
    avgDurationMs: totalDurationMs / sessions.length,
    longest: longestSession(sessions),
    peak: peakSession(sessions),
    busiestHour: busiestHour(hourCounts),
    topWeekday,
    hourCounts,
    streak,
    rank,
    memberCount: members.length,
  };
}

module.exports = { computeServerWrapped, computeMemberWrapped, totalsByMember, busiestHour };
