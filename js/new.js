const fs = require("fs");
const path = require("path");
const { requireSignedRequest } = require("./security");

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const IDN_API_URL = "https://api.idn.app/graphql";
const POLL_INTERVAL_MS = 30000;

// Secret buat sistem signature (API_KEY + HMAC-SHA256) yang ngelindungin
// endpoint API kita dari akses sembarangan - dipakai kalau nanti nambah
// endpoint yang nyajiin data (bukan buat health-check, itu sengaja tetap
// publik biar Railway/UptimeRobot bisa akses tanpa signature).
const API_SECRET = process.env.API_SECRET || "";

// CACHE_DIR nentuin di mana semua file data (rekap, prioritas, subscription,
// dll) disimpen. Urutan prioritas:
//   1. CACHE_DIR - kalau mau nunjuk manual ke folder tertentu.
//   2. RAILWAY_VOLUME_MOUNT_PATH - Railway ngisi ini OTOMATIS begitu kamu
//      nempelin Volume ke service ini (gak perlu diisi manual sama sekali,
//      cukup attach Volume-nya doang di dashboard Railway) - biar data-nya
//      TAHAN lintas redeploy, bukan ke-reset tiap kali ada kode baru di-push.
//   3. Kalau dua-duanya kosong (mis. lagi jalan di komputer lokal), fallback
//      ke folder data/ di root project.
const CACHE_DIR = process.env.CACHE_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, "..", "data");
// Log ini sengaja dicetak paling awal pas boot - cara paling gampang buat
// mastiin (lewat Deploy Logs di Railway) apakah data beneran kesimpen di
// Volume yang persistent, atau diam-diam masih fallback ke folder lokal
// yang bakal ke-reset tiap redeploy.
console.log(
  `CACHE_DIR aktif: ${CACHE_DIR} ${process.env.RAILWAY_VOLUME_MOUNT_PATH ? "(dari Railway Volume - persistent ✓)" : "(BUKAN dari Volume - bakal ke-reset tiap redeploy!)"}`,
);
const CACHE_FILE = path.join(CACHE_DIR, "active-lives-cache.json");
const DURATION_HISTORY_FILE = path.join(CACHE_DIR, "live-duration-history.json");

// Token bot Discord buat fitur tanya-jawab interaktif (opsional). Beda sama
// DISCORD_WEBHOOK_URL yang cuma bisa kirim, bukan baca pesan. Kalau nggak
// diset, notifikasi tetap jalan normal, cuma fitur tanya-jawabnya mati.
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || "";

// Opsional - ID channel Discord tempat bot boleh lebih "agresif" balas
// (hampir semua pesan yang gak dikenali dibalas menu options, gak perlu
// nyebut "cok"/"live"). Channel lain tetap butuh wake word biar gak ganggu
// obrolan biasa. Cara dapetin ID channel: Developer Mode di Discord Settings
// > Advanced, terus klik kanan nama channel-nya > Copy Channel ID.
const BOT_CHANNEL_ID = process.env.BOT_CHANNEL_ID || "";

// Perkiraan "kemungkinan mendekati akhir" buat member prioritas dipicu kalau
// durasi live udah ngelewatin ambang ini (kalau belum ada riwayat durasi
// buat member itu). Bisa di-override lewat env var, satuannya menit.
const DEFAULT_ENDING_SOON_THRESHOLD_MS = (Number(process.env.ENDING_SOON_THRESHOLD_MINUTES) || 40) * 60 * 1000;

if (!DISCORD_WEBHOOK_URL) {
  console.error("DISCORD_WEBHOOK_URL belum diset di environment variable. Bot berhenti.");
  process.exit(1);
}

// Kalau ada member JKT48 yang nama/bio IDN-nya kebetulan nggak nyantumin
// kata "JKT48", tambahin username IDN-nya di sini biar tetap kedeteksi.
const JKT48_USERNAME_WHITELIST = [
  // "username_idn_member",
];

// Member prioritas: notifikasinya dibikin jauh lebih flashy/urgent (embed +
// opsional mention) dibanding member JKT48 lain. Diurutkan dari yang paling
// emergency ke bawah - urutan ini nentuin intensitas warna & tone pesannya.
const PRIORITY_MEMBERS = [
  { rank: 1, keyword: "nala", label: "NALA", color: 0xff0000, sirens: "🚨🔥🚨" },
  { rank: 2, keyword: "levi", label: "LEVI", color: 0xff8c00, sirens: "🚨⚡🚨" },
  { rank: 3, keyword: "lily", label: "LILY", color: 0xffd700, sirens: "🚨✨🚨" },
];

// ID user Discord yang mau di-mention khusus buat notif prioritas (opsional).
// Cara dapetinnya: di Discord, aktifin Developer Mode di Settings > Advanced,
// terus klik kanan nama kamu sendiri > Copy User ID. ID yang sama ini juga
// dipake buat nentuin siapa "owner" yang boleh kelola daftar prioritas lewat chat.
const PRIORITY_PING_USER_ID = process.env.PRIORITY_PING_USER_ID || "";

// Fitur: owner bisa nambah/hapus member prioritas lewat chat ("cok tambah
// prioritas <nama>") tanpa perlu ubah kode. Yang custom disimpen di file
// terpisah dari 3 bawaan (Nala/Levi/Lily), jadi ketiga itu nggak bisa
// kehapus via chat. Di-cache di memori biar nggak baca file berkali-kali
// tiap kali dicek (sama kayak fix performa riwayat durasi sebelumnya).
const CUSTOM_PRIORITY_FILE = path.join(CACHE_DIR, "custom-priority.json");
const PRIORITY_COLOR_PALETTE = [0x1abc9c, 0x9b59b6, 0x3498db, 0x2ecc71, 0xe91e63];
let customPriorityCache = null;

function loadCustomPriorityMembers() {
  if (customPriorityCache === null) {
    try {
      customPriorityCache = JSON.parse(fs.readFileSync(CUSTOM_PRIORITY_FILE, "utf-8"));
    } catch (error) {
      customPriorityCache = [];
    }
  }
  return customPriorityCache;
}

function saveCustomPriorityMembers(list) {
  customPriorityCache = list;
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(CUSTOM_PRIORITY_FILE, JSON.stringify(list, null, 2));
  } catch (error) {
    console.error("Gagal nyimpen daftar prioritas custom:", error.message);
  }
}

function getAllPriorityMembers() {
  return [...PRIORITY_MEMBERS, ...loadCustomPriorityMembers()];
}

function addCustomPriorityMember(rawKeyword) {
  const keyword = (rawKeyword || "").trim().toLowerCase();
  if (!keyword) return { ok: false, reason: "empty" };
  // Keyword pendek (1-2 huruf) matching-nya pakai text.includes() di
  // getPriorityConfig - itu bisa nyantol ke nama/username siapa aja yang
  // kebetulan ngandung huruf itu. Sama kelas bug kayak yang di pencarian
  // nama member, jadi dicegah dari sumbernya.
  if (keyword.length < 3) return { ok: false, reason: "too_short" };

  const all = getAllPriorityMembers();
  if (all.some((p) => p.keyword === keyword)) return { ok: false, reason: "exists" };

  const custom = loadCustomPriorityMembers();
  custom.push({
    rank: all.length + 1,
    keyword,
    label: keyword.toUpperCase(),
    color: PRIORITY_COLOR_PALETTE[custom.length % PRIORITY_COLOR_PALETTE.length],
    sirens: "🚨💥🚨",
  });
  saveCustomPriorityMembers(custom);
  return { ok: true };
}

function removeCustomPriorityMember(rawKeyword) {
  const keyword = (rawKeyword || "").trim().toLowerCase();
  const custom = loadCustomPriorityMembers();
  const filtered = custom.filter((p) => p.keyword !== keyword);
  if (filtered.length === custom.length) return { ok: false, reason: "not_found" };
  saveCustomPriorityMembers(filtered);
  return { ok: true };
}

function getPriorityConfig(memberName, username) {
  const text = `${memberName || ""} ${username || ""}`.toLowerCase();
  return getAllPriorityMembers().find((p) => containsWholeWord(text, p.keyword)) || null;
}

// Fitur: SIAPA AJA (bukan cuma owner) bisa "cok ingetin <nama>" buat di-tag
// pribadi tiap kali member itu mulai live - beda dari 3 member prioritas yang
// hardcoded, ini per-user dan bisa buat member manapun. Disimpen keyword ->
// daftar user ID yang subscribe, cache di memori kayak custom-priority.
const SUBSCRIPTIONS_FILE = path.join(CACHE_DIR, "subscriptions.json");
let subscriptionsCache = null;

function loadSubscriptions() {
  if (subscriptionsCache === null) {
    try {
      subscriptionsCache = JSON.parse(fs.readFileSync(SUBSCRIPTIONS_FILE, "utf-8"));
    } catch (error) {
      subscriptionsCache = {};
    }
  }
  return subscriptionsCache;
}

function saveSubscriptions(map) {
  subscriptionsCache = map;
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(SUBSCRIPTIONS_FILE, JSON.stringify(map, null, 2));
  } catch (error) {
    console.error("Gagal nyimpen daftar subscription:", error.message);
  }
}

function addSubscription(rawKeyword, userId) {
  const keyword = (rawKeyword || "").trim().toLowerCase();
  if (!keyword) return { ok: false, reason: "empty" };
  if (keyword.length < 3) return { ok: false, reason: "too_short" };

  const subs = loadSubscriptions();
  const list = subs[keyword] || [];
  if (list.includes(userId)) return { ok: false, reason: "already" };

  list.push(userId);
  subs[keyword] = list;
  saveSubscriptions(subs);
  return { ok: true };
}

