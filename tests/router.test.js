require("./helpers/setupTestEnv");
// Owner ID palsu buat nge-tes gate "cuma owner boleh ubah prioritas" -
// dioverride di sini (bukan di setupTestEnv, yang sengaja ngosongin ini)
// biar dua-duanya (jalur owner vs bukan-owner) bisa dites beneran.
process.env.PRIORITY_PING_USER_ID = "owner-test-id";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { activeLives } = require("../src/storage/activeLives");
const { recordLiveDuration } = require("../src/storage/durationHistory");
const { saveChannelRouting } = require("../src/storage/channelRouting");
const { buildChatReply } = require("../src/chat/router");

const OWNER = "owner-test-id";

// replyRecapRange/replyTodayRecapSoFar balikin STRING polos kalau datanya
// kosong, tapi OBJECT {content, components} (tombol navigasi rekap) kalau
// ada sesi - dites di kedua kemungkinan biar gak diam-diam rapuh ke urutan
// test/isolasi data antar file.
function textOf(reply) {
  return typeof reply === "string" ? reply : reply.content;
}

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

test("berapa kali <nama> live - dispatch ke replyLiveCount", async () => {
  const reply = await buildChatReply("cok berapa kali liveCountRoutertest live");
  assert.match(reply, /belum ada catatan live buat "livecountroutertest"/);
});

test("berapa kali si <nama> live - varian dengan 'si' juga jalan", async () => {
  const reply = await buildChatReply("cok berapa kali si liveCountRoutertest2 live");
  assert.match(reply, /belum ada catatan live buat "livecountroutertest2"/);
});

// Bug beneran yang dilaporin user: "Lily berapa kali Live?" (NAMA duluan,
// bukan "berapa kali" duluan) malah kepick up sebagai fuzzy-match nama
// member (jatuh ke findDurationHistoryByNameFragment's "lagi nggak live
// sekarang" fallback) soalnya dulu liveCountMatch cuma punya 1 arah
// ("berapa kali <nama> live"). Ini pola sebaliknya - HARUS ketangkep
// duluan sebagai replyLiveCount, BUKAN jatuh ke fallback member-not-live.
test("<nama> berapa kali live - urutan NAMA duluan (laporan bug asli) dispatch ke replyLiveCount, BUKAN fallback 'lagi nggak live'", async () => {
  const reply = await buildChatReply("livecountnamefirsttest berapa kali live?");
  assert.match(reply, /belum ada catatan live buat "livecountnamefirsttest"/);
  assert.doesNotMatch(reply, /lagi nggak live sekarang/);
});

