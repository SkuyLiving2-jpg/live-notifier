const { findMemberByNameFragment } = require("../storage/activeLives");
const { findDurationHistoryByNameFragment } = require("../storage/durationHistory");
const { getUsernameForChannel } = require("../storage/channelRouting");
const { containsWholeWord, stripTrailingLiveWord, formatRelativeTime, formatDuration, getTodayWIB } = require("../utils");
const { tryHandleWatchConfirmShortcut, replyFallbackMenu } = require("./menu");
const { markMenuShown, tryHandleMenuShortcut, tryHandleMemberPromptShortcut } = require("./pendingState");
const { replyMemberChannelFallback } = require("./memberChannelReply");
const { replyStartComparePick } = require("./compareFlow");
const { getDiscordClient } = require("../discordClient");
const { withCloseButton } = require("./interactionHelpers");
const {
  buildRolePanel,
  syncRolePanel,
  handleAddMemberRoleCommand,
  handleRemoveMemberRoleCommand,
  replyRoleDiagnostics,
  replyRoleList,
  buildAllLiveConfirm,
  OWNER_NO_ALL_ROLE_NOTE,
} = require("./roleFlow");
const { replyDurationChart } = require("./chartReply");
const { replyViewerChart } = require("./viewerChart");
const { tryHandlePersonalCommand } = require("./personalFlow");
const { tryHandleGuessCommand } = require("./guessFlow");
const { suggestCommand } = require("./commandSuggest");
const { replyWrapped } = require("./wrappedCard");
const { touchLastSeen } = require("../storage/userPrefs");
const { replyCekMember } = require("./slashCommands");
const { buildAliasListBlock } = require("./aliasFlow");
const {
  replyListLive,
  replyLongestLive,
  replyLongestLiveForRange,
  replyTopViewers,
  replyTopViewersForRange,
  resolveStatRangeFromText,
  replyExportRecap,
  replyCompareMembers,
  replyCompareMembersMulti,
  replyBotStatus,
  replySpecificMember,
  replyHelp,
  isOwner,
  replyPriorityList,
  replyMySubscriptions,
  replyMemberStats,
  replyLiveCount,
  replyLiveCountLeaderboard,
  replyLongestNotLiveLeaderboard,
  replySchedulePattern,
  replyGifterSnapshot,
  replyTodayRecapSoFar,
  replyScheduleToday,
  isTodayScheduleFragment,
  replyRecapRange,
  replyRecapMenu,
  replyRecapDatePicker,
  replyRecapMonth,
  replyRecapMonthGeneric,
  replyRecapSpecificDate,
  replyRecapWeekdayPicker,
  parseSpecificDateFromText,
  parseRelativePeriodFromText,
  replyUnsupportedPeriod,
  findImpossibleDateInText,
  replyImpossibleDate,
  extractMemberFromPeriodText,
  findMultipleKnownMembers,
  replyOneMemberOnly,
  replyMemberWeekdayUnsupported,
  resolveMemberPeriod,
  replyRecapMemberInRange,
  parseMonthOnlyFromText,
  parseWeekdayFromText,
  tryHandleRecapPageShortcut,
  replyRecapMember,
  replyStreak,
  extractRecapMemberFragment,
  handleAddPriority,
  handleRemovePriority,
  isKnownMemberFragment,
  handleAddAlias,
  handleRemoveAlias,
  handleSubscribe,
  handleUnsubscribe,
} = require("./replies");

// ---------------------------------------------------------------------------
// Router perintah chat: teks pesan -> balasan.
//
// Bentuknya "chain of responsibility": ROUTES di bawah adalah daftar langkah
// BERURUTAN, tiap langkah satu fungsi kecil bernama yang menerima konteks pesan
// (`ctx`) dan balikin:
//   - NO_MATCH  -> langkah ini gak berlaku buat pesan ini, lanjut ke langkah berikut;
//   - nilai lain (termasuk null) -> itu balasannya, berhenti di sini.
// Kalau semua langkah NO_MATCH, jatuh ke buildFallbackReply (menu bantuan).
//
// URUTAN ADALAH BAGIAN DARI LOGIKA: pola yang lebih spesifik harus di atas pola
// yang lebih umum ("berhenti ingetin" sebelum "ingetin", "export rekap" sebelum
// "rekap", dst - alasan tiap kasus ada di komentar langkahnya). Sebelum ini
// semuanya satu fungsi ~600 baris; dipecah supaya tiap aturan bisa dibaca,
// dites, dan dipindah sendiri-sendiri. Perilakunya SAMA persis dengan versi
// lama (dijaga tes golden-master + tes router yang sudah ada).
// ---------------------------------------------------------------------------

const NO_MATCH = Symbol("no-match");

// Kata kunci buat manggil bot di chat (contoh: "Cok, ini yang masih live
// siapa aja?"). Pesan yang nggak nyebut salah satu kata ini bakal diabaikan,
// biar bot nggak ikut respon ke obrolan biasa di channel.
const CHAT_WAKE_WORDS = ["cok"];
// Kata-kata yang nunjukkin pesannya kemungkinan nanya soal live, walau nggak
// nyebut "cok" sama sekali (misal "siapa yang live?"). Supaya nggak ke-trigger
// tiap kali kata "live" muncul di obrolan biasa, ini cuma dianggap "nanya ke
// bot" kalau ada tanda tanya atau kata tanya juga di pesannya.
const TOPIC_WORDS = ["live"];
const QUESTION_HINTS = ["?", "siapa", "apa", "gimana", "kapan", "berapa"];

