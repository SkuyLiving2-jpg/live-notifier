const { activeLives } = require("../storage/activeLives");
const { SESSION_RETENTION_DAYS, getCompletedSessionsSince } = require("../storage/dailyLog");
const { addSubscription, removeSubscription } = require("../storage/subscriptions");
const { MAX_OSHIS, getUserPrefs, updateUserPrefs } = require("../storage/userPrefs");
const { summarizeMember, formatMemberBlock } = require("../oshiSummary");
const { describeElapsed, formatDuration, formatShortDateWIB, formatViewCount } = require("../utils");
const { resolveRecapMember, describeMissingMember } = require("./replies");

// Perintah PERSONAL (butuh tau siapa yang ngetik): profil oshi, pengaturan notif
// (DM/tag, jam tenang), ringkasan mingguan, dan "cok kelewat". Dipanggil
// router.js lewat tryHandlePersonalCommand - null kalau pesannya bukan salah satunya.

const NEED_USER = "Cok, perintah ini cuma bisa dipakai lewat chat biasa (bot perlu tau kamu siapa).";
const MIN_CATCHUP_WINDOW_MS = 2 * 60 * 60 * 1000;
const MAX_CATCHUP_WINDOW_MS = 48 * 60 * 60 * 1000;
const DEFAULT_CATCHUP_WINDOW_MS = 12 * 60 * 60 * 1000;
const MAX_CATCHUP_LINES = 15;

const pad2 = (n) => String(n).padStart(2, "0");
const firstNameKeyword = (name) =>
  String(name || "")
    .split(/[\s|]+/)[0]
    .toLowerCase();

// ---------- oshi ----------

async function resolveMember(fragment, purpose) {
  const shown = (fragment || "").trim();
  if (!shown) return { error: "Cok, sebut nama membernya juga ya." };
  const resolved = resolveRecapMember(shown);
  if (resolved.status === "ambiguous")
    return { error: `Cok, ada beberapa member yang cocok sama "${shown}": ${resolved.names.join(", ")}. Ketik nama yang lebih lengkap ya.` };
  if (resolved.status !== "ok") return { error: await describeMissingMember(shown, purpose) };
  return { username: resolved.username, name: resolved.name };
}

async function handleAddOshi(fragment, authorId) {
  if (!authorId) return NEED_USER;
  const member = await resolveMember(fragment, "dijadiin oshi");
  if (member.error) return member.error;

  const prefs = getUserPrefs(authorId);
  if (prefs.oshis.includes(member.username)) return `**${member.name}** udah jadi oshi kamu kok. Ketik "cok oshi saya" buat liat profilnya.`;
  if (prefs.oshis.length >= MAX_OSHIS) return `Cok, oshi maksimal ${MAX_OSHIS} orang ya. Hapus salah satu dulu: "cok hapus oshi <nama>".`;

  updateUserPrefs(authorId, (p) => p.oshis.push(member.username));
  // Oshi otomatis di-subscribe (di-tag pas live), biar gak perlu "cok ingetin" lagi.
  const keyword = firstNameKeyword(member.name);
  const subscribed = keyword.length >= 3 && addSubscription(keyword, authorId).ok;
  const tagNote = subscribed ? "Kamu juga bakal di-tag pas dia mulai live" : "Kamu bakal dikabari pas dia mulai live (kalau udah subscribe)";
  return `⭐ **${member.name}** sekarang oshi kamu! ${tagNote}, plus dapet ringkasan mingguan lewat DM tiap Minggu malam (matiin: "cok ringkasan mati"). Ketik "cok oshi saya" buat liat profilnya.`;
}

