// Perbandingan dua sampai lima member (embed + tombol).

const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");
const { loadDurationHistory, getAverageDuration, getPreviousMaxDuration } = require("../../storage/durationHistory");
const { loadLiveCount, findLiveCountByNameFragment } = require("../../storage/liveCount");
const { fetchPublicProfileByUsername } = require("../../idnApi");
const { DAILY_RECAP_COLOR } = require("../../config");
const { formatDuration, formatRelativeTime } = require("../../utils");

const { normalizeMemberFragment, describeMissingMember } = require("./memberLookup");

// Fitur "Q2" ke-4, owner minta ("cok bandingin <A> vs <B>") - resolusi
// member LEWAT findLiveCountByNameFragment (bukan findMemberByNameFragment's
// activeLives, yang cuma kena buat yang LAGI live sekarang) soalnya
// live-count.json satu-satunya sumber yang selalu punya entry buat member
// manapun yang PERNAH ke-track live-nya, live atau enggak sekarang - dan
// itu juga sumber yang punya `count` (total live), yang jadi angka utama
// perbandingan ini.
async function fetchAvatarSafely(username) {
  try {
    const profile = await fetchPublicProfileByUsername(username);
    return profile?.avatar || null;
  } catch (error) {
    // Foto profil FITUR TAMBAHAN doang buat perbandingan ini (owner minta
    // "biar kelihatan lebih hidup"), bukan data inti - gagal ambil (network/
    // IDN API lagi bermasalah) TETEP ngasih hasil perbandingan teksnya,
    // cuma tanpa foto, sama filosofinya kayak replyTodayRecapSoFar's arsip
    // eksternal (fetchExternalTodayLiveHistory) yang juga "fitur tambahan,
    // gagal gak boleh bikin seluruh balesan gagal".
    console.error(`Gagal ambil foto profil ${username} (bukan fatal, perbandingan tetep jalan tanpa foto):`, error.message);
    return null;
  }
}

// Satu embed per member (bukan 1 embed gabungan) - Discord cuma ngasih SATU
// slot gambar (`thumbnail`/`image`) per embed, tapi SATU PESAN boleh bawa
// beberapa embed sekaligus (dirender numpuk ke bawah, bukan sebelahan, tapi
// tetep dua-duanya keliatan foto profilnya masing-masing di pesan yang
// sama) - itu cara paling simpel buat nunjukkin foto KEDUA member tanpa
// perlu compositing gambar manual.
function buildCompareMemberEmbed(entry, avatarUrl, avgDurationMs, maxDurationMs, isCountWinner) {
  return {
    title: isCountWinner ? `🏆 ${entry.name}` : entry.name,
    color: DAILY_RECAP_COLOR,
    thumbnail: avatarUrl ? { url: avatarUrl } : undefined,
    fields: [
      { name: "Total live", value: `${entry.count}x`, inline: true },
      { name: "Rata-rata durasi", value: avgDurationMs != null ? formatDuration(avgDurationMs) : "-", inline: true },
      { name: "Rekor terlama", value: maxDurationMs != null ? formatDuration(maxDurationMs) : "-", inline: true },
      { name: "Live pertama", value: formatRelativeTime(new Date(entry.firstLiveAt)), inline: true },
      { name: "Live terakhir", value: formatRelativeTime(new Date(entry.lastLiveAt)), inline: true },
    ],
  };
}

// Diekstrak dari replyCompareMembers (di bawah) biar bisa dipake bareng sama
// replyCompareMembersByUsername - dua-duanya ujung-ujungnya ngerakit embed
// yang SAMA persis, cuma beda cara nyari `a`/`b`-nya (fragment teks vs
// username yang udah pasti valid dari dropdown pencarian).
async function buildCompareReply(a, b) {
  const durationHistory = loadDurationHistory();
  const avgA = getAverageDuration(durationHistory, a.username);
  const avgB = getAverageDuration(durationHistory, b.username);
  const maxA = getPreviousMaxDuration(durationHistory, a.username);
  const maxB = getPreviousMaxDuration(durationHistory, b.username);

  const [avatarA, avatarB] = await Promise.all([fetchAvatarSafely(a.username), fetchAvatarSafely(b.username)]);

  const countWinnerIsA = a.count !== b.count && a.count > b.count;
  const countWinnerIsB = a.count !== b.count && b.count > a.count;

  // Tombol "Tutup" nempel di SEMUA jalur hasil perbandingan (ketikan langsung
  // "bandingin <A> dan <B>" MAUPUN lewat flow dropdown compareFlow.js) -
  // dulu cuma flow dropdown yang punya, jadi ketikan langsung ninggalin
  // kotak hasil yang gak bisa ditutup.
  return {
    content: `⚔️ **${a.name}** dan **${b.name}**`,
    embeds: [buildCompareMemberEmbed(a, avatarA, avgA, maxA, countWinnerIsA), buildCompareMemberEmbed(b, avatarB, avgB, maxB, countWinnerIsB)],
    components: [buildCompareCloseRow()],
  };
}

