const fs = require("fs");
const path = require("path");
const { CACHE_DIR } = require("./config");
const { activeLives } = require("./storage/activeLives");
const { writeFileAtomic, getRegisteredStore } = require("./storage/jsonStore");
const { loadDurationHistory } = require("./storage/durationHistory");
const { loadDailyLog } = require("./storage/dailyLog");
const { loadCustomPriorityMembers } = require("./storage/priorityStore");
const { loadSubscriptions } = require("./storage/subscriptions");
const { loadGifterSnapshot } = require("./storage/gifterSnapshot");
const { loadChannelRouting } = require("./storage/channelRouting");
const { loadLiveCount } = require("./storage/liveCount");
const { loadAliases } = require("./storage/aliases");
const { loadStreakAlerts } = require("./storage/streaks");
const { loadMemberRoles } = require("./storage/memberRoles");
const { loadRolePanelState } = require("./storage/rolePanelState");
const { loadViewerTimelines } = require("./storage/viewerTimelines");
const { loadAll: loadUserPrefs } = require("./storage/userPrefs");
const { load: loadGuessGame } = require("./storage/guessGame");
const { loadVc } = require("./storage/vcSchedule");

// Backup = foto SEMUA data bot (dipakai /api/backup, backup mingguan ke DM owner) dan kebalikannya, pemulihan
// (/api/restore). Satu daftar SECTIONS jadi sumber kebenaran buat keduanya, jadi section yang ditambahkan ke
// backup otomatis ikut bisa dipulihkan (dan test memastikan daftar ini tidak melenceng dari store yang ada).

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const everyValue = (obj, check) => Object.values(obj).every(check);
const isStringArray = (v) => Array.isArray(v) && v.every((x) => typeof x === "string");

// Validator: balikin null kalau bentuknya benar, atau alasan penolakan. Sengaja cukup ketat untuk menolak sampah
// yang nanti bikin bot error (mis. sesi tanpa endedAtUnix membuat loadDailyLog melempar), tapi tidak mengunci
// field opsional - backup lama tanpa field baru tetap harus bisa dipulihkan.
const needObject = (v) => (isPlainObject(v) ? null : "harus berupa object");

function validateDurationHistory(v) {
  if (!isPlainObject(v)) return "harus berupa object { username: [entri] }";
  const ok = everyValue(
    v,
    (list) => Array.isArray(list) && list.every((e) => isPlainObject(e) && Number.isFinite(e.durationMs) && typeof e.at === "string"),
  );
  return ok ? null : "tiap username harus berisi array entri { durationMs: angka, at: string }";
}

function validateDailyLog(v) {
  if (!isPlainObject(v) || !Array.isArray(v.sessions)) return "harus berupa object dengan array sessions";
  const sessionsOk = v.sessions.every(
    (s) =>
      isPlainObject(s) &&
      typeof s.username === "string" &&
      Number.isFinite(s.endedAtUnix) &&
      Number.isFinite(s.startedAtUnix) &&
      Number.isFinite(s.durationMs),
  );
  if (!sessionsOk) return "tiap sesi harus punya username (string) serta startedAtUnix, endedAtUnix, durationMs (angka)";
  if (v.streakDates !== undefined && !(isPlainObject(v.streakDates) && everyValue(v.streakDates, isStringArray)))
    return "streakDates harus object { username: [tanggal] }";
  return null;
}

function validateLiveCount(v) {
  if (!isPlainObject(v)) return "harus berupa object";
  return everyValue(v, (e) => isPlainObject(e) && Number.isFinite(e.count)) ? null : "tiap entri harus berupa object dengan count (angka)";
}

function validateVcSchedule(v) {
  if (!isPlainObject(v) || !Array.isArray(v.sessions)) return "harus berupa object dengan array sessions";
  const ok = v.sessions.every(
    (s) =>
      isPlainObject(s) &&
      Number.isInteger(s.id) &&
      typeof s.name === "string" &&
      Number.isInteger(s.session) &&
      typeof s.date === "string" &&
      /^\d{2}:\d{2}$/.test(s.open) &&
      /^\d{2}:\d{2}$/.test(s.start) &&
      typeof s.link === "string",
  );
  if (!ok) return "tiap sesi harus punya id, name, session (angka), date, open/start (HH:MM) dan link";
  if (v.nicknames !== undefined && !(isPlainObject(v.nicknames) && everyValue(v.nicknames, (x) => typeof x === "string")))
    return "nicknames harus object { kunci: julukan }";
  return null;
}

