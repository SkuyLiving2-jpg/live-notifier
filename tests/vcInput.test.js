require("./helpers/setupTestEnv");

const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  parseTime,
  formatTime,
  parseDateInput,
  formatDateDisplay,
  parseSessionNumber,
  parseTickets,
  parseLinkField,
  extractZoomId,
  formatZoomId,
  validateSessionForm,
} = require("../src/chat/vcInput");

const TODAY = "2026-10-15"; // Kamis

test("parseTime - format yang umum diketik semuanya jadi HH:MM", () => {
  const cases = {
    12.45: "12:45",
    "12:45": "12:45",
    1245: "12:45",
    945: "09:45",
    9.05: "09:05",
    13: "13:00",
    0: "00:00",
    "00.00": "00:00",
    23.59: "23:59",
    "12.45 wib": "12:45",
    " 14 . 30 ": "14:30",
    "12,45": "12:45",
  };
  for (const [input, expected] of Object.entries(cases)) {
    assert.deepEqual(parseTime(input), { ok: true, value: expected }, input);
  }
});

test("parseTime - jam/menit di luar jangkauan dan teks sampah ditolak dengan pesan yang menyebut kolomnya", () => {
  for (const bad of ["24.00", "12.60", "2400", "25", "abc", "", "12.5", "1:2:3", "12.45.10", "-1"]) {
    const result = parseTime(bad, "Jam buka");
    assert.equal(result.ok, false, bad);
    assert.match(result.error, /^Jam buka/);
  }
  assert.equal(parseTime(undefined).ok, false);
});

test("formatTime - gaya titik milik owner", () => {
  assert.equal(formatTime("12:45"), "12.45");
  assert.equal(formatTime("09:05"), "09.05");
});

test("parseDateInput - kata relatif, angka, nama bulan, hari di depan, dan ISO", () => {
  const cases = {
    "hari ini": "2026-10-15",
    besok: "2026-10-16",
    lusa: "2026-10-17",
    "18/10": "2026-10-18",
    "18-10": "2026-10-18",
    "18.10": "2026-10-18",
    "18/10/2026": "2026-10-18",
    "18/10/26": "2026-10-18",
    "18 oktober": "2026-10-18",
    "18 Okt": "2026-10-18",
    "18 okt 2026": "2026-10-18",
    "sabtu 18 oktober": "2026-10-18",
    "Sabtu, 18 Oktober": "2026-10-18",
    "2026-10-18": "2026-10-18",
    "2026-1-5": "2026-01-05",
    "1 agustus 2027": "2027-08-01",
    "3 des": "2026-12-03",
    "29 februari 2028": "2028-02-29",
  };
  for (const [input, expected] of Object.entries(cases)) {
    assert.deepEqual(parseDateInput(input, TODAY), { ok: true, value: expected }, input);
  }
});

test("parseDateInput - tanggal yang sudah lewat > 60 hari tanpa tahun dianggap tahun depan; yang baru lewat tetap tahun ini", () => {
  assert.equal(parseDateInput("5/1", "2026-12-20").value, "2027-01-05");
  assert.equal(parseDateInput("5 januari", "2026-12-20").value, "2027-01-05");
  assert.equal(parseDateInput("10/10", TODAY).value, "2026-10-10", "5 hari lalu: boleh (mencatat VC kemarin)");
  assert.equal(parseDateInput("20/8", TODAY).value, "2026-08-20", "56 hari lalu: masih tahun ini");
  assert.equal(parseDateInput("1/8", TODAY).value, "2027-08-01", "75 hari lalu: dianggap tahun depan");
});

test("parseDateInput - tanggal mustahil dan teks sampah ditolak", () => {
  for (const bad of [
    "31 februari",
    "29 februari 2027",
    "32/1",
    "0/5",
    "1/13",
    "2026-02-30",
    "2026-13-01",
    "besok lusa",
    "abc",
    "",
    "18",
    "18 foo",
    "oktober",
  ]) {
    const result = parseDateInput(bad, TODAY);
    assert.equal(result.ok, false, bad);
    assert.match(result.error, /gak/);
  }
  assert.equal(parseDateInput(undefined, TODAY).ok, false);
});

test("formatDateDisplay - nama hari WIB + tanggal panjang", () => {
  assert.equal(formatDateDisplay("2026-10-18"), "Minggu, 18 Oktober 2026");
  assert.equal(formatDateDisplay("2026-10-15"), "Kamis, 15 Oktober 2026");
});

test("parseSessionNumber - 1-99, boleh diawali kata sesi", () => {
  assert.deepEqual(parseSessionNumber("2"), { ok: true, value: 2 });
  assert.deepEqual(parseSessionNumber("Sesi 12"), { ok: true, value: 12 });
  assert.deepEqual(parseSessionNumber(" sesi3 "), { ok: true, value: 3 });
  for (const bad of ["0", "100", "-1", "dua", "", "1.5", "2a"]) assert.equal(parseSessionNumber(bad).ok, false, bad);
});

test("parseTickets - kosong = tidak ada info (null); 1-999 boleh dengan kata tiket; selain itu ditolak", () => {
  assert.deepEqual(parseTickets(""), { ok: true, value: null });
  assert.deepEqual(parseTickets("   "), { ok: true, value: null });
  assert.deepEqual(parseTickets(undefined), { ok: true, value: null });
  assert.deepEqual(parseTickets("3"), { ok: true, value: 3 });
  assert.deepEqual(parseTickets("5 tiket"), { ok: true, value: 5 });
  assert.deepEqual(parseTickets("999"), { ok: true, value: 999 });
  for (const bad of ["0", "1000", "-2", "banyak", "3.5"]) assert.equal(parseTickets(bad).ok, false, bad);
});

