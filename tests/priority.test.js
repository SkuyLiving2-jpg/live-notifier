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
const { formatClockWIB } = require("../src/utils");

const FIXED_TIME = new Date("2026-09-22T08:50:00.000Z");
const FIXED_CLOCK = formatClockWIB(FIXED_TIME);

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

test("buildPriorityPayload - status end pake endMessagePool kalau ada (Nala), plain kalau enggak (Levi) - dua-duanya tetep dapet field jam selesai", () => {
  const nala = getAllPriorityMembers().find((m) => m.keyword === "nala");
  const levi = getAllPriorityMembers().find((m) => m.keyword === "levi");

  const nalaEnd = buildPriorityPayload("Nala", "https://idn.app/x", "end", nala, null, { timestamp: FIXED_TIME });
  assert.equal(nalaEnd.embeds[0].fields.length, 2, "Nala harus punya field jam selesai + field pesan perpisahan");
  assert.deepEqual(nalaEnd.embeds[0].fields[0], { name: "🕐 Selesai", value: FIXED_CLOCK, inline: true });
  assert.match(nalaEnd.embeds[0].fields[1].name, /Pesan dari/);

  const leviEnd = buildPriorityPayload("Levi", "https://idn.app/x", "end", levi, null, { timestamp: FIXED_TIME });
  assert.deepEqual(
    leviEnd.embeds[0].fields,
    [{ name: "🕐 Selesai", value: FIXED_CLOCK, inline: true }],
    "Levi gak punya endMessagePool, jadi cuma field jam selesai doang",
  );

  // description dipake APA ADANYA sama scripts/backfill-live-history.js's
  // parsePriorityEmbedEvent (nama member ditarik langsung dari situ buat
  // status "end") - harus TETAP cuma nama doang, gak boleh ketempelan teks lain.
  assert.equal(nalaEnd.embeds[0].description, "Nala");
});

test("buildPriorityPayload - status start pake startIntro/startHashtag kalau ada (Nala), plain kalau enggak (Levi), dua-duanya dapet field jam mulai", () => {
  const nala = getAllPriorityMembers().find((m) => m.keyword === "nala");
  const levi = getAllPriorityMembers().find((m) => m.keyword === "levi");

  const nalaStart = buildPriorityPayload("Nala", "https://idn.app/x", "start", nala, null, { timestamp: FIXED_TIME });
  assert.match(nalaStart.content, /^Nala, si Best Friend mu lagi Live\n/);
  assert.match(nalaStart.content, /JANGAN SAMPE KETINGGALAN/);
  assert.match(nalaStart.content, /#NaLex$/);
  assert.deepEqual(nalaStart.embeds[0].fields, [{ name: "🕐 Mulai", value: FIXED_CLOCK, inline: true }]);

  const leviStart = buildPriorityPayload("Levi", "https://idn.app/x", "start", levi, null, { timestamp: FIXED_TIME });
  assert.doesNotMatch(leviStart.content, /Best Friend/);
  assert.doesNotMatch(leviStart.content, /#NaLex/);
  assert.deepEqual(leviStart.embeds[0].fields, [{ name: "🕐 Mulai", value: FIXED_CLOCK, inline: true }]);
});

test("buildPriorityPayload - timestamp default (gak dikasih argumen) tetep aman, jatuh ke waktu sekarang", () => {
  const levi = getAllPriorityMembers().find((m) => m.keyword === "levi");
  const payload = buildPriorityPayload("Levi", "https://idn.app/x", "start", levi, null);
  assert.match(payload.embeds[0].fields[0].value, /^\d{2}\.\d{2}\.\d{2} WIB$/);
});
