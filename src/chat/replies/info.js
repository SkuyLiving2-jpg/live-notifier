// Jawaban info singkat tanpa tombol: siapa yang lagi live, status bot, info satu member, bantuan, daftar prioritas, langganan sendiri.

const { pollHealth } = require("../../pollHealth");
const { activeLives, getSortedActiveLives } = require("../../storage/activeLives");
const { loadSubscriptions } = require("../../storage/subscriptions");
const { getAllPriorityMembers } = require("../../priority");
const { PRIORITY_PING_USER_ID, DAILY_RECAP_COLOR } = require("../../config");
const { formatViewCount, formatClockWIB, describeElapsed } = require("../../utils");

const { MAX_COMPARE_MEMBERS } = require("./compare");

function replyListLive() {
  const sorted = getSortedActiveLives();
  if (sorted.length === 0) return "Cok, lagi nggak ada member JKT48 yang live nih.";

  const lines = sorted.map((entry, i) => {
    const elapsedText = describeElapsed(Date.now() - new Date(entry.liveAt).getTime());
    const viewText = entry.viewCount != null ? ` | 👁️ ${formatViewCount(entry.viewCount)}` : "";
    return `${i + 1}. **${entry.name}** - ${elapsedText}${viewText}`;
  });

  return `Cok, ini yang lagi live (urut dari paling lama):\n${lines.join("\n")}`;
}

function replyBotStatus() {
  // Bot hidup tapi polling IDN lagi gagal berturut-turut = notif live GAK bakal
  // kekirim - "jalan normal" bakal bohong.
  if (pollHealth.failures >= 3) {
    return `⚠️ Bot hidup, TAPI polling ke IDN lagi gagal ${pollHealth.failures}x berturut-turut - live baru belum bisa kedeteksi sampai pulih. Lagi mantau ${activeLives.size} member yang live sekarang.`;
  }
  return `✅ Bot jalan normal. Lagi mantau ${activeLives.size} member yang live sekarang.`;
}

function replySpecificMember(entry) {
  // entry.liveAt datang MENTAH dari live_at API IDN (idnApi.js gak validasi
  // format-nya) - divalidasi eksplisit di sini soalnya formatClockWIB()
  // (Intl.DateTimeFormat) THROW kalau dikasih Invalid Date (bukan ngasih
  // teks aneh kayak formatDuration/describeElapsed dengan NaN) - tanpa ini,
  // satu live_at yang kebetulan rusak bikin "cok siapa yang live <nama>"
  // gagal total tanpa balesan sama sekali (lihat notify/liveNotify.js's
  // sendDiscordNotif buat bug sekelas ini yang ketemu duluan).
  const liveAtDate = entry.liveAt ? new Date(entry.liveAt) : null;
  const liveAtValid = liveAtDate && !Number.isNaN(liveAtDate.getTime());
  const elapsedText = describeElapsed(liveAtValid ? Date.now() - liveAtDate.getTime() : 0);
  const startText = liveAtValid ? `, mulai jam ${formatClockWIB(liveAtDate)}` : "";
  const viewText = entry.viewCount != null ? ` | 👁️ ${formatViewCount(entry.viewCount)} penonton` : "";
  const liveUrl = `https://idn.app/${entry.username}/live/${entry.slug}`;
  return `**${entry.name}** lagi live, ${elapsedText}${startText}${viewText}. ${liveUrl}`;
}

function replyMemberNotFound(fragment) {
  return `Cok, nggak nemu member "${fragment}" yang lagi live. Coba cek ejaannya, atau tanya "cok siapa yang live" buat liat daftarnya.`;
}