const SECTIONS = [
  { key: "durationHistory", file: "live-duration-history.json", load: loadDurationHistory, validate: validateDurationHistory },
  { key: "dailyLog", file: "daily-log.json", load: loadDailyLog, validate: validateDailyLog },
  {
    key: "customPriority",
    file: "custom-priority.json",
    load: loadCustomPriorityMembers,
    validate: (v) => (Array.isArray(v) ? null : "harus berupa array"),
  },
  {
    key: "subscriptions",
    file: "subscriptions.json",
    load: loadSubscriptions,
    validate: (v) => (isPlainObject(v) && everyValue(v, isStringArray) ? null : "harus berupa object { keyword: [userId] }"),
  },
  {
    key: "gifterSnapshot",
    file: "gifter-snapshot.json",
    load: loadGifterSnapshot,
    validate: (v) => (isPlainObject(v) && isPlainObject(v.members) ? null : "harus berupa object dengan members (object)"),
  },
  // channelRouting berisi URL webhook (bearer secret): ikut /api/backup yang bertanda tangan, TAPI tidak ikut backup mingguan lewat DM.
  { key: "channelRouting", file: "channel-routing.json", load: loadChannelRouting, validate: needObject, secret: true },
  { key: "liveCount", file: "live-count.json", load: loadLiveCount, validate: validateLiveCount },
  {
    key: "aliases",
    file: "aliases.json",
    load: loadAliases,
    validate: (v) => (isPlainObject(v) && everyValue(v, (x) => typeof x === "string") ? null : "harus berupa object { alias: nama }"),
  },
  {
    key: "streakAlerts",
    file: "streak-alerts.json",
    load: loadStreakAlerts,
    validate: (v) => (isPlainObject(v) && everyValue(v, Number.isFinite) ? null : "harus berupa object { username: angka }"),
  },
  { key: "memberRoles", file: "member-roles.json", load: loadMemberRoles, validate: needObject },
  { key: "rolePanel", file: "role-panel.json", load: loadRolePanelState, validate: needObject },
  {
    key: "viewerTimelines",
    file: "viewer-timelines.json",
    load: loadViewerTimelines,
    validate: (v) => (isPlainObject(v) && everyValue(v, Array.isArray) ? null : "harus berupa object { username: [sesi] }"),
  },
  {
    key: "userPrefs",
    file: "user-prefs.json",
    load: loadUserPrefs,
    validate: (v) => (isPlainObject(v) && everyValue(v, isPlainObject) ? null : "harus berupa object { userId: {preferensi} }"),
  },
  { key: "guessGame", file: "guess-game.json", load: loadGuessGame, validate: needObject },
  { key: "vcSchedule", file: "vc-schedule.json", load: loadVc, validate: validateVcSchedule },
];

// activeLives ikut dibackup (info), tapi TIDAK dipulihkan: itu state "siapa yang live sekarang" milik proses yang
// sedang berjalan; menimpanya dengan foto lama bikin notif "selesai" palsu atau notif "mulai" ganda.
const NOT_RESTORED = { activeLives: "sengaja tidak dipulihkan (state live yang sedang berjalan)" };

// Foto seluruh data. `excludeSecrets` membuang section yang berisi rahasia (webhook) dan activeLives -
// dipakai backup mingguan lewat DM, yang menyimpan file di riwayat Discord.
function buildBackupSnapshot({ excludeSecrets = false } = {}) {
  const snapshot = { exportedAt: new Date().toISOString() };
  if (!excludeSecrets) snapshot.activeLives = Object.fromEntries(activeLives);
  for (const section of SECTIONS) {
    if (excludeSecrets && section.secret) continue;
    snapshot[section.key] = section.load();
  }
  return snapshot;
}

function summarize(key, value) {
  if (key === "dailyLog" || key === "vcSchedule") return `${value.sessions.length} sesi`;
  if (Array.isArray(value)) return `${value.length} item`;
  return `${Object.keys(value).length} entri`;
}

