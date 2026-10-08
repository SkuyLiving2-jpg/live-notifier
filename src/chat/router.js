const { MessageFlags } = require("discord.js");
const { BOT_CHANNEL_ID, PRIORITY_PING_USER_ID, DISCORD_BOT_TOKEN } = require("../config");
const { safeReplyOptions } = require("../utils");
const { pruneRepeatedExchange } = require("./repeatedReplyGuard");
const { syncRolePanelOnBoot } = require("./roleFlow");

const { buildChatReply } = require("./commandRoutes");
const { dispatchInteraction } = require("./interactionRoutes");

// BUG YANG DILAPORIN OWNER ("grafik erine" gak keluar apa-apa): kalau kirim
// balesan gagal, dulu cuma masuk log - user gak dapet apa-apa, kesannya
// command-nya diem. Penyebab paling mungkin buat grafik: gambar PNG butuh
// izin "Attach Files" (error 50013 kalau gak ada), sementara teks biasa
// cukup "Send Messages". Jadi dicoba kirim penjelasan TEKS POLOS.
// Error izin (50013 Missing Permissions, 160002 gak bisa reply tanpa izin baca
// riwayat pesan, 50001 Missing Access) itu soal SETUP channel di Discord, bukan
// bug - tapi log lamanya gak nyebut channel mana (jadi susah dicari) dan nyetak
// dua baris tiap pesan. Sekarang SATU baris yang nyebut nama + ID channel dan
// izin yang kurang, maksimal sekali per channel per 10 menit.
const PERMISSION_ERROR_CODES = new Set([50013, 160002, 50001]);
const PERMISSION_LOG_COOLDOWN_MS = 10 * 60 * 1000;
const lastPermissionLogAt = new Map();

function describePermissionProblem(code) {
  if (code === 160002) return 'izin "Read Message History" belum ada (wajib buat membalas/reply pesan)';
  if (code === 50001) return 'bot gak punya akses ke channel ini (izin "View Channel" belum ada)';
  return 'izin "Send Messages" (atau izin lain yang dibutuhin balasan ini) belum ada';
}

function logReplyFailure(message, error) {
  if (!PERMISSION_ERROR_CODES.has(error?.code)) {
    console.error("Gagal kirim balesan chat:", error?.message, "| code:", error?.code);
    return;
  }
  const channelId = message?.channel?.id || message?.channelId || "?";
  const now = Date.now();
  if (now - (lastPermissionLogAt.get(channelId) || 0) < PERMISSION_LOG_COOLDOWN_MS) return;
  lastPermissionLogAt.set(channelId, now);
  console.error(
    `Bot gak bisa membalas di channel #${message?.channel?.name || "?"} (ID ${channelId}): ${describePermissionProblem(error.code)} - kode ${error.code}. ` +
      "Cek Permissions channel/kategori itu buat role bot: View Channel, Send Messages, Read Message History (+ Attach Files buat grafik/CSV). Log ini muncul maks sekali per 10 menit per channel.",
  );
}

async function replyWithFailureNotice(message, reply, error) {
  logReplyFailure(message, error);
  // Tanpa izin baca riwayat, balasan apapun (termasuk penjelasan ini) pasti
  // ditolak dengan alasan yang sama - gak usah dicoba.
  if (error?.code === 160002) return;
  const hasFiles = typeof reply === "object" && Array.isArray(reply.files) && reply.files.length > 0;
  const notice =
    error.code === 50013 && hasFiles
      ? 'Cok, gambarnya gak bisa kekirim - bot belum punya izin "Attach Files" di channel ini. Minta admin nambahin izin itu ke role bot ya.'
      : "Cok, ada error pas ngirim balesannya. Coba lagi bentar ya.";
  await message.reply(safeReplyOptions(notice)).catch((noticeError) => {
    // Izin error: sudah dicatat sekali di atas, jangan dobel-dobel.
    if (!PERMISSION_ERROR_CODES.has(noticeError?.code)) {
      console.error("Gagal kirim pesan error-nya juga:", noticeError.message, "| code:", noticeError.code);
    }
  });
}

// Handler tombol/menu/modal yang melempar error sebelum sempat menjawab bikin
// user cuma lihat "interaksi gagal" tanpa penjelasan. Jaring pengaman UMUM
// (handler tertentu - role, slash - punya penanganan sendiri): kasih pesan
// pribadi singkat. 10062 = interaksi sudah kedaluwarsa (lewat ~3 detik),
// gak ada yang bisa dijawab lagi.
async function notifyInteractionFailure(interaction, error) {
  if (error?.code === 10062 || error?.code === 40060) return;
  try {
    if (typeof interaction?.isRepliable === "function" && !interaction.isRepliable()) return;
    const payload = safeReplyOptions({ content: "Cok, ada error pas ngejalanin itu. Coba lagi bentar ya.", flags: MessageFlags.Ephemeral });
    if (interaction.deferred || interaction.replied) await interaction.followUp(payload);
    else await interaction.reply(payload);
  } catch (notifyError) {
    console.error("Gagal ngasih tau user soal error interaksi:", notifyError.message);
  }
}

