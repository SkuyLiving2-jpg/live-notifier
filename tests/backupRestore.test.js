require("./helpers/setupTestEnv");
process.env.PORT = "0";
process.env.API_SECRET = "test-secret-backup-restore";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { signPayload } = require("../src/security");
const { tempCacheDir } = require("./helpers/setupTestEnv");
const { startServer } = require("../src/server");
const { SECTIONS, writeSafetyCopy, SAFETY_COPY_PREFIX, SAFETY_COPIES_KEPT, planRestore } = require("../src/backup");
const { getRegisteredStore } = require("../src/storage/jsonStore");
const { recordLiveEnded } = require("../src/storage/dailyLog");
const { recordLiveCompleted } = require("../src/storage/liveCount");
const { recordLiveDuration } = require("../src/storage/durationHistory");
const { addSubscription } = require("../src/storage/subscriptions");
const { addAlias } = require("../src/storage/aliases");
const { updateUserPrefs } = require("../src/storage/userPrefs");
const { setLastAlertedStreak } = require("../src/storage/streaks");
const { saveChannelRouting } = require("../src/storage/channelRouting");
const { saveCustomPriorityMembers } = require("../src/storage/priorityStore");
const { activeLives } = require("../src/storage/activeLives");

function startTestServer() {
  const server = startServer();
  return new Promise((resolve) => server.on("listening", () => resolve(server)));
}

function signedHeaders(body) {
  const timestamp = Date.now().toString();
  return {
    "X-Api-Timestamp": timestamp,
    "X-Api-Signature": signPayload(process.env.API_SECRET, timestamp, body),
    "Content-Type": "application/json",
  };
}

async function getBackup(port) {
  const res = await fetch(`http://127.0.0.1:${port}/api/backup`, { headers: signedHeaders("") });
  assert.equal(res.status, 200);
  return res.json();
}

async function postRestore(port, payload) {
  const body = JSON.stringify(payload);
  const res = await fetch(`http://127.0.0.1:${port}/api/restore`, { method: "POST", headers: signedHeaders(body), body });
  return { status: res.status, data: await res.json() };
}

const WEBHOOK = "https://discord.com/api/webhooks/123456789012345678/abcDEF";

function seedData() {
  const end = new Date(Date.now() - 3600_000);
  recordLiveEnded("Nala JKT48", "jkt48_nala", new Date(end.getTime() - 1800_000), end, 120);
  recordLiveCompleted("jkt48_nala", "Nala JKT48");
  recordLiveDuration("jkt48_nala", "Nala JKT48", 1800_000);
  addSubscription("nala", "111111111111111111");
  addAlias("nal", "nala");
  updateUserPrefs("111111111111111111", (p) => {
    p.delivery = "dm";
  });
  setLastAlertedStreak("jkt48_nala", 3);
  saveChannelRouting({ jkt48_nala: WEBHOOK });
  saveCustomPriorityMembers([{ keyword: "gita", label: "GITA", color: 0x9b59b6, sirens: "🚨" }]);
}

function resolveDefault(defaultValue) {
  return typeof defaultValue === "function" ? defaultValue() : structuredClone(defaultValue);
}

function wipeAll() {
  for (const section of SECTIONS) {
    const entry = getRegisteredStore(section.file);
    entry.store.save(resolveDefault(entry.defaultValue));
  }
}

const snapshotOfSections = () => Object.fromEntries(SECTIONS.map((s) => [s.key, structuredClone(s.load())]));

test("daftar SECTIONS konsisten dengan store yang ada, dan nilai KOSONG/default tiap store lolos validasinya", () => {
  for (const section of SECTIONS) {
    const entry = getRegisteredStore(section.file);
    assert.ok(entry, `${section.key}: store ${section.file} tidak terdaftar (nama file di backup.js salah / store tidak dimuat)`);
    assert.equal(
      section.validate(resolveDefault(entry.defaultValue)),
      null,
      `${section.key}: data kosong harus valid (fresh volume tetap bisa dipulihkan)`,
    );
  }
  const keys = SECTIONS.map((s) => s.key);
  assert.equal(new Set(keys).size, keys.length, "key section harus unik");
});

