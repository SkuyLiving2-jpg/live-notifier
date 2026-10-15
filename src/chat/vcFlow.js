const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
} = require("discord.js");
const {
  loadVc,
  saveVc,
  defaultVcTitle,
  addVcSession,
  getVcSession,
  updateVcSession,
  removeVcSession,
  setVcNickname,
  resetVcPeriod,
} = require("../storage/vcSchedule");
const { searchLiveCountByNameFragment } = require("../storage/liveCount");
const { getDiscordClient } = require("../discordClient");
const { safeReplyOptions, getTodayWIB, matchesNameFragment } = require("../utils");
const { shiftDateWIB } = require("../streakMath");
const { isOwner } = require("./replies");
const { searchTargetCandidates } = require("./aliasFlow");
const { deleteInteractionMessage } = require("./interactionHelpers");
const { validateSessionForm, parseDateInput, formatDateDisplay, formatTime, formatOpenWindow } = require("./vcInput");
const { slotsForDate, describeDayType, checkSession } = require("./vcSlots");
const { renderVcMessages, buildGroups, memberKey, cleanName, escapeMd } = require("./vcRender");
const { generateNote, generateOpener } = require("./vcAbsurd");

// ---------------------------------------------------------------------------
// "input vc": rangkuman Video Call member yang diinput owner. HANYA owner, HANYA lewat DM bot (link Zoom + kode
// sandi tidak boleh nongol di channel server). Dua jenis pesan di DM:
//   - PESAN RANGKUMAN: hasil jadi (vcRender.js). SATU pesan yang di-edit terus tiap ada perubahan (pecah jadi
//     beberapa pesan hanya kalau melewati batas 2000 karakter). ID-nya disimpan di storage/vcSchedule.js.
//   - PANEL: pesan kontrol berisi tombol (tambah/ubah/hapus/judul/reset/tutup). Setiap "input vc" membuat panel baru.
// Alur tambah sesi: Member (cari -> pilih) -> Tanggal (dropdown 25 hari / ketik) -> Sesi (dropdown; isinya mengikuti hari:
// Senin-Jumat sesi 1-3, Sabtu-Minggu sesi 1-6, tiap opsi membawa JENDELA JAM BUKA-nya, lihat vcSlots.js) -> form (Mulai
// manual, Link [+ kode sandi], Tiket). Tiap layar punya "Menu" dan "Tutup" supaya salah pencet tidak menjebak.
// ---------------------------------------------------------------------------

const DM_ONLY_NOTE = "Cok, input VC cuma bisa lewat DM bot ini (biar link Zoom-nya gak kebaca orang lain). Chat aku lewat DM ya.";
const NOT_OWNER_NOTE = "Cok, fitur ini cuma buat owner.";

// ------------------------------ state sementara ------------------------------

// "channelId:userId" -> { member, date, session, matches, manualName, lastForm, lastEdit, at }. Isian modal berisi teks bebas
// (bisa mengandung ":") jadi tidak dititipkan lewat customId; hilang kalau bot restart (owner tinggal mulai lagi).
const drafts = new Map();
const DRAFT_TTL_MS = 30 * 60 * 1000;

function draftKey(interaction) {
  return `${interaction.channelId}:${interaction.user.id}`;
}

function getDraft(interaction) {
  const key = draftKey(interaction);
  const draft = drafts.get(key);
  if (!draft) return null;
  if (Date.now() - draft.at > DRAFT_TTL_MS) {
    drafts.delete(key);
    return null;
  }
  draft.at = Date.now();
  return draft;
}

function startDraft(interaction) {
  const draft = { member: null, date: null, session: null, matches: [], manualName: null, lastForm: null, lastEdit: null, at: Date.now() };
  drafts.set(draftKey(interaction), draft);
  return draft;
}

const clearDraft = (interaction) => drafts.delete(draftKey(interaction));

// ------------------------- periode & pesan rangkuman -------------------------

// Periode aktif selalu punya judul + pembuka (dibuat sekali, disimpan supaya pesan rangkuman stabil).
function ensurePeriod() {
  const data = loadVc();
  let changed = false;
  if (!data.title) {
    data.title = defaultVcTitle();
    changed = true;
  }
  if (!data.opener) {
    data.opener = generateOpener({ title: data.title });
    changed = true;
  }
  if (changed) saveVc(data);
  return data;
}

// Satu antrean: dua perubahan beruntun (klik cepat) tidak boleh sama-sama membuat pesan rangkuman baru.
let syncChain = Promise.resolve();
function withLock(fn) {
  const run = syncChain.then(fn, fn);
  syncChain = run.catch(() => {});
  return run;
}

async function getOwnerDm(userId) {
  const client = getDiscordClient();
  if (!client) throw new Error("bot belum login");
  const user = await client.users.fetch(userId);
  return user.createDM();
}

async function deleteMessages(dm, ids) {
  for (const id of ids) await dm.messages.delete(id).catch(() => {});
}

async function sendAll(dm, chunks) {
  const ids = [];
  for (const chunk of chunks) ids.push((await dm.send(safeReplyOptions({ content: chunk }))).id);
  return ids;
}

