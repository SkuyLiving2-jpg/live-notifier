require("./helpers/setupTestEnv");

// Client Discord palsu HARUS dipasang sebelum modul src/ yang ngambil getDiscordClient
// lewat destructuring (personalDelivery, oshiDigest) di-require.
const discordClient = require("../src/discordClient");
const dms = [];
const failDmFor = new Set();
let fakeClient = null;
discordClient.getDiscordClient = () => fakeClient;
function installFakeClient() {
  dms.length = 0;
  failDmFor.clear();
  fakeClient = {
    users: {
      fetch: async (id) => ({
        send: async (payload) => {
          if (failDmFor.has(id)) throw new Error("Cannot send messages to this user");
          dms.push({ id, content: payload.content });
        },
      }),
    },
  };
}

const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { getUserPrefs, updateUserPrefs, touchLastSeen, isQuietHour, MAX_OSHIS } = require("../src/storage/userPrefs");
const { saveSubscriptions, loadSubscriptions } = require("../src/storage/subscriptions");
const { recordLiveCompleted } = require("../src/storage/liveCount");
const { recordLiveEnded } = require("../src/storage/dailyLog");
const { activeLives } = require("../src/storage/activeLives");
const { splitByPreference } = require("../src/notify/personalDelivery");
const { sendDiscordNotif } = require("../src/notify/liveNotify");
const { maybeSendOshiDigests, digestWeekKey } = require("../src/notify/oshiDigest");
const { buildChatReply } = require("../src/chat/router");
const { getHourWIBOf } = require("../src/utils");

beforeEach(() => installFakeClient());

const textOf = (reply) => (typeof reply === "string" ? reply : reply.content);
const say = async (message, authorId = "user-p1") => textOf(await buildChatReply(message, { isBotChannel: true, authorId, channelId: "chan-p" }));

// ---------- storage ----------
test("userPrefs - default lengkap, update tervalidasi, id berbahaya aman, oshi dibatasi", () => {
  assert.deepEqual(getUserPrefs("u-baru"), {
    oshis: [],
    delivery: "tag",
    quietStart: null,
    quietEnd: null,
    digestOff: false,
    digestWeek: null,
    lastSeenAt: null,
  });
  assert.equal(getUserPrefs("__proto__").delivery, "tag");
  assert.equal(getUserPrefs(null).delivery, "tag");

  updateUserPrefs("u-valid", (p) => {
    p.delivery = "ngawur";
    p.quietStart = 25;
    p.quietEnd = 3;
    p.oshis = ["a", "a", "b", "c", "d", "e", "f", "g"];
  });
  const prefs = getUserPrefs("u-valid");
  assert.equal(prefs.delivery, "tag", "nilai selain dm/tag -> tag");
  assert.equal(prefs.quietStart, null, "jam di luar 0-23 dibuang");
  assert.equal(prefs.oshis.length, MAX_OSHIS);
  assert.equal(new Set(prefs.oshis).size, prefs.oshis.length, "tanpa duplikat");
  assert.deepEqual(updateUserPrefs("__proto__", (p) => (p.delivery = "dm")).delivery, "tag", "__proto__ tidak disimpan");
});

test("isQuietHour - rentang biasa, nyebrang tengah malam, mati", () => {
  const night = { quietStart: 23, quietEnd: 6 };
  assert.equal(isQuietHour(night, 23), true);
  assert.equal(isQuietHour(night, 0), true);
  assert.equal(isQuietHour(night, 5), true);
  assert.equal(isQuietHour(night, 6), false, "akhir eksklusif");
  assert.equal(isQuietHour(night, 12), false);
  const day = { quietStart: 13, quietEnd: 15 };
  assert.equal(isQuietHour(day, 13), true);
  assert.equal(isQuietHour(day, 15), false);
  assert.equal(isQuietHour({ quietStart: null, quietEnd: null }, 3), false);
});

test("touchLastSeen - ditulis sekali, tidak ditulis ulang dalam interval 10 menit", () => {
  const id = "u-seen";
  touchLastSeen(id, 1_000_000);
  assert.equal(getUserPrefs(id).lastSeenAt, 1_000_000);
  touchLastSeen(id, 1_000_000 + 60_000);
  assert.equal(getUserPrefs(id).lastSeenAt, 1_000_000, "terlalu cepat -> tidak diubah");
  touchLastSeen(id, 1_000_000 + 11 * 60_000);
  assert.equal(getUserPrefs(id).lastSeenAt, 1_000_000 + 11 * 60_000);
});

