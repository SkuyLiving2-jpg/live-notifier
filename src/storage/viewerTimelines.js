const path = require("path");
const { CACHE_DIR } = require("../config");
const { createJsonStore } = require("./jsonStore");
const { MAX_STORED_SAMPLES, downsample, cleanSamples } = require("../viewerTimeline");

// Kurva penonton sesi live yang SUDAH SELESAI (monitor.js ngumpulin sampelnya
// selama live di activeLives, lihat viewerTimeline.js). Bentuk:
//   { [username]: [ { startedAtUnix, endedAtUnix, samples: [[unixDetik, penonton], ...] }, ... ] }
// urut dari yang paling lama; per member cuma MAX_SESSIONS_PER_MEMBER terakhir dan
// cuma yang lebih muda dari RETENTION_DAYS (sama dengan arsip rekap).
const VIEWER_TIMELINES_FILE = path.join(CACHE_DIR, "viewer-timelines.json");
const store = createJsonStore(VIEWER_TIMELINES_FILE, {}, { errorLabel: "kurva penonton" });

const MAX_SESSIONS_PER_MEMBER = 10;
const RETENTION_DAYS = 35;
const MIN_SAMPLES_TO_KEEP = 3; // di bawah ini bukan kurva (live sangat singkat), gak usah disimpen

function loadViewerTimelines() {
  const raw = store.load();
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
}

function listFor(all, username) {
  return Object.prototype.hasOwnProperty.call(all, username) && Array.isArray(all[username]) ? all[username] : [];
}

// Dipanggil monitor.js pas sesi selesai (lolos validasi durasi). `entry` = data
// activeLives member itu (butuh viewSamples + liveAt).
function recordViewerTimeline(username, entry, endedAtDate = new Date()) {
  const samples = cleanSamples(entry?.viewSamples);
  if (samples.length < MIN_SAMPLES_TO_KEEP || !entry?.liveAt) return false;

  const all = loadViewerTimelines();
  const cutoffUnix = Math.floor(Date.now() / 1000) - RETENTION_DAYS * 24 * 60 * 60;
  const kept = listFor(all, username).filter((s) => s.endedAtUnix >= cutoffUnix);
  kept.push({
    startedAtUnix: Math.floor(new Date(entry.liveAt).getTime() / 1000),
    endedAtUnix: Math.floor(endedAtDate.getTime() / 1000),
    samples: downsample(samples, MAX_STORED_SAMPLES),
  });
  all[username] = kept.slice(-MAX_SESSIONS_PER_MEMBER);
  store.save(all);
  return true;
}

function getViewerTimelines(username) {
  return listFor(loadViewerTimelines(), username);
}

module.exports = { loadViewerTimelines, recordViewerTimeline, getViewerTimelines, MAX_SESSIONS_PER_MEMBER };
