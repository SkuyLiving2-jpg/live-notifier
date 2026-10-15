require("./helpers/setupTestEnv");

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { renderVcMessages, buildGroups, memberKey, cleanName, escapeMd, packBlocks, MESSAGE_LIMIT, SEPARATOR } = require("../src/chat/vcRender");

let nextId = 1;
function session(over = {}) {
  return {
    id: nextId++,
    username: "jkt48_michelle",
    name: "Michelle Levia JKT48",
    session: 1,
    date: "2026-10-18",
    open: "14:15",
    start: "14:30",
    tickets: null,
    link: "https://us02web.zoom.us/j/81331441967?pwd=abc",
    passcode: null,
    note: "Catatan absurd.",
    ...over,
  };
}

const data = (sessions, extra = {}) => ({ title: "VC Oktober 2026", opener: "Pembuka absurd.", sessions, nicknames: {}, ...extra });
const join = (messages) => messages.join("\n<<<PESAN BARU>>>\n");

test("cleanName / memberKey / escapeMd", () => {
  assert.equal(cleanName("Nala JKT48"), "Nala");
  assert.equal(cleanName("Piya | Karafuru Idol Group"), "Piya");
  assert.equal(cleanName("Kimmy"), "Kimmy");
  assert.equal(cleanName("JKT48"), "JKT48", "nama yang hanya JKT48 tidak dikosongkan");
  assert.equal(memberKey({ username: "jkt48_nala", name: "x" }), "jkt48_nala");
  assert.equal(memberKey({ username: null, name: "Lepi JKT48" }), "name:lepi");
  assert.equal(escapeMd("a*b_c~d`e|f>g#h@i\\j"), "a\\*b\\_c\\~d\\`e\\|f\\>g\\#h\\@i\\\\j");
});

