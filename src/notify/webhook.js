const { DISCORD_WEBHOOK_URL } = require("../config");

// Helper bersama buat POST payload ke channel webhook Discord - dedup dari
// ~5 blok try/catch fetch(DISCORD_WEBHOOK_URL) yang sebelumnya ditulis
// manual berulang (notif start/end, rekap harian, alert rekor baru, alert
// milestone penonton). Cuma ngurusin kirim + error-nya - pesan sukses tetap
// dicetak sama masing-masing pemanggil (isinya beda-beda, ada detail
// dinamis per kejadian), makanya cuma balikin true/false.
// `allowed_mentions: { parse: [] }` matiin SEMUA mention implisit
// (@everyone/@here/role/user) dari teks - default-nya Discord justru
// SEBALIKNYA (parse SEMUA jenis mention yang nyantol di content apa
// adanya). Tanpa ini, nama member dari IDN (`memberName`/`entry.name`,
// dipake mentah di banyak payload lewat helper ini) yang KEBETULAN
// ngandung "@everyone" bakal beneran ngeping semua orang di server. Kalau
// pemanggil emang butuh mention SPESIFIK (satu-satunya kasus sekarang:
// notify/liveNotify.js's subscriber ping), dia nyetel `allowed_mentions`
// sendiri di payload-nya (mis. `{ users: [...id] }`) - itu nimpa default
// ini (spread di bawah, field pemanggil menang), jadi CUMA id yang
// disebutin eksplisit itu yang bisa ke-ping, apapun isi teksnya.
function withDefaultMentionGuard(payload) {
  return { allowed_mentions: { parse: [] }, ...payload };
}

// Percobaan TAMBAHAN maksimal kalau kena rate limit (429) - bot ini kecil/
// personal (1 webhook, jarang banget kirim beruntun banyak sekaligus), jadi
// kalau masih ke-rate-limit abis segini kali coba, itu udah tanda ada
// masalah lain (Discord lagi bermasalah, dll), bukan sesuatu yang wajar
// buat terus-terusan di-retry.
const MAX_RATE_LIMIT_RETRIES = 3;
// Cap brapa lama nunggu per retry, TERLEPAS dari retry_after yang diminta
// Discord - biar satu notif yang kena rate limit parah gak nyandera siklus
// polling monitor.js (POLL_INTERVAL_MS, default 20 detik) kelamaan nunggu
// (semua pemanggil postToWebhook di-await, jadi delay di sini nunda proses
// member berikutnya di siklus yang sama juga).
const MAX_RATE_LIMIT_WAIT_MS = 5000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Discord ngasih tau berapa detik (boleh pecahan) harus nunggu lewat field
// `retry_after` di BODY JSON respons 429-nya - bukan cuma header
// Retry-After. Fallback ke 1 detik kalau body-nya somehow gak kebaca/gak
// punya field itu (respons rusak/berubah format), biar tetep ada jeda
// (bukan langsung nyoba lagi tanpa jeda sama sekali) tanpa gantung nunggu
// parsing yang gak akan pernah berhasil.
async function getRetryAfterMs(response) {
  try {
    const data = await response.json();
    if (typeof data?.retry_after === "number" && data.retry_after >= 0) {
      return Math.min(Math.ceil(data.retry_after * 1000), MAX_RATE_LIMIT_WAIT_MS);
    }
  } catch {
    // body bukan JSON valid/kosong - pakai fallback di bawah
  }
  return 1000;
}

// Retry CUMA buat 429 (rate limit) - itu satu-satunya kegagalan yang emang
// masuk akal buat dicoba lagi tanpa perlu campur tangan (nunggu bentar
// pasti balik normal). Status lain (4xx payload salah, 5xx Discord
// bermasalah) ATAU network error (fetch throw) langsung dianggap gagal
// tanpa retry, sama kayak perilaku sebelumnya - nyoba ulang PERSIS payload
// yang sama buat kegagalan jenis itu cuma bakal gagal lagi dengan cara yang
// sama (kalau payloadnya emang salah) atau nambah beban ke layanan yang
// emang lagi bermasalah, bukan nolong apa-apa.
//
// Diekstrak dari postToWebhook (§10's kelimapuluh+item, saran fitur ke-7,
// dashboard live) biar retry/backoff 429-nya bisa dipakai bareng sama
// createWebhookMessage/editWebhookMessage di bawah, TANPA nyalin-ulang loop
// yang sama - balikin Response APA ADANYA (baik ok maupun enggak, KECUALI
// exception/network error yang balikin null), biar pemanggil yang mutusin
// sendiri gimana nanganin status non-2xx SPESIFIK (mis. editWebhookMessage
// perlu tau beda 404 dari kegagalan lain, postToWebhook sendiri gak peduli
// beda itu sama sekali).
async function sendWebhookRequest(method, url, body, errorLabel) {
  for (let attempt = 1; attempt <= MAX_RATE_LIMIT_RETRIES + 1; attempt++) {
    try {
      const response = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body,
      });

      if (response.ok) return response;

      if (response.status === 429 && attempt <= MAX_RATE_LIMIT_RETRIES) {
        const waitMs = await getRetryAfterMs(response);
        console.error(
          `${errorLabel} kena rate limit Discord (429) - nunggu ${waitMs}ms, coba lagi (percobaan ${attempt + 1}/${MAX_RATE_LIMIT_RETRIES + 1})`,
        );
        await sleep(waitMs);
        continue;
      }

      return response;
    } catch (error) {
      console.error(errorLabel, error.message);
      return null;
    }
  }

  // Gak akan kesampe beneran - loop di atas selalu return sebelum abis
  // (percobaan terakhir yang masih 429 jatuh ke return response di dalam
  // loop). Dibiarin di sini murni jaga-jaga/menuhin "function harus balikin
  // sesuatu", bukan jalur yang dianggap bisa kejalanin.
  return null;
}