// Rencana pemulihan TANPA menulis apa pun. Balikin { error } kalau permintaannya salah (400), atau
// { sections, skipped, invalid } - `invalid` tidak kosong berarti TIDAK ADA yang boleh ditulis.
function planRestore(backup, requestedSections) {
  if (!isPlainObject(backup)) return { error: "backup harus berupa object hasil /api/backup (atau file dari npm run backup-data)" };
  const byKey = new Map(SECTIONS.map((s) => [s.key, s]));
  const has = (key) => Object.prototype.hasOwnProperty.call(backup, key);

  let keys;
  if (requestedSections !== undefined) {
    if (!Array.isArray(requestedSections) || requestedSections.some((k) => typeof k !== "string"))
      return { error: "sections harus array nama section" };
    const unknown = requestedSections.filter((k) => !byKey.has(k));
    if (unknown.length > 0) return { error: `section tidak dikenal: ${unknown.join(", ")}` };
    keys = [...new Set(requestedSections)];
    const absent = keys.filter((k) => !has(k));
    if (absent.length > 0) return { error: `section tidak ada di file backup: ${absent.join(", ")}` };
  } else {
    keys = SECTIONS.map((s) => s.key).filter(has);
  }
  if (keys.length === 0) return { error: "tidak ada section yang bisa dipulihkan di file backup ini" };

  const skipped = Object.keys(backup)
    .filter((k) => k !== "exportedAt" && !byKey.has(k))
    .map((k) => ({ section: k, reason: NOT_RESTORED[k] || "section tidak dikenal, diabaikan" }));

  const invalid = [];
  const sections = [];
  for (const key of keys) {
    const reason = byKey.get(key).validate(backup[key]);
    if (reason) invalid.push({ section: key, reason });
    else sections.push({ section: key, incoming: summarize(key, backup[key]), current: summarize(key, byKey.get(key).load()) });
  }
  return { sections, skipped, invalid };
}

const SAFETY_COPY_PREFIX = "pre-restore-";
const SAFETY_COPIES_KEPT = 3;

// Salinan keadaan SEBELUM pemulihan, di folder data yang sama: pemulihan yang salah file bisa dibatalkan.
function writeSafetyCopy(now = new Date()) {
  const name = `${SAFETY_COPY_PREFIX}${now.toISOString().replace(/[:.]/g, "-")}.json`;
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  writeFileAtomic(path.join(CACHE_DIR, name), JSON.stringify(buildBackupSnapshot()));
  const old = fs
    .readdirSync(CACHE_DIR)
    .filter((f) => f.startsWith(SAFETY_COPY_PREFIX) && f.endsWith(".json"))
    .sort()
    .reverse()
    .slice(SAFETY_COPIES_KEPT);
  for (const f of old) {
    try {
      fs.unlinkSync(path.join(CACHE_DIR, f));
    } catch {
      // salinan lama gagal dihapus - tidak fatal
    }
  }
  return name;
}

// Tulis section yang SUDAH lolos planRestore. Salinan pengaman ditulis dulu; kalau itu gagal, pemulihan dibatalkan.
// store.save() menelan error tulis-disk (hanya mencatat log), jadi keberhasilan dicek lewat cache-nya: save yang
// sukses mengganti cache ke objek yang sama, yang gagal membiarkannya.
function applyRestore(backup, keys) {
  const safetyCopy = writeSafetyCopy();
  const byKey = new Map(SECTIONS.map((s) => [s.key, s]));
  const restored = [];
  const failed = [];
  for (const key of keys) {
    const section = byKey.get(key);
    const entry = getRegisteredStore(section.file);
    if (!entry) {
      failed.push({ section: key, reason: `store ${section.file} belum terdaftar` });
      continue;
    }
    entry.store.save(backup[key]);
    if (entry.store.load() === backup[key]) restored.push(key);
    else failed.push({ section: key, reason: "gagal menulis ke disk (lihat log server)" });
  }
  return { safetyCopy, restored, failed };
}

module.exports = { SECTIONS, buildBackupSnapshot, planRestore, applyRestore, writeSafetyCopy, SAFETY_COPY_PREFIX, SAFETY_COPIES_KEPT };
