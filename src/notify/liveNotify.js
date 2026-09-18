const { postToWebhook } = require("./webhook");
const { getPriorityConfig } = require("../priority");
const { sendPriorityDM } = require("./priorityDm");
const { loadSubscriptions } = require("../storage/subscriptions");
const { containsWholeWord } = require("../utils");
const { PRIORITY_PING_USER_ID } = require("../config");

function buildNormalPayload(memberName, liveUrl, status) {
  return status === "end"
    ? { content: `✅ **${memberName}** udah selesai live di IDN Live.` }
    : { content: `🚨 **${memberName}** lagi live di IDN Live!\nNonton di sini: ${liveUrl}` };
}

// User yang udah dapet DM prioritas (PRIORITY_PING_USER_ID, lihat
// notify/priorityDm.js's sendPriorityDM) di-exclude dari hasil
// SUBSCRIPTION-nya kalau member ini kebetulan member prioritas juga - biar
// owner gak dobel ke-tag (sekali di DM prioritas, sekali lagi di notif
// channel biasa). Sebelumnya ini selalu ngehapus PRIORITY_PING_USER_ID dari
// hasil apapun membernya - bug-nya, kalau si owner subscribe ke member yang
// BUKAN prioritas, dia nggak akan pernah ke-tag walau udah subscribe.
function getSubscribersFor(memberName, username) {
  const text = `${memberName || ""} ${username || ""}`.toLowerCase();
  const subs = loadSubscriptions();
  const ids = new Set();
  for (const [keyword, list] of Object.entries(subs)) {
    if (containsWholeWord(text, keyword)) list.forEach((id) => ids.add(id));
  }
  if (getPriorityConfig(memberName, username)) ids.delete(PRIORITY_PING_USER_ID);
  return [...ids];
}

async function sendDiscordNotif(memberName, username, slug, status = "start", imageUrl = null) {
  // Tanpa "www" biar konsisten sama link yang di-generate tombol Share di
  // app IDN sendiri (lebih besar kemungkinan ke-handle sebagai App
  // Link/Universal Link, alias langsung buka app di HP kalau appnya
  // udah ke-install, bukan buka browser).
  const liveUrl = `https://idn.app/${username}/live/${slug}`;
  const priority = getPriorityConfig(memberName, username);
  const payload = buildNormalPayload(memberName, liveUrl, status);

  if (status === "start") {
    const subscriberIds = getSubscribersFor(memberName, username);
    if (subscriberIds.length > 0) {
      const mentions = subscriberIds.map((id) => `<@${id}>`).join(" ");
      payload.content = `${payload.content}\n${mentions} kamu subscribe notif buat member ini!`;
    }
  }

  const terkirim = await postToWebhook(payload);
  if (terkirim) {
    console.log(`Notif ${status} terkirim untuk ${memberName}`);
  }

  // DM flashy dikirim TERPISAH dari notif channel di atas, dan kegagalannya
  // gak mempengaruhi nilai balik "terkirim" (channel tetap dianggep sukses
  // walau DM-nya gagal, mis. pemilik nutup DM dari member server) - biar
  // activeLives/riwayat tetap ke-track normal, cuma sisi flashy-nya yang
  // sempet kelewat sekali.
  if (priority) {
    await sendPriorityDM(memberName, liveUrl, status, priority, imageUrl);
  }

  return terkirim;
}

module.exports = { buildNormalPayload, sendDiscordNotif };
