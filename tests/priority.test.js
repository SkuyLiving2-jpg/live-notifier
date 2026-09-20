require("./helpers/setupTestEnv");
// Override abis setupTestEnv (yang sengaja ngosongin ini) - dites di sini
// biar buildPriorityPayload's mention behavior bisa diverifikasi beneran,
// pake ID palsu, bukan ID owner asli.
process.env.PRIORITY_PING_USER_ID = "999999999999999999";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  getAllPriorityMembers,
  addCustomPriorityMember,
  removeCustomPriorityMember,
  generateEndMessage,
  buildPriorityPayload,
} = require("../src/priority");

test("getAllPriorityMembers() awalnya cuma 3 yang hardcoded (Nala/Levi/Lily)", () => {
  // Test pertama di process/file ini - tempCacheDir baru dibikin fresh sama
  // setupTestEnv (lihat helpers/setupTestEnv.js), jadi custom-priority.json
  // dipastikan belum pernah ada/kebaca sama sekali di titik ini.
  const members = getAllPriorityMembers();
  assert.deepEqual(
    members.map((m) => m.keyword),
    ["nala", "levi", "lily"],
  );
});

test("addCustomPriorityMember - keyword <3 huruf ditolak", () => {
  const result = addCustomPriorityMember("ab");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "too_short");
});

test("addCustomPriorityMember - keyword yang udah dipake (termasuk 3 hardcoded) ditolak", () => {
  const result = addCustomPriorityMember("nala");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "exists");
});

test("addCustomPriorityMember - berhasil nambah, lalu bisa dihapus lagi", () => {
  const before = getAllPriorityMembers().length;

  const added = addCustomPriorityMember("Gabby"); // huruf besar, harus dinormalisasi lowercase
  assert.equal(added.ok, true);

  const afterAdd = getAllPriorityMembers();
  assert.equal(afterAdd.length, before + 1);
  const newMember = afterAdd.find((m) => m.keyword === "gabby");
  assert.ok(newMember);
  assert.equal(newMember.label, "GABBY");

  const removed = removeCustomPriorityMember("gabby");
  assert.equal(removed.ok, true);
  assert.equal(getAllPriorityMembers().length, before);
});

test("removeCustomPriorityMember - nama yang gak ada di daftar custom", () => {
  const result = removeCustomPriorityMember("member-ngasal-yang-gak-ada");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "not_found");
});

test("generateEndMessage - null kalau member gak punya endMessagePool (mis. Levi)", () => {
  const levi = getAllPriorityMembers().find((m) => m.keyword === "levi");
  assert.equal(generateEndMessage(levi), null);
});

test("generateEndMessage - Nala punya pool, hasilnya kalimat gabungan opener+body+closer", () => {
  const nala = getAllPriorityMembers().find((m) => m.keyword === "nala");
  const message = generateEndMessage(nala);
  assert.equal(typeof message, "string");
  assert.ok(message.length > 0);
  // format: "<opener>, <body>! <closer>"
  assert.match(message, /^.+, .+! .+$/);
});

test("buildPriorityPayload - includeMention:true nempelin mention, false enggak", () => {
  const nala = getAllPriorityMembers().find((m) => m.keyword === "nala");

  const withMention = buildPriorityPayload("Nala", "https://idn.app/x", "start", nala, null, { includeMention: true });
  assert.match(withMention.content, /<@999999999999999999>/);

  const withoutMention = buildPriorityPayload("Nala", "https://idn.app/x", "start", nala, null, { includeMention: false });
  assert.doesNotMatch(withoutMention.content, /<@999999999999999999>/);
});

test("buildPriorityPayload - status end pake endMessagePool kalau ada (Nala), plain kalau enggak (Levi)", () => {
  const nala = getAllPriorityMembers().find((m) => m.keyword === "nala");
  const levi = getAllPriorityMembers().find((m) => m.keyword === "levi");

  const nalaEnd = buildPriorityPayload("Nala", "https://idn.app/x", "end", nala, null);
  assert.ok(nalaEnd.embeds[0].fields, "Nala harus punya field pesan perpisahan");

  const leviEnd = buildPriorityPayload("Levi", "https://idn.app/x", "end", levi, null);
  assert.equal(leviEnd.embeds[0].fields, undefined, "Levi gak punya endMessagePool, jadi gak ada field");
});

test("buildPriorityPayload - status start pake startIntro/startHashtag kalau ada (Nala), plain kalau enggak (Levi)", () => {
  const nala = getAllPriorityMembers().find((m) => m.keyword === "nala");
  const levi = getAllPriorityMembers().find((m) => m.keyword === "levi");

  const nalaStart = buildPriorityPayload("Nala", "https://idn.app/x", "start", nala, null);
  assert.match(nalaStart.content, /^Nala, si Best Friend mu lagi Live\n/);
  assert.match(nalaStart.content, /JANGAN SAMPE KETINGGALAN/);
  assert.match(nalaStart.content, /#NaLex$/);

  const leviStart = buildPriorityPayload("Levi", "https://idn.app/x", "start", levi, null);
  assert.doesNotMatch(leviStart.content, /Best Friend/);
  assert.doesNotMatch(leviStart.content, /#NaLex/);
});
