require("./helpers/setupTestEnv");
// PORT:0 -> OS milihin port bebas sendiri (hindarin bentrok sama apapun
// yang kebetulan lagi jalan di 3000 lokal). API_SECRET di-set eksplisit di
// sini (bukan ngandelin .env asli siapapun yang jalanin test ini) biar
// signature yang dites deterministik.
process.env.PORT = "0";
process.env.API_SECRET = "test-secret-buat-server-test";

const fs = require("fs");
const path = require("path");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { signPayload } = require("../src/security");
const { tempCacheDir } = require("./helpers/setupTestEnv");
const { startServer } = require("../src/server");

// Server ini di-listen di localhost port OS-assigned doang - gak ada
// koneksi keluar ke Discord/IDN/Railway sama sekali, jadi aman dijalanin
// beneran di test (beda dari monitor.js's pollLoop yang sengaja DIHINDARIN
// - lihat tests/monitor.test.js).
function startTestServer(startFn = startServer) {
  const server = startFn();
  return new Promise((resolve) => {
    server.on("listening", () => resolve(server));
  });
}

// server.js's handleBackfillLiveHistory nulis ke 3 storage module sekaligus
// (dailyLog/durationHistory/liveCount), dan ke-3-nya (+ server.js sendiri,
// yang capture reference fungsi mereka pas di-require) di-cache in-memory
// buat seumur hidup proses test ini (sama alasannya kayak
// tests/dailyLog.test.js/tests/replies.test.js's fresh-instance helper) -
// jadi test yang assert TOTAL EXACT (bukan cuma "apakah username ini ada")
// butuh server yang BENERAN fresh, gak numpang sisa data dari test lain di
// file yang sama (mis. cutoff getEarliestSessionDate() ke-geser gara-gara
// sesi yang dibackfill test SEBELUMNYA, walau username-nya beda).
const SERVER_MODULE_PATH = require.resolve("../src/server");
const BACKFILL_STORAGE_MODULE_PATHS = [
  require.resolve("../src/storage/dailyLog"),
  require.resolve("../src/storage/durationHistory"),
  require.resolve("../src/storage/liveCount"),
];
const BACKFILL_STORAGE_FILES = ["daily-log.json", "live-duration-history.json", "live-count.json"];

function freshStartServerForBackfillTest() {
  delete require.cache[SERVER_MODULE_PATH];
  BACKFILL_STORAGE_MODULE_PATHS.forEach((p) => delete require.cache[p]);
  BACKFILL_STORAGE_FILES.forEach((f) => {
    try {
      fs.unlinkSync(path.join(tempCacheDir, f));
    } catch {
      // wajar kalau belum pernah ada file-nya
    }
  });
  return require("../src/server").startServer;
}

function sign(body) {
  const timestamp = Date.now().toString();
  const signature = signPayload(process.env.API_SECRET, timestamp, body);
  return { timestamp, signature };
}

test("GET /api/backup - request tanpa signature ditolak (401)", async () => {
  const server = await startTestServer();
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/api/backup`);
    assert.equal(res.status, 401);
  } finally {
    server.close();
  }
});

test("GET /api/backup - request yang di-sign bener balikin agregasi semua storage module", async () => {
  const server = await startTestServer();
  try {
    const { port } = server.address();
    const { timestamp, signature } = sign("");

    const res = await fetch(`http://127.0.0.1:${port}/api/backup`, {
      headers: { "X-Api-Timestamp": timestamp, "X-Api-Signature": signature },
    });
    assert.equal(res.status, 200);

    const data = await res.json();
    assert.ok(data.exportedAt);
    assert.deepEqual(data.activeLives, {});
    assert.deepEqual(data.durationHistory, {});
    assert.deepEqual(data.dailyLog, { sessions: [], recapSentDate: null });
    assert.deepEqual(data.customPriority, []);
    assert.deepEqual(data.subscriptions, {});
    assert.deepEqual(data.gifterSnapshot, { members: {} });
  } finally {
    server.close();
  }
});

