const { activeLives, getSortedActiveLives } = require("../storage/activeLives");
const {
  getCompletedSessionsToday,
  getCompletedSessionsSince,
  getEarliestSessionDate,
  fetchExternalTodayLiveHistory,
} = require("../storage/dailyLog");
const { findDurationHistoryByNameFragment } = require("../storage/durationHistory");
const { findLiveCountByNameFragment, getLiveCountLeaderboard } = require("../storage/liveCount");
const { loadSubscriptions, addSubscription, removeSubscription } = require("../storage/subscriptions");
const { loadGifterSnapshot, findGifterSnapshotByNameFragment } = require("../storage/gifterSnapshot");
const { getAllPriorityMembers, addCustomPriorityMember, removeCustomPriorityMember } = require("../priority");
const { PRIORITY_PING_USER_ID } = require("../config");
const {
  formatDuration,
  formatRelativeTime,
  formatViewCount,
  formatClockWIB,
  getTodayWIB,
  getDateWIB,
  formatShortDateWIB,
  describeElapsed,
  getTimeOfDayBucket,
  getHourWIBOf,
  WEEKDAY_FORMATTER_WIB,
  stripTrailingLiveWord,
  YES_PATTERN,
  NO_PATTERN,
  NEXT_PAGE_PATTERN,
  PREV_PAGE_PATTERN,
} = require("../utils");

function replyListLive() {
  const sorted = getSortedActiveLives();
  if (sorted.length === 0) return "Cok, lagi nggak ada member JKT48 yang live nih.";

  const lines = sorted.map((entry, i) => {
    const elapsedText = describeElapsed(Date.now() - new Date(entry.liveAt).getTime());
    const viewText = entry.viewCount != null ? ` | 👁️ ${formatViewCount(entry.viewCount)}` : "";
    return `${i + 1}. **${entry.name}** - ${elapsedText}${viewText}`;
  });

  return `Cok, ini yang lagi live (urut dari paling lama):\n${lines.join("\n")}`;
}

// Dulu cuma bandingin member yang LAGI live sekarang - jadi kalau ada yang
// live 3 jam terus SELESAI, terus member lain baru mulai live 5 menit,
// yang kesebut "paling lama" malah yang baru mulai itu (soalnya yang udah
// selesai udah ilang dari activeLives). Sekarang gabungin durasi live yang
// LAGI JALAN (activeLives) SAMA sesi yang UDAH SELESAI hari ini (daily log)
// biar rekap-nya beneran akurat sepanjang hari, bukan cuma potret sesaat.
function replyLongestLive() {
  const candidates = [];

  for (const entry of activeLives.values()) {
    candidates.push({
      name: entry.name,
      durationMs: Date.now() - new Date(entry.liveAt).getTime(),
      isLive: true,
    });
  }
  for (const session of getCompletedSessionsToday()) {
    candidates.push({ name: session.name, durationMs: session.durationMs, isLive: false });
  }

  if (candidates.length === 0) return "Cok, belum ada data live hari ini.";

  const longest = candidates.reduce((max, c) => (c.durationMs > max.durationMs ? c : max), candidates[0]);
  const statusText = longest.isLive ? "masih live sekarang" : "udah selesai";
  return `Paling lama live hari ini: **${longest.name}**, ${formatDuration(longest.durationMs)} (${statusText}).`;
}

// Sama kayak replyLongestLive - dulu cuma liat viewCount member yang LAGI
// live sekarang, jadi member yang tadi rame banget tapi udah selesai live
// bakal ilang gitu aja dari ranking. Sekarang bandingin PUNCAK penonton
// (peakViewCount, dicatet tiap polling selama live-nya jalan) dari live
// yang lagi jalan MAUPUN yang udah selesai hari ini, terus ambil puncak
// tertinggi per member (kalau dia live 2x hari ini, yang diitung yang
// paling rame di antara keduanya).
function replyTopViewers() {
  const peakByUsername = new Map();

  for (const session of getCompletedSessionsToday()) {
    if (session.peakViewCount == null) continue;
    const prev = peakByUsername.get(session.username);
    if (!prev || session.peakViewCount > prev.peak) {
      peakByUsername.set(session.username, { name: session.name, peak: session.peakViewCount });
    }
  }
  for (const entry of activeLives.values()) {
    if (entry.peakViewCount == null) continue;
    const prev = peakByUsername.get(entry.username);
    if (!prev || entry.peakViewCount > prev.peak) {
      peakByUsername.set(entry.username, { name: entry.name, peak: entry.peakViewCount });
    }
  }

  if (peakByUsername.size === 0) return "Cok, belum ada data penonton buat hari ini.";

  const sorted = [...peakByUsername.values()].sort((a, b) => b.peak - a.peak);
  const medals = ["🥇", "🥈", "🥉"];
  const lines = sorted.map((entry, i) => {
    const medal = medals[i] || `${i + 1}.`;
    return `${medal} **${entry.name}** - 👁️ ${formatViewCount(entry.peak)} (puncak)`;
  });

  return `👀 Paling rame ditonton hari ini (puncak penonton):\n${lines.join("\n")}`;
}

