const { ActivityType } = require("discord.js");
const { getDiscordClient } = require("./discordClient");
const { getSortedActiveLives } = require("./storage/activeLives");

// Status bot di daftar anggota Discord: "Watching 🔴 Nala, Levi (live)" saat ada yang
// live, "Watching jadwal live JKT48" saat sepi. Kelihatan sekilas tanpa buka channel.
// Hanya dikirim ke Discord kalau teksnya BERUBAH (atau sudah lama tidak disegarkan -
// presence bisa hilang setelah koneksi gateway putus-sambung), jadi aman dipanggil
// tiap siklus polling. Gagal/tanpa client = diam, gak pernah melempar.
const MAX_NAMES = 3;
const MAX_TEXT_LENGTH = 128; // batas Discord buat nama aktivitas
const IDLE_TEXT = "jadwal live JKT48";
const REFRESH_INTERVAL_MS = 30 * 60 * 1000;

let lastText = null;
let lastSetAt = 0;

const givenName = (name) => String(name || "").split(/[\s|]+/)[0] || "member";

function buildPresenceText(names) {
  if (names.length === 0) return IDLE_TEXT;
  const shown = names.slice(0, MAX_NAMES).map(givenName);
  const more = names.length - shown.length;
  const text = `🔴 ${shown.join(", ")}${more > 0 ? ` +${more}` : ""} (live)`;
  return text.length > MAX_TEXT_LENGTH ? `${text.slice(0, MAX_TEXT_LENGTH - 1)}…` : text;
}

// Balikin true kalau presence BENAR-BENAR dikirim ke Discord.
async function updateBotPresence(now = Date.now()) {
  const client = getDiscordClient();
  if (!client?.user || typeof client.user.setPresence !== "function") return false; // belum login/ready: coba lagi siklus berikutnya

  const text = buildPresenceText(getSortedActiveLives().map((entry) => entry.name));
  if (text === lastText && now - lastSetAt < REFRESH_INTERVAL_MS) return false;

  try {
    client.user.setPresence({ status: "online", activities: [{ name: text, type: ActivityType.Watching }] });
    lastText = text;
    lastSetAt = now;
    return true;
  } catch (error) {
    console.error("Gagal ngatur status bot (nggak fatal):", error.message);
    return false;
  }
}

// Buat test: reset state modul.
function resetPresenceState() {
  lastText = null;
  lastSetAt = 0;
}

module.exports = { updateBotPresence, buildPresenceText, resetPresenceState, IDLE_TEXT };
