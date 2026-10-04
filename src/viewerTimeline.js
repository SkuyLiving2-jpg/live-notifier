// Kurva jumlah penonton SELAMA satu sesi live. monitor.js sudah membaca view_count
// tiap siklus polling (default 20 detik) tapi dulu cuma menyimpan angka puncaknya -
// kurva lengkapnya hilang. Modul ini murni (tanpa I/O): menambah sampel ke entry
// activeLives, memadatkan, dan menghitung statistik buat grafik/ringkasan.
//
// Sampel = [unixDetik, jumlahPenonton], urut waktu.

// Batas sampel selama live berjalan (entry activeLives ikut ditulis ke disk tiap
// siklus, jadi ukurannya dijaga kecil). Lewat batas ini sampel dipadatkan jadi
// separuh (merata, titik pertama & terakhir tetap) - live yang sangat panjang
// resolusinya turun, tapi bentuk kurvanya tetap utuh.
const MAX_LIVE_SAMPLES = 240;
// Batas sampel yang disimpan permanen per sesi yang sudah selesai.
const MAX_STORED_SAMPLES = 120;
// Dua sampel yang terlalu rapat (mis. dua siklus berurutan cepat) tidak berguna.
const MIN_SAMPLE_GAP_SEC = 5;

// Ambil `max` titik secara merata dari `samples`, titik pertama & terakhir selalu ikut.
function downsample(samples, max) {
  if (samples.length <= max) return samples;
  const step = (samples.length - 1) / (max - 1);
  const out = [];
  for (let i = 0; i < max; i++) out.push(samples[Math.round(i * step)]);
  return out;
}

// Tambah satu sampel ke entry.viewSamples (dibuat kalau belum ada). Nilai bukan
// angka (IDN kadang kirim null) dilewati.
function addViewerSample(entry, viewCount, nowSec = Math.floor(Date.now() / 1000)) {
  if (typeof viewCount !== "number" || !Number.isFinite(viewCount) || viewCount < 0) return;
  if (!Array.isArray(entry.viewSamples)) entry.viewSamples = [];
  const last = entry.viewSamples[entry.viewSamples.length - 1];
  if (last && nowSec - last[0] < MIN_SAMPLE_GAP_SEC) return;
  entry.viewSamples.push([nowSec, viewCount]);
  if (entry.viewSamples.length > MAX_LIVE_SAMPLES) entry.viewSamples = downsample(entry.viewSamples, MAX_LIVE_SAMPLES / 2);
}

// Sampel dari file bisa rusak/diedit tangan - saring yang bentuknya salah.
function cleanSamples(samples) {
  if (!Array.isArray(samples)) return [];
  return samples.filter((s) => Array.isArray(s) && Number.isFinite(s[0]) && Number.isFinite(s[1]) && s[1] >= 0).sort((a, b) => a[0] - b[0]);
}

// Statistik kurva: puncak (+ kapan), rata-rata berbobot waktu, penonton awal/akhir.
// null kalau sampelnya kurang dari 2 (belum bisa disebut kurva).
function computeViewerStats(rawSamples) {
  const samples = cleanSamples(rawSamples);
  if (samples.length < 2) return null;

  let peak = -1;
  let peakAtSec = samples[0][0];
  for (const [t, v] of samples) {
    if (v > peak) {
      peak = v;
      peakAtSec = t;
    }
  }

  // Trapesium antar sampel; bobot = selisih waktu.
  let area = 0;
  let span = 0;
  for (let i = 1; i < samples.length; i++) {
    const dt = samples[i][0] - samples[i - 1][0];
    area += ((samples[i][1] + samples[i - 1][1]) / 2) * dt;
    span += dt;
  }
  const avg = span > 0 ? area / span : samples[0][1];

  return {
    peak,
    peakAtSec,
    peakOffsetSec: peakAtSec - samples[0][0],
    avg,
    startViews: samples[0][1],
    endViews: samples[samples.length - 1][1],
    firstSec: samples[0][0],
    lastSec: samples[samples.length - 1][0],
    count: samples.length,
  };
}

module.exports = { MAX_LIVE_SAMPLES, MAX_STORED_SAMPLES, downsample, addViewerSample, cleanSamples, computeViewerStats };
