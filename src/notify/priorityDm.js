const { getDiscordClient } = require("../discordClient");
const { PRIORITY_PING_USER_ID, DEFAULT_ENDING_SOON_THRESHOLD_MS } = require("../config");
const { getPriorityConfig, buildPriorityPayload, getAllPriorityMembers } = require("../priority");
const { getAverageDuration, findDurationHistoryByNameFragment } = require("../storage/durationHistory");
const { activeLives, saveActiveLives } = require("../storage/activeLives");
const { wasAlertedToday, markAlertedToday } = require("../storage/headsUpAlerts");
const { computeSchedulePattern, isHourInRange } = require("../schedulePattern");
const { formatDuration, getDateWIB, getHourWIBOf } = require("../utils");

// Notif flashy (embed warna-warni + tombol + pesan spesial) buat member
// prioritas dulu kekirim ke CHANNEL bersama - masalahnya, channel itu
// kelihatan sama persis buat SEMUA orang yang join server, padahal daftar
// prioritas (Nala/Levi/Lily/custom) itu preferensi PRIBADI pemilik bot
// (PRIORITY_PING_USER_ID). Sekarang dipisah: channel publik SELALU dapet
// notif standar (lihat notify/liveNotify.js's buildNormalPayload) buat
// SEMUA member termasuk prioritas - biar orang lain yang join gak ngerasa
// "dipaksa" liat 3 member itu diistimewain. Versi flashy-nya dikirim
// TERPISAH lewat DM pribadi ke pemilik doang (fungsi di bawah ini), gak
// numpang tampil di channel sama sekali.
async function sendPriorityDM(memberName, liveUrl, status, priority, imageUrl, timestamp) {
  const client = getDiscordClient();
  if (!client || !PRIORITY_PING_USER_ID) return; // fitur bot token/owner ID belum diset - flashy DM dimatiin, channel tetap dapet notif biasa

  const payload = buildPriorityPayload(memberName, liveUrl, status, priority, imageUrl, { includeMention: false, timestamp });
  try {
    const user = await client.users.fetch(PRIORITY_PING_USER_ID);
    await user.send(payload);
    console.log(`DM prioritas (${status}) terkirim untuk ${memberName}`);
  } catch (error) {
    console.error("Gagal ngirim DM prioritas (channel tetap dapet notif biasa, ini nggak fatal):", error.message);
  }
}

// "Party Mode": momen 2+ member prioritas (Nala/Levi/Lily/custom) live
// BARENGAN itu momen langka & seru - pantes dikasih alert khusus di luar
// notif "mulai live" biasa-biasa tiap orang. Dipanggil abis notif "start"
// buat member prioritas berhasil kekirim, jadi otomatis nge-refresh ("Nala &
// Levi" -> "Nala & Levi & Lily") tiap kali ada tambahan anggota partynya.
//
// Sama kayak notif prioritas & ending-soon, ini soal daftar prioritas PRIBADI
// pemilik bot - jadi dikirim lewat DM ke pemilik doang, gak diposting ke
// channel bersama (yang keliatan sama buat siapapun yang join server).
async function maybePartyModeAlert() {
  const client = getDiscordClient();
  if (!client || !PRIORITY_PING_USER_ID) return;

  const liveNow = [...activeLives.values()].filter((entry) => getPriorityConfig(entry.name, entry.username));
  if (liveNow.length < 2) return;

  const names = liveNow.map((entry) => `**${entry.name}**`).join(" & ");

  const payload = {
    content: `🎉🔥 **PARTY MODE AKTIF!** 🔥🎉\n${liveNow.length} member prioritas live BARENGAN: ${names}!\nSaatnya split-screen! 📱📱`,
  };

  try {
    const user = await client.users.fetch(PRIORITY_PING_USER_ID);
    await user.send(payload);
    console.log("Party Mode alert (DM) terkirim");
  } catch (error) {
    console.error("Gagal ngirim Party Mode alert (DM, ini nggak fatal):", error.message);
  }
}

