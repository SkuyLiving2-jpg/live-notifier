require("./helpers/setupTestEnv");

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { stopPolling } = require("../src/monitor");

// pollLoop() sendiri SENGAJA gak dites langsung di sini - checkLiveMembers()
// di dalemnya manggil fetchAllLivestreams() yang nembak API IDN BENERAN.
// Test unit gak boleh gantungin diri ke network call ke layanan pihak
// ketiga (sama alasannya kayak kenapa tests/router.test.js jauhin jalur
// "cok rekap"). Scope test ini dibatesin ke hal yang bisa diverifikasi
// tanpa itu: stopPolling() harus aman dipanggil kapan aja (termasuk
// sebelum siklus polling pernah jalan sama sekali) dan idempoten.
test("stopPolling - aman dipanggil sebelum polling pernah jalan, dan idempoten (dipanggil 2x gak error)", () => {
  assert.doesNotThrow(() => stopPolling());
  assert.doesNotThrow(() => stopPolling());
});