// Edit pesan rangkuman yang sudah ada; yang hilang (dihapus manual) atau kelebihan ditangani. Kalau ada pesan lama yang
// sudah dihapus, SEMUA dikirim ulang berurutan - mengedit sebagian bikin urutan potongan pesan tertukar.
async function writeSummary(dm, chunks, existingIds) {
  // Rangkuman membesar sampai butuh pesan tambahan: potongan baru akan mendarat di BAWAH panel tombol dan memisahkan dirinya
  // dari potongan sebelumnya (ketahuan lewat playground). Kirim ulang semuanya supaya potongan tetap berurutan dan menyatu.
  if (existingIds.length > 0 && chunks.length > existingIds.length) {
    await deleteMessages(dm, existingIds);
    return sendAll(dm, chunks);
  }
  const ids = [];
  try {
    for (let i = 0; i < chunks.length; i++) {
      if (existingIds[i]) {
        await dm.messages.edit(existingIds[i], safeReplyOptions({ content: chunks[i] }));
        ids.push(existingIds[i]);
      } else {
        ids.push((await dm.send(safeReplyOptions({ content: chunks[i] }))).id);
      }
    }
  } catch (error) {
    if (error?.code !== 10008) throw error; // Unknown Message: pesan lama dihapus owner
    await deleteMessages(dm, [...ids, ...existingIds]);
    return sendAll(dm, chunks);
  }
  await deleteMessages(dm, existingIds.slice(chunks.length));
  return ids;
}

// Render ulang rangkuman ke DM owner. Balikin { ok } atau { ok: false, reason } - TIDAK melempar, supaya data yang
// sudah tersimpan tidak dianggap gagal cuma karena Discord sedang bermasalah.
function syncSummary(userId, { repost = false } = {}) {
  return withLock(async () => {
    try {
      const dm = await getOwnerDm(userId);
      const data = ensurePeriod();
      const chunks = renderVcMessages(data);
      const sameChannel = data.message && data.message.channelId === dm.id;
      const existing = sameChannel ? data.message.ids : [];
      let ids;
      if (repost) {
        await deleteMessages(dm, existing);
        ids = await sendAll(dm, chunks);
      } else {
        ids = await writeSummary(dm, chunks, existing);
      }
      const fresh = loadVc();
      fresh.message = { channelId: dm.id, ids };
      saveVc(fresh);
      return { ok: true };
    } catch (error) {
      console.error("Gagal update pesan rangkuman VC:", error.message);
      return { ok: false, reason: error.message };
    }
  });
}

const syncWarning = (sync) =>
  sync.ok ? "" : `\n⚠️ Datanya sudah tersimpan, tapi pesan rangkuman gagal di-update (${sync.reason}). Coba lagi dari menu.`;

// ------------------------------ komponen umum --------------------------------

const button = (id, label, style = ButtonStyle.Secondary, disabled = false) =>
  new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style).setDisabled(disabled);
const row = (...components) => new ActionRowBuilder().addComponents(components);
const navRow = () => row(button("vc_flow:menu", "⬅️ Menu"), button("vc_flow:close", "✖ Tutup", ButtonStyle.Danger));

function textInput(id, label, { placeholder, value, required = true, max } = {}) {
  const input = new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(TextInputStyle.Short).setRequired(required);
  if (placeholder) input.setPlaceholder(placeholder);
  if (value) input.setValue(String(value).slice(0, max || 4000));
  if (max) input.setMaxLength(max);
  return input;
}

function modal(customId, title, inputs) {
  return new ModalBuilder()
    .setCustomId(customId)
    .setTitle(title.slice(0, 45))
    .addComponents(inputs.map((input) => row(input)));
}

// ---------------------------------- layar ------------------------------------

function buildPanel(prefix = "") {
  const data = loadVc();
  const members = new Set(data.sessions.map(memberKey)).size;
  const summary = data.sessions.length > 0 ? `${data.sessions.length} sesi dari ${members} member` : "belum ada sesi";
  const hasSessions = data.sessions.length > 0;
  return {
    content: `${prefix ? `${prefix}\n\n` : ""}🎬 **Input VC** - ${escapeMd(data.title || defaultVcTitle())}\n${summary}. Rangkumannya ada di pesan yang di-update otomatis. Mau ngapain, cok?`,
    components: [
      row(
        button("vc_flow:add", "➕ Tambah sesi", ButtonStyle.Success),
        button("vc_flow:edit", "✏️ Ubah / Hapus", ButtonStyle.Primary, !hasSessions),
        button("vc_flow:title", "📝 Judul"),
      ),
      row(
        button("vc_flow:opener", "🎲 Acak pembuka"),
        button("vc_flow:repost", "📌 Kirim ulang di bawah"),
        button("vc_flow:reset", "🧹 Reset periode", ButtonStyle.Danger, !hasSessions),
      ),
      row(button("vc_flow:close", "✖ Tutup", ButtonStyle.Danger)),
    ],
  };
}

function buildSearchRetry(message, manualName) {
  const buttons = [];
  if (manualName) buttons.push(button("vc_flow:manual", `✍️ Pakai "${manualName.slice(0, 40)}" apa adanya`, ButtonStyle.Primary));
  buttons.push(button("vc_flow:add", "🔍 Cari lagi"));
  return {
    content: `${message}\nBukan member IDN / belum pernah live? Kamu bisa pakai nama yang diketik apa adanya.`,
    components: [row(...buttons), navRow()],
  };
}

