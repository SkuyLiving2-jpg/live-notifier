const { tempCacheDir } = require("./helpers/setupTestEnv");
const fs = require("fs");
const path = require("path");
const { test } = require("node:test");
const assert = require("node:assert/strict");

const ALIASES_FILE = path.join(tempCacheDir, "aliases.json");
const MODULE_PATH = require.resolve("../src/storage/aliases");

// Sama alasannya kayak freshLiveCount() di tests/liveCount.test.js - modul
// ini sendiri DIJAMIN gak require modul storage/ lain (murni leaf, lihat
// komennya di aliases.js), jadi fresh-reload di sini aman dilakukan sendirian
// tanpa perlu ikut nge-reload modul lain juga.
function freshAliases() {
  delete require.cache[MODULE_PATH];
  try {
    fs.unlinkSync(ALIASES_FILE);
  } catch {
    // wajar kalau belum pernah ada file-nya
  }
  return require("../src/storage/aliases");
}

test("addAlias - nambah baru, key/target dinormalisasi (lowercase+trim)", () => {
  const { addAlias, loadAliases } = freshAliases();

  const result = addAlias("  KimKim  ", " Kimmy ");
  assert.deepEqual(result, { ok: true, previous: null });
  assert.deepEqual(loadAliases(), { kimkim: "kimmy" });
});

test("addAlias - nimpa target lama, previous dibalikin di hasilnya", () => {
  const { addAlias } = freshAliases();

  addAlias("onel", "oline");
  const result = addAlias("onel", "onigiri"); // ganti target-nya
  assert.deepEqual(result, { ok: true, previous: "oline" });
});

test("addAlias - alias/target kosong atau kependekan ditolak", () => {
  const { addAlias, loadAliases } = freshAliases();

  assert.deepEqual(addAlias("", "nala"), { ok: false, reason: "empty" });
  assert.deepEqual(addAlias("kk", ""), { ok: false, reason: "empty" });
  assert.deepEqual(addAlias("k", "nala"), { ok: false, reason: "too_short" }); // 1 huruf doang
  assert.deepEqual(loadAliases(), {}); // gak ada satupun yang ke-save
});

test("removeAlias - hapus yang ada -> ok, yang gak ada -> ok:false", () => {
  const { addAlias, removeAlias, loadAliases } = freshAliases();

  addAlias("kimkim", "kimmy");
  assert.deepEqual(removeAlias("kimkim"), { ok: true });
  assert.deepEqual(loadAliases(), {});

  assert.deepEqual(removeAlias("kimkim"), { ok: false }); // udah kehapus, coba hapus lagi
  assert.deepEqual(removeAlias("gak-pernah-ada"), { ok: false });
});

test("resolveAliasInFragment - belum ada alias sama sekali -> cuma lowercase+trim polos (fast path)", () => {
  const { resolveAliasInFragment } = freshAliases();

  assert.equal(resolveAliasInFragment("  Nala JKT48  "), "nala jkt48");
  assert.equal(resolveAliasInFragment(""), "");
  assert.equal(resolveAliasInFragment(null), "");
});

test("resolveAliasInFragment - substitusi PER KATA, kata lain di fragment yang sama gak ikut kesubstitusi", () => {
  const { addAlias, resolveAliasInFragment } = freshAliases();
  addAlias("kimkim", "kimmy");

  assert.equal(resolveAliasInFragment("kimkim"), "kimmy");
  // "jkt48" bukan alias, harus tetep apa adanya di sebelah hasil substitusi
  assert.equal(resolveAliasInFragment("kimkim jkt48"), "kimmy jkt48");
  // Case-insensitive di sisi ketikan user juga
  assert.equal(resolveAliasInFragment("KimKim"), "kimmy");
});

test("resolveAliasInFragment - fragment yang gak match alias manapun gak berubah sama sekali", () => {
  const { addAlias, resolveAliasInFragment } = freshAliases();
  addAlias("kimkim", "kimmy");

  assert.equal(resolveAliasInFragment("nala"), "nala");
  assert.equal(resolveAliasInFragment("kimkimnese"), "kimkimnese"); // bukan kata "kimkim" utuh, cuma mirip
});
