// Tool CLI MANUAL - dijalanin sendiri di komputermu, BUKAN bagian dari bot
// Discord yang jalan 24 jam di Railway. Sengaja dipisah: endpoint top-gifter
// IDN butuh login akun pribadi (Authorization token yang expired ~24 jam),
// jadi nggak aman/praktis buat disimpen permanen di server yang jalan terus.
//
// Jalanin: npm run cek-gifter
// Token cuma diminta SEKALI di awal sesi - abis itu bisa dipake buat cek
// live siapa aja berkali-kali (token nggak terikat ke 1 live tertentu),
// sampai kamu keluar dari script atau tokennya kadaluarsa (otomatis
// diminta ulang kalau itu terjadi). Nggak ada yang ditulis ke file.
//
// Cara ambil Authorization & X-Api-Key dari browser:
//   1. Buka live IDN, F12 > tab Network > filter "Fetch/XHR"
//   2. Buka/refresh panel "Top Gifter" di live-nya
//   3. Cari request ke ".../gift/livestream/.../top-gifter", klik, buka tab Headers
//   4. Copy nilai header "Authorization" (termasuk kata "Bearer ") dan "X-Api-Key"
//
// Lewat argumen/env var juga masih bisa (buat non-interaktif/sekali pakai):
//   $env:IDN_AUTH_TOKEN = "Bearer eyJ..."
//   $env:IDN_X_API_KEY = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
//   node scripts/cek-top-gifter.js https://www.idn.app/jkt48_kathrina/live/yyyash-260916215907 10
//
// OPSIONAL: biar hasilnya juga bisa dijawab lewat chat Discord ("cok gifter
// <nama>"), isi BOT_API_URL & API_SECRET di file .env (BUKAN dari IDN sama
// sekali - ini URL bot kamu sendiri di Railway + secret yang sama kayak di
// server-nya). Abis itu tiap kali mode interaktif berhasil cek gifter, HASIL
// nya (bukan token IDN-nya) langsung dikirim ke bot lewat request yang
// di-sign (lihat js/security.js) - kalau dua var itu kosong, fitur ini
// cuma di-skip, semuanya tetap jalan normal kayak biasa (lokal doang).

const readline = require("readline");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const { signPayload } = require("../js/security");

const IDN_API_URL = "https://api.idn.app/graphql";
const MAX_LIVESTREAM_PAGES = 20;
const DEFAULT_TOP_N = 10;
const BOT_API_URL = process.env.BOT_API_URL || "";
const API_SECRET = process.env.API_SECRET || "";

const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  yellow: "\x1b[33m",
  gold: "\x1b[38;5;220m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  red: "\x1b[31m",
};

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

// Sama kayak fetchAllLivestreams() di js/new.js - API publik IDN, nggak
// butuh login. Dipakai buat nyusun daftar live JKT48 yang lagi aktif SEKARANG
// biar user tinggal milih, nggak perlu copy-paste link manual.
async function fetchLiveJkt48Members() {
  const query = `
    query GetLivestreams($page: Int) {
      getLivestreams(page: $page) {
        creator { username name }
        slug
        view_count
      }
    }
  `;

  const all = [];
  for (let page = 1; page <= MAX_LIVESTREAM_PAGES; page++) {
    const res = await fetch(IDN_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables: { page } }),
    });
    if (!res.ok) throw new Error(`IDN API balikin status ${res.status} (halaman ${page})`);
    const result = await res.json();
    if (result.errors) throw new Error(`GraphQL error (halaman ${page}): ${JSON.stringify(result.errors)}`);
    const lives = result?.data?.getLivestreams || [];
    if (lives.length === 0) break;
    all.push(...lives);
  }

  return all.filter((l) => typeof l?.creator?.username === "string" && l.creator.username.toLowerCase().startsWith("jkt48_"));
}

async function fetchTopGifter(slug, n, authToken, apiKey) {
  const url = `https://api.idn.app/api/v1/gift/livestream/${encodeURIComponent(slug)}/top-gifter?n=${n}`;
  const res = await fetch(url, {
    headers: { Authorization: authToken, "X-Api-Key": apiKey, "User-Agent": "Mozilla/5.0" },
  });

  const body = await res.json().catch(() => null);

  if (res.status === 401) {
    const err = new Error("401 Unauthorized - token/API key-nya udah kadaluarsa atau salah.");
    err.isAuthError = true;
    throw err;
  }
  if (!res.ok) {
    throw new Error(`API balikin status ${res.status}: ${JSON.stringify(body)}`);
  }
  return body?.data || [];
}

