const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");
const { activeLives } = require("../storage/activeLives");
const { getCompletedSessionsToday, getCompletedSessionsSince } = require("../storage/dailyLog");
const { loadLiveCount } = require("../storage/liveCount");
const { describeElapsed, safeReplyOptions } = require("../utils");
const { deleteInteractionMessage } = require("./interactionHelpers");
const { buildRecapTablePage } = require("./replies");

// Fallback reply KHUSUS channel per-member (fitur "Q3") - beda dari
// menu.js's replyFallbackMenu (9 opsi generik buat channel gabungan), ini
// SENGAJA cuma 3 opsi soalnya channel-nya udah scoped ke SATU member aja,
// jadi gak perlu nanya "member yang mana" kayak opsi 4/9 di menu utama -
// username-nya udah pasti dari channelRouting.js's getUsernameForChannel
// (dipanggil chat/router.js pas pesan MASUK dari channel yang ke-mapping).
//
// Seberapa jauh sebuah channel dianggep "channel khusus member" ditentuin
// storage/channelRouting.js (entry bentuk object yang punya channelId) -
// modul ini murni logic BALASANNYA doang, gak nyentuh routing-nya sendiri.

function resolveMemberDisplayName(username) {
  const live = activeLives.get(username);
  if (live?.name) return live.name;
  const countEntry = loadLiveCount()[username];
  if (countEntry?.name) return countEntry.name;
  return username;
}

// "Tutup" ditambahin di sini (baris yang sama, masih di bawah limit 5
// tombol/baris Discord) - dulu gak ada cara nutup sama sekali di channel
// khusus member, beda dari menu 9-opsi/tabel rekap yang udah dibenerin
// duluan (lihat handleMemberChannelFallbackButton buat kenapa ini penting).
function buildMemberChannelFallbackComponents(username) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`member_fallback:today:${username}`).setLabel("Udah live hari ini?").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`member_fallback:count:${username}`).setLabel("Udah berapa kali live?").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`member_fallback:status:${username}`).setLabel("Lagi live sekarang?").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`member_fallback:close:${username}`).setLabel("Tutup").setStyle(ButtonStyle.Danger),
  );
  return [row];
}

function replyMemberChannelFallback(username) {
  const name = resolveMemberDisplayName(username);
  return {
    content: `Halo! Mau tau apa soal **${name}**? Klik salah satu di bawah ya.`,
    components: buildMemberChannelFallbackComponents(username),
  };
}

// Opsi 1: "udah live hari ini?" - gabungan sesi yang UDAH SELESAI hari ini
// (daily log) + yang MASIH LIVE SEKARANG (activeLives), sama pola gabungnya
// kayak replies.js's replyLongestLive/getTodaySessionsForRecap tapi
// difilter ke SATU username doang.
function replyMemberLiveToday(username) {
  const name = resolveMemberDisplayName(username);
  const isLiveNow = activeLives.has(username);
  const completedToday = getCompletedSessionsToday().filter((s) => s.username === username).length;
  const totalToday = completedToday + (isLiveNow ? 1 : 0);

  if (totalToday === 0) {
    return { content: `Cok, **${name}** belum live hari ini.` };
  }
  const liveNowNote = isLiveNow ? " (salah satunya lagi berlangsung sekarang)" : "";
  return { content: `Cok, **${name}** udah live ${totalToday}x hari ini${liveNowNote}.` };
}

// Opsi 2: total live count SEMENJAK bot ini jalan (storage/liveCount.js,
// counter yang gak pernah di-prune - beda dari daily log yang di-prune 35
// hari). Kalau ada datanya, tawarin liat tabel histori (opsi 3-nya
// replyMemberLiveHistoryTable, lewat tombol y/n) - kalau nggak ada,
// jangan pura-pura nawarin history yang emang kosong.
function replyMemberLiveCount(username) {
  const name = resolveMemberDisplayName(username);
  const entry = loadLiveCount()[username];
  if (!entry) {
    return { content: `Cok, belum ada catatan live buat **${name}** semenjak bot ini mantau.` };
  }

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`member_fallback:history_yes:${username}`).setLabel("Mau liat history live nya?").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`member_fallback:history_no:${username}`).setLabel("Nggak usah").setStyle(ButtonStyle.Secondary),
  );
  return {
    content: `Cok, **${name}** udah live **${entry.count}x** semenjak bot ini mantau. Mau liat history live-nya?`,
    components: [row],
  };
}

// Klik "y" abis replyMemberLiveCount - tabel rekap sesi yang ke-track
// (daily-log.json, cuma nyimpen 35 hari terakhir - lihat storage/dailyLog.js)
// difilter ke SATU member doang. Reuse buildRecapTablePage dari replies.js
// (sama fungsi yang dipake "cok rekap") biar formatnya konsisten, cuma
// nunjukkin HALAMAN PERTAMA doang (gak ada navigasi halaman kayak rekap
// biasa) - sengaja diringkes sesuai instruksi "lebih simple", riwayat 1
// member jarang lebih dari 20 sesi (1 halaman) dalam 35 hari.
function replyMemberLiveHistoryTable(username) {
  const name = resolveMemberDisplayName(username);
  const sessions = getCompletedSessionsSince(365).filter((s) => s.username === username);
  if (sessions.length === 0) {
    // Bisa kejadian kalau live count-nya > 0 tapi semua sesinya udah
    // ke-prune dari daily log (retensi 35 hari) - counter total-nya sendiri
    // gak pernah di-prune, jadi dua sumber ini bisa nyimpang buat member
    // yang udah lama banget gak ke-cek historinya.
    return { content: `Cok, detail history **${name}** udah nggak kesimpen lagi (cuma nyimpen 35 hari terakhir).` };
  }

  const { text, hasMore } = buildRecapTablePage(sessions, 0);
  const moreNote = hasMore ? `\n_(cuma nunjukkin ${sessions.length > 20 ? 20 : sessions.length} sesi terbaru)_` : "";
  return { content: `📊 History live **${name}** (35 hari terakhir):\n${text}${moreNote}` };
}

