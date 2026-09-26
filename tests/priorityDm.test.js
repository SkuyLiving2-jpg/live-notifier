require("./helpers/setupTestEnv");
// PRIORITY_PING_USER_ID di-set SEBELUM require apapun yang nembus ke
// src/notify/priorityDm.js - fungsi di situ (termasuk maybeSendHeadsUpAlerts)
// no-op total kalau ini kosong (lihat setupTestEnv.js, yang sengaja
// ngosongin ini), jadi harus di-override dulu biar beneran bisa dites.
process.env.PRIORITY_PING_USER_ID = "owner-test-priority-dm";

const fs = require("fs");
const path = require("path");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { tempCacheDir } = require("./helpers/setupTestEnv");

const DURATION_HISTORY_FILE = path.join(tempCacheDir, "live-duration-history.json");
const HEADS_UP_ALERTS_FILE = path.join(tempCacheDir, "heads-up-alerts.json");

const DISCORD_CLIENT_MODULE_PATH = require.resolve("../src/discordClient");
const PRIORITY_DM_MODULE_PATH = require.resolve("../src/notify/priorityDm");
const DURATION_HISTORY_MODULE_PATH = require.resolve("../src/storage/durationHistory");
const HEADS_UP_ALERTS_MODULE_PATH = require.resolve("../src/storage/headsUpAlerts");
const ACTIVE_LIVES_MODULE_PATH = require.resolve("../src/storage/activeLives");

// discordClient.js's getDiscordClient() balikin instance discord.js Client
// BENERAN (butuh DISCORD_BOT_TOKEN asli buat kekonstruksi) - gak mungkin/gak
// perlu dipakai di test. Sebagai gantinya, exports-nya di-PATCH langsung
// (module.exports adalah 1 objek yang sama dipegang bareng oleh siapapun
// yang require() dia) buat balikin fake client `{ users: { fetch } }` yang
// nyatet tiap DM ke `sentDMs`, BARU SETELAH itu priorityDm.js di-require
// ulang (cache-nya dihapus dulu) biar destructuring `const { getDiscordClient
// } = require("../discordClient")`-nya narik versi yang UDAH di-patch, bukan
// versi asli yang sempet ke-capture sebelumnya.
function freshPriorityDmWithFakeClient() {
  delete require.cache[DISCORD_CLIENT_MODULE_PATH];
  delete require.cache[PRIORITY_DM_MODULE_PATH];
  delete require.cache[DURATION_HISTORY_MODULE_PATH];
  delete require.cache[HEADS_UP_ALERTS_MODULE_PATH];
  delete require.cache[ACTIVE_LIVES_MODULE_PATH];
  try {
    fs.unlinkSync(DURATION_HISTORY_FILE);
  } catch {
    // wajar kalau belum pernah ada file-nya
  }
  try {
    fs.unlinkSync(HEADS_UP_ALERTS_FILE);
  } catch {
    // wajar kalau belum pernah ada file-nya
  }

  const sentDMs = [];
  const fakeClient = {
    users: {
      fetch: async () => ({
        send: async (payload) => {
          sentDMs.push(payload);
        },
      }),
    },
  };
  require("../src/discordClient").getDiscordClient = () => fakeClient;

  const { maybeSendHeadsUpAlerts } = require("../src/notify/priorityDm");
  const { saveDurationHistory } = require("../src/storage/durationHistory");
  const { activeLives } = require("../src/storage/activeLives");
  return { maybeSendHeadsUpAlerts, saveDurationHistory, activeLives, sentDMs };
}

// 5 entry, SEMUA mulai jam 12:00 WIB (bucket "siang", 11-15) - dominasi
// 100% (jauh di atas ambang 50%) dan 5 entry (pas di ambang minimal),
// rangeMin/rangeMax = 12/12.
function seedDominantSiangPattern(saveDurationHistory) {
  saveDurationHistory({
    jkt48_nala: [1, 2, 3, 4, 5].map((day) => ({
      name: "Nala",
      durationMs: 60 * 60_000,
      at: `2026-09-0${day}T13:00:00+07:00`, // mulai (at - durationMs) = 12:00
    })),
  });
}

const INSIDE_WINDOW_NOW = new Date("2026-09-20T12:30:00+07:00"); // jam 12 WIB - di dalem rentang 12-12
const OUTSIDE_WINDOW_NOW = new Date("2026-09-20T18:00:00+07:00"); // jam 18 WIB - jelas di luar

