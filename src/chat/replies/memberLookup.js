// Mencari & menjelaskan member dari potongan nama: normalisasi, cek dikenal, pesan "belum pernah live / tidak ada", resolusi ambigu.

const { activeLives, findMemberByNameFragment } = require("../../storage/activeLives");
const { findDurationHistoryByNameFragment } = require("../../storage/durationHistory");
const { loadLiveCount, findLiveCountByNameFragment, searchLiveCountByNameFragment } = require("../../storage/liveCount");
const { getAllPriorityMembers } = require("../../priority");
const { resolveAliasInFragment } = require("../../storage/aliases");
const { fetchPublicProfileByUsername, isJkt48Member } = require("../../idnApi");
const { matchesNameFragment, containsWholeWord } = require("../../utils");

function firstNameOf(name) {
  return (name || "").split(/[\s|]+/)[0].toLowerCase();
}

// Nyari member dari live-count.json (pernah SELESAI live semenjak bot jalan)
// DAN activeLives (lagi live sekarang - bisa aja live PERTAMA-nya, belum masuk
// live-count sampe selesai). Kalau ada beberapa yang cocok, nama yang PERSIS
// sama nama depan menang; kalau tetep >1, ambigu (user disuruh lebih spesifik
// - jangan asal pilih yang pertama). "none" -> pemanggil nanya ke IDN lewat
// describeMissingMember (belum pernah live vs gak ada sama sekali).
function resolveRecapMember(fragment) {
  // resolveAliasInFragment (§10's kelimapuluh item) DULUAN, baru
  // normalizeMemberFragment - searchLiveCountByNameFragment di bawah udah
  // otomatis alias-aware sendiri (resolusinya ada DI DALEM fungsi itu), tapi
  // loop activeLives manual tepat di bawahnya butuh needle yang UDAH
  // di-resolve secara eksplisit juga.
  const needle = resolveAliasInFragment(normalizeMemberFragment(fragment));
  if (!needle) return { status: "none" };

  const candidates = new Map();
  for (const m of searchLiveCountByNameFragment(needle)) candidates.set(m.username, { username: m.username, name: m.name });
  for (const [username, entry] of activeLives) {
    if (!candidates.has(username) && entry.name && matchesNameFragment(needle, firstNameOf(entry.name))) {
      candidates.set(username, { username, name: entry.name });
    }
  }

  const all = [...candidates.values()];
  if (all.length === 0) return { status: "none" };
  if (all.length === 1) return { status: "ok", ...all[0] };
  const exact = all.filter((c) => firstNameOf(c.name) === needle);
  if (exact.length === 1) return { status: "ok", ...exact[0] };
  return { status: "ambiguous", names: all.map((c) => c.name).sort() };
}

function memberDisplayName(username) {
  return loadLiveCount()[username]?.name || activeLives.get(username)?.name || username;
}

// Kunci buat ngebandingin dua ketikan nama tanpa peduli huruf besar/kecil,
// spasi ekstra, atau kata "JKT48" di belakangnya ("Nala" == " nala JKT48 ").
function normalizeMemberFragment(fragment) {
  return (fragment || "")
    .toLowerCase()
    .replace(/\bjkt48\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Gerbang "ini beneran nama member?" - dipindah ke sini (§10's kelimapuluh
// item) dari chat/router.js, yang tadinya nyimpen definisi ini sendiri.
// Dipindah biar bisa dipakai DUA tempat: router.js's bare-form compare gate
// ("<nama> dan <nama>" polos, lihat komennya di sana) DAN handleAddAlias di
// bawah (nolak alias yang kebetulan nabrak nama member yang UDAH dikenal -
// lihat komennya). router.js require dari sini (chat/replies/), bukan
// sebaliknya, jadi naronya di sini (bukan balik ke router.js) gak
// ngebalik arah dependency yang udah ada.
//
// Cek LiveCount/activeLives/durationHistory (lewat findLiveCountByNameFragment
// dkk) OTOMATIS ikut ngenalin alias (storage/aliases.js's resolveAliasInFragment
// dipanggil DI DALEM tiap fungsi itu) - cek prioritas di bawah ini yang perlu
// resolveAliasInFragment SECARA EKSPLISIT, soalnya containsWholeWord manggil
// `fragment` mentah, bukan lewat salah satu fungsi find*ByNameFragment itu.
function isKnownMemberFragment(fragment) {
  if (findLiveCountByNameFragment(fragment) || findMemberByNameFragment(fragment) || findDurationHistoryByNameFragment(fragment)) return true;
  const resolved = resolveAliasInFragment(fragment);
  return getAllPriorityMembers().some((p) => containsWholeWord(resolved, p.keyword));
}

// Nama yang gak ada di live-count.json (belum pernah ke-track live-nya) BUKAN
// berarti "member itu gak ada" - Kimmy misalnya beneran member JKT48 dengan
// akun IDN (jkt48_kimmy), cuma belum pernah live semenjak bot ini mulai
// mantau. Jadi sebelum bilang "gak ketemu", dicek langsung ke IDN (username
// member konsisten "jkt48_<nama depan>", lihat idnApi.js's isJkt48Member):
// - profil ada & akun JKT48 -> "belum pernah live" (jujur, sesuai datanya)
// - profil gak ada          -> beneran gak ketemu (typo/bukan member/belum
//                              punya akun IDN)
// - IDN gagal dihubungi     -> bilang gak bisa ngecek, BUKAN nebak salah satunya
async function describeMissingMember(fragment, purpose = "dibandingin") {
  const shown = (fragment || "").trim();
  // `shown` (bukan hasil alias) yang ditampilin di pesan di bawah - biar user
  // liat persis apa yang dia ketik. resolveAliasInFragment (§10's kelimapuluh
  // item) cuma dipakai buat NENTUIN username IDN yang bakal dicek (token) -
  // tanpa ini, alias yang UDAH kedaftar (mis. "kimkim" -> "kimmy") bakal salah
  // nyoba `jkt48_kimkim` (gak ada) alih-alih `jkt48_kimmy` yang beneran ada,
  // jadi ngasih tau "gak nemu" padahal membernya jelas ada di bawah alias itu.
  const token = normalizeMemberFragment(resolveAliasInFragment(shown)).split(" ")[0];
  if (!token || token.length < 2) return `Cok, ketik nama membernya yang jelas ya - "${shown}" terlalu pendek/gak valid.`;

  try {
    const profile = await fetchPublicProfileByUsername(`jkt48_${token}`);
    if (profile && isJkt48Member(profile)) {
      return `Cok, **${profile.name}** belum pernah live semenjak bot ini mulai mantau, jadi belum ada datanya buat ${purpose}.`;
    }
    return `Cok, gak nemu member JKT48 bernama "${shown}" di IDN - cek lagi ejaan namanya (atau mungkin dia belum punya akun IDN).`;
  } catch (error) {
    console.error(`Gagal ngecek member "${shown}" ke IDN:`, error.message);
    return `Cok, "${shown}" belum ada di catatan bot, dan bot lagi gak bisa ngecek ke IDN buat mastiin dia member atau bukan. Coba lagi bentar.`;
  }
}

module.exports = {
  resolveRecapMember,
  memberDisplayName,
  normalizeMemberFragment,
  isKnownMemberFragment,
  describeMissingMember,
};
