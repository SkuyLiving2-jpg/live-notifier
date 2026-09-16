// Tool CLI MANUAL - dijalanin sendiri di komputermu, BUKAN bagian dari bot
// Discord yang jalan 24 jam di Railway. Sengaja dipisah: endpoint top-gifter
// IDN butuh login akun pribadi (Authorization token yang expired ~24 jam),
// jadi nggak aman/praktis buat disimpen permanen di server yang jalan terus.
//
// Cara pakai:
//   1. Buka live IDN di browser, F12 > tab Network > filter "Fetch/XHR"
//   2. Buka/refresh panel "Top Gifter" di live-nya
//   3. Cari request ke ".../gift/livestream/.../top-gifter", klik, buka tab Headers
//   4. Copy nilai header "Authorization" (termasuk kata "Bearer ") dan "X-Api-Key"
//   5. Set sebagai environment variable di sesi terminal ini (contoh di bawah)
//   6. Jalankan: node scripts/cek-top-gifter.js <slug-atau-link-live> [jumlah]
//
// PowerShell:
//   $env:IDN_AUTH_TOKEN = "Bearer eyJ..."
//   $env:IDN_X_API_KEY = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
//   node scripts/cek-top-gifter.js https://www.idn.app/jkt48_kathrina/live/yyyash-260916215907 10
//
// Git Bash:
//   export IDN_AUTH_TOKEN="Bearer eyJ..."
//   export IDN_X_API_KEY="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
//   node scripts/cek-top-gifter.js yyyash-260916215907 10
//
// Token-nya cuma dibaca dari environment variable sesi ini doang - nggak
// pernah ditulis ke file apa pun. Begitu kamu tutup terminal-nya, ilang.

function extractSlug(input) {
  const trimmed = (input || "").trim();
  const match = trimmed.match(/\/live\/([^/?#]+)/);
  return match ? match[1] : trimmed;
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
  const authToken = process.env.IDN_AUTH_TOKEN;
  const apiKey = process.env.IDN_X_API_KEY;

  if (!rawSlugOrUrl) {
    console.error("Pemakaian: node scripts/cek-top-gifter.js <slug-atau-link-live> [jumlah]");
    process.exit(1);
  }

  if (!authToken || !apiKey) {
    console.error(
      "IDN_AUTH_TOKEN dan/atau IDN_X_API_KEY belum diset di environment variable sesi ini.\n" +
        "Lihat komentar instruksi di bagian atas scripts/cek-top-gifter.js buat cara ambilnya dari browser.",
    );
    process.exit(1);
  }

  const slug = extractSlug(rawSlugOrUrl);
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