function removeSubscription(rawKeyword, userId) {
  const keyword = (rawKeyword || "").trim().toLowerCase();
  const subs = loadSubscriptions();
  const list = subs[keyword] || [];
  const filtered = list.filter((id) => id !== userId);
  if (filtered.length === list.length) return { ok: false, reason: "not_found" };

  if (filtered.length === 0) delete subs[keyword];
  else subs[keyword] = filtered;
  saveSubscriptions(subs);
  return { ok: true };
}

// User yang udah di-mention lewat PRIORITY_PING_USER_ID di-exclude dari hasil
// SUBSCRIPTIONnya kalau member ini kebetulan member prioritas juga - biar
// nggak dobel tag di notifnya. Sebelumnya ini selalu ngehapus PRIORITY_PING_USER_ID
// dari hasil apapun membernya - bug-nya, kalau si owner subscribe ke member
// yang BUKAN prioritas, dia nggak akan pernah ke-tag walau udah subscribe.
function getSubscribersFor(memberName, username) {
  const text = `${memberName || ""} ${username || ""}`.toLowerCase();
  const subs = loadSubscriptions();
  const ids = new Set();
  for (const [keyword, list] of Object.entries(subs)) {
    if (containsWholeWord(text, keyword)) list.forEach((id) => ids.add(id));
  }
  if (getPriorityConfig(memberName, username)) ids.delete(PRIORITY_PING_USER_ID);
  return [...ids];
}

// Snapshot top-gifter: username -> { name, gifters, checkedAt }. Bot ini
// SENDIRI nggak pernah manggil API top-gifter IDN (itu butuh login pribadi,
// nggak cocok disimpen di server 24/7 - lihat scripts/cek-top-gifter.js).
// File ini isinya cuma DIISI dari luar, lewat endpoint /api/gifter-snapshot
// (POST, butuh signature) yang dipanggil scripts/cek-top-gifter.js abis
// kamu cek manual di komputer sendiri. Jadi yang nyebrang ke bot cuma HASIL
// datanya (nama gifter + gold), kredensialnya sendiri nggak pernah ke sini.
const GIFTER_SNAPSHOT_FILE = path.join(CACHE_DIR, "gifter-snapshot.json");

function loadGifterSnapshot() {
  try {
    const data = JSON.parse(fs.readFileSync(GIFTER_SNAPSHOT_FILE, "utf-8"));
    data.members = data.members || {};
    return data;
  } catch (error) {
    return { members: {} };
  }
}

function saveGifterSnapshot(snapshot) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(GIFTER_SNAPSHOT_FILE, JSON.stringify(snapshot, null, 2));
  } catch (error) {
    console.error("Gagal nyimpen snapshot gifter:", error.message);
  }
}

// Sama logikanya kayak findMemberByNameFragment, tapi nyariin di snapshot
// gifter (bukan di activeLives) - dipanggil member yang MASIH live maupun
// yang udah kelar tetap bisa ketemu, soalnya ini data historis/snapshot.
function findGifterSnapshotByNameFragment(fragment) {
  const needle = (fragment || "").trim().toLowerCase();
  if (!needle) return null;

  const { members } = loadGifterSnapshot();
  for (const [username, data] of Object.entries(members)) {
    if (!data?.name) continue;
    const givenName = data.name.split(/[\s|]+/)[0].toLowerCase();
    if (matchesNameFragment(needle, givenName)) {
      return { username, ...data };
    }
  }
  return null;
}

// Cache buat nyimpen member yang lagi live: username -> { name, username, slug }
// Disimpan juga ke file (CACHE_FILE) biar kalau proses restart (crash, atau
// container-nya di-restart), bot nggak ngirim ulang notif "mulai live" buat
// member yang sebenernya udah live dari sebelum restart.
function loadActiveLives() {
  try {
    const raw = fs.readFileSync(CACHE_FILE, "utf-8");
    return new Map(Object.entries(JSON.parse(raw)));
  } catch (error) {
    return new Map();
  }
}

function saveActiveLives() {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(Object.fromEntries(activeLives), null, 2));
  } catch (error) {
    console.error("Gagal nyimpen cache ke file:", error.message);
  }
}

const activeLives = loadActiveLives();

// Riwayat durasi live per username (dalam ms), disimpan biar bisa dipakai
// ngitung rata-rata durasi live seseorang - dasar buat nebak "kemungkinan
// mendekati akhir". Cuma nyimpen 10 data terakhir per orang biar file-nya
// nggak membengkak dan makin relevan sama pola live terbarunya.
function loadDurationHistory() {
  try {
    const raw = fs.readFileSync(DURATION_HISTORY_FILE, "utf-8");
    return JSON.parse(raw);
  } catch (error) {
    return {};
  }
}

function saveDurationHistory(history) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(DURATION_HISTORY_FILE, JSON.stringify(history, null, 2));
  } catch (error) {
    console.error("Gagal nyimpen riwayat durasi:", error.message);
  }
}

// Tiap entry nyimpen { name, durationMs, at } - nama-nya kepake buat fitur
// stats & pengumuman rekor, biar bisa nyari riwayat orang yang LAGI NGGAK
// live (activeLives udah kehapus begitu dia selesai live).
function recordLiveDuration(username, name, durationMs) {
  const history = loadDurationHistory();
  const list = history[username] || [];
  list.push({ name, durationMs, at: new Date().toISOString() });
  history[username] = list.slice(-10);
  saveDurationHistory(history);
}

function getAverageDuration(durationHistory, username) {
  const list = durationHistory[username] || [];
  if (list.length === 0) return null;
  return list.reduce((total, item) => total + item.durationMs, 0) / list.length;
}

// Rekor durasi live TERLAMA sebelum live yang baru aja selesai ini (buat
// bandingin apakah ini rekor baru). Return null kalau belum ada riwayat.
function getPreviousMaxDuration(durationHistory, username) {
  const list = durationHistory[username] || [];
  if (list.length === 0) return null;
  return Math.max(...list.map((item) => item.durationMs));
}

// Cocokin fragment ke nama depan per KATA, bukan substring bebas - soalnya
// substring bebas ("nama.includes(needle)") bikin huruf tunggal kayak "a"
// ke-anggep cocok ke nama siapa aja yang kebetulan ada huruf "a"-nya (mis.
// "Fahira"). Kata di needle harus PERSIS sama sama nama depannya, ATAU
// minimal 3 huruf dan jadi prefix/typo-toleran dari nama depannya.
function matchesNameFragment(needle, givenName) {
  if (!needle || !givenName) return false;
  const words = needle.split(/[^a-z0-9]+/).filter(Boolean);
  return words.some((word) => {
    if (word === givenName) return true;
    if (word.length >= 3 && givenName.startsWith(word)) return true;
    if (givenName.length >= 3 && word.startsWith(givenName)) return true;
    return false;
  });
}

// Cek apakah `phrase` (bisa 1 kata atau beberapa kata, misal keyword custom
// prioritas/subscription) muncul di `text` sebagai KATA/FRASE UTUH, bukan
// nyempil di tengah kata lain. Sebelumnya beberapa tempat (getPriorityConfig,
// getSubscribersFor, deteksi wake word "cok"/"live") pakai text.includes()
// biasa - itu bug yang sama kelasnya kayak yang udah dibenerin di
// matchesNameFragment: keyword "cok" ke-anggep nyantol ke "cokelat", keyword
// "live" ke-anggep nyantol ke "delivery", keyword prioritas "lily" ke-anggep
// nyantol ke member lain yang kebetulan namanya mengandung "lily" di tengah.
function containsWholeWord(text, phrase) {
  if (!text || !phrase) return false;
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, "i").test(` ${text} `);
}

function findDurationHistoryByNameFragment(fragment) {
  const needle = (fragment || "").trim().toLowerCase();
  if (!needle) return null;

  const history = loadDurationHistory();
  for (const [username, entries] of Object.entries(history)) {
    if (entries.length === 0) continue;
    const displayName = entries[entries.length - 1].name || username;
    const givenName = displayName.split(/[\s|]+/)[0].toLowerCase();
    if (matchesNameFragment(needle, givenName)) {
      return { username, displayName, entries };
    }
  }
  return null;
}

function formatDuration(ms) {
  const totalMinutes = Math.max(0, Math.floor(ms / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}j ${minutes}m` : `${minutes}m`;
}

function formatRelativeTime(date) {
  const diffMin = Math.max(0, Math.floor((Date.now() - date.getTime()) / 60000));
  if (diffMin < 60) return `${diffMin} menit lalu`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour} jam lalu`;
  const diffDay = Math.floor(diffHour / 24);
  return `${diffDay} hari lalu`;
}

function formatViewCount(n) {
  return Number(n).toLocaleString("id-ID");
}

function formatClockWIB(date) {
  return `${new Intl.DateTimeFormat("id-ID", { timeZone: "Asia/Jakarta", hour: "2-digit", minute: "2-digit" }).format(date)} WIB`;
}

// --- Rekap harian: sekali sehari, ringkasan siapa aja yang live hari itu ---
const DAILY_LOG_FILE = path.join(CACHE_DIR, "daily-log.json");
const DAILY_RECAP_HOUR = Number(process.env.DAILY_RECAP_HOUR) || 23; // jam WIB

function getTodayWIB() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(new Date());
}

function getHourWIB() {
  return Number(
    new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Jakarta", hour: "numeric", hour12: false }).format(new Date()),
  );
}

// Awal & akhir "hari ini" (WIB, UTC+7 tetap sepanjang tahun - gak ada DST)
// dalam Unix SECONDS, buat nyaring entri arsip eksternal yang live_at_unix-nya
// jatuh di hari ini.
function getTodayWIBRangeUnix() {
  const startMs = new Date(`${getTodayWIB()}T00:00:00+07:00`).getTime();
  return { startSec: Math.floor(startMs / 1000), endSec: Math.floor(startMs / 1000) + 24 * 60 * 60 };
}

