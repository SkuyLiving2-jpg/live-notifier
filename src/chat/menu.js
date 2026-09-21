const { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } = require("discord.js");
const { activeLives, getSortedActiveLives, findMemberByNameFragment } = require("../storage/activeLives");
const { getSortedGifterSnapshotMembers } = require("../storage/gifterSnapshot");
const { getGreeting, describeElapsed, YES_PATTERN, NO_PATTERN, safeReplyOptions } = require("../utils");
const {
  replyListLive,
  replyBotStatus,
  replyLongestLive,
  replyTopViewers,
  replyPriorityList,
  replyMySubscriptions,
  replyTodayRecapSoFar,
  replyMemberNotFound,
  replyGifterSnapshotByUsername,
} = require("./replies");

// "channelId:authorId" -> kapan terakhir menu fallback ditampilin buat orang
// itu. Dipake biar user bisa balas cukup ketik angkanya doang (1-9) abis
// menu-nya muncul - tapi CUMA kalau menu-nya baru aja beneran ditampilin
// duluan, biar ketik angka "mentah" tanpa konteks tetap nunjukkin menu-nya
// dulu (bukan nebak). Map ini dikelola sepenuhnya di chat/pendingState.js
// (lihat markMenuShown), file ini cuma consumer lewat resolveBareMenuChoice.

// Tombol Discord buat tiap pilihan menu - custom_id-nya "fallback_menu:<N>",
// dibaca di handleFallbackMenuButton(). Discord batesin maksimal 5 tombol
// per baris, jadi 9 pilihan dipecah jadi 2 baris (5 + 4).
function buildFallbackMenuComponents() {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("fallback_menu:1").setLabel("1. Siapa yang live").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("fallback_menu:2").setLabel("2. Status bot").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("fallback_menu:3").setLabel("3. Paling lama (hari ini)").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("fallback_menu:4").setLabel("4. Cek member").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("fallback_menu:5").setLabel("5. Paling rame (hari ini)").setStyle(ButtonStyle.Primary),
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("fallback_menu:6").setLabel("6. Daftar prioritas").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("fallback_menu:7").setLabel("7. Reminder aku").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("fallback_menu:8").setLabel("8. Rekap hari ini").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("fallback_menu:9").setLabel("9. Cek top gifter").setStyle(ButtonStyle.Success),
  );
  return [row1, row2];
}

// Dipanggil kalau pesannya kedetect nanya soal live tapi nggak match
// pertanyaan yang udah dikenali - dikasih menu daripada bot diem aja.
//
// CATATAN: pilihan #3 dan #5 sekarang beneran ngitung "hari ini" (gabungan
// live yang lagi jalan + yang udah selesai, dari daily log), BUKAN cuma
// snapshot siapa yang lagi live detik ini - liat replies.js's
// replyLongestLive() dan replyTopViewers(). Beda sama pilihan #8 ("cok rekap
// hari ini") yang nampilin TABEL lengkap semua sesi, ini cuma nyebut satu
// yang paling menonjol.
//
// Balikin OBJECT ({content, components}), bukan string doang - discord.js
// nerima dua-duanya di message.reply(), jadi gak perlu ubah apa-apa di
// pemanggilnya. Nomor 1-9 ketik manual TETEP jalan (lewat
// pendingState.js's tryHandleMenuShortcut) - tombol ini cuma nambahin cara
// yang lebih gampang, bukan gantiin.
//
// Teks sengaja diringkes (dulu nge-list ulang 9 opsi + instruksi ketik
// manual + kontak owner jadi satu blok panjang) - label di tombolnya sendiri
// ("1. Siapa yang live", dst, lihat buildFallbackMenuComponents) udah nyebut
// tiap opsi, jadi gak perlu diulang di teks. Instruksi ketik-manual/angka
// (buat yang gak bisa klik tombol) dan kontak owner dipindah ke
// replyHelp() - orang yang emang nyari itu biasanya nanya "cok bantuan" duluan.
function replyFallbackMenu() {
  const content = `Halo, selamat ${getGreeting()}! Klik salah satu di bawah, atau tanya "cok bantuan" buat command lengkapnya.`;
  return { content, components: buildFallbackMenuComponents() };
}

// Dipake bareng-bareng sama shortcut angka (chat teks, lihat
// pendingState.js) DAN tombol Discord (di bawah) - biar switch-nya cuma ada
// di 1 tempat, gak didobelin.
async function resolveBareMenuChoice(choice, channelId, authorId) {
  switch (choice) {
    case "1":
      return replyListLive();
    case "2":
      return replyBotStatus();
    case "3":
      return replyLongestLive();
    case "5":
      return replyTopViewers();
    case "6":
      return replyPriorityList();
    case "7":
      return replyMySubscriptions(authorId);
    case "8":
      return await replyTodayRecapSoFar(channelId, authorId);
    default:
      return null;
  }
}

