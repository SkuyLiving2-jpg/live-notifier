// Data rekap: mengambil sesi per rentang, kode rentang (encode/decode), pilihan tanggal, dan halaman rekap yang sedang dibuka.

const { activeLives } = require("../../../storage/activeLives");
const {
  getCompletedSessionsToday,
  getCompletedSessionsForDate,
  getCompletedSessionsSince,
  getCompletedSessionsForMonth,
  getDistinctSessionMonths,
  getEarliestSessionDate,
  SESSION_RETENTION_DAYS,
} = require("../../../storage/dailyLog");
const { getTodayWIB, getDateWIB, WEEKDAY_FORMATTER_WIB } = require("../../../utils");

const { WEEKDAY_NAMES_ID } = require("./dateParsing");

// Sesi yang MASIH LIVE SEKARANG (dari activeLives), dibentuk jadi baris
// ala-sesi (endedAtUnix/durationMs null) biar bisa numpang bareng sesi yang
// UDAH SELESAI di tabel/hitungan yang sama. Dipisah dari getTodaySessionsForRecap
// biar bisa dipake juga di rekap mingguan/bulanan (lihat getSessionsForRange
// & replyRecapRange di bawah, §10's thirty-third item) - bukan cuma "hari
// ini" doang.
function getOngoingSessionsForRecap() {
  return [...activeLives.values()].map((entry) => ({
    name: entry.name,
    username: entry.username,
    startedAtUnix: Math.floor(new Date(entry.liveAt).getTime() / 1000),
    endedAtUnix: null,
    durationMs: null,
    peakViewCount: entry.peakViewCount ?? entry.viewCount ?? null,
  }));
}

// Gabungan "gambaran lengkap hari ini" - sesi yang UDAH SELESAI hari ini
// (dari daily-log.json) + yang MASIH LIVE SEKARANG. Sama pola-nya kayak
// replyLongestLive()/replyTopViewers() (yang udah lebih dulu gabungin dua
// sumber ini) - diexport biar bisa dites langsung, sama kayak buildRecapTablePage.
function getTodaySessionsForRecap() {
  return [...getCompletedSessionsToday(), ...getOngoingSessionsForRecap()];
}

// Gabungan sesi PER BULAN - sesi yang UDAH SELESAI di bulan itu, DITAMBAH
// sesi yang MASIH LIVE SEKARANG kalau `monthWIB` kebetulan bulan BERJALAN
// (sama alasannya kayak getTodaySessionsForRecap) - bulan-bulan LAIN (yang
// udah lewat) gak mungkin punya sesi yang "masih live", jadi gak pernah
// digabung buat itu.
function getMonthSessionsForRecap(monthWIB) {
  const completed = getCompletedSessionsForMonth(monthWIB);
  if (monthWIB !== getTodayWIB().slice(0, 7)) return completed;
  return [...completed, ...getOngoingSessionsForRecap()];
}

// Semua bulan ("YYYY-MM") yang layak ditawarin di dropdown "cok rekap bulan"
// polos (replyRecapMonthGeneric di bawah) - gabungan bulan yang BENERAN ada
// sesi selesainya (getDistinctSessionMonths) DITAMBAH bulan BERJALAN selalu
// dipaksa masuk walau belum ada sesi yang selesai sama sekali di situ (mis.
// baru mulai ada yang live, belum ada yang kelar) - urut dari yang paling
// baru.
function getAvailableRecapMonths() {
  const months = new Set(getDistinctSessionMonths());
  months.add(getTodayWIB().slice(0, 7));
  return [...months].sort().reverse();
}

