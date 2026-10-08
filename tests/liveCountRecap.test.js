require("./helpers/setupTestEnv");

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { getTodayWIB } = require("../src/utils");
const { shiftDateWIB } = require("../src/streakMath");
const { activeLives } = require("../src/storage/activeLives");
const { recordLiveEnded } = require("../src/storage/dailyLog");
const { recordLiveCompleted } = require("../src/storage/liveCount");
const {
  replyLiveCount,
  replyLiveCountWithRecap,
  replyRecapMember,
  handleRecapNavButton,
  handleRecapMemberDateSelect,
  handleRecapJumpModalSubmit,
} = require("../src/chat/replies");
const { buildChatReply } = require("../src/chat/commandRoutes");
const { findInteractionRoute } = require("../src/chat/interactionRoutes");

// ----------------------------------------------------------------- helpers

function fakeInteraction({ customId, values = [], channelId = "c-lc", authorId = "u-lc", fieldValue = "" } = {}) {
  const updates = [];
  const calls = [];
  return {
    customId,
    values,
    channelId,
    user: { id: authorId },
    fields: { getTextInputValue: () => fieldValue },
    update: async (payload) => updates.push(payload),
    reply: async (payload) => calls.push(payload),
    deferUpdate: async () => {},
    message: { delete: async () => {} },
    updates,
    calls,
  };
}

const rows = (reply) => reply.components.map((row) => row.components.map((c) => c.data.custom_id));
const ids = (reply) => rows(reply).flat();
const labels = (reply) => reply.components.flatMap((row) => row.components.map((c) => c.data.label).filter(Boolean));
const selectJson = (reply) => reply.components[0].components[0].toJSON();

// Catat satu sesi selesai member pada tanggal WIB tertentu (tengah hari, jauh dari batas hari).
function recordSessionOn(name, username, dateWIB, { hourStart = 12, minutes = 30 } = {}) {
  const start = new Date(`${dateWIB}T${String(hourStart).padStart(2, "0")}:00:00+07:00`);
  recordLiveEnded(name, username, start, new Date(start.getTime() + minutes * 60000), 10);
}

const daysAgo = (n) => shiftDateWIB(getTodayWIB(), -n);

// Dua member, tanggal berbeda-beda. Nama unik per test biar data antar test tidak saling ganggu.
function seedMember(name, username, dates) {
  for (const d of dates) recordSessionOn(name, username, d);
  recordLiveCompleted(username, name);
}

// ------------------------------------------------------------- jawaban jumlah live

test("replyLiveCountWithRecap - member ketemu: kalimat sama persis dengan replyLiveCount + tombol Lihat rekap & Tutup", () => {
  seedMember("Lcwr JKT48", "jkt48_lcwr", [daysAgo(1)]);
  const reply = replyLiveCountWithRecap("lcwr");
  assert.equal(reply.content, replyLiveCount("lcwr"), "isi teks tidak boleh berubah");
  assert.deepEqual(ids(reply), ["recap_nav:memberrecap:jkt48_lcwr", "reply_close"]);
  assert.deepEqual(labels(reply), ["📋 Lihat rekap", "Tutup"]);
  assert.equal(reply.components.length, 1, "kedua tombol satu baris");
});

test("replyLiveCountWithRecap - tidak ketemu / nama kosong tetap string biasa (persis replyLiveCount)", () => {
  assert.equal(replyLiveCountWithRecap("member-tidak-ada-sama-sekali"), replyLiveCount("member-tidak-ada-sama-sekali"));
  assert.equal(typeof replyLiveCountWithRecap("member-tidak-ada-sama-sekali"), "string");
  assert.equal(replyLiveCountWithRecap(""), replyLiveCount(""));
});

test("chat 'cok berapa kali <nama> live' - ada tombol Lihat rekap dan tepat satu Tutup", async () => {
  seedMember("Lcchat JKT48", "jkt48_lcchat", [daysAgo(1)]);
  const reply = await buildChatReply("cok berapa kali lcchat live", { isBotChannel: true, channelId: "c1", authorId: "u1" });
  assert.deepEqual(ids(reply), ["recap_nav:memberrecap:jkt48_lcchat", "reply_close"]);
  const notFound = await buildChatReply("cok berapa kali tidakadasama live", { isBotChannel: true, channelId: "c1", authorId: "u1" });
  assert.deepEqual(ids(notFound), ["reply_close"], "tidak ketemu: tetap bisa ditutup, tanpa Lihat rekap");
});

