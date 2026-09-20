const http = require("http");
const { requireSignedRequest } = require("./security");
const { API_SECRET, PORT, MAX_PLAUSIBLE_LIVE_DURATION_MS } = require("./config");
const { activeLives } = require("./storage/activeLives");
const { loadGifterSnapshot, saveGifterSnapshot } = require("./storage/gifterSnapshot");
const { loadDurationHistory, saveDurationHistory, recordLiveDurationAt } = require("./storage/durationHistory");
const { loadDailyLog, saveDailyLog, recordLiveEnded, getEarliestSessionDate } = require("./storage/dailyLog");
const { loadCustomPriorityMembers } = require("./storage/priorityStore");
const { loadSubscriptions } = require("./storage/subscriptions");
const { rebuildLiveCountFromSessions } = require("./storage/liveCount");

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

// Nerima riwayat live yang direkonstruksi dari histori pesan notif Discord
// (lihat scripts/backfill-live-history.js) - satu-satunya cara ngisi
// SEBELUM daily-log.json jadi arsip beneran (16c4b7c, 2026-09-19), soalnya
// kode sendiri nggak pernah nyimpen data selengkap itu (lihat ARCHITECTURE.md
// §10's bug-history keempat). Kode ini gak bisa "nebak" data yang emang gak
// pernah kecatet - satu-satunya sumber yang lebih lengkap dari kode kita
// sendiri adalah histori pesan Discord-nya sendiri (kalau belum dihapus).
//
// Cuma nerima sesi yang SELESAI-nya sebelum sesi PALING TUA yang UDAH ADA
// sekarang - biar gak dobel sama yang udah beneran ke-track live oleh bot
// sendiri (lihat getEarliestSessionDate). Ini juga bikin endpoint-nya aman
// dipanggil ulang (idempotent): abis backfill pertama sukses, earliest date
// arsip jadi mundur ke histori yang baru ditambahin, jadi panggilan kedua
// otomatis nolak nyisipin ulang sesi yang sama.
function handleBackfillLiveHistory(req, res, body) {
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

  const sessions = Array.isArray(payload?.sessions) ? payload.sessions : null;
  if (!sessions) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Body harus punya sessions (array)" }));
    return;
  }

  // s.endedAtUnix - s.startedAtUnix dibatasin ke MAX_PLAUSIBLE_LIVE_DURATION_MS
  // - jaring pengaman KEDUA (script pengirimnya sendiri, scripts/backfill-live-history.js,
  // udah nyaring ini duluan di reconstructSessions) buat kasus sesi durasi
  // ratusan jam yang ternyata masih bisa lolos ke sini (mis. dari script versi
  // lama sebelum fix-nya, atau sumber lain di masa depan) - lihat ARCHITECTURE.md
  // §10 buat cerita lengkap bug fatalnya (FIFO pairing start/end yang salah).
  const validSessions = sessions.filter(
    (s) =>
      s &&
      typeof s.name === "string" &&
      s.name &&
      typeof s.username === "string" &&
      s.username &&
      typeof s.startedAtUnix === "number" &&
      typeof s.endedAtUnix === "number" &&
      s.endedAtUnix > s.startedAtUnix &&
      (s.endedAtUnix - s.startedAtUnix) * 1000 <= MAX_PLAUSIBLE_LIVE_DURATION_MS,
  );

  const cutoffDateWIB = getEarliestSessionDate();
  const cutoffUnix = cutoffDateWIB ? Math.floor(new Date(`${cutoffDateWIB}T00:00:00+07:00`).getTime() / 1000) : Infinity;
  const accepted = validSessions.filter((s) => s.endedAtUnix < cutoffUnix);

  const dryRun = Boolean(payload.dryRun);
  let durationHistoryBackfilled = 0;
  if (!dryRun) {
    for (const s of accepted) {
      recordLiveEnded(s.name, s.username, new Date(s.startedAtUnix * 1000), new Date(s.endedAtUnix * 1000), null);
    }

    // live-duration-history.json (dipake "cok stats"/"cok kapan ... live")
    // SENGAJA dicek idempotent-nya independen dari cutoff daily-log di atas
    // (dedup per-entry lewat `at` yang UDAH ADA, bukan ikut cutoff yang
    // sama) - soalnya kalau endpoint ini sendiri dapet bugfix belakangan
    // (persis yang kejadian: versi pertama endpoint ini lupa nulis ke sini
    // sama sekali), re-run abis fix-nya HARUS tetap bisa ngisi celah yang
    // ketinggalan itu, walau daily-log-nya sendiri udah gak nerima sesi yang
    // sama lagi (cutoff-nya udah kelewat). recordLiveDurationAt (bukan
    // recordLiveDuration biasa) soalnya butuh `at` HISTORIS, bukan "sekarang"
    // - kalau enggak, pola jam/hari yang dihitung replySchedulePattern jadi ngaco.
    const seenAtByUsername = new Map(
      Object.entries(loadDurationHistory()).map(([username, entries]) => [username, new Set(entries.map((e) => e.at))]),
    );
    for (const s of validSessions) {
      const atIso = new Date(s.endedAtUnix * 1000).toISOString();
      const seen = seenAtByUsername.get(s.username) || new Set();
      if (seen.has(atIso)) continue;
      recordLiveDurationAt(s.username, s.name, (s.endedAtUnix - s.startedAtUnix) * 1000, new Date(s.endedAtUnix * 1000));
      seen.add(atIso);
      seenAtByUsername.set(s.username, seen);
      durationHistoryBackfilled++;
    }

    // Direbuild dari SELURUH sesi valid yang dikirim (bukan cuma yang
    // accepted ke daily-log) - histori pesan Discord nyakup seluruh linimasa
    // bot jalan, jadi ini otoritatif buat total ALL-TIME, gak cuma buat
    // ngisi celah sebelum daily-log ada.
    rebuildLiveCountFromSessions(validSessions);
  }

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      dryRun,
      totalReceived: sessions.length,
      totalValid: validSessions.length,
      cutoffDateWIB,
      acceptedIntoDailyLog: accepted.length,
      skippedAlreadyCovered: validSessions.length - accepted.length,
      durationHistoryBackfilled,
    }),
  );
}

