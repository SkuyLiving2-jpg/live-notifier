// Perintah pemilik: daftar prioritas dan alias nama member.

const { addCustomPriorityMember, removeCustomPriorityMember } = require("../../priority");
const { loadAliases, addAlias, removeAlias, validateAliasKey, ALIAS_MAX_LENGTH } = require("../../storage/aliases");
const { fetchPublicProfileByUsername, isJkt48Member } = require("../../idnApi");
const { PRIORITY_PING_USER_ID } = require("../../config");
const { stripTrailingLiveWord } = require("../../utils");

const { normalizeMemberFragment, isKnownMemberFragment } = require("./memberLookup");

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

// Saran fitur ke-5 (§10's kelimapuluh item): alias/panggilan buat pencarian
// nama member ("cok tambah alias <alias> = <nama asli>", "buat"/"untuk"
// juga diterima gantiin "="). Owner-gated (sama kayak prioritas, BUKAN
// terbuka kayak subscribe) - alias yang salah/nyasar bisa DIEM-DIEM ngerusak
// pencarian nama itu buat SEMUA ORANG (bukan cuma yang nambahin), jadi bukan
// resiko yang aman dibuka ke siapa aja.
function describeInvalidAlias(alias) {
  const reason = validateAliasKey(alias);
  if (reason === "too_short") return "Alias-nya kependekan, minimal 2 huruf ya.";
  if (reason === "too_long") return `Alias-nya kepanjangan, maksimal ${ALIAS_MAX_LENGTH} huruf ya.`;
  if (reason === "invalid_format")
    return `Alias cuma boleh SATU kata, huruf/angka doang (tanpa spasi/tanda baca) - "${alias}" gak bakal bisa kecocokan pas dicari.`;
  return null;
}

async function handleAddAlias(aliasFragment, targetFragment, authorId) {
  if (!isOwner(authorId)) return "Cok, cuma owner yang boleh ubah daftar alias.";

  const alias = (aliasFragment || "").trim();
  const target = (targetFragment || "").trim();
  if (!alias || !target) return 'Format-nya "cok tambah alias <alias> = <nama asli>" (atau "buat"/"untuk" gantiin "=").';

  const invalidAliasMessage = describeInvalidAlias(alias);
  if (invalidAliasMessage) return invalidAliasMessage;

  // Alias gak boleh nabrak nama yang UDAH dikenal (nama asli member manapun)
  // - kalau dibolehin, alias itu bakal DIEM-DIEM nge-shadow lookup buat nama
  // yang sebenernya udah kepake (mis. alias "nala" ke member lain bakal
  // bikin ketikan "nala" polos ke-alihin, bukan tetep nunjuk ke Nala asli).
  if (isKnownMemberFragment(alias)) {
    return `Cok, "${alias}" udah dikenal sebagai nama member sendiri - gak bisa dijadiin alias ke member lain.`;
  }

  // Target-nya divalidasi LANGSUNG ke IDN (bukan cuma isKnownMemberFragment,
  // yang butuh histori yang UDAH TERCATAT bot) - sama alasan describeMissingMember
  // di atas: member yang REAL tapi belum pernah live sekalipun (kayak Kimmy)
  // tetep harus bisa didaftarin alias-nya dari awal, gak perlu nunggu dia
  // live dulu baru bisa dikasih panggilan.
  const targetToken = normalizeMemberFragment(target).split(" ")[0];
  if (!targetToken || targetToken.length < 2) return `Cok, "${target}" bukan nama member yang valid.`;
  try {
    const profile = await fetchPublicProfileByUsername(`jkt48_${targetToken}`);
    if (!profile || !isJkt48Member(profile)) {
      return `Cok, "${target}" gak ketemu sebagai member JKT48 di IDN - cek lagi ejaannya.`;
    }
  } catch (error) {
    console.error(`Gagal ngecek target alias "${target}" ke IDN:`, error.message);
    return `Cok, bot lagi gak bisa ngecek ke IDN buat mastiin "${target}" member beneran atau bukan. Coba lagi bentar.`;
  }

  const result = addAlias(alias, targetToken);
  if (!result.ok) return describeInvalidAlias(alias) || "Gagal nambahin alias, coba lagi.";

  const replacedNote = result.previous ? ` (gantiin target lama "${result.previous}")` : "";
  return `✅ Alias "${alias}" -> "${targetToken}" ditambahin${replacedNote}. Sekarang ketik "${alias}" bakal ke-anggep sama kayak "${targetToken}".`;
}

function handleRemoveAlias(aliasFragment, authorId) {
  if (!isOwner(authorId)) return "Cok, cuma owner yang boleh ubah daftar alias.";
  const alias = (aliasFragment || "").trim();
  const result = removeAlias(alias);
  if (!result.ok) return `Alias "${alias}" gak ketemu.`;
  return `✅ Alias "${alias}" dihapus.`;
}

// Siapa aja boleh liat daftar alias yang ada (read-only, gak ada resiko) -
// sama pola aksesnya kayak replyPriorityList.
function replyAliasList() {
  const map = loadAliases();
  const entries = Object.entries(map).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return "Cok, belum ada alias yang kedaftar.";
  const lines = entries.map(([alias, target]) => `- "${alias}" -> "${target}"`);
  return `📛 Daftar alias:\n${lines.join("\n")}`;
}

module.exports = {
  isOwner,
  handleAddPriority,
  handleRemovePriority,
  handleAddAlias,
  handleRemoveAlias,
  replyAliasList,
};
