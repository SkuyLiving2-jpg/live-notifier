// Catatan "pengiriman sampingan ini sudah berhasil" untuk satu sesi live, disimpan di memori.
//
// Kenapa ada: notif channel gabungan (sendDiscordNotif -> postToWebhook) adalah satu-satunya penentu
// sukses; kalau gagal, monitor.js MENCOBA ULANG notif yang sama tiap siklus polling (jangan sampai
// notif hilang). Tapi pengiriman sampingan di fungsi yang sama (DM prioritas ke pemilik, DM
// subscriber, duplikat ke channel khusus member) ikut terulang di tiap percobaan ulang itu, jadi
// selama webhook gabungan bermasalah (mis. Discord 5xx, webhook dihapus) pemilik/subscriber
// menerima DM yang sama tiap ~20 detik. Dengan catatan ini tiap pengiriman sampingan cukup
// berhasil SEKALI per sesi; percobaan ulang tidak mengulanginya.
//
// Sengaja di memori (bukan file): kalau bot restart di tengah gangguan, paling buruk satu DM
// terkirim lagi - jauh lebih murah daripada menjaga file tambahan. Entri dibuang setelah TTL
// supaya Map tidak tumbuh terus.
const LEDGER_TTL_MS = 12 * 60 * 60 * 1000;

const delivered = new Map();

function prune(now) {
  for (const [key, at] of delivered) {
    if (now - at > LEDGER_TTL_MS) delivered.delete(key);
  }
}

// Kunci selalu diawali kunci sesi ("<username>:<slug>:<status>") supaya satu sesi bisa dibersihkan sekaligus.
function deliveryKey(sessionKey, kind, who = "") {
  return `${sessionKey}|${kind}|${who}`;
}

function wasDelivered(key, now = Date.now()) {
  prune(now);
  return delivered.has(key);
}

function markDelivered(key, now = Date.now()) {
  delivered.set(key, now);
}

// Dipanggil begitu notif channel gabungan BERHASIL: percobaan ulang sudah tidak ada, dan catatan yang
// tersisa tidak boleh menahan DM/duplikat untuk live berikutnya yang kebetulan memakai slug yang sama.
function forgetSession(sessionKey) {
  const prefix = `${sessionKey}|`;
  for (const key of delivered.keys()) {
    if (key.startsWith(prefix)) delivered.delete(key);
  }
}

function clearDeliveryLedger() {
  delivered.clear();
}

module.exports = { deliveryKey, wasDelivered, markDelivered, forgetSession, clearDeliveryLedger, LEDGER_TTL_MS };