// ---------- pengiriman: DM / tag / jam tenang ----------
test("splitByPreference - tag default, DM kalau dipilih & bot bisa DM, jam tenang dilewati", () => {
  updateUserPrefs("u-dm", (p) => (p.delivery = "dm"));
  const hour = getHourWIBOf(new Date());
  updateUserPrefs("u-quiet", (p) => {
    p.quietStart = hour;
    p.quietEnd = (hour + 1) % 24;
  });
  const result = splitByPreference(["u-plain", "u-dm", "u-quiet"]);
  assert.deepEqual(result, { tag: ["u-plain"], dm: ["u-dm"], quiet: ["u-quiet"] });

  fakeClient = null; // bot belum login -> DM mustahil, jatuh ke tag
  assert.deepEqual(splitByPreference(["u-dm"]), { tag: ["u-dm"], dm: [], quiet: [] });
});

function captureWebhook() {
  const original = global.fetch;
  const bodies = [];
  global.fetch = async (url, options) => {
    bodies.push(JSON.parse(options.body));
    return { ok: true, json: async () => ({}) };
  };
  return { bodies, restore: () => (global.fetch = original) };
}

test("sendDiscordNotif - subscriber pilih DM dapat DM (tidak di-tag); DM gagal jatuh balik ke tag; jam tenang tidak diganggu", async () => {
  saveSubscriptions({ pengirim: ["sub-plain", "sub-dm", "sub-dm-gagal", "sub-quiet"] });
  updateUserPrefs("sub-dm", (p) => (p.delivery = "dm"));
  updateUserPrefs("sub-dm-gagal", (p) => (p.delivery = "dm"));
  const hour = getHourWIBOf(new Date());
  updateUserPrefs("sub-quiet", (p) => {
    p.quietStart = hour;
    p.quietEnd = (hour + 1) % 24;
  });
  failDmFor.add("sub-dm-gagal");

  const { bodies, restore } = captureWebhook();
  try {
    assert.equal(await sendDiscordNotif("Pengirim", "jkt48_pengirim", "slug-x", "start", null, null), true);
  } finally {
    restore();
    saveSubscriptions({});
  }
  const channel = bodies[0].content;
  assert.match(channel, /<@sub-plain>/);
  assert.match(channel, /<@sub-dm-gagal>/, "DM gagal -> ditag di channel");
  assert.doesNotMatch(channel, /<@sub-dm>/, "yang pilih DM tidak ditag");
  assert.doesNotMatch(channel, /<@sub-quiet>/, "jam tenang tidak ditag");
  assert.deepEqual(new Set(bodies[0].allowed_mentions.users), new Set(["sub-plain", "sub-dm-gagal"]));
  assert.deepEqual(
    dms.map((d) => d.id),
    ["sub-dm"],
  );
  assert.match(dms[0].content, /Pengirim.*lagi live/s);
  assert.match(dms[0].content, /cok notif tag/);
});

// ---------- perintah chat ----------
test("chat - oshi: tambah (ikut subscribe), profil, duplikat, batas, hapus (ikut unsubscribe)", async () => {
  recordLiveCompleted("jkt48_oshia", "Oshia JKT48");
  const user = "user-oshi-1";

  assert.match(await say("cok oshi saya", user), /belum punya oshi/);

  const added = await say("cok oshi oshia", user);
  assert.match(added, /sekarang oshi kamu/);
  assert.deepEqual(getUserPrefs(user).oshis, ["jkt48_oshia"]);
  assert.ok(loadSubscriptions().oshia?.includes(user), "oshi otomatis di-subscribe");

  assert.match(await say("cok oshi oshia", user), /udah jadi oshi kamu/);

  const profile = await say("cok oshi saya", user);
  assert.match(profile, /Oshi kamu\*\* \(1\/5\)/);
  assert.match(profile, /Oshia JKT48/);

  assert.match(await say("cok hapus oshi oshia", user), /dihapus dari oshi/);
  assert.deepEqual(getUserPrefs(user).oshis, []);
  assert.equal(loadSubscriptions().oshia, undefined, "subscribe ikut dimatikan");
  assert.match(await say("cok hapus oshi oshia", user), /bukan oshi kamu/);
});

test("chat - oshi: member gak dikenal ditolak, batas 5 oshi", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ data: null }) });
  try {
    assert.match(await say("cok oshi zzzmemberngawur", "user-oshi-2"), /zzzmemberngawur/);
    assert.deepEqual(getUserPrefs("user-oshi-2").oshis, []);
  } finally {
    global.fetch = originalFetch;
  }
  const names = ["Limaa", "Limab", "Limac", "Limad", "Limae", "Limaf"];
  names.forEach((n) => recordLiveCompleted(`jkt48_${n.toLowerCase()}`, `${n} JKT48`));
  for (const n of names.slice(0, 5)) assert.match(await say(`cok oshi ${n.toLowerCase()}`, "user-oshi-3"), /sekarang oshi kamu/);
  assert.match(await say("cok oshi limaf", "user-oshi-3"), /maksimal 5/);
});

