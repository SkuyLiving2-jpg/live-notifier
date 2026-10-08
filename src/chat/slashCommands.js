// Slash command ("/") native Discord - PELENGKAP command teks "cok ..." yang
// udah ada (chat/router.js), BUKAN gantiin. Owner minta ini (§10's "line
// count iseng" batch, saran fitur ke-1) biar pengalaman user lebih maksimal
// (autocomplete nama member, validasi argumen dari Discord sendiri, muncul
// di command picker "/" tanpa perlu apal syntax "cok ...").
//
// PRINSIP DESAIN UTAMA: setiap handler slash command di sini SEDAPAT
// MUNGKIN cuma manggil fungsi reply/handle yang UDAH ADA di replies.js
// (yang sama persis dipake command teks, dan udah puluhan test-nya) -
// hampir gak ada logic BARU yang ditulis di sini, cuma "ekstrak opsi dari
// interaction, panggil fungsi yang sama, relay hasilnya". Ini KEPUTUSAN
// KEAMANAN eksplisit (owner nanya "apakah berbahaya"), bukan cuma soal
// males nulis ulang: command yang khusus-owner (tambah/hapus alias/prioritas)
// ngecek `isOwner()` DI DALAM fungsi replies.js yang dipanggil, jadi gak ada
// cara buat lupa masang gate itu di sisi slash command - gate-nya bukan
// duplikasi yang bisa divergen, dia struktural nempel di fungsi yang sama
// yang udah dipercaya buat jalur teks.
//
// customId-nya sendiri (fallback_menu:, recap_nav:, dst) TETEP dispatch
// lewat button/select-menu interaction seperti biasa - modul ini CUMA
// nangenin interaction.isChatInputCommand()/isAutocomplete(), dua kelas
// interaction yang beda sama sekali dari yang udah ada.
const { SlashCommandBuilder, MessageFlags } = require("discord.js");
const { activeLives, findMemberByNameFragment } = require("../storage/activeLives");
const { loadLiveCount } = require("../storage/liveCount");
const { formatRelativeTime, formatDuration, safeReplyOptions, getTodayWIB } = require("../utils");
const { withCloseButton } = require("./interactionHelpers");
const {
  replyListLive,
  replyBotStatus,
  replyHelp,
  replyPriorityList,
  replyMySubscriptions,
  replyAliasList,
  replyLiveCountLeaderboard,
  replyLongestNotLiveLeaderboard,
  replySpecificMember,
  replyMemberNotFound,
  replyMemberStats,
  replyStreak,
  replySchedulePattern,
  replyGifterSnapshot,
  replyLiveCount,
  handleSubscribe,
  handleUnsubscribe,
  handleAddPriority,
  handleRemovePriority,
  handleRemoveAlias,
  handleAddAlias,
  resolveStatRangeFromText,
  replyLongestLive,
  replyLongestLiveForRange,
  replyTopViewers,
  replyTopViewersForRange,
  replyExportRecap,
  replyCompareMembers,
  replyCompareMembersMulti,
  replyTodayRecapSoFar,
  replyRecapRange,
  replyRecapMonth,
  replyRecapMember,
  replyRecapMenu,
} = require("./replies");
const { findDurationHistoryByNameFragment } = require("../storage/durationHistory");
const { replyDurationChart } = require("./chartReply");
const { replyViewerChart } = require("./viewerChart");
const { replyWrapped } = require("./wrappedCard");
const personal = require("./personalFlow");
const guess = require("./guessFlow");

// Dipake HAMPIR di semua command yang butuh nama member - satu helper biar
// deskripsi/nama opsi-nya konsisten di semua command, gak ketik ulang
// berkali-kali. `setAutocomplete(true)` yang bikin Discord manggil
// handleSlashAutocomplete di bawah tiap user ngetik di opsi ini.
function addMemberOption(builder, { name = "member", description = "Nama member (ketik buat liat saran)", required = true } = {}) {
  return builder.addStringOption((opt) => opt.setName(name).setDescription(description).setRequired(required).setAutocomplete(true));
}