// customId "compare_pick:close" dibaca chat/compareFlow.js's
// handleComparePickButton (router.js dispatch by prefix "compare_pick:") -
// didefinisiin di SINI (bukan di compareFlow.js) soalnya compareFlow.js yang
// require chat/replies/, bukan sebaliknya (biar gak circular require).
const COMPARE_CLOSE_ID = "compare_pick:close";

function buildCompareCloseRow() {
  return new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(COMPARE_CLOSE_ID).setLabel("Tutup").setStyle(ButtonStyle.Danger));
}

function sameMemberMessage(fragmentA, fragmentB) {
  return `Cok, "${fragmentA.trim()}" sama "${fragmentB.trim()}" itu member yang sama, gak bisa dibandingin sama diri sendiri. Pilih dua member yang BEDA ya.`;
}

// "cok bandingin <A> dan <B>" (juga "bandingkan"/"banding", dan ketikan
// "<A> dan <B>" doang - lihat router.js). Urutan cek: nama yang SAMA
// dulu (sebelum nyentuh storage/network), baru resolusi kedua member, dan
// kalau ada yang gak ketemu, dua-duanya dijelasin sekaligus (bukan satu-satu
// tiap user coba ulang).
async function replyCompareMembers(fragmentA, fragmentB) {
  if (normalizeMemberFragment(fragmentA) === normalizeMemberFragment(fragmentB)) return sameMemberMessage(fragmentA, fragmentB);

  const a = findLiveCountByNameFragment(fragmentA);
  const b = findLiveCountByNameFragment(fragmentB);

  const missing = [];
  if (!a) missing.push(describeMissingMember(fragmentA));
  if (!b) missing.push(describeMissingMember(fragmentB));
  if (missing.length > 0) return (await Promise.all(missing)).join("\n");

  if (a.username === b.username) return sameMemberMessage(fragmentA, fragmentB);

  return buildCompareReply(a, b);
}

// Dipake chat/compareFlow.js (dropdown pencarian buat "cok bandingin" POLOS,
// tanpa nyebut "<A> dan <B>" sekaligus) - beda dari replyCompareMembers di
// atas, di sini `usernameA`/`usernameB` udah DIJAMIN ada di live-count.json
// (hasil pilihan dropdown/pencarian) dan compareFlow.js sendiri yang nolak
// pasangan member yang sama SEBELUM sampai sini, jadi gak perlu validasi
// "belum ada catatan"/"member yang sama" ulang kayak versi fragment.
async function replyCompareMembersByUsername(usernameA, usernameB) {
  const data = loadLiveCount();
  const a = { username: usernameA, ...data[usernameA] };
  const b = { username: usernameB, ...data[usernameB] };
  return buildCompareReply(a, b);
}

// Versi N-member dari replyCompareMembersByUsername - dipake compareFlow.js
// (dropdown "bandingin" polos: pilih jumlah 2-5, lalu cari satu-satu). Username
// udah DIJAMIN ada di live-count.json dan gak dobel (compareFlow.js yang jaga).
async function replyCompareMembersMultiByUsername(usernames) {
  const data = loadLiveCount();
  return buildCompareReplyMulti(usernames.map((username) => ({ username, ...data[username] })));
}

