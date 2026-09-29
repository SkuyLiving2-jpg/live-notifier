const { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } = require("discord.js");
const { activeLives, getSortedActiveLives, findMemberByNameFragment } = require("../storage/activeLives");
const { getSortedGifterSnapshotMembers } = require("../storage/gifterSnapshot");
const { getGreeting, describeElapsed, YES_PATTERN, NO_PATTERN, safeReplyOptions } = require("../utils");
const { deleteInteractionMessage } = require("./interactionHelpers");
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
  replyLongestNotLiveLeaderboard,
  replyAliasList,
  replyHelp,
} = require("./replies");

// "channelId:authorId" -> kapan terakhir menu fallback ditampilin buat orang
// itu. Dipake biar user bisa balas cukup ketik angkanya doang (1-9) abis
// menu-nya muncul - tapi CUMA kalau menu-nya baru aja beneran ditampilin
// duluan, biar ketik angka "mentah" tanpa konteks tetap nunjukkin menu-nya
// dulu (bukan nebak). Map ini dikelola sepenuhnya di chat/pendingState.js
// (lihat markMenuShown), file ini cuma consumer lewat resolveBareMenuChoice.

// Owner minta menu fallback (dulu 9 opsi, sekarang 12) dirombak dari "1
// layar isinya 9-12 tombol numpuk" jadi WIZARD BERHALAMAN - 3 tombol utama per halaman, plus
// "Tutup" dan "Menu lainnya" buat lanjut ke 3 opsi berikutnya. customId
// tiap opsi TETEP "fallback_menu:<id>" apa adanya (id-nya masih persis sama
// kayak dulu: "1".."9" buat 9 opsi asli, "notlive"/"aliaslist"/"more" buat 3
// yang ditambahin belakangan) - PENTING biar handleFallbackMenuButton's
// dispatcher, resolveBareMenuChoice, DAN shortcut ketik-angka mentah
// (pendingState.js's tryHandleMenuShortcut, regexnya masih ngenalin "1".."9"
// APA ADANYA) semuanya TETEP JALAN tanpa disentuh sama sekali - cuma
// SUSUNAN TAMPILANNYA yang berubah, bukan cara kerjanya.
//
// MENU_PAGES adalah SATU-SATUNYA sumber kebenaran soal "opsi mana ada di
// halaman mana" - dipake buildFallbackMenuComponents (bikin tombolnya) DAN
// pageIndexForOption (nyari balik "abis jawab opsi X, kudu balik ke halaman
// berapa" - lihat komen di situ). Urutan halaman (owner minta persis gini):
// 1) siapa yang live / cek member / rekap hari ini
// 2) paling lama live / paling rame / cek top gifter
// 3) daftar prioritas / status bot / reminder aku
// 4) (halaman TERAKHIR, cuma "Tutup" tanpa "Menu lainnya") tiga fitur
//    keyword-only yang ditambahin belakangan - paling lama GAK live / daftar
//    alias / fitur lainnya (nunjukkin replyHelp()).
const MENU_PAGES = [
  [
    { id: "1", label: "Siapa yang live", style: ButtonStyle.Primary },
    { id: "4", label: "Cek member", style: ButtonStyle.Success },
    { id: "8", label: "Rekap hari ini", style: ButtonStyle.Secondary },
  ],
  [
    { id: "3", label: "Paling lama live", style: ButtonStyle.Primary },
    { id: "5", label: "Paling rame", style: ButtonStyle.Primary },
    { id: "9", label: "Cek top gifter", style: ButtonStyle.Success },
  ],
  [
    { id: "6", label: "Daftar prioritas", style: ButtonStyle.Secondary },
    { id: "2", label: "Status bot", style: ButtonStyle.Secondary },
    { id: "7", label: "Reminder aku", style: ButtonStyle.Secondary },
  ],
  [
    { id: "notlive", label: "😴 Paling lama gak live", style: ButtonStyle.Secondary },
    { id: "aliaslist", label: "📖 Daftar alias", style: ButtonStyle.Secondary },
    { id: "more", label: "❓ Fitur lainnya", style: ButtonStyle.Primary },
  ],
];

// Tiap opsi ada di HALAMAN TETAP (lihat MENU_PAGES) - dipake abis suatu opsi
// dijawab, biar tombol menu yang ditempel-ulang balik ke halaman ASAL opsi
// itu (bukan selalu reset ke halaman 1). Tanpa ini, klik "Menu lainnya" ->
// pilih opsi -> jawaban keluar -> menu ditempel ulang dari halaman 1 lagi ->
// user kudu mencet "Menu lainnya" ULANG buat nyoba opsi lain di halaman yang
// sama - regresi UX dibanding pas semua 9-12 opsi masih numpuk 1 layar.
function pageIndexForOption(optionId) {
  const index = MENU_PAGES.findIndex((page) => page.some((opt) => opt.id === optionId));
  return index === -1 ? 0 : index;
}

