// "cok wrapped" (rangkuman 30 hari seluruh member) dan "cok wrapped <nama>" (satu
// member) - satu gambar kartu yang enak di-screenshot & dibagikan. Perhitungan di
// ../wrapped.js; di sini cuma menggambar & membalas. Gaya/font sama dengan grafik lain.
const { createCanvas } = require("@napi-rs/canvas");
const { AttachmentBuilder } = require("discord.js");
const { getCompletedSessionsSince, getStreakDatesForMember } = require("../storage/dailyLog");
const { computeCurrentStreak } = require("../streakMath");
const { computeServerWrapped, computeMemberWrapped } = require("../wrapped");
const { formatDuration, formatViewCount, getTodayWIB } = require("../utils");
const { describeMissingMember, resolveRecapMember } = require("./replies");
const { buildChartCloseRow, COLORS, FONT_REGULAR, FONT_BOLD } = require("./chartReply");

const WRAPPED_DAYS = 30;
const WIDTH = 900;
const HEIGHT = 620;
const PAD = 40;
const ACCENT = "#fee75c";

const pad2 = (n) => String(n).padStart(2, "0");
const hoursText = (ms) => `${Math.round((ms / 3_600_000) * 10) / 10} jam`.replace(".", ",");
const hourText = (h) => (h === null ? "-" : `${pad2(h)}.00 WIB`);

function fitText(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let cut = text;
  while (cut.length > 1 && ctx.measureText(`${cut}…`).width > maxWidth) cut = cut.slice(0, -1);
  return `${cut}…`;
}

// card = { title, subtitle, tiles: [{label, value}] (3), bars | hourCounts, barsTitle, footnotes: [string] }
function drawWrappedCard(card) {
  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = COLORS.background;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  // Pita aksen di kiri atas.
  ctx.fillStyle = COLORS.bar;
  ctx.fillRect(0, 0, WIDTH, 8);

  ctx.textAlign = "left";
  ctx.fillStyle = ACCENT;
  ctx.font = `bold 15px ${FONT_BOLD}, sans-serif`;
  ctx.fillText("JKT48 LIVE WRAPPED", PAD, 44);
  ctx.fillStyle = COLORS.text;
  ctx.font = `bold 34px ${FONT_BOLD}, sans-serif`;
  ctx.fillText(fitText(ctx, card.title, WIDTH - PAD * 2), PAD, 88);
  ctx.fillStyle = COLORS.subtext;
  ctx.font = `16px ${FONT_REGULAR}, sans-serif`;
  ctx.fillText(card.subtitle, PAD, 114);

  // Tiga angka besar.
  const tileGap = 16;
  const tileWidth = (WIDTH - PAD * 2 - tileGap * 2) / 3;
  card.tiles.forEach((tile, i) => {
    const x = PAD + i * (tileWidth + tileGap);
    ctx.fillStyle = "#2b2d31";
    ctx.fillRect(x, 140, tileWidth, 92);
    ctx.fillStyle = COLORS.subtext;
    ctx.font = `13px ${FONT_REGULAR}, sans-serif`;
    ctx.fillText(tile.label, x + 16, 166);
    ctx.fillStyle = COLORS.text;
    ctx.font = `bold 32px ${FONT_BOLD}, sans-serif`;
    ctx.fillText(fitText(ctx, tile.value, tileWidth - 32), x + 16, 212);
  });

  // Bagian tengah: batang horizontal (top member) ATAU histogram jam mulai live.
  const midTop = 262;
  ctx.fillStyle = COLORS.text;
  ctx.font = `bold 16px ${FONT_BOLD}, sans-serif`;
  ctx.fillText(card.barsTitle, PAD, midTop);

  if (card.bars) {
    const maxValue = Math.max(...card.bars.map((b) => b.value), 1);
    const labelWidth = 190;
    const barMax = WIDTH - PAD * 2 - labelWidth - 120;
    card.bars.forEach((bar, i) => {
      const y = midTop + 20 + i * 38;
      ctx.fillStyle = COLORS.text;
      ctx.font = `15px ${FONT_REGULAR}, sans-serif`;
      ctx.fillText(fitText(ctx, `${i + 1}. ${bar.label}`, labelWidth - 10), PAD, y + 20);
      ctx.fillStyle = i === 0 ? COLORS.barRecord : COLORS.bar;
      ctx.fillRect(PAD + labelWidth, y + 4, Math.max(4, (bar.value / maxValue) * barMax), 22);
      ctx.fillStyle = COLORS.subtext;
      ctx.font = `13px ${FONT_REGULAR}, sans-serif`;
      ctx.fillText(bar.text, PAD + labelWidth + Math.max(4, (bar.value / maxValue) * barMax) + 10, y + 21);
    });
  } else if (card.hourCounts) {
    const maxCount = Math.max(...card.hourCounts, 1);
    const chartTop = midTop + 18;
    const chartHeight = 150;
    const slot = (WIDTH - PAD * 2) / 24;
    card.hourCounts.forEach((count, h) => {
      const barHeight = (count / maxCount) * chartHeight;
      ctx.fillStyle = count === maxCount && count > 0 ? COLORS.barRecord : COLORS.bar;
      ctx.fillRect(PAD + h * slot + 3, chartTop + chartHeight - barHeight, slot - 6, Math.max(count > 0 ? 3 : 0, barHeight));
      if (h % 3 === 0) {
        ctx.fillStyle = COLORS.subtext;
        ctx.font = `12px ${FONT_REGULAR}, sans-serif`;
        ctx.textAlign = "left";
        ctx.fillText(pad2(h), PAD + h * slot + 2, chartTop + chartHeight + 18);
      }
    });
  }

  // Catatan kaki.
  ctx.font = `15px ${FONT_REGULAR}, sans-serif`;
  card.footnotes.forEach((line, i) => {
    ctx.fillStyle = i === 0 ? COLORS.text : COLORS.subtext;
    ctx.fillText(fitText(ctx, line, WIDTH - PAD * 2), PAD, 502 + i * 26);
  });

  return canvas.toBuffer("image/png");
}

