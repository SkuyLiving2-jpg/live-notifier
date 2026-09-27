const { postToWebhook } = require("./webhook");
const { formatDuration, formatMonthLabel, getHourWIBOf, getTodayWIB, getDateWIB, WEEKDAY_FORMATTER_WIB } = require("../utils");
const { getPreviousMaxDuration, findDurationHistoryByNameFragment, loadDurationHistory } = require("../storage/durationHistory");
const {
  loadDailyLog,
  saveDailyLog,
  getCompletedSessionsToday,
  getCompletedSessionsSince,
  getCompletedSessionsForMonth,
  getDistinctSessionDatesForMember,
} = require("../storage/dailyLog");
const { activeLives, saveActiveLives } = require("../storage/activeLives");
const { loadSubscriptions } = require("../storage/subscriptions");
const { wasAlertedToday, markAlertedToday } = require("../storage/headsUpAlerts");
const { getLastAlertedStreak, setLastAlertedStreak, clearStreakAlert } = require("../storage/streaks");
const { computeSchedulePattern, isHourInRange, HEADS_UP_MIN_ENTRIES, HEADS_UP_MIN_DOMINANCE } = require("../schedulePattern");
const { computeCurrentStreak, STREAK_MILESTONES } = require("../streakMath");
const { DAILY_RECAP_HOUR, SCHEDULE_DIGEST_HOUR, DAILY_RECAP_COLOR } = require("../config");

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

// Saran fitur ke-6 (§10's kelimapuluh+item): "prediksi jadwal hari ini",
// dikirim SEKALI tiap pagi (default jam 7 WIB, lihat config.js's
// SCHEDULE_DIGEST_HOUR) - pelengkap alami dari rekap harian/mingguan/bulanan
// otomatis di atas (yang ngerangkum yang UDAH SELESAI), ini nebak yang BELUM
// terjadi. Beda dari "cok jadwal <nama>" (satu member, on-demand, jawab APA
// ADANYA walau pola-nya lemah - USER yang nanya) DAN heads-up DM/publik di
// atas (JAM SPESIFIK, per-member, real-time) - ini SEMUA member sekaligus,
// SEKALI SEHARI, dan cuma nyebut yang pola HARI-nya (bukan cuma jamnya) kuat
// buat HARI INI spesifik, biar daftarnya gak kepanjangan nyebutin semua
// member yang punya RIWAYAT tapi gak ada indikasi bakal live HARI INI.
function buildScheduleDigestPayload(candidates, todayWeekdayName) {
  if (candidates.length === 0) return null;

  const pad2 = (n) => String(n).padStart(2, "0");
  const lines = candidates.map((c) => `- **${c.displayName}** sekitar jam ${pad2(c.pattern.rangeMin)}-${pad2(c.pattern.rangeMax)} WIB`);

  return {
    embeds: [
      {
        title: `📅 Prediksi jadwal hari ${todayWeekdayName}`,
        description: [
          `Member yang histori live-nya nunjukkin pola KUAT di hari ${todayWeekdayName}, sekitar jam segini:`,
          lines.join("\n"),
          "",
          "_(Perkiraan dari pola histori kita sendiri, BUKAN jadwal resmi - IDN gak nyediain jadwal sama sekali, bisa aja meleset. Member lain masih bisa aja live juga, cuma pola histori mereka belum cukup kuat buat diprediksi.)_",
        ].join("\n"),
        color: DAILY_RECAP_COLOR,
        timestamp: new Date().toISOString(),
      },
    ],
  };
}