function memberPromptQuestion(option) {
  return option === "4"
    ? 'Member yang mana? Ketik nama membernya juga ya, misal "4 Nala".'
    : 'Gifter siapa? Ketik nama membernya juga ya, misal "9 Nala".';
}

// "channelId:authorId" -> { username, name, at } - nunggu jawaban y/n abis
// user milih member lewat menu #4. Di-key per channel+author soalnya ini
// nunggu jawaban SATU ORANG spesifik - kalau cuma per-channel, jawaban "y"
// dari orang lain di channel yang sama bisa nyangkut ke pertanyaan yang
// bukan buat dia.
const pendingWatchConfirm = new Map();
const PENDING_WATCH_CONFIRM_TTL_MS = 2 * 60000;

// Dipanggil abis user milih member lewat "4 <nama>" - kalau membernya lagi
// live, JANGAN langsung kasih link, tanya dulu "mau nonton?" (biar kayak
// ngobrol beneran, bukan asal muntahin info). Kalau membernya ternyata lagi
// nggak live, gak usah nanya apa-apa lagi, langsung bilang aja.
// Dipisah dari startWatchConfirm biar pemanggil yang UDAH PASTI punya entry-nya
// (mis. dropdown pilihan #4, lihat handleFallbackMemberSelect) bisa langsung
// pake entry itu tanpa nyari ulang lewat fuzzy name-match - beda sama
// startWatchConfirm(fragment, ...) yang emang butuh nyari dulu (dipanggil dari
// chat teks yang cuma punya nama, bukan entry).
function startWatchConfirmForEntry(entry, channelId, authorId) {
  if (channelId && authorId) {
    pendingWatchConfirm.set(`${channelId}:${authorId}`, { username: entry.username, name: entry.name, at: Date.now() });
  }
  return `**${entry.name}** lagi live nih! Mau nonton sekarang? (y/n)`;
}

function startWatchConfirm(fragment, channelId, authorId) {
  const found = findMemberByNameFragment(fragment);
  if (!found) return replyMemberNotFound(fragment);
  return startWatchConfirmForEntry(found, channelId, authorId);
}

// Dicek di AWAL chat/router.js's buildChatReply - jawaban "y" atau "n"
// polos nggak nyebut "cok"/"live" sama sekali, jadi kalau nunggu wake-word
// dulu, jawabannya nggak akan pernah ke-proses.
function tryHandleWatchConfirmShortcut(text, channelId, authorId) {
  if (!channelId || !authorId) return null;
  const key = `${channelId}:${authorId}`;
  const pending = pendingWatchConfirm.get(key);
  if (!pending) return null;

  const expired = Date.now() - pending.at > PENDING_WATCH_CONFIRM_TTL_MS;
  const isYes = YES_PATTERN.test(text);
  const isNo = NO_PATTERN.test(text);
  if (!isYes && !isNo) {
    // Bukan jawaban y/n - biarin ke routing normal. Kalau kebetulan udah
    // expired, bersihin sekalian biar gak numpuk selamanya nungguin jawaban
    // yang gak bakal dateng, tapi jangan ganggu pesan yang emang gak
    // relevan ini dengan pesan "kelamaan mikirnya".
    if (expired) pendingWatchConfirm.delete(key);
    return null;
  }

  pendingWatchConfirm.delete(key); // sekali pake abis itu clear

  // Kalau udah expired, jangan diem-diem lanjut ke routing normal (bisa
  // nyasar ke fallback menu di bot-channel gara-gara "y"/"n" polos jatuh ke
  // situ, kesannya jawaban orangnya gak "nyambung" ke apa-apa) - kasih tau
  // eksplisit daripada bikin bingung.
  if (expired) {
    return `Yah, kelamaan mikirnya buat **${pending.name}** - kalau masih mau cek, tanya lagi ya.`;
  }

  // Re-cek status live-nya SEKARANG, jangan percaya data lama - bisa aja
  // dia udah selesai live selagi user mikir mau jawab y/n apa nggak.
  const entry = activeLives.get(pending.username);
  if (!entry) {
    return `Yah, **${pending.name}** kayaknya baru aja selesai live.`;
  }

  if (isYes) {
    const liveUrl = `https://idn.app/${entry.username}/live/${entry.slug}`;
    return `🔴 Gas nonton! **${entry.name}** - ${liveUrl}`;
  }

  const elapsedText = describeElapsed(Date.now() - new Date(entry.liveAt).getTime());
  return `Oke sip. **${entry.name}** ${elapsedText}, kalau berubah pikiran tinggal cek lagi ya.`;
}

