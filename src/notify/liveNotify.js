const { postToWebhook } = require("./webhook");
const { getPriorityConfig } = require("../priority");
const { sendPriorityDM } = require("./priorityDm");
const { loadSubscriptions } = require("../storage/subscriptions");
const { containsWholeWord } = require("../utils");
const { PRIORITY_PING_USER_ID } = require("../config");

// priority (opsional) - kalau member ini punya startIntro/startHashtag (lihat
// config.js's PRIORITY_MEMBERS, sekarang cuma Nala yang diisi) itu ikut
// ditempel di notif CHANNEL juga, TAPI formatnya TETAP plain content kayak
// notif member lain (bukan ganti jadi embed/tombol flashy kayak
// priority/index.js's buildPriorityPayload, yang cuma dikirim ke DM pribadi
// owner). Sengaja dipertahanin plain: activeLives/daily-log (yang dipake
// rekap) dicatet dari BOOKKEEPING internal bot, bukan di-parse dari teks
// notif channel - jadi nambahin intro/hashtag di sini aman, gak ngubah
// struktur pesan yang bisa bikin sesi Nala "kelewatan" dari rekap.
// imageUrl (opsional) - thumbnail live dari IDN (field image_url di
// getLivestreams, sama field yang dipake priority/index.js's embed flashy).
// Sebelumnya CUMA member prioritas yang dapet gambar di notifnya (channel
// notif biasa selalu polos teks doang) - sekarang semua member dapet gambar
// juga kalau IDN nyediain (kadang null di detik-detik pertama live baru
// mulai, sebelum thumbnail-nya sempet ke-generate). Ditaro di `embeds`
// (BUKAN nambahin title/color/field apapun - cuma field `image` doang),
// jadi TETEP "plain" secara isi (gak ada yang bikin notif ini keliatan
// spesial dibanding member lain, beda sama priority's embed flashy), cuma
// visualnya lebih enak diliat. `content` (dan makanya parsing backfill yang
// baca message.content) sama sekali gak kesentuh oleh ini.
function buildNormalPayload(memberName, liveUrl, status, priority = null, imageUrl = null) {
  if (status === "end") {
    return { content: `✅ **${memberName}** udah selesai live di IDN Live.` };
  }
  const introLine = priority?.startIntro ? `${priority.startIntro}\n` : "";
  const hashtagSuffix = priority?.startHashtag ? ` ${priority.startHashtag}` : "";
  const payload = { content: `${introLine}🚨 **${memberName}** lagi live di IDN Live!\nNonton di sini: ${liveUrl}${hashtagSuffix}` };
  if (imageUrl) {
    payload.embeds = [{ image: { url: imageUrl } }];
  }
  return payload;
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
  const payload = buildNormalPayload(memberName, liveUrl, status, priority, imageUrl);

  if (status === "start") {
    const subscriberIds = getSubscribersFor(memberName, username);
    if (subscriberIds.length > 0) {
      const mentions = subscriberIds.map((id) => `<@${id}>`).join(" ");
      payload.content = `${payload.content}\n${mentions} kamu subscribe notif buat member ini!`;
      // Satu-satunya mention yang BENERAN dimaksud di jalur ini - scoped
      // eksplisit ke ID subscriber doang (lihat webhook.js's
      // withDefaultMentionGuard), biar CUMA mereka yang ke-ping walau
      // memberName kebetulan ngandung teks semacam "@everyone".
      payload.allowed_mentions = { users: subscriberIds };
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