test("round trip: backup -> kosongkan semua -> restore (default pratinjau tidak menulis, dryRun:false memulihkan semuanya persis)", async () => {
  seedData();
  const server = await startTestServer();
  try {
    const { port } = server.address();
    const backup = await getBackup(port);
    const before = snapshotOfSections();
    assert.ok(before.dailyLog.sessions.length >= 1 && Object.keys(before.liveCount).length >= 1, "seed harus terisi");

    wipeAll();
    assert.deepEqual(snapshotOfSections().liveCount, {}, "wipe berhasil");

    // Tanpa dryRun eksplisit -> default AMAN = pratinjau, tidak ada yang ditulis.
    const preview = await postRestore(port, { backup });
    assert.equal(preview.status, 200);
    assert.equal(preview.data.dryRun, true);
    assert.ok(preview.data.sections.length > 0);
    assert.deepEqual(snapshotOfSections().liveCount, {}, "pratinjau tidak boleh mengubah data");
    assert.ok(
      preview.data.skipped.some((s) => s.section === "activeLives"),
      "activeLives dilaporkan dilewati",
    );

    const applied = await postRestore(port, { backup, dryRun: false });
    assert.equal(applied.status, 200, JSON.stringify(applied.data));
    assert.equal(applied.data.dryRun, false);
    assert.deepEqual(applied.data.failed, []);
    assert.deepEqual([...applied.data.restored].sort(), SECTIONS.map((s) => s.key).sort());
    assert.deepEqual(snapshotOfSections(), before, "semua section kembali persis seperti sebelum dikosongkan");
    assert.ok(fs.existsSync(path.join(tempCacheDir, applied.data.safetyCopy)), "salinan pengaman keadaan sebelum restore ditulis");
  } finally {
    server.close();
  }
});

test("restore - satu section salah bentuk -> 400 dan TIDAK ADA section lain yang ditulis (all-or-nothing)", async () => {
  seedData();
  const server = await startTestServer();
  try {
    const { port } = server.address();
    const backup = await getBackup(port);
    const liveCountBefore = structuredClone(getRegisteredStore("live-count.json").store.load());
    wipeAll();

    const broken = { ...backup, dailyLog: { sessions: [{ username: "x" }] } }; // sesi tanpa endedAtUnix dst
    const res = await postRestore(port, { backup: broken, dryRun: false });
    assert.equal(res.status, 400);
    assert.deepEqual(
      res.data.invalid.map((i) => i.section),
      ["dailyLog"],
    );
    assert.deepEqual(snapshotOfSections().liveCount, {}, "liveCount yang valid pun tidak boleh ikut ditulis");
    assert.notDeepEqual(liveCountBefore, {}, "sanity: seed liveCount memang ada");
  } finally {
    server.close();
  }
});

test("restore - sections yang dipilih saja yang dipulihkan; section tak dikenal / tak ada di file -> 400; tanpa signature -> 401; GET -> 405", async () => {
  seedData();
  const server = await startTestServer();
  try {
    const { port } = server.address();
    const backup = await getBackup(port);
    wipeAll();

    const only = await postRestore(port, { backup, sections: ["liveCount"], dryRun: false });
    assert.equal(only.status, 200);
    assert.deepEqual(only.data.restored, ["liveCount"]);
    assert.ok(Object.keys(snapshotOfSections().liveCount).length >= 1);
    assert.deepEqual(snapshotOfSections().subscriptions, {}, "section lain tetap kosong");

    assert.equal((await postRestore(port, { backup, sections: ["bukanSection"] })).status, 400);
    const withoutLiveCount = { ...backup };
    delete withoutLiveCount.liveCount;
    assert.equal((await postRestore(port, { backup: withoutLiveCount, sections: ["liveCount"] })).status, 400);
    assert.equal((await postRestore(port, { backup: "bukan object" })).status, 400);
    assert.equal((await postRestore(port, { backup: { exportedAt: "x", cuma: "asing" } })).status, 400, "tidak ada section yang dikenal");

    const unsigned = await fetch(`http://127.0.0.1:${port}/api/restore`, { method: "POST", body: "{}" });
    assert.equal(unsigned.status, 401);
    const getRes = await fetch(`http://127.0.0.1:${port}/api/restore`, { headers: signedHeaders("") });
    assert.equal(getRes.status, 405);
  } finally {
    server.close();
  }
});

test("restore - activeLives di file backup TIDAK PERNAH ditimpakan ke proses yang sedang berjalan", async () => {
  const server = await startTestServer();
  try {
    const { port } = server.address();
    activeLives.set("jkt48_sedanglive", { name: "Sedang", username: "jkt48_sedanglive", slug: "s", liveAt: new Date().toISOString() });
    const backup = await getBackup(port);
    activeLives.delete("jkt48_sedanglive");
    activeLives.set("jkt48_lain", { name: "Lain", username: "jkt48_lain", slug: "s2", liveAt: new Date().toISOString() });

    const res = await postRestore(port, { backup, dryRun: false });
    assert.equal(res.status, 200);
    assert.equal(activeLives.has("jkt48_sedanglive"), false);
    assert.equal(activeLives.has("jkt48_lain"), true, "state live yang sedang berjalan tidak disentuh");
    activeLives.delete("jkt48_lain");
  } finally {
    server.close();
  }
});