function buildSingleMatch(match, query) {
  const note = match.neverLive ? " (belum pernah live semenjak bot ini mantau)" : "";
  return {
    content: `Ketemu: **${escapeMd(cleanName(match.name))}**${note}. Pakai yang ini?`,
    components: [
      row(
        button("vc_flow:use", `✅ Pakai ${cleanName(match.name).slice(0, 40)}`, ButtonStyle.Success),
        button("vc_flow:manual", `✍️ Pakai "${query.slice(0, 40)}" apa adanya`),
        button("vc_flow:add", "🔍 Cari lagi"),
      ),
      navRow(),
    ],
  };
}

function buildMultiMatch(matches, query) {
  const shown = matches.slice(0, 24);
  const options = shown.map((m) => ({
    label: cleanName(m.name).slice(0, 100),
    value: m.username,
    description: m.neverLive ? "belum pernah live" : `${m.count}x live`,
  }));
  options.push({ label: `✍️ Pakai "${query}" apa adanya`.slice(0, 100), value: "__manual__" });
  const select = new StringSelectMenuBuilder().setCustomId("vc_select:member").setPlaceholder("Pilih member...").addOptions(options);
  const note =
    matches.length > shown.length ? `\n_(cuma nunjukkin ${shown.length} dari ${matches.length} hasil - cari lagi yang lebih spesifik)_` : "";
  return { content: `🔍 Ketemu ${matches.length} member. Yang mana, cok?${note}`, components: [row(select), navRow()] };
}

// Dropdown 25 hari mulai hari ini + tombol "tanggal lain".
function buildDateStep(member, prefix = "") {
  const today = getTodayWIB();
  const options = [];
  for (let i = 0; i < 25; i++) {
    const date = shiftDateWIB(today, i);
    const option = { label: formatDateDisplay(date), value: date };
    if (i === 0) option.description = "hari ini";
    else if (i === 1) option.description = "besok";
    options.push(option);
  }
  const select = new StringSelectMenuBuilder().setCustomId("vc_select:date").setPlaceholder("Pilih tanggal VC...").addOptions(options);
  return {
    content: `${prefix ? `${prefix}\n` : ""}Member: **${escapeMd(cleanName(member.name))}**\nTanggal VC-nya kapan?`,
    components: [row(select), row(button("vc_flow:date_other", "📅 Tanggal lain...")), navRow()],
  };
}

// Dropdown sesi: isinya tergantung hari (Senin-Jumat sesi 1-3, Sabtu-Minggu sesi 1-6) dan tiap opsi membawa jendela jam
// bukanya - jadi memilih sesi = memilih jam buka, dan sesi yang tidak ada di hari itu memang tidak bisa dipilih.
function buildSessionStep(member, date, prefix = "") {
  const data = loadVc();
  const options = slotsForDate(date).map((slot) => {
    const taken = duplicateOf(data, member, date, slot.session);
    return {
      label: `Sesi ${slot.session} · Buka ${formatOpenWindow(slot.open, slot.openEnd)}`,
      value: String(slot.session),
      description: taken ? "Sudah ada untuk member ini (pakai Ubah / Hapus)" : undefined,
    };
  });
  const select = new StringSelectMenuBuilder().setCustomId("vc_select:session").setPlaceholder("Pilih sesi...").addOptions(options);
  return {
    content: `${prefix ? `${prefix}\n` : ""}Member: **${escapeMd(cleanName(member.name))}**\nTanggal: **${formatDateDisplay(date)}** - ${describeDayType(date)}\nSesi berapa, cok? (jam buka ikut sesinya)`,
    components: [row(select), row(button("vc_flow:redate", "📅 Ganti tanggal")), navRow()],
  };
}

function buildErrorStep(errors, retryId) {
  return {
    content: `Ada yang belum bener, cok:\n${errors.map((e) => `• ${e}`).join("\n")}`,
    components: [row(button(retryId, "🔁 Perbaiki", ButtonStyle.Primary)), navRow()],
  };
}

const sessionLabel = (s) => `${cleanName(s.name)} · Sesi ${s.session} · ${s.date.slice(8)}/${s.date.slice(5, 7)} ${formatTime(s.start)}`;

function describeSession(s) {
  const tickets = s.tickets ? ` · ${s.tickets} tiket` : "";
  const pass = s.passcode ? ` · sandi ${escapeMd(s.passcode)}` : "";
  return `**${escapeMd(cleanName(s.name))}** · Sesi ${s.session} · ${formatDateDisplay(s.date)}\nBuka ${formatOpenWindow(s.open, s.openEnd)} · Mulai ${formatTime(s.start)}${tickets}${pass}`;
}

