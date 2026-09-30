const fs = require("fs");
const path = require("path");

// Tulis lewat file sementara lalu di-rename - kalau proses mati/kena SIGKILL di
// TENGAH nulis (redeploy Railway, crash), file aslinya tetep utuh. Nulis
// langsung ke file tujuan bisa ninggalin JSON setengah jadi; abis itu load()
// nganggep file-nya "rusak", balik ke nilai default, dan tulis berikutnya
// nimpa datanya selamanya.
function writeFileAtomic(filePath, content) {
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, content);
  fs.renameSync(tempPath, filePath);
}

// File ada tapi isinya bukan JSON valid: salinannya disimpen (*.corrupt-<waktu>)
// sebelum kita fallback ke nilai default dan (nantinya) nimpa file aslinya -
// biar datanya masih bisa diselamatin manual. File yang emang belum ada (ENOENT)
// itu normal (pertama kali jalan), bukan korupsi.
function preserveCorruptFile(filePath, error) {
  if (error?.code === "ENOENT") return;
  console.error(`File ${path.basename(filePath)} gak bisa dibaca (${error?.message}) - pakai nilai default, salinan file lama disimpen.`);
  try {
    fs.copyFileSync(filePath, `${filePath}.corrupt-${Date.now()}`);
  } catch {
    // salinan gagal dibuat - gak fatal
  }
}

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
        preserveCorruptFile(filePath, error);
        cache = typeof defaultValue === "function" ? defaultValue() : defaultValue;
      }
      hasCache = true;
    }
    return cache;
  }

  // `cache` CUMA di-update abis writeFileSync BENERAN sukses - sebelumnya
  // cache di-update DULUAN (optimistic), jadi kalau nulis ke disk gagal
  // (disk penuh, permission error, dll), proses yang lagi jalan tetep
  // "percaya" data barunya udah ke-simpen (load() berikutnya balikin value
  // yang GAGAL ditulis itu), padahal file di disk masih isi yang LAMA -
  // silently out-of-sync sampai proses ini restart dan kehilangan data yang
  // dikira udah aman tersimpan.
  function save(value) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      writeFileAtomic(filePath, JSON.stringify(value, null, 2));
      cache = value;
      hasCache = true;
    } catch (error) {
      console.error(`Gagal nyimpen ${errorLabel || path.basename(filePath)}:`, error.message);
    }
  }

  return { load, save };
}

module.exports = { createJsonStore, writeFileAtomic, preserveCorruptFile };