// ------------------------------------------------------------- tombol Lihat rekap

test("klik Lihat rekap - pesan DIEDIT jadi rekap member itu: tabel, dropdown tanggal, Tutup rekap, Kembali; TANPA Cari member", async () => {
  seedMember("Lcopen JKT48", "jkt48_lcopen", [daysAgo(1), daysAgo(1), daysAgo(3)]);
  const click = fakeInteraction({ customId: "recap_nav:memberrecap:jkt48_lcopen" });
  await handleRecapNavButton(click);

  assert.equal(click.calls.length, 0, "edit di tempat, bukan pesan baru");
  const view = click.updates[0];
  assert.match(view.content, /📋 \*\*Rekap live Lcopen JKT48\*\*/);
  assert.match(view.content, /Total sesi: 3x/);
  assert.deepEqual(rows(view), [["recap_member_date:jkt48_lcopen:lc-jkt48_lcopen"], ["recap_nav:close"], ["recap_nav:backto:lc-jkt48_lcopen"]]);
  assert.ok(!ids(view).some((id) => id.startsWith("recap_nav:search")), "Cari member harus tidak ada");
  assert.ok(labels(view).includes("🔙 Kembali ke jumlah live"));
  assert.ok(labels(view).includes("Tutup rekap"));
});

test("klik Kembali - balik ke jawaban jumlah live yang sama persis (lengkap dengan tombol Lihat rekap)", async () => {
  seedMember("Lcback JKT48", "jkt48_lcback", [daysAgo(2)]);
  const original = replyLiveCountWithRecap("lcback");

  const click = fakeInteraction({ customId: "recap_nav:backto:lc-jkt48_lcback" });
  await handleRecapNavButton(click);
  const restored = click.updates[0];
  assert.equal(restored.content, original.content);
  assert.deepEqual(ids(restored), ids(original));
});

test("Kembali dari origin yang datanya sudah tidak ada - jatuh ke menu rekap, tidak error", async () => {
  const click = fakeInteraction({ customId: "recap_nav:backto:lc-jkt48_sudahhilang" });
  await handleRecapNavButton(click);
  assert.ok(click.updates[0].content, "tetap membalas sesuatu");
  assert.ok(
    ids(click.updates[0]).some((id) => id.startsWith("recap_menu:")),
    "menu rekap",
  );
});

test("Lihat rekap untuk member tanpa sesi tersimpan - pesan jelas + Tutup + Kembali (bukan menu rekap umum)", async () => {
  recordLiveCompleted("jkt48_lckosong", "Lckosong JKT48"); // ada hitungan live, tapi tidak ada sesi di arsip
  const click = fakeInteraction({ customId: "recap_nav:memberrecap:jkt48_lckosong" });
  await handleRecapNavButton(click);
  const view = click.updates[0];
  assert.match(view.content, /gak punya sesi live yang masih kesimpen/);
  assert.deepEqual(ids(view), ["recap_nav:close", "recap_nav:backto:lc-jkt48_lckosong"]);
});

// ------------------------------------------------------------- dropdown tanggal

test("dropdown tanggal - berisi 'Semua sesi' + HANYA tanggal yang ada sesi member itu, terbaru dulu, dengan jumlah sesi", async () => {
  seedMember("Lcdates JKT48", "jkt48_lcdates", [daysAgo(5), daysAgo(2), daysAgo(2), daysAgo(9)]);
  // member lain di tanggal lain TIDAK boleh muncul di dropdown member ini
  seedMember("Lcother JKT48", "jkt48_lcother", [daysAgo(4), daysAgo(7)]);

  const view = await replyRecapMember("lcdates", "c-lc", "u-lc");
  const select = selectJson(view);
  assert.equal(select.custom_id, "recap_member_date:jkt48_lcdates");
  assert.deepEqual(
    select.options.map((o) => o.value),
    ["all", daysAgo(2), daysAgo(5), daysAgo(9)],
  );
  assert.deepEqual(
    select.options.slice(1).map((o) => o.description),
    ["2 sesi live", "1 sesi live", "1 sesi live"],
  );
  assert.equal(select.options[0].default, true, "tampilan semua sesi -> 'Semua sesi' terpilih");
});

