const { tempCacheDir } = require("./helpers/setupTestEnv");
// Env harus di-set SETELAH setupTestEnv dan SEBELUM config.js ke-load.
process.env.DAILY_RECAP_HOUR = "0"; // gerbang jam rekap selalu lolos
process.env.PRIORITY_PING_USER_ID = "owner-hard";
process.env.PORT = "0";
process.env.API_SECRET = "secret-audit-hardening";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createJsonStore } = require("../src/storage/jsonStore");
const { signPayload } = require("../src/security");

function tempFile(name) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hardening-")), name);
}

// ==== jsonStore: tulis atomik + salinan file rusak ====
test("jsonStore.save - lewat file sementara: gak ada sisa *.tmp, isi file valid", () => {
  const filePath = tempFile("atomic.json");
  createJsonStore(filePath, {}).save({ a: 1 });
  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, "utf-8")), { a: 1 });
  assert.equal(fs.existsSync(`${filePath}.tmp`), false);
});

test("jsonStore.load - file RUSAK: fallback ke default TAPI salinannya disimpen (*.corrupt-*), file yang belum ada gak bikin salinan", () => {
  const filePath = tempFile("bad.json");
  fs.writeFileSync(filePath, "{ setengah jadi");
  assert.deepEqual(createJsonStore(filePath, { d: true }).load(), { d: true });
  const copies = fs.readdirSync(path.dirname(filePath)).filter((f) => f.startsWith("bad.json.corrupt-"));
  assert.equal(copies.length, 1);
  assert.equal(fs.readFileSync(path.join(path.dirname(filePath), copies[0]), "utf-8"), "{ setengah jadi");

  const missing = tempFile("belum-ada.json");
  assert.deepEqual(createJsonStore(missing, []).load(), []);
  assert.equal(fs.readdirSync(path.dirname(missing)).length, 0);
});

// ==== timeout fetch ====
test("webhook & IDN: request dikirim dengan AbortSignal (timeout), gak bisa nyangkut selamanya", async () => {
  const { postToWebhook } = require("../src/notify/webhook");
  const { fetchAllLivestreams } = require("../src/idnApi");
  const signals = [];
  const original = global.fetch;
  global.fetch = async (url, options) => {
    signals.push(options?.signal);
    return { ok: true, json: async () => ({ data: { getLivestreams: [] } }) };
  };
  try {
    await postToWebhook({ content: "x" });
    await fetchAllLivestreams();
  } finally {
    global.fetch = original;
  }
  assert.equal(signals.length, 2);
  for (const signal of signals) assert.ok(signal instanceof AbortSignal);
});

// ==== rekap otomatis: gagal kirim -> dicoba lagi, bukan ditandai terkirim ====
const DAILY_LOG_FILE = path.join(tempCacheDir, "daily-log.json");
const RELOAD = ["../src/storage/dailyLog", "../src/notify/publicAlerts"].map((p) => require.resolve(p));
function freshAlerts() {
  RELOAD.forEach((p) => delete require.cache[p]);
  fs.rmSync(DAILY_LOG_FILE, { force: true });
  return { alerts: require("../src/notify/publicAlerts"), log: require("../src/storage/dailyLog") };
}

test("maybeSendDailyRecap - webhook GAGAL: recapSentDate TIDAK di-set, siklus berikutnya nyoba lagi dan berhasil (dulu rekap hari itu hilang)", async () => {
  const { alerts, log } = freshAlerts();
  const now = Date.now();
  log.recordLiveEnded("Nala", "jkt48_nala", new Date(now - 3600_000), new Date(now), 100);

  const original = global.fetch;
  const originalError = console.error;
  console.error = () => {};
  let calls = 0;
  let ok = false;
  global.fetch = async () => {
    calls += 1;
    return ok ? { ok: true, json: async () => ({}) } : { ok: false, status: 500 };
  };
  try {
    await alerts.maybeSendDailyRecap();
    assert.equal(calls, 1);
    assert.equal(log.loadDailyLog().recapSentDate, null);

    ok = true;
    await alerts.maybeSendDailyRecap();
    assert.equal(calls, 2);
    assert.ok(log.loadDailyLog().recapSentDate);

    await alerts.maybeSendDailyRecap();
    assert.equal(calls, 2, "udah kekirim, gak dobel");
  } finally {
    global.fetch = original;
    console.error = originalError;
  }
});

