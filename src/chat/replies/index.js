// Pintu masuk tunggal jawaban chat. Isinya dipecah per topik di folder ini (recap/ untuk semua yang berhubungan
// dengan rekap); file ini hanya menyatukan ekspor publik supaya pemanggil cukup require("./replies").
// Modul di dalam folder ini saling require LANGSUNG (bukan lewat file ini) - lihat ARCHITECTURE.md.

const {
  COMPARE_CLOSE_ID,
  buildCompareCloseRow,
  sameMemberMessage,
  replyCompareMembers,
  replyCompareMembersByUsername,
  replyCompareMembersMultiByUsername,
  MAX_COMPARE_MEMBERS,
  replyCompareMembersMulti,
} = require("./compare");
const { buildExportCsv, replyExportRecap } = require("./export");
const { replyGifterSnapshot, replyGifterSnapshotByUsername } = require("./gifter");
const {
  replyListLive,
  replyBotStatus,
  replySpecificMember,
  replyMemberNotFound,
  replyHelp,
  replyPriorityList,
  replyMySubscriptions,
} = require("./info");
const { replyLiveCount, replyLiveCountWithRecap } = require("./liveCount");
const { resolveRecapMember, normalizeMemberFragment, isKnownMemberFragment, describeMissingMember } = require("./memberLookup");
const { replyStreak, replyMemberStats } = require("./memberStats");
const { isOwner, handleAddPriority, handleRemovePriority, handleAddAlias, handleRemoveAlias, replyAliasList } = require("./priorityAlias");
const {
  replyLongestLiveForRange,
  replyLongestLive,
  replyTopViewersForRange,
  replyTopViewers,
  replyLiveCountLeaderboard,
  replyLongestNotLiveLeaderboard,
} = require("./rankings");
const { buildRecapDateSelectRow, buildWeekdayDateSelectRow, buildRecapMonthSelectRow, buildRecapPageBlock } = require("./recap/components");
const {
  parseSpecificDateFromText,
  parseMonthOnlyFromText,
  parseRelativePeriodFromText,
  findImpossibleDateInText,
  replyImpossibleDate,
  replyUnsupportedPeriod,
  parseWeekdayFromText,
  resolveStatRangeFromText,
} = require("./recap/dateParsing");
const { replyRecapMember, handleRecapMemberDateSelect, replyRecapMemberInRange, handleRecapMemberModalSubmit } = require("./recap/member");
const {
  extractRecapMemberFragment,
  extractMemberFromPeriodText,
  findMultipleKnownMembers,
  replyOneMemberOnly,
  replyMemberWeekdayUnsupported,
  resolveMemberPeriod,
} = require("./recap/memberText");
const { handleRecapMenuButton, handleRecapDateSelect, handleRecapMonthSelect, handleRecapSearchModalSubmit } = require("./recap/menu");
const { tryHandleRecapPageShortcut, handleRecapNavButton, handleRecapJumpModalSubmit } = require("./recap/navigation");
const { replyRecapDatePicker, replyRecapMenu } = require("./recap/screens");
const { getTodaySessionsForRecap, getAvailableRecapMonths } = require("./recap/sessions");
const { buildRecapTablePage } = require("./recap/table");
const {
  replyTodayRecapSoFar,
  replyRecapRange,
  replyRecapMonth,
  replyRecapMonthGeneric,
  replyRecapSpecificDate,
  replyRecapWeekdayPicker,
} = require("./recap/views");
const { replySchedulePattern, isTodayScheduleFragment, replyScheduleToday } = require("./schedule");
const { handleSubscribe, handleUnsubscribe } = require("./subscribe");

module.exports = {
  // compare
  COMPARE_CLOSE_ID,
  buildCompareCloseRow,
  sameMemberMessage,
  replyCompareMembers,
  replyCompareMembersByUsername,
  replyCompareMembersMultiByUsername,
  MAX_COMPARE_MEMBERS,
  replyCompareMembersMulti,
  // export
  buildExportCsv,
  replyExportRecap,
  // gifter
  replyGifterSnapshot,
  replyGifterSnapshotByUsername,
  // info
  replyListLive,
  replyBotStatus,
  replySpecificMember,
  replyMemberNotFound,
  replyHelp,
  replyPriorityList,
  replyMySubscriptions,
  // liveCount
  replyLiveCount,
  replyLiveCountWithRecap,
  // memberLookup
  resolveRecapMember,
  normalizeMemberFragment,
  isKnownMemberFragment,
  describeMissingMember,
  // memberStats
  replyStreak,
  replyMemberStats,
  // priorityAlias
  isOwner,
  handleAddPriority,
  handleRemovePriority,
  handleAddAlias,
  handleRemoveAlias,
  replyAliasList,
  // rankings
  replyLongestLiveForRange,
  replyLongestLive,
  replyTopViewersForRange,
  replyTopViewers,
  replyLiveCountLeaderboard,
  replyLongestNotLiveLeaderboard,
  // recap/components
  buildRecapDateSelectRow,
  buildWeekdayDateSelectRow,
  buildRecapMonthSelectRow,
  buildRecapPageBlock,
  // recap/dateParsing
  parseSpecificDateFromText,
  parseMonthOnlyFromText,
  parseRelativePeriodFromText,
  findImpossibleDateInText,
  replyImpossibleDate,
  replyUnsupportedPeriod,
  parseWeekdayFromText,
  resolveStatRangeFromText,
  // recap/member
  replyRecapMember,
  handleRecapMemberDateSelect,
  replyRecapMemberInRange,
  handleRecapMemberModalSubmit,
  // recap/memberText
  extractRecapMemberFragment,
  extractMemberFromPeriodText,
  findMultipleKnownMembers,
  replyOneMemberOnly,
  replyMemberWeekdayUnsupported,
  resolveMemberPeriod,
  // recap/menu
  handleRecapMenuButton,
  handleRecapDateSelect,
  handleRecapMonthSelect,
  handleRecapSearchModalSubmit,
  // recap/navigation
  tryHandleRecapPageShortcut,
  handleRecapNavButton,
  handleRecapJumpModalSubmit,
  // recap/screens
  replyRecapDatePicker,
  replyRecapMenu,
  // recap/sessions
  getTodaySessionsForRecap,
  getAvailableRecapMonths,
  // recap/table
  buildRecapTablePage,
  // recap/views
  replyTodayRecapSoFar,
  replyRecapRange,
  replyRecapMonth,
  replyRecapMonthGeneric,
  replyRecapSpecificDate,
  replyRecapWeekdayPicker,
  // schedule
  replySchedulePattern,
  isTodayScheduleFragment,
  replyScheduleToday,
  // subscribe
  handleSubscribe,
  handleUnsubscribe,
};
