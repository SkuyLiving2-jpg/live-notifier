const http = require("http");
const { requireSignedRequest } = require("./security");
const { API_SECRET, PORT, MAX_PLAUSIBLE_LIVE_DURATION_MS } = require("./config");
const { activeLives } = require("./storage/activeLives");
const { loadGifterSnapshot, saveGifterSnapshot } = require("./storage/gifterSnapshot");
const { loadDurationHistory, saveDurationHistory, recordLiveDurationAt } = require("./storage/durationHistory");
const { loadDailyLog, saveDailyLog, recordLiveEnded } = require("./storage/dailyLog");
const { loadCustomPriorityMembers } = require("./storage/priorityStore");
const { loadSubscriptions } = require("./storage/subscriptions");
const { rebuildLiveCountFromSessions } = require("./storage/liveCount");
const { loadChannelRouting, saveChannelRouting } = require("./storage/channelRouting");

// Format webhook Discord yang valid - dipake buat nolak entry yang jelas
// bukan webhook URL SEDINI mungkin (pas di-push), bukan nyoba kirim ke situ
// dulu baru ketauan gagal tiap kali ada notif. Persis pola yang dipake
// scripts/backfill-live-history.js's extractWebhookIds buat narik id+token.
// Domain-nya terima "discord.com" (yang sekarang) ATAU "discordapp.com"
// (domain lama - masih beneran jalan buat webhook, banyak URL lama/tutorial
// masih makai ini) - ketauan pas owner nyoba push webhook URL yang dia
// copy dan ternyata masih pake discordapp.com, ke-tolak duluan padahal
// URL-nya beneran valid & bisa dipake.
const DISCORD_WEBHOOK_URL_RE = /^https:\/\/discord(app)?\.com\/api\/webhooks\/\d+\/[^/?]+$/;

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

// Nerima pemetaan username -> webhook URL channel KHUSUS per-member yang
// di-push dari scripts/set-channel-routing.js (jalan di komputer lokal
// owner). SELALU full REPLACE (bukan merge) - file lokal yang di-push
// dianggep daftar LENGKAP yang paling baru, bukan tambahan parsial (lihat
// storage/channelRouting.js's saveChannelRouting). Tiap value divalidasi
// bentuknya webhook URL Discord SEDINI mungkin di sini - kalau nggak, entry
// yang typo/salah tempel bakal diam-diam gagal terus tiap kali ada notif
// buat member itu, baru ketauan pas ngecek log jauh belakangan.
function handleChannelRoutingUpload(req, res, body) {
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

  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Body harus berupa object { username: webhookUrl, ... }" }));
    return;
  }

  const invalidEntries = Object.entries(payload).filter(([, url]) => typeof url !== "string" || !DISCORD_WEBHOOK_URL_RE.test(url));
  if (invalidEntries.length > 0) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: "Ada value yang bukan webhook URL Discord yang valid",
        invalidUsernames: invalidEntries.map(([username]) => username),
      }),
    );
    return;
  }

  saveChannelRouting(payload);

  const count = Object.keys(payload).length;
  console.log(`Pemetaan channel per-member ke-update (${count} member)`);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, count }));
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
      channelRouting: loadChannelRouting(),
    }),
  );
}

// Toleransi buat nganggep sesi backfill "udah ada" di daily-log - beda
// beberapa detik antara timestamp live-tracker (Date.now() pas poll loop
// NGEDETEKSI live-nya selesai) sama timestamp pesan Discord (createdTimestamp,
// beberapa saat setelahnya) itu wajar, BUKAN sesi yang beda. 2 menit jauh
// lebih longgar dari itu tapi masih jauh lebih pendek dibanding jarak antar
// 2 sesi live BEDA dari member yang sama (biasanya berjam-jam/berhari-hari).
const SESSION_DEDUP_TOLERANCE_SEC = 120;

function isAlreadyInDailyLog(endedAtByUsername, session) {
  const existing = endedAtByUsername.get(session.username);
  if (!existing) return false;
  return existing.some((endedAtUnix) => Math.abs(endedAtUnix - session.endedAtUnix) <= SESSION_DEDUP_TOLERANCE_SEC);
}