// PENTING soal CACHE_DIR/Railway: rekap harian kita ("data/daily-log.json")
// cuma nyatet live yang kita SENDIRI pantau start-sampai-selesai. Kalau bot
// sempet mati/restart di tengah hari (misal abis redeploy, dan CACHE_DIR-nya
// nggak diarahin ke storage yang persist lintas redeploy), live yang
// kejadian pas bot lagi off bakal "kelewatan" - bukan salah IDN, tapi karena
// kita cuma bisa nyatet apa yang kita amati sendiri secara real-time.
//
// IDN sendiri gak nyediain API histori sama sekali (udah di-cek langsung ke
// schema GraphQL-nya). Jadi buat nutup celah itu, kita baca (READ-ONLY, gak
// nulis/redistribusi apa-apa) dari arsip publik JKT48Live-Record
// (github.com/rznive/JKT48Live-Record) - project auto-scraper pihak ketiga
// yang ngerekam tiap live IDN JKT48 lewat GitHub Actions, datanya disimpen
// per-bulan di data/idn/YYYY-MM.json. Ini CUMA pelengkap informasi (siapa aja
// yang sempet live + jam berapa) - repo itu gak punya LICENSE file jadi kita
// nggak nyalin/nyimpen kodenya, cuma baca file JSON publiknya on-the-fly,
// sama kayak kita manggil endpoint publik IDN sendiri. Kalau lagi gak bisa
// diakses (jaringan/repo pindah/dll), rekap tetap jalan normal pakai data
// lokal doang - ini FITUR TAMBAHAN, bukan dependency yang bisa bikin bot mati.
const EXTERNAL_LIVE_HISTORY_BASE_URL = "https://raw.githubusercontent.com/rznive/JKT48Live-Record/main/data/idn";

async function fetchExternalTodayLiveHistory() {
  try {
    const [year, month] = getTodayWIB().split("-");
    const url = `${EXTERNAL_LIVE_HISTORY_BASE_URL}/${year}-${month}.json`;
    const response = await fetch(url);
    if (!response.ok) return null; // wajar kalau bulan berjalan belum ke-commit filenya

    const allEntries = await response.json();
    if (!Array.isArray(allEntries)) return null;

    const { startSec, endSec } = getTodayWIBRangeUnix();
    return allEntries.filter(
      (e) =>
        typeof e?.username === "string" &&
        e.username.toLowerCase().startsWith("jkt48_") &&
        typeof e.live_at_unix === "number" &&
        e.live_at_unix >= startSec &&
        e.live_at_unix < endSec,
    );
  } catch (error) {
    console.error("Gagal ambil arsip live eksternal (nggak fatal, rekap tetap jalan pakai data lokal):", error.message);
    return null;
  }
}

function loadDailyLog() {
  const today = getTodayWIB();
  try {
    const data = JSON.parse(fs.readFileSync(DAILY_LOG_FILE, "utf-8"));
    if (data.date !== today) return { date: today, sessions: [], recapSentDate: data.recapSentDate || null };
    data.sessions = data.sessions || [];
    return data;
  } catch (error) {
    return { date: today, sessions: [], recapSentDate: null };
  }
}

function saveDailyLog(log) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(DAILY_LOG_FILE, JSON.stringify(log, null, 2));
  } catch (error) {
    console.error("Gagal nyimpen log harian:", error.message);
  }
}

// Dulu rekap CUMA nyatet pas live SELESAI (recordDailyEntry lama) - jadi
// kalau kamu nanya "cok rekap hari ini" pas ada member yang MASIH live
// (belum kelar), dia bakal keliatan "zonk" walau bot JELAS-JELAS abis ngirim
// notif "mulai live" buat orang itu. Sekarang tiap notif "mulai live" yang
// berhasil kekirim LANGSUNG dicatet sebagai sesi (status masih live), terus
// pas dia selesai sesi yang SAMA di-update (bukan bikin entry baru) biar
// rekap bisa nunjukkin siapa aja yang live hari ini - baik yang udah selesai
// maupun yang masih berlangsung.
function recordLiveStartedToday(name, username, startedAtDate) {
  const log = loadDailyLog();
  log.sessions.push({
    name,
    username,
    startedAtUnix: Math.floor(startedAtDate.getTime() / 1000),
    endedAtUnix: null,
    durationMs: null,
  });
  saveDailyLog(log);
}

function recordLiveEndedToday(name, username, durationMs, endedAtDate) {
  const log = loadDailyLog();
  const endedAtUnix = Math.floor(endedAtDate.getTime() / 1000);
  // Cari sesi "masih live" TERAKHIR buat username ini - biasanya emang itu
  // yang barusan mulai. [...].reverse() bukan .findLast() biar tetep jalan
  // di runtime Node yang lebih lama.
  const openSession = [...log.sessions].reverse().find((s) => s.username === username && s.endedAtUnix === null);
  if (openSession) {
    openSession.endedAtUnix = endedAtUnix;
    openSession.durationMs = durationMs;
  } else {
    // Sesi "mulai"-nya kelewat kecatet (mis. live-nya kepotong pergantian
    // hari WIB, atau bot baru restart tengah live) - tetep catet daripada
    // rekap kehilangan data, walau jam mulainya cuma perkiraan mundur dari
    // durasi yang kita tau.
    log.sessions.push({ name, username, startedAtUnix: endedAtUnix - Math.round(durationMs / 1000), endedAtUnix, durationMs });
  }
  saveDailyLog(log);
}

async function maybeSendDailyRecap() {
  if (getHourWIB() < DAILY_RECAP_HOUR) return;

  const log = loadDailyLog();
  if (log.recapSentDate === log.date) return; // udah kekirim hari ini

  const completed = log.sessions.filter((s) => s.endedAtUnix !== null);
  if (completed.length > 0) {
    const totalLives = completed.length;
    const totalDurationMs = completed.reduce((sum, s) => sum + s.durationMs, 0);
    const longest = completed.reduce((max, s) => (s.durationMs > max.durationMs ? s : max), completed[0]);
    const uniqueMembers = new Set(completed.map((s) => s.name)).size;

    const payload = {
      content: [
        `📋 **Rekap live hari ini (${log.date})**`,
        `Total live: ${totalLives}x dari ${uniqueMembers} member`,
        `Total durasi gabungan: ${formatDuration(totalDurationMs)}`,
        `Paling lama: **${longest.name}** (${formatDuration(longest.durationMs)})`,
      ].join("\n"),
    };

    try {
      const response = await fetch(DISCORD_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) throw new Error(`Discord webhook balikin status ${response.status}`);
      console.log("Rekap harian terkirim");
    } catch (error) {
      console.error("Gagal ngirim rekap harian:", error.message);
    }
  }

  log.recapSentDate = log.date;
  saveDailyLog(log);
}

// Selebrasi kalau live yang baru aja selesai itu rekor durasi TERLAMA buat
// member itu (dibanding riwayat sebelumnya). Dicek SEBELUM live barusan
// dicatet ke riwayat, biar dibandingin ke rekor LAMA-nya, bukan diri sendiri.
async function maybeAnnounceNewRecord(username, memberName, durationMs, durationHistory) {
  const previousMax = getPreviousMaxDuration(durationHistory, username);
  if (previousMax === null || durationMs <= previousMax) return;

  const payload = {
    content: `🏆 **${memberName}** baru aja pecahin rekor durasi live-nya sendiri! Sebelumnya paling lama ${formatDuration(previousMax)}, sekarang ${formatDuration(durationMs)} 🎉`,
  };

  try {
    const response = await fetch(DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) throw new Error(`Discord webhook balikin status ${response.status}`);
    console.log(`Notif rekor baru terkirim untuk ${memberName}`);
  } catch (error) {
    console.error("Gagal ngirim notif rekor:", error.message);
  }
}

// "Party Mode": momen 2+ member prioritas (Nala/Levi/Lily/custom) live
// BARENGAN itu momen langka & seru - pantes dikasih alert khusus di luar
// notif "mulai live" biasa-biasa tiap orang. Dipanggil abis notif "start"
// buat member prioritas berhasil kekirim, jadi otomatis nge-refresh ("Nala &
// Levi" -> "Nala & Levi & Lily") tiap kali ada tambahan anggota partynya.
async function maybePartyModeAlert() {
  const liveNow = [...activeLives.values()].filter((entry) => getPriorityConfig(entry.name, entry.username));
  if (liveNow.length < 2) return;

  const mention = PRIORITY_PING_USER_ID ? `<@${PRIORITY_PING_USER_ID}> ` : "";
  const names = liveNow.map((entry) => `**${entry.name}**`).join(" & ");

  const payload = {
    content: `${mention}🎉🔥 **PARTY MODE AKTIF!** 🔥🎉\n${liveNow.length} member prioritas live BARENGAN: ${names}!\nSaatnya split-screen! 📱📱`,
  };

  try {
    const response = await fetch(DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) throw new Error(`Discord webhook balikin status ${response.status}`);
    console.log("Party Mode alert terkirim");
  } catch (error) {
    console.error("Gagal ngirim Party Mode alert:", error.message);
  }
}

// Ambang jumlah penonton buat alert "tembus milestone" - sekali per ambang
// per sesi live (dicatet di entry.alertedMilestones), berlaku buat SEMUA
// member JKT48 (bukan cuma prioritas), soalnya lonjakan penonton itu sinyal
// bagus buat ikutan nonton siapapun membernya.
const VIEWER_MILESTONES = [1000, 5000, 10000, 20000, 50000];

async function maybeAlertViewerMilestone(entry) {
  if (entry.viewCount == null) return;
  entry.alertedMilestones = entry.alertedMilestones || [];

  for (const milestone of VIEWER_MILESTONES) {
    if (entry.viewCount >= milestone && !entry.alertedMilestones.includes(milestone)) {
      entry.alertedMilestones.push(milestone);
      saveActiveLives();
      await sendViewerMilestoneAlert(entry, milestone);
    }
  }
}