test("chat - pengaturan: notif dm/tag, jam tenang (set/mati/salah), ringkasan, tampilan pengaturan", async () => {
  const user = "user-set-1";
  assert.match(await say("cok pengaturan", user), /di-tag di channel/);

  assert.match(await say("cok notif dm", user), /lewat \*\*DM\*\*/);
  assert.equal(getUserPrefs(user).delivery, "dm");
  assert.match(await say("cok pengaturan", user), /lewat DM/);
  assert.match(await say("cok notif tag", user), /di-tag di channel/);
  assert.equal(getUserPrefs(user).delivery, "tag");

  assert.match(await say("cok jam tenang 23-6", user), /23\.00-06\.00 WIB/);
  assert.equal(getUserPrefs(user).quietStart, 23);
  assert.match(await say("cok jam tenang 5 sampai 7", user), /05\.00-07\.00/);
  assert.match(await say("cok jam tenang 25-3", user), /angka 0-23/);
  assert.match(await say("cok jam tenang 8-8", user), /jangan sama/);
  assert.equal(getUserPrefs(user).quietStart, 5, "input salah tidak mengubah pengaturan");
  assert.match(await say("cok jam tenang mati", user), /dimatiin/);
  assert.equal(getUserPrefs(user).quietStart, null);

  assert.match(await say("cok ringkasan mati", user), /dimatiin/);
  assert.equal(getUserPrefs(user).digestOff, true);
  assert.match(await say("cok ringkasan hidup", user), /dihidupin/);
  assert.equal(getUserPrefs(user).digestOff, false);
});

test("chat - perintah personal tanpa authorId (mis. slash/tes) dijawab sopan, tidak error", async () => {
  const reply = textOf(await buildChatReply("cok oshi saya", { isBotChannel: true, authorId: null }));
  assert.match(reply, /perlu tau kamu siapa/);
});

test("chat - 'notif live semua' lama TIDAK tertangkap perintah baru (tetap alur role)", async () => {
  const reply = await buildChatReply("cok notif live semua", { isBotChannel: true, authorId: "user-role-x", channelId: "c" });
  assert.notEqual(reply, null);
  assert.doesNotMatch(textOf(reply), /Cara dikabari/);
});

// ---------- cok kelewat ----------
test("chat - kelewat: jendela eksplisit, daftar selesai + lagi live, oshi ditandai bintang, kosong -> tenang", async () => {
  const user = "user-kelewat-1";
  const now = Date.now();
  recordLiveEnded("Kelewata JKT48", "jkt48_kelewata", new Date(now - 100 * 60_000), new Date(now - 40 * 60_000), 321);
  recordLiveEnded("Kelewatb JKT48", "jkt48_kelewatb", new Date(now - 30 * 3600_000), new Date(now - 29 * 3600_000), null);
  activeLives.set("jkt48_kelewatc", {
    name: "Kelewatc JKT48",
    username: "jkt48_kelewatc",
    slug: "s",
    liveAt: new Date(now - 15 * 60_000).toISOString(),
    viewCount: 77,
  });
  updateUserPrefs(user, (p) => p.oshis.push("jkt48_kelewata"));
  try {
    const reply = await say("cok kelewat 3 jam", user);
    assert.match(reply, /Yang kelewat 3 jam terakhir/);
    assert.match(reply, /Lagi live sekarang/);
    assert.match(reply, /Kelewatc JKT48/);
    assert.match(reply, /⭐ .*Kelewata JKT48.*puncak/s);
    assert.doesNotMatch(reply, /Kelewatb/, "di luar jendela 3 jam");
    assert.match(reply, /⭐ = oshi kamu/);

    const wide = await say("cok kelewat 2 hari", user);
    assert.match(wide, /Kelewatb JKT48/);

    activeLives.delete("jkt48_kelewatc");
    const empty = await say("cok kelewat 10 menit", "user-kelewat-2");
    assert.match(empty, /Gak ada yang live/);
  } finally {
    activeLives.delete("jkt48_kelewatc");
  }
});

