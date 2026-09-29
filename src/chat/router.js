const { findMemberByNameFragment } = require("../storage/activeLives");
const { findDurationHistoryByNameFragment } = require("../storage/durationHistory");
const { getUsernameForChannel } = require("../storage/channelRouting");
const { BOT_CHANNEL_ID, PRIORITY_PING_USER_ID, DISCORD_BOT_TOKEN } = require("../config");
const { containsWholeWord, stripTrailingLiveWord, formatRelativeTime, formatDuration, safeReplyOptions, getTodayWIB } = require("../utils");
const { tryHandleWatchConfirmShortcut } = require("./menu");
const { markMenuShown, tryHandleMenuShortcut, tryHandleMemberPromptShortcut } = require("./pendingState");
const { replyFallbackMenu } = require("./menu");
const { replyMemberChannelFallback, handleMemberChannelFallbackButton } = require("./memberChannelReply");
const { replyStartComparePick, handleComparePickButton, handleCompareModalSubmit, handleCompareSelect } = require("./compareFlow");
const { pruneRepeatedExchange } = require("./repeatedReplyGuard");
const { replyDurationChart } = require("./chartReply");
const { handleSlashCommand, handleSlashAutocomplete } = require("./slashCommands");
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
  replyPriorityList,
  replyMySubscriptions,
  replyMemberStats,
  replyLiveCount,
  replyLiveCountLeaderboard,
  replyLongestNotLiveLeaderboard,
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
  handleRecapMemberModalSubmit,
  replyRecapMember,
  replyStreak,
  extractRecapMemberFragment,
  handleRecapJumpModalSubmit,
  handleRecapMenuButton,
  handleRecapDateSelect,
  handleRecapMonthSelect,
  handleAddPriority,
  handleRemovePriority,
  isKnownMemberFragment,
  handleAddAlias,
  handleRemoveAlias,
  replyAliasList,
  handleSubscribe,
  handleUnsubscribe,
} = require("./replies");
const { handleFallbackMenuButton, handleFallbackMemberSelect, handleFallbackExtraSelect, handleWatchConfirmButton } = require("./menu");

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

  // Saran fitur ke-5 (§10's kelimapuluh item): "cok tambah alias <alias> =
  // <nama asli>" - pemisahnya "=", "untuk", atau "buat" (sama filosofi
  // multi-pemisah kayak compareMatch's "dan"/"&" di bawah). Dicek sebelum
  // "hapus alias"/"daftar alias" di bawahnya, dan gak nabrak "tambah
  // prioritas"/"hapus prioritas" di atas - kata kunci "alias" vs "prioritas"
  // beda persis setelah "tambah(in/kan)?"/"hapus", jadi dua-duanya gak
  // pernah saling ke-tangkep.
  const addAliasMatch = text.match(/tambah(?:in|kan)?\s+alias\s+(.+?)\s*(?:=|untuk|buat)\s*(.+)/);
  if (addAliasMatch) {
    return await handleAddAlias(addAliasMatch[1], addAliasMatch[2], authorId);
  }

  const removeAliasMatch = text.match(/hapus\s+alias\s+(.+)/);
  if (removeAliasMatch) {
    return handleRemoveAlias(removeAliasMatch[1], authorId);
  }

  if (containsWholeWord(text, "alias") && (containsWholeWord(text, "daftar") || containsWholeWord(text, "list"))) {
    return replyAliasList();
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

  // Saran fitur ke-5 (§10's kelimapuluh+item): "cok streak <nama member>" -
  // berapa hari berturut-turut dia punya live.
  const streakMatch = text.match(/streak\s+(.+)/);
  if (streakMatch) {
    return await replyStreak(streakMatch[1]);
  }

  // Saran fitur "iseng nambah baris" ke-2 (owner minta beneran dikerjain):
  // "cok grafik <nama>"/"cok chart <nama>" - bar chart durasi live 10 sesi
  // terakhir (gambar PNG, lihat chat/chartReply.js), bukan teks/embed kayak
  // reply lain. Dicek SEBELUM stats/streak di atas? Enggak - taro SETELAH,
  // soalnya kata "grafik"/"chart" gak nyempil di kalimat command lain manapun
  // di file ini, jadi urutannya gak krusial, cuma ditaro deket
  // stats/streak biar related secara tematik (dua-duanya "detail 1 member").
  const chartMatch = text.match(/(?:grafik|chart)\s+(.+)/);
  if (chartMatch) {
    return await replyDurationChart(chartMatch[1]);
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

  // Saran fitur ke-3: "cok bandingin A, B, dan C" (koma - Oxford comma
  // ATAUPUN "dan" polos di akhir - dan variasinya "A, B, C"/"A, B & C")
  // - lebih dari 2 member sekaligus. Dicek SEBELUM compareMatch (2-way) di
  // bawah - KOMA jadi sinyal pemicu ("ini daftar, bukan bentuk 2-way biasa")
  // soalnya bentuk 2-way yang UDAH ADA gak pernah pakai koma sama sekali,
  // jadi ini gak bisa nabrak balik ke situ: kalimat tanpa koma SELALU jatuh
  // ke compareMatch seperti biasa, perilaku 2-member lama gak kesentuh sama
  // sekali. Bentuk "A dan B dan C" TANPA koma sama sekali SENGAJA gak
  // didukung - susah dibedain dari kalimat biasa yang kebetulan nyebut "dan"
  // berkali-kali, beda dari koma yang gak ambigu.
  const compareListFullMatch = text.match(/\bbanding(?:in|kan)?\s+(.+)/);
  if (compareListFullMatch && compareListFullMatch[1].includes(",")) {
    const rawParts = compareListFullMatch[1].split(/\s*,\s*(?:dan\s+)?|\s+dan\s+|\s*&\s*/);
    const parts = rawParts.map((p) => p.trim()).filter(Boolean);
    if (parts.length >= 2) {
      const lastIndex = parts.length - 1;
      parts[lastIndex] = parts[lastIndex].replace(/[?!.\s]+$/, "");
      return parts.length === 2 ? await replyCompareMembers(parts[0], parts[1]) : await replyCompareMembersMulti(parts);
    }
    // Koma ada tapi ujung-ujungnya cuma nyisa 1 potongan (mis. koma nyantol
    // di ujung kalimat doang, "bandingin nala,") - biarin jatuh ke
    // compareMatch/bare-form/replyStartComparePick di bawah seperti biasa.
  }

  // §10's forty-second item: "cok bandingin <A> dan <B>" - pemisahnya SENGAJA
  // cuma "dan" atau "&" (owner minta "vs"/"versus" dibuang: "nala dan lily"/
  // "nala & lily", bukan "nala vs lily"). Kata kuncinya "bandingin"/"bandingkan"/"banding". Dua
  // nama fragment-nya diselesaiin lewat findLiveCountByNameFragment yang sama
  // dipake replyLiveCount, jadi konsisten sama cara "cok berapa kali <nama>
  // live" ngenalin member.
  const compareMatch = text.match(/\bbanding(?:in|kan)?\s+(.+?)(?:\s+dan\s+|\s*&\s*)(.+)/);
  if (compareMatch) {
    return await replyCompareMembers(compareMatch[1].trim(), compareMatch[2].replace(/[?!.\s]+$/, ""));
  }

  // Kata kuncinya diketik tapi pasangannya gak lengkap (mis. "cok bandingin"
  // polos, atau cuma satu nama) - owner ngeluh ini kepentok jatuh ke fallback
  // menu 9-opsi generik, padahal maksudnya jelas mau bandingin, cuma belum
  // mutusin lawannya siapa. Dikasih flow dropdown/search 2 langkah
  // (chat/compareFlow.js).
  if (/\bbanding(?:in|kan)?\b/.test(text)) {
    return replyStartComparePick();
  }

  // Bug yang dilaporin owner: "nala, lily, dan levi" (BARE, tanpa "cok
  // bandingin" sama sekali) gak kejawab - compareListFullMatch di atas
  // (versi 3+ member) CUMA aktif kalau ada kata kunci "banding(in/kan)"
  // duluan, dan bareCompareMatch di bawah (versi bare) CUMA nerima PERSIS
  // dua nama (regexnya gak punya koma sama sekali). Jadi kalimat bare 3+
  // member gak ketangkep siapapun, jatuh ke jadwalMatch dkk atau fallback
  // generik. Sama filosofinya kayak compareListFullMatch: KOMA jadi sinyal
  // pemicu "ini daftar, bukan kalimat biasa" - bentuk bare 2-way yang UDAH
  // ADA (bareCompareMatch di bawah) gak pernah pakai koma, jadi ini gak
  // bisa nabrak balik ke situ. Beda dari compareListFullMatch: SEMUA
  // potongannya (bukan cuma dua terakhir) harus persis satu kata alfanumerik
  // (regex `^...$` di-anchor ke SELURUH commandText) DAN minimal SATU harus
  // dikenali sebagai member (isKnownMemberFragment) - dua penjagaan ekstra
  // ini WAJIB di sini (compareListFullMatch gak butuh itu, soalnya dia udah
  // dijamin sengaja lewat kata kunci "bandingin") biar kalimat bare biasa
  // yang kebetulan nyebut koma ("makan, minum, dan tidur") gak salah
  // dibajak jadi perbandingan.
  if (commandText.includes(",")) {
    const bareListParts = commandText
      .replace(/[?!.\s]+$/, "")
      .split(/\s*,\s*(?:dan\s+)?|\s+dan\s+|\s*&\s*/)
      .map((p) => p.trim());
    const isBareWordList = bareListParts.length >= 2 && bareListParts.every((p) => /^[a-z0-9]+$/.test(p));
    if (isBareWordList && bareListParts.some((p) => isKnownMemberFragment(p))) {
      return bareListParts.length === 2
        ? await replyCompareMembers(bareListParts[0], bareListParts[1])
        : await replyCompareMembersMulti(bareListParts);
    }
  }

  // Tanpa kata kunci sama sekali: "<nama> dan <nama>" doang (owner minta
  // "nala dan lily" langsung jadi perbandingan). Ini pola yang LONGGAR banget
  // ("dan" ada di mana-mana), jadi dijaga ketat: harus persis dua kata
  // tunggal di kiri-kanan "dan"/"&", DAN minimal salah satunya dikenali sebagai
  // member (isKnownMemberFragment - BUKAN cuma live-count.json, yang bisa aja
  // kosong/ke-reset: member prioritas kayak Nala/Levi/Lily tetep selalu dikenali) - biar kalimat biasa ("cok makan dan
  // tidur") gak salah dibajak jadi perbandingan.
  const bareCompareMatch = commandText.match(/^([a-z0-9]+)(?:\s+dan\s+|\s*&\s*)([a-z0-9]+)[?!.]*$/);
  if (bareCompareMatch && (isKnownMemberFragment(bareCompareMatch[1]) || isKnownMemberFragment(bareCompareMatch[2]))) {
    return await replyCompareMembers(bareCompareMatch[1], bareCompareMatch[2]);
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

    // "rekap <nama member>" (§10's forty-eighth item, mis. "rekap aralie") -
    // dicek PALING AKHIR, setelah semua kata kunci rekap lain (hari/minggu/
    // bulan/tanggal/nama bulan/nama hari) gagal, jadi gak pernah nabrak
    // mereka. extractRecapMemberFragment ketat (tepat satu kata nama), kalimat
    // yang gak jelas tetep jatuh ke menu di bawah.
    const memberFragment = extractRecapMemberFragment(text);
    if (memberFragment) {
      return await replyRecapMember(memberFragment, channelId, authorId);
    }

    // "rekap" POLOS doang (gak nyebut minggu/bulan/tanggal/hari/nama
    // hari/nama bulan sama sekali) -> menu tombol - owner minta ini biar
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

  // Saran fitur ke-2 (§10's kelimapuluh item): "siapa yang paling lama gak
  // live" - kebalikan dari leaderboard "paling sering live" di bawah. Dicek
  // DULUAN, SEBELUM check "paling lama live" tepat di bawah ini - keduanya
  // sama-sama ngandung frasa "paling lama" ("paling lama gak live" vs
  // "paling lama live"), jadi yang lebih spesifik (butuh "siapa" + kata
  // negasi eksplisit) harus menang duluan, kalau nggak "siapa yang paling
  // lama gak live" bakal kesasar ke replyLongestLive (durasi SATU sesi live
  // terpanjang, bukan leaderboard "udah berapa lama gak pernah live").
  // "siapa" WAJIB ada di sini (beda dari check-check leaderboard/durasi lain
  // yang gak mensyaratkan itu) - tanpa gerbang ini, kalimat wajar kayak
  // "cok nala kok lama gak live" (nanya SATU member spesifik, bukan minta
  // leaderboard) bakal ikut kebajak juga.
  const notLiveNegationWords = ["gak", "nggak", "enggak", "tidak", "belum"];
  const asksLongestNotLive =
    containsWholeWord(text, "siapa") &&
    containsWholeWord(text, "live") &&
    (containsWholeWord(text, "jarang") || (containsWholeWord(text, "lama") && notLiveNegationWords.some((w) => containsWholeWord(text, w))));
  if (asksLongestNotLive) {
    return replyLongestNotLiveLeaderboard();
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
      if (reply) {
        const sent = await message.reply(safeReplyOptions(reply));
        // Ketikan yang SAMA diulang lebih dari 2x -> ketikan lama + balesan
        // bot lamanya dihapus (lihat repeatedReplyGuard.js). Dipanggil abis
        // balesan kekirim, dan gak pernah throw (kegagalan hapus cuma di-log).
        await pruneRepeatedExchange(message, (message.content || "").trim().toLowerCase(), sent);
      }
    } catch (error) {
      // Sebelumnya cuma nyetak error.message - kalau ini beneran gagal
      // gara-gara Discord API nolak (mis. kurang permission), error.code
      // (angka error Discord, mis. 50013) sama error.stack jauh lebih
      // kebaca ketimbang cuma pesan generik "Missing Permissions".
      console.error("Gagal balas chat:", error.message, "| code:", error.code, "\n", error.stack);
    }
  });

  client.on("interactionCreate", async (interaction) => {
    try {
      if (interaction.isChatInputCommand()) {
        // Slash command ("/live", "/rekap", dst - chat/slashCommands.js).
        // Dicek PALING ATAS (beda kelas interaction sama sekali dari
        // button/select-menu/modal di bawah - ChatInputCommandInteraction
        // gak punya `.customId`, jadi taro di sini biar jelas gak nyampur
        // sama rantai if-else berbasis customId di bawahnya).
        await handleSlashCommand(interaction);
      } else if (interaction.isAutocomplete()) {
        // Saran autocomplete buat opsi "member"/"target" pas user lagi
        // ngetik di slash command manapun (lihat AUTOCOMPLETE_OPTION_NAMES
        // di slashCommands.js) - beda method (`interaction.respond()`,
        // BUKAN `.reply()`) dari semua interaction lain di file ini.
        await handleSlashAutocomplete(interaction);
      } else if (interaction.isButton() && interaction.customId.startsWith("fallback_menu:")) {
        await handleFallbackMenuButton(interaction);
      } else if (interaction.isStringSelectMenu() && interaction.customId.startsWith("fallback_select:")) {
        await handleFallbackMemberSelect(interaction);
      } else if (interaction.isStringSelectMenu() && interaction.customId === "fallback_extra_select") {
        // Dropdown "❓ Fitur lainnya" (EXTRA_FEATURES, lihat menu.js) - customId
        // beda skema dari "fallback_select:<4|9>" di atas SENGAJA (dropdown ini
        // milih FITUR, bukan nama member/gifter, jadi handler-nya juga beda -
        // exact match "===", bukan startsWith, soalnya gak ada suffix apapun
        // nempel di customId-nya).
        await handleFallbackExtraSelect(interaction);
      } else if (interaction.isButton() && interaction.customId.startsWith("member_fallback:")) {
        await handleMemberChannelFallbackButton(interaction);
      } else if (interaction.isButton() && interaction.customId.startsWith("recap_nav:")) {
        await handleRecapNavButton(interaction);
      } else if (interaction.isModalSubmit() && interaction.customId.startsWith("recap_search_modal:")) {
        await handleRecapSearchModalSubmit(interaction);
      } else if (interaction.isModalSubmit() && interaction.customId.startsWith("recap_member_modal:")) {
        await handleRecapMemberModalSubmit(interaction);
      } else if (interaction.isModalSubmit() && interaction.customId.startsWith("recap_jump_modal:")) {
        await handleRecapJumpModalSubmit(interaction);
      } else if (interaction.isButton() && interaction.customId.startsWith("recap_menu:")) {
        await handleRecapMenuButton(interaction);
      } else if (interaction.isStringSelectMenu() && interaction.customId.startsWith("recap_date_select")) {
        // startsWith (bukan === persis) - BUG YANG DILAPORIN OWNER (tombol
        // "🔙 Kembali", lihat komen di replies.js's buildBackRow/withOrigin):
        // customId dropdown ini sekarang bisa bawa origin tambahan
        // ("recap_date_select:recapmenu"), bukan cuma "recap_date_select"
        // polos - persis pola yang customId "recap_nav:"/"fallback_menu:"
        // dkk di atas udah pakai dari dulu.
        await handleRecapDateSelect(interaction);
      } else if (interaction.isStringSelectMenu() && interaction.customId.startsWith("recap_month_select")) {
        await handleRecapMonthSelect(interaction);
      } else if (interaction.isButton() && interaction.customId.startsWith("watch_confirm:")) {
        await handleWatchConfirmButton(interaction);
      } else if (interaction.isButton() && interaction.customId.startsWith("compare_pick:")) {
        await handleComparePickButton(interaction);
      } else if (interaction.isModalSubmit() && interaction.customId.startsWith("compare_modal:")) {
        await handleCompareModalSubmit(interaction);
      } else if (interaction.isStringSelectMenu() && interaction.customId.startsWith("compare_select:")) {
        await handleCompareSelect(interaction);
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