// Heuristik ini cuma buat member prioritas (preferensi PRIBADI pemilik) -
// sama kayak notif start/end prioritas, ini dikirim lewat DM ke pemilik
// doang, BUKAN diposting ke channel bersama (dulu gitu - masalahnya orang
// lain di channel bakal ikut keliatan "kok bot ini perhatian banget sama 3
// orang ini doang" padahal itu preferensi pemilik doang).
async function sendEndingSoonAlert(entry, priority, elapsedMs, avgMs) {
  const client = getDiscordClient();
  if (!client || !PRIORITY_PING_USER_ID) return;

  const liveUrl = `https://idn.app/${entry.username}/live/${entry.slug}`;
  const elapsedText = formatDuration(elapsedMs);
  const basis = avgMs
    ? `rata-rata live dia biasanya ${formatDuration(avgMs)}`
    : `belum ada cukup riwayat, pakai perkiraan umum ${formatDuration(DEFAULT_ENDING_SOON_THRESHOLD_MS)}`;

  const payload = {
    content: `${priority.sirens} **${priority.label} udah live ${elapsedText}** - kemungkinan mendekati akhir/mau baca podium (${basis}). Ini perkiraan doang, bisa meleset!`,
    embeds: [
      {
        title: `⏳ Kemungkinan ${priority.label} bakal segera akhirin live`,
        description: `**PERKIRAAN, bukan kepastian** - cek langsung buat mastiin.\n\n[🔴 **BUKA LIVE-NYA**](${liveUrl})`,
        color: priority.color,
        footer: { text: "Heuristik durasi live, bisa meleset" },
        timestamp: new Date().toISOString(),
      },
    ],
  };

  try {
    const user = await client.users.fetch(PRIORITY_PING_USER_ID);
    await user.send(payload);
    console.log(`Alert 'ending soon' (DM) terkirim untuk ${entry.name}`);
  } catch (error) {
    console.error("Gagal ngirim alert ending-soon (DM, ini nggak fatal):", error.message);
  }
}

// PENTING: ini PERKIRAAN, bukan deteksi beneran. API IDN nggak nyediain data
// gift/podium sama sekali, jadi kita cuma bisa nebak dari durasi live
// dibanding rata-rata durasi live orang itu sebelumnya (atau ambang default
// kalau belum ada riwayat). Bisa aja meleset - dipicu sekali doang per sesi
// live biar nggak spam.
async function maybeAlertEndingSoon(entry, durationHistory) {
  const priority = getPriorityConfig(entry.name, entry.username);
  if (!priority) return; // heuristik ini cuma buat member prioritas
  if (entry.endingSoonAlerted || !entry.liveAt) return;

  const elapsedMs = Date.now() - new Date(entry.liveAt).getTime();
  const avgMs = getAverageDuration(durationHistory, entry.username);
  const thresholdMs = avgMs ? avgMs * 0.8 : DEFAULT_ENDING_SOON_THRESHOLD_MS;

  if (elapsedMs >= thresholdMs) {
    entry.endingSoonAlerted = true;
    saveActiveLives();
    await sendEndingSoonAlert(entry, priority, elapsedMs, avgMs);
  }
}

// Ambang buat alert heads-up PROAKTIF (§10's forty-third item, owner minta
// "Q2" fitur ke-5) - SENGAJA lebih ketat dari "cok jadwal <nama>"'s ambang
// (minimal 3 riwayat, ditampilin apa adanya soalnya USER yang nanya, gampang
// diabein kalau meleset). Alert ini NYAMPERIN owner duluan tanpa diminta -
// owner sendiri ngingetin jam live JKT48 itu SANGAT random/acak, jadi harus
// lebih yakin dulu sebelum berani ngasih tau:
// - minimal 5 live yang ke-track (bukan 3) - riwayat yang lebih panjang
//   sebelum berani nebak ada pola beneran.
// - pola jam yang PALING SERING muncul (topBucketName) harus ngerangkum
//   MINIMAL SEPARUH (50%) dari riwayat yang ke-track - kalau live-nya
//   beneran tersebar acak ke semua jam, gak ada pola yang cukup kuat buat
//   dipercaya, mendingan diem daripada ngasih heads-up yang bakal sering meleset.
const HEADS_UP_MIN_ENTRIES = 5;
const HEADS_UP_MIN_DOMINANCE = 0.5;

