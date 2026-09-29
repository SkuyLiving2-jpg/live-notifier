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
const { AttachmentBuilder } = require("discord.js");
const { findDurationHistoryByNameFragment } = require("../storage/durationHistory");
const { formatDuration, formatShortDateWIB } = require("../utils");
const { describeMissingMember } = require("./replies");

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

// Titik masuk utama - dipanggil chat/router.js's "cok grafik <nama>" DAN
// chat/slashCommands.js's "/grafik". Async (sama pola-nya kayak
// replyCompareMembers dkk) soalnya describeMissingMember butuh network call
// ke IDN buat mbedain "member beneran tapi belum pernah live" vs "bukan
// member JKT48 sama sekali" kalau gak ketemu histori durasinya.
async function replyDurationChart(fragment) {
  const found = findDurationHistoryByNameFragment(fragment);
  if (!found) return describeMissingMember(fragment, "digrafikin");

  const buffer = drawDurationChart(found.displayName, found.entries);
  const fileName = `grafik-${found.username}.png`;
  return {
    content: `📊 Grafik durasi live **${found.displayName}** (${found.entries.length} sesi terakhir).`,
    files: [new AttachmentBuilder(buffer, { name: fileName })],
  };
}

module.exports = { replyDurationChart, computeDurationChartMetrics, drawDurationChart };
