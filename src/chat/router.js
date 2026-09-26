const { findMemberByNameFragment } = require("../storage/activeLives");
const { findDurationHistoryByNameFragment } = require("../storage/durationHistory");
const { getUsernameForChannel } = require("../storage/channelRouting");
const { BOT_CHANNEL_ID, PRIORITY_PING_USER_ID, DISCORD_BOT_TOKEN } = require("../config");
const { containsWholeWord, stripTrailingLiveWord, formatRelativeTime, formatDuration, safeReplyOptions, getTodayWIB } = require("../utils");
const { tryHandleWatchConfirmShortcut } = require("./menu");
const { markMenuShown, tryHandleMenuShortcut, tryHandleMemberPromptShortcut } = require("./pendingState");
const { replyFallbackMenu } = require("./menu");
const { replyMemberChannelFallback, handleMemberChannelFallbackButton } = require("./memberChannelReply");
const {
  replyListLive,
  replyLongestLive,
  replyLongestLiveForRange,
  replyTopViewers,
  replyTopViewersForRange,
  resolveStatRangeFromText,
  replyExportRecap,
  replyCompareMembers,
  replyBotStatus,
  replySpecificMember,
  replyHelp,
  replyPriorityList,
  replyMySubscriptions,
  replyMemberStats,
  replyLiveCount,
  replyLiveCountLeaderboard,
  replySchedulePattern,
  replyGifterSnapshot,
  replyTodayRecapSoFar,
  replyRecapRange,
  replyRecapMenu,
  replyRecapDatePicker,
  replyRecapMonth,
  replyRecapMonthGeneric,
  replyRecapSpecificDate,
  replyRecapWeekdayPicker,
  parseSpecificDateFromText,
  parseMonthOnlyFromText,
  parseWeekdayFromText,
  tryHandleRecapPageShortcut,
  handleRecapNavButton,
  handleRecapSearchModalSubmit,
  handleRecapJumpModalSubmit,
  handleRecapMenuButton,
  handleRecapDateSelect,
  handleRecapMonthSelect,
  handleAddPriority,
  handleRemovePriority,
  handleSubscribe,
  handleUnsubscribe,
} = require("./replies");
const { handleFallbackMenuButton, handleFallbackMemberSelect, handleWatchConfirmButton } = require("./menu");

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

  // Channel khusus SATU member (fitur "Q3", storage/channelRouting.js's
  // getUsernameForChannel) dihitung DI SINI (bukan cuma di fallback paling
  // bawah) soalnya dipake dua kali - buat nentuin mentionsBot juga. BUG
  // SEBELUMNYA: dulu channel ini masih kena gerbang wake-word biasa, jadi
  // orang yang ngetik tanpa "cok" di channel yang emang KHUSUS buat 1 member
  // itu bakal diem-diem gak dijawab sama sekali (keliatan kayak bot rusak,
  // padahal cuma nunggu kata "cok").
  const dedicatedUsername = channelId ? getUsernameForChannel(channelId) : null;

  // Di channel khusus bot ATAU channel khusus member, hampir semua pesan
  // dianggap "ditujukan ke bot" - gak perlu nyebut "cok" atau "live" dulu.
  // Beda dari BOT_CHANNEL_ID (manual di .env), dedicatedUsername otomatis -
  // channel itu emang eksis spesifik buat member ini, jadi wajar hampir
  // semua pesan di situ dianggep nanya soal dia.
  const mentionsBot = isBotChannel || Boolean(dedicatedUsername) || CHAT_WAKE_WORDS.some((w) => containsWholeWord(text, w));
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

  // §10's forty-second item: "cok bandingin <A> vs <B>" (juga nerima
  // "lawan"/"sama"/"dan"/"dengan" sebagai pemisah, biar natural apapun cara
  // orangnya nulis) - dua nama fragment-nya diselesaiin lewat
  // findLiveCountByNameFragment yang sama dipake replyLiveCount, jadi
  // konsisten sama cara "cok berapa kali <nama> live" ngenalin member.
  const compareMatch = text.match(/bandingin\s+(.+?)\s+(?:vs\.?|lawan|sama|dan|dengan)\s+(.+)/);
  if (compareMatch) {
    return await replyCompareMembers(compareMatch[1], compareMatch[2]);
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

  // §10's forty-first item: "cok export rekap ..." - dicek SEBELUM "rekap"
  // polos di bawah, soalnya kalimatnya juga ngandung kata "rekap" (bakal
  // ketangkep sama dispatch rekap biasa dan nunjukkin TABEL kalau ini
  // dibiarin ke bawah, bukan file CSV yang diminta). Rentangnya reuse
  // resolveStatRangeFromText yang sama kayak "paling lama live"/"paling
  // rame ditonton" (§10's fortieth item) - "export rekap" doang (gak nyebut
  // rentang) default ke hari ini, sama kayak dua fitur itu.
  if (containsWholeWord(text, "export") && containsWholeWord(text, "rekap")) {
    return replyExportRecap(text);
  }

  // Dicek SEBELUM "rekap" polos di bawah - kalimatnya juga ngandung "rekap"
  // jadi harus ketangkep duluan sama check yang lebih spesifik ini, sama
  // pola-nya kayak "berhenti ingetin" vs "ingetin" di atas. Urutannya
  // (§10's thirty-sixth item) dari yang PALING SPESIFIK ke yang PALING
  // POLOS, biar kalimat yang nyebut beberapa kata kunci sekaligus (mis.
  // "rekap per tanggal 25 september", ngandung "tanggal" DAN tanggal
  // spesifik) ketangkep sama check yang paling ngerti maksud usernya.
  if (containsWholeWord(text, "rekap")) {
    // "rekap hari senin"/"rekap senin" dkk - weekday DULUAN (sebelum "rekap
    // minggu" biasa), soalnya kata "minggu" (Minggu) sendiri BISA ketangkep
    // di sini juga (lewat parseWeekdayFromText's "hari"+"minggu" khusus) -
    // lihat komen di parseWeekdayFromText buat kenapa gak nabrak "rekap
    // minggu ini" (rentang 7 hari) yang udah ada dari dulu.
    const weekdayIndex = parseWeekdayFromText(text);
    if (weekdayIndex !== null) {
      return await replyRecapWeekdayPicker(weekdayIndex);
    }

    // Tanggal LENGKAP (hari + nama bulan, mis. "25 september") - dicek
    // SEBELUM cabang bulan/minggu di bawah, soalnya kalimat kayak gitu juga
    // ngandung nama bulan (bisa kesangkut ke cabang "nama bulan polos") atau
    // gak sengaja ngandung kata "bulan"/"minggu" juga. User yang udah
    // eksplisit nyebut tanggal pasti maunya LANGSUNG liat tabel tanggal itu,
    // bukan ditanya-tanya lagi.
    const specificDate = parseSpecificDateFromText(text);
    if (specificDate) {
      return await replyRecapSpecificDate(specificDate, channelId, authorId);
    }

    if (containsWholeWord(text, "minggu")) {
      return await replyRecapRange(7, "minggu ini", channelId, authorId);
    }

    // "rekap bulan ini" - eksplisit nyebut "ini", jadi SELALU langsung bulan
    // BERJALAN, gak usah nanya walau nanti udah ada beberapa bulan yang
    // punya data (beda dari "rekap bulan" polos di bawah).
    if (containsWholeWord(text, "bulan") && containsWholeWord(text, "ini")) {
      return await replyRecapMonth(getTodayWIB().slice(0, 7), channelId, authorId);
    }

    // Nama bulan POLOS tanpa angka hari (mis. "rekap september") - dicek
    // SETELAH specificDate gagal di atas, biar "rekap 25 september" gak
    // kepotong jadi ini.
    const monthOnly = parseMonthOnlyFromText(text);
    if (monthOnly) {
      return await replyRecapMonth(monthOnly, channelId, authorId);
    }

    // "rekap bulan" polos (gak nyebut nama bulan/"ini" sama sekali) -
    // dropdown milih bulan (atau langsung tunjukkin kalau cuma ada 1 bulan
    // yang punya data, kasus sekarang).
    if (containsWholeWord(text, "bulan")) {
      return await replyRecapMonthGeneric(channelId, authorId);
    }

    // "rekap tanggal"/"rekap per tanggal" (TANPA tanggal spesifik nempel) ->
    // langsung dropdown milih tanggal, skip menu 4-tombol di bawah
    // (orangnya udah jelas mau rekap tanggal, tinggal milih yang mana).
    if (containsWholeWord(text, "tanggal")) {
      return replyRecapDatePicker();
    }

    // "rekap hari ini"/"rekap hari" -> tetep langsung ke rekap hari ini
    // kayak sebelumnya (BUKAN nunjukkin menu 4-tombol) - orangnya udah
    // eksplisit nyebut rentangnya, jadi gak perlu ditanya lagi. Weekday
    // ("rekap hari senin" dkk) udah ketangkep duluan di paling atas, jadi
    // "hari" yang nyampe sini beneran polos ("hari ini"/"hari" doang).
    if (containsWholeWord(text, "hari")) {
      return await replyTodayRecapSoFar(channelId, authorId);
    }

    // "rekap" POLOS doang (gak nyebut minggu/bulan/tanggal/hari/nama
    // hari/nama bulan sama sekali) -> menu 4-tombol - owner minta ini biar
    // user gak bingung mau ketik apa buat tiap jenis rekap.
    return replyRecapMenu();
  }

  const asksTopViewers =
    containsWholeWord(text, "viewer") ||
    (containsWholeWord(text, "penonton") &&
      (containsWholeWord(text, "banyak") || containsWholeWord(text, "terbanyak") || containsWholeWord(text, "rame"))) ||
    (containsWholeWord(text, "ditonton") && (containsWholeWord(text, "banyak") || containsWholeWord(text, "rame")));
  // §10's fortieth item: "paling rame ditonton"/"paling lama live" sekarang
  // bisa dikasih rentang juga (minggu ini/bulan ini/nama bulan/tanggal
  // spesifik) - resolveStatRangeFromText balikin null kalau kalimatnya gak
  // nyebut rentang apapun, dan pemanggilnya (replyTopViewers/replyLongestLive)
  // tetep dipake apa adanya buat itu, jadi perilaku default "hari ini" gak
  // berubah sama sekali.
  if (asksTopViewers) {
    const range = resolveStatRangeFromText(text);
    return range ? replyTopViewersForRange(range.rangeDays, range.label) : replyTopViewers();
  }

  if (containsWholeWord(text, "live") && (containsWholeWord(text, "paling lama") || containsWholeWord(text, "udah lama"))) {
    const range = resolveStatRangeFromText(text);
    return range ? replyLongestLiveForRange(range.rangeDays, range.label) : replyLongestLive();
  }

  // Dicek SEBELUM check "siapa yang live" polos di bawah - kalimatnya juga
  // ngandung "live" + "siapa", jadi harus ketangkep duluan sama check yang
  // lebih spesifik ini (sama pola-nya kayak "rekap minggu/bulan" vs "rekap"
  // polos di atas), biar "cok siapa yang paling sering live" (nanya total
  // live count SEMUA member) gak kejawab kayak "cok siapa yang live"
  // (nanya siapa yang LAGI live detik ini) - dua pertanyaan yang beda arti.
  if (
    containsWholeWord(text, "live") &&
    (containsWholeWord(text, "paling sering") ||
      containsWholeWord(text, "paling banyak") ||
      containsWholeWord(text, "tersering") ||
      containsWholeWord(text, "terbanyak"))
  ) {
    return replyLiveCountLeaderboard();
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
  // menu daripada diem aja. Kalau channel ini ke-mapping ke channel khusus
  // SATU member (dedicatedUsername, dihitung di atas), kasih fallback yang
  // lebih simpel & spesifik member itu (3 opsi tombol) daripada menu 9-opsi
  // generik yang nanya "member yang mana" - di sini itu udah jelas
  // jawabannya, jadi gak perlu nanya lagi. Nomor shortcut (1-9, lihat
  // markMenuShown/tryHandleMenuShortcut) SENGAJA gak dipasang buat jalur
  // ini - fallback per-member cuma bisa lewat tombol.
  if (dedicatedUsername) return replyMemberChannelFallback(dedicatedUsername);

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
      if (reply) await message.reply(safeReplyOptions(reply));
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
      } else if (interaction.isButton() && interaction.customId.startsWith("member_fallback:")) {
        await handleMemberChannelFallbackButton(interaction);
      } else if (interaction.isButton() && interaction.customId.startsWith("recap_nav:")) {
        await handleRecapNavButton(interaction);
      } else if (interaction.isModalSubmit() && interaction.customId.startsWith("recap_search_modal:")) {
        await handleRecapSearchModalSubmit(interaction);
      } else if (interaction.isModalSubmit() && interaction.customId.startsWith("recap_jump_modal:")) {
        await handleRecapJumpModalSubmit(interaction);
      } else if (interaction.isButton() && interaction.customId.startsWith("recap_menu:")) {
        await handleRecapMenuButton(interaction);
      } else if (interaction.isStringSelectMenu() && interaction.customId === "recap_date_select") {
        await handleRecapDateSelect(interaction);
      } else if (interaction.isStringSelectMenu() && interaction.customId === "recap_month_select") {
        await handleRecapMonthSelect(interaction);
      } else if (interaction.isButton() && interaction.customId.startsWith("watch_confirm:")) {
        await handleWatchConfirmButton(interaction);
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
