const { getDiscordClient } = require("../discordClient");
const { DAILY_RECAP_HOUR } = require("../config");
const { getUserPrefs, updateUserPrefs, isQuietHour, listUsersWithOshis } = require("../storage/userPrefs");
const { summarizeMember, formatWeeklyLine } = require("../oshiSummary");
const { sendDirectMessages } = require("./personalDelivery");
const { getDateWIB, getHourWIBOf, WEEKDAY_FORMATTER_WIB } = require("../utils");

// Ringkasan mingguan oshi lewat DM: tiap Minggu jam DAILY_RECAP_HOUR (WIB) ke atas -
// jam yang sama dengan rekap mingguan publik. Pengguna yang lagi jam tenang
// ditunda; jendelanya diperpanjang sampai Senin siang supaya yang jam tenangnya
// menutupi Minggu malam tetap dapat. Dedup per pengguna lewat `digestWeek`
// (tanggal Minggu WIB minggu itu), jadi aman dipanggil tiap siklus polling.
const MONDAY_CUTOFF_HOUR = 12;
const DAY_MS = 24 * 60 * 60 * 1000;

// Tanggal Minggu (WIB) yang jendela ringkasannya sedang terbuka, atau null.
function digestWeekKey(now) {
  const weekday = WEEKDAY_FORMATTER_WIB.format(now);
  const hour = getHourWIBOf(now);
  if (weekday === "Minggu" && hour >= DAILY_RECAP_HOUR) return getDateWIB(now);
  if (weekday === "Senin" && hour < MONDAY_CUTOFF_HOUR) return getDateWIB(new Date(now.getTime() - DAY_MS));
  return null;
}

function buildDigestText(oshis, nowMs) {
  const lines = oshis.map((username) => formatWeeklyLine(summarizeMember(username, nowMs)));
  return [
    "📰 **Ringkasan mingguan oshi kamu** (7 hari terakhir)",
    "",
    ...lines,
    "",
    '_Profil lengkap: "cok oshi saya". Matiin ringkasan ini: "cok ringkasan mati"._',
  ].join("\n");
}

async function maybeSendOshiDigests(now = new Date()) {
  const weekKey = digestWeekKey(now);
  if (!weekKey || !getDiscordClient()) return;

  const hour = getHourWIBOf(now);
  for (const userId of listUsersWithOshis()) {
    const prefs = getUserPrefs(userId);
    if (prefs.digestOff || prefs.digestWeek === weekKey) continue;
    if (isQuietHour(prefs, hour)) continue; // ditunda sampai jam tenang lewat (selama jendela masih terbuka)

    // Ditandai SEBELUM kirim: DM yang ditutup/gagal tidak diulang tiap 20 detik.
    updateUserPrefs(userId, (p) => {
      p.digestWeek = weekKey;
    });
    await sendDirectMessages([userId], { content: buildDigestText(prefs.oshis, now.getTime()) });
  }
}

module.exports = { maybeSendOshiDigests, digestWeekKey, buildDigestText };
