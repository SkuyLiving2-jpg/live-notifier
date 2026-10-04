// "cok grafik <nama member>" (chat/router.js) DAN "/grafik" (chat/slashCommands.js)
// - saran fitur ke-2 dari batch "line count iseng" yang owner minta beneran
// dikerjain. Render GAMBAR (bar chart durasi live 10 sesi terakhir), bukan
// teks/embed kayak reply lain - satu-satunya fitur di bot ini yang beneran
// gambar raster (§10's export-CSV juga ngirim file, tapi itu data mentah,
// bukan visual).
//
// Library: @napi-rs/canvas (BUKAN "canvas"/node-canvas biasa) - node-canvas
// butuh compile native (Cairo/Pango) yang bisa gagal/lambat di beberapa host
// (termasuk Railway punya riwayat buildpack yang rewel soal native addon),
// @napi-rs/canvas ngirim prebuilt binary per-platform (Rust/napi-rs), jadi
// `npm install` doang, gak ada resiko build gagal di deploy.
//
// Font: DIREGISTER MANUAL dari file .ttf yang di-bundle (dejavu-fonts-ttf),
// BUKAN ngandelin font sistem ("sans-serif" biasa) - environment produksi
// (container Linux minimal di Railway) kemungkinan BESAR nggak punya font
// apapun ke-install, dan canvas DIAM-DIAM gagal render teks (bukan error,
// cuma kosong/tofu) kalau font-nya gak ketemu. Constructor testable/portable
// di komputer manapun (Windows dev, Railway prod) - register sekali pas
// modul ini pertama di-require, bukan tiap kali chart dibikin.
const path = require("path");
const { createCanvas, GlobalFonts } = require("@napi-rs/canvas");
const { ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");
const { activeLives } = require("../storage/activeLives");
const { SESSION_RETENTION_DAYS, getCompletedSessionsSince } = require("../storage/dailyLog");
const { findDurationHistoryByNameFragment, loadDurationHistory } = require("../storage/durationHistory");
const { formatDuration, formatShortDateWIB } = require("../utils");
const { describeMissingMember, resolveRecapMember } = require("./replies");
const { deleteInteractionMessage } = require("./interactionHelpers");

const FONT_REGULAR = "ChartSans";
const FONT_BOLD = "ChartSansBold";
// GlobalFonts.registerFromPath sengaja dibungkus try/catch - kalau paketnya
// somehow ke-hapus/rusak (mis. install parsial), chart-nya gagal jadi
// gambar polos/gak ada teks daripada bikin SELURUH bot down (require() gak
// pernah boleh throw buat modul yang di-require pas boot). Fallback font
// generic ("sans-serif") tetep dicoba di CSS font-nya (lihat drawChart) -
// kalau registrasi gagal, minimal masih ada KEMUNGKINAN sistem punya font
// terinstall, daripada gambar kosong tanpa font sama sekali.
try {
  GlobalFonts.registerFromPath(path.join(__dirname, "..", "..", "node_modules", "dejavu-fonts-ttf", "ttf", "DejaVuSans.ttf"), FONT_REGULAR);
  GlobalFonts.registerFromPath(path.join(__dirname, "..", "..", "node_modules", "dejavu-fonts-ttf", "ttf", "DejaVuSans-Bold.ttf"), FONT_BOLD);
} catch (error) {
  console.error("Gagal register font buat chart (grafik tetep jalan, cuma mungkin tanpa teks):", error.message);
}

const CHART_WIDTH = 900;
const CHART_HEIGHT = 500;
const MARGIN = { top: 74, right: 30, bottom: 64, left: 90 };
const COLORS = {
  background: "#1e1f22", // senada tema gelap Discord (bukan matching sempurna, cuma biar nggak "kotak putih nyala" di client gelap)
  grid: "#3a3b3f",
  bar: "#5865f2", // "blurple" - warna yang sama dipake DAILY_RECAP_COLOR (config.js), biar chart ini kerasa satu identitas visual sama rekap otomatis
  barRecord: "#57f287", // ijo - nyorot sesi TERLAMA (rekor durasi member itu sendiri, bukan rekor global)
  avgLine: "#faa61a", // kuning/oranye - beda jauh dari warna bar, gampang dibedain sebagai garis referensi
  text: "#e3e5e8",
  subtext: "#9a9ca0",
};

// Dipisah dari bagian gambar (drawChart di bawah) biar bisa DITES LANGSUNG
// tanpa perlu inspeksi pixel PNG - sama filosofinya kayak computeNextPollDelay
// (monitor.js) yang misahin logic murni dari orkestrasi yang nyentuh I/O.
// `entries` diasumsikan udah kronologis (oldest dulu) - itu emang kontrak
// findDurationHistoryByNameFragment/loadDurationHistory (lihat recordLiveDurationAt).
function computeDurationChartMetrics(entries) {
  const durations = entries.map((e) => e.durationMs);
  const maxDurationMs = Math.max(...durations);
  const avgDurationMs = durations.reduce((a, b) => a + b, 0) / durations.length;
  const recordIndex = durations.indexOf(maxDurationMs);
  // Floor 1 menit - jaga-jaga murni (durasi live beneran gak akan pernah
  // sekecil ini dalam praktiknya) biar skala Y gak pernah kebagi 0/nyaris 0
  // (yang bakal bikin tinggi bar jadi NaN/Infinity).
  const scaleMaxMs = Math.max(maxDurationMs * 1.15, 60000);
  return { maxDurationMs, avgDurationMs, recordIndex, scaleMaxMs };
}

// Bikin PNG buffer-nya - INI yang nyentuh canvas (efek samping/I/O dalam
// artian "hasilnya gambar", bukan cuma angka), dipisah dari
// computeDurationChartMetrics biar jelas mana yang dites lewat assert angka
// biasa vs mana yang cuma dites "gak crash, balikin buffer PNG valid".
function drawDurationChart(displayName, entries) {
  const { avgDurationMs, recordIndex, scaleMaxMs } = computeDurationChartMetrics(entries);

  const canvas = createCanvas(CHART_WIDTH, CHART_HEIGHT);
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = COLORS.background;
  ctx.fillRect(0, 0, CHART_WIDTH, CHART_HEIGHT);

  const innerWidth = CHART_WIDTH - MARGIN.left - MARGIN.right;
  const innerHeight = CHART_HEIGHT - MARGIN.top - MARGIN.bottom;
  const baseline = CHART_HEIGHT - MARGIN.bottom;
  const valueToY = (ms) => baseline - (ms / scaleMaxMs) * innerHeight;

  // Judul + subjudul.
  ctx.fillStyle = COLORS.text;
  ctx.font = `bold 26px ${FONT_BOLD}, sans-serif`;
  ctx.textAlign = "left";
  ctx.fillText(`Durasi Live - ${displayName}`, MARGIN.left, 40);
  ctx.fillStyle = COLORS.subtext;
  ctx.font = `16px ${FONT_REGULAR}, sans-serif`;
  ctx.fillText(`${entries.length} sesi terakhir - rata-rata ${formatDuration(avgDurationMs)}`, MARGIN.left, 62);

  // Grid horizontal + label sumbu Y (4 pembagian + garis dasar).
  const GRID_DIVISIONS = 4;
  ctx.strokeStyle = COLORS.grid;
  ctx.fillStyle = COLORS.subtext;
  ctx.font = `12px ${FONT_REGULAR}, sans-serif`;
  ctx.textAlign = "right";
  for (let i = 0; i <= GRID_DIVISIONS; i++) {
    const ms = (scaleMaxMs / GRID_DIVISIONS) * i;
    const y = valueToY(ms);
    ctx.beginPath();
    ctx.moveTo(MARGIN.left, y);
    ctx.lineTo(CHART_WIDTH - MARGIN.right, y);
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillText(formatDuration(ms), MARGIN.left - 10, y + 4);
  }

  // Bar per sesi + label tanggal (sumbu X) + label durasi (di atas bar).
  const slotWidth = innerWidth / entries.length;
  const barWidth = slotWidth * 0.6;
  ctx.textAlign = "center";
  entries.forEach((entry, i) => {
    const slotCenterX = MARGIN.left + slotWidth * i + slotWidth / 2;
    const barTopY = valueToY(entry.durationMs);
    const isRecord = i === recordIndex;

    ctx.fillStyle = isRecord ? COLORS.barRecord : COLORS.bar;
    ctx.fillRect(slotCenterX - barWidth / 2, barTopY, barWidth, baseline - barTopY);

    ctx.fillStyle = COLORS.text;
    ctx.font = `12px ${FONT_REGULAR}, sans-serif`;
    ctx.fillText(formatDuration(entry.durationMs), slotCenterX, barTopY - 8);

    ctx.fillStyle = COLORS.subtext;
    ctx.fillText(formatShortDateWIB(new Date(entry.at)), slotCenterX, baseline + 20);
  });

  // Garis rata-rata (putus-putus) - referensi biar gampang liat sesi mana
  // yang di atas/di bawah rata-rata sekilas, tanpa harus baca angka satu-satu.
  const avgY = valueToY(avgDurationMs);
  ctx.strokeStyle = COLORS.avgLine;
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 5]);
  ctx.beginPath();
  ctx.moveTo(MARGIN.left, avgY);
  ctx.lineTo(CHART_WIDTH - MARGIN.right, avgY);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = COLORS.avgLine;
  ctx.font = `bold 12px ${FONT_BOLD}, sans-serif`;
  ctx.textAlign = "right";
  ctx.fillText(`rata-rata: ${formatDuration(avgDurationMs)}`, CHART_WIDTH - MARGIN.right, avgY - 8);

  return canvas.toBuffer("image/png");
}

