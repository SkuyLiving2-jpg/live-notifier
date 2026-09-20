require("./helpers/setupTestEnv");
// PORT:0 -> OS milihin port bebas sendiri (hindarin bentrok sama apapun
// yang kebetulan lagi jalan di 3000 lokal). API_SECRET di-set eksplisit di
// sini (bukan ngandelin .env asli siapapun yang jalanin test ini) biar
// signature yang dites deterministik.
process.env.PORT = "0";
process.env.API_SECRET = "test-secret-buat-server-test";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { signPayload } = require("../src/security");
const { startServer } = require("../src/server");

// Server ini di-listen di localhost port OS-assigned doang - gak ada
// koneksi keluar ke Discord/IDN/Railway sama sekali, jadi aman dijalanin
// beneran di test (beda dari monitor.js's pollLoop yang sengaja DIHINDARIN
// - lihat tests/monitor.test.js).
function startTestServer() {
  const server = startServer();
  return new Promise((resolve) => {
    server.on("listening", () => resolve(server));
  });
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