test("parseLinkField - link saja, link + kode sandi, dan variasi pembungkus/awalan", () => {
  const link = "https://us02web.zoom.us/j/87197929985?pwd=nAphf94DuyS05UmPIkj0hjRO39txqn.1";
  assert.deepEqual(parseLinkField(link), { ok: true, value: { link, passcode: null } });
  assert.deepEqual(parseLinkField(`${link} 388756`), { ok: true, value: { link, passcode: "388756" } });
  assert.deepEqual(parseLinkField(`<${link}> sandi:388756`), { ok: true, value: { link, passcode: "388756" } });
  assert.deepEqual(parseLinkField(`  ${link}   kode=Ab12  `), { ok: true, value: { link, passcode: "Ab12" } });
  assert.equal(parseLinkField("http://meet.example.com/abc").ok, true, "bukan Zoom pun boleh");
});

test("parseLinkField - bukan URL, skema berbahaya, terlalu panjang, sandi aneh, atau token berlebih ditolak", () => {
  const link = "https://us02web.zoom.us/j/87197929985";
  const bad = [
    "",
    "   ",
    "zoom.us/j/123",
    "javascript:alert(1)",
    "ftp://x.com/file",
    "file:///etc/passwd",
    `${link} 12`,
    `${link} abc-123`,
    `${link} 1234567890123`,
    `${link} 123456 tambahan`,
    `https://example.com/${"a".repeat(300)}`,
  ];
  for (const input of bad) assert.equal(parseLinkField(input).ok, false, input.slice(0, 40));
  assert.equal(parseLinkField(undefined).ok, false);
});

test("extractZoomId + formatZoomId - ID 11/10/9 digit diformat seperti di Zoom; non-Zoom/tanpa ID -> null", () => {
  assert.equal(extractZoomId("https://us02web.zoom.us/j/87197929985?pwd=abc"), "87197929985");
  assert.equal(formatZoomId("87197929985"), "871 9792 9985");
  assert.equal(extractZoomId("https://us02web.zoom.us/j/81331441967?pwd=x"), "81331441967");
  assert.equal(formatZoomId("81331441967"), "813 3144 1967");
  assert.equal(formatZoomId("8133144196"), "813 314 4196", "10 digit: 3-3-4");
  assert.equal(formatZoomId("813314419"), "813 314 419", "9 digit: 3-3-3");
  assert.equal(extractZoomId("https://zoom.us/wc/join/81331441967"), "81331441967");
  assert.equal(extractZoomId("https://us06web.zoom.us/s/81331441967"), null, "webinar /s/ bukan rapat");
  assert.equal(extractZoomId("https://meet.google.com/abc-defg-hij"), null);
  assert.equal(extractZoomId("https://evil-zoom.us.example.com/j/81331441967"), null, "host palsu yang mengandung zoom.us");
  assert.equal(extractZoomId("https://zoom.us/j/123"), null, "ID terlalu pendek");
  assert.equal(extractZoomId("bukan url"), null);
});

test("validateSessionForm - semua benar: nilai terparse lengkap", () => {
  const result = validateSessionForm(
    { sesi: "2", buka: "12.45", mulai: "13.00", link: "https://us02web.zoom.us/j/87197929985?pwd=abc 388756", tiket: "3" },
    TODAY,
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, {
    session: 2,
    open: "12:45",
    start: "13:00",
    link: "https://us02web.zoom.us/j/87197929985?pwd=abc",
    passcode: "388756",
    tickets: 3,
  });
  assert.deepEqual(result.errors, []);
});

test("validateSessionForm - SEMUA kesalahan dilaporkan sekaligus, bukan satu-satu", () => {
  const result = validateSessionForm({ sesi: "abc", buka: "99", mulai: "x", link: "bukan link", tiket: "-1" }, TODAY);
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 5);
});

test("validateSessionForm - jam buka tidak boleh lebih telat dari jam mulai (sama boleh)", () => {
  const base = { sesi: "1", link: "https://zoom.us/j/81331441967" };
  assert.equal(validateSessionForm({ ...base, buka: "14.00", mulai: "13.00" }, TODAY).ok, false);
  assert.match(validateSessionForm({ ...base, buka: "14.00", mulai: "13.00" }, TODAY).errors[0], /lebih telat/);
  assert.equal(validateSessionForm({ ...base, buka: "13.00", mulai: "13.00" }, TODAY).ok, true);
  assert.equal(validateSessionForm({ ...base, buka: "12.59", mulai: "13.00" }, TODAY).ok, true);
});

test("validateSessionForm - kolom yang tidak dikirim dilewati (modal edit sebagian); tanggal ikut kalau ada", () => {
  const onlyLink = validateSessionForm({ link: "https://zoom.us/j/81331441967 abc123" }, TODAY);
  assert.equal(onlyLink.ok, true);
  assert.deepEqual(Object.keys(onlyLink.value).sort(), ["link", "passcode"]);

  const edit = validateSessionForm({ sesi: "2", tanggal: "besok", buka: "12.45", mulai: "13.00", tiket: "" }, TODAY);
  assert.equal(edit.ok, true);
  assert.equal(edit.value.date, "2026-10-16");
  assert.equal(edit.value.tickets, null);
});
