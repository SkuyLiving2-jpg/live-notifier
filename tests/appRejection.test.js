require("./helpers/setupTestEnv");

const { test } = require("node:test");
const assert = require("node:assert/strict");

// app.js ngambil sendOwnerDM lewat destructuring pas di-require, jadi diganti DULU di modulnya.
const ownerAlert = require("../src/notify/ownerAlert");
const dms = [];
ownerAlert.sendOwnerDM = async (content) => {
  dms.push(content);
  return true;
};
const { handleUnhandledRejection } = require("../src/app");

test("unhandledRejection: dicatat + owner di-DM SEKALI per jendela cooldown, proses gak dimatiin", async () => {
  const originalError = console.error;
  const originalExit = process.exit;
  let exited = false;
  console.error = () => {};
  process.exit = () => {
    exited = true;
  };
  try {
    const t0 = 1_000_000_000_000;
    assert.equal(await handleUnhandledRejection(new Error("boom pertama"), t0), true);
    assert.equal(dms.length, 1);
    assert.match(dms[0], /boom pertama/);

    assert.equal(await handleUnhandledRejection(new Error("boom kedua"), t0 + 60_000), false, "dalam cooldown: gak DM lagi");
    assert.equal(dms.length, 1);

    assert.equal(await handleUnhandledRejection("string biasa", t0 + 11 * 60_000), true, "lewat cooldown: DM lagi, reason non-Error aman");
    assert.equal(dms.length, 2);
    assert.match(dms[1], /string biasa/);

    assert.equal(exited, false, "TIDAK boleh process.exit");
  } finally {
    console.error = originalError;
    process.exit = originalExit;
  }
});
