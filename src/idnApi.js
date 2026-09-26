const { IDN_API_URL, JKT48_USERNAME_WHITELIST } = require("./config");

function isJkt48Member(creator) {
  if (!creator) return false;
  if (JKT48_USERNAME_WHITELIST.includes(creator.username)) return true;

  // Semua akun IDN resmi member JKT48 konsisten pakai username berawalan
  // "jkt48_" (misal jkt48_levi, jkt48_nala). Sebelumnya kode ini nge-cek
  // apakah kata "jkt48" muncul di bio profil - itu rapuh, soalnya akun fans
  // atau reaction channel juga sering nyebut "JKT48" di bio mereka padahal
  // bukan member asli, jadi nembus filter dan ikut kekirim notifikasi.
  return typeof creator.username === "string" && creator.username.toLowerCase().startsWith("jkt48_");
}

// getLivestreams IDN itu di-paging (halaman 1 cuma nampilin ~12 live
// teratas). Kalo cuma ambil halaman pertama, live yang penontonnya sedikit
// (biasanya yang lebih baru mulai) bisa nangkring di halaman 2+ dan nggak
// pernah kedeteksi. Jadi kita ambil terus tiap halaman sampai kosong.
const MAX_LIVESTREAM_PAGES = 20; // jaga-jaga biar nggak infinite loop

async function fetchAllLivestreams() {
  const query = `
    query GetLivestreams($page: Int) {
      getLivestreams(page: $page) {
        creator {
          username
          name
          bio_description
        }
        title
        slug
        live_at
        view_count
        image_url
      }
    }
  `;

  const allLives = [];

  for (let page = 1; page <= MAX_LIVESTREAM_PAGES; page++) {
    const response = await fetch(IDN_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables: { page } }),
    });

    if (!response.ok) {
      throw new Error(`IDN API balikin status ${response.status} (halaman ${page})`);
    }

    const result = await response.json();

    if (result.errors) {
      throw new Error(`GraphQL error (halaman ${page}): ${JSON.stringify(result.errors)}`);
    }

    const lives = result?.data?.getLivestreams || [];
    if (lives.length === 0) break; // udah abis halamannya

    allLives.push(...lives);
  }

  return allLives;
}

// Profil publik SATU member by username - dipake buat narik foto profilnya
// (`avatar`, field ini beneran ada di skema IDN, dicek langsung lewat
// introspeksi manual soalnya gak didokumentasiin di mana pun) buat fitur
// "cok bandingin <member> vs <member>" (chat/replies.js's replyCompareMembers,
// §10's forty-second item) - beda dari fetchAllLivestreams yang narik
// SEMUA yang lagi live, ini query `getPublicProfileByUsername` yang IDN
// sediain buat SATU akun spesifik, jalan independen dari status live-nya
// sekarang (member yang lagi nggak live tetep bisa dicari profilnya).
const PROFILE_FETCH_TIMEOUT_MS = 2000;

async function fetchPublicProfileByUsername(username) {
  const query = `
    query GetPublicProfile($username: String!) {
      getPublicProfileByUsername(username: $username) {
        username
        name
        avatar
      }
    }
  `;

  // Timeout pendek: fungsi ini dipanggil di tengah interaksi tombol/modal
  // Discord (chat/compareFlow.js), yang WAJIB dibales dalam ~3 detik - IDN
  // yang lagi lemot gak boleh bikin interaksinya kadaluarsa.
  const response = await fetch(IDN_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables: { username } }),
    signal: AbortSignal.timeout(PROFILE_FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`IDN API balikin status ${response.status}`);
  }

  const result = await response.json();
  if (result.errors) {
    // Dicek langsung ke API asli: username yang gak ada BUKAN balikin
    // `data: null`, tapi error GraphQL "User Not found" - itu kasus normal
    // (member/nama yang gak ada), bukan gangguan, jadi dianggap "gak ketemu".
    const onlyNotFound = result.errors.every((e) => /not found/i.test(e?.message || ""));
    if (onlyNotFound) return null;
    throw new Error(`GraphQL error: ${JSON.stringify(result.errors)}`);
  }

  return result?.data?.getPublicProfileByUsername || null;
}

module.exports = { isJkt48Member, fetchAllLivestreams, fetchPublicProfileByUsername };
