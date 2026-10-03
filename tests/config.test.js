require("./helpers/setupTestEnv");

const { test } = require("node:test");
const assert = require("node:assert/strict");

const CONFIG_MODULE_PATH = require.resolve("../src/config");

// config.js baca env var SEKALI doang pas pertama kali di-require (nilainya
// kecantol jadi const module-level) - buat nge-tes beberapa kombinasi env
// var, config.js harus di-require ULANG FRESH tiap kali (require.cache-nya
// dihapus dulu), sama pola freshDailyLog()/freshLiveCount() di test file
// lain. Env var yang diubah di sini dibalikin lagi abis require-nya selesai,
// biar gak nyampur ke assertion test lain di file yang sama.
function freshConfig(envOverrides) {
  const previous = {};
  for (const [key, value] of Object.entries(envOverrides)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  delete require.cache[CONFIG_MODULE_PATH];
  const config = require("../src/config");
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return config;
}

// BUG SEBELUMNYA: `Number(process.env.X) || fallback` balikin fallback
// kalau env var-nya "0" - soalnya `0 || fallback` di JS itu falsy, jadi
// dianggap "gak diisi". Ketemu gak sengaja pas nulis test fitur rekap embed
// (butuh DAILY_RECAP_HOUR=0 biar gerbang jamnya konsisten lolos apapun jam
// aslinya) - env var yang SENGAJA di-set ke 0 diem-diem ke-timpa fallback,
// bukan beneran kepake. Fixed dengan envInt() (config.js) yang bedain
// "env var gak ada/string kosong" (pakai fallback) dari "env var beneran 0"
// (pakai 0-nya, bukan fallback).
test("DAILY_RECAP_HOUR - '0' beneran jadi 0, BUKAN ketiban fallback 23 (regresi bug envInt)", () => {
  const { DAILY_RECAP_HOUR } = freshConfig({ DAILY_RECAP_HOUR: "0" });
  assert.equal(DAILY_RECAP_HOUR, 0);
});

test("DAILY_RECAP_HOUR - env var gak diset sama sekali -> fallback 23", () => {
  const { DAILY_RECAP_HOUR } = freshConfig({ DAILY_RECAP_HOUR: undefined });
  assert.equal(DAILY_RECAP_HOUR, 23);
});

test("DAILY_RECAP_HOUR - string kosong -> fallback 23 (bukan NaN/0)", () => {
  const { DAILY_RECAP_HOUR } = freshConfig({ DAILY_RECAP_HOUR: "" });
  assert.equal(DAILY_RECAP_HOUR, 23);
});

test("DAILY_RECAP_HOUR - bukan angka valid -> fallback 23, bukan NaN yang nyangkut ke perbandingan jam", () => {
  const { DAILY_RECAP_HOUR } = freshConfig({ DAILY_RECAP_HOUR: "bukan-angka" });
  assert.equal(DAILY_RECAP_HOUR, 23);
});

test("DAILY_RECAP_HOUR - angka valid biasa (mis. 20) tetep kepake apa adanya", () => {
  const { DAILY_RECAP_HOUR } = freshConfig({ DAILY_RECAP_HOUR: "20" });
  assert.equal(DAILY_RECAP_HOUR, 20);
});

test("DEFAULT_ENDING_SOON_THRESHOLD_MS - ENDING_SOON_THRESHOLD_MINUTES='0' beneran jadi 0ms, BUKAN ketiban fallback 40 menit", () => {
  const { DEFAULT_ENDING_SOON_THRESHOLD_MS } = freshConfig({ ENDING_SOON_THRESHOLD_MINUTES: "0" });
  assert.equal(DEFAULT_ENDING_SOON_THRESHOLD_MS, 0);
});

test("DEFAULT_ENDING_SOON_THRESHOLD_MS - env var gak diset -> fallback 40 menit dalam ms", () => {
  const { DEFAULT_ENDING_SOON_THRESHOLD_MS } = freshConfig({ ENDING_SOON_THRESHOLD_MINUTES: undefined });
  assert.equal(DEFAULT_ENDING_SOON_THRESHOLD_MS, 40 * 60 * 1000);
});

test("POLL_INTERVAL_MS - env var gak diset -> fallback 20 detik dalam ms (diturunin dari 30 detik)", () => {
  const { POLL_INTERVAL_MS } = freshConfig({ POLL_INTERVAL_SECONDS: undefined });
  assert.equal(POLL_INTERVAL_MS, 20 * 1000);
});

test("POLL_INTERVAL_MS - POLL_INTERVAL_SECONDS diisi angka lain (mis. 15) tetep kepake apa adanya", () => {
  const { POLL_INTERVAL_MS } = freshConfig({ POLL_INTERVAL_SECONDS: "15" });
  assert.equal(POLL_INTERVAL_MS, 15 * 1000);
});

test("POLL_INTERVAL_MS - 0/negatif/terlalu kecil dinaikkan ke batas bawah 5 detik (bukan nembak IDN tiap detik)", () => {
  for (const raw of ["0", "-10", "1"]) {
    assert.equal(freshConfig({ POLL_INTERVAL_SECONDS: raw }).POLL_INTERVAL_MS, 5000, raw);
  }
});

test("DAILY_RECAP_HOUR/SCHEDULE_DIGEST_HOUR - di luar 0-23 atau pecahan -> fallback default (24 bikin rekap gak pernah kekirim)", () => {
  for (const raw of ["24", "-1", "7.5", "99"]) {
    const config = freshConfig({ DAILY_RECAP_HOUR: raw, SCHEDULE_DIGEST_HOUR: raw });
    assert.equal(config.DAILY_RECAP_HOUR, 23, raw);
    assert.equal(config.SCHEDULE_DIGEST_HOUR, 7, raw);
  }
  assert.equal(freshConfig({ SCHEDULE_DIGEST_HOUR: "0" }).SCHEDULE_DIGEST_HOUR, 0, "0 tetap sah");
});

test("env ID/token/URL: spasi & newline di ujung (hasil paste) dibuang", () => {
  const config = freshConfig({
    PRIORITY_PING_USER_ID: " 12345\n",
    BOT_CHANNEL_ID: "  777 ",
    DISCORD_BOT_TOKEN: "tok \n",
  });
  assert.equal(config.PRIORITY_PING_USER_ID, "12345");
  assert.equal(config.BOT_CHANNEL_ID, "777");
  assert.equal(config.DISCORD_BOT_TOKEN, "tok");
});