const CHART_HINT = 'Ketik `grafik <nama member>` ya (atau "chart <nama>"), contoh: "grafik nala".';
const STATS_HINT = 'Ketik `stats <nama member>` ya, contoh: "stats nala".';
const BARE_KEYWORD_HINTS = {
  grafik: CHART_HINT,
  chart: CHART_HINT,
  stats: STATS_HINT,
  stat: STATS_HINT,
  statistik: STATS_HINT,
  streak: 'Ketik `streak <nama member>` ya, contoh: "streak nala".',
  jadwal: 'Ketik `jadwal <nama member>` ya (atau "kapan <nama> biasanya live?"), contoh: "jadwal nala".',
  gifter: 'Ketik `gifter <nama member>` ya, contoh: "gifter nala".',
  ingetin:
    'Ketik `ingetin <nama member>` ya - nanti kamu di-tag pas dia mulai live. Contoh: "ingetin nala" (atau beberapa sekaligus: "ingetin nala dan lily").',
  "berhenti ingetin":
    'Ketik `berhenti ingetin <nama member>` ya, contoh: "berhenti ingetin nala". Mau liat daftar reminder kamu? Ketik "reminder aku".',
  "tambah prioritas": 'Khusus owner: ketik `tambah prioritas <nama member>`, contoh: "tambah prioritas kimmy".',
  "hapus prioritas": 'Khusus owner: ketik `hapus prioritas <nama member>`, contoh: "hapus prioritas kimmy".',
};

// Kata umum yang bisa nyangkut di posisi "nama" pola status-member
// ("siapa yang live", "masih live?", "status bot") - bukan nama member.
const MEMBER_QUERY_STOPWORDS = new Set([
  "masih", "lagi", "lg", "sedang", "udah", "sudah", "yang", "siapa", "ada", "apa", "kapan",
  "gak", "nggak", "belum", "semua", "member", "bot", "live", "cok", "dia", "kamu", "aku",
]); // prettier-ignore

// Perintah yang mengatur role server - gak ada artinya (dan gak bisa jalan) di DM.
const ROLE_COMMAND_IN_DM = /\brole\b|\bnotif(?:ikasi)?\s+(?:live\s+)?semua\b/;
const DM_ROLE_NOTE = "Cok, perintah role cuma bisa dipakai di server (bukan lewat DM). Buka channel role di server buat milih notifmu.";

const NOT_LIVE_NEGATION_WORDS = ["gak", "nggak", "enggak", "tidak", "belum"];

// Pemisah daftar nama pada perintah banding ("nala, lily, dan levi" / "nala & lily").
const COMPARE_LIST_SPLIT = /\s*,\s*(?:dan\s+)?|\s+dan\s+|\s*&\s*/;

// Konteks satu pesan. `dedicatedUsername` diisi routeWakeGate (channel khusus satu member).
function buildContext(rawContent, { isBotChannel = false, channelId = null, authorId = null, isDm = false } = {}) {
  const text = (rawContent || "").toLowerCase().trim();
  return {
    text,
    // Wake-word "cok" dibuang dari AWAL kalimat buat pola-pola yang nempatin
    // nama member DULUAN (mis. "lily berapa kali live?") - tanpa ini, capture
    // group yang gak dianchor bisa "kebablasan" ngambil "cok" juga jadi bagian
    // dari nama ("cok lily" alih-alih "lily"). Pola yang nempatin keyword-nya
    // DULUAN ("berapa kali lily live?", "jadwal lily", dst) gak kepengaruh sama
    // sekali - regex mereka nyari kata kuncinya duluan.
    commandText: text.replace(/^cok[,.!?]?\s+/, ""),
    channelId,
    authorId,
    isBotChannel,
    isDm,
    dedicatedUsername: null,
  };
}

async function firstMatch(steps, ctx) {
  for (const step of steps) {
    const result = await step(ctx);
    if (result !== NO_MATCH) return result;
  }
  return NO_MATCH;
}

// Langkah yang cuma mau "jawab kalau hasilnya truthy" (shortcut pending-state).
const truthyOrNoMatch = (reply) => (reply ? reply : NO_MATCH);

// ============================ 1. Gerbang awal ===============================

function routeDmRoleNote({ text, isDm }) {
  return isDm && ROLE_COMMAND_IN_DM.test(text) ? DM_ROLE_NOTE : NO_MATCH;
}

function routeWatchConfirmShortcut({ text, channelId, authorId }) {
  return truthyOrNoMatch(tryHandleWatchConfirmShortcut(text, channelId, authorId));
}

// Dicek abis watchConfirm - kalau kebetulan dua-duanya lagi pending buat
// orang yang sama, jawaban "y"-nya kepake buat yang pertama diminta duluan.
async function routeRecapPageShortcut({ text, channelId, authorId }) {
  return truthyOrNoMatch(await tryHandleRecapPageShortcut(text, channelId, authorId));
}

function routeMemberPromptShortcut({ text, channelId, authorId }) {
  return truthyOrNoMatch(tryHandleMemberPromptShortcut(text, channelId, authorId));
}

async function routeMenuShortcut({ text, channelId, authorId }) {
  return truthyOrNoMatch(await tryHandleMenuShortcut(text, channelId, authorId));
}

// "notif live semua" (juga "notif semua"/"notifikasi live semua member") -
// frasa yang SPESIFIK dan dicek dari SELURUH pesan, jadi jalan di channel
// manapun tanpa "cok" (member baru biasanya cuma bisa ngetik di channel
// tertentu). Dijawab konfirmasi "Yakin?" + tombol Ya/Tidak (chat/roleFlow.js).
function routeNotifAllLive({ text, authorId }) {
  if (!authorId || !/^(?:cok[,.!?]?\s+)?(?:tolong\s+)?notif(?:ikasi)?\s+(?:live\s+)?semua(?:\s+member)?[?!.\s]*$/.test(text)) return NO_MATCH;
  // Owner gak perlu role ini (udah lihat semua channel) - jangan ditawarin.
  return isOwner(authorId) ? OWNER_NO_ALL_ROLE_NOTE : buildAllLiveConfirm(authorId);
}