// "channelId:authorId" -> { currentPage, totalPages, at, rangeDays } - nunggu
// jawaban y/mundur/n abis nunjukkin 1 halaman tabel rekap. Sama pola-nya
// kayak pendingWatchConfirm (di chat/menu.js, di-key per orang bukan per
// channel, biar jawaban orang lain di channel yang sama gak nyasar ke
// halaman punya orang ini). `rangeDays` (null = "hari ini", gabungan sama
// activeLives; angka = rekap mingguan/bulanan, cuma sesi yang UDAH selesai;
// string "YYYY-MM-DD" = rekap TANGGAL SPESIFIK, lihat getSessionsForRange)
// dicatet biar halaman lain tau harus narik dari daftar sesi yang SAMA,
// bukan default balik ke rekap hari ini - dulu (sebelum rekap mingguan/
// bulanan ada) cuma ada 1 jenis rekap jadi ini gak masalah, sekarang WAJIB
// biar navigasi halaman rekap minggu ini gak diem-diem ganti jadi nunjukkin
// rekap hari ini.
//
// SENGAJA nyimpen currentPage (bukan cuma nextPage kayak sebelumnya) dan
// nyimpen pending state SELAMA totalPages > 1 - BUKAN cuma pas hasMore true
// (ada halaman berikutnya). Sebelumnya, begitu user nyampe halaman TERAKHIR,
// pending state-nya gak pernah kebentuk (hasMore-nya udah false), jadi user
// yang lagi di halaman terakhir gak punya cara mundur balik ke halaman
// sebelumnya sama sekali - itu bug yang dilaporin owner: "list-nya gak bisa
// dimundurin ya?".
const pendingRecapPage = new Map();

const PENDING_RECAP_PAGE_TTL_MS = 2 * 60000;

// Satu titik keputusan buat narik SESI yang sesuai sebuah `rangeDays` - dulu
// ternary `rangeDays == null ? getTodaySessionsForRecap() : getCompletedSessionsSince(rangeDays)`
// ini ditulis ULANG di 3 tempat (tryHandleRecapPageShortcut,
// handleRecapNavButton, handleRecapSearchModalSubmit), jadi pas nambahin
// jenis rentang BARU (rekap per tanggal) gampang kelewatan salah satu -
// digabung di sini biar nambah jenis rentang lagi ke depannya cukup di 1
// tempat. `rangeDays`: null = hari ini (gabungan activeLives), number = N
// hari terakhir, string "YYYY-MM-DD" = tanggal spesifik.
//
// String tanggal yang KEBETULAN sama persis sama hari ini di-treat SAMA
// kayak rangeDays null (gabungan activeLives juga, bukan cuma
// getCompletedSessionsForDate) - dulu (sebelum buildRecapDateSelectRow ikut
// nawarin hari ini sebagai opsi, lihat komen di situ) ini gak mungkin
// kejadian soalnya dropdown-nya sengaja gak pernah ngasih value hari ini.
// Begitu hari ini jadi bisa dipilih, tanpa special-case ini milih "hari ini"
// dari dropdown per-tanggal bakal ngasih hasil BEDA dari tombol "Rekap hari
// ini" (kelewatan sesi yang MASIH LIVE, cuma nunjukkin yang udah selesai) -
// kelihatan kayak bug baru ("kok yang lagi live sekarang gak muncul").
//
// BUG SEBELUMNYA (dilaporin owner, §10's thirty-third item): rentang N-hari
// (rekap minggu/bulan) dulu CUMA narik getCompletedSessionsSince - sesi yang
// masih LIVE SEKARANG gak pernah ikut ke-gabung, jadi "cok rekap minggu ini"
// nunjukkin tabel yang kelewatan siapapun yang lagi live pas ditanya, padahal
// live itu jelas-jelas bagian dari "minggu ini" juga (dia mulainya paling
// nggak hari ini, yang termasuk 7/30 hari terakhir). Sekarang ikut digabung
// sama getOngoingSessionsForRecap(), sama kayak rangeDays null/hari-ini di atas.
//
// String `rangeDays` sekarang ada DUA bentuk, dibedain dari PANJANGNYA
// (fixed-width, gak ambigu): "YYYY-MM-DD" (10 karakter) = tanggal spesifik,
// "YYYY-MM" (7 karakter) = bulan spesifik (§10's thirty-sixth item, rekap per
// nama bulan/dropdown "rekap bulan" polos) - lihat getMonthSessionsForRecap
// buat kenapa bulan BERJALAN ikut digabung sama activeLives juga, sama
// alasannya kayak tanggal hari ini.
// Rekap PER MEMBER: SEMUA sesi yang masih kesimpen di arsip (SESSION_RETENTION_DAYS
// hari terakhir) buat satu username + yang lagi live sekarang.
function getMemberSessionsForRecap(username) {
  const completed = getCompletedSessionsSince(SESSION_RETENTION_DAYS).filter((s) => s.username === username);
  const ongoing = getOngoingSessionsForRecap().filter((s) => s.username === username);
  return [...completed, ...ongoing];
}