// customId-nya "fallback_menu:<id>" - SAMA PERSIS skema lama, cuma sekarang
// isinya cuma 3 tombol (satu halaman doang) tiap kali dipanggil, bukan 9-12
// sekaligus. Baris kedua: "Tutup" (selalu ada, customId "fallback_menu:delete"
// - lihat handleFallbackMenuButton's "delete"/"close" buat kenapa
// perilakunya BENERAN ngehapus pesan bukan diedit jadi teks dismiss), lalu
// "⬅️ Menu sebelumnya" KECUALI di halaman PERTAMA (gak ada halaman sebelum
// itu), lalu "Menu lainnya ➡️" KECUALI di halaman TERAKHIR (owner eksplisit
// minta halaman terakhir cuma "tambahan tombol tutup", gak ada "menu
// lainnya" lagi soalnya emang gak ada halaman sesudahnya).
//
// BUG YANG DILAPORIN OWNER: dulu cuma ada "Menu lainnya" (maju doang) - user
// yang udah kepencet sampe halaman 3-4 gak ada cara balik ke halaman
// sebelumnya SELAIN nutup pesannya terus manggil ulang dari awal. Fixed
// dengan nambahin "⬅️ Menu sebelumnya" - customId-nya REUSE persis skema
// "fallback_menu:goto:<page>" yang udah ada (dipake "Menu lainnya" juga),
// cuma angkanya mundur (`safePage - 1`) bukan maju (`safePage + 1`) - gak
// perlu handler baru sama sekali di handleFallbackMenuButton, "goto" udah
// generic (pindah ke halaman manapun yang dikasih, gak peduli maju/mundur).
function buildFallbackMenuComponents(page = 0) {
  const safePage = MENU_PAGES[page] ? page : 0;
  const options = MENU_PAGES[safePage];
  const optionRow = new ActionRowBuilder().addComponents(
    options.map((opt) => new ButtonBuilder().setCustomId(`fallback_menu:${opt.id}`).setLabel(opt.label).setStyle(opt.style)),
  );

  const navButtons = [new ButtonBuilder().setCustomId("fallback_menu:delete").setLabel("Tutup").setStyle(ButtonStyle.Danger)];
  if (safePage > 0) {
    navButtons.push(
      new ButtonBuilder()
        .setCustomId(`fallback_menu:goto:${safePage - 1}`)
        .setLabel("⬅️ Menu sebelumnya")
        .setStyle(ButtonStyle.Secondary),
    );
  }
  const isLastPage = safePage === MENU_PAGES.length - 1;
  if (!isLastPage) {
    navButtons.push(
      new ButtonBuilder()
        .setCustomId(`fallback_menu:goto:${safePage + 1}`)
        .setLabel("Menu lainnya ➡️")
        .setStyle(ButtonStyle.Secondary),
    );
  }
  const navRow = new ActionRowBuilder().addComponents(navButtons);

  return [optionRow, navRow];
}