// Gerbang "apakah pesan ini ditujukan ke bot?". Pesan biasa tanpa "cok" diabaikan (null).
function routeWakeGate(ctx) {
  // Channel khusus SATU member (storage/channelRouting.js's getUsernameForChannel)
  // dihitung di sini karena dipakai dua kali: buat nentuin mentionsBot DAN di
  // fallback paling bawah. BUG SEBELUMNYA: channel ini dulu masih kena gerbang
  // wake-word biasa, jadi orang yang ngetik tanpa "cok" di channel yang emang
  // KHUSUS buat 1 member bakal diem-diem gak dijawab (keliatan kayak bot rusak).
  ctx.dedicatedUsername = ctx.channelId ? getUsernameForChannel(ctx.channelId) : null;

  // Di channel khusus bot ATAU channel khusus member, hampir semua pesan
  // dianggap "ditujukan ke bot" - gak perlu nyebut "cok" atau "live" dulu.
  const mentionsBot = ctx.isBotChannel || Boolean(ctx.dedicatedUsername) || CHAT_WAKE_WORDS.some((w) => containsWholeWord(ctx.text, w));
  const looksLikeLiveQuestion =
    TOPIC_WORDS.some((w) => containsWholeWord(ctx.text, w)) &&
    QUESTION_HINTS.some((w) => (w === "?" ? ctx.text.includes("?") : containsWholeWord(ctx.text, w)));
  return !mentionsBot && !looksLikeLiveQuestion ? null : NO_MATCH;
}

// "minggu lalu" gak didukung dan tanggal mustahil ("31 februari") ditolak
// EKSPLISIT sebelum semua cabang rekap/export/paling-lama/paling-rame di bawah -
// dulu keduanya diam-diam dijawab pakai data lain ("minggu ini" / "rekap bulan Februari").
function routePeriodGuards({ text }) {
  const asksPeriodStat = ["rekap", "export", "paling", "viewer", "penonton"].some((w) => containsWholeWord(text, w));
  if (!asksPeriodStat) return NO_MATCH;
  if (parseRelativePeriodFromText(text)?.kind === "unsupported") return replyUnsupportedPeriod();
  const impossibleDate = findImpossibleDateInText(text);
  return impossibleDate ? replyImpossibleDate(impossibleDate) : NO_MATCH;
}

// ===================== 2. Fitur personal & mini-game ========================

// Perintah personal (oshi, pengaturan notif, jam tenang, ringkasan, kelewat) -
// chat/personalFlow.js. Dicek sebelum perintah lain biar kata-kata umumnya
// ("oshi", "notif") gak ketangkep cabang lain.
async function routePersonalCommand({ text, commandText, authorId }) {
  const reply = await tryHandlePersonalCommand(text, commandText, authorId);
  return reply !== null ? withCloseButton(reply) : NO_MATCH;
}

// Mini-game tebak-tebakan (chat/guessFlow.js): "tebak <nama> <menit>", "tebak berikutnya <nama>", "papan tebak".
async function routeGuessCommand({ commandText, authorId }) {
  const reply = await tryHandleGuessCommand(commandText, authorId);
  return reply !== null ? withCloseButton(reply) : NO_MATCH;
}

// "cok wrapped" / "cok wrapped <nama>" - kartu rangkuman 30 hari (chat/wrappedCard.js).
async function routeWrapped({ commandText }) {
  const match = commandText.match(/^(?:kartu\s+)?wrapped(?:\s+(.+?))?[?!.\s]*$/);
  return match ? await replyWrapped(match[1] || "") : NO_MATCH;
}

// ===================== 3. Prioritas, role, alias ============================

function routeAddPriority({ text, authorId }) {
  const match = text.match(/tambah(?:in|kan)?\s+prioritas\s+(.+)/);
  return match ? handleAddPriority(match[1], authorId) : NO_MATCH;
}

function routeRemovePriority({ text, authorId }) {
  const match = text.match(/hapus\s+prioritas\s+(.+)/);
  return match ? handleRemovePriority(match[1], authorId) : NO_MATCH;
}

// "pasang panel role" = owner masang panel PERMANEN (tanpa Tutup) di channel ini
// (chat/roleFlow.js).
async function routeInstallRolePanel({ text, authorId, channelId }) {
  if (!/pasang\s+panel\s+role/.test(text)) return NO_MATCH;
  if (!isOwner(authorId)) return "Cok, cuma owner yang boleh masang panel role.";
  const discordClient = getDiscordClient();
  // Tanpa client (bot belum login) jatuh ke perilaku lama: balikin panelnya
  // buat dikirim sebagai balasan biasa.
  if (!discordClient || !channelId) return buildRolePanel();
  const result = await syncRolePanel(discordClient, channelId);
  if (!result.ok)
    return `Cok, gagal masang panel di channel ini: ${result.error}. Cek izin bot di channel itu (View Channel, Send Messages, Read Message History).`;
  if (result.action === "edited") return "✅ Panel role diperbarui - pesan panel yang lama di-edit, gak dobel.";
  return result.moved
    ? "✅ Panel role dipasang di channel ini (panel lama di channel sebelumnya dihapus)."
    : "✅ Panel role dipasang. Selanjutnya panel ini di-edit otomatis, gak bakal numpuk.";
}

// "role"/"atur role"/"role notif" polos = siapa aja boleh munculin panel
// sementara (ada Tutup) - klik tombolnya buka pilihan pribadi (ephemeral).
function routePlainRolePanel({ commandText }) {
  return /^(?:atur\s+|ambil\s+|minta\s+)?role(?:\s+notif)?[?!.\s]*$/.test(commandText) ? buildRolePanel({ closable: true }) : NO_MATCH;
}

// Owner daftarin role tiap member (role yang sama yang ngatur akses channel
// privat member itu): "tambah role aralie @Aralie" / "hapus role aralie" /
// "daftar role". "semua" = role notif semua member.
async function routeAddMemberRole({ text, authorId, channelId }) {
  const match = text.match(/tambah(?:in|kan)?\s+role\b(.*)$/);
  return match ? await handleAddMemberRoleCommand(match[1], authorId, channelId) : NO_MATCH;
}

async function routeRemoveMemberRole({ text, authorId }) {
  const match = text.match(/hapus\s+role\b(.*)$/);
  return match ? await handleRemoveMemberRoleCommand(match[1], authorId) : NO_MATCH;
}

