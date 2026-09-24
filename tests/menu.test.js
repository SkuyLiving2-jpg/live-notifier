require("./helpers/setupTestEnv");

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { activeLives } = require("../src/storage/activeLives");
const { saveGifterSnapshot } = require("../src/storage/gifterSnapshot");
const {
  resolveBareMenuChoice,
  memberPromptQuestion,
  startWatchConfirm,
  startWatchConfirmForEntry,
  tryHandleWatchConfirmShortcut,
  handleWatchConfirmButton,
  handleFallbackMenuButton,
  handleFallbackMemberSelect,
} = require("../src/chat/menu");

// Fake discord.js interaction - handleFallbackMenuButton/handleFallbackMemberSelect/
// handleWatchConfirmButton cuma pernah nyentuh .customId/.channelId/.user.id/
// .values/.reply()/.update(), jadi gak butuh library mocking discord.js beneran.
function fakeInteraction({ customId, channelId = "c1", authorId = "u1", values = [] }) {
  const calls = [];
  const updates = [];
  return {
    customId,
    channelId,
    user: { id: authorId },
    values,
    reply: async (payload) => {
      calls.push(payload);
    },
    update: async (payload) => {
      updates.push(payload);
    },
    calls,
    updates,
  };
}

// resolveBareMenuChoice("8") sengaja GAK dites di sini - itu manggil
// replyTodayRecapSoFar() yang nge-fetch arsip eksternal via network (lihat
// storage/dailyLog.js's fetchExternalTodayLiveHistory), dan test unit
// sengaja dijauhin dari network call beneran (flaky/lambat/gak perlu).
test("resolveBareMenuChoice - dispatch table buat pilihan 1/2/3/5/6/7, null buat 4/9/gak dikenal", async () => {
  assert.match(await resolveBareMenuChoice("1", "c", "u"), /live/i);
  assert.match(await resolveBareMenuChoice("2", "c", "u"), /Bot jalan normal/);
  assert.match(await resolveBareMenuChoice("3", "c", "u"), /live hari ini/i);
  assert.match(await resolveBareMenuChoice("5", "c", "u"), /penonton|rame/i);
  assert.match(await resolveBareMenuChoice("6", "c", "u"), /NALA/);
  assert.match(await resolveBareMenuChoice("7", "c", "u"), /subscribe/i);
  assert.equal(await resolveBareMenuChoice("4", "c", "u"), null); // butuh nama, ditangani terpisah
  assert.equal(await resolveBareMenuChoice("9", "c", "u"), null);
  assert.equal(await resolveBareMenuChoice("99", "c", "u"), null);
});

test("memberPromptQuestion - teks beda buat opsi 4 (member) vs 9 (gifter)", () => {
  assert.match(memberPromptQuestion("4"), /Member yang mana/);
  assert.match(memberPromptQuestion("9"), /Gifter siapa/);
});

test("startWatchConfirmForEntry + tryHandleWatchConfirmShortcut - alur y/n dasar", () => {
  activeLives.set("jkt48_menutest", { name: "Menutest", username: "jkt48_menutest", slug: "s", liveAt: new Date().toISOString() });
  try {
    const question = startWatchConfirmForEntry(activeLives.get("jkt48_menutest"), "c-watch", "u-watch");
    assert.match(question.content, /Mau nonton sekarang\?/);
    assert.equal(question.components[0].components.length, 3, "harus 3 tombol: Ya/Enggak/Tutup");

    const yesReply = tryHandleWatchConfirmShortcut("y", "c-watch", "u-watch");
    assert.match(yesReply, /Gas nonton!/);

    // sekali jawab, pending-nya abis - jawab lagi harus null (gak ada yang ditunggu lagi)
    assert.equal(tryHandleWatchConfirmShortcut("y", "c-watch", "u-watch"), null);
  } finally {
    activeLives.delete("jkt48_menutest");
  }
});

test("tryHandleWatchConfirmShortcut - jawaban 'n'", () => {
  activeLives.set("jkt48_menutest2", { name: "Menutest2", username: "jkt48_menutest2", slug: "s", liveAt: new Date().toISOString() });
  try {
    startWatchConfirmForEntry(activeLives.get("jkt48_menutest2"), "c-watch2", "u-watch2");
    const noReply = tryHandleWatchConfirmShortcut("n", "c-watch2", "u-watch2");
    assert.match(noReply, /Oke sip\./);
  } finally {
    activeLives.delete("jkt48_menutest2");
  }
});