function replyBotStatus() {
  return `✅ Bot jalan normal. Lagi mantau ${activeLives.size} member yang live sekarang.`;
}

function replySpecificMember(entry) {
  // entry.liveAt datang MENTAH dari live_at API IDN (idnApi.js gak validasi
  // format-nya) - divalidasi eksplisit di sini soalnya formatClockWIB()
  // (Intl.DateTimeFormat) THROW kalau dikasih Invalid Date (bukan ngasih
  // teks aneh kayak formatDuration/describeElapsed dengan NaN) - tanpa ini,
  // satu live_at yang kebetulan rusak bikin "cok siapa yang live <nama>"
  // gagal total tanpa balesan sama sekali (lihat notify/liveNotify.js's
  // sendDiscordNotif buat bug sekelas ini yang ketemu duluan).
  const liveAtDate = entry.liveAt ? new Date(entry.liveAt) : null;
  const liveAtValid = liveAtDate && !Number.isNaN(liveAtDate.getTime());
  const elapsedText = describeElapsed(liveAtValid ? Date.now() - liveAtDate.getTime() : 0);
  const startText = liveAtValid ? `, mulai jam ${formatClockWIB(liveAtDate)}` : "";
  const viewText = entry.viewCount != null ? ` | 👁️ ${formatViewCount(entry.viewCount)} penonton` : "";
  const liveUrl = `https://idn.app/${entry.username}/live/${entry.slug}`;
  return `**${entry.name}** lagi live, ${elapsedText}${startText}${viewText}. ${liveUrl}`;
}

function replyMemberNotFound(fragment) {
  return `Cok, nggak nemu member "${fragment}" yang lagi live. Coba cek ejaannya, atau tanya "cok siapa yang live" buat liat daftarnya.`;
}

function replyHelp() {
  const ownerContact = PRIORITY_PING_USER_ID ? `<@${PRIORITY_PING_USER_ID}>` : "owner channel ini";
  return [
    "Cok bisa jawab ini:",
    '- "cok ini yang masih live siapa aja?"',
    '- "cok siapa yang paling lama live hari ini?"',
    '- "cok siapa yang paling rame ditonton hari ini?"',
    '- "cok status"',
    '- "cok <nama member> masih live?"',
    '- "cok stats <nama member>" - statistik durasi live-nya',
    '- "cok berapa kali <nama member> live" - total berapa kali dia udah live semenjak bot ini jalan',
    '- "cok siapa yang paling sering live" - leaderboard total live count semua member',
    '- "cok kapan <nama member> biasanya live?" / "cok jadwal <nama>" - pola jam/hari dari histori (bukan jadwal resmi)',
    '- "cok gifter <nama member>" - top gifter (snapshot terakhir dari "npm run cek-gifter", bukan real-time)',
    '- "cok rekap hari ini" - rekap live yang udah selesai hari ini',
    '- "cok rekap minggu ini" / "cok rekap bulan ini" - rekap 7/30 hari terakhir',
    '- "cok daftar prioritas" - lihat member prioritas',
    '- "cok ingetin <nama member>" - kamu di-tag pribadi kalau dia mulai live',
    '- "cok berhenti ingetin <nama member>" - matiin reminder itu',
    '- "cok reminder aku" - lihat kamu subscribe reminder siapa aja',
    '- (khusus owner) "cok tambah prioritas <nama>" / "cok hapus prioritas <nama>"',
    "",
    'Kalau abis muncul menu tombol, kamu juga bisa cukup balas angkanya doang (misal "1" atau "4 Nala") tanpa perlu klik.',
    `Ada yang belum kejawab? Hubungi ${ownerContact}.`,
  ].join("\n");
}