function buildEntryScreen(session, prefix = "") {
  return {
    content: `${prefix ? `${prefix}\n\n` : ""}${describeSession(session)}\n🔗 <${session.link}>\n💬 _${escapeMd(session.note || "-")}_`,
    components: [
      row(
        button(`vc_flow:eform:${session.id}`, "✏️ Sesi & jam", ButtonStyle.Primary),
        button(`vc_flow:elink:${session.id}`, "🔗 Link"),
        button(`vc_flow:enote:${session.id}`, "🎲 Catatan baru"),
        button(`vc_flow:edel:${session.id}`, "🗑️ Hapus", ButtonStyle.Danger),
      ),
      row(button("vc_flow:edit", "⬅️ Daftar sesi"), button("vc_flow:close", "✖ Tutup", ButtonStyle.Danger)),
    ],
  };
}

function buildEntryList() {
  const data = loadVc();
  const ordered = buildGroups(data.sessions).flatMap((g) => g.sessions);
  if (ordered.length === 0) return buildPanel("Belum ada sesi yang bisa diubah.");
  const shown = ordered.slice(0, 25);
  const select = new StringSelectMenuBuilder()
    .setCustomId("vc_select:entry")
    .setPlaceholder("Pilih sesi...")
    .addOptions(shown.map((s) => ({ label: sessionLabel(s).slice(0, 100), value: String(s.id) })));
  const note = ordered.length > shown.length ? `\n_(cuma nunjukkin ${shown.length} dari ${ordered.length} sesi)_` : "";
  return { content: `Sesi yang mana, cok?${note}`, components: [row(select), navRow()] };
}

// ---------------------------------- modal ------------------------------------

const MEMBER_QUERY_MODAL = () =>
  modal("vc_modal:search", "Cari member VC", [textInput("member_query", "Nama member", { placeholder: "misal: Lily", max: 40 })]);
const DATE_TEXT_MODAL = () =>
  modal("vc_modal:datetext", "Tanggal VC", [
    textInput("date_text", "Tanggal", { placeholder: "18/10, 18 oktober, besok, atau 2026-10-18", max: 40 }),
  ]);

// Sesi dan jam buka sudah dipilih di dropdown (judul form mengingatkannya); yang diketik tinggal jam MULAI (manual, jadi
// dasar pengingat), link, dan tiket. Placeholder jam mulai = ujung jendela buka, hanya contoh - bukan isian otomatis.
function buildFormModal(slot, prefill = {}) {
  return modal("vc_modal:form", `Sesi ${slot.session} · Buka ${formatOpenWindow(slot.open, slot.openEnd)}`, [
    textInput("mulai", "Jam MULAI", { placeholder: formatTime(slot.openEnd), value: prefill.mulai, max: 10 }),
    textInput("link", "Link Zoom (+ kode sandi, opsional)", { placeholder: "https://us02web.zoom.us/j/... 388756", value: prefill.link, max: 400 }),
    textInput("tiket", "Jumlah tiket (opsional)", { placeholder: "3", value: prefill.tiket, required: false, max: 10 }),
  ]);
}

// Jam buka tidak ada di form ubah: ia mengikuti (tanggal, sesi) - ganti sesi/tanggal = jam bukanya ikut berganti, dan sesi
// yang tidak ada di hari itu (mis. sesi 5 di hari Senin) ditolak.
function buildEditFormModal(session, prefill = {}) {
  return modal(`vc_modal:eform:${session.id}`, "Ubah sesi & jam", [
    textInput("sesi", "Sesi (hari kerja 1-3, akhir pekan 1-6)", { value: prefill.sesi ?? session.session, max: 10 }),
    textInput("tanggal", "Tanggal", { placeholder: "18/10 atau 2026-10-18", value: prefill.tanggal ?? session.date, max: 40 }),
    textInput("mulai", "Jam MULAI", { value: prefill.mulai ?? formatTime(session.start), max: 10 }),
    textInput("tiket", "Jumlah tiket (kosong = tidak ada)", { required: false, value: prefill.tiket ?? (session.tickets || ""), max: 10 }),
  ]);
}

function buildLinkModal(session, prefill) {
  return modal(`vc_modal:elink:${session.id}`, "Ubah link Zoom", [
    textInput("link", "Link Zoom (+ kode sandi, opsional)", {
      value: prefill ?? `${session.link}${session.passcode ? ` ${session.passcode}` : ""}`,
      max: 400,
    }),
  ]);
}

const titleModal = (title) =>
  modal("vc_modal:title", "Judul periode VC", [textInput("title", "Judul", { placeholder: "VC Oktober 2026", value: title, max: 60 })]);

// -------------------------------- penolakan ----------------------------------

async function rejectNonOwner(interaction) {
  if (isOwner(interaction.user.id)) return false;
  await interaction.reply(safeReplyOptions({ content: NOT_OWNER_NOTE, flags: MessageFlags.Ephemeral }));
  return true;
}

// Layar pengganti kalau draft (state sementara) sudah hilang: restart bot / kelamaan.
const expiredPanel = () => buildPanel("Cok, sesi inputnya kelamaan/ke-reset - mulai lagi dari menu ya.");

// --------------------------------- tombol ------------------------------------

function duplicateOf(data, member, date, sessionNo, exceptId = null) {
  const key = member.username || `name:${cleanName(member.name).toLowerCase()}`;
  return data.sessions.find((s) => s.id !== exceptId && memberKey(s) === key && s.date === date && s.session === sessionNo) || null;
}