test("tryHandleWatchConfirmShortcut - jawaban bukan y/n diabaikan (null), pending TETEP hidup buat jawaban berikutnya", () => {
  activeLives.set("jkt48_menutest3", { name: "Menutest3", username: "jkt48_menutest3", slug: "s", liveAt: new Date().toISOString() });
  try {
    startWatchConfirmForEntry(activeLives.get("jkt48_menutest3"), "c-watch3", "u-watch3");
    assert.equal(tryHandleWatchConfirmShortcut("ngomong random", "c-watch3", "u-watch3"), null);
    // masih bisa dijawab beneran abis itu, gak keburu ke-consume sama percobaan gagal di atas
    assert.match(tryHandleWatchConfirmShortcut("y", "c-watch3", "u-watch3"), /Gas nonton!/);
  } finally {
    activeLives.delete("jkt48_menutest3");
  }
});

test("tryHandleWatchConfirmShortcut - jawaban y/n yang udah EXPIRED (>2 menit) dikasih pesan eksplisit, bukan diem-diem jatuh ke routing normal", () => {
  activeLives.set("jkt48_expiredtest", { name: "Expiredtest", username: "jkt48_expiredtest", slug: "s", liveAt: new Date().toISOString() });
  const originalNow = Date.now;
  try {
    startWatchConfirmForEntry(activeLives.get("jkt48_expiredtest"), "c-expired", "u-expired");
    Date.now = () => originalNow() + 3 * 60_000; // lompat 3 menit ke depan, ngelewatin TTL 2 menit
    const reply = tryHandleWatchConfirmShortcut("y", "c-expired", "u-expired");
    assert.match(reply, /kelamaan mikirnya/);

    // Pending-nya udah ke-consume walau expired (bukan cuma "diem"), jadi jawab lagi harus null.
    assert.equal(tryHandleWatchConfirmShortcut("y", "c-expired", "u-expired"), null);
  } finally {
    Date.now = originalNow;
    activeLives.delete("jkt48_expiredtest");
  }
});

test("tryHandleWatchConfirmShortcut - member udah kelar live pas user baru jawab -> dikasih tau, bukan link basi", () => {
  activeLives.set("jkt48_menutest4", { name: "Menutest4", username: "jkt48_menutest4", slug: "s", liveAt: new Date().toISOString() });
  startWatchConfirmForEntry(activeLives.get("jkt48_menutest4"), "c-watch4", "u-watch4");
  activeLives.delete("jkt48_menutest4"); // "keburu selesai" pas user lagi mikir

  const reply = tryHandleWatchConfirmShortcut("y", "c-watch4", "u-watch4");
  assert.match(reply, /kayaknya baru aja selesai live/);
});

// Owner minta pertanyaan "mau nonton?" jadi tombol (bukan ngetik y/n) DAN
// dikasih opsi "Tutup" kalau salah pencet member dari dropdown -
// handleWatchConfirmButton adalah tombolnya. customId bawa username LANGSUNG
// (self-contained kayak recap_nav's tombol) - gak nunggu pendingWatchConfirm
// buat FUNGSI, jadi dites langsung lewat customId, gak perlu startWatchConfirmForEntry
// dipanggil duluan.
test("handleWatchConfirmButton - action 'yes' EDIT pesan yang ada (update) jadi link nonton, BUKAN pesan baru", async () => {
  activeLives.set("jkt48_wcbtn", { name: "Wcbtn", username: "jkt48_wcbtn", slug: "slug-wcbtn", liveAt: new Date().toISOString() });
  try {
    const interaction = fakeInteraction({ customId: "watch_confirm:yes:jkt48_wcbtn" });
    await handleWatchConfirmButton(interaction);
    assert.equal(interaction.calls.length, 0, "gak boleh kirim pesan baru");
    assert.match(interaction.updates[0].content, /Gas nonton!.*Wcbtn.*https:\/\/idn\.app\/jkt48_wcbtn\/live\/slug-wcbtn/s);
    assert.deepEqual(interaction.updates[0].components, []);
  } finally {
    activeLives.delete("jkt48_wcbtn");
  }
});