test("maybeSendWeeklyRecap / maybeSendMonthlyRecap - gagal kirim gak nandain terkirim", async () => {
  const { alerts, log } = freshAlerts();
  const now = Date.now();
  log.recordLiveEnded("Nala", "jkt48_nala", new Date(now - 3600_000), new Date(now), 100);
  const sunday = new Date("2026-09-27T12:00:00+07:00"); // Minggu
  const lastDay = new Date("2026-09-30T12:00:00+07:00"); // hari terakhir bulan

  const original = global.fetch;
  const originalError = console.error;
  console.error = () => {};
  global.fetch = async () => ({ ok: false, status: 500 });
  try {
    await alerts.maybeSendWeeklyRecap(sunday);
    await alerts.maybeSendMonthlyRecap(lastDay);
    const saved = log.loadDailyLog();
    assert.equal(saved.recapSentWeek, null);
    assert.equal(saved.recapSentMonth, null);
  } finally {
    global.fetch = original;
    console.error = originalError;
  }
});

// ==== arsip eksternal: cache + fallback stale ====
test("fetchExternalTodayLiveHistory - hasil di-cache sebentar (klik berulang gak nembak GitHub lagi) dan pakai data lama kalau fetch gagal", async () => {
  const { log } = freshAlerts();
  log.resetExternalHistoryCache();
  const nowSec = Math.floor(Date.now() / 1000);
  const entries = [{ username: "jkt48_cache", creator_name: "Cache", live_at_unix: nowSec }];
  let fetches = 0;
  let fail = false;
  const original = global.fetch;
  const originalNow = Date.now;
  const originalError = console.error;
  console.error = () => {};
  global.fetch = async () => {
    fetches += 1;
    if (fail) throw new Error("timeout");
    return { ok: true, json: async () => entries };
  };
  try {
    assert.equal((await log.fetchExternalTodayLiveHistory()).length, 1);
    assert.equal((await log.fetchExternalTodayLiveHistory()).length, 1);
    assert.equal(fetches, 1, "panggilan kedua dari cache");

    // 2 menit kemudian cache "basi" tapi GitHub lagi gagal -> pakai data lama, bukan null.
    const later = originalNow() + 2 * 60 * 1000;
    Date.now = () => later;
    fail = true;
    const stale = await log.fetchExternalTodayLiveHistory();
    assert.equal(fetches, 2);
    assert.equal(stale.length, 1);

    // Terlalu lama (>15 menit) -> gak dipake lagi.
    Date.now = () => originalNow() + 20 * 60 * 1000;
    assert.equal(await log.fetchExternalTodayLiveHistory(), null);
  } finally {
    Date.now = originalNow;
    global.fetch = original;
    console.error = originalError;
    log.resetExternalHistoryCache();
  }
});

// ==== router: frasa natural yang dulu salah rute ====
const { buildChatReply } = require("../src/chat/router");
const { activeLives } = require("../src/storage/activeLives");
const { recordLiveCompleted } = require("../src/storage/liveCount");
const { recordLiveDurationAt } = require("../src/storage/durationHistory");

const ask = (text) => buildChatReply(text, { isBotChannel: false, channelId: "c-hard", authorId: "u-hard" });
const textOf = (reply) => (typeof reply === "string" ? reply : reply.content || JSON.stringify(reply.embeds || ""));

test("'jadwal hari ini' - prediksi siapa yang kemungkinan live hari ini, BUKAN mencari member bernama 'hari ini'", async () => {
  const reply = await ask("cok jadwal hari ini");
  assert.doesNotMatch(textOf(reply), /belum ada riwayat live buat "hari ini"/);
  assert.match(textOf(reply), /hari (Senin|Selasa|Rabu|Kamis|Jumat|Sabtu|Minggu)/i);
});

test("'terakhir live <nama> kapan' / '<nama> terakhir live kapan' - jawab info terakhir live member, bukan 'nggak nemu member terakhir'", async () => {
  recordLiveCompleted("jkt48_terakhirx", "Terakhirx JKT48");
  const end = new Date(Date.now() - 3 * 3600_000);
  for (let i = 0; i < 3; i++) recordLiveDurationAt("jkt48_terakhirx", "Terakhirx JKT48", 40 * 60_000, new Date(end.getTime() - i * 86_400_000));
  for (const text of ["cok terakhir live terakhirx kapan", "cok terakhirx terakhir live kapan"]) {
    const reply = textOf(await ask(text));
    assert.doesNotMatch(reply, /nggak nemu/i, text);
    assert.match(reply, /Terakhirx/, text);
  }
});

