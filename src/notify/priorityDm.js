const { getDiscordClient } = require("../discordClient");
const { PRIORITY_PING_USER_ID, DEFAULT_ENDING_SOON_THRESHOLD_MS } = require("../config");
const { getPriorityConfig, buildPriorityPayload } = require("../priority");
const { getAverageDuration } = require("../storage/durationHistory");
const { activeLives, saveActiveLives } = require("../storage/activeLives");
const { formatDuration } = require("../utils");

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
async function sendPriorityDM(memberName, liveUrl, status, priority, imageUrl) {
  const client = getDiscordClient();
  if (!client || !PRIORITY_PING_USER_ID) return; // fitur bot token/owner ID belum diset - flashy DM dimatiin, channel tetap dapet notif biasa

  const payload = buildPriorityPayload(memberName, liveUrl, status, priority, imageUrl, { includeMention: false });
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

module.exports = { sendPriorityDM, maybePartyModeAlert, maybeAlertEndingSoon };
