// Berapa lama sesi live yang sudah selesai disimpan di arsip rekap (storage/dailyLog.js) sebelum dipangkas.
// Modul daun tanpa dependensi (tidak memuat config.js) SENGAJA: teks bantuan dan definisi slash command
// butuh angka ini, dan scripts/register-slash-commands.js tidak boleh jadi ikut menuntut env bot lengkap.
//
// 65 hari, bukan 35: "rekap bulan lalu" harus SELALU lengkap. Bulan lalu paling panjang 31 hari, ditambah
// sisa bulan berjalan sampai 31 hari lagi = 62 hari. Dengan 35 hari, setelah tanggal ~5 bulan berikutnya,
// rekap bulan lalu diam-diam terpotong (tetap berjudul "Rekap bulan ...", totalnya lebih kecil dari kenyataan).
// Ukuran data kecil (±3,5 KB/hari, sekitar 230 KB di 65 hari), jadi biayanya hampir nol.
const SESSION_RETENTION_DAYS = 65;

module.exports = { SESSION_RETENTION_DAYS };