// BUG YANG DILAPORIN OWNER ("Fitur lainnya kok kayak rusak"): daftar
// command di bawah ini kepanjangan - digabung jadi SATU string polos
// (`content`), panjangnya 2900-an karakter, ngelewatin batas 2000 karakter
// punya Discord buat `content` pesan. Efeknya interaction.update()/message.reply()
// nolak ngirim SAMA SEKALI (Discord API balikin error), jadi baik tombol "❓
// Fitur lainnya" (menu.js) MAUPUN ngetik "cok bantuan" langsung dua-duanya
// diem-diem gagal - user ngerasa tombolnya "rusak" padahal akar masalahnya
// teksnya kepanjangan. Sekarang dipecah: `content` cuma intro pendek (bebas
// jauh dari batas 2000), daftar commandnya sendiri dipindah ke `embeds`
// (field `description` embed batasnya 4096 karakter, jauh lebih longgar).
// Balikin OBJECT ({content, embeds}), bukan string lagi - safeReplyOptions
// (utils.js) nerima dua-duanya, jadi pemanggil (router.js's "cok bantuan"
// DAN menu.js's tombol "❓ Fitur lainnya") gak perlu ubah cara manggilnya.
function replyHelp() {
  const ownerContact = PRIORITY_PING_USER_ID ? `<@${PRIORITY_PING_USER_ID}>` : "owner channel ini";
  const description = [
    '- "cok ini yang masih live siapa aja?"',
    '- "cok siapa yang paling lama live" / "cok siapa yang paling rame ditonton" - tambahin "minggu ini"/"bulan ini"/nama bulan/tanggal buat rentang laen, default hari ini',
    '- "cok status"',
    '- "cok <nama member> masih live?"',
    '- "cok stats <nama member>" - statistik durasi live-nya',
    '- "cok berapa kali <nama member> live" - total berapa kali dia udah live semenjak bot ini jalan',
    '- "cok siapa yang paling sering live" - leaderboard total live count semua member',
    '- "cok siapa yang paling lama gak live" / "cok siapa yang paling jarang live" - kebalikannya, member yang UDAH LAMA gak keliatan (yang lagi live sekarang dikecualiin)',
    '- "cok kapan <nama member> biasanya live?" / "cok jadwal <nama>" - pola jam/hari dari histori (bukan jadwal resmi)',
    '- "cok gifter <nama member>" - top gifter (snapshot terakhir dari "npm run cek-gifter", bukan real-time)',
    '- "cok bandingin <nama> dan <nama>" (atau "cok <nama> & <nama>") - total live/rata-rata/rekor durasi berdampingan + foto profil. "cok bandingin" polos = ditanya mau berapa member (2-5), dicariin lewat dropdown',
    `- "cok bandingin A, B, dan C" - bisa lebih dari 2 member sekaligus (pakai koma, maks ${MAX_COMPARE_MEMBERS} orang), mis. "cok bandingin nala, levi, dan lily"`,
    '- "notif live semua" - minta notif live SEMUA member (ditanya "yakin?" dulu, tinggal klik Ya/Tidak)',
    '- "cok role" - tombol buat milih notif live: semua member atau member tertentu (owner: "cok pasang panel role", "cok tambah role <nama> @Role", "cok hapus role <nama>", "cok daftar role", "cok cek role")',
    '- "cok rekap hari ini" - rekap live yang udah selesai hari ini',
    '- "cok rekap minggu ini" (7 hari terakhir) / "cok rekap bulan ini" / "cok rekap <nama bulan>" / "cok rekap <tanggal>" / "cok rekap <nama hari>"',
    '- "cok rekap <nama member>" (mis. "cok rekap aralie") - tabel semua live member itu yang masih kesimpen di rekap (35 hari terakhir). Bisa juga lewat tombol "Rekap member" di menu "cok rekap"',
    '- "cok streak <nama member>" - lagi live berapa hari berturut-turut',
    '- "cok grafik <nama member>" (atau "cok chart <nama>") - bar chart durasi live 10 sesi terakhirnya (gambar, bukan teks)',
    '- "cok oshi <nama>" / "cok oshi saya" - member favoritmu (maks 5): profil, di-tag pas live, ringkasan mingguan lewat DM',
    '- "cok kelewat" (atau "cok kelewat 6 jam") - siapa aja yang live sejak terakhir kamu aktif',
    '- "cok wrapped" / "cok wrapped <nama>" - kartu rangkuman 30 hari terakhir (gambar)',
    '- "cok tebak" - mini-game tebak durasi live / siapa live berikutnya ("cok papan tebak" = skor)',
    '- "cok pengaturan" - notif lewat DM ("cok notif dm") dan jam tenang ("cok jam tenang 23-6")',
    '- "cok grafik penonton <nama member>" - kurva jumlah penonton selama live (gambar), lengkap dengan puncaknya',
    '- "cok export rekap ..." - sama rentangnya kayak "cok rekap ...", dikirim jadi file CSV yang bisa didownload',
    '- "cok daftar prioritas" - lihat member prioritas',
    '- "cok ingetin <nama member>" - kamu di-tag kalau dia mulai live, ATAU kalau ada tanda-tanda bentar lagi live (perkiraan dari pola jam biasanya dia live, kalau histori-nya udah cukup)',
    '- "cok berhenti ingetin <nama member>" - matiin reminder itu',
    '- "cok reminder aku" - lihat kamu subscribe reminder siapa aja',
    '- (khusus owner) "cok tambah prioritas <nama>" / "cok hapus prioritas <nama>"',
    '- "cok alias" - lihat panggilan/nickname yang udah kedaftar (owner: tombol Tambah/Hapus di layar itu, atau "cok tambah alias <alias> = <nama asli>" / "cok hapus alias <alias>")',
    "",
    'Kalau abis muncul menu tombol, kamu juga bisa cukup balas angkanya doang (misal "1" atau "4 Nala") tanpa perlu klik.',
    '💡 Notif kerasa suka telat/gak keluar? Cek setting notifikasi channel-nya - klik nama channel > Notification Settings, pastiin di "All Messages" (bukan "Only @mentions"), soalnya notif live biasa emang gak nge-tag siapa-siapa kecuali kamu subscribe ("cok ingetin <nama>").',
  ].join("\n");
  return {
    content: `Cok bisa jawab ini (daftar lengkap di bawah). Ada yang belum kejawab? Hubungi ${ownerContact}.`,
    embeds: [{ description, color: DAILY_RECAP_COLOR }],
  };
}