// Daftar SEMUA member prioritas (bawaan Nala/Levi/Lily + custom yang
// ditambahin owner lewat chat) - siapa aja boleh nanya ini, bukan cuma owner.
function replyPriorityList() {
  const all = getAllPriorityMembers().sort((a, b) => a.rank - b.rank);
  if (all.length === 0) return "Cok, belum ada member prioritas yang diset.";
  const lines = all.map((p) => `${p.rank}. **${p.label}** (keyword: "${p.keyword}")`);
  return `⭐ Daftar member prioritas:\n${lines.join("\n")}`;
}

// Kebalikan dari handleSubscribe/handleUnsubscribe - buat user nanya "aku
// subscribe siapa aja sih" tanpa harus inget-inget sendiri.
function replyMySubscriptions(authorId) {
  const subs = loadSubscriptions();
  const keywords = Object.entries(subs)
    .filter(([, ids]) => ids.includes(authorId))
    .map(([keyword]) => keyword);

  if (keywords.length === 0) {
    return 'Cok, kamu belum subscribe reminder buat siapa pun. Ketik "cok ingetin <nama member>" buat mulai.';
  }
  return `🔔 Kamu subscribe reminder buat: ${keywords.map((k) => `"${k}"`).join(", ")}`;
}

// Discord ngerender fenced code block (```) monospace - dipake buat nyusun
// tabel yang kolomnya rapi rata kiri-kanan, bukan cuma daftar baris teks.
// Dipecah per PAGE_SIZE baris biar sesi yang buanyak hari ini nggak numbrung
// ngelewatin limit 2000 karakter per pesan Discord - sebelumnya kelebihan
// cuma di-buang diem-diem (cuma dikasih catetan "+N sesi lainnya"), sekarang
// bisa diminta liat halaman berikutnya lewat "cok rekap" -> jawab "y".
const RECAP_TABLE_PAGE_SIZE = 20;

function buildRecapTablePage(sessions, page) {
  const sorted = [...sessions].sort((a, b) => a.startedAtUnix - b.startedAtUnix);
  const totalPages = Math.max(1, Math.ceil(sorted.length / RECAP_TABLE_PAGE_SIZE));
  const clampedPage = Math.min(Math.max(page, 0), totalPages - 1);
  const start = clampedPage * RECAP_TABLE_PAGE_SIZE;
  const pageSessions = sorted.slice(start, start + RECAP_TABLE_PAGE_SIZE);

  const header = ["No", "Member", "Status", "Mulai", "Durasi"];
  const rows = pageSessions.map((s, i) => {
    const startedAt = new Date(s.startedAtUnix * 1000);
    // Live yang mulai sebelum tengah malam WIB tapi baru selesai/kecatet
    // SETELAH lewat tengah malam (mis. mulai 22:50 kemarin, kelar 00:39 hari
    // ini) tetep numpang di tabel rekap "hari ini" (soalnya log harian
    // ngikutin tanggal WIB pas sesi itu SELESAI/kecatet, bukan pas mulai) -
    // tanpa penanda ini, jam mulainya keliatan kayak jam mulai HARI INI juga,
    // padahal bukan. Ditambahin "(DD/MM)" di sebelah jam kalau tanggal WIB
    // mulainya beda dari tanggal "hari ini".
    const startedOnDifferentDay = getDateWIB(startedAt) !== getTodayWIB();
    const mulaiText = startedOnDifferentDay ? `${formatClockWIB(startedAt)} (${formatShortDateWIB(startedAt)})` : formatClockWIB(startedAt);
    return [
      String(start + i + 1),
      s.name,
      s.endedAtUnix !== null ? "Selesai" : "Live",
      mulaiText,
      s.endedAtUnix !== null ? formatDuration(s.durationMs) : "-",
    ];
  });

  const widths = header.map((h, col) => Math.max(h.length, ...rows.map((r) => r[col].length)));
  const formatRow = (cols) => cols.map((c, i) => c.padEnd(widths[i])).join(" | ");
  const separator = widths.map((w) => "-".repeat(w)).join("-+-");

  const text = ["```", formatRow(header), separator, ...rows.map(formatRow), "```"].join("\n");
  return { text, page: clampedPage, totalPages, hasMore: clampedPage < totalPages - 1 };
}

