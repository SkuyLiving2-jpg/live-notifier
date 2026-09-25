require("./helpers/setupTestEnv");

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { activeLives } = require("../src/storage/activeLives");
const { recordLiveEnded } = require("../src/storage/dailyLog");
const { recordLiveCompleted } = require("../src/storage/liveCount");
const {
  replyMemberChannelFallback,
  replyMemberLiveToday,
  replyMemberLiveCount,
  replyMemberLiveHistoryTable,
  replyMemberLiveStatus,
  replyMemberWatchNow,
  handleMemberChannelFallbackButton,
} = require("../src/chat/memberChannelReply");

// Fake discord.js interaction - sama pola kayak tests/menu.test.js's
// fakeInteraction, handleMemberChannelFallbackButton cuma pernah nyentuh
// .customId/.update(), jadi gak butuh library mocking discord.js beneran.
function fakeInteraction(customId) {
  const calls = [];
  const updates = [];
  const deferUpdateCalls = [];
  const deletedMessageIds = [];
  return {
    customId,
    message: { id: `fake-msg-${customId}`, delete: async () => deletedMessageIds.push(`fake-msg-${customId}`) },
    reply: async (payload) => calls.push(payload),
    update: async (payload) => updates.push(payload),
    deferUpdate: async () => deferUpdateCalls.push(true),
    calls,
    updates,
    deferUpdateCalls,
    deletedMessageIds,
  };
}

test("replyMemberChannelFallback - nunjukkin nama member + 4 tombol opsi (3 pertanyaan + Tutup)", () => {
  activeLives.set("jkt48_mcrfallback", { name: "Mcrfallback", username: "jkt48_mcrfallback", slug: "s", liveAt: new Date().toISOString() });
  try {
    const reply = replyMemberChannelFallback("jkt48_mcrfallback");
    assert.match(reply.content, /\*\*Mcrfallback\*\*/);
    assert.equal(reply.components.length, 1);
    assert.equal(reply.components[0].components.length, 4);
  } finally {
    activeLives.delete("jkt48_mcrfallback");
  }
});

test("replyMemberChannelFallback - member yang gak lagi live/gak ada di liveCount -> fallback pake username mentah sebagai nama", () => {
  const reply = replyMemberChannelFallback("jkt48_mcrunknown");
  assert.match(reply.content, /\*\*jkt48_mcrunknown\*\*/);
});

test("replyMemberLiveToday - belum live hari ini -> bilang belum, gak ada tombol", () => {
  const reply = replyMemberLiveToday("jkt48_mcrtoday_none");
  assert.match(reply.content, /belum live hari ini/);
  assert.equal(reply.components, undefined);
});

test("replyMemberLiveToday - udah live 1x hari ini (sesi selesai) -> ngitung bener", () => {
  const now = new Date();
  recordLiveEnded("Mcrtoday", "jkt48_mcrtoday", new Date(now.getTime() - 3600_000), new Date(now.getTime() - 1800_000), 50);
  const reply = replyMemberLiveToday("jkt48_mcrtoday");
  assert.match(reply.content, /udah live 1x hari ini/);
  assert.doesNotMatch(reply.content, /lagi berlangsung sekarang/);
});

test("replyMemberLiveToday - gabungan sesi SELESAI hari ini + yang LAGI LIVE SEKARANG", () => {
  const now = new Date();
  recordLiveEnded("Mcrtoday2", "jkt48_mcrtoday2", new Date(now.getTime() - 3600_000), new Date(now.getTime() - 1800_000), 50);
  activeLives.set("jkt48_mcrtoday2", { name: "Mcrtoday2", username: "jkt48_mcrtoday2", slug: "s", liveAt: now.toISOString() });
  try {
    const reply = replyMemberLiveToday("jkt48_mcrtoday2");
    assert.match(reply.content, /udah live 2x hari ini \(salah satunya lagi berlangsung sekarang\)/);
  } finally {
    activeLives.delete("jkt48_mcrtoday2");
  }
});

test("replyMemberLiveCount - belum ada catatan live sama sekali -> bilang belum ada, gak ada tombol", () => {
  const reply = replyMemberLiveCount("jkt48_mcrcount_none");
  assert.match(reply.content, /belum ada catatan live buat/);
  assert.equal(reply.components, undefined);
});