// Diklik dari tombol replyFallbackMenu(). Pilihan 1/2/3/5/6/7/8 langsung
// dijawab lewat resolveBareMenuChoice (fungsi sama yang dipake shortcut
// angka). Pilihan 4/9 beda - butuh tau membernya SIAPA, jadi alih-alih nyuruh
// ngetik nama manual, langsung dikasih dropdown isinya member yang lagi live.
async function handleFallbackMenuButton(interaction) {
  const optionId = interaction.customId.split(":")[1];

  // Opsi 4 (cek member) HARUS dari activeLives (nanya "masih live gak?"
  // cuma masuk akal buat yang emang lagi live). Opsi 9 (gifter) BEDA -
  // datanya snapshot yang independen dari status live sekarang, jadi
  // sumber dropdown-nya juga beda (lihat getSortedGifterSnapshotMembers).
  if (optionId === "4") {
    const sorted = getSortedActiveLives();
    if (sorted.length === 0) {
      // PUBLIK (bukan ephemeral) - ini jawaban FINAL (gak ada dropdown lanjutan
      // buat dipilih), sama kayak balesan "cok siapa yang live" biasa lewat
      // teks (replyListLive), jadi visibility-nya juga harus konsisten sama itu,
      // bukan cuma keliatan orang yang mimic tombolnya doang.
      await interaction.reply(safeReplyOptions(replyListLive()));
      return;
    }

    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId("fallback_select:4")
      .setPlaceholder("Pilih member...")
      .addOptions(sorted.slice(0, 25).map((entry) => ({ label: entry.name, value: entry.username })));
    const row = new ActionRowBuilder().addComponents(selectMenu);
    // Ephemeral (cuma keliatan yang mimic tombolnya) - ini baru langkah
    // milih, belum jawaban final, jadi gak perlu numpuk di channel publik.
    await interaction.reply(safeReplyOptions({ content: "Mau cek member yang mana?", components: [row], ephemeral: true }));
    return;
  }

  if (optionId === "9") {
    const sorted = getSortedGifterSnapshotMembers();
    if (sorted.length === 0) {
      // PUBLIK juga, sama alasannya kayak opsi 4 - ini jawaban final, bukan
      // langkah milih, jadi konsisten sama balesan "cok gifter <nama>" biasa
      // yang juga publik pas datanya kosong.
      await interaction.reply(
        safeReplyOptions(
          'Cok, belum ada data top gifter buat siapapun. Yang pegang akun IDN-nya bisa jalanin "npm run cek-gifter" dulu biar ke-update.',
        ),
      );
      return;
    }

    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId("fallback_select:9")
      .setPlaceholder("Pilih member...")
      .addOptions(sorted.slice(0, 25).map((entry) => ({ label: entry.name, value: entry.username })));
    const row = new ActionRowBuilder().addComponents(selectMenu);
    await interaction.reply(safeReplyOptions({ content: "Mau cek top gifter member yang mana?", components: [row], ephemeral: true }));
    return;
  }

  const reply = await resolveBareMenuChoice(optionId, interaction.channelId, interaction.user.id);
  if (reply) await interaction.reply(safeReplyOptions(reply));
}

// Diklik abis milih member dari dropdown yang dimunculin handleFallbackMenuButton.
// Jawaban FINAL ini sengaja PUBLIK (bukan ephemeral) - informasinya kayak
// "siapa yang live"/"top gifter" itu kepake bareng, konsisten sama balesan
// command teks yang emang keliatan semua orang di channel.
async function handleFallbackMemberSelect(interaction) {
  const optionId = interaction.customId.split(":")[1];
  const username = interaction.values[0];

  if (optionId === "4") {
    // Langsung pake entry dari username (udah pasti bener, dari pilihan
    // dropdown) - BUKAN startWatchConfirm(entry.name, ...) yang bakal
    // nyari ulang lewat fuzzy name-match dan berpotensi (walau jarang)
    // nyangkut ke member lain yang kebetulan nama depannya mirip.
    const entry = activeLives.get(username);
    const reply = entry ? startWatchConfirmForEntry(entry, interaction.channelId, interaction.user.id) : replyMemberNotFound(username);
    await interaction.reply(safeReplyOptions(reply));
    return;
  }

  // username di sini dijamin ada di gifter-snapshot.json - langsung dari
  // pilihan dropdown yang dibangun getSortedGifterSnapshotMembers(), bukan
  // dari activeLives kayak sebelumnya.
  await interaction.reply(safeReplyOptions(replyGifterSnapshotByUsername(username)));
}

module.exports = {
  buildFallbackMenuComponents,
  replyFallbackMenu,
  resolveBareMenuChoice,
  memberPromptQuestion,
  startWatchConfirm,
  startWatchConfirmForEntry,
  tryHandleWatchConfirmShortcut,
  handleFallbackMenuButton,
  handleFallbackMemberSelect,
};