function addRangeOption(builder) {
  return builder.addStringOption((opt) =>
    opt.setName("rentang").setDescription('Opsional - "minggu ini"/"bulan ini"/nama bulan/tanggal (kosongin buat hari ini)').setRequired(false),
  );
}

// "/cek member:<...>" - versi slash dari ngetik nama member polos di chat.
// SENGAJA gak reuse buildChatReply(text) kayak beberapa command laen di
// bawah (compare/export) - kalau fragment-nya gak match APAPUN,
// buildChatReply bakal jatuh ke MENU FALLBACK 9-opsi generik, yang gak
// masuk akal buat konteks slash command (user manggil "/cek", ngarepin
// jawaban langsung soal 1 member, bukan menu tombol lain). Jadi logic
// 3-tingkatnya (live sekarang -> pernah live tapi lagi nggak -> gak
// dikenal) ditulis eksplisit di sini, sama persis kayak router.js's
// fallback chain (findMemberByNameFragment -> findDurationHistoryByNameFragment
// -> replyMemberNotFound) - satu-satunya bagian file ini yang beneran
// nge-duplikasi logic dispatch, karena keduanya (chat teks vs slash) butuh
// PERILAKU AKHIR yang beda kalau gagal match.
function replyCekMember(fragment) {
  const entry = findMemberByNameFragment(fragment);
  if (entry) return replySpecificMember(entry);

  const historyMatch = findDurationHistoryByNameFragment(fragment);
  if (historyMatch && historyMatch.entries.length > 0) {
    const last = historyMatch.entries[historyMatch.entries.length - 1];
    return `Cok, **${historyMatch.displayName}** lagi nggak live sekarang. Terakhir live ${formatRelativeTime(new Date(last.at))}, durasinya ${formatDuration(last.durationMs)}.`;
  }

  return replyMemberNotFound(fragment);
}