test("replyMemberLiveCount - ada catatan -> sebut total count + tawarin tombol y/n liat history", () => {
  recordLiveCompleted("jkt48_mcrcount", "Mcrcount");
  recordLiveCompleted("jkt48_mcrcount", "Mcrcount");
  const reply = replyMemberLiveCount("jkt48_mcrcount");
  assert.match(reply.content, /udah live \*\*2x\*\* semenjak bot ini mantau/);
  assert.equal(reply.components[0].components.length, 2);
});

test("replyMemberLiveHistoryTable - ada sesi ke-track -> tabel muncul nyebut nama membernya", () => {
  const now = new Date();
  recordLiveEnded("Mcrhist", "jkt48_mcrhist", new Date(now.getTime() - 3600_000), new Date(now.getTime() - 1800_000), 50);
  recordLiveCompleted("jkt48_mcrhist", "Mcrhist"); // nama displaynya diambil dari sini (liveCount), bukan dailyLog
  const reply = replyMemberLiveHistoryTable("jkt48_mcrhist");
  assert.match(reply.content, /History live \*\*Mcrhist\*\*/);
  assert.match(reply.content, /Mcrhist/);
});

test("replyMemberLiveHistoryTable - gak ada sesi ke-track (udah lewat retensi/emang belum pernah) -> bilang gak kesimpen lagi", () => {
  const reply = replyMemberLiveHistoryTable("jkt48_mcrhist_none");
  assert.match(reply.content, /udah nggak kesimpen lagi/);
});

test("replyMemberLiveStatus - lagi nggak live -> jawaban final, gak ada tombol", () => {
  const reply = replyMemberLiveStatus("jkt48_mcrstatus_none");
  assert.match(reply.content, /lagi nggak live sekarang/);
  assert.equal(reply.components, undefined);
});

test("replyMemberLiveStatus - lagi live -> tawarin tombol y/n mau nonton", () => {
  activeLives.set("jkt48_mcrstatus", { name: "Mcrstatus", username: "jkt48_mcrstatus", slug: "slug-x", liveAt: new Date().toISOString() });
  try {
    const reply = replyMemberLiveStatus("jkt48_mcrstatus");
    assert.match(reply.content, /lagi live nih.*Mau nonton live-nya\?/s);
    assert.equal(reply.components[0].components.length, 2);
  } finally {
    activeLives.delete("jkt48_mcrstatus");
  }
});

test("replyMemberWatchNow - masih live -> kasih link idn.app", () => {
  activeLives.set("jkt48_mcrwatch", { name: "Mcrwatch", username: "jkt48_mcrwatch", slug: "slug-y", liveAt: new Date().toISOString() });
  try {
    const reply = replyMemberWatchNow("jkt48_mcrwatch");
    assert.match(reply.content, /https:\/\/idn\.app\/jkt48_mcrwatch\/live\/slug-y/);
  } finally {
    activeLives.delete("jkt48_mcrwatch");
  }
});

test("replyMemberWatchNow - keburu selesai live pas user mikir -> dikasih tau, bukan link basi", () => {
  const reply = replyMemberWatchNow("jkt48_mcrwatch_gone");
  assert.match(reply.content, /kayaknya baru aja selesai live/);
});

