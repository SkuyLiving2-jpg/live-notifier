// Jadwal sesi VC: sesi apa saja yang ada di suatu hari, dan JENDELA JAM BUKA tiap sesi (buka - tutup antrean, mis. 16.15 - 16.30).
// Murni dan tanpa dependensi (tanggal "YYYY-MM-DD" kalender WIB, tidak ada zona waktu yang ikut campur).
//   Hari kerja (Senin-Jumat): sesi 1-3.
//   Akhir pekan (Sabtu-Minggu): sesi 1-6; sesi 4-6 memakai jendela yang sama dengan sesi 1-3 hari kerja.
// Jam MULAI diisi manual owner (dasar pengingat), tapi dibatasi RUMUS: dari 15 menit sebelum jam buka sampai jam buka
// (jendela buka 16.15-16.30 -> mulai 16.00-16.15). Batasnya (startFrom/startTo) ikut dikembalikan checkSession.
// Hari libur nasional tidak dikenali: kalau ada VC "hari kerja" di tanggal merah, pakai aturan Senin-Jumat apa adanya.

const WEEKDAY_SLOTS = Object.freeze(
  [
    { session: 1, open: "16:15", openEnd: "16:30" },
    { session: 2, open: "17:45", openEnd: "18:00" },
    { session: 3, open: "19:15", openEnd: "19:30" },
  ].map(Object.freeze),
);

const WEEKEND_SLOTS = Object.freeze(
  [
    { session: 1, open: "11:30", openEnd: "11:45" },
    { session: 2, open: "13:00", openEnd: "13:15" },
    { session: 3, open: "14:30", openEnd: "14:45" },
    ...WEEKDAY_SLOTS.map((slot) => ({ ...slot, session: slot.session + 3 })),
  ].map(Object.freeze),
);

const START_LEAD_MINUTES = 15;

// "16:15" - 15 menit -> "16:00". Jendela buka paling awal 11:30, jadi tidak pernah melewati tengah malam.
function minusMinutes(hhmm, minutes) {
  const total = Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5)) - minutes;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

// Rentang jam MULAI yang sah untuk sebuah slot: [15 menit sebelum buka, jam buka].
const startRange = (slot) => ({ startFrom: minusMinutes(slot.open, START_LEAD_MINUTES), startTo: slot.open });

const DAY_NAMES = ["Minggu", "Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu"];

// 0 (Minggu) - 6 (Sabtu) untuk "YYYY-MM-DD", atau null kalau bukan tanggal yang nyata.
function dayOfWeek(dateWIB) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateWIB ?? ""));
  if (!m) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return d.getUTCDay();
}

const isWeekend = (dateWIB) => {
  const dow = dayOfWeek(dateWIB);
  return dow === 0 || dow === 6;
};

// Sesi yang ada di tanggal itu (urut sesi). Tanggal tidak valid -> [].
function slotsForDate(dateWIB) {
  const dow = dayOfWeek(dateWIB);
  if (dow === null) return [];
  return dow === 0 || dow === 6 ? WEEKEND_SLOTS : WEEKDAY_SLOTS;
}

// Teks jenis hari untuk layar/pesan: "hari kerja (Senin-Jumat)" / "akhir pekan (Sabtu-Minggu)".
function describeDayType(dateWIB) {
  return isWeekend(dateWIB) ? "akhir pekan (Sabtu-Minggu)" : "hari kerja (Senin-Jumat)";
}

// { ok: true, value: { session, open, openEnd, startFrom, startTo } } atau { ok: false, error } - dipakai semua tempat yang menerima nomor sesi.
function checkSession(dateWIB, session) {
  const dow = dayOfWeek(dateWIB);
  if (dow === null) return { ok: false, error: `Tanggal "${dateWIB}" tidak valid, jadi sesinya tidak bisa dicek.` };
  const slots = slotsForDate(dateWIB);
  const slot = slots.find((s) => s.session === session);
  if (slot) return { ok: true, value: { session: slot.session, open: slot.open, openEnd: slot.openEnd, ...startRange(slot) } };
  const last = slots[slots.length - 1].session;
  const hint = isWeekend(dateWIB) ? `akhir pekan cuma sesi 1-${last}` : `hari kerja cuma sesi 1-${last}; sesi 4-6 cuma ada di Sabtu-Minggu`;
  return { ok: false, error: `Sesi ${session} gak ada di hari ${DAY_NAMES[dow]} - ${hint}.` };
}

module.exports = { START_LEAD_MINUTES, startRange, WEEKDAY_SLOTS, WEEKEND_SLOTS, dayOfWeek, isWeekend, slotsForDate, describeDayType, checkSession };