// Daftar SATU-SATUNYA sumber kebenaran: tiap entry { builder, handler }.
// `builder` dipake scripts/register-slash-commands.js (lewat getCommandDefinitions().map(d => d.builder.toJSON())),
// `handler` dipake handleSlashCommand di bawah - keduanya SELALU sinkron
// (gak mungkin ada command yang ke-daftar tapi handler-nya lupa ditulis,
// atau sebaliknya) karena satu array yang sama dipake dua-duanya.
const BASE_COMMAND_DEFINITIONS = [
  {
    builder: new SlashCommandBuilder().setName("live").setDescription("Lihat member JKT48 yang lagi live sekarang"),
    handler: async () => replyListLive(),
  },
  {
    builder: new SlashCommandBuilder().setName("status").setDescription("Cek status bot"),
    handler: async () => replyBotStatus(),
  },
  {
    builder: new SlashCommandBuilder().setName("bantuan").setDescription("Daftar lengkap command yang bot ini bisa jawab"),
    handler: async () => replyHelp(),
  },
  {
    builder: addMemberOption(new SlashCommandBuilder().setName("cek").setDescription("Cek status live 1 member (live sekarang/terakhir kapan)")),
    handler: async (interaction) => replyCekMember(interaction.options.getString("member", true)),
  },
  {
    builder: addMemberOption(new SlashCommandBuilder().setName("stats").setDescription("Statistik durasi live 1 member (rata-rata & rekor)")),
    handler: async (interaction) => replyMemberStats(interaction.options.getString("member", true)),
  },
  {
    builder: addMemberOption(new SlashCommandBuilder().setName("streak").setDescription("Lagi live berapa hari berturut-turut")),
    handler: async (interaction) => replyStreak(interaction.options.getString("member", true)),
  },
  {
    builder: addMemberOption(new SlashCommandBuilder().setName("grafik").setDescription("Bar chart durasi live 10 sesi terakhir (gambar)")),
    handler: async (interaction) => replyDurationChart(interaction.options.getString("member", true)),
  },
  {
    builder: addMemberOption(new SlashCommandBuilder().setName("jadwal").setDescription("Pola jam/hari biasanya dia live (dari histori)")),
    handler: async (interaction) => replySchedulePattern(interaction.options.getString("member", true)),
  },
  {
    builder: addMemberOption(new SlashCommandBuilder().setName("gifter").setDescription("Top gifter member itu (snapshot terakhir)")),
    handler: async (interaction) => replyGifterSnapshot(interaction.options.getString("member", true)),
  },
  {
    builder: addMemberOption(new SlashCommandBuilder().setName("berapa-kali").setDescription("Total berapa kali member itu udah live")),
    handler: async (interaction) => replyLiveCount(interaction.options.getString("member", true)),
  },
  {
    builder: new SlashCommandBuilder().setName("paling-sering").setDescription("Leaderboard total live count semua member"),
    handler: async () => replyLiveCountLeaderboard(),
  },
  {
    builder: new SlashCommandBuilder().setName("paling-jarang").setDescription("Member yang UDAH LAMA gak live (leaderboard kebalikan)"),
    handler: async () => replyLongestNotLiveLeaderboard(),
  },
  {
    // rentang OPSIONAL - kosong -> "hari ini" (replyLongestLive/replyTopViewers
    // polos), diisi -> resolveStatRangeFromText yang SAMA persis dipake
    // command teks "cok paling lama live minggu ini" dkk (§10's fortieth
    // item), gak nulis ulang parser rentang.
    builder: addRangeOption(new SlashCommandBuilder().setName("paling-lama").setDescription("Member dengan durasi 1 sesi live terpanjang")),
    handler: async (interaction) => {
      const rentang = interaction.options.getString("rentang");
      const range = rentang ? resolveStatRangeFromText(rentang) : null;
      return range ? replyLongestLiveForRange(range.rangeDays, range.label) : replyLongestLive();
    },
  },
  {
    builder: addRangeOption(new SlashCommandBuilder().setName("paling-rame").setDescription("Member dengan penonton terbanyak")),
    handler: async (interaction) => {
      const rentang = interaction.options.getString("rentang");
      const range = rentang ? resolveStatRangeFromText(rentang) : null;
      return range ? replyTopViewersForRange(range.rangeDays, range.label) : replyTopViewers();
    },
  },
  {
    builder: addRangeOption(new SlashCommandBuilder().setName("export-rekap").setDescription("Export rekap live jadi file CSV")),
    handler: async (interaction) => replyExportRecap(interaction.options.getString("rentang") || ""),
  },
  {
    builder: (() => {
      const b = new SlashCommandBuilder().setName("bandingin").setDescription("Bandingin 2-5 member sekaligus");
      addMemberOption(b, { name: "member1", description: "Member pertama" });
      addMemberOption(b, { name: "member2", description: "Member kedua" });
      addMemberOption(b, { name: "member3", description: "Member ketiga (opsional)", required: false });
      addMemberOption(b, { name: "member4", description: "Member keempat (opsional)", required: false });
      addMemberOption(b, { name: "member5", description: "Member kelima (opsional)", required: false });
      return b;
    })(),
    handler: async (interaction) => {
      const fragments = ["member1", "member2", "member3", "member4", "member5"].map((name) => interaction.options.getString(name)).filter(Boolean);
      return fragments.length === 2 ? replyCompareMembers(fragments[0], fragments[1]) : replyCompareMembersMulti(fragments);
    },
  },
  {
    builder: new SlashCommandBuilder().setName("prioritas").setDescription("Lihat daftar member prioritas"),
    handler: async () => replyPriorityList(),
  },
  {
    builder: addMemberOption(new SlashCommandBuilder().setName("tambah-prioritas").setDescription("(khusus owner) Tambah member prioritas")),
    handler: async (interaction) => handleAddPriority(interaction.options.getString("member", true), interaction.user.id),
  },
  {
    builder: addMemberOption(new SlashCommandBuilder().setName("hapus-prioritas").setDescription("(khusus owner) Hapus member prioritas custom")),
    handler: async (interaction) => handleRemovePriority(interaction.options.getString("member", true), interaction.user.id),
  },
  {
    builder: new SlashCommandBuilder().setName("daftar-alias").setDescription("Lihat panggilan/nickname yang udah kedaftar"),
    handler: async () => replyAliasList(),
  },
  {
    builder: new SlashCommandBuilder()
      .setName("tambah-alias")
      .setDescription("(khusus owner) Tambah alias/panggilan buat 1 member")
      .addStringOption((opt) => opt.setName("alias").setDescription("Alias/panggilan barunya").setRequired(true))
      .addStringOption((opt) => opt.setName("target").setDescription("Nama asli member yang dituju").setRequired(true).setAutocomplete(true)),
    handler: async (interaction) =>
      handleAddAlias(interaction.options.getString("alias", true), interaction.options.getString("target", true), interaction.user.id),
  },
  {
    builder: new SlashCommandBuilder()
      .setName("hapus-alias")
      .setDescription("(khusus owner) Hapus 1 alias")
      .addStringOption((opt) => opt.setName("alias").setDescription("Alias yang mau dihapus").setRequired(true)),
    handler: async (interaction) => handleRemoveAlias(interaction.options.getString("alias", true), interaction.user.id),
  },
  {
    builder: addMemberOption(new SlashCommandBuilder().setName("ingetin").setDescription("Di-tag kalau member itu mulai live")),
    handler: async (interaction) => handleSubscribe(interaction.options.getString("member", true), interaction.user.id),
  },
  {
    builder: addMemberOption(new SlashCommandBuilder().setName("berhenti-ingetin").setDescription("Matiin reminder buat member itu")),
    handler: async (interaction) => handleUnsubscribe(interaction.options.getString("member", true), interaction.user.id),
  },
  {
    builder: new SlashCommandBuilder().setName("reminder-aku").setDescription("Lihat kamu subscribe reminder siapa aja"),
    handler: async (interaction) => replyMySubscriptions(interaction.user.id),
  },
  {
    builder: new SlashCommandBuilder()
      .setName("rekap")
      .setDescription("Rekap live yang udah selesai")
      .addSubcommand((sub) => sub.setName("hari-ini").setDescription("Rekap hari ini"))
      .addSubcommand((sub) => sub.setName("minggu-ini").setDescription("Rekap minggu ini (7 hari terakhir)"))
      .addSubcommand((sub) => sub.setName("bulan-ini").setDescription("Rekap bulan ini"))
      .addSubcommand((sub) => addMemberOption(sub.setName("member").setDescription("Rekap semua sesi live 1 member (35 hari terakhir)")))
      .addSubcommand((sub) => sub.setName("menu").setDescription("Menu pilihan rekap (per tanggal/bulan lain/dst)")),
    handler: async (interaction) => {
      const sub = interaction.options.getSubcommand();
      const channelId = interaction.channelId;
      const authorId = interaction.user.id;
      if (sub === "hari-ini") return replyTodayRecapSoFar(channelId, authorId);
      if (sub === "minggu-ini") return replyRecapRange(7, "minggu ini", channelId, authorId);
      if (sub === "bulan-ini") return replyRecapMonth(getTodayWIB().slice(0, 7), channelId, authorId);
      if (sub === "member") return replyRecapMember(interaction.options.getString("member", true), channelId, authorId);
      // "menu" (default/fallback) - replyRecapMenu() sendiri udah bawa tombol
      // (hari ini/minggu ini/bulan ini/per tanggal/rekap member), jadi
      // subcommand-subcommand rentang lain yang SENGAJA belum dibikinin slash
      // command sendiri (per tanggal spesifik, nama bulan lain, nama hari)
      // tetep KEJANGKAU dari sini secara interaktif - bukan celah, jalan
      // pintas.
      return replyRecapMenu();
    },
  },
];