// Rentang rekap PER MEMBER (fitur "cok rekap <nama member>"/tombol "Rekap
// member") ditandai string berawalan "@" + username ("@jkt48_aralie"). Awalan
// itu SENGAJA - username bisa aja panjangnya pas 7 atau 10 karakter, sama
// kayak panjang string bulan ("YYYY-MM") / tanggal ("YYYY-MM-DD") yang dipake
// buat ngebedain jenis rentang lain di sini, jadi tanpa penanda eksplisit ini
// bisa salah kebaca jadi bulan/tanggal. Selalu dicek DULUAN sebelum cek panjang.
function isMemberRange(rangeDays) {
  return typeof rangeDays === "string" && rangeDays.startsWith("@");
}

// "@username" = SEMUA sesi member itu; "@username#YYYY-MM-DD" = sesi member itu di SATU
// tanggal (pilihan dropdown tanggal di rekap member, buildMemberDateSelectRow). "#"
// aman dipakai sebagai pemisah: username IDN gak pernah ngandung "#", dan bukan ":"
// (pemisah posisional customId).
function parseMemberRange(rangeDays) {
  const raw = rangeDays.slice(1);
  const hashAt = raw.indexOf("#");
  return hashAt === -1 ? { username: raw, date: null } : { username: raw.slice(0, hashAt), date: raw.slice(hashAt + 1) };
}

function getSessionsForRange(rangeDays) {
  if (isMemberRange(rangeDays)) {
    const { username, date } = parseMemberRange(rangeDays);
    // Satu tanggal: logika SAMA dengan rekap tanggal biasa (hari ini ikut gabung sesi yang masih live), difilter ke member itu.
    return date ? getSessionsForRange(date).filter((s) => s.username === username) : getMemberSessionsForRecap(username);
  }
  if (rangeDays == null || rangeDays === getTodayWIB()) return getTodaySessionsForRecap();
  if (typeof rangeDays === "string") {
    if (rangeDays.length === 7) return getMonthSessionsForRecap(rangeDays);
    // Tanggal yang di-TAG weekday-nya (buildWeekdayDateSelectRow, mis.
    // "2026-09-14#1") harus dilucutin dulu tag-nya sebelum di-query - date
    // yang beneran dicari cuma bagian sebelum "#"-nya.
    const { date } = parseDateRangeValue(rangeDays);
    return date === getTodayWIB() ? getTodaySessionsForRecap() : getCompletedSessionsForDate(date);
  }
  return [...getCompletedSessionsSince(rangeDays), ...getOngoingSessionsForRecap()];
}

