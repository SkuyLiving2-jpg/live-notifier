// Generator kalimat ABSURD buat rangkuman VC (chat/vcFlow.js): catatan per sesi dan kalimat pembuka periode.
// Murni (tanpa I/O); `rng` dioper supaya bisa dites deterministik. Sengaja kombinatorial - subjek x predikat x
// penutup (+ templat khusus tiket/jeda jam/nama) - supaya hasilnya jarang sama dan tidak terasa berulang.
//
// Aturan isi: lucu karena tidak masuk akal, BUKAN karena menjelekkan orang. Subjeknya benda/hewan/situasi sehari-hari;
// satu-satunya yang menyebut orang adalah nama depan member, dan itu pun cuma dalam kalimat yang memuji/heboh
// (tidak ada ejekan, tidak ada klaim tentang kehidupan pribadi). Julukan khas ("CECE ADIK AING ...") sengaja TIDAK
// dikarang di sini - itu candaan owner, diisi sendiri lewat "julukan vc".

const SUBJECTS = [
  "Kucing tetanggaku",
  "Sinyal Wi-Fi lantai dua",
  "Kipas angin kamarku",
  "Sendal jepit sebelah kiri",
  "Mie instan jam 2 pagi",
  "Charger HP-ku",
  "Bantal gulingku",
  "Ayam jago komplek",
  "Abang bakso depan gang",
  "Galon yang tinggal setengah",
  "Kulkas dua pintu",
  "Sapu lidi di pojokan",
  "Awan mendung di atas genteng",
  "Nasi uduk sisa semalam",
  "Lampu teras yang kedip-kedip",
  "Jemuran yang belum kering",
  "Tukang parkir dari alam lain",
  "Alarm motor tetangga",
  "Bayangan di tembok kamar",
  "Tupperware tanpa tutup",
  "Remote TV yang hilang sejak 2019",
  "Kerupuk di kaleng biskuit",
  "Cicak di dinding kamar",
  "Panci bekas rebus mie",
  "Kalender dari bank",
  "Handuk basah di gagang pintu",
  "Dispenser galon",
  "Sandal hotel yang kebawa pulang",
  "Kardus bekas kulkas",
  "Sepeda yang cuma dipakai buat gantung baju",
];

const PREDICATES = [
  "sudah konfirmasi ikut nonton",
  "bersumpah tidak akan nge-lag",
  "minta dikasih kursi paling depan",
  "mendadak jadi pawang sinyal",
  "ikut latihan teriak 'halo' dari semalam",
  "menolak berhenti tepuk tangan",
  "sedang bertapa demi sesi ini",
  "mengajukan cuti massal",
  "sudah siap di posisi sejak subuh",
  "diam-diam ikut daftar tiket",
  "berjanji tidak akan buffering",
  "terharu duluan padahal belum mulai",
  "lagi menyiapkan yel-yel dalam bahasa kalbu",
  "membuka lapak gorengan di pinggir Zoom",
  "minta namanya ditulis di buku tamu",
  "lagi latihan senyum di depan kaca",
  "dikabarkan sudah booking kursi VIP",
  "ikut mengheningkan cipta sebelum mulai",
  "melaporkan bahwa cuaca di dalam layar sedang cerah",
  "sedang menghitung mundur pakai sempoa",
  "menolak keluar kamar sampai sesi selesai",
  "sudah menyiapkan pidato tiga halaman yang tidak akan dibaca",
  "bilang tenang, padahal tangannya gemetar",
  "mengirim surat izin ke semesta",
];

// Penutup: kalimat utuh (berakhir titik).
const CLOSERS = [
  "Jangan telat, ditinggal itu menyakitkan.",
  "Demi nusa, bangsa, dan kuota.",
  "Sekian dan terima kuota.",
  "Ini bukan saran finansial.",
  "Catat di kalender, tempel di jidat.",
  "Kalau bingung, tanya kucing.",
  "Info ini sahih menurut ilmu cocoklogi.",
  "Sumber: mimpi semalam.",
  "Dilarang tanya kenapa.",
  "Harap bawa semangat dan sendok.",
  "Selamat menikmati, jangan lupa napas.",
  "Saksikan, atau menyesal sampai tahun depan.",
  "Tolong jangan dipikir terlalu dalam.",
  "Sudah dikonfirmasi oleh sekelompok semut.",
  "Tetap tenang, tetap lebay.",
  "Disahkan tanpa rapat.",
  "Kalau ini salah, salahkan Wi-Fi.",
  "Tidak ada hubungannya dengan cuaca, tapi tetap bawa payung.",
];

// Pembanding rebutan tiket: "lebih ganas dari ___".
const SCRAMBLES = [
  "antrean gorengan jam 4 sore",
  "diskon tengah malam di toko yang sudah tutup",
  "kursi KRL jam pulang kantor",
  "sisa nasi uduk terakhir di warung",
  "colokan di bandara",
  "parkir depan minimarket",
  "voucher ongkir akhir bulan",
  "kembalian permen di kasir",
  "tempat duduk di pojok warkop",
  "rebutan remote waktu bola",
];

const SNACKS = ["pisang goreng", "kerupuk", "cilok", "klepon", "bakwan", "tahu isi"];