async function routeRoleDiagnostics({ text, authorId, channelId }) {
  return /\bcek\s+(?:setup\s+)?role\b/.test(text) ? await replyRoleDiagnostics(authorId, channelId) : NO_MATCH;
}

function routeRoleList({ text }) {
  return containsWholeWord(text, "daftar") && containsWholeWord(text, "role") ? replyRoleList() : NO_MATCH;
}

// "cok tambah alias <alias> = <nama asli>" - pemisahnya "=", "untuk", atau
// "buat". Dicek sebelum "hapus alias"/"daftar alias" di bawahnya, dan gak
// nabrak "tambah prioritas"/"hapus prioritas" - kata kunci "alias" vs
// "prioritas" beda persis setelah "tambah(in/kan)?"/"hapus".
async function routeAddAlias({ text, authorId }) {
  const match = text.match(/tambah(?:in|kan)?\s+alias\s+(.+?)\s*(?:=|untuk|buat)\s*(.+)/);
  return match ? await handleAddAlias(match[1], match[2], authorId) : NO_MATCH;
}

function routeRemoveAlias({ text, authorId }) {
  const match = text.match(/hapus\s+alias\s+(.+)/);
  return match ? handleRemoveAlias(match[1], authorId) : NO_MATCH;
}

// Ketikan "alias" doang (tanpa harus "daftar alias") langsung jalanin fitur
// alias - daftar + tombol Tambah/Hapus (owner-only pas diklik) + Tutup. Juga
// nangkep "tambah alias"/"hapus alias" yang formatnya belum lengkap, jadi yang
// lupa format tetep bisa lanjut lewat tombol.
function routeAliasList({ text }) {
  return containsWholeWord(text, "alias") ? buildAliasListBlock() : NO_MATCH;
}

// ========================== 4. Langganan (ingetin) ==========================

// Dicek sebelum unsubscribe/subscribe - "reminder" kata kunci beda dari
// "ingetin", tapi kalimatnya bisa ngandung dua-duanya ("cok reminder aku
// ingetin siapa aja"), biar nggak ketangkep duluan sama regex subscribe yang rakus.
function routeMySubscriptions({ text, authorId }) {
  return containsWholeWord(text, "reminder") ? replyMySubscriptions(authorId) : NO_MATCH;
}

// "berhenti ingetin" harus dicek DULUAN sebelum "ingetin" biasa, soalnya
// kalimatnya juga ngandung kata "ingetin" dan bakal ketangkep regex subscribe.
function routeUnsubscribe({ text, authorId }) {
  const match = text.match(/berhenti\s+ingetin(?:in)?\s+(?:kalau\s+|kalo\s+)?(.+)/);
  return match ? handleUnsubscribe(match[1], authorId) : NO_MATCH;
}

function routeSubscribe({ text, authorId }) {
  const match = text.match(/ingetin(?:in)?\s+(?:kalau\s+|kalo\s+)?(.+)/);
  return match ? handleSubscribe(match[1], authorId) : NO_MATCH;
}

// ===================== 5. Detail satu member ================================

function routeMemberStats({ text }) {
  const match = text.match(/stat(?:s|istik)\s+(.+)/);
  return match ? withCloseButton(replyMemberStats(match[1])) : NO_MATCH;
}

// "cok streak <nama member>" - berapa hari berturut-turut dia punya live.
async function routeStreak({ text }) {
  const match = text.match(/streak\s+(.+)/);
  return match ? withCloseButton(await replyStreak(match[1])) : NO_MATCH;
}

// "grafik penonton <nama>" (kurva penonton, chat/viewerChart.js) dicek DULUAN -
// kalau enggak, routeDurationChart di bawah nangkepnya sebagai nama member "penonton ...".
async function routeViewerChart({ text }) {
  const match = text.match(/(?:grafik|chart)\s+(?:penonton|viewers?)(?:\s+(.+))?$/);
  if (!match) return NO_MATCH;
  return match[1] ? await replyViewerChart(match[1]) : 'Ketik `grafik penonton <nama member>` ya, contoh: "grafik penonton nala".';
}

// "cok grafik <nama>"/"cok chart <nama>" - bar chart durasi live 10 sesi
// terakhir (gambar PNG, chat/chartReply.js), bukan teks/embed kayak reply lain.
async function routeDurationChart({ text }) {
  const match = text.match(/(?:grafik|chart)\s+(.+)/);
  return match ? await replyDurationChart(match[1]) : NO_MATCH;
}

// Dua cara natural buat nanya total hitungan live: "berapa kali (si) <nama> live"
// (kata tanya duluan, dicek dari `text` biasa) ATAU "<nama> (udah/sudah) berapa kali
// live" (nama duluan - dicek dari `commandText` yang wake-word-nya udah dibuang DAN
// di-anchor `^`, biar capture-nya cuma "lily", bukan "cok lily". Bug beneran yang
// dilaporin user: "lily berapa kali live?" dulu jatuh ke fallback "member gak lagi live").
function routeLiveCount({ text, commandText }) {
  const match = text.match(/berapa\s+kali\s+(?:si\s+)?(.+?)\s+live\b/) || commandText.match(/^(.+?)\s+(?:udah\s+|sudah\s+)?berapa\s+kali\s+live\b/);
  return match ? withCloseButton(replyLiveCount(match[1])) : NO_MATCH;
}

function routeGifter({ text }) {
  const match = text.match(/gifter\s+(.+)/);
  return match ? replyGifterSnapshot(match[1]) : NO_MATCH;
}

// ============================ 6. Bandingin member ===========================

