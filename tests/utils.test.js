// utils.js sengaja gak butuh setupTestEnv - fungsi-fungsinya murni (nggak
// nyentuh file/network/config), jadi bisa langsung di-require apa adanya.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  formatDuration,
  formatViewCount,
  formatClockWIB,
  getDateWIB,
  getTodayWIB,
  formatShortDateWIB,
  getHourWIBOf,
  getTimeOfDayBucket,
  describeElapsed,
  matchesNameFragment,
  containsWholeWord,
  stripTrailingLiveWord,
  pickRandom,
  YES_PATTERN,
  NO_PATTERN,
  NEXT_PAGE_PATTERN,
  PREV_PAGE_PATTERN,
  safeReplyOptions,
} = require("../src/utils");

test("formatDuration - jam & menit", () => {
  assert.equal(formatDuration(0), "0m");
  assert.equal(formatDuration(59_999), "0m"); // dibawah 1 menit dibulatin ke bawah
  assert.equal(formatDuration(60_000), "1m");
  assert.equal(formatDuration(3_600_000), "1j 0m");
  assert.equal(formatDuration(3_660_000), "1j 1m");
  assert.equal(formatDuration(-5000), "0m"); // clamp, gak boleh negatif
});

test("formatViewCount - pemisah ribuan gaya id-ID", () => {
  assert.equal(formatViewCount(0), "0");
  assert.equal(formatViewCount(1000), "1.000");
  assert.equal(formatViewCount(1234567), "1.234.567");
});

test("getDateWIB - tanggal WIB dari Date tertentu, bukan cuma sekarang", () => {
  // 15 Jan 2026, jam 20:00 WIB -> masih tanggal 15 di WIB
  assert.equal(getDateWIB(new Date("2026-01-15T20:00:00+07:00")), "2026-01-15");
  // 15 Jan 2026 17:30 UTC == 16 Jan 2026 00:30 WIB - nyebrang tengah malam
  assert.equal(getDateWIB(new Date("2026-01-15T17:30:00Z")), "2026-01-16");
});

test("getTodayWIB - delegasi ke getDateWIB() tanpa argumen (sekarang)", () => {
  assert.equal(getTodayWIB(), getDateWIB());
});

test("formatShortDateWIB - format DD/MM", () => {
  assert.equal(formatShortDateWIB(new Date("2026-01-05T10:00:00+07:00")), "05/01");
  assert.equal(formatShortDateWIB(new Date("2026-12-31T23:00:00+07:00")), "31/12");
});

// Owner minta jam mulai/selesai live (notif channel, recap, priority DM -
// semua lewat fungsi ini) nyantumin DETIK juga, bukan cuma jam.menit. Dites
// eksplisit di sini (bukan cuma diwarisi lewat pemanggilnya) biar ketauan
// LANGSUNG kalau ada yang nge-revert formatnya balik ke HH.MM doang.
test("formatClockWIB - format HH.MM.SS WIB, nyantumin detik", () => {
  assert.equal(formatClockWIB(new Date("2026-01-15T13:05:33+07:00")), "13.05.33 WIB");
  // Detik 0 tetep dipad jadi 2 digit ("00"), bukan ilang/jadi "0".
  assert.equal(formatClockWIB(new Date("2026-01-15T13:05:00+07:00")), "13.05.00 WIB");
});

test("getHourWIBOf - jam WIB dari Date tertentu", () => {
  assert.equal(getHourWIBOf(new Date("2026-01-15T20:00:00+07:00")), 20);
  assert.equal(getHourWIBOf(new Date("2026-01-15T23:59:00+07:00")), 23);
});

// Regresi: Intl.DateTimeFormat({hour12:false}) punya kuirk ICU yang
// ngebalikin "24" (bukan "0") buat SELURUH jam 00:00-00:59 WIB - kalau
// gak dinormalisasi, publicAlerts.js's maybeSendDailyRecap() jadi salah
// nganggep tengah malam "udah lewat jam rekap" (24 < 23 => false), bikin
// rekap harian 23:00 yang beneran diem-diem gak pernah kekirim. Dites
// tiap menit di jam pertama biar ketauan kalau kuirk-nya cuma di detik
// pertama doang (bukan, ini konsisten sepanjang jam 00:xx).
test("getHourWIBOf - jam 00:00-00:59 WIB harus balik 0, BUKAN 24 (kuirk ICU)", () => {
  for (const minute of ["00", "01", "30", "59"]) {
    assert.equal(getHourWIBOf(new Date(`2026-01-16T00:${minute}:00+07:00`)), 0, `jam 00:${minute} WIB harus 0`);
  }
});