// Nerima riwayat live yang direkonstruksi dari histori pesan notif Discord
// (lihat scripts/backfill-live-history.js) - satu-satunya cara ngisi
// SEBELUM daily-log.json jadi arsip beneran (16c4b7c, 2026-09-19), soalnya
// kode sendiri nggak pernah nyimpen data selengkap itu (lihat ARCHITECTURE.md
// §10's bug-history keempat). Kode ini gak bisa "nebak" data yang emang gak
// pernah kecatet - satu-satunya sumber yang lebih lengkap dari kode kita
// sendiri adalah histori pesan Discord-nya sendiri (kalau belum dihapus).
//
// Idempotency-nya DEDUP PER SESI (username + endedAtUnix, lihat
// isAlreadyInDailyLog), BUKAN cutoff tanggal kayak versi sebelumnya. Versi
// cutoff kelihatan aman di awal (nolak apa pun yang selesainya SETELAH sesi
// paling tua yang udah ada, biar gak dobel sama yang beneran ke-track live
// sama bot sendiri), tapi rusak begitu backfill perlu dijalanin LEBIH DARI
// SEKALI buat periode yang SAMA - persis yang kejadian ke owner: parser embed
// prioritasnya sendiri dibenerin 2x (§10's bug ketujuh & kesepuluh), dan
// tiap kali abis dibenerin, "sesi paling tua yang udah ada" itu UDAH KADUNG
// mundur ke sesi yang berhasil ke-backfill di run SEBELUMNYA - jadi cutoff-nya
// OTOMATIS nolak sesi TAMBAHAN dari periode yang SAMA walau sesi itu beneran
// belum pernah kesimpen (persis "kapan Nala/Lily/Levi live sebelum 19
// September" yang gak pernah nongol di "cok rekap", padahal count-priority-notifs.js
// udah nemuin notifnya). Dedup per sesi gak punya masalah ini - setiap sesi
// dicek sendiri-sendiri terlepas dari tanggalnya, jadi aman dipanggil ULANG
// berkali-kali seiring parsernya dibenerin bertahap.
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

  const endedAtByUsername = new Map();
  for (const s of loadDailyLog().sessions) {
    const list = endedAtByUsername.get(s.username) || [];
    list.push(s.endedAtUnix);
    endedAtByUsername.set(s.username, list);
  }
  const accepted = [];
  for (const s of validSessions) {
    if (isAlreadyInDailyLog(endedAtByUsername, s)) continue;
    accepted.push(s);
    // Ditambahin ke set yang sama SEKARANG (bukan cuma dari daily-log yang
    // udah ada) - biar 2 sesi identik yang KEBETULAN dobel dalam satu
    // payload yang SAMA (mis. tumpang-tindih channel/DM di sekitar momen
    // 0bd317e cutover) juga kesaring, bukan cuma dobel-cek terhadap data lama.
    const list = endedAtByUsername.get(s.username) || [];
    list.push(s.endedAtUnix);
    endedAtByUsername.set(s.username, list);
  }

  const dryRun = Boolean(payload.dryRun);
  let durationHistoryBackfilled = 0;
  if (!dryRun) {
    for (const s of accepted) {
      recordLiveEnded(s.name, s.username, new Date(s.startedAtUnix * 1000), new Date(s.endedAtUnix * 1000), null);
    }

    // live-duration-history.json (dipake "cok stats"/"cok kapan ... live") -
    // dedup-nya sendiri, per-entry lewat `at` yang UDAH ADA (mirip pola
    // daily-log di atas, tapi exact-match bukan toleransi - `at` selalu
    // sama persis kalau sesi yang sama direkonstruksi ulang, gak kayak
    // endedAtUnix daily-log yang bisa beda dikit sama timestamp live-tracker).
    // recordLiveDurationAt (bukan recordLiveDuration biasa) soalnya butuh
    // `at` HISTORIS, bukan "sekarang" - kalau enggak, pola jam/hari yang
    // dihitung replySchedulePattern jadi ngaco.
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

      if (req.url === "/api/channel-routing") {
        signedEndpoint(handleChannelRoutingUpload)(req, res);
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