// "cok bandingin A, B, dan C" - lebih dari 2 member sekaligus. Dicek SEBELUM
// routeCompareTwoWay: KOMA jadi sinyal pemicu ("ini daftar, bukan 2-way biasa")
// soalnya bentuk 2-way yang UDAH ADA gak pernah pakai koma, jadi gak bisa nabrak
// balik ke situ. Bentuk "A dan B dan C" TANPA koma SENGAJA gak didukung - susah
// dibedain dari kalimat biasa yang kebetulan nyebut "dan" berkali-kali.
async function routeCompareList({ text }) {
  const match = text.match(/\bbanding(?:in|kan)?\s+(.+)/);
  if (!match || !match[1].includes(",")) return NO_MATCH;
  const parts = match[1]
    .split(COMPARE_LIST_SPLIT)
    .map((p) => p.trim())
    .filter(Boolean);
  // Koma ada tapi ujung-ujungnya cuma nyisa 1 potongan (koma nyantol di ujung
  // kalimat, "bandingin nala,") - biarin jatuh ke langkah compare berikutnya.
  if (parts.length < 2) return NO_MATCH;
  const lastIndex = parts.length - 1;
  parts[lastIndex] = parts[lastIndex].replace(/[?!.\s]+$/, "");
  return withCloseButton(parts.length === 2 ? await replyCompareMembers(parts[0], parts[1]) : await replyCompareMembersMulti(parts));
}

// "cok bandingin <A> dan <B>" - pemisahnya SENGAJA cuma "dan" atau "&" (owner
// minta "vs"/"versus" dibuang). Kata kuncinya "bandingin"/"bandingkan"/"banding".
async function routeCompareTwoWay({ text }) {
  const match = text.match(/\bbanding(?:in|kan)?\s+(.+?)(?:\s+dan\s+|\s*&\s*)(.+)/);
  return match ? withCloseButton(await replyCompareMembers(match[1].trim(), match[2].replace(/[?!.\s]+$/, ""))) : NO_MATCH;
}

// Kata kuncinya diketik tapi pasangannya gak lengkap ("cok bandingin" polos,
// atau cuma satu nama) - dikasih flow dropdown/search 2 langkah (chat/compareFlow.js)
// daripada jatuh ke menu fallback generik.
function routeComparePicker({ text }) {
  return /\bbanding(?:in|kan)?\b/.test(text) ? replyStartComparePick() : NO_MATCH;
}

// "nala, lily, dan levi" TANPA kata "bandingin". Sama filosofinya dengan
// routeCompareList (KOMA = sinyal daftar), tapi dijaga lebih ketat: SEMUA
// potongan harus satu kata alfanumerik DAN minimal SATU dikenali sebagai member
// (isKnownMemberFragment) - supaya kalimat biasa yang kebetulan pakai koma
// ("makan, minum, dan tidur") gak salah dibajak jadi perbandingan.
async function routeBareCompareList({ commandText }) {
  if (!commandText.includes(",")) return NO_MATCH;
  const parts = commandText
    .replace(/[?!.\s]+$/, "")
    .split(COMPARE_LIST_SPLIT)
    .map((p) => p.trim());
  const isBareWordList = parts.length >= 2 && parts.every((p) => /^[a-z0-9]+$/.test(p));
  if (!isBareWordList || !parts.some((p) => isKnownMemberFragment(p))) return NO_MATCH;
  return withCloseButton(parts.length === 2 ? await replyCompareMembers(parts[0], parts[1]) : await replyCompareMembersMulti(parts));
}

// "<nama> dan <nama>" doang (owner minta "nala dan lily" langsung jadi
// perbandingan). Pola LONGGAR banget ("dan" ada di mana-mana), jadi dijaga ketat:
// persis dua kata tunggal di kiri-kanan "dan"/"&", DAN minimal salah satunya
// dikenali sebagai member (isKnownMemberFragment - bukan cuma live-count.json yang
// bisa kosong: Nala/Levi/Lily tetep selalu dikenali).
async function routeBareCompare({ commandText }) {
  const match = commandText.match(/^([a-z0-9]+)(?:\s+dan\s+|\s*&\s*)([a-z0-9]+)[?!.]*$/);
  if (!match || !(isKnownMemberFragment(match[1]) || isKnownMemberFragment(match[2]))) return NO_MATCH;
  return withCloseButton(await replyCompareMembers(match[1], match[2]));
}

// ============================ 7. Jadwal & prioritas =========================

// "cok jadwal nala" (keyword+nama kayak stats/gifter).
function routeSchedule({ text }) {
  const match = text.match(/jadwal\s+(.+)/);
  if (!match) return NO_MATCH;
  const fragment = stripTrailingLiveWord(match[1]);
  // "jadwal hari ini" = prediksi SIAPA yang kemungkinan live hari ini (bukan nama member "hari ini").
  return withCloseButton(isTodayScheduleFragment(fragment) ? replyScheduleToday() : replySchedulePattern(fragment));
}

// "cok kapan nala live/live nala" (nama-nya "keapit" di antara "kapan" dan "live").
// "biasanya" boleh sebelum ATAU sesudah nama - BUG: format yang ditulis di bantuan
// sendiri ("cok kapan <nama> biasanya live?") dulu ikut nyangkutin "biasanya" ke nama.
function routeKapanLive({ text }) {
  const match = text.match(/kapan\s+(?:biasanya\s+)?(.+?)\s+(?:biasanya\s+)?live\b/) || text.match(/kapan\s+live\s+(.+)/);
  return match ? withCloseButton(replySchedulePattern(match[1])) : NO_MATCH;
}

function routePriorityList({ text }) {
  return containsWholeWord(text, "prioritas") &&
    (containsWholeWord(text, "daftar") || containsWholeWord(text, "siapa") || containsWholeWord(text, "list"))
    ? replyPriorityList()
    : NO_MATCH;
}

// ============================ 8. Rekap & export =============================

// "cok export rekap ..." - dicek SEBELUM "rekap" polos di bawah, soalnya
// kalimatnya juga ngandung kata "rekap" (bakal ketangkep dispatch rekap biasa dan
// nunjukkin TABEL, bukan file CSV yang diminta). Rentangnya reuse
// resolveStatRangeFromText; "export rekap" doang default ke hari ini.
async function routeExportRecap({ text }) {
  return containsWholeWord(text, "export") && containsWholeWord(text, "rekap") ? withCloseButton(await replyExportRecap(text)) : NO_MATCH;
}