// Command PERSONAL & fitur baru. `ephemeral: true` = jawabannya cuma kelihatan oleh
// pemakainya (deferReply ephemeral di handleSlashCommand) - cocok buat profil oshi,
// pengaturan, kelewat, dan tebakan yang gak perlu ngotorin channel. Wrapped & grafik
// penonton sengaja publik (gambarnya enak dibagikan). Sama seperti command lain di atas:
// handler cuma manggil fungsi yang SAMA dengan versi teks ("cok oshi ...", dst).
const PERSONAL_COMMAND_DEFINITIONS = [
  {
    ephemeral: true,
    builder: new SlashCommandBuilder()
      .setName("oshi")
      .setDescription("Member favoritmu: profil, tambah, hapus")
      .addSubcommand((sub) => sub.setName("lihat").setDescription("Profil singkat semua oshi kamu"))
      .addSubcommand((sub) => addMemberOption(sub.setName("tambah").setDescription("Jadikan member sebagai oshi (maks 5)")))
      .addSubcommand((sub) => addMemberOption(sub.setName("hapus").setDescription("Hapus member dari oshi kamu"))),
    handler: async (interaction) => {
      const sub = interaction.options.getSubcommand();
      const userId = interaction.user.id;
      if (sub === "tambah") return personal.handleAddOshi(interaction.options.getString("member", true), userId);
      if (sub === "hapus") return personal.handleRemoveOshi(interaction.options.getString("member", true), userId);
      return personal.replyOshiProfile(userId);
    },
  },
  {
    ephemeral: true,
    builder: new SlashCommandBuilder()
      .setName("kelewat")
      .setDescription("Siapa aja yang live sejak terakhir kamu aktif")
      .addIntegerOption((opt) =>
        opt.setName("jam").setDescription("Opsional - lihat N jam terakhir (1-720)").setMinValue(1).setMaxValue(720).setRequired(false),
      ),
    handler: async (interaction) => {
      const hours = interaction.options.getInteger("jam");
      return personal.buildCatchup(interaction.user.id, hours ? `${hours} jam` : "");
    },
  },
  {
    ephemeral: true,
    builder: new SlashCommandBuilder()
      .setName("pengaturan")
      .setDescription("Atur notifmu: lewat DM/tag, jam tenang, ringkasan mingguan")
      .addSubcommand((sub) => sub.setName("lihat").setDescription("Lihat pengaturanmu sekarang"))
      .addSubcommand((sub) =>
        sub
          .setName("notif")
          .setDescription("Member yang kamu ingetin dikabari lewat apa")
          .addStringOption((opt) =>
            opt
              .setName("cara")
              .setDescription("DM atau di-tag di channel")
              .setRequired(true)
              .addChoices({ name: "Lewat DM", value: "dm" }, { name: "Di-tag di channel", value: "tag" }),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("jam-tenang")
          .setDescription("Gak di-tag/di-DM di rentang jam ini (WIB)")
          .addIntegerOption((opt) => opt.setName("mulai").setDescription("Jam mulai (0-23)").setMinValue(0).setMaxValue(23).setRequired(true))
          .addIntegerOption((opt) => opt.setName("selesai").setDescription("Jam selesai (0-23)").setMinValue(0).setMaxValue(23).setRequired(true)),
      )
      .addSubcommand((sub) => sub.setName("jam-tenang-mati").setDescription("Matiin jam tenang"))
      .addSubcommand((sub) =>
        sub
          .setName("ringkasan")
          .setDescription("Ringkasan mingguan oshi lewat DM")
          .addStringOption((opt) =>
            opt
              .setName("status")
              .setDescription("Hidup atau mati")
              .setRequired(true)
              .addChoices({ name: "Hidup", value: "hidup" }, { name: "Mati", value: "mati" }),
          ),
      ),
    handler: async (interaction) => {
      const sub = interaction.options.getSubcommand();
      const userId = interaction.user.id;
      if (sub === "notif") return personal.handleSetDelivery(interaction.options.getString("cara", true), userId);
      if (sub === "jam-tenang") {
        return personal.handleSetQuietHours(interaction.options.getInteger("mulai", true), interaction.options.getInteger("selesai", true), userId);
      }
      if (sub === "jam-tenang-mati") return personal.handleClearQuietHours(userId);
      if (sub === "ringkasan") return personal.handleSetDigest(interaction.options.getString("status", true) === "hidup", userId);
      return personal.replySettings(userId);
    },
  },
  {
    ephemeral: true,
    builder: new SlashCommandBuilder()
      .setName("tebak")
      .setDescription("Mini-game tebak-tebakan (durasi live / siapa live berikutnya)")
      .addSubcommand((sub) =>
        addMemberOption(
          sub.setName("durasi").setDescription("Tebak berapa lama member yang lagi live bakal live (15 menit pertama)"),
        ).addIntegerOption((opt) => opt.setName("menit").setDescription("Tebakan durasi (menit)").setMinValue(1).setMaxValue(720).setRequired(true)),
      )
      .addSubcommand((sub) => addMemberOption(sub.setName("berikutnya").setDescription("Tebak siapa yang bakal mulai live berikutnya")))
      .addSubcommand((sub) => sub.setName("lihat").setDescription("Ronde yang lagi buka + cara main"))
      .addSubcommand((sub) => sub.setName("papan").setDescription("Papan skor tebak-tebakan")),
    handler: async (interaction) => {
      const sub = interaction.options.getSubcommand();
      const userId = interaction.user.id;
      if (sub === "durasi")
        return guess.handleDurationGuess(
          interaction.options.getString("member", true),
          String(interaction.options.getInteger("menit", true)),
          userId,
        );
      if (sub === "berikutnya") return guess.handleNextGuess(interaction.options.getString("member", true), userId);
      if (sub === "papan") return guess.replyScoreboard(userId);
      return guess.replyGuessOverview(userId);
    },
  },
  {
    builder: new SlashCommandBuilder()
      .setName("wrapped")
      .setDescription("Kartu rangkuman 30 hari terakhir (semua member atau satu member)")
      .addStringOption((opt) =>
        opt.setName("member").setDescription("Opsional - kosongin buat semua member").setRequired(false).setAutocomplete(true),
      ),
    handler: async (interaction) => replyWrapped(interaction.options.getString("member") || ""),
  },
  {
    builder: addMemberOption(new SlashCommandBuilder().setName("grafik-penonton").setDescription("Kurva jumlah penonton selama live (gambar)")),
    handler: async (interaction) => replyViewerChart(interaction.options.getString("member", true)),
  },
];

const COMMAND_DEFINITIONS = [...BASE_COMMAND_DEFINITIONS, ...PERSONAL_COMMAND_DEFINITIONS];

// Command yang jawabannya cuma boleh kelihatan oleh pemakainya.
const EPHEMERAL_COMMANDS = new Set(COMMAND_DEFINITIONS.filter((def) => def.ephemeral).map((def) => def.builder.name));

// Peta nama command -> handler, dibangun SEKALI dari COMMAND_DEFINITIONS
// (bukan ditulis dobel) - dipake handleSlashCommand di bawah buat lookup
// O(1) per interaction.
const HANDLERS_BY_NAME = new Map(COMMAND_DEFINITIONS.map((def) => [def.builder.name, def.handler]));

// Dipake scripts/register-slash-commands.js buat PUT ke Discord API - JSON
// polos (SlashCommandBuilder#toJSON()), bukan instance builder-nya sendiri.
function getCommandDefinitionsJSON() {
  return COMMAND_DEFINITIONS.map((def) => def.builder.toJSON());
}

// Dipanggil chat/router.js's interactionCreate pas interaction.isChatInputCommand().
// Dibungkus try/catch SENDIRI (bukan cuma ngandelin try/catch besar di
// wireDiscordEvents) - kalau salah satu handler di atas throw (mis. network
// ke IDN gagal total, bukan ditangani di dalem fungsinya), user tetep dapet
// balesan yang jelas, bukan "This interaction failed" generik dari Discord
// tanpa penjelasan.
async function handleSlashCommand(interaction) {
  const handler = HANDLERS_BY_NAME.get(interaction.commandName);
  if (!handler) {
    await interaction.reply(
      safeReplyOptions("Cok, command ini belum dikenalin bot - mungkin belum di-deploy ulang (`npm run register-slash-commands`)."),
    );
    return;
  }

  // deferReply() DULUAN: Discord cuma nunggu 3 detik buat balesan pertama,
  // sementara beberapa handler nunggu IDN (timeout 2 detik, mis. /bandingin
  // narik avatar, /tambah-alias validasi target) - ditambah latensi Discord,
  // bisa lewat batas dan user dapet "The application did not respond".
  // Abis defer, batasnya jadi 15 menit, jawabannya diisi lewat editReply().
  // Command personal dijawab ephemeral (cuma kelihatan pemakainya, bisa di-"Dismiss" sendiri);
  // sisanya publik, jadi dikasih tombol "Tutup" yang beneran ngehapus pesannya (sama kayak
  // balasan chat teks) biar channel gak numpuk. withCloseButton gak nambah apa-apa kalau
  // balasannya udah punya tombol sendiri (rekap/grafik/menu punya "Tutup"-nya masing-masing).
  // Ephemeral SENGAJA gak dikasih: bot gak bisa menghapus pesan ephemeral, tombolnya bakal mati.
  const isEphemeral = EPHEMERAL_COMMANDS.has(interaction.commandName);
  const finalize = (reply) => safeReplyOptions(isEphemeral ? reply : withCloseButton(reply));

  try {
    await interaction.deferReply(isEphemeral ? { flags: MessageFlags.Ephemeral } : undefined);
    const reply = await handler(interaction);
    await interaction.editReply(finalize(reply));
  } catch (error) {
    console.error(`Gagal jalanin slash command "/${interaction.commandName}":`, error.message, error.stack);
    const content = "Cok, ada error pas ngejalanin command ini. Coba lagi bentar ya.";
    if (interaction.replied || interaction.deferred) {
      await interaction.editReply(finalize(content));
    } else {
      await interaction.reply(finalize(content));
    }
  }
}

// Semua command yang butuh nama member pake NAMA OPSI "member" (lewat
// addMemberOption di atas) KECUALI "/tambah-alias"'s opsi "target" - jadi
// autocomplete-nya generic per NAMA OPSI yang lagi difokusin user, bukan per
// command, satu handler ini nyervis SEMUA command sekaligus.
const AUTOCOMPLETE_OPTION_NAMES = new Set(["member", "member1", "member2", "member3", "member4", "member5", "target"]);
const AUTOCOMPLETE_LIMIT = 25; // batas keras Discord buat jumlah choice

// Gabungan dua sumber: loadLiveCount() (SEMUA member yang pernah SELESAI
// live semenjak bot ini jalan - append-only, paling lengkap) + activeLives
// (member yang LAGI live SEKARANG - jaga-jaga buat member yang live
// pertama kalinya dan belum sempet "selesai" tercatat di live-count.json).
// Gak nge-require storage lain di LUAR dua ini (biar tetep murah/cepat -
// autocomplete Discord expect respon dalam hitungan detik).
function getMemberAutocompleteChoices(query) {
  const known = new Map(); // username -> display name
  for (const [username, entry] of Object.entries(loadLiveCount())) known.set(username, entry.name);
  for (const entry of activeLives.values()) known.set(entry.username, entry.name);

  const needle = (query || "").trim().toLowerCase();
  return [...known.entries()]
    .filter(([username, name]) => !needle || name.toLowerCase().includes(needle) || username.toLowerCase().includes(needle))
    .sort((a, b) => a[1].localeCompare(b[1]))
    .slice(0, AUTOCOMPLETE_LIMIT)
    .map(([username, name]) => ({ name, value: username }));
}

// Dipanggil chat/router.js's interactionCreate pas interaction.isAutocomplete().
// interaction.respond() BEDA dari interaction.reply() - gak lewat
// safeReplyOptions (itu buat balesan pesan biasa), format-nya emang harus
// array {name, value} polos.
async function handleSlashAutocomplete(interaction) {
  const focused = interaction.options.getFocused(true);
  if (!AUTOCOMPLETE_OPTION_NAMES.has(focused.name)) {
    await interaction.respond([]);
    return;
  }
  try {
    await interaction.respond(getMemberAutocompleteChoices(focused.value));
  } catch (error) {
    // Discord ngasih waktu SANGAT sempit (~3 detik) buat interaction.respond()
    // - kalau somehow telat/gagal, jangan biarin exception ini nyasar naik
    // ke wireDiscordEvents (autocomplete gagal SEKALI doang harusnya gak
    // ganggu apapun, user tinggal lanjut ngetik manual).
    console.error("Gagal ngasih autocomplete member:", error.message);
  }
}

module.exports = {
  EPHEMERAL_COMMANDS,
  getCommandDefinitionsJSON,
  handleSlashCommand,
  handleSlashAutocomplete,
  getMemberAutocompleteChoices,
  replyCekMember,
};
