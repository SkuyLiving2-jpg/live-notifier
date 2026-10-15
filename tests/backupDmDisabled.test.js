require("./helpers/setupTestEnv"); // WEEKLY_BACKUP_DM=off di sini
process.env.PRIORITY_PING_USER_ID = "999000999000999000";

const sent = [];
require("../src/discordClient").getDiscordClient = () => ({
  isReady: () => true,
  users: { fetch: async () => ({ send: async (p) => sent.push(p) }) },
});

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { maybeSendWeeklyBackup } = require("../src/notify/backupDm");

test("WEEKLY_BACKUP_DM=off -> tidak mengirim apa pun", async () => {
  assert.equal(await maybeSendWeeklyBackup(Date.now()), false);
  assert.equal(sent.length, 0);
});
