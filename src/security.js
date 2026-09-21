const crypto = require("crypto");

// Request dianggap basi (ditolak) kalau timestamp-nya lebih tua/baru dari ini.
// Ini nyegah "replay attack" - orang yang nyuri 1 request yang sah terus
// ngirim ulang persis sama berkali-kali nggak akan bisa dipake lagi setelah
// jendela waktu ini lewat.
const SIGNATURE_TTL_MS = 5 * 60 * 1000;

function signPayload(secret, timestamp, body) {
  const bodyString = typeof body === "string" ? body : JSON.stringify(body || "");
  const canonical = `${timestamp}.${bodyString}`;
  return crypto.createHmac("sha256", secret).update(canonical).digest("hex");
}

// Verifikasi request masuk. Butuh header X-Api-Timestamp (ms epoch) dan
// X-Api-Signature (hex HMAC-SHA256 dari "timestamp.body" pake secret kita).
function verifySignature({ secret, timestamp, signature, body }) {
  if (!secret) return { valid: false, reason: "server_secret_not_configured" };
  if (!timestamp || !signature) return { valid: false, reason: "missing_headers" };

  const timestampMs = Number(timestamp);
  if (!Number.isFinite(timestampMs)) return { valid: false, reason: "invalid_timestamp" };

  const age = Math.abs(Date.now() - timestampMs);
  if (age > SIGNATURE_TTL_MS) return { valid: false, reason: "expired" };

  const expected = signPayload(secret, timestamp, body);

  let expectedBuf;
  let actualBuf;
  try {
    expectedBuf = Buffer.from(expected, "hex");
    actualBuf = Buffer.from(signature, "hex");
  } catch {
    return { valid: false, reason: "malformed_signature" };
  }

  // Panjang beda = pasti salah, tapi tetep dicek pake timingSafeEqual di
  // bawah buat yang panjangnya sama - biar nggak bocor info lewat waktu respons.
  if (expectedBuf.length !== actualBuf.length) return { valid: false, reason: "invalid_signature" };
  if (!crypto.timingSafeEqual(expectedBuf, actualBuf)) return { valid: false, reason: "invalid_signature" };

  return { valid: true };
}

// Batas ukuran body request - tanpa ini, `body += chunk` di bawah numpuk
// tanpa batas di memori selama koneksi TCP-nya masih ngirim data (endpoint
// ini dilindungi signature, jadi bukan celah buat orang luar sembarangan,
// tapi tetep aja gak ada alasan buat percaya body-nya "pasti kecil" tanpa
// batas eksplisit). 5MB generus banget buat payload terbesar yang beneran
// dikirim (backfill-live-history's sessions array, bisa ribuan entri ~150
// byte/entri) tapi tetep ngebatesin, bukan dibiarin tanpa batas sama sekali.
const MAX_REQUEST_BODY_BYTES = 5 * 1024 * 1024;

// Bungkus handler HTTP mentah (Node http.createServer) biar cuma jalan kalau
// request-nya punya signature yang valid. Pemanggil (client) perlu generate
// timestamp + signature pake signPayload() dengan secret yang sama.
function requireSignedRequest(secret, handler) {
  return (req, res) => {
    let body = "";
    let tooLarge = false;
    req.on("data", (chunk) => {
      if (tooLarge) return;
      body += chunk;
      if (Buffer.byteLength(body) > MAX_REQUEST_BODY_BYTES) {
        tooLarge = true;
        body = ""; // buang biar buffer-nya gak nyangkut percuma di memori
        // SENGAJA nggak req.destroy() di sini - motong socket paksa SEBELUM
        // body sisanya abis kekirim bikin klien (khususnya undici/fetch)
        // liat ini sebagai koneksi putus mentah (ECONNRESET / "fetch
        // failed"), bukan respons 413 yang rapi - klien jadi gak pernah
        // beneran "lihat" alasan penolakannya. "Connection: close" cukup:
        // Node tetap ngabisin nguras body yang lagi ngalir (di-ignore aja,
        // gak nambah ke `body` lagi jadi memori tetap kebatesin), kirim
        // 413-nya, baru nutup socket-nya SETELAH respons itu beneran
        // terkirim abis.
        res.writeHead(413, { "Content-Type": "application/json", Connection: "close" });
        res.end(JSON.stringify({ error: "Body kegedean" }));
      }
    });
    req.on("end", () => {
      if (tooLarge) return; // response udah dikirim pas nyadar kegedean, jangan diproses lagi

      const timestamp = req.headers["x-api-timestamp"];
      const signature = req.headers["x-api-signature"];
      const result = verifySignature({ secret, timestamp, signature, body });

      if (!result.valid) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized", reason: result.reason }));
        return;
      }

      handler(req, res, body);
    });
  };
}

module.exports = { signPayload, verifySignature, requireSignedRequest, SIGNATURE_TTL_MS, MAX_REQUEST_BODY_BYTES };
