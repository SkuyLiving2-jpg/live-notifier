require("dotenv").config();

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const IDN_API_URL = "https://api.idn.app/graphql";
const POLL_INTERVAL_MS = 30000;

if (!DISCORD_WEBHOOK_URL) {
  console.error("DISCORD_WEBHOOK_URL belum diset di environment variable. Bot berhenti.");
  process.exit(1);
}

// Kalau ada member JKT48 yang nama/bio IDN-nya kebetulan nggak nyantumin
// kata "JKT48", tambahin username IDN-nya di sini biar tetap kedeteksi.
const JKT48_USERNAME_WHITELIST = [
  // "username_idn_member",
];

// Cache buat nyimpen member yang lagi live: username -> { name, username, slug }
const activeLives = new Map();

function isJkt48Member(creator) {
  if (!creator) return false;
  if (JKT48_USERNAME_WHITELIST.includes(creator.username)) return true;

  const text = `${creator.name || ""} ${creator.bio_description || ""}`.toLowerCase();
  return text.includes("jkt48");
}

async function checkLiveMembers() {
  const query = `
    query GetLivestreams {
      getLivestreams {
        creator {
          username
          name
          bio_description
        }
        title
        slug
      }
    }
  `;

  try {
    const response = await fetch(IDN_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query }),
    });

    if (!response.ok) {
      throw new Error(`IDN API balikin status ${response.status}`);
    }

    const result = await response.json();

    if (result.errors) {
      throw new Error(`GraphQL error: ${JSON.stringify(result.errors)}`);
    }

    const currentLives = result?.data?.getLivestreams || [];
    const currentLiveUsernames = new Set();

    for (const live of currentLives) {
      const username = live?.creator?.username;
      if (!username) continue; // skip entry yang datanya nggak lengkap
      if (!isJkt48Member(live.creator)) continue; // cuma peduli member JKT48

      currentLiveUsernames.add(username);

      // Kirim notif cuma kalo member baru mulai live
      if (!activeLives.has(username)) {
        const terkirim = await sendDiscordNotif(live.creator.name, live.creator.username, live.slug, "start");
        if (terkirim) {
          activeLives.set(username, { name: live.creator.name, username, slug: live.slug });
        }
        // kalau gagal kirim, username sengaja nggak ditambahin
        // biar dicoba lagi di polling berikutnya
      }
    }

    // Kirim notif "sudah selesai" + bersihkan cache kalau member udah selesai live
    for (const [username, memberData] of activeLives) {
      if (!currentLiveUsernames.has(username)) {
        const terkirim = await sendDiscordNotif(memberData.name, memberData.username, memberData.slug, "end");
        if (terkirim) {
          activeLives.delete(username);
        }
        // kalau gagal kirim, sengaja nggak dihapus dari cache
        // biar dicoba lagi di polling berikutnya
      }
    }
  } catch (error) {
    console.error("Gagal ngecek IDN Live:", error.message);
  }
}

async function sendDiscordNotif(memberName, username, slug, status = "start") {
  const liveUrl = `https://www.idn.app/${username}/live/${slug}`;
  const payload =
    status === "end"
      ? { content: `✅ **${memberName}** udah selesai live di IDN Live.` }
      : { content: `🚨 **${memberName}** lagi live di IDN Live!\nNonton di sini: ${liveUrl}` };

  try {
    const response = await fetch(DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`Discord webhook balikin status ${response.status}`);
    }

    console.log(`Notif ${status} terkirim untuk ${memberName}`);
    return true;
  } catch (error) {
    console.error("Gagal ngirim notif ke Discord:", error.message);
    return false;
  }
}

// Jalankan polling tiap 30 detik (self-scheduling biar nggak tumpang tindih
// kalau checkLiveMembers kebetulan lebih lambat dari interval-nya)
async function pollLoop() {
  await checkLiveMembers();
  setTimeout(pollLoop, POLL_INTERVAL_MS);
}

console.log("Bot notifikasi IDN Live jalan...");
pollLoop();