test("pilih tanggal - tabel HANYA sesi member itu di tanggal itu; dropdown menandai tanggal terpilih; Tutup + Kembali tetap ada", async () => {
  seedMember("Lcpick JKT48", "jkt48_lcpick", [daysAgo(3), daysAgo(3), daysAgo(6)]);
  seedMember("Lcpickother JKT48", "jkt48_lcpickother", [daysAgo(3), daysAgo(3), daysAgo(3)]); // member lain, tanggal SAMA

  const pick = fakeInteraction({ customId: "recap_member_date:jkt48_lcpick:lc-jkt48_lcpick", values: [daysAgo(3)] });
  await handleRecapMemberDateSelect(pick);

  assert.equal(pick.calls.length, 0, "edit di tempat");
  const view = pick.updates[0];
  assert.match(view.content, /📋 \*\*Rekap live Lcpick JKT48 - /);
  assert.match(view.content, /Total sesi: 2x \(2 udah selesai, 0 masih live\)/);
  assert.equal((view.content.match(/Selesai/g) || []).length, 2, "dua baris tabel, sesi member lain tidak ikut");
  assert.doesNotMatch(view.content, /Lcpickother/);
  assert.doesNotMatch(view.content, /35 hari terakhir/, "catatan retensi hanya di tampilan semua sesi");

  const select = selectJson(view);
  assert.equal(select.options.find((o) => o.default).value, daysAgo(3));
  assert.deepEqual(ids(view).slice(1), ["recap_nav:close", "recap_nav:backto:lc-jkt48_lcpick"]);
  assert.ok(!ids(view).some((id) => id.startsWith("recap_nav:search")));
});

test("pilih 'Semua sesi' - kembali ke rekap lengkap member itu", async () => {
  seedMember("Lcall JKT48", "jkt48_lcall", [daysAgo(1), daysAgo(4)]);
  const pick = fakeInteraction({ customId: "recap_member_date:jkt48_lcall:lc-jkt48_lcall", values: ["all"] });
  await handleRecapMemberDateSelect(pick);
  const view = pick.updates[0];
  assert.match(view.content, /📋 \*\*Rekap live Lcall JKT48\*\*/);
  assert.match(view.content, /Total sesi: 2x/);
  assert.match(view.content, /35 hari terakhir/);
  assert.equal(selectJson(view).options[0].default, true);
});

test("value dropdown aneh (bukan tanggal) diperlakukan sebagai 'Semua sesi', tidak error", async () => {
  seedMember("Lcjunk JKT48", "jkt48_lcjunk", [daysAgo(1)]);
  const pick = fakeInteraction({ customId: "recap_member_date:jkt48_lcjunk", values: ["bukan-tanggal"] });
  await handleRecapMemberDateSelect(pick);
  assert.match(pick.updates[0].content, /Total sesi: 1x/);
});

test("tanggal yang datanya hilang saat dipilih - pesan jelas, dropdown + Tutup tetap ada", async () => {
  seedMember("Lcgone JKT48", "jkt48_lcgone", [daysAgo(2)]);
  const pick = fakeInteraction({ customId: "recap_member_date:jkt48_lcgone", values: [daysAgo(20)] });
  await handleRecapMemberDateSelect(pick);
  const view = pick.updates[0];
  assert.match(view.content, /gak punya live yang kecatet tanggal/);
  assert.ok(ids(view).includes("recap_member_date:jkt48_lcgone"));
  assert.ok(ids(view).includes("recap_nav:close"));
});

test("member yang LAGI LIVE: hari ini muncul di dropdown dan tampilan tanggal hari ini memuat sesi yang masih berjalan", async () => {
  seedMember("Lclive JKT48", "jkt48_lclive", [daysAgo(2)]);
  activeLives.set("jkt48_lclive", {
    name: "Lclive JKT48",
    username: "jkt48_lclive",
    slug: "s",
    liveAt: new Date(Date.now() - 600000).toISOString(),
    viewCount: 5,
    peakViewCount: 5,
  });
  try {
    const view = await replyRecapMember("lclive", "c-lc", "u-lc");
    assert.deepEqual(
      selectJson(view).options.map((o) => o.value),
      ["all", getTodayWIB(), daysAgo(2)],
    );
    const pick = fakeInteraction({ customId: "recap_member_date:jkt48_lclive", values: [getTodayWIB()] });
    await handleRecapMemberDateSelect(pick);
    assert.match(pick.updates[0].content, /Total sesi: 1x \(0 udah selesai, 1 masih live\)/);
  } finally {
    activeLives.delete("jkt48_lclive");
  }
});

// ------------------------------------------------------------- halaman & customId

