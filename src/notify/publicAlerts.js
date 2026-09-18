const { postToWebhook } = require("./webhook");
const { formatDuration, getHourWIBOf } = require("../utils");
const { getPreviousMaxDuration } = require("../storage/durationHistory");
const { loadDailyLog, saveDailyLog } = require("../storage/dailyLog");
const { saveActiveLives } = require("../storage/activeLives");
const { DAILY_RECAP_HOUR } = require("../config");

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

async function maybeSendDailyRecap() {
  if (getHourWIBOf() < DAILY_RECAP_HOUR) return;

  const log = loadDailyLog();
  if (log.recapSentDate === log.date) return; // udah kekirim hari ini

  const completed = log.sessions.filter((s) => s.endedAtUnix !== null);
  if (completed.length > 0) {
    const totalLives = completed.length;
    const totalDurationMs = completed.reduce((sum, s) => sum + s.durationMs, 0);
    const longest = completed.reduce((max, s) => (s.durationMs > max.durationMs ? s : max), completed[0]);
    const uniqueMembers = new Set(completed.map((s) => s.name)).size;

    const payload = {
      content: [
        `📋 **Rekap live hari ini (${log.date})**`,
        `Total live: ${totalLives}x dari ${uniqueMembers} member`,
        `Total durasi gabungan: ${formatDuration(totalDurationMs)}`,
        `Paling lama: **${longest.name}** (${formatDuration(longest.durationMs)})`,
      ].join("\n"),
    };

    if (await postToWebhook(payload, "Gagal ngirim rekap harian:")) {
      console.log("Rekap harian terkirim");
    }
  }

  log.recapSentDate = log.date;
  saveDailyLog(log);
}

module.exports = { maybeAlertViewerMilestone, maybeAnnounceNewRecord, maybeSendDailyRecap };
