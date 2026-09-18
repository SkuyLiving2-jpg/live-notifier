// Titik masuk bot - logic sebenernya sekarang ada di src/ (lihat
// ARCHITECTURE.md buat peta lengkap modulnya). File ini sengaja dibiarin
// tetap di js/new.js (bukan dipindah) biar package.json's "main"/"scripts.start"
// dan deployment Railway gak perlu diubah sama sekali.
require("../src/app").start();
