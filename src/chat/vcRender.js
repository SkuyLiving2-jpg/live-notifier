// Merender rangkuman VC (storage/vcSchedule.js) jadi teks pesan Discord. Murni - tidak menyentuh Discord/disk.
//
// Hasilnya `content` biasa dengan markdown (bukan embed) SENGAJA: owner menyalin rangkuman ini ke tempat lain, dan
// "Copy Text" di Discord hanya membawa isi `content` (embed tidak ikut). Link dibungkus <...> supaya Discord tidak
// memunculkan kartu pratinjau Zoom yang memenuhi layar.
//
// Urutan: member PRIORITAS (Nala/Levi/Lily/custom) selalu di atas dan dapat format spesial (judul besar + sirens +
// blok kutipan + catatan absurd); member lain format polos. Di dalam masing-masing kelompok diurutkan tanggal lalu
// jam mulai terawal. Satu member dengan beberapa sesi digabung di bawah SATU judul (sesinya diurutkan tanggal+jam).

const { getPriorityConfig } = require("../priority");
const { formatTime, formatOpenWindow, formatDateDisplay, extractZoomId, formatZoomId } = require("./vcInput");

const SEPARATOR = "━━━━━━━━━━━━━━━━━━━━";
// Batas Discord 2000 karakter per pesan; disisakan selisih biar aman terhadap karakter multi-unit (emoji).
const MESSAGE_LIMIT = 1900;

