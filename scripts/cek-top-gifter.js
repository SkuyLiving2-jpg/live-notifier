// Tool CLI MANUAL - dijalanin sendiri di komputermu, BUKAN bagian dari bot
// Discord yang jalan 24 jam di Railway. Sengaja dipisah: endpoint top-gifter
// IDN butuh login akun pribadi (Authorization token yang expired ~24 jam),
// jadi nggak aman/praktis buat disimpen permanen di server yang jalan terus.
// Nggak bisa diotomatisasi penuh (ambil token sendiri tanpa kamu login) -
// itu artinya nyimpen PASSWORD asli akun kamu, jauh lebih beresiko.
//
// Cara paling gampang: jalanin `npm run cek-gifter`, nanti ditanya satu-satu
// (link/slug live, Authorization, X-Api-Key). Nggak ada yang ditulis ke file.
//
// Cara ambil Authorization & X-Api-Key dari browser:
//   1. Buka live IDN, F12 > tab Network > filter "Fetch/XHR"
//   2. Buka/refresh panel "Top Gifter" di live-nya
//   3. Cari request ke ".../gift/livestream/.../top-gifter", klik, buka tab Headers
//   4. Copy nilai header "Authorization" (termasuk kata "Bearer ") dan "X-Api-Key"
//
// Lewat argumen/env var juga masih bisa (buat yang lebih suka non-interaktif):
//   $env:IDN_AUTH_TOKEN = "Bearer eyJ..."
//   $env:IDN_X_API_KEY = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
//   node scripts/cek-top-gifter.js https://www.idn.app/jkt48_kathrina/live/yyyash-260916215907 10

const readline = require("readline");

function extractSlug(input) {
  const trimmed = (input || "").trim();
  const match = trimmed.match(/\/live\/([^/?#]+)/);
  return match ? match[1] : trimmed;
}

// rl.question() biasa NGGAK reliable buat nanya berturut-turut kalau semua
// jawaban udah kebuffer duluan di stdin (misal input di-pipe) - baris ke-2/3
// bisa ke-drop diem-diem karena race antara event "line" dan microtask
// continuation-nya. Jadi dipakai queue manual: baris yang masuk sebelum
// ada yang nanya disimpen di buffer, baris yang ditunggu abis nanya
// ditangani lewat waiter.
function createPrompter() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  const lineBuffer = [];
  const waiters = [];
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (waiters.length > 0) waiters.shift()(trimmed);
    else lineBuffer.push(trimmed);
  });
  return {
    ask(question) {
      process.stdout.write(question);
      if (lineBuffer.length > 0) return Promise.resolve(lineBuffer.shift());
      return new Promise((resolve) => waiters.push(resolve));
    },
    close() {
      rl.close();
    },
  };
}

async function fetchTopGifter(slug, n, authToken, apiKey) {
  const url = `https://api.idn.app/api/v1/gift/livestream/${encodeURIComponent(slug)}/top-gifter?n=${n}`;
  const res = await fetch(url, {
    headers: {
      Authorization: authToken,
      "X-Api-Key": apiKey,
      "User-Agent": "Mozilla/5.0",
    },
  });

  const body = await res.json().catch(() => null);

  if (res.status === 401) {
    throw new Error(
      "401 Unauthorized - token/API key-nya udah kadaluarsa atau salah. Ambil ulang dari browser (lihat instruksi di atas file ini).",
    );
  }
  if (!res.ok) {
    throw new Error(`API balikin status ${res.status}: ${JSON.stringify(body)}`);
  }
  return body?.data || [];
}

function formatGold(n) {
  return n.toLocaleString("id-ID");
}

async function main() {
  const [, , rawSlugOrUrl, rawN] = process.argv;
  const needsPrompt = !rawSlugOrUrl || !process.env.IDN_AUTH_TOKEN || !process.env.IDN_X_API_KEY;
  const prompter = needsPrompt ? createPrompter() : null;

  const slugInput = rawSlugOrUrl || (await prompter.ask("Link/slug live IDN: "));
  if (!slugInput) {
    console.error("Link/slug live nggak boleh kosong.");
    if (prompter) prompter.close();
    process.exit(1);
  }

  const authToken = process.env.IDN_AUTH_TOKEN || (await prompter.ask("Paste Authorization (termasuk kata 'Bearer '): "));
  if (!authToken) {
    console.error("Authorization nggak boleh kosong.");
    if (prompter) prompter.close();
    process.exit(1);
  }

  const apiKey = process.env.IDN_X_API_KEY || (await prompter.ask("Paste X-Api-Key: "));
  if (prompter) prompter.close();
  if (!apiKey) {
    console.error("X-Api-Key nggak boleh kosong.");
    process.exit(1);
  }

  const slug = extractSlug(slugInput);
  const n = Number(rawN) || 10;

  try {
    // Parameter "n" di API-nya ternyata nggak konsisten ngebatesin jumlah
    // hasil (dicoba n=5, tetap balikin semua) - jadi dipotong manual di sini.
    const allGifters = await fetchTopGifter(slug, n, authToken, apiKey);
    const gifters = allGifters.slice(0, n);
    if (gifters.length === 0) {
      console.log(`Belum ada gifter buat live "${slug}".`);
      return;
    }

    console.log(`\n🏆 Top ${gifters.length} Gifter - ${slug}\n`);
    for (const g of gifters) {
      console.log(`${g.rank}. ${g.name} - ${formatGold(g.total_gold)} IDN Gold`);
    }
    console.log();
  } catch (error) {
    console.error("Gagal ambil data:", error.message);
    process.exit(1);
  }
}

main();
