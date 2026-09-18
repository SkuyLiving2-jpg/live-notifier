const { containsWholeWord, pickRandom } = require("../utils");
const { PRIORITY_MEMBERS, PRIORITY_COLOR_PALETTE, PRIORITY_PING_USER_ID } = require("../config");
const { loadCustomPriorityMembers, saveCustomPriorityMembers } = require("../storage/priorityStore");

// Fitur: owner bisa nambah/hapus member prioritas lewat chat ("cok tambah
// prioritas <nama>") tanpa perlu ubah kode. Yang custom disimpen terpisah
// dari 3 bawaan (Nala/Levi/Lily - lihat config.js's PRIORITY_MEMBERS), jadi
// ketiga itu nggak bisa kehapus via chat.
function getAllPriorityMembers() {
  return [...PRIORITY_MEMBERS, ...loadCustomPriorityMembers()];
}

function addCustomPriorityMember(rawKeyword) {
  const keyword = (rawKeyword || "").trim().toLowerCase();
  if (!keyword) return { ok: false, reason: "empty" };
  // Keyword pendek (1-2 huruf) matching-nya pakai containsWholeWord di
  // getPriorityConfig - itu bisa nyantol ke nama/username siapa aja yang
  // kebetulan ngandung kata itu utuh. Sama kelas bug kayak yang di pencarian
  // nama member, jadi dicegah dari sumbernya.
  if (keyword.length < 3) return { ok: false, reason: "too_short" };

  const all = getAllPriorityMembers();
  if (all.some((p) => p.keyword === keyword)) return { ok: false, reason: "exists" };

  const custom = loadCustomPriorityMembers();
  custom.push({
    rank: all.length + 1,
    keyword,
    label: keyword.toUpperCase(),
    color: PRIORITY_COLOR_PALETTE[custom.length % PRIORITY_COLOR_PALETTE.length],
    sirens: "🚨💥🚨",
  });
  saveCustomPriorityMembers(custom);
  return { ok: true };
}

function removeCustomPriorityMember(rawKeyword) {
  const keyword = (rawKeyword || "").trim().toLowerCase();
  const custom = loadCustomPriorityMembers();
  const filtered = custom.filter((p) => p.keyword !== keyword);
  if (filtered.length === custom.length) return { ok: false, reason: "not_found" };
  saveCustomPriorityMembers(filtered);
  return { ok: true };
}

function getPriorityConfig(memberName, username) {
  const text = `${memberName || ""} ${username || ""}`.toLowerCase();
  return getAllPriorityMembers().find((p) => containsWholeWord(text, p.keyword)) || null;
}

// Pilih 1 fragmen acak dari opener/body/closer terus digabung jadi 1
// kalimat utuh - kombinasinya jauh lebih banyak (6x6x6 = 216 variasi) dari
// jumlah baris yang ditulis, tanpa perlu nulis 216 kalimat lengkap manual.
function generateEndMessage(priority) {
  if (!priority.endMessagePool) return null;
  const { openers, bodies, closers } = priority.endMessagePool;
  return `${pickRandom(openers)}, ${pickRandom(bodies)}! ${pickRandom(closers)}`;
}