// Karakter yang dibaca Discord sebagai markdown / mention dinetralkan, karena nama (dari IDN), julukan dan judul
// diketik bebas dan dipakai di dalam teks tebal/miring.
function escapeMd(text) {
  return String(text ?? "").replace(/([\\*_~`|>#@])/g, "\\$1");
}

// "Nala JKT48" -> "Nala", "Piya | Grup" -> "Piya". Nama yang diketik manual dibiarkan.
function cleanName(name) {
  const base = String(name ?? "")
    .split("|")[0]
    .trim();
  return base.replace(/\s+JKT48$/i, "").trim() || String(name ?? "").trim();
}

// Kunci member untuk julukan: username IDN, atau "name:<nama>" untuk member yang diketik manual.
function memberKey(session) {
  return session.username || `name:${cleanName(session.name).toLowerCase()}`;
}

function compareSessions(a, b) {
  return a.date.localeCompare(b.date) || a.start.localeCompare(b.start) || a.session - b.session || a.id - b.id;
}

// Kelompok per member, sudah urut: prioritas dulu (tanggal, jam, lalu peringkat prioritas), lalu sisanya.
function buildGroups(sessions) {
  const byMember = new Map();
  for (const s of sessions) {
    const key = memberKey(s);
    if (!byMember.has(key)) byMember.set(key, { key, name: s.name, username: s.username || null, sessions: [] });
    byMember.get(key).sessions.push(s);
  }
  const groups = [...byMember.values()].map((g) => {
    g.sessions.sort(compareSessions);
    g.priority = getPriorityConfig(g.name, g.username) || null;
    g.first = g.sessions[0];
    return g;
  });
  // Antar KELOMPOK hanya tanggal+jam mulai terawal yang dibandingkan; seri dipecah peringkat prioritas (Nala #1 sebelum
  // Levi #2) lalu nama - BUKAN urutan input (id sesi), supaya hasilnya tidak bergantung siapa yang diketik duluan.
  const byStart = (a, b) => a.first.date.localeCompare(b.first.date) || a.first.start.localeCompare(b.first.start);
  const byName = (a, b) => cleanName(a.name).localeCompare(cleanName(b.name));
  const priority = groups.filter((g) => g.priority).sort((a, b) => byStart(a, b) || a.priority.rank - b.priority.rank || byName(a, b));
  const others = groups.filter((g) => !g.priority).sort((a, b) => byStart(a, b) || byName(a, b));
  return [...priority, ...others];
}

function idLine(s) {
  const zoomId = extractZoomId(s.link);
  const parts = [];
  if (zoomId) parts.push(`🆔 ${formatZoomId(zoomId)}`);
  if (s.passcode) parts.push(`🔑 ${escapeMd(s.passcode)}`);
  return parts.join(" · ");
}

function ticketsText(s) {
  return s.tickets ? `${s.tickets} tiket` : "";
}

// Sesi satu member, dikelompokkan per tanggal. `fancy` = format prioritas.
function renderSessionLines(sessions, fancy) {
  const lines = [];
  let currentDate = null;
  for (const s of sessions) {
    if (s.date !== currentDate) {
      currentDate = s.date;
      lines.push(fancy ? `**📅 ${formatDateDisplay(s.date)}**` : `📅 ${formatDateDisplay(s.date)}`);
    }
    const note = s.note ? escapeMd(s.note) : "";
    if (fancy) {
      // Garis kutipan kosong memisahkan sesi-sesi yang berurutan di tanggal yang sama (tanpa ini menyatu jadi satu blok).
      if (lines[lines.length - 1]?.startsWith(">")) lines.push(">");
      const tickets = ticketsText(s);
      lines.push(
        `> 🎬 **Sesi ${s.session}** · 🕐 Buka **${formatOpenWindow(s.open, s.openEnd)}** · ▶️ Mulai **${formatTime(s.start)}**${tickets ? ` · 🎟️ **${tickets}**` : ""}`,
      );
      lines.push(`> 🔗 <${s.link}>`);
      const ids = idLine(s);
      if (ids) lines.push(`> ${ids}`);
      if (note) lines.push(`> 💬 _${note}_`);
    } else {
      const tickets = ticketsText(s);
      lines.push(`• Sesi ${s.session} · Buka ${formatOpenWindow(s.open, s.openEnd)} · Mulai ${formatTime(s.start)}${tickets ? ` · ${tickets}` : ""}`);
      const ids = idLine(s);
      lines.push(`  <${s.link}>${ids ? ` (${ids})` : ""}`);
      if (note) lines.push(`  ↳ _${note}_`);
    }
  }
  return lines;
}

function renderGroup(group, number, nickname) {
  const name = escapeMd(cleanName(group.name));
  const nick = nickname ? escapeMd(nickname) : "";
  if (group.priority) {
    const { sirens } = group.priority;
    const title = nick ? `${nick.toUpperCase()} (${name.toUpperCase()})` : name.toUpperCase();
    return [`## ${number}. ${sirens} ${title} ${sirens}`, ...renderSessionLines(group.sessions, true)].join("\n");
  }
  const title = nick ? `**${number}. ${nick}** (${name})` : `**${number}. ${name}**`;
  return [title, ...renderSessionLines(group.sessions, false)].join("\n");
}

// Gabungkan blok jadi pesan-pesan <= limit. Blok yang sendirian melebihi limit dipecah per baris.
function packBlocks(blocks, limit = MESSAGE_LIMIT) {
  const messages = [];
  let current = "";
  const push = () => {
    if (current) messages.push(current);
    current = "";
  };
  for (const block of blocks) {
    if (block.length > limit) {
      push();
      for (const line of block.split("\n")) {
        if (current && current.length + line.length + 1 > limit) push();
        current += (current ? "\n" : "") + (line.length > limit ? line.slice(0, limit - 1) + "…" : line);
      }
      continue;
    }
    if (current && current.length + block.length + 2 > limit) push();
    current += (current ? "\n\n" : "") + block;
  }
  push();
  return messages;
}

// Daftar teks pesan (biasanya 1; lebih kalau rangkumannya panjang). Pesan pertama berisi judul + pembuka.
function renderVcMessages(data) {
  const header = [`# 🎬 ${escapeMd(data.title || "VC")}`];
  if (data.opener) header.push(`_${escapeMd(data.opener)}_`);

  const groups = buildGroups(data.sessions);
  if (groups.length === 0) {
    return packBlocks([header.join("\n"), '_Belum ada sesi. Ketik "input vc" buat nambah._']);
  }
  const blocks = [`${header.join("\n")}\n${SEPARATOR}`];
  groups.forEach((group, i) => {
    // Pemisah menempel di AKHIR blok (bukan blok sendiri) supaya tidak pernah jadi baris pertama pesan lanjutan.
    const separator = i < groups.length - 1 ? `\n${SEPARATOR}` : "";
    blocks.push(`${renderGroup(group, i + 1, data.nicknames?.[group.key])}${separator}`);
  });
  return packBlocks(blocks);
}

module.exports = { renderVcMessages, buildGroups, memberKey, cleanName, escapeMd, packBlocks, compareSessions, MESSAGE_LIMIT, SEPARATOR };
