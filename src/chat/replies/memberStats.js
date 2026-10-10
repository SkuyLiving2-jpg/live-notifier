// Statistik satu member (durasi, rata-rata, rekor) dan streak hari berturut-turut live.

const { activeLives } = require("../../storage/activeLives");
const { getStreakDatesForMember } = require("../../storage/dailyLog");
const { computeCurrentStreak, computeStreakStartDate } = require("../../streakMath");
const { findDurationHistoryByNameFragment } = require("../../storage/durationHistory");
const { formatDuration, getTodayWIB, formatLongDateWIB } = require("../../utils");

const { resolveRecapMember, describeMissingMember } = require("./memberLookup");

// Saran fitur ke-5 (§10's kelimapuluh+item): "cok streak <nama member>" -
// berapa hari BERTURUT-TURUT (WIB) member itu punya live. Resolusi member-nya
// SAMA kayak "cok rekap <nama>" (resolveRecapMember) - butuh minimal 1 live
// yang TERCATAT (selesai ATAU lagi berlangsung), bukan cuma
// findLiveCountByNameFragment doang, biar member yang lagi live PERTAMA
// KALINYA (belum pernah selesai sekalipun) tetep kejawab bener soal
// streak-nya, bukan disangka "gak ketemu".
async function replyStreak(fragment) {
  const shown = (fragment || "").trim();
  const resolved = resolveRecapMember(shown);
  if (resolved.status === "ambiguous") {
    return `Cok, ada beberapa member yang cocok sama "${shown}": ${resolved.names.join(", ")}. Ketik nama yang lebih lengkap ya.`;
  }
  if (resolved.status === "none") {
    return await describeMissingMember(shown, "dicek streak live-nya");
  }

  const dates = getStreakDatesForMember(resolved.username);
  const isLiveNow = activeLives.has(resolved.username);
  const today = getTodayWIB();
  const streak = computeCurrentStreak(dates, today, isLiveNow);

  if (streak === 0) {
    return `Cok, **${resolved.name}** lagi nggak dalam streak (kemarin maupun hari ini belum ada live yang kecatet).`;
  }
  const liveNowNote = isLiveNow ? " (lagi live sekarang, ikut ke-hitung)" : "";
  // Streak yang "mentok" di tanggal tertua yang kita punya bisa aja sebenarnya
  // lebih panjang - dikasih tau jujur, bukan diam-diam dianggap pasti.
  const oldestKnown = [...dates].sort()[0];
  const startDate = computeStreakStartDate(dates, today, isLiveNow);
  const truncatedNote =
    startDate && startDate === oldestKnown
      ? ` _(Data live ${resolved.name} baru kecatet sejak ${formatLongDateWIB(new Date(`${oldestKnown}T12:00:00+07:00`))}, jadi streak aslinya bisa lebih panjang.)_`
      : "";
  const sinceNote = startDate ? ` Mulai ${formatLongDateWIB(new Date(`${startDate}T12:00:00+07:00`))}.` : "";
  return `🔥 **${resolved.name}** lagi streak **${streak} hari** berturut-turut live${liveNowNote}!${sinceNote}${truncatedNote}`;
}

function replyMemberStats(fragment) {
  const found = findDurationHistoryByNameFragment(fragment);
  if (!found || found.entries.length === 0) {
    return `Cok, belum ada data riwayat live buat "${fragment.trim()}".`;
  }

  const durations = found.entries.map((e) => e.durationMs);
  const total = durations.reduce((a, b) => a + b, 0);
  const avg = total / durations.length;
  const max = Math.max(...durations);

  return [
    `📊 Statistik **${found.displayName}** (${durations.length} live terakhir yang ke-track):`,
    `- Rata-rata durasi: ${formatDuration(avg)}`,
    `- Rekor terlama: ${formatDuration(max)}`,
  ].join("\n");
}

module.exports = {
  replyStreak,
  replyMemberStats,
};
