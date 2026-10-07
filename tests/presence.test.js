require("./helpers/setupTestEnv");

// Client palsu dipasang sebelum presence.js di-require (destructuring getDiscordClient).
const discordClient = require("../src/discordClient");
const presenceCalls = [];
let fakeClient = null;
discordClient.getDiscordClient = () => fakeClient;

const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { ActivityType } = require("discord.js");
const { updateBotPresence, buildPresenceText, resetPresenceState, IDLE_TEXT } = require("../src/presence");
const { activeLives } = require("../src/storage/activeLives");

beforeEach(() => {
  presenceCalls.length = 0;
  resetPresenceState();
  activeLives.clear();
  fakeClient = { user: { setPresence: (p) => presenceCalls.push(p) } };
});

const live = (username, name, minutesAgo = 5) => ({
  name,
  username,
  slug: "s",
  liveAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
  viewCount: 1,
});

test("buildPresenceText - kosong, beberapa nama (nama depan saja), lebih dari 3 dipotong +N, dibatasi 128 karakter", () => {
  assert.equal(buildPresenceText([]), IDLE_TEXT);
  assert.equal(buildPresenceText(["Nala JKT48", "Levi | Idol"]), "🔴 Nala, Levi (live)");
  assert.equal(buildPresenceText(["A", "B", "C", "D", "E"]), "🔴 A, B, C +2 (live)");
  assert.ok(buildPresenceText(["X".repeat(300)]).length <= 128);
  assert.equal(buildPresenceText([""]), "🔴 member (live)");
});

test("updateBotPresence - kirim saat ada yang live, tidak diulang kalau sama, kirim lagi kalau berubah", async () => {
  assert.equal(await updateBotPresence(), true, "pertama kali (sepi) tetap dikirim");
  assert.equal(presenceCalls[0].activities[0].name, IDLE_TEXT);
  assert.equal(presenceCalls[0].activities[0].type, ActivityType.Watching);

  assert.equal(await updateBotPresence(), false, "sama -> tidak dikirim");
  activeLives.set("jkt48_a", live("jkt48_a", "Nala JKT48"));
  assert.equal(await updateBotPresence(), true);
  assert.equal(presenceCalls.at(-1).activities[0].name, "🔴 Nala (live)");
  assert.equal(await updateBotPresence(), false);
  activeLives.clear();
  assert.equal(await updateBotPresence(), true);
  assert.equal(presenceCalls.at(-1).activities[0].name, IDLE_TEXT);
  assert.equal(presenceCalls.length, 3);
});

test("updateBotPresence - disegarkan lagi setelah 30 menit walau teks sama", async () => {
  const t0 = 5_000_000_000_000;
  assert.equal(await updateBotPresence(t0), true);
  assert.equal(await updateBotPresence(t0 + 29 * 60_000), false);
  assert.equal(await updateBotPresence(t0 + 31 * 60_000), true);
});

test("updateBotPresence - tanpa client / client belum ready / setPresence error: false dan tidak melempar", async () => {
  fakeClient = null;
  assert.equal(await updateBotPresence(), false);
  fakeClient = { user: null };
  assert.equal(await updateBotPresence(), false);
  fakeClient = {
    user: {
      setPresence: () => {
        throw new Error("gateway putus");
      },
    },
  };
  const originalErr = console.error;
  console.error = () => {};
  try {
    assert.equal(await updateBotPresence(), false);
  } finally {
    console.error = originalErr;
  }
  fakeClient = { user: { setPresence: (p) => presenceCalls.push(p) } };
  assert.equal(await updateBotPresence(), true, "error sebelumnya tidak mengunci state: berikutnya tetap dicoba");
});
