require("./helpers/setupTestEnv");

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { extractWebhookIds, parseEvents, reconstructSessions } = require("../scripts/backfill-live-history");

test("extractWebhookIds - narik id & token dari DISCORD_WEBHOOK_URL, error kalau formatnya gak dikenali", () => {
  const { webhookId, webhookToken } = extractWebhookIds("https://discord.com/api/webhooks/123456789/abcDEF-token_123");
  assert.equal(webhookId, "123456789");
  assert.equal(webhookToken, "abcDEF-token_123");

  assert.throws(() => extractWebhookIds("https://discord.com/not-a-webhook-url"));
});

function fakeMessage({ webhookId = "wh-1", content, createdTimestamp }) {
  return { webhookId, content, createdTimestamp };
}

test("parseEvents - matching pesan start/end sesuai format buildNormalPayload, plus mention subscriber di ekor start", () => {
  const messages = [
    fakeMessage({
      content: "🚨 **Aralie** lagi live di IDN Live!\nNonton di sini: https://idn.app/jkt48_aralie/live/slug-123",
      createdTimestamp: 1000,
    }),
    fakeMessage({
      // start dengan tag subscriber di ekornya - harus tetep ke-parse walau ada teks tambahan
      content:
        "🚨 **Erine** lagi live di IDN Live!\nNonton di sini: https://idn.app/jkt48_erine/live/slug-456\n<@123> kamu subscribe notif buat member ini!",
      createdTimestamp: 2000,
    }),
    fakeMessage({ content: "✅ **Aralie** udah selesai live di IDN Live.", createdTimestamp: 3000 }),
  ];

  const events = parseEvents(messages, "wh-1");
  assert.equal(events.length, 3);
  assert.deepEqual(
    events.map((e) => e.type),
    ["start", "start", "end"],
  );
  assert.equal(events[1].name, "Erine");
  assert.equal(events[1].username, "jkt48_erine");
});

test("parseEvents - pesan dari webhook LAIN (mis. orang ngetik teks mirip) diabaikan", () => {
  const messages = [
    fakeMessage({
      webhookId: "wh-BEDA",
      content: "🚨 **Palsu** lagi live di IDN Live!\nNonton di sini: https://idn.app/jkt48_palsu/live/x",
      createdTimestamp: 1000,
    }),
  ];
  assert.equal(parseEvents(messages, "wh-1").length, 0);
});

test("parseEvents - pesan chat biasa (bukan format notif) diabaikan", () => {
  const messages = [fakeMessage({ content: "cok siapa yang live?", createdTimestamp: 1000 })];
  assert.equal(parseEvents(messages, "wh-1").length, 0);
});

test("reconstructSessions - pasangin start->end per nama (FIFO), termasuk 2x live berturut-turut buat member yang SAMA", () => {
  const events = [
    { type: "start", name: "Nala", username: "jkt48_nala", atMs: 1000 },
    { type: "end", name: "Nala", atMs: 2000 },
    { type: "start", name: "Nala", username: "jkt48_nala", atMs: 3000 },
    { type: "end", name: "Nala", atMs: 4000 },
  ];

  const { sessions, unmatchedStarts, unmatchedEnds } = reconstructSessions(events);
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].startedAtUnix, 1);
  assert.equal(sessions[0].endedAtUnix, 2);
  assert.equal(sessions[1].startedAtUnix, 3);
  assert.equal(sessions[1].endedAtUnix, 4);
  assert.equal(unmatchedStarts.length, 0);
  assert.equal(unmatchedEnds.length, 0);
});

test("reconstructSessions - 'start' tanpa 'end' (live yang masih jalan pas histori diambil) masuk unmatchedStarts, BUKAN dipaksa jadi sesi", () => {
  const events = [{ type: "start", name: "Levi", username: "jkt48_levi", atMs: 1000 }];
  const { sessions, unmatchedStarts } = reconstructSessions(events);
  assert.equal(sessions.length, 0);
  assert.equal(unmatchedStarts.length, 1);
  assert.equal(unmatchedStarts[0].name, "Levi");
});

test("reconstructSessions - 'end' tanpa 'start' sebelumnya masuk unmatchedEnds, BUKAN ditebak waktu mulainya", () => {
  const events = [{ type: "end", name: "Lily", atMs: 1000 }];
  const { sessions, unmatchedEnds } = reconstructSessions(events);
  assert.equal(sessions.length, 0);
  assert.equal(unmatchedEnds.length, 1);
});

test("reconstructSessions - dua member BEDA live bersamaan gak saling ketuker pasangannya", () => {
  const events = [
    { type: "start", name: "Nala", username: "jkt48_nala", atMs: 1000 },
    { type: "start", name: "Levi", username: "jkt48_levi", atMs: 1500 },
    { type: "end", name: "Levi", atMs: 2000 },
    { type: "end", name: "Nala", atMs: 2500 },
  ];

  const { sessions } = reconstructSessions(events);
  assert.equal(sessions.length, 2);
  const byName = Object.fromEntries(sessions.map((s) => [s.name, s]));
  assert.equal(byName.Nala.startedAtUnix, 1);
  assert.equal(byName.Nala.endedAtUnix, 2);
  assert.equal(byName.Levi.startedAtUnix, 1);
  assert.equal(byName.Levi.endedAtUnix, 2);
});
