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
    assert.deepEqual(data.channelRouting, {});
  } finally {
    server.close();
  }
});

test("POST /api/channel-routing - request tanpa signature ditolak (401)", async () => {
  const server = await startTestServer();
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/api/channel-routing`, { method: "POST", body: "{}" });
    assert.equal(res.status, 401);
  } finally {
    server.close();
  }
});

// Regresi: owner nyoba push webhook URL yang copy-annya masih pake domain
// LAMA (discordapp.com, bukan discord.com) - itu masih beneran webhook yang
// valid/jalan, tapi ke-tolak duluan sama regex yang cuma nerima discord.com.
test("POST /api/channel-routing - webhook URL domain LAMA (discordapp.com) tetep diterima, bukan cuma discord.com", async () => {
  const server = await startTestServer();
  try {
    const { port } = server.address();
    const body = JSON.stringify({ jkt48_aralie: "https://discordapp.com/api/webhooks/111/token-aralie" });
    const { timestamp, signature } = sign(body);
    const res = await fetch(`http://127.0.0.1:${port}/api/channel-routing`, {
      method: "POST",
      headers: { "X-Api-Timestamp": timestamp, "X-Api-Signature": signature, "Content-Type": "application/json" },
      body,
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.deepEqual(data, { ok: true, count: 1 });
  } finally {
    server.close();
  }
});

test("POST /api/channel-routing - request yang di-sign bener nyimpen pemetaan, full REPLACE bukan merge", async () => {
  const server = await startTestServer();
  try {
    const { port } = server.address();
    const body1 = JSON.stringify({ jkt48_aralie: "https://discord.com/api/webhooks/111/token-aralie" });
    const { timestamp: t1, signature: s1 } = sign(body1);
    const res1 = await fetch(`http://127.0.0.1:${port}/api/channel-routing`, {
      method: "POST",
      headers: { "X-Api-Timestamp": t1, "X-Api-Signature": s1, "Content-Type": "application/json" },
      body: body1,
    });
    assert.equal(res1.status, 200);
    const data1 = await res1.json();
    assert.deepEqual(data1, { ok: true, count: 1 });

    // Push KEDUA cuma nyantumin 1 username BEDA - harus jadi satu-satunya isi
    // (REPLACE), aralie dari push pertama HARUS ilang, bukan numpuk (merge).
    const body2 = JSON.stringify({ jkt48_delynn: "https://discord.com/api/webhooks/222/token-delynn" });
    const { timestamp: t2, signature: s2 } = sign(body2);
    const res2 = await fetch(`http://127.0.0.1:${port}/api/channel-routing`, {
      method: "POST",
      headers: { "X-Api-Timestamp": t2, "X-Api-Signature": s2, "Content-Type": "application/json" },
      body: body2,
    });
    assert.equal(res2.status, 200);

    const { timestamp: t3, signature: s3 } = sign("");
    const backupRes = await fetch(`http://127.0.0.1:${port}/api/backup`, {
      headers: { "X-Api-Timestamp": t3, "X-Api-Signature": s3 },
    });
    const backup = await backupRes.json();
    assert.deepEqual(backup.channelRouting, { jkt48_delynn: "https://discord.com/api/webhooks/222/token-delynn" });
  } finally {
    server.close();
  }
});