// Sub-langkah rekap, dicek dari yang PALING SPESIFIK ke yang PALING POLOS supaya
// kalimat yang nyebut beberapa kata kunci sekaligus (mis. "rekap per tanggal 25
// september", ngandung "tanggal" DAN tanggal spesifik) ketangkep sama check yang
// paling ngerti maksud usernya. Langkah terakhir (routeRecapMenu) selalu jawab.

// "rekap <nama> <rentang>" (mis. "rekap nala minggu ini") DULUAN - BUG: nama membernya
// dulu diabaikan dan yang keluar rekap semua member. Nama hari + member ("rekap nala
// senin") dan dua member sekaligus ("rekap nala lily minggu ini") ditolak jelas.
async function routeRecapMemberScoped({ text }) {
  const periodMember = extractMemberFromPeriodText(text);
  const memberPeriod = periodMember ? resolveMemberPeriod(text) : null;
  if (periodMember && memberPeriod) return await replyRecapMemberInRange(periodMember, memberPeriod);
  if (periodMember && parseWeekdayFromText(text) !== null) return replyMemberWeekdayUnsupported(periodMember);
  const multipleMembers = findMultipleKnownMembers(text);
  if (multipleMembers && (resolveMemberPeriod(text) || parseWeekdayFromText(text) !== null)) return replyOneMemberOnly(multipleMembers);
  return NO_MATCH;
}

// "kemarin"/"bulan lalu" DULUAN (BUG: "rekap kemarin" dulu dianggep NAMA MEMBER
// "kemarin" dan nembak IDN, "rekap bulan lalu" dijawab bulan INI).
async function routeRecapRelative({ text, channelId, authorId }) {
  const relative = parseRelativePeriodFromText(text);
  if (relative?.kind === "date") return await replyRecapSpecificDate(relative.date, channelId, authorId);
  if (relative?.kind === "month") return await replyRecapMonth(relative.month, channelId, authorId);
  return NO_MATCH;
}

// "rekap hari senin"/"rekap senin" dkk - weekday DULUAN (sebelum "rekap minggu"
// biasa), soalnya kata "minggu" (Minggu) sendiri BISA ketangkep di sini (lewat
// parseWeekdayFromText's "hari"+"minggu" khusus) - lihat komen di sana soal kenapa
// gak nabrak "rekap minggu ini" (rentang 7 hari).
async function routeRecapWeekday({ text }) {
  const weekdayIndex = parseWeekdayFromText(text);
  return weekdayIndex !== null ? await replyRecapWeekdayPicker(weekdayIndex) : NO_MATCH;
}

// Tanggal LENGKAP (hari + nama bulan, mis. "25 september") - SEBELUM cabang
// bulan/minggu, soalnya kalimat kayak gitu juga ngandung nama bulan atau kata
// "bulan"/"minggu". User yang eksplisit nyebut tanggal maunya LANGSUNG liat tabelnya.
async function routeRecapSpecificDate({ text, channelId, authorId }) {
  const specificDate = parseSpecificDateFromText(text);
  return specificDate ? await replyRecapSpecificDate(specificDate, channelId, authorId) : NO_MATCH;
}

async function routeRecapWeek({ text, channelId, authorId }) {
  return containsWholeWord(text, "minggu") ? await replyRecapRange(7, "minggu ini", channelId, authorId) : NO_MATCH;
}

// "rekap bulan ini" - eksplisit nyebut "ini", jadi SELALU langsung bulan BERJALAN,
// gak usah nanya walau nanti udah ada beberapa bulan yang punya data.
async function routeRecapThisMonth({ text, channelId, authorId }) {
  return containsWholeWord(text, "bulan") && containsWholeWord(text, "ini")
    ? await replyRecapMonth(getTodayWIB().slice(0, 7), channelId, authorId)
    : NO_MATCH;
}

// Nama bulan POLOS tanpa angka hari ("rekap september") - dicek SETELAH
// routeRecapSpecificDate, biar "rekap 25 september" gak kepotong jadi ini.
async function routeRecapNamedMonth({ text, channelId, authorId }) {
  const monthOnly = parseMonthOnlyFromText(text);
  return monthOnly ? await replyRecapMonth(monthOnly, channelId, authorId) : NO_MATCH;
}

// "rekap bulan" polos - dropdown milih bulan (atau langsung tunjukkin kalau cuma 1 bulan punya data).
async function routeRecapMonthPicker({ text, channelId, authorId }) {
  return containsWholeWord(text, "bulan") ? await replyRecapMonthGeneric(channelId, authorId) : NO_MATCH;
}

// "rekap tanggal"/"rekap per tanggal" (TANPA tanggal spesifik) -> langsung
// dropdown milih tanggal, skip menu 4-tombol.
function routeRecapDatePicker({ text }) {
  return containsWholeWord(text, "tanggal") ? replyRecapDatePicker() : NO_MATCH;
}

// "rekap hari ini"/"rekap hari" -> langsung rekap hari ini (BUKAN menu 4-tombol).
// Weekday ("rekap hari senin") udah ketangkep duluan, jadi "hari" yang nyampe sini polos.
async function routeRecapToday({ text, channelId, authorId }) {
  return containsWholeWord(text, "hari") ? await replyTodayRecapSoFar(channelId, authorId) : NO_MATCH;
}

// "rekap <nama member>" (mis. "rekap aralie") - dicek PALING AKHIR, setelah semua
// kata kunci rekap lain gagal, jadi gak pernah nabrak mereka. extractRecapMemberFragment
// ketat (tepat satu kata nama), kalimat yang gak jelas tetep jatuh ke menu.
async function routeRecapMemberName({ text, channelId, authorId }) {
  const memberFragment = extractRecapMemberFragment(text);
  return memberFragment ? await replyRecapMember(memberFragment, channelId, authorId) : NO_MATCH;
}

// "rekap" POLOS (gak nyebut minggu/bulan/tanggal/hari/nama sama sekali) -> menu tombol.
function routeRecapMenu() {
  return replyRecapMenu();
}

