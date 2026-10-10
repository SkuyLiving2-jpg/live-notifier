// Langganan notif live per member ("cok ingetin ...").

const { addSubscription, removeSubscription, KEYWORD_MAX_LENGTH } = require("../../storage/subscriptions");
const { stripTrailingLiveWord } = require("../../utils");

const { isKnownMemberFragment } = require("./memberLookup");

// Beda dari priority list (khusus owner), subscribe ini SIAPA AJA boleh -
// personal reminder buat di-tag pas member manapun mulai live.
// BUG: "ingetin nala dan lily" dulu didaftarin sebagai SATU keyword "nala dan
// lily" (gak pernah cocok sama siapapun) sambil dibales "Sip, kamu bakal
// di-tag tiap kali "nala dan lily" mulai live!" - langganan diam-diam gak
// berguna, dan nongol di "reminder aku". Sekarang dipecah per nama (pemisah
// "dan"/"&"/koma, maksimal MAX_SUBSCRIBE_NAMES sekaligus). Satu nama = pesan
// lama persis, jadi perilaku biasa gak berubah.
const MAX_SUBSCRIBE_NAMES = 5;

function splitSubscribeNames(rawName) {
  return stripTrailingLiveWord(rawName)
    .split(/\s*(?:,|&|\bdan\b)\s*/i)
    .map((n) => n.trim())
    .filter(Boolean);
}

function handleSubscribe(rawName, authorId) {
  const names = splitSubscribeNames(rawName);
  if (names.length > MAX_SUBSCRIBE_NAMES) return `Cok, maksimal ${MAX_SUBSCRIBE_NAMES} member sekaligus ya (kamu ngasih ${names.length}).`;
  if (names.length <= 1) {
    const name = names[0] || stripTrailingLiveWord(rawName);
    const result = addSubscription(name, authorId);
    if (!result.ok && result.reason === "too_short") return "Nama membernya kependekan, minimal 3 huruf ya.";
    if (!result.ok && result.reason === "too_long") return `Nama membernya kepanjangan, maksimal ${KEYWORD_MAX_LENGTH} huruf ya.`;
    if (!result.ok && result.reason === "invalid") return "Nama itu gak bisa dipakai buat subscribe. Coba nama member yang lain ya.";
    if (!result.ok && result.reason === "already") return `Kamu udah subscribe notif buat "${name}" kok.`;
    if (!result.ok) return "Gagal subscribe, coba lagi.";
    return `🔔 Sip, kamu bakal di-tag tiap kali "${name}" mulai live!${unknownNameWarning([name])}`;
  }

  const added = [];
  const already = [];
  const tooShort = [];
  const rejected = [];
  for (const name of names) {
    const result = addSubscription(name, authorId);
    if (result.ok) added.push(name);
    else if (result.reason === "already") already.push(name);
    else if (result.reason === "too_long" || result.reason === "invalid") rejected.push(name.length > 20 ? `${name.slice(0, 20)}…` : name);
    else tooShort.push(name);
  }
  const quote = (list) => list.map((n) => `"${n}"`).join(", ");
  const lines = [];
  if (added.length > 0) lines.push(`🔔 Sip, kamu bakal di-tag tiap kali ${quote(added)} mulai live!${unknownNameWarning(added)}`);
  if (already.length > 0) lines.push(`Udah subscribe dari tadi: ${quote(already)}.`);
  if (tooShort.length > 0) lines.push(`Kependekan (minimal 3 huruf): ${quote(tooShort)}.`);
  if (rejected.length > 0) lines.push(`Gak valid (kepanjangan, maks ${KEYWORD_MAX_LENGTH} huruf): ${quote(rejected)}.`);
  return lines.join("\n");
}

// Nama yang gak dikenal bot (belum pernah live/gak ada di data) TETEP didaftarin -
// bisa aja member yang emang belum pernah live semenjak bot mantau - tapi user
// dikasih tau, biar salah ketik ("nlaa") gak diem-diem jadi langganan mati.
function unknownNameWarning(names) {
  const unknown = names.filter((n) => !isKnownMemberFragment(n));
  if (unknown.length === 0) return "";
  const quoted = unknown.map((n) => `"${n}"`).join(", ");
  return `\n⚠️ Bot belum pernah liat member ${quoted} live. Kalau salah ketik, ketik "berhenti ingetin ${unknown[0]}" lalu daftar ulang.`;
}

function handleUnsubscribe(rawName, authorId) {
  const names = splitSubscribeNames(rawName);
  if (names.length <= 1) {
    const name = names[0] || stripTrailingLiveWord(rawName);
    const result = removeSubscription(name, authorId);
    if (!result.ok) return `Kamu belum subscribe "${name}".`;
    return `🔕 Oke, notif buat "${name}" dimatiin.`;
  }

  const removed = [];
  const notFound = [];
  for (const name of names.slice(0, MAX_SUBSCRIBE_NAMES)) {
    (removeSubscription(name, authorId).ok ? removed : notFound).push(name);
  }
  const quote = (list) => list.map((n) => `"${n}"`).join(", ");
  const lines = [];
  if (removed.length > 0) lines.push(`🔕 Oke, notif buat ${quote(removed)} dimatiin.`);
  if (notFound.length > 0) lines.push(`Kamu belum subscribe ${quote(notFound)}.`);
  return lines.join("\n");
}

module.exports = {
  handleSubscribe,
  handleUnsubscribe,
};
