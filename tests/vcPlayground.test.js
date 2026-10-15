// Playground web "input vc" (scripts/vc-playground): Discord palsu yang menegakkan aturan Discord + server HTTP lokal.
// safeEnv.js di dalam playground yang mengosongkan env asli dan memakai folder data sementara, jadi file ini tidak perlu
// setupTestEnv - tapi playground HARUS dimuat sebelum modul src/ lain (config.js membaca env sekali).
const engine = require("../scripts/vc-playground/engine");
const { createServer, isLocalHost } = require("../scripts/vc-playground/server");
const MD = require("../scripts/vc-playground/public/markdown");

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { getTodayWIB } = require("../src/utils");
const { shiftDateWIB } = require("../src/streakMath");
const { loadVc } = require("../src/storage/vcSchedule");

const { FakeInteraction } = engine._internals;
const DATE = shiftDateWIB(getTodayWIB(), 3);
const ZOOM = "https://us02web.zoom.us/j/87197929985?pwd=abc";

beforeEach(async () => {
  await engine.reset();
  await engine.setConfig({ failDm: false, clientOff: false, idnDown: false, slow: false });
  await engine.advanceClock(0);
});

const channel = (id) => engine.getState().channels.find((c) => c.id === id);
const lastBot = (id = "dm-owner") =>
  channel(id)
    .messages.filter((m) => m.author === "bot")
    .at(-1);
const owner = (extra) => ({ channel: "dm-owner", actor: "owner", ...extra });

// ------------------------------- markdown -------------------------------

test("markdown: heading, kutipan, daftar, kode, tebal/miring, <url> menjadi tautan", () => {
  const html = MD.render(
    [
      "# Judul",
      "## Sub",
      "> kutipan **tebal**",
      "> baris dua",
      "- satu",
      "- dua",
      "```",
      "kode <b>",
      "```",
      "_miring_ dan `kode`",
      "<https://zoom.us/j/1>",
    ].join("\n"),
  );
  assert.match(html, /<h1 class="md-h md-h1">Judul<\/h1>/);
  assert.match(html, /<h2 class="md-h md-h2">Sub<\/h2>/);
  assert.match(html, /<blockquote class="md-quote">.*<strong>tebal<\/strong>.*baris dua.*<\/blockquote>/s);
  assert.match(html, /<ul class="md-list"><li>satu<\/li><li>dua<\/li><\/ul>/);
  assert.match(html, /<pre class="md-code">kode &lt;b&gt;<\/pre>/);
  assert.match(html, /<em>miring<\/em>/);
  assert.match(html, /<code class="md-inline-code">kode<\/code>/);
  assert.match(html, /<a class="md-link" href="https:\/\/zoom\.us\/j\/1"/);
});

test("markdown: escape backslash, garis bawah di dalam kata tidak jadi miring, mention jadi label", () => {
  assert.match(MD.render("\\*bukan tebal\\*"), /\*bukan tebal\*/);
  assert.doesNotMatch(MD.render("\\*bukan miring\\*"), /<em>/);
  assert.doesNotMatch(MD.render("jkt48_lily dan jkt48_levi"), /<em>/);
  assert.match(MD.render("halo <@123456>"), /md-mention/);
});

