const path = require("path");
const { CACHE_DIR, PRIORITY_PING_USER_ID, WEEKLY_BACKUP_DM } = require("../config");
const { getDiscordClient } = require("../discordClient");
const { createJsonStore } = require("../storage/jsonStore");
const { buildBackupSnapshot } = require("../backup");
const { getDateWIB } = require("../utils");
const { sendOwnerDM } = require("./ownerAlert");

// Backup MINGGUAN otomatis ke DM owner. Data bot cuma ada di Volume Railway; kalau Volume hilang, tidak ada salinan
// lain kecuali kamu ingat menjalankan `npm run backup-data`. DM adalah salinan di luar Railway yang tidak butuh
// setup apa pun, dan memakai jalur yang sudah ada (sendOwnerDM).
//
// Yang TIDAK ikut: webhook channel khusus (rahasia - lihat SECTIONS[].secret di backup.js; push ulang dari file lokal
// lewat `npm run set-channel-routing`) dan activeLives (state sesaat). Status pengiriman disimpan di file sendiri supaya
// restart/redeploy tidak mengirim ulang, dan tidak ikut ter-restore.
const BACKUP_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
// Setelah percobaan GAGAL (DM ditutup, Discord error) jangan mencoba lagi tiap siklus polling (20 detik).
const RETRY_AFTER_MS = 60 * 60 * 1000;
// Batas lampiran bot Discord bervariasi per server/boost untuk DM; 8 MB aman di semua kondisi.
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

const store = createJsonStore(
  path.join(CACHE_DIR, "backup-dm-state.json"),
  { lastSentAt: null, lastAttemptAt: null },
  { errorLabel: "status backup mingguan" },
);

// Balikin true kalau backup BENAR-BENAR terkirim di panggilan ini.
async function maybeSendWeeklyBackup(now = Date.now()) {
  if (!WEEKLY_BACKUP_DM || !PRIORITY_PING_USER_ID) return false;
  const client = getDiscordClient();
  // Belum login/ready (beberapa detik pertama setelah boot): tunggu siklus berikutnya TANPA mencatat percobaan.
  if (!client || (typeof client.isReady === "function" && !client.isReady())) return false;

  const state = { lastSentAt: null, lastAttemptAt: null, ...store.load() };
  if (state.lastSentAt && now - state.lastSentAt < BACKUP_INTERVAL_MS) return false;
  if (state.lastAttemptAt && now - state.lastAttemptAt < RETRY_AFTER_MS) return false;

  // Dicatat SEBELUM mengirim: kalau pembuatan/pengiriman backup melempar error, siklus berikutnya tidak mengulang tiap 20 detik.
  state.lastAttemptAt = now;
  store.save(state);

  const date = getDateWIB(new Date(now));
  const json = JSON.stringify(buildBackupSnapshot({ excludeSecrets: true }));
  const bytes = Buffer.byteLength(json);

  let sent;
  if (bytes > MAX_ATTACHMENT_BYTES) {
    sent = await sendOwnerDM(
      `⚠️ **Backup mingguan (${date})**: datanya ${(bytes / 1024 / 1024).toFixed(1)} MB, terlalu besar buat dilampirkan di DM. Jalankan \`npm run backup-data\` dari komputermu.`,
    );
  } else {
    sent = await sendOwnerDM(
      `📦 **Backup data bot (mingguan, ${date})** - ${(bytes / 1024).toFixed(0)} KB. Simpan file ini; kalau data di Railway hilang, pulihkan dengan \`npm run restore-data -- <file>\`. Webhook channel khusus tidak ikut (push ulang pakai \`npm run set-channel-routing\`).`,
      { files: [{ attachment: Buffer.from(json), name: `backup-${date}.json` }] },
    );
  }

  if (sent) {
    state.lastSentAt = now;
    store.save(state);
    console.log(`Backup mingguan terkirim ke DM owner (${(bytes / 1024).toFixed(0)} KB)`);
  }
  return Boolean(sent);
}

module.exports = { maybeSendWeeklyBackup, BACKUP_INTERVAL_MS, RETRY_AFTER_MS, MAX_ATTACHMENT_BYTES };
