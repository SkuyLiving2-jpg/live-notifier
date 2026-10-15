require("./helpers/setupTestEnv");

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { generateNote, generateOpener, SUBJECTS, PREDICATES, CLOSERS } = require("../src/chat/vcAbsurd");

// RNG deterministik (mulberry32): seed yang berdekatan tetap menghasilkan urutan yang tidak berkorelasi
// (LCG sederhana tidak - nilai pertamanya hampir sama untuk seed berurutan, jadi pemilihan templat selalu jatuh ke jenis yang sama).
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BAD_TEXT = /undefined|null|NaN|\[object|\{|\}|\$\{|\s{2,}/;

test("generateNote - deterministik untuk rng yang sama", () => {
  const args = { name: "Lily JKT48", tickets: 3, open: "12:45", start: "13:00" };
  assert.equal(generateNote({ ...args, rng: seeded(7) }), generateNote({ ...args, rng: seeded(7) }));
  assert.notEqual(generateNote({ ...args, rng: seeded(7) }), generateNote({ ...args, rng: seeded(8) }));
});

test("generateNote - 3000 sampel: satu baris, tidak ada placeholder bocor, panjang wajar, dan sangat bervariasi", () => {
  const unique = new Set();
  const rng = seeded(42);
  for (let i = 0; i < 3000; i++) {
    const note = generateNote({
      name: i % 5 === 0 ? "Piya | Grup Lain" : "Michelle Levia JKT48",
      tickets: i % 3 === 0 ? (i % 7) + 1 : null,
      open: i % 2 === 0 ? "12:45" : null,
      start: i % 2 === 0 ? ["13:00", "12:45", "15:30"][i % 3] : null,
      rng,
    });
    assert.ok(note.length >= 15 && note.length <= 260, `panjang ${note.length}: ${note}`);
    assert.doesNotMatch(note, BAD_TEXT, note);
    assert.ok(!note.includes("\n"), "harus satu baris");
    assert.match(note, /[.!]$/, `harus berakhir titik: ${note}`);
    unique.add(note);
  }
  assert.ok(unique.size > 1500, `variasi kurang: hanya ${unique.size} unik dari 3000`);
});

test("generateNote - tanpa data opsional tetap jalan (tidak melempar, tidak ada 'undefined')", () => {
  for (const args of [{}, { name: "" }, { name: null }, { tickets: 0 }, { open: "12:00" }, { name: "  " }]) {
    const note = generateNote({ ...args, rng: seeded(3) });
    assert.doesNotMatch(note, BAD_TEXT);
    assert.ok(note.length > 10);
  }
  assert.ok(generateNote().length > 10, "tanpa argumen sama sekali");
});

test("generateNote - templat tiket muncul dan menyebut jumlah yang benar; 1 tiket punya kalimat khusus", () => {
  const seen = new Set();
  for (let i = 0; i < 400; i++) seen.add(generateNote({ name: "Lily", tickets: 5, rng: seeded(i) }));
  assert.ok(
    [...seen].some((n) => /\b5 tiket\b|tiket 5/.test(n)),
    "harus ada kalimat yang menyebut 5 tiket",
  );
  assert.ok(
    [...seen].every((n) => !/\b[0-46-9] tiket\b/.test(n)),
    "tidak boleh menyebut jumlah tiket yang salah",
  );
  const single = new Set();
  for (let i = 0; i < 400; i++) single.add(generateNote({ name: "Lily", tickets: 1, rng: seeded(i) }));
  assert.ok([...single].some((n) => /Cuma 1 tiket/.test(n)));
});

test("generateNote - templat jeda jam: menghitung menit buka->mulai dengan benar, dan kasus 0 / >= 60 menit", () => {
  const notes = (open, start) => {
    const out = new Set();
    for (let i = 0; i < 400; i++) out.add(generateNote({ name: "Lily", open, start, rng: seeded(i) }));
    return [...out];
  };
  assert.ok(notes("12:45", "13:00").some((n) => /15 menit/.test(n)));
  assert.ok(notes("12:00", "13:30").some((n) => /Jeda 90 menit/.test(n)));
  assert.ok(notes("13:00", "13:00").some((n) => /jam yang sama/.test(n)));
});

test("generateOpener - memuat judul pada templat yang memakainya, satu baris, tanpa placeholder bocor, variasi tinggi", () => {
  const unique = new Set();
  const rng = seeded(99);
  let withTitle = 0;
  for (let i = 0; i < 2000; i++) {
    const opener = generateOpener({ title: "VC Oktober 2026", rng });
    assert.ok(opener.length >= 20 && opener.length <= 300, `panjang ${opener.length}: ${opener}`);
    assert.doesNotMatch(opener, BAD_TEXT, opener);
    assert.ok(!opener.includes("\n"));
    if (opener.includes("VC Oktober 2026")) withTitle++;
    unique.add(opener);
  }
  assert.ok(unique.size > 1000, `variasi kurang: ${unique.size}`);
  assert.ok(withTitle > 500, "sebagian besar templat menyebut judulnya");
  assert.doesNotMatch(generateOpener({ rng: seeded(1) }), BAD_TEXT, "tanpa judul pun aman");
});

test("pool kata - tidak ada entri kosong/duplikat, subjek berhuruf kapital, penutup berakhir titik, predikat tanpa titik", () => {
  for (const pool of [SUBJECTS, PREDICATES, CLOSERS]) {
    assert.equal(new Set(pool).size, pool.length, "ada duplikat");
    assert.ok(pool.every((x) => x.trim() === x && x.length > 3));
  }
  assert.ok(SUBJECTS.every((s) => /^[A-Z]/.test(s) && !/[.!?]$/.test(s)));
  assert.ok(PREDICATES.every((s) => !/[.!?]$/.test(s)));
  assert.ok(CLOSERS.every((s) => /[.!]$/.test(s)));
});