// Kegiatan di jeda antara jam MULAI dan jam BUKA.
const WAITING_ACTIVITIES = [
  "ngelap layar sampai kinclong",
  "latihan menyapa tanpa gugup",
  "mengatur napas dan harga diri",
  "memastikan kucing tidak ikut Zoom",
  "membaca ulang jadwal tujuh kali",
  "nyari headset yang selalu hilang",
  "menyusun kata-kata mutiara",
  "mondar-mandir sambil bilang 'tenang'",
  "ngecek sinyal sampai sinyalnya risih",
];

// Predikat pendek buat templat nama ("begitu <nama> muncul, <subjek> langsung ...").
const REACTIONS = [
  "berdiri tegak hormat",
  "lupa cara berkedip",
  "menitikkan air mata sambil makan kerupuk",
  "joget pelan-pelan tanpa musik",
  "mendadak fasih bahasa alien",
  "minta tanda tangan di udara",
  "ikut melambai ke layar",
  "pura-pura tidak peduli, padahal gemetar",
];

const lcFirst = (s) => s.charAt(0).toLowerCase() + s.slice(1);

function pick(list, rng) {
  return list[Math.min(list.length - 1, Math.floor(rng() * list.length))];
}

// Nama depan tanpa embel-embel akun IDN ("Nala JKT48" -> "Nala", "Piya | Grup" -> "Piya").
function firstName(name) {
  return String(name || "")
    .split(/[\s|]+/)
    .filter(Boolean)[0];
}

const toMinutes = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

function ticketNote(tickets, rng) {
  if (tickets === 1) return "Cuma 1 tiket. Satu. Sendirian. Seperti kopi hitam tanpa gula.";
  const forms = [
    () => `${tickets} tiket doang. Rebutannya lebih ganas dari ${pick(SCRAMBLES, rng)}.`,
    () => `Stok tiket ${tickets}, stok keberanian entah di mana. Rebutan lebih seru dari ${pick(SCRAMBLES, rng)}.`,
    () => `Hanya ${tickets} tiket, setara ${tickets} potong ${pick(SNACKS, rng)} untuk sekampung.`,
  ];
  return pick(forms, rng)();
}

// Aturan sesi: jam MULAI jatuh 0-15 menit SEBELUM jam buka (vcSlots.js). Data lama (sebelum aturan itu) bisa punya mulai
// setelah buka; itu tetap dapat kalimat yang benar.
function timeNote(open, start, rng) {
  const lead = toMinutes(open) - toMinutes(start); // menit mulai mendahului buka (negatif = mulai setelah buka)
  if (lead > 0) return `Mulai ${lead} menit sebelum buka: waktu yang pas buat ${pick(WAITING_ACTIVITIES, rng)}.`;
  if (lead === 0) return "Mulai dan buka di menit yang sama. Tidak ada waktu untuk napas. Selamat berjuang.";
  const gap = -lead;
  if (gap >= 60) return `Jeda ${gap} menit antara buka dan mulai, cukup untuk mandi, makan, dan galau tiga kali.`;
  return `Buka dulu, ${gap} menit kemudian mulai: waktu yang pas buat ${pick(WAITING_ACTIVITIES, rng)}.`;
}

// Catatan lucu per sesi. Semua masukan opsional; templat khusus (tiket/jeda/nama) hanya dipakai kalau datanya ada.
function generateNote({ name, tickets = null, open = null, start = null, rng = Math.random } = {}) {
  const generic = () => `${pick(SUBJECTS, rng)} ${pick(PREDICATES, rng)}. ${pick(CLOSERS, rng)}`;
  const candidates = [generic, generic];
  if (tickets)
    candidates.push(
      () => ticketNote(tickets, rng),
      () => ticketNote(tickets, rng),
    );
  if (open && start) candidates.push(() => timeNote(open, start, rng));
  const first = firstName(name);
  if (first) candidates.push(() => `Konon, begitu ${first} muncul di layar, ${lcFirst(pick(SUBJECTS, rng))} langsung ${pick(REACTIONS, rng)}.`);
  return pick(candidates, rng)();
}

// Kalimat pembuka periode (satu baris di bawah judul).
function generateOpener({ title = "VC", rng = Math.random } = {}) {
  const forms = [
    () => `Saatnya yang kita tunggu-tunggu! ${pick(SUBJECTS, rng)} ${pick(PREDICATES, rng)}. ${pick(CLOSERS, rng)}`,
    () => `${title} sudah tiba, lebih cepat dari tanggal gajian. ${pick(SUBJECTS, rng)} ${pick(PREDICATES, rng)}.`,
    () => `Peringatan dini: ${title} semakin dekat. ${pick(SUBJECTS, rng)} ${pick(PREDICATES, rng)}.`,
    () => `Menurut ramalan ${lcFirst(pick(SUBJECTS, rng))}, ${title} akan berjalan lancar. ${pick(CLOSERS, rng)}`,
    () => `Kabar gembira dari ${lcFirst(pick(SUBJECTS, rng))}: ${title} resmi dibuka. ${pick(CLOSERS, rng)}`,
  ];
  return pick(forms, rng)();
}

module.exports = { generateNote, generateOpener, SUBJECTS, PREDICATES, CLOSERS, SCRAMBLES, SNACKS, WAITING_ACTIVITIES, REACTIONS };
