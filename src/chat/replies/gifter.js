// Snapshot top gifter per member.

const { loadGifterSnapshot, findGifterSnapshotByNameFragment } = require("../../storage/gifterSnapshot");
const { formatRelativeTime } = require("../../utils");

// PENTING: ini SNAPSHOT (foto sesaat), bukan live/real-time. Bot ini sendiri
// nggak pernah manggil API top-gifter (butuh login pribadi) - datanya cuma
// seakurat terakhir kali kamu jalanin "npm run cek-gifter" manual, jadi
// selalu dikasih tau "dicek X lalu" biar orang gak salah kira ini real-time.
function formatGifterSnapshotReply(found) {
  const checkedText = formatRelativeTime(new Date(found.checkedAt));
  if (!found.gifters || found.gifters.length === 0) {
    return `Cok, **${found.name}** belum ada gifter di data terakhir (dicek ${checkedText}, bukan live real-time).`;
  }

  const medals = ["🥇", "🥈", "🥉"];
  const lines = found.gifters
    .slice(0, 10)
    .map((g, i) => `${medals[i] || `${i + 1}.`} ${g.name} - ${Number(g.total_gold).toLocaleString("id-ID")} Gold`);

  return [`🏆 **Top Gifter ${found.name}** (dicek ${checkedText}, BUKAN live real-time)`, ...lines].join("\n");
}

function replyGifterSnapshot(fragment) {
  const name = (fragment || "").trim();
  if (!name) return 'Gifter siapa? Ketik nama membernya juga ya, misal "cok gifter kathrina".';

  const found = findGifterSnapshotByNameFragment(name);
  if (!found) {
    return `Cok, belum ada data top gifter buat "${name}". Yang pegang akun IDN-nya bisa jalanin "npm run cek-gifter" dulu di komputernya biar ke-update.`;
  }
  return formatGifterSnapshotReply(found);
}

// Dipake dari dropdown tombol (fallback_select:9) - beda dari replyGifterSnapshot
// yang nyari lewat FRAGMEN nama (bisa ambigu kalau ada 2 member namanya mirip),
// ini langsung ambil dari username yang UDAH PASTI dipilih user dari dropdown,
// gak perlu nebak-nebak lagi.
function replyGifterSnapshotByUsername(username) {
  const { members } = loadGifterSnapshot();
  const data = members[username];
  if (!data) {
    return `Cok, belum ada data top gifter buat member ini. Yang pegang akun IDN-nya bisa jalanin "npm run cek-gifter" dulu biar ke-update.`;
  }
  return formatGifterSnapshotReply({ username, ...data });
}

module.exports = {
  replyGifterSnapshot,
  replyGifterSnapshotByUsername,
};
