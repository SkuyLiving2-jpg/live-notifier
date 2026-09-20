// jsonStore.js gak butuh setupTestEnv - dia terima filePath eksplisit,
// gak baca CACHE_DIR/config apapun. Tiap test bikin folder temp sendiri
// biar nggak numpuk/kesenggol test lain.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createJsonStore } = require("../src/storage/jsonStore");

function tempFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jsonstore-test-"));
  return path.join(dir, name);
}

test("load() balikin defaultValue kalau file belum ada", () => {
  const store = createJsonStore(tempFile("x.json"), { hello: "default" });
  assert.deepEqual(store.load(), { hello: "default" });
});

test("defaultValue boleh berupa function (lazy default)", () => {
  const store = createJsonStore(tempFile("x.json"), () => ({ n: 42 }));
  assert.deepEqual(store.load(), { n: 42 });
});

test("save() lalu load() (instance sama) balikin nilai yang baru disimpen", () => {
  const store = createJsonStore(tempFile("x.json"), []);
  store.save([1, 2, 3]);
  assert.deepEqual(store.load(), [1, 2, 3]);
});

test("save() bikin foldernya kalau belum ada (mkdir -p)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jsonstore-test-"));
  const nested = path.join(dir, "a", "b", "c", "data.json");
  const store = createJsonStore(nested, {});
  store.save({ ok: true });
  assert.ok(fs.existsSync(nested));
  assert.deepEqual(JSON.parse(fs.readFileSync(nested, "utf-8")), { ok: true });
});

test("instance BARU yang nunjuk ke file sama baca isi yang udah ke-save (persist lintas restart)", () => {
  const filePath = tempFile("shared.json");
  createJsonStore(filePath, {}).save({ persisted: true });

  const freshInstance = createJsonStore(filePath, { persisted: false });
  assert.deepEqual(freshInstance.load(), { persisted: true });
});

test("file JSON rusak -> load() fallback ke defaultValue, bukan throw", () => {
  const filePath = tempFile("corrupt.json");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "{ ini bukan json valid ");

  const store = createJsonStore(filePath, { fallback: true });
  assert.deepEqual(store.load(), { fallback: true });
});

// BUG: sebelumnya save() nge-update cache in-memory DULUAN sebelum nulis ke
// disk beneran - kalau writeFileSync gagal (disk penuh, permission, dll),
// load() berikutnya (dalam proses yang SAMA) tetep balikin value yang GAGAL
// ditulis itu, padahal file di disk masih isi yang lama. Dites dengan
// nge-mock fs.writeFileSync biar throw, tanpa beneran butuh disk penuh.
test("save() yang GAGAL nulis ke disk TIDAK ikut nge-update cache in-memory - load() abis itu masih balikin data lama", () => {
  const filePath = tempFile("writefail.json");
  const store = createJsonStore(filePath, { initial: true });
  store.save({ version: 1 });
  assert.deepEqual(store.load(), { version: 1 });

  const original = fs.writeFileSync;
  fs.writeFileSync = () => {
    throw new Error("simulasi disk penuh");
  };
  try {
    store.save({ version: 2 });
  } finally {
    fs.writeFileSync = original;
  }

  assert.deepEqual(store.load(), { version: 1 }, "cache HARUS tetap yang lama, bukan value yang gagal ditulis");
  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, "utf-8")), { version: 1 }, "file di disk juga harus tetap yang lama");
});