test("lebih dari satu halaman di satu tanggal - Maju/Lompat halaman jalan, customId membawa tanggal, dan origin 'Kembali' bertahan", async () => {
  const username = "jkt48_lcpaged";
  const date = daysAgo(2);
  for (let i = 0; i < 25; i++) recordSessionOn("Lcpaged JKT48", username, date, { hourStart: 0 + (i % 20), minutes: 10 });
  recordLiveCompleted(username, "Lcpaged JKT48");

  const pick = fakeInteraction({ customId: `recap_member_date:${username}:lc-${username}`, values: [date] });
  await handleRecapMemberDateSelect(pick);
  const view = pick.updates[0];
  assert.match(view.content, /Halaman 1\/2/);
  const next = ids(view).find((id) => id.startsWith("recap_nav:next:"));
  assert.equal(next, `recap_nav:next:u${username}#${date}:0:lc-${username}`);
  assert.ok(ids(view).includes(`recap_nav:jump:u${username}#${date}:0:lc-${username}`));
  assert.ok(ids(view).includes(`recap_nav:backto:lc-${username}`));

  const click = fakeInteraction({ customId: next });
  await handleRecapNavButton(click);
  const page2 = click.updates[0];
  assert.match(page2.content, /Halaman 2\/2/);
  assert.equal((page2.content.match(/Selesai/g) || []).length, 5);
  assert.ok(ids(page2).includes(`recap_nav:backto:lc-${username}`), "Kembali tidak hilang setelah pindah halaman");
  assert.equal(selectJson(page2).options.find((o) => o.default).value, date, "dropdown tetap menandai tanggal yang sama");

  const jump = fakeInteraction({ customId: `recap_jump_modal:u${username}#${date}:0:lc-${username}`, fieldValue: "2" });
  await handleRecapJumpModalSubmit(jump);
  assert.match(jump.updates[0].content, /Halaman 2\/2/);
});

test("semua customId yang dibuat <= 100 karakter walau username panjang (batas Discord)", async () => {
  const username = "jkt48_marsha_lenathea_panjang";
  const date = daysAgo(1);
  for (let i = 0; i < 25; i++) recordSessionOn("Marsha JKT48", username, date, { hourStart: i % 20, minutes: 5 });
  recordLiveCompleted(username, "Marsha JKT48");

  const open = fakeInteraction({ customId: `recap_nav:memberrecap:${username}` });
  await handleRecapNavButton(open);
  const pick = fakeInteraction({ customId: `recap_member_date:${username}:lc-${username}`, values: [date] });
  await handleRecapMemberDateSelect(pick);
  for (const view of [replyLiveCountWithRecap("marsha"), open.updates[0], pick.updates[0]]) {
    for (const id of ids(view)) assert.ok(id.length <= 100, `${id} (${id.length} karakter) melebihi batas 100`);
  }
});

test("dropdown tidak pernah melebihi 25 opsi, dan tanggal yang dipilih tetap tertandai walau lebih tua dari 24 tanggal terbaru", async () => {
  const username = "jkt48_lcmany";
  const dates = Array.from({ length: 30 }, (_, i) => daysAgo(i + 1)); // 30 tanggal berbeda
  seedMember("Lcmany JKT48", username, dates);

  const pick = fakeInteraction({ customId: `recap_member_date:${username}`, values: [daysAgo(30)] });
  await handleRecapMemberDateSelect(pick);
  const options = selectJson(pick.updates[0]).options;
  assert.ok(options.length <= 25, `opsi ${options.length}`);
  assert.equal(options.filter((o) => o.default).length, 1);
  assert.equal(options.find((o) => o.default).value, daysAgo(30), "tanggal tua yang dipilih tetap ada & terpilih");
});

// ------------------------------------------------------------- jalur & kompatibilitas

test("rute interaksi - dropdown tanggal member terdaftar dan mengarah ke handler-nya", () => {
  const route = findInteractionRoute({
    customId: "recap_member_date:jkt48_x:lc-jkt48_x",
    isButton: () => false,
    isStringSelectMenu: () => true,
    isModalSubmit: () => false,
  });
  assert.ok(route, "rute harus ada");
  assert.equal(route.handler, handleRecapMemberDateSelect);
});

test("rekap member yang dibuka dengan mengetik (tanpa origin) - dropdown tanggal ada, tanpa tombol Kembali, perilaku lama tetap", async () => {
  seedMember("Lctyped JKT48", "jkt48_lctyped", [daysAgo(1)]);
  const view = await replyRecapMember("lctyped", "c-lc", "u-lc");
  assert.deepEqual(rows(view), [["recap_member_date:jkt48_lctyped"], ["recap_nav:close"]]);
});
