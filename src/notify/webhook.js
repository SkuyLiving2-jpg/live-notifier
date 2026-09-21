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

async function postToWebhook(payload, errorLabel = "Gagal ngirim notif ke Discord:") {
  try {
    const response = await fetch(DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(withDefaultMentionGuard(payload)),
    });
    if (!response.ok) {
      throw new Error(`Discord webhook balikin status ${response.status}`);
    }
    return true;
  } catch (error) {
    console.error(errorLabel, error.message);
    return false;
  }
}

module.exports = { postToWebhook, withDefaultMentionGuard };
