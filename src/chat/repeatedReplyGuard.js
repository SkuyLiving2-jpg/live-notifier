// Owner ngeluh: nyoba mulai flow "cok bandingin" (chat/compareFlow.js) beberapa
// kali sebelum bener-bener milih membernya - tiap ketikan "bandingin" bikin
// PESAN BOT BARU (message.reply() di chat/router.js selalu bikin pesan baru,
// beda dari tombol/dropdown yang nge-EDIT pesan yang sama di tempat), jadi
// ngetik "bandingin" 5x ninggalin 5 pesan bot yang identik numpuk di channel -
// bukan cuma soal "bandingin" doang, command APAPUN yang diketik ULANG PERSIS
// SAMA bakal punya masalah yang sama.
//
// Solusinya di sini generik (bukan spesifik compareFlow): sebelum ngirim
// balesan buat sebuah pesan, cek apa TEKS pesan itu (udah dinormalisasi -
// lowercase+trim, SAMA persis kayak `text` yang dipake buildChatReply buat
// matching) SAMA PERSIS kayak teks yang men-trigger balesan bot SEBELUMNYA
// dari orang yang sama di channel yang sama - kalau iya, balesan LAMA itu
// dihapus dulu sebelum yang baru dikirim, jadi ngetik ulang keyword yang sama
// berkali-kali cuma nyisain SATU balesan bot (yang paling baru), bukan numpuk.
// Kunci penyimpanannya "channelId:authorId" (sama polanya kayak
// pendingState.js) - orang lain yang ngetik command yang SAMA di waktu yang
// SAMA gak saling ke-hapus balesannya.
const lastReplyByAuthor = new Map();

function keyFor(channelId, authorId) {
  return `${channelId}:${authorId}`;
}

// Dipanggil SEBELUM message.reply() - kalau `normalizedText` sama kayak teks
// yang men-trigger balesan bot yang lagi dilacak buat orang+channel ini,
// balesan LAMA itu dihapus (best-effort - wajar gagal kalau udah dihapus
// manual/lewat tombol Tutup duluan, gak boleh bikin balesan yang BARU ikut
// gagal cuma gara-gara ini).
async function deletePreviousReplyIfRepeated(message, normalizedText) {
  const key = keyFor(message.channel.id, message.author.id);
  const previous = lastReplyByAuthor.get(key);
  if (previous && previous.text === normalizedText) {
    await message.channel.messages.delete(previous.messageId).catch(() => {});
  }
}

// Dipanggil abis message.reply() BERHASIL ngirim - nyimpen balesan yang baru
// ini sebagai "yang lagi dilacak" buat channel+author ini, nimpa yang lama
// (apapun teksnya - command BEDA yang diketik abis ini otomatis "reset" trek
// ini, cuma diulang PERSIS SAMA yang bakal kena hapus di panggilan berikutnya).
function rememberReply(message, normalizedText, sentMessage) {
  const key = keyFor(message.channel.id, message.author.id);
  lastReplyByAuthor.set(key, { text: normalizedText, messageId: sentMessage.id });
}

module.exports = { deletePreviousReplyIfRepeated, rememberReply };