async function sendViewerMilestoneAlert(entry, milestone) {
  const liveUrl = `https://idn.app/${entry.username}/live/${entry.slug}`;
  const payload = {
    content: `🎯 **${entry.name}** baru aja tembus **${milestone.toLocaleString("id-ID")} penonton**! 👀🔥\n${liveUrl}`,
  };

  try {
    const response = await fetch(DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) throw new Error(`Discord webhook balikin status ${response.status}`);
    console.log(`Milestone ${milestone} penonton terkirim untuk ${entry.name}`);
  } catch (error) {
    console.error("Gagal ngirim alert milestone penonton:", error.message);
  }
}

function isJkt48Member(creator) {
  if (!creator) return false;
  if (JKT48_USERNAME_WHITELIST.includes(creator.username)) return true;

  // Semua akun IDN resmi member JKT48 konsisten pakai username berawalan
  // "jkt48_" (misal jkt48_levi, jkt48_nala). Sebelumnya kode ini nge-cek
  // apakah kata "jkt48" muncul di bio profil - itu rapuh, soalnya akun fans
  // atau reaction channel juga sering nyebut "JKT48" di bio mereka padahal
  // bukan member asli, jadi nembus filter dan ikut kekirim notifikasi.
  return typeof creator.username === "string" && creator.username.toLowerCase().startsWith("jkt48_");
}

// getLivestreams IDN itu di-paging (halaman 1 cuma nampilin ~12 live
// teratas). Kalo cuma ambil halaman pertama, live yang penontonnya sedikit
// (biasanya yang lebih baru mulai) bisa nangkring di halaman 2+ dan nggak
// pernah kedeteksi. Jadi kita ambil terus tiap halaman sampai kosong.
const MAX_LIVESTREAM_PAGES = 20; // jaga-jaga biar nggak infinite loop

async function fetchAllLivestreams() {
  const query = `
    query GetLivestreams($page: Int) {
      getLivestreams(page: $page) {
        creator {
          username
          name
          bio_description
        }
        title
        slug
        live_at
        view_count
      }
    }
  `;

  const allLives = [];

  for (let page = 1; page <= MAX_LIVESTREAM_PAGES; page++) {
    const response = await fetch(IDN_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables: { page } }),
    });

    if (!response.ok) {
      throw new Error(`IDN API balikin status ${response.status} (halaman ${page})`);
    }

    const result = await response.json();

    if (result.errors) {
      throw new Error(`GraphQL error (halaman ${page}): ${JSON.stringify(result.errors)}`);
    }

    const lives = result?.data?.getLivestreams || [];
    if (lives.length === 0) break; // udah abis halamannya

    allLives.push(...lives);
  }

  return allLives;
}

async function checkLiveMembers() {
  try {
    const currentLives = await fetchAllLivestreams();
    const currentLiveUsernames = new Set();
    // Dibaca sekali per siklus polling (bukan sekali per member yang live)
    // biar nggak buka file yang sama berkali-kali kalau lagi banyak yang live.
    const durationHistory = loadDurationHistory();

    for (const live of currentLives) {
      const username = live?.creator?.username;
      if (!username) continue; // skip entry yang datanya nggak lengkap
      if (!isJkt48Member(live.creator)) continue; // cuma peduli member JKT48

      currentLiveUsernames.add(username);

      // Kirim notif cuma kalo member baru mulai live
      if (!activeLives.has(username)) {
        const terkirim = await sendDiscordNotif(live.creator.name, live.creator.username, live.slug, "start");
        if (terkirim) {
          activeLives.set(username, {
            name: live.creator.name,
            username,
            slug: live.slug,
            liveAt: live.live_at,
            viewCount: live.view_count,
            endingSoonAlerted: false,
            alertedMilestones: [],
          });
          saveActiveLives();
          recordLiveStartedToday(live.creator.name, live.creator.username, live.live_at ? new Date(live.live_at) : new Date());
          if (getPriorityConfig(live.creator.name, live.creator.username)) {
            await maybePartyModeAlert();
          }
        }
        // kalau gagal kirim, username sengaja nggak ditambahin
        // biar dicoba lagi di polling berikutnya
      } else {
        // udah live dari sebelumnya - update data terbaru & cek heuristik
        // "kemungkinan mendekati akhir" (cuma buat member prioritas) + cek
        // milestone jumlah penonton (buat semua member JKT48)
        const entry = activeLives.get(username);
        entry.viewCount = live.view_count;
        await maybeAlertEndingSoon(entry, durationHistory);
        await maybeAlertViewerMilestone(entry);
      }
    }

    // Kirim notif "sudah selesai" + bersihkan cache kalau member udah selesai live
    for (const [username, memberData] of activeLives) {
      if (!currentLiveUsernames.has(username)) {
        const terkirim = await sendDiscordNotif(memberData.name, memberData.username, memberData.slug, "end");
        if (terkirim) {
          if (memberData.liveAt) {
            const durationMs = Date.now() - new Date(memberData.liveAt).getTime();
            await maybeAnnounceNewRecord(username, memberData.name, durationMs, durationHistory);
            recordLiveDuration(username, memberData.name, durationMs);
            recordLiveEndedToday(memberData.name, memberData.username, durationMs, new Date());
          }
          activeLives.delete(username);
          saveActiveLives();
        }
        // kalau gagal kirim, sengaja nggak dihapus dari cache
        // biar dicoba lagi di polling berikutnya
      }
    }

    await maybeSendDailyRecap();
  } catch (error) {
    console.error("Gagal ngecek IDN Live:", error.message);
  }
}

function buildNormalPayload(memberName, liveUrl, status) {
  return status === "end"
    ? { content: `✅ **${memberName}** udah selesai live di IDN Live.` }
    : { content: `🚨 **${memberName}** lagi live di IDN Live!\nNonton di sini: ${liveUrl}` };
}

function buildPriorityPayload(memberName, liveUrl, status, priority) {
  const mention = PRIORITY_PING_USER_ID ? `<@${PRIORITY_PING_USER_ID}> ` : "";

  if (status === "end") {
    return {
      content: `${mention}${priority.sirens} Live prioritas **#${priority.rank} ${priority.label}** udah selesai.`,
      embeds: [
        {
          title: `${priority.label} sudah selesai live`,
          description: memberName,
          color: priority.color,
          url: liveUrl,
        },
      ],
    };
  }

  return {
    content: `${mention}${priority.sirens.repeat(2)} **JANGAN SAMPE KETINGGALAN!** ${priority.sirens.repeat(2)}`,
    embeds: [
      {
        title: `⚡ PRIORITAS #${priority.rank}: ${priority.label} LIVE SEKARANG! ⚡`,
        description: `**${memberName}** baru aja mulai live di IDN Live.\n\n[🔴 **TONTON SEKARANG**](${liveUrl})`,
        url: liveUrl,
        color: priority.color,
        footer: { text: "IDN Live Priority Alert" },
        timestamp: new Date().toISOString(),
      },
    ],
  };
}

async function sendDiscordNotif(memberName, username, slug, status = "start") {
  // Tanpa "www" biar konsisten sama link yang di-generate tombol Share di
  // app IDN sendiri (lebih besar kemungkinan ke-handle sebagai App
  // Link/Universal Link, alias langsung buka app di HP kalau appnya
  // udah ke-install, bukan buka browser).
  const liveUrl = `https://idn.app/${username}/live/${slug}`;
  const priority = getPriorityConfig(memberName, username);
  const payload = priority
    ? buildPriorityPayload(memberName, liveUrl, status, priority)
    : buildNormalPayload(memberName, liveUrl, status);

  if (status === "start") {
    const subscriberIds = getSubscribersFor(memberName, username);
    if (subscriberIds.length > 0) {
      const mentions = subscriberIds.map((id) => `<@${id}>`).join(" ");
      payload.content = `${payload.content}\n${mentions} kamu subscribe notif buat member ini!`;
    }
  }

  try {
    const response = await fetch(DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`Discord webhook balikin status ${response.status}`);
    }

    console.log(`Notif ${status} terkirim untuk ${memberName}`);
    return true;
  } catch (error) {
    console.error("Gagal ngirim notif ke Discord:", error.message);
    return false;
  }
}

// PENTING: ini PERKIRAAN, bukan deteksi beneran. API IDN nggak nyediain data
// gift/podium sama sekali, jadi kita cuma bisa nebak dari durasi live
// dibanding rata-rata durasi live orang itu sebelumnya (atau ambang default
// kalau belum ada riwayat). Bisa aja meleset - dipicu sekali doang per sesi
// live biar nggak spam.
async function maybeAlertEndingSoon(entry, durationHistory) {
  const priority = getPriorityConfig(entry.name, entry.username);
  if (!priority) return; // heuristik ini cuma buat 3 member prioritas
  if (entry.endingSoonAlerted || !entry.liveAt) return;

  const elapsedMs = Date.now() - new Date(entry.liveAt).getTime();
  const avgMs = getAverageDuration(durationHistory, entry.username);
  const thresholdMs = avgMs ? avgMs * 0.8 : DEFAULT_ENDING_SOON_THRESHOLD_MS;

  if (elapsedMs >= thresholdMs) {
    entry.endingSoonAlerted = true;
    saveActiveLives();
    await sendEndingSoonAlert(entry, priority, elapsedMs, avgMs);
  }
}

