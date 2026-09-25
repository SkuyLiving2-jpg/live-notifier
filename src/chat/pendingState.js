const { replyGifterSnapshot } = require("./replies");
const { resolveBareMenuChoice, startWatchConfirm, memberPromptQuestion } = require("./menu");

// "channelId:authorId" -> kapan terakhir menu fallback ditampilin buat orang
// itu. Dipake biar user bisa balas cukup ketik angkanya doang (1-9) abis
// menu-nya muncul - tapi CUMA kalau menu-nya baru aja beneran ditampilin
// duluan, biar ketik angka "mentah" tanpa konteks tetap nunjukkin menu-nya
// dulu (bukan nebak).
//
// BUG SEBELUMNYA: ini di-key per CHANNEL doang (bukan per orang) - jadi di
// channel rame, cuma orang PERTAMA yang bales angka abis menu muncul yang
// kedetect; orang kedua yang bales angka sama malah dikasih menu dari awal
// lagi (soalnya pending-nya udah "sekali pake" abis dipakai orang pertama).
// Sekarang di-key bareng channel+author, sama pola-nya kayak
// menu.js's pendingWatchConfirm/pendingMemberPrompt (di bawah)/pendingRecapPage
// (di replies.js) - tiap orang punya "menu barusan ditampilin" sendiri-sendiri.
const pendingMenuByAuthor = new Map();
const PENDING_MENU_TTL_MS = 3 * 60000;

// Dipanggil chat/router.js abis nunjukkin fallback menu ke seseorang, biar
// balesan angka mentah berikutnya dari orang itu ketangkep sebagai lanjutan.
function markMenuShown(channelId, authorId) {
  if (channelId && authorId) pendingMenuByAuthor.set(`${channelId}:${authorId}`, Date.now());
}

// Kebalikan dari markMenuShown - dipanggil menu.js's handleFallbackMenuButton
// abis tombol "Tutup" (fallback_menu:delete) beneran ngehapus pesan menunya
// (§10's thirty-fourth item). Tanpa ini, ngetik angka mentah (mis. "3")
// dalam PENDING_MENU_TTL_MS abis pesannya kehapus tetep ketangkep sebagai
// "lanjutan milih opsi menu" - padahal menu-nya udah eksplisit ditutup
// (salah pencet/salah ketik), jadi jawabannya bakal keliatan nyasar dari
// mana asalnya. Sama pola-nya kayak replies.js's "recap_nav:close" yang
// juga nge-clear pendingRecapPage-nya sendiri.
function clearMenuShown(channelId, authorId) {
  if (channelId && authorId) pendingMenuByAuthor.delete(`${channelId}:${authorId}`);
}

// "channelId:authorId" -> { option: "4"|"9", at } - nunggu NAMA member abis
// user milih opsi 4/9 tanpa langsung nyebut nama. BUG SEBELUMNYA: begitu
// nanya "member yang mana?"/"gifter siapa?", pendingMenuByAuthor keburu
// ke-hapus (sekali pake abis itu clear) - jadi jawaban berikutnya (nama
// doang, ATAU ulang "9 <nama>") gak dikenalin lagi sebagai lanjutan opsi
// 4/9, malah nyasar ke router biasa (bisa salah ke-anggep command lain sama
// sekali). Sekarang dicatet dulu opsi mana yang lagi nunggu nama.
const pendingMemberPrompt = new Map();
const PENDING_MEMBER_PROMPT_TTL_MS = 2 * 60000;

async function tryHandleMenuShortcut(text, channelId, authorId) {
  if (!channelId || !authorId) return null;

  const key = `${channelId}:${authorId}`;
  const shownAt = pendingMenuByAuthor.get(key);
  const isPending = shownAt && Date.now() - shownAt <= PENDING_MENU_TTL_MS;
  if (!isPending) return null;

  // Sebelumnya /^([1-4])\s*(.*)$/ - itu match ke SEMUA pesan yang cuma
  // DIAWALI angka 1-4 (mis. "10 menit lagi" ke-anggep pilih menu #1). Sekarang
  // pilihan yang nggak butuh input tambahan (1-3, 5-8) harus persis SATU
  // angka itu doang, dan pilihan yang butuh nama member (4, 9) harus "4"/"9"
  // doang atau "4 <spasi><nama>"/"9 <spasi><nama>" - bukan asal awalan angka.
  const bareChoice = text.match(/^([1-3]|[5-8])$/);
  const choiceFour = text.match(/^4(?:\s+(.+))?$/);
  const choiceNine = text.match(/^9(?:\s+(.+))?$/);
  if (!bareChoice && !choiceFour && !choiceNine) return null;

  pendingMenuByAuthor.delete(key); // sekali pake abis itu clear

  if (bareChoice) {
    return await resolveBareMenuChoice(bareChoice[1], channelId, authorId);
  }

  const option = choiceFour ? "4" : "9";
  const rest = ((choiceFour || choiceNine)[1] || "").trim();
  if (!rest) {
    if (authorId) pendingMemberPrompt.set(`${channelId}:${authorId}`, { option, at: Date.now() });
    return memberPromptQuestion(option);
  }
  return option === "4" ? startWatchConfirm(rest, channelId, authorId) : replyGifterSnapshot(rest);
}

// Dicek di awal chat/router.js's buildChatReply (pola sama kayak
// menu.js's tryHandleWatchConfirmShortcut) - jawaban nama polos ("nala")
// atau ulang command ("9 nala") gak nyebut "cok"/"live" sama sekali, jadi
// harus ketangkep sebelum gerbang wake-word.
function tryHandleMemberPromptShortcut(text, channelId, authorId) {
  if (!channelId || !authorId) return null;
  const key = `${channelId}:${authorId}`;
  const pending = pendingMemberPrompt.get(key);
  if (!pending) return null;

  if (Date.now() - pending.at > PENDING_MEMBER_PROMPT_TTL_MS) {
    pendingMemberPrompt.delete(key);
    return null;
  }

  const trimmed = text.trim();
  const isBareOptionRepeat = trimmed === pending.option; // ngetik ulang "9"/"4" doang, tanpa nama
  const withoutPrefix = trimmed.replace(new RegExp(`^${pending.option}\\s+`), "").trim();
  const name = isBareOptionRepeat ? "" : withoutPrefix || trimmed;

  if (!name) return memberPromptQuestion(pending.option); // masih nunggu nama, pending TETEP hidup

  pendingMemberPrompt.delete(key);
  return pending.option === "4" ? startWatchConfirm(name, channelId, authorId) : replyGifterSnapshot(name);
}

module.exports = { markMenuShown, clearMenuShown, tryHandleMenuShortcut, tryHandleMemberPromptShortcut };