async function handleRemoveOshi(fragment, authorId) {
  if (!authorId) return NEED_USER;
  const member = await resolveMember(fragment, "dihapus dari oshi");
  if (member.error) return member.error;

  const prefs = getUserPrefs(authorId);
  if (!prefs.oshis.includes(member.username)) return `**${member.name}** bukan oshi kamu.`;
  updateUserPrefs(authorId, (p) => {
    p.oshis = p.oshis.filter((u) => u !== member.username);
  });
  removeSubscription(firstNameKeyword(member.name), authorId);
  return `Oke, **${member.name}** dihapus dari oshi kamu (reminder-nya juga dimatiin).`;
}

function replyOshiProfile(authorId, nowMs = Date.now()) {
  if (!authorId) return NEED_USER;
  const { oshis } = getUserPrefs(authorId);
  if (oshis.length === 0) {
    return 'Kamu belum punya oshi. Ketik "cok oshi <nama member>" (maks 5) - nanti ada profil singkat, tag pas dia live, dan ringkasan mingguan lewat DM. Contoh: "cok oshi nala".';
  }
  const blocks = oshis.map((username) => formatMemberBlock(summarizeMember(username, nowMs), nowMs));
  return [`**Oshi kamu** (${oshis.length}/${MAX_OSHIS})`, ...blocks, '_Tambah: "cok oshi <nama>" - Hapus: "cok hapus oshi <nama>"_'].join("\n\n");
}

// ---------- pengaturan notif ----------

function describeQuiet(prefs) {
  return prefs.quietStart === null ? "mati" : `${pad2(prefs.quietStart)}.00-${pad2(prefs.quietEnd)}.00 WIB`;
}

function replySettings(authorId) {
  if (!authorId) return NEED_USER;
  const prefs = getUserPrefs(authorId);
  return [
    "⚙️ **Pengaturan notif kamu**",
    `- Cara dikabari (member yang kamu "ingetin"): **${prefs.delivery === "dm" ? "lewat DM" : "di-tag di channel"}**`,
    `- Jam tenang: **${describeQuiet(prefs)}**`,
    `- Ringkasan mingguan oshi (DM): **${prefs.digestOff ? "mati" : prefs.oshis.length > 0 ? "hidup" : "hidup (belum ada oshi)"}**`,
    "",
    'Ubah: "cok notif dm" / "cok notif tag", "cok jam tenang 23-6" / "cok jam tenang mati", "cok ringkasan mati" / "cok ringkasan hidup".',
    '_Jam tenang: kamu gak di-tag dan gak di-DM di jam itu - cek yang kelewat pakai "cok kelewat"._',
  ].join("\n");
}

function handleSetDelivery(mode, authorId) {
  if (!authorId) return NEED_USER;
  updateUserPrefs(authorId, (p) => {
    p.delivery = mode;
  });
  return mode === "dm"
    ? "📬 Oke, notif member yang kamu ingetin sekarang dikirim lewat **DM** (bukan di-tag di channel). Pastiin DM dari anggota server kebuka - kalau DM gagal, bot tetap nge-tag kamu di channel."
    : "🏷️ Oke, notif member yang kamu ingetin sekarang **di-tag di channel** lagi.";
}

function handleSetQuietHours(startRaw, endRaw, authorId) {
  if (!authorId) return NEED_USER;
  const start = Number(startRaw);
  const end = Number(endRaw);
  const valid = (n) => Number.isInteger(n) && n >= 0 && n <= 23;
  if (!valid(start) || !valid(end)) return 'Jamnya harus angka 0-23 (WIB), contoh: "cok jam tenang 23-6".';
  if (start === end) return 'Jam mulai dan selesainya jangan sama ya. Contoh: "cok jam tenang 23-6".';
  updateUserPrefs(authorId, (p) => {
    p.quietStart = start;
    p.quietEnd = end;
  });
  return `🌙 Jam tenang diset **${pad2(start)}.00-${pad2(end)}.00 WIB**: di jam itu kamu gak di-tag dan gak di-DM. Yang kelewat bisa dicek lewat "cok kelewat".`;
}