async function sendEndingSoonAlert(entry, priority, elapsedMs, avgMs) {
  const mention = PRIORITY_PING_USER_ID ? `<@${PRIORITY_PING_USER_ID}> ` : "";
  const liveUrl = `https://idn.app/${entry.username}/live/${entry.slug}`;
  const elapsedText = formatDuration(elapsedMs);
  const basis = avgMs
    ? `rata-rata live dia biasanya ${formatDuration(avgMs)}`
    : `belum ada cukup riwayat, pakai perkiraan umum ${formatDuration(DEFAULT_ENDING_SOON_THRESHOLD_MS)}`;

  const payload = {
    content: `${mention}${priority.sirens} **${priority.label} udah live ${elapsedText}** - kemungkinan mendekati akhir/mau baca podium (${basis}). Ini perkiraan doang, bisa meleset!`,
    embeds: [
      {
        title: `⏳ Kemungkinan ${priority.label} bakal segera akhirin live`,
        description: `**PERKIRAAN, bukan kepastian** - cek langsung buat mastiin.\n\n[🔴 **BUKA LIVE-NYA**](${liveUrl})`,
        color: priority.color,
        footer: { text: "Heuristik durasi live, bisa meleset" },
        timestamp: new Date().toISOString(),
      },
    ],
  };

  try {
    const response = await fetch(DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      throw new Error(`Discord webhook balikin status ${response.status}`);
    }
    console.log(`Alert 'ending soon' terkirim untuk ${entry.name}`);
  } catch (error) {
    console.error("Gagal ngirim alert ending-soon:", error.message);
  }
}

// Jalankan polling tiap 30 detik (self-scheduling biar nggak tumpang tindih
// kalau checkLiveMembers kebetulan lebih lambat dari interval-nya)
async function pollLoop() {
  await checkLiveMembers();
  setTimeout(pollLoop, POLL_INTERVAL_MS);
}

// Endpoint contoh yang dilindungi signature - nunjukkin data internal bot
// yang lebih detail dibanding health-check publik. Pola ini yang dipake
// kalau nanti nambah endpoint lain yang nyajiin data beneran.
function handleProtectedStatus(req, res) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      status: "ok",
      uptimeSeconds: Math.floor(process.uptime()),
      activeLivesCount: activeLives.size,
      activeLives: [...activeLives.values()].map((entry) => ({
        name: entry.name,
        username: entry.username,
        liveAt: entry.liveAt,
      })),
    }),
  );
}

// Nerima snapshot top-gifter yang di-push dari scripts/cek-top-gifter.js
// (jalan di komputer lokal siapapun yang megang akun IDN-nya). Body-nya
// CUMA hasil (username, name, gifters) - nggak ada kredensial IDN sama
// sekali yang lewat sini, jadi aman walau endpoint-nya "publik" (tetep
// dilindungi signature, tapi isinya emang bukan rahasia).
function handleGifterSnapshotUpload(req, res, body) {
  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Method not allowed, pakai POST" }));
    return;
  }

  let payload;
  try {
    payload = JSON.parse(body);
  } catch (error) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Body bukan JSON valid" }));
    return;
  }

  const { username, name, gifters } = payload || {};
  if (typeof username !== "string" || !username || typeof name !== "string" || !name || !Array.isArray(gifters)) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Body harus punya username (string), name (string), dan gifters (array)" }));
    return;
  }

  const snapshot = loadGifterSnapshot();
  snapshot.members[username] = { name, gifters, checkedAt: new Date().toISOString() };
  saveGifterSnapshot(snapshot);

  console.log(`Snapshot gifter ke-update buat ${name} (${gifters.length} gifter)`);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, username, gifterCount: gifters.length }));
}

// Railway (dan platform hosting sejenis) ngecek apakah service "sehat" dengan
// nunggu ada port yang kebuka. Bot ini murni background process tanpa server
// HTTP, jadi tanpa ini Railway bisa nganggep container-nya nggak sehat dan
// restart terus-menerus. Server kecil ini cuma buat "ngasih tanda hidup".
//
// /api/status & /api/gifter-snapshot sengaja dipisah dan dilindungi
// signature - health-check di "/" TETAP publik tanpa signature, karena
// Railway & UptimeRobot manggil itu tanpa tahu cara nge-sign request.
const PORT = process.env.PORT || 3000;
require("http")
  .createServer((req, res) => {
    if (req.url === "/api/status") {
      if (!API_SECRET) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "API_SECRET belum diset di server" }));
        return;
      }
      requireSignedRequest(API_SECRET, handleProtectedStatus)(req, res);
      return;
    }

    if (req.url === "/api/gifter-snapshot") {
      if (!API_SECRET) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "API_SECRET belum diset di server" }));
        return;
      }
      requireSignedRequest(API_SECRET, handleGifterSnapshotUpload)(req, res);
      return;
    }

    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("JKT48 IDN Live notifier is running.\n");
  })
  .listen(PORT, () => {
    console.log(`Health check server listening on port ${PORT}`);
  });

// Kata kunci buat manggil bot di chat (contoh: "Cok, ini yang masih live
// siapa aja?"). Pesan yang nggak nyebut salah satu kata ini bakal diabaikan,
// biar bot nggak ikut respon ke obrolan biasa di channel.
const CHAT_WAKE_WORDS = ["cok"];
// Kata-kata yang nunjukkin pesannya kemungkinan nanya soal live, walau nggak
// nyebut "cok" sama sekali (misal "siapa yang live?"). Supaya nggak ke-trigger
// tiap kali kata "live" muncul di obrolan biasa, ini cuma dianggap "nanya ke
// bot" kalau ada tanda tanya atau kata tanya juga di pesannya.
const TOPIC_WORDS = ["live"];
const QUESTION_HINTS = ["?", "siapa", "apa", "gimana", "kapan", "berapa"];

function getGreeting() {
  const hourWIB = Number(
    new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Jakarta", hour: "numeric", hour12: false }).format(new Date()),
  );
  if (hourWIB >= 4 && hourWIB < 11) return "pagi";
  if (hourWIB >= 11 && hourWIB < 15) return "siang";
  if (hourWIB >= 15 && hourWIB < 18) return "sore";
  return "malam";
}

function getSortedActiveLives() {
  return [...activeLives.values()].sort((a, b) => new Date(a.liveAt) - new Date(b.liveAt));
}

// Di bawah 30 menit dianggap "baru live", 30 menit ke atas "udah live".
const NEW_LIVE_THRESHOLD_MS = 30 * 60000;

function describeElapsed(ms) {
  const prefix = ms < NEW_LIVE_THRESHOLD_MS ? "baru live" : "udah live";
  return `${prefix} ${formatDuration(ms)}`;
}

function replyListLive() {
  const sorted = getSortedActiveLives();
  if (sorted.length === 0) return "Cok, lagi nggak ada member JKT48 yang live nih.";

  const lines = sorted.map((entry, i) => {
    const elapsedText = describeElapsed(Date.now() - new Date(entry.liveAt).getTime());
    const viewText = entry.viewCount != null ? ` | 👁️ ${formatViewCount(entry.viewCount)}` : "";
    return `${i + 1}. **${entry.name}** - ${elapsedText}${viewText}`;
  });

  return `Cok, ini yang lagi live (urut dari paling lama):\n${lines.join("\n")}`;
}

function replyLongestLive() {
  const sorted = getSortedActiveLives();
  if (sorted.length === 0) return "Cok, lagi nggak ada yang live.";
  const longest = sorted[0];
  const elapsedText = describeElapsed(Date.now() - new Date(longest.liveAt).getTime());
  return `Yang paling lama live sekarang: **${longest.name}**, ${elapsedText}.`;
}

// Beda sama replyLongestLive (durasi live) - ini urut berdasarkan JUMLAH
// PENONTON, buat jawab "siapa yang paling rame ditonton sekarang".
function replyTopViewers() {
  const withViews = [...activeLives.values()].filter((e) => e.viewCount != null);
  if (withViews.length === 0) return "Cok, lagi nggak ada data penonton buat live sekarang.";

  const sorted = [...withViews].sort((a, b) => b.viewCount - a.viewCount);
  const medals = ["🥇", "🥈", "🥉"];
  const lines = sorted.map((entry, i) => {
    const medal = medals[i] || `${i + 1}.`;
    return `${medal} **${entry.name}** - 👁️ ${formatViewCount(entry.viewCount)}`;
  });

  return `👀 Paling rame ditonton sekarang:\n${lines.join("\n")}`;
}

function replyBotStatus() {
  return `✅ Bot jalan normal. Lagi mantau ${activeLives.size} member yang live sekarang.`;
}

function replySpecificMember(entry) {
  const elapsedText = describeElapsed(Date.now() - new Date(entry.liveAt).getTime());
  const startText = entry.liveAt ? `, mulai jam ${formatClockWIB(new Date(entry.liveAt))}` : "";
  const viewText = entry.viewCount != null ? ` | 👁️ ${formatViewCount(entry.viewCount)} penonton` : "";
  const liveUrl = `https://idn.app/${entry.username}/live/${entry.slug}`;
  return `**${entry.name}** lagi live, ${elapsedText}${startText}${viewText}. ${liveUrl}`;
}

function replyMemberNotFound(fragment) {
  return `Cok, nggak nemu member "${fragment}" yang lagi live. Coba cek ejaannya, atau tanya "cok siapa yang live" buat liat daftarnya.`;
}

// Nama akun IDN biasanya "Nala JKT48" atau "Piya | Karafuru Idol Group" -
// yang orang beneran ketik biasanya cuma nama depannya ("Nala", "Piya"),
// bukan nama lengkap persis. Jadi cocokin ke kata pertama dari nama-nya,
// bukan nyari nama lengkap sebagai substring persis (itu penyebab bug-nya).
function findMemberByNameFragment(fragment) {
  const needle = (fragment || "").trim().toLowerCase();
  if (!needle) return null;

  for (const entry of activeLives.values()) {
    if (!entry.name) continue;
    const givenName = entry.name.split(/[\s|]+/)[0].toLowerCase();
    if (matchesNameFragment(needle, givenName)) {
      return entry;
    }
  }
  return null;
}