// `now` opsional, sama alasannya kayak maybeSendWeeklyRecap/maybeSendMonthlyRecap
// di atas (§10's thirty-ninth item) - biar gerbang jam/dedup-nya bisa dites
// deterministik.
async function maybeSendScheduleDigest(now = new Date()) {
  if (getHourWIBOf(now) < SCHEDULE_DIGEST_HOUR) return;

  const todayKey = getDateWIB(now);
  const log = loadDailyLog();
  if (log.digestSentDate === todayKey) return; // udah kekirim hari ini

  const todayWeekdayName = WEEKDAY_FORMATTER_WIB.format(now);
  const history = loadDurationHistory();
  const candidates = [];
  for (const [username, entries] of Object.entries(history)) {
    if (entries.length === 0 || activeLives.has(username)) continue; // lagi live sekarang - gak perlu "diprediksi" lagi, udah kejadian

    const pattern = computeSchedulePattern(entries);
    if (!pattern || pattern.total < HEADS_UP_MIN_ENTRIES) continue;
    // Dua ambang dominansi dicek TERPISAH - jam (topBucketCount, sama kayak
    // heads-up) DAN hari (topWeekdayCount, KHUSUS di sini) - member yang jam
    // live-nya konsisten tapi HARI-nya tersebar acak ke seluruh minggu tetep
    // HARUS gak nyantol ke SATU hari spesifik manapun, walau jamnya kuat.
    if (pattern.topBucketCount / pattern.total < HEADS_UP_MIN_DOMINANCE) continue;
    if (pattern.topWeekdayName !== todayWeekdayName) continue;
    if (pattern.topWeekdayCount / pattern.total < HEADS_UP_MIN_DOMINANCE) continue;

    candidates.push({ username, displayName: entries[entries.length - 1].name || username, pattern });
  }
  candidates.sort((a, b) => a.pattern.rangeMin - b.pattern.rangeMin); // yang diperkirakan PALING PAGI duluan

  const payload = buildScheduleDigestPayload(candidates, todayWeekdayName);
  if (payload) {
    if (await postToWebhook(payload, "Gagal ngirim prediksi jadwal harian:")) {
      console.log(`Prediksi jadwal harian terkirim (${candidates.length} member)`);
    }
  }
  // Ditandai SELESAI hari ini walau `payload` null (gak ada kandidat sama
  // sekali) - sama pola-nya kayak maybeSendDailyRecap, biar gak dicoba
  // ngitung ulang tiap siklus polling sepanjang sisa hari itu.
  log.digestSentDate = todayKey;
  saveDailyLog(log);
}

// Saran fitur ke-4 (§10's kelimapuluh+item): heads-up jadwal PUBLIK - beda
// dari notify/priorityDm.js's maybeSendHeadsUpAlerts (DM ke owner doang,
// cuma buat member prioritas), ini buat member MANAPUN yang punya subscriber
// ("cok ingetin <nama>"), dikirim ke CHANNEL bersama (nge-tag subscriber-nya
// lewat mention, bukan DM) - subscriber udah opt-in secara terbuka lewat
// "cok ingetin", beda dari daftar prioritas yang preferensi PRIBADI owner,
// jadi wajar kalau alertnya nongol di channel bersama, bukan didiemin di DM.
//
// Kriteria "cukup yakin buat ngasih heads-up" (HEADS_UP_MIN_ENTRIES/
// HEADS_UP_MIN_DOMINANCE/computeSchedulePattern/isHourInRange) SAMA PERSIS
// kayak versi DM - satu-satunya beda TUJUAN pengirimannya (channel+mention
// vs DM owner), bukan KRITERIA "kapan pantes ngasih tau"-nya.
//
// Dedup per-hari-per-username PISAH dari versi DM (key di-prefix "sub:" -
// storage/headsUpAlerts.js gak peduli bentuk key-nya, cuma nyimpen string
// apa adanya) - biar member yang KEBETULAN prioritas JUGA punya subscriber
// (mis. ada yang "cok ingetin nala" padahal Nala udah prioritas) gak salah
// nge-suppress salah satu jalur gara-gara ngirain udah "kepake" hari itu,
// padahal yang kepake jalur yang laen.
function sendPublicHeadsUpAlert(displayName, pattern, subscriberIds) {
  const pad2 = (n) => String(n).padStart(2, "0");
  const windowText = `${pad2(pattern.rangeMin)}-${pad2(pattern.rangeMax)} WIB`;
  const mentions = subscriberIds.map((id) => `<@${id}>`).join(" ");

  const payload = {
    content: `👀 **${displayName}** biasanya live sekitar jam segini (${windowText}, ${pattern.topBucketCount}/${pattern.total}x riwayat terakhir) - kemungkinan bentar lagi live!\n${mentions} kamu subscribe notif buat member ini. _(Perkiraan dari pola histori, BUKAN jadwal resmi - bisa aja meleset.)_`,
    // Mention yang BENERAN dimaksud cuma subscriber-nya doang (sama pola
    // scoped-nya kayak liveNotify.js's getSubscribersFor) - biar CUMA
    // mereka yang ke-ping walau displayName kebetulan ngandung teks aneh.
    allowed_mentions: { users: subscriberIds },
  };

  return postToWebhook(payload, `Gagal ngirim heads-up jadwal publik buat ${displayName}:`).then((ok) => {
    if (ok) console.log(`Heads-up jadwal publik terkirim buat ${displayName} (${subscriberIds.length} subscriber)`);
  });
}