// BUG SEBELUMNYA: semua cabang di sini dulu pake interaction.reply() (pesan
// BARU per klik) - channel khusus member numpuk pesan tiap kali ada tombol
// dipencet, persis keluhan yang udah dibenerin duluan buat menu 9-opsi/tabel
// rekap. Sekarang SEMUA harus lewat interaction.update() (EDIT pesan yang
// sama), gak pernah manggil .reply() sama sekali - dites eksplisit lewat
// assert.equal(interaction.calls.length, 0) di tiap cabang.
test("handleMemberChannelFallbackButton - dispatch table lengkap buat tiap action, SEMUA lewat update() bukan reply()", async () => {
  activeLives.set("jkt48_mcrbtn", { name: "Mcrbtn", username: "jkt48_mcrbtn", slug: "s", liveAt: new Date().toISOString() });
  recordLiveCompleted("jkt48_mcrbtn", "Mcrbtn");
  try {
    const today = fakeInteraction("member_fallback:today:jkt48_mcrbtn");
    await handleMemberChannelFallbackButton(today);
    assert.equal(today.calls.length, 0, "gak boleh reply() pesan baru");
    assert.match(today.updates[0].content, /Mcrbtn/);
    assert.equal(today.updates[0].components.length, 1, "jawaban polos -> menu 3-opsi+Tutup ditempelin balik");

    const count = fakeInteraction("member_fallback:count:jkt48_mcrbtn");
    await handleMemberChannelFallbackButton(count);
    assert.equal(count.calls.length, 0);
    assert.match(count.updates[0].content, /udah live \*\*1x\*\*/);
    assert.equal(count.updates[0].components[0].components.length, 2, "punya data -> tombol y/n history sendiri, BUKAN menu 3-opsi");

    const status = fakeInteraction("member_fallback:status:jkt48_mcrbtn");
    await handleMemberChannelFallbackButton(status);
    assert.equal(status.calls.length, 0);
    assert.match(status.updates[0].content, /lagi live nih/);
    assert.equal(status.updates[0].components[0].components.length, 2, "lagi live -> tombol y/n nonton sendiri, BUKAN menu 3-opsi");

    const historyYes = fakeInteraction("member_fallback:history_yes:jkt48_mcrbtn");
    await handleMemberChannelFallbackButton(historyYes);
    assert.equal(historyYes.calls.length, 0);
    assert.match(historyYes.updates[0].content, /udah nggak kesimpen lagi|History live/);
    assert.equal(historyYes.updates[0].components.length, 1, "abis nunjukkin tabel -> menu 3-opsi+Tutup ditempelin balik");

    const watchYes = fakeInteraction("member_fallback:watch_yes:jkt48_mcrbtn");
    await handleMemberChannelFallbackButton(watchYes);
    assert.equal(watchYes.calls.length, 0);
    assert.match(watchYes.updates[0].content, /Gas nonton!/);
    assert.deepEqual(watchYes.updates[0].components, [], "jawaban final y/n -> tombol dikosongin, bukan menu lagi");

    const historyNo = fakeInteraction("member_fallback:history_no:jkt48_mcrbtn");
    await handleMemberChannelFallbackButton(historyNo);
    assert.equal(historyNo.calls.length, 0);
    assert.match(historyNo.updates[0].content, /terima kasih ya, semoga enjoy/);
    assert.deepEqual(historyNo.updates[0].components, []);

    const watchNo = fakeInteraction("member_fallback:watch_no:jkt48_mcrbtn");
    await handleMemberChannelFallbackButton(watchNo);
    assert.equal(watchNo.calls.length, 0);
    assert.match(watchNo.updates[0].content, /terima kasih ya, semoga enjoy/);
    assert.deepEqual(watchNo.updates[0].components, []);

    // §10's thirty-fifth item: dulu diedit jadi teks "Oke, dibatalin." +
    // components:[], sekarang BENERAN ngehapus pesannya - konsisten sama
    // semua tombol Tutup lain di bot ini.
    const close = fakeInteraction("member_fallback:close:jkt48_mcrbtn");
    await handleMemberChannelFallbackButton(close);
    assert.equal(close.calls.length, 0);
    assert.equal(close.updates.length, 0, "gak boleh update() jadi teks apapun");
    assert.equal(close.deferUpdateCalls.length, 1);
    assert.deepEqual(close.deletedMessageIds, [close.message.id]);
  } finally {
    activeLives.delete("jkt48_mcrbtn");
  }
});

test("handleMemberChannelFallbackButton - jawaban kosong (gak ada data/gak lagi live) -> menu 3-opsi ditempelin balik, bukan dead-end", async () => {
  const count = fakeInteraction("member_fallback:count:jkt48_mcrbtn_empty");
  await handleMemberChannelFallbackButton(count);
  assert.match(count.updates[0].content, /belum ada catatan live buat/);
  assert.equal(count.updates[0].components.length, 1);
  assert.equal(count.updates[0].components[0].components.length, 4);

  const status = fakeInteraction("member_fallback:status:jkt48_mcrbtn_empty");
  await handleMemberChannelFallbackButton(status);
  assert.match(status.updates[0].content, /lagi nggak live sekarang/);
  assert.equal(status.updates[0].components.length, 1);
  assert.equal(status.updates[0].components[0].components.length, 4);
});

test("handleMemberChannelFallbackButton - semua update lewat safeReplyOptions (allowedMentions nge-matiin mention implisit)", async () => {
  const interaction = fakeInteraction("member_fallback:today:jkt48_mcrmention");
  await handleMemberChannelFallbackButton(interaction);
  assert.deepEqual(interaction.updates[0].allowedMentions, { parse: [] });
});

test("handleMemberChannelFallbackButton - action gak dikenal -> gak manggil reply/update sama sekali", async () => {
  const interaction = fakeInteraction("member_fallback:asdf:jkt48_mcrunknownaction");
  await handleMemberChannelFallbackButton(interaction);
  assert.equal(interaction.calls.length, 0);
  assert.equal(interaction.updates.length, 0);
});
