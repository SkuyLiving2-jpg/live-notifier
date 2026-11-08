require("./helpers/setupTestEnv");

// Client Discord palsu - dipasang SEBELUM monitor/presence di-require (presence mengambil getDiscordClient lewat destructuring).
const presences = [];
const fakeClient = {
  isReady: () => true,
  user: { setPresence: (p) => presences.push(p.activities[0].name) },
};
require("../src/discordClient").getDiscordClient = () => fakeClient;

const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { checkLiveMembers } = require("../src/monitor");
const { activeLives, getSortedActiveLives, isConfirmedEnded, ENDED_GRACE_POLLS } = require("../src/storage/activeLives");
const { resetPresenceState, IDLE_TEXT } = require("../src/presence");

// Laporan owner: status bot ("Watching 🔴 ...") menampilkan member yang sudah selesai live dan tidak ikut berubah.
// Penyebab: notif "selesai" wajib terkirim dulu sebelum entri dihapus dari activeLives - webhook yang gagal terus
// membuat entri nyangkut selamanya, dan status/dashboard memakai daftar itu apa adanya.

function mockFetch({ webhookOk }) {
  const original = global.fetch;
  global.fetch = async (url) => {
    if (String(url).includes("idn.app")) return { ok: true, json: async () => ({ data: { getLivestreams: [] } }) }; // tidak ada yang live
    return webhookOk ? { ok: true, status: 200, json: async () => ({}) } : { ok: false, status: 404, json: async () => ({}) };
  };
  return () => {
    global.fetch = original;
  };
}

function seedLive(username, name, extra = {}) {
  activeLives.set(username, {
    name,
    username,
    slug: `slug-${username}`,
    liveAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    viewCount: 10,
    peakViewCount: 10,
    imageUrl: null,
    endingSoonAlerted: false,
    alertedMilestones: [],
    ...extra,
  });
}

beforeEach(() => {
  presences.length = 0;
  resetPresenceState();
  activeLives.clear();
});

test("getSortedActiveLives - entri yang sudah pasti selesai (absen >= ENDED_GRACE_POLLS) tidak ikut daftar 'lagi live'; glitch 1 siklus tetap ikut", () => {
  seedLive("jkt48_a", "Alpha JKT48");
  seedLive("jkt48_b", "Bravo JKT48", { missingStreak: ENDED_GRACE_POLLS - 1 });
  seedLive("jkt48_c", "Charlie JKT48", { missingStreak: ENDED_GRACE_POLLS });
  assert.deepEqual(
    getSortedActiveLives()
      .map((e) => e.username)
      .sort(),
    ["jkt48_a", "jkt48_b"],
  );
  assert.equal(isConfirmedEnded(activeLives.get("jkt48_c")), true);
  assert.equal(isConfirmedEnded(activeLives.get("jkt48_b")), false);
  assert.equal(isConfirmedEnded(undefined), false);
});

test("webhook gagal terus: status bot TIDAK lagi menampilkan member yang sudah selesai (entri tetap dicoba kirim ulang)", async () => {
  const restore = mockFetch({ webhookOk: false });
  try {
    seedLive("jkt48_stuck", "Stuck JKT48");
    await checkLiveMembers(); // absen 1x: masih dianggap live (grace)
    assert.match(presences.at(-1), /Stuck/);
    await checkLiveMembers(); // absen 2x: selesai, notif gagal -> entri nyangkut, tapi status harus sudah bersih
    assert.ok(activeLives.has("jkt48_stuck"), "entri dipertahankan supaya notif 'selesai' dicoba lagi");
    assert.equal(presences.at(-1), IDLE_TEXT);
  } finally {
    restore();
  }
});

test("webhook rusak permanen: setelah batas percobaan sesi ditutup tanpa notif, tidak nyangkut selamanya", async () => {
  const restore = mockFetch({ webhookOk: false });
  try {
    seedLive("jkt48_dead", "Dead JKT48", { missingStreak: 43 });
    await checkLiveMembers(); // 44: masih dicoba
    assert.ok(activeLives.has("jkt48_dead"));
    await checkLiveMembers(); // 45: menyerah
    assert.ok(!activeLives.has("jkt48_dead"), "sesi harus ditutup setelah menyerah");
  } finally {
    restore();
  }
});

test("status bot diperbarui di siklus yang sama saat member selesai (notif sukses)", async () => {
  const restore = mockFetch({ webhookOk: true });
  try {
    seedLive("jkt48_ok", "Okay JKT48");
    await checkLiveMembers();
    assert.match(presences.at(-1), /Okay/);
    await checkLiveMembers();
    assert.ok(!activeLives.has("jkt48_ok"));
    assert.equal(presences.at(-1), IDLE_TEXT);
  } finally {
    restore();
  }
});