test("<nama> berapa kali live - wake-word 'cok' di depan nama GAK ikut ke-capture jadi bagian nama", async () => {
  const reply = await buildChatReply("cok livecountcoktest berapa kali live?");
  assert.match(reply, /belum ada catatan live buat "livecountcoktest"/);
  assert.doesNotMatch(reply, /"cok /); // fragment-nya harus "livecountcoktest" doang, bukan "cok livecountcoktest"
});

test("<nama> berapa kali live - varian 'udah berapa kali live'", async () => {
  const reply = await buildChatReply("livecountudahtest udah berapa kali live?");
  assert.match(reply, /belum ada catatan live buat "livecountudahtest"/);
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

// §10's fortieth item: "paling lama live"/"paling rame ditonton" bisa dikasih
// rentang juga (minggu ini/bulan ini/nama bulan/tanggal spesifik), gak cuma
// "hari ini" - dispatch ini gak nyentuh network sama sekali (murni activeLives
// + daily-log lokal), jadi aman dites langsung kayak replyRecapRange.
test("paling lama live minggu ini - dispatch ke replyLongestLiveForRange(7, 'minggu ini'), BUKAN 'hari ini'", async () => {
  const reply = await buildChatReply("cok siapa yang paling lama live minggu ini?");
  assert.match(reply, /Paling lama live minggu ini|belum ada data live minggu ini/);
});

test("paling rame ditonton bulan ini - dispatch ke replyTopViewersForRange (bulan berjalan), BUKAN 'hari ini'", async () => {
  const reply = await buildChatReply("cok siapa yang paling rame ditonton bulan ini?");
  assert.match(reply, /Paling rame ditonton bulan|belum ada data penonton buat bulan/);
  assert.doesNotMatch(reply, /hari ini/);
});

// §10's forty-first item: "cok export rekap ..." harus ketangkep SEBELUM
// dispatch "rekap" biasa (kalimatnya juga ngandung kata "rekap") - kalau
// kebalik urutannya, ini bakal nunjukkin TABEL rekap biasa, bukan file CSV.
test("export rekap - dispatch ke replyExportRecap (balesan bawa file CSV), BUKAN ke dispatch 'rekap' biasa", async () => {
  const reply = await buildChatReply("cok export rekap");
  const content = textOf(reply);
  assert.match(content, /diexport ke CSV|belum ada data live buat diexport/);
  if (typeof reply === "object") {
    assert.ok(reply.files, "balesan yang ada datanya harus bawa file CSV");
  }
});

// Dicek SEBELUM check "live" + "siapa" polos (replyListLive) di router.js -
// kalimatnya juga ngandung "live" + "siapa", jadi harus ketangkep duluan
// sama check leaderboard yang lebih spesifik. "cok siapa yang live" (tanpa
// "paling sering") harus TETEP jatuh ke replyListLive seperti biasa.
test("siapa yang paling sering live - dispatch ke replyLiveCountLeaderboard, BUKAN replyListLive (siapa yang LAGI live sekarang)", async () => {
  const reply = await buildChatReply("cok siapa yang paling sering live");
  assert.match(reply, /Paling sering live semenjak bot ini jalan|belum ada catatan live sama sekali/);
  assert.doesNotMatch(reply, /ini yang lagi live \(urut dari paling lama\)|lagi nggak ada member JKT48 yang live nih/);
});

test("siapa yang live (tanpa 'paling sering') - TETAP dispatch ke replyListLive seperti biasa, gak keganggu check leaderboard baru", async () => {
  const reply = await buildChatReply("cok siapa yang live");
  assert.match(reply, /ini yang lagi live \(urut dari paling lama\)|Cok, lagi nggak ada member JKT48 yang live nih/);
});

// Beda dari "cok rekap" polos (replyTodayRecapSoFar) - replyRecapRange gak
// nyentuh network (gak ada lookup arsip eksternal), jadi aman dites
// langsung, dan penting buat mastiin urutan regex-nya bener: "rekap minggu
// ini"/"rekap bulan ini" harus ketangkep SEBELUM "rekap" polos, bukan
// malah kepick up sebagai rekap hari ini.
test("rekap minggu ini - dispatch ke replyRecapRange(7, ...), BUKAN rekap hari ini", async () => {
  const reply = await buildChatReply("cok rekap minggu ini");
  const content = textOf(reply);
  assert.match(content, /Rekap minggu ini|belum ada live yang kecatet dalam minggu ini/);
  assert.doesNotMatch(content, /Rekap live hari ini/);
});

// §10's thirty-sixth item: "rekap bulan ini" sekarang dispatch ke
// replyRecapMonth (bulan KALENDER berjalan), bukan lagi replyRecapRange(30,
// ...) (30 hari rolling) - biar konsisten sama fitur rekap-per-nama-bulan
// baru ("cok rekap september" pas lagi September harus ngasih hasil yang
// SAMA kayak "cok rekap bulan ini").
test("rekap bulan ini - dispatch ke replyRecapMonth (bulan kalender berjalan), BUKAN rekap hari ini", async () => {
  const reply = await buildChatReply("cok rekap bulan ini");
  const content = textOf(reply);
  assert.match(content, /Rekap bulan|belum ada live yang kecatet buat bulan/);
  assert.doesNotMatch(content, /Rekap live hari ini/);
});

// "rekap hari ini" tetep dispatch LANGSUNG ke replyTodayRecapSoFar (bukan
// menu 4-tombol di bawah) - orangnya udah eksplisit nyebut rentangnya.
// SENGAJA gak dites di sini (sama alesannya kayak "cok rekap" polos yang
// LAMA, lihat catetan router.test.js's row di ARCHITECTURE.md §10) -
// replyTodayRecapSoFar bikin network call beneran ke arsip eksternal, dan
// unit test sengaja dijauhin dari itu (flaky/lambat/gak perlu). Rutenya
// sendiri cuma satu `&& containsWholeWord(text, "hari")` tambahan sebelum
// fallback ke menu, jadi cukup jelas dari baca kodenya doang.

// "rekap tanggal"/"rekap per tanggal" -> langsung dropdown milih tanggal,
// skip menu 4-tombol.
test("rekap tanggal - dispatch ke replyRecapDatePicker (dropdown tanggal), BUKAN menu 4-tombol atau rekap hari ini", async () => {
  const reply = await buildChatReply("cok rekap tanggal");
  assert.equal(reply.content, "Rekap tanggal berapa nih, cok?");
  assert.equal(reply.components.length, 2, "1 baris dropdown + 1 baris tombol tutup");
  assert.equal(reply.components[0].components[0].data.custom_id, "recap_date_select");
  assert.equal(reply.components[1].components[0].data.custom_id, "recap_nav:close");
});

// "rekap" POLOS (gak nyebut minggu/bulan/tanggal/hari ini sama sekali) ->
// menu 4-tombol, BUKAN langsung rekap hari ini kayak sebelumnya - owner
// minta ini biar user gak bingung mau ketik apa.
test("rekap polos (tanpa minggu/bulan/tanggal/hari) - dispatch ke menu 4-tombol + Tutup", async () => {
  const reply = await buildChatReply("cok rekap");
  assert.equal(reply.content, "Mau rekap yang mana, cok?");
  const customIds = reply.components[0].components.map((c) => c.data.custom_id);
  assert.deepEqual(customIds, ["recap_menu:today", "recap_menu:week", "recap_menu:month", "recap_menu:date", "recap_nav:close"]);
});

// §10's thirty-sixth item: "cok rekap <tanggal spesifik>"/"cok rekap
// <nama-bulan>"/"cok rekap bulan"/"cok rekap <nama-hari>" - laporan owner:
// "rekap 25 september" dulu diem-diem jatuh ke menu 4-tombol (rekap polos),
// padahal user udah eksplisit nyebut tanggalnya.
test("rekap <tanggal lengkap, mis. '25 september'> - dispatch ke replyRecapSpecificDate, BUKAN menu 4-tombol polos", async () => {
  const reply = await buildChatReply("cok rekap 25 september");
  const content = textOf(reply);
  assert.match(content, /Rekap tanggal|gak ada data rekap buat tanggal/);
  assert.doesNotMatch(content, /^Mau rekap yang mana, cok\?$/);
});

test("rekap <nama bulan tanpa angka hari, mis. 'september'> - dispatch ke replyRecapMonth, BUKAN menu 4-tombol polos", async () => {
  const reply = await buildChatReply("cok rekap september");
  const content = textOf(reply);
  assert.match(content, /Rekap bulan|belum ada live yang kecatet buat bulan/);
});

// "rekap bulan" polos (TANPA nama bulan/"ini") - dropdown milih bulan, atau
// langsung tunjukkin kalau cuma ada 1 bulan yang punya data (belum ada cara
// bikin data multi-bulan lewat unit test router.js tanpa reach ke dailyLog
// langsung, jadi cuma dites jalur "cuma 1 bulan" di sini).
test("rekap bulan polos (tanpa nama bulan/'ini') - dispatch ke replyRecapMonthGeneric, BUKAN rekap bulan-rolling lama", async () => {
  const reply = await buildChatReply("cok rekap bulan");
  const content = textOf(reply);
  assert.match(content, /Rekap bulan|belum ada live yang kecatet buat bulan|Rekap bulan berapa nih/);
  assert.doesNotMatch(content, /Rekap live hari ini/);
});

test("rekap <nama hari, mis. 'senin'> - dispatch ke replyRecapWeekdayPicker (dropdown tanggal buat hari itu)", async () => {
  const reply = await buildChatReply("cok rekap senin");
  const content = textOf(reply);
  assert.match(content, /Senin tanggal berapa nih, cok\?|belum ada tanggal hari Senin yang kecatet/);
});

// "rekap hari minggu" HARUS ketangkep sebagai hari Minggu (weekday picker),
// BUKAN kesangkut ke cabang "rekap minggu ini" (rentang 7 hari) - dua-duanya
// sama-sama ngandung kata "minggu".
test("rekap hari minggu - dispatch ke replyRecapWeekdayPicker (hari Minggu), BUKAN rekap minggu ini (rentang 7 hari)", async () => {
  const reply = await buildChatReply("cok rekap hari minggu");
  const content = textOf(reply);
  assert.match(content, /Minggu tanggal berapa nih, cok\?|belum ada tanggal hari Minggu yang kecatet/);
  assert.doesNotMatch(content, /Rekap minggu ini/);
});

// Regresi: "rekap minggu ini"/"rekap minggu" polos (TANPA "hari") harus
// TETAP jalan sebagai rentang 7 hari seperti biasa, gak kebajak sama
// pengecekan weekday "Minggu" yang baru ditambahin.
test("rekap minggu (tanpa 'hari') - TETAP dispatch ke replyRecapRange(7, ...), bukan weekday picker", async () => {
  const reply = await buildChatReply("cok rekap minggu");
  const content = textOf(reply);
  assert.match(content, /Rekap minggu ini|belum ada live yang kecatet dalam minggu ini/);
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

// Fitur "Q3": channel yang ke-mapping (storage/channelRouting.js's
// getUsernameForChannel) ke SATU member spesifik harus dapet fallback yang
// lebih simpel & spesifik member itu (chat/memberChannelReply.js), BUKAN
// menu 9-opsi generik yang nanya "member yang mana" - di channel khusus itu
// jawabannya udah jelas.
test("pesan yang gak match pola manapun di channel KHUSUS member (ke-mapping channelId) -> fallback per-member, bukan menu generik", async () => {
  saveChannelRouting({
    jkt48_dedicatedroutertest: { webhookUrl: "https://discord.com/api/webhooks/999/token-router", channelId: "c-dedicated-router-test" },
  });
  const reply = await buildChatReply("cok apaan sih ini asdkjaskjd", { channelId: "c-dedicated-router-test", authorId: "u-dedicated" });
  assert.match(reply.content, /\*\*jkt48_dedicatedroutertest\*\*/);
  assert.equal(reply.components[0].components.length, 4, "harus 3 tombol opsi + Tutup, bukan 9 opsi menu generik");
});

test("pesan yang gak match pola manapun di channel BIASA (gak ke-mapping) -> TETAP fallback menu generik seperti biasa", async () => {
  const reply = await buildChatReply("cok apaan sih ini asdkjaskjd", { channelId: "c-not-dedicated-test", authorId: "u-not-dedicated" });
  assert.equal(reply.components.length, 2, "menu generik ada 2 baris tombol (9 opsi), beda dari fallback per-member yang cuma 1 baris/3 tombol");
});

// BUG BENERAN yang dilaporin owner: pesan di channel khusus member TANPA
// "cok"/kata tanya-live sama sekali dulu diem-diem kena gerbang wake-word
// biasa (buildChatReply balikin null) - keliatan kayak bot gak jalan sama
// sekali di channel itu, padahal cuma nunggu kata "cok" yang user gak tau
// perlu diketik. Channel khusus member SEHARUSNYA diperlakukan kayak
// BOT_CHANNEL_ID (isBotChannel) - hampir semua pesan dianggap ditujukan ke bot.
test("channel KHUSUS member: pesan TANPA 'cok'/kata tanya-live sama sekali TETEP dapet balesan (fallback per-member), bukan diem (null)", async () => {
  saveChannelRouting({
    jkt48_nowakewordtest: { webhookUrl: "https://discord.com/api/webhooks/999/token-nowake", channelId: "c-dedicated-no-wakeword-test" },
  });
  const reply = await buildChatReply("halo semuanya, apa kabar", { channelId: "c-dedicated-no-wakeword-test", authorId: "u-no-wakeword" });
  assert.notEqual(reply, null, "channel khusus member harus balesin walau gak nyebut 'cok'/'live' sama sekali, sama kayak BOT_CHANNEL_ID");
  assert.match(reply.content, /\*\*jkt48_nowakewordtest\*\*/);
});

// Regresi sekaligus: channel BIASA (gak ke-mapping) harus TETAP kena gerbang
// wake-word seperti biasa - fix di atas gak boleh nge-bypass wake-word buat
// channel manapun, cuma buat channel yang beneran ke-mapping ke member.
test("channel BIASA (gak ke-mapping): pesan tanpa 'cok'/kata tanya-live TETEP diabaikan (null), gerbang wake-word gak ke-bypass", async () => {
  const reply = await buildChatReply("halo semuanya, apa kabar", { channelId: "c-plain-no-wakeword-test", authorId: "u-plain-no-wakeword" });
  assert.equal(reply, null);
});
