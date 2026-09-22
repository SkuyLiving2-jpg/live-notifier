const { postToWebhook } = require("./webhook");
const { getPriorityConfig } = require("../priority");
const { sendPriorityDM } = require("./priorityDm");
const { loadSubscriptions } = require("../storage/subscriptions");
const { getChannelWebhookFor } = require("../storage/channelRouting");
const { containsWholeWord, formatClockWIB } = require("../utils");
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
// timestamp (Date) - jam mulai (status "start", idealnya live_at asli dari
// IDN biar akurat) atau jam selesai (status "end", jam bot NGEDETEK
// selesainya, soalnya IDN gak nyediain jam selesai beneran) - SELALU
// ditempel sebagai baris TERAKHIR di content, biar backfill-live-history.js's
// START_RE/END_RE (yang cuma ngecek AWAL string, gak ada jangkar `$` di
// akhir) tetep bisa parsing pesan lama maupun baru tanpa perlu diubah.
function buildNormalPayload(memberName, liveUrl, status, priority = null, imageUrl = null, timestamp = new Date()) {
  if (status === "end") {
    return { content: `✅ **${memberName}** udah selesai live di IDN Live.\nSelesai jam ${formatClockWIB(timestamp)}` };
  }
  const introLine = priority?.startIntro ? `${priority.startIntro}\n` : "";
  const hashtagSuffix = priority?.startHashtag ? ` ${priority.startHashtag}` : "";
  const payload = {
    content: `${introLine}🚨 **${memberName}** lagi live di IDN Live!\nNonton di sini: ${liveUrl}${hashtagSuffix}\nMulai jam ${formatClockWIB(timestamp)}`,
  };
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

// liveAt (opsional) - jam mulai ASLI dari IDN (field live_at di
// getLivestreams, dikirim monitor.js cuma pas status "start"). Status "end"
// gak butuh ini - jam selesainya selalu "sekarang" (kapan bot NGEDETEK live
// itu udah gak ada lagi), bukan sesuatu yang IDN sediakan.
async function sendDiscordNotif(memberName, username, slug, status = "start", imageUrl = null, liveAt = null) {
  // Tanpa "www" biar konsisten sama link yang di-generate tombol Share di
  // app IDN sendiri (lebih besar kemungkinan ke-handle sebagai App
  // Link/Universal Link, alias langsung buka app di HP kalau appnya
  // udah ke-install, bukan buka browser).
  const liveUrl = `https://idn.app/${username}/live/${slug}`;
  const priority = getPriorityConfig(memberName, username);
  // `liveAt` datang MENTAH dari respons API IDN (idnApi.js gak validasi
  // format-nya sama sekali) - kalau IDN suatu saat ngasih string yang gak
  // keparse (bukan cuma null/kosong, yang udah ke-cover sama `!liveAt`),
  // `new Date(liveAt)` jadi Invalid Date. formatClockWIB() (Intl.DateTimeFormat)
  // THROW kalau dikasih Invalid Date, bukan ngasih teks aneh - tanpa
  // pengecekan Number.isNaN ini, satu live_at yang rusak bakal nge-throw
  // sampe ke checkLiveMembers()'s try/catch LUAR, motong siklus polling itu
  // lebih awal (member LAIN yang belum sempet diproses di siklus yang sama
  // ikut kelewat, bukan cuma yang live_at-nya rusak).
  const parsedLiveAt = liveAt ? new Date(liveAt) : null;
  const timestamp = status === "start" && parsedLiveAt && !Number.isNaN(parsedLiveAt.getTime()) ? parsedLiveAt : new Date();
  const payload = buildNormalPayload(memberName, liveUrl, status, priority, imageUrl, timestamp);

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

  // Channel KHUSUS member ini (fitur "Q2", storage/channelRouting.js) -
  // kalau ada, payload yang SAMA juga dikirim ke situ, DUPLIKAT (bukan
  // pengganti) dari channel gabungan di bawah. Dijalanin BARENGAN (bukan
  // nunggu satu-satu) - dua-duanya independen, nunggu berurutan cuma bakal
  // dobelin latensi tiap member yang punya channel khusus di tiap siklus
  // polling monitor.js tanpa manfaat apa-apa. `terkirim` (yang nentuin
  // activeLives/riwayat, lihat monitor.js) CUMA dari hasil channel gabungan
  // - kegagalan kirim ke channel khusus (mis. webhook-nya keburu dihapus)
  // dianggep best-effort, sama kayak sendPriorityDM di bawah, BUKAN dianggep
  // "notif ini gagal" secara keseluruhan.
  const dedicatedWebhookUrl = getChannelWebhookFor(username);
  const [terkirim] = await Promise.all([
    postToWebhook(payload),
    dedicatedWebhookUrl
      ? postToWebhook(payload, `Gagal ngirim notif ke channel khusus ${memberName}:`, dedicatedWebhookUrl).then((ok) => {
          if (ok) console.log(`Notif ${status} terkirim ke channel khusus ${memberName}`);
        })
      : null,
  ]);
  if (terkirim) {
    console.log(`Notif ${status} terkirim untuk ${memberName}`);
  }

  // DM flashy dikirim TERPISAH dari notif channel di atas, dan kegagalannya
  // gak mempengaruhi nilai balik "terkirim" (channel tetap dianggep sukses
  // walau DM-nya gagal, mis. pemilik nutup DM dari member server) - biar
  // activeLives/riwayat tetap ke-track normal, cuma sisi flashy-nya yang
  // sempet kelewat sekali.
  if (priority) {
    await sendPriorityDM(memberName, liveUrl, status, priority, imageUrl, timestamp);
  }

  return terkirim;
}

module.exports = { buildNormalPayload, sendDiscordNotif };
