// Saran "maksud kamu ...?" buat perintah yang salah ketik (mis. "cok strek nala").
// Dipakai CUMA di jalur fallback paling akhir router.js (pesan yang gak cocok pola
// manapun dan bukan nama member) - nambah satu baris petunjuk di atas menu, gak
// ngubah routing perintah lain sama sekali.

// Kata kunci perintah yang UMUM dan cukup unik. `usage` = contoh pemakaian yang ditampilin.
const COMMANDS = [
  { keyword: "streak", usage: "cok streak <nama member>" },
  { keyword: "stats", usage: "cok stats <nama member>" },
  { keyword: "statistik", usage: "cok statistik <nama member>" },
  { keyword: "jadwal", usage: "cok jadwal <nama member>" },
  { keyword: "grafik", usage: "cok grafik <nama member>" },
  { keyword: "rekap", usage: "cok rekap hari ini" },
  { keyword: "gifter", usage: "cok gifter <nama member>" },
  { keyword: "ingetin", usage: "cok ingetin <nama member>" },
  { keyword: "reminder", usage: "cok reminder aku" },
  { keyword: "bandingin", usage: "cok bandingin <nama> dan <nama>" },
  { keyword: "oshi", usage: "cok oshi <nama member>" },
  { keyword: "kelewat", usage: "cok kelewat" },
  { keyword: "tebak", usage: "cok tebak <nama member> <menit>" },
  { keyword: "wrapped", usage: "cok wrapped" },
  { keyword: "pengaturan", usage: "cok pengaturan" },
  { keyword: "bantuan", usage: "cok bantuan" },
  { keyword: "status", usage: "cok status" },
  { keyword: "export", usage: "cok export rekap" },
  { keyword: "alias", usage: "cok alias" },
];

const MIN_TOKEN_LENGTH = 4; // token pendek terlalu rawan salah tebak (nama panggilan, kata umum)

// Jarak edit Levenshtein (satu baris memori); input pendek jadi murah.
function editDistance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length];
}

// Balikin teks saran, atau null kalau gak ada yang cukup mirip / ambigu. `commandText`
// = pesan lowercase tanpa "cok" di depan. Cuma KATA PERTAMA yang dicek, dan kalau
// persis sama dengan kata kunci (berarti perintahnya sudah dikenal, cuma argumennya
// yang gak cocok) tidak ada saran.
function suggestCommand(commandText) {
  const token = String(commandText || "")
    .trim()
    .split(/\s+/)[0]
    .replace(/[^a-z]/g, "");
  if (token.length < MIN_TOKEN_LENGTH) return null;
  if (COMMANDS.some((c) => c.keyword === token)) return null;

  const maxDistance = token.length >= 7 ? 2 : 1;
  let best = null;
  let bestDistance = Infinity;
  let tie = false;
  for (const command of COMMANDS) {
    if (Math.abs(command.keyword.length - token.length) > maxDistance) continue;
    const distance = editDistance(token, command.keyword);
    if (distance < bestDistance) {
      best = command;
      bestDistance = distance;
      tie = false;
    } else if (distance === bestDistance) {
      tie = true;
    }
  }
  if (!best || bestDistance > maxDistance || tie) return null;
  return `🤔 Maksud kamu \`${best.usage}\`?`;
}

module.exports = { suggestCommand, editDistance, COMMANDS };
