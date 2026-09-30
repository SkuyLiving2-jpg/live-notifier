const { getDiscordClient } = require("../discordClient");
const { PRIORITY_PING_USER_ID } = require("../config");

// DM ke owner bot (PRIORITY_PING_USER_ID) - dipake buat kabar OPERASIONAL yang cuma
// relevan buat pemilik (polling IDN macet, dst), makanya gak pernah ke channel
// publik (beda dari crashAlert.js yang boleh fallback ke webhook karena proses
// mau mati). Gak pernah throw; balikin true kalau kekirim.
async function sendOwnerDM(content) {
  const client = getDiscordClient();
  if (!client || !PRIORITY_PING_USER_ID) return false;
  try {
    const user = await client.users.fetch(PRIORITY_PING_USER_ID);
    await user.send({ content });
    return true;
  } catch (error) {
    console.error("Gagal ngirim DM ke owner (nggak fatal):", error.message);
    return false;
  }
}

module.exports = { sendOwnerDM };
