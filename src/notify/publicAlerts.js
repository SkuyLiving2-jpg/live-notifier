const { postToWebhook } = require("./webhook");
const { formatDuration, formatMonthLabel, getHourWIBOf, getTodayWIB, getDateWIB, WEEKDAY_FORMATTER_WIB } = require("../utils");
const { getPreviousMaxDuration } = require("../storage/durationHistory");
const {
  loadDailyLog,
  saveDailyLog,
  getCompletedSessionsToday,
  getCompletedSessionsSince,
  getCompletedSessionsForMonth,
} = require("../storage/dailyLog");
const { saveActiveLives } = require("../storage/activeLives");
const { DAILY_RECAP_HOUR, DAILY_RECAP_COLOR } = require("../config");

// Ambang jumlah penonton buat alert "tembus milestone" - sekali per ambang
// per sesi live (dicatet di entry.alertedMilestones), berlaku buat SEMUA
// member JKT48 (bukan cuma prioritas), soalnya lonjakan penonton itu sinyal
// bagus buat ikutan nonton siapapun membernya.
const VIEWER_MILESTONES = [1000, 5000, 10000, 20000, 50000];

async function sendViewerMilestoneAlert(entry, milestone) {
  const liveUrl = `https://idn.app/${entry.username}/live/${entry.slug}`;
  const payload = {
    content: `🎯 **${entry.name}** baru aja tembus **${milestone.toLocaleString("id-ID")} penonton**! 👀🔥\n${liveUrl}`,
  };

  if (await postToWebhook(payload, "Gagal ngirim alert milestone penonton:")) {
    console.log(`Milestone ${milestone} penonton terkirim untuk ${entry.name}`);
  }
}

async function maybeAlertViewerMilestone(entry) {
  if (entry.viewCount == null) return;
  entry.alertedMilestones = entry.alertedMilestones || [];

  for (const milestone of VIEWER_MILESTONES) {
    if (entry.viewCount >= milestone && !entry.alertedMilestones.includes(milestone)) {
      entry.alertedMilestones.push(milestone);
      saveActiveLives();
      await sendViewerMilestoneAlert(entry, milestone);
    }
  }
}

// Selebrasi kalau live yang baru aja selesai itu rekor durasi TERLAMA buat
// member itu (dibanding riwayat sebelumnya). Dicek SEBELUM live barusan
// dicatet ke riwayat, biar dibandingin ke rekor LAMA-nya, bukan diri sendiri.
async function maybeAnnounceNewRecord(username, memberName, durationMs, durationHistory) {
  const previousMax = getPreviousMaxDuration(durationHistory, username);
  if (previousMax === null || durationMs <= previousMax) return;

  const payload = {
    content: `🏆 **${memberName}** baru aja pecahin rekor durasi live-nya sendiri! Sebelumnya paling lama ${formatDuration(previousMax)}, sekarang ${formatDuration(durationMs)} 🎉`,
  };

  if (await postToWebhook(payload, "Gagal ngirim notif rekor:")) {
    console.log(`Notif rekor baru terkirim untuk ${memberName}`);
  }
}

// Dipisah dari maybeSendDailyRecap biar bisa dites langsung sebagai fungsi
// murni (gak perlu mock fetch/waktu) - dulu rekap ini cuma `content` teks
// panjang 1 blok, sekarang jadi embed (title + fields) biar lebih enak
// dibaca terutama di HP (Discord ngerender field inline berdampingan,
// bukan numpuk jadi paragraf teks rata kiri doang).
//
// Balikin null kalau `completed` kosong - BUKAN cuma soal "gak ada apa-apa
// buat dilaporin", tapi `completed.reduce(..., completed[0])` di bawah bakal
// mulai dari `undefined` kalau array-nya kosong (reduce dengan initial value
// pada array kosong balikin initial value-nya apa adanya tanpa manggil
// callback-nya sama sekali), dan `longest.name`/`longest.durationMs`
// setelahnya bakal throw. Satu-satunya pemanggil sekarang (maybeSendDailyRecap
// di bawah) udah nge-guard ini duluan (`completed.length > 0`), tapi guard di
// SINI juga - bukan cuma di pemanggil - biar fungsi murni ini aman dipanggil
// langsung (mis. dari test lain di masa depan) tanpa perlu inget syarat
// tersembunyi itu.
// Embed rekap generik - SAMA persis strukturnya buat harian/mingguan/bulanan,
// cuma title-nya beda (dan datanya, tapi itu tanggung jawab pemanggil). Dulu
// ini nyatu di dalem buildDailyRecapPayload doang; diekstrak pas rekap
// mingguan/bulanan otomatis ditambahin (§10's thirty-ninth item) biar 3
// fungsi buildXRecapPayload gak nulis ulang hitungan total/paling lama yang
// sama persis 3x.
function buildRecapEmbedPayload(completed, title) {
  if (completed.length === 0) return null;

  const totalLives = completed.length;
  const totalDurationMs = completed.reduce((sum, s) => sum + s.durationMs, 0);
  const longest = completed.reduce((max, s) => (s.durationMs > max.durationMs ? s : max), completed[0]);
  const uniqueMembers = new Set(completed.map((s) => s.name)).size;

  return {
    embeds: [
      {
        title,
        color: DAILY_RECAP_COLOR,
        fields: [
          { name: "Total live", value: `${totalLives}x dari ${uniqueMembers} member`, inline: true },
          { name: "Total durasi gabungan", value: formatDuration(totalDurationMs), inline: true },
          { name: "Paling lama", value: `**${longest.name}** (${formatDuration(longest.durationMs)})`, inline: false },
        ],
        timestamp: new Date().toISOString(),
      },
    ],
  };
}