// Saran fitur ke-3, 3+ member sekaligus (§10's kelimapuluh+item). Discord
// ngizinin sampe 10 embed per pesan, tapi dibatesin lebih ketat di sini -
// bukan cuma soal limit teknis, embed numpuk ke BAWAH (bukan sebelahan,
// lihat komen buildCompareMemberEmbed) jadi kebanyakan tetep bikin hasilnya
// kepanjangan buat dibaca nyaman.
const MAX_COMPARE_MEMBERS = 5;

// Gabungan nama jadi kalimat Indonesia yang natural: 2 nama -> "A dan B", 3+
// -> "A, B, dan C" (koma di antara yang tengah, "dan" cuma sebelum yang
// terakhir) - dipake buat baris judul hasil perbandingan multi-member.
function joinNaturalList(items) {
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} dan ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, dan ${items[items.length - 1]}`;
}

// Versi N-member (>=2) dari buildCompareReply di atas - SENGAJA fungsi
// terpisah (bukan generalisasi buildCompareReply yang udah ada), biar jalur
// 2-member yang udah lama stabil + lengkap ke-tes itu SAMA SEKALI gak
// kesentuh/keresiko-in sama perubahan ini.
async function buildCompareReplyMulti(entries) {
  const durationHistory = loadDurationHistory();
  const avatars = await Promise.all(entries.map((entry) => fetchAvatarSafely(entry.username)));

  // Pemenang total-live (🏆) - aturannya SAMA kayak versi 2-member: cuma
  // ditandain kalau count TERTINGGI-nya gak seri (2+ member share count
  // tertinggi -> gak ada yang ditandain sama sekali, daripada nandain
  // beberapa 🏆 sekaligus yang malah bingungin).
  const maxCount = Math.max(...entries.map((e) => e.count));
  const winnerCountAtMax = entries.filter((e) => e.count === maxCount).length;

  const embeds = entries.map((entry, i) => {
    const avg = getAverageDuration(durationHistory, entry.username);
    const max = getPreviousMaxDuration(durationHistory, entry.username);
    const isWinner = winnerCountAtMax === 1 && entry.count === maxCount;
    return buildCompareMemberEmbed(entry, avatars[i], avg, max, isWinner);
  });

  return {
    content: `⚔️ ${joinNaturalList(entries.map((e) => `**${e.name}**`))}`,
    embeds,
    components: [buildCompareCloseRow()],
  };
}

// "cok bandingin A, B, dan C" (dan variasinya - lihat komen router.js's
// compareListFullMatch buat daftar bentuk yang diterima). Aturan-aturannya
// SAMA persis kayak replyCompareMembers (2-member), cuma digeneralisir ke N:
// nama yang sama-sama-persis ditolak, member yang gak ketemu dijelasin
// SEMUA sekaligus (bukan satu-satu tiap user coba ulang), dan dua ketikan
// BEDA yang kebetulan resolve ke username IDN yang SAMA juga ditolak.
async function replyCompareMembersMulti(fragments) {
  if (fragments.length > MAX_COMPARE_MEMBERS) {
    return `Cok, maksimal ${MAX_COMPARE_MEMBERS} member sekaligus ya buat dibandingin (kamu ngasih ${fragments.length}).`;
  }

  const normalized = fragments.map(normalizeMemberFragment);
  for (let i = 0; i < normalized.length; i++) {
    for (let j = i + 1; j < normalized.length; j++) {
      if (normalized[i] === normalized[j]) return sameMemberMessage(fragments[i], fragments[j]);
    }
  }

  const resolved = fragments.map(findLiveCountByNameFragment);
  const missingIndexes = resolved.map((r, i) => (r ? -1 : i)).filter((i) => i !== -1);
  if (missingIndexes.length > 0) {
    return (await Promise.all(missingIndexes.map((i) => describeMissingMember(fragments[i])))).join("\n");
  }

  for (let i = 0; i < resolved.length; i++) {
    for (let j = i + 1; j < resolved.length; j++) {
      if (resolved[i].username === resolved[j].username) return sameMemberMessage(fragments[i], fragments[j]);
    }
  }

  return buildCompareReplyMulti(resolved);
}

module.exports = {
  COMPARE_CLOSE_ID,
  buildCompareCloseRow,
  sameMemberMessage,
  replyCompareMembers,
  replyCompareMembersByUsername,
  replyCompareMembersMultiByUsername,
  MAX_COMPARE_MEMBERS,
  replyCompareMembersMulti,
};
