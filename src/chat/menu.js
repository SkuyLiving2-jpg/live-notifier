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
// per baris, jadi 9 pilihan dipecah jadi 2 baris (5 + 4) - baris kedua
// (6-9) masih nyisa 1 slot, jadi tombol "Tutup" (di bawah) nempel di situ,
// tetep 2 baris, gak perlu baris ketiga.
//
// "Tutup" di sini ("fallback_menu:delete") BEDA dari "Tutup" yang udah ada
// di buildFallbackPickActionRow ("fallback_menu:close", nempel di dropdown
// opsi 4/9) - owner minta ini buat kasus salah pencet/salah ketik pas menu
// 9-opsi INI yang lagi keliatan (bukan pas di tengah milih member/gifter),
// dan maksudnya beda: bukan diedit jadi teks "dibatalin" (itu masih
// nyisain jejak pesan), tapi PESANNYA BENERAN DIHAPUS - dianggep kayak
// gak pernah ada. Lihat handleFallbackMenuButton's "delete" branch.
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
    new ButtonBuilder().setCustomId("fallback_menu:delete").setLabel("Tutup").setStyle(ButtonStyle.Danger),
  );
  return [row1, row2];
}

// Baris tombol "Tutup"/"Kembali" yang nempel DI BAWAH dropdown pilih
// member/gifter (opsi 4/9 di handleFallbackMenuButton) - StringSelectMenu
// harus sendirian di baris-nya (gak bisa digabung sama tombol di baris yang
// sama), jadi ini baris KEDUA yang nempel bareng dropdown-nya. "Kembali"
// nyusul owner minta ada cara balik ke menu 9-opsi awal TANPA harus nutup
// dulu terus manggil ulang "cok bantuan" - beda dari "Tutup" yang beneran
// ngakhirin interaksinya. customId-nya ("fallback_menu:close"/"fallback_menu:back")
// dibaca di handleFallbackMenuButton (dispatcher yang sama kayak tombol menu
// 1-9), bukan handler terpisah.
function buildFallbackPickActionRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("fallback_menu:close").setLabel("Tutup").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("fallback_menu:back").setLabel("Kembali").setStyle(ButtonStyle.Secondary),
  );
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

// Tombol Ya/Enggak/Tutup buat pertanyaan "mau nonton?" - owner minta ini
// jadi tombol (bukan ngetik "y"/"n") biar "gak ribet", DAN minta ada opsi
// "Tutup" kalau ternyata salah pencet member dari dropdown. customId-nya
// bawa username LANGSUNG (self-contained, sama pola-nya kayak recap_nav's
// tombol) - gak nunggu/gak butuh pendingWatchConfirm buat FUNGSI (cuma
// dipake buat nampilin ulang nama-nya kalau membernya udah keburu selesai
// live pas diklik, lihat handleWatchConfirmButton), jadi tombol ini tetep
// valid diklik kapan aja, gak kena TTL kayak jalur ngetik y/n.
function buildWatchConfirmComponents(username) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`watch_confirm:yes:${username}`).setLabel("🔴 Ya, nonton").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`watch_confirm:no:${username}`).setLabel("Enggak").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`watch_confirm:close:${username}`).setLabel("Tutup").setStyle(ButtonStyle.Danger),
  );
  return [row];
}