test("getTimeOfDayBucket - batas-batas jam", () => {
  assert.equal(getTimeOfDayBucket(3), "malam");
  assert.equal(getTimeOfDayBucket(4), "pagi");
  assert.equal(getTimeOfDayBucket(10), "pagi");
  assert.equal(getTimeOfDayBucket(11), "siang");
  assert.equal(getTimeOfDayBucket(14), "siang");
  assert.equal(getTimeOfDayBucket(15), "sore");
  assert.equal(getTimeOfDayBucket(17), "sore");
  assert.equal(getTimeOfDayBucket(18), "malam");
  assert.equal(getTimeOfDayBucket(23), "malam");
});

test("describeElapsed - ambang 30 menit", () => {
  assert.match(describeElapsed(29 * 60_000), /^baru live/);
  assert.match(describeElapsed(30 * 60_000), /^udah live/);
});

test("matchesNameFragment - kata utuh, prefix >=3 huruf, typo-toleran", () => {
  assert.equal(matchesNameFragment("nala", "nala"), true);
  assert.equal(matchesNameFragment("nal", "nala"), true); // prefix 3 huruf
  assert.equal(matchesNameFragment("na", "nala"), false); // kependekan
  assert.equal(matchesNameFragment("nalabanget", "nala"), true); // needle lebih panjang, prefix cocok
  assert.equal(matchesNameFragment("levi", "nala"), false);
});

test("containsWholeWord - gak nyantol ke substring di tengah kata lain", () => {
  assert.equal(containsWholeWord("sedang live sekarang", "live"), true);
  assert.equal(containsWholeWord("lagi delivery paket", "live"), false);
  assert.equal(containsWholeWord("LIVE dong", "live"), true); // case-insensitive
});

test("stripTrailingLiveWord - buang ekor 'live'/'live?'", () => {
  assert.equal(stripTrailingLiveWord("nala live"), "nala");
  assert.equal(stripTrailingLiveWord("nala live?"), "nala");
  assert.equal(stripTrailingLiveWord("nala"), "nala");
});

test("pickRandom - selalu balikin elemen yang beneran ada di array", () => {
  const list = ["a", "b", "c"];
  for (let i = 0; i < 20; i++) {
    assert.ok(list.includes(pickRandom(list)));
  }
});

test("YES_PATTERN / NO_PATTERN", () => {
  for (const yes of ["y", "ya", "iya", "yes", "oke", "gas"]) assert.match(yes, YES_PATTERN);
  for (const no of ["n", "gak", "nggak", "tidak", "males"]) assert.match(no, NO_PATTERN);
  assert.doesNotMatch("kapan", YES_PATTERN);
  assert.doesNotMatch("kapan", NO_PATTERN);
});

// NEXT_PAGE_PATTERN/PREV_PAGE_PATTERN - alternatif kata kunci navigasi
// halaman rekap (chat/replies.js's tryHandleRecapPageShortcut), TERPISAH
// dari YES_PATTERN/NO_PATTERN biar gak nabrak arti "y"/"n" di flow
// konfirmasi lain (mis. watch-confirm di chat/menu.js).
test("NEXT_PAGE_PATTERN / PREV_PAGE_PATTERN", () => {
  for (const next of ["maju", "forward", "lanjut", "next", "berikutnya"]) assert.match(next, NEXT_PAGE_PATTERN);
  for (const prev of ["mundur", "balik", "kembali", "prev", "back"]) assert.match(prev, PREV_PAGE_PATTERN);
  assert.doesNotMatch("y", NEXT_PAGE_PATTERN); // "y" tetep cuma di YES_PATTERN, gak dobel di sini
  assert.doesNotMatch("kapan", NEXT_PAGE_PATTERN);
  assert.doesNotMatch("kapan", PREV_PAGE_PATTERN);
});

// Regresi buat celah mention-abuse: chat/router.js & chat/menu.js's tiap
// message.reply()/interaction.reply() WAJIB lewat sini biar allowedMentions
// selalu ke-pasang, gak peduli reply-nya balikin string mentah atau object
// {content, components, ...}.
test("safeReplyOptions - selalu nempelin allowedMentions:{parse:[]}, baik reply-nya string maupun object", () => {
  const fromString = safeReplyOptions("halo @everyone");
  assert.deepEqual(fromString, { content: "halo @everyone", allowedMentions: { parse: [] } });

  const fromObject = safeReplyOptions({ content: "pilih salah satu", components: ["dummy-row"], ephemeral: true });
  assert.deepEqual(fromObject, {
    content: "pilih salah satu",
    components: ["dummy-row"],
    ephemeral: true,
    allowedMentions: { parse: [] },
  });
});
