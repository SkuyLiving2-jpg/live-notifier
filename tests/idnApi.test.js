require("./helpers/setupTestEnv");

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { isJkt48Member, fetchPublicProfileByUsername } = require("../src/idnApi");

test("isJkt48Member - username berawalan 'jkt48_' dianggep member, yang lain (walau bio-nya nyebut JKT48) enggak", () => {
  assert.equal(isJkt48Member({ username: "jkt48_nala" }), true);
  assert.equal(isJkt48Member({ username: "jkt48_NALA" }), true); // gak case-sensitive
  assert.equal(isJkt48Member({ username: "fanaccount_jkt48" }), false);
  assert.equal(isJkt48Member(null), false);
});

// fetchPublicProfileByUsername (§10's forty-second item, dasar foto profil
// buat "cok bandingin") - dites lewat global.fetch yang di-mock, BUKAN
// network beneran, sama pola-nya kayak tests/monitor.test.js/webhook.test.js.
test("fetchPublicProfileByUsername - respons sukses balikin { username, name, avatar } apa adanya", async () => {
  const original = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({
      data: { getPublicProfileByUsername: { username: "jkt48_nala", name: "Nala JKT48", avatar: "https://cdn.example/x.webp" } },
    }),
  });
  try {
    const profile = await fetchPublicProfileByUsername("jkt48_nala");
    assert.deepEqual(profile, { username: "jkt48_nala", name: "Nala JKT48", avatar: "https://cdn.example/x.webp" });
  } finally {
    global.fetch = original;
  }
});

test("fetchPublicProfileByUsername - username yang gak ketemu di IDN balikin null, bukan throw", async () => {
  const original = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ data: { getPublicProfileByUsername: null } }) });
  try {
    assert.equal(await fetchPublicProfileByUsername("jkt48_gakada"), null);
  } finally {
    global.fetch = original;
  }
});

test("fetchPublicProfileByUsername - HTTP status gagal -> throw (pemanggil yang nentuin gimana nanganinnya)", async () => {
  const original = global.fetch;
  global.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
  try {
    await assert.rejects(() => fetchPublicProfileByUsername("jkt48_nala"), /status 500/);
  } finally {
    global.fetch = original;
  }
});

test("fetchPublicProfileByUsername - GraphQL error di body -> throw juga, walau HTTP status-nya 200", async () => {
  const original = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ errors: [{ message: "boom" }] }) });
  try {
    await assert.rejects(() => fetchPublicProfileByUsername("jkt48_nala"), /GraphQL error/);
  } finally {
    global.fetch = original;
  }
});
