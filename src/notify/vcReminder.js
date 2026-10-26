const path = require("path");
const { CACHE_DIR, PRIORITY_PING_USER_ID, VC_REMINDER_DM } = require("../config");
const { getDiscordClient } = require("../discordClient");
const { createJsonStore } = require("../storage/jsonStore");
const { loadVc } = require("../storage/vcSchedule");
const { getDateWIB } = require("../utils");
const { formatTime, formatOpenWindow } = require("../chat/vcInput");
const { cleanName, escapeMd } = require("../chat/vcRender");
const { sendOwnerDM } = require("./ownerAlert");

// Pengingat jam MULAI VC ke DM owner. Jam Mulai (diinput lewat "input vc") adalah saat owner harus siap-siap sebelum jendela
// jam buka; tanpa pengingat, data itu cuma jadi tulisan di rangkuman. Satu DM per sesi, berisi link Zoom + kode sandi
// (DM owner memang satu-satunya tempat data itu hidup, sama seperti rangkumannya).
//
// Jendela kirim: REMIND_BEFORE_MS sebelum jam mulai sampai GRACE_AFTER_MS sesudahnya (toleransi restart/redeploy). Sesi yang
// baru diinput setelah jendelanya lewat tidak diingatkan. Kunci pengingat memuat tanggal + jam mulai, jadi sesi yang jamnya
// diubah owner diingatkan lagi untuk jam barunya. Status disimpan terpisah dari data VC (restart tidak mengirim ulang).
const REMIND_BEFORE_MS = 5 * 60 * 1000;
const GRACE_AFTER_MS = 10 * 60 * 1000;
// Setelah percobaan GAGAL (DM ditutup, Discord error) jangan coba lagi tiap siklus polling (20 detik).
const RETRY_AFTER_MS = 60 * 1000;
const KEEP_STATE_MS = 3 * 24 * 60 * 60 * 1000;

const store = createJsonStore(path.join(CACHE_DIR, "vc-reminders.json"), { sent: {}, attempts: {} }, { errorLabel: "pengingat VC" });

// WIB = UTC+7 tetap (tanpa DST), jadi jam dinding sesi bisa diubah ke epoch langsung.
const startMs = (session) => new Date(`${session.date}T${session.start}:00+07:00`).getTime();
const reminderKey = (s) => `${s.id}:${s.date}:${s.start}`;

function buildReminderText(session, now) {
  const minutes = Math.round((startMs(session) - now) / 60000);
  const when = minutes > 0 ? `${minutes} menit lagi` : "sekarang";
  const lines = [
    `⏰ **Pengingat VC** - ${escapeMd(cleanName(session.name))} · Sesi ${session.session}`,
    `Mulai ${formatTime(session.start)} WIB (${when}) · Buka ${formatOpenWindow(session.open, session.openEnd)}`,
    `🔗 <${session.link}>`,
  ];
  if (session.passcode) lines.push(`🔑 Sandi: ${escapeMd(session.passcode)}`);
  if (session.tickets) lines.push(`🎟️ ${session.tickets} tiket`);
  return lines.join("\n");
}

// Balikin jumlah pengingat yang BENAR-BENAR terkirim di panggilan ini. Tidak melempar.
async function maybeSendVcReminders(now = Date.now()) {
  if (!VC_REMINDER_DM || !PRIORITY_PING_USER_ID) return 0;
  const today = getDateWIB(new Date(now));
  const yesterday = getDateWIB(new Date(now - 24 * 60 * 60 * 1000));
  const due = loadVc().sessions.filter((s) => {
    if (s.date !== today && s.date !== yesterday) return false; // jendela bisa melewati tengah malam
    const delta = startMs(s) - now;
    return delta <= REMIND_BEFORE_MS && delta >= -GRACE_AFTER_MS;
  });
  if (due.length === 0) return 0;

  const client = getDiscordClient();
  if (!client || (typeof client.isReady === "function" && !client.isReady())) return 0;

  const state = { sent: {}, attempts: {}, ...store.load() };
  let sentCount = 0;
  for (const session of due.sort((a, b) => startMs(a) - startMs(b))) {
    const key = reminderKey(session);
    if (state.sent[key]) continue;
    if (state.attempts[key] && now - state.attempts[key] < RETRY_AFTER_MS) continue;
    state.attempts[key] = now; // dicatat sebelum mengirim
    if (await sendOwnerDM(buildReminderText(session, now))) {
      state.sent[key] = now;
      sentCount++;
    }
  }
  for (const bucket of [state.sent, state.attempts]) {
    for (const [key, at] of Object.entries(bucket)) if (now - at > KEEP_STATE_MS) delete bucket[key];
  }
  store.save(state);
  return sentCount;
}

module.exports = { maybeSendVcReminders, buildReminderText, REMIND_BEFORE_MS, GRACE_AFTER_MS, RETRY_AFTER_MS };