async function sendHeadsUpAlert(priority, displayName, pattern) {
  const client = getDiscordClient();
  if (!client || !PRIORITY_PING_USER_ID) return;

  const pad2 = (n) => String(n).padStart(2, "0");
  const windowText = `${pad2(pattern.rangeMin)}-${pad2(pattern.rangeMax)} WIB`;

  const payload = {
    content: `${priority.sirens} **${priority.label}** biasanya live sekitar jam segini (${windowText}, ${pattern.topBucketCount}/${pattern.total}x riwayat terakhir) - kemungkinan bentar lagi live!`,
    embeds: [
      {
        title: `👀 Kemungkinan ${priority.label} bakal live sebentar lagi`,
        description:
          "**PERKIRAAN dari pola histori, BUKAN jadwal resmi** - IDN gak nyediain jadwal sama sekali, jam live beneran bisa aja meleset jauh dari ini.",
        color: priority.color,
        footer: { text: "Heuristik pola jam live, bisa meleset" },
        timestamp: new Date().toISOString(),
      },
    ],
  };

  try {
    const user = await client.users.fetch(PRIORITY_PING_USER_ID);
    await user.send(payload);
    console.log(`Alert 'heads-up jadwal' (DM) terkirim untuk ${displayName}`);
  } catch (error) {
    console.error("Gagal ngirim alert heads-up jadwal (DM, ini nggak fatal):", error.message);
  }
}

// Dipanggil tiap siklus polling (monitor.js), sama pola-nya kayak
// notify/publicAlerts.js's maybeSendDailyRecap dkk - murah buat dicek ulang
// kalau gerbangnya lagi ketutup (maks 1 lookup durationHistory + 1 lookup
// heads-up-alerts.json per member prioritas per siklus).
//
// Cuma buat member PRIORITAS (preferensi pribadi pemilik, sama kayak
// ending-soon/Party Mode) - resolusi keyword ("nala") ke username IDN
// ("jkt48_nala") lewat findDurationHistoryByNameFragment, SAMA fungsi yang
// dipake "cok jadwal <nama>" buat nyari histori durasinya (satu-satunya
// sumber data pola jam yang ada). Member yang LAGI LIVE SEKARANG dilewatin -
// heads-up buat sesuatu yang UDAH kejadian gak ada gunanya, dan mereka udah
// dapet notif "mulai live" sendiri.
//
// `now` opsional (default beneran "sekarang", monitor.js gak pernah ngoper
// ini manual) - SAMA alasannya kayak notify/publicAlerts.js's
// maybeSendWeeklyRecap/maybeSendMonthlyRecap (§10's thirty-ninth item):
// biar gerbang jam/kunci-dedup-nya bisa dites deterministik pakai tanggal
// palsu, tanpa perlu data histori-nya ikut dipalsuin juga.
async function maybeSendHeadsUpAlerts(now = new Date()) {
  const client = getDiscordClient();
  if (!client || !PRIORITY_PING_USER_ID) return;

  const today = getDateWIB(now);
  const currentHour = getHourWIBOf(now);

  for (const priority of getAllPriorityMembers()) {
    const found = findDurationHistoryByNameFragment(priority.keyword);
    if (!found || activeLives.has(found.username)) continue;
    if (wasAlertedToday(found.username, today)) continue;

    const pattern = computeSchedulePattern(found.entries);
    if (!pattern || pattern.total < HEADS_UP_MIN_ENTRIES) continue;
    if (pattern.topBucketCount / pattern.total < HEADS_UP_MIN_DOMINANCE) continue;
    if (!isHourInRange(currentHour, pattern.rangeMin, pattern.rangeMax)) continue;

    markAlertedToday(found.username, today);
    await sendHeadsUpAlert(priority, found.displayName, pattern);
  }
}

module.exports = { sendPriorityDM, maybePartyModeAlert, maybeAlertEndingSoon, maybeSendHeadsUpAlerts };