test("handleWatchConfirmButton - action 'no' EDIT pesan yang ada jadi 'oke sip', BUKAN pesan baru", async () => {
  activeLives.set("jkt48_wcbtn2", { name: "Wcbtn2", username: "jkt48_wcbtn2", slug: "s", liveAt: new Date().toISOString() });
  try {
    const interaction = fakeInteraction({ customId: "watch_confirm:no:jkt48_wcbtn2" });
    await handleWatchConfirmButton(interaction);
    assert.equal(interaction.calls.length, 0);
    assert.match(interaction.updates[0].content, /Oke sip\. \*\*Wcbtn2\*\*/);
  } finally {
    activeLives.delete("jkt48_wcbtn2");
  }
});

test("handleWatchConfirmButton - action 'close' EDIT pesan yang ada jadi 'dibatalin', TANPA re-cek status live sama sekali", async () => {
  const interaction = fakeInteraction({ customId: "watch_confirm:close:jkt48_wcbtn3" });
  await handleWatchConfirmButton(interaction);
  assert.equal(interaction.calls.length, 0);
  assert.match(interaction.updates[0].content, /Oke, dibatalin/);
  assert.deepEqual(interaction.updates[0].components, []);
});

// Member-nya udah kelar live PAS diklik (button self-contained, gak kena
// TTL kayak jalur teks, jadi ini bisa kejadian kapan aja) - dikasih tau,
// bukan link basi. Namanya diambil dari pendingWatchConfirm (fallback) kalau
// activeLives-nya udah kehapus.
test("handleWatchConfirmButton - member udah kelar live pas diklik -> dikasih tau (nama dari pendingWatchConfirm), bukan link basi", async () => {
  activeLives.set("jkt48_wcbtn4", { name: "Wcbtn4", username: "jkt48_wcbtn4", slug: "s", liveAt: new Date().toISOString() });
  startWatchConfirmForEntry(activeLives.get("jkt48_wcbtn4"), "c1", "u1"); // ngisi pendingWatchConfirm buat fallback nama
  activeLives.delete("jkt48_wcbtn4"); // "keburu selesai" pas user lagi mikir mau klik

  const interaction = fakeInteraction({ customId: "watch_confirm:yes:jkt48_wcbtn4" });
  await handleWatchConfirmButton(interaction);
  assert.match(interaction.updates[0].content, /Yah, \*\*Wcbtn4\*\* kayaknya baru aja selesai live/);
});

// Abis dijawab lewat tombol, jawaban TEKS "y"/"n" yang nyasar berikutnya
// (misal orangnya lupa udah klik tombol) gak boleh diem-diem nyangkut ke
// pending state teks yang sama.
test("handleWatchConfirmButton - abis diklik, pendingWatchConfirm buat orang itu ke-clear (jawaban teks 'y' abis itu gak nyasar)", async () => {
  activeLives.set("jkt48_wcbtn5", { name: "Wcbtn5", username: "jkt48_wcbtn5", slug: "s", liveAt: new Date().toISOString() });
  try {
    startWatchConfirmForEntry(activeLives.get("jkt48_wcbtn5"), "c-wcclear", "u-wcclear");
    const interaction = fakeInteraction({ customId: "watch_confirm:no:jkt48_wcbtn5", channelId: "c-wcclear", authorId: "u-wcclear" });
    await handleWatchConfirmButton(interaction);

    assert.equal(tryHandleWatchConfirmShortcut("y", "c-wcclear", "u-wcclear"), null);
  } finally {
    activeLives.delete("jkt48_wcbtn5");
  }
});

test("startWatchConfirm - fuzzy name search: ketemu -> tanya y/n, gak ketemu -> replyMemberNotFound", () => {
  activeLives.set("jkt48_fuzzytest", { name: "Fuzzytest", username: "jkt48_fuzzytest", slug: "s", liveAt: new Date().toISOString() });
  try {
    assert.match(startWatchConfirm("fuzzytest", "c-fz", "u-fz").content, /Mau nonton sekarang/);
    assert.match(startWatchConfirm("member-yang-gak-ada", "c-fz2", "u-fz2"), /nggak nemu member/);
  } finally {
    activeLives.delete("jkt48_fuzzytest");
  }
});