// "null" gak bisa lewat customId Discord (harus string) - "today" dipake
// sebagai stand-in buat rangeDays null (rekap hari ini), dikonversi balik
// lewat decodeRecapRange. Rentang TANGGAL SPESIFIK ("YYYY-MM-DD") dikasih
// awalan "d" (gak bisa ke-tabrak "today" atau angka hari-mundur manapun,
// keduanya gak pernah diawalin huruf) biar tetep 1 segmen doang pas
// nyambung ke customId yang di-split(":") posisional - TANPA awalan ini,
// tanda "-" di dalem tanggalnya aman (bukan pemisah), tapi kalau dulu dicoba
// pake ":" bakal numbuhin segmen ekstra dan ngerusak parts[n] di bawah.
// Simetris, dipake baik buat NULIS customId (buildRecapNavComponents)
// maupun BACA-nya balik (handleRecapNavButton/handleRecapSearchModalSubmit).
//
// Rentang BULAN SPESIFIK ("YYYY-MM", §10's thirty-sixth item) dikasih awalan
// "m" - beda dari "d" (tanggal) soalnya begitu udah didekode balik jadi
// string polos, getSessionsForRange butuh cara buat bedain "YYYY-MM-DD" dari
// "YYYY-MM" (dibedain dari PANJANG string-nya di situ - lihat komen di sana).
function encodeRecapRange(rangeDays) {
  if (rangeDays == null) return "today";
  if (isMemberRange(rangeDays)) return `u${rangeDays.slice(1)}`; // "@jkt48_x" -> "ujkt48_x" (awalan "u" = user/member)
  if (typeof rangeDays === "string") return rangeDays.length === 7 ? `m${rangeDays}` : `d${rangeDays}`;
  return String(rangeDays);
}

function decodeRecapRange(range) {
  if (range === "today") return null;
  if (range.startsWith("u")) return `@${range.slice(1)}`;
  if (range.startsWith("d") || range.startsWith("m")) return range.slice(1);
  return Number(range);
}

// Discord StringSelectMenu maksimal 25 opsi - dropdown "rekap per tanggal"
// nunjukkin sampai 25 hari TERAKHIR mundur dari HARI INI (dulu mulai dari
// KEMARIN, lihat komen BUG SEBELUMNYA di bawah), dipotong di SALAH SATU dari
// dua batas, mana yang lebih deket: SESSION_RETENTION_DAYS punya dailyLog.js
// (35 hari - lewat itu datanya emang udah kebuang) ATAU tanggal sesi
// PALING TUA yang beneran ada di arsip (getEarliestSessionDate) - owner
// laporin dropdown-nya nunjukkin tanggal jauh ke belakang dari sebelum bot
// ini bahkan mulai jalan/nge-track (mis. bot baru mulai 13 September, tapi
// dropdown-nya nawarin sampe akhir Agustus), yang klik ke situ ujung-ujungnya
// cuma "belum ada live yang kecatet" - bukan salah, tapi ngebuang opsi buat
// tanggal yang emang gak mungkin ada datanya sama sekali.
const RECAP_DATE_OPTIONS_COUNT = 25;