test("chat - kelewat tanpa jendela: pakai waktu aktif terakhir (min 2 jam), pertama kali -> 12 jam; waktu aktif dicatat setelah balasan", async () => {
  const user = "user-kelewat-3";
  assert.match(await say("cok kelewat", user), /pakai 12 jam/);
  // balasan di atas sudah mencatat lastSeen -> sekarang dasar jendelanya "sejak terakhir ngobrol"
  assert.ok(getUserPrefs(user).lastSeenAt, "lastSeen tercatat setelah dibalas");
  assert.match(await say("cok kelewat", user), /sejak terakhir kamu ngobrol sama bot/);
  assert.match(await say("cok kelewat", user), /Yang kelewat 2 jam terakhir/, "minimal 2 jam");
});

// ---------- ringkasan mingguan ----------
test("digestWeekKey - Minggu >= jam rekap, Senin pagi pakai Minggu kemarin, selain itu null", () => {
  assert.equal(digestWeekKey(new Date("2026-09-20T23:30:00+07:00")), "2026-09-20");
  assert.equal(digestWeekKey(new Date("2026-09-21T09:00:00+07:00")), "2026-09-20");
  assert.equal(digestWeekKey(new Date("2026-09-21T13:00:00+07:00")), null);
  assert.equal(digestWeekKey(new Date("2026-09-20T10:00:00+07:00")), null, "Minggu tapi belum jam rekap");
  assert.equal(digestWeekKey(new Date("2026-09-22T23:30:00+07:00")), null);
});

test("maybeSendOshiDigests - DM sekali per minggu per pengguna; mati/jam tenang/tanpa oshi dilewati; jam tenang ditunda ke Senin", async () => {
  recordLiveCompleted("jkt48_digesta", "Digesta JKT48");
  const now = Date.now();
  recordLiveEnded("Digesta JKT48", "jkt48_digesta", new Date(now - 3 * 3600_000), new Date(now - 2 * 3600_000), 150);

  updateUserPrefs("d-aktif", (p) => p.oshis.push("jkt48_digesta"));
  updateUserPrefs("d-mati", (p) => {
    p.oshis.push("jkt48_digesta");
    p.digestOff = true;
  });
  updateUserPrefs("d-tenang", (p) => {
    p.oshis.push("jkt48_digesta");
    p.quietStart = 22;
    p.quietEnd = 7;
  });
  updateUserPrefs("d-tanpa-oshi", (p) => (p.delivery = "dm"));

  const sundayNight = new Date("2026-09-20T23:30:00+07:00");
  await maybeSendOshiDigests(sundayNight);
  const recipients = () =>
    dms
      .map((d) => d.id)
      .filter((id) => id.startsWith("d-"))
      .sort(); // pengguna dari test lain (oshi) ikut terdaftar - cuma yang "d-" yang diperiksa
  assert.deepEqual(recipients(), ["d-aktif"], "d-tenang ditunda, d-mati & d-tanpa-oshi dilewati");
  const mine = dms.find((d) => d.id === "d-aktif").content;
  assert.match(mine, /Ringkasan mingguan oshi/);
  assert.match(mine, /Digesta JKT48/);
  assert.match(mine, /1x live/);

  await maybeSendOshiDigests(sundayNight);
  assert.deepEqual(recipients(), ["d-aktif"], "tidak dikirim dua kali");

  await maybeSendOshiDigests(new Date("2026-09-21T08:00:00+07:00")); // Senin, jam tenang sudah lewat (>= 7)
  assert.deepEqual(recipients(), ["d-aktif", "d-tenang"]);
  assert.equal(getUserPrefs("d-aktif").digestWeek, "2026-09-20");

  fakeClient = null;
  updateUserPrefs("d-aktif", (p) => (p.digestWeek = null));
  dms.length = 0;
  await maybeSendOshiDigests(sundayNight);
  assert.equal(dms.filter((d) => d.id.startsWith("d-")).length, 0, "tanpa client Discord: tidak error, tidak mengirim");
});

test("maybeSendOshiDigests - DM ditutup tidak diulang (sudah ditandai) dan tidak melempar error", async () => {
  recordLiveCompleted("jkt48_digestb", "Digestb JKT48");
  updateUserPrefs("d-ditutup", (p) => p.oshis.push("jkt48_digestb"));
  failDmFor.add("d-ditutup");
  const originalErr = console.error;
  console.error = () => {};
  try {
    const when = new Date("2026-09-27T23:30:00+07:00");
    await maybeSendOshiDigests(when);
    assert.equal(getUserPrefs("d-ditutup").digestWeek, "2026-09-27");
    failDmFor.clear();
    await maybeSendOshiDigests(when);
    assert.equal(dms.filter((d) => d.id === "d-ditutup").length, 0, "tidak dicoba ulang di minggu yang sama");
  } finally {
    console.error = originalErr;
  }
});
