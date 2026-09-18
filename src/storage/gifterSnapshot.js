const path = require("path");
const { CACHE_DIR } = require("../config");
const { createJsonStore } = require("./jsonStore");
const { matchesNameFragment } = require("../utils");

// Snapshot top-gifter: username -> { name, gifters, checkedAt }. Bot ini
// SENDIRI nggak pernah manggil API top-gifter IDN (itu butuh login pribadi,
// nggak cocok disimpen di server 24/7 - lihat scripts/cek-top-gifter.js).
// File ini isinya cuma DIISI dari luar, lewat endpoint /api/gifter-snapshot
// (POST, butuh signature) yang dipanggil scripts/cek-top-gifter.js abis
// kamu cek manual di komputer sendiri. Jadi yang nyebrang ke bot cuma HASIL
// datanya (nama gifter + gold), kredensialnya sendiri nggak pernah ke sini.
const GIFTER_SNAPSHOT_FILE = path.join(CACHE_DIR, "gifter-snapshot.json");
const store = createJsonStore(GIFTER_SNAPSHOT_FILE, () => ({ members: {} }), { errorLabel: "snapshot gifter" });

function loadGifterSnapshot() {
  const data = store.load();
  data.members = data.members || {};
  return data;
}

function saveGifterSnapshot(snapshot) {
  store.save(snapshot);
}

// Sama logikanya kayak findMemberByNameFragment, tapi nyariin di snapshot
// gifter (bukan di activeLives) - member yang MASIH live maupun yang udah
// kelar tetap bisa ketemu, soalnya ini data historis/snapshot.
function findGifterSnapshotByNameFragment(fragment) {
  const needle = (fragment || "").trim().toLowerCase();
  if (!needle) return null;

  const { members } = loadGifterSnapshot();
  for (const [username, data] of Object.entries(members)) {
    if (!data?.name) continue;
    const givenName = data.name.split(/[\s|]+/)[0].toLowerCase();
    if (matchesNameFragment(needle, givenName)) {
      return { username, ...data };
    }
  }
  return null;
}

// Dipake buat ngisi dropdown tombol opsi 9 - data gifter itu SNAPSHOT yang
// independen dari status live (beda dari opsi 4 yang emang harus dari
// activeLives), jadi daftar pilihannya juga harus dari member yang PUNYA
// data snapshot, bukan dari member yang lagi live. Diurutkan dari yang
// paling baru dicek, biar data terbaru nongol duluan di dropdown.
function getSortedGifterSnapshotMembers() {
  const { members } = loadGifterSnapshot();
  return Object.entries(members)
    .map(([username, data]) => ({ username, name: data.name, checkedAt: data.checkedAt }))
    .sort((a, b) => new Date(b.checkedAt) - new Date(a.checkedAt));
}

module.exports = {
  loadGifterSnapshot,
  saveGifterSnapshot,
  findGifterSnapshotByNameFragment,
  getSortedGifterSnapshotMembers,
};