// Gabungan "gambaran lengkap hari ini" - sesi yang UDAH SELESAI hari ini
// (dari daily-log.json) + yang MASIH LIVE SEKARANG (dari activeLives,
// dibentuk jadi baris ala-sesi biar bisa numpang bareng di tabel/hitungan
// yang sama). Sama pola-nya kayak replyLongestLive()/replyTopViewers()
// (yang udah lebih dulu gabungin dua sumber ini) - diexport biar bisa dites
// langsung, sama kayak buildRecapTablePage.
function getTodaySessionsForRecap() {
  const completed = getCompletedSessionsToday();
  const ongoing = [...activeLives.values()].map((entry) => ({
    name: entry.name,
    username: entry.username,
    startedAtUnix: Math.floor(new Date(entry.liveAt).getTime() / 1000),
    endedAtUnix: null,
    durationMs: null,
    peakViewCount: entry.peakViewCount ?? entry.viewCount ?? null,
  }));
  return [...completed, ...ongoing];
}

// "channelId:authorId" -> { currentPage, totalPages, at, rangeDays } - nunggu
// jawaban y/mundur/n abis nunjukkin 1 halaman tabel rekap. Sama pola-nya
// kayak pendingWatchConfirm (di chat/menu.js, di-key per orang bukan per
// channel, biar jawaban orang lain di channel yang sama gak nyasar ke
// halaman punya orang ini). `rangeDays` (null = "hari ini", gabungan sama
// activeLives; angka = rekap mingguan/bulanan, cuma sesi yang UDAH selesai)
// dicatet biar halaman lain tau harus narik dari daftar sesi yang SAMA,
// bukan default balik ke rekap hari ini - dulu (sebelum rekap mingguan/
// bulanan ada) cuma ada 1 jenis rekap jadi ini gak masalah, sekarang WAJIB
// biar navigasi halaman rekap minggu ini gak diem-diem ganti jadi nunjukkin
// rekap hari ini.
//
// SENGAJA nyimpen currentPage (bukan cuma nextPage kayak sebelumnya) dan
// nyimpen pending state SELAMA totalPages > 1 - BUKAN cuma pas hasMore true
// (ada halaman berikutnya). Sebelumnya, begitu user nyampe halaman TERAKHIR,
// pending state-nya gak pernah kebentuk (hasMore-nya udah false), jadi user
// yang lagi di halaman terakhir gak punya cara mundur balik ke halaman
// sebelumnya sama sekali - itu bug yang dilaporin owner: "list-nya gak bisa
// dimundurin ya?".
const pendingRecapPage = new Map();
const PENDING_RECAP_PAGE_TTL_MS = 2 * 60000;

function buildRecapPageBlock(sessions, page, channelId, authorId, rangeDays = null) {
  const result = buildRecapTablePage(sessions, page);
  const hasPrev = result.page > 0;

  let footer;
  if (result.hasMore && hasPrev) {
    footer = `_(Halaman ${result.page + 1}/${result.totalPages} - balas "y"/"maju" buat lanjut, atau "mundur" buat balik ke halaman sebelumnya)_`;
  } else if (result.hasMore) {
    footer = `_(Halaman ${result.page + 1}/${result.totalPages} - masih ada lagi, mau liat halaman berikutnya? Balas "y"/"maju")_`;
  } else if (hasPrev) {
    footer = `_(Halaman ${result.page + 1}/${result.totalPages} - udah paling akhir. Balas "mundur" buat balik ke halaman sebelumnya)_`;
  } else {
    footer = `_(Halaman ${result.page + 1}/${result.totalPages} - udah paling akhir)_`;
  }

  if (result.totalPages > 1 && channelId && authorId) {
    pendingRecapPage.set(`${channelId}:${authorId}`, { currentPage: result.page, totalPages: result.totalPages, at: Date.now(), rangeDays });
  }

  return `${result.text}\n${footer}`;
}

// Dicek di awal chat/router.js's buildChatReply (sama pola kayak
// menu.js's tryHandleWatchConfirmShortcut) - jawaban "y"/"maju"/"mundur"/"n"
// polos buat navigasi halaman rekap gak nyebut "cok"/"live", jadi harus
// ditangkep sebelum gerbang wake-word.
async function tryHandleRecapPageShortcut(text, channelId, authorId) {
  if (!channelId || !authorId) return null;
  const key = `${channelId}:${authorId}`;
  const pending = pendingRecapPage.get(key);
  if (!pending) return null;

  if (Date.now() - pending.at > PENDING_RECAP_PAGE_TTL_MS) {
    pendingRecapPage.delete(key);
    return null;
  }

  // "y" tetep didukung (biar gak ngerusak kebiasaan lama) - NEXT_PAGE_PATTERN
  // ("maju"/"forward"/dst) itu TAMBAHAN, bukan gantiin. Lihat komentar di
  // NEXT_PAGE_PATTERN (utils.js) buat kenapa dipisah dari YES_PATTERN.
  const isNext = YES_PATTERN.test(text) || NEXT_PAGE_PATTERN.test(text);
  const isPrev = PREV_PAGE_PATTERN.test(text);
  const isStop = NO_PATTERN.test(text);
  if (!isNext && !isPrev && !isStop) return null;

  if (isStop) {
    pendingRecapPage.delete(key);
    return "Oke, segitu aja ya.";
  }

  if (isNext && pending.currentPage >= pending.totalPages - 1) {
    return 'Cok, ini udah halaman paling akhir. Balas "mundur" kalau mau balik.';
  }
  if (isPrev && pending.currentPage <= 0) {
    return 'Cok, ini udah halaman pertama, gak bisa mundur lagi. Balas "y"/"maju" kalau mau lanjut.';
  }

  const targetPage = isNext ? pending.currentPage + 1 : pending.currentPage - 1;
  const sessions = pending.rangeDays == null ? getTodaySessionsForRecap() : getCompletedSessionsSince(pending.rangeDays);
  return buildRecapPageBlock(sessions, targetPage, channelId, authorId, pending.rangeDays);
}

