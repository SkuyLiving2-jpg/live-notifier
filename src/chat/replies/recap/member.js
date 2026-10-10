// Rekap live SATU member: tabel semua sesi, per tanggal, dropdown tanggal, dan modal Rekap member.

const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");
const { SESSION_RETENTION_DAYS } = require("../../../storage/dailyLog");
const { loadLiveCount } = require("../../../storage/liveCount");
const { formatDuration, formatLongDateWIB, safeReplyOptions } = require("../../../utils");

const { resolveRecapMember, describeMissingMember, memberDisplayName } = require("../memberLookup");
const { buildCloseOnlyRow, isLiveCountOrigin, buildBackRow, buildRecapNavComponents, buildRecapPageBlock, liveCountOrigin } = require("./components");
const { withRecapMenu } = require("./screens");
const { pendingRecapPage, getSessionsForRange } = require("./sessions");
const { RECAP_TABLE_PAGE_SIZE, buildRecapTablePage } = require("./table");

// Tabel rekap live SATU member (semua sesi yang masih kesimpen di arsip) -
// tabel + tombol Maju/Mundur/Tutup/Lompat halaman SAMA persis kayak rekap
// lain (buildRecapPageBlock), cuma tanpa "🔍 Cari member" (lihat
// buildRecapNavComponents). Member harus BENERAN member JKT48 yang pernah live:
// nama yang gak dikenal bot dicek ke IDN (describeMissingMember) - jadi
// "belum pernah live" vs "gak ada member itu" dibedain, sama kayak
// "bandingin". Hasil gagal SELALU balik bawa menu rekap biar bisa coba lagi.
async function replyRecapMember(fragment, channelId, authorId, origin = "") {
  pendingRecapPage.delete(`${channelId}:${authorId}`);
  const shown = (fragment || "").trim();

  const resolved = resolveRecapMember(shown);
  if (resolved.status === "ambiguous") {
    return withRecapMenu(`Cok, ada beberapa member yang cocok sama "${shown}": ${resolved.names.join(", ")}. Ketik nama yang lebih lengkap ya.`);
  }
  if (resolved.status === "none") {
    return withRecapMenu(await describeMissingMember(shown, "direkap"));
  }

  return buildMemberRecapView({ username: resolved.username, name: resolved.name, channelId, authorId, origin });
}

// Tampilan rekap SATU member: semua sesi di arsip, atau satu tanggal kalau `date` diisi.
// Dipakai tiga jalur yang logikanya HARUS sama: ketik "cok rekap <nama>" (replyRecapMember),
// tombol "📋 Lihat rekap" di jawaban jumlah live, dan dropdown "📅 Cari tanggal".
function buildMemberRecapView({ username, name, date = null, channelId, authorId, origin = "" }) {
  const rangeDays = date ? `@${username}#${date}` : `@${username}`;
  const sessions = getSessionsForRange(rangeDays);
  const dateLabel = date ? formatLongDateWIB(new Date(`${date}T00:00:00+07:00`)) : null;

  if (sessions.length === 0) {
    if (date) {
      // Tanggal dipilih dari dropdown tapi datanya keburu berubah - tetap kasih dropdown/Tutup/Kembali.
      return {
        content: `Cok, **${name}** gak punya live yang kecatet tanggal ${dateLabel}.`,
        components: buildRecapNavComponents(0, 1, rangeDays, origin),
      };
    }
    const total = loadLiveCount()[username]?.count;
    const totalNote = total ? ` (total ${total}x live semenjak bot ini mulai mantau)` : "";
    const message = `Cok, **${name}** gak punya sesi live yang masih kesimpen di rekap${totalNote} - arsip sesi cuma nyimpen ${SESSION_RETENTION_DAYS} hari terakhir.`;
    // Dari jawaban jumlah live: jangan lempar ke menu rekap umum, cukup Tutup + Kembali.
    if (isLiveCountOrigin(origin)) return { content: message, components: [buildCloseOnlyRow(), buildBackRow(origin)] };
    return withRecapMenu(message);
  }

  const summaryLines = buildMemberSummaryLines(date ? `📋 **Rekap live ${name} - ${dateLabel}**` : `📋 **Rekap live ${name}**`, sessions);
  if (!date) summaryLines.push(`_(Rekap cuma nyimpen sesi ${SESSION_RETENTION_DAYS} hari terakhir.)_`);

  const block = buildRecapPageBlock(sessions, 0, channelId, authorId, rangeDays, origin);
  return { content: [summaryLines.join("\n"), block.content].join("\n"), components: block.components };
}

// Rekap member yang dibuka dari tombol di jawaban jumlah live (username sudah pasti, gak perlu resolusi nama).
function buildMemberRecapFromUsername(username, channelId, authorId) {
  pendingRecapPage.delete(`${channelId}:${authorId}`);
  return buildMemberRecapView({ username, name: memberDisplayName(username), channelId, authorId, origin: liveCountOrigin(username) });
}