function handleClearQuietHours(authorId) {
  if (!authorId) return NEED_USER;
  updateUserPrefs(authorId, (p) => {
    p.quietStart = null;
    p.quietEnd = null;
  });
  return "🔔 Jam tenang dimatiin. Notif jalan normal 24 jam.";
}

function handleSetDigest(on, authorId) {
  if (!authorId) return NEED_USER;
  updateUserPrefs(authorId, (p) => {
    p.digestOff = !on;
  });
  return on ? "📰 Ringkasan mingguan oshi dihidupin (dikirim lewat DM tiap Minggu malam)." : "📰 Ringkasan mingguan oshi dimatiin.";
}

// ---------- cok kelewat ----------

// "6 jam", "90 menit", "2 hari" -> ms (atau null kalau gak ada).
function parseCatchupWindow(text) {
  const match = text.match(/(\d{1,3})\s*(jam|menit|hari)\b/);
  if (!match) return null;
  const amount = Number(match[1]);
  const unitMs = { menit: 60 * 1000, jam: 60 * 60 * 1000, hari: 24 * 60 * 60 * 1000 }[match[2]];
  const maxMs = SESSION_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  return Math.min(Math.max(amount * unitMs, 10 * 60 * 1000), maxMs);
}

function clockWIB(unixSec) {
  return new Intl.DateTimeFormat("id-ID", { timeZone: "Asia/Jakarta", hour: "2-digit", minute: "2-digit" }).format(new Date(unixSec * 1000));
}

function describeWindow(ms) {
  const hours = ms / (60 * 60 * 1000);
  if (hours < 1) return `${Math.round(ms / 60000)} menit`;
  if (hours < 48) return `${Math.round(hours * 10) / 10} jam`.replace(".0", "");
  return `${Math.round(hours / 24)} hari`;
}

// Yang live kelewat: sesi SELESAI dalam jendela waktu + yang lagi live sekarang.
function buildCatchup(authorId, text, nowMs = Date.now()) {
  const prefs = getUserPrefs(authorId);
  const explicit = parseCatchupWindow(text);
  let windowMs;
  let basis;
  if (explicit) {
    windowMs = explicit;
    basis = "";
  } else if (prefs.lastSeenAt) {
    windowMs = Math.min(Math.max(nowMs - prefs.lastSeenAt, MIN_CATCHUP_WINDOW_MS), MAX_CATCHUP_WINDOW_MS);
    basis = " (sejak terakhir kamu ngobrol sama bot)";
  } else {
    windowMs = DEFAULT_CATCHUP_WINDOW_MS;
    basis = " (bot belum tau kapan terakhir kamu aktif, jadi pakai 12 jam)";
  }

  const sinceSec = Math.floor((nowMs - windowMs) / 1000);
  const oshis = new Set(prefs.oshis);
  const daysBack = Math.ceil(windowMs / (24 * 60 * 60 * 1000)) + 1;
  const finished = getCompletedSessionsSince(daysBack)
    .filter((s) => s.endedAtUnix >= sinceSec)
    .sort((a, b) => b.endedAtUnix - a.endedAtUnix);
  const liveNow = [...activeLives.values()];

  const mark = (username) => (oshis.has(username) ? "⭐ " : "");
  const showDate = windowMs > 18 * 60 * 60 * 1000;
  const lines = finished.slice(0, MAX_CATCHUP_LINES).map((s) => {
    const day = showDate ? `${formatShortDateWIB(new Date(s.startedAtUnix * 1000))} ` : "";
    const peak = typeof s.peakViewCount === "number" ? ` - puncak 👁️ ${formatViewCount(s.peakViewCount)}` : "";
    return `${mark(s.username)}${day}${clockWIB(s.startedAtUnix)}-${clockWIB(s.endedAtUnix)} - **${s.name}** (${formatDuration(s.durationMs)}${peak})`;
  });
  const extra = finished.length - lines.length;

  const header = `📭 **Yang kelewat ${describeWindow(windowMs)} terakhir**${basis}`;
  if (finished.length === 0 && liveNow.length === 0) return `${header}\nGak ada yang live di rentang itu. Tenang, kamu gak ketinggalan apa-apa. 😌`;

  const parts = [header];
  if (liveNow.length > 0) {
    const nowLines = liveNow.map(
      (e) =>
        `${mark(e.username)}🔴 **${e.name}** - ${describeElapsed(nowMs - new Date(e.liveAt).getTime())}${e.viewCount != null ? `, 👁️ ${formatViewCount(e.viewCount)}` : ""}`,
    );
    parts.push(`**Lagi live sekarang:**\n${nowLines.join("\n")}`);
  }
  if (finished.length > 0) {
    parts.push(`**Udah selesai (${finished.length}):**\n${lines.join("\n")}${extra > 0 ? `\n_...dan ${extra} sesi lain_` : ""}`);
  }
  if (oshis.size > 0) parts.push("_⭐ = oshi kamu_");
  return parts.join("\n\n");
}

