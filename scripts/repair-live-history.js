// Tool CLI MANUAL, SEKALI PAKAI - dijalanin sendiri di komputermu, BUKAN
// bagian dari bot Discord yang jalan 24 jam di Railway (sama kategorinya
// kayak cek-top-gifter.js/backup-data.js/backfill-live-history.js).
//
// KENAPA INI ADA: scripts/backfill-live-history.js sebelum diperbaiki punya
// bug fatal di reconstructSessions - "start" yang numpuk tanpa "end" di
// antaranya (mis. bot sempet restart di tengah live) bisa kepasangin ke
// "end" yang SALAH, ngasilin sesi dengan durasi ratusan jam. Kalau kamu udah
// sempet jalanin "npm run backfill-live-history -- --apply" SEBELUM fix itu
// ada, data korup itu udah kesimpen beneran di Volume Railway - fix di
// reconstructSessions doang gak nge-beresin yang UDAH TERLANJUR nyangkut di
// sana. Script ini yang beresin: manggil endpoint /api/repair-live-history
// yang buang sesi/entry durasinya gak masuk akal (>12 jam) dari
// daily-log.json + live-duration-history.json, terus rebuild live-count.json
// dari data yang udah bersih.
//
// AMAN dijalanin - cuma MEMBUANG data yang emang gak valid (durasi
// implausible), gak nyentuh sesi yang durasinya wajar sama sekali. Aman
// diulang kalau perlu (kedua kalinya bakal ngelaporin 0 yang dibuang, karena
// yang implausible udah kebuang di jalan pertama).
//
// Jalanin: npm run repair-live-history           (DRY RUN, preview doang)
//          npm run repair-live-history -- --apply (BENERAN buang datanya)
//
// Butuh di .env: BOT_API_URL, API_SECRET (sama kayak backup-data.js).

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const { signPayload } = require("../src/security");

const BOT_API_URL = process.env.BOT_API_URL || "";
const API_SECRET = process.env.API_SECRET || "";

async function main() {
  const apply = process.argv.includes("--apply");

  if (!BOT_API_URL || !API_SECRET) {
    console.error("BOT_API_URL dan API_SECRET harus diisi di .env dulu (env var yang sama kayak buat backup-data.js - lihat .env.example).");
    process.exit(1);
  }

  const bodyString = JSON.stringify({ dryRun: !apply });
  const timestamp = Date.now().toString();
  const signature = signPayload(API_SECRET, timestamp, bodyString);

  const res = await fetch(`${BOT_API_URL.replace(/\/+$/, "")}/api/repair-live-history`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Api-Timestamp": timestamp, "X-Api-Signature": signature },
    body: bodyString,
  });

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    console.error(`Bot balikin status ${res.status}: ${data ? JSON.stringify(data) : "(gak ada detail)"}`);
    process.exit(1);
  }

  console.log(JSON.stringify(data, null, 2));

  if (!apply) {
    console.log('\nIni baru PREVIEW - jalanin lagi dengan "npm run repair-live-history -- --apply" buat beneran buang data korupnya.');
  } else {
    console.log(
      "\nSelesai. Coba tanya bot 'cok berapa kali <nama> live', 'cok kapan <nama> live', atau 'cok rekap minggu/bulan ini' buat verifikasi durasinya udah masuk akal.",
    );
  }
}

main().catch((error) => {
  console.error("Gagal:", error.message);
  process.exit(1);
});