const MAX_CHART_SESSIONS = 10;

// BUG YANG DILAPORIN OWNER ("grafik dan rekap gak sinkron"): grafik dulu
// HANYA baca riwayat durasi (live-duration-history.json, 10 data terakhir),
// sementara "cok rekap <nama>" baca arsip rekap (daily-log.json, 35 hari) -
// dua file terpisah yang gak selalu berisi hal yang sama (mis. sebagian sesi
// cuma ke-backfill ke salah satunya, atau riwayat durasi kepotong/direset).
// Hasilnya rekap bilang 6 sesi sementara grafik nunjukkin 2 sesi lain yang
// jauh lebih lama.
//
// Aturannya sekarang: DALAM jendela rekap (SESSION_RETENTION_DAYS hari
// terakhir) arsip rekap berlaku SEPENUHNYA - grafik = sesi-sesi yang sama
// dengan tabel "cok rekap <nama>" member itu, riwayat durasi yang nyelip di
// jendela itu tapi gak ada di arsip DIABAIKAN (justru itu sumber gak
// sinkronnya). Riwayat durasi cuma dipake buat (1) nambah sesi yang LEBIH TUA
// dari jendela itu (yang emang udah dipangkas dari rekap, biar member yang
// jarang live tetep dapet grafik berisi), dan (2) cadangan penuh kalau arsip
// rekap member itu kosong sama sekali. Hasilnya 10 sesi TERAKHIR, kronologis
// (terlama dulu).
function mergeChartEntries(
  archiveSessions,
  historyEntries,
  { now = Date.now(), retentionDays = SESSION_RETENTION_DAYS, limit = MAX_CHART_SESSIONS } = {},
) {
  const fromArchive = archiveSessions
    .filter((s) => s.endedAtUnix !== null && s.durationMs > 0)
    .map((s) => ({ name: s.name, durationMs: s.durationMs, at: new Date(s.endedAtUnix * 1000).toISOString() }));

  const windowStartMs = now - retentionDays * 24 * 60 * 60 * 1000;
  const fallbackToHistory = fromArchive.length === 0;
  const historyUsed = fallbackToHistory ? historyEntries : historyEntries.filter((entry) => new Date(entry.at).getTime() < windowStartMs);

  const entries = [...historyUsed, ...fromArchive].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime()).slice(-limit);
  const olderFromHistory = entries.filter((e) => historyUsed.includes(e)).length;
  return { entries, olderFromHistory, fallbackToHistory };
}

