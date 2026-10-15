// Harus di-require PALING AWAL (sebelum modul apa pun dari src/): src/config.js membaca process.env sekali saat pertama kali
// dimuat, dan dotenv TIDAK menimpa variabel yang sudah terisi - jadi mengisi/mengosongkan variabel di sini = .env asli tidak
// pernah dipakai playground. Hasilnya: tidak ada token bot, webhook, URL/secret API produksi, dan data ditulis ke folder
// sementara (bukan data/ milik bot yang jalan).
const fs = require("fs");
const os = require("os");
const path = require("path");

const OWNER_ID = "111111111111111111";
const OTHER_ID = "222222222222222222";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "jkt48-vc-playground-"));

// Semua kunci di .env.example DAN di .env asli (hanya NAMA kuncinya yang dibaca, nilainya tidak) dikosongkan kalau belum diisi
// proses pemanggil, supaya rahasia apa pun yang ada di .env (termasuk yang tidak tercantum di .env.example) tidak ikut terbaca.
// Nilai khusus playground ditimpa di bawahnya.
for (const file of [".env.example", ".env"]) {
  try {
    for (const line of fs.readFileSync(path.join(__dirname, "..", "..", file), "utf8").split(/\r?\n/)) {
      const key = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/.exec(line)?.[1];
      if (key && process.env[key] === undefined) process.env[key] = "";
    }
  } catch {
    // file tidak ada: daftar eksplisit di bawah tetap menutup variabel yang berbahaya.
  }
}

Object.assign(process.env, {
  CACHE_DIR: dataDir,
  DISCORD_BOT_TOKEN: "",
  DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/playground/dummy-tidak-pernah-dipanggil",
  DASHBOARD_WEBHOOK_URL: "",
  BOT_API_URL: "",
  API_SECRET: "",
  BOT_CHANNEL_ID: "",
  PRIORITY_PING_USER_ID: OWNER_ID,
  WEEKLY_BACKUP_DM: "off",
});

function removeDataDir() {
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // folder sementara; sisanya dibersihkan OS.
  }
}
process.on("exit", removeDataDir);

module.exports = { OWNER_ID, OTHER_ID, dataDir };