// [[tanggal WIB, jumlah sesi]] terbaru dulu. Sesi yang masih live dihitung ke HARI INI
// (sama kayak getSessionsForRange: tanggal sesi selesai = tanggal rekapnya).
function getMemberSessionDates(username) {
  const counts = new Map();
  for (const s of getMemberSessionsForRecap(username)) {
    const date = s.endedAtUnix === null ? getTodayWIB() : getDateWIB(new Date(s.endedAtUnix * 1000));
    counts.set(date, (counts.get(date) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));
}

// Tanggal-tanggal (mundur dari hari ini, dibatesin batas yang SAMA kayak
// buildRecapDateSelectRow di atas - retensi 35 hari ATAU sesi paling tua yang
// beneran ada, mana yang lebih deket) yang HARI-nya (WIB) cocok sama
// `weekdayIndex` (0=Minggu...6=Sabtu) - dasar dropdown "cok rekap hari
// senin"/"cok rekap senin" dkk (§10's thirty-sixth item). Weekday-nya
// dihitung lewat WEEKDAY_FORMATTER_WIB (Intl timeZone Asia/Jakarta), BUKAN
// Date.prototype.getDay() - getDay() ngikutin zona waktu LOKAL SERVER (bukan
// WIB), dan Railway biasanya jalan di UTC, jadi getDay() bisa nunjuk hari
// yang SALAH (mundur 1 hari) buat instant tengah-malam WIB - sama kelas bug
// timezone yang codebase ini udah konsisten hindarin di tempat lain
// (getDateWIB dkk, semua lewat Intl timeZone eksplisit, gak pernah pake
// method Date yang zona-lokal-server-dependent).
const WEEKDAY_LOOKBACK_DAYS = 90; // ~13 minggu ke belakang, cukup generous - dibatesin lebih ketat lagi sama earliestDate kalau arsipnya ada isinya

function findRecentDatesForWeekday(weekdayIndex) {
  const todayStartMs = new Date(`${getTodayWIB()}T00:00:00+07:00`).getTime();
  const earliestDate = getEarliestSessionDate();
  const targetName = WEEKDAY_NAMES_ID[weekdayIndex];
  const dates = [];
  for (let i = 0; i < WEEKDAY_LOOKBACK_DAYS && dates.length < RECAP_DATE_OPTIONS_COUNT; i++) {
    const d = new Date(todayStartMs - i * 24 * 60 * 60 * 1000);
    const value = getDateWIB(d);
    if (earliestDate && value < earliestDate) break;
    if (WEEKDAY_FORMATTER_WIB.format(d) === targetName) dates.push(d);
  }
  return dates;
}

// BUG SEBELUMNYA (dilaporin owner): milih tanggal dari dropdown weekday
// ("cok rekap senin") nunjukkin tabelnya bener, TAPI dropdown yang nempel di
// tabel itu (buat ganti-ganti tanggal tanpa nutup dulu, lihat
// buildRecapNavComponents) balik ke dropdown SEMUA tanggal (buildRecapDateSelectRow),
// bukan tetep ke dropdown khusus hari Senin - soalnya rangeDays yang
// nge-alir ke situ cuma tanggal POLOS ("YYYY-MM-DD"), gak ada jejak sama
// sekali "ini dipilih lewat filter weekday yang mana". Fix-nya: tanggal yang
// dipilih dari dropdown weekday di-TAG sekalian sama weekday-nya di NILAI
// opsinya sendiri ("YYYY-MM-DD#W", W = 0-6 - encodeWeekdayTaggedDate) - beda
// dari tanggal biasa yang value-nya tetep polos 10 karakter. Tag ini ngalir
// transparan lewat semua tempat yang udah nganggep rangeDays date "cuma
// string" (getSessionsForRange, encodeRecapRange/decodeRecapRange,
// pendingRecapPage) TANPA perlu diubah - satu-satunya tempat yang perlu
// SADAR ada tag ini ya buildRecapNavComponents (buat milih dropdown yang mana
// yang ditempelin balik) dan handleRecapDateSelect (buat misahin tanggal
// asli dari tag-nya pas format label/bikin Date). Tanggal yang dipilih dari
// dropdown "rekap tanggal" biasa TETEP polos, gak pernah ke-tag - dropdown
// itu emang didesain buat lompat ke tanggal MANAPUN, bukan dibatesin ke 1 hari.
function encodeWeekdayTaggedDate(dateWIB, weekdayIndex) {
  return `${dateWIB}#${weekdayIndex}`;
}

function parseDateRangeValue(rangeValue) {
  const hashIndex = rangeValue.indexOf("#");
  if (hashIndex === -1) return { date: rangeValue, weekdayIndex: null };
  return { date: rangeValue.slice(0, hashIndex), weekdayIndex: Number(rangeValue.slice(hashIndex + 1)) };
}

module.exports = {
  getOngoingSessionsForRecap,
  getTodaySessionsForRecap,
  getAvailableRecapMonths,
  pendingRecapPage,
  PENDING_RECAP_PAGE_TTL_MS,
  isMemberRange,
  parseMemberRange,
  getSessionsForRange,
  encodeRecapRange,
  decodeRecapRange,
  RECAP_DATE_OPTIONS_COUNT,
  getMemberSessionDates,
  findRecentDatesForWeekday,
  encodeWeekdayTaggedDate,
  parseDateRangeValue,
};
