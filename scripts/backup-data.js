// Tool CLI MANUAL - narik backup semua data bot (rekap live, riwayat
// durasi, prioritas custom, subscription, snapshot gifter) dari endpoint
// /api/backup yang jalan di Railway, disimpen ke file lokal. BUKAN bagian
// dari bot 24 jam (sama kategorinya kayak cek-top-gifter.js) - dijalanin
// sendiri kapan aja kamu mau ada cadangan, gak otomatis/terjadwal.
//
// PENTING: data bot cuma ada di Railway Volume-nya - kalau itu kenapa-kenapa
// (ke-detach, ke-hapus gak sengaja, dll), gak ada cadangan lain sama sekali
// tanpa ini.
//
// Jalanin: npm run backup-data
// Butuh BOT_API_URL & API_SECRET di .env - env var yang SAMA PERSIS kayak
// yang dipake scripts/cek-top-gifter.js buat ngirim snapshot gifter (lihat
// .env.example). Kalau salah satu kosong, script ini berhenti & bilang
// kenapa, bukan diem-diem gagal.

const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const { signPayload } = require("../src/security");

const BOT_API_URL = process.env.BOT_API_URL || "";
const API_SECRET = process.env.API_SECRET || "";

async function main() {
  if (!BOT_API_URL || !API_SECRET) {
    console.error("BOT_API_URL dan API_SECRET harus diisi di .env dulu (env var yang sama kayak buat cek-top-gifter.js - lihat .env.example).");
    process.exit(1);
  }

  // Sama persis pola signing-nya kayak cek-top-gifter.js's pushSnapshotToBot
  // - bedanya di sini gak ada body (GET, narik doang), jadi di-sign string
  // kosong. Server-nya (src/server.js's handleBackupExport, lewat
  // requireSignedRequest) verifikasi pake body yang beneran diterima -
  // request tanpa body kebaca sebagai string kosong juga di sisi situ,
  // jadi tetep cocok.
  const timestamp = Date.now().toString();
  const signature = signPayload(API_SECRET, timestamp, "");

  const res = await fetch(`${BOT_API_URL.replace(/\/+$/, "")}/api/backup`, {
    method: "GET",
    headers: {
      "X-Api-Timestamp": timestamp,
      "X-Api-Signature": signature,
    },
  });

  if (!res.ok) {
    const errBody = await res.json().catch(() => null);
    console.error(`Bot balikin status ${res.status}: ${errBody ? JSON.stringify(errBody) : "(gak ada detail)"}`);
    process.exit(1);
  }

  const data = await res.json();

  const backupsDir = path.join(__dirname, "..", "backups");
  fs.mkdirSync(backupsDir, { recursive: true });
  const filename = `backup-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  const filePath = path.join(backupsDir, filename);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));

  console.log(`Backup tersimpan di ${filePath}`);
}

main().catch((error) => {
  console.error("Gagal narik backup:", error.message);
  process.exit(1);
});
