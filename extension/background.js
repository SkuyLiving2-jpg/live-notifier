// Ekstensi ini SENGAJA sempit: cuma "nguping" (bukan ngubah/blokir) request
// yang URL-nya persis ke endpoint top-gifter IDN, ambil 2 header dari situ,
// terus kirim ke server LOKAL kita (http://localhost:47821) doang - nggak
// pernah dikirim ke server lain, nggak pernah disimpen ke chrome.storage,
// nggak baca konten/isi live atau apa pun selain 2 header itu.

const LOCAL_SERVER_CAPTURE_URL = "http://localhost:47821/api/capture";
const TOP_GIFTER_URL_PATTERN = "https://api.idn.app/api/v1/gift/livestream/*/top-gifter*";

function extractSlug(url) {
  const match = url.match(/\/livestream\/([^/?]+)\/top-gifter/);
  return match ? match[1] : null;
}

chrome.webRequest.onSendHeaders.addListener(
  (details) => {
    const headers = details.requestHeaders || [];
    const authHeader = headers.find((h) => h.name.toLowerCase() === "authorization");
    const apiKeyHeader = headers.find((h) => h.name.toLowerCase() === "x-api-key");

    if (!authHeader?.value || !apiKeyHeader?.value) return;

    const slug = extractSlug(details.url);

    fetch(LOCAL_SERVER_CAPTURE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slug,
        authToken: authHeader.value,
        apiKey: apiKeyHeader.value,
      }),
    }).catch(() => {
      // Server lokal (scripts/gifter-ui-server.js) kemungkinan lagi nggak
      // jalan - nggak apa-apa, diem aja, nggak ganggu browsing biasa.
    });
  },
  { urls: [TOP_GIFTER_URL_PATTERN] },
  ["requestHeaders", "extraHeaders"],
);
