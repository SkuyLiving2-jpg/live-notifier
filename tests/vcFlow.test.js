require("./helpers/setupTestEnv");
// Owner-nya di-set SESUDAH setupTestEnv (yang mengosongkannya) dan SEBELUM config.js dimuat.
const OWNER = "owner-vc-test-id";
process.env.PRIORITY_PING_USER_ID = OWNER;

// --- Discord palsu: DM channel yang mencatat pesan; dipasang sebelum vcFlow di-require ---
let dm;
let failDm = false;
function makeDm() {
  const store = new Map();
  const log = [];
  let seq = 0;
  const unknown = () => Object.assign(new Error("Unknown Message"), { code: 10008 });
  return {
    id: "dm-1",
    store,
    log,
    messages: {
      edit: async (id, payload) => {
        if (!store.has(id)) throw unknown();
        store.set(id, payload.content);
        log.push(["edit", id]);
      },
      delete: async (id) => {
        if (!store.has(id)) throw unknown();
        store.delete(id);
        log.push(["delete", id]);
      },
    },
    send: async (payload) => {
      const id = `m${++seq}`;
      store.set(id, payload.content);
      log.push(["send", id]);
      return { id };
    },
  };
}
let clientEnabled = true;
require("../src/discordClient").getDiscordClient = () =>
  clientEnabled
    ? {
        users: {
          fetch: async () => ({
            createDM: async () => {
              if (failDm) throw new Error("Cannot send messages to this user");
              return dm;
            },
          }),
        },
      }
    : null;

const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { MessageFlags } = require("discord.js");
const {
  handleVcButton,
  handleVcSelect,
  handleVcModalSubmit,
  handleVcCommand,
  syncSummary,
  resetTransientState,
  DM_ONLY_NOTE,
} = require("../src/chat/vcFlow");
const { buildChatReply } = require("../src/chat/router");
const { findInteractionRoute } = require("../src/chat/interactionRoutes");
const { loadVc, getVcSession } = require("../src/storage/vcSchedule");
const { getRegisteredStore } = require("../src/storage/jsonStore");
const { recordLiveCompleted } = require("../src/storage/liveCount");
const { getTodayWIB } = require("../src/utils");
const { shiftDateWIB } = require("../src/streakMath");
const { MESSAGE_LIMIT } = require("../src/chat/vcRender");
const { dayOfWeek } = require("../src/chat/vcSlots");
const { formatDateDisplay } = require("../src/chat/vcInput");

const IDN_NOT_FOUND = { ok: true, json: async () => ({ errors: [{ message: "IDNAccount: User Not found" }], data: null }) };
const ZOOM = "https://us02web.zoom.us/j/87197929985?pwd=abc";
// Tanggal uji HARUS punya jenis hari yang pasti (aturan sesi bergantung pada hari), apa pun hari saat test dijalankan:
// DATE = Sabtu (sesi 1-6), WEEKDAY = Senin (sesi 1-3), keduanya 2-8 hari ke depan.
function nextDow(dow) {
  for (let ahead = 2; ahead <= 8; ahead++) {
    const date = shiftDateWIB(getTodayWIB(), ahead);
    if (dayOfWeek(date) === dow) return date;
  }
  throw new Error("tidak mungkin");
}
const DATE = nextDow(6);
const WEEKDAY = nextDow(1);
// Sabtu sesi 2 = jendela buka 13.00-13.15 (vcSlots); jam mulai diisi manual.
// Satu link Zoom = satu sesi (bot menolak link yang sama di sesi lain), jadi sesi kedua dst. di test pakai link baru.
let linkSeq = 0;
const freshLink = () => `https://us02web.zoom.us/j/${87197929985 + ++linkSeq}?pwd=abc 388756`;
const GOOD_FORM = { mulai: "13.00", link: `${ZOOM} 388756`, tiket: "3" };

let realFetch;
beforeEach(() => {
  resetTransientState();
  dm = makeDm();
  failDm = false;
  clientEnabled = true;
  getRegisteredStore("vc-schedule.json").store.save({ title: null, opener: null, sessions: [], nicknames: {}, nextId: 1, message: null });
  realFetch = global.fetch;
  global.fetch = async () => IDN_NOT_FOUND; // pencarian member tidak boleh menembak IDN sungguhan
  recordLiveCompleted("jkt48_lily", "Lily JKT48");
  recordLiveCompleted("jkt48_aralie", "Aralie JKT48");
});
test.afterEach(() => {
  global.fetch = realFetch;
});

// --- interaksi palsu ---
function fake({ customId, fields = {}, values = [], authorId = OWNER, channelId = "dm-chan" } = {}) {
  const calls = { screens: [], modals: [], replies: [], deferred: 0, deleted: 0 };
  // Setiap layar yang dikirim ke Discord divalidasi: isi <= 2000 karakter dan semua komponen bisa diserialisasi (label tombol
  // <= 80, opsi dropdown <= 25, dst - discord.js melempar kalau melanggar). Pelanggaran = test gagal, bukan error di Discord.
  const record = (p) => {
    assert.ok((p.content || "").length <= 2000, `isi layar ${p.content.length} karakter`);
    for (const r of p.components || []) {
      const json = r.toJSON();
      assert.ok(json.components.length >= 1 && json.components.length <= 5);
    }
    assert.ok((p.components || []).length <= 5, "maks 5 baris komponen");
    // Discord menolak seluruh pesan kalau ada dua komponen dengan custom_id sama (error "custom_id duplicated").
    const customIds = (p.components || []).flatMap((r) => r.toJSON().components.map((c) => c.custom_id));
    assert.equal(new Set(customIds).size, customIds.length, `custom_id ganda di satu layar: ${customIds.join(", ")}`);
    calls.screens.push(p);
  };
  return {
    customId,
    channelId,
    user: { id: authorId },
    values,
    fields: {
      getTextInputValue: (id) => {
        if (!(id in fields)) throw new Error(`field "${id}" tidak dikirim`);
        return fields[id];
      },
    },
    message: { id: "panel-1", delete: async () => calls.deleted++ },
    update: async (p) => record(p),
    editReply: async (p) => record(p),
    reply: async (p) => calls.replies.push(p),
    deferUpdate: async () => calls.deferred++,
    showModal: async (m) => {
      m.toJSON(); // validasi batas Discord (judul/label/panjang) lewat builder discord.js
      calls.modals.push(m);
    },
    calls,
    get screen() {
      return calls.screens[calls.screens.length - 1];
    },
  };
}
const idsOf = (screen) => screen.components.flatMap((r) => r.components.map((c) => c.data.custom_id));
const labelsOf = (screen) => screen.components.flatMap((r) => r.components.map((c) => c.data.label).filter(Boolean));
const modalValues = (modal) => Object.fromEntries(modal.toJSON().components.map((r) => [r.components[0].custom_id, r.components[0].value]));

async function btn(customId, opts) {
  const i = fake({ customId, ...opts });
  await handleVcButton(i);
  return i;
}
async function sel(customId, values, opts) {
  const i = fake({ customId, values, ...opts });
  await handleVcSelect(i);
  return i;
}
async function mod(customId, fields, opts) {
  const i = fake({ customId, fields, ...opts });
  await handleVcModalSubmit(i);
  return i;
}

// Alur lengkap tambah sesi untuk "lily" (1 hasil pencarian): tanggal -> sesi (dropdown) -> form. Balikin interaksi form terakhir.
async function addLilySession(form = GOOD_FORM, opts = {}, sessionNo = 2, date = DATE) {
  await btn("vc_flow:add", opts);
  await mod("vc_modal:search", { member_query: "lily" }, opts);
  await btn("vc_flow:use", opts);
  await sel("vc_select:date", [date], opts);
  await sel("vc_select:session", [String(sessionNo)], opts);
  return mod("vc_modal:form", form, opts);
}

const summaryText = () => [...dm.store.values()].join("\n<<<>>>\n");

// ---------------------------------------------------------------------------
// Gerbang: hanya owner, hanya DM
// ---------------------------------------------------------------------------