// Versi on-demand dari rekap harian otomatis (yang ngirim sendiri jam 23:00
// WIB) - ini dipanggil kapan aja user nanya, nunjukkin progress SEJAUH INI
// (live yang masih berlangsung belum ikut ke-hitung, baru masuk pas selesai).
// Async karena nyoba lengkapin data lokal pakai arsip eksternal. Kalau
// arsipnya gak keambil (network error/dll), fungsi ini tetep balikin rekap
// versi lokal doang - gak pernah gagal total gara-gara sumber tambahan ini.
async function replyTodayRecapSoFar(channelId, authorId) {
  const sessions = getTodaySessionsForRecap();
  const completed = sessions.filter((s) => s.endedAtUnix !== null);
  const ongoingCount = sessions.length - completed.length;

  // Member yang KETAUAN live hari ini dari arsip eksternal, tapi beneran gak
  // ke-track lokal sama sekali (bukan cuma "masih live", tapi bot-nya emang
  // kelewatan momennya - mis. sempet mati/restart pas dia live).
  const trackedNames = new Set(sessions.map((s) => s.name));
  const external = await fetchExternalTodayLiveHistory();
  const missedByMember = new Map();
  for (const e of external || []) {
    if (trackedNames.has(e.creator_name) || activeLives.has(e.username)) continue;
    if (!missedByMember.has(e.creator_name)) missedByMember.set(e.creator_name, e);
  }
  const missedNote =
    missedByMember.size > 0
      ? `\n\n📡 Dari arsip publik JKT48Live-Record, ketauan juga live hari ini yang kelewatan bot: ${[...missedByMember.entries()]
          .map(([name, e]) => `**${name}** (${formatClockWIB(new Date(e.live_at_unix * 1000))})`)
          .join(", ")} - durasinya belum ke-track soalnya bot nggak nyaksiin dari awal sampai selesai.`
      : "";

  if (sessions.length === 0) {
    return `Cok, belum ada yang live hari ini (${getTodayWIB()}).${missedNote}`;
  }

  const totalDurationMs = completed.reduce((sum, s) => sum + s.durationMs, 0);
  const uniqueMembers = new Set(sessions.map((s) => s.name)).size;
  const longest = completed.length > 0 ? completed.reduce((max, s) => (s.durationMs > max.durationMs ? s : max), completed[0]) : null;

  const summaryLines = [
    `📋 **Rekap live hari ini (${getTodayWIB()})**`,
    `Total sesi: ${sessions.length}x dari ${uniqueMembers} member (${completed.length} udah selesai, ${ongoingCount} masih live)`,
  ];
  if (longest) {
    summaryLines.push(
      `Total durasi (yang udah selesai): ${formatDuration(totalDurationMs)} | Paling lama: **${longest.name}** (${formatDuration(longest.durationMs)})`,
    );
  }

  return [summaryLines.join("\n"), buildRecapPageBlock(sessions, 0, channelId, authorId)].join("\n") + missedNote;
}

