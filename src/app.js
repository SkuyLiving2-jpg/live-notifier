const { DISCORD_BOT_TOKEN } = require("./config");
const { createDiscordClient, getDiscordClient } = require("./discordClient");
const { wireDiscordEvents } = require("./chat/router");
const { startServer } = require("./server");
const { pollLoop, stopPolling } = require("./monitor");
const { sendCrashAlert } = require("./notify/crashAlert");

// Berapa lama paling lama nunggu sendCrashAlert() (network call ke Discord)
// sebelum proses keluar paksa - upaya ngasih tau gak boleh nahan proses
// mati selamanya kalau koneksinya kebetulan lagi hang.
const CRASH_ALERT_TIMEOUT_MS = 3000;

// Titik masuk tunggal buat nyalain seluruh bot - dipanggil dari src/index.js.
// Sengaja dipisah dari require-time (bukan langsung jalan begitu file ini
// di-require) biar modul-modul lain (storage, notify, priority, dst) bisa
// di-require sendiri-sendiri buat dites/diperiksa tanpa ikut nyalain server
// HTTP, login Discord, atau mulai polling IDN.
function start() {
  const server = startServer();

  // Fitur tanya-jawab DAN DM notif prioritas ini opsional - kalau
  // DISCORD_BOT_TOKEN nggak diset, notifikasi channel tetap jalan normal,
  // cuma bot nggak bisa dichat dan member prioritas gak dapet perlakuan
  // flashy/DM (bakal dapet notif biasa doang, sama kayak member lain).
  if (DISCORD_BOT_TOKEN) {
    const client = createDiscordClient();
    wireDiscordEvents(client);
  } else {
    console.log(
      "DISCORD_BOT_TOKEN nggak diset - fitur tanya-jawab DAN DM notif prioritas dimatiin (notif channel tetap jalan normal, member prioritas dapet notif biasa kayak member lain).",
    );
  }

  // Graceful shutdown - Railway (dan platform sejenis) ngirim SIGTERM pas
  // mau matiin/restart container (redeploy, scaling, dll) dan nunggu bentar
  // sebelum SIGKILL paksa. Tanpa ini, proses kepotong kasar di tengah
  // siklus polling yang lagi jalan; dengan ini, siklus yang lagi jalan
  // dibiarin kelar dulu, koneksi Discord ditutup rapi, server HTTP-nya
  // di-close, baru keluar - atau paksa keluar abis beberapa detik kalau ada
  // yang nyangkut (jaga-jaga, bukan diharepin kejadian).
  let shuttingDown = false;
  function shutdown(signal) {
    if (shuttingDown) return; // Ctrl+C dobel dst - jangan proses 2x
    shuttingDown = true;
    console.log(`${signal} diterima, matiin bot dengan rapi...`);

    stopPolling();
    getDiscordClient()?.destroy();
    server.close(() => process.exit(0));

    // Fallback - kalau server.close() somehow nggak pernah manggil
    // callback-nya (mis. ada koneksi HTTP yang nyangkut kebuka), tetep
    // keluar daripada nge-gantung selamanya. .unref() biar timer ini
    // sendiri gak nahan proses tetep hidup kalau shutdown normal berhasil
    // duluan sebelum 5 detik.
    setTimeout(() => process.exit(0), 5000).unref();
  }
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // Jaring pengaman TERAKHIR - checkLiveMembers() di monitor.js udah
  // punya try/catch sendiri buat error per-siklus polling biasa (jadi bot
  // TETEP jalan lanjut walau 1 siklus gagal). Dua handler ini buat sesuatu
  // yang beneran LOLOS dari situ (bug di tempat lain, event handler
  // Discord yang error, dll) - dikasih tau dulu (best-effort, dibatesin
  // waktu biar gak nge-gantung) baru proses keluar, daripada mati diem-diem
  // tanpa jejak sama sekali.
  async function handleFatalError(context, error) {
    console.error(`${context}:`, error);
    await Promise.race([sendCrashAlert(context, error), new Promise((resolve) => setTimeout(resolve, CRASH_ALERT_TIMEOUT_MS))]);
    process.exit(1);
  }
  process.on("uncaughtException", (error) => {
    handleFatalError("uncaughtException", error);
  });
  process.on("unhandledRejection", (reason) => {
    handleFatalError("unhandledRejection", reason);
  });

  console.log("Bot notifikasi IDN Live jalan...");
  pollLoop();
}

module.exports = { start };