function replyHelp() {
  return [
    "Cok bisa jawab ini:",
    '- "cok ini yang masih live siapa aja?"',
    '- "cok siapa yang paling lama live?"',
    '- "cok siapa yang paling rame ditonton?"',
    '- "cok status"',
    '- "cok <nama member> masih live?"',
    '- "cok stats <nama member>" - statistik durasi live-nya',
    '- "cok gifter <nama member>" - top gifter (snapshot terakhir dari "npm run cek-gifter", bukan real-time)',
    '- "cok rekap hari ini" - rekap live yang udah selesai hari ini',
    '- "cok daftar prioritas" - lihat member prioritas',
    '- "cok ingetin <nama member>" - kamu di-tag pribadi kalau dia mulai live',
    '- "cok berhenti ingetin <nama member>" - matiin reminder itu',
    '- "cok reminder aku" - lihat kamu subscribe reminder siapa aja',
    '- (khusus owner) "cok tambah prioritas <nama>" / "cok hapus prioritas <nama>"',
  ].join("\n");
}

// Daftar SEMUA member prioritas (bawaan Nala/Levi/Lily + custom yang
// ditambahin owner lewat chat) - siapa aja boleh nanya ini, bukan cuma owner.
function replyPriorityList() {
  const all = getAllPriorityMembers().sort((a, b) => a.rank - b.rank);
  if (all.length === 0) return "Cok, belum ada member prioritas yang diset.";
  const lines = all.map((p) => `${p.rank}. **${p.label}** (keyword: "${p.keyword}")`);
  return `⭐ Daftar member prioritas:\n${lines.join("\n")}`;
}

// Kebalikan dari handleSubscribe/handleUnsubscribe - buat user nanya "aku
// subscribe siapa aja sih" tanpa harus inget-inget sendiri.
function replyMySubscriptions(authorId) {
  const subs = loadSubscriptions();
  const keywords = Object.entries(subs)
    .filter(([, ids]) => ids.includes(authorId))
    .map(([keyword]) => keyword);

  if (keywords.length === 0) {
    return 'Cok, kamu belum subscribe reminder buat siapa pun. Ketik "cok ingetin <nama member>" buat mulai.';
  }
  return `🔔 Kamu subscribe reminder buat: ${keywords.map((k) => `"${k}"`).join(", ")}`;
}

// Versi on-demand dari rekap harian otomatis (yang ngirim sendiri jam 23:00
// WIB) - ini dipanggil kapan aja user nanya, nunjukkin progress SEJAUH INI
// (live yang masih berlangsung belum ikut ke-hitung, baru masuk pas selesai).
// Async karena nyoba lengkapin data lokal pakai arsip eksternal (lihat
// komentar di fetchExternalTodayLiveHistory). Kalau arsipnya gak keambil
// (network error/dll), fungsi ini tetep balikin rekap versi lokal doang -
// gak pernah gagal total gara-gara sumber tambahan ini.
// Discord ngerender fenced code block (```) monospace - dipake buat nyusun
// tabel yang kolomnya rapi rata kiri-kanan, bukan cuma daftar baris teks.
// Dipecah per PAGE_SIZE baris biar sesi yang buanyak hari ini nggak numbrung
// ngelewatin limit 2000 karakter per pesan Discord - sebelumnya kelebihan
// cuma di-buang diem-diem (cuma dikasih catetan "+N sesi lainnya"), sekarang
// bisa diminta liat halaman berikutnya lewat "cok rekap" -> jawab "y".
const RECAP_TABLE_PAGE_SIZE = 20;

function buildRecapTablePage(sessions, page) {
  const sorted = [...sessions].sort((a, b) => a.startedAtUnix - b.startedAtUnix);
  const totalPages = Math.max(1, Math.ceil(sorted.length / RECAP_TABLE_PAGE_SIZE));
  const clampedPage = Math.min(Math.max(page, 0), totalPages - 1);
  const start = clampedPage * RECAP_TABLE_PAGE_SIZE;
  const pageSessions = sorted.slice(start, start + RECAP_TABLE_PAGE_SIZE);

  const header = ["No", "Member", "Status", "Mulai", "Durasi"];
  const rows = pageSessions.map((s, i) => [
    String(start + i + 1),
    s.name,
    s.endedAtUnix !== null ? "Selesai" : "Live",
    formatClockWIB(new Date(s.startedAtUnix * 1000)),
    s.endedAtUnix !== null ? formatDuration(s.durationMs) : "-",
  ]);

  const widths = header.map((h, col) => Math.max(h.length, ...rows.map((r) => r[col].length)));
  const formatRow = (cols) => cols.map((c, i) => c.padEnd(widths[i])).join(" | ");
  const separator = widths.map((w) => "-".repeat(w)).join("-+-");

  const text = ["```", formatRow(header), separator, ...rows.map(formatRow), "```"].join("\n");
  return { text, page: clampedPage, totalPages, hasMore: clampedPage < totalPages - 1 };
}

// "channelId:authorId" -> { nextPage, at } - nunggu jawaban y/n abis nunjukkin
// 1 halaman tabel rekap yang masih ada lanjutannya. Sama pola-nya kayak
// pendingWatchConfirm (di-key per orang, bukan per channel, biar jawaban
// orang lain di channel yang sama gak nyasar ke halaman punya orang ini).
const pendingRecapPage = new Map();
const PENDING_RECAP_PAGE_TTL_MS = 2 * 60000;

function buildRecapPageBlock(sessions, page, channelId, authorId) {
  const result = buildRecapTablePage(sessions, page);
  const footer = result.hasMore
    ? `_(Halaman ${result.page + 1}/${result.totalPages} - masih ada lagi, mau liat halaman berikutnya? Balas "y")_`
    : `_(Halaman ${result.page + 1}/${result.totalPages} - udah paling akhir)_`;

  if (result.hasMore && channelId && authorId) {
    pendingRecapPage.set(`${channelId}:${authorId}`, { nextPage: result.page + 1, at: Date.now() });
  }

  return `${result.text}\n${footer}`;
}

// Dicek di awal buildChatReply (sama pola kayak tryHandleWatchConfirmShortcut)
// - jawaban "y"/"n" polos buat lanjut halaman rekap gak nyebut "cok"/"live",
// jadi harus ditangkep sebelum gerbang wake-word.
async function tryHandleRecapPageShortcut(text, channelId, authorId) {
  if (!channelId || !authorId) return null;
  const key = `${channelId}:${authorId}`;
  const pending = pendingRecapPage.get(key);
  if (!pending) return null;

  if (Date.now() - pending.at > PENDING_RECAP_PAGE_TTL_MS) {
    pendingRecapPage.delete(key);
    return null;
  }

  const isYes = YES_PATTERN.test(text);
  const isNo = NO_PATTERN.test(text);
  if (!isYes && !isNo) return null;

  pendingRecapPage.delete(key);
  if (isNo) return "Oke, segitu aja ya.";

  const log = loadDailyLog();
  return buildRecapPageBlock(log.sessions, pending.nextPage, channelId, authorId);
}

// Dulu ini cuma baca log.entries (yang cuma keisi pas live SELESAI) - jadi
// kalau ditanya pas member masih live (padahal bot udah ngirim notif "mulai
// live"-nya), balesannya "zonk" walau data-nya SEBENERNYA ada. Sekarang
// pakai log.sessions yang kecatet dari notif "mulai" juga, jadi sesi yang
// masih live pun ikut keliatan (statusnya "🔴 Live", durasi belum ada).
async function replyTodayRecapSoFar(channelId, authorId) {
  const log = loadDailyLog();
  const sessions = log.sessions;
  const completed = sessions.filter((s) => s.endedAtUnix !== null);
  const ongoingCount = sessions.length - completed.length;

  // Member yang KETAUAN live hari ini dari arsip eksternal, tapi beneran gak
  // ke-track lokal sama sekali (bukan cuma "masih live", tapi bot-nya emang
  // kelewatan momennya - mis. sempet mati/restart pas dia live).
  const trackedNames = new Set(sessions.map((s) => s.name));
  const external = await fetchExternalTodayLiveHistory();
  const missedByMember = new Map();
  for (const e of external || []) {
    if (trackedNames.has(e.creator_name) || activeLives.has(e.username)) continue;
    if (!missedByMember.has(e.creator_name)) missedByMember.set(e.creator_name, e);
  }
  const missedNote =
    missedByMember.size > 0
      ? `\n\n📡 Dari arsip publik JKT48Live-Record, ketauan juga live hari ini yang kelewatan bot: ${[...missedByMember.entries()]
          .map(([name, e]) => `**${name}** (${formatClockWIB(new Date(e.live_at_unix * 1000))})`)
          .join(", ")} - durasinya belum ke-track soalnya bot nggak nyaksiin dari awal sampai selesai.`
      : "";

  if (sessions.length === 0) {
    return `Cok, belum ada yang live hari ini (${log.date}).${missedNote}`;
  }

  const totalDurationMs = completed.reduce((sum, s) => sum + s.durationMs, 0);
  const uniqueMembers = new Set(sessions.map((s) => s.name)).size;
  const longest = completed.length > 0 ? completed.reduce((max, s) => (s.durationMs > max.durationMs ? s : max), completed[0]) : null;

  const summaryLines = [
    `📋 **Rekap live hari ini (${log.date})**`,
    `Total sesi: ${sessions.length}x dari ${uniqueMembers} member (${completed.length} udah selesai, ${ongoingCount} masih live)`,
  ];
  if (longest) {
    summaryLines.push(
      `Total durasi (yang udah selesai): ${formatDuration(totalDurationMs)} | Paling lama: **${longest.name}** (${formatDuration(longest.durationMs)})`,
    );
  }

  return [summaryLines.join("\n"), buildRecapPageBlock(sessions, 0, channelId, authorId)].join("\n") + missedNote;
}

