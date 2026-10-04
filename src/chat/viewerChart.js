// "cok grafik penonton <nama>" - kurva jumlah penonton selama satu sesi live
// (sesi terakhir yang sudah selesai, atau sesi yang lagi jalan kalau dia live
// sekarang). Data ini cuma bot ini yang punya: monitor.js menyimpan jumlah
// penonton tiap siklus polling (lihat viewerTimeline.js), IDN app sendiri cuma
// nunjukkin angka saat ini. Gambar PNG, gaya & font sama dengan grafik durasi.
const { createCanvas } = require("@napi-rs/canvas");
const { AttachmentBuilder } = require("discord.js");
const { activeLives } = require("../storage/activeLives");
const { SESSION_RETENTION_DAYS, getCompletedSessionsSince } = require("../storage/dailyLog");
const { getViewerTimelines } = require("../storage/viewerTimelines");
const { cleanSamples, computeViewerStats } = require("../viewerTimeline");
const { formatDuration, formatViewCount, formatClockWIB } = require("../utils");
const { describeMissingMember, resolveRecapMember } = require("./replies");
const { buildChartCloseRow, COLORS, FONT_REGULAR, FONT_BOLD } = require("./chartReply");

const WIDTH = 900;
const HEIGHT = 500;
const MARGIN = { top: 84, right: 34, bottom: 62, left: 86 };

// Skala Y "rapi": ujung atas dibulatkan ke atas ke 1/2/5 x 10^n, biar label
// sumbu tidak aneh (mis. 1.337) dan puncak tidak mentok ke tepi atas.
function niceCeil(value) {
  if (value <= 10) return 10;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  for (const factor of [1, 2, 5, 10]) {
    if (magnitude * factor >= value * 1.08) return magnitude * factor;
  }
  return magnitude * 10;
}

function drawViewerChart(displayName, rawSamples, { inProgress = false } = {}) {
  const samples = cleanSamples(rawSamples);
  const stats = computeViewerStats(samples);
  if (!stats) throw new Error("drawViewerChart butuh minimal 2 sampel");

  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = COLORS.background;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  const innerWidth = WIDTH - MARGIN.left - MARGIN.right;
  const innerHeight = HEIGHT - MARGIN.top - MARGIN.bottom;
  const baseline = HEIGHT - MARGIN.bottom;
  const spanSec = Math.max(1, stats.lastSec - stats.firstSec);
  const scaleMax = niceCeil(stats.peak);
  const xOf = (t) => MARGIN.left + ((t - stats.firstSec) / spanSec) * innerWidth;
  const yOf = (v) => baseline - (v / scaleMax) * innerHeight;

  ctx.fillStyle = COLORS.text;
  ctx.font = `bold 26px ${FONT_BOLD}, sans-serif`;
  ctx.textAlign = "left";
  ctx.fillText(`Penonton Live - ${displayName}`, MARGIN.left, 40);
  ctx.fillStyle = COLORS.subtext;
  ctx.font = `16px ${FONT_REGULAR}, sans-serif`;
  const subtitle = `${inProgress ? "Sedang live" : "Sesi selesai"} - ${formatDuration(spanSec * 1000)} - puncak ${formatViewCount(stats.peak)} - rata-rata ${formatViewCount(Math.round(stats.avg))}`;
  ctx.fillText(subtitle, MARGIN.left, 64);

  // Grid + label sumbu Y.
  const GRID = 4;
  ctx.lineWidth = 1;
  ctx.textAlign = "right";
  ctx.font = `12px ${FONT_REGULAR}, sans-serif`;
  for (let i = 0; i <= GRID; i++) {
    const v = (scaleMax / GRID) * i;
    const y = yOf(v);
    ctx.strokeStyle = COLORS.grid;
    ctx.beginPath();
    ctx.moveTo(MARGIN.left, y);
    ctx.lineTo(WIDTH - MARGIN.right, y);
    ctx.stroke();
    ctx.fillStyle = COLORS.subtext;
    ctx.fillText(formatViewCount(Math.round(v)), MARGIN.left - 10, y + 4);
  }

  // Label sumbu X: waktu sejak mulai.
  ctx.textAlign = "center";
  const X_TICKS = 4;
  for (let i = 0; i <= X_TICKS; i++) {
    const t = stats.firstSec + (spanSec / X_TICKS) * i;
    ctx.fillStyle = COLORS.subtext;
    ctx.fillText(i === 0 ? "mulai" : `+${formatDuration((t - stats.firstSec) * 1000)}`, xOf(t), baseline + 22);
  }

  // Area di bawah kurva + garis kurva.
  ctx.beginPath();
  ctx.moveTo(xOf(samples[0][0]), baseline);
  for (const [t, v] of samples) ctx.lineTo(xOf(t), yOf(v));
  ctx.lineTo(xOf(samples[samples.length - 1][0]), baseline);
  ctx.closePath();
  ctx.fillStyle = "rgba(88, 101, 242, 0.25)";
  ctx.fill();

  ctx.beginPath();
  samples.forEach(([t, v], i) => (i === 0 ? ctx.moveTo(xOf(t), yOf(v)) : ctx.lineTo(xOf(t), yOf(v))));
  ctx.strokeStyle = COLORS.bar;
  ctx.lineWidth = 3;
  ctx.stroke();

  // Garis rata-rata putus-putus.
  const avgY = yOf(stats.avg);
  ctx.strokeStyle = COLORS.avgLine;
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 5]);
  ctx.beginPath();
  ctx.moveTo(MARGIN.left, avgY);
  ctx.lineTo(WIDTH - MARGIN.right, avgY);
  ctx.stroke();
  ctx.setLineDash([]);

  // Penanda puncak. Label digeser ke kiri kalau puncaknya dekat tepi kanan.
  const px = xOf(stats.peakAtSec);
  const py = yOf(stats.peak);
  ctx.fillStyle = COLORS.barRecord;
  ctx.beginPath();
  ctx.arc(px, py, 6, 0, Math.PI * 2);
  ctx.fill();
  ctx.font = `bold 13px ${FONT_BOLD}, sans-serif`;
  ctx.textAlign = px > WIDTH - 170 ? "right" : "left";
  ctx.fillText(`puncak ${formatViewCount(stats.peak)}`, px + (ctx.textAlign === "right" ? -10 : 10), Math.max(py - 10, MARGIN.top - 4));

  return canvas.toBuffer("image/png");
}