// ---------- router ----------

// text = pesan lowercase; commandText = tanpa "cok" di depan. Balikin string
// (jawaban) atau null kalau bukan perintah personal.
async function tryHandlePersonalCommand(text, commandText, authorId) {
  const t = commandText;

  const removeOshi = t.match(/^(?:(?:hapus|buang|batal(?:in)?)\s+oshi|oshi\s+(?:hapus|buang))\s+(.+)$/);
  if (removeOshi) return await handleRemoveOshi(removeOshi[1], authorId);

  if (/^oshi(?:\s+(?:saya|aku|ku|kamu))?[?!.\s]*$/.test(t) || /^(?:profil|profile)\s+(?:oshi|aku|saya)[?!.\s]*$/.test(t))
    return replyOshiProfile(authorId);

  const addOshi = t.match(/^(?:tambah(?:in|kan)?\s+)?oshi\s+(?:aku\s+|saya\s+|ku\s+)?(?:adalah\s+|itu\s+)?(.+)$/);
  if (addOshi) return await handleAddOshi(addOshi[1], authorId);

  if (/^(?:pengaturan|setelan|settings?)(?:\s+(?:aku|saya|ku|notif))?[?!.\s]*$/.test(t)) return replySettings(authorId);

  const delivery = t.match(/^(?:atur\s+)?notif(?:ikasi)?\s+(?:lewat\s+|via\s+|ke\s+)?(dm|tag)[?!.\s]*$/);
  if (delivery) return handleSetDelivery(delivery[1], authorId);

  const quiet = t.match(
    /^jam\s+tenang\s+(?:(\d{1,2})\s*(?:-|–|sampai|sd|s\/d|ke|hingga)\s*(\d{1,2})|(mati|off|matiin|hapus|batal|nonaktif))[?!.\s]*$/,
  );
  if (quiet) return quiet[3] ? handleClearQuietHours(authorId) : handleSetQuietHours(quiet[1], quiet[2], authorId);
  if (/^jam\s+tenang[?!.\s]*$/.test(t)) return replySettings(authorId);

  const digest = t.match(/^ringkasan(?:\s+mingguan)?(?:\s+oshi)?\s+(mati|off|matiin|nonaktif|hidup|on|nyala|aktif)[?!.\s]*$/);
  if (digest) return handleSetDigest(/^(hidup|on|nyala|aktif)$/.test(digest[1]), authorId);

  if (/\b(?:kelewat(?:an)?|ketinggalan)\b/.test(t)) {
    if (!authorId) return NEED_USER;
    return buildCatchup(authorId, t);
  }

  return null;
}

module.exports = {
  tryHandlePersonalCommand,
  handleAddOshi,
  handleRemoveOshi,
  replyOshiProfile,
  replySettings,
  handleSetDelivery,
  handleSetQuietHours,
  handleClearQuietHours,
  handleSetDigest,
  buildCatchup,
  parseCatchupWindow,
};
