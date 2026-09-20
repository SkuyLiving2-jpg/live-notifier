const { findMemberByNameFragment } = require("../storage/activeLives");
const { findDurationHistoryByNameFragment } = require("../storage/durationHistory");
const { BOT_CHANNEL_ID, PRIORITY_PING_USER_ID, DISCORD_BOT_TOKEN } = require("../config");
const { containsWholeWord, stripTrailingLiveWord, formatRelativeTime, formatDuration } = require("../utils");
const { tryHandleWatchConfirmShortcut } = require("./menu");
const { markMenuShown, tryHandleMenuShortcut, tryHandleMemberPromptShortcut } = require("./pendingState");
const { replyFallbackMenu } = require("./menu");
const {
  replyListLive,
  replyLongestLive,
  replyTopViewers,
  replyBotStatus,
  replySpecificMember,
  replyHelp,
  replyPriorityList,
  replyMySubscriptions,
  replyMemberStats,
  replyLiveCount,
  replySchedulePattern,
  replyGifterSnapshot,
  replyTodayRecapSoFar,
  replyRecapRange,
  tryHandleRecapPageShortcut,
  handleAddPriority,
  handleRemovePriority,
  handleSubscribe,
  handleUnsubscribe,
} = require("./replies");
const { handleFallbackMenuButton, handleFallbackMemberSelect } = require("./menu");

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

