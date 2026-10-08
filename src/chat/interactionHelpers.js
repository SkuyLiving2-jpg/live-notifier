const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");

// Helper bersama buat tombol "Tutup" yang beneran NGEHAPUS pesannya (bukan
// diedit jadi teks dismiss kayak "Oke, dibatalin."/"Terima kasih...") -
// dipake bareng-bareng oleh chat/menu.js, chat/replies.js, DAN
// chat/memberChannelReply.js (§10's thirty-fifth item). Sebelum ini, ada 2
// logika "tutup" beda yang nyebar di 3 file: sebagian nge-edit jadi teks
// dismiss + components:[] (masih nyisain 1 pesan sebagai jejak), sebagian
// (fallback_menu:delete, §10's thirty-fourth item) beneran ngehapus -
// owner minta disamain SEMUA biar gak ambigu/gak nge-bug: sekali "Tutup"
// diklik di manapun, pesannya beneran ilang, titik.
//
// Modul TERPISAH (bukan taro fungsi ini di salah satu dari 3 file itu terus
// di-export dari sana) SENGAJA - menu.js sendiri udah require("./replies")
// di atasnya, jadi kalau fungsi ini ditaro di menu.js lalu replies.js
// require balik ke menu.js buat pake fungsi ini, itu numbuhin circular
// require ASLI (persis kelas masalah yang udah kejadian & didokumentasiin
// di menu.js's handleFallbackMenuButton's "delete" branch, soal kenapa
// clearMenuShown dari pendingState.js di-require LAZY di situ). Modul BARU
// yang berdiri sendiri (gak require apapun dari menu.js/replies.js/
// memberChannelReply.js, dan gak ada satupun dari ketiganya yang saling
// require satu sama lain buat fungsi ini) bisa di-require SEMUA ARAH tanpa
// resiko siklus sama sekali.
//
// interaction.deferUpdate() WAJIB dipanggil DULU, sebelum message.delete() -
// deferUpdate() ngakuin interaksinya ke Discord TANPA nampilin balesan
// apapun (beda dari update(), yang juga ngakuin tapi HARUS bawa konten
// baru). Tanpa ini, Discord nunjukkin "This interaction failed" ke orang
// yang ngeklik walau pesannya beneran kehapus di baliknya - interaksinya
// sendiri gak pernah "dijawab" sama sekali dari sudut pandang Discord kalau
// cuma message.delete() doang yang dipanggil. .catch(() => {}) di
// message.delete() jaga-jaga kalau pesannya kebetulan udah kehapus duluan
// (mis. diklik dua kali kepencet, atau kena race sama tombol "Tutup" lain
// yang ngehapus pesan yang sama).
async function deleteInteractionMessage(interaction) {
  await interaction.deferUpdate();
  await interaction.message.delete().catch(() => {});
}

// Tombol "Tutup" buat balasan command yang diketik ("cok stats nala", "cok streak
// nala", dst) - balasannya teks polos tanpa tombol apapun, jadi numpuk di
// channel. customId "reply_close" sengaja BUKAN "recap_nav:close" (yang juga
// ngebersihin pendingRecapPage milik user - efek samping yang gak relevan di
// sini). `withCloseButton` nerima string ATAU objek balasan ({content, files,
// embeds, components}); balasan yang UDAH punya tombol sendiri dibiarin apa
// adanya.
function buildReplyCloseButton() {
  return new ButtonBuilder().setCustomId("reply_close").setLabel("Tutup").setStyle(ButtonStyle.Danger);
}

function buildReplyCloseRow() {
  return new ActionRowBuilder().addComponents(buildReplyCloseButton());
}

function withCloseButton(reply) {
  if (typeof reply === "string") return { content: reply, components: [buildReplyCloseRow()] };
  if (reply && typeof reply === "object" && !(reply.components && reply.components.length > 0)) {
    return { ...reply, components: [buildReplyCloseRow()] };
  }
  return reply;
}

async function handleReplyCloseButton(interaction) {
  await deleteInteractionMessage(interaction);
}

module.exports = { deleteInteractionMessage, buildReplyCloseButton, buildReplyCloseRow, withCloseButton, handleReplyCloseButton };