// Dropdown "📅 Cari tanggal" di rekap member. customId: "recap_member_date:<username>[:<origin>]".
// Nilai "all" (atau apa pun yang bukan tanggal) = balik ke rekap semua sesi.
async function handleRecapMemberDateSelect(interaction) {
  const parts = interaction.customId.split(":");
  const username = parts[1];
  const origin = parts[2] || "";
  const value = interaction.values[0];
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
  pendingRecapPage.delete(`${interaction.channelId}:${interaction.user.id}`);
  const view = buildMemberRecapView({
    username,
    name: memberDisplayName(username),
    date,
    channelId: interaction.channelId,
    authorId: interaction.user.id,
    origin,
  });
  await interaction.update(safeReplyOptions(view));
}

function buildMemberSummaryLines(title, sessions) {
  const completed = sessions.filter((s) => s.endedAtUnix !== null);
  const ongoingCount = sessions.length - completed.length;
  const summaryLines = [title, `Total sesi: ${sessions.length}x (${completed.length} udah selesai, ${ongoingCount} masih live)`];
  if (completed.length > 0) {
    const totalDurationMs = completed.reduce((sum, s) => sum + s.durationMs, 0);
    const longest = completed.reduce((max, s) => (s.durationMs > max.durationMs ? s : max), completed[0]);
    summaryLines.push(
      `Total durasi: ${formatDuration(totalDurationMs)} | Rata-rata: ${formatDuration(totalDurationMs / completed.length)} | Paling lama: ${formatDuration(longest.durationMs)}`,
    );
  }
  return summaryLines;
}

// "rekap nala minggu ini"/"rekap nala 25 september"/"rekap nala kemarin" -
// BUG: dulu nama membernya diabaikan dan yang keluar rekap SEMUA member di
// rentang itu. Sekarang sesi rentang itu difilter ke satu member. Cuma halaman
// pertama (RECAP_TABLE_PAGE_SIZE baris) + tombol Tutup - rentang + member gak
// punya navigasi halaman sendiri; sisanya diarahin ke "rekap <nama>" (semua arsip
// dengan navigasi lengkap).
async function replyRecapMemberInRange(fragment, range) {
  const shown = (fragment || "").trim();
  const resolved = resolveRecapMember(shown);
  if (resolved.status === "ambiguous") {
    return withRecapMenu(`Cok, ada beberapa member yang cocok sama "${shown}": ${resolved.names.join(", ")}. Ketik nama yang lebih lengkap ya.`);
  }
  if (resolved.status === "none") {
    return withRecapMenu(await describeMissingMember(shown, "direkap"));
  }

  const sessions = getSessionsForRange(range.rangeDays).filter((s) => s.username === resolved.username);
  if (sessions.length === 0) {
    return `Cok, **${resolved.name}** gak punya sesi live di ${range.label} (arsip cuma nyimpen ${SESSION_RETENTION_DAYS} hari terakhir).`;
  }

  const summaryLines = buildMemberSummaryLines(`📋 **Rekap live ${resolved.name}** - ${range.label}`, sessions);
  const page = buildRecapTablePage(sessions, 0, true);
  if (page.hasMore) {
    summaryLines.push(
      `_(Nampilin ${RECAP_TABLE_PAGE_SIZE} sesi pertama dari ${sessions.length}. Ketik "rekap ${shown}" buat semua arsip dengan navigasi halaman.)_`,
    );
  }
  const closeRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("recap_nav:close").setLabel("Tutup rekap").setStyle(ButtonStyle.Danger),
  );
  return { content: [summaryLines.join("\n"), page.text].join("\n"), components: [closeRow] };
}

// Submit modal "Rekap member" (dibuka tombol menu "recap_menu:member") -
// NGE-EDIT pesan menu-nya jadi tabel rekap member (interaction.update, bukan
// pesan baru), atau jadi pesan gagal + menu lagi biar bisa coba nama lain.
async function handleRecapMemberModalSubmit(interaction) {
  const fragment = interaction.fields.getTextInputValue("member_name");
  // "recapmenu" di-hardcode (bukan dibaca dari customId modalnya) - modal ini
  // SATU-SATUNYA jalan buat munculin tabel rekap member (gak ada jalur
  // "ngetik langsung" yang lewat modal ini juga), jadi origin-nya selalu
  // sama, gak perlu ditempelin ke customId (lihat komen di buildBackRow's
  // withOrigin buat kenapa origin biasanya HARUS nempel di customId).
  const reply = await replyRecapMember(fragment, interaction.channelId, interaction.user.id, "recapmenu");
  await interaction.update(safeReplyOptions(reply));
}

module.exports = {
  replyRecapMember,
  buildMemberRecapFromUsername,
  handleRecapMemberDateSelect,
  replyRecapMemberInRange,
  handleRecapMemberModalSubmit,
};