// Nempelin listener pesan/tombol ke discord.js Client yang udah dibikin
// discordClient.js's createDiscordClient() - dipanggil dari src/app.js's
// start() setelah DISCORD_BOT_TOKEN dipastiin ada, JADI fungsi ini sendiri
// gak nge-cek DISCORD_BOT_TOKEN lagi (itu tanggung jawab pemanggilnya).
function wireDiscordEvents(client) {
  // EventEmitter "error" TANPA listener = throw = proses mati (uncaughtException
  // di app.js). Error koneksi gateway harus cukup dicatat - discord.js
  // nyambung ulang sendiri.
  client.on("error", (error) => console.error("Error koneksi Discord:", error.message));
  client.on("shardError", (error) => console.error("Error shard Discord:", error.message));

  client.once("clientReady", () => {
    console.log(`Bot tanya-jawab login sebagai ${client.user.tag}`);
    // Panel role: dipasang/di-edit otomatis tiap boot (gak numpuk).
    syncRolePanelOnBoot(client).catch((error) => console.error("Gagal sinkron panel role pas boot:", error.message));
    // Dicetak sekali pas boot - cara paling gampang buat mastiin (lewat
    // Deploy Logs di Railway, tanpa perlu akses dashboard/CLI-nya) apakah
    // PRIORITY_PING_USER_ID keisi bener, soalnya kalau kosong DM notif
    // prioritas (notify/priorityDm.js) diem-diem gak pernah kekirim tanpa
    // error apapun.
    console.log(
      PRIORITY_PING_USER_ID
        ? `PRIORITY_PING_USER_ID aktif - DM notif prioritas bakal dikirim ke user ID ${PRIORITY_PING_USER_ID}.`
        : "PRIORITY_PING_USER_ID BELUM diset - DM notif prioritas gak bakal kekirim (channel tetap dapet notif biasa).",
    );
  });

  client.on("messageCreate", async (message) => {
    try {
      if (message.author.bot) return;
      // DM (tanpa server): semua pesan dianggap ditujukan ke bot, kayak di channel bot.
      const isDm = !message.guildId;
      const isBotChannel = isDm || (Boolean(BOT_CHANNEL_ID) && message.channel.id === BOT_CHANNEL_ID);
      const reply = await buildChatReply(message.content, {
        isBotChannel,
        isDm,
        channelId: message.channel.id,
        authorId: message.author.id,
      });
      if (reply) {
        let sent;
        try {
          sent = await message.reply(safeReplyOptions(reply));
        } catch (sendError) {
          await replyWithFailureNotice(message, reply, sendError);
          return;
        }
        // Ketikan yang SAMA diulang lebih dari 2x -> ketikan lama + balesan
        // bot lamanya dihapus (lihat repeatedReplyGuard.js). Dipanggil abis
        // balesan kekirim, dan gak pernah throw (kegagalan hapus cuma di-log).
        // (Di DM dilewati: bot gak bisa menghapus pesan user di DM.)
        if (!isDm) await pruneRepeatedExchange(message, (message.content || "").trim().toLowerCase(), sent);
      }
    } catch (error) {
      // Sebelumnya cuma nyetak error.message - kalau ini beneran gagal
      // gara-gara Discord API nolak (mis. kurang permission), error.code
      // (angka error Discord, mis. 50013) sama error.stack jauh lebih
      // kebaca ketimbang cuma pesan generik "Missing Permissions".
      console.error("Gagal balas chat:", error.message, "| code:", error.code, "\n", error.stack);
    }
  });

  client.on("interactionCreate", async (interaction) => {
    try {
      // Tombol/dropdown/modal/slash di-dispatch lewat tabel di chat/interactionRoutes.js.
      await dispatchInteraction(interaction);
    } catch (error) {
      console.error("Gagal proses tombol/menu Discord:", error.message, "| code:", error.code);
      await notifyInteractionFailure(interaction, error);
    }
  });

  client.login(DISCORD_BOT_TOKEN).catch((error) => {
    console.error("Gagal login bot Discord (cek DISCORD_BOT_TOKEN):", error.message);
  });
}

module.exports = { buildChatReply, wireDiscordEvents, replyWithFailureNotice };