const RECAP_ROUTES = [
  routeRecapMemberScoped,
  routeRecapRelative,
  routeRecapWeekday,
  routeRecapSpecificDate,
  routeRecapWeek,
  routeRecapThisMonth,
  routeRecapNamedMonth,
  routeRecapMonthPicker,
  routeRecapDatePicker,
  routeRecapToday,
  routeRecapMemberName,
  routeRecapMenu,
];

async function routeRecap(ctx) {
  return containsWholeWord(ctx.text, "rekap") ? await firstMatch(RECAP_ROUTES, ctx) : NO_MATCH;
}

// ===================== 9. Leaderboard & status umum =========================

// "paling rame" polos juga diterima - itu PERSIS label tombol menunya, dulu
// diketik malah jatuh ke menu fallback. Rentang opsional ("minggu ini"/bulan/tanggal)
// lewat resolveStatRangeFromText; tanpa rentang tetap default "hari ini".
function routeTopViewers({ text }) {
  const asksTopViewers =
    ["paling rame", "paling ramai", "terame", "teramai"].some((w) => containsWholeWord(text, w)) ||
    containsWholeWord(text, "viewer") ||
    (containsWholeWord(text, "penonton") &&
      (containsWholeWord(text, "banyak") || containsWholeWord(text, "terbanyak") || containsWholeWord(text, "rame"))) ||
    (containsWholeWord(text, "ditonton") && (containsWholeWord(text, "banyak") || containsWholeWord(text, "rame")));
  if (!asksTopViewers) return NO_MATCH;
  const range = resolveStatRangeFromText(text);
  return range ? replyTopViewersForRange(range.rangeDays, range.label) : replyTopViewers();
}

// "siapa yang paling lama gak live" - kebalikan dari leaderboard "paling sering
// live". Dicek DULUAN, SEBELUM routeLongestLive: keduanya ngandung "paling lama",
// jadi yang lebih spesifik (butuh "siapa"/"paling" + kata negasi eksplisit) harus
// menang. "siapa" ATAU "paling" WAJIB ada - tanpa gerbang ini, kalimat wajar kayak
// "cok nala kok lama gak live" (nanya SATU member) ikut kebajak.
function routeLongestNotLive({ text }) {
  const asksLongestNotLive =
    (containsWholeWord(text, "siapa") || containsWholeWord(text, "paling")) &&
    containsWholeWord(text, "live") &&
    (containsWholeWord(text, "jarang") || (containsWholeWord(text, "lama") && NOT_LIVE_NEGATION_WORDS.some((w) => containsWholeWord(text, w))));
  return asksLongestNotLive ? replyLongestNotLiveLeaderboard() : NO_MATCH;
}

function routeLongestLive({ text }) {
  if (!(containsWholeWord(text, "live") && (containsWholeWord(text, "paling lama") || containsWholeWord(text, "udah lama")))) return NO_MATCH;
  const range = resolveStatRangeFromText(text);
  return range ? replyLongestLiveForRange(range.rangeDays, range.label) : replyLongestLive();
}

// Dicek SEBELUM routeListLive - kalimatnya juga ngandung "live" + "siapa", jadi
// "cok siapa yang paling sering live" (total live count SEMUA member) gak boleh
// kejawab kayak "cok siapa yang live" (siapa yang LAGI live detik ini).
function routeLiveCountLeaderboard({ text }) {
  const asks =
    containsWholeWord(text, "live") &&
    (containsWholeWord(text, "paling sering") ||
      containsWholeWord(text, "paling banyak") ||
      containsWholeWord(text, "tersering") ||
      containsWholeWord(text, "terbanyak"));
  return asks ? withCloseButton(replyLiveCountLeaderboard()) : NO_MATCH;
}

function routeListLive({ text }) {
  const asks =
    containsWholeWord(text, "live") &&
    (containsWholeWord(text, "siapa") ||
      containsWholeWord(text, "list") ||
      containsWholeWord(text, "apa aja") ||
      containsWholeWord(text, "ada berapa") ||
      // "ada yang live ga?" / "ada member live?" - dulu jatuh ke menu fallback
      // padahal artinya sama persis kayak "siapa yang live".
      /\bada\s+(?:yang|member|orang)\b/.test(text));
  return asks ? replyListLive() : NO_MATCH;
}

// Keyword yang diketik POLOS tanpa nama member (mis. "grafik" doang) - dulu
// jatuh ke menu fallback generik, kesannya command-nya gak jalan.
function routeBareKeywordHint({ commandText }) {
  const bareKeyword = commandText.replace(/[?!.\s]+$/, "");
  // hasOwnProperty, bukan lookup langsung: input pengguna dipakai sebagai kunci, dan
  // BARE_KEYWORD_HINTS["constructor"] / ["__proto__"] itu warisan Object.prototype
  // (fungsi/objek, bukan teks) - dulu "cok constructor" dibalas dengan FUNGSI, yang
  // gagal dikirim ke Discord.
  return Object.prototype.hasOwnProperty.call(BARE_KEYWORD_HINTS, bareKeyword) ? BARE_KEYWORD_HINTS[bareKeyword] : NO_MATCH;
}

// ===================== 10. Status satu member & fallback nama ===============

// "terakhir live nala kapan" / "nala terakhir live kapan" / "kapan nala terakhir
// live" - dulu "terakhir" kebaca sebagai NAMA member ("nggak nemu member 'terakhir'").
function routeLastLive({ commandText }) {
  const match =
    commandText.match(/^(?:kapan\s+)?(?:terakhir|last)\s+live\s+([a-z0-9]+)/) ||
    commandText.match(/^(?:kapan\s+)?([a-z0-9]+)\s+(?:terakhir|last)\s+live\b/);
  return match && !MEMBER_QUERY_STOPWORDS.has(match[1]) ? replyCekMember(match[1]) : NO_MATCH;
}

