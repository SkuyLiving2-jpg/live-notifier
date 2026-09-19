const { activeLives, getSortedActiveLives } = require("../storage/activeLives");
const { getCompletedSessionsToday, fetchExternalTodayLiveHistory } = require("../storage/dailyLog");
const { findDurationHistoryByNameFragment } = require("../storage/durationHistory");
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
  const elapsedText = describeElapsed(Date.now() - new Date(entry.liveAt).getTime());
  const startText = entry.liveAt ? `, mulai jam ${formatClockWIB(new Date(entry.liveAt))}` : "";
  const viewText = entry.viewCount != null ? ` | 👁️ ${formatViewCount(entry.viewCount)} penonton` : "";
  const liveUrl = `https://idn.app/${entry.username}/live/${entry.slug}`;
  return `**${entry.name}** lagi live, ${elapsedText}${startText}${viewText}. ${liveUrl}`;
}

function replyMemberNotFound(fragment) {
  return `Cok, nggak nemu member "${fragment}" yang lagi live. Coba cek ejaannya, atau tanya "cok siapa yang live" buat liat daftarnya.`;
}

function replyHelp() {
  return [
    "Cok bisa jawab ini:",
    '- "cok ini yang masih live siapa aja?"',
    '- "cok siapa yang paling lama live hari ini?"',
    '- "cok siapa yang paling rame ditonton hari ini?"',
    '- "cok status"',
    '- "cok <nama member> masih live?"',
    '- "cok stats <nama member>" - statistik durasi live-nya',
    '- "cok kapan <nama member> biasanya live?" / "cok jadwal <nama>" - pola jam/hari dari histori (bukan jadwal resmi)',
    '- "cok gifter <nama member>" - top gifter (snapshot terakhir dari "npm run cek-gifter", bukan real-time)',
    '- "cok rekap hari ini" - rekap live yang udah selesai hari ini',
    '- "cok daftar prioritas" - lihat member prioritas',
    '- "cok ingetin <nama member>" - kamu di-tag pribadi kalau dia mulai live',
    '- "cok berhenti ingetin <nama member>" - matiin reminder itu',
    '- "cok reminder aku" - lihat kamu subscribe reminder siapa aja',
    '- (khusus owner) "cok tambah prioritas <nama>" / "cok hapus prioritas <nama>"',
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

// "channelId:authorId" -> { nextPage, at } - nunggu jawaban y/n abis nunjukkin
// 1 halaman tabel rekap yang masih ada lanjutannya. Sama pola-nya kayak
// pendingWatchConfirm (di chat/menu.js, di-key per orang bukan per channel,
// biar jawaban orang lain di channel yang sama gak nyasar ke halaman punya
// orang ini).
const pendingRecapPage = new Map();
const PENDING_RECAP_PAGE_TTL_MS = 2 * 60000;

function buildRecapPageBlock(sessions, page, channelId, authorId) {
  const result = buildRecapTablePage(sessions, page);
  const footer = result.hasMore
    ? `_(Halaman ${result.page + 1}/${result.totalPages} - masih ada lagi, mau liat halaman berikutnya? Balas "y")_`
    : `_(Halaman ${result.page + 1}/${result.totalPages} - udah paling akhir)_`;

  if (result.hasMore && channelId && authorId) {
    pendingRecapPage.set(`${channelId}:${authorId}`, { nextPage: result.page + 1, at: Date.now() });
  }

  return `${result.text}\n${footer}`;
}

// Dicek di awal chat/router.js's buildChatReply (sama pola kayak
// menu.js's tryHandleWatchConfirmShortcut) - jawaban "y"/"n" polos buat
// lanjut halaman rekap gak nyebut "cok"/"live", jadi harus ditangkep
// sebelum gerbang wake-word.
async function tryHandleRecapPageShortcut(text, channelId, authorId) {
  if (!channelId || !authorId) return null;
  const key = `${channelId}:${authorId}`;
  const pending = pendingRecapPage.get(key);
  if (!pending) return null;

  if (Date.now() - pending.at > PENDING_RECAP_PAGE_TTL_MS) {
    pendingRecapPage.delete(key);
    return null;
  }

  const isYes = YES_PATTERN.test(text);
  const isNo = NO_PATTERN.test(text);
  if (!isYes && !isNo) return null;

  pendingRecapPage.delete(key);
  if (isNo) return "Oke, segitu aja ya.";

  return buildRecapPageBlock(getTodaySessionsForRecap(), pending.nextPage, channelId, authorId);
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
  replySchedulePattern,
  formatGifterSnapshotReply,
  replyGifterSnapshot,
  replyGifterSnapshotByUsername,
  replyTodayRecapSoFar,
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