test("'ada yang live ga?' - dijawab daftar yang lagi live (sama kayak 'siapa yang live'), bukan menu fallback", async () => {
  activeLives.set("jkt48_adax", {
    name: "Adax JKT48",
    username: "jkt48_adax",
    slug: "s",
    liveAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    viewCount: 5,
  });
  try {
    assert.match(textOf(await ask("cok ada yang live ga?")), /Adax/);
    assert.match(textOf(await ask("cok ada member live?")), /Adax/);
  } finally {
    activeLives.delete("jkt48_adax");
  }
});

// ==== server: body UTF-8 utuh + backup lengkap ====
const { startServer } = require("../src/server");
function listening() {
  const server = startServer();
  return new Promise((resolve) => server.on("listening", () => resolve(server)));
}
function signed(body) {
  const timestamp = Date.now().toString();
  return {
    "X-Api-Timestamp": timestamp,
    "X-Api-Signature": signPayload(process.env.API_SECRET, timestamp, body),
    "Content-Type": "application/json",
  };
}

test("POST body besar berisi karakter multi-byte (emoji/kanji) di banyak chunk: signature tetap cocok (dulu karakter yang kepotong di batas chunk bikin 401 acak)", async () => {
  const server = await listening();
  try {
    const { port } = server.address();
    const name = "アイドル🎤✨".repeat(40_000); // ~1MB, dipecah banyak chunk
    const body = JSON.stringify({ username: "jkt48_utf", name, gifters: [] });
    const res = await fetch(`http://127.0.0.1:${port}/api/gifter-snapshot`, { method: "POST", headers: signed(body), body });
    assert.equal(res.status, 200);
  } finally {
    server.close();
  }
});