// Nanya status SATU member ("erine masih live?", "apakah erine live", "cek erine",
// "status erine") - BUG: dulu cuma kejawab kalau member itu LAGI live atau udah punya
// riwayat; "status <nama>" malah dijawab status BOT. Jalurnya sama persis kayak "/cek"
// (replyCekMember). Nama harus satu kata dan bukan kata umum (MEMBER_QUERY_STOPWORDS),
// biar "siapa yang live"/"status bot" dkk gak kebajak.
function routeMemberQuery({ commandText }) {
  const match =
    commandText.match(/^(?:cek|status)\s+(?:member\s+)?([a-z0-9]+)[?!.]*$/) ||
    commandText.match(/^(?:apakah\s+|apa\s+)?([a-z0-9]+)\s+(?:(?:masih|lagi|lg|sedang|udah|sudah)\s+)?live\b/);
  return match && !MEMBER_QUERY_STOPWORDS.has(match[1]) ? replyCekMember(match[1]) : NO_MATCH;
}

function routeBotStatus({ text }) {
  return containsWholeWord(text, "status") || containsWholeWord(text, "sehat") || containsWholeWord(text, "masih jalan")
    ? replyBotStatus()
    : NO_MATCH;
}

function routeHelp({ text }) {
  return containsWholeWord(text, "help") || containsWholeWord(text, "bantuan") || containsWholeWord(text, "bisa apa") ? replyHelp() : NO_MATCH;
}

function routeLiveMemberByName({ text }) {
  const matchedMember = findMemberByNameFragment(text);
  return matchedMember ? replySpecificMember(matchedMember) : NO_MATCH;
}

// Nama-nya dikenalin tapi nggak lagi live sekarang - daripada bilang "nggak
// ketemu" doang (padahal membernya beneran ada), kasih tau kapan terakhir dia
// live berdasarkan riwayat durasi yang udah ke-track.
function routeMemberLastSeen({ text }) {
  const historyMatch = findDurationHistoryByNameFragment(text);
  if (!historyMatch || historyMatch.entries.length === 0) return NO_MATCH;
  const last = historyMatch.entries[historyMatch.entries.length - 1];
  return `Cok, **${historyMatch.displayName}** lagi nggak live sekarang. Terakhir live ${formatRelativeTime(new Date(last.at))}, durasinya ${formatDuration(last.durationMs)}.`;
}

// Nyebut bot/nanya soal live tapi nggak match pola yang dikenal -> kasih menu
// daripada diem aja. Kalau channel ini ke-mapping ke channel khusus SATU member,
// kasih fallback yang lebih simpel & spesifik member itu (3 opsi tombol) - di sini
// udah jelas jawabannya, gak perlu nanya "member yang mana". Nomor shortcut (1-9,
// markMenuShown/tryHandleMenuShortcut) SENGAJA gak dipasang buat jalur per-member itu.
function buildFallbackReply({ dedicatedUsername, commandText, channelId, authorId }) {
  if (dedicatedUsername) return replyMemberChannelFallback(dedicatedUsername);

  markMenuShown(channelId, authorId);
  const menu = replyFallbackMenu();
  // Salah ketik perintah ("cok strek nala") -> petunjuk "maksud kamu ...?" di atas menu.
  const suggestion = suggestCommand(commandText);
  return suggestion ? { ...menu, content: `${suggestion}\n\n${menu.content}` } : menu;
}

// ============================== Daftar rute =================================

// URUTAN = prioritas pencocokan. Jangan ubah urutan tanpa memikirkan pola yang
// saling tumpang tindih (alasannya ada di komentar tiap langkah).
const ROUTES = [
  // 1. Gerbang awal
  routeDmRoleNote,
  routeWatchConfirmShortcut,
  routeRecapPageShortcut,
  routeMemberPromptShortcut,
  routeMenuShortcut,
  routeNotifAllLive,
  routeWakeGate,
  routePeriodGuards,
  // 2. Fitur personal & mini-game
  routePersonalCommand,
  routeGuessCommand,
  routeWrapped,
  // 3. Prioritas, role, alias
  routeAddPriority,
  routeRemovePriority,
  routeInstallRolePanel,
  routePlainRolePanel,
  routeAddMemberRole,
  routeRemoveMemberRole,
  routeRoleDiagnostics,
  routeRoleList,
  routeAddAlias,
  routeRemoveAlias,
  routeAliasList,
  // 4. Langganan
  routeMySubscriptions,
  routeUnsubscribe,
  routeSubscribe,
  // 5. Detail satu member
  routeMemberStats,
  routeStreak,
  routeViewerChart,
  routeDurationChart,
  routeLiveCount,
  routeGifter,
  // 6. Bandingin member
  routeCompareList,
  routeCompareTwoWay,
  routeComparePicker,
  routeBareCompareList,
  routeBareCompare,
  // 7. Jadwal & prioritas
  routeSchedule,
  routeKapanLive,
  routePriorityList,
  // 8. Rekap & export
  routeExportRecap,
  routeRecap,
  // 9. Leaderboard & status umum
  routeTopViewers,
  routeLongestNotLive,
  routeLongestLive,
  routeLiveCountLeaderboard,
  routeListLive,
  routeBareKeywordHint,
  // 10. Status satu member & fallback nama
  routeLastLive,
  routeMemberQuery,
  routeBotStatus,
  routeHelp,
  routeLiveMemberByName,
  routeMemberLastSeen,
];

async function buildChatReplyCore(rawContent, options) {
  const ctx = buildContext(rawContent, options);
  const result = await firstMatch(ROUTES, ctx);
  return result !== NO_MATCH ? result : buildFallbackReply(ctx);
}

// Pembungkus: setelah bot BENERAN ngebales seseorang, dicatat kapan terakhir dia aktif
// (dasar jendela "cok kelewat"). Dicatat SESUDAH balasan dihitung, jadi "cok kelewat"
// sendiri masih baca waktu aktif yang SEBELUMNYA.
async function buildChatReply(rawContent, options = {}) {
  const reply = await buildChatReplyCore(rawContent, options);
  if (reply !== null && reply !== undefined && options.authorId) {
    try {
      touchLastSeen(options.authorId);
    } catch (error) {
      console.error("Gagal nyatet waktu aktif terakhir (nggak fatal):", error.message);
    }
  }
  return reply;
}

module.exports = { buildChatReply, ROUTES, RECAP_ROUTES, NO_MATCH };
