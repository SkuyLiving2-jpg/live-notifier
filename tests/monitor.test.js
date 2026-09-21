require("./helpers/setupTestEnv");

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { stopPolling, checkLiveMembers } = require("../src/monitor");
const { activeLives } = require("../src/storage/activeLives");
const { getCompletedSessionsToday } = require("../src/storage/dailyLog");

// pollLoop() sendiri SENGAJA gak dites langsung di sini - checkLiveMembers()
// di dalemnya manggil fetchAllLivestreams() yang nembak API IDN BENERAN.
// Test unit gak boleh gantungin diri ke network call ke layanan pihak
// ketiga (sama alasannya kayak kenapa tests/router.test.js jauhin jalur
// "cok rekap"). Scope test ini dibatesin ke hal yang bisa diverifikasi
// tanpa itu: stopPolling() harus aman dipanggil kapan aja (termasuk
// sebelum siklus polling pernah jalan sama sekali) dan idempoten.
test("stopPolling - aman dipanggil sebelum polling pernah jalan, dan idempoten (dipanggil 2x gak error)", () => {
  assert.doesNotThrow(() => stopPolling());
  assert.doesNotThrow(() => stopPolling());
});

// checkLiveMembers() BENERAN dipanggil di 2 test di bawah (beda dari
// pollLoop() di atas) - tapi global.fetch di-mock dulu, jadi TETEP gak ada
// network call beneran ke IDN/Discord (idnApi.js/notify/webhook.js dua-duanya
// makai `fetch` global Node bawaan, gak ada client HTTP terpisah yang bisa
// di-inject). Sama pola monkey-patch-nya kayak tests/jsonStore.test.js's
// fs.writeFileSync mock.
function mockFetchNobodyLiveOnIdn() {
  const original = global.fetch;
  global.fetch = async (url) => {
    if (String(url).includes("idn.app")) {
      // fetchAllLivestreams: IDN bilang GAK ADA yang live sama sekali -
      // jadi siapapun yang lagi nyangkut di activeLives bakal ke-anggep
      // "baru aja selesai" di siklus ini.
      return { ok: true, json: async () => ({ data: { getLivestreams: [] } }) };
    }
    // Webhook Discord (notif start/end) - anggap selalu sukses kekirim.
    return { ok: true, json: async () => ({}) };
  };
  return () => {
    global.fetch = original;
  };
}

// Regresi buat gap yang ketemu pas audit: durationMs di jalur "live selesai"
// NORMAL (bukan backfill) dulu gak pernah divalidasi sama sekali - beda dari
// server.js's handleBackfillLiveHistory/handleRepairLiveHistory yang udah
// nyaring durasi implausible. Kalau activeLives nyimpen `liveAt` basi (mis.
// bot sempet mati lama), durasi yang keitung bisa ratusan jam dan ke-tulis
// LANGSUNG ke daily-log/duration-history - persis kelas bug "100+ jam live"
// yang dilaporin owner, cuma lewat pintu beda.
test("checkLiveMembers - durasi implausible (activeLives basi, >12 jam) DIBUANG dari stats, gak nyangkut ke daily-log, tapi tetep dibersihin dari activeLives", async () => {
  const restoreFetch = mockFetchNobodyLiveOnIdn();
  const username = "jkt48_test_implausible";
  try {
    activeLives.set(username, {
      name: "ImplausibleTest",
      username,
      slug: "slug-implausible",
      liveAt: new Date(Date.now() - 20 * 60 * 60 * 1000).toISOString(), // 20 jam lalu
      viewCount: 100,
      peakViewCount: 100,
      imageUrl: null,
      endingSoonAlerted: false,
      alertedMilestones: [],
    });

    await checkLiveMembers();

    assert.ok(!activeLives.has(username), "harus tetep dihapus dari activeLives biar gak nyangkut, walau durasinya dibuang");
    const recorded = getCompletedSessionsToday().some((s) => s.username === username);
    assert.equal(recorded, false, "sesi durasi implausible HARUS NGGAK kecatet ke daily-log");
  } finally {
    restoreFetch();
    activeLives.delete(username);
  }
});

test("checkLiveMembers - durasi WAJAR tetep kecatet normal ke daily-log (fix implausible-duration gak ngeblokir kasus normal)", async () => {
  const restoreFetch = mockFetchNobodyLiveOnIdn();
  const username = "jkt48_test_normal";
  try {
    activeLives.set(username, {
      name: "NormalTest",
      username,
      slug: "slug-normal",
      liveAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(), // 30 menit lalu
      viewCount: 50,
      peakViewCount: 50,
      imageUrl: null,
      endingSoonAlerted: false,
      alertedMilestones: [],
    });

    await checkLiveMembers();

    assert.ok(!activeLives.has(username));
    const recorded = getCompletedSessionsToday().some((s) => s.username === username);
    assert.equal(recorded, true, "sesi durasi wajar harus tetep kecatet normal ke daily-log");
  } finally {
    restoreFetch();
    activeLives.delete(username);
  }
});