// Daftar SEMUA member prioritas (bawaan Nala/Levi/Lily + custom yang
// ditambahin owner lewat chat) - siapa aja boleh nanya ini, bukan cuma owner.
function replyPriorityList() {
  const all = getAllPriorityMembers().sort((a, b) => a.rank - b.rank);
  if (all.length === 0) return "Cok, belum ada member prioritas yang diset.";
  const lines = all.map((p) => `${p.rank}. **${p.label}** (keyword: "${p.keyword}")`);
  return `⭐ Daftar member prioritas:\n${lines.join("\n")}`;
}

// Kebalikan dari handleSubscribe/handleUnsubscribe - buat user nanya "aku
// subscribe siapa aja sih" tanpa harus inget-inget sendiri.
function replyMySubscriptions(authorId) {
  const subs = loadSubscriptions();
  const keywords = Object.entries(subs)
    .filter(([, ids]) => ids.includes(authorId))
    .map(([keyword]) => keyword);

  if (keywords.length === 0) {
    return 'Cok, kamu belum subscribe reminder buat siapa pun. Ketik "cok ingetin <nama member>" buat mulai.';
  }
  return `🔔 Kamu subscribe reminder buat: ${keywords.map((k) => `"${k}"`).join(", ")}`;
}

module.exports = {
  replyListLive,
  replyBotStatus,
  replySpecificMember,
  replyMemberNotFound,
  replyHelp,
  replyPriorityList,
  replyMySubscriptions,
};
