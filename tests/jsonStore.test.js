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