async function buildChatReply(rawContent, { isBotChannel = false, channelId = null, authorId = null } = {}) {
  const text = (rawContent || "").toLowerCase().trim();

  const watchConfirmReply = tryHandleWatchConfirmShortcut(text, channelId, authorId);
  if (watchConfirmReply) return watchConfirmReply;

  // Dicek abis watchConfirm - kalau kebetulan dua-duanya lagi pending buat
  // orang yang sama, jawaban "y"-nya kepake buat yang pertama diminta duluan.
  const recapPageReply = await tryHandleRecapPageShortcut(text, channelId, authorId);
  if (recapPageReply) return recapPageReply;

  const memberPromptReply = tryHandleMemberPromptShortcut(text, channelId, authorId);
  if (memberPromptReply) return memberPromptReply;

  const shortcutReply = await tryHandleMenuShortcut(text, channelId, authorId);
  if (shortcutReply) return shortcutReply;

  // Di channel khusus bot, hampir semua pesan dianggap "ditujukan ke bot" -
  // gak perlu nyebut "cok" atau "live" dulu.
  const mentionsBot = isBotChannel || CHAT_WAKE_WORDS.some((w) => containsWholeWord(text, w));
  const looksLikeLiveQuestion =
    TOPIC_WORDS.some((w) => containsWholeWord(text, w)) && QUESTION_HINTS.some((w) => (w === "?" ? text.includes("?") : containsWholeWord(text, w)));

  if (!mentionsBot && !looksLikeLiveQuestion) return null;

  // Wake-word "cok" dibuang dari AWAL kalimat buat pola-pola di bawah yang
  // nempatin nama member DULUAN (mis. "lily berapa kali live?") - tanpa ini,
  // capture group yang gak dianchor bisa "kebablasan" ngambil "cok" juga
  // jadi bagian dari nama ("cok lily" alih-alih "lily"). Pola yang nempatin
  // keyword-nya DULUAN (kayak "berapa kali lily live?", "jadwal lily", dst)
  // gak kepengaruh sama sekali - regex mereka nyari kata kuncinya duluan,
  // apapun yang ada sebelum kata kunci itu (termasuk "cok") gak pernah ikut
  // ke-capture.
  const commandText = text.replace(/^cok[,.!?]?\s+/, "");

  const addPriorityMatch = text.match(/tambah(?:in|kan)?\s+prioritas\s+(.+)/);
  if (addPriorityMatch) {
    return handleAddPriority(addPriorityMatch[1], authorId);
  }

  const removePriorityMatch = text.match(/hapus\s+prioritas\s+(.+)/);
  if (removePriorityMatch) {
    return handleRemovePriority(removePriorityMatch[1], authorId);
  }

  // Dicek sebelum unsubscribeMatch/subscribeMatch di bawah - "reminder"
  // adalah kata kunci beda dari "ingetin", tapi kalimatnya bisa aja ngandung
  // dua-duanya sekaligus (mis. "cok reminder aku ingetin siapa aja"), jadi
  // biar nggak ketangkep duluan sama regex subscribe yang lebih rakus.
  if (containsWholeWord(text, "reminder")) {
    return replyMySubscriptions(authorId);
  }

  // "berhenti ingetin" harus dicek DULUAN sebelum "ingetin" biasa, soalnya
  // kalimatnya juga ngandung kata "ingetin" dan bakal ketangkep regex subscribe.
  const unsubscribeMatch = text.match(/berhenti\s+ingetin(?:in)?\s+(?:kalau\s+|kalo\s+)?(.+)/);
  if (unsubscribeMatch) {
    return handleUnsubscribe(unsubscribeMatch[1], authorId);
  }

  const subscribeMatch = text.match(/ingetin(?:in)?\s+(?:kalau\s+|kalo\s+)?(.+)/);
  if (subscribeMatch) {
    return handleSubscribe(subscribeMatch[1], authorId);
  }

  const statsMatch = text.match(/stat(?:s|istik)\s+(.+)/);
  if (statsMatch) {
    return replyMemberStats(statsMatch[1]);
  }

  // Dua cara natural buat nanya total hitungan live, sama pola dual-arah
  // kayak jadwal/kapan-live di bawah: "berapa kali (si) <nama> live" (kata
  // tanya duluan, dicek dari `text` biasa - literal "berapa kali" motong
  // nama dari "cok" di depannya) ATAU "<nama> (udah/sudah) berapa kali live"
  // (nama duluan - dicek dari `commandText`, yang wake-word-nya udah
  // dibuang, DAN di-anchor ke awal string sama `^`, biar capture-nya beneran
  // cuma "lily", bukan "cok lily" - ini bug beneran yang dilaporin user:
  // "lily berapa kali live?" dulu gak match sama sekali karena cuma pola
  // pertama yang ada, jatuh ke fallback "member gak lagi live" yang salah).
  const liveCountMatch =
    text.match(/berapa\s+kali\s+(?:si\s+)?(.+?)\s+live\b/) || commandText.match(/^(.+?)\s+(?:udah\s+|sudah\s+)?berapa\s+kali\s+live\b/);
  if (liveCountMatch) {
    return replyLiveCount(liveCountMatch[1]);
  }

  const gifterMatch = text.match(/gifter\s+(.+)/);
  if (gifterMatch) {
    return replyGifterSnapshot(gifterMatch[1]);
  }

  // Dua cara natural buat nanya pola jadwal: "cok jadwal nala" (pola
  // keyword+nama kayak stats/gifter) atau "cok kapan nala live/live nala"
  // (nama-nya "keapit" di antara kata "kapan" dan "live").
  const jadwalMatch = text.match(/jadwal\s+(.+)/);
  if (jadwalMatch) {
    return replySchedulePattern(stripTrailingLiveWord(jadwalMatch[1]));
  }

  const kapanLiveMatch = text.match(/kapan\s+(?:biasanya\s+)?(.+?)\s+live\b/) || text.match(/kapan\s+live\s+(.+)/);
  if (kapanLiveMatch) {
    return replySchedulePattern(kapanLiveMatch[1]);
  }

  if (
    containsWholeWord(text, "prioritas") &&
    (containsWholeWord(text, "daftar") || containsWholeWord(text, "siapa") || containsWholeWord(text, "list"))
  ) {
    return replyPriorityList();
  }

  // Dicek SEBELUM "rekap" polos di bawah - kalimatnya juga ngandung "rekap"
  // jadi harus ketangkep duluan sama check yang lebih spesifik ini, sama
  // pola-nya kayak "berhenti ingetin" vs "ingetin" di atas.
  if (containsWholeWord(text, "rekap") && containsWholeWord(text, "minggu")) {
    return await replyRecapRange(7, "minggu ini", channelId, authorId);
  }
  if (containsWholeWord(text, "rekap") && containsWholeWord(text, "bulan")) {
    return await replyRecapRange(30, "bulan ini", channelId, authorId);
  }
  if (containsWholeWord(text, "rekap")) {
    return await replyTodayRecapSoFar(channelId, authorId);
  }

  const asksTopViewers =
    containsWholeWord(text, "viewer") ||
    (containsWholeWord(text, "penonton") &&
      (containsWholeWord(text, "banyak") || containsWholeWord(text, "terbanyak") || containsWholeWord(text, "rame"))) ||
    (containsWholeWord(text, "ditonton") && (containsWholeWord(text, "banyak") || containsWholeWord(text, "rame")));
  if (asksTopViewers) {
    return replyTopViewers();
  }

  if (containsWholeWord(text, "live") && (containsWholeWord(text, "paling lama") || containsWholeWord(text, "udah lama"))) {
    return replyLongestLive();
  }

  if (
    containsWholeWord(text, "live") &&
    (containsWholeWord(text, "siapa") ||
      containsWholeWord(text, "list") ||
      containsWholeWord(text, "apa aja") ||
      containsWholeWord(text, "ada berapa"))
  ) {
    return replyListLive();
  }

  if (containsWholeWord(text, "status") || containsWholeWord(text, "sehat") || containsWholeWord(text, "masih jalan")) {
    return replyBotStatus();
  }

  if (containsWholeWord(text, "help") || containsWholeWord(text, "bantuan") || containsWholeWord(text, "bisa apa")) {
    return replyHelp();
  }

  const matchedMember = findMemberByNameFragment(text);
  if (matchedMember) {
    return replySpecificMember(matchedMember);
  }

  // Nama-nya dikenalin tapi nggak lagi live sekarang - daripada bilang
  // "nggak ketemu" doang (padahal membernya beneran ada), kasih tau kapan
  // terakhir dia live berdasarkan riwayat durasi yang udah ke-track.
  const historyMatch = findDurationHistoryByNameFragment(text);
  if (historyMatch && historyMatch.entries.length > 0) {
    const last = historyMatch.entries[historyMatch.entries.length - 1];
    const lastAt = new Date(last.at);
    return `Cok, **${historyMatch.displayName}** lagi nggak live sekarang. Terakhir live ${formatRelativeTime(lastAt)}, durasinya ${formatDuration(last.durationMs)}.`;
  }

  // Nyebut bot/nanya soal live tapi nggak match pola yang dikenal -> kasih
  // menu daripada diem aja, dan inget orang ini abis dikasih menu.
  markMenuShown(channelId, authorId);
  return replyFallbackMenu();
}

