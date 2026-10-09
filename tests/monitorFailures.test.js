require("./helpers/setupTestEnv");

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { checkLiveMembers } = require("../src/monitor");
const { activeLives } = require("../src/storage/activeLives");
const { getCompletedSessionsSince } = require("../src/storage/dailyLog");
const { pollHealth } = require("../src/pollHealth");

// Jalur kegagalan checkLiveMembers: Discord menolak kiriman, IDN mati. Dua hal yang tidak boleh terjadi:
// (1) member dianggap sudah diumumkan padahal notifnya gagal (notif hilang selamanya), dan
// (2) state rusak karena satu siklus gagal. Fetch dipalsukan, jadi tidak ada panggilan jaringan sungguhan.

function installFakeNetwork() {
  const net = { idn: [], idnDown: false, discordOk: true, discordPosts: [] };
  const original = global.fetch;
  global.fetch = async (url, options = {}) => {
    if (String(url).includes("idn")) {
      if (net.idnDown) throw new Error("IDN down");
      const page = options.body ? JSON.parse(options.body).variables.page : 1;
      return { ok: true, json: async () => ({ data: { getLivestreams: page === 1 ? net.idn : [] } }) };
    }
    const body = options.body ? JSON.parse(options.body) : null;
    net.discordPosts.push({ ok: net.discordOk, content: body?.content ?? "" });
    return net.discordOk
      ? { ok: true, status: 200, json: async () => ({}), text: async () => "" }
      : { ok: false, status: 500, json: async () => ({}), text: async () => "x" };
  };
  net.restore = () => {
    global.fetch = original;
  };
  return net;
}

const live = (username, name, slug, views = 10) => ({
  creator: { username, name, bio_description: "" },
  title: "t",
  slug,
  live_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
  view_count: views,
  image_url: null,
});

const startPosts = (net) => net.discordPosts.filter((p) => /live|mulai/i.test(p.content));
const sessionsOf = (username) => getCompletedSessionsSince(1).filter((s) => s.username === username);

test("notif MULAI gagal terkirim - member BELUM dianggap sudah diumumkan, dicoba lagi siklus berikutnya sampai terkirim", async () => {
  const net = installFakeNetwork();
  const username = "jkt48_mfstart";
  try {
    net.idn = [live(username, "Mfstart JKT48", "s1")];

    net.discordOk = false;
    await checkLiveMembers();
    assert.ok(!activeLives.has(username), "notif gagal -> jangan didaftarkan, supaya dicoba lagi");

    await checkLiveMembers(); // masih gagal
    assert.ok(!activeLives.has(username));

    net.discordOk = true;
    net.discordPosts.length = 0;
    await checkLiveMembers();
    assert.ok(activeLives.has(username), "begitu Discord pulih, member terdaftar");
    assert.equal(startPosts(net).length, 1, "tepat SATU notif mulai yang berhasil");

    net.discordPosts.length = 0;
    await checkLiveMembers(); // siklus berikutnya: sudah terdaftar, tidak ada notif mulai lagi
    assert.equal(startPosts(net).length, 0, "tidak ada notif mulai ganda");
  } finally {
    activeLives.delete(username);
    net.restore();
  }
});

test("notif SELESAI gagal terkirim - sesi TIDAK dihapus/dicatat sampai notifnya terkirim, lalu dicatat tepat sekali", async () => {
  const net = installFakeNetwork();
  const username = "jkt48_mfend";
  try {
    net.idn = [live(username, "Mfend JKT48", "s1")];
    await checkLiveMembers();
    assert.ok(activeLives.has(username));

    net.idn = []; // member selesai live
    net.discordOk = false;
    await checkLiveMembers(); // absen ke-1 (toleransi)
    await checkLiveMembers(); // absen ke-2 -> mencoba kirim notif selesai -> GAGAL
    assert.ok(activeLives.has(username), "notif selesai gagal -> tetap di activeLives supaya dicoba lagi");
    assert.equal(sessionsOf(username).length, 0, "belum boleh tercatat di rekap");

    net.discordOk = true;
    await checkLiveMembers();
    assert.ok(!activeLives.has(username), "notif terkirim -> sesi ditutup");
    assert.equal(sessionsOf(username).length, 1, "tercatat tepat sekali");

    await checkLiveMembers();
    assert.equal(sessionsOf(username).length, 1, "siklus berikutnya tidak mencatat ulang");
  } finally {
    activeLives.delete(username);
    net.restore();
  }
});

test("IDN mati - state live TIDAK disentuh (tidak ada notif selesai palsu), kegagalan dihitung, dan dipulihkan saat IDN kembali", async () => {
  const net = installFakeNetwork();
  const username = "jkt48_mfidn";
  const originalError = console.error;
  console.error = () => {};
  try {
    net.idn = [live(username, "Mfidn JKT48", "s1")];
    await checkLiveMembers();
    assert.ok(activeLives.has(username));
    const before = JSON.stringify(activeLives.get(username));

    net.idnDown = true;
    net.discordPosts.length = 0;
    const failuresBefore = pollHealth.failures;
    for (let i = 0; i < 3; i++) await checkLiveMembers(); // lebih dari ENDED_GRACE_POLLS: bila IDN down dianggap "member hilang" ia salah dianggap selesai
    assert.ok(activeLives.has(username), "IDN down bukan berarti member selesai live");
    assert.equal(JSON.stringify(activeLives.get(username)), before, "state member tidak berubah sama sekali");
    assert.equal(net.discordPosts.length, 0, "tidak ada notif apa pun saat IDN down");
    assert.equal(pollHealth.failures, failuresBefore + 3);

    net.idnDown = false;
    await checkLiveMembers();
    assert.equal(pollHealth.failures, 0, "sukses mereset penghitung kegagalan");
    assert.ok(activeLives.has(username));
  } finally {
    console.error = originalError;
    activeLives.delete(username);
    net.restore();
  }
});
