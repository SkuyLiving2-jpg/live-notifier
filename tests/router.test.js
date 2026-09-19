require("./helpers/setupTestEnv");
// Owner ID palsu buat nge-tes gate "cuma owner boleh ubah prioritas" -
// dioverride di sini (bukan di setupTestEnv, yang sengaja ngosongin ini)
// biar dua-duanya (jalur owner vs bukan-owner) bisa dites beneran.
process.env.PRIORITY_PING_USER_ID = "owner-test-id";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { activeLives } = require("../src/storage/activeLives");
const { recordLiveDuration } = require("../src/storage/durationHistory");
const { buildChatReply } = require("../src/chat/router");

const OWNER = "owner-test-id";

// buildChatReply dipanggil BANYAK banget di file ini dengan member/keyword
// yang beda-beda tiap test (bukan di-reset per test) - dipilih nama unik per
// test biar gak numpang state test lain dalam 1 file/proses yang sama.

test("wake-word gate: di LUAR bot channel, pesan biasa tanpa 'cok'/pola tanya-live diabaikan (null)", async () => {
  const reply = await buildChatReply("halo, apa kabar semuanya", { isBotChannel: false });
  assert.equal(reply, null);
});

test("wake-word gate: nyebut 'cok' cukup buat kepick up walau di luar bot channel", async () => {
  const reply = await buildChatReply("cok siapa yang live?", { isBotChannel: false });
  assert.notEqual(reply, null);
});

test("wake-word gate: di DALAM bot channel, pesan apapun kepick up walau gak nyebut 'cok'/'live'", async () => {
  const reply = await buildChatReply("random banget nih pesannya", { isBotChannel: true, channelId: "c-gate", authorId: "u-gate" });
  assert.notEqual(reply, null);
  assert.ok(reply.components, "harus jatuh ke fallback menu (ada tombol)");
});

test("urutan regex: 'reminder' harus ketangkep SEBELUM pola subscribe 'ingetin' walau kalimatnya ngandung dua-duanya", async () => {
  const reply = await buildChatReply("cok reminder aku ingetin siapa aja", { authorId: "u-reminder-order" });
  assert.match(reply, /subscribe/i);
  assert.doesNotMatch(reply, /Sip, kamu bakal di-tag/); // BUKAN kepick up sebagai handleSubscribe
});

test("urutan regex: 'berhenti ingetin' harus ketangkep SEBELUM pola subscribe biasa 'ingetin'", async () => {
  const reply = await buildChatReply("cok berhenti ingetin ordertest", { authorId: "u-order-2" });
  assert.match(reply, /belum subscribe "ordertest"/);
});

test("ingetin (subscribe) - dispatch ke handleSubscribe", async () => {
  const reply = await buildChatReply("cok ingetin subscribetest", { authorId: "u-sub" });
  assert.match(reply, /Sip, kamu bakal di-tag tiap kali "subscribetest" mulai live/);
});

test("tambah prioritas - owner boleh, non-owner ditolak", async () => {
  const asOwner = await buildChatReply("cok tambah prioritas ownertestmember", { authorId: OWNER });
  assert.match(asOwner, /ditambahin ke daftar prioritas/);

  const asOther = await buildChatReply("cok tambah prioritas lainnyatestmember", { authorId: "bukan-owner" });
  assert.match(asOther, /cuma owner yang boleh/);
});

test("stats <nama> - dispatch ke replyMemberStats", async () => {
  const reply = await buildChatReply("cok stats statstestmember");
  assert.match(reply, /belum ada data riwayat live buat "statstestmember"/);
});

test("gifter <nama> - dispatch ke replyGifterSnapshot", async () => {
  const reply = await buildChatReply("cok gifter giftertestmember");
  assert.match(reply, /belum ada data top gifter buat "giftertestmember"/);
});

test("jadwal <nama> - dispatch ke replySchedulePattern", async () => {
  const reply = await buildChatReply("cok jadwal jadwaltestmember");
  assert.match(reply, /belum ada riwayat live buat "jadwaltestmember"/);
});