// `now` opsional, sama alasannya kayak maybeSendWeeklyRecap/maybeSendMonthlyRecap
// di atas (§10's thirty-ninth item) - biar gerbang jam/dedup-nya bisa dites
// deterministik pakai tanggal palsu.
async function maybeSendPublicHeadsUpAlerts(now = new Date()) {
  const today = getDateWIB(now);
  const currentHour = getHourWIBOf(now);
  const subs = loadSubscriptions();

  // Beberapa keyword subscription BEDA bisa nunjuk ke MEMBER YANG SAMA (mis.
  // ada yang subscribe pakai "nala", ada yang pakai "nala jkt48") - digabung
  // DULU jadi satu per USERNAME (union subscriber ID-nya) sebelum ngirim,
  // biar gak ada subscriber yang kelewat cuma gara-gara dia subscribe pakai
  // ejaan keyword yang beda dari yang diproses duluan.
  const byUsername = new Map(); // username -> { found, subscriberIds: Set }
  for (const [keyword, subscriberIds] of Object.entries(subs)) {
    if (subscriberIds.length === 0) continue;
    const found = findDurationHistoryByNameFragment(keyword);
    if (!found) continue;
    const bucket = byUsername.get(found.username) || { found, subscriberIds: new Set() };
    subscriberIds.forEach((id) => bucket.subscriberIds.add(id));
    byUsername.set(found.username, bucket);
  }

  for (const [username, { found, subscriberIds }] of byUsername) {
    if (activeLives.has(username)) continue; // lagi live sekarang - heads-up buat yang udah kejadian gak ada gunanya

    const dedupKey = `sub:${username}`;
    if (wasAlertedToday(dedupKey, today)) continue;

    const pattern = computeSchedulePattern(found.entries);
    if (!pattern || pattern.total < HEADS_UP_MIN_ENTRIES) continue;
    if (pattern.topBucketCount / pattern.total < HEADS_UP_MIN_DOMINANCE) continue;
    if (!isHourInRange(currentHour, pattern.rangeMin, pattern.rangeMax)) continue;

    markAlertedToday(dedupKey, today);
    await sendPublicHeadsUpAlert(found.displayName, pattern, [...subscriberIds]);
  }
}

// Saran fitur ke-5 (§10's kelimapuluh+item): LIVE STREAK - dipanggil
// monitor.js pas sebuah live SELESAI (titik yang SAMA kayak maybeAnnounceNewRecord
// di atas, cuma buat sesi yang durasinya udah lolos validasi plausible),
// jadi tanggal hari ini (WIB) UDAH pasti masuk arsip completed di titik ini -
// beda dari chat/replies.js's replyStreak yang ON-DEMAND (bisa dipanggil
// KAPAN AJA termasuk pas membernya LAGI live, belum selesai, makanya versi
// itu perlu isLiveNow, versi ini enggak).
async function sendStreakMilestoneAlert(memberName, streak) {
  const payload = {
    content: `🔥 **${memberName}** lagi live **${streak} hari berturut-turut**! Konsisten banget nih 👏`,
  };
  if (await postToWebhook(payload, "Gagal ngirim alert milestone streak:")) {
    console.log(`Milestone streak ${streak} hari terkirim untuk ${memberName}`);
  }
}

async function maybeAnnounceStreakMilestone(username, memberName) {
  const dates = getDistinctSessionDatesForMember(username);
  const streak = computeCurrentStreak(dates, getTodayWIB());

  if (streak === 0) {
    // Keputus - bersihin penanda "udah pernah diumumin" biar streak BARU
    // yang mulai dari 0 lagi bisa ngelewatin milestone yang SAMA dan tetep
    // dirayain lagi (lihat komen lengkapnya di storage/streaks.js).
    clearStreakAlert(username);
    return;
  }

  const lastAlerted = getLastAlertedStreak(username);
  // Milestone TERTINGGI yang udah kelewatan (streak >= milestone) tapi BELUM
  // pernah diumumin (milestone > lastAlerted) - bukan cuma "streak PERSIS
  // sama angka milestone", biar streak yang "meloncat" (mis. data direstore/
  // dihitung ulang) tetep dirayain sekali, bukan diem-diem kelewatan gara-gara
  // gak PERSIS hinggap di angkanya.
  const milestone = [...STREAK_MILESTONES].reverse().find((m) => streak >= m && lastAlerted < m);
  if (!milestone) return;

  setLastAlertedStreak(username, milestone);
  await sendStreakMilestoneAlert(memberName, streak);
}

module.exports = {
  maybeAlertViewerMilestone,
  maybeAnnounceNewRecord,
  maybeSendDailyRecap,
  maybeSendWeeklyRecap,
  maybeSendMonthlyRecap,
  maybeSendScheduleDigest,
  maybeSendPublicHeadsUpAlerts,
  maybeAnnounceStreakMilestone,
  buildDailyRecapPayload,
  buildWeeklyRecapPayload,
  buildMonthlyRecapPayload,
  buildScheduleDigestPayload,
  isSundayWIB,
  isLastDayOfMonthWIB,
};
