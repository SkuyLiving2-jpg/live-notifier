const { postToWebhook } = require("./webhook");
const { resolveDurationRound, discardDurationRound, resolveNextRound } = require("../storage/guessGame");
const { formatDuration } = require("../utils");

// Pengumuman hasil mini-game tebak-tebakan ke channel gabungan. Mention <@id> di
// sini SENGAJA tidak nge-ping (webhook.js's withDefaultMentionGuard): cuma nampilin
// nama pemenang, bukan mengganggu mereka.
const MAX_LISTED = 8;
const MEDALS = ["🥇", "🥈", "🥉"];

function describeDiff(diffMinutes) {
  if (diffMinutes < 1) return "kurang dari 1 mnt";
  return `${Math.round(diffMinutes)} mnt`;
}

function buildDurationResultText(result) {
  const lines = result.ranking.slice(0, MAX_LISTED).map((r, i) => {
    const bonus = r.exact ? " 🎯 tepat banget!" : "";
    const points = r.points > 0 ? ` - **+${r.points} poin**` : "";
    return `${MEDALS[i] || `${i + 1}.`} <@${r.userId}> tebak ${formatDuration(r.minutes * 60000)} (selisih ${describeDiff(r.diff)})${points}${bonus}`;
  });
  const more = result.ranking.length - lines.length;
  return [
    `🎯 **Hasil tebak durasi live ${result.name}** - live-nya selesai di **${formatDuration(result.durationMs)}**!`,
    ...lines,
    more > 0 ? `_...dan ${more} penebak lain_` : null,
    '_Skor: "cok papan tebak" - mau ikut? Pas ada yang live: "cok tebak <nama> <menit>"._',
  ]
    .filter(Boolean)
    .join("\n");
}

// Dipanggil monitor.js pas sesi selesai & durasinya masuk akal.
async function maybeResolveDurationGuesses(username, memberData, durationMs) {
  const liveAtUnix = Math.floor(new Date(memberData.liveAt).getTime() / 1000);
  const result = resolveDurationRound(username, liveAtUnix, durationMs);
  if (!result) return;
  await postToWebhook({ content: buildDurationResultText(result) }, `Gagal ngirim hasil tebak durasi ${result.name}:`);
}

function buildNextResultText(starterName, result) {
  const winners = result.winners.map((id) => `<@${id}>`).join(" ");
  const verdict =
    result.winners.length > 0
      ? `✅ Yang nebak bener: ${winners} (**+2 poin** tiap orang)${result.losers.length > 0 ? `, ${result.losers.length} orang meleset` : ""}.`
      : `Gak ada yang nebak bener (${result.total} penebak meleset).`;
  return `🔮 **${starterName}** yang live berikutnya!\n${verdict}`;
}

// Dipanggil monitor.js tiap ada member BARU mulai live.
async function maybeResolveNextStarter(username, name) {
  const result = resolveNextRound(username);
  if (!result || result.total === 0) return;
  await postToWebhook({ content: buildNextResultText(name, result) }, `Gagal ngirim hasil tebak berikutnya (${name}):`);
}

module.exports = { maybeResolveDurationGuesses, maybeResolveNextStarter, discardDurationRound, buildDurationResultText, buildNextResultText };
