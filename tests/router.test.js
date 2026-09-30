require("./helpers/setupTestEnv");
// Owner ID palsu buat nge-tes gate "cuma owner boleh ubah prioritas" -
// dioverride di sini (bukan di setupTestEnv, yang sengaja ngosongin ini)
// biar dua-duanya (jalur owner vs bukan-owner) bisa dites beneran.
process.env.PRIORITY_PING_USER_ID = "owner-test-id";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { activeLives } = require("../src/storage/activeLives");
const { recordLiveDuration } = require("../src/storage/durationHistory");
const { recordLiveCompleted } = require("../src/storage/liveCount");
const { recordLiveEnded } = require("../src/storage/dailyLog");
const { saveChannelRouting } = require("../src/storage/channelRouting");
const { buildChatReply, replyWithFailureNotice } = require("../src/chat/router");

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

// Saran fitur ke-5 (§10's kelimapuluh item): "cok tambah alias <alias> =
// <nama asli>" (dan variasi pemisah "buat"/"untuk"). fetch dipalsuin di sini
// (bukan pakai withFakeIdn yang SELALU balikin profil null) soalnya
// handleAddAlias butuh target-nya BENERAN ketemu di IDN dulu.
test("tambah alias - owner boleh (semua pemisah '=' / 'buat' / 'untuk'), non-owner ditolak, dan gak nabrak 'tambah prioritas'", async () => {
  recordLiveCompleted("jkt48_aliasroutertarget", "Aliasroutertarget");
  const original = global.fetch;
  global.fetch = async (url, options) => {
    const { variables } = JSON.parse(options.body);
    if (variables.username !== "jkt48_aliasroutertarget") return { ok: true, json: async () => ({ errors: [{ message: "User Not found" }] }) };
    return {
      ok: true,
      json: async () => ({ data: { getPublicProfileByUsername: { username: variables.username, name: "Aliasroutertarget JKT48" } } }),
    };
  };
  try {
    const asOther = await buildChatReply("cok tambah alias arttest1 = aliasroutertarget", { authorId: "bukan-owner" });
    assert.match(asOther, /cuma owner yang boleh/);

    for (const [i, sep] of ["=", "buat", "untuk"].entries()) {
      const reply = await buildChatReply(`cok tambah alias arttest${i} ${sep} aliasroutertarget`, { authorId: OWNER });
      assert.match(reply, /ditambahin/, sep);
    }

    // Gak salah ke-tangkep sama regex "tambah prioritas" (beda kata kunci)
    const reply = await buildChatReply("cok tambah prioritas anotherprioritytest", { authorId: OWNER });
    assert.match(reply, /ditambahin ke daftar prioritas/);
    assert.doesNotMatch(reply, /Alias/);
  } finally {
    global.fetch = original;
  }
});

// Owner minta ketikan "alias" doang udah cukup buat buka fitur alias, lengkap
// sama tombol Tutup buat yang salah ketik.
test("keyword 'alias' (polos / pake 'cok' / format tambah-hapus yang belum lengkap) -> layar daftar alias + tombol Tambah & Tutup", async () => {
  for (const text of ["cok alias", "alias", "cok daftar alias", "cok tambah alias", "cok hapus alias"]) {
    const reply = await buildChatReply(text, { isBotChannel: true, channelId: "c-alias-keyword", authorId: "siapa-aja" });
    assert.ok(reply && typeof reply === "object", `"${text}" harus balikin layar interaktif`);
    const customIds = reply.components.flatMap((row) => row.components.map((c) => c.data.custom_id));
    assert.ok(customIds.includes("alias_flow:add"), `"${text}" -> tombol Tambah alias`);
    assert.ok(customIds.includes("alias_flow:close"), `"${text}" -> tombol Tutup`);
  }
});

test("hapus alias / daftar alias - dispatch ke handleRemoveAlias/layar daftar alias", async () => {
  recordLiveCompleted("jkt48_hapusaliastarget", "Hapusaliastarget");
  const original = global.fetch;
  global.fetch = async (url, options) => {
    const { variables } = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({ data: { getPublicProfileByUsername: { username: variables.username, name: "Hapusaliastarget JKT48" } } }),
    };
  };
  try {
    await buildChatReply("cok tambah alias hapusaliastest = hapusaliastarget", { authorId: OWNER });

    const listed = await buildChatReply("cok daftar alias");
    assert.match(listed.content, /"hapusaliastest" -> "hapusaliastarget"/);

    const asOther = await buildChatReply("cok hapus alias hapusaliastest", { authorId: "bukan-owner" });
    assert.match(asOther, /cuma owner yang boleh/);

    const removed = await buildChatReply("cok hapus alias hapusaliastest", { authorId: OWNER });
    assert.match(removed, /"hapusaliastest" dihapus/);
  } finally {
    global.fetch = original;
  }
});

test("stats <nama> - dispatch ke replyMemberStats", async () => {
  const reply = textOf(await buildChatReply("cok stats statstestmember"));
  assert.match(reply, /belum ada data riwayat live buat "statstestmember"/);
});

test("berapa kali <nama> live - dispatch ke replyLiveCount", async () => {
  const reply = textOf(await buildChatReply("cok berapa kali liveCountRoutertest live"));
  assert.match(reply, /belum ada catatan live buat "livecountroutertest"/);
});

// Saran fitur ke-5 (§10's kelimapuluh+item): "cok streak <nama member>".
test("streak <nama> - dispatch ke replyStreak", async () => {
  const original = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ errors: [{ message: "User Not found" }] }) });
  try {
    const reply = textOf(await buildChatReply("cok streak streakroutertest", { authorId: "u-streak-router" }));
    assert.match(reply, /gak nemu member JKT48 bernama "streakroutertest"/);
  } finally {
    global.fetch = original;
  }
});