async function pickMember(interaction, member) {
  const draft = getDraft(interaction) || startDraft(interaction);
  draft.member = member;
  draft.date = null;
  draft.session = null;
  draft.lastForm = null;
  await interaction.update(safeReplyOptions(buildDateStep(member)));
}

async function handleVcButton(interaction) {
  if (await rejectNonOwner(interaction)) return;
  const [, action, arg] = interaction.customId.split(":");

  switch (action) {
    case "menu":
      clearDraft(interaction);
      return interaction.update(safeReplyOptions(buildPanel()));
    case "close":
      clearDraft(interaction);
      return deleteInteractionMessage(interaction);
    case "add":
      startDraft(interaction);
      return interaction.showModal(MEMBER_QUERY_MODAL());
    case "use": {
      const draft = getDraft(interaction);
      const match = draft?.matches?.[0];
      if (!match) return interaction.update(safeReplyOptions(expiredPanel()));
      return pickMember(interaction, { username: match.username, name: match.name });
    }
    case "manual": {
      const draft = getDraft(interaction);
      if (!draft?.manualName) return interaction.update(safeReplyOptions(expiredPanel()));
      return pickMember(interaction, { username: null, name: draft.manualName });
    }
    case "again": {
      // "Sesi lagi": member dan tanggal yang sama (beberapa sesi di hari yang sama itu umum), tinggal pilih sesi berikutnya.
      const draft = getDraft(interaction);
      if (!draft?.member || !draft.date) return interaction.update(safeReplyOptions(expiredPanel()));
      draft.session = null;
      draft.lastForm = null;
      return interaction.update(safeReplyOptions(buildSessionStep(draft.member, draft.date)));
    }
    case "redate": {
      const draft = getDraft(interaction);
      if (!draft?.member) return interaction.update(safeReplyOptions(expiredPanel()));
      draft.date = null;
      draft.session = null;
      draft.lastForm = null;
      return interaction.update(safeReplyOptions(buildDateStep(draft.member)));
    }
    case "date_other":
      return interaction.showModal(DATE_TEXT_MODAL());
    case "form": {
      const draft = getDraft(interaction);
      const slot = draft?.member && draft.date && draft.session ? checkSession(draft.date, draft.session) : null;
      if (!slot?.ok) return interaction.update(safeReplyOptions(expiredPanel()));
      return interaction.showModal(buildFormModal(slot.value, draft.lastForm || {}));
    }
    case "edit":
      return interaction.update(safeReplyOptions(buildEntryList()));
    case "eform": {
      const session = getVcSession(arg);
      if (!session) return interaction.update(safeReplyOptions(buildPanel("Cok, sesi itu udah gak ada.")));
      const draft = getDraft(interaction) || startDraft(interaction);
      const prefill = draft.lastEdit && draft.lastEdit.id === session.id ? draft.lastEdit.fields : {};
      return interaction.showModal(buildEditFormModal(session, prefill));
    }
    case "elink": {
      const session = getVcSession(arg);
      if (!session) return interaction.update(safeReplyOptions(buildPanel("Cok, sesi itu udah gak ada.")));
      const draft = getDraft(interaction);
      const prefill = draft?.lastLink && draft.lastLink.id === session.id ? draft.lastLink.value : undefined;
      return interaction.showModal(buildLinkModal(session, prefill));
    }
    case "enote": {
      const session = getVcSession(arg);
      if (!session) return interaction.update(safeReplyOptions(buildPanel("Cok, sesi itu udah gak ada.")));
      await interaction.deferUpdate();
      const updated = updateVcSession(session.id, {
        note: generateNote({ name: session.name, tickets: session.tickets, open: session.open, start: session.start }),
      });
      const sync = await syncSummary(interaction.user.id);
      return interaction.editReply(safeReplyOptions(buildEntryScreen(updated, `🎲 Catatan baru!${syncWarning(sync)}`)));
    }
    case "edel": {
      const session = getVcSession(arg);
      if (!session) return interaction.update(safeReplyOptions(buildPanel("Cok, sesi itu udah gak ada.")));
      return interaction.update(
        safeReplyOptions({
          content: `Yakin hapus sesi ini?\n${describeSession(session)}`,
          components: [
            row(button(`vc_flow:edelok:${session.id}`, "✅ Ya, hapus", ButtonStyle.Danger), button(`vc_flow:eback:${session.id}`, "❌ Batal")),
            navRow(),
          ],
        }),
      );
    }
    case "eback": {
      const session = getVcSession(arg);
      return interaction.update(safeReplyOptions(session ? buildEntryScreen(session) : buildPanel()));
    }
    case "edelok": {
      await interaction.deferUpdate();
      const session = getVcSession(arg);
      const removed = removeVcSession(arg);
      const sync = removed ? await syncSummary(interaction.user.id) : { ok: true };
      const text = removed ? `🗑️ Dihapus: ${session ? sessionLabel(session) : "sesi"}.` : "Sesi itu udah gak ada.";
      return interaction.editReply(safeReplyOptions(buildPanel(`${text}${syncWarning(sync)}`)));
    }
    case "title":
      return interaction.showModal(titleModal(loadVc().title || defaultVcTitle()));
    case "opener": {
      await interaction.deferUpdate();
      const data = ensurePeriod();
      data.opener = generateOpener({ title: data.title });
      saveVc(data);
      const sync = await syncSummary(interaction.user.id);
      return interaction.editReply(safeReplyOptions(buildPanel(`🎲 Pembuka baru!${syncWarning(sync)}`)));
    }
    case "repost": {
      await interaction.deferUpdate();
      ensurePeriod();
      const sync = await syncSummary(interaction.user.id, { repost: true });
      return interaction.editReply(
        safeReplyOptions(buildPanel(sync.ok ? "📌 Rangkuman dikirim ulang di paling bawah." : `⚠️ Gagal kirim ulang (${sync.reason}).`)),
      );
    }
    case "reset":
      return interaction.update(
        safeReplyOptions({
          content: "Yakin mau kosongkan SEMUA sesi dan mulai periode baru? Julukan member tetap disimpen.",
          components: [row(button("vc_flow:resetok", "✅ Ya, kosongkan", ButtonStyle.Danger), button("vc_flow:menu", "❌ Batal")), navRow()],
        }),
      );
    case "resetok": {
      await interaction.deferUpdate();
      resetVcPeriod(generateOpener({ title: defaultVcTitle() }));
      const sync = await syncSummary(interaction.user.id);
      return interaction.editReply(safeReplyOptions(buildPanel(`🧹 Periode baru dimulai.${syncWarning(sync)}`)));
    }
    default:
      return undefined;
  }
}