function formatGold(n) {
  return Number(n).toLocaleString("id-ID");
}

function medalFor(rank) {
  if (rank === 1) return "🥇";
  if (rank === 2) return "🥈";
  if (rank === 3) return "🥉";
  return `${c.dim}#${rank}${c.reset}`;
}

function printGifterResults(gifters, liveName) {
  console.log(`\n${c.bold}${c.cyan}🏆 Top Gifter - ${liveName}${c.reset}\n`);
  if (gifters.length === 0) {
    console.log(`${c.dim}Belum ada gifter buat live ini.${c.reset}\n`);
    return;
  }
  for (const g of gifters) {
    const medal = medalFor(g.rank);
    const name = g.name.padEnd(28).slice(0, 28);
    console.log(`${medal}  ${c.bold}${name}${c.reset} ${c.gold}${formatGold(g.total_gold)} IDN Gold${c.reset}`);
  }
  console.log();
}

// Ngirim HASIL cek (nama gifter + gold) ke bot Discord yang lagi jalan -
// BUKAN token IDN-nya. Pake signPayload yang sama kayak yang dipake server
// buat verifikasi (js/security.js), jadi endpoint-nya cuma nerima request
// yang beneran dari kita, bukan sembarang orang yang nebak URL bot-nya.
async function pushSnapshotToBot(username, name, gifters) {
  const bodyString = JSON.stringify({ username, name, gifters });
  const timestamp = Date.now().toString();
  const signature = signPayload(API_SECRET, timestamp, bodyString);

  const res = await fetch(`${BOT_API_URL.replace(/\/+$/, "")}/api/gifter-snapshot`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Api-Timestamp": timestamp,
      "X-Api-Signature": signature,
    },
    body: bodyString,
  });

  if (!res.ok) {
    const errBody = await res.json().catch(() => null);
    throw new Error(`Bot balikin status ${res.status}: ${errBody ? JSON.stringify(errBody) : "(gak ada detail)"}`);
  }
}

// Kalau lagi nggak ada yang live sama sekali -> null.
// Kalau cuma 1 -> langsung dipilih otomatis, nggak usah nanya.
// Kalau 2+ -> tampilin daftarnya, biar user tinggal ketik nomornya (atau
// return undefined kalau pilihannya nggak valid).
async function pickLive(prompter) {
  console.log(`${c.dim}Ngecek member JKT48 yang lagi live...${c.reset}`);
  const lives = await fetchLiveJkt48Members();

  if (lives.length === 0) return null;

  if (lives.length === 1) {
    const only = lives[0];
    console.log(`Cuma ${c.bold}${only.creator.name}${c.reset} yang lagi live, langsung dicek ya.`);
    return only;
  }

  console.log(`\n${c.bold}Member JKT48 yang lagi live sekarang:${c.reset}`);
  lives.forEach((l, i) => {
    const viewText = l.view_count != null ? ` ${c.dim}(👁️ ${l.view_count})${c.reset}` : "";
    console.log(`  ${c.cyan}${i + 1}.${c.reset} ${l.creator.name}${viewText}`);
  });

  const choice = await prompter.ask("\nMau cek top gifter live-nya siapa? (nomor): ");
  const idx = Number(choice) - 1;
  if (!Number.isInteger(idx) || idx < 0 || idx >= lives.length) {
    console.log(`${c.red}Pilihan "${choice}" nggak valid, coba lagi.${c.reset}\n`);
    return undefined;
  }
  return lives[idx];
}

async function askCredentials(prompter) {
  const authToken = await prompter.ask("Paste Authorization (termasuk kata 'Bearer '): ");
  const apiKey = await prompter.ask("Paste X-Api-Key: ");
  return { authToken, apiKey };
}

