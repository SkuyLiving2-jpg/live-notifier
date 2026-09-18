// Titik masuk tunggal buat nyalain bot - satu-satunya file yang beneran
// dieksekusi langsung lewat "node src/index.js" (npm start). Sengaja cuma
// mindah tugas ke app.js's start() instead of nulis logic apapun di sini,
// biar app.js tetap bisa di-require sendiri (mis. dari test) tanpa ikut
// nyalain bot-nya.
require("./app").start();