// Rekap mingguan/bulanan - beda dari replyTodayRecapSoFar dalam 2 hal: (1)
// ini jendela waktu yang UDAH LEWAT/tertutup, jadi gak perlu digabung sama
// activeLives (member yang lagi live sekarang bukan bagian dari "7 hari
// terakhir", itu bagian dari HARI INI, yang bakal numpang di sini juga
// begitu dia beneran selesai), dan (2) gak perlu cek arsip eksternal
// (JKT48Live-Record) - itu arsipnya emang cuma nyimpen bulan berjalan,
// gak didesain buat query rentang lebih lebar.
async function replyRecapRange(daysBack, label, channelId, authorId) {
  const sessions = getCompletedSessionsSince(daysBack);
  if (sessions.length === 0) {
    return `Cok, belum ada live yang kecatet dalam ${label}.`;
  }

  const totalDurationMs = sessions.reduce((sum, s) => sum + s.durationMs, 0);
  const uniqueMembers = new Set(sessions.map((s) => s.name)).size;
  const longest = sessions.reduce((max, s) => (s.durationMs > max.durationMs ? s : max), sessions[0]);

  const summaryLines = [
    `📋 **Rekap ${label}**`,
    `Total sesi: ${sessions.length}x dari ${uniqueMembers} member`,
    `Total durasi gabungan: ${formatDuration(totalDurationMs)} | Paling lama: **${longest.name}** (${formatDuration(longest.durationMs)})`,
  ];

  // Arsip multi-hari ini masih baru (lihat storage/dailyLog.js's
  // getEarliestSessionDate) - kalau rentang yang diminta (7/30 hari) mundur
  // lebih jauh dari data paling tua yang beneran ada, kasih tau KENAPA
  // rekapnya keliatan pendek daripada diem-diem keliatan kayak ada yang bug.
  const windowStartDate = getDateWIB(new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000));
  const earliestDate = getEarliestSessionDate();
  if (earliestDate && earliestDate > windowStartDate) {
    summaryLines.push(
      `_(Catatan: pencatatan multi-hari baru mulai ${earliestDate}, jadi rentang ${daysBack} hari ini belum penuh - bakal lengkap sendirinya seiring bot jalan terus.)_`,
    );
  }

  return [summaryLines.join("\n"), buildRecapPageBlock(sessions, 0, channelId, authorId, daysBack)].join("\n");
}

function replyMemberStats(fragment) {
  const found = findDurationHistoryByNameFragment(fragment);
  if (!found || found.entries.length === 0) {
    return `Cok, belum ada data riwayat live buat "${fragment.trim()}".`;
  }

  const durations = found.entries.map((e) => e.durationMs);
  const total = durations.reduce((a, b) => a + b, 0);
  const avg = total / durations.length;
  const max = Math.max(...durations);

  return [
    `📊 Statistik **${found.displayName}** (${durations.length} live terakhir yang ke-track):`,
    `- Rata-rata durasi: ${formatDuration(avg)}`,
    `- Rekor terlama: ${formatDuration(max)}`,
  ].join("\n");
}

// Beda dari replyMemberStats di atas (yang datanya dibatesin 10 live
// TERAKHIR buat ngitung rata-rata/rekor) - ini counter TOTAL yang gak
// pernah di-prune/reset (storage/liveCount.js), jadi bisa jawab "udah
// berapa kali live SEMENJAK bot ini jalan", bukan cuma dari histori terbatas.
function replyLiveCount(fragment) {
  const name = (fragment || "").trim();
  if (!name) return 'Live count siapa? Ketik nama membernya juga ya, misal "cok berapa kali nala live".';

  const found = findLiveCountByNameFragment(name);
  if (!found) return `Cok, belum ada catatan live buat "${name}" semenjak bot ini jalan.`;

  const sinceText = getDateWIB(new Date(found.firstLiveAt));
  const lastText = formatRelativeTime(new Date(found.lastLiveAt));
  return `📊 **${found.name}** udah live **${found.count}x** semenjak bot ini mulai mantau (dari ${sinceText}). Terakhir live ${lastText}.`;
}

// Beda lagi dari replyLiveCount (satu member spesifik) - ini leaderboard
// SEMUA member sekaligus, diurutin dari yang paling sering live. Sumbernya
// sama (storage/liveCount.js, counter TOTAL yang gak pernah di-prune).
function replyLiveCountLeaderboard() {
  const top = getLiveCountLeaderboard(10);
  if (top.length === 0) return "Cok, belum ada catatan live sama sekali semenjak bot ini jalan.";

  const medals = ["🥇", "🥈", "🥉"];
  const lines = top.map((entry, i) => `${medals[i] || `${i + 1}.`} **${entry.name}** - ${entry.count}x live`);
  return `📊 Paling sering live semenjak bot ini jalan:\n${lines.join("\n")}`;
}

