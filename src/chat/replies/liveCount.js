// Jawaban "berapa kali <member> live" beserta tombol Lihat rekap / Tutup.

const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");
const { buildReplyCloseButton } = require("../interactionHelpers");
const { loadLiveCount, findLiveCountByNameFragment } = require("../../storage/liveCount");
const { formatRelativeTime, getDateWIB } = require("../../utils");

// Beda dari replyMemberStats di atas (yang datanya dibatesin 10 live
// TERAKHIR buat ngitung rata-rata/rekor) - ini counter TOTAL yang gak
// pernah di-prune/reset (storage/liveCount.js), jadi bisa jawab "udah
// berapa kali live SEMENJAK bot ini jalan", bukan cuma dari histori terbatas.
function formatLiveCountText(found) {
  const sinceText = getDateWIB(new Date(found.firstLiveAt));
  const lastText = formatRelativeTime(new Date(found.lastLiveAt));
  return `📊 **${found.name}** udah live **${found.count}x** semenjak bot ini mulai mantau (dari ${sinceText}). Terakhir live ${lastText}.`;
}

function describeLiveCount(fragment) {
  const name = (fragment || "").trim();
  if (!name) return { text: 'Live count siapa? Ketik nama membernya juga ya, misal "cok berapa kali nala live".', found: null };

  const found = findLiveCountByNameFragment(name);
  if (!found) return { text: `Cok, belum ada catatan live buat "${name}" semenjak bot ini jalan.`, found: null };

  return { text: formatLiveCountText(found), found };
}

// Versi teks polos (dipakai tes dan pemanggil yang cuma butuh kalimatnya).
function replyLiveCount(fragment) {
  return describeLiveCount(fragment).text;
}

// Baris tombol di jawaban jumlah live: "📋 Lihat rekap" (buka rekap member itu, lihat
// handleRecapNavButton action "memberrecap") + "Tutup" (hapus pesan).
function buildLiveCountRow(username) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`recap_nav:memberrecap:${username}`).setLabel("📋 Lihat rekap").setStyle(ButtonStyle.Primary),
    buildReplyCloseButton(),
  );
}

// Jawaban "cok berapa kali <nama> live" / "/berapa-kali": kalimat jumlah live + tombol
// Lihat rekap/Tutup. Kalau member gak ketemu (atau nama kosong) tetap string biasa - pemanggil
// yang membungkusnya dengan tombol Tutup.
function replyLiveCountWithRecap(fragment) {
  const { text, found } = describeLiveCount(fragment);
  return found ? { content: text, components: [buildLiveCountRow(found.username)] } : text;
}

// Dipakai tombol "Kembali ke jumlah live" - balik ke jawaban yang sama dari username (null kalau datanya sudah tidak ada).
function buildLiveCountBlockForUsername(username) {
  const entry = loadLiveCount()[username];
  if (!entry) return null;
  return { content: formatLiveCountText({ username, ...entry }), components: [buildLiveCountRow(username)] };
}

module.exports = {
  replyLiveCount,
  replyLiveCountWithRecap,
  buildLiveCountBlockForUsername,
};
