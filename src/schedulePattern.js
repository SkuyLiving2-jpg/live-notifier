const { getTimeOfDayBucket, getHourWIBOf, WEEKDAY_FORMATTER_WIB } = require("./utils");

// Diekstrak dari chat/replies.js's replySchedulePattern (§10's forty-third
// item) - matematika "pola jam/hari paling sering muncul dari riwayat durasi
// live" ini dibutuhin di DUA tempat sekarang: replySchedulePattern ("cok
// jadwal <nama>", jawaban ATAS PERTANYAAN user) dan notify/priorityDm.js's
// maybeSendHeadsUpAlerts (alert PROAKTIF nyamperin owner duluan, §10's
// forty-third item juga). Modul standalone (gak require apapun dari
// chat/ ATAU notify/) SENGAJA - notify/ butuh matematika ini juga, dan
// notify/ me-require dari chat/ bakal kebalik arah dependency yang udah ada
// di seluruh codebase ini (chat/ konsisten cuma narik dari storage/priority/
// utils, notify/ juga cuma narik dari situ - gak pernah ada notify/ narik
// dari chat/ ataupun sebaliknya). Sama filosofinya kayak chat/interactionHelpers.js
// (§10's thirty-fifth item) - fungsi bersama yang ditaro di modul BARU, gak
// nempel ke salah satu pemakainya.
//
// PENTING: IDN nggak nyediain jadwal live resmi sama sekali (udah dicek
// langsung ke API-nya). Jadi ini PURE statistik dari histori kita SENDIRI
// (live-duration-history.json, maks 10 entry terakhir per orang) - bukan
// jaminan/jadwal pasti, bisa aja meleset kalau pola live-nya emang nggak
// tetap. Entries cuma nyimpen timestamp SELESAI (`at`) + durasinya, BUKAN
// timestamp mulai eksplisit - jadi waktu MULAI live diperkirakan mundur
// (at - durationMs), bukan dibaca langsung dari field.
//
// Balikin null kalau `entries` kurang dari 3 - di bawah itu gak ada cukup
// data buat nebak pola apa-apa sama sekali (dipanggil kedua pemakainya
// sebagai gerbang awal, tapi maybeSendHeadsUpAlerts nerapin ambang yang
// LEBIH KETAT lagi di atas ini, lihat komen di situ).
function computeSchedulePattern(entries) {
  if (!entries || entries.length < 3) return null;

  const startTimes = entries.map((e) => new Date(new Date(e.at).getTime() - e.durationMs));
  const total = startTimes.length;

  const bucketCounts = {};
  const weekdayCounts = {};
  const hoursByBucket = {};
  for (const startDate of startTimes) {
    const hourWIB = getHourWIBOf(startDate);
    const bucket = getTimeOfDayBucket(hourWIB);
    bucketCounts[bucket] = (bucketCounts[bucket] || 0) + 1;
    (hoursByBucket[bucket] = hoursByBucket[bucket] || []).push(hourWIB);

    const weekday = WEEKDAY_FORMATTER_WIB.format(startDate);
    weekdayCounts[weekday] = (weekdayCounts[weekday] || 0) + 1;
  }

  const [topBucketName, topBucketCount] = Object.entries(bucketCounts).sort((a, b) => b[1] - a[1])[0];
  const [topWeekdayName, topWeekdayCount] = Object.entries(weekdayCounts).sort((a, b) => b[1] - a[1])[0];

  // "malam" ngerangkum jam 18-23 SAMA 0-3 (lewat tengah malam) - kalau
  // dihitung range min/max mentah, itu bisa keliatan salah ("00-23", nutupin
  // seharian) padahal beneran cuma sekelompok jam malam yang nyambung lewat
  // pergantian hari. Digeser +24 dulu buat jam dini hari (0-3) biar urutannya
  // bener secara matematis, baru di-mod 24 lagi pas ditampilin.
  const rawHours = hoursByBucket[topBucketName];
  const rangeHours = topBucketName === "malam" ? rawHours.map((h) => (h < 4 ? h + 24 : h)) : rawHours;
  const rangeMin = Math.min(...rangeHours) % 24;
  const rangeMax = Math.max(...rangeHours) % 24;

  return { total, topBucketName, topBucketCount, topWeekdayName, topWeekdayCount, rangeMin, rangeMax };
}

// Jam `hour` (0-23) ada di antara `min`-`max` INKLUSIF, TERMASUK kasus
// rentang yang nyebrang tengah malam (mis. min=22, max=1 - jam 23 ATAU jam 0
// dua-duanya kena, tapi jam 10 pagi enggak). `min <= max` cek rentang normal
// biasa; `min > max` berarti rentangnya nyebrang, jadi "di luar [max, min]"
// alih-alih "di antara [min, max]".
function isHourInRange(hour, min, max) {
  return min <= max ? hour >= min && hour <= max : hour >= min || hour <= max;
}

module.exports = { computeSchedulePattern, isHourInRange };
