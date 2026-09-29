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
const { markMenuShown, tryHandleMenuShortcut } = require("../src/chat/pendingState");

// Fake discord.js interaction - handleFallbackMenuButton/handleFallbackMemberSelect/
// handleWatchConfirmButton cuma pernah nyentuh .customId/.channelId/.user.id/
// .values/.reply()/.update()/.deferUpdate()/.message.delete(), jadi gak butuh
// library mocking discord.js beneran.
function fakeInteraction({ customId, channelId = "c1", authorId = "u1", values = [] }) {
  const calls = [];
  const updates = [];
  const deferUpdateCalls = [];
  const deletedMessageIds = [];
  return {
    customId,
    channelId,
    user: { id: authorId },
    values,
    message: { id: `fake-msg-${channelId}-${authorId}`, delete: async () => deletedMessageIds.push(`fake-msg-${channelId}-${authorId}`) },
    reply: async (payload) => {
      calls.push(payload);
    },
    update: async (payload) => {
      updates.push(payload);
    },
    deferUpdate: async () => {
      deferUpdateCalls.push(true);
    },
    calls,
    updates,
    deferUpdateCalls,
    deletedMessageIds,
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

// §10's thirty-fifth item: dulu diedit jadi teks "Oke, dibatalin." +
// components:[], sekarang BENERAN ngehapus pesannya - konsisten sama tombol
// Tutup lain di bot ini (gak perlu re-cek status live sama sekali buat ini,
// pesannya cuma dihapus).
test("handleWatchConfirmButton - action 'close' BENERAN ngehapus pesannya (message.delete), TANPA re-cek status live sama sekali", async () => {
  const interaction = fakeInteraction({ customId: "watch_confirm:close:jkt48_wcbtn3" });
  await handleWatchConfirmButton(interaction);
  assert.equal(interaction.calls.length, 0);
  assert.equal(interaction.updates.length, 0, "gak boleh update() jadi teks apapun");
  assert.equal(interaction.deferUpdateCalls.length, 1);
  assert.deepEqual(interaction.deletedMessageIds, [interaction.message.id]);
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

// BUG SEBELUMNYA: pendingWatchConfirm di-key per channel+author DOANG (bukan
// per pesan/member) - kalau user nanya "4 <member A>" (pesan A) terus,
// SEBELUM ngejawab, nanya lagi "4 <member B>" (pesan B, channel+author yang
// SAMA), pending-nya ke-TIMPA jadi punya B. Kalau A keburu selesai live
// duluan dan user balik ke pesan A (yang LAMA) buat mencet tombolnya,
// fallback nama-nya dulu polos `pending?.name` - ngasih nama B, padahal yang
// diklik jelas-jelas tombol punya A. Sekarang pending cuma dipercaya sebagai
// fallback nama kalau `pending.username`-nya masih cocok sama username yang
// dibawa tombol yang beneran diklik - kalau enggak (kasus ini), jatuh ke
// "member ini" generik, bukan nama member LAIN yang salah.
test("handleWatchConfirmButton - pendingWatchConfirm ke-timpa sama query MEMBER LAIN (channel+author sama) -> fallback nama TIDAK ngasih nama member lain yang salah", async () => {
  activeLives.set("jkt48_wcbtnA", { name: "WcbtnA", username: "jkt48_wcbtnA", slug: "s", liveAt: new Date().toISOString() });
  activeLives.set("jkt48_wcbtnB", { name: "WcbtnB", username: "jkt48_wcbtnB", slug: "s", liveAt: new Date().toISOString() });
  try {
    // "4 A" duluan (pesan A), terus "4 B" (pesan B) SEBELUM pesan A dijawab -
    // pendingWatchConfirm buat channel+author ini sekarang punya B.
    startWatchConfirmForEntry(activeLives.get("jkt48_wcbtnA"), "c-wccross", "u-wccross");
    startWatchConfirmForEntry(activeLives.get("jkt48_wcbtnB"), "c-wccross", "u-wccross");

    activeLives.delete("jkt48_wcbtnA"); // A keburu selesai live duluan

    // User balik ke pesan A (YANG LAMA) dan mencet tombolnya - customId-nya
    // masih bawa username A, walau pending-nya sekarang punya B.
    const interaction = fakeInteraction({ customId: "watch_confirm:yes:jkt48_wcbtnA", channelId: "c-wccross", authorId: "u-wccross" });
    await handleWatchConfirmButton(interaction);

    assert.match(interaction.updates[0].content, /Yah, \*\*member ini\*\* kayaknya baru aja selesai live/);
    assert.doesNotMatch(interaction.updates[0].content, /WcbtnB/, "gak boleh salah ngasih nama member LAIN (B)");
  } finally {
    activeLives.delete("jkt48_wcbtnA");
    activeLives.delete("jkt48_wcbtnB");
  }
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

test("handleFallbackMenuButton - opsi 4 (cek member) EDIT pesan menu (update), BUKAN pesan baru - dropdown kalau ada yang live, jawaban langsung + menu ditempel lagi kalau kosong", async () => {
  const emptyInteraction = fakeInteraction({ customId: "fallback_menu:4" });
  await handleFallbackMenuButton(emptyInteraction);
  assert.equal(emptyInteraction.calls.length, 0, "gak boleh reply() pesan baru");
  assert.match(emptyInteraction.updates[0].content, /nggak ada member JKT48 yang live/);
  // Semua reply (lewat safeReplyOptions, lihat utils.js) sekarang SELALU
  // jadi object {content, ...}, gak pernah string mentah lagi - itu yang
  // matiin allowedMentions implisit (@everyone/@here/role) dari teks yang
  // di-echo.
  assert.deepEqual(emptyInteraction.updates[0].allowedMentions, { parse: [] });
  // Menu ditempel ULANG di bawah jawaban - biar user bisa lanjut mencet opsi
  // LAIN dari pesan yang sama, gak numpuk pesan baru. Sekarang paginated
  // (lihat MENU_PAGES di menu.js) - tiap halaman cuma 2 baris (3 tombol opsi
  // + baris "Tutup"/"Menu lainnya"), opsi "4" ada di halaman PERTAMA jadi
  // menu yang ditempel balik ya halaman itu juga.
  assert.equal(emptyInteraction.updates[0].components.length, 2);
  assert.equal(emptyInteraction.updates[0].components[0].components[0].data.custom_id, "fallback_menu:1");

  activeLives.set("jkt48_dropdowntest", { name: "Dropdowntest", username: "jkt48_dropdowntest", slug: "s", liveAt: new Date().toISOString() });
  try {
    const withDataInteraction = fakeInteraction({ customId: "fallback_menu:4" });
    await handleFallbackMenuButton(withDataInteraction);
    assert.equal(withDataInteraction.calls.length, 0, "gak boleh reply() pesan baru");
    assert.match(withDataInteraction.updates[0].content, /Mau cek member yang mana/);
    assert.ok(withDataInteraction.updates[0].components, "harus ada dropdown select menu");
    // Baris ke-2 harus tombol "Tutup" + "Kembali" - owner ngeluh gak ada cara
    // batalin/balik kalau salah pencet opsi 4 dan gak jadi mau milih member.
    // "Kembali"-nya bawa nomor halaman ASAL opsi 4 (halaman pertama, index 0)
    // di customId-nya, biar baliknya ke halaman yang bener (lihat
    // pageIndexForOption di menu.js).
    const actionRow = withDataInteraction.updates[0].components[1];
    assert.equal(actionRow.components[0].data.custom_id, "fallback_menu:close");
    assert.equal(actionRow.components[0].data.label, "Tutup");
    assert.equal(actionRow.components[1].data.custom_id, "fallback_menu:back:0");
    assert.equal(actionRow.components[1].data.label, "Kembali");
  } finally {
    activeLives.delete("jkt48_dropdowntest");
  }
});

test("handleFallbackMenuButton - opsi 9 (top gifter) EDIT pesan menu (update), BUKAN pesan baru - dropdown kalau ada data, jawaban langsung + menu ditempel lagi kalau kosong", async () => {
  const emptyInteraction = fakeInteraction({ customId: "fallback_menu:9" });
  await handleFallbackMenuButton(emptyInteraction);
  assert.equal(emptyInteraction.calls.length, 0, "gak boleh reply() pesan baru");
  assert.match(emptyInteraction.updates[0].content, /belum ada data top gifter buat siapapun/);
  assert.equal(emptyInteraction.updates[0].components.length, 2, "menu (2 baris, lihat komen di test opsi 4) ditempel ulang");

  saveGifterSnapshot({ members: { jkt48_giftermenutest: { name: "Giftermenutest", gifters: [], checkedAt: new Date().toISOString() } } });
  const withDataInteraction = fakeInteraction({ customId: "fallback_menu:9" });
  await handleFallbackMenuButton(withDataInteraction);
  assert.match(withDataInteraction.updates[0].content, /Mau cek top gifter member yang mana/);
  // Opsi "9" ada di halaman KEDUA (index 1) - "Kembali"-nya harus balik ke
  // situ, bukan ke halaman pertama.
  const actionRow = withDataInteraction.updates[0].components[1];
  assert.equal(actionRow.components[0].data.custom_id, "fallback_menu:close");
  assert.equal(actionRow.components[1].data.custom_id, "fallback_menu:back:1");
});

// §10's thirty-fifth item: dulu diedit jadi teks "Oke, dibatalin." +
// components:[], sekarang BENERAN ngehapus pesannya (sama kayak
// fallback_menu:delete di menu - dua-duanya sekarang identik).
test("handleFallbackMenuButton - tombol 'Tutup' di bawah dropdown 4/9 BENERAN ngehapus pesannya, gak diedit jadi teks 'dibatalin'", async () => {
  const interaction = fakeInteraction({ customId: "fallback_menu:close" });
  await handleFallbackMenuButton(interaction);
  assert.equal(interaction.calls.length, 0, "gak boleh reply() pesan baru");
  assert.equal(interaction.updates.length, 0, "gak boleh update() jadi teks apapun");
  assert.equal(interaction.deferUpdateCalls.length, 1);
  assert.deepEqual(interaction.deletedMessageIds, [interaction.message.id]);
});

test("handleFallbackMenuButton - tombol 'Kembali' bawa nomor halaman ASAL (customId 'fallback_menu:back:<page>') - EDIT pesan balik ke halaman itu, BUKAN pesan baru", async () => {
  // Halaman pertama (index 0, default kalau customId gak bawa nomor halaman
  // - dulu customId-nya cuma "fallback_menu:back" polos).
  const firstPage = fakeInteraction({ customId: "fallback_menu:back:0" });
  await handleFallbackMenuButton(firstPage);
  assert.equal(firstPage.calls.length, 0, "gak boleh reply() pesan baru");
  assert.match(firstPage.updates[0].content, /Klik salah satu di bawah/);
  const firstPageIds = firstPage.updates[0].components[0].components.map((c) => c.data.custom_id);
  assert.deepEqual(firstPageIds, ["fallback_menu:1", "fallback_menu:4", "fallback_menu:8"]);

  // Halaman kedua (index 1) - dipake dropdown opsi 9 yang "Kembali"-nya
  // nunjuk ke situ (lihat test opsi 9 di atas).
  const secondPage = fakeInteraction({ customId: "fallback_menu:back:1" });
  await handleFallbackMenuButton(secondPage);
  const secondPageIds = secondPage.updates[0].components[0].components.map((c) => c.data.custom_id);
  assert.deepEqual(secondPageIds, ["fallback_menu:3", "fallback_menu:5", "fallback_menu:9"]);
});

// §10's thirty-fourth item - owner minta tombol tutup buat menu fallback ITU
// SENDIRI (beda dari "fallback_menu:close" di atas, yang nempel di dropdown
// opsi 4/9), buat kasus salah pencet/salah ketik - dan minta pesannya
// BENERAN DIHAPUS, bukan diedit jadi teks "dibatalin". Owner belakangan minta
// menu ini dirombak jadi WIZARD BERHALAMAN (3 tombol opsi/halaman, lihat
// MENU_PAGES di menu.js) - test ini sekarang ngecek SEMUA HALAMAN, bukan
// cuma bentuk lama yang numpuk 9-12 tombol di 1-2 baris.
//
// BUG YANG DILAPORIN OWNER (nyusul, abis wizard berhalaman ini di-ship): dulu
// cuma ada "Menu lainnya" (maju doang), gak ada cara balik ke halaman
// sebelumnya - user yang udah kepencet sampe halaman 3-4 kejebak, satu-satunya
// jalan keluar nutup pesannya terus manggil ulang dari awal. Sekarang tiap
// halaman (kecuali halaman PERTAMA) juga punya "⬅️ Menu sebelumnya".
test("replyFallbackMenu - wizard berhalaman: 4 halaman (3 opsi + Tutup/navigasi maju-mundur per halaman, halaman pertama tanpa mundur, halaman terakhir tanpa maju)", async () => {
  const { replyFallbackMenu } = require("../src/chat/menu");

  // Halaman 1: siapa yang live / cek member / rekap hari ini.
  const page1 = replyFallbackMenu();
  assert.equal(page1.components.length, 2, "tiap halaman cuma 2 baris: opsi + nav");
  const page1OptionIds = page1.components[0].components.map((c) => c.data.custom_id);
  assert.deepEqual(page1OptionIds, ["fallback_menu:1", "fallback_menu:4", "fallback_menu:8"]);
  const page1NavIds = page1.components[1].components.map((c) => c.data.custom_id);
  assert.deepEqual(
    page1NavIds,
    ["fallback_menu:delete", "fallback_menu:goto:1"],
    "halaman PERTAMA gak ada 'Menu sebelumnya' (gak ada halaman sebelum itu), cuma 'Menu lainnya' (goto halaman 2)",
  );

  // Halaman 2: paling lama live / paling rame / cek top gifter.
  const page2 = replyFallbackMenu(1);
  const page2OptionIds = page2.components[0].components.map((c) => c.data.custom_id);
  assert.deepEqual(page2OptionIds, ["fallback_menu:3", "fallback_menu:5", "fallback_menu:9"]);
  const page2NavIds = page2.components[1].components.map((c) => c.data.custom_id);
  assert.deepEqual(
    page2NavIds,
    ["fallback_menu:delete", "fallback_menu:goto:0", "fallback_menu:goto:2"],
    "halaman TENGAH punya dua-duanya: 'Menu sebelumnya' (goto halaman 1) DAN 'Menu lainnya' (goto halaman 3)",
  );

  // Halaman 3: daftar prioritas / status bot / reminder aku.
  const page3 = replyFallbackMenu(2);
  const page3OptionIds = page3.components[0].components.map((c) => c.data.custom_id);
  assert.deepEqual(page3OptionIds, ["fallback_menu:6", "fallback_menu:2", "fallback_menu:7"]);
  const page3NavIds = page3.components[1].components.map((c) => c.data.custom_id);
  assert.deepEqual(page3NavIds, ["fallback_menu:delete", "fallback_menu:goto:1", "fallback_menu:goto:3"]);

  // Halaman 4 (TERAKHIR) - fitur keyword-only (notlive/aliaslist/more): punya
  // "Menu sebelumnya" (goto halaman 3) tapi gak ada "Menu lainnya" lagi (owner
  // minta eksplisit: "3 menu terakhir tadi, tapi hanya tambahan tombol
  // tutup" - itu soal gak ada halaman KELIMA buat dituju, bukan soal
  // larangan ada tombol mundur).
  const page4 = replyFallbackMenu(3);
  const page4OptionIds = page4.components[0].components.map((c) => c.data.custom_id);
  assert.deepEqual(page4OptionIds, ["fallback_menu:notlive", "fallback_menu:aliaslist", "fallback_menu:more"]);
  const page4NavIds = page4.components[1].components.map((c) => c.data.custom_id);
  assert.deepEqual(
    page4NavIds,
    ["fallback_menu:delete", "fallback_menu:goto:2"],
    "halaman terakhir punya 'Menu sebelumnya' tapi gak ada 'Menu lainnya' (gak ada halaman ke-5)",
  );

  // Nomor halaman di luar jangkauan -> fallback aman ke halaman 1, bukan crash.
  const outOfRange = replyFallbackMenu(99);
  assert.deepEqual(
    outOfRange.components[0].components.map((c) => c.data.custom_id),
    page1OptionIds,
  );
});

test("handleFallbackMenuButton - tombol 'Menu lainnya ➡️' (fallback_menu:goto:<page>) EDIT pesan pindah ke halaman berikutnya, BUKAN pesan baru", async () => {
  const interaction = fakeInteraction({ customId: "fallback_menu:goto:1" });
  await handleFallbackMenuButton(interaction);
  assert.equal(interaction.calls.length, 0, "gak boleh reply() pesan baru");
  assert.match(interaction.updates[0].content, /Menu lainnya/);
  const optionIds = interaction.updates[0].components[0].components.map((c) => c.data.custom_id);
  assert.deepEqual(optionIds, ["fallback_menu:3", "fallback_menu:5", "fallback_menu:9"]);
});

// BUG YANG DILAPORIN OWNER: dulu cuma ada "Menu lainnya" (maju), gak ada
// jalan balik ke halaman sebelumnya - satu-satunya customId "goto" yang ada
// dipake buat DUA ARAH sekaligus (`fallback_menu:goto:<page-1>` buat mundur,
// `fallback_menu:goto:<page+1>` buat maju - lihat buildFallbackMenuComponents),
// jadi handler-nya SAMA PERSIS kayak test "Menu lainnya" di atas, gak perlu
// branch baru - ini cuma buktiin arah mundurnya juga jalan.
test("handleFallbackMenuButton - tombol '⬅️ Menu sebelumnya' (fallback_menu:goto:<page>, arah mundur) EDIT pesan balik ke halaman sebelumnya, BUKAN pesan baru", async () => {
  const interaction = fakeInteraction({ customId: "fallback_menu:goto:0" });
  await handleFallbackMenuButton(interaction);
  assert.equal(interaction.calls.length, 0, "gak boleh reply() pesan baru");
  const optionIds = interaction.updates[0].components[0].components.map((c) => c.data.custom_id);
  assert.deepEqual(optionIds, ["fallback_menu:1", "fallback_menu:4", "fallback_menu:8"], "balik ke opsi-opsi halaman 1");
});

test("handleFallbackMenuButton - tombol 'Tutup' di menu fallback BENERAN NGEHAPUS pesannya (message.delete), BUKAN diedit jadi teks 'dibatalin'", async () => {
  const interaction = fakeInteraction({ customId: "fallback_menu:delete", channelId: "c-delmenu", authorId: "u-delmenu" });
  await handleFallbackMenuButton(interaction);

  assert.equal(interaction.calls.length, 0, "gak boleh reply() pesan baru");
  assert.equal(interaction.updates.length, 0, "gak boleh update() jadi teks apapun - pesannya beneran hilang, bukan diganti teks");
  assert.equal(interaction.deferUpdateCalls.length, 1, "harus deferUpdate() dulu biar Discord gak nunjukkin 'interaction failed'");
  assert.deepEqual(interaction.deletedMessageIds, [interaction.message.id], "pesan menu-nya sendiri harus beneran kehapus");
});

test("handleFallbackMenuButton - tombol 'Tutup' di menu fallback juga nge-clear pendingMenuByAuthor, biar angka mentah abis itu gak nyasar dianggep lanjutan menu yang udah dihapus", async () => {
  const channelId = "c-delmenu-pending";
  const authorId = "u-delmenu-pending";
  markMenuShown(channelId, authorId);

  // Sebelum ditutup, angka mentah masih ketangkep sebagai lanjutan (baseline).
  assert.notEqual(await tryHandleMenuShortcut("2", channelId, authorId), null);

  markMenuShown(channelId, authorId); // pasang lagi (baris di atas udah "sekali pake" abis dipake)
  const interaction = fakeInteraction({ customId: "fallback_menu:delete", channelId, authorId });
  await handleFallbackMenuButton(interaction);

  assert.equal(
    await tryHandleMenuShortcut("2", channelId, authorId),
    null,
    "abis ditutup, angka mentah gak boleh lagi ketangkep sebagai lanjutan menu",
  );
});

// §10's thirty-fifth item - "fallback_menu:close" (dropdown 4/9) sekarang
// digabung logikanya sama "fallback_menu:delete" di atas, jadi harus
// nge-clear pendingMenuByAuthor juga, bukan cuma "delete".
test("handleFallbackMenuButton - tombol 'Tutup' di dropdown 4/9 JUGA nge-clear pendingMenuByAuthor (sama kayak 'delete', sekarang satu logika)", async () => {
  const channelId = "c-closemenu-pending";
  const authorId = "u-closemenu-pending";
  markMenuShown(channelId, authorId);

  const interaction = fakeInteraction({ customId: "fallback_menu:close", channelId, authorId });
  await handleFallbackMenuButton(interaction);

  assert.equal(
    await tryHandleMenuShortcut("2", channelId, authorId),
    null,
    "abis 'Tutup' dropdown 4/9 diklik, angka mentah gak boleh ketangkep sebagai lanjutan menu",
  );
});

test("handleFallbackMenuButton - opsi bare (mis. 2, ada di HALAMAN KETIGA) EDIT pesan menu (update) dengan halaman ASALnya ditempel lagi, BUKAN pesan baru", async () => {
  const interaction = fakeInteraction({ customId: "fallback_menu:2" });
  await handleFallbackMenuButton(interaction);
  assert.equal(interaction.calls.length, 0, "gak boleh reply() pesan baru");
  assert.match(interaction.updates[0].content, /Bot jalan normal/);
  assert.equal(interaction.updates[0].components.length, 2, "menu (2 baris: opsi + nav) ditempel ulang biar bisa lanjut mencet opsi lain");
  const optionIds = interaction.updates[0].components[0].components.map((c) => c.data.custom_id);
  assert.deepEqual(optionIds, ["fallback_menu:6", "fallback_menu:2", "fallback_menu:7"], "balik ke HALAMAN KETIGA (asal opsi '2'), bukan halaman 1");
});

// Halaman terakhir (owner minta, biar fitur-fitur baru yang masih
// keyword-only kayak alias/streak/leaderboard "paling lama gak live"/
// bandingin 3+ member kekenal user baru, bukan cuma nongol kalau kebetulan
// ngetik "cok bantuan" sendiri) - "notlive"/"aliaslist" langsung jawab tanpa
// nama (sama pola kayak opsi 2/3/5/6/7), "more" nunjukkin daftar lengkap
// (replyHelp) plus tombol Tutup/Kembali (sama pola kayak dropdown opsi 4/9).
test("handleFallbackMenuButton - '😴 Paling lama gak live' (fallback_menu:notlive) jawab langsung, halaman terakhir ditempel ulang", async () => {
  const interaction = fakeInteraction({ customId: "fallback_menu:notlive" });
  await handleFallbackMenuButton(interaction);
  assert.equal(interaction.calls.length, 0, "gak boleh reply() pesan baru");
  assert.match(interaction.updates[0].content, /paling lama gak live|belum ada catatan live/i);
  assert.equal(interaction.updates[0].components.length, 2, "menu (2 baris) ditempel ulang biar bisa lanjut mencet opsi lain");
  const optionIds = interaction.updates[0].components[0].components.map((c) => c.data.custom_id);
  assert.deepEqual(optionIds, ["fallback_menu:notlive", "fallback_menu:aliaslist", "fallback_menu:more"], "balik ke halaman TERAKHIR (asalnya)");
});

test("handleFallbackMenuButton - '📖 Daftar alias' (fallback_menu:aliaslist) jawab langsung, halaman terakhir ditempel ulang", async () => {
  const interaction = fakeInteraction({ customId: "fallback_menu:aliaslist" });
  await handleFallbackMenuButton(interaction);
  assert.equal(interaction.calls.length, 0, "gak boleh reply() pesan baru");
  assert.match(interaction.updates[0].content, /daftar alias|belum ada alias/i);
  assert.equal(interaction.updates[0].components.length, 2, "menu (2 baris) ditempel ulang biar bisa lanjut mencet opsi lain");
});

test("handleFallbackMenuButton - '❓ Fitur lainnya' (fallback_menu:more) nunjukkin replyHelp() lengkap (embed), plus tombol Tutup+Kembali (BUKAN menu ditempel ulang)", async () => {
  const interaction = fakeInteraction({ customId: "fallback_menu:more" });
  await handleFallbackMenuButton(interaction);
  assert.equal(interaction.calls.length, 0, "gak boleh reply() pesan baru");
  // replyHelp() sekarang balikin OBJECT {content, embeds} (dipecah dari
  // content polos - kepanjangan, ngelewatin batas 2000 karakter Discord,
  // itu bug "Fitur lainnya kok kayak rusak" yang dilaporin owner). Daftar
  // command lengkapnya (termasuk fitur keyword-only) ada di embeds[0].description,
  // ini SATU-SATUNYA tempat fitur itu bisa kelihat dari menu tanpa ngetik
  // "cok bantuan".
  assert.ok(interaction.updates[0].embeds, "harus ada embed (bukan content polos - kena limit 2000 karakter Discord)");
  assert.match(interaction.updates[0].embeds[0].description, /cok streak/i);
  assert.match(interaction.updates[0].embeds[0].description, /cok tambah alias/i);
  assert.match(interaction.updates[0].embeds[0].description, /cok bandingin/i);
  assert.ok(interaction.updates[0].content.length < 2000, "content-nya sendiri (di luar embed) harus jauh di bawah batas 2000 karakter Discord");
  assert.equal(interaction.updates[0].components.length, 1, "cuma 1 baris (Tutup+Kembali), bukan menu ditempel ulang");
  const actionRow = interaction.updates[0].components[0];
  assert.equal(actionRow.components[0].data.custom_id, "fallback_menu:close");
  assert.equal(actionRow.components[0].data.label, "Tutup");
  assert.equal(actionRow.components[1].data.custom_id, "fallback_menu:back:3", "'Kembali' balik ke HALAMAN TERAKHIR (asal tombol 'Fitur lainnya')");
  assert.equal(actionRow.components[1].data.label, "Kembali");
});

test("handleFallbackMenuButton - tombol 'Kembali' di bawah replyHelp() ('❓ Fitur lainnya') EDIT balik ke HALAMAN TERAKHIR (bukan halaman 1)", async () => {
  const helpInteraction = fakeInteraction({ customId: "fallback_menu:more" });
  await handleFallbackMenuButton(helpInteraction);
  assert.match(helpInteraction.updates[0].embeds[0].description, /cok streak/i);

  const backInteraction = fakeInteraction({ customId: "fallback_menu:back:3" });
  await handleFallbackMenuButton(backInteraction);
  assert.match(backInteraction.updates[0].content, /Fitur lainnya/);
  assert.equal(backInteraction.updates[0].components.length, 2);
  const optionIds = backInteraction.updates[0].components[0].components.map((c) => c.data.custom_id);
  assert.deepEqual(optionIds, ["fallback_menu:notlive", "fallback_menu:aliaslist", "fallback_menu:more"]);
});

// Opsi 8 (rekap hari ini) balikin object {content, components} yang UDAH
// bawa tombol navigasi rekap sendiri (Maju/Mundur/Tutup rekap/Cari member) -
// dipake APA ADANYA, gak ditempelin menu lagi di atasnya (2 sistem tombol
// beda konteks numpuk di 1 pesan bakal bikin bingung, bukan bantu).
// resolveBareMenuChoice("8") sengaja gak dites lewat handleFallbackMenuButton
// beneran di sini - manggil replyTodayRecapSoFar() yang nge-fetch arsip
// eksternal via network (lihat catetan di bawah), jadi cukup dipastiin lewat
// bentuk return object-nya, bukan manggil ulang jalur network beneran.

test("handleFallbackMemberSelect - opsi 4: member yang dipilih dari dropdown lagi live -> EDIT pesan jadi tanya y/n; udah gak live -> replyMemberNotFound", async () => {
  activeLives.set("jkt48_selecttest", { name: "Selecttest", username: "jkt48_selecttest", slug: "s", liveAt: new Date().toISOString() });
  try {
    const interaction = fakeInteraction({ customId: "fallback_select:4", values: ["jkt48_selecttest"] });
    await handleFallbackMemberSelect(interaction);
    assert.equal(interaction.calls.length, 0, "gak boleh reply() pesan baru");
    assert.match(interaction.updates[0].content, /Mau nonton sekarang/);
  } finally {
    activeLives.delete("jkt48_selecttest");
  }

  const goneInteraction = fakeInteraction({ customId: "fallback_select:4", values: ["jkt48_selecttest"] });
  await handleFallbackMemberSelect(goneInteraction);
  assert.match(goneInteraction.updates[0].content, /nggak nemu member/);
  assert.equal(goneInteraction.updates[0].components.length, 2, "menu (halaman asal opsi 4, index 0) ditempelin balik, bukan dead-end tanpa tombol");
});

test("handleFallbackMemberSelect - opsi 9: langsung ambil dari username dropdown (bukan fuzzy search), EDIT pesan (update)", async () => {
  saveGifterSnapshot({
    members: {
      jkt48_selectgiftertest: { name: "Selectgiftertest", gifters: [{ name: "Fan1", total_gold: 500 }], checkedAt: new Date().toISOString() },
    },
  });
  const interaction = fakeInteraction({ customId: "fallback_select:9", values: ["jkt48_selectgiftertest"] });
  await handleFallbackMemberSelect(interaction);
  assert.equal(interaction.calls.length, 0, "gak boleh reply() pesan baru");
  assert.match(interaction.updates[0].content, /Top Gifter Selectgiftertest/);
  assert.equal(interaction.updates[0].components.length, 2, "menu (halaman asal opsi 9, index 1) ditempelin balik, bukan dead-end tanpa tombol");
  const optionIds = interaction.updates[0].components[0].components.map((c) => c.data.custom_id);
  assert.deepEqual(optionIds, ["fallback_menu:3", "fallback_menu:5", "fallback_menu:9"]);
});
