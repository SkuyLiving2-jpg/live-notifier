// State kesehatan polling IDN (diisi monitor.js tiap siklus) - modul kecil
// tersendiri biar "cok status" (chat/replies/) dan /api/status + /healthz (server.js)
// bisa baca tanpa require monitor.js (yang narik seluruh rantai notif/storage).
const pollHealth = { failures: 0, alerted: false, lastSuccessAt: null };

// Polling dianggap MACET kalau sudah segini lama tanpa satu pun siklus yang berhasil. Sama dengan ambang DM
// peringatan ke owner (POLL_FAILURE_ALERT_MINUTES di monitor.js), jadi uptime monitor dan DM sepakat soal "macet".
// Mencakup dua kasus: IDN down terus-menerus, DAN loop polling yang diam-diam berhenti/nyangkut (kasus kedua
// tidak menghitung kegagalan sama sekali, jadi hanya terdeteksi lewat umur sukses terakhir).
const POLL_STALE_AFTER_MS = 5 * 60 * 1000;

// Murni (semua masukan dioper) biar gampang dites. `uptimeMs` dipakai untuk masa tenggang saat baru menyala:
// sebelum siklus pertama sempat sukses, bot belum dianggap rusak - kalau tidak, tiap deploy baru langsung merah.
function evaluatePollHealth({ now = Date.now(), uptimeMs = process.uptime() * 1000, state = pollHealth, staleAfterMs = POLL_STALE_AFTER_MS } = {}) {
  if (!state.lastSuccessAt) {
    return uptimeMs < staleAfterMs
      ? { healthy: true, status: "starting", lastSuccessAgeMs: null }
      : { healthy: false, status: "never_succeeded", lastSuccessAgeMs: null };
  }
  const lastSuccessAgeMs = Math.max(0, now - state.lastSuccessAt);
  return lastSuccessAgeMs <= staleAfterMs ? { healthy: true, status: "ok", lastSuccessAgeMs } : { healthy: false, status: "stale", lastSuccessAgeMs };
}

module.exports = { pollHealth, evaluatePollHealth, POLL_STALE_AFTER_MS };
