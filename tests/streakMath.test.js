const { test } = require("node:test");
const assert = require("node:assert/strict");
const { computeCurrentStreak, shiftDateWIB, STREAK_MILESTONES } = require("../src/streakMath");

const TODAY = "2026-09-20";

test("shiftDateWIB - mundur/maju N hari, termasuk nyebrang bulan/tahun", () => {
  assert.equal(shiftDateWIB(TODAY, -1), "2026-09-19");
  assert.equal(shiftDateWIB(TODAY, 1), "2026-09-21");
  assert.equal(shiftDateWIB("2026-09-01", -1), "2026-08-31"); // nyebrang bulan
  assert.equal(shiftDateWIB("2027-01-01", -1), "2026-12-31"); // nyebrang tahun
});

test("computeCurrentStreak - gak ada data sama sekali, gak lagi live -> 0", () => {
  assert.equal(computeCurrentStreak(new Set(), TODAY), 0);
  assert.equal(computeCurrentStreak([], TODAY, false), 0);
});

test("computeCurrentStreak - cuma hari ini doang yang ada -> streak 1", () => {
  assert.equal(computeCurrentStreak(new Set([TODAY]), TODAY), 1);
});

test("computeCurrentStreak - 3 hari berturut-turut termasuk hari ini -> streak 3", () => {
  const dates = new Set([TODAY, shiftDateWIB(TODAY, -1), shiftDateWIB(TODAY, -2)]);
  assert.equal(computeCurrentStreak(dates, TODAY), 3);
});

test("computeCurrentStreak - ADA GAP di tengah -> streak cuma ngitung rangkaian TERUS-MENERUS dari hari ini mundur, berenti pas nemu gap", () => {
  // Hari ini & kemarin ada, tapi 2 hari lalu KOSONG, 3 hari lalu ada lagi -
  // yang 3-hari-lalu itu gak boleh ikut ke-hitung (gak nyambung).
  const dates = new Set([TODAY, shiftDateWIB(TODAY, -1), shiftDateWIB(TODAY, -3)]);
  assert.equal(computeCurrentStreak(dates, TODAY), 2);
});

test("computeCurrentStreak - hari ini KOSONG tapi kemarin ADA (harinya belum abis) -> streak masih 'hidup', dihitung dari kemarin mundur", () => {
  const yesterday = shiftDateWIB(TODAY, -1);
  const dates = new Set([yesterday, shiftDateWIB(TODAY, -2)]);
  assert.equal(computeCurrentStreak(dates, TODAY), 2);
});

test("computeCurrentStreak - hari ini MAUPUN kemarin dua-duanya kosong -> streak beneran PUTUS (0), walau ada data lebih lama", () => {
  const dates = new Set([shiftDateWIB(TODAY, -3), shiftDateWIB(TODAY, -4)]);
  assert.equal(computeCurrentStreak(dates, TODAY), 0);
});

test("computeCurrentStreak - isLiveNow=true (sesi hari ini BELUM selesai, jadi belum ada di `dates`) tetep ngitung hari ini sebagai aktif", () => {
  const yesterday = shiftDateWIB(TODAY, -1);
  const dates = new Set([yesterday]); // hari ini SENGAJA gak ada di sini (sesinya belum selesai)
  assert.equal(computeCurrentStreak(dates, TODAY, true), 2);
  assert.equal(computeCurrentStreak(dates, TODAY, false), 1); // tanpa isLiveNow, cuma kemarin doang yang kehitung
});

test("computeCurrentStreak - isLiveNow=true tapi TANPA histori apapun (live pertama kalinya) -> streak 1", () => {
  assert.equal(computeCurrentStreak(new Set(), TODAY, true), 1);
});

test("computeCurrentStreak - nerima array biasa, gak cuma Set", () => {
  assert.equal(computeCurrentStreak([TODAY, shiftDateWIB(TODAY, -1)], TODAY), 2);
});

test("STREAK_MILESTONES - array angka menaik, gak kosong", () => {
  assert.ok(Array.isArray(STREAK_MILESTONES) && STREAK_MILESTONES.length > 0);
  for (let i = 1; i < STREAK_MILESTONES.length; i++) {
    assert.ok(STREAK_MILESTONES[i] > STREAK_MILESTONES[i - 1], "harus urut menaik");
  }
});
