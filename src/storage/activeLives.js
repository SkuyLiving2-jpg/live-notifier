const fs = require("fs");
const path = require("path");
const { CACHE_DIR } = require("../config");
const { matchesNameFragment } = require("../utils");

// Cache buat nyimpen member yang lagi live: username -> { name, username, slug, ... }
// Disimpan juga ke file (CACHE_FILE) biar kalau proses restart (crash, atau
// container-nya di-restart), bot nggak ngirim ulang notif "mulai live" buat
// member yang sebenernya udah live dari sebelum restart.
//
// Beda dari domain storage lain (yang lazy-load lewat jsonStore factory),
// activeLives ini di-load SEKALI aja pas modul ini pertama kali di-require,
// terus Map-nya dipegang sebagai satu-satunya sumber kebenaran in-memory
// yang dimutasi langsung sama monitor.js - bukan fungsi load() yang
// dipanggil berulang, jadi gak cocok pakai jsonStore.
const CACHE_FILE = path.join(CACHE_DIR, "active-lives-cache.json");

function loadActiveLives() {
  try {
    const raw = fs.readFileSync(CACHE_FILE, "utf-8");
    return new Map(Object.entries(JSON.parse(raw)));
  } catch (error) {
    return new Map();
  }
}

const activeLives = loadActiveLives();

function saveActiveLives() {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(Object.fromEntries(activeLives), null, 2));
  } catch (error) {
    console.error("Gagal nyimpen cache ke file:", error.message);
  }
}

function getSortedActiveLives() {
  return [...activeLives.values()].sort((a, b) => new Date(a.liveAt) - new Date(b.liveAt));
}

// Nama akun IDN biasanya "Nala JKT48" atau "Piya | Karafuru Idol Group" -
// yang orang beneran ketik biasanya cuma nama depannya ("Nala", "Piya"),
// bukan nama lengkap persis. Jadi cocokin ke kata pertama dari nama-nya,
// bukan nyari nama lengkap sebagai substring persis (itu penyebab bug-nya).
function findMemberByNameFragment(fragment) {
  const needle = (fragment || "").trim().toLowerCase();
  if (!needle) return null;

  for (const entry of activeLives.values()) {
    if (!entry.name) continue;
    const givenName = entry.name.split(/[\s|]+/)[0].toLowerCase();
    if (matchesNameFragment(needle, givenName)) {
      return entry;
    }
  }
  return null;
}

module.exports = { activeLives, saveActiveLives, getSortedActiveLives, findMemberByNameFragment };
