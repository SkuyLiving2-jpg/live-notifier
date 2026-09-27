const { getDateWIB } = require("./utils");

// Saran fitur ke-5 (§10's kelimapuluh+item): LIVE STREAK - berapa hari
// BERTURUT-TURUT (WIB) seorang member punya live. Modul standalone (murni
// operasi di atas STRING tanggal WIB, gak nyentuh storage/network sama
// sekali) - dipake DUA tempat (chat/replies.js's "cok streak <nama>"
// ON-DEMAND, DAN notify/publicAlerts.js's milestone alert pas sesi live
// selesai), sama alasannya kayak schedulePattern.js/interactionHelpers.js:
// modul BARU biar gak ngebalik arah dependency chat<->notify yang udah
// konsisten di seluruh codebase ini (lihat komennya schedulePattern.js).

// Tanggal WIB `deltaDays` dari `dateWIB` (boleh negatif buat mundur). Lewat
// getDateWIB (bukan Date.prototype.getDate manual) biar konsisten pake
// timezone WIB eksplisit, sama kelas kehati-hatian yang codebase ini pake di
// semua tempat lain yang ngitung tanggal (lihat komen findRecentDatesForWeekday
// di chat/replies.js soal kenapa method Date yang zona-lokal-server-dependent
// dihindarin).
function shiftDateWIB(dateWIB, deltaDays) {
  const ms = new Date(`${dateWIB}T00:00:00+07:00`).getTime() + deltaDays * 24 * 60 * 60 * 1000;
  return getDateWIB(new Date(ms));
}

// `sessionDates` - Set (atau array) tanggal WIB ("YYYY-MM-DD") tempat member
// ini PUNYA SESI SELESAI (storage/dailyLog.js's getDistinctSessionDatesForMember).
// `isLiveNow` - lagi live SEKARANG (activeLives) - dianggep "hari ini keisi"
// juga walau sesi hari ini itu sendiri BELUM SELESAI (jadi belum masuk
// `sessionDates`, yang cuma nyatet sesi yang UDAH kelar).
//
// Definisi "streak" di sini (mirip aplikasi kebiasaan kayak Duolingo): streak
// GAK keputus sampe SEHARI PENUH lewat tanpa aktivitas sama sekali - jadi
// kalau kemarin ada live tapi hari ini belum (harinya kan belum abis), streak
// masih dianggep "hidup" (dihitung mundur dari kemarin), BUKAN langsung 0.
// Streak baru BENERAN 0 begitu kemarin JUGA kosong.
function computeCurrentStreak(sessionDates, todayWIB, isLiveNow = false) {
  const dates = sessionDates instanceof Set ? sessionDates : new Set(sessionDates);
  const yesterday = shiftDateWIB(todayWIB, -1);
  const hasToday = isLiveNow || dates.has(todayWIB);
  if (!hasToday && !dates.has(yesterday)) return 0;

  let cursor = hasToday ? todayWIB : yesterday;
  let streak = 0;
  // Iterasi pertama (kalau mulai dari `todayWIB`) SELALU dianggep aktif -
  // `hasToday` udah nyakup kasus isLiveNow (yang gak nongol di `dates` sama
  // sekali soalnya sesi hari ini belum selesai). Iterasi berikutnya (hari-hari
  // SEBELUMNYA) HARUS beneran ada di `dates` - gak ada lagi "kelonggaran"
  // isLiveNow buat tanggal selain hari ini.
  while (cursor === todayWIB ? hasToday : dates.has(cursor)) {
    streak += 1;
    cursor = shiftDateWIB(cursor, -1);
  }
  return streak;
}

// Ambang perayaan streak (hari) - notify/publicAlerts.js's
// maybeAnnounceStreakMilestone cuma ngirim alert SEKALI per angka ini per
// "putaran" streak yang lagi jalan (lihat storage/streaks.js's
// lastAlertedStreak, yang direset begitu streak-nya keputus).
const STREAK_MILESTONES = [3, 5, 7, 14, 21, 30, 50, 100];

module.exports = { computeCurrentStreak, shiftDateWIB, STREAK_MILESTONES };