function buildDailyRecapPayload(completed, today) {
  return buildRecapEmbedPayload(completed, `📋 Rekap live hari ini (${today})`);
}

// Rekap MINGGUAN otomatis (§10's thirty-ninth item, owner minta) - datanya
// getCompletedSessionsSince(7), SAMA persis sumber yang dipake "cok rekap
// minggu ini" on-demand (rentang 7 hari rolling, BUKAN minggu kalender
// Senin-Minggu) - biar rekap otomatis ini gak ngasih angka beda dari yang
// user liat kalau nanya manual di hari yang sama.
function buildWeeklyRecapPayload(completed) {
  return buildRecapEmbedPayload(completed, "📋 Rekap live mingguan (7 hari terakhir)");
}

// Rekap BULANAN otomatis - datanya getCompletedSessionsForMonth(monthWIB),
// bulan KALENDER yang lagi ditutup (dikirim di hari TERAKHIR bulan itu,
// lihat isLastDayOfMonthWIB), sama sumbernya kayak "cok rekap bulan ini"/
// "cok rekap <nama bulan>" on-demand.
function buildMonthlyRecapPayload(completed, monthWIB) {
  return buildRecapEmbedPayload(completed, `📋 Rekap live bulanan (${formatMonthLabel(monthWIB)})`);
}

async function maybeSendDailyRecap() {
  if (getHourWIBOf() < DAILY_RECAP_HOUR) return;

  const today = getTodayWIB();
  const log = loadDailyLog();
  if (log.recapSentDate === today) return; // udah kekirim hari ini

  const payload = buildDailyRecapPayload(getCompletedSessionsToday(), today);
  if (payload) {
    if (await postToWebhook(payload, "Gagal ngirim rekap harian:")) {
      console.log("Rekap harian terkirim");
    }
  }

  log.recapSentDate = today;
  saveDailyLog(log);
}

// Hari WIB "Minggu" (Sunday) dipilih sebagai hari pengiriman rekap mingguan
// otomatis - bukan soal "itu hari yang BENER secara kalender", cuma butuh
// SATU hari tetap yang konsisten. Dites dengan `now` eksplisit (bukan cuma
// `new Date()` default) biar deterministik - gak gantungan sama hari
// beneran pas test ini kebetulan dijalanin.
function isSundayWIB(now = new Date()) {
  return WEEKDAY_FORMATTER_WIB.format(now) === "Minggu";
}

// Hari TERAKHIR di bulan kalender WIB - dicek dengan "besok" udah beda bulan
// apa belum, bukan tabel jumlah-hari-per-bulan manual (otomatis bener buat
// tahun kabisat juga, sama trik yang dipake chat/replies.js's daysInMonth,
// cuma dari arah sebaliknya).
function isLastDayOfMonthWIB(now = new Date()) {
  const todayMonth = getDateWIB(now).slice(0, 7);
  const tomorrowMonth = getDateWIB(new Date(now.getTime() + 24 * 60 * 60 * 1000)).slice(0, 7);
  return tomorrowMonth !== todayMonth;
}

// `now` opsional (default beneran "sekarang") SATU-SATUNYA buat gerbang
// hari/jam DAN kunci dedup recapSentWeek/recapSentMonth di bawah - BUKAN
// buat nentuin data yang direkap (getCompletedSessionsSince/
// getCompletedSessionsForMonth tetap narik dari waktu BENERAN sekarang,
// gak ikut di-"palsuin"). Dipisah gini SENGAJA biar testable: tes bisa
// maksa gerbangnya "hari ini pasti Minggu"/"hari ini pasti akhir bulan"
// pakai tanggal palsu tanpa perlu bikin data rekap-nya ikut palsu juga -
// di produksi dua-duanya sama-sama "sekarang beneran" soalnya `now` gak
// pernah dioper manual dari monitor.js.
async function maybeSendWeeklyRecap(now = new Date()) {
  if (!isSundayWIB(now) || getHourWIBOf(now) < DAILY_RECAP_HOUR) return;

  const todayKey = getDateWIB(now);
  const log = loadDailyLog();
  if (log.recapSentWeek === todayKey) return; // udah kekirim buat Minggu ini

  const payload = buildWeeklyRecapPayload(getCompletedSessionsSince(7));
  if (payload) {
    if (await postToWebhook(payload, "Gagal ngirim rekap mingguan:")) {
      console.log("Rekap mingguan terkirim");
    }
  }

  log.recapSentWeek = todayKey;
  saveDailyLog(log);
}

async function maybeSendMonthlyRecap(now = new Date()) {
  if (!isLastDayOfMonthWIB(now) || getHourWIBOf(now) < DAILY_RECAP_HOUR) return;

  const todayKey = getDateWIB(now);
  const log = loadDailyLog();
  if (log.recapSentMonth === todayKey) return; // udah kekirim buat penutupan bulan ini

  const monthWIB = getTodayWIB().slice(0, 7); // bulan yang BENERAN lagi ditutup hari ini
  const payload = buildMonthlyRecapPayload(getCompletedSessionsForMonth(monthWIB), monthWIB);
  if (payload) {
    if (await postToWebhook(payload, "Gagal ngirim rekap bulanan:")) {
      console.log("Rekap bulanan terkirim");
    }
  }

  log.recapSentMonth = todayKey;
  saveDailyLog(log);
}

module.exports = {
  maybeAlertViewerMilestone,
  maybeAnnounceNewRecord,
  maybeSendDailyRecap,
  maybeSendWeeklyRecap,
  maybeSendMonthlyRecap,
  buildDailyRecapPayload,
  buildWeeklyRecapPayload,
  buildMonthlyRecapPayload,
  isSundayWIB,
  isLastDayOfMonthWIB,
};