test("restore - tulis disk gagal TIDAK dilaporkan sukses (cache tidak berubah -> failed + status 500)", async () => {
  seedData();
  const server = await startTestServer();
  const realRename = fs.renameSync;
  const originalError = console.error;
  try {
    const { port } = server.address();
    const backup = await getBackup(port);
    wipeAll();
    console.error = () => {};
    fs.renameSync = (from, to) => {
      if (String(to).endsWith("aliases.json")) throw new Error("disk penuh (simulasi)");
      return realRename(from, to);
    };
    const res = await postRestore(port, { backup, dryRun: false });
    assert.equal(res.status, 500);
    assert.deepEqual(
      res.data.failed.map((f) => f.section),
      ["aliases"],
    );
    assert.ok(!res.data.restored.includes("aliases"));
    assert.ok(res.data.restored.includes("liveCount"), "section lain tetap dipulihkan");
  } finally {
    fs.renameSync = realRename;
    console.error = originalError;
    server.close();
  }
});

test("writeSafetyCopy - hanya SAFETY_COPIES_KEPT salinan terbaru yang disimpan", () => {
  for (let i = 0; i < SAFETY_COPIES_KEPT + 3; i++) writeSafetyCopy(new Date(Date.UTC(2030, 0, 1 + i)));
  const files = fs.readdirSync(tempCacheDir).filter((f) => f.startsWith(SAFETY_COPY_PREFIX));
  assert.ok(files.length <= SAFETY_COPIES_KEPT + 3);
  // Salinan dari test sebelumnya memakai tanggal "sekarang" (lebih awal dari 2030), jadi yang tersisa adalah 3 yang terbaru (2030).
  assert.equal(files.length, SAFETY_COPIES_KEPT);
  assert.ok(files.every((f) => f.includes("2030-01-0")));
});

test("planRestore - backup lama tanpa field baru tetap bisa dipulihkan (field opsional tidak dikunci)", () => {
  const plan = planRestore({ dailyLog: { sessions: [], recapSentDate: null } });
  assert.equal(plan.error, undefined);
  assert.deepEqual(plan.invalid, []);
  assert.deepEqual(
    plan.sections.map((s) => s.section),
    ["dailyLog"],
  );
});

// --- CLI end-to-end: scripts/restore-data.js dijalankan sebagai proses terpisah melawan server lokal ---

function runCli(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, "..", "scripts", "restore-data.js"), ...args], {
      env: { ...process.env, ...env },
      cwd: path.join(__dirname, ".."),
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out }));
  });
}

test("CLI restore-data - tanpa --apply cuma pratinjau; dengan --apply menyimpan keadaan sekarang ke komputer lokal dulu lalu memulihkan", async () => {
  seedData();
  const server = await startTestServer();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "restore-cli-"));
  try {
    const { port } = server.address();
    const backup = await getBackup(port);
    const file = path.join(workDir, "backup.json");
    fs.writeFileSync(file, JSON.stringify(backup));
    const env = { BOT_API_URL: `http://127.0.0.1:${port}`, API_SECRET: process.env.API_SECRET, RESTORE_LOCAL_COPY_DIR: path.join(workDir, "local") };
    wipeAll();

    const preview = await runCli([file], env);
    assert.equal(preview.code, 0, preview.out);
    assert.match(preview.out, /PRATINJAU/);
    assert.match(preview.out, /liveCount: sekarang 0 entri -> jadi/);
    assert.deepEqual(snapshotOfSections().liveCount, {}, "pratinjau tidak menulis");
    assert.equal(fs.existsSync(path.join(workDir, "local")), false, "pratinjau juga tidak membuat salinan lokal");

    const applied = await runCli([file, "--apply", "--sections=liveCount,subscriptions"], env);
    assert.equal(applied.code, 0, applied.out);
    assert.match(applied.out, /Dipulihkan: liveCount, subscriptions/);
    assert.ok(Object.keys(snapshotOfSections().liveCount).length >= 1);
    assert.deepEqual(snapshotOfSections().aliases, {}, "section yang tidak dipilih tetap kosong");
    const localCopies = fs.readdirSync(path.join(workDir, "local"));
    assert.equal(localCopies.length, 1);
    assert.match(localCopies[0], /^pre-restore-.*\.json$/);

    const bad = await runCli([path.join(workDir, "tidak-ada.json")], env);
    assert.equal(bad.code, 1);
    assert.match(bad.out, /Gak bisa baca/);
  } finally {
    server.close();
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

test("CLI restore-data - server menolak (mis. API_SECRET salah) -> exit 1 dan TIDAK menulis apa pun", async () => {
  seedData();
  const server = await startTestServer();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "restore-cli-"));
  try {
    const { port } = server.address();
    const backup = await getBackup(port);
    const file = path.join(workDir, "backup.json");
    fs.writeFileSync(file, JSON.stringify(backup));
    wipeAll();
    const res = await runCli([file, "--apply"], {
      BOT_API_URL: `http://127.0.0.1:${port}`,
      API_SECRET: "secret-yang-salah",
      RESTORE_LOCAL_COPY_DIR: path.join(workDir, "local"),
    });
    assert.equal(res.code, 1);
    assert.deepEqual(snapshotOfSections().liveCount, {});
  } finally {
    server.close();
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});