test("POST /api/backfill-live-history - dryRun:true gak nulis apa-apa, cuma preview", async () => {
  const server = await startTestServer();
  try {
    const { port } = server.address();
    const nowSec = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({
      dryRun: true,
      sessions: [
        { name: "Aralie", username: "jkt48_aralie", startedAtUnix: nowSec - 10 * 24 * 60 * 60, endedAtUnix: nowSec - 10 * 24 * 60 * 60 + 3600 },
      ],
    });
    const { timestamp, signature } = sign(body);

    const res = await fetch(`http://127.0.0.1:${port}/api/backfill-live-history`, {
      method: "POST",
      headers: { "X-Api-Timestamp": timestamp, "X-Api-Signature": signature, "Content-Type": "application/json" },
      body,
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.dryRun, true);
    assert.equal(data.totalValid, 1);
    assert.equal(data.acceptedIntoDailyLog, 1); // arsip masih kosong -> cutoff Infinity -> ke-accept

    // Beneran gak nulis - /api/backup masih harus nunjukkin arsip kosong.
    const { timestamp: t2, signature: s2 } = sign("");
    const backupRes = await fetch(`http://127.0.0.1:${port}/api/backup`, {
      headers: { "X-Api-Timestamp": t2, "X-Api-Signature": s2 },
    });
    const backup = await backupRes.json();
    assert.deepEqual(backup.dailyLog.sessions, []);
  } finally {
    server.close();
  }
});

test("POST /api/backfill-live-history - sesi invalid (kurang field/endedAt <= startedAt) difilter, gak dihitung 'valid'", async () => {
  const server = await startTestServer();
  try {
    const { port } = server.address();
    const nowSec = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({
      dryRun: true,
      sessions: [
        { name: "Valid", username: "jkt48_valid", startedAtUnix: nowSec - 3600, endedAtUnix: nowSec },
        { name: "Kebalik", username: "jkt48_kebalik", startedAtUnix: nowSec, endedAtUnix: nowSec - 3600 }, // endedAt < startedAt
        { name: "Tanpa username", startedAtUnix: nowSec - 3600, endedAtUnix: nowSec }, // gak ada username
      ],
    });
    const { timestamp, signature } = sign(body);

    const res = await fetch(`http://127.0.0.1:${port}/api/backfill-live-history`, {
      method: "POST",
      headers: { "X-Api-Timestamp": timestamp, "X-Api-Signature": signature, "Content-Type": "application/json" },
      body,
    });
    const data = await res.json();
    assert.equal(data.totalReceived, 3);
    assert.equal(data.totalValid, 1);
  } finally {
    server.close();
  }
});

// Bug fatal yang dilaporin user: rekap nunjukkin durasi ratusan jam (121j,
// 122j, dll) - root cause-nya reconstructSessions di scripts/backfill-live-history.js
// yang FIFO-pairing-nya salah pas ada "start" numpuk tanpa "end" (udah
// diperbaiki, lihat tests/backfillLiveHistory.test.js). Ini jaring pengaman
// KEDUA di sisi server - bahkan kalau kliennya somehow ngirim sesi durasi
// implausible (mis. dari script versi lama sebelum fix), server HARUS
// nolaknya sendiri, bukan percaya buta ke apa yang dikirim.
test("POST /api/backfill-live-history - sesi durasi implausible (>12 jam) ditolak juga di sisi server, gak ikut ke-accept", async () => {
  const server = await startTestServer();
  try {
    const { port } = server.address();
    const nowSec = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({
      dryRun: true,
      sessions: [
        { name: "Wajar", username: "jkt48_wajar", startedAtUnix: nowSec - 3600, endedAtUnix: nowSec },
        { name: "Ngaco", username: "jkt48_ngaco", startedAtUnix: nowSec - 122 * 60 * 60, endedAtUnix: nowSec }, // 122 jam
      ],
    });
    const { timestamp, signature } = sign(body);

    const res = await fetch(`http://127.0.0.1:${port}/api/backfill-live-history`, {
      method: "POST",
      headers: { "X-Api-Timestamp": timestamp, "X-Api-Signature": signature, "Content-Type": "application/json" },
      body,
    });
    const data = await res.json();
    assert.equal(data.totalReceived, 2);
    assert.equal(data.totalValid, 1, "cuma sesi yang durasinya wajar yang harusnya lolos valid");
  } finally {
    server.close();
  }
});

test("POST /api/backfill-live-history - dryRun:false beneran nulis, dan aman dipanggil ULANG (idempotent, gak dobel)", async () => {
  const server = await startTestServer();
  try {
    const { port } = server.address();
    const nowSec = Math.floor(Date.now() / 1000);
    const sessions = [
      { name: "Aralie", username: "jkt48_aralie", startedAtUnix: nowSec - 10 * 24 * 60 * 60, endedAtUnix: nowSec - 10 * 24 * 60 * 60 + 3600 },
      { name: "Erine", username: "jkt48_erine", startedAtUnix: nowSec - 9 * 24 * 60 * 60, endedAtUnix: nowSec - 9 * 24 * 60 * 60 + 3600 },
    ];

    async function callBackfill(dryRun) {
      const body = JSON.stringify({ dryRun, sessions });
      const { timestamp, signature } = sign(body);
      const res = await fetch(`http://127.0.0.1:${port}/api/backfill-live-history`, {
        method: "POST",
        headers: { "X-Api-Timestamp": timestamp, "X-Api-Signature": signature, "Content-Type": "application/json" },
        body,
      });
      return res.json();
    }

    const first = await callBackfill(false);
    assert.equal(first.acceptedIntoDailyLog, 2); // arsip kosong dulunya -> cutoff Infinity -> dua-duanya ke-accept

    // Panggil PERSIS SAMA lagi - dailyLog's earliest date sekarang mundur ke
    // sesi yang barusan dibackfill, jadi cutoff-nya juga ikut mundur, dan
    // dua sesi yang SAMA ini seharusnya udah "tertutup" sama cutoff barunya.
    const second = await callBackfill(false);
    assert.equal(second.acceptedIntoDailyLog, 0);

    const { timestamp: t2, signature: s2 } = sign("");
    const backupRes = await fetch(`http://127.0.0.1:${port}/api/backup`, {
      headers: { "X-Api-Timestamp": t2, "X-Api-Signature": s2 },
    });
    const backup = await backupRes.json();
    assert.equal(backup.dailyLog.sessions.length, 2, "dipanggil 2x tapi sesinya HARUS tetap cuma 2, bukan 4 (dobel)");
  } finally {
    server.close();
  }
});

// Bug yang dilaporin user: "cok kapan lily live?" cuma nunjukkin 1 riwayat
// walau lily udah 3x live sebelum backfill - ternyata backfill sebelumnya
// CUMA ngisi daily-log.json + live-count.json, gak nyentuh
// live-duration-history.json (yang dipake "cok kapan .../cok stats") sama
// sekali. Dites di sini: sesi yang di-accept ke daily-log HARUS juga masuk
// ke live-duration-history.json, dengan `at` HISTORIS (bukan waktu backfill
// dijalanin) - lihat storage/durationHistory.js's recordLiveDurationAt.
test("POST /api/backfill-live-history - dryRun:false juga ngisi live-duration-history.json (dipake 'cok kapan .../cok stats', bukan cuma daily-log)", async () => {
  const server = await startTestServer(freshStartServerForBackfillTest());
  try {
    const { port } = server.address();
    const nowSec = Math.floor(Date.now() / 1000);
    const daysAgo = (n) => nowSec - n * 24 * 60 * 60;
    const sessions = [
      { name: "Lily", username: "jkt48_lily_histtest", startedAtUnix: daysAgo(20), endedAtUnix: daysAgo(20) + 3600 },
      { name: "Lily", username: "jkt48_lily_histtest", startedAtUnix: daysAgo(15), endedAtUnix: daysAgo(15) + 3600 },
      { name: "Lily", username: "jkt48_lily_histtest", startedAtUnix: daysAgo(10), endedAtUnix: daysAgo(10) + 3600 },
    ];
    const body = JSON.stringify({ dryRun: false, sessions });
    const { timestamp, signature } = sign(body);
    await fetch(`http://127.0.0.1:${port}/api/backfill-live-history`, {
      method: "POST",
      headers: { "X-Api-Timestamp": timestamp, "X-Api-Signature": signature, "Content-Type": "application/json" },
      body,
    });

    const { timestamp: t2, signature: s2 } = sign("");
    const backupRes = await fetch(`http://127.0.0.1:${port}/api/backup`, {
      headers: { "X-Api-Timestamp": t2, "X-Api-Signature": s2 },
    });
    const backup = await backupRes.json();
    const entries = backup.durationHistory.jkt48_lily_histtest;
    assert.equal(entries.length, 3);
    // `at` harus deket sama waktu SESI-nya beneran SELESAI (endedAtUnix =
    // daysAgo(20) + 3600), BUKAN deket "sekarang" (yang berarti
    // recordLiveDuration biasa yang kepanggil, bukan recordLiveDurationAt).
    const oldestAt = new Date(entries[0].at).getTime();
    const expectedOldestEndedAtMs = (daysAgo(20) + 3600) * 1000;
    assert.ok(Math.abs(oldestAt - expectedOldestEndedAtMs) < 5000, "`at` harus historis (~20 hari lalu), bukan waktu backfill dijalanin");
  } finally {
    server.close();
  }
});

// Skenario NYATA yang kejadian ke user: backfill sempet dijalanin pas
// endpoint-nya masih versi LAMA (sebelum recordLiveDurationAt ditambahin) -
// daily-log.json udah ke-isi, tapi live-duration-history.json KOSONG buat
// sesi itu. Cutoff daily-log bakal NOLAK sesi yang sama di run berikutnya
// (bener, itu emang udah tercatet di situ) - tapi live-duration-history
// HARUS tetep berhasil ke-isi lewat pengecekan idempotent-nya sendiri
// (independen dari cutoff daily-log), soalnya di situ dia BENERAN belum ada.
test("POST /api/backfill-live-history - re-run setelah bugfix TETAP bisa ngisi live-duration-history yang ketinggalan dari run sebelum fix", async () => {
  const startFn = freshStartServerForBackfillTest();

  const { recordLiveEnded } = require("../src/storage/dailyLog");
  const nowSec = Math.floor(Date.now() / 1000);
  const daysAgo = (n) => nowSec - n * 24 * 60 * 60;
  const sessions = [20, 15, 10].map((d) => ({
    name: "Lily",
    username: "jkt48_lily_rerunfix",
    startedAtUnix: daysAgo(d),
    endedAtUnix: daysAgo(d) + 3600,
  }));
  // Seed daily-log.json LANGSUNG, mensimulasikan "endpoint versi lama udah
  // pernah jalan" - live-duration-history.json SENGAJA dibiarin kosong.
  sessions.forEach((s) => recordLiveEnded(s.name, s.username, new Date(s.startedAtUnix * 1000), new Date(s.endedAtUnix * 1000), null));

  const server = await startTestServer(startFn);
  try {
    const { port } = server.address();
    const body = JSON.stringify({ dryRun: false, sessions });
    const { timestamp, signature } = sign(body);
    const res = await fetch(`http://127.0.0.1:${port}/api/backfill-live-history`, {
      method: "POST",
      headers: { "X-Api-Timestamp": timestamp, "X-Api-Signature": signature, "Content-Type": "application/json" },
      body,
    });
    const result = await res.json();

    assert.equal(result.acceptedIntoDailyLog, 0, "daily-log udah ke-isi duluan (simulasi run lama) - cutoff harus nolak lagi");
    assert.equal(result.durationHistoryBackfilled, 3, "tapi live-duration-history HARUS tetep ke-isi, independen dari cutoff daily-log");

    const { timestamp: t2, signature: s2 } = sign("");
    const backupRes = await fetch(`http://127.0.0.1:${port}/api/backup`, {
      headers: { "X-Api-Timestamp": t2, "X-Api-Signature": s2 },
    });
    const backup = await backupRes.json();
    assert.equal(backup.durationHistory.jkt48_lily_rerunfix.length, 3);
  } finally {
    server.close();
  }
});

test("POST /api/backfill-live-history - request tanpa signature ditolak (401)", async () => {
  const server = await startTestServer();
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/api/backfill-live-history`, {
      method: "POST",
      body: JSON.stringify({ sessions: [] }),
    });
    assert.equal(res.status, 401);
  } finally {
    server.close();
  }
});

// scripts/repair-live-history.js's server-side counterpart - buat beresin
// data yang UDAH TERLANJUR korup (durasi implausible) dari backfill versi
// lama, sebelum reconstructSessions-nya diperbaiki. Seed daily-log +
// duration-history LANGSUNG (bukan lewat /api/backfill-live-history, yang
// sekarang udah nolak durasi implausible sejak dites - ini mensimulasikan
// data yang kesimpen SEBELUM validasi itu ada).
test("POST /api/repair-live-history - dryRun:true cuma preview, gak beneran ngubah data", async () => {
  const startFn = freshStartServerForBackfillTest();
  const { recordLiveEnded } = require("../src/storage/dailyLog");
  const { recordLiveDurationAt } = require("../src/storage/durationHistory");

  const nowSec = Math.floor(Date.now() / 1000);
  recordLiveEnded("Wajar", "jkt48_repair_wajar", new Date((nowSec - 3600) * 1000), new Date(nowSec * 1000), null);
  recordLiveEnded("Ngaco", "jkt48_repair_ngaco", new Date((nowSec - 122 * 60 * 60) * 1000), new Date(nowSec * 1000), null);
  recordLiveDurationAt("jkt48_repair_ngaco", "Ngaco", 122 * 60 * 60 * 1000, new Date(nowSec * 1000));

  const server = await startTestServer(startFn);
  try {
    const { port } = server.address();
    const body = JSON.stringify({ dryRun: true });
    const { timestamp, signature } = sign(body);

    const res = await fetch(`http://127.0.0.1:${port}/api/repair-live-history`, {
      method: "POST",
      headers: { "X-Api-Timestamp": timestamp, "X-Api-Signature": signature, "Content-Type": "application/json" },
      body,
    });
    const data = await res.json();
    assert.equal(data.dryRun, true);
    assert.equal(data.dailyLogRemoved, 1);
    assert.equal(data.durationHistoryRemoved, 1);

    const { timestamp: t2, signature: s2 } = sign("");
    const backupRes = await fetch(`http://127.0.0.1:${port}/api/backup`, {
      headers: { "X-Api-Timestamp": t2, "X-Api-Signature": s2 },
    });
    const backup = await backupRes.json();
    assert.equal(backup.dailyLog.sessions.length, 2, "dryRun harusnya gak beneran ngehapus apa-apa");
  } finally {
    server.close();
  }
});