// Baris tombol "Tutup" di bawah grafik (owner minta: grafik belum ada tombol
// tutupnya, beda dari fitur lain yang jawabannya bisa ditutup). customId
// sendiri ("chart_flow:close", dibaca router.js) - boleh diklik siapa aja,
// sama kayak semua tombol Tutup lain di bot ini.
function buildChartCloseRow() {
  return new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("chart_flow:close").setLabel("Tutup").setStyle(ButtonStyle.Danger));
}

async function handleChartButton(interaction) {
  if (interaction.customId === "chart_flow:close") await deleteInteractionMessage(interaction);
}

// Titik masuk utama - dipanggil chat/router.js's "cok grafik <nama>" DAN
// chat/slashCommands.js's "/grafik". Async (sama pola-nya kayak
// replyCompareMembers dkk) soalnya describeMissingMember butuh network call
// ke IDN buat mbedain "member beneran tapi belum pernah live" vs "bukan
// member JKT48 sama sekali" kalau gak ketemu datanya.
//
// Member di-resolve lewat resolveRecapMember (SAMA kayak "cok rekap <nama>"),
// bukan cuma fuzzy-match pertama di riwayat durasi - jadi nama yang cocok ke
// beberapa member ditanyain balik ("ketik yang lebih lengkap") persis kayak
// rekap, bukan diem-diem milih yang pertama ketemu. Riwayat durasi tetep jadi
// jalur cadangan buat member yang (entah kenapa) gak ada di live-count.
async function replyDurationChart(fragment) {
  const shown = (fragment || "").trim();
  const resolved = resolveRecapMember(shown);
  if (resolved.status === "ambiguous") {
    return `Cok, ada beberapa member yang cocok sama "${shown}": ${resolved.names.join(", ")}. Ketik nama yang lebih lengkap ya.`;
  }

  let username;
  let displayName;
  if (resolved.status === "ok") {
    ({ username, name: displayName } = resolved);
  } else {
    const fromHistory = findDurationHistoryByNameFragment(shown);
    if (!fromHistory) return describeMissingMember(shown, "digrafikin");
    ({ username, displayName } = fromHistory);
  }

  const archiveSessions = getCompletedSessionsSince(SESSION_RETENTION_DAYS).filter((s) => s.username === username);
  const { entries, olderFromHistory, fallbackToHistory } = mergeChartEntries(archiveSessions, loadDurationHistory()[username] || []);
  const isLiveNow = activeLives.has(username);

  if (entries.length === 0) {
    const liveNote = isLiveNow ? " - dia lagi live sekarang, grafiknya bisa dibikin begitu sesi ini kelar" : "";
    return `Cok, **${displayName}** belum punya sesi live yang udah selesai buat digrafikin${liveNote}.`;
  }

  const notes = [];
  if (fallbackToHistory) {
    notes.push("Rekap gak nyimpen sesi member ini, jadi grafik diambil dari riwayat durasi.");
  } else if (olderFromHistory > 0) {
    notes.push(`${olderFromHistory} sesi yang lebih tua dari ${SESSION_RETENTION_DAYS} hari (udah gak ada di rekap) ikut dari riwayat durasi.`);
  }
  if (isLiveNow) notes.push("Sesi yang lagi live sekarang belum ikut (grafik cuma ngitung sesi yang udah selesai).");

  return {
    content: [`📊 Grafik durasi live **${displayName}** (${entries.length} sesi terakhir yang udah selesai).`, ...notes].join(" "),
    files: [new AttachmentBuilder(drawDurationChart(displayName, entries), { name: `grafik-${username}.png` })],
    components: [buildChartCloseRow()],
  };
}

module.exports = {
  replyDurationChart,
  computeDurationChartMetrics,
  drawDurationChart,
  mergeChartEntries,
  handleChartButton,
  buildChartCloseRow,
  COLORS,
  FONT_REGULAR,
  FONT_BOLD,
};