// Dipanggil abis user milih member lewat "4 <nama>" - kalau membernya lagi
// live, JANGAN langsung kasih link, tanya dulu "mau nonton?" (biar kayak
// ngobrol beneran, bukan asal muntahin info). Kalau membernya ternyata lagi
// nggak live, gak usah nanya apa-apa lagi, langsung bilang aja.
// Dipisah dari startWatchConfirm biar pemanggil yang UDAH PASTI punya entry-nya
// (mis. dropdown pilihan #4, lihat handleFallbackMemberSelect) bisa langsung
// pake entry itu tanpa nyari ulang lewat fuzzy name-match - beda sama
// startWatchConfirm(fragment, ...) yang emang butuh nyari dulu (dipanggil dari
// chat teks yang cuma punya nama, bukan entry).
//
// Balikin OBJECT ({content, components}), bukan string doang - ngetik "y"/
// "n" polos (tryHandleWatchConfirmShortcut di bawah) TETEP jalan sebagai
// alternatif, tombol cuma nambahin cara yang lebih gampang.
function startWatchConfirmForEntry(entry, channelId, authorId) {
  if (channelId && authorId) {
    pendingWatchConfirm.set(`${channelId}:${authorId}`, { username: entry.username, name: entry.name, at: Date.now() });
  }
  return { content: `**${entry.name}** lagi live nih! Mau nonton sekarang?`, components: buildWatchConfirmComponents(entry.username) };
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

// Diklik dari salah satu tombol buildWatchConfirmComponents() bikin (customId
// "watch_confirm:<yes|no|close>:<username>"). EDIT pesan yang tombolnya
// nempel (interaction.update, bukan pesan baru) - sama pola-nya kayak
// handleRecapNavButton, biar gak numpuk pesan baru per klik. Username-nya
// dari customId (bukan pendingWatchConfirm) - pending state di sini cuma
// dipake buat NAMA cadangan (lihat komen di bawah), gak nge-block button-nya
// buat tetep valid diklik walau udah lewat PENDING_WATCH_CONFIRM_TTL_MS.
async function handleWatchConfirmButton(interaction) {
  const [, action, username] = interaction.customId.split(":");
  const key = `${interaction.channelId}:${interaction.user.id}`;
  const pending = pendingWatchConfirm.get(key);
  pendingWatchConfirm.delete(key); // abis dijawab lewat tombol, jawaban teks "y"/"n" yang nyasar berikutnya gak boleh nyangkut ke ini lagi

  if (action === "close") {
    await interaction.update(safeReplyOptions({ content: "Oke, dibatalin.", components: [] }));
    return;
  }

  // Re-cek status live-nya SEKARANG (bukan pas tombolnya ditampilin) - bisa
  // aja membernya udah selesai live selagi user mikir mau klik apa nggak.
  // Nama-nya diambil dari activeLives kalau masih ada (paling akurat), kalau
  // udah nggak ada fallback ke nama yang sempet kesimpen di pendingWatchConfirm
  // (bisa aja kosong kalau udah lewat TTL-nya/gak ada - fallback terakhir
  // "member ini" biar tetep ada balesan, bukan "undefined").
  const entry = activeLives.get(username);
  const name = entry?.name || pending?.name || "member ini";

  if (!entry) {
    await interaction.update(safeReplyOptions({ content: `Yah, **${name}** kayaknya baru aja selesai live.`, components: [] }));
    return;
  }

  if (action === "yes") {
    const liveUrl = `https://idn.app/${entry.username}/live/${entry.slug}`;
    await interaction.update(safeReplyOptions({ content: `🔴 Gas nonton! **${name}** - ${liveUrl}`, components: [] }));
    return;
  }

  const elapsedText = describeElapsed(Date.now() - new Date(entry.liveAt).getTime());
  await interaction.update(
    safeReplyOptions({ content: `Oke sip. **${name}** ${elapsedText}, kalau berubah pikiran tinggal cek lagi ya.`, components: [] }),
  );
}

// Diklik dari tombol replyFallbackMenu(). Pilihan 1/2/3/5/6/7/8 langsung
// dijawab lewat resolveBareMenuChoice (fungsi sama yang dipake shortcut
// angka). Pilihan 4/9 beda - butuh tau membernya SIAPA, jadi alih-alih nyuruh
// ngetik nama manual, langsung dikasih dropdown isinya member yang lagi live.
//
// SEMUA cabang di sini pake interaction.update() (EDIT pesan menu yang
// tombolnya nempel), BUKAN interaction.reply() (pesan BARU) - owner ngeluh
// tiap kali mencet tombol yang beda-beda di menu 9-opsi, jawabannya numpuk
// jadi pesan baru satu-satu, sama persis keluhan yang dulu diomongin soal
// tabel rekap (lihat handleRecapNavButton). Konsekuensinya: langkah dropdown
// milih member/gifter (opsi 4/9, di bawah) yang DULU ephemeral (cuma keliatan
// orang yang mimic) sekarang ikutan jadi publik juga - gak ada cara nge-edit
// pesan publik jadi ephemeral, dan mengedit pesan yang sama itu justru
// intinya di sini, bukan bug. Opsi 1/2/3/5/6/7/9(kosong)/4(kosong) balikin
// STRING polos (gak ada tombol sendiri) - buildFallbackMenuComponents()
// ditempelin ULANG di bawahnya biar user bisa lanjut mencet opsi LAIN dari
// pesan yang sama, gak perlu manggil ulang "cok bantuan". Opsi 8 (rekap hari
// ini) BEDA - baliknya udah bawa tombol navigasi rekap sendiri (Maju/Mundur/
// Tutup rekap/Cari member), jadi dipake apa adanya tanpa ditempelin menu lagi
// (nge-gabung 2 sistem tombol beda konteks di 1 pesan cuma bikin bingung).
async function handleFallbackMenuButton(interaction) {
  const optionId = interaction.customId.split(":")[1];

  // Opsi 4 (cek member) HARUS dari activeLives (nanya "masih live gak?"
  // cuma masuk akal buat yang emang lagi live). Opsi 9 (gifter) BEDA -
  // datanya snapshot yang independen dari status live sekarang, jadi
  // sumber dropdown-nya juga beda (lihat getSortedGifterSnapshotMembers).
  if (optionId === "4") {
    const sorted = getSortedActiveLives();
    if (sorted.length === 0) {
      await interaction.update(safeReplyOptions({ content: replyListLive(), components: buildFallbackMenuComponents() }));
      return;
    }

    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId("fallback_select:4")
      .setPlaceholder("Pilih member...")
      .addOptions(sorted.slice(0, 25).map((entry) => ({ label: entry.name, value: entry.username })));
    const row = new ActionRowBuilder().addComponents(selectMenu);
    await interaction.update(safeReplyOptions({ content: "Mau cek member yang mana?", components: [row, buildFallbackPickActionRow()] }));
    return;
  }

  if (optionId === "9") {
    const sorted = getSortedGifterSnapshotMembers();
    if (sorted.length === 0) {
      await interaction.update(
        safeReplyOptions({
          content: 'Cok, belum ada data top gifter buat siapapun. Yang pegang akun IDN-nya bisa jalanin "npm run cek-gifter" dulu biar ke-update.',
          components: buildFallbackMenuComponents(),
        }),
      );
      return;
    }

    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId("fallback_select:9")
      .setPlaceholder("Pilih member...")
      .addOptions(sorted.slice(0, 25).map((entry) => ({ label: entry.name, value: entry.username })));
    const row = new ActionRowBuilder().addComponents(selectMenu);
    await interaction.update(safeReplyOptions({ content: "Mau cek top gifter member yang mana?", components: [row, buildFallbackPickActionRow()] }));
    return;
  }

  // Tombol "Tutup" yang nempel LANGSUNG di menu 9-opsi (buildFallbackMenuComponents,
  // §10's thirty-fourth item, beda dari "close" di bawah yang nempel di
  // dropdown opsi 4/9) - owner minta buat kasus salah pencet/salah ketik
  // pas menu-nya baru aja muncul, dan minta perilakunya beda dari "close":
  // bukan DIEDIT jadi teks "dibatalin" (masih nyisain 1 pesan sebagai
  // jejak), tapi pesannya BENERAN DIHAPUS - dianggep kayak gak pernah ada.
  // interaction.deferUpdate() dulu (ngakuin interaksinya TANPA nampilin
  // balesan apapun), baru interaction.message.delete() - tanpa
  // deferUpdate() Discord nunjukkin "This interaction failed" ke yang
  // ngeklik walau pesannya beneran kehapus, soalnya interaksinya sendiri
  // gak pernah diakuin. .catch(() => {}) jaga-jaga kalau pesannya
  // kebetulan udah kehapus duluan (mis. diklik dua kali kepencet).
  // clearMenuShown di-require LAZY (bukan di atas file bareng require lain)
  // SENGAJA - pendingState.js sendiri require("./menu") buat resolveBareMenuChoice
  // dkk, jadi require("./pendingState") di ATAS file ini bakal bikin circular
  // require (menu.js keburu balik ngambil menu.js versi BELUM SELESAI
  // load, module.exports-nya masih kosong). Require di DALAM function
  // (dieksekusi pas beneran dipanggil, bukan pas file-nya di-load) aman
  // soalnya di titik itu proses loading dua-duanya udah lama kelar.
  if (optionId === "delete") {
    const { clearMenuShown } = require("./pendingState");
    clearMenuShown(interaction.channelId, interaction.user.id);
    await interaction.deferUpdate();
    await interaction.message.delete().catch(() => {});
    return;
  }

  // Tombol "Tutup" yang nempel di BAWAH dropdown milih member/gifter di atas
  // (opsi 4/9) - owner ngeluh gak ada cara buat batalin kalau salah pencet
  // opsi 4/9 dan gak jadi mau milih siapa-siapa (beda dari watch-confirm's
  // tombol "Tutup", yang nutup pertanyaan "mau nonton?" SETELAH member
  // kepilih - ini nutup langkah SEBELUM sempet milih sama sekali). customId-nya
  // gak bawa optionId (4 vs 9) soalnya aksinya sama persis buat dua-duanya -
  // edit pesan ini sendiri jadi teks "dibatalin", ilangin dropdown.
  if (optionId === "close") {
    await interaction.update(safeReplyOptions({ content: "Oke, dibatalin.", components: [] }));
    return;
  }

  // Tombol "Kembali" - nempel di baris yang sama kayak "Tutup" di atas, tapi
  // beda tujuan: bukan ngakhirin interaksinya, cuma balikin pesan ini ke
  // tampilan menu 9-opsi awal (replyFallbackMenu()) lagi, biar user bisa
  // pilih opsi LAIN tanpa harus nutup dulu terus manggil ulang "cok bantuan"
  // dari nol. Sama pola in-place-edit-nya kayak "close" - satu pesan yang
  // sama terus dipake bolak-balik, gak numpuk pesan baru.
  if (optionId === "back") {
    await interaction.update(safeReplyOptions(replyFallbackMenu()));
    return;
  }

  const reply = await resolveBareMenuChoice(optionId, interaction.channelId, interaction.user.id);
  if (!reply) return;

  if (typeof reply === "string") {
    await interaction.update(safeReplyOptions({ content: reply, components: buildFallbackMenuComponents() }));
    return;
  }

  // Opsi 8 (rekap hari ini) - udah bawa tombol navigasi sendiri, dipake
  // apa adanya (lihat komen di atas function ini).
  await interaction.update(safeReplyOptions(reply));
}

// Diklik abis milih member dari dropdown yang dimunculin handleFallbackMenuButton.
// Sama kayak handleFallbackMenuButton di atas, pake interaction.update() buat
// nerusin ngedit PESAN MENU yang SAMA (yang tadinya udah diedit jadi dropdown),
// bukan interaction.reply() yang bakal numpuk pesan baru lagi.
//
// BUG SEBELUMNYA: cabang "member udah keburu selesai live" (opsi 4) dan
// SELURUH cabang opsi 9 balikin STRING polos apa adanya (interaction.update
// isinya cuma content, components: undefined) - hasilnya pesan mentok TANPA
// tombol apapun, beda dari jalur lain di menu ini yang selalu nempelin balik
// buildFallbackMenuComponents() abis ngasih jawaban. User kejebak harus
// ngetik ulang "cok bantuan" dari nol buat lanjut nanya yang lain. Sekarang
// dua-duanya juga nempelin balik menu 9-opsi, sama kayak cabang string biasa
// di handleFallbackMenuButton. Cabang "member MASIH live" (opsi 4) TETEP
// apa adanya (startWatchConfirmForEntry udah bawa tombol Ya/Enggak/Tutup
// sendiri) - gak ditempelin menu lagi, sama alasannya kayak opsi 8 di
// handleFallbackMenuButton (dua sistem tombol beda konteks numpuk di 1
// pesan cuma bikin bingung).
async function handleFallbackMemberSelect(interaction) {
  const optionId = interaction.customId.split(":")[1];
  const username = interaction.values[0];

  if (optionId === "4") {
    // Langsung pake entry dari username (udah pasti bener, dari pilihan
    // dropdown) - BUKAN startWatchConfirm(entry.name, ...) yang bakal
    // nyari ulang lewat fuzzy name-match dan berpotensi (walau jarang)
    // nyangkut ke member lain yang kebetulan nama depannya mirip.
    const entry = activeLives.get(username);
    const reply = entry
      ? startWatchConfirmForEntry(entry, interaction.channelId, interaction.user.id)
      : { content: replyMemberNotFound(username), components: buildFallbackMenuComponents() };
    await interaction.update(safeReplyOptions(reply));
    return;
  }

  // username di sini dijamin ada di gifter-snapshot.json - langsung dari
  // pilihan dropdown yang dibangun getSortedGifterSnapshotMembers(), bukan
  // dari activeLives kayak sebelumnya.
  await interaction.update(safeReplyOptions({ content: replyGifterSnapshotByUsername(username), components: buildFallbackMenuComponents() }));
}

module.exports = {
  buildFallbackMenuComponents,
  replyFallbackMenu,
  resolveBareMenuChoice,
  memberPromptQuestion,
  startWatchConfirm,
  startWatchConfirmForEntry,
  tryHandleWatchConfirmShortcut,
  handleWatchConfirmButton,
  handleFallbackMenuButton,
  handleFallbackMemberSelect,
};