// Opsi 3: cek status live SEKARANG. Kalau lagi live, tawarin nonton lewat
// tombol y/n (link cuma dikasih abis dikonfirmasi, bukan langsung
// dimuntahin) - kalau nggak lagi live, jawaban final, gak ada tombol lanjutan.
function replyMemberLiveStatus(username) {
  const name = resolveMemberDisplayName(username);
  const entry = activeLives.get(username);
  if (!entry) {
    return { content: `Cok, **${name}** lagi nggak live sekarang.` };
  }

  const elapsedText = describeElapsed(Date.now() - new Date(entry.liveAt).getTime());
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`member_fallback:watch_yes:${username}`).setLabel("Ya, nonton").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`member_fallback:watch_no:${username}`).setLabel("Nggak dulu").setStyle(ButtonStyle.Secondary),
  );
  return {
    content: `🔴 **${name}** lagi live nih, ${elapsedText}! Mau nonton live-nya?`,
    components: [row],
  };
}

// Klik "y" abis replyMemberLiveStatus - RE-CEK activeLives di sini (jangan
// percaya status lama dari waktu tombolnya ditampilin), sama pola safety-nya
// kayak menu.js's tryHandleWatchConfirmShortcut - member bisa aja udah
// selesai live pas user baru mikir mau klik atau nggak.
function replyMemberWatchNow(username) {
  const name = resolveMemberDisplayName(username);
  const entry = activeLives.get(username);
  if (!entry) {
    return { content: `Yah, **${name}** kayaknya baru aja selesai live.` };
  }
  const liveUrl = `https://idn.app/${entry.username}/live/${entry.slug}`;
  return { content: `🔴 Gas nonton! **${name}** - ${liveUrl}` };
}

const THANKS_ENJOY_REPLY = { content: "Oke, terima kasih ya, semoga enjoy! 🎉", components: [] };

// BUG SEBELUMNYA: SEMUA cabang di sini pake interaction.reply() (pesan BARU)
// - channel khusus member (fitur per-member dedicated channel) numpuk 1
// pesan baru TIAP KALI ada yang mencet tombol apapun di sini, persis keluhan
// yang udah dibenerin duluan buat menu 9-opsi (chat/menu.js's
// handleFallbackMenuButton) dan tabel rekap (chat/replies.js's
// handleRecapNavButton), cuma file ini kelewatan pas itu dibenerin. Sekarang
// SEMUA cabang pake interaction.update() (EDIT pesan yang tombolnya nempel),
// sama polanya kayak dua file itu:
// - "today"/"count"/"status" - jawaban langsung. Kalau reply-nya UDAH bawa
//   tombol lanjutan sendiri (count/status yang ada data, nawarin liat
//   history/nonton), dipake apa adanya - gak ditempelin menu 3-opsi lagi di
//   atasnya (2 sistem tombol beda konteks numpuk di 1 pesan bikin bingung,
//   bukan bantu, sama alasannya kayak opsi 8 di menu.js). Kalau kosong (gak
//   ada data/gak lagi live), menu 3-opsi (+Tutup) ditempelin balik biar bisa
//   lanjut nanya yang lain dari pesan yang sama.
// - "history_yes" - nunjukkin tabel, gak ada tombol lanjutan sendiri, jadi
//   menu 3-opsi ditempelin balik juga.
// - "watch_yes"/"history_no"/"watch_no" - JAWABAN FINAL atas pertanyaan y/n
//   (bukan pertanyaan baru), components:[] eksplisit buat ngosongin tombol,
//   sama pola-nya kayak menu.js's handleWatchConfirmButton's "yes"/"no".
// - "close" - nutup interaksinya. §10's thirty-fifth item: dulu diedit jadi
//   teks "Oke, dibatalin." + components:[], sekarang BENERAN ngehapus
//   pesannya (deleteInteractionMessage) - logika "tutup" yang sekarang
//   konsisten di semua tombol Tutup di bot ini (menu 9-opsi, dropdown 4/9,
//   watch-confirm, DAN tabel rekap).
async function handleMemberChannelFallbackButton(interaction) {
  const [, action, username] = interaction.customId.split(":");

  if (action === "close") {
    await deleteInteractionMessage(interaction);
    return;
  }

  if (action === "history_no" || action === "watch_no") {
    await interaction.update(safeReplyOptions(THANKS_ENJOY_REPLY));
    return;
  }

  if (action === "watch_yes") {
    await interaction.update(safeReplyOptions({ ...replyMemberWatchNow(username), components: [] }));
    return;
  }

  if (action === "history_yes") {
    await interaction.update(
      safeReplyOptions({ ...replyMemberLiveHistoryTable(username), components: buildMemberChannelFallbackComponents(username) }),
    );
    return;
  }

  let reply;
  if (action === "today") reply = replyMemberLiveToday(username);
  else if (action === "count") reply = replyMemberLiveCount(username);
  else if (action === "status") reply = replyMemberLiveStatus(username);
  else return;

  if (!reply.components) reply.components = buildMemberChannelFallbackComponents(username);
  await interaction.update(safeReplyOptions(reply));
}

module.exports = {
  buildMemberChannelFallbackComponents,
  replyMemberChannelFallback,
  replyMemberLiveToday,
  replyMemberLiveCount,
  replyMemberLiveHistoryTable,
  replyMemberLiveStatus,
  replyMemberWatchNow,
  handleMemberChannelFallbackButton,
};