test("POST /api/repair-live-history - dryRun:false beneran buang sesi/entry durasi implausible, dan rebuild live-count dari sisanya", async () => {
  const startFn = freshStartServerForBackfillTest();
  const { recordLiveEnded } = require("../src/storage/dailyLog");
  const { recordLiveDurationAt } = require("../src/storage/durationHistory");

  const nowSec = Math.floor(Date.now() / 1000);
  recordLiveEnded("Wajar", "jkt48_repair2_wajar", new Date((nowSec - 3600) * 1000), new Date(nowSec * 1000), null);
  recordLiveEnded("Ngaco", "jkt48_repair2_ngaco", new Date((nowSec - 122 * 60 * 60) * 1000), new Date(nowSec * 1000), null);
  recordLiveDurationAt("jkt48_repair2_wajar", "Wajar", 3600 * 1000, new Date(nowSec * 1000));
  recordLiveDurationAt("jkt48_repair2_ngaco", "Ngaco", 122 * 60 * 60 * 1000, new Date(nowSec * 1000));

  const server = await startTestServer(startFn);
  try {
    const { port } = server.address();
    const body = JSON.stringify({ dryRun: false });
    const { timestamp, signature } = sign(body);

    const res = await fetch(`http://127.0.0.1:${port}/api/repair-live-history`, {
      method: "POST",
      headers: { "X-Api-Timestamp": timestamp, "X-Api-Signature": signature, "Content-Type": "application/json" },
      body,
    });
    const data = await res.json();
    assert.equal(data.dryRun, false);
    assert.equal(data.dailyLogRemoved, 1);
    assert.equal(data.dailyLogSessionsRemaining, 1);
    assert.equal(data.durationHistoryRemoved, 1);

    const { timestamp: t2, signature: s2 } = sign("");
    const backupRes = await fetch(`http://127.0.0.1:${port}/api/backup`, {
      headers: { "X-Api-Timestamp": t2, "X-Api-Signature": s2 },
    });
    const backup = await backupRes.json();
    assert.equal(backup.dailyLog.sessions.length, 1);
    assert.equal(backup.dailyLog.sessions[0].name, "Wajar");
    assert.equal(backup.durationHistory.jkt48_repair2_ngaco, undefined);
    assert.equal(backup.durationHistory.jkt48_repair2_wajar.length, 1);
  } finally {
    server.close();
  }
});

test("POST /api/repair-live-history - request tanpa signature ditolak (401)", async () => {
  const server = await startTestServer();
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/api/repair-live-history`, {
      method: "POST",
      body: JSON.stringify({ dryRun: true }),
    });
    assert.equal(res.status, 401);
  } finally {
    server.close();
  }
});

test("GET / - health check TETAP publik, gak butuh signature", async () => {
  const server = await startTestServer();
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /JKT48 IDN Live notifier is running/);
  } finally {
    server.close();
  }
});