test("kapan <nama> live - pola alternatif buat replySchedulePattern (nama keapit 'kapan'...'live')", async () => {
  const reply = await buildChatReply("cok kapan kapantestmember live");
  assert.match(reply, /belum ada riwayat live buat "kapantestmember"/);
});

test("daftar prioritas - selalu ngandung 3 member bawaan", async () => {
  const reply = await buildChatReply("cok daftar prioritas");
  assert.match(reply, /NALA/);
  assert.match(reply, /LEVI/);
  assert.match(reply, /LILY/);
});

test("paling rame ditonton hari ini - dispatch ke replyTopViewers", async () => {
  const reply = await buildChatReply("cok siapa yang paling rame ditonton hari ini?");
  assert.match(reply, /Paling rame ditonton hari ini|belum ada data penonton/);
});

test("paling lama live hari ini - dispatch ke replyLongestLive", async () => {
  const reply = await buildChatReply("cok siapa yang paling lama live hari ini?");
  assert.match(reply, /Paling lama live hari ini|belum ada data live hari ini/);
});

// Beda dari "cok rekap" polos (replyTodayRecapSoFar) - replyRecapRange gak
// nyentuh network (gak ada lookup arsip eksternal), jadi aman dites
// langsung, dan penting buat mastiin urutan regex-nya bener: "rekap minggu
// ini"/"rekap bulan ini" harus ketangkep SEBELUM "rekap" polos, bukan
// malah kepick up sebagai rekap hari ini.
test("rekap minggu ini - dispatch ke replyRecapRange(7, ...), BUKAN rekap hari ini", async () => {
  const reply = await buildChatReply("cok rekap minggu ini");
  assert.match(reply, /Rekap minggu ini|belum ada live yang kecatet dalam minggu ini/);
  assert.doesNotMatch(reply, /Rekap live hari ini/);
});

test("rekap bulan ini - dispatch ke replyRecapRange(30, ...), BUKAN rekap hari ini", async () => {
  const reply = await buildChatReply("cok rekap bulan ini");
  assert.match(reply, /Rekap bulan ini|belum ada live yang kecatet dalam bulan ini/);
  assert.doesNotMatch(reply, /Rekap live hari ini/);
});

test("status - dispatch ke replyBotStatus", async () => {
  const reply = await buildChatReply("cok status");
  assert.match(reply, /Bot jalan normal/);
});

test("help/bantuan - dispatch ke replyHelp", async () => {
  const reply = await buildChatReply("cok bantuan");
  assert.match(reply, /^Cok bisa jawab ini:/);
});

test("member yang LAGI LIVE ketemu lewat fuzzy name match (activeLives)", async () => {
  activeLives.set("jkt48_routertest", {
    name: "Routertest",
    username: "jkt48_routertest",
    slug: "slug-router",
    liveAt: new Date().toISOString(),
    viewCount: 5,
  });
  try {
    const reply = await buildChatReply("cok routertest masih live?");
    assert.match(reply, /\*\*Routertest\*\* lagi live/);
  } finally {
    activeLives.delete("jkt48_routertest");
  }
});

test("member yang UDAH GAK LIVE tapi ada riwayat durasi - dikasih info terakhir live, bukan 'nggak ketemu'", async () => {
  recordLiveDuration("jkt48_histtest", "Histtest", 60_000);
  const reply = await buildChatReply("cok histtest masih live?");
  assert.match(reply, /\*\*Histtest\*\* lagi nggak live sekarang\. Terakhir live/);
});

test("pesan yang match wake-word tapi gak match pola manapun -> fallback menu, bukan diem", async () => {
  const reply = await buildChatReply("cok apaan sih ini asdkjaskjd", { channelId: "c-fallback", authorId: "u-fallback" });
  assert.ok(reply && typeof reply === "object" && reply.components, "harus balikin objek menu (content+components), bukan string command");
});