test("'input vc' dari owner di DM -> panel + pesan rangkuman dikirim ke DM", async () => {
  const reply = await handleVcCommand({ rawText: "input vc", commandText: "input vc", authorId: OWNER, isDm: true });
  assert.match(reply.content, /Input VC/);
  assert.deepEqual(idsOf(reply), [
    "vc_flow:add",
    "vc_flow:edit",
    "vc_flow:title",
    "vc_flow:opener",
    "vc_flow:repost",
    "vc_flow:reset",
    "vc_flow:wipe",
    "vc_flow:close",
  ]);
  assert.equal(dm.store.size, 1, "satu pesan rangkuman");
  assert.match(summaryText(), /# 🎬 VC /);
  assert.match(summaryText(), /Belum ada sesi/);
  assert.match(reply.content, /belum ada sesi/);
});

test("panel kosong: tombol Ubah/Hapus dan Reset dinonaktifkan (tidak ada yang bisa diubah)", async () => {
  const reply = await handleVcCommand({ rawText: "input vc", commandText: "input vc", authorId: OWNER, isDm: true });
  const buttons = reply.components.flatMap((r) => r.components);
  const disabled = Object.fromEntries(buttons.map((b) => [b.data.custom_id, Boolean(b.data.disabled)]));
  assert.equal(disabled["vc_flow:edit"], true);
  assert.equal(disabled["vc_flow:reset"], true);
  assert.equal(disabled["vc_flow:add"], false);
});

test("owner di LUAR DM -> penjelasan 'cuma lewat DM', dan TIDAK ada pesan yang dikirim", async () => {
  const reply = await handleVcCommand({ rawText: "input vc", commandText: "input vc", authorId: OWNER, isDm: false });
  assert.equal(reply, DM_ONLY_NOTE);
  assert.equal(dm.store.size, 0);
  assert.equal(loadVc().sessions.length, 0);
});

test("BUKAN owner (DM maupun server) -> null: fitur seolah tidak ada, tidak ada yang dikirim", async () => {
  for (const isDm of [true, false]) {
    assert.equal(await handleVcCommand({ rawText: "input vc", commandText: "input vc", authorId: "orang-lain", isDm }), null);
    assert.equal(await handleVcCommand({ rawText: "julukan vc lily = x", commandText: "julukan vc lily = x", authorId: "orang-lain", isDm }), null);
  }
  assert.equal(dm.store.size, 0);
});

test("teks lain -> null (rute berikutnya jalan)", async () => {
  for (const text of ["halo", "rekap hari ini", "vc", "input", "input video", "cok siapa yang live"]) {
    assert.equal(await handleVcCommand({ rawText: text, commandText: text, authorId: OWNER, isDm: true }), null, text);
  }
});

test("lewat router sungguhan: owner di DM dapat panel (dengan/tanpa 'cok', huruf besar, 'inputvc'); orang lain dapat balasan biasa", async () => {
  for (const text of ["input vc", "Input VC", "cok input vc", "inputvc", "  input   vc  "]) {
    const reply = await buildChatReply(text, { isBotChannel: true, isDm: true, channelId: "dm-1", authorId: OWNER });
    assert.match(reply.content, /Input VC/, text);
  }
  const before = dm.store.size;
  const other = await buildChatReply("input vc", { isBotChannel: true, isDm: true, channelId: "dm-2", authorId: "orang-lain" });
  assert.doesNotMatch(JSON.stringify(other), /Input VC/);
  assert.equal(dm.store.size, before, "orang lain tidak memicu pesan rangkuman");

  const inServer = await buildChatReply("cok input vc", { isBotChannel: false, isDm: false, channelId: "ch-1", authorId: OWNER });
  assert.equal(inServer, DM_ONLY_NOTE);
  const noWake = await buildChatReply("input vc", { isBotChannel: false, isDm: false, channelId: "ch-1", authorId: OWNER });
  assert.equal(noWake, null, "di channel tanpa 'cok' bot tidak menjawab sama sekali");
});

test("tombol, dropdown, dan form dari BUKAN owner ditolak ephemeral dan tidak mengubah apa pun", async () => {
  const intruder = { authorId: "orang-lain" };
  const attempts = [
    await btn("vc_flow:add", intruder),
    await btn("vc_flow:close", intruder),
    await btn("vc_flow:resetok", intruder),
    await btn("vc_flow:wipe", intruder),
    await btn("vc_flow:wipeok", intruder),
    await sel("vc_select:date", [DATE], intruder),
    await mod("vc_modal:form", GOOD_FORM, intruder),
    await mod("vc_modal:title", { title: "diretas" }, intruder),
  ];
  for (const i of attempts) {
    assert.equal(i.calls.replies.length, 1);
    assert.equal(i.calls.replies[0].flags, MessageFlags.Ephemeral);
    assert.match(i.calls.replies[0].content, /cuma buat owner/);
    assert.equal(i.calls.screens.length, 0);
    assert.equal(i.calls.modals.length, 0);
    assert.equal(i.calls.deleted, 0);
  }
  assert.equal(loadVc().sessions.length, 0);
  assert.equal(loadVc().title, null);
});

test("customId vc_* terdaftar di tabel interaksi (tombol/dropdown/form) ke handler VC", () => {
  const kinds = { button: "isButton", select: "isStringSelectMenu", modal: "isModalSubmit" };
  const make = (kind, customId) => ({ customId, ...Object.fromEntries(Object.values(kinds).map((m) => [m, () => m === kinds[kind]])) });
  assert.equal(findInteractionRoute(make("button", "vc_flow:add")).handler, handleVcButton);
  assert.equal(findInteractionRoute(make("select", "vc_select:date")).handler, handleVcSelect);
  assert.equal(findInteractionRoute(make("modal", "vc_modal:form")).handler, handleVcModalSubmit);
});

// ---------------------------------------------------------------------------
// Alur tambah sesi
// ---------------------------------------------------------------------------

test("tambah sesi (member dikenal, 1 hasil): modal cari -> pakai -> dropdown tanggal 25 hari -> modal detail -> tersimpan + rangkuman ter-update", async () => {
  const add = await btn("vc_flow:add");
  assert.equal(add.calls.modals[0].toJSON().custom_id, "vc_modal:search");
  assert.equal(add.calls.screens.length, 0, "tombol yang membuka modal tidak boleh juga mengedit pesan");

  const search = await mod("vc_modal:search", { member_query: "lily" });
  assert.equal(search.calls.deferred, 1, "pencarian bisa lama - harus diakui dulu");
  assert.match(search.screen.content, /Ketemu: \*\*Lily\*\*/);
  assert.deepEqual(idsOf(search.screen).slice(0, 3), ["vc_flow:use", "vc_flow:manual", "vc_flow:add"]);

  const use = await btn("vc_flow:use");
  assert.match(use.screen.content, /Member: \*\*Lily\*\*/);
  const dateSelect = use.screen.components[0].components[0];
  assert.equal(dateSelect.data.custom_id, "vc_select:date");
  assert.equal(dateSelect.options.length, 25);
  assert.equal(dateSelect.options[0].data.value, getTodayWIB());
  assert.equal(dateSelect.options[0].data.description, "hari ini");
  assert.equal(dateSelect.options[1].data.description, "besok");
  assert.equal(dateSelect.options[24].data.value, shiftDateWIB(getTodayWIB(), 24));

  const picked = await sel("vc_select:date", [DATE]);
  assert.equal(picked.calls.modals.length, 0, "memilih tanggal membuka dropdown sesi dulu, bukan form");
  assert.match(picked.screen.content, /akhir pekan/);
  const sessionSelect = picked.screen.components[0].components[0];
  assert.equal(sessionSelect.data.custom_id, "vc_select:session");
  assert.deepEqual(
    sessionSelect.options.map((o) => o.data.label),
    [
      "Sesi 1 · Buka 11.30-11.45",
      "Sesi 2 · Buka 13.00-13.15",
      "Sesi 3 · Buka 14.30-14.45",
      "Sesi 4 · Buka 16.15-16.30",
      "Sesi 5 · Buka 17.45-18.00",
      "Sesi 6 · Buka 19.15-19.30",
    ],
  );
  assert.ok(idsOf(picked.screen).includes("vc_flow:redate"));

  const chosen = await sel("vc_select:session", ["2"]);
  const formModal = chosen.calls.modals[0].toJSON();
  assert.equal(formModal.custom_id, "vc_modal:form");
  assert.equal(formModal.title, "Sesi 2 · Buka 13.00-13.15", "judul form mengingatkan sesi + jam buka yang dipilih");
  assert.deepEqual(Object.keys(modalValues(chosen.calls.modals[0])), ["mulai", "link", "tiket"], "jam buka tidak diketik");
  assert.equal(formModal.components[0].components[0].placeholder, "12.45", "jam mulai manual: placeholder saja, tidak terisi otomatis");
  assert.equal(formModal.components[0].components[0].value, undefined);

  const form = await mod("vc_modal:form", GOOD_FORM);
  assert.match(form.screen.content, /✅ Tersimpan: \*\*Lily\*\* · Sesi 2/);
  assert.match(form.screen.content, /Buka 13\.00-13\.15 · Mulai 13\.00/);
  assert.deepEqual(idsOf(form.screen), [
    "vc_flow:same",
    "vc_flow:again",
    "vc_flow:add",
    "vc_flow:edit",
    "vc_flow:menu",
    "vc_flow:done",
    "vc_flow:close",
  ]);

  const [s] = loadVc().sessions;
  assert.deepEqual(
    {
      username: s.username,
      name: s.name,
      session: s.session,
      date: s.date,
      open: s.open,
      openEnd: s.openEnd,
      start: s.start,
      tickets: s.tickets,
      passcode: s.passcode,
      link: s.link,
    },
    {
      username: "jkt48_lily",
      name: "Lily JKT48",
      session: 2,
      date: DATE,
      open: "13:00",
      openEnd: "13:15",
      start: "13:00",
      tickets: 3,
      passcode: "388756",
      link: ZOOM,
    },
  );
  assert.ok(s.note && s.note.length > 10, "catatan absurd digenerate");

  assert.equal(dm.store.size, 1);
  const text = summaryText();
  assert.match(text, /## 1\. 🚨✨🚨 LILY 🚨✨🚨/, "Lily = prioritas -> format spesial");
  assert.match(text, /🆔 871 9792 9985 · 🔑 388756/, "ID Zoom otomatis dari link");
  assert.match(text, /🎟️ \*\*3 tiket\*\*/);
  assert.match(text, /🕐 Buka \*\*13\.00-13\.15\*\* · ▶️ Mulai \*\*13\.00\*\*/, "jendela jam buka tampil sebagai rentang");
  assert.match(text, new RegExp(s.note.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "catatan yang tersimpan = yang tampil");
});

test("member tidak dikenal: pencarian kosong -> pakai nama apa adanya -> tersimpan tanpa username, format polos", async () => {
  await btn("vc_flow:add");
  const search = await mod("vc_modal:search", { member_query: "Zzqx Lepi" });
  assert.match(search.screen.content, /gak nemu member/);
  assert.ok(idsOf(search.screen).includes("vc_flow:manual"));
  assert.ok(labelsOf(search.screen).some((l) => l.includes("Zzqx Lepi")));

  await btn("vc_flow:manual");
  await sel("vc_select:date", [DATE]);
  await sel("vc_select:session", ["2"]);
  const form = await mod("vc_modal:form", { ...GOOD_FORM, link: freshLink(), tiket: "" });
  assert.match(form.screen.content, /Tersimpan/);

  const [s] = loadVc().sessions;
  assert.equal(s.username, null);
  assert.equal(s.name, "Zzqx Lepi");
  assert.equal(s.tickets, null);
  assert.match(summaryText(), /\*\*1\. Zzqx Lepi\*\*/);
  assert.doesNotMatch(summaryText(), /^## /m);
});

test("pencarian dengan banyak hasil: dropdown berisi semua + opsi 'pakai apa adanya'; memilih satu lanjut ke tanggal", async () => {
  recordLiveCompleted("jkt48_nadia", "Nadia JKT48");
  recordLiveCompleted("jkt48_nadine", "Nadine JKT48");
  await btn("vc_flow:add");
  const search = await mod("vc_modal:search", { member_query: "nad" });
  const select = search.screen.components[0].components[0];
  assert.equal(select.data.custom_id, "vc_select:member");
  const values = select.options.map((o) => o.data.value);
  assert.deepEqual(values.sort(), ["__manual__", "jkt48_nadia", "jkt48_nadine"].sort());

  const picked = await sel("vc_select:member", ["jkt48_nadine"]);
  assert.match(picked.screen.content, /Member: \*\*Nadine\*\*/);
});

test("pencarian: member dari IDN yang belum pernah live (neverLive) tetap bisa dipilih", async () => {
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ data: { getPublicProfileByUsername: { username: "jkt48_kimmy", name: "Kimmy JKT48", avatar: "x" } } }),
  });
  await btn("vc_flow:add");
  const search = await mod("vc_modal:search", { member_query: "kimmy" });
  assert.match(search.screen.content, /Ketemu: \*\*Kimmy\*\* \(belum pernah live/);
  await btn("vc_flow:use");
  await sel("vc_select:date", [DATE]);
  await sel("vc_select:session", ["2"]);
  await mod("vc_modal:form", GOOD_FORM);
  assert.equal(loadVc().sessions[0].username, "jkt48_kimmy");
});

test("pencarian: IDN error -> tetap ada opsi pakai nama apa adanya (tidak buntu)", async () => {
  global.fetch = async () => {
    throw new Error("IDN down");
  };
  await btn("vc_flow:add");
  const search = await mod("vc_modal:search", { member_query: "sesuatu" });
  assert.match(search.screen.content, /IDN lagi gak bisa dicek/);
  assert.ok(idsOf(search.screen).includes("vc_flow:manual"));
});

test("tanggal lain (ketik): valid -> dropdown sesi; tidak valid -> pesan + coba lagi; sesi yang dipilih dari situ tetap menyimpan tanggalnya", async () => {
  await btn("vc_flow:add");
  await mod("vc_modal:search", { member_query: "lily" });
  await btn("vc_flow:use");
  const other = await btn("vc_flow:date_other");
  assert.equal(other.calls.modals[0].toJSON().custom_id, "vc_modal:datetext");

  const bad = await mod("vc_modal:datetext", { date_text: "31 februari" });
  assert.match(bad.screen.content, /gak ada di kalender/);
  assert.ok(idsOf(bad.screen).includes("vc_flow:date_other"));

  const premature = await btn("vc_flow:form");
  assert.match(premature.screen.content, /kelamaan\/ke-reset/, "form tidak bisa dibuka sebelum sesi dipilih");

  const good = await mod("vc_modal:datetext", { date_text: DATE });
  assert.match(good.screen.content, /Tanggal: \*\*/);
  assert.equal(good.screen.components[0].components[0].data.custom_id, "vc_select:session");
  const chosen = await sel("vc_select:session", ["2"]);
  assert.equal(chosen.calls.modals[0].toJSON().custom_id, "vc_modal:form");

  await mod("vc_modal:form", GOOD_FORM);
  assert.equal(loadVc().sessions[0].date, DATE);
});

test("dropdown sesi mengikuti hari: Senin-Jumat cuma sesi 1-3 (jendela buka 16.15/17.45/19.15), Sabtu-Minggu sesi 1-6", async () => {
  await btn("vc_flow:add");
  await mod("vc_modal:search", { member_query: "lily" });
  await btn("vc_flow:use");

  const weekday = await sel("vc_select:date", [WEEKDAY]);
  assert.match(weekday.screen.content, /hari kerja/);
  assert.deepEqual(
    weekday.screen.components[0].components[0].options.map((o) => o.data.label),
    ["Sesi 1 · Buka 16.15-16.30", "Sesi 2 · Buka 17.45-18.00", "Sesi 3 · Buka 19.15-19.30"],
  );

  // sesi 4-6 TIDAK ADA di hari kerja walau value-nya dikirim paksa (mis. dari layar lama): ditolak, tidak membuka form
  const forced = await sel("vc_select:session", ["4"]);
  assert.equal(forced.calls.modals.length, 0);
  assert.match(forced.screen.content, /Sesi 4 gak ada di hari Senin/);
  assert.equal(forced.screen.components[0].components[0].options.length, 3);

  const sunday = shiftDateWIB(DATE, 1);
  assert.equal(dayOfWeek(sunday), 0);
  const weekend = await sel("vc_select:date", [sunday]);
  assert.equal(weekend.screen.components[0].components[0].options.length, 6);
});

test("sesi dipilih -> jam buka mengikuti sesi (hari kerja sesi 3 = 19.15-19.30; Sabtu sesi 6 = sama dengan sesi 3 hari kerja)", async () => {
  await addLilySession({ ...GOOD_FORM, link: freshLink(), mulai: "19.15" }, {}, 3, WEEKDAY);
  await addLilySession({ ...GOOD_FORM, link: freshLink(), mulai: "19.15" }, {}, 6, DATE);
  const [weekday, weekend] = loadVc().sessions;
  assert.deepEqual([weekday.session, weekday.open, weekday.openEnd], [3, "19:15", "19:30"]);
  assert.deepEqual([weekend.session, weekend.open, weekend.openEnd], [6, "19:15", "19:30"]);
});

test("jam mulai harus 15 menit sebelum jam buka sampai jam buka: di luar rentang (terlalu awal / setelah buka) ditolak, batas tepat boleh", async () => {
  await btn("vc_flow:add");
  await mod("vc_modal:search", { member_query: "lily" });
  await btn("vc_flow:use");
  await sel("vc_select:date", [DATE]);
  const picked = await sel("vc_select:session", ["2"]); // buka 13.00-13.15 -> mulai 12.45-13.00
  const label = picked.calls.modals[0].toJSON().components[0].components[0].label;
  assert.equal(label, "Jam MULAI (12.45-13.00)", "rentang yang sah tertulis di form");

  const reject = async (mulai) => {
    const result = await mod("vc_modal:form", { ...GOOD_FORM, link: freshLink(), mulai });
    assert.match(result.screen.content, /Jam mulai \S+ di luar aturan sesi 2: harus 12\.45-13\.00/, mulai);
    assert.equal(loadVc().sessions.length, 0, `${mulai} tidak boleh tersimpan`);
  };
  await reject("12.44"); // semenit terlalu awal
  await reject("13.01"); // semenit setelah jam buka
  await reject("13.15"); // = ujung jendela buka (ini jam BUKA, bukan jam mulai)
  await reject("16.15");

  const edge = await mod("vc_modal:form", { ...GOOD_FORM, link: freshLink(), mulai: "12.45" });
  assert.match(edge.screen.content, /Tersimpan/);
  assert.equal(loadVc().sessions[0].start, "12:45");
  assert.match(edge.screen.content, /Buka 13.00-13.15 · Mulai 12.45/);
});

test("rentang jam mulai tiap sesi weekday & weekend = 15 menit sebelum jam buka sampai jam buka", async () => {
  const expected = {
    [WEEKDAY]: { 1: "16.00-16.15", 2: "17.30-17.45", 3: "19.00-19.15" },
    [DATE]: { 1: "11.15-11.30", 2: "12.45-13.00", 3: "14.15-14.30", 4: "16.00-16.15", 5: "17.30-17.45", 6: "19.00-19.15" },
  };
  for (const [date, bySession] of Object.entries(expected)) {
    for (const [no, range] of Object.entries(bySession)) {
      await btn("vc_flow:add");
      await mod("vc_modal:search", { member_query: "aralie" });
      await btn("vc_flow:use");
      await sel("vc_select:date", [date]);
      const picked = await sel("vc_select:session", [no]);
      assert.equal(picked.calls.modals[0].toJSON().components[0].components[0].label, `Jam MULAI (${range})`, `${date} sesi ${no}`);
      assert.equal(picked.calls.modals[0].toJSON().components[0].components[0].placeholder, range.slice(0, 5), "placeholder = awal rentang (contoh)");
    }
  }
});

test("'Ganti tanggal' di dropdown sesi kembali ke pilihan tanggal dan membuang sesi/isian lama", async () => {
  await btn("vc_flow:add");
  await mod("vc_modal:search", { member_query: "lily" });
  await btn("vc_flow:use");
  await sel("vc_select:date", [DATE]);
  const back = await btn("vc_flow:redate");
  assert.equal(back.screen.components[0].components[0].data.custom_id, "vc_select:date");
  const staleSession = await sel("vc_select:session", ["2"]);
  assert.match(staleSession.screen.content, /kelamaan\/ke-reset/, "tanggal belum dipilih ulang -> sesi lama tidak berlaku");
});

test("form salah isi: SEMUA kesalahan ditampilkan, tidak ada yang tersimpan, 'Perbaiki' membuka form dengan isian terakhir (tidak mengetik dari nol)", async () => {
  await btn("vc_flow:add");
  await mod("vc_modal:search", { member_query: "lily" });
  await btn("vc_flow:use");
  await sel("vc_select:date", [DATE]);
  await sel("vc_select:session", ["2"]);

  const bad = await mod("vc_modal:form", { mulai: "25.00", link: "bukan link", tiket: "x" });
  assert.match(bad.screen.content, /Ada yang belum bener/);
  assert.equal((bad.screen.content.match(/^• /gm) || []).length, 3, "mulai, link, dan tiket");
  assert.deepEqual(idsOf(bad.screen), ["vc_flow:form", "vc_flow:menu", "vc_flow:close"]);
  assert.equal(loadVc().sessions.length, 0);
  assert.equal(dm.store.size, 0, "tidak ada pesan rangkuman untuk input yang gagal");

  const retry = await btn("vc_flow:form");
  assert.deepEqual(modalValues(retry.calls.modals[0]), { mulai: "25.00", link: "bukan link", tiket: "x" });
  assert.equal(retry.calls.modals[0].toJSON().title, "Sesi 2 · Buka 13.00-13.15", "form perbaikan tetap untuk sesi yang sama");

  const fixed = await mod("vc_modal:form", GOOD_FORM);
  assert.match(fixed.screen.content, /Tersimpan/);
  assert.equal(loadVc().sessions.length, 1);
});

test("sesi yang sama (member + tanggal + nomor sesi) ditolak sebagai duplikat; nomor sesi lain boleh", async () => {
  await addLilySession();
  assert.equal(loadVc().sessions.length, 1);

  // "Sesi lagi": member + tanggal tetap, langsung ke dropdown sesi; sesi yang sudah ada ditandai di dropdown
  const again = await btn("vc_flow:again");
  assert.equal(again.screen.components[0].components[0].data.custom_id, "vc_select:session");
  assert.match(again.screen.content, new RegExp(formatDateDisplay(DATE)));
  const options = again.screen.components[0].components[0].options;
  assert.match(options[1].data.description, /Sudah ada/);
  assert.equal(options[2].data.description, undefined);

  await sel("vc_select:session", ["2"]);
  const dup = await mod("vc_modal:form", GOOD_FORM);
  assert.match(dup.screen.content, /udah ada/);
  assert.equal(loadVc().sessions.length, 1);

  await btn("vc_flow:again");
  await sel("vc_select:session", ["3"]); // Sabtu sesi 3 = buka 14.30-14.45
  const other = await mod("vc_modal:form", { ...GOOD_FORM, link: freshLink(), mulai: "14.30" });
  assert.match(other.screen.content, /Tersimpan/);
  assert.equal(loadVc().sessions.length, 2);
  assert.equal((summaryText().match(/^## /gm) || []).length, 1, "dua sesi Lily tetap SATU judul");
});

test("draft hilang (kelamaan/bot restart) -> layar 'ke-reset', tidak ada yang tersimpan", async () => {
  const opts = { channelId: "dm-tidak-ada-draft" };
  const form = await mod("vc_modal:form", GOOD_FORM, opts);
  assert.match(form.screen.content, /kelamaan\/ke-reset/);
  const use = await btn("vc_flow:use", opts);
  assert.match(use.screen.content, /kelamaan\/ke-reset/);
  const date = await sel("vc_select:date", [DATE], opts);
  assert.match(date.screen.content, /kelamaan\/ke-reset/);
  const session = await sel("vc_select:session", ["2"], opts);
  assert.match(session.screen.content, /kelamaan\/ke-reset/);
  const retry = await btn("vc_flow:form", opts);
  assert.match(retry.screen.content, /kelamaan\/ke-reset/);
  const again = await btn("vc_flow:again", opts);
  assert.match(again.screen.content, /kelamaan\/ke-reset/);
  const manual = await btn("vc_flow:manual", opts);
  assert.match(manual.screen.content, /kelamaan\/ke-reset/);
  assert.equal(loadVc().sessions.length, 0);
});

test("'Tutup' menghapus pesan wizard; 'Menu' kembali ke panel dan membuang draft", async () => {
  await btn("vc_flow:add", { channelId: "dm-nav" });
  const menu = await btn("vc_flow:menu", { channelId: "dm-nav" });
  assert.match(menu.screen.content, /Input VC/);
  const stale = await btn("vc_flow:use", { channelId: "dm-nav" });
  assert.match(stale.screen.content, /kelamaan\/ke-reset/, "draft sudah dibuang oleh Menu");

  const close = await btn("vc_flow:close", { channelId: "dm-nav" });
  assert.equal(close.calls.deleted, 1);
  assert.equal(close.calls.deferred, 1);
});

test("'Tutup' sebelum ada sesi tersimpan menghapus pesan rangkuman (judul + pembuka) juga", async () => {
  await handleVcCommand({ rawText: "input vc", commandText: "input vc", authorId: OWNER, isDm: true });
  assert.equal(dm.store.size, 1, "rangkuman berisi judul dibuat otomatis");
  await btn("vc_flow:add"); // mulai mengisi tapi belum ada yang tersimpan

  const close = await btn("vc_flow:close");
  assert.equal(close.calls.deleted, 1, "panel dihapus");
  assert.equal(dm.store.size, 0, "pesan rangkuman ikut hilang, tidak ada sisa judul di DM");
  assert.equal(loadVc().message, null, "referensi pesan dibuang supaya 'input vc' berikutnya membuat pesan baru");

  await handleVcCommand({ rawText: "input vc", commandText: "input vc", authorId: OWNER, isDm: true });
  assert.equal(dm.store.size, 1, "'input vc' lagi membuat rangkuman baru");
});

test("'Tutup' di tengah pengisian tapi belum disimpan: tidak ada sesi, rangkuman kosong ikut dihapus", async () => {
  await handleVcCommand({ rawText: "input vc", commandText: "input vc", authorId: OWNER, isDm: true });
  await btn("vc_flow:add");
  await mod("vc_modal:search", { member_query: "lily" });
  await btn("vc_flow:use");
  await sel("vc_select:date", [DATE]);
  await sel("vc_select:session", ["2"]);
  await btn("vc_flow:close"); // form sudah terbuka, tapi belum di-submit
  assert.equal(loadVc().sessions.length, 0);
  assert.equal(dm.store.size, 0);
});

// --- Tutup = batal untuk sesi baru yang belum "Selesai"; Selesai = simpan ---

const labelOf = (screen, customId) => screen.components.flatMap((r) => r.components).find((c) => c.data.custom_id === customId)?.data.label;

test("'Tutup' setelah membuat sesi (belum Selesai): sesi dibuang, rangkuman kosong ikut dihapus dari DM", async () => {
  await handleVcCommand({ rawText: "input vc", commandText: "input vc", authorId: OWNER, isDm: true });
  const saved = await addLilySession();
  assert.match(saved.screen.content, /Tersimpan/);
  assert.match(saved.screen.content, /1 sesi baru belum diselesaikan/);
  assert.equal(labelOf(saved.screen, "vc_flow:close"), "✖ Tutup & buang 1 sesi baru", "labelnya jujur soal efeknya");
  assert.equal(labelOf(saved.screen, "vc_flow:done"), "✅ Selesai");
  assert.equal(loadVc().sessions.length, 1);
  assert.equal(dm.store.size, 1);

  const close = await btn("vc_flow:close");
  assert.equal(close.calls.deleted, 1, "panel dihapus");
  assert.equal(loadVc().sessions.length, 0, "sesinya ikut dibuang");
  assert.equal(dm.store.size, 0, "judul + info sesi di DM hilang semua");
  assert.equal(loadVc().message, null);
});

test("'Tutup' membuang SEMUA sesi baru dari sitting ini (beberapa member), tapi sesi lama yang sudah Selesai tetap", async () => {
  recordLiveCompleted("jkt48_nala", "Nala JKT48");
  await handleVcCommand({ rawText: "input vc", commandText: "input vc", authorId: OWNER, isDm: true });
  await addLilySession(); // sitting 1: Lily
  await btn("vc_flow:done");
  assert.equal(loadVc().sessions.length, 1);

  // sitting 2: Aralie + Nala (Member lain, sesi sama), lalu batal
  await btn("vc_flow:add");
  await mod("vc_modal:search", { member_query: "aralie" });
  await btn("vc_flow:use");
  await sel("vc_select:date", [DATE]);
  await sel("vc_select:session", ["2"]);
  await mod("vc_modal:form", { ...GOOD_FORM, link: freshLink() });
  await btn("vc_flow:same");
  await mod("vc_modal:search", { member_query: "nala" });
  await btn("vc_flow:use");
  const second = await mod("vc_modal:form", { mulai: "12.50", link: freshLink(), tiket: "" });
  assert.equal(labelOf(second.screen, "vc_flow:close"), "✖ Tutup & buang 2 sesi baru");
  assert.equal(loadVc().sessions.length, 3);

  await btn("vc_flow:close");
  const left = loadVc().sessions;
  assert.equal(left.length, 1);
  assert.equal(left[0].username, "jkt48_lily", "sesi yang sudah Selesai tidak tersentuh");
  assert.equal(dm.store.size, 1, "rangkuman masih ada dan sudah di-update (tanpa Aralie & Nala)");
  assert.match(summaryText(), /LILY/);
  assert.doesNotMatch(summaryText(), /Aralie|NALA/i);
});

test("'Selesai' menyimpan sesinya: sesudahnya Tutup hanya menutup panel dan rangkuman (judul + sesi) tetap ada", async () => {
  await handleVcCommand({ rawText: "input vc", commandText: "input vc", authorId: OWNER, isDm: true });
  await addLilySession();
  const done = await btn("vc_flow:done");
  assert.match(done.screen.content, /✅ Selesai\. 1 sesi baru tersimpan - total 1 sesi/);
  assert.deepEqual(done.screen.components, [], "layar penutup tanpa tombol");
  assert.equal(dm.store.size, 1);

  const panel = await handleVcCommand({ rawText: "input vc", commandText: "input vc", authorId: OWNER, isDm: true });
  assert.equal(labelOf(panel, "vc_flow:close"), "✖ Tutup", "tidak ada yang tertunda lagi");
  assert.ok(!idsOf(panel).includes("vc_flow:done"));
  const close = await btn("vc_flow:close");
  assert.equal(close.calls.deleted, 1);
  assert.equal(loadVc().sessions.length, 1);
  assert.equal(dm.store.size, 1);
  assert.match(summaryText(), /LILY/);
});

test("sesi yang dihapus lewat Ubah/Hapus tidak dihitung tertunda; mengubah sesi lama tidak membuatnya tertunda", async () => {
  await addLilySession();
  await btn("vc_flow:done");
  const id = loadVc().sessions[0].id;
  await mod(`vc_modal:eform:${id}`, { sesi: "2", tanggal: DATE, mulai: "12.50", tiket: "3" });
  const close = await btn("vc_flow:close");
  assert.equal(close.calls.deleted, 1);
  assert.equal(loadVc().sessions.length, 1, "sesi lama yang diedit tetap ada");

  await addLilySession({ ...GOOD_FORM, mulai: "17.45", link: freshLink() }, {}, 5, DATE);
  const [, fresh] = loadVc().sessions;
  await btn(`vc_flow:edelok:${fresh.id}`); // dihapus manual sebelum Tutup
  const after = await btn("vc_flow:close");
  assert.equal(after.calls.deleted, 1);
  assert.equal(loadVc().sessions.length, 1);
});

test("sitting kedaluwarsa (3 jam tanpa aktivitas): sesinya dianggap final, Tutup tidak membuangnya", async () => {
  await addLilySession();
  const realNow = Date.now;
  Date.now = () => realNow() + 3 * 60 * 60 * 1000 + 60_000;
  try {
    const close = await btn("vc_flow:close");
    assert.equal(close.calls.deleted, 1);
  } finally {
    Date.now = realNow;
  }
  assert.equal(loadVc().sessions.length, 1);
});

test("Reset / Hapus rangkuman membersihkan catatan 'tertunda' (tidak ada sisa yang dibuang belakangan)", async () => {
  await addLilySession();
  await btn("vc_flow:resetok");
  await addLilySession({ ...GOOD_FORM, mulai: "14.20", link: freshLink() }, {}, 3, DATE);
  await btn("vc_flow:done");
  const close = await btn("vc_flow:close");
  assert.equal(close.calls.deleted, 1);
  assert.equal(loadVc().sessions.length, 1);
});

test("panel menampilkan catatan tertunda dan tombol Selesai hanya saat ada sesi baru yang belum selesai", async () => {
  const empty = await handleVcCommand({ rawText: "input vc", commandText: "input vc", authorId: OWNER, isDm: true });
  assert.doesNotMatch(empty.content, /belum diselesaikan/);
  assert.ok(!idsOf(empty).includes("vc_flow:done"));
  await addLilySession();
  const menu = await btn("vc_flow:menu");
  assert.match(menu.screen.content, /⏳ 1 sesi baru belum diselesaikan/);
  assert.ok(idsOf(menu.screen).includes("vc_flow:done"));
  assert.equal(labelOf(menu.screen, "vc_flow:close"), "✖ Tutup & buang 1 sesi baru");
});

test("'Tutup' tetap beres (panel terhapus, tidak melempar) walau bot gagal menghapus rangkuman kosong", async () => {
  await handleVcCommand({ rawText: "input vc", commandText: "input vc", authorId: OWNER, isDm: true });
  assert.equal(dm.store.size, 1);
  clientEnabled = false; // bot "belum login": penghapusan gagal tapi Tutup tetap beres
  const close = await btn("vc_flow:close");
  assert.equal(close.calls.deleted, 1);
  clientEnabled = true;
  assert.equal(dm.store.size, 1, "gagal hapus -> rangkuman masih ada, dan itu tidak merusak apa-apa");
});

// ---------------------------------------------------------------------------
// Urutan & tampilan di rangkuman (end-to-end lewat flow)
// ---------------------------------------------------------------------------

test("urutan di rangkuman: prioritas selalu paling atas walau diinput terakhir dan tanggalnya paling belakang", async () => {
  const addPlain = async (query, date, form) => {
    await btn("vc_flow:add");
    await mod("vc_modal:search", { member_query: query });
    await btn("vc_flow:use");
    await sel("vc_select:date", [date]);
    await sel("vc_select:session", ["1"]);
    await mod("vc_modal:form", form);
  };
  await addPlain("aralie", DATE, { ...GOOD_FORM, link: freshLink(), mulai: "11.30" });
  await addPlain("lily", shiftDateWIB(DATE, 7), { ...GOOD_FORM, link: freshLink(), mulai: "11.30" });
  const text = summaryText();
  assert.ok(text.indexOf("LILY") < text.indexOf("Aralie"), "Lily (prioritas, seminggu lebih belakang) di atas Aralie (biasa, lebih dulu)");
  assert.match(text, /## 1\. 🚨✨🚨 LILY/);
  assert.match(text, /\*\*2\. Aralie\*\*/);
});

// ---------------------------------------------------------------------------
// Ubah / hapus
// ---------------------------------------------------------------------------

test("ubah sesi & jam: modal terisi nilai sekarang; perubahan tersimpan, catatan dibuat ulang bila jam/tiket berubah, rangkuman ter-update", async () => {
  await addLilySession();
  const id = loadVc().sessions[0].id;
  const oldNote = getVcSession(id).note;

  const list = await btn("vc_flow:edit");
  assert.equal(list.screen.components[0].components[0].data.custom_id, "vc_select:entry");
  const entry = await sel("vc_select:entry", [String(id)]);
  assert.deepEqual(idsOf(entry.screen).slice(0, 4), [`vc_flow:eform:${id}`, `vc_flow:elink:${id}`, `vc_flow:enote:${id}`, `vc_flow:edel:${id}`]);

  const open = await btn(`vc_flow:eform:${id}`);
  assert.deepEqual(modalValues(open.calls.modals[0]), { sesi: "2", tanggal: DATE, mulai: "13.00", tiket: "3" }, "tidak ada kolom jam buka");

  const sunday = shiftDateWIB(DATE, 1);
  const done = await mod(`vc_modal:eform:${id}`, { sesi: "5", tanggal: sunday, mulai: "17.45", tiket: "" });
  assert.match(done.screen.content, /✅ Diubah/);
  assert.match(done.screen.content, /Buka 17\.45-18\.00/, "jam buka ikut sesi baru");
  const s = getVcSession(id);
  assert.deepEqual(
    { session: s.session, date: s.date, open: s.open, openEnd: s.openEnd, start: s.start, tickets: s.tickets },
    { session: 5, date: sunday, open: "17:45", openEnd: "18:00", start: "17:45", tickets: null },
  );
  assert.notEqual(s.note, oldNote, "catatan basi (menyebut 3 tiket/jeda lama) dibuat ulang");
  assert.match(summaryText(), /Sesi 5/);
  assert.doesNotMatch(summaryText(), /Sesi 2/);
  assert.equal(dm.store.size, 1, "diedit di tempat, bukan pesan baru");
});

test("ubah sesi: kalau jam/tiket TIDAK berubah (cuma pindah ke Sabtu lain), catatannya dipertahankan", async () => {
  await addLilySession();
  const id = loadVc().sessions[0].id;
  const note = getVcSession(id).note;
  const nextSaturday = shiftDateWIB(DATE, 7);
  await mod(`vc_modal:eform:${id}`, { sesi: "2", tanggal: nextSaturday, mulai: "13.00", tiket: "3" });
  assert.equal(getVcSession(id).note, note);
  assert.equal(getVcSession(id).date, nextSaturday);
});

test("ubah sesi: sesi 4-6 di hari kerja ditolak (tidak ada), termasuk saat tanggalnya dipindah ke hari kerja; sesi 1-3 boleh dan jam bukanya ikut", async () => {
  await addLilySession({ ...GOOD_FORM, link: freshLink(), mulai: "17.45" }, {}, 5, DATE); // Sabtu sesi 5 (17.45-18.00)
  const id = loadVc().sessions[0].id;

  const moved = await mod(`vc_modal:eform:${id}`, { sesi: "5", tanggal: WEEKDAY, mulai: "18.00", tiket: "3" });
  assert.match(moved.screen.content, /Ada yang belum bener/);
  assert.match(moved.screen.content, /Sesi 5 gak ada di hari Senin - hari kerja cuma sesi 1-3/);
  assert.deepEqual([getVcSession(id).session, getVcSession(id).date], [5, DATE], "tidak ada yang berubah");

  const typed = await mod(`vc_modal:eform:${id}`, { sesi: "4", tanggal: "senin", mulai: "16.30", tiket: "3" });
  assert.match(typed.screen.content, /gak ada di kalender|gak kebaca/, "kata 'senin' bukan tanggal");

  const fixed = await mod(`vc_modal:eform:${id}`, { sesi: "3", tanggal: WEEKDAY, mulai: "19.15", tiket: "3" });
  assert.match(fixed.screen.content, /✅ Diubah/);
  const s = getVcSession(id);
  assert.deepEqual([s.session, s.date, s.open, s.openEnd], [3, WEEKDAY, "19:15", "19:30"]);

  const tooHigh = await mod(`vc_modal:eform:${id}`, { sesi: "7", tanggal: DATE, mulai: "19.30", tiket: "3" });
  assert.match(tooHigh.screen.content, /Sesi 7 gak ada di hari Sabtu - akhir pekan cuma sesi 1-6/);
});

test("ubah sesi: salah isi -> daftar kesalahan + isian terakhir terisi lagi saat 'Perbaiki'; bentrok dengan sesi lain member itu ditolak", async () => {
  await addLilySession();
  await btn("vc_flow:again");
  await sel("vc_select:session", ["3"]);
  await mod("vc_modal:form", { ...GOOD_FORM, link: freshLink(), mulai: "14.30" });
  const [a, b] = loadVc().sessions;

  const bad = await mod(`vc_modal:eform:${a.id}`, { sesi: "x", tanggal: "?", mulai: "12.00", tiket: "" });
  assert.match(bad.screen.content, /Ada yang belum bener/);
  assert.equal(getVcSession(a.id).session, 2, "tidak berubah");
  const reopen = await btn(`vc_flow:eform:${a.id}`);
  // tiket sengaja dikosongkan owner -> form dibuka dengan kolom tiket KOSONG (bukan kembali ke angka lama 3)
  assert.deepEqual(modalValues(reopen.calls.modals[0]), { sesi: "x", tanggal: "?", mulai: "12.00", tiket: undefined });

  const clash = await mod(`vc_modal:eform:${a.id}`, { sesi: String(b.session), tanggal: DATE, mulai: "14.30", tiket: "3" });
  assert.match(clash.screen.content, /udah dipakai sesi lain/);
  assert.equal(getVcSession(a.id).session, 2);
});

test("ubah link: terparse (+sandi), tersimpan, rangkuman ter-update; link salah ditolak dan isiannya dipertahankan", async () => {
  await addLilySession();
  const id = loadVc().sessions[0].id;
  const open = await btn(`vc_flow:elink:${id}`);
  assert.equal(modalValues(open.calls.modals[0]).link, `${ZOOM} 388756`);

  const bad = await mod(`vc_modal:elink:${id}`, { link: "ngawur" });
  assert.match(bad.screen.content, /Ada yang belum bener/);
  assert.equal(getVcSession(id).link, ZOOM);
  const reopen = await btn(`vc_flow:elink:${id}`);
  assert.equal(modalValues(reopen.calls.modals[0]).link, "ngawur");

  const ok = await mod(`vc_modal:elink:${id}`, { link: "https://us02web.zoom.us/j/81331441967?pwd=zzz sandi:Ab12" });
  assert.match(ok.screen.content, /✅ Link diubah/);
  assert.equal(getVcSession(id).passcode, "Ab12");
  assert.match(summaryText(), /🆔 813 3144 1967 · 🔑 Ab12/);
});

test("catatan baru: berubah, tersimpan, tampil di rangkuman", async () => {
  await addLilySession();
  const id = loadVc().sessions[0].id;
  const seen = new Set([getVcSession(id).note]);
  for (let i = 0; i < 5; i++) {
    await btn(`vc_flow:enote:${id}`);
    seen.add(getVcSession(id).note);
  }
  assert.ok(seen.size > 1, "catatan berganti");
  assert.ok(summaryText().includes(getVcSession(id).note.replace(/([\\*_~`|>#@])/g, "\\$1")));
});

test("hapus sesi: konfirmasi dulu; Batal tidak menghapus; Ya menghapus dan merapikan rangkuman; sesi yang sudah hilang tidak bikin error", async () => {
  await addLilySession();
  const id = loadVc().sessions[0].id;

  const ask = await btn(`vc_flow:edel:${id}`);
  assert.match(ask.screen.content, /Yakin hapus/);
  const cancel = await btn(`vc_flow:eback:${id}`);
  assert.match(cancel.screen.content, /Sesi 2/);
  assert.equal(loadVc().sessions.length, 1);

  const del = await btn(`vc_flow:edelok:${id}`);
  assert.match(del.screen.content, /🗑️ Dihapus/);
  assert.equal(loadVc().sessions.length, 0);
  assert.match(summaryText(), /Belum ada sesi/);
  assert.doesNotMatch(summaryText(), /LILY/);

  const again = await btn(`vc_flow:edelok:${id}`);
  assert.match(again.screen.content, /udah gak ada/);
  const gone = await btn(`vc_flow:eform:${id}`);
  assert.match(gone.screen.content, /udah gak ada/);
  const gone2 = await sel("vc_select:entry", [String(id)]);
  assert.match(gone2.screen.content, /udah gak ada/);
});

test("daftar ubah/hapus: urut seperti di rangkuman (prioritas dulu), dibatasi 25 dengan catatan jumlah", async () => {
  const { addVcSession } = require("../src/storage/vcSchedule");
  for (let i = 0; i < 30; i++) {
    addVcSession({
      username: `jkt48_m${i}`,
      name: `Member ${i} JKT48`,
      session: 1,
      date: DATE,
      open: "10:00",
      start: "10:30",
      tickets: null,
      link: ZOOM,
      passcode: null,
      note: "n",
    });
  }
  addVcSession({
    username: "jkt48_lily",
    name: "Lily JKT48",
    session: 1,
    date: shiftDateWIB(DATE, 5),
    open: "10:00",
    start: "10:30",
    tickets: null,
    link: ZOOM,
    passcode: null,
    note: "n",
  });
  const list = await btn("vc_flow:edit");
  const select = list.screen.components[0].components[0];
  assert.equal(select.options.length, 25);
  assert.match(select.options[0].data.label, /^Lily/, "prioritas di urutan pertama");
  assert.match(list.screen.content, /25 dari 31/);
});

// ---------------------------------------------------------------------------
// Judul, pembuka, kirim ulang, reset
// ---------------------------------------------------------------------------

test("judul: modal terisi judul sekarang; diubah -> tersimpan + rangkuman; kosong ditolak; dipotong 60 karakter", async () => {
  await handleVcCommand({ rawText: "input vc", commandText: "input vc", authorId: OWNER, isDm: true });
  const open = await btn("vc_flow:title");
  assert.match(modalValues(open.calls.modals[0]).title, /^VC /);

  const ok = await mod("vc_modal:title", { title: "  VC   Spesial  Natal " });
  assert.match(ok.screen.content, /Judul diubah/);
  assert.equal(loadVc().title, "VC Spesial Natal");
  assert.match(summaryText(), /# 🎬 VC Spesial Natal/);

  const empty = await mod("vc_modal:title", { title: "   " });
  assert.match(empty.screen.content, /gak boleh kosong/);
  assert.equal(loadVc().title, "VC Spesial Natal");

  await mod("vc_modal:title", { title: "x".repeat(100) });
  assert.equal(loadVc().title.length, 60);
});

test("acak pembuka: berganti dan tampil di rangkuman", async () => {
  await handleVcCommand({ rawText: "input vc", commandText: "input vc", authorId: OWNER, isDm: true });
  const seen = new Set([loadVc().opener]);
  for (let i = 0; i < 6; i++) {
    const r = await btn("vc_flow:opener");
    assert.match(r.screen.content, /Pembuka baru/);
    seen.add(loadVc().opener);
  }
  assert.ok(seen.size > 1);
  assert.ok(summaryText().includes(loadVc().opener));
});

test("kirim ulang di bawah: pesan lama dihapus dan yang baru dikirim (id berganti), isi sama", async () => {
  await addLilySession();
  const [oldId] = loadVc().message.ids;
  const before = summaryText();
  const r = await btn("vc_flow:repost");
  assert.match(r.screen.content, /dikirim ulang/);
  const [newId] = loadVc().message.ids;
  assert.notEqual(newId, oldId);
  assert.equal(dm.store.has(oldId), false);
  assert.equal(summaryText(), before);
  assert.equal(dm.store.size, 1);
});

test("layar konfirmasi reset & hapus rangkuman tidak punya custom_id ganda (Discord menolak pesan seperti itu)", async () => {
  await addLilySession();
  for (const id of ["vc_flow:reset", "vc_flow:wipe"]) {
    const ask = await btn(id); // fake() sudah menolak custom_id ganda di setiap layar
    const ids = idsOf(ask.screen);
    assert.equal(new Set(ids).size, ids.length, id);
    assert.ok(ids.includes("vc_flow:menu") && ids.includes("vc_flow:close"), "tetap ada Batal dan Tutup");
  }
});

// --- satu link Zoom = satu sesi ---

test("link Zoom yang sama dengan sesi lain ditolak (walau beda host/sandi/huruf/garis miring); 'Perbaiki' mengisi ulang isiannya", async () => {
  await addLilySession();
  const before = loadVc().sessions.length;
  const attempt = async (link, date = DATE, sessionNo = "3", query = "aralie") => {
    await btn("vc_flow:add");
    await mod("vc_modal:search", { member_query: query });
    await btn("vc_flow:use");
    await sel("vc_select:date", [date]);
    await sel("vc_select:session", [sessionNo]);
    return mod("vc_modal:form", { mulai: "14.30", link, tiket: "" });
  };
  const variants = [
    `${ZOOM} 388756`, // persis sama
    "https://us02web.zoom.us/j/87197929985", // tanpa ?pwd
    "https://zoom.us/j/87197929985?pwd=lain", // host & pwd beda, ID rapat sama
  ];
  for (const link of variants) {
    const rejected = await attempt(link);
    assert.match(rejected.screen.content, /Link Zoom itu udah dipakai sesi lain: Lily · Sesi 2/, link);
    assert.deepEqual(idsOf(rejected.screen), ["vc_flow:form", "vc_flow:menu", "vc_flow:done", "vc_flow:close"]);
    assert.equal(loadVc().sessions.length, before, "tidak ada sesi baru yang tersimpan");
  }
  const retry = await btn("vc_flow:form");
  assert.equal(modalValues(retry.calls.modals[0]).mulai, "14.30", "isian terakhir terisi lagi");

  const fixed = await mod("vc_modal:form", { mulai: "14.30", link: "https://us02web.zoom.us/j/81111111111 111222", tiket: "" });
  assert.match(fixed.screen.content, /✅ Tersimpan/);
  assert.equal(loadVc().sessions.length, before + 1);
});

test("link non-Zoom: sama persis ditolak, beda path boleh", async () => {
  await addLilySession({ ...GOOD_FORM, link: "https://meet.example.com/room/abc" });
  const addAralie = async (link, sessionNo) => {
    await btn("vc_flow:add");
    await mod("vc_modal:search", { member_query: "aralie" });
    await btn("vc_flow:use");
    await sel("vc_select:date", [DATE]);
    await sel("vc_select:session", [sessionNo]);
    return mod("vc_modal:form", { mulai: "17.45", link, tiket: "" });
  };
  const same = await addAralie("https://MEET.example.com/room/abc/", "5");
  assert.match(same.screen.content, /udah dipakai sesi lain/);
  const other = await addAralie("https://meet.example.com/room/xyz", "5");
  assert.match(other.screen.content, /✅ Tersimpan/);
});

test("ubah link: link sesi lain ditolak; link sendiri (tidak berubah) boleh; link baru yang unik tersimpan", async () => {
  await addLilySession();
  await addLilySession({ ...GOOD_FORM, mulai: "17.45", link: freshLink() }, {}, 5, DATE);
  const [a, b] = loadVc().sessions;

  const clash = await mod(`vc_modal:elink:${b.id}`, { link: `${a.link}` });
  assert.match(clash.screen.content, /Link Zoom itu udah dipakai sesi lain: Lily · Sesi 2/);
  assert.deepEqual(idsOf(clash.screen).slice(0, 1), [`vc_flow:elink:${b.id}`]);
  assert.equal(getVcSession(b.id).link, b.link, "tidak berubah");

  const own = await mod(`vc_modal:elink:${b.id}`, { link: `${b.link} 999888` });
  assert.match(own.screen.content, /✅ Link diubah/, "link sendiri + ganti sandi tidak dianggap bentrok");
  const fresh = await mod(`vc_modal:elink:${b.id}`, { link: freshLink() });
  assert.match(fresh.screen.content, /✅ Link diubah/);
});

// --- banyak member di sesi yang sama ---

test("beberapa member di sesi yang sama: 'Member lain (sesi N sama)' langsung ke form tanpa pilih tanggal/sesi lagi", async () => {
  recordLiveCompleted("jkt48_nala", "Nala JKT48");
  const saved = await addLilySession();
  assert.ok(idsOf(saved.screen).includes("vc_flow:same"));
  assert.ok(labelsOf(saved.screen).some((l) => /Member lain \(Sesi 2 sama\)/.test(l)));

  const addSame = async (query, form) => {
    const open = await btn("vc_flow:same");
    assert.equal(open.calls.modals[0].toJSON().custom_id, "vc_modal:search");
    await mod("vc_modal:search", { member_query: query });
    const use = await btn("vc_flow:use");
    assert.equal(use.calls.screens.length, 0, "tidak ada layar tanggal/sesi: langsung buka form");
    const formModal = use.calls.modals[0].toJSON();
    assert.equal(formModal.custom_id, "vc_modal:form");
    assert.equal(formModal.title, "Sesi 2 · Buka 13.00-13.15");
    return mod("vc_modal:form", form);
  };
  const aralie = await addSame("aralie", { mulai: "13.00", link: freshLink(), tiket: "2" });
  assert.match(aralie.screen.content, /✅ Tersimpan: \*\*Aralie\*\* · Sesi 2/);
  const nala = await addSame("nala", { mulai: "12.50", link: freshLink(), tiket: "" }); // rantai: member ketiga dst.
  assert.match(nala.screen.content, /✅ Tersimpan: \*\*Nala\*\* · Sesi 2/);

  const sessions = loadVc().sessions;
  assert.equal(sessions.length, 3);
  assert.ok(
    sessions.every((s) => s.session === 2 && s.date === DATE),
    "ketiganya di sesi & tanggal yang sama",
  );
  assert.equal(new Set(sessions.map((s) => s.link)).size, 3, "tiap member punya link sendiri");
  const text = summaryText();
  for (const name of ["LILY", "Aralie", "Nala"]) assert.match(text, new RegExp(name, "i"), name);
});

test("'Member lain (sesi sama)': member yang sudah punya sesi itu -> diarahkan pilih sesi lain; tanpa draft -> panel kedaluwarsa", async () => {
  await addLilySession();
  await btn("vc_flow:same");
  await mod("vc_modal:search", { member_query: "lily" });
  const use = await btn("vc_flow:use");
  assert.equal(use.calls.modals.length, 0);
  assert.match(use.screen.content, /Lily udah punya Sesi 2/);
  assert.equal(idsOf(use.screen)[0], "vc_select:session");
  const picked = await sel("vc_select:session", ["3"]);
  assert.equal(picked.calls.modals[0].toJSON().title, "Sesi 3 · Buka 14.30-14.45");

  const stale = await btn("vc_flow:same", { channelId: "dm-tanpa-draft" });
  assert.match(stale.screen.content, /kelamaan\/ke-reset/);
});

test("'Member lain (sesi sama)' dibatalkan di tengah jalan: 'Sesi lagi' tetap jalan, dan 'Member & tanggal lain' mulai bersih", async () => {
  await addLilySession();
  await btn("vc_flow:same"); // modal pencarian dibuka lalu ditutup tanpa submit
  const again = await btn("vc_flow:again");
  assert.match(again.screen.content, /Sesi berapa/);
  await btn("vc_flow:add");
  await mod("vc_modal:search", { member_query: "aralie" });
  const use = await btn("vc_flow:use");
  assert.match(use.screen.content, /Tanggal VC-nya kapan/, "alur biasa, tidak terbawa sesi sebelumnya");
});

test("daftar Ubah/Hapus dipecah per halaman: SEMUA sesi (lebih dari 25) bisa dijangkau, tombol halaman benar", async () => {
  const data = loadVc();
  for (let i = 0; i < 60; i++) {
    data.sessions.push({
      id: i + 1,
      username: null,
      name: `Member ${String(i).padStart(2, "0")}`,
      session: 2,
      date: DATE,
      open: "13:00",
      openEnd: "13:15",
      start: "13:00",
      tickets: null,
      link: `https://us02web.zoom.us/j/${82000000000 + i}`,
      passcode: null,
      note: "",
    });
  }
  data.nextId = 61;
  getRegisteredStore("vc-schedule.json").store.save(data);

  const seen = new Set();
  const optionsOf = (screen) => screen.components[0].components[0].options.map((o) => o.data.value);
  let screen = (await btn("vc_flow:edit")).screen;
  assert.match(screen.content, /sesi 1-25 dari 60, halaman 1\/3/);
  const pagerOf = (s) => Object.fromEntries(s.components[1].components.map((b) => [b.data.custom_id, Boolean(b.data.disabled)]));
  assert.deepEqual(
    pagerOf(screen),
    { "vc_flow:elist:-1": true, "vc_flow:elist_info": true, "vc_flow:elist:1": false },
    "halaman pertama: Sebelumnya mati",
  );
  for (const id of optionsOf(screen)) seen.add(id);
  assert.equal(optionsOf(screen).length, 25);

  screen = (await btn("vc_flow:elist:1")).screen;
  assert.match(screen.content, /sesi 26-50 dari 60, halaman 2\/3/);
  for (const id of optionsOf(screen)) seen.add(id);
  screen = (await btn("vc_flow:elist:2")).screen;
  assert.match(screen.content, /sesi 51-60 dari 60, halaman 3\/3/);
  assert.equal(optionsOf(screen).length, 10);
  assert.deepEqual(
    pagerOf(screen),
    { "vc_flow:elist:1": false, "vc_flow:elist_info": true, "vc_flow:elist:3": true },
    "halaman terakhir: Berikutnya mati",
  );
  for (const id of optionsOf(screen)) seen.add(id);
  assert.equal(seen.size, 60, "tiap sesi muncul tepat sekali di salah satu halaman");

  const clampedHigh = (await btn("vc_flow:elist:99")).screen;
  assert.match(clampedHigh.content, /halaman 3\/3/);
  const clampedLow = (await btn("vc_flow:elist:-5")).screen;
  assert.match(clampedLow.content, /halaman 1\/3/);
  const garbage = (await btn("vc_flow:elist:abc")).screen;
  assert.match(garbage.content, /halaman 1\/3/, "halaman tidak valid -> halaman pertama");

  const entry = await sel("vc_select:entry", ["60"]); // sesi terakhir (dulu tidak terjangkau) bisa dipilih
  assert.match(entry.screen.content, /Member 59/);
});

test("daftar Ubah/Hapus dengan <= 25 sesi tidak menampilkan baris halaman", async () => {
  await addLilySession();
  const list = await btn("vc_flow:edit");
  assert.equal(list.screen.components.length, 2, "dropdown + navigasi saja");
  assert.doesNotMatch(list.screen.content, /halaman/);
});

test("link yang mengandung < atau > ditolak (merusak tampilan rangkuman); <link> yang dibungkus tetap diterima", async () => {
  await btn("vc_flow:add");
  await mod("vc_modal:search", { member_query: "lily" });
  await btn("vc_flow:use");
  await sel("vc_select:date", [DATE]);
  await sel("vc_select:session", ["2"]);
  const bad = await mod("vc_modal:form", { ...GOOD_FORM, link: "https://example.com/a>b" });
  assert.match(bad.screen.content, /gak boleh mengandung tanda < atau >/);
  assert.equal(loadVc().sessions.length, 0);
  const wrapped = await mod("vc_modal:form", { ...GOOD_FORM, link: `<${freshLink().split(" ")[0]}> 123456` });
  assert.match(wrapped.screen.content, /Tersimpan/);
  assert.doesNotMatch(loadVc().sessions[0].link, /[<>]/);
});

test("reset periode: konfirmasi dulu; setelahnya sesi kosong, judul kembali ke bulan ini, julukan TETAP, rangkuman 'belum ada sesi'", async () => {
  await addLilySession();
  await handleVcCommand({
    rawText: "julukan vc lily = Cece Adik Aing",
    commandText: "julukan vc lily = cece adik aing",
    authorId: OWNER,
    isDm: true,
  });
  await mod("vc_modal:title", { title: "Judul Lama" });

  const ask = await btn("vc_flow:reset");
  assert.match(ask.screen.content, /Yakin mau kosongkan/);
  assert.equal(loadVc().sessions.length, 1, "belum dihapus sebelum dikonfirmasi");

  const done = await btn("vc_flow:resetok");
  assert.match(done.screen.content, /Periode baru/);
  const data = loadVc();
  assert.equal(data.sessions.length, 0);
  assert.match(data.title, /^VC /);
  assert.notEqual(data.title, "Judul Lama");
  assert.deepEqual(data.nicknames, { jkt48_lily: "Cece Adik Aing" });
  assert.match(summaryText(), /Belum ada sesi/);
});

test("hapus rangkuman: konfirmasi dulu; setelahnya pesan rangkuman hilang dari DM, sesi kosong, julukan TETAP", async () => {
  await handleVcCommand({ rawText: "input vc", commandText: "input vc", authorId: OWNER, isDm: true });
  await addLilySession();
  await handleVcCommand({
    rawText: "julukan vc lily = Cece Adik Aing",
    commandText: "julukan vc lily = cece adik aing",
    authorId: OWNER,
    isDm: true,
  });
  await mod("vc_modal:title", { title: "Judul Lama" });
  assert.equal(dm.store.size, 1);

  const ask = await btn("vc_flow:wipe");
  assert.match(ask.screen.content, /Yakin mau hapus 1 sesi dan pesan rangkumannya/);
  assert.deepEqual(idsOf(ask.screen), ["vc_flow:wipeok", "vc_flow:menu", "vc_flow:done", "vc_flow:close"]);
  assert.equal(loadVc().sessions.length, 1, "belum dihapus sebelum dikonfirmasi");
  assert.equal(dm.store.size, 1);

  const done = await btn("vc_flow:wipeok");
  assert.match(done.screen.content, /Rangkuman dihapus/);
  assert.equal(dm.store.size, 0, "tidak ada pesan rangkuman tersisa di DM");
  const data = loadVc();
  assert.equal(data.sessions.length, 0);
  assert.equal(data.message, null);
  assert.match(data.title, /^VC /);
  assert.deepEqual(data.nicknames, { jkt48_lily: "Cece Adik Aing" });
  assert.match(done.screen.content, /belum ada sesi\. Pesan rangkuman dibuat otomatis/, "panel tidak lagi menyebut pesan yang sudah tidak ada");
  const wipeBtn = done.screen.components.flatMap((r) => r.components).find((b) => b.data.custom_id === "vc_flow:wipe");
  assert.equal(wipeBtn.data.disabled, true, "tidak ada lagi yang bisa dihapus");

  await addLilySession(); // tetap bisa mulai lagi: rangkuman dibuat baru
  assert.equal(dm.store.size, 1);
  assert.match(summaryText(), /LILY/);
});

test("hapus rangkuman: sesi sudah banyak sampai rangkuman terpecah beberapa pesan -> semua pesannya hilang", async () => {
  const data = loadVc();
  for (let i = 0; i < 40; i++) {
    data.sessions.push({
      id: i + 1,
      username: null,
      name: `Member Nomor ${i} ${"x".repeat(20)}`,
      session: 2,
      date: DATE,
      open: "13:00",
      openEnd: "13:15",
      start: "13:00",
      tickets: 3,
      link: `${ZOOM}`,
      passcode: "123456",
      note: "catatan panjang ".repeat(5),
    });
  }
  data.nextId = 41;
  getRegisteredStore("vc-schedule.json").store.save(data);
  await syncSummary(OWNER);
  assert.ok(dm.store.size > 1, `rangkuman terpecah (${dm.store.size} pesan)`);

  await btn("vc_flow:wipeok");
  assert.equal(dm.store.size, 0);
  assert.equal(loadVc().sessions.length, 0);
});

test("hapus rangkuman: DM tidak terjangkau -> data DIBIARKAN (tidak setengah terhapus) dan owner diberi tahu", async () => {
  await addLilySession();
  clientEnabled = false;
  const done = await btn("vc_flow:wipeok");
  clientEnabled = true;
  assert.match(done.screen.content, /Gagal menghapus rangkuman/);
  assert.equal(loadVc().sessions.length, 1, "sesi masih ada, bisa dicoba lagi");
  assert.ok(loadVc().message, "referensi pesan masih ada");
  assert.equal(dm.store.size, 1);
});

test("hapus rangkuman: draft pengisian yang sedang berjalan ikut dibuang", async () => {
  await btn("vc_flow:add");
  await mod("vc_modal:search", { member_query: "lily" });
  await btn("vc_flow:wipeok");
  const stale = await btn("vc_flow:use");
  assert.match(stale.screen.content, /kelamaan\/ke-reset/);
});

// ---------------------------------------------------------------------------
// Sinkron pesan rangkuman
// ---------------------------------------------------------------------------

test("sync: perubahan berikutnya MENGEDIT pesan yang sama (tidak menambah pesan)", async () => {
  await addLilySession();
  const sends = () => dm.log.filter(([op]) => op === "send").length;
  assert.equal(sends(), 1);
  await mod("vc_modal:title", { title: "Judul Baru" });
  await mod("vc_modal:title", { title: "Judul Lebih Baru" });
  assert.equal(sends(), 1);
  assert.ok(dm.log.filter(([op]) => op === "edit").length >= 2);
});

test("sync: pesan rangkuman dihapus manual -> dikirim ulang otomatis (tidak error, tidak dobel)", async () => {
  await addLilySession();
  const [oldId] = loadVc().message.ids;
  dm.store.delete(oldId); // owner menghapus pesannya di Discord
  const r = await mod("vc_modal:title", { title: "Setelah Dihapus" });
  assert.doesNotMatch(r.screen.content, /gagal/);
  assert.equal(dm.store.size, 1);
  assert.match(summaryText(), /Setelah Dihapus/);
  assert.notEqual(loadVc().message.ids[0], oldId);
});

test("sync: rangkuman panjang jadi beberapa pesan; lalu menyusut -> pesan kelebihan dihapus; membesar lagi -> pesan baru", async () => {
  const { addVcSession, removeVcSession } = require("../src/storage/vcSchedule");
  const ids = [];
  for (let i = 0; i < 40; i++) {
    ids.push(
      addVcSession({
        username: `jkt48_p${i}`,
        name: `Panjang ${i} JKT48`,
        session: 1,
        date: DATE,
        open: "10:00",
        start: "10:30",
        tickets: 5,
        link: ZOOM,
        passcode: "123456",
        note: "Catatan absurd yang panjang supaya memenuhi pesan dengan cepat sekali.",
      }).id,
    );
  }
  assert.deepEqual(await syncSummary(OWNER), { ok: true });
  const many = loadVc().message.ids.length;
  assert.ok(many > 1);
  for (const text of dm.store.values()) assert.ok(text.length <= MESSAGE_LIMIT);

  for (const id of ids.slice(5)) removeVcSession(id);
  await syncSummary(OWNER);
  const fewer = loadVc().message.ids.length;
  assert.ok(fewer < many);
  assert.equal(dm.store.size, fewer, "pesan kelebihan dihapus dari DM");

  for (let i = 0; i < 40; i++) {
    addVcSession({
      username: `jkt48_q${i}`,
      name: `Lagi ${i} JKT48`,
      session: 1,
      date: DATE,
      open: "10:00",
      start: "10:30",
      tickets: 5,
      link: ZOOM,
      passcode: "123456",
      note: "Catatan absurd yang panjang supaya memenuhi pesan dengan cepat sekali.",
    });
  }
  await syncSummary(OWNER);
  assert.ok(loadVc().message.ids.length > fewer);
  assert.equal(dm.store.size, loadVc().message.ids.length);
});

test("sync: rangkuman membesar jadi 2+ pesan -> potongannya tetap berurutan dan menyatu di BAWAH panel (bukan terpisah oleh panel)", async () => {
  const { addVcSession } = require("../src/storage/vcSchedule");
  await addLilySession();
  assert.equal(loadVc().message.ids.length, 1);
  const panel = await dm.send({ content: "PANEL TOMBOL" }); // panel dikirim sesudah rangkuman pertama, seperti "input vc"

  for (let i = 0; i < 40; i++) {
    addVcSession({
      username: `jkt48_g${i}`,
      name: `Tumbuh ${i} JKT48`,
      session: 1,
      date: DATE,
      open: "10:00",
      start: "10:30",
      tickets: 5,
      link: ZOOM,
      passcode: "123456",
      note: "Catatan absurd yang panjang supaya memenuhi pesan dengan cepat sekali.",
    });
  }
  await syncSummary(OWNER);
  const summaryIds = loadVc().message.ids;
  assert.ok(summaryIds.length > 1);
  const order = [...dm.store.keys()];
  assert.deepEqual(order, [panel.id, ...summaryIds], "panel di atas, lalu semua potongan rangkuman berurutan tanpa disela pesan lain");
  assert.match(dm.store.get(summaryIds[0]), /^# /, "potongan pertama membawa judul periode");
});

test("sync: DM gagal -> data TETAP tersimpan, dan layar menampilkan peringatan (bukan seolah gagal total)", async () => {
  failDm = true;
  const originalError = console.error;
  console.error = () => {};
  try {
    const form = await addLilySession();
    assert.match(form.screen.content, /✅ Tersimpan/);
    assert.match(form.screen.content, /pesan rangkuman gagal di-update \(Cannot send messages/);
    assert.equal(loadVc().sessions.length, 1, "data aman");

    const panel = await handleVcCommand({ rawText: "input vc", commandText: "input vc", authorId: OWNER, isDm: true });
    assert.match(panel.content, /Gagal update pesan rangkuman/);

    failDm = false;
    assert.deepEqual(await syncSummary(OWNER), { ok: true }, "pulih begitu DM bisa lagi");
    assert.match(summaryText(), /LILY/);
  } finally {
    console.error = originalError;
  }
});

test("sync: bot belum login (client null) -> {ok:false} tanpa melempar", async () => {
  clientEnabled = false;
  const originalError = console.error;
  console.error = () => {};
  try {
    const result = await syncSummary(OWNER);
    assert.equal(result.ok, false);
    assert.match(result.reason, /belum login/);
  } finally {
    console.error = originalError;
  }
});

test("sync: dua perubahan bersamaan tidak membuat dua pesan rangkuman (antrean)", async () => {
  const { ensurePeriod } = require("../src/chat/vcFlow");
  ensurePeriod();
  const results = await Promise.all([syncSummary(OWNER), syncSummary(OWNER), syncSummary(OWNER)]);
  assert.ok(results.every((r) => r.ok));
  assert.equal(dm.store.size, 1);
  assert.equal(dm.log.filter(([op]) => op === "send").length, 1);
});

// ---------------------------------------------------------------------------
// Julukan
// ---------------------------------------------------------------------------

test("julukan: dipasang ke member yang sudah punya sesi -> rangkuman ter-update (priority = JULUKAN (NAMA)); dihapus -> kembali", async () => {
  await addLilySession();
  const set = await handleVcCommand({
    rawText: "julukan vc lily = Cece Adik Aing",
    commandText: "julukan vc lily = cece adik aing",
    authorId: OWNER,
    isDm: true,
  });
  assert.match(set, /Julukan buat \*\*Lily\*\*: "Cece Adik Aing"/);
  assert.equal(loadVc().nicknames.jkt48_lily, "Cece Adik Aing", "huruf besar/kecil dipertahankan");
  assert.match(summaryText(), /## 1\. 🚨✨🚨 CECE ADIK AING \(LILY\) 🚨✨🚨/);

  const clear = await handleVcCommand({ rawText: "hapus julukan vc lily", commandText: "hapus julukan vc lily", authorId: OWNER, isDm: true });
  assert.match(clear, /dihapus/);
  assert.deepEqual(loadVc().nicknames, {});
  assert.match(summaryText(), /## 1\. 🚨✨🚨 LILY 🚨✨🚨/);
});

test("julukan: member belum punya sesi -> dikenali lewat data bot; nama tak dikenal -> disimpan per nama; ambigu -> diminta lebih spesifik; terlalu panjang -> ditolak", async () => {
  const known = await handleVcCommand({
    rawText: "julukan vc aralie = Si Kalem",
    commandText: "julukan vc aralie = si kalem",
    authorId: OWNER,
    isDm: true,
  });
  assert.match(known, /Aralie/);
  assert.equal(loadVc().nicknames.jkt48_aralie, "Si Kalem");

  await handleVcCommand({ rawText: "julukan vc Zzqx Lepi = My Pumpkin", commandText: "x", authorId: OWNER, isDm: true });
  assert.equal(loadVc().nicknames["name:zzqx lepi"], "My Pumpkin");

  recordLiveCompleted("jkt48_nadia", "Nadia JKT48");
  recordLiveCompleted("jkt48_nadine", "Nadine JKT48");
  const ambiguous = await handleVcCommand({ rawText: "julukan vc nad = X", commandText: "x", authorId: OWNER, isDm: true });
  assert.match(ambiguous, /cocok ke beberapa member \(Nadia, Nadine\)/);
  assert.equal(loadVc().nicknames.jkt48_nadia, undefined);

  const long = await handleVcCommand({ rawText: `julukan vc lily = ${"x".repeat(61)}`, commandText: "x", authorId: OWNER, isDm: true });
  assert.match(long, /kepanjangan/);
  assert.equal(loadVc().nicknames.jkt48_lily, undefined);
});

test("julukan: bukan owner / di server -> diabaikan / dijelaskan; lewat router juga jalan", async () => {
  assert.equal(await handleVcCommand({ rawText: "julukan vc lily = X", commandText: "x", authorId: "orang-lain", isDm: true }), null);
  assert.equal(await handleVcCommand({ rawText: "julukan vc lily = X", commandText: "x", authorId: OWNER, isDm: false }), DM_ONLY_NOTE);
  assert.deepEqual(loadVc().nicknames, {});

  const viaRouter = await buildChatReply("Julukan VC Lily = Cece Mantap", { isBotChannel: true, isDm: true, channelId: "dm-1", authorId: OWNER });
  assert.match(viaRouter, /Cece Mantap/);
  assert.equal(loadVc().nicknames.jkt48_lily, "Cece Mantap");
});

// ---------------------------------------------------------------------------
// Keamanan keluaran
// ---------------------------------------------------------------------------

test("pesan rangkuman dikirim tanpa mention (allowedMentions kosong) walau nama/julukan memuat @everyone", async () => {
  const sent = [];
  const realSend = dm.send;
  dm.send = async (payload) => {
    sent.push(payload);
    return realSend(payload);
  };
  await btn("vc_flow:add");
  await mod("vc_modal:search", { member_query: "@everyone Bahaya" });
  await btn("vc_flow:manual");
  await sel("vc_select:date", [DATE]);
  await sel("vc_select:session", ["2"]);
  await mod("vc_modal:form", GOOD_FORM);
  await handleVcCommand({ rawText: "julukan vc @everyone Bahaya = @here halo", commandText: "x", authorId: OWNER, isDm: true });
  assert.ok(sent.length >= 1);
  assert.ok(sent.every((p) => p.allowedMentions && p.allowedMentions.parse.length === 0));
  assert.ok(!/(^|[^\\])@(everyone|here)/.test(summaryText()), "tidak ada @everyone/@here yang aktif di teks");
});