// -------------------------------- dropdown -----------------------------------

async function handleVcSelect(interaction) {
  if (await rejectNonOwner(interaction)) return;
  const action = interaction.customId.split(":")[1];
  const value = interaction.values[0];

  if (action === "member") {
    const draft = getDraft(interaction);
    if (!draft) return interaction.update(safeReplyOptions(expiredPanel()));
    if (value === "__manual__") {
      if (!draft.manualName) return interaction.update(safeReplyOptions(expiredPanel()));
      return pickMember(interaction, { username: null, name: draft.manualName });
    }
    const match = draft.matches.find((m) => m.username === value);
    if (!match) return interaction.update(safeReplyOptions(expiredPanel()));
    return pickMember(interaction, { username: match.username, name: match.name });
  }

  if (action === "date") {
    const draft = getDraft(interaction);
    if (!draft?.member) return interaction.update(safeReplyOptions(expiredPanel()));
    const parsed = parseDateInput(value);
    if (!parsed.ok) return interaction.update(safeReplyOptions(buildDateStep(draft.member, parsed.error)));
    draft.date = parsed.value;
    draft.session = null;
    draft.lastForm = null;
    return interaction.update(safeReplyOptions(buildSessionStep(draft.member, draft.date)));
  }

  if (action === "session") {
    const draft = getDraft(interaction);
    if (!draft?.member || !draft.date) return interaction.update(safeReplyOptions(expiredPanel()));
    const slot = checkSession(draft.date, Number(value));
    // Dropdown cuma berisi sesi yang ada di hari itu; ini menjaga kalau layar lama (tanggal sudah berganti) masih diklik.
    if (!slot.ok) return interaction.update(safeReplyOptions(buildSessionStep(draft.member, draft.date, slot.error)));
    draft.session = slot.value.session;
    draft.lastForm = null;
    return interaction.showModal(buildFormModal(slot.value));
  }

  if (action === "entry") {
    const session = getVcSession(value);
    return interaction.update(safeReplyOptions(session ? buildEntryScreen(session) : buildPanel("Cok, sesi itu udah gak ada.")));
  }
  return undefined;
}

// ---------------------------------- modal ------------------------------------

const field = (interaction, id) => interaction.fields.getTextInputValue(id);

async function handleSearchSubmit(interaction) {
  await interaction.deferUpdate(); // pencarian bisa sampai ke IDN (lambat) - interaksi harus segera diakui
  const query = field(interaction, "member_query").trim();
  const draft = getDraft(interaction) || startDraft(interaction);
  draft.manualName = query.length >= 2 ? query.replace(/\s+/g, " ").slice(0, 40) : null;
  const { matches, idnError } = await searchTargetCandidates(query);
  draft.matches = matches;

  let screen;
  if (idnError) screen = buildSearchRetry(`Cok, "${query}" belum ada di catatan bot, dan IDN lagi gak bisa dicek.`, draft.manualName);
  else if (matches.length === 0) screen = buildSearchRetry(`Cok, gak nemu member bernama "${query}".`, draft.manualName);
  else if (matches.length === 1) screen = buildSingleMatch(matches[0], draft.manualName || query);
  else screen = buildMultiMatch(matches, draft.manualName || query);
  await interaction.editReply(safeReplyOptions(screen));
}

async function handleDateTextSubmit(interaction) {
  const draft = getDraft(interaction);
  if (!draft?.member) return interaction.update(safeReplyOptions(expiredPanel()));
  const parsed = parseDateInput(field(interaction, "date_text"));
  if (!parsed.ok) {
    return interaction.update(
      safeReplyOptions({ content: parsed.error, components: [row(button("vc_flow:date_other", "📅 Coba lagi", ButtonStyle.Primary)), navRow()] }),
    );
  }
  draft.date = parsed.value;
  draft.session = null;
  draft.lastForm = null;
  return interaction.update(safeReplyOptions(buildSessionStep(draft.member, draft.date)));
}