// Fitur "grafik" (chat/chartReply.js) - "grafik" maupun "chart" dua-duanya
// dikenalin, dan balesannya OBJECT {content, files} (PNG attachment), bukan
// string polos kayak kebanyakan reply lain.
test("grafik/chart <nama> - dispatch ke replyDurationChart, dua-duanya kata kunci dikenalin", async () => {
  recordLiveDuration("jkt48_chartroutertest", "Chartroutertest", 60 * 60_000);

  const reply = await buildChatReply("cok grafik chartroutertest");
  assert.match(reply.content, /Grafik durasi live \*\*Chartroutertest\*\*/);
  assert.equal(reply.files.length, 1);
  assert.equal(reply.files[0].name, "grafik-jkt48_chartroutertest.png");

  const replyViaChart = await buildChatReply("cok chart chartroutertest");
  assert.match(replyViaChart.content, /Grafik durasi live \*\*Chartroutertest\*\*/);
});

test("berapa kali si <nama> live - varian dengan 'si' juga jalan", async () => {
  const reply = textOf(await buildChatReply("cok berapa kali si liveCountRoutertest2 live"));
  assert.match(reply, /belum ada catatan live buat "livecountroutertest2"/);
});

// Bug beneran yang dilaporin user: "Lily berapa kali Live?" (NAMA duluan,
// bukan "berapa kali" duluan) malah kepick up sebagai fuzzy-match nama
// member (jatuh ke findDurationHistoryByNameFragment's "lagi nggak live
// sekarang" fallback) soalnya dulu liveCountMatch cuma punya 1 arah
// ("berapa kali <nama> live"). Ini pola sebaliknya - HARUS ketangkep
// duluan sebagai replyLiveCount, BUKAN jatuh ke fallback member-not-live.
test("<nama> berapa kali live - urutan NAMA duluan (laporan bug asli) dispatch ke replyLiveCount, BUKAN fallback 'lagi nggak live'", async () => {
  const reply = textOf(await buildChatReply("livecountnamefirsttest berapa kali live?"));
  assert.match(reply, /belum ada catatan live buat "livecountnamefirsttest"/);
  assert.doesNotMatch(reply, /lagi nggak live sekarang/);
});

