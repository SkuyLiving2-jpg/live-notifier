require("./helpers/setupTestEnv");

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { stopPolling, checkLiveMembers, computeNextPollDelay } = require("../src/monitor");
const { activeLives } = require("../src/storage/activeLives");
const { getCompletedSessionsToday } = require("../src/storage/dailyLog");
const { formatClockWIB } = require("../src/utils");
const { POLL_INTERVAL_MS } = require("../src/config");

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

// Regresi buat cadence polling yang molor: pollLoop dulu nunggu
// POLL_INTERVAL_MS PENUH abis checkLiveMembers() kelar, bukan jadwal tetap
// dari AWAL siklus - jadi siklus yang lambat (mis. kena retry rate-limit
// Discord) bikin siklus BERIKUTNYA ikut mundur juga, numpuk keterlambatan
// notif. computeNextPollDelay ngurangin waktu yang udah kepake siklus
// barusan dari jeda ke siklus berikutnya.
test("computeNextPollDelay - siklus cepet (elapsed kecil) -> jeda ke siklus berikutnya dikurangin sesuai waktu yang udah kepake", () => {
  assert.equal(computeNextPollDelay(0), POLL_INTERVAL_MS);
  assert.equal(computeNextPollDelay(5000), POLL_INTERVAL_MS - 5000);
});

test("computeNextPollDelay - siklus LAMBAT (elapsed >= POLL_INTERVAL_MS, mis. abis retry 429 beruntun) tetep dikasih jeda MINIMAL, gak langsung diulang tanpa jeda", () => {
  assert.equal(computeNextPollDelay(POLL_INTERVAL_MS), 1000);
  assert.equal(
    computeNextPollDelay(POLL_INTERVAL_MS + 10_000),
    1000,
    "siklus yang jauh lebih lambat dari interval-nya tetep dikasih jeda minimal, bukan 0/negatif",
  );
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

    // 2x - ENDED_GRACE_POLLS (lihat monitor.js) butuh absen 2x BERTURUT-TURUT
    // sebelum beneran dianggap selesai, bukan cuma sekali.
    await checkLiveMembers();
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
    await checkLiveMembers();

    assert.ok(!activeLives.has(username));
    const recorded = getCompletedSessionsToday().some((s) => s.username === username);
    assert.equal(recorded, true, "sesi durasi wajar harus tetep kecatet normal ke daily-log");
  } finally {
    restoreFetch();
    activeLives.delete(username);
  }
});

// Mock buat checkLiveMembers() berkali-kali BERTURUT-TURUT, tiap panggilan
// ngonsumsi SATU entry cycle dari queue-nya (array of lives yang "lagi live"
// di siklus itu). idnApi.js's fetchAllLivestreams loop per halaman SAMPAI
// nemu array kosong - kalau cycle-nya non-kosong, itu butuh 2 fetch call
// (isinya, baru kosong buat nutup paginasi); kalau cycle-nya UDAH kosong dari
// awal, cuma butuh 1 fetch call (loop-nya langsung berhenti di halaman
// pertama, gak pernah minta halaman kedua) - awaitingTerminator ngelacak
// mana dari dua kasus itu yang lagi kejadian, biar cycle SELANJUTNYA
// (checkLiveMembers() panggilan berikutnya) mulai dari entry queue yang
// BENER, bukan ketuker gara-gara nganggep semua cycle butuh 2 fetch call.
// capturedWebhookBodies (opsional) - array yang di-push isi body tiap kali
// mock ini "ngirim" ke webhook Discord, biar test bisa ngecek ISI notif yang
// beneran keluar dari checkLiveMembers() (mis. baris "Mulai jam"/"Selesai
// jam"), bukan cuma efek sampingnya doang di activeLives/daily-log.
function mockFetchIdnCycles(cycles, capturedWebhookBodies = []) {
  const original = global.fetch;
  const queue = [...cycles];
  let awaitingTerminator = false;
  global.fetch = async (url, options) => {
    if (String(url).includes("idn.app")) {
      if (awaitingTerminator) {
        awaitingTerminator = false;
        return { ok: true, json: async () => ({ data: { getLivestreams: [] } }) };
      }
      const data = queue.shift() || [];
      if (data.length > 0) awaitingTerminator = true;
      return { ok: true, json: async () => ({ data: { getLivestreams: data } }) };
    }
    if (options?.body) capturedWebhookBodies.push(JSON.parse(options.body));
    return { ok: true, json: async () => ({}) }; // webhook Discord - anggap selalu sukses kekirim
  };
  return () => {
    global.fetch = original;
  };
}

function fakeLiveEntry(username, name, liveAtIso) {
  return {
    creator: { username, name, bio_description: "" },
    slug: `slug-${username}`,
    live_at: liveAtIso,
    view_count: 10,
    image_url: null,
  };
}