async function handleFormSubmit(interaction) {
  await interaction.deferUpdate();
  const draft = getDraft(interaction);
  if (!draft?.member || !draft.date || !draft.session) return interaction.editReply(safeReplyOptions(expiredPanel()));

  const raw = {
    mulai: field(interaction, "mulai"),
    link: field(interaction, "link"),
    tiket: field(interaction, "tiket"),
  };
  draft.lastForm = raw; // dipakai buat mengisi ulang form kalau ada yang salah - owner tidak mengetik dari nol
  // Sesi + tanggal dari dropdown sebelumnya ikut divalidasi: jam buka diturunkan dari sana, bukan diketik.
  const result = validateSessionForm(raw, undefined, { date: draft.date, session: draft.session });
  if (!result.ok) return interaction.editReply(safeReplyOptions(buildErrorStep(result.errors, "vc_flow:form")));

  const data = ensurePeriod();
  const { value } = result;
  const duplicate = duplicateOf(data, draft.member, draft.date, draft.session);
  if (duplicate) {
    return interaction.editReply(
      safeReplyOptions(
        buildErrorStep(
          [`Sesi ${draft.session} buat ${cleanName(draft.member.name)} di tanggal itu udah ada - pakai "Ubah / Hapus" kalau mau diganti.`],
          "vc_flow:form",
        ),
      ),
    );
  }

  const session = addVcSession({
    username: draft.member.username,
    name: draft.member.name,
    session: draft.session,
    date: draft.date,
    open: value.open,
    openEnd: value.openEnd,
    start: value.start,
    tickets: value.tickets,
    link: value.link,
    passcode: value.passcode,
    note: generateNote({ name: draft.member.name, tickets: value.tickets, open: value.open, start: value.start }),
  });
  draft.lastForm = null;
  draft.session = null; // tanggal dipertahankan: "Sesi lagi" lanjut ke sesi berikutnya di hari yang sama
  const sync = await syncSummary(interaction.user.id);
  await interaction.editReply(
    safeReplyOptions({
      content: `✅ Tersimpan: ${describeSession(session)}${syncWarning(sync)}`,
      components: [
        row(
          button("vc_flow:again", `➕ Sesi lagi (${cleanName(draft.member.name).slice(0, 30)})`, ButtonStyle.Success),
          button("vc_flow:add", "➕ Member lain", ButtonStyle.Success),
          button("vc_flow:edit", "✏️ Ubah / Hapus"),
        ),
        navRow(),
      ],
    }),
  );
}

async function handleEditFormSubmit(interaction) {
  await interaction.deferUpdate();
  const id = Number(interaction.customId.split(":")[2]);
  const session = getVcSession(id);
  if (!session) return interaction.editReply(safeReplyOptions(buildPanel("Cok, sesi itu udah gak ada.")));

  const raw = {
    sesi: field(interaction, "sesi"),
    tanggal: field(interaction, "tanggal"),
    mulai: field(interaction, "mulai"),
    tiket: field(interaction, "tiket"),
  };
  const draft = getDraft(interaction) || startDraft(interaction);
  draft.lastEdit = { id, fields: raw };
  const result = validateSessionForm(raw);
  if (!result.ok) return interaction.editReply(safeReplyOptions(buildErrorStep(result.errors, `vc_flow:eform:${id}`)));

  const { value } = result;
  const duplicate = duplicateOf(loadVc(), session, value.date, value.session, id);
  if (duplicate) {
    return interaction.editReply(
      safeReplyOptions(buildErrorStep([`Sesi ${value.session} di tanggal itu udah dipakai sesi lain member ini.`], `vc_flow:eform:${id}`)),
    );
  }

  // Catatan absurd menyebut jumlah tiket / jeda jam: kalau itu berubah, catatannya dibuat ulang biar tidak basi.
  const timingChanged = value.open !== session.open || value.start !== session.start || value.tickets !== session.tickets;
  const patch = { session: value.session, date: value.date, open: value.open, openEnd: value.openEnd, start: value.start, tickets: value.tickets };
  if (timingChanged) patch.note = generateNote({ name: session.name, tickets: value.tickets, open: value.open, start: value.start });
  const updated = updateVcSession(id, patch);
  draft.lastEdit = null;
  const sync = await syncSummary(interaction.user.id);
  await interaction.editReply(safeReplyOptions(buildEntryScreen(updated, `✅ Diubah.${syncWarning(sync)}`)));
}

