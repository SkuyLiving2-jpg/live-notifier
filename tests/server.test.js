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
