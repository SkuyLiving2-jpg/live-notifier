const fs = require("fs");
const path = require("path");

// Factory generik buat file JSON yang di-cache di memori (biar nggak baca
// file yang sama berkali-kali dari disk) dengan fallback ke `defaultValue`
// kalau file belum ada/rusak, dan auto-mkdir pas nulis. Dedup dari pola
// load/save yang sebelumnya diulang manual di ~6 tempat berbeda (riwayat
// durasi, log harian, prioritas custom, subscription, snapshot gifter).
//
// Aman di-cache (bukan cuma sekadar optimisasi disk-read) karena tiap
// pemanggil SELALU pasang pola load() -> mutasi -> save() berpasangan -
// gak ada tempat yang mutasi hasil load() tanpa manggil save() setelahnya -
// jadi hasil load() berikutnya (dari cache) selalu konsisten sama isi file
// yang beneran ke-tulis terakhir.
function createJsonStore(filePath, defaultValue, { errorLabel } = {}) {
  const dir = path.dirname(filePath);
  let cache;
  let hasCache = false;

  function load() {
    if (!hasCache) {
      try {
        cache = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      } catch (error) {
        cache = typeof defaultValue === "function" ? defaultValue() : defaultValue;
      }
      hasCache = true;
    }
    return cache;
  }

  function save(value) {
    cache = value;
    hasCache = true;
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
    } catch (error) {
      console.error(`Gagal nyimpen ${errorLabel || path.basename(filePath)}:`, error.message);
    }
  }

  return { load, save };
}

module.exports = { createJsonStore };