// PENTING: IDN nggak nyediain jadwal live resmi sama sekali (udah dicek
// langsung ke API-nya). Jadi ini PURE statistik dari histori kita SENDIRI
// (live-duration-history.json, maks 10 entry terakhir per orang) - bukan
// jaminan/jadwal pasti, bisa aja meleset kalau pola live-nya emang nggak
// tetap. live-duration-history.json cuma nyimpen timestamp SELESAI (`at`)
// + durasinya, BUKAN timestamp mulai eksplisit - jadi waktu MULAI live
// diperkirakan mundur (at - durationMs), bukan dibaca langsung dari field.
function replySchedulePattern(fragment) {
  const found = findDurationHistoryByNameFragment(fragment);
  if (!found || found.entries.length === 0) {
    return `Cok, belum ada riwayat live buat "${fragment.trim()}" - belum bisa nebak polanya.`;
  }

  const { entries, displayName } = found;
  if (entries.length < 3) {
    return `Cok, riwayat **${displayName}** baru ada ${entries.length}x - masih kurang buat nebak pola jadwalnya (minimal 3x live yang ke-track). Coba tanya lagi lain kali.`;
  }

  const startTimes = entries.map((e) => new Date(new Date(e.at).getTime() - e.durationMs));
  const total = startTimes.length;

  const bucketCounts = {};
  const weekdayCounts = {};
  const hoursByBucket = {};
  for (const startDate of startTimes) {
    const hourWIB = getHourWIBOf(startDate);
    const bucket = getTimeOfDayBucket(hourWIB);
    bucketCounts[bucket] = (bucketCounts[bucket] || 0) + 1;
    (hoursByBucket[bucket] = hoursByBucket[bucket] || []).push(hourWIB);

    const weekday = WEEKDAY_FORMATTER_WIB.format(startDate);
    weekdayCounts[weekday] = (weekdayCounts[weekday] || 0) + 1;
  }

  const [topBucketName, topBucketCount] = Object.entries(bucketCounts).sort((a, b) => b[1] - a[1])[0];
  const [topWeekdayName, topWeekdayCount] = Object.entries(weekdayCounts).sort((a, b) => b[1] - a[1])[0];

  // "malam" ngerangkum jam 18-23 SAMA 0-3 (lewat tengah malam) - kalau
  // dihitung range min/max mentah, itu bisa keliatan salah ("00-23", nutupin
  // seharian) padahal beneran cuma sekelompok jam malam yang nyambung lewat
  // pergantian hari. Digeser +24 dulu buat jam dini hari (0-3) biar urutannya
  // bener secara matematis, baru di-mod 24 lagi pas ditampilin.
  const rawHours = hoursByBucket[topBucketName];
  const rangeHours = topBucketName === "malam" ? rawHours.map((h) => (h < 4 ? h + 24 : h)) : rawHours;
  const rangeMin = Math.min(...rangeHours) % 24;
  const rangeMax = Math.max(...rangeHours) % 24;
  const pad2 = (n) => String(n).padStart(2, "0");

  const lines = [
    `📅 Pola live **${displayName}** (dari ${total} live terakhir yang ke-track):`,
    `- Paling sering **${topBucketName}**, sekitar jam ${pad2(rangeMin)}-${pad2(rangeMax)} WIB (${topBucketCount}/${total}x)`,
  ];
  if (topWeekdayCount / total >= 0.4) {
    lines.push(`- Hari yang sering: **${topWeekdayName}** (${topWeekdayCount}/${total}x)`);
  }
  lines.push("_(Pola dari histori doang, BUKAN jadwal resmi - IDN nggak nyediain jadwal, jadi bisa aja meleset.)_");

  return lines.join("\n");
}

// PENTING: ini SNAPSHOT (foto sesaat), bukan live/real-time. Bot ini sendiri
// nggak pernah manggil API top-gifter (butuh login pribadi) - datanya cuma
// seakurat terakhir kali kamu jalanin "npm run cek-gifter" manual, jadi
// selalu dikasih tau "dicek X lalu" biar orang gak salah kira ini real-time.
function formatGifterSnapshotReply(found) {
  const checkedText = formatRelativeTime(new Date(found.checkedAt));
  if (!found.gifters || found.gifters.length === 0) {
    return `Cok, **${found.name}** belum ada gifter di data terakhir (dicek ${checkedText}, bukan live real-time).`;
  }

  const medals = ["🥇", "🥈", "🥉"];
  const lines = found.gifters
    .slice(0, 10)
    .map((g, i) => `${medals[i] || `${i + 1}.`} ${g.name} - ${Number(g.total_gold).toLocaleString("id-ID")} Gold`);

  return [`🏆 **Top Gifter ${found.name}** (dicek ${checkedText}, BUKAN live real-time)`, ...lines].join("\n");
}

