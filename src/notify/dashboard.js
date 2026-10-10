const { createWebhookMessage, editWebhookMessage } = require("./webhook");
const { getSortedActiveLives } = require("../storage/activeLives");
const { loadDashboardState, saveDashboardState } = require("../storage/dashboard");
const { describeElapsed, formatViewCount } = require("../utils");
const { DASHBOARD_WEBHOOK_URL, DAILY_RECAP_COLOR } = require("../config");

// Saran fitur ke-7 (§10's kelimapuluh+item, paling susah dari batch saran
// fitur ini): dashboard "lagi live sekarang" - SATU pesan yang terus DI-EDIT
// di tempat (bukan pesan baru tiap kali ada yang mulai/selesai live), biar
// orang yang baru buka Discord langsung liat kondisi TERKINI tanpa perlu
// scroll nyariin notif start/end paling baru. Beda dari notif start/end
// biasa (notify/liveNotify.js) yang emang SENGAJA numpuk (riwayat siapa aja
// yang udah/lagi live, orang boleh liat semuanya) - dashboard ini murni
// tampilan STATUS SEKARANG, riwayatnya udah ke-cover notif biasa + "cok
// rekap".
//
// Modul terpisah (bukan ditumpuk ke notify/publicAlerts.js) - siklus hidup
// "SATU pesan yang terus di-edit + bisa "ilang" dan perlu dibikin ulang"
// beda kelasnya dari alert-alert sekali-tembak di publicAlerts.js (rekap/
// milestone/heads-up publik/digest jadwal), yang semuanya "kirim pesan BARU
// kalau kondisinya kepenuhin" - gak ada satupun yang perlu NGINGET ID pesan
// buat di-edit lagi nanti.

function buildDashboardPayload(sorted) {
  if (sorted.length === 0) {
    return {
      embeds: [
        {
          title: "🔴 Lagi Live Sekarang",
          description: "Gak ada member JKT48 yang lagi live saat ini.",
          color: DAILY_RECAP_COLOR,
          timestamp: new Date().toISOString(),
        },
      ],
    };
  }

  // Format baris SAMA persis kayak chat/replies/info.js's replyListLive ("cok
  // siapa yang live") - biar dashboard sama jawaban on-demand konsisten,
  // gak ada dua gaya nunjukkin info yang sama.
  const lines = sorted.map((entry, i) => {
    const elapsedText = describeElapsed(Date.now() - new Date(entry.liveAt).getTime());
    const viewText = entry.viewCount != null ? ` | 👁️ ${formatViewCount(entry.viewCount)}` : "";
    return `${i + 1}. **${entry.name}** - ${elapsedText}${viewText}`;
  });

  return {
    embeds: [
      {
        title: "🔴 Lagi Live Sekarang",
        description: lines.join("\n"),
        color: DAILY_RECAP_COLOR,
        footer: { text: "Update otomatis pas ada yang mulai/selesai live - jam & penonton di atas bukan real-time detik ini" },
        timestamp: new Date().toISOString(),
      },
    ],
  };
}

// Kunci "siapa aja yang lagi live" buat dideteksi PERUBAHANNYA - SENGAJA
// cuma daftar username (bukan teks lengkap yang ada elapsed time/viewer
// count di dalemnya, yang berubah TERUS-MENERUS walau rosternya sama sekali
// gak berubah). Lihat komen lengkapnya di storage/dashboard.js.
function usernamesKey(sorted) {
  return sorted.map((entry) => entry.username).join(",");
}

// Dipanggil monitor.js TIAP siklus polling (murah - short-circuit ke `return`
// di baris kedua kalau fitur ini mati, dan gak nyentuh network sama sekali
// kalau rosternya belum berubah dari terakhir kali di-update).
async function maybeUpdateDashboard() {
  if (!DASHBOARD_WEBHOOK_URL) return; // fitur opt-in, mati by default (lihat config.js)

  const sorted = getSortedActiveLives();
  const currentKey = usernamesKey(sorted);
  const state = loadDashboardState();
  if (state.messageId && state.lastUsernamesKey === currentKey) return; // roster gak berubah, gak perlu ngapa-ngapain

  const payload = buildDashboardPayload(sorted);

  if (state.messageId) {
    const result = await editWebhookMessage(state.messageId, payload, "Gagal update dashboard live:", DASHBOARD_WEBHOOK_URL);
    if (result === "ok") {
      saveDashboardState({ messageId: state.messageId, lastUsernamesKey: currentKey });
      return;
    }
    if (result === "failed") return; // gangguan sesaat - biarin pesan lama, coba lagi siklus berikutnya, JANGAN bikin pesan baru (bisa dobel)
    // result === "gone" (404, pesannya udah gak ada) - lanjut ke bawah, bikin BARU.
  }

  const newMessageId = await createWebhookMessage(payload, "Gagal bikin dashboard live:", DASHBOARD_WEBHOOK_URL);
  if (newMessageId) {
    saveDashboardState({ messageId: newMessageId, lastUsernamesKey: currentKey });
  }
  // Gagal bikin juga (newMessageId null) - state DIBIARIN apa adanya
  // (messageId tetep null), jadi siklus berikutnya nyoba bikin lagi dari
  // awal, bukan nyangkut permanen.
}

module.exports = { buildDashboardPayload, maybeUpdateDashboard };
