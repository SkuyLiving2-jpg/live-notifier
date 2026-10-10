const path = require("path");

// src/chat/replies/ dipecah jadi banyak modul yang masing-masing menyimpan referensi ke storage (dailyLog, dst.)
// saat di-require. Test yang butuh storage "segar" harus membuang cache SEMUA modul replies, bukan cuma index.js -
// kalau tidak, modul-modul di dalamnya masih memegang referensi storage yang lama.
const REPLIES_DIR = path.dirname(require.resolve("../../src/chat/replies"));

function clearRepliesCache() {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(REPLIES_DIR + path.sep)) delete require.cache[key];
  }
}

module.exports = { clearRepliesCache };
