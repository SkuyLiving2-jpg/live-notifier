// Pola jadwal live member dan siapa yang biasanya live hari ini.

const { getScheduleDigestCandidates, buildScheduleDigestPayload } = require("../../notify/publicAlerts");
const { findDurationHistoryByNameFragment } = require("../../storage/durationHistory");
const { computeSchedulePattern } = require("../../schedulePattern");

// PENTING: IDN nggak nyediain jadwal live resmi sama sekali (udah dicek
// langsung ke API-nya). Jadi ini PURE statistik dari histori kita SENDIRI
// (live-duration-history.json, maks 10 entry terakhir per orang) - bukan
// jaminan/jadwal pasti, bisa aja meleset kalau pola live-nya emang nggak
// tetap. Matematika pola-nya sendiri (`computeSchedulePattern`) diekstrak ke
// ../schedulePattern.js (§10's forty-third item) - dipake bareng sama
// notify/priorityDm.js's alert heads-up proaktif, biar dua-duanya narik dari
// definisi "pola jam paling sering" yang SAMA persis.
function replySchedulePattern(fragment) {
  const found = findDurationHistoryByNameFragment(fragment);
  if (!found || found.entries.length === 0) {
    return `Cok, belum ada riwayat live buat "${fragment.trim()}" - belum bisa nebak polanya.`;
  }

  const { entries, displayName } = found;
  const pattern = computeSchedulePattern(entries);
  if (!pattern) {
    return `Cok, riwayat **${displayName}** baru ada ${entries.length}x - masih kurang buat nebak pola jadwalnya (minimal 3x live yang ke-track). Coba tanya lagi lain kali.`;
  }

  const pad2 = (n) => String(n).padStart(2, "0");
  const lines = [
    `📅 Pola live **${displayName}** (dari ${pattern.total} live terakhir yang ke-track):`,
    `- Paling sering **${pattern.topBucketName}**, sekitar jam ${pad2(pattern.rangeMin)}-${pad2(pattern.rangeMax)} WIB (${pattern.topBucketCount}/${pattern.total}x)`,
  ];
  if (pattern.topWeekdayCount / pattern.total >= 0.4) {
    lines.push(`- Hari yang sering: **${pattern.topWeekdayName}** (${pattern.topWeekdayCount}/${pattern.total}x)`);
  }
  lines.push("_(Pola dari histori doang, BUKAN jadwal resmi - IDN nggak nyediain jadwal, jadi bisa aja meleset.)_");

  return lines.join("\n");
}

// "cok jadwal hari ini" - versi on-demand dari prediksi jadwal pagi hari
// (notify/publicAlerts.js's maybeSendScheduleDigest, kandidat dari fungsi yang
// sama). Sebelumnya "hari ini" kebaca sebagai NAMA member dan dijawab
// "belum ada riwayat live buat 'hari ini'".
const TODAY_SCHEDULE_WORDS = new Set(["hari ini", "hari", "hariini", "today", "sekarang", "nanti", "hari ini dong"]);

function isTodayScheduleFragment(fragment) {
  return TODAY_SCHEDULE_WORDS.has(
    String(fragment || "")
      .trim()
      .replace(/[?!.\s]+$/, ""),
  );
}

function replyScheduleToday(now = new Date()) {
  const { candidates, todayWeekdayName } = getScheduleDigestCandidates(now);
  return (
    buildScheduleDigestPayload(candidates, todayWeekdayName) ||
    `Cok, belum ada member yang pola jadwalnya cukup kuat buat ditebak live di hari ${todayWeekdayName} ini. Mau cek satu member? Ketik "jadwal <nama>".`
  );
}

module.exports = {
  replySchedulePattern,
  isTodayScheduleFragment,
  replyScheduleToday,
};