function replyMemberStats(fragment) {
  const found = findDurationHistoryByNameFragment(fragment);
  if (!found || found.entries.length === 0) {
    return `Cok, belum ada data riwayat live buat "${fragment.trim()}".`;
  }

  const durations = found.entries.map((e) => e.durationMs);
  const total = durations.reduce((a, b) => a + b, 0);
  const avg = total / durations.length;
  const max = Math.max(...durations);

  return [
    `📊 Statistik **${found.displayName}** (${durations.length} live terakhir yang ke-track):`,
    `- Rata-rata durasi: ${formatDuration(avg)}`,
    `- Rekor terlama: ${formatDuration(max)}`,
  ].join("\n");
}

// PENTING: ini SNAPSHOT (foto sesaat), bukan live/real-time. Bot ini sendiri
// nggak pernah manggil API top-gifter (butuh login pribadi) - datanya cuma
// seakurat terakhir kali kamu jalanin "npm run cek-gifter" manual, jadi
// selalu dikasih tau "dicek X lalu" biar orang gak salah kira ini real-time.
function replyGifterSnapshot(fragment) {
  const name = (fragment || "").trim();
  if (!name) return 'Gifter siapa? Ketik nama membernya juga ya, misal "cok gifter kathrina".';

  const found = findGifterSnapshotByNameFragment(name);
  if (!found) {
    return `Cok, belum ada data top gifter buat "${name}". Yang pegang akun IDN-nya bisa jalanin "npm run cek-gifter" dulu di komputernya biar ke-update.`;
  }

  const checkedText = formatRelativeTime(new Date(found.checkedAt));
  if (!found.gifters || found.gifters.length === 0) {
    return `Cok, **${found.name}** belum ada gifter di data terakhir (dicek ${checkedText}, bukan live real-time).`;
  }

  const medals = ["🥇", "🥈", "🥉"];
  const lines = found.gifters
    .slice(0, 10)
    .map((g, i) => `${medals[i] || `${i + 1}.`} ${g.name} - ${Number(g.total_gold).toLocaleString("id-ID")} Gold`);

  return [`🏆 **Top Gifter ${found.name}** (dicek ${checkedText}, BUKAN live real-time)`, ...lines].join("\n");
}

function isOwner(authorId) {
  return Boolean(PRIORITY_PING_USER_ID) && authorId === PRIORITY_PING_USER_ID;
}

// Dipake buat bersihin ekor kayak "nala live" / "nala live?" jadi cuma
// "nala" - orang sering nulis kalimat lengkap ("tambah prioritas nala live")
// padahal yang dibutuhin cuma nama/keyword-nya doang.
function stripTrailingLiveWord(raw) {
  return (raw || "").trim().replace(/\s+live\??$/i, "").trim();
}

function handleAddPriority(nameFragment, authorId) {
  if (!isOwner(authorId)) return "Cok, cuma owner yang boleh ubah daftar prioritas.";
  const name = stripTrailingLiveWord(nameFragment);
  const result = addCustomPriorityMember(name);
  if (!result.ok && result.reason === "exists") return `"${name}" udah ada di daftar prioritas.`;
  if (!result.ok && result.reason === "too_short") return "Nama/keyword-nya kependekan, minimal 3 huruf ya.";
  if (!result.ok) return "Gagal nambahin, coba lagi.";
  return `✅ "${name}" ditambahin ke daftar prioritas, notif live-nya bakal jadi flashy sekarang.`;
}

function handleRemovePriority(nameFragment, authorId) {
  if (!isOwner(authorId)) return "Cok, cuma owner yang boleh ubah daftar prioritas.";
  const name = stripTrailingLiveWord(nameFragment);
  const result = removeCustomPriorityMember(name);
  if (!result.ok) return `"${name}" nggak ketemu di daftar prioritas custom (Nala/Levi/Lily nggak bisa dihapus lewat chat).`;
  return `✅ "${name}" dihapus dari daftar prioritas.`;
}

// Beda dari priority list (khusus owner), subscribe ini SIAPA AJA boleh -
// personal reminder buat di-tag pas member manapun mulai live.
function handleSubscribe(rawName, authorId) {
  const name = stripTrailingLiveWord(rawName);
  const result = addSubscription(name, authorId);
  if (!result.ok && result.reason === "too_short") return "Nama membernya kependekan, minimal 3 huruf ya.";
  if (!result.ok && result.reason === "already") return `Kamu udah subscribe notif buat "${name}" kok.`;
  if (!result.ok) return "Gagal subscribe, coba lagi.";
  return `🔔 Sip, kamu bakal di-tag tiap kali "${name}" mulai live!`;
}

function handleUnsubscribe(rawName, authorId) {
  const name = stripTrailingLiveWord(rawName);
  const result = removeSubscription(name, authorId);
  if (!result.ok) return `Kamu belum subscribe "${name}".`;
  return `🔕 Oke, notif buat "${name}" dimatiin.`;
}

// Channel -> kapan terakhir menu fallback ditampilin di situ. Dipake biar
// user bisa balas cukup ketik angkanya doang (1-4) abis menu-nya muncul -
// tapi CUMA kalau menu-nya baru aja beneran ditampilin duluan, biar ketik
// angka "mentah" tanpa konteks tetap nunjukkin menu-nya dulu (bukan nebak).
const pendingMenuByChannel = new Map();
const PENDING_MENU_TTL_MS = 3 * 60000;

// Dipanggil kalau pesannya kedetect nanya soal live tapi nggak match
// pertanyaan yang udah dikenali - dikasih menu daripada bot diem aja.
//
// CATATAN: pilihan #3 dulu teksnya "paling lama live PER HARI INI" - itu
// SALAH, yang beneran dijalanin (replyLongestLive) itu ranking durasi live
// yang LAGI AKTIF sekarang, bukan rekap harian (itu fiturnya "cok rekap
// hari ini" / pilihan #8, beda). Dibenerin biar gak nyesetin ekspektasi.
function replyFallbackMenu() {
  const ownerContact = PRIORITY_PING_USER_ID ? `<@${PRIORITY_PING_USER_ID}>` : "owner channel ini";
  return [
    `Halo, selamat ${getGreeting()}! Apa yang ingin kamu tanyakan?`,
    "1. Siapa saja yang masih live?",
    "2. Status live sekarang",
    "3. Siapa yang paling lama live sekarang?",
    "4. Apakah <nama member> masih live?",
    "5. Siapa yang paling rame ditonton sekarang?",
    "6. Daftar member prioritas",
    "7. Reminder aku (siapa aja yang aku subscribe)",
    "8. Rekap live hari ini",
    "9. Cek top gifter <nama member> (data terakhir dari 'npm run cek-gifter', bukan real-time)",
    "",
    '(Abis ini kamu bisa balas cukup ketik angkanya aja, misal "1" atau "4 Nala")',
    "",
    `Kalau ada pertanyaan lain, silakan hubungi ${ownerContact}.`,
  ].join("\n");
}

async function tryHandleMenuShortcut(text, channelId, authorId) {
  if (!channelId) return null;

  const shownAt = pendingMenuByChannel.get(channelId);
  const isPending = shownAt && Date.now() - shownAt <= PENDING_MENU_TTL_MS;
  if (!isPending) return null;

  // Sebelumnya /^([1-4])\s*(.*)$/ - itu match ke SEMUA pesan yang cuma
  // DIAWALI angka 1-4 (mis. "10 menit lagi" ke-anggep pilih menu #1). Sekarang
  // pilihan yang nggak butuh input tambahan (1-3, 5-8) harus persis SATU
  // angka itu doang, dan pilihan yang butuh nama member (4, 9) harus "4"/"9"
  // doang atau "4 <spasi><nama>"/"9 <spasi><nama>" - bukan asal awalan angka.
  const bareChoice = text.match(/^([1-3]|[5-8])$/);
  const choiceFour = text.match(/^4(?:\s+(.+))?$/);
  const choiceNine = text.match(/^9(?:\s+(.+))?$/);
  if (!bareChoice && !choiceFour && !choiceNine) return null;

  pendingMenuByChannel.delete(channelId); // sekali pake abis itu clear

  if (bareChoice) {
    switch (bareChoice[1]) {
      case "1":
        return replyListLive();
      case "2":
        return replyBotStatus();
      case "3":
        return replyLongestLive();
      case "5":
        return replyTopViewers();
      case "6":
        return replyPriorityList();
      case "7":
        return replyMySubscriptions(authorId);
      default:
        return await replyTodayRecapSoFar(channelId, authorId); // "8"
    }
  }

  if (choiceFour) {
    const rest = (choiceFour[1] || "").trim();
    if (!rest) return 'Member yang mana? Ketik nama membernya juga ya, misal "4 Nala".';
    return startWatchConfirm(rest, channelId, authorId);
  }

  const restNine = (choiceNine[1] || "").trim();
  if (!restNine) return 'Gifter siapa? Ketik nama membernya juga ya, misal "9 Nala".';
  return replyGifterSnapshot(restNine);
}

// "channelId:authorId" -> { username, name, at } - nunggu jawaban y/n abis
// user milih member lewat menu #4. Di-key per channel+author (beda dari
// pendingMenuByChannel yang per-channel doang) soalnya ini nunggu jawaban
// SATU ORANG spesifik - kalau cuma per-channel, jawaban "y" dari orang lain
// di channel yang sama bisa nyangkut ke pertanyaan yang bukan buat dia.
const pendingWatchConfirm = new Map();
const PENDING_WATCH_CONFIRM_TTL_MS = 2 * 60000;
const YES_PATTERN = /^(y|ya|iya|iyah|iy|yes|yup|yoi|oke|ok|gas|mau|boleh)$/i;
const NO_PATTERN = /^(n|no|ga|gak|kaga|nggak|enggak|tidak|males|ga\s*mau|nggak\s*mau)$/i;

