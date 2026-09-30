// State kesehatan polling IDN (diisi monitor.js tiap siklus) - modul kecil
// tersendiri biar "cok status" (chat/replies.js) dan /api/status (server.js)
// bisa baca tanpa require monitor.js (yang narik seluruh rantai notif/storage).
const pollHealth = { failures: 0, alerted: false, lastSuccessAt: null };

module.exports = { pollHealth };