test("markdown: HTML dari teks pengguna di-escape (tidak ada XSS) dan hanya http(s) yang jadi tautan", () => {
  const html = MD.render('<script>alert(1)</script> <img src=x onerror=alert(1)> "kutip" <javascript:alert(1)> [x](javascript:alert(1))');
  assert.doesNotMatch(html, /<script|<img|href="javascript/i);
  assert.match(html, /&lt;script&gt;/);
});

// ------------------------- aturan Discord yang ditegakkan -------------------------

test("validateMessage: isi >2000, >5 baris komponen, custom_id ganda, dropdown >25 opsi, pesan kosong dilaporkan; yang wajar lolos", () => {
  const btn = (id) => ({ type: 2, style: 1, label: "x", custom_id: id });
  assert.deepEqual(engine.validateMessage({ content: "ok", components: [{ type: 1, components: [btn("a"), btn("b")] }] }), []);
  assert.match(engine.validateMessage({ content: "x".repeat(2001) }).join(), /2001 karakter/);
  assert.match(engine.validateMessage({ content: "ok", components: Array(6).fill({ type: 1, components: [btn("a")] }) }).join(), /6 baris/);
  assert.match(engine.validateMessage({ content: "ok", components: [{ type: 1, components: [btn("a"), btn("a")] }] }).join(), /custom_id ganda/);
  const options = Array.from({ length: 26 }, (_, i) => ({ label: `o${i}`, value: `v${i}` }));
  assert.match(
    engine.validateMessage({ content: "ok", components: [{ type: 1, components: [{ type: 3, custom_id: "s", options }] }] }).join(),
    /26 opsi/,
  );
  assert.match(engine.validateMessage({ content: "  " }).join(), /pesan kosong/);
  assert.match(
    engine
      .validateMessage({
        content: "ok",
        components: [{ type: 1, components: [{ type: 3, custom_id: "s", options: [{ label: "a", value: "a" }] }, btn("b")] }],
      })
      .join(),
    /dropdown tidak boleh digabung/,
  );
});

test("validateModal: judul >45, >5 isian, label >45 dilaporkan; modal wajar lolos", () => {
  const input = (label) => ({ type: 1, components: [{ type: 4, custom_id: label, label, style: 1 }] });
  assert.deepEqual(engine.validateModal({ custom_id: "m", title: "Judul", components: [input("a")] }), []);
  assert.match(engine.validateModal({ custom_id: "m", title: "x".repeat(46), components: [input("a")] }).join(), /1-45/);
  assert.match(engine.validateModal({ custom_id: "m", title: "t", components: Array(6).fill(input("a")) }).join(), /6 isian/);
  assert.match(engine.validateModal({ custom_id: "m", title: "t", components: [input("l".repeat(46))] }).join(), /label isian/);
});

test("FakeInteraction: sekali ack, editReply butuh ack, modal tidak bisa dibuka dari modal, update setelah defer ditolak", async () => {
  const fake = (kind) =>
    new FakeInteraction({
      kind,
      customId: "x",
      values: [],
      fields: {},
      actor: { id: "1" },
      channel: { id: "dm-owner", isDm: true, messages: [] },
      message: null,
      entry: { issues: [] },
    });
  await assert.rejects(() => fake("button").editReply({ content: "x" }), { code: "InteractionNotReplied" });

  const twice = fake("button");
  await twice.deferUpdate();
  await assert.rejects(() => twice.update({ content: "x" }), { code: 40060 });

  await assert.rejects(() => fake("modal").showModal({ toJSON: () => ({ custom_id: "m", title: "t", components: [] }) }), { code: 40060 });
});

// ------------------------------- alur lewat engine -------------------------------

test("engine: 'input vc' dari owner di DM -> pesan rangkuman + panel; orang lain dan channel server tidak membocorkan fitur", async () => {
  const sent = await engine.sendText(owner({ text: "input vc" }));
  assert.deepEqual(sent.issues, []);
  const bots = channel("dm-owner").messages.filter((m) => m.author === "bot");
  assert.equal(bots.length, 2);
  assert.match(bots[0].content, /^# /);
  assert.ok(bots[1].components.length >= 2, "panel tombol");

  await engine.sendText({ channel: "server", actor: "owner", text: "input vc" });
  assert.match(lastBot("server").content, /cuma bisa lewat DM/);

  await engine.sendText({ channel: "dm-other", actor: "other", text: "input vc" });
  const reply = channel("dm-other").messages.filter((m) => m.author === "bot");
  assert.ok(reply.every((m) => !/Input VC|VC Oktober|rangkuman/i.test(m.content)));
  assert.equal(loadVc().sessions.length, 0);
});

test("engine: tambah sesi lengkap lewat tombol/dropdown/form - tersimpan, pesan rangkuman DI-EDIT (id sama), tanpa pelanggaran aturan Discord", async () => {
  await engine.sendText(owner({ text: "input vc" }));
  const summaryId = channel("dm-owner").messages.find((m) => m.author === "bot").id;
  const panel = lastBot();

  const add = await engine.interact(owner({ kind: "button", customId: "vc_flow:add", messageId: panel.id }));
  assert.equal(add.modal.custom_id, "vc_modal:search");
  assert.deepEqual(add.entry.issues, []);

  await engine.interact(owner({ kind: "modal", customId: "vc_modal:search", fields: { member_query: "lily" }, messageId: panel.id }));
  assert.match(lastBot().content, /Ketemu: \*\*Lily\*\*/);
  await engine.interact(owner({ kind: "button", customId: "vc_flow:use", messageId: panel.id }));
  assert.match(lastBot().content, /Tanggal VC-nya kapan/);

  const picked = await engine.interact(owner({ kind: "select", customId: "vc_select:date", values: [DATE], messageId: panel.id }));
  assert.equal(picked.modal.custom_id, "vc_modal:form");

  const saved = await engine.interact(
    owner({
      kind: "modal",
      customId: "vc_modal:form",
      fields: { sesi: "2", buka: "12.45", mulai: "13.00", link: `${ZOOM} 388756`, tiket: "3" },
      messageId: panel.id,
    }),
  );
  assert.deepEqual(saved.entry.issues, []);
  assert.equal(saved.entry.ack, "deferUpdate");
  assert.equal(loadVc().sessions.length, 1);

  const summary = channel("dm-owner").messages.find((m) => m.id === summaryId);
  assert.ok(summary.edited, "pesan rangkuman yang sama di-edit, bukan pesan baru");
  assert.match(summary.content, /3 tiket/);
  assert.equal(engine.getState().log.filter((e) => e.issues.length > 0).length, 0);
});

test("engine: orang lain menekan tombol -> ditolak sebagai pesan ephemeral yang hanya terlihat olehnya; data tidak berubah", async () => {
  await engine.sendText(owner({ text: "input vc" }));
  const panel = lastBot();
  const result = await engine.interact({ channel: "dm-owner", actor: "other", kind: "button", customId: "vc_flow:reset", messageId: panel.id });
  assert.equal(result.ack, "reply");
  const rejection = lastBot();
  assert.equal(rejection.ephemeral, true);
  assert.equal(rejection.visibleTo, engine.OTHER_ID);
  assert.match(rejection.content, /cuma buat owner/);
});

test("engine: customId tanpa rute dilaporkan sebagai masalah (tombol mati)", async () => {
  await engine.sendText(owner({ text: "input vc" }));
  const result = await engine.interact(owner({ kind: "button", customId: "vc_tidak_ada:x", messageId: lastBot().id }));
  assert.match(result.entry.issues.join(), /Tidak ada rute/);
});

test("engine: handler yang tidak merespons dilaporkan ('Interaksi ini gagal'); handler yang melempar error dilaporkan dan pengguna dapat balasan ephemeral", async () => {
  const { INTERACTION_ROUTES } = require("../src/chat/interactionRoutes");
  const added = [
    { kind: "button", exact: "uji_tanpa_respons", handler: async () => {} },
    {
      kind: "button",
      exact: "uji_error",
      handler: async () => {
        throw new Error("meledak");
      },
    },
  ];
  INTERACTION_ROUTES.push(...added);
  try {
    await engine.sendText(owner({ text: "input vc" }));
    const panel = lastBot();

    const silent = await engine.interact(owner({ kind: "button", customId: "uji_tanpa_respons", messageId: panel.id }));
    assert.equal(silent.ack, null);
    assert.match(silent.entry.issues.join(), /Tidak ada respons sama sekali/);

    const boom = await engine.interact(owner({ kind: "button", customId: "uji_error", messageId: panel.id }));
    assert.match(boom.entry.issues.join(), /Handler melempar error: meledak/);
    assert.match(lastBot().content, /ada error pas ngejalanin itu/);
    assert.equal(lastBot().ephemeral, true);
  } finally {
    for (const route of added) INTERACTION_ROUTES.splice(INTERACTION_ROUTES.indexOf(route), 1);
  }
});

test("engine: rangkuman yang sama-sama dihapus manual dikirim ulang; Discord menolak DM -> data tersimpan + peringatan, bukan crash", async () => {
  await engine.seed({ many: false });
  const [summary] = channel("dm-owner").messages;
  await engine.deleteMessage({ channel: "dm-owner", id: summary.id });
  await engine.sendText(owner({ text: "input vc" }));
  assert.ok(
    channel("dm-owner").messages.some((m) => /^# /.test(m.content || "")),
    "rangkuman hadir lagi",
  );

  await engine.setConfig({ failDm: true });
  const originalError = console.error;
  console.error = () => {};
  try {
    const panel = lastBot();
    await engine.interact(owner({ kind: "button", customId: "vc_flow:opener", messageId: panel.id }));
  } finally {
    console.error = originalError;
  }
  assert.match(lastBot().content, /Datanya sudah tersimpan/);
});

test("engine: 'isi banyak' memecah rangkuman jadi beberapa pesan, semuanya <= 2000 karakter dan berurutan di bawah panel", async () => {
  await engine.sendText(owner({ text: "input vc" }));
  await engine.seed({ many: true });
  const messages = channel("dm-owner").messages.filter((m) => m.author === "bot");
  const summaryIds = loadVc().message.ids;
  assert.ok(summaryIds.length > 1);
  for (const m of messages) assert.ok(m.content.length <= 2000);
  assert.deepEqual(
    messages.slice(-summaryIds.length).map((m) => m.id),
    summaryIds,
  );
  assert.equal(engine.getState().log.filter((e) => e.issues.length > 0).length, 0);
});

test("engine: majukan jam 31 menit -> draft kedaluwarsa; kembalikan jam -> normal; semua jaringan diblokir dan dihitung", async () => {
  await engine.sendText(owner({ text: "input vc" }));
  const panel = lastBot();
  await engine.interact(owner({ kind: "button", customId: "vc_flow:add", messageId: panel.id }));
  await engine.interact(owner({ kind: "modal", customId: "vc_modal:search", fields: { member_query: "lily" }, messageId: panel.id }));
  await engine.interact(owner({ kind: "button", customId: "vc_flow:use", messageId: panel.id }));
  await engine.advanceClock(31);
  await engine.interact(owner({ kind: "select", customId: "vc_select:date", values: [DATE], messageId: panel.id }));
  assert.match(lastBot().content, /kelamaan/);
  assert.equal(engine.getState().config.clockOffsetMin, 31);
  await engine.advanceClock(0);
  assert.equal(engine.getState().config.clockOffsetMin, 0);

  const before = engine.getState().config.blockedFetch;
  await engine.interact(owner({ kind: "button", customId: "vc_flow:add", messageId: panel.id }));
  await engine.interact(owner({ kind: "modal", customId: "vc_modal:search", fields: { member_query: "orangtakdikenal" }, messageId: panel.id }));
  assert.equal(engine.getState().config.blockedFetch, before + 1, "pencarian ke IDN diblokir dan dijawab 'tidak ditemukan'");
  assert.match(lastBot().content, /gak nemu member/);
});

// --------------------------------- server HTTP ---------------------------------

let server;
let port;
before(async () => {
  server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = server.address().port;
});
after(() => new Promise((resolve) => server.close(resolve)));

function request(method, path, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });
}

test("server: halaman & aset statis dilayani dengan CSP; path traversal dan file tak dikenal 404", async () => {
  const index = await request("GET", "/");
  assert.equal(index.status, 200);
  assert.match(index.headers["content-type"], /text\/html/);
  assert.match(index.headers["content-security-policy"], /default-src 'self'/);
  assert.equal((await request("GET", "/app.js")).status, 200);
  assert.equal((await request("GET", "/markdown.js")).status, 200);
  assert.equal((await request("GET", "/../engine.js")).status, 404);
  assert.equal((await request("GET", "/..%2Fengine.js")).status, 404);
  assert.equal((await request("GET", "/tidak-ada.js")).status, 404);
});

test("server: Host/Origin non-localhost ditolak (anti DNS-rebinding); JSON rusak -> 400; method salah -> 405", async () => {
  assert.equal((await request("GET", "/api/state", { headers: { Host: "evil.example.com" } })).status, 403);
  assert.equal((await request("POST", "/api/send", { body: {}, headers: { Origin: "https://evil.example.com" } })).status, 403);
  assert.equal((await request("POST", "/api/send", { body: "{bukan json" })).status, 400);
  assert.equal((await request("DELETE", "/api/state")).status, 405);
  assert.equal(isLocalHost("localhost:4848"), true);
  assert.equal(isLocalHost("127.0.0.1"), true);
  assert.equal(isLocalHost("localhost.evil.com"), false);
});

test("server: /api/send menjalankan kode bot asli dan membalas state terbaru; input salah -> 400 dengan pesan", async () => {
  const ok = await request("POST", "/api/send", { body: { channel: "dm-owner", actor: "owner", text: "input vc" } });
  assert.equal(ok.status, 200);
  const data = JSON.parse(ok.text);
  assert.deepEqual(data.result.issues, []);
  assert.ok(data.state.channels[0].messages.some((m) => m.author === "bot" && m.components.length > 0));

  const bad = await request("POST", "/api/send", { body: { channel: "tidak-ada", actor: "owner", text: "x" } });
  assert.equal(bad.status, 400);
  assert.match(JSON.parse(bad.text).error, /tidak dikenal/);
  assert.equal((await request("POST", "/api/send", { body: { channel: "dm-owner", actor: "owner", text: "   " } })).status, 400);
  assert.equal((await request("POST", "/api/interact", { body: { channel: "dm-owner", actor: "owner", kind: "aneh", customId: "x" } })).status, 400);
});