// Dipanggil abis user milih member lewat "4 <nama>" - kalau membernya lagi
// live, JANGAN langsung kasih link, tanya dulu "mau nonton?" (biar kayak
// ngobrol beneran, bukan asal muntahin info). Kalau membernya ternyata lagi
// nggak live, gak usah nanya apa-apa lagi, langsung bilang aja.
function startWatchConfirm(fragment, channelId, authorId) {
  const found = findMemberByNameFragment(fragment);
  if (!found) return replyMemberNotFound(fragment);

  if (channelId && authorId) {
    pendingWatchConfirm.set(`${channelId}:${authorId}`, { username: found.username, name: found.name, at: Date.now() });
  }
  return `**${found.name}** lagi live nih! Mau nonton sekarang? (y/n)`;
}

// Dicek di AWAL buildChatReply (kayak tryHandleMenuShortcut) - jawaban "y"
// atau "n" polos nggak nyebut "cok"/"live" sama sekali, jadi kalau nunggu
// wake-word dulu, jawabannya nggak akan pernah ke-proses.
function tryHandleWatchConfirmShortcut(text, channelId, authorId) {
  if (!channelId || !authorId) return null;
  const key = `${channelId}:${authorId}`;
  const pending = pendingWatchConfirm.get(key);
  if (!pending) return null;

  if (Date.now() - pending.at > PENDING_WATCH_CONFIRM_TTL_MS) {
    pendingWatchConfirm.delete(key);
    return null;
  }

  const isYes = YES_PATTERN.test(text);
  const isNo = NO_PATTERN.test(text);
  if (!isYes && !isNo) return null; // bukan jawaban y/n, biarin ke routing normal

  pendingWatchConfirm.delete(key); // sekali pake abis itu clear

  // Re-cek status live-nya SEKARANG, jangan percaya data lama - bisa aja
  // dia udah selesai live selagi user mikir mau jawab y/n apa nggak.
  const entry = activeLives.get(pending.username);
  if (!entry) {
    return `Yah, **${pending.name}** kayaknya baru aja selesai live.`;
  }

  if (isYes) {
    const liveUrl = `https://idn.app/${entry.username}/live/${entry.slug}`;
    return `🔴 Gas nonton! **${entry.name}** - ${liveUrl}`;
  }

  const elapsedText = describeElapsed(Date.now() - new Date(entry.liveAt).getTime());
  return `Oke sip. **${entry.name}** ${elapsedText}, kalau berubah pikiran tinggal cek lagi ya.`;
}

async function buildChatReply(rawContent, { isBotChannel = false, channelId = null, authorId = null } = {}) {
  const text = (rawContent || "").toLowerCase().trim();

  const watchConfirmReply = tryHandleWatchConfirmShortcut(text, channelId, authorId);
  if (watchConfirmReply) return watchConfirmReply;

  // Dicek abis watchConfirm - kalau kebetulan dua-duanya lagi pending buat
  // orang yang sama, jawaban "y"-nya kepake buat yang pertama diminta duluan.
  const recapPageReply = await tryHandleRecapPageShortcut(text, channelId, authorId);
  if (recapPageReply) return recapPageReply;

  const shortcutReply = await tryHandleMenuShortcut(text, channelId, authorId);
  if (shortcutReply) return shortcutReply;

  // Di channel khusus bot, hampir semua pesan dianggap "ditujukan ke bot" -
  // gak perlu nyebut "cok" atau "live" dulu.
  const mentionsBot = isBotChannel || CHAT_WAKE_WORDS.some((w) => containsWholeWord(text, w));
  const looksLikeLiveQuestion =
    TOPIC_WORDS.some((w) => containsWholeWord(text, w)) &&
    QUESTION_HINTS.some((w) => (w === "?" ? text.includes("?") : containsWholeWord(text, w)));

  if (!mentionsBot && !looksLikeLiveQuestion) return null;

  const addPriorityMatch = text.match(/tambah(?:in|kan)?\s+prioritas\s+(.+)/);
  if (addPriorityMatch) {
    return handleAddPriority(addPriorityMatch[1], authorId);
  }

  const removePriorityMatch = text.match(/hapus\s+prioritas\s+(.+)/);
  if (removePriorityMatch) {
    return handleRemovePriority(removePriorityMatch[1], authorId);
  }

  // Dicek sebelum unsubscribeMatch/subscribeMatch di bawah - "reminder"
  // adalah kata kunci beda dari "ingetin", tapi kalimatnya bisa aja ngandung
  // dua-duanya sekaligus (mis. "cok reminder aku ingetin siapa aja"), jadi
  // biar nggak ketangkep duluan sama regex subscribe yang lebih rakus.
  if (containsWholeWord(text, "reminder")) {
    return replyMySubscriptions(authorId);
  }

  // "berhenti ingetin" harus dicek DULUAN sebelum "ingetin" biasa, soalnya
  // kalimatnya juga ngandung kata "ingetin" dan bakal ketangkep regex subscribe.
  const unsubscribeMatch = text.match(/berhenti\s+ingetin(?:in)?\s+(?:kalau\s+|kalo\s+)?(.+)/);
  if (unsubscribeMatch) {
    return handleUnsubscribe(unsubscribeMatch[1], authorId);
  }

  const subscribeMatch = text.match(/ingetin(?:in)?\s+(?:kalau\s+|kalo\s+)?(.+)/);
  if (subscribeMatch) {
    return handleSubscribe(subscribeMatch[1], authorId);
  }

  const statsMatch = text.match(/stat(?:s|istik)\s+(.+)/);
  if (statsMatch) {
    return replyMemberStats(statsMatch[1]);
  }

  const gifterMatch = text.match(/gifter\s+(.+)/);
  if (gifterMatch) {
    return replyGifterSnapshot(gifterMatch[1]);
  }

  if (containsWholeWord(text, "prioritas") && (containsWholeWord(text, "daftar") || containsWholeWord(text, "siapa") || containsWholeWord(text, "list"))) {
    return replyPriorityList();
  }

  if (containsWholeWord(text, "rekap")) {
    return await replyTodayRecapSoFar(channelId, authorId);
  }

  const asksTopViewers =
    containsWholeWord(text, "viewer") ||
    (containsWholeWord(text, "penonton") && (containsWholeWord(text, "banyak") || containsWholeWord(text, "terbanyak") || containsWholeWord(text, "rame"))) ||
    (containsWholeWord(text, "ditonton") && (containsWholeWord(text, "banyak") || containsWholeWord(text, "rame")));
  if (asksTopViewers) {
    return replyTopViewers();
  }

  if (containsWholeWord(text, "live") && (containsWholeWord(text, "paling lama") || containsWholeWord(text, "udah lama"))) {
    return replyLongestLive();
  }

  if (
    containsWholeWord(text, "live") &&
    (containsWholeWord(text, "siapa") || containsWholeWord(text, "list") || containsWholeWord(text, "apa aja") || containsWholeWord(text, "ada berapa"))
  ) {
    return replyListLive();
  }

  if (containsWholeWord(text, "status") || containsWholeWord(text, "sehat") || containsWholeWord(text, "masih jalan")) {
    return replyBotStatus();
  }

  if (containsWholeWord(text, "help") || containsWholeWord(text, "bantuan") || containsWholeWord(text, "bisa apa")) {
    return replyHelp();
  }

  const matchedMember = findMemberByNameFragment(text);
  if (matchedMember) {
    return replySpecificMember(matchedMember);
  }

  // Nama-nya dikenalin tapi nggak lagi live sekarang - daripada bilang
  // "nggak ketemu" doang (padahal membernya beneran ada), kasih tau kapan
  // terakhir dia live berdasarkan riwayat durasi yang udah ke-track.
  const historyMatch = findDurationHistoryByNameFragment(text);
  if (historyMatch && historyMatch.entries.length > 0) {
    const last = historyMatch.entries[historyMatch.entries.length - 1];
    const lastAt = new Date(last.at);
    return `Cok, **${historyMatch.displayName}** lagi nggak live sekarang. Terakhir live ${formatRelativeTime(lastAt)}, durasinya ${formatDuration(last.durationMs)}.`;
  }

  // Nyebut bot/nanya soal live tapi nggak match pola yang dikenal -> kasih
  // menu daripada diem aja, dan inget channel ini abis dikasih menu.
  if (channelId) pendingMenuByChannel.set(channelId, Date.now());
  return replyFallbackMenu();
}

// Fitur tanya-jawab ini opsional - kalau DISCORD_BOT_TOKEN nggak diset,
// notifikasi tetap jalan normal, cuma bot nggak bisa dichat.
if (DISCORD_BOT_TOKEN) {
  const { Client, GatewayIntentBits } = require("discord.js");
  const chatClient = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  });

  chatClient.once("clientReady", () => {
    console.log(`Bot tanya-jawab login sebagai ${chatClient.user.tag}`);
  });

  chatClient.on("messageCreate", async (message) => {
    try {
      if (message.author.bot) return;
      const isBotChannel = Boolean(BOT_CHANNEL_ID) && message.channel.id === BOT_CHANNEL_ID;
      const reply = await buildChatReply(message.content, {
        isBotChannel,
        channelId: message.channel.id,
        authorId: message.author.id,
      });
      if (reply) await message.reply(reply);
    } catch (error) {
      console.error("Gagal balas chat:", error.message);
    }
  });

  chatClient.login(DISCORD_BOT_TOKEN).catch((error) => {
    console.error("Gagal login bot Discord (cek DISCORD_BOT_TOKEN):", error.message);
  });
} else {
  console.log("DISCORD_BOT_TOKEN nggak diset - fitur tanya-jawab dimatiin (notifikasi tetap jalan normal).");
}

console.log("Bot notifikasi IDN Live jalan...");
pollLoop();