function buildServerCard(wrapped) {
  const footnotes = [
    `Jam tersibuk: ${hourText(wrapped.busiestHour)}  -  Hari tersibuk: ${wrapped.topWeekday ?? "-"}`,
    wrapped.longest ? `Sesi terpanjang: ${wrapped.longest.name} - ${formatDuration(wrapped.longest.durationMs)}` : "",
    wrapped.peak ? `Penonton terbanyak: ${wrapped.peak.name} - ${formatViewCount(wrapped.peak.peakViewCount)}` : "",
    wrapped.topStreak ? `Streak terpanjang: ${wrapped.topStreak.name} - ${wrapped.topStreak.days} hari` : "",
  ].filter(Boolean);
  return {
    title: `${WRAPPED_DAYS} Hari Terakhir`,
    subtitle: "Rangkuman live semua member JKT48 yang dipantau bot ini",
    tiles: [
      { label: "TOTAL SESI LIVE", value: String(wrapped.sessionCount) },
      { label: "TOTAL WAKTU LIVE", value: hoursText(wrapped.totalDurationMs) },
      { label: "MEMBER YANG LIVE", value: String(wrapped.memberCount) },
    ],
    barsTitle: "Paling lama live",
    bars: wrapped.topMembers.map((m) => ({ label: m.name, value: m.durationMs, text: `${hoursText(m.durationMs)} - ${m.count}x` })),
    footnotes,
  };
}

function buildMemberCard(wrapped) {
  const footnotes = [
    `Peringkat #${wrapped.rank} dari ${wrapped.memberCount} member (berdasarkan total waktu live)`,
    `Jam favorit: ${hourText(wrapped.busiestHour)}  -  Hari favorit: ${wrapped.topWeekday ?? "-"}`,
    wrapped.longest ? `Sesi terpanjang: ${formatDuration(wrapped.longest.durationMs)}` : "",
    wrapped.peak ? `Penonton terbanyak: ${formatViewCount(wrapped.peak.peakViewCount)}` : "",
    wrapped.streak > 0 ? `Streak sekarang: ${wrapped.streak} hari` : "",
  ].filter(Boolean);
  return {
    title: wrapped.name,
    subtitle: `Rangkuman ${WRAPPED_DAYS} hari terakhir`,
    tiles: [
      { label: "SESI LIVE", value: String(wrapped.sessionCount) },
      { label: "TOTAL WAKTU LIVE", value: hoursText(wrapped.totalDurationMs) },
      { label: "RATA-RATA / SESI", value: formatDuration(wrapped.avgDurationMs) },
    ],
    barsTitle: "Biasanya mulai live jam berapa (WIB)",
    hourCounts: wrapped.hourCounts,
    footnotes,
  };
}

function loadSessions() {
  return getCompletedSessionsSince(WRAPPED_DAYS).filter((s) => s.endedAtUnix !== null && s.durationMs > 0);
}

function currentStreak(username) {
  return computeCurrentStreak(getStreakDatesForMember(username), getTodayWIB());
}

async function replyWrapped(fragment) {
  const shown = (fragment || "").trim();
  const sessions = loadSessions();

  if (!shown) {
    const streaks = {};
    for (const username of new Set(sessions.map((s) => s.username))) streaks[username] = currentStreak(username);
    const wrapped = computeServerWrapped(sessions, streaks);
    if (!wrapped) return `Cok, belum ada sesi live yang kecatet di ${WRAPPED_DAYS} hari terakhir, jadi belum ada yang bisa dirangkum.`;
    return {
      content: `🎁 **JKT48 Live Wrapped** - rangkuman ${WRAPPED_DAYS} hari terakhir. Mau versi satu member? Ketik "cok wrapped <nama>".`,
      files: [new AttachmentBuilder(drawWrappedCard(buildServerCard(wrapped)), { name: "wrapped-semua-member.png" })],
      components: [buildChartCloseRow()],
    };
  }

  const resolved = resolveRecapMember(shown);
  if (resolved.status === "ambiguous")
    return `Cok, ada beberapa member yang cocok sama "${shown}": ${resolved.names.join(", ")}. Ketik nama yang lebih lengkap ya.`;
  if (resolved.status !== "ok") return await describeMissingMember(shown, "dirangkum");

  const wrapped = computeMemberWrapped(sessions, resolved.username, currentStreak(resolved.username));
  if (!wrapped)
    return `Cok, **${resolved.name}** belum punya sesi live yang kecatet di ${WRAPPED_DAYS} hari terakhir, jadi belum ada yang bisa dirangkum.`;
  return {
    content: `🎁 **Wrapped ${wrapped.name}** - rangkuman ${WRAPPED_DAYS} hari terakhir.`,
    files: [new AttachmentBuilder(drawWrappedCard(buildMemberCard(wrapped)), { name: `wrapped-${resolved.username}.png` })],
    components: [buildChartCloseRow()],
  };
}

module.exports = { replyWrapped, drawWrappedCard, buildServerCard, buildMemberCard, hoursText };
