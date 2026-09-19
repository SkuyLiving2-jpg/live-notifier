const http = require("http");
const { requireSignedRequest } = require("./security");
const { API_SECRET, PORT } = require("./config");
const { activeLives } = require("./storage/activeLives");
const { loadGifterSnapshot, saveGifterSnapshot } = require("./storage/gifterSnapshot");

// Endpoint contoh yang dilindungi signature - nunjukkin data internal bot
// yang lebih detail dibanding health-check publik. Pola ini yang dipake
// kalau nanti nambah endpoint lain yang nyajiin data beneran.
function handleProtectedStatus(req, res) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      status: "ok",
      uptimeSeconds: Math.floor(process.uptime()),
      activeLivesCount: activeLives.size,
      activeLives: [...activeLives.values()].map((entry) => ({
        name: entry.name,
        username: entry.username,
        liveAt: entry.liveAt,
      })),
    }),
  );
}

// Nerima snapshot top-gifter yang di-push dari scripts/cek-top-gifter.js
// (jalan di komputer lokal siapapun yang megang akun IDN-nya). Body-nya
// CUMA hasil (username, name, gifters) - nggak ada kredensial IDN sama
// sekali yang lewat sini, jadi aman walau endpoint-nya "publik" (tetep
// dilindungi signature, tapi isinya emang bukan rahasia).
function handleGifterSnapshotUpload(req, res, body) {
  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Method not allowed, pakai POST" }));
    return;
  }

  let payload;
  try {
    payload = JSON.parse(body);
  } catch (error) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Body bukan JSON valid" }));
    return;
  }

  const { username, name, gifters } = payload || {};
  if (typeof username !== "string" || !username || typeof name !== "string" || !name || !Array.isArray(gifters)) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Body harus punya username (string), name (string), dan gifters (array)" }));
    return;
  }

  const snapshot = loadGifterSnapshot();
  snapshot.members[username] = { name, gifters, checkedAt: new Date().toISOString() };
  saveGifterSnapshot(snapshot);

  console.log(`Snapshot gifter ke-update buat ${name} (${gifters.length} gifter)`);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, username, gifterCount: gifters.length }));
}

// Railway (dan platform hosting sejenis) ngecek apakah service "sehat" dengan
// nunggu ada port yang kebuka. Bot ini murni background process tanpa server
// HTTP, jadi tanpa ini Railway bisa nganggep container-nya nggak sehat dan
// restart terus-menerus. Server kecil ini cuma buat "ngasih tanda hidup".
//
// /api/status & /api/gifter-snapshot sengaja dipisah dan dilindungi
// signature - health-check di "/" TETAP publik tanpa signature, karena
// Railway & UptimeRobot manggil itu tanpa tahu cara nge-sign request.
function startServer() {
  return http
    .createServer((req, res) => {
      if (req.url === "/api/status") {
        if (!API_SECRET) {
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "API_SECRET belum diset di server" }));
          return;
        }
        requireSignedRequest(API_SECRET, handleProtectedStatus)(req, res);
        return;
      }

      if (req.url === "/api/gifter-snapshot") {
        if (!API_SECRET) {
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "API_SECRET belum diset di server" }));
          return;
        }
        requireSignedRequest(API_SECRET, handleGifterSnapshotUpload)(req, res);
        return;
      }

      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("JKT48 IDN Live notifier is running.\n");
    })
    .listen(PORT, () => {
      console.log(`Health check server listening on port ${PORT}`);
    });
}

module.exports = { startServer };