// Mode sekali-jalan (argumen dikasih langsung) - buat dipanggil non-interaktif
// / dari script lain. Nggak loop, keluar abis 1 hasil.
async function runOnce(rawSlugOrUrl, rawN) {
  const slug = extractSlug(rawSlugOrUrl);
  const n = Number(rawN) || DEFAULT_TOP_N;

  const needsPrompt = !process.env.IDN_AUTH_TOKEN || !process.env.IDN_X_API_KEY;
  const prompter = needsPrompt ? createPrompter() : null;

  const authToken = process.env.IDN_AUTH_TOKEN || (await prompter.ask("Paste Authorization (termasuk kata 'Bearer '): "));
  const apiKey = process.env.IDN_X_API_KEY || (await prompter.ask("Paste X-Api-Key: "));
  if (prompter) prompter.close();

  if (!authToken || !apiKey) {
    console.error("Authorization dan X-Api-Key wajib diisi.");
    process.exit(1);
  }

  try {
    const gifters = (await fetchTopGifter(slug, n, authToken, apiKey)).slice(0, n);
    printGifterResults(gifters, slug);
  } catch (error) {
    console.error(`${c.red}Gagal ambil data: ${error.message}${c.reset}`);
    process.exit(1);
  }
}

// Mode interaktif penuh - loop terus, token diminta sekali di awal (atau
// diulang kalau ketauan kadaluarsa), abis itu bisa cek live lain-lain
// tanpa perlu mulai ulang script.
async function runInteractive() {
  const prompter = createPrompter();
  let authToken = process.env.IDN_AUTH_TOKEN || null;
  let apiKey = process.env.IDN_X_API_KEY || null;

  console.log(`${c.bold}🏆 Cek Top Gifter IDN Live${c.reset}\n`);
  const canPushToBot = Boolean(BOT_API_URL && API_SECRET);
  if (!canPushToBot) {
    console.log(`${c.dim}(Tip: isi BOT_API_URL & API_SECRET di .env biar hasilnya juga muncul di chat Discord lewat "cok gifter <nama>")${c.reset}\n`);
  }

  if (!authToken || !apiKey) {
    const creds = await askCredentials(prompter);
    authToken = creds.authToken;
    apiKey = creds.apiKey;
  }

  while (true) {
    if (!authToken || !apiKey) {
      console.log(`${c.red}Authorization dan X-Api-Key wajib diisi.${c.reset}`);
      const creds = await askCredentials(prompter);
      authToken = creds.authToken;
      apiKey = creds.apiKey;
      continue;
    }

    let live;
    try {
      live = await pickLive(prompter);
    } catch (error) {
      console.log(`${c.red}Gagal ambil daftar live: ${error.message}${c.reset}`);
      live = null;
    }

    if (live === undefined) continue; // pilihan nomor tadi nggak valid, ulang
    if (live === null) {
      console.log(`${c.dim}Nggak ada member JKT48 yang lagi live sekarang.${c.reset}`);
      const retry = await prompter.ask("\nCoba cek lagi? (y/n): ");
      if (retry.trim().toLowerCase() !== "y") break;
      continue;
    }

    try {
      const gifters = (await fetchTopGifter(live.slug, DEFAULT_TOP_N, authToken, apiKey)).slice(0, DEFAULT_TOP_N);
      printGifterResults(gifters, live.creator.name);

      if (canPushToBot) {
        try {
          await pushSnapshotToBot(live.creator.username, live.creator.name, gifters);
          console.log(`${c.green}✓ Snapshot ke-update di Discord bot juga.${c.reset}\n`);
        } catch (pushError) {
          console.log(`${c.red}Gagal update ke Discord bot (data ini cuma keliatan di layar kamu): ${pushError.message}${c.reset}\n`);
        }
      }
    } catch (error) {
      if (error.isAuthError) {
        console.log(`${c.red}${error.message}${c.reset} Minta token baru ya.\n`);
        const creds = await askCredentials(prompter);
        authToken = creds.authToken;
        apiKey = creds.apiKey;
        continue; // langsung ulang loop, biar bisa coba live yang sama lagi
      }
      console.log(`${c.red}Gagal ambil data: ${error.message}${c.reset}`);
    }

    const again = await prompter.ask("Cek live lain? (y/n): ");
    if (again.trim().toLowerCase() !== "y") break;
    console.log();
  }

  prompter.close();
  console.log(`\n${c.dim}Sampai jumpa!${c.reset}`);
}

async function main() {
  const [, , rawSlugOrUrl, rawN] = process.argv;
  if (rawSlugOrUrl) {
    await runOnce(rawSlugOrUrl, rawN);
  } else {
    await runInteractive();
  }
}

main();
