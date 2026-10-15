// Playground "input vc": halaman web lokal untuk mencoba fitur rangkuman VC tanpa membuka DM Discord sungguhan.
//   npm run vc-playground            (lalu buka http://localhost:4848)
//   npm run vc-playground -- --port 5000
// Server ini HANYA mendengarkan 127.0.0.1, memakai folder data sementara, tidak login ke Discord, dan memblokir semua
// jaringan (lihat safeEnv.js + engine.js). Yang dijalankan adalah kode asli bot; yang palsu cuma lapisan Discord-nya.

const engine = require("./engine");
const http = require("http");
const fs = require("fs");
const path = require("path");

const PUBLIC_DIR = path.join(__dirname, "public");
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
const MAX_BODY_BYTES = 200_000;

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("body terlalu besar"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(Object.assign(new Error("body bukan JSON yang valid"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

// Aksi POST -> fungsi engine. Semuanya membalas state terbaru supaya UI cukup merender ulang.
const ACTIONS = {
  "/api/send": async (b) => ({ result: await engine.sendText(b) }),
  "/api/interact": async (b) => ({ result: await engine.interact(b) }),
  "/api/delete-message": async (b) => ({ result: await engine.deleteMessage(b) }),
  "/api/config": async (b) => ({ result: await engine.setConfig(b) }),
  "/api/clock": async (b) => ({ result: await engine.advanceClock(b.minutes) }),
  "/api/seed": async (b) => ({ result: await engine.seed({ many: Boolean(b.many) }) }),
  "/api/reset": async () => ({ result: await engine.reset() }),
};

function serveStatic(pathname, res) {
  const name = pathname === "/" ? "index.html" : path.basename(pathname);
  const file = path.join(PUBLIC_DIR, name);
  const type = MIME[path.extname(name)];
  if (!type || !file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file)) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("tidak ditemukan");
    return;
  }
  res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
  fs.createReadStream(file).pipe(res);
}

// Perlindungan DNS-rebinding / halaman lain yang menembak localhost: Host dan Origin harus localhost/127.0.0.1.
function isLocalHost(value) {
  return /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(value || "");
}

function createServer() {
  return http.createServer(async (req, res) => {
    try {
      if (!isLocalHost(req.headers.host)) return sendJson(res, 403, { error: "Host tidak diizinkan" });
      const origin = req.headers.origin;
      if (origin && !isLocalHost(origin.replace(/^https?:\/\//, ""))) return sendJson(res, 403, { error: "Origin tidak diizinkan" });
      const pathname = (req.url || "/").split("?")[0];

      res.setHeader("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'");
      res.setHeader("X-Content-Type-Options", "nosniff");

      if (req.method === "GET" && pathname === "/api/state") return sendJson(res, 200, { state: engine.getState() });
      if (req.method === "POST" && ACTIONS[pathname]) {
        const body = await readBody(req);
        const extra = await ACTIONS[pathname](body);
        return sendJson(res, 200, { ...extra, state: engine.getState() });
      }
      if (req.method === "GET") return serveStatic(pathname, res);
      return sendJson(res, 405, { error: "method tidak didukung" });
    } catch (error) {
      return sendJson(res, error.status || 400, { error: error.message });
    }
  });
}

function main() {
  const portArg = process.argv.indexOf("--port");
  const port = portArg !== -1 ? Number(process.argv[portArg + 1]) : Number(process.env.PLAYGROUND_PORT) || 4848;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error("Port tidak valid. Contoh: npm run vc-playground -- --port 5000");
    process.exit(1);
  }
  const server = createServer();
  server.on("error", (error) => {
    console.error(error.code === "EADDRINUSE" ? `Port ${port} sedang dipakai. Coba: npm run vc-playground -- --port ${port + 1}` : error.message);
    process.exit(1);
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(`\nVC Playground jalan di http://localhost:${port}`);
    console.log("Aman: tidak login ke Discord, jaringan diblokir, data di folder sementara (hilang saat dihentikan). Tekan Ctrl+C untuk berhenti.\n");
  });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => process.exit(0));
}

if (require.main === module) main();

module.exports = { createServer, isLocalHost };
