const { test } = require("node:test");
const assert = require("node:assert/strict");
const { computeSchedulePattern, isHourInRange } = require("../src/schedulePattern");

function entry(atIso, durationMs) {
  return { name: "Test", durationMs, at: atIso };
}

test("computeSchedulePattern - kurang dari 3 entries -> null", () => {
  assert.equal(computeSchedulePattern([]), null);
  assert.equal(computeSchedulePattern([entry("2026-09-01T10:00:00+07:00", 60_000), entry("2026-09-02T10:00:00+07:00", 60_000)]), null);
});

test("computeSchedulePattern - pola jam siang yang konsisten -> topBucketName 'siang', rangeMin/rangeMax bener", () => {
  // Mulai live diperkirakan mundur (at - durationMs) - 3 entry mulai jam
  // 12:00, 12:30, 13:00 WIB (semua bucket "siang", 11-15).
  const pattern = computeSchedulePattern([
    entry("2026-09-01T13:00:00+07:00", 60 * 60_000), // mulai 12:00
    entry("2026-09-02T13:30:00+07:00", 60 * 60_000), // mulai 12:30
    entry("2026-09-03T14:00:00+07:00", 60 * 60_000), // mulai 13:00
  ]);
  assert.equal(pattern.total, 3);
  assert.equal(pattern.topBucketName, "siang");
  assert.equal(pattern.topBucketCount, 3);
  assert.equal(pattern.rangeMin, 12);
  assert.equal(pattern.rangeMax, 13);
});

// Bucket "malam" ngerangkum jam 18-23 SAMA 0-3 (nyebrang tengah malam) -
// tanpa penggeseran +24 di computeSchedulePattern, range min/max mentah
// bakal keliatan salah (mis. "00-23", nutupin seharian).
test("computeSchedulePattern - pola jam malam yang nyebrang tengah malam -> range tetep bener (bukan '00-23')", () => {
  const pattern = computeSchedulePattern([
    entry("2026-09-01T23:00:00+07:00", 60 * 60_000), // mulai 22:00
    entry("2026-09-02T00:30:00+07:00", 60 * 60_000), // mulai 23:30 (hari sebelumnya)
    entry("2026-09-03T01:00:00+07:00", 60 * 60_000), // mulai 00:00
  ]);
  assert.equal(pattern.topBucketName, "malam");
  assert.equal(pattern.rangeMin, 22);
  assert.equal(pattern.rangeMax, 0);
});

test("computeSchedulePattern - hari yang sering muncul (topWeekdayName/topWeekdayCount) kehitung bener", () => {
  const pattern = computeSchedulePattern([
    entry("2026-09-07T13:00:00+07:00", 60 * 60_000), // Senin
    entry("2026-09-14T13:00:00+07:00", 60 * 60_000), // Senin
    entry("2026-09-08T13:00:00+07:00", 60 * 60_000), // Selasa
  ]);
  assert.equal(pattern.topWeekdayName, "Senin");
  assert.equal(pattern.topWeekdayCount, 2);
});

test("isHourInRange - rentang normal (gak nyebrang tengah malam)", () => {
  assert.equal(isHourInRange(12, 11, 15), true);
  assert.equal(isHourInRange(11, 11, 15), true); // batas bawah inklusif
  assert.equal(isHourInRange(15, 11, 15), true); // batas atas inklusif
  assert.equal(isHourInRange(10, 11, 15), false);
  assert.equal(isHourInRange(16, 11, 15), false);
});

test("isHourInRange - rentang yang nyebrang tengah malam (min > max)", () => {
  assert.equal(isHourInRange(23, 22, 1), true);
  assert.equal(isHourInRange(0, 22, 1), true);
  assert.equal(isHourInRange(1, 22, 1), true);
  assert.equal(isHourInRange(22, 22, 1), true);
  assert.equal(isHourInRange(10, 22, 1), false); // jam siang, jelas di luar rentang malam ini
});
