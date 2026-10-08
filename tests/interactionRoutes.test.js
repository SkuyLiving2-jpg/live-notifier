require("./helpers/setupTestEnv");

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { dispatchInteraction, findInteractionRoute, INTERACTION_ROUTES } = require("../src/chat/interactionRoutes");
const { handleReplyCloseButton } = require("../src/chat/interactionHelpers");
const { handleChartButton } = require("../src/chat/chartReply");
const { handleCompareCountSelect } = require("../src/chat/compareFlow");
const { handleFallbackExtraSelect } = require("../src/chat/menu");
const { handleRecapDateSelect, handleRecapJumpModalSubmit } = require("../src/chat/replies");

// Interaksi palsu: cuma method pengecek jenis + customId, seperti yang dipakai dispatcher.
function fakeInteraction(kind, customId) {
  return {
    customId,
    isChatInputCommand: () => false,
    isAutocomplete: () => false,
    isButton: () => kind === "button",
    isStringSelectMenu: () => kind === "select",
    isModalSubmit: () => kind === "modal",
  };
}

const sampleId = (route) => (route.exact !== undefined ? route.exact : `${route.prefix}contoh`);

test("tabel rute - bentuknya valid dan tidak ada baris ganda", () => {
  assert.ok(INTERACTION_ROUTES.length >= 20);
  const seen = new Set();
  for (const route of INTERACTION_ROUTES) {
    assert.ok(["button", "select", "modal"].includes(route.kind), `kind aneh: ${route.kind}`);
    assert.equal(typeof route.handler, "function");
    assert.ok((route.exact === undefined) !== (route.prefix === undefined), "tiap baris harus punya tepat satu dari exact/prefix");
    const key = `${route.kind}:${route.exact ?? route.prefix}`;
    assert.ok(!seen.has(key), `baris ganda: ${key}`);
    seen.add(key);
  }
});

test("tiap baris bisa dicapai - customId contohnya jatuh ke baris itu sendiri (tidak dibayangi baris lain)", () => {
  for (const route of INTERACTION_ROUTES) {
    const found = findInteractionRoute(fakeInteraction(route.kind, sampleId(route)));
    assert.equal(found, route, `${route.kind} ${sampleId(route)} dibayangi baris lain`);
  }
});

test("jenis interaksi harus cocok - tombol dengan id dropdown tidak dirutekan, dan sebaliknya", () => {
  assert.equal(findInteractionRoute(fakeInteraction("button", "fallback_select:4")), undefined);
  assert.equal(findInteractionRoute(fakeInteraction("select", "fallback_menu:x")), undefined);
  assert.equal(findInteractionRoute(fakeInteraction("modal", "role_flow:x")), undefined);
});

test("customId asing atau kosong tidak dirutekan dan tidak melempar", async () => {
  for (const id of ["", "tidak_dikenal:1", "reply_close_extra", "compare_countX"]) {
    assert.equal(findInteractionRoute(fakeInteraction("button", id)), undefined, `button ${id}`);
    assert.equal(findInteractionRoute(fakeInteraction("select", id)), undefined, `select ${id}`);
  }
  await dispatchInteraction(fakeInteraction("button", "tidak_dikenal:1")); // tidak melempar
});

test("kecocokan exact vs prefix sesuai rantai lama", () => {
  // exact: tidak boleh ikut nyangkut kalau ada ekor tambahan
  assert.equal(findInteractionRoute(fakeInteraction("button", "reply_close")).handler, handleReplyCloseButton);
  assert.equal(findInteractionRoute(fakeInteraction("button", "reply_close:1")), undefined);
  assert.equal(findInteractionRoute(fakeInteraction("select", "compare_count")).handler, handleCompareCountSelect);
  assert.equal(findInteractionRoute(fakeInteraction("select", "compare_count:2")), undefined);
  assert.equal(findInteractionRoute(fakeInteraction("select", "fallback_extra_select")).handler, handleFallbackExtraSelect);
  // prefix tanpa ":" - dropdown rekap membawa origin ("recap_date_select:recapmenu")
  assert.equal(findInteractionRoute(fakeInteraction("select", "recap_date_select")).handler, handleRecapDateSelect);
  assert.equal(findInteractionRoute(fakeInteraction("select", "recap_date_select:recapmenu")).handler, handleRecapDateSelect);
  assert.equal(findInteractionRoute(fakeInteraction("modal", "recap_jump_modal:1")).handler, handleRecapJumpModalSubmit);
  assert.equal(findInteractionRoute(fakeInteraction("button", "chart_flow:abc")).handler, handleChartButton);
});

test("dispatchInteraction - memanggil handler baris yang cocok, tepat sekali, dengan interaksinya", async () => {
  const route = INTERACTION_ROUTES.find((r) => r.exact === "reply_close");
  const original = route.handler;
  const calls = [];
  route.handler = async (interaction) => calls.push(interaction);
  try {
    const interaction = fakeInteraction("button", "reply_close");
    await dispatchInteraction(interaction);
    assert.equal(calls.length, 1);
    assert.equal(calls[0], interaction);
    await dispatchInteraction(fakeInteraction("button", "role_flow:x")); // baris lain: handler ini tidak dipanggil
    assert.equal(calls.length, 1);
  } finally {
    route.handler = original;
  }
});

test("dispatchInteraction - error dari handler diteruskan ke pemanggil (ditangani wireDiscordEvents)", async () => {
  const route = INTERACTION_ROUTES.find((r) => r.exact === "reply_close");
  const original = route.handler;
  route.handler = async () => {
    throw new Error("boom");
  };
  try {
    await assert.rejects(() => dispatchInteraction(fakeInteraction("button", "reply_close")), /boom/);
  } finally {
    route.handler = original;
  }
});