// Baris tombol "Tutup"/"Kembali" yang nempel DI BAWAH dropdown pilih
// member/gifter (opsi 4/9 di handleFallbackMenuButton) DAN di bawah
// replyHelp() (opsi "more") - StringSelectMenu/embed panjang harus sendirian
// di baris-nya, jadi ini baris terpisah yang nempel bareng. "Kembali" nyusul
// owner minta ada cara balik ke menu awal TANPA harus nutup dulu terus
// manggil ulang "cok bantuan" - beda dari "Tutup" yang beneran ngakhirin
// interaksinya. `page` (dari pageIndexForOption si opsi yang lagi dijawab)
// ikut nempel di customId-nya ("fallback_menu:back:<page>") biar "Kembali"
// balik ke HALAMAN ASAL, bukan selalu reset ke halaman 1 (sama alasannya
// kayak pageIndexForOption di atas).
function buildFallbackPickActionRow(page = 0) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("fallback_menu:close").setLabel("Tutup").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`fallback_menu:back:${page}`).setLabel("Kembali").setStyle(ButtonStyle.Secondary),
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
// `page` nentuin halaman mana yang ditampilin (default halaman pertama, lihat
// MENU_PAGES) - teksnya beda dikit per halaman: halaman pertama nyapa +
// kasih tau ada "Menu lainnya", halaman TERAKHIR (yang punya tombol "❓ Fitur
// lainnya") nyebut eksplisit biar orang tau tombol itu ngasih daftar command
// lengkap, halaman tengah cukup teks pendek.
function replyFallbackMenu(page = 0) {
  const safePage = MENU_PAGES[page] ? page : 0;
  const isLastPage = safePage === MENU_PAGES.length - 1;
  const content =
    safePage === 0
      ? `Halo, selamat ${getGreeting()}! Klik salah satu di bawah ya.`
      : isLastPage
        ? 'Menu lainnya - ada juga tombol "❓ Fitur lainnya" buat lihat command lengkapnya (gak perlu ngetik "cok bantuan" sendiri).'
        : "Menu lainnya, klik salah satu:";
  return { content, components: buildFallbackMenuComponents(safePage) };
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
      // BUG YANG DILAPORIN OWNER: tabel yang keluar dari opsi ini gak punya
      // jalan balik ke menu fallback ini sendiri - "fallback" (dibaca
      // replies.js's buildRecapNavComponents/buildBackRow) nempelin tombol
      // "🔙 Kembali ke menu" yang balik ke replyFallbackMenu() persis di
      // sini. Berlaku baik diklik lewat tombol MAUPUN diketik lewat shortcut
      // angka "8" abis menu ini ditampilin (chat/pendingState.js) - dua-duanya
      // manggil resolveBareMenuChoice yang sama ini.
      return await replyTodayRecapSoFar(channelId, authorId, "fallback");
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

  // §10's thirty-fifth item - dulu diedit jadi teks "Oke, dibatalin." +
  // components:[], sekarang BENERAN ngehapus pesannya (deleteInteractionMessage,
  // sama logika "tutup" yang dipake konsisten di seluruh bot sekarang), biar
  // gak nyisain jejak pesan buat kasus salah pencet member dari dropdown.
  if (action === "close") {
    await deleteInteractionMessage(interaction);
    return;
  }

  // Re-cek status live-nya SEKARANG (bukan pas tombolnya ditampilin) - bisa
  // aja membernya udah selesai live selagi user mikir mau klik apa nggak.
  // Nama-nya diambil dari activeLives kalau masih ada (paling akurat), kalau
  // udah nggak ada fallback ke nama yang sempet kesimpen di pendingWatchConfirm
  // (bisa aja kosong kalau udah lewat TTL-nya/gak ada - fallback terakhir
  // "member ini" biar tetep ada balesan, bukan "undefined").
  //
  // BUG SEBELUMNYA: fallback-nya dulu `pending?.name` polos, TANPA ngecek
  // pending itu beneran soal MEMBER YANG SAMA kayak tombol yang diklik.
  // pendingWatchConfirm di-key per channel+author doang (bukan per pesan) -
  // jadi kalau user nanya "4 nala" (pesan A, tombol carry "jkt48_nala") terus
  // SEBELUM dijawab nanya lagi "4 levi" (pesan B), pending-nya ke-TIMPA jadi
  // punya Levi. Kalau nala keburu selesai live duluan terus user BALIK ke
  // pesan A (yang lama) dan mencet tombolnya, `entry` bakal null (nala
  // beneran udah nggak live) dan fallback-nya salah ngasih nama "Levi" -
  // padahal yang diklik jelas-jelas tombol punya Nala. Sekarang pending cuma
  // dipercaya sebagai fallback nama kalau `pending.username` masih COCOK sama
  // username yang dibawa customId tombol yang beneran diklik.
  const entry = activeLives.get(username);
  const pendingName = pending?.username === username ? pending.name : null;
  const name = entry?.name || pendingName || "member ini";

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
// tiap kali mencet tombol yang beda-beda di menu ini, jawabannya numpuk jadi
// pesan baru satu-satu, sama persis keluhan yang dulu diomongin soal tabel
// rekap (lihat handleRecapNavButton). Konsekuensinya: langkah dropdown milih
// member/gifter (opsi 4/9, di bawah) yang DULU ephemeral (cuma keliatan
// orang yang mimic) sekarang ikutan jadi publik juga - gak ada cara nge-edit
// pesan publik jadi ephemeral, dan mengedit pesan yang sama itu justru
// intinya di sini, bukan bug. Opsi 1/2/3/5/6/7/9(kosong)/4(kosong) balikin
// STRING polos (gak ada tombol sendiri) - buildFallbackMenuComponents(pageIndexForOption(...))
// ditempelin ULANG di bawahnya (di HALAMAN ASAL opsi itu, bukan selalu
// halaman 1) biar user bisa lanjut mencet opsi LAIN dari pesan yang sama,
// gak perlu manggil ulang "cok bantuan". Opsi 8 (rekap hari ini) BEDA -
// baliknya udah bawa tombol navigasi rekap sendiri (Maju/Mundur/Tutup
// rekap/Cari member), jadi dipake apa adanya tanpa ditempelin menu lagi
// (nge-gabung 2 sistem tombol beda konteks di 1 pesan cuma bikin bingung).
async function handleFallbackMenuButton(interaction) {
  const parts = interaction.customId.split(":");
  const optionId = parts[1];

  // Tombol "Menu lainnya ➡️" (lihat buildFallbackMenuComponents) - customId-nya
  // bawa LANGSUNG nomor halaman tujuan ("fallback_menu:goto:<page>"), jadi
  // gak butuh state tersimpan di server buat "lagi di halaman berapa" -
  // sama pola self-contained-nya kayak recap_nav's tombol Maju/Mundur.
  if (optionId === "goto") {
    const targetPage = Number(parts[2]) || 0;
    await interaction.update(safeReplyOptions(replyFallbackMenu(targetPage)));
    return;
  }

  // Opsi 4 (cek member) HARUS dari activeLives (nanya "masih live gak?"
  // cuma masuk akal buat yang emang lagi live). Opsi 9 (gifter) BEDA -
  // datanya snapshot yang independen dari status live sekarang, jadi
  // sumber dropdown-nya juga beda (lihat getSortedGifterSnapshotMembers).
  if (optionId === "4") {
    const sorted = getSortedActiveLives();
    if (sorted.length === 0) {
      await interaction.update(safeReplyOptions({ content: replyListLive(), components: buildFallbackMenuComponents(pageIndexForOption(optionId)) }));
      return;
    }

    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId("fallback_select:4")
      .setPlaceholder("Pilih member...")
      .addOptions(sorted.slice(0, 25).map((entry) => ({ label: entry.name, value: entry.username })));
    const row = new ActionRowBuilder().addComponents(selectMenu);
    await interaction.update(
      safeReplyOptions({ content: "Mau cek member yang mana?", components: [row, buildFallbackPickActionRow(pageIndexForOption(optionId))] }),
    );
    return;
  }

  if (optionId === "9") {
    const sorted = getSortedGifterSnapshotMembers();
    if (sorted.length === 0) {
      await interaction.update(
        safeReplyOptions({
          content: 'Cok, belum ada data top gifter buat siapapun. Yang pegang akun IDN-nya bisa jalanin "npm run cek-gifter" dulu biar ke-update.',
          components: buildFallbackMenuComponents(pageIndexForOption(optionId)),
        }),
      );
      return;
    }

    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId("fallback_select:9")
      .setPlaceholder("Pilih member...")
      .addOptions(sorted.slice(0, 25).map((entry) => ({ label: entry.name, value: entry.username })));
    const row = new ActionRowBuilder().addComponents(selectMenu);
    await interaction.update(
      safeReplyOptions({
        content: "Mau cek top gifter member yang mana?",
        components: [row, buildFallbackPickActionRow(pageIndexForOption(optionId))],
      }),
    );
    return;
  }

  // Halaman terakhir (owner minta, biar fitur-fitur baru yang masih
  // keyword-only kekenal user baru - lihat komen panjang di MENU_PAGES).
  // "notlive"/"aliaslist" gak butuh nama/parameter apapun, jadi langsung
  // jawab di tempat - SAMA POLA persis kayak opsi 1/2/3/5/6/7 (balikin
  // STRING polos, buildFallbackMenuComponents() ditempelin ULANG biar bisa
  // lanjut pencet opsi lain dari halaman yang sama).
  if (optionId === "notlive") {
    await interaction.update(
      safeReplyOptions({ content: replyLongestNotLiveLeaderboard(), components: buildFallbackMenuComponents(pageIndexForOption(optionId)) }),
    );
    return;
  }
  if (optionId === "aliaslist") {
    await interaction.update(safeReplyOptions({ content: replyAliasList(), components: buildFallbackMenuComponents(pageIndexForOption(optionId)) }));
    return;
  }

  // "❓ Fitur lainnya" - nunjukkin replyHelp() (daftar LENGKAP semua command,
  // termasuk yang butuh nama kayak "cok streak <nama>"/"cok bandingin A, B,
  // dan C"/"cok tambah alias", yang gak mungkin dikasih tombol langsung
  // tanpa nanya nama dulu) di tempat yang sama - reuse buildFallbackPickActionRow()
  // (Tutup + Kembali) SAMA PERSIS kayak baris di bawah dropdown opsi 4/9,
  // biar user bisa balik ke menu lagi abis baca, bukan kejebak. replyHelp()
  // sekarang balikin OBJECT ({content, embeds}) bukan string polos lagi
  // (lihat komennya di replies.js) - {...helpReply} nge-spread content DAN
  // embeds-nya, components-nya ditimpa/ditambahin di sini.
  if (optionId === "more") {
    const helpReply = replyHelp();
    await interaction.update(safeReplyOptions({ ...helpReply, components: [buildFallbackPickActionRow(pageIndexForOption(optionId))] }));
    return;
  }

  // Tombol "Tutup" - DUA tempat beda nempelinnya (mismatch customId sengaja
  // dipertahanin buat jejak/logging, tapi PERILAKUNYA sekarang IDENTIK, lihat
  // §10's thirty-fifth item):
  // - "fallback_menu:delete" - nempel LANGSUNG di menu fallback (buildFallbackMenuComponents,
  //   §10's thirty-fourth item), buat kasus salah pencet/salah ketik pas
  //   menu-nya baru aja muncul.
  // - "fallback_menu:close" - nempel di BAWAH dropdown milih member/gifter
  //   (opsi 4/9, buildFallbackPickActionRow), buat kasus salah pencet opsi
  //   4/9 dan gak jadi mau milih siapa-siapa (beda dari watch-confirm's
  //   tombol "Tutup" sendiri, yang nutup pertanyaan "mau nonton?" SETELAH
  //   member kepilih - dua-duanya sekarang sama-sama ngehapus pesan juga,
  //   lihat handleWatchConfirmButton, cuma beda di function/state yang
  //   dibersihin).
  // Dua-duanya sama-sama ngakhirin SELURUH flow menu ini (bukan cuma satu
  // langkah), jadi dua-duanya juga clearMenuShown - biar angka mentah yang
  // ke-ketik abis pesannya kehapus gak ketangkep sebagai "lanjutan" menu
  // yang udah gak ada lagi. clearMenuShown di-require LAZY (bukan di atas
  // file bareng require lain) SENGAJA - pendingState.js sendiri
  // require("./menu") buat resolveBareMenuChoice dkk, jadi
  // require("./pendingState") di ATAS file ini bakal bikin circular require
  // (menu.js keburu balik ngambil menu.js versi BELUM SELESAI load,
  // module.exports-nya masih kosong). Require di DALAM function (dieksekusi
  // pas beneran dipanggil, bukan pas file-nya di-load) aman soalnya di
  // titik itu proses loading dua-duanya udah lama kelar.
  if (optionId === "delete" || optionId === "close") {
    const { clearMenuShown } = require("./pendingState");
    clearMenuShown(interaction.channelId, interaction.user.id);
    await deleteInteractionMessage(interaction);
    return;
  }

  // Tombol "Kembali" - nempel di baris yang sama kayak "Tutup" di atas, tapi
  // beda tujuan: bukan ngakhirin interaksinya, cuma balikin pesan ini ke
  // tampilan menu (replyFallbackMenu()) lagi, biar user bisa pilih opsi LAIN
  // tanpa harus nutup dulu terus manggil ulang "cok bantuan" dari nol. Sama
  // pola in-place-edit-nya kayak "close" - satu pesan yang sama terus dipake
  // bolak-balik, gak numpuk pesan baru. Halaman tujuannya dari customId
  // ("fallback_menu:back:<page>", lihat buildFallbackPickActionRow) - balik
  // ke HALAMAN ASAL opsi yang tadi diklik, bukan selalu direset ke halaman 1.
  if (optionId === "back") {
    const page = Number(parts[2]) || 0;
    await interaction.update(safeReplyOptions(replyFallbackMenu(page)));
    return;
  }

  const reply = await resolveBareMenuChoice(optionId, interaction.channelId, interaction.user.id);
  if (!reply) return;

  if (typeof reply === "string") {
    await interaction.update(safeReplyOptions({ content: reply, components: buildFallbackMenuComponents(pageIndexForOption(optionId)) }));
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
// dua-duanya juga nempelin balik menu fallback, sama kayak cabang string biasa
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
      : { content: replyMemberNotFound(username), components: buildFallbackMenuComponents(pageIndexForOption(optionId)) };
    await interaction.update(safeReplyOptions(reply));
    return;
  }

  // username di sini dijamin ada di gifter-snapshot.json - langsung dari
  // pilihan dropdown yang dibangun getSortedGifterSnapshotMembers(), bukan
  // dari activeLives kayak sebelumnya.
  await interaction.update(
    safeReplyOptions({ content: replyGifterSnapshotByUsername(username), components: buildFallbackMenuComponents(pageIndexForOption(optionId)) }),
  );
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
