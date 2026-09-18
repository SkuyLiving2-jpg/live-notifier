const { DISCORD_WEBHOOK_URL } = require("../config");

// Helper bersama buat POST payload ke channel webhook Discord - dedup dari
// ~5 blok try/catch fetch(DISCORD_WEBHOOK_URL) yang sebelumnya ditulis
// manual berulang (notif start/end, rekap harian, alert rekor baru, alert
// milestone penonton). Cuma ngurusin kirim + error-nya - pesan sukses tetap
// dicetak sama masing-masing pemanggil (isinya beda-beda, ada detail
// dinamis per kejadian), makanya cuma balikin true/false.
async function postToWebhook(payload, errorLabel = "Gagal ngirim notif ke Discord:") {
  try {
    const response = await fetch(DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
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

module.exports = { postToWebhook };