// Nempelin listener pesan/tombol ke discord.js Client yang udah dibikin
// discordClient.js's createDiscordClient() - dipanggil dari src/app.js's
// start() setelah DISCORD_BOT_TOKEN dipastiin ada, JADI fungsi ini sendiri
// gak nge-cek DISCORD_BOT_TOKEN lagi (itu tanggung jawab pemanggilnya).
function wireDiscordEvents(client) {
  client.once("clientReady", () => {
    console.log(`Bot tanya-jawab login sebagai ${client.user.tag}`);
    // Dicetak sekali pas boot - cara paling gampang buat mastiin (lewat
    // Deploy Logs di Railway, tanpa perlu akses dashboard/CLI-nya) apakah
    // PRIORITY_PING_USER_ID keisi bener, soalnya kalau kosong DM notif
    // prioritas (notify/priorityDm.js) diem-diem gak pernah kekirim tanpa
    // error apapun.
    console.log(
      PRIORITY_PING_USER_ID
        ? `PRIORITY_PING_USER_ID aktif - DM notif prioritas bakal dikirim ke user ID ${PRIORITY_PING_USER_ID}.`
        : "PRIORITY_PING_USER_ID BELUM diset - DM notif prioritas gak bakal kekirim (channel tetap dapet notif biasa).",
    );
  });

  client.on("messageCreate", async (message) => {
    try {
      if (message.author.bot) return;
      const isBotChannel = Boolean(BOT_CHANNEL_ID) && message.channel.id === BOT_CHANNEL_ID;
      const reply = await buildChatReply(message.content, {
        isBotChannel,
        channelId: message.channel.id,
        authorId: message.author.id,
      });
      if (reply) await message.reply(reply);
    } catch (error) {
      console.error("Gagal balas chat:", error.message);
    }
  });

  client.on("interactionCreate", async (interaction) => {
    try {
      if (interaction.isButton() && interaction.customId.startsWith("fallback_menu:")) {
        await handleFallbackMenuButton(interaction);
      } else if (interaction.isStringSelectMenu() && interaction.customId.startsWith("fallback_select:")) {
        await handleFallbackMemberSelect(interaction);
      }
    } catch (error) {
      console.error("Gagal proses tombol/menu Discord:", error.message);
    }
  });

  client.login(DISCORD_BOT_TOKEN).catch((error) => {
    console.error("Gagal login bot Discord (cek DISCORD_BOT_TOKEN):", error.message);
  });
}

module.exports = { buildChatReply, wireDiscordEvents };