// imageUrl (thumbnail live dari IDN, field image_url di getLivestreams) cuma
// dipasang buat notif PRIORITAS - biar makin flashy/eye-catching, sesuai
// permintaan. Notif biasa (notify/liveNotify.js's buildNormalPayload)
// sengaja dibiarin polos, biar bedanya sama prioritas makin kerasa.
//
// includeMention (default true) - dimatiin kalau payload ini bakal dikirim
// lewat DM PRIBADI ke pemilik bot (lihat notify/priorityDm.js's
// sendPriorityDM) - nge-mention diri sendiri di DM sendiri itu aneh/
// redundant, mention cuma perlu dipasang kalau suatu saat payload ini
// dipakai lagi buat posting ke channel bersama.
function buildPriorityPayload(memberName, liveUrl, status, priority, imageUrl, { includeMention = true } = {}) {
  const mention = includeMention && PRIORITY_PING_USER_ID ? `<@${PRIORITY_PING_USER_ID}> ` : "";

  if (status === "end") {
    // endMessagePool (opsional, lihat config.js's PRIORITY_MEMBERS) - cuma
    // diisi buat member yang emang mau dikasih sentuhan khusus di notif
    // "selesai live"-nya (misal Nala). Kalau kosong, notif "selesai" tetap
    // plain kayak Levi/Lily - jadi ini BUKAN template semua member
    // prioritas, cuma yang di-opt-in lewat field itu. Diracik ULANG (random)
    // tiap kali fungsi ini dipanggil, jadi tiap live selesai kalimatnya
    // beda-beda.
    const endMessage = generateEndMessage(priority);
    return {
      content: endMessage
        ? `${mention}${priority.sirens} Live prioritas **#${priority.rank} ${priority.label}** udah selesai. 💌`
        : `${mention}${priority.sirens} Live prioritas **#${priority.rank} ${priority.label}** udah selesai.`,
      embeds: [
        {
          title: endMessage ? `💚 ${priority.label} sudah selesai live - makasih ya!` : `${priority.label} sudah selesai live`,
          description: memberName,
          color: priority.color,
          url: liveUrl,
          ...(imageUrl ? { thumbnail: { url: imageUrl } } : {}),
          ...(endMessage
            ? { fields: [{ name: `💌 Pesan dari ${priority.label}`, value: endMessage }], footer: { text: "Sampai jumpa di live berikutnya!" } }
            : {}),
        },
      ],
    };
  }

  return {
    content: `${mention}${priority.sirens.repeat(2)} **JANGAN SAMPE KETINGGALAN!** ${priority.sirens.repeat(2)}`,
    embeds: [
      {
        title: `⚡ PRIORITAS #${priority.rank}: ${priority.label} LIVE SEKARANG! ⚡`,
        // Link "TONTON SEKARANG" dulu ditulis manual di sini - sekarang udah
        // pindah jadi tombol beneran (components di bawah), jadi deskripsinya
        // gak perlu nyebut link lagi, tinggal fokus ngasih tau siapa yang live.
        description: `**${memberName}** baru aja mulai live di IDN Live.`,
        url: liveUrl,
        color: priority.color,
        footer: { text: "IDN Live Priority Alert" },
        timestamp: new Date().toISOString(),
        // "image" (bukan "thumbnail") sengaja dipilih di sini - dia nampilin
        // gambarnya BESAR di bawah embed, jauh lebih eye-catching buat notif
        // "baru mulai live" yang emang tujuannya bikin orang langsung notice.
        ...(imageUrl ? { image: { url: imageUrl } } : {}),
      },
    ],
    // Tombol LINK (style 5) - klik langsung buka live-nya di browser/app,
    // BEDA dari tombol menu fallback (fallback_menu:N) yang custom_id-nya
    // perlu ditangkep interactionCreate. Tombol link gak butuh bot nunggu
    // interaksi apa-apa sama sekali, jadi aman dikirim lewat webhook polos
    // (bukan lewat bot client) kayak notif ini. Label-nya beda per member -
    // lihat buttonLabel di config.js's PRIORITY_MEMBERS (Nala dikasih kesan
    // lebih mendesak dibanding Levi/Lily).
    components: [
      {
        type: 1,
        components: [
          {
            type: 2,
            style: 5,
            label: priority.buttonLabel || "🔴 Tonton Live Sekarang",
            url: liveUrl,
          },
        ],
      },
    ],
  };
}

module.exports = {
  getAllPriorityMembers,
  addCustomPriorityMember,
  removeCustomPriorityMember,
  getPriorityConfig,
  generateEndMessage,
  buildPriorityPayload,
};
