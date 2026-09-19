const http = require("http");
const { requireSignedRequest } = require("./security");
const { API_SECRET, PORT } = require("./config");
const { activeLives } = require("./storage/activeLives");
const { loadGifterSnapshot, saveGifterSnapshot } = require("./storage/gifterSnapshot");
const { loadDurationHistory } = require("./storage/durationHistory");
const { loadDailyLog } = require("./storage/dailyLog");
const { loadCustomPriorityMembers } = require("./storage/priorityStore");
const { loadSubscriptions } = require("./storage/subscriptions");

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
  } catch {
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

// Read-only - narik SEMUA data yang lagi kesimpen jadi satu file JSON,
// buat scripts/backup-data.js narik backup manual ke komputer lokal (data
// Railway cuma ada di Volume-nya, gak ada cadangan lain kalau itu ilang).
// Gabungan langsung dari load() tiap storage module - gak ada logic baru,
// murni agregasi apa yang udah ada.
function handleBackupExport(req, res) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      exportedAt: new Date().toISOString(),
      activeLives: Object.fromEntries(activeLives),
      durationHistory: loadDurationHistory(),
      dailyLog: loadDailyLog(),
      customPriority: loadCustomPriorityMembers(),
      subscriptions: loadSubscriptions(),
      gifterSnapshot: loadGifterSnapshot(),
    }),
  );
}

// Dipake tiap endpoint /api/* yang butuh signature - dedup dari 3 blok
// "kalau API_SECRET belum diset, 503" + requireSignedRequest yang sebelumnya
// (sebelum backup ditambah) udah diulang 2x identik.
function signedEndpoint(handler) {
  return (req, res) => {
    if (!API_SECRET) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "API_SECRET belum diset di server" }));
      return;
    }
    requireSignedRequest(API_SECRET, handler)(req, res);
  };
}

// Railway (dan platform hosting sejenis) ngecek apakah service "sehat" dengan
// nunggu ada port yang kebuka. Bot ini murni background process tanpa server
// HTTP, jadi tanpa ini Railway bisa nganggep container-nya nggak sehat dan
// restart terus-menerus. Server kecil ini cuma buat "ngasih tanda hidup".
//
// /api/* sengaja dipisah dan dilindungi signature - health-check di "/"
// TETAP publik tanpa signature, karena Railway & UptimeRobot manggil itu
// tanpa tahu cara nge-sign request.
function startServer() {
  return http
    .createServer((req, res) => {
      if (req.url === "/api/status") {
        signedEndpoint(handleProtectedStatus)(req, res);
        return;
      }

      if (req.url === "/api/gifter-snapshot") {
        signedEndpoint(handleGifterSnapshotUpload)(req, res);
        return;
      }

      if (req.url === "/api/backup") {
        signedEndpoint(handleBackupExport)(req, res);
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
