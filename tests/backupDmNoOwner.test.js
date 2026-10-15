require("./helpers/setupTestEnv");
process.env.WEEKLY_BACKUP_DM = "on"; // dinyalakan, tapi PRIORITY_PING_USER_ID kosong (dikosongkan setupTestEnv)

const sent = [];
require("../src/discordClient").getDiscordClient = () => ({
  isReady: () => true,
  users: { fetch: async () => ({ send: async (p) => sent.push(p) }) },
});

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { maybeSendWeeklyBackup } = require("../src/notify/backupDm");

test("tanpa PRIORITY_PING_USER_ID (tidak ada tujuan DM) -> tidak mencoba apa pun", async () => {
  assert.equal(await maybeSendWeeklyBackup(Date.now()), false);
  assert.equal(sent.length, 0);
});