test("handleFallbackMenuButton - opsi 4 (cek member) balikin dropdown kalau ada yang live, jawaban final PUBLIK (bukan ephemeral) kalau kosong", async () => {
  const emptyInteraction = fakeInteraction({ customId: "fallback_menu:4" });
  await handleFallbackMenuButton(emptyInteraction);
  assert.equal(emptyInteraction.calls.length, 1);
  assert.match(emptyInteraction.calls[0].content, /nggak ada member JKT48 yang live/);
  // Gak ada `ephemeral` di payload-nya - sama kayak replyListLive() via teks,
  // jadi otomatis publik, konsisten sama balesan teks yang setara. Semua
  // reply (lewat safeReplyOptions, lihat utils.js) sekarang SELALU jadi
  // object {content, ...}, gak pernah string mentah lagi - itu yang matiin
  // allowedMentions implisit (@everyone/@here/role) dari teks yang di-echo.
  assert.deepEqual(emptyInteraction.calls[0].allowedMentions, { parse: [] });

  activeLives.set("jkt48_dropdowntest", { name: "Dropdowntest", username: "jkt48_dropdowntest", slug: "s", liveAt: new Date().toISOString() });
  try {
    const withDataInteraction = fakeInteraction({ customId: "fallback_menu:4" });
    await handleFallbackMenuButton(withDataInteraction);
    assert.match(withDataInteraction.calls[0].content, /Mau cek member yang mana/);
    assert.ok(withDataInteraction.calls[0].components, "harus ada dropdown select menu");
  } finally {
    activeLives.delete("jkt48_dropdowntest");
  }
});

test("handleFallbackMenuButton - opsi 9 (top gifter) balikin dropdown kalau ada data, jawaban final PUBLIK (bukan ephemeral) kalau kosong", async () => {
  const emptyInteraction = fakeInteraction({ customId: "fallback_menu:9" });
  await handleFallbackMenuButton(emptyInteraction);
  assert.match(emptyInteraction.calls[0].content, /belum ada data top gifter buat siapapun/);

  saveGifterSnapshot({ members: { jkt48_giftermenutest: { name: "Giftermenutest", gifters: [], checkedAt: new Date().toISOString() } } });
  const withDataInteraction = fakeInteraction({ customId: "fallback_menu:9" });
  await handleFallbackMenuButton(withDataInteraction);
  assert.match(withDataInteraction.calls[0].content, /Mau cek top gifter member yang mana/);
});

test("handleFallbackMenuButton - opsi bare (mis. 1) langsung diteruskan ke resolveBareMenuChoice", async () => {
  const interaction = fakeInteraction({ customId: "fallback_menu:2" });
  await handleFallbackMenuButton(interaction);
  assert.match(interaction.calls[0].content, /Bot jalan normal/);
});

test("handleFallbackMemberSelect - opsi 4: member yang dipilih dari dropdown lagi live -> tanya y/n; udah gak live -> replyMemberNotFound", async () => {
  activeLives.set("jkt48_selecttest", { name: "Selecttest", username: "jkt48_selecttest", slug: "s", liveAt: new Date().toISOString() });
  try {
    const interaction = fakeInteraction({ customId: "fallback_select:4", values: ["jkt48_selecttest"] });
    await handleFallbackMemberSelect(interaction);
    assert.match(interaction.calls[0].content, /Mau nonton sekarang/);
  } finally {
    activeLives.delete("jkt48_selecttest");
  }

  const goneInteraction = fakeInteraction({ customId: "fallback_select:4", values: ["jkt48_selecttest"] });
  await handleFallbackMemberSelect(goneInteraction);
  assert.match(goneInteraction.calls[0].content, /nggak nemu member/);
});

test("handleFallbackMemberSelect - opsi 9: langsung ambil dari username dropdown (bukan fuzzy search)", async () => {
  saveGifterSnapshot({
    members: {
      jkt48_selectgiftertest: { name: "Selectgiftertest", gifters: [{ name: "Fan1", total_gold: 500 }], checkedAt: new Date().toISOString() },
    },
  });
  const interaction = fakeInteraction({ customId: "fallback_select:9", values: ["jkt48_selectgiftertest"] });
  await handleFallbackMemberSelect(interaction);
  assert.match(interaction.calls[0].content, /Top Gifter Selectgiftertest/);
});
