// Peringkat: live terlama, penonton terbanyak (per rentang), leaderboard jumlah live, dan yang paling lama gak live.

const { activeLives } = require("../../storage/activeLives");
const { getLiveCountLeaderboard, getLongestNotLiveLeaderboard } = require("../../storage/liveCount");
const { formatDuration, formatRelativeTime, formatViewCount } = require("../../utils");

const { getSessionsForRange } = require("./recap/sessions");

// Dulu cuma bandingin member yang LAGI live sekarang - jadi kalau ada yang
// live 3 jam terus SELESAI, terus member lain baru mulai live 5 menit,
// yang kesebut "paling lama" malah yang baru mulai itu (soalnya yang udah
// selesai udah ilang dari activeLives). Sekarang gabungin durasi live yang
// LAGI JALAN (activeLives) SAMA sesi yang UDAH SELESAI hari ini (daily log)
// biar rekap-nya beneran akurat sepanjang hari, bukan cuma potret sesaat.
//
// §10's fortieth item: diekstrak jadi replyLongestLiveForRange(rangeDays,
// label) biar "paling lama live" bisa nanya rentang laen juga (minggu ini/
// bulan ini/tanggal spesifik), bukan cuma "hari ini" - reuse getSessionsForRange
// yang SAMA persis dipake fitur rekap, jadi "paling lama live bulan ini" dan
// "rekap bulan ini" narik dari sumber data yang identik. Sesi yang MASIH LIVE
// (endedAtUnix null, dari getOngoingSessionsForRecap) durationMs-nya SENGAJA
// null di situ (belum final) - dihitung ULANG di sini dari startedAtUnix biar
// tetep bisa dibandingin ke sesi yang udah selesai.
function replyLongestLiveForRange(rangeDays, label) {
  const sessions = getSessionsForRange(rangeDays);
  if (sessions.length === 0) return `Cok, belum ada data live ${label}.`;

  const candidates = sessions.map((s) => ({
    name: s.name,
    isLive: s.endedAtUnix === null,
    durationMs: s.endedAtUnix === null ? Date.now() - s.startedAtUnix * 1000 : s.durationMs,
  }));

  const longest = candidates.reduce((max, c) => (c.durationMs > max.durationMs ? c : max), candidates[0]);
  const statusText = longest.isLive ? "masih live sekarang" : "udah selesai";
  return `Paling lama live ${label}: **${longest.name}**, ${formatDuration(longest.durationMs)} (${statusText}).`;
}

function replyLongestLive() {
  return replyLongestLiveForRange(null, "hari ini");
}

// Sama kayak replyLongestLive - dulu cuma liat viewCount member yang LAGI
// live sekarang, jadi member yang tadi rame banget tapi udah selesai live
// bakal ilang gitu aja dari ranking. Sekarang bandingin PUNCAK penonton
// (peakViewCount, dicatet tiap polling selama live-nya jalan) dari live
// yang lagi jalan MAUPUN yang udah selesai hari ini, terus ambil puncak
// tertinggi per member (kalau dia live 2x hari ini, yang diitung yang
// paling rame di antara keduanya).
//
// Sama alasannya kayak replyLongestLiveForRange di atas (§10's fortieth
// item) - `peakViewCount` sesi yang MASIH LIVE udah keisi (getOngoingSessionsForRecap
// narik dari activeLives-nya langsung), jadi gak butuh perlakuan khusus
// kayak durationMs di atas.
function replyTopViewersForRange(rangeDays, label) {
  const sessions = getSessionsForRange(rangeDays);
  const peakByUsername = new Map();

  for (const s of sessions) {
    if (s.peakViewCount == null) continue;
    const prev = peakByUsername.get(s.username);
    if (!prev || s.peakViewCount > prev.peak) {
      peakByUsername.set(s.username, { name: s.name, peak: s.peakViewCount });
    }
  }

  if (peakByUsername.size === 0) return `Cok, belum ada data penonton buat ${label}.`;

  const sorted = [...peakByUsername.values()].sort((a, b) => b.peak - a.peak);
  const medals = ["🥇", "🥈", "🥉"];
  const lines = sorted.map((entry, i) => {
    const medal = medals[i] || `${i + 1}.`;
    return `${medal} **${entry.name}** - 👁️ ${formatViewCount(entry.peak)} (puncak)`;
  });

  return `👀 Paling rame ditonton ${label} (puncak penonton):\n${lines.join("\n")}`;
}

function replyTopViewers() {
  return replyTopViewersForRange(null, "hari ini");
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

// Kebalikan dari replyLiveCountLeaderboard - "siapa yang paling LAMA GAK
// live" (saran fitur ke-2, §10's kelimapuluh item). Member yang LAGI live
// SEKARANG sengaja dikeluarin dari daftar ini (dicek lewat activeLives,
// bukan storage/liveCount.js's getLongestNotLiveLeaderboard - modul storage
// gak saling require, lihat komennya di sana) - aneh kalau ada yang lagi
// live detik ini tapi disebut "udah lama gak live" cuma gara-gara gap
// historisnya kebetulan lebar. Dibatesin 10 kayak leaderboard yang sebelahnya.
function replyLongestNotLiveLeaderboard() {
  const ranked = getLongestNotLiveLeaderboard()
    .filter((entry) => !activeLives.has(entry.username))
    .slice(0, 10);
  if (ranked.length === 0) return "Cok, belum ada catatan live sama sekali semenjak bot ini jalan.";

  const lines = ranked.map((entry, i) => `${i + 1}. **${entry.name}** - terakhir live ${formatRelativeTime(new Date(entry.lastLiveAt))}`);
  return `😴 Paling lama gak live (dari yang lagi enggak live sekarang):\n${lines.join("\n")}`;
}

module.exports = {
  replyLongestLiveForRange,
  replyLongestLive,
  replyTopViewersForRange,
  replyTopViewers,
  replyLiveCountLeaderboard,
  replyLongestNotLiveLeaderboard,
};
