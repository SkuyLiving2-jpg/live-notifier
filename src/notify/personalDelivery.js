const { getDiscordClient } = require("../discordClient");
const { getUserPrefs, isQuietHour } = require("../storage/userPrefs");
const { getHourWIBOf } = require("../utils");

// Preferensi pengguna (storage/userPrefs.js) buat notif yang nge-tag subscriber
// "cok ingetin": cara dikabari (tag di channel / DM) dan jam tenang.
//
// - jam tenang (WIB)  -> TIDAK di-tag dan TIDAK di-DM (mereka bisa cek "cok kelewat" nanti)
// - delivery "dm"     -> dikirim lewat DM, bukan di-tag di channel
// - lainnya / bot belum login (gak bisa DM) -> di-tag seperti biasa
function splitByPreference(userIds, now = new Date()) {
  const hour = getHourWIBOf(now);
  const canDm = Boolean(getDiscordClient());
  const tag = [];
  const dm = [];
  const quiet = [];
  for (const id of userIds) {
    const prefs = getUserPrefs(id);
    if (isQuietHour(prefs, hour)) quiet.push(id);
    else if (prefs.delivery === "dm" && canDm) dm.push(id);
    else tag.push(id);
  }
  return { tag, dm, quiet };
}

// DM bisa nyangkut (jaringan Discord lambat) - jangan sampai nahan siklus polling.
const DM_TIMEOUT_MS = 5000;

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("DM timeout")), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Kirim `payload` lewat DM ke semua `userIds` bersamaan. Balikin { sent, failed } -
// `failed` (DM ditutup, user gak ketemu, timeout) dipakai pemanggil buat jatuh
// balik ke tag di channel supaya gak ada yang kehilangan notif diam-diam.
async function sendDirectMessages(userIds, payload) {
  const client = getDiscordClient();
  if (!client || userIds.length === 0) return { sent: [], failed: [...userIds] };
  const results = await Promise.allSettled(
    userIds.map((id) =>
      withTimeout(
        client.users.fetch(id).then((user) => user.send(payload)),
        DM_TIMEOUT_MS,
      ),
    ),
  );
  const sent = [];
  const failed = [];
  results.forEach((result, i) => (result.status === "fulfilled" ? sent : failed).push(userIds[i]));
  if (failed.length > 0) console.error(`DM subscriber gagal buat ${failed.length} user (jatuh balik ke tag di channel).`);
  return { sent, failed };
}

module.exports = { splitByPreference, sendDirectMessages };