// Regresi buat bug yang dilaporin owner lewat screenshot rekap harian: member
// yang sama muncul 2x di tabel dengan jam "Mulai" PERSIS SAMA tapi durasi
// beda - ketauan disebabin monitor.js langsung nganggep "selesai" begitu
// SEKALI absen dari respons IDN (glitch sesaat di sisi IDN, bukan beneran
// selesai), padahal dia balik muncul lagi siklus berikutnya. ENDED_GRACE_POLLS
// (monitor.js) nunggu 2 siklus absen BERTURUT-TURUT dulu sebelum beneran
// diproses sebagai "selesai".
test("checkLiveMembers - member absen SEKALI doang (glitch sesaat IDN) TETEP ditunggu, gak langsung dianggap selesai (regresi live kepotong jadi 2 sesi)", async () => {
  const username = "jkt48_test_glitch";
  const liveAtIso = new Date(Date.now() - 5 * 60_000).toISOString();
  const liveEntry = fakeLiveEntry(username, "GlitchTest", liveAtIso);

  const restoreFetch = mockFetchIdnCycles([
    [liveEntry], // cycle 1: mulai live
    [], // cycle 2: GLITCH - ilang sesaat doang
    [liveEntry], // cycle 3: balik muncul lagi
  ]);
  try {
    await checkLiveMembers();
    assert.ok(activeLives.has(username), "harus ke-set abis start");

    await checkLiveMembers();
    assert.ok(activeLives.has(username), "HARUS TETEP ada di activeLives - baru absen 1x, belum boleh dianggap selesai");
    assert.equal(activeLives.get(username).missingStreak, 1);

    await checkLiveMembers();
    assert.ok(activeLives.has(username), "masih tetep sesi yang SAMA (bukan 'mulai baru') begitu dia balik muncul");
    assert.equal(activeLives.get(username).missingStreak, 0, "streak absen harus ke-reset abis balik keliatan lagi");
    assert.equal(activeLives.get(username).liveAt, liveAtIso, "liveAt HARUS TETEP dari awal, gak boleh keganti kayak 'mulai baru'");

    const recorded = getCompletedSessionsToday().some((s) => s.username === username);
    assert.equal(recorded, false, "gak boleh ada sesi 'selesai' yang kecatet - live-nya beneran nyambung terus, cuma glitch 1 siklus doang");
  } finally {
    restoreFetch();
    activeLives.delete(username);
  }
});

test("checkLiveMembers - member absen 2x BERTURUT-TURUT baru beneran dianggap selesai live", async () => {
  const username = "jkt48_test_realend";
  const liveAtIso = new Date(Date.now() - 5 * 60_000).toISOString();
  const liveEntry = fakeLiveEntry(username, "RealEndTest", liveAtIso);

  const restoreFetch = mockFetchIdnCycles([
    [liveEntry], // cycle 1: mulai live
    [], // cycle 2: absen 1x
    [], // cycle 3: absen 2x BERTURUT-TURUT -> beneran selesai
  ]);
  try {
    await checkLiveMembers();
    assert.ok(activeLives.has(username));

    await checkLiveMembers();
    assert.ok(activeLives.has(username), "absen 1x - masih ditunggu, belum diproses selesai");

    await checkLiveMembers();
    assert.ok(!activeLives.has(username), "absen 2x berturut-turut - baru beneran diproses selesai & dihapus dari activeLives");

    const recorded = getCompletedSessionsToday().some((s) => s.username === username);
    assert.equal(recorded, true, "sesi yang BENERAN selesai (2x absen berturut-turut) harus tetep kecatet normal ke daily-log");
  } finally {
    restoreFetch();
    activeLives.delete(username);
  }
});

// Regresi buat permintaan owner: notif "mulai live" harus nyantumin jam
// mulai, notif "selesai" harus nyantumin jam selesai (lihat
// notify/liveNotify.js's buildNormalPayload). Dicek END-TO-END lewat
// checkLiveMembers() beneran (bukan langsung manggil buildNormalPayload,
// yang udah dites terpisah di tests/liveNotify.test.js) - biar kepastian
// monitor.js BENERAN nerusin live.live_at (jam mulai ASLI dari IDN, bukan
// jam bot ngedetek-nya) ke sendDiscordNotif juga ke-cover.
test("checkLiveMembers - notif start nyantumin jam mulai (dari live_at IDN), notif end nyantumin jam selesai (sekarang)", async () => {
  const username = "jkt48_test_jamnotif";
  const liveAtIso = new Date(Date.now() - 15 * 60_000).toISOString(); // 15 menit lalu
  const liveEntry = fakeLiveEntry(username, "JamNotifTest", liveAtIso);
  const capturedWebhookBodies = [];

  const restoreFetch = mockFetchIdnCycles(
    [
      [liveEntry], // cycle 1: mulai live
      [], // cycle 2: absen 1x
      [], // cycle 3: absen 2x berturut-turut -> beneran selesai
    ],
    capturedWebhookBodies,
  );
  try {
    await checkLiveMembers(); // notif "start" kekirim
    await checkLiveMembers(); // absen 1x, belum ada notif "end"
    await checkLiveMembers(); // absen 2x berturut-turut, notif "end" kekirim

    assert.equal(capturedWebhookBodies.length, 2, "harus persis 2 notif kekirim: start & end");

    const startBody = capturedWebhookBodies[0];
    assert.match(startBody.content, /\nMulai jam \d{2}\.\d{2}\.\d{2} WIB/, "notif start harus nyantumin jam mulai");
    assert.match(
      startBody.content,
      new RegExp(`Mulai jam ${formatClockWIB(new Date(liveAtIso))}`),
      "jam mulai yang ditampilin harus dari live_at ASLI IDN, bukan jam bot ngedetek",
    );

    const endBody = capturedWebhookBodies[1];
    assert.match(endBody.content, /\nSelesai jam \d{2}\.\d{2}\.\d{2} WIB/, "notif end harus nyantumin jam selesai");
  } finally {
    restoreFetch();
    activeLives.delete(username);
  }
});
