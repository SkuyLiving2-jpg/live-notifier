require("./helpers/setupTestEnv");

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { GatewayIntentBits } = require("discord.js");

function freshClientModule(env) {
  const previous = {};
  for (const [key, value] of Object.entries(env)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const id of [require.resolve("../src/config"), require.resolve("../src/discordClient")]) delete require.cache[id];
  const mod = require("../src/discordClient");
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return mod;
}

test("createDiscordClient - GuildMembers (privileged) CUMA diminta kalau sambutan member baru diaktifin", () => {
  const off = freshClientModule({ DISCORD_BOT_TOKEN: "x", ROLE_WELCOME_ENABLED: undefined, ROLE_CHANNEL_ID: undefined }).createDiscordClient();
  assert.equal(off.options.intents.has(GatewayIntentBits.GuildMembers), false);
  assert.equal(off.options.intents.has(GatewayIntentBits.Guilds), true);

  const on = freshClientModule({ DISCORD_BOT_TOKEN: "x", ROLE_WELCOME_ENABLED: "true", ROLE_CHANNEL_ID: "123" }).createDiscordClient();
  assert.equal(on.options.intents.has(GatewayIntentBits.GuildMembers), true);
});
