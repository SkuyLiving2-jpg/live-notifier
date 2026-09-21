require("./helpers/setupTestEnv");

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { buildNormalPayload } = require("../src/notify/liveNotify");
const { getAllPriorityMembers } = require("../src/priority");

test("buildNormalPayload - status end tetep plain, priority gak ngaruh sama sekali", () => {
  const nala = getAllPriorityMembers().find((m) => m.keyword === "nala");
  const payload = buildNormalPayload("Nala", "https://idn.app/x", "end", nala);
  assert.equal(payload.content, "✅ **Nala** udah selesai live di IDN Live.");
});

test("buildNormalPayload - status end TETEP gak ada gambar walau imageUrl dikasih (thumbnail cuma buat notif start)", () => {
  const payload = buildNormalPayload("Gabby", "https://idn.app/x", "end", null, "https://cdn.example/gabby.jpg");
  assert.equal(payload.embeds, undefined);
});

test("buildNormalPayload - status start dikasih imageUrl -> muncul embeds[0].image, content-nya TETEP sama persis (gak kesentuh)", () => {
  const payload = buildNormalPayload("Gabby", "https://idn.app/x", "start", null, "https://cdn.example/gabby.jpg");
  assert.equal(payload.content, "🚨 **Gabby** lagi live di IDN Live!\nNonton di sini: https://idn.app/x");
  assert.deepEqual(payload.embeds, [{ image: { url: "https://cdn.example/gabby.jpg" } }]);
});

test("buildNormalPayload - status start TANPA imageUrl (null, mis. IDN belum sempet generate thumbnail) gak nambahin embeds sama sekali", () => {
  const payload = buildNormalPayload("Gabby", "https://idn.app/x", "start", null, null);
  assert.equal(payload.embeds, undefined);
});

test("buildNormalPayload - status start buat member BUKAN prioritas (priority null) tetep format standar", () => {
  const payload = buildNormalPayload("Gabby", "https://idn.app/x", "start", null);
  assert.equal(payload.content, "🚨 **Gabby** lagi live di IDN Live!\nNonton di sini: https://idn.app/x");
});

// Notif CHANNEL Nala tetep plain content (bukan embed/tombol - itu cuma di
// DM, lihat priority/index.js's buildPriorityPayload) - startIntro/
// startHashtag cuma nempel di teksnya doang, struktur pesannya sama kayak
// member lain.
test("buildNormalPayload - status start buat Nala nempelin startIntro/startHashtag TAPI tetep plain content, bukan embed", () => {
  const nala = getAllPriorityMembers().find((m) => m.keyword === "nala");
  const payload = buildNormalPayload("Nala", "https://idn.app/x", "start", nala);
  assert.equal(payload.content, "Nala, si Best Friend mu lagi Live\n🚨 **Nala** lagi live di IDN Live!\nNonton di sini: https://idn.app/x #NaLex");
  assert.equal(payload.embeds, undefined, "notif channel harus tetep plain content, bukan embed");
});

test("buildNormalPayload - status start buat Levi (prioritas tapi TANPA startIntro/startHashtag) tetep format standar", () => {
  const levi = getAllPriorityMembers().find((m) => m.keyword === "levi");
  const payload = buildNormalPayload("Levi", "https://idn.app/x", "start", levi);
  assert.equal(payload.content, "🚨 **Levi** lagi live di IDN Live!\nNonton di sini: https://idn.app/x");
});