// Rata-rata puncak penonton sesi-sesi LAIN member itu (dari arsip rekap), buat
// ngasih konteks "ini ramai atau biasa aja buat dia". null kalau datanya kurang.
function typicalPeakFor(username, excludeStartedAtUnix) {
  const peaks = getCompletedSessionsSince(SESSION_RETENTION_DAYS)
    .filter((s) => s.username === username && s.startedAtUnix !== excludeStartedAtUnix && typeof s.peakViewCount === "number")
    .map((s) => s.peakViewCount);
  if (peaks.length < 2) return null;
  return peaks.reduce((a, b) => a + b, 0) / peaks.length;
}

function describePeakVsTypical(peak, typical) {
  if (!typical) return "";
  const diff = Math.round(((peak - typical) / typical) * 100);
  if (Math.abs(diff) < 5) return ` Itu sekitar biasanya dia (rata-rata puncak ${formatViewCount(Math.round(typical))}).`;
  return diff > 0
    ? ` Itu ${diff}% LEBIH ramai dari rata-rata puncaknya (${formatViewCount(Math.round(typical))}).`
    : ` Itu ${Math.abs(diff)}% lebih sepi dari rata-rata puncaknya (${formatViewCount(Math.round(typical))}).`;
}

async function replyViewerChart(fragment) {
  const shown = (fragment || "").trim();
  const resolved = resolveRecapMember(shown);
  if (resolved.status === "ambiguous") {
    return `Cok, ada beberapa member yang cocok sama "${shown}": ${resolved.names.join(", ")}. Ketik nama yang lebih lengkap ya.`;
  }
  if (resolved.status !== "ok") return await describeMissingMember(shown, "digrafikin");
  const { username, name: displayName } = resolved;

  // Lagi live? Pakai kurva yang lagi jalan. Kalau belum cukup titik, jujur bilang.
  const live = activeLives.get(username);
  let samples;
  let inProgress = false;
  let startedAtUnix = null;
  if (live) {
    samples = cleanSamples(live.viewSamples);
    inProgress = true;
    startedAtUnix = live.liveAt ? Math.floor(new Date(live.liveAt).getTime() / 1000) : null;
    if (samples.length < 3) {
      return `Cok, **${displayName}** baru mulai live - kurva penontonnya belum cukup titik (tiap ~20 detik dicatat satu). Coba lagi beberapa menit lagi.`;
    }
  } else {
    const last = getViewerTimelines(username).at(-1);
    if (!last) {
      return `Cok, belum ada kurva penonton buat **${displayName}**. Kurva baru dicatat buat live yang mulai SETELAH fitur ini aktif - tunggu sampai dia selesai live berikutnya.`;
    }
    samples = last.samples;
    startedAtUnix = last.startedAtUnix;
  }

  const stats = computeViewerStats(samples);
  if (!stats) return `Cok, data kurva penonton **${displayName}** rusak/kurang. Coba lagi setelah live berikutnya.`;

  const peakClock = formatClockWIB(new Date(stats.peakAtSec * 1000));
  const header = inProgress
    ? `📈 Kurva penonton **${displayName}** (lagi live, sampai sekarang).`
    : `📈 Kurva penonton **${displayName}** (sesi terakhir yang udah selesai).`;
  const content =
    `${header} Puncak **${formatViewCount(stats.peak)}** di menit ke-${Math.round(stats.peakOffsetSec / 60)} (${peakClock}), rata-rata ~${formatViewCount(Math.round(stats.avg))}.` +
    describePeakVsTypical(stats.peak, typicalPeakFor(username, startedAtUnix));

  return {
    content,
    files: [new AttachmentBuilder(drawViewerChart(displayName, samples, { inProgress }), { name: `penonton-${username}.png` })],
    components: [buildChartCloseRow()],
  };
}

module.exports = { replyViewerChart, drawViewerChart, niceCeil, describePeakVsTypical };