function replyGifterSnapshot(fragment) {
  const name = (fragment || "").trim();
  if (!name) return 'Gifter siapa? Ketik nama membernya juga ya, misal "cok gifter kathrina".';

  const found = findGifterSnapshotByNameFragment(name);
  if (!found) {
    return `Cok, belum ada data top gifter buat "${name}". Yang pegang akun IDN-nya bisa jalanin "npm run cek-gifter" dulu di komputernya biar ke-update.`;
  }
  return formatGifterSnapshotReply(found);
}

// Dipake dari dropdown tombol (fallback_select:9) - beda dari replyGifterSnapshot
// yang nyari lewat FRAGMEN nama (bisa ambigu kalau ada 2 member namanya mirip),
// ini langsung ambil dari username yang UDAH PASTI dipilih user dari dropdown,
// gak perlu nebak-nebak lagi.
function replyGifterSnapshotByUsername(username) {
  const { members } = loadGifterSnapshot();
  const data = members[username];
  if (!data) {
    return `Cok, belum ada data top gifter buat member ini. Yang pegang akun IDN-nya bisa jalanin "npm run cek-gifter" dulu biar ke-update.`;
  }
  return formatGifterSnapshotReply({ username, ...data });
}

function isOwner(authorId) {
  return Boolean(PRIORITY_PING_USER_ID) && authorId === PRIORITY_PING_USER_ID;
}

function handleAddPriority(nameFragment, authorId) {
  if (!isOwner(authorId)) return "Cok, cuma owner yang boleh ubah daftar prioritas.";
  const name = stripTrailingLiveWord(nameFragment);
  const result = addCustomPriorityMember(name);
  if (!result.ok && result.reason === "exists") return `"${name}" udah ada di daftar prioritas.`;
  if (!result.ok && result.reason === "too_short") return "Nama/keyword-nya kependekan, minimal 3 huruf ya.";
  if (!result.ok) return "Gagal nambahin, coba lagi.";
  return `✅ "${name}" ditambahin ke daftar prioritas, notif live-nya bakal jadi flashy sekarang.`;
}

function handleRemovePriority(nameFragment, authorId) {
  if (!isOwner(authorId)) return "Cok, cuma owner yang boleh ubah daftar prioritas.";
  const name = stripTrailingLiveWord(nameFragment);
  const result = removeCustomPriorityMember(name);
  if (!result.ok) return `"${name}" nggak ketemu di daftar prioritas custom (Nala/Levi/Lily nggak bisa dihapus lewat chat).`;
  return `✅ "${name}" dihapus dari daftar prioritas.`;
}

// Beda dari priority list (khusus owner), subscribe ini SIAPA AJA boleh -
// personal reminder buat di-tag pas member manapun mulai live.
function handleSubscribe(rawName, authorId) {
  const name = stripTrailingLiveWord(rawName);
  const result = addSubscription(name, authorId);
  if (!result.ok && result.reason === "too_short") return "Nama membernya kependekan, minimal 3 huruf ya.";
  if (!result.ok && result.reason === "already") return `Kamu udah subscribe notif buat "${name}" kok.`;
  if (!result.ok) return "Gagal subscribe, coba lagi.";
  return `🔔 Sip, kamu bakal di-tag tiap kali "${name}" mulai live!`;
}

function handleUnsubscribe(rawName, authorId) {
  const name = stripTrailingLiveWord(rawName);
  const result = removeSubscription(name, authorId);
  if (!result.ok) return `Kamu belum subscribe "${name}".`;
  return `🔕 Oke, notif buat "${name}" dimatiin.`;
}

module.exports = {
  replyListLive,
  replyLongestLive,
  replyTopViewers,
  replyBotStatus,
  replySpecificMember,
  replyMemberNotFound,
  replyHelp,
  replyPriorityList,
  replyMySubscriptions,
  replyMemberStats,
  replyLiveCount,
  replyLiveCountLeaderboard,
  replySchedulePattern,
  formatGifterSnapshotReply,
  replyGifterSnapshot,
  replyGifterSnapshotByUsername,
  replyTodayRecapSoFar,
  replyRecapRange,
  getTodaySessionsForRecap,
  buildRecapTablePage,
  buildRecapPageBlock,
  tryHandleRecapPageShortcut,
  isOwner,
  handleAddPriority,
  handleRemovePriority,
  handleSubscribe,
  handleUnsubscribe,
};