test("GET /api/backup - ikut memuat liveCount, aliases, streakAlerts, memberRoles, rolePanel (dulu gak ke-backup)", async () => {
  const server = await listening();
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/api/backup`, { headers: signed("") });
    assert.equal(res.status, 200);
    const data = await res.json();
    for (const key of ["liveCount", "aliases", "streakAlerts", "memberRoles", "rolePanel"]) {
      assert.ok(key in data, `${key} harus ada di backup`);
    }
  } finally {
    server.close();
  }
});

// ==== client Discord: error event gak boleh bikin proses mati ====
test("wireDiscordEvents - listener 'error' & 'shardError' terpasang (EventEmitter 'error' tanpa listener = crash)", () => {
  const { EventEmitter } = require("node:events");
  const { wireDiscordEvents } = require("../src/chat/router");
  const fake = new EventEmitter();
  fake.login = () => Promise.resolve();
  const originalError = console.error;
  console.error = () => {};
  try {
    wireDiscordEvents(fake);
    assert.doesNotThrow(() => fake.emit("error", new Error("ws putus")));
    assert.doesNotThrow(() => fake.emit("shardError", new Error("shard putus")));
  } finally {
    console.error = originalError;
  }
});

// ==== input liar: kunci objek bawaan, panjang berlebihan ====
test("subscribe - keyword 'constructor'/'toString' gak bikin crash, '__proto__' ditolak, keyword kepanjangan ditolak (file gak bisa digembungin)", () => {
  const { addSubscription, removeSubscription, loadSubscriptions, KEYWORD_MAX_LENGTH } = require("../src/storage/subscriptions");
  assert.deepEqual(addSubscription("constructor", "u1"), { ok: true });
  assert.deepEqual(addSubscription("constructor", "u1"), { ok: false, reason: "already" });
  assert.deepEqual(removeSubscription("constructor", "u1"), { ok: true });
  assert.deepEqual(addSubscription("tostring", "u1"), { ok: true });
  assert.deepEqual(addSubscription("__proto__", "u1"), { ok: false, reason: "invalid" });
  assert.deepEqual(removeSubscription("__proto__", "u1"), { ok: false, reason: "not_found" });
  assert.deepEqual(addSubscription("a".repeat(KEYWORD_MAX_LENGTH + 1), "u1"), { ok: false, reason: "too_long" });
  assert.equal(Object.getPrototypeOf(loadSubscriptions()), Object.prototype, "prototype gak boleh berubah");
  removeSubscription("tostring", "u1");
});

test("chat 'ingetin' - pesan jelas buat nama kepanjangan/reserved (bukan diam atau 'Gagal subscribe' generik)", async () => {
  const { buildChatReply } = require("../src/chat/router");
  const ctx = { isBotChannel: true, channelId: "c-x", authorId: "u-x" };
  assert.match(await buildChatReply(`cok ingetin ${"z".repeat(60)}`, ctx), /kepanjangan/);
  assert.match(await buildChatReply("cok ingetin __proto__", ctx), /gak bisa dipakai/);
});

test("alias - kata 'constructor'/'toString' di kalimat gak ngambil fungsi bawaan Object; hapus/replace alias pakai hasOwn", () => {
  const { addAlias, removeAlias, resolveAliasInFragment } = require("../src/storage/aliases");
  assert.deepEqual(addAlias("zzalias", "nala"), { ok: true, previous: null });
  try {
    assert.equal(resolveAliasInFragment("stats constructor tostring zzalias"), "stats constructor tostring nala");
    assert.deepEqual(removeAlias("constructor"), { ok: false });
    assert.deepEqual(addAlias("constructor", "lily"), { ok: true, previous: null });
    assert.deepEqual(removeAlias("constructor"), { ok: true });
  } finally {
    removeAlias("zzalias");
  }
});

test("safeReplyOptions - content > 2000 dipotong (Discord nolak tanpa pesan), blok kode yang kepotong ditutup, yang pendek gak berubah", () => {
  const { safeReplyOptions, DISCORD_CONTENT_LIMIT } = require("../src/utils");
  assert.equal(safeReplyOptions("halo").content, "halo");
  const long = safeReplyOptions("x".repeat(5000)).content;
  assert.ok(long.length <= DISCORD_CONTENT_LIMIT);
  const code = safeReplyOptions(`\`\`\`\n${"baris\n".repeat(600)}\`\`\``).content;
  assert.ok(code.length <= DISCORD_CONTENT_LIMIT);
  assert.equal((code.match(/```/g) || []).length % 2, 0, "fence harus seimbang");
  const object = safeReplyOptions({ content: "y".repeat(3000), components: [] });
  assert.ok(object.content.length <= DISCORD_CONTENT_LIMIT);
  assert.deepEqual(object.components, []);
  assert.deepEqual(object.allowedMentions, { parse: [] });
  assert.equal(safeReplyOptions({ embeds: [] }).content, undefined);
});

test("interactionCreate - handler yang melempar error sebelum menjawab: user dapat pesan pribadi (bukan 'interaksi gagal'); interaksi kedaluwarsa (10062) dibiarkan diam", async () => {
  const { EventEmitter } = require("node:events");
  const { wireDiscordEvents } = require("../src/chat/router");
  const fake = new EventEmitter();
  fake.login = () => Promise.resolve();
  const originalError = console.error;
  console.error = () => {};
  const replies = [];
  const makeInteraction = (deferUpdate) => ({
    isChatInputCommand: () => false,
    isAutocomplete: () => false,
    isButton: () => true,
    isStringSelectMenu: () => false,
    isModalSubmit: () => false,
    isRepliable: () => true,
    customId: "reply_close",
    deferred: false,
    replied: false,
    deferUpdate,
    reply: async (payload) => replies.push(payload),
  });
  try {
    wireDiscordEvents(fake);
    const listeners = fake.listeners("interactionCreate");
    await listeners[0](makeInteraction(async () => { throw new Error("boom"); })); // prettier-ignore
    assert.equal(replies.length, 1);
    assert.match(replies[0].content, /ada error pas ngejalanin/);
    assert.equal(replies[0].flags, 64);

    await listeners[0](makeInteraction(async () => { throw Object.assign(new Error("Unknown interaction"), { code: 10062 }); })); // prettier-ignore
    assert.equal(replies.length, 1, "kedaluwarsa: gak ada yang bisa dijawab");
  } finally {
    console.error = originalError;
  }
});