// webhookUrl (opsional, default DISCORD_WEBHOOK_URL/channel gabungan) - buat
// fitur channel khusus per-member (lihat storage/channelRouting.js), yang
// butuh kirim payload yang SAMA ke webhook LAIN (channel spesifik member
// itu). Sengaja jadi parameter tambahan doang (bukan ubah signature yang
// udah ada) - semua pemanggil lama tetep jalan identik tanpa perlu diubah.
async function postToWebhook(payload, errorLabel = "Gagal ngirim notif ke Discord:", webhookUrl = DISCORD_WEBHOOK_URL) {
  const body = JSON.stringify(withDefaultMentionGuard(payload));
  const response = await sendWebhookRequest("POST", webhookUrl, body, errorLabel);
  if (!response) return false; // exception/network error - sendWebhookRequest udah nyetak errorLabel-nya sendiri
  if (response.ok) return true;

  console.error(errorLabel, `Discord webhook balikin status ${response.status}`);
  return false;
}

// Bikin pesan BARU lewat webhook DAN balikin ID-nya (beda dari postToWebhook
// biasa, yang gak pernah butuh tau ID pesan yang ke-post - cuma peduli
// sukses/gagal doang). Query `?wait=true` (didokumentasiin resmi sama
// Discord) bikin webhook POST balikin JSON pesan yang beneran ke-post
// (termasuk `.id`), bukan cuma 204 No Content polos. Dipake
// notify/dashboard.js pas belum ada dashboard sama sekali (messageId null)
// ATAU abis dashboard lama ilang (dihapus manual, lihat editWebhookMessage's
// "gone" case) - balikin null kalau gagal (exception, kena status gagal, ATAU
// body sukses tapi somehow bukan JSON/gak punya field `id`).
async function createWebhookMessage(payload, errorLabel, webhookUrl = DISCORD_WEBHOOK_URL) {
  const body = JSON.stringify(withDefaultMentionGuard(payload));
  const response = await sendWebhookRequest("POST", `${webhookUrl}?wait=true`, body, errorLabel);
  if (!response) return null;
  if (!response.ok) {
    console.error(errorLabel, `Discord webhook balikin status ${response.status}`);
    return null;
  }

  try {
    const data = await response.json();
    return data.id || null;
  } catch (error) {
    console.error(`${errorLabel} respons sukses tapi body-nya bukan JSON yang kebaca:`, error.message);
    return null;
  }
}

// Edit pesan yang UDAH ADA (dashboard live, notify/dashboard.js). Balikin
// salah satu dari tiga kemungkinan, BUKAN boolean polos - pemanggil butuh
// nanganin ketiganya beda-beda:
// - "ok"     - berhasil diedit.
// - "gone"   - Discord balikin 404 (pesannya udah gak ada lagi, mis. dihapus
//              manual dari Discord-nya langsung) - pemanggil harus bikin
//              pesan BARU (createWebhookMessage), nyoba edit ID yang udah
//              gak ada lagi bakal 404 selamanya.
// - "failed" - kegagalan LAIN (network, status gagal selain 404, dll) -
//              biarin pesan lama apa adanya, coba lagi siklus polling
//              berikutnya - BUKAN dianggap "gone" (asumsi keliru "gone"
//              buat kegagalan sesaat bakal bikin dashboard baru dibikin
//              TERUS-TERUSAN tiap kali kena gangguan jaringan sesaat,
//              ninggalin banyak pesan lama yang gak pernah kehapus).
async function editWebhookMessage(messageId, payload, errorLabel, webhookUrl = DISCORD_WEBHOOK_URL) {
  const body = JSON.stringify(withDefaultMentionGuard(payload));
  const response = await sendWebhookRequest("PATCH", `${webhookUrl}/messages/${messageId}`, body, errorLabel);
  if (!response) return "failed";
  if (response.ok) return "ok";
  if (response.status === 404) return "gone";

  console.error(errorLabel, `Discord webhook balikin status ${response.status}`);
  return "failed";
}

module.exports = {
  postToWebhook,
  createWebhookMessage,
  editWebhookMessage,
  withDefaultMentionGuard,
  MAX_RATE_LIMIT_RETRIES,
  MAX_RATE_LIMIT_WAIT_MS,
};
