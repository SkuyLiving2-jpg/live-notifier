const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  START_LEAD_MINUTES,
  startRange,
  WEEKDAY_SLOTS,
  WEEKEND_SLOTS,
  dayOfWeek,
  isWeekend,
  slotsForDate,
  describeDayType,
  checkSession,
} = require("../src/chat/vcSlots");

const window = (slot) => `${slot.session}:${slot.open}-${slot.openEnd}`;

test("tabel hari kerja: sesi 1-3 dengan jendela buka 16.15-16.30, 17.45-18.00, 19.15-19.30", () => {
  assert.deepEqual(WEEKDAY_SLOTS.map(window), ["1:16:15-16:30", "2:17:45-18:00", "3:19:15-19:30"]);
});

test("tabel akhir pekan: sesi 1-3 jam sendiri (11.30/13.00/14.30), sesi 4-6 = sesi 1-3 hari kerja", () => {
  assert.deepEqual(WEEKEND_SLOTS.map(window), ["1:11:30-11:45", "2:13:00-13:15", "3:14:30-14:45", "4:16:15-16:30", "5:17:45-18:00", "6:19:15-19:30"]);
  for (let i = 0; i < 3; i++) {
    assert.equal(WEEKEND_SLOTS[i + 3].open, WEEKDAY_SLOTS[i].open);
    assert.equal(WEEKEND_SLOTS[i + 3].openEnd, WEEKDAY_SLOTS[i].openEnd);
  }
});

test("tabel tidak bisa diubah dari luar (dibekukan)", () => {
  assert.throws(() => {
    "use strict";
    WEEKDAY_SLOTS[0].open = "00:00";
  }, TypeError);
  assert.throws(() => WEEKEND_SLOTS.push({}), TypeError);
});

test("dayOfWeek - hari yang benar untuk tanggal kalender; tanggal tidak nyata/format salah -> null", () => {
  assert.equal(dayOfWeek("2026-10-15"), 4); // Kamis
  assert.equal(dayOfWeek("2026-10-17"), 6); // Sabtu
  assert.equal(dayOfWeek("2026-10-18"), 0); // Minggu
  assert.equal(dayOfWeek("2026-10-19"), 1); // Senin
  assert.equal(dayOfWeek("2024-02-29"), 4, "tahun kabisat");
  for (const bad of ["2026-02-30", "2026-13-01", "2026-10-32", "18/10/2026", "", null, undefined, "2026-1-1"]) {
    assert.equal(dayOfWeek(bad), null, String(bad));
  }
});

test("hari kerja vs akhir pekan: Senin-Jumat 3 sesi, Sabtu-Minggu 6 sesi (satu minggu penuh)", () => {
  const week = ["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25"]; // Senin-Minggu
  assert.deepEqual(
    week.map((d) => slotsForDate(d).length),
    [3, 3, 3, 3, 3, 6, 6],
  );
  assert.deepEqual(week.map(isWeekend), [false, false, false, false, false, true, true]);
  assert.equal(describeDayType("2026-10-19"), "hari kerja (Senin-Jumat)");
  assert.equal(describeDayType("2026-10-24"), "akhir pekan (Sabtu-Minggu)");
  assert.deepEqual(slotsForDate("bukan tanggal"), []);
});

test("checkSession - sesi yang ada balikin jendelanya; sesi 4-6 di hari kerja dan sesi >6 ditolak dengan pesan yang jelas", () => {
  assert.deepEqual(checkSession("2026-10-19", 2), {
    ok: true,
    value: { session: 2, open: "17:45", openEnd: "18:00", startFrom: "17:30", startTo: "17:45" },
  });
  assert.deepEqual(checkSession("2026-10-24", 6), {
    ok: true,
    value: { session: 6, open: "19:15", openEnd: "19:30", startFrom: "19:00", startTo: "19:15" },
  });

  for (const session of [4, 5, 6]) {
    const result = checkSession("2026-10-19", session);
    assert.equal(result.ok, false);
    assert.equal(result.error, `Sesi ${session} gak ada di hari Senin - hari kerja cuma sesi 1-3; sesi 4-6 cuma ada di Sabtu-Minggu.`);
  }
  assert.equal(checkSession("2026-10-23", 4).ok, false, "Jumat masih hari kerja");
  assert.equal(checkSession("2026-10-24", 7).error, "Sesi 7 gak ada di hari Sabtu - akhir pekan cuma sesi 1-6.");
  assert.equal(checkSession("2026-10-24", 0).ok, false);
  assert.equal(checkSession("2026-10-24", NaN).ok, false);
  assert.match(checkSession("bukan tanggal", 1).error, /tidak valid/);
});

test("nilai yang dikembalikan checkSession adalah salinan (mengubahnya tidak merusak tabel)", () => {
  const { value } = checkSession("2026-10-19", 1);
  value.open = "00:00";
  assert.equal(checkSession("2026-10-19", 1).value.open, "16:15");
});

test("rentang jam MULAI = 15 menit sebelum jam buka sampai jam buka, untuk semua sesi weekday & weekend", () => {
  const range = (date, session) => {
    const { value } = checkSession(date, session);
    return `${value.startFrom}-${value.startTo}`;
  };
  assert.deepEqual(
    [1, 2, 3].map((s) => range("2026-10-19", s)),
    ["16:00-16:15", "17:30-17:45", "19:00-19:15"],
  );
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6].map((s) => range("2026-10-24", s)),
    ["11:15-11:30", "12:45-13:00", "14:15-14:30", "16:00-16:15", "17:30-17:45", "19:00-19:15"],
  );
  for (const slot of [...WEEKDAY_SLOTS, ...WEEKEND_SLOTS]) {
    const to = startRange(slot);
    assert.equal(to.startTo, slot.open, "batas atas = jam buka");
    assert.equal(
      Number(slot.open.slice(0, 2)) * 60 + Number(slot.open.slice(3)) - (Number(to.startFrom.slice(0, 2)) * 60 + Number(to.startFrom.slice(3))),
      START_LEAD_MINUTES,
    );
  }
});