// Nerima-nya sengaja gak validasi durasi (§ handleBackfillLiveHistory di atas
// yang sekarang udah nyaring itu duluan) TAPI data yang KADUNG kesimpen dari
// SEBELUM validasi itu ada masih korup di Volume Railway - endpoint ini buat
// beresin data yang UDAH TERLANJUR nyangkut, bukan nyaring data baru.
// Dipanggil sekali lewat scripts/repair-live-history.js abis fix-nya deploy.
//
// Beresin 3 tempat: (1) daily-log.json - buang sesi durasinya implausible,
// (2) live-duration-history.json - buang entry implausible per username,
// (3) live-count.json - di-REBUILD ULANG dari daily-log.json yang UDAH
// dibersihin di langkah (1) (bukan dari data lama yang mungkin masih ngitung
// sesi korup yang udah dibuang) - retention daily-log 35 hari lebih dari
// cukup nyakup seluruh histori bot ini sejauh ini, jadi aman dipake sebagai
// sumber REBUILD total, bukan cuma partial.
function handleRepairLiveHistory(req, res, body) {
  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Method not allowed, pakai POST" }));
    return;
  }

  let payload;
  try {
    payload = body ? JSON.parse(body) : {};
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Body bukan JSON valid" }));
    return;
  }
  const dryRun = Boolean(payload?.dryRun);

  const isImplausible = (durationMs) => !(durationMs > 0) || durationMs > MAX_PLAUSIBLE_LIVE_DURATION_MS;

  const log = loadDailyLog();
  const cleanedSessions = log.sessions.filter((s) => !isImplausible((s.endedAtUnix - s.startedAtUnix) * 1000));
  const dailyLogRemoved = log.sessions.length - cleanedSessions.length;

  const durationHistory = loadDurationHistory();
  let durationHistoryRemoved = 0;
  for (const username of Object.keys(durationHistory)) {
    durationHistoryRemoved += durationHistory[username].filter((e) => isImplausible(e.durationMs)).length;
  }

  if (!dryRun) {
    log.sessions = cleanedSessions;
    saveDailyLog(log);

    for (const username of Object.keys(durationHistory)) {
      const cleaned = durationHistory[username].filter((e) => !isImplausible(e.durationMs));
      if (cleaned.length === 0) delete durationHistory[username];
      else durationHistory[username] = cleaned;
    }
    saveDurationHistory(durationHistory);

    rebuildLiveCountFromSessions(cleanedSessions);

    console.log(
      `Repair live-history: ${dailyLogRemoved} sesi dibuang dari daily-log, ${durationHistoryRemoved} entry dibuang dari duration-history, live-count direbuild dari ${cleanedSessions.length} sesi.`,
    );
  }

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      dryRun,
      dailyLogSessionsRemaining: cleanedSessions.length,
      dailyLogRemoved,
      durationHistoryRemoved,
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

      if (req.url === "/api/backfill-live-history") {
        signedEndpoint(handleBackfillLiveHistory)(req, res);
        return;
      }

      if (req.url === "/api/repair-live-history") {
        signedEndpoint(handleRepairLiveHistory)(req, res);
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
