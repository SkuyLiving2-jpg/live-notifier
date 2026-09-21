const { postToWebhook } = require("./webhook");
const { formatDuration, getHourWIBOf, getTodayWIB } = require("../utils");
const { getPreviousMaxDuration } = require("../storage/durationHistory");
const { loadDailyLog, saveDailyLog, getCompletedSessionsToday } = require("../storage/dailyLog");
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
function buildDailyRecapPayload(completed, today) {
  if (completed.length === 0) return null;

  const totalLives = completed.length;
  const totalDurationMs = completed.reduce((sum, s) => sum + s.durationMs, 0);
  const longest = completed.reduce((max, s) => (s.durationMs > max.durationMs ? s : max), completed[0]);
  const uniqueMembers = new Set(completed.map((s) => s.name)).size;

  return {
    embeds: [
      {
        title: `📋 Rekap live hari ini (${today})`,
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

module.exports = { maybeAlertViewerMilestone, maybeAnnounceNewRecord, maybeSendDailyRecap, buildDailyRecapPayload };