// Bentuk BARU (fitur "Q3" - fallback chat khusus channel per-member, lihat
// storage/channelRouting.js): value objek { webhookUrl, channelId } harus
// diterima juga, bukan cuma string webhook URL polos.
test("POST /api/channel-routing - value bentuk object { webhookUrl, channelId } valid diterima", async () => {
  const server = await startTestServer();
  try {
    const { port } = server.address();
    const body = JSON.stringify({
      jkt48_objecttest: { webhookUrl: "https://discord.com/api/webhooks/111/token-obj", channelId: "111222333444555666" },
    });
    const { timestamp, signature } = sign(body);
    const res = await fetch(`http://127.0.0.1:${port}/api/channel-routing`, {
      method: "POST",
      headers: { "X-Api-Timestamp": timestamp, "X-Api-Signature": signature, "Content-Type": "application/json" },
      body,
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.deepEqual(data, { ok: true, count: 1 });
  } finally {
    server.close();
  }
});

test("POST /api/channel-routing - value bentuk object dengan channelId BUKAN snowflake Discord yang valid ditolak (400)", async () => {
  const server = await startTestServer();
  try {
    const { port } = server.address();
    const body = JSON.stringify({
      jkt48_badchannelid: { webhookUrl: "https://discord.com/api/webhooks/111/token-bad", channelId: "bukan-angka" },
    });
    const { timestamp, signature } = sign(body);
    const res = await fetch(`http://127.0.0.1:${port}/api/channel-routing`, {
      method: "POST",
      headers: { "X-Api-Timestamp": timestamp, "X-Api-Signature": signature, "Content-Type": "application/json" },
      body,
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.deepEqual(data.invalidUsernames, ["jkt48_badchannelid"]);
  } finally {
    server.close();
  }
});

test("POST /api/channel-routing - value yang bukan webhook URL valid ditolak (400), gak nimpa data yang udah ada", async () => {
  const server = await startTestServer();
  try {
    const { port } = server.address();

    // Baseline dulu (bukan ngandelin state sisa test lain di file yang sama)
    // - dipush valid duluan, biar bisa dipastiin push yang INVALID setelahnya
    // BENERAN gak nimpa apa-apa, bukan cuma kebetulan ketemu {} yang kosong.
    const baselineBody = JSON.stringify({ jkt48_baseline: "https://discord.com/api/webhooks/777/token-baseline" });
    const { timestamp: tb, signature: sb } = sign(baselineBody);
    await fetch(`http://127.0.0.1:${port}/api/channel-routing`, {
      method: "POST",
      headers: { "X-Api-Timestamp": tb, "X-Api-Signature": sb, "Content-Type": "application/json" },
      body: baselineBody,
    });

    const body = JSON.stringify({ jkt48_aralie: "bukan-webhook-url-valid" });
    const { timestamp, signature } = sign(body);
    const res = await fetch(`http://127.0.0.1:${port}/api/channel-routing`, {
      method: "POST",
      headers: { "X-Api-Timestamp": timestamp, "X-Api-Signature": signature, "Content-Type": "application/json" },
      body,
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.deepEqual(data.invalidUsernames, ["jkt48_aralie"]);

    const { timestamp: t2, signature: s2 } = sign("");
    const backupRes = await fetch(`http://127.0.0.1:${port}/api/backup`, {
      headers: { "X-Api-Timestamp": t2, "X-Api-Signature": s2 },
    });
    const backup = await backupRes.json();
    assert.deepEqual(
      backup.channelRouting,
      { jkt48_baseline: "https://discord.com/api/webhooks/777/token-baseline" },
      "push invalid harus gak nimpa data baseline sama sekali, walau cuma satu dari banyak entry yang rusak",
    );
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
    assert.equal(data.acceptedIntoDailyLog, 1); // arsip masih kosong -> belum ada yang bisa dobel -> ke-accept

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
    assert.equal(first.acceptedIntoDailyLog, 2); // arsip kosong dulunya -> belum ada yang bisa dobel -> dua-duanya ke-accept

    // Panggil PERSIS SAMA lagi - dua sesi yang SAMA (username + endedAtUnix
    // identik) sekarang udah ada di daily-log, jadi dedup-nya harus nolak
    // dua-duanya lagi.
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
// sesi itu. Dedup daily-log bakal NOLAK sesi yang SAMA PERSIS di run
// berikutnya (bener, itu emang udah tercatet di situ) - tapi
// live-duration-history HARUS tetep berhasil ke-isi lewat pengecekan
// idempotent-nya sendiri, soalnya di situ dia BENERAN belum ada.
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

    assert.equal(result.acceptedIntoDailyLog, 0, "daily-log udah ke-isi duluan (simulasi run lama) - dedup harus nolak lagi");
    assert.equal(result.durationHistoryBackfilled, 3, "tapi live-duration-history HARUS tetep ke-isi, independen dari dedup daily-log");

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

// BUG FATAL yang dilaporin user: "kapan Nala/Lily/Levi live sebelum 19
// September" gak pernah nongol di "cok rekap", walau parsernya udah
// dibenerin dan count-priority-notifs.js udah nemuin notifnya. Root cause-nya
// versi CUTOFF-TANGGAL lama: begitu satu run backfill berhasil masukin SATU
// SAJA sesi dari periode awal (mis. sesi non-prioritas), "sesi paling tua
// yang udah ada" jadi mundur ke situ - run backfill BERIKUTNYA yang nemuin
// sesi TAMBAHAN dari periode yang SAMA (mis. sesi prioritas yang baru
// kebaca abis parser embed-nya dibenerin) bakal DITOLAK KELIRU, walau sesi
// itu beneran belum pernah kesimpen, cuma karena endedAtUnix-nya "lewat"
// cutoff. Dedup per-sesi (bukan per-tanggal) gak punya masalah ini.
test("POST /api/backfill-live-history - sesi BARU dari periode yang SAMA kayak yang udah pernah ke-backfill sebelumnya TETAP ke-accept (bukan ketolak gara-gara cutoff tanggal)", async () => {
  const startFn = freshStartServerForBackfillTest();
  const { recordLiveEnded } = require("../src/storage/dailyLog");
  const nowSec = Math.floor(Date.now() / 1000);
  const daysAgo = (n) => nowSec - n * 24 * 60 * 60;

  // Simulasiin: run backfill PERTAMA berhasil masukin 1 sesi non-prioritas
  // dari 20 hari lalu - ini yang bikin "sesi paling tua yang udah ada"
  // mundur ke tanggal itu di versi cutoff lama.
  recordLiveEnded("Aralie", "jkt48_cutoffbug_aralie", new Date(daysAgo(20) * 1000), new Date((daysAgo(20) + 3600) * 1000), null);

  const server = await startTestServer(startFn);
  try {
    const { port } = server.address();
    // Run KEDUA nemuin sesi TAMBAHAN dari periode yang SAMA (19 hari lalu,
    // beda member & waktu) - versi cutoff lama bakal nolak ini (endedAtUnix
    // udah "lewat" cutoff 20 hari lalu), padahal ini sesi yang beneran belum
    // pernah kesimpen.
    const newlyFoundSession = { name: "Nala", username: "jkt48_cutoffbug_nala", startedAtUnix: daysAgo(19), endedAtUnix: daysAgo(19) + 3600 };
    const body = JSON.stringify({ dryRun: false, sessions: [newlyFoundSession] });
    const { timestamp, signature } = sign(body);
    const res = await fetch(`http://127.0.0.1:${port}/api/backfill-live-history`, {
      method: "POST",
      headers: { "X-Api-Timestamp": timestamp, "X-Api-Signature": signature, "Content-Type": "application/json" },
      body,
    });
    const result = await res.json();
    assert.equal(result.acceptedIntoDailyLog, 1, "sesi baru dari periode yang sama harus TETAP ke-accept, bukan ketolak cutoff");

    const { timestamp: t2, signature: s2 } = sign("");
    const backupRes = await fetch(`http://127.0.0.1:${port}/api/backup`, {
      headers: { "X-Api-Timestamp": t2, "X-Api-Signature": s2 },
    });
    const backup = await backupRes.json();
    assert.ok(
      backup.dailyLog.sessions.some((s) => s.username === "jkt48_cutoffbug_nala"),
      "sesi Nala yang baru ketemu harus ada di daily-log, siap dipakai 'cok rekap'",
    );
  } finally {
    server.close();
  }
});

// Kebalikan dari tes di atas - dedup per-sesi HARUS tetep nolak sesi yang
// BENERAN udah ada, walau endedAtUnix-nya beda beberapa detik dari yang
// udah tersimpan (wajar - beda antara timestamp live-tracker's Date.now()
// SAMA timestamp pesan Discord createdTimestamp buat sesi live yang SAMA).
test("POST /api/backfill-live-history - sesi yang endedAtUnix-nya beda beberapa detik dari yang UDAH ADA (drift timestamp wajar) tetep kedeteksi dobel", async () => {
  const startFn = freshStartServerForBackfillTest();
  const { recordLiveEnded } = require("../src/storage/dailyLog");
  const nowSec = Math.floor(Date.now() / 1000);
  const daysAgo = (n) => nowSec - n * 24 * 60 * 60;

  // Sesi yang UDAH ke-track live sama bot sendiri (real-time).
  recordLiveEnded("Nala", "jkt48_drifttest", new Date(daysAgo(5) * 1000), new Date((daysAgo(5) + 3600) * 1000), 50);

  const server = await startTestServer(startFn);
  try {
    const { port } = server.address();
    // Sesi "sama" yang direkonstruksi dari pesan Discord - endedAtUnix-nya
    // 7 detik lebih telat dari yang di-track live-tracker (wajar).
    const nearDuplicate = { name: "Nala", username: "jkt48_drifttest", startedAtUnix: daysAgo(5), endedAtUnix: daysAgo(5) + 3600 + 7 };
    const body = JSON.stringify({ dryRun: false, sessions: [nearDuplicate] });
    const { timestamp, signature } = sign(body);
    const res = await fetch(`http://127.0.0.1:${port}/api/backfill-live-history`, {
      method: "POST",
      headers: { "X-Api-Timestamp": timestamp, "X-Api-Signature": signature, "Content-Type": "application/json" },
      body,
    });
    const result = await res.json();
    assert.equal(result.acceptedIntoDailyLog, 0, "sesi yang cuma beda beberapa detik dari yang udah ada harus ketahuan dobel, bukan numpuk");
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

// security.js's MAX_REQUEST_BODY_BYTES - ditolak (413) SEBELUM sempet
// diperiksa signature-nya sama sekali (jadi gak perlu beneran nge-sign body
// segede ini di test) - nyegah body request numpuk tanpa batas di memori.
test("POST /api/backfill-live-history - body ngelewatin batas ukuran ditolak (413), gak diproses sama sekali", async () => {
  const server = await startTestServer();
  try {
    const { port } = server.address();
    const oversizedBody = "x".repeat(6 * 1024 * 1024); // 6MB > MAX_REQUEST_BODY_BYTES (5MB)
    const res = await fetch(`http://127.0.0.1:${port}/api/backfill-live-history`, {
      method: "POST",
      body: oversizedBody,
    });
    assert.equal(res.status, 413);
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
