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
  linkKey,
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

const SATURDAY = "2026-10-17";
const MONDAY = "2026-10-19";

test("validateSessionForm - semua benar: nilai terparse lengkap; jam buka (jendela) diturunkan dari tanggal+sesi, bukan diketik", () => {
  const result = validateSessionForm({ mulai: "13.00", link: "https://us02web.zoom.us/j/87197929985?pwd=abc 388756", tiket: "3" }, TODAY, {
    date: SATURDAY,
    session: 2,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, {
    start: "13:00",
    link: "https://us02web.zoom.us/j/87197929985?pwd=abc",
    passcode: "388756",
    tickets: 3,
    open: "13:00",
    openEnd: "13:15",
  });
  assert.deepEqual(result.errors, []);
});

test("validateSessionForm - SEMUA kesalahan dilaporkan sekaligus, bukan satu-satu", () => {
  const result = validateSessionForm({ sesi: "abc", tanggal: "?", mulai: "x", link: "bukan link", tiket: "-1" }, TODAY);
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 5);
});

test("validateSessionForm - sesi harus ada di hari itu: Senin-Jumat sesi 1-3, Sabtu-Minggu sesi 1-6", () => {
  const startFor = { 1: "16.00", 2: "17.30", 3: "19.00", 4: "16.00", 5: "17.30", 6: "19.00" }; // awal rentang sesi itu (sesi 1-3 akhir pekan beda: lihat di bawah)
  const form = (sesi, tanggal) => validateSessionForm({ sesi, tanggal, mulai: startFor[sesi] }, TODAY);
  for (const sesi of ["1", "2", "3"]) assert.equal(form(sesi, MONDAY).ok, true, `Senin sesi ${sesi}`);
  for (const sesi of ["4", "5", "6"]) {
    const result = form(sesi, MONDAY);
    assert.equal(result.ok, false, `Senin sesi ${sesi} harus invalid`);
    assert.match(result.errors[0], new RegExp(`Sesi ${sesi} gak ada di hari Senin - hari kerja cuma sesi 1-3`));
  }
  for (const sesi of ["4", "5", "6"]) assert.equal(form(sesi, SATURDAY).ok, true, `Sabtu sesi ${sesi}`);
  const weekendStart = { 1: "11.15", 2: "12.45", 3: "14.15" };
  for (const sesi of ["1", "2", "3"]) {
    assert.equal(validateSessionForm({ sesi, tanggal: SATURDAY, mulai: weekendStart[sesi] }, TODAY).ok, true, `Sabtu sesi ${sesi}`);
  }
  assert.equal(form("6", "2026-10-18").ok, true, "Minggu sesi 6");
  assert.match(form("7", SATURDAY).errors[0], /Sesi 7 gak ada di hari Sabtu - akhir pekan cuma sesi 1-6/);
  assert.match(form("4", "2026-10-16").errors[0], /hari Jumat/, "Jumat tetap hari kerja");
});

test("validateSessionForm - jam buka mengikuti sesi (weekday & weekend), termasuk sesi 4-6 akhir pekan = sesi 1-3 hari kerja", () => {
  const open = (date, session) => {
    const { value } = validateSessionForm({}, TODAY, { date, session });
    return `${value.open}-${value.openEnd}`;
  };
  assert.deepEqual(
    [1, 2, 3].map((s) => open(MONDAY, s)),
    ["16:15-16:30", "17:45-18:00", "19:15-19:30"],
  );
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6].map((s) => open(SATURDAY, s)),
    ["11:30-11:45", "13:00-13:15", "14:30-14:45", "16:15-16:30", "17:45-18:00", "19:15-19:30"],
  );
});

test("validateSessionForm - jam mulai harus 15 menit sebelum jam buka sampai jam buka (batas tepat boleh, di luarnya ditolak)", () => {
  const form = (mulai) => validateSessionForm({ mulai }, TODAY, { date: SATURDAY, session: 2 }); // buka 13.00-13.15 -> mulai 12.45-13.00
  assert.equal(form("12.45").ok, true);
  assert.equal(form("12.50").ok, true);
  assert.equal(form("13.00").ok, true);
  for (const bad of ["12.44", "12.00", "13.01", "13.15", "13.40"]) {
    const result = form(bad);
    assert.equal(result.ok, false, bad);
    assert.equal(result.errors[0], `Jam mulai ${bad} di luar aturan sesi 2: harus 12.45-13.00 (15 menit sebelum jam buka sampai jam buka).`);
  }
  const weekday = (mulai) => validateSessionForm({ mulai }, TODAY, { date: MONDAY, session: 1 }); // buka 16.15-16.30 -> mulai 16.00-16.15
  assert.equal(weekday("16.00").ok, true);
  assert.equal(weekday("16.15").ok, true);
  assert.equal(weekday("16.30").ok, false, "16.30 itu ujung jendela buka, bukan jam mulai");
  assert.equal(weekday("15.59").ok, false);
});

test("validateSessionForm - kolom yang tidak dikirim dilewati (modal sebagian); tanggal+sesi dari kolom menang atas konteks", () => {
  const onlyLink = validateSessionForm({ link: "https://zoom.us/j/81331441967 abc123" }, TODAY);
  assert.equal(onlyLink.ok, true);
  assert.deepEqual(Object.keys(onlyLink.value).sort(), ["link", "passcode"], "tanpa tanggal+sesi tidak ada jam buka");

  const edit = validateSessionForm({ sesi: "2", tanggal: "lusa", mulai: "12.50", tiket: "" }, TODAY); // lusa = Sabtu 17/10
  assert.equal(edit.ok, true);
  assert.equal(edit.value.date, SATURDAY);
  assert.equal(edit.value.tickets, null);
  assert.deepEqual([edit.value.open, edit.value.openEnd], ["13:00", "13:15"]);

  const override = validateSessionForm({ sesi: "5", tanggal: "lusa", mulai: "17.45" }, TODAY, { date: MONDAY, session: 1 });
  assert.deepEqual([override.value.date, override.value.session, override.value.open], [SATURDAY, 5, "17:45"]);
});

test("linkKey: link Zoom disamakan lewat ID rapat; link lain lewat host+path+query (huruf besar & garis miring penutup diabaikan)", () => {
  const base = linkKey("https://us02web.zoom.us/j/87197929985?pwd=abc");
  assert.equal(base, "zoom:87197929985");
  assert.equal(linkKey("https://zoom.us/j/87197929985"), base, "host & pwd beda");
  assert.equal(linkKey("https://us06web.zoom.us/j/87197929985?pwd=zzz&from=x"), base);
  assert.notEqual(linkKey("https://us02web.zoom.us/j/87197929986"), base, "ID beda = link beda");
  assert.equal(linkKey("https://MEET.example.com/room/abc/"), linkKey("https://meet.example.com/room/abc"));
  assert.notEqual(linkKey("https://meet.example.com/room/abc"), linkKey("https://meet.example.com/room/xyz"));
  assert.notEqual(linkKey("https://meet.example.com/r?id=1"), linkKey("https://meet.example.com/r?id=2"), "query dibedakan untuk non-Zoom");
  assert.equal(typeof linkKey("bukan url"), "string", "tidak melempar");
});