test("<nama> berapa kali live - wake-word 'cok' di depan nama GAK ikut ke-capture jadi bagian nama", async () => {
  const reply = textOf(await buildChatReply("cok livecountcoktest berapa kali live?"));
  assert.match(reply, /belum ada catatan live buat "livecountcoktest"/);
  assert.doesNotMatch(reply, /"cok /); // fragment-nya harus "livecountcoktest" doang, bukan "cok livecountcoktest"
});

test("<nama> berapa kali live - varian 'udah berapa kali live'", async () => {
  const reply = textOf(await buildChatReply("livecountudahtest udah berapa kali live?"));
  assert.match(reply, /belum ada catatan live buat "livecountudahtest"/);
});

test("gifter <nama> - dispatch ke replyGifterSnapshot", async () => {
  const reply = await buildChatReply("cok gifter giftertestmember");
  assert.match(reply, /belum ada data top gifter buat "giftertestmember"/);
});

test("jadwal <nama> - dispatch ke replySchedulePattern", async () => {
  const reply = textOf(await buildChatReply("cok jadwal jadwaltestmember"));
  assert.match(reply, /belum ada riwayat live buat "jadwaltestmember"/);
});

test("kapan <nama> live - pola alternatif buat replySchedulePattern (nama keapit 'kapan'...'live')", async () => {
  const reply = textOf(await buildChatReply("cok kapan kapantestmember live"));
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
  if (/diexport ke CSV/.test(content)) {
    assert.ok(reply.files, "balesan yang ada datanya harus bawa file CSV");
  }
});

// §10's forty-second/forty-sixth item: "cok bandingin <A> dan <B>". Pemisahnya
// CUMA "dan" (owner minta "vs"/"versus" dibuang), kata kuncinya
// "bandingin"/"bandingkan"/"banding", dan "<A> dan <B>" doang (tanpa kata
// kunci) juga jadi perbandingan. Member di-seed langsung ke live-count.json
// (nama-nama unik, gak ada yang jadi awalan nama lain - pencocokan nama itu
// fuzzy-awalan) dan fetch di-mock biar foto profil gak nembak network beneran.
function withFakeIdn(fn) {
  return async () => {
    const original = global.fetch;
    global.fetch = async () => ({ ok: true, json: async () => ({ data: { getPublicProfileByUsername: null } }) });
    try {
      await fn();
    } finally {
      global.fetch = original;
    }
  };
}

recordLiveCompleted("jkt48_zorrawx", "Zorrawx JKT48");
recordLiveCompleted("jkt48_yelvaqp", "Yelvaqp JKT48");

test(
  "bandingin <A> dan <B> - dispatch ke replyCompareMembers (2 embed + tombol Tutup)",
  withFakeIdn(async () => {
    const reply = await buildChatReply("cok bandingin zorrawx dan yelvaqp");
    assert.equal(reply.content, "⚔️ **Zorrawx JKT48** dan **Yelvaqp JKT48**");
    assert.equal(reply.embeds.length, 2);
    assert.equal(reply.components[0].components[0].data.custom_id, "compare_pick:close");
  }),
);

test(
  "kata kunci 'bandingkan' dan 'banding' juga jalan, sama kayak 'bandingin'",
  withFakeIdn(async () => {
    for (const word of ["bandingkan", "banding"]) {
      const reply = await buildChatReply(`cok ${word} zorrawx dan yelvaqp`);
      assert.equal(reply.content, "⚔️ **Zorrawx JKT48** dan **Yelvaqp JKT48**", word);
    }
  }),
);

// Saran fitur ke-3: "cok bandingin A, B, dan C" - 3+ member sekaligus. Koma
// jadi sinyal pemicu (compareListFullMatch di router.js), dicek SEBELUM
// compareMatch 2-way di atas.
recordLiveCompleted("jkt48_qixolawp", "Qixolawp JKT48");

test(
  "bandingin A, B, dan C (koma) - dispatch ke replyCompareMembersMulti, BUKAN kesalah-parse jadi 2-way",
  withFakeIdn(async () => {
    const reply = await buildChatReply("cok bandingin zorrawx, yelvaqp, dan qixolawp");
    assert.equal(reply.content, "⚔️ **Zorrawx JKT48**, **Yelvaqp JKT48**, dan **Qixolawp JKT48**");
    assert.equal(reply.embeds.length, 3);
    assert.equal(reply.components[0].components[0].data.custom_id, "compare_pick:close");
  }),
);

test(
  "bandingin A, B, C (koma polos tanpa 'dan' sama sekali) juga jalan ke replyCompareMembersMulti",
  withFakeIdn(async () => {
    const reply = await buildChatReply("cok bandingin zorrawx, yelvaqp, qixolawp");
    assert.equal(reply.embeds.length, 3);
  }),
);

test(
  "bandingin A, B (koma, cuma 2) - TETAP lewat replyCompareMembers (2-member) yang sama, bukan versi multi",
  withFakeIdn(async () => {
    const reply = await buildChatReply("cok bandingin zorrawx, yelvaqp");
    assert.equal(reply.content, "⚔️ **Zorrawx JKT48** dan **Yelvaqp JKT48**");
    assert.equal(reply.embeds.length, 2);
  }),
);

test(
  "bandingin A dan B (TANPA koma) - dispatch lama (2-way) SAMA SEKALI gak kesentuh sama gerbang koma yang baru",
  withFakeIdn(async () => {
    const reply = await buildChatReply("cok bandingin zorrawx dan yelvaqp");
    assert.equal(reply.content, "⚔️ **Zorrawx JKT48** dan **Yelvaqp JKT48**");
    assert.equal(reply.embeds.length, 2);
  }),
);

test(
  "'<A> dan <B>' TANPA kata kunci (di belakang 'cok') langsung jadi perbandingan",
  withFakeIdn(async () => {
    const reply = await buildChatReply("cok zorrawx dan yelvaqp");
    assert.equal(reply.content, "⚔️ **Zorrawx JKT48** dan **Yelvaqp JKT48**");
  }),
);

test(
  "'<A> dan <B>' tanpa 'cok' di bot channel juga jadi perbandingan, tapi di channel biasa (tanpa 'cok') diabaikan kayak pesan biasa",
  withFakeIdn(async () => {
    const inBotChannel = await buildChatReply("Zorrawx dan Yelvaqp", { isBotChannel: true, channelId: "c-cmp", authorId: "u-cmp" });
    assert.equal(inBotChannel.content, "⚔️ **Zorrawx JKT48** dan **Yelvaqp JKT48**");

    const elsewhere = await buildChatReply("Zorrawx dan Yelvaqp", { isBotChannel: false });
    assert.equal(elsewhere, null);
  }),
);

// Bug yang dilaporin owner: "nala, lily, dan levi" (BARE, tanpa "cok
// bandingin" sama sekali) gak jadi perbandingan - cuma versi berkata kunci
// ("bandingin A, B, dan C") yang sebelumnya dukung 3+ member, bentuk bare
// (Zorrawx dan Yelvaqp") cuma nerima PERSIS dua nama. Sekarang koma jadi
// sinyal pemicu yang sama di bentuk bare juga.
recordLiveCompleted("jkt48_wovinatx", "Wovinatx JKT48");

test(
  "'<A>, <B>, dan <C>' BARE (tanpa 'bandingin') langsung jadi perbandingan 3-member",
  withFakeIdn(async () => {
    const reply = await buildChatReply("cok zorrawx, yelvaqp, dan qixolawp");
    assert.equal(reply.content, "⚔️ **Zorrawx JKT48**, **Yelvaqp JKT48**, dan **Qixolawp JKT48**");
    assert.equal(reply.embeds.length, 3);
  }),
);

test(
  "'<A>, <B>, <C>' BARE (koma polos tanpa 'dan' sama sekali) juga jalan",
  withFakeIdn(async () => {
    const reply = await buildChatReply("cok zorrawx, yelvaqp, qixolawp");
    assert.equal(reply.embeds.length, 3);
  }),
);

test(
  "'<A>, <B>, <C>, dan <D>' BARE 4 member sekaligus juga jalan",
  withFakeIdn(async () => {
    const reply = await buildChatReply("cok zorrawx, yelvaqp, qixolawp, dan wovinatx");
    assert.equal(reply.embeds.length, 4);
  }),
);

test(
  "'<A>, <B>' BARE (koma, cuma 2, tanpa 'bandingin') tetep lewat replyCompareMembers 2-member, bukan versi multi",
  withFakeIdn(async () => {
    const reply = await buildChatReply("cok zorrawx, yelvaqp");
    assert.equal(reply.content, "⚔️ **Zorrawx JKT48** dan **Yelvaqp JKT48**");
    assert.equal(reply.embeds.length, 2);
  }),
);

test(
  "'<A>, <B>, dan <C>' BARE tanpa 'cok' di bot channel juga jadi perbandingan, di channel biasa (tanpa 'cok') diabaikan",
  withFakeIdn(async () => {
    const inBotChannel = await buildChatReply("Zorrawx, Yelvaqp, dan Qixolawp", { isBotChannel: true, channelId: "c-cmp3", authorId: "u-cmp3" });
    assert.equal(inBotChannel.embeds.length, 3);

    const elsewhere = await buildChatReply("Zorrawx, Yelvaqp, dan Qixolawp", { isBotChannel: false });
    assert.equal(elsewhere, null);
  }),
);

test("kalimat biasa ber-koma yang gak nyebut member manapun gak dibajak jadi perbandingan bare", async () => {
  const reply = await buildChatReply("cok makan, minum, dan tidur");
  assert.doesNotMatch(JSON.stringify(reply), /⚔️|belum pernah live/);
});

test("'<A>, <B>, dan <A>' BARE (member yang sama muncul dobel) ditolak dengan pesan jelas, sama kayak versi berkata kunci", async () => {
  const reply = textOf(await buildChatReply("cok zorrawx, yelvaqp, dan zorrawx"));
  assert.match(reply, /gak bisa dibandingin sama diri sendiri/);
});

test("'vs' SUDAH BUKAN pemisah: 'bandingin <A> vs <B>' jatuh ke flow dropdown, dan '<A> vs <B>' polos bukan perbandingan", async () => {
  const withKeyword = await buildChatReply("cok bandingin zorrawx vs yelvaqp");
  assert.match(withKeyword.content, /berapa member/i);

  const bare = await buildChatReply("cok zorrawx vs yelvaqp");
  assert.doesNotMatch(JSON.stringify(bare), /⚔️|compare_pick/);
});

test("bandingin dengan SATU nama doang (pasangannya belum ada) - dispatch ke flow dropdown, bukan menu fallback generik", async () => {
  const reply = await buildChatReply("cok bandingin zorrawx");
  assert.match(reply.content, /berapa member/i);
});

test("member SAMA di dua sisi ('A dan A') ditolak dengan pesan jelas, baik pakai kata kunci maupun polos", async () => {
  for (const text of ["cok bandingin zorrawx dan zorrawx", "cok bandingkan zorrawx dan zorrawx", "cok zorrawx dan zorrawx"]) {
    const reply = textOf(await buildChatReply(text));
    assert.match(reply, /gak bisa dibandingin sama diri sendiri/, text);
  }
  // beda huruf besar/kecil + tambahan "JKT48" tetep dianggep orang yang sama
  const withJkt48 = textOf(await buildChatReply("cok bandingin Zorrawx dan zorrawx JKT48"));
  assert.match(withJkt48, /gak bisa dibandingin sama diri sendiri/);
});

test("kalimat biasa berpola '<kata> dan <kata>' yang BUKAN nama member gak dibajak jadi perbandingan", async () => {
  const reply = await buildChatReply("cok makan dan tidur");
  assert.doesNotMatch(JSON.stringify(reply), /⚔️|compare_pick|belum pernah live/);
});

// "cok bandingin" DIKETIK POLOS - owner ngeluh ini kepentok jatuh ke fallback
// menu 9-opsi generik. Harus dispatch ke flow dropdown (chat/compareFlow.js's
// replyStartComparePick), BUKAN replyFallbackMenu.
test("bandingin POLOS - dispatch ke flow dropdown pencarian, BUKAN fallback menu generik", async () => {
  for (const word of ["bandingin", "bandingkan", "banding"]) {
    const reply = await buildChatReply(`cok ${word}`);
    assert.match(reply.content, /berapa member/i, word);
    assert.doesNotMatch(reply.content, /selamat (pagi|siang|sore|malam)/i);
    const select = reply.components[0].components[0];
    assert.equal(select.data.custom_id, "compare_count", word);
    assert.deepEqual(
      select.options.map((o) => o.data.value),
      ["2", "3", "4", "5"],
    );
    assert.equal(reply.components[1].components[0].data.custom_id, "compare_pick:close", word);
  }
});

// Dicek SEBELUM check "live" + "siapa" polos (replyListLive) di router.js -
// kalimatnya juga ngandung "live" + "siapa", jadi harus ketangkep duluan
// sama check leaderboard yang lebih spesifik. "cok siapa yang live" (tanpa
// "paling sering") harus TETEP jatuh ke replyListLive seperti biasa.
test("siapa yang paling sering live - dispatch ke replyLiveCountLeaderboard, BUKAN replyListLive (siapa yang LAGI live sekarang)", async () => {
  const reply = textOf(await buildChatReply("cok siapa yang paling sering live"));
  assert.match(reply, /Paling sering live semenjak bot ini jalan|belum ada catatan live sama sekali/);
  assert.doesNotMatch(reply, /ini yang lagi live \(urut dari paling lama\)|lagi nggak ada member JKT48 yang live nih/);
});

test("siapa yang live (tanpa 'paling sering') - TETAP dispatch ke replyListLive seperti biasa, gak keganggu check leaderboard baru", async () => {
  const reply = await buildChatReply("cok siapa yang live");
  assert.match(reply, /ini yang lagi live \(urut dari paling lama\)|Cok, lagi nggak ada member JKT48 yang live nih/);
});

// Saran fitur ke-2 (§10's kelimapuluh item): "siapa yang paling lama gak
// live" - kebalikan leaderboard di atas. Dicek DULUAN sebelum check "paling
// lama live" (replyLongestLive) - dua-duanya sama-sama ngandung frasa
// "paling lama", jadi harus dipastiin yang lebih spesifik ini menang, BUKAN
// malah nyasar ke durasi live TERPANJANG.
test("siapa yang paling lama gak live - dispatch ke replyLongestNotLiveLeaderboard, BUKAN replyLongestLive (durasi live terpanjang)", async () => {
  for (const text of ["cok siapa yang paling lama gak live", "cok siapa yang paling jarang live"]) {
    const reply = await buildChatReply(text);
    assert.match(reply, /Paling lama gak live|belum ada catatan live sama sekali/, text);
    assert.doesNotMatch(reply, /^Paling lama live /, text);
  }
});

// Regresi yang DIJAGA lewat gerbang "siapa" wajib: kalimat wajar yang nanya
// SATU member spesifik ("nala kok lama gak live") kebetulan juga ngandung
// "live"+"gak"+"lama" - TANPA gerbang "siapa" ini bakal kebajak jadi
// leaderboard, padahal maksudnya nanya member itu doang.
test("'<nama member> kok lama gak live' (tanpa 'siapa') TETAP dijawab soal member itu, BUKAN kebajak jadi leaderboard", async () => {
  const reply = await buildChatReply("cok nala kok lama gak live");
  assert.doesNotMatch(textOf(reply), /Paling lama gak live/);
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
test("rekap polos (tanpa minggu/bulan/tanggal/hari) - dispatch ke menu 5-tombol (termasuk Rekap member) + Tutup", async () => {
  const reply = await buildChatReply("cok rekap");
  assert.equal(reply.content, "Mau rekap yang mana, cok?");
  const customIds = reply.components.flatMap((row) => row.components.map((c) => c.data.custom_id));
  assert.deepEqual(customIds, ["recap_menu:today", "recap_menu:week", "recap_menu:month", "recap_menu:date", "recap_menu:member", "recap_nav:close"]);
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

// replyHelp() balikin OBJECT {content, embeds} sekarang (bukan string polos
// lagi - content-nya doang dulu 2900-an karakter, ngelewatin batas 2000
// karakter Discord, itu penyebab bug "tombol Fitur lainnya kok kayak rusak"
// yang dilaporin owner, lihat replies.js's replyHelp). buildChatReply cuma
// nerusin apa adanya (safeReplyOptions di router.js's messageCreate nerima
// object), jadi dites di sini bentuknya, bukan lewat assert.match ke string.
test("help/bantuan - dispatch ke replyHelp", async () => {
  const reply = await buildChatReply("cok bantuan");
  assert.match(reply.content, /^Cok bisa jawab ini/);
  assert.match(reply.embeds[0].description, /cok streak/i);
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
  // Menu generik sekarang wizard berhalaman (owner minta dirombak dari
  // numpuk 9-12 tombol jadi 3 opsi/halaman, lihat menu.js's MENU_PAGES) -
  // halaman pertama = 2 baris (3 tombol opsi + baris Tutup/Menu lainnya),
  // beda dari fallback per-member yang cuma 1 baris/4 tombol (test di atas).
  assert.equal(reply.components.length, 2, "halaman pertama menu generik ada 2 baris (3 opsi + nav)");
  assert.equal(reply.components[0].components.length, 3, "3 tombol opsi di halaman pertama");
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

// §10's forty-eighth item: "rekap <nama member>" - dicek PALING AKHIR di dispatch
// "rekap" (setelah hari/minggu/bulan/tanggal/nama bulan/nama hari), jadi gak
// boleh nabrak satupun dari itu. Data member di-seed langsung (nama unik).
const rtrNowUnix = Math.floor(Date.now() / 1000);
for (let i = 0; i < 2; i++) {
  recordLiveEnded(
    "Rtrrecap JKT48",
    "jkt48_rtrrecap",
    new Date((rtrNowUnix - (i + 1) * 7200) * 1000),
    new Date((rtrNowUnix - (i + 1) * 7200 + 3600) * 1000),
    5,
  );
}
recordLiveCompleted("jkt48_rtrrecap", "Rtrrecap JKT48");

test("'cok rekap <nama member>' - dispatch ke tabel rekap member (cuma sesi dia, tombol Tutup doang, tanpa 'Cari member')", async () => {
  const reply = await buildChatReply("cok rekap rtrrecap", { channelId: "c-rtr1", authorId: "u-rtr1" });
  assert.match(reply.content, /📋 \*\*Rekap live Rtrrecap JKT48\*\*/);
  assert.match(reply.content, /Total sesi: 2x/);
  const ids = reply.components.flatMap((row) => row.components.map((c) => c.data.custom_id));
  assert.deepEqual(ids, ["recap_nav:close"]);
});

test("'rekap <nama>' tanpa 'cok' di bot channel juga jalan, dan kata pelengkap ('dong') diabaikan", async () => {
  const reply = await buildChatReply("rekap Rtrrecap dong", { isBotChannel: true, channelId: "c-rtr2", authorId: "u-rtr2" });
  assert.match(reply.content, /Rekap live Rtrrecap JKT48/);
});

test("kata kunci rekap lain TIDAK ketabrak rekap member: minggu ini / bulan ini / nama bulan / nama hari tetep ke jalurnya masing-masing", async () => {
  const week = await buildChatReply("cok rekap minggu ini", { channelId: "c-rtr3", authorId: "u-rtr3" });
  assert.match(textOf(week), /Rekap minggu ini|belum ada live yang kecatet dalam minggu ini/);

  const month = await buildChatReply("cok rekap bulan ini", { channelId: "c-rtr3", authorId: "u-rtr3" });
  assert.match(textOf(month), /Rekap bulan|belum ada live yang kecatet buat bulan|Mau rekap yang mana/);

  const monthName = await buildChatReply("cok rekap september", { channelId: "c-rtr3", authorId: "u-rtr3" });
  assert.doesNotMatch(textOf(monthName), /gak nemu member|belum pernah live/);

  const weekday = await buildChatReply("cok rekap senin", { channelId: "c-rtr3", authorId: "u-rtr3" });
  assert.doesNotMatch(textOf(weekday), /gak nemu member|belum pernah live/);
});

test("'cok rekap' polos dan 'cok rekap member' (tanpa nama) -> menu rekap yang sekarang punya tombol 'Rekap member'", async () => {
  for (const text of ["cok rekap", "cok rekap member"]) {
    const reply = await buildChatReply(text);
    assert.equal(reply.content, "Mau rekap yang mana, cok?", text);
    const ids = reply.components.flatMap((row) => row.components.map((c) => c.data.custom_id));
    assert.ok(ids.includes("recap_menu:member"), text);
  }
});

test(
  "kalimat rekap yang gak jelas ('cok rekap dong banget pokoknya') gak dianggep nama member - tetep menu; nama yang gak ada -> gak nemu + menu",
  withFakeIdn(async () => {
    const vague = await buildChatReply("cok rekap dong banget pokoknya");
    assert.equal(vague.content, "Mau rekap yang mana, cok?");

    const unknown = await buildChatReply("cok rekap namangawurbanget");
    assert.match(unknown.content, /gak nemu member JKT48 bernama "namangawurbanget"/);
    assert.match(unknown.content, /Mau rekap yang mana, cok\?/);
  }),
);

// Regresi (dilaporin owner): "nala & levi" gak jadi perbandingan - malah
// jatuh ke jawaban ngawur ("levi lagi gak live"). "&" itu setara "dan".
test(
  "'&' setara 'dan': 'nala & levi' (pakai/tanpa spasi, pakai/tanpa kata kunci, di bot channel) semuanya jadi perbandingan",
  withFakeIdn(async () => {
    const expected = "⚔️ **Zorrawx JKT48** dan **Yelvaqp JKT48**";
    for (const text of ["cok zorrawx & yelvaqp", "cok zorrawx&yelvaqp", "cok bandingin zorrawx & yelvaqp", "cok bandingkan zorrawx&yelvaqp"]) {
      const reply = await buildChatReply(text, { channelId: "c-amp", authorId: "u-amp" });
      assert.equal(reply.content, expected, text);
    }
    const inBotChannel = await buildChatReply("Zorrawx & Yelvaqp", { isBotChannel: true, channelId: "c-amp", authorId: "u-amp" });
    assert.equal(inBotChannel.content, expected);
  }),
);

test("'&' juga kena aturan member-sama: 'zorrawx & zorrawx' ditolak", async () => {
  const reply = textOf(await buildChatReply("cok zorrawx & zorrawx"));
  assert.match(reply, /gak bisa dibandingin sama diri sendiri/);
});

// Gerbang bentuk polos dulu cuma ngecek live-count.json - kalau file itu
// kosong/ke-reset, "nala dan levi" gak kedeteksi. Member prioritas (Nala/
// Levi/Lily, dari config) harus TETEP dikenali walau gak ada data tersimpan.
test(
  "bentuk polos tetep kedeteksi lewat daftar prioritas walau nama itu gak ada di live-count ('lily & <nama ngawur>' -> jawaban perbandingan, BUKAN menu fallback)",
  withFakeIdn(async () => {
    const reply = textOf(await buildChatReply("cok lily & namangawurbanget", { channelId: "c-amp2", authorId: "u-amp2" }));
    assert.equal(typeof reply, "string");
    assert.match(reply, /gak nemu member JKT48 bernama "namangawurbanget"/);
    assert.doesNotMatch(reply, /selamat (pagi|siang|sore|malam)/i);
  }),
);

test("bentuk polos '<kata biasa> & <kata biasa>' yang bukan nama member tetep gak dibajak", async () => {
  const reply = await buildChatReply("cok makan & tidur");
  assert.doesNotMatch(JSON.stringify(reply), /⚔️|compare_pick|belum pernah live|gak nemu member/);
});

// ==== Bug keyword yang dilaporin owner ("banyak keyword gak keluar") ====
// Semua dites di bot channel (gak perlu "cok"), sama kayak cara owner ngetik.
function inBotChannel(text, authorId = "u-keyword-regress") {
  return buildChatReply(text, { isBotChannel: true, channelId: "c-keyword-regress", authorId });
}

function isFallbackMenu(reply) {
  return typeof reply === "object" && /Klik salah satu di bawah/.test(reply.content || "");
}

test("status SATU member ('X masih live?', 'apakah X live', 'cek X', 'status X') -> jawaban soal member itu, BUKAN menu fallback/status bot", async () => {
  for (const text of [
    "kwregress masih live?",
    "kwregress live?",
    "kwregress lagi live gak",
    "apakah kwregress live",
    "cek kwregress",
    "cek member kwregress",
    "status kwregress",
  ]) {
    const reply = await inBotChannel(text);
    assert.ok(!isFallbackMenu(reply), `"${text}" gak boleh jatuh ke menu fallback`);
    assert.match(textOf(reply), /kwregress/, `"${text}" harus jawab soal member yang disebut`);
    assert.doesNotMatch(textOf(reply), /Bot jalan normal/, `"${text}" bukan status bot`);
  }
});

test("status member yang punya riwayat tapi lagi gak live -> 'lagi nggak live', kapan terakhir", async () => {
  recordLiveDuration("jkt48_kwhistory", "Kwhistory JKT48", 30 * 60_000);
  const reply = await inBotChannel("kwhistory masih live?");
  assert.match(textOf(reply), /\*\*Kwhistory JKT48\*\* lagi nggak live sekarang/);
});

test("pola status-member gak ngebajak kalimat umum: 'status bot', 'status', 'siapa yang live', 'masih live?'", async () => {
  assert.match(textOf(await inBotChannel("status bot")), /Bot jalan normal/);
  assert.match(textOf(await inBotChannel("status")), /Bot jalan normal/);
  assert.doesNotMatch(textOf(await inBotChannel("siapa yang live")), /nggak nemu member/);
  assert.doesNotMatch(textOf(await inBotChannel("masih live?")), /nggak nemu member "masih"/);
});

test("'kapan <nama> biasanya live?' (format di bantuan sendiri) - 'biasanya' gak ikut nyangkut ke nama member", async () => {
  const reply = await inBotChannel("kapan kwsched biasanya live?");
  assert.doesNotMatch(textOf(reply), /biasanya"/);
  assert.match(textOf(reply), /"kwsched"/);
});

test("'paling lama gak live' & 'paling jarang live' (label tombol menu sendiri) -> leaderboard gak-live, BUKAN durasi live terlama/menu fallback", async () => {
  recordLiveCompleted("jkt48_kwnotlive", "Kwnotlive");
  for (const text of ["paling lama gak live", "paling jarang live", "siapa yang paling lama gak live"]) {
    assert.match(textOf(await inBotChannel(text)), /Paling lama gak live/, `"${text}"`);
  }
  // kalimat soal SATU member (gak ada "paling"/"siapa") tetep gak kebajak
  assert.doesNotMatch(textOf(await inBotChannel("kwnotlive kok lama gak live")), /Paling lama gak live/);
});

test("'paling rame' (label tombol menu sendiri) -> jawaban penonton terbanyak, bukan menu fallback", async () => {
  const reply = await inBotChannel("paling rame");
  assert.ok(!isFallbackMenu(reply));
  assert.match(textOf(reply), /penonton|ditonton/i);
});

test("keyword POLOS tanpa nama ('grafik', 'stats', 'streak', dst) -> contoh cara pakai, bukan menu fallback", async () => {
  for (const keyword of ["grafik", "chart", "stats", "statistik", "streak", "jadwal", "gifter", "ingetin"]) {
    const reply = await inBotChannel(keyword);
    assert.equal(typeof reply, "string", `"${keyword}"`);
    assert.match(reply, /contoh/i, `"${keyword}" harus ngasih contoh`);
  }
  assert.match(await buildChatReply("cok grafik", { isBotChannel: false }), /grafik <nama member>/);
});

// Kasus "grafik erine" yang gak keluar apa-apa: kirim balesan gagal (paling
// mungkin izin "Attach Files" buat gambar grafik) dulu cuma masuk log.
test("replyWithFailureNotice - kirim gagal -> user tetep dapet penjelasan teks, gak diem", async () => {
  const originalError = console.error;
  console.error = () => {};
  try {
    const sentNotices = [];
    const message = { reply: async (payload) => sentNotices.push(payload) };
    const missingPermission = Object.assign(new Error("Missing Permissions"), { code: 50013 });

    await replyWithFailureNotice(message, { content: "grafik", files: [{}] }, missingPermission);
    assert.match(sentNotices[0].content, /izin "Attach Files"/);

    await replyWithFailureNotice(message, "teks biasa", Object.assign(new Error("lain"), { code: 50035 }));
    assert.match(sentNotices[1].content, /ada error pas ngirim balesannya/);

    const brokenMessage = { reply: async () => { throw new Error("gak bisa kirim apa-apa"); } }; // prettier-ignore
    await assert.doesNotReject(replyWithFailureNotice(brokenMessage, "x", missingPermission));
  } finally {
    console.error = originalError;
  }
});

// ==== Debug pass: rekap/export/paling-rame dengan kata waktu relatif ====
function yesterdaySession(username, name) {
  const end = new Date(Date.now() - 24 * 3600_000);
  recordLiveEnded(name, username, new Date(end.getTime() - 2 * 3600_000), end, 77);
  recordLiveCompleted(username, name);
}

test("rekap kemarin / rekap hari kemarin -> rekap TANGGAL KEMARIN (dulu: dianggep nama member kemarin dan nembak IDN, atau malah jawab rekap hari ini)", async () => {
  yesterdaySession("jkt48_kmrnrouter", "Kmrnrouter JKT48");
  const original = global.fetch;
  let fetchCalls = 0;
  global.fetch = async () => {
    fetchCalls += 1;
    throw new Error("gak boleh nembak IDN buat kata kemarin");
  };
  try {
    for (const text of ["rekap kemarin", "rekap hari kemarin", "cok rekap kemarin"]) {
      const reply = await inBotChannel(text);
      assert.match(textOf(reply), /Rekap tanggal/, text);
      assert.match(textOf(reply), /Kmrnrouter/, text + " harus nampilin sesi kemarin");
      assert.doesNotMatch(textOf(reply), /hari ini \(/, text + " bukan rekap hari ini");
    }
    assert.equal(fetchCalls, 0);
  } finally {
    global.fetch = original;
  }
});

test("rekap bulan lalu -> bulan SEBELUM bulan berjalan, bukan bulan ini", async () => {
  const [year, month] = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 7).split("-").map(Number);
  const prev = month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, "0")}`;
  const { formatMonthLabel } = require("../src/utils");
  const reply = await inBotChannel("rekap bulan lalu");
  assert.match(textOf(reply), new RegExp(formatMonthLabel(prev)));
});

test("minggu lalu ditolak EKSPLISIT di rekap/export/paling-rame (dulu diam-diam dijawab pake data minggu ini)", async () => {
  for (const text of ["rekap minggu lalu", "export rekap minggu lalu", "paling rame minggu lalu", "paling lama live pekan lalu"]) {
    assert.match(textOf(await inBotChannel(text)), /"minggu lalu" belum bisa dijawab/, text);
  }
  assert.doesNotMatch(textOf(await inBotChannel("kwrouterx minggu lalu live gak")), /belum bisa dijawab/);
});

test("paling rame kemarin / paling lama live kemarin / export rekap kemarin pake data KEMARIN (dulu diam-diam pake hari ini)", async () => {
  yesterdaySession("jkt48_kmrnstat", "Kmrnstat JKT48");
  assert.match(textOf(await inBotChannel("paling rame kemarin")), /kemarin/);
  assert.match(textOf(await inBotChannel("paling lama live kemarin")), /kemarin/);
  const exported = await inBotChannel("export rekap kemarin");
  assert.match(textOf(exported), /kemarin/);
  assert.ok(exported.files && exported.files.length === 1, "ada sesi kemarin -> CSV kekirim");
});

test("rekap 2026-09-25 (format ISO) kebaca sebagai tanggal, bukan jatuh ke menu", async () => {
  const reply = await inBotChannel("rekap 2026-09-25");
  assert.match(textOf(reply), /25 September 2026/);
});

test("keyword polos berhenti ingetin / tambah prioritas / hapus prioritas -> contoh cara pakai, bukan menu fallback", async () => {
  for (const [text, expected] of [
    ["berhenti ingetin", /berhenti ingetin <nama member>/],
    ["tambah prioritas", /tambah prioritas <nama member>/],
    ["hapus prioritas", /hapus prioritas <nama member>/],
  ]) {
    const reply = await inBotChannel(text);
    assert.equal(typeof reply, "string", text);
    assert.match(reply, expected);
  }
});

// ==== Fix sisa: nama member + rentang, tanggal mustahil ====
test("rekap <nama> <rentang> (minggu ini / hari ini / kemarin) -> rekap SATU member, bukan semua member", async () => {
  recordLiveEnded("Rtrnamea", "jkt48_rtrnamea", new Date(Date.now() - 3600_000), new Date(), 9);
  recordLiveCompleted("jkt48_rtrnamea", "Rtrnamea JKT48");
  recordLiveEnded("Rtrnameb", "jkt48_rtrnameb", new Date(Date.now() - 3600_000), new Date(), 9);
  recordLiveCompleted("jkt48_rtrnameb", "Rtrnameb JKT48");

  for (const text of ["rekap rtrnamea minggu ini", "cok rekap rtrnamea hari ini", "rekap minggu ini rtrnamea"]) {
    const reply = await inBotChannel(text);
    assert.match(textOf(reply), /Rtrnamea/, text);
    assert.doesNotMatch(textOf(reply), /Rtrnameb/, text + " gak boleh nampilin member lain");
  }
});

test("rekap <nama> <tanggal mustahil> dan export/paling-rame dengan tanggal mustahil ditolak eksplisit, bukan jatuh jadi rekap bulan", async () => {
  for (const text of ["rekap 31 februari", "cok rekap 2026-02-30", "export rekap 30 februari", "paling rame 31 april"]) {
    assert.match(textOf(await inBotChannel(text)), /itu gak ada di kalender/, text);
  }
  assert.doesNotMatch(textOf(await inBotChannel("rekap 25 september")), /gak ada di kalender/);
});

// ==== Tombol Tutup di balasan command "Fitur lainnya" yang diketik ====
test("balasan stats/berapa kali live/jadwal/streak/paling sering live/bandingin/export punya tombol Tutup (reply_close)", async () => {
  const original = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ errors: [{ message: "User Not found" }] }) });
  try {
    for (const text of [
      "cok stats closebtnmember",
      "cok berapa kali closebtnmember live",
      "cok jadwal closebtnmember",
      "cok kapan closebtnmember live",
      "cok streak closebtnmember",
      "cok siapa yang paling sering live",
      "cok bandingin closebtna dan closebtnb",
      "cok export rekap",
    ]) {
      const reply = await buildChatReply(text, { channelId: "c-closebtn", authorId: "u-closebtn" });
      assert.equal(typeof reply, "object", text);
      const ids = reply.components.flatMap((row) => row.toJSON().components.map((c) => c.custom_id));
      assert.deepEqual(ids, ["reply_close"], text);
    }
  } finally {
    global.fetch = original;
  }
});

test("withCloseButton - balasan yang udah punya tombol sendiri gak ditimpa; file/embeds ikut kebawa", () => {
  const { withCloseButton } = require("../src/chat/interactionHelpers");
  const own = { content: "x", components: [{ fake: true }] };
  assert.equal(withCloseButton(own), own);
  const withFile = withCloseButton({ content: "x", files: ["f"] });
  assert.deepEqual(withFile.files, ["f"]);
  assert.equal(withFile.components.length, 1);
});

test("interaksi reply_close ngehapus pesannya (deferUpdate lalu message.delete)", async () => {
  const { handleReplyCloseButton } = require("../src/chat/interactionHelpers");
  const calls = [];
  await handleReplyCloseButton({
    deferUpdate: async () => calls.push("defer"),
    message: { delete: async () => calls.push("delete") },
  });
  assert.deepEqual(calls, ["defer", "delete"]);
});

// ==== Review pass: rekap <nama> + nama hari / dua member ditolak jelas ====
test("rekap <nama> <nama hari> dan rekap <nama> <nama> <rentang> ditolak eksplisit, nama member gak diam-diam dibuang", async () => {
  recordLiveCompleted("jkt48_rtrwka", "Rtrwka JKT48");
  recordLiveCompleted("jkt48_rtrwkb", "Rtrwkb JKT48");
  assert.match(textOf(await inBotChannel("rekap rtrwka senin")), /"rtrwka" per nama hari belum bisa/);
  assert.match(textOf(await inBotChannel("rekap rtrwka rtrwkb minggu ini")), /cuma bisa SATU nama.*"rtrwka", "rtrwkb"/);
});
