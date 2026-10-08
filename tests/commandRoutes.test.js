require("./helpers/setupTestEnv");

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { ROUTES, RECAP_ROUTES, NO_MATCH, buildChatReply } = require("../src/chat/commandRoutes");

const nameOf = (routes) => routes.map((route) => route.name);

test("ROUTES - semua langkah fungsi bernama dan tidak ada duplikat", () => {
  for (const routes of [ROUTES, RECAP_ROUTES]) {
    const names = nameOf(routes);
    for (const route of routes) assert.equal(typeof route, "function");
    assert.ok(
      names.every((name) => name.startsWith("route")),
      `nama langkah anonim/aneh: ${names.filter((n) => !n.startsWith("route"))}`,
    );
    assert.equal(new Set(names).size, names.length, "ada langkah yang terdaftar dua kali");
  }
  assert.ok(ROUTES.length > 40);
});

// Urutan adalah bagian dari logika: pola yang lebih spesifik harus dicek lebih dulu.
// Tiap pasangan di bawah pernah (atau hampir) jadi bug "pola umum mencuri pesan pola spesifik".
function assertOrder(routes, pairs) {
  const names = nameOf(routes);
  for (const [first, second, why] of pairs) {
    const a = names.indexOf(first);
    const b = names.indexOf(second);
    assert.notEqual(a, -1, `${first} harus ada`);
    assert.notEqual(b, -1, `${second} harus ada`);
    assert.ok(a < b, `${first} harus sebelum ${second} (${why})`);
  }
}

test("urutan rute utama - pola spesifik selalu di atas pola umum", () => {
  assertOrder(ROUTES, [
    ["routeWakeGate", "routePersonalCommand", "pesan tanpa 'cok' diabaikan sebelum fitur apa pun"],
    ["routeMySubscriptions", "routeUnsubscribe", "'reminder' bisa muncul bersama 'ingetin'"],
    ["routeUnsubscribe", "routeSubscribe", "'berhenti ingetin' mengandung kata 'ingetin'"],
    ["routeViewerChart", "routeDurationChart", "'grafik penonton x' bukan nama member 'penonton x'"],
    ["routeCompareList", "routeCompareTwoWay", "daftar bermodal koma sebelum 2-way"],
    ["routeCompareTwoWay", "routeComparePicker", "pasangan lengkap sebelum picker"],
    ["routeExportRecap", "routeRecap", "'export rekap' mengandung kata 'rekap'"],
    ["routeLongestNotLive", "routeLongestLive", "keduanya mengandung 'paling lama'"],
    ["routeLiveCountLeaderboard", "routeListLive", "'siapa yang paling sering live' bukan 'siapa yang live'"],
    ["routeListLive", "routeBareKeywordHint", "pertanyaan live sebelum petunjuk kata polos"],
    ["routeLastLive", "routeMemberQuery", "'terakhir live x' bukan member bernama 'terakhir'"],
    ["routeMemberQuery", "routeBotStatus", "'status nala' bukan status bot"],
  ]);
});

test("urutan sub-rute rekap - dari yang paling spesifik ke yang paling polos, menu selalu terakhir", () => {
  assertOrder(RECAP_ROUTES, [
    ["routeRecapMemberScoped", "routeRecapRelative", "'rekap nala minggu ini' membawa nama member"],
    ["routeRecapRelative", "routeRecapWeekday", "'kemarin'/'bulan lalu' bukan nama member"],
    ["routeRecapWeekday", "routeRecapWeek", "'minggu' bisa berarti hari Minggu"],
    ["routeRecapSpecificDate", "routeRecapWeek", "tanggal lengkap sebelum bulan/minggu"],
    ["routeRecapSpecificDate", "routeRecapNamedMonth", "'25 september' bukan bulan polos"],
    ["routeRecapThisMonth", "routeRecapMonthPicker", "'bulan ini' langsung, bukan dropdown"],
    ["routeRecapMemberName", "routeRecapMenu", "nama member sebelum menu rekap"],
  ]);
  assert.equal(RECAP_ROUTES[RECAP_ROUTES.length - 1].name, "routeRecapMenu", "langkah terakhir harus selalu menjawab");
});

test("NO_MATCH - simbol unik, bukan nilai balasan yang mungkin", () => {
  assert.equal(typeof NO_MATCH, "symbol");
  assert.notEqual(NO_MATCH, null);
});

test("kata kunci polos yang sama dengan properti Object.prototype dijawab menu, bukan fungsi/objek prototipe", async () => {
  for (const word of ["cok constructor", "cok __proto__", "cok constructor?", "cok __proto__."]) {
    const reply = await buildChatReply(word, { isBotChannel: true });
    assert.notEqual(typeof reply, "function", `${word} tidak boleh dibalas dengan fungsi`);
    assert.notEqual(reply, Object.prototype, `${word} tidak boleh dibalas dengan Object.prototype`);
    assert.ok(typeof reply === "string" || (reply && typeof reply.content === "string"), `${word} harus dibalas teks/pesan Discord yang valid`);
  }
});

test("kata kunci polos asli tetap dijawab petunjuk (tidak rusak oleh perbaikan hasOwnProperty)", async () => {
  assert.match(await buildChatReply("cok grafik", { isBotChannel: true }), /grafik <nama member>/);
  assert.match(await buildChatReply("cok streak?", { isBotChannel: true }), /streak <nama member>/);
  assert.match(await buildChatReply("cok berhenti ingetin", { isBotChannel: true }), /berhenti ingetin <nama member>/);
});

test("pesan yang tidak ditujukan ke bot tetap diabaikan (null)", async () => {
  assert.equal(await buildChatReply("hari ini makan apa ya", { isBotChannel: false }), null);
  assert.equal(await buildChatReply("", { isBotChannel: false }), null);
  assert.equal(await buildChatReply(undefined, { isBotChannel: false }), null);
});
