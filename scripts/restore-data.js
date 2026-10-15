// Tool CLI MANUAL - memulihkan data bot dari file backup (hasil `npm run backup-data`, atau file .json yang dikirim
// bot ke DM-mu tiap minggu). BUKAN bagian dari bot 24 jam; kebalikan dari backup-data.js.
//
// Jalanin: npm run restore-data -- <file.json>                       (PRATINJAU saja - tidak menulis apa pun)
//          npm run restore-data -- <file.json> --apply               (benar-benar memulihkan)
//          npm run restore-data -- <file.json> --sections=dailyLog,liveCount [--apply]   (hanya sebagian)
//
// Pengaman: tanpa --apply ini hanya menampilkan rencana (jumlah entri sekarang vs yang masuk). Server memvalidasi
// SEMUA section dulu - satu saja salah bentuk, tidak ada yang ditulis. Dengan --apply, keadaan SEKARANG diunduh dulu
// ke backups/pre-restore-*.json di komputermu (kalau unduhan gagal, pemulihan dibatalkan) - kalau ternyata salah
// file, pulihkan balik dari file itu. Server juga menyimpan salinan sendiri (pre-restore-*.json di folder datanya).
// activeLives di file backup sengaja diabaikan (state live yang sedang berjalan).
//
// Butuh BOT_API_URL & API_SECRET di .env - sama persis kayak backup-data.js.

const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const { signPayload, MAX_REQUEST_BODY_BYTES } = require("../src/security");

const BOT_API_URL = process.env.BOT_API_URL || "";
const API_SECRET = process.env.API_SECRET || "";

function parseArgs(argv) {
  const args = { file: null, apply: false, sections: undefined };
  for (const arg of argv) {
    if (arg === "--apply") args.apply = true;
    else if (arg.startsWith("--sections="))
      args.sections = arg
        .slice("--sections=".length)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    else if (arg.startsWith("--")) throw new Error(`opsi tidak dikenal: ${arg}`);
    else if (!args.file) args.file = arg;
    else throw new Error(`argumen berlebih: ${arg}`);
  }
  return args;
}

function printPlan(data) {
  for (const s of data.sections) console.log(`  - ${s.section}: sekarang ${s.current} -> jadi ${s.incoming}`);
  for (const s of data.skipped || []) console.log(`  (dilewati) ${s.section}: ${s.reason}`);
}

function signedHeaders(body) {
  const timestamp = Date.now().toString();
  return { "X-Api-Timestamp": timestamp, "X-Api-Signature": signPayload(API_SECRET, timestamp, body) };
}

// Unduh keadaan sekarang ke backups/pre-restore-*.json. Melempar error kalau gagal - pemanggil harus berhenti.
async function saveCurrentStateLocally(baseUrl) {
  const res = await fetch(`${baseUrl}/api/backup`, { method: "GET", headers: signedHeaders("") });
  if (!res.ok) throw new Error(`gagal mengunduh data sekarang buat jaga-jaga (status ${res.status})`);
  // RESTORE_LOCAL_COPY_DIR hanya untuk test; default-nya folder backups/ di repo (di-gitignore).
  const backupsDir = process.env.RESTORE_LOCAL_COPY_DIR || path.join(__dirname, "..", "backups");
  fs.mkdirSync(backupsDir, { recursive: true });
  const filePath = path.join(backupsDir, `pre-restore-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(filePath, JSON.stringify(await res.json(), null, 2));
  return filePath;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.file) {
    console.error("Pakai: npm run restore-data -- <file.json> [--apply] [--sections=a,b]");
    process.exit(1);
  }
  if (!BOT_API_URL || !API_SECRET) {
    console.error("BOT_API_URL dan API_SECRET harus diisi di .env dulu (sama kayak backup-data.js - lihat .env.example).");
    process.exit(1);
  }

  let backup;
  try {
    backup = JSON.parse(fs.readFileSync(args.file, "utf-8"));
  } catch (error) {
    console.error(`Gak bisa baca ${args.file} sebagai JSON: ${error.message}`);
    process.exit(1);
  }
  if (backup && typeof backup === "object") delete backup.activeLives; // diabaikan server; membuang di sini menghemat ukuran kiriman

  const body = JSON.stringify({ backup, sections: args.sections, dryRun: !args.apply });
  if (Buffer.byteLength(body) > MAX_REQUEST_BODY_BYTES) {
    console.error(
      `File terlalu besar (${(Buffer.byteLength(body) / 1024 / 1024).toFixed(1)} MB, batas server ${MAX_REQUEST_BODY_BYTES / 1024 / 1024} MB). Pulihkan per bagian pakai --sections=...`,
    );
    process.exit(1);
  }

  const baseUrl = BOT_API_URL.replace(/\/+$/, "");
  let localCopy = null;
  if (args.apply) {
    localCopy = await saveCurrentStateLocally(baseUrl);
    console.log(`Keadaan sekarang disimpan dulu di ${localCopy}`);
  }

  const res = await fetch(`${baseUrl}/api/restore`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...signedHeaders(body) },
    body,
  });
  const data = await res.json().catch(() => null);

  if (!res.ok) {
    console.error(`Bot balikin status ${res.status}: ${data ? JSON.stringify(data, null, 2) : "(gak ada detail)"}`);
    process.exit(1);
  }

  if (data.dryRun) {
    console.log(`PRATINJAU dari ${args.file} (belum ada yang diubah):`);
    printPlan(data);
    console.log("\nKalau sudah benar, ulangi dengan --apply buat benar-benar memulihkan.");
    return;
  }

  console.log(`Dipulihkan: ${data.restored.join(", ") || "(tidak ada)"}`);
  for (const f of data.failed) console.error(`  GAGAL ${f.section}: ${f.reason}`);
  for (const s of data.skipped || []) console.log(`  (dilewati) ${s.section}: ${s.reason}`);
  console.log(`Salah file? Balikin dengan: npm run restore-data -- "${localCopy}" --apply`);
  console.log(`(Server juga menyimpan salinan sendiri: ${data.safetyCopy} di folder data bot.)`);
}

main().catch((error) => {
  console.error("Gagal memulihkan:", error.message);
  process.exit(1);
});
