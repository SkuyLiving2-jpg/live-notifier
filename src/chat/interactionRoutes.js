const { handleSlashCommand, handleSlashAutocomplete } = require("./slashCommands");
const { handleMemberChannelFallbackButton } = require("./memberChannelReply");
const { handleComparePickButton, handleCompareModalSubmit, handleCompareSelect, handleCompareCountSelect } = require("./compareFlow");
const { handleReplyCloseButton } = require("./interactionHelpers");
const { handleRoleFlowButton, handleRoleFlowSelect } = require("./roleFlow");
const { handleChartButton } = require("./chartReply");
const { handleAliasFlowButton, handleAliasFlowModalSubmit, handleAliasFlowSelect } = require("./aliasFlow");
const {
  handleRecapNavButton,
  handleRecapSearchModalSubmit,
  handleRecapMemberModalSubmit,
  handleRecapJumpModalSubmit,
  handleRecapMenuButton,
  handleRecapDateSelect,
  handleRecapMonthSelect,
  handleRecapMemberDateSelect,
} = require("./replies");
const { handleFallbackMenuButton, handleFallbackMemberSelect, handleFallbackExtraSelect, handleWatchConfirmButton } = require("./menu");

// ---------------------------------------------------------------------------
// Dispatcher tombol / dropdown / modal Discord: customId -> handler.
//
// Dulu ini rantai if/else ~26 cabang di dalam wireDiscordEvents. Sekarang tabel:
// satu baris per handler, jadi menambah tombol baru = menambah satu baris, dan
// tabelnya bisa dites langsung (tests/interactionRoutes.test.js).
//
// Aturan pencocokan sama persis dengan rantai lama: baris dicoba BERURUTAN, yang
// pertama cocok jalan; jenis interaksi dicek dulu (isButton/isStringSelectMenu/
// isModalSubmit), baru customId-nya. `prefix` = startsWith, `exact` = ===.
//
// Slash command dan autocomplete SENGAJA ditangani sebelum tabel: itu kelas
// interaksi yang beda sama sekali (ChatInputCommandInteraction gak punya
// `.customId`, dan autocomplete dijawab lewat `interaction.respond()`, bukan `.reply()`).
// ---------------------------------------------------------------------------

const KIND_CHECKS = {
  button: (interaction) => interaction.isButton(),
  select: (interaction) => interaction.isStringSelectMenu(),
  modal: (interaction) => interaction.isModalSubmit(),
};

const INTERACTION_ROUTES = [
  { kind: "button", prefix: "fallback_menu:", handler: handleFallbackMenuButton },
  { kind: "select", prefix: "fallback_select:", handler: handleFallbackMemberSelect },
  // Dropdown "❓ Fitur lainnya" (EXTRA_FEATURES, menu.js): customId beda skema dari
  // "fallback_select:<4|9>" SENGAJA (milih FITUR, bukan nama member), dan exact match
  // karena gak ada suffix yang nempel.
  { kind: "select", exact: "fallback_extra_select", handler: handleFallbackExtraSelect },
  { kind: "button", prefix: "member_fallback:", handler: handleMemberChannelFallbackButton },
  { kind: "button", prefix: "recap_nav:", handler: handleRecapNavButton },
  { kind: "modal", prefix: "recap_search_modal:", handler: handleRecapSearchModalSubmit },
  { kind: "modal", prefix: "recap_member_modal:", handler: handleRecapMemberModalSubmit },
  { kind: "modal", prefix: "recap_jump_modal:", handler: handleRecapJumpModalSubmit },
  { kind: "button", prefix: "recap_menu:", handler: handleRecapMenuButton },
  // startsWith tanpa ":" (bukan exact) - BUG YANG DILAPORIN OWNER (tombol "🔙 Kembali",
  // lihat replies/recap/components.js's buildBackRow/withOrigin): customId dropdown ini bisa bawa origin
  // tambahan ("recap_date_select:recapmenu"), bukan cuma "recap_date_select" polos.
  { kind: "select", prefix: "recap_date_select", handler: handleRecapDateSelect },
  { kind: "select", prefix: "recap_month_select", handler: handleRecapMonthSelect },
  // Dropdown "📅 Cari tanggal" di rekap per member (customId: recap_member_date:<username>[:<origin>]).
  { kind: "select", prefix: "recap_member_date:", handler: handleRecapMemberDateSelect },
  { kind: "button", prefix: "watch_confirm:", handler: handleWatchConfirmButton },
  { kind: "button", prefix: "compare_pick:", handler: handleComparePickButton },
  { kind: "modal", prefix: "compare_modal:", handler: handleCompareModalSubmit },
  { kind: "select", exact: "compare_count", handler: handleCompareCountSelect },
  { kind: "select", prefix: "compare_select:", handler: handleCompareSelect },
  { kind: "button", exact: "reply_close", handler: handleReplyCloseButton },
  { kind: "button", prefix: "chart_flow:", handler: handleChartButton },
  { kind: "button", prefix: "role_flow:", handler: handleRoleFlowButton },
  { kind: "select", prefix: "role_select:", handler: handleRoleFlowSelect },
  { kind: "button", prefix: "alias_flow:", handler: handleAliasFlowButton },
  { kind: "modal", prefix: "alias_modal:", handler: handleAliasFlowModalSubmit },
  { kind: "select", prefix: "alias_select:", handler: handleAliasFlowSelect },
];

function matchesCustomId(route, customId) {
  return route.exact !== undefined ? customId === route.exact : customId.startsWith(route.prefix);
}

// Balikin rute yang cocok buat interaksi tombol/dropdown/modal ini, atau undefined.
function findInteractionRoute(interaction) {
  return INTERACTION_ROUTES.find((route) => KIND_CHECKS[route.kind](interaction) && matchesCustomId(route, interaction.customId));
}

async function dispatchInteraction(interaction) {
  // Slash command ("/live", "/rekap", dst - chat/slashCommands.js).
  if (interaction.isChatInputCommand()) return await handleSlashCommand(interaction);
  // Saran autocomplete buat opsi "member"/"target" pas user lagi ngetik di slash command
  // manapun (lihat AUTOCOMPLETE_OPTION_NAMES di slashCommands.js).
  if (interaction.isAutocomplete()) return await handleSlashAutocomplete(interaction);

  const route = findInteractionRoute(interaction);
  if (route) await route.handler(interaction);
}

module.exports = { dispatchInteraction, findInteractionRoute, INTERACTION_ROUTES };