test("maybeSendHeadsUpAlerts - pola kuat + jam sekarang masuk rentang + belum live + belum di-alert hari ini -> DM kekirim", async () => {
  const { maybeSendHeadsUpAlerts, saveDurationHistory, sentDMs } = freshPriorityDmWithFakeClient();
  seedDominantSiangPattern(saveDurationHistory);

  await maybeSendHeadsUpAlerts(INSIDE_WINDOW_NOW);

  assert.equal(sentDMs.length, 1);
  assert.match(sentDMs[0].content, /NALA/);
  assert.match(sentDMs[0].content, /12-12 WIB/);
});

test("maybeSendHeadsUpAlerts - dipanggil 2x hari yang sama -> DM cuma kekirim SEKALI (dedup harian)", async () => {
  const { maybeSendHeadsUpAlerts, saveDurationHistory, sentDMs } = freshPriorityDmWithFakeClient();
  seedDominantSiangPattern(saveDurationHistory);

  await maybeSendHeadsUpAlerts(INSIDE_WINDOW_NOW);
  await maybeSendHeadsUpAlerts(new Date("2026-09-20T13:00:00+07:00")); // masih hari yang sama, masih dalem rentang
  assert.equal(sentDMs.length, 1);
});

test("maybeSendHeadsUpAlerts - member UDAH LIVE SEKARANG -> gak ngirim apa-apa, walau pola/jam-nya cocok", async () => {
  const { maybeSendHeadsUpAlerts, saveDurationHistory, activeLives, sentDMs } = freshPriorityDmWithFakeClient();
  seedDominantSiangPattern(saveDurationHistory);
  activeLives.set("jkt48_nala", { name: "Nala", username: "jkt48_nala", slug: "s", liveAt: new Date().toISOString() });

  await maybeSendHeadsUpAlerts(INSIDE_WINDOW_NOW);
  assert.equal(sentDMs.length, 0);
});

test("maybeSendHeadsUpAlerts - riwayat kurang dari 5x (di bawah ambang) -> gak ngirim, walau semuanya bucket yang sama", async () => {
  const { maybeSendHeadsUpAlerts, saveDurationHistory, sentDMs } = freshPriorityDmWithFakeClient();
  saveDurationHistory({
    jkt48_nala: [1, 2, 3].map((day) => ({ name: "Nala", durationMs: 60 * 60_000, at: `2026-09-0${day}T13:00:00+07:00` })),
  });

  await maybeSendHeadsUpAlerts(INSIDE_WINDOW_NOW);
  assert.equal(sentDMs.length, 0);
});

test("maybeSendHeadsUpAlerts - pola gak dominan (jam live-nya tersebar acak, < 50% di satu bucket) -> gak ngirim", async () => {
  const { maybeSendHeadsUpAlerts, saveDurationHistory, sentDMs } = freshPriorityDmWithFakeClient();
  saveDurationHistory({
    jkt48_nala: [
      { name: "Nala", durationMs: 60 * 60_000, at: "2026-09-01T13:00:00+07:00" }, // siang
      { name: "Nala", durationMs: 60 * 60_000, at: "2026-09-02T13:00:00+07:00" }, // siang
      { name: "Nala", durationMs: 60 * 60_000, at: "2026-09-03T23:00:00+07:00" }, // malam
      { name: "Nala", durationMs: 60 * 60_000, at: "2026-09-04T23:00:00+07:00" }, // malam
      { name: "Nala", durationMs: 60 * 60_000, at: "2026-09-05T18:30:00+07:00" }, // sore
    ],
  });

  await maybeSendHeadsUpAlerts(INSIDE_WINDOW_NOW);
  assert.equal(sentDMs.length, 0);
});

test("maybeSendHeadsUpAlerts - jam sekarang di LUAR rentang perkiraan -> gak ngirim", async () => {
  const { maybeSendHeadsUpAlerts, saveDurationHistory, sentDMs } = freshPriorityDmWithFakeClient();
  seedDominantSiangPattern(saveDurationHistory);

  await maybeSendHeadsUpAlerts(OUTSIDE_WINDOW_NOW);
  assert.equal(sentDMs.length, 0);
});