async function handleLinkSubmit(interaction) {
  await interaction.deferUpdate();
  const id = Number(interaction.customId.split(":")[2]);
  const session = getVcSession(id);
  if (!session) return interaction.editReply(safeReplyOptions(buildPanel("Cok, sesi itu udah gak ada.")));

  const rawLink = field(interaction, "link");
  const result = validateSessionForm({ link: rawLink });
  if (!result.ok) {
    const draft = getDraft(interaction) || startDraft(interaction);
    draft.lastLink = { id, value: rawLink };
    return interaction.editReply(safeReplyOptions(buildErrorStep(result.errors, `vc_flow:elink:${id}`)));
  }
  const updated = updateVcSession(id, { link: result.value.link, passcode: result.value.passcode });
  const sync = await syncSummary(interaction.user.id);
  await interaction.editReply(safeReplyOptions(buildEntryScreen(updated, `✅ Link diubah.${syncWarning(sync)}`)));
}

async function handleTitleSubmit(interaction) {
  await interaction.deferUpdate();
  const title = field(interaction, "title").trim().replace(/\s+/g, " ");
  if (!title) return interaction.editReply(safeReplyOptions(buildPanel("Judul gak boleh kosong.")));
  const data = ensurePeriod();
  data.title = title.slice(0, 60);
  saveVc(data);
  const sync = await syncSummary(interaction.user.id);
  await interaction.editReply(safeReplyOptions(buildPanel(`📝 Judul diubah.${syncWarning(sync)}`)));
}

async function handleVcModalSubmit(interaction) {
  if (await rejectNonOwner(interaction)) return;
  const [, action] = interaction.customId.split(":");
  if (action === "search") return handleSearchSubmit(interaction);
  if (action === "datetext") return handleDateTextSubmit(interaction);
  if (action === "form") return handleFormSubmit(interaction);
  if (action === "eform") return handleEditFormSubmit(interaction);
  if (action === "elink") return handleLinkSubmit(interaction);
  if (action === "title") return handleTitleSubmit(interaction);
  return undefined;
}

// ------------------------------ perintah teks --------------------------------

// Kunci member untuk julukan dari teks nama: sesi yang sudah ada dulu (nama depan cocok), lalu member yang dikenal bot,
// terakhir nama apa adanya.
function resolveNicknameTarget(nameText) {
  const needle = nameText.trim().toLowerCase();
  const data = loadVc();
  const inSessions = data.sessions.find((s) => matchesNameFragment(needle, cleanName(s.name).split(/\s+/)[0].toLowerCase()));
  if (inSessions) return { key: memberKey(inSessions), display: cleanName(inSessions.name) };
  const known = searchLiveCountByNameFragment(needle);
  if (known.length === 1) return { key: known[0].username, display: cleanName(known[0].name) };
  if (known.length > 1) return { ambiguous: known.map((m) => cleanName(m.name)) };
  return { key: `name:${needle}`, display: nameText.trim() };
}

const NICKNAME_SET = /^(?:cok[,.!?]?\s+)?julukan\s+vc\s+(.+?)\s*=\s*(.+)$/i;
const NICKNAME_CLEAR = /^(?:cok[,.!?]?\s+)?(?:hapus|reset)\s+julukan\s+vc\s+(.+)$/i;
const NICKNAME_MAX = 60;

async function handleNicknameCommand(rawText, authorId) {
  const set = rawText.match(NICKNAME_SET);
  const clear = set ? null : rawText.match(NICKNAME_CLEAR);
  const target = resolveNicknameTarget((set ? set[1] : clear[1]).trim());
  if (target.ambiguous)
    return `Cok, "${(set ? set[1] : clear[1]).trim()}" cocok ke beberapa member (${target.ambiguous.slice(0, 5).join(", ")}) - ketik nama yang lebih lengkap.`;

  if (clear) {
    setVcNickname(target.key, null);
    if (loadVc().sessions.length > 0) await syncSummary(authorId);
    return `✅ Julukan buat **${escapeMd(target.display)}** dihapus.`;
  }
  const nickname = set[2].trim().replace(/\s+/g, " ");
  if (nickname.length > NICKNAME_MAX) return `Cok, julukannya kepanjangan (maks ${NICKNAME_MAX} karakter).`;
  setVcNickname(target.key, nickname);
  const sync = loadVc().sessions.length > 0 ? await syncSummary(authorId) : { ok: true };
  return `✅ Julukan buat **${escapeMd(target.display)}**: "${escapeMd(nickname)}"${syncWarning(sync)}`;
}

// Dipanggil commandRoutes. Balikin null kalau pesannya BUKAN perintah VC (rute berikutnya jalan). Orang selain owner
// juga dapat null: fitur ini tidak boleh kelihatan ada bagi mereka. Owner di luar DM dapat penjelasan.
async function handleVcCommand({ rawText, commandText, authorId, isDm }) {
  const isInput = /^input\s*vc\b/.test(commandText);
  const isNickname = NICKNAME_SET.test(rawText) || NICKNAME_CLEAR.test(rawText);
  if (!isInput && !isNickname) return null;
  if (!isOwner(authorId)) return null;
  if (!isDm) return DM_ONLY_NOTE;

  if (isNickname) return handleNicknameCommand(rawText, authorId);

  ensurePeriod();
  const sync = await syncSummary(authorId);
  return buildPanel(sync.ok ? "" : `⚠️ Gagal update pesan rangkuman (${sync.reason}).`);
}

module.exports = { handleVcCommand, handleVcButton, handleVcSelect, handleVcModalSubmit, syncSummary, buildPanel, ensurePeriod, DM_ONLY_NOTE };
