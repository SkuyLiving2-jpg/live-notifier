// Server HTTP LOKAL doang (bind ke 127.0.0.1, nggak bisa diakses dari luar
// komputer ini) buat nyajiin UI browser dari scripts/gifter-ui.html, dan
// jadi jembatan ("proxy") ke API IDN Live biar browser nggak kena masalah
// CORS. BUKAN bagian dari bot Discord yang jalan di Railway - jalan sendiri
// pas kamu jalanin, mati begitu jendela terminal-nya ditutup.
//
// Authorization & X-Api-Key yang kamu isi manual di form (atau yang
// ke-capture otomatis dari extension/) CUMA disimpen di VARIABEL DI MEMORI
// proses ini - nggak pernah ditulis ke file. Begitu jendela terminal ini
// ditutup, semuanya ilang total.

const http = require("http");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");

const IDN_API_URL = "https://api.idn.app/graphql";
const MAX_LIVESTREAM_PAGES = 20;
const PORT = 47821;

const HTML_PAGE = fs.readFileSync(path.join(__dirname, "gifter-ui.html"), "utf-8");

// Diisi sama endpoint /api/capture (dipanggil extension/ tiap nyomot
// header baru). Di memori doang, nggak pernah disave ke disk.
let capturedCredential = null; // { authToken, apiKey, capturedAt }

// Sama kayak fetchAllLivestreams() di js/new.js - API publik, nggak butuh login.
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
    throw new Error("401 Unauthorized - token/API key-nya udah kadaluarsa atau salah. Ambil ulang dari browser.");
  }
  if (!res.ok) {
    throw new Error(`API balikin status ${res.status}: ${JSON.stringify(body)}`);
  }
  return body?.data || [];
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    // Extension service worker origin-nya "chrome-extension://..." (beda
    // dari "http://localhost:47821"), jadi butuh CORS biar fetch-nya nggak
    // diblokir. Server ini cuma bind ke 127.0.0.1 (nggak bisa diakses dari
    // luar komputer ini sama sekali), jadi "*" di sini aman.
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(data));
}

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") {
    // Preflight CORS dari extension.
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return;
  }

  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(HTML_PAGE);
    return;
  }

  if (req.method === "GET" && req.url === "/api/lives") {
    fetchLiveJkt48Members()
      .then((lives) =>
        sendJson(
          res,
          200,
          lives.map((l) => ({ name: l.creator.name, username: l.creator.username, slug: l.slug, viewCount: l.view_count })),
        ),
      )
      .catch((error) => sendJson(res, 502, { error: error.message }));
    return;
  }

  // Dipanggil sama extension/ (background.js) tiap dia nyomot header baru
  // dari request Top Gifter yang beneran dikirim browser kamu.
  if (req.method === "POST" && req.url === "/api/capture") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch (error) {
        sendJson(res, 400, { error: "Body nggak valid." });
        return;
      }

      const { authToken, apiKey } = parsed;
      if (!authToken || !apiKey) {
        sendJson(res, 400, { error: "authToken dan apiKey wajib diisi." });
        return;
      }

      capturedCredential = { authToken, apiKey, capturedAt: Date.now() };
      console.log(`Token ke-capture otomatis dari extension (${new Date().toLocaleTimeString("id-ID")})`);
      sendJson(res, 200, { ok: true });
    });
    return;
  }

  // Dicek sama UI tiap user milih member - biar tau apa perlu nampilin
  // form paste manual atau langsung tembak /api/top-gifter otomatis.
  if (req.method === "GET" && req.url === "/api/captured") {
    if (!capturedCredential) {
      sendJson(res, 200, { available: false });
      return;
    }
    sendJson(res, 200, {
      available: true,
      ageSeconds: Math.round((Date.now() - capturedCredential.capturedAt) / 1000),
    });
    return;
  }

  if (req.method === "POST" && req.url === "/api/top-gifter") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch (error) {
        sendJson(res, 400, { error: "Body request nggak valid." });
        return;
      }

      const { slug, n } = parsed;
      // Kalau authToken/apiKey nggak dikirim dari form manual, coba pakai
      // yang udah ke-capture otomatis dari extension.
      const authToken = parsed.authToken || capturedCredential?.authToken;
      const apiKey = parsed.apiKey || capturedCredential?.apiKey;

      if (!slug || !authToken || !apiKey) {
        sendJson(res, 400, { error: "slug, authToken, dan apiKey wajib diisi." });
        return;
      }

      const limit = Number(n) || 15;
      fetchTopGifter(slug, limit, authToken, apiKey)
        .then((gifters) => sendJson(res, 200, { data: gifters.slice(0, limit) }))
        .catch((error) => sendJson(res, 502, { error: error.message }));
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
});

server.listen(PORT, "127.0.0.1", () => {
  const url = `http://localhost:${PORT}`;
  console.log(`UI Cek Top Gifter jalan di ${url}`);
  console.log("Kalau browser nggak otomatis kebuka, buka link di atas manual.");
  console.log("Tutup jendela ini (atau Ctrl+C) kalau udah selesai make.\n");

  const openCommand =
    process.platform === "win32" ? `start "" "${url}"` : process.platform === "darwin" ? `open "${url}"` : `xdg-open "${url}"`;
  exec(openCommand, (error) => {
    if (error) console.log("Gagal buka browser otomatis, buka link di atas manual ya.");
  });
});