test("render - judul, pembuka, dan pemisah; satu member biasa = format polos (bukan heading)", () => {
  const [msg] = renderVcMessages(data([session()]));
  assert.match(msg, /^# 🎬 VC Oktober 2026\n_Pembuka absurd\._\n━+/);
  assert.match(msg, /\*\*1\. Michelle Levia\*\*/);
  assert.match(msg, /📅 Minggu, 18 Oktober 2026/);
  assert.match(msg, /• Sesi 1 · Buka 14\.15 · Mulai 14\.30/);
  assert.match(msg, /<https:\/\/us02web\.zoom\.us\/j\/81331441967\?pwd=abc> \(🆔 813 3144 1967\)/);
  assert.match(msg, /↳ _Catatan absurd\._/);
  assert.doesNotMatch(msg, /^## /m, "member biasa tidak dapat heading spesial");
  assert.doesNotMatch(msg, /\n> /, "dan tidak pakai blok kutipan");
});

test("render - member PRIORITAS: heading besar + sirens + blok kutipan + tiket tebal + ID & sandi", () => {
  const [msg] = renderVcMessages(
    data([
      session({
        username: "jkt48_lily",
        name: "Lily JKT48",
        session: 2,
        open: "12:45",
        start: "13:00",
        tickets: 3,
        passcode: "388756",
        link: "https://us02web.zoom.us/j/87197929985?pwd=x",
      }),
    ]),
  );
  assert.match(msg, /^## 1\. 🚨✨🚨 LILY 🚨✨🚨$/m);
  assert.match(msg, /^\*\*📅 Minggu, 18 Oktober 2026\*\*$/m);
  assert.match(msg, /^> 🎬 \*\*Sesi 2\*\* · 🕐 Buka \*\*12\.45\*\* · ▶️ Mulai \*\*13\.00\*\* · 🎟️ \*\*3 tiket\*\*$/m);
  assert.match(msg, /^> 🔗 <https:\/\/us02web\.zoom\.us\/j\/87197929985\?pwd=x>$/m);
  assert.match(msg, /^> 🆔 871 9792 9985 · 🔑 388756$/m);
  assert.match(msg, /^> 💬 _Catatan absurd\._$/m);
});

test("render - PRIORITAS SELALU di atas walau tanggalnya lebih belakang; di dalam kelompok urut tanggal lalu jam", () => {
  const sessions = [
    session({ username: "jkt48_aralie", name: "Aralie JKT48", date: "2026-10-10", start: "09:00", open: "08:30" }), // biasa, paling awal
    session({ username: "jkt48_lily", name: "Lily JKT48", date: "2026-10-25", start: "20:00", open: "19:30" }), // prioritas, paling akhir
    session({ username: "jkt48_levi", name: "Levi JKT48", date: "2026-10-12", start: "13:00", open: "12:30" }), // prioritas
    session({ username: "jkt48_nala", name: "Nala JKT48", date: "2026-10-12", start: "13:00", open: "12:30" }), // prioritas, jam sama dgn Levi
    session({ username: "jkt48_zee", name: "Zee JKT48", date: "2026-10-11", start: "10:00", open: "09:30" }), // biasa
  ];
  const groups = buildGroups(sessions);
  assert.deepEqual(
    groups.map((g) => cleanName(g.name)),
    ["Nala", "Levi", "Lily", "Aralie", "Zee"],
    "prioritas dulu (tanggal, jam, lalu peringkat: Nala #1 sebelum Levi #2), lalu member biasa menurut tanggal",
  );
  assert.ok(groups.slice(0, 3).every((g) => g.priority));
  assert.ok(groups.slice(3).every((g) => !g.priority));
});

test("render - satu member dengan beberapa sesi digabung di SATU judul; tanggal sama tidak diulang, tanggal beda dapat baris sendiri", () => {
  const sessions = [
    session({ username: "jkt48_lily", name: "Lily JKT48", session: 3, date: "2026-10-18", start: "14:30", open: "14:15" }),
    session({ username: "jkt48_lily", name: "Lily JKT48", session: 2, date: "2026-10-18", start: "13:00", open: "12:45" }),
    session({ username: "jkt48_lily", name: "Lily JKT48", session: 1, date: "2026-10-25", start: "10:00", open: "09:45" }),
  ];
  const [msg] = renderVcMessages(data(sessions));
  assert.equal((msg.match(/^## /gm) || []).length, 1, "satu heading");
  assert.equal((msg.match(/📅 Minggu, 18 Oktober 2026/g) || []).length, 1, "tanggal sama tampil sekali");
  assert.equal((msg.match(/📅 Minggu, 25 Oktober 2026/g) || []).length, 1);
  assert.ok(msg.indexOf("Sesi 2") < msg.indexOf("Sesi 3"), "jam 13.00 sebelum 14.30");
  assert.ok(msg.indexOf("Sesi 3") < msg.indexOf("Sesi 1"), "tanggal 18 sebelum tanggal 25");
});

test("render - julukan: priority = JULUKAN (NAMA) huruf besar; biasa = **n. julukan** (nama); julukan bisa dipasang ke member non-IDN", () => {
  const sessions = [session({ username: "jkt48_lily", name: "Lily JKT48" }), session({ username: null, name: "Lepi" })];
  const [msg] = renderVcMessages(data(sessions, { nicknames: { jkt48_lily: "Cece Adik Aing", "name:lepi": "My Pumpkin" } }));
  assert.match(msg, /^## 1\. 🚨✨🚨 CECE ADIK AING \(LILY\) 🚨✨🚨$/m);
  assert.match(msg, /^\*\*2\. My Pumpkin\*\* \(Lepi\)$/m);
});

test("render - karakter markdown/mention di nama, julukan, judul, catatan, dan sandi dinetralkan", () => {
  const sessions = [session({ username: null, name: "*Bold* @everyone _x_", note: "pakai *bintang* dan @here", passcode: "ab12" })];
  const [msg] = renderVcMessages(data(sessions, { title: "VC #1 @everyone", nicknames: { "name:*bold* @everyone _x_": "**nick**" } }));
  assert.match(msg, /# 🎬 VC \\#1 \\@everyone/);
  assert.ok(!/(^|[^\\])@everyone/.test(msg), "tidak ada @everyone yang lolos tanpa escape");
  assert.ok(!/(^|[^\\])@here/.test(msg));
  assert.ok(!/(^|[^\\])\*\*nick/.test(msg), "julukan tidak bisa membuka tebal");
});

test("render - kosong: tetap ada judul dan petunjuk, tanpa pemisah/kelompok", () => {
  const messages = renderVcMessages(data([]));
  assert.equal(messages.length, 1);
  assert.match(messages[0], /# 🎬 VC Oktober 2026/);
  assert.match(messages[0], /Belum ada sesi/);
  assert.doesNotMatch(messages[0], new RegExp(SEPARATOR));
});

test("render - tanpa opener/title/note/tiket/sandi/ID Zoom: tidak ada baris kosong atau 'undefined'", () => {
  const messages = renderVcMessages({
    title: null,
    opener: null,
    nicknames: undefined,
    sessions: [session({ note: null, tickets: null, passcode: null, link: "https://meet.example.com/abc" })],
  });
  const text = join(messages);
  assert.match(text, /# 🎬 VC/);
  assert.doesNotMatch(text, /undefined|null|NaN|🆔|🔑|↳/);
});

test("render - banyak sesi dipecah jadi beberapa pesan <= batas, tidak ada pesan yang kosong atau diawali pemisah, dan tidak ada sesi hilang", () => {
  const sessions = [];
  for (let i = 0; i < 60; i++) {
    sessions.push(
      session({
        username: `jkt48_m${i}`,
        name: `Member Nomor ${i} JKT48`,
        session: (i % 3) + 1,
        date: `2026-10-${String(10 + (i % 15)).padStart(2, "0")}`,
        note: "Catatan absurd yang cukup panjang supaya pesannya cepat penuh dan harus dipecah.",
      }),
    );
  }
  const messages = renderVcMessages(data(sessions));
  assert.ok(messages.length > 1);
  for (const m of messages) {
    assert.ok(m.length <= MESSAGE_LIMIT, `pesan ${m.length} karakter`);
    assert.ok(m.trim().length > 0);
    assert.ok(!m.startsWith(SEPARATOR), "pesan lanjutan tidak boleh diawali pemisah");
  }
  const text = join(messages);
  for (let i = 0; i < 60; i++) assert.ok(text.includes(`Member Nomor ${i}**`), `member ${i} hilang`);
  assert.ok(messages[0].startsWith("# 🎬"), "judul hanya di pesan pertama");
  assert.equal((text.match(/^# /gm) || []).length, 1);
});

test("render - satu member dengan sesi sangat banyak (satu blok > batas) dipecah per baris, tidak ada baris terpotong", () => {
  const sessions = [];
  for (let i = 0; i < 40; i++)
    sessions.push(
      session({
        username: "jkt48_banyak",
        name: "Banyak JKT48",
        session: (i % 99) + 1,
        date: `2026-11-${String(1 + (i % 28)).padStart(2, "0")}`,
        note: "Catatan absurd yang panjang sekali supaya satu blok melewati batas pesan.",
      }),
    );
  const messages = renderVcMessages(data(sessions));
  assert.ok(messages.length > 1);
  assert.ok(messages.every((m) => m.length <= MESSAGE_LIMIT));
  assert.equal((join(messages).match(/🔗/g) || []).length, 0, "member biasa tidak memakai ikon 🔗");
  assert.equal((join(messages).match(/• Sesi/g) || []).length, 40, "semua 40 sesi tampil");
});

test("packBlocks - gabung rapi, pecah blok raksasa per baris, baris tunggal yang melebihi batas dipotong dengan …", () => {
  assert.deepEqual(packBlocks(["a", "b", "c"], 100), ["a\n\nb\n\nc"]);
  assert.deepEqual(packBlocks(["aaaa", "bbbb"], 8), ["aaaa", "bbbb"]);
  const big = ["x".repeat(30), "y".repeat(30), "z".repeat(30)].join("\n");
  const packed = packBlocks([big], 70);
  assert.equal(packed.length, 2);
  assert.ok(packed.every((p) => p.length <= 70));
  const one = packBlocks(["w".repeat(500)], 100);
  assert.equal(one.length, 1);
  assert.ok(one[0].length <= 100 && one[0].endsWith("…"));
  assert.deepEqual(packBlocks([], 100), []);
});

test("render - semua pesan hasil render aman untuk limit Discord 2000 pada kasus terburuk (nama & catatan panjang, banyak escape)", () => {
  const sessions = [];
  for (let i = 0; i < 30; i++) {
    sessions.push(
      session({
        username: null,
        name: `${"*".repeat(30)} Nama ${i}`,
        note: "_".repeat(150),
        passcode: "ab12",
        link: `https://zoom.us/j/81331441967?pwd=${"a".repeat(200)}`,
      }),
    );
  }
  for (const m of renderVcMessages(data(sessions))) assert.ok(m.length <= 2000, `pesan ${m.length} karakter`);
});
