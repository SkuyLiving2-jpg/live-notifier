require("./helpers/setupTestEnv");

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { suggestCommand, editDistance, COMMANDS } = require("../src/chat/commandSuggest");
const { buildChatReply } = require("../src/chat/router");

test("editDistance - dasar", () => {
  assert.equal(editDistance("streak", "streak"), 0);
  assert.equal(editDistance("strek", "streak"), 1);
  assert.equal(editDistance("", "abc"), 3);
  assert.equal(editDistance("kitten", "sitting"), 3);
});

test("suggestCommand - salah ketik satu/dua huruf disarankan; kata pertama saja yang dicek", () => {
  assert.match(suggestCommand("strek nala"), /cok streak <nama member>/);
  assert.match(suggestCommand("jadwall nala"), /cok jadwal/);
  assert.match(suggestCommand("kelewt"), /cok kelewat/);
  assert.match(suggestCommand("wraped"), /cok wrapped/);
  assert.match(suggestCommand("bandinginn nala lily"), /cok bandingin/);
  assert.match(suggestCommand("pengaturn"), /cok pengaturan/);
  assert.equal(suggestCommand("nala strek"), null, "kata pertama bukan perintah");
});

test("suggestCommand - tidak menyarankan: perintah sudah benar, kata pendek/umum, tidak mirip, ambigu, kosong", () => {
  assert.equal(suggestCommand("streak xyz"), null, "perintah sudah dikenal");
  assert.equal(suggestCommand("halo semuanya"), null);
  assert.equal(suggestCommand("ayu"), null, "terlalu pendek");
  assert.equal(suggestCommand("makan siang"), null);
  assert.equal(suggestCommand("statu"), null, "sama dekat ke 'stats' dan 'status' -> ambigu");
  assert.equal(suggestCommand(""), null);
  assert.equal(suggestCommand(null), null);
  assert.equal(suggestCommand("12345"), null);
});

test("suggestCommand - semua kata kunci unik dan tidak ada yang bentrok satu sama lain di jarak 1", () => {
  const keywords = COMMANDS.map((c) => c.keyword);
  assert.equal(new Set(keywords).size, keywords.length);
  for (const k of keywords) assert.equal(suggestCommand(k), null, `${k} sendiri tidak boleh disaranin`);
});

test("router - perintah salah ketik jatuh ke menu fallback DENGAN petunjuk; ketikan acak tetap menu biasa tanpa petunjuk", async () => {
  const typo = await buildChatReply("cok strek nala", { isBotChannel: true, authorId: "sug-1", channelId: "sug-c" });
  assert.match(typo.content, /Maksud kamu `cok streak <nama member>`\?/);
  assert.match(typo.content, /selamat/, "menu aslinya tetap ada di bawah petunjuk");
  assert.ok(typo.components.length > 0);

  const plain = await buildChatReply("cok halo semuanya", { isBotChannel: true, authorId: "sug-2", channelId: "sug-c" });
  assert.doesNotMatch(plain.content, /Maksud kamu/);
});
