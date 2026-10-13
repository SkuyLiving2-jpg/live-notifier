require("./helpers/setupTestEnv");

// recordLiveEnded sengaja dibuat melempar SEBELUM monitor di-require (monitor mengambil fungsinya lewat
// destructuring) - mensimulasikan pencatatan sesi yang gagal (JSON rusak, disk penuh, dst).
const dailyLogStorage = require("../src/storage/dailyLog");
dailyLogStorage.recordLiveEnded = () => {
  throw new Error("simulasi: gagal mencatat sesi");
};

const http = require("http");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { checkLiveMembers } = require("../src/monitor");
const { activeLives } = require("../src/storage/activeLives");
const { loadLiveCount } = require("../src/storage/liveCount");
const { loadDurationHistory } = require("../src/storage/durationHistory");
const { requireSignedRequest, signPayload } = require("../src/security");

test("pencatatan sesi gagal SETELAH notif selesai terkirim - sesi tetap ditutup, notif selesai tidak diulang tiap siklus, statistik tidak berlipat", async () => {
  const originalFetch = global.fetch;
  const originalError = console.error;
  const posts = [];
  let live = true;
  global.fetch = async (url, options) => {
    if (String(url).includes("idn.app")) {
      const page = JSON.parse(options.body).variables.page;
      const lives =
        live && page === 1
          ? [
              {
                creator: { username: "jkt48_zeta", name: "Zeta JKT48" },
                slug: "s1",
                live_at: new Date(Date.now() - 20 * 60e3).toISOString(),
                view_count: 10,
              },
            ]
          : [];
      return { ok: true, json: async () => ({ data: { getLivestreams: lives } }) };
    }
    posts.push(JSON.parse(options.body).content);
    return { ok: true, json: async () => ({}) };
  };
  console.error = () => {};
  try {
    await checkLiveMembers(); // mulai live
    live = false;
    for (let i = 0; i < 6; i++) await checkLiveMembers(); // absen 6 siklus berturut-turut

    assert.equal(posts.filter((p) => p.includes("lagi live")).length, 1, "notif mulai tepat sekali");
    assert.equal(posts.filter((p) => p.includes("udah selesai live")).length, 1, "notif selesai tepat sekali, bukan tiap siklus");
    assert.equal(posts.filter((p) => p.includes("pecahin rekor")).length, 0, "tidak ada pengumuman rekor palsu dari catatan sebagian yang berulang");
    assert.equal(activeLives.has("jkt48_zeta"), false, "sesi harus ditutup walau pencatatan gagal");
    assert.equal(loadLiveCount().jkt48_zeta.count, 1, "satu live dihitung satu kali");
    assert.equal(loadDurationHistory().jkt48_zeta.length, 1, "satu entri riwayat durasi, bukan satu per siklus");
  } finally {
    global.fetch = originalFetch;
    console.error = originalError;
  }
});

test("requireSignedRequest - handler yang melempar error dijawab 500 dan TIDAK jadi uncaughtException (proses bot tidak mati)", async () => {
  const secret = "rahasia-uji-ketahanan";
  const originalError = console.error;
  console.error = () => {};
  let uncaught = null;
  const onUncaught = (error) => {
    uncaught = error;
  };
  process.on("uncaughtException", onUncaught);

  const server = http.createServer(
    requireSignedRequest(secret, () => {
      throw new Error("handler meledak");
    }),
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const body = JSON.stringify({ apa: "saja" });
    const timestamp = Date.now().toString();
    const res = await fetch(`http://127.0.0.1:${server.address().port}/x`, {
      method: "POST",
      headers: { "X-Api-Timestamp": timestamp, "X-Api-Signature": signPayload(secret, timestamp, body) },
      body,
      signal: AbortSignal.timeout(3000),
    });
    assert.equal(res.status, 500);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(uncaught, null, "error handler tidak boleh lolos jadi uncaughtException");
  } finally {
    process.off("uncaughtException", onUncaught);
    console.error = originalError;
    server.close();
  }
});
