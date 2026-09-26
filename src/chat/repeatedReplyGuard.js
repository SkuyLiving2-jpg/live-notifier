// Owner ngeluh: ngetik keyword yang SAMA berkali-kali (mis. "bandingin" 5x
// nyoba-nyoba mulai chat/compareFlow.js) bikin channel penuh kata yang sama -
// PESAN KETIKAN USER-nya sendiri numpuk, plus tiap ketikan dijawab PESAN BOT
// BARU (message.reply() di chat/router.js selalu bikin pesan baru, beda dari
// tombol/dropdown yang nge-EDIT pesan yang sama di tempat).
//
// Aturannya (generik buat command APAPUN, bukan cuma "bandingin"):
// - "Ketikan yang sama" = teks PERSIS SAMA (lowercase+trim, sama kayak `text`
//   yang dipake buildChatReply) dari orang yang sama di channel yang sama,
//   berurutan (ketikan berbeda di antaranya = mulai hitungan baru), dan
//   masih dalam REPEAT_WINDOW_MS (ngetik ulang besok gak boleh nghapus pesan
//   kemarin).
// - Ketikan ke-1 dan ke-2 dibiarin (wajar ngulang sekali). Begitu diketik
//   LEBIH DARI REPEAT_KEEP_LIMIT kali (ke-3 dst), SEMUA ketikan + balesan bot
//   sebelumnya dalam rangkaian itu dihapus - cuma yang paling baru yang nyisa.
// - Yang dihapus: pesan ketikan user (BUTUH permission "Manage Messages" buat
//   bot di channel itu - tanpa itu Discord nolak, dan itu dicatet jelas di log
//   satu kali) DAN balesan bot-nya sendiri (selalu boleh).
//
// Cuma dipanggil kalau bot BENERAN ngebales pesan itu (router.js) - pesan yang
// gak ditujukan ke bot (gak ada "cok"/di luar channel bot) gak pernah disentuh.
const REPEAT_KEEP_LIMIT = 2;
const REPEAT_WINDOW_MS = 10 * 60_000;

// "channelId:authorId" -> { text, count, messageIds, lastAt }
const streaks = new Map();
let warnedMissingPermission = false;

function keyFor(channelId, authorId) {
  return `${channelId}:${authorId}`;
}

// Murni state (gak ada I/O, gak ada await) - dipisah dari penghapusan biar
// (1) gampang dites deterministik lewat `now` yang dioper, dan (2) update
// state-nya SINKRON: kalau user ngetik cepet-cepet beberapa kali, beberapa
// handler jalan bareng, dan state gak boleh keburu berubah di antara
// baca-tulisnya. Balikin daftar ID pesan yang harus dihapus.
function registerExchange({ channelId, authorId, text, userMessageId, botReplyId, now = Date.now() }) {
  const key = keyFor(channelId, authorId);
  const previous = streaks.get(key);
  const continuing = previous && previous.text === text && now - previous.lastAt <= REPEAT_WINDOW_MS;
  const streak = continuing ? previous : { text, count: 0, messageIds: [], lastAt: now };

  streak.count += 1;
  streak.lastAt = now;

  let toDelete = [];
  if (streak.count > REPEAT_KEEP_LIMIT) {
    toDelete = streak.messageIds;
    streak.messageIds = [];
  }
  streak.messageIds.push(userMessageId, botReplyId);
  streaks.set(key, streak);
  return toDelete;
}

function reportDeleteFailure(error, messageId) {
  if (error?.code === 10008) return; // Unknown Message - udah kehapus duluan (manual/tombol Tutup), aman
  if (error?.code === 50013) {
    if (warnedMissingPermission) return;
    warnedMissingPermission = true;
    console.error(
      'Gagal hapus pesan ketikan berulang: bot BELUM punya permission "Manage Messages" di channel ini (butuh itu buat hapus pesan orang lain, balesan bot sendiri tetap kehapus). Kasih permission itu ke role bot kalau mau ketikan berulang ikut dihapus.',
    );
    return;
  }
  console.error(`Gagal hapus pesan ketikan berulang ${messageId}:`, error?.code, error?.message);
}

// Dipanggil SETELAH balesan bot berhasil kekirim - `message` = pesan
// ketikan user, `sentReply` = balesan bot buat pesan itu.
async function pruneRepeatedExchange(message, normalizedText, sentReply, now = Date.now()) {
  const toDelete = registerExchange({
    channelId: message.channel.id,
    authorId: message.author.id,
    text: normalizedText,
    userMessageId: message.id,
    botReplyId: sentReply.id,
    now,
  });
  await Promise.all(toDelete.map((id) => message.channel.messages.delete(id).catch((error) => reportDeleteFailure(error, id))));
}

module.exports = { registerExchange, pruneRepeatedExchange, REPEAT_KEEP_LIMIT, REPEAT_WINDOW_MS };
