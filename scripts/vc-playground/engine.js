// Mesin playground "input vc": Discord PALSU yang menjalankan kode ASLI bot (commandRoutes.buildChatReply, tabel
// interactionRoutes, vcFlow, vcRender, storage) tanpa koneksi ke Discord. Yang tiruan hanya lapisan Discord-nya:
//   - channel (DM owner, DM orang lain, channel server) berisi daftar pesan,
//   - objek interaksi yang MENEGAKKAN aturan Discord (sekali ack, editReply butuh ack, modal tidak boleh dari modal,
//     isi <= 2000, maks 5 baris komponen, custom_id unik, dst) - pelanggaran dilempar/dicatat seperti Discord menolaknya.
// Penting: safeEnv HARUS dimuat pertama (lihat catatan di file itu), dan getDiscordClient dipasang SEBELUM vcFlow dimuat
// karena vcFlow mengambil fungsi itu lewat destructuring saat di-require.

const { OWNER_ID, OTHER_ID } = require("./safeEnv");
const { performance } = require("node:perf_hooks");
const { MessageFlags } = require("discord.js");

const config = { failDm: false, clientOff: false, idnDown: false, slow: false };
const SLOW_MS = 1500;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const discordLatency = () => (config.slow ? sleep(SLOW_MS) : Promise.resolve());

// ------------------------------- channel & pesan -------------------------------

const CHANNEL_DEFS = [
  { id: "dm-owner", label: "DM bot · Owner", isDm: true, ownerOf: OWNER_ID },
  { id: "dm-other", label: "DM bot · Orang lain", isDm: true, ownerOf: OTHER_ID },
  { id: "server", label: "# channel bot (server)", isDm: false, ownerOf: null },
];
const channels = Object.fromEntries(CHANNEL_DEFS.map((def) => [def.id, { ...def, messages: [] }]));
const ACTORS = { owner: { id: OWNER_ID, name: "Kamu (owner)" }, other: { id: OTHER_ID, name: "Orang lain" } };

let messageSeq = 0;
let logSeq = 0;
const log = [];
const stats = { blockedFetch: 0 };
const clock = { offsetMs: 0 };

// Date.now() digeser supaya kedaluwarsa draft 30 menit bisa dites tanpa menunggu. Yang digeser HANYA Date.now().
const realNow = Date.now.bind(Date);
Date.now = () => realNow() + clock.offsetMs;

// Semua jaringan diblokir: pencarian member yang tidak dikenal bot menembak IDN, di playground itu dijawab "tidak ditemukan".
global.fetch = async () => {
  stats.blockedFetch++;
  if (config.idnDown) throw new Error("IDN tidak bisa dihubungi (simulasi)");
  return { ok: true, json: async () => ({ errors: [{ message: "IDNAccount: User Not found" }], data: null }) };
};

// ------------------------------ validasi aturan Discord ------------------------------

function validateComponents(rows) {
  const issues = [];
  if (rows.length > 5) issues.push(`${rows.length} baris komponen (maks 5)`);
  const seen = new Set();
  rows.forEach((row, r) => {
    const items = row.components || [];
    const selects = items.filter((c) => c.type === 3);
    if (items.length === 0) issues.push(`baris ${r + 1} kosong`);
    if (selects.length > 0 && items.length > 1) issues.push(`baris ${r + 1}: dropdown tidak boleh digabung dengan komponen lain`);
    if (items.length > 5) issues.push(`baris ${r + 1}: ${items.length} komponen (maks 5)`);
    for (const c of items) {
      if (c.type !== 5 && c.custom_id) {
        if (c.custom_id.length > 100) issues.push(`custom_id "${c.custom_id.slice(0, 20)}…" lebih dari 100 karakter`);
        if (seen.has(c.custom_id)) issues.push(`custom_id ganda: ${c.custom_id}`);
        seen.add(c.custom_id);
      }
      if (c.type === 2) {
        if (!c.label && !c.emoji) issues.push(`tombol ${c.custom_id} tanpa label`);
        if ((c.label || "").length > 80) issues.push(`label tombol ${c.custom_id} ${c.label.length} karakter (maks 80)`);
      }
      if (c.type === 3) {
        const options = c.options || [];
        if (options.length < 1 || options.length > 25) issues.push(`dropdown ${c.custom_id}: ${options.length} opsi (harus 1-25)`);
        if ((c.placeholder || "").length > 150) issues.push(`placeholder dropdown ${c.custom_id} lebih dari 150 karakter`);
        for (const o of options) {
          if (!o.label || o.label.length > 100) issues.push(`opsi dropdown "${(o.label || "").slice(0, 20)}" label kosong/lebih dari 100`);
          if (!o.value || o.value.length > 100) issues.push(`opsi dropdown "${(o.label || "").slice(0, 20)}" value kosong/lebih dari 100`);
          if ((o.description || "").length > 100) issues.push(`deskripsi opsi "${o.label}" lebih dari 100 karakter`);
        }
      }
    }
  });
  return issues;
}

// Mengembalikan daftar pelanggaran aturan Discord untuk isi sebuah pesan (kosong = lolos).
function validateMessage(msg) {
  const issues = [];
  const content = msg.content || "";
  if (content.length > 2000) issues.push(`isi pesan ${content.length} karakter (maks 2000)`);
  const embeds = msg.embeds || [];
  if (embeds.length > 10) issues.push(`${embeds.length} embed (maks 10)`);
  let embedChars = 0;
  for (const e of embeds) {
    if ((e.description || "").length > 4096) issues.push(`deskripsi embed ${e.description.length} karakter (maks 4096)`);
    if ((e.title || "").length > 256) issues.push("judul embed lebih dari 256 karakter");
    embedChars += (e.description || "").length + (e.title || "").length;
  }
  if (embedChars > 6000) issues.push(`total teks embed ${embedChars} karakter (maks 6000)`);
  if (!content.trim() && embeds.length === 0 && (msg.files || []).length === 0) issues.push("pesan kosong (tanpa isi, embed, atau file)");
  issues.push(...validateComponents(msg.components || []));
  return issues;
}

function validateModal(modal) {
  const issues = [];
  if (!modal.title || modal.title.length > 45) issues.push(`judul modal "${modal.title}" harus 1-45 karakter`);
  if (!modal.custom_id || modal.custom_id.length > 100) issues.push("custom_id modal kosong/lebih dari 100 karakter");
  const rows = modal.components || [];
  if (rows.length < 1 || rows.length > 5) issues.push(`${rows.length} isian di modal (harus 1-5)`);
  for (const row of rows) {
    const inputs = row.components || [];
    if (inputs.length !== 1) issues.push("tiap baris modal harus berisi tepat 1 isian");
    for (const input of inputs) {
      if (!input.label || input.label.length > 45) issues.push(`label isian "${input.label}" harus 1-45 karakter`);
      if ((input.placeholder || "").length > 100) issues.push(`placeholder isian "${input.label}" lebih dari 100 karakter`);
      if ((input.value || "").length > 4000) issues.push(`nilai awal isian "${input.label}" lebih dari 4000 karakter`);
      if (input.max_length !== undefined && (input.max_length < 1 || input.max_length > 4000))
        issues.push(`max_length isian "${input.label}" di luar 1-4000`);
      if (input.max_length !== undefined && (input.value || "").length > input.max_length)
        issues.push(`nilai awal isian "${input.label}" melebihi max_length`);
    }
  }
  return issues;
}

// --------------------------------- normalisasi ---------------------------------

const toJson = (x) => (x && typeof x.toJSON === "function" ? x.toJSON() : x);

function isEphemeralFlags(flags) {
  if (Array.isArray(flags)) return flags.includes(MessageFlags.Ephemeral);
  return typeof flags === "number" && (flags & MessageFlags.Ephemeral) === MessageFlags.Ephemeral;
}

// Payload bot (string / objek discord.js) -> bentuk polos yang dipakai playground.
function normalizeOutgoing(payload) {
  const base = typeof payload === "string" ? { content: payload } : payload || {};
  return {
    content: typeof base.content === "string" ? base.content : undefined,
    embeds: Array.isArray(base.embeds) ? base.embeds.map(toJson) : undefined,
    components: Array.isArray(base.components) ? base.components.map(toJson) : undefined,
    files: Array.isArray(base.files) ? base.files.map((f) => ({ name: f?.name || f?.attachment?.name || "file" })) : undefined,
    ephemeral: isEphemeralFlags(base.flags),
  };
}

function discordError(message, code) {
  return Object.assign(new Error(message), { code });
}

function addMessage(channel, { author, authorId = null, patch = {} }) {
  const message = {
    id: `m${++messageSeq}`,
    author,
    authorId,
    content: patch.content ?? "",
    embeds: patch.embeds ?? [],
    components: patch.components ?? [],
    files: patch.files ?? [],
    ephemeral: Boolean(patch.ephemeral),
    visibleTo: patch.ephemeral ? (patch.visibleTo ?? null) : null,
    edited: false,
    at: realNow() + clock.offsetMs,
  };
  const issues = author === "bot" ? validateMessage(message) : [];
  if (issues.length > 0) throw discordError(`Invalid Form Body: ${issues.join("; ")}`, 50035);
  channel.messages.push(message);
  return message;
}

// Perilaku PATCH pesan Discord: field yang tidak dikirim tidak berubah; yang dikirim menggantikan.
function applyEdit(message, patch) {
  const next = {
    ...message,
    content: patch.content ?? message.content,
    embeds: patch.embeds ?? message.embeds,
    components: patch.components ?? message.components,
    files: patch.files ?? message.files,
  };
  const issues = validateMessage(next);
  if (issues.length > 0) throw discordError(`Invalid Form Body: ${issues.join("; ")}`, 50035);
  Object.assign(message, next, { edited: true });
}

const findMessage = (channel, id) => channel.messages.find((m) => m.id === id) || null;
const unknownMessage = () => discordError("Unknown Message", 10008);

function removeMessage(channel, id) {
  const index = channel.messages.findIndex((m) => m.id === id);
  if (index === -1) return false;
  channel.messages.splice(index, 1);
  return true;
}

// ------------------------- Discord palsu untuk vcFlow (DM) -------------------------

function dmApiFor(channel) {
  return {
    id: channel.id,
    send: async (payload) => {
      await discordLatency();
      const message = addMessage(channel, { author: "bot", patch: normalizeOutgoing(payload) });
      return { id: message.id };
    },
    messages: {
      edit: async (id, payload) => {
        await discordLatency();
        const message = findMessage(channel, id);
        if (!message) throw unknownMessage();
        applyEdit(message, normalizeOutgoing(payload));
      },
      delete: async (id) => {
        await discordLatency();
        if (!removeMessage(channel, id)) throw unknownMessage();
      },
    },
  };
}

const fakeClient = {
  users: {
    fetch: async (userId) => ({
      createDM: async () => {
        await discordLatency();
        if (config.failDm) throw new Error("Cannot send messages to this user");
        return dmApiFor(userId === OWNER_ID ? channels["dm-owner"] : channels["dm-other"]);
      },
    }),
  },
};

require("../../src/discordClient").getDiscordClient = () => (config.clientOff ? null : fakeClient);

const { buildChatReply } = require("../../src/chat/commandRoutes");
const { findInteractionRoute } = require("../../src/chat/interactionRoutes");
const { safeReplyOptions, getTodayWIB } = require("../../src/utils");
const { shiftDateWIB } = require("../../src/streakMath");
const { loadVc, addVcSession } = require("../../src/storage/vcSchedule");
const { ensurePeriod, syncSummary, resetTransientState } = require("../../src/chat/vcFlow");
const { generateNote } = require("../../src/chat/vcAbsurd");
const { slotsForDate, startRange } = require("../../src/chat/vcSlots");
const { recordLiveCompleted } = require("../../src/storage/liveCount");
const { getRegisteredStore } = require("../../src/storage/jsonStore");

// ------------------------------- interaksi palsu -------------------------------

const ACK_DEADLINE_MS = 3000;

class FakeInteraction {
  constructor({ kind, customId, values, fields, actor, channel, message, entry }) {
    this.kind = kind;
    this.customId = customId;
    this.values = values;
    this.user = { id: actor.id };
    this.channelId = channel.id;
    this.guildId = channel.isDm ? null : "playground-guild";
    this.message = message ? { id: message.id, delete: async () => void removeMessage(channel, message.id) } : null;
    this.fields = {
      getTextInputValue: (id) => {
        if (!(id in fields)) throw new Error(`field "${id}" tidak dikirim`);
        return String(fields[id]);
      },
    };
    this.deferred = false;
    this.replied = false;
    this.modalJson = null;
    this.ackKind = null;
    this.ackMs = null;
    this.replyMessageId = null;
    this._channel = channel;
    this._source = message;
    this._entry = entry;
    this._startedAt = performance.now();
  }

  isButton() {
    return this.kind === "button";
  }
  isStringSelectMenu() {
    return this.kind === "select";
  }
  isModalSubmit() {
    return this.kind === "modal";
  }
  isChatInputCommand() {
    return false;
  }
  isAutocomplete() {
    return false;
  }
  isRepliable() {
    return true;
  }
  inGuild() {
    return !this._channel.isDm;
  }

  _ack(kind) {
    if (this.ackKind) throw discordError("Interaction has already been acknowledged.", 40060);
    this.ackKind = kind;
    this.ackMs = Math.round(performance.now() - this._startedAt);
    if (this.ackMs > ACK_DEADLINE_MS)
      this._entry.issues.push(`Respons pertama baru keluar setelah ${this.ackMs} ms (batas Discord 3000 ms) - tombol akan gagal`);
  }

  // Balasan ephemeral hanya terlihat oleh orang yang berinteraksi.
  _patchFor(payload) {
    return { ...normalizeOutgoing(payload), visibleTo: this.user.id };
  }

  _editSource(payload) {
    if (!this._source || !findMessage(this._channel, this._source.id)) throw unknownMessage();
    applyEdit(findMessage(this._channel, this._source.id), normalizeOutgoing(payload));
  }

  async update(payload) {
    if (this.kind === "modal" && !this._source) throw discordError("Modal ini tidak dibuka dari komponen pesan, update() tidak berlaku.", 40060);
    this._ack("update");
    this._editSource(payload);
  }

  async deferUpdate() {
    this._ack("deferUpdate");
    this.deferred = true;
  }

  async reply(payload) {
    this._ack("reply");
    this.replied = true;
    this.replyMessageId = addMessage(this._channel, { author: "bot", patch: this._patchFor(payload) }).id;
  }

  async deferReply() {
    this._ack("deferReply");
    this.deferred = true;
  }

  async editReply(payload) {
    if (!this.ackKind) throw discordError("The reply to this interaction has not been sent or deferred.", "InteractionNotReplied");
    if (this.ackKind === "reply" || this.ackKind === "deferReply") {
      const message = this.replyMessageId && findMessage(this._channel, this.replyMessageId);
      if (message) return applyEdit(message, normalizeOutgoing(payload));
      this.replyMessageId = addMessage(this._channel, { author: "bot", patch: this._patchFor(payload) }).id;
      return undefined;
    }
    return this._editSource(payload);
  }

  async followUp(payload) {
    if (!this.ackKind) throw discordError("The reply to this interaction has not been sent or deferred.", "InteractionNotReplied");
    addMessage(this._channel, { author: "bot", patch: this._patchFor(payload) });
  }

  async showModal(modal) {
    if (this.kind === "modal") throw discordError("Modal tidak bisa dibuka sebagai jawaban atas pengiriman modal.", 40060);
    const json = toJson(modal); // discord.js memvalidasi batas builder (judul/label/panjang) di sini
    const issues = validateModal(json);
    if (issues.length > 0) throw discordError(`Invalid Form Body (modal): ${issues.join("; ")}`, 50035);
    this._ack("showModal");
    this.modalJson = json;
  }
}

// -------------------------------- pencatatan --------------------------------

function startLog(kind, actorKey, summary) {
  const entry = {
    n: ++logSeq,
    at: realNow() + clock.offsetMs,
    kind,
    actor: actorKey,
    summary,
    ack: null,
    ackMs: null,
    ms: null,
    issues: [],
    error: null,
  };
  log.push(entry);
  if (log.length > 300) log.shift();
  return entry;
}

// ---------------------------------- aksi ----------------------------------

let chain = Promise.resolve();
function serial(fn) {
  const run = chain.then(() => fn());
  chain = run.catch(() => {});
  return run;
}

function channelOf(id) {
  const channel = channels[id];
  if (!channel) throw new Error(`channel "${id}" tidak dikenal`);
  return channel;
}
function actorOf(key) {
  const actor = ACTORS[key];
  if (!actor) throw new Error(`aktor "${key}" tidak dikenal`);
  return actor;
}

function sendText({ channel: channelId, actor: actorKey, text }) {
  return serial(async () => {
    const channel = channelOf(channelId);
    const actor = actorOf(actorKey);
    const body = String(text ?? "");
    if (!body.trim()) throw new Error("teks kosong");
    const entry = startLog("pesan", actorKey, body.slice(0, 80));
    const t0 = performance.now();
    addMessage(channel, { author: "user", authorId: actor.id, patch: { content: body.slice(0, 2000) } });
    try {
      const reply = await buildChatReply(body, { isBotChannel: true, isDm: channel.isDm, channelId: channel.id, authorId: actor.id });
      if (reply === null || reply === undefined || reply === "") {
        entry.ack = "diam";
        entry.summary += "  → bot tidak membalas";
      } else {
        addMessage(channel, { author: "bot", patch: normalizeOutgoing(safeReplyOptions(reply)) });
        entry.ack = "balasan";
      }
    } catch (error) {
      entry.error = error.message;
      entry.issues.push(`Balasan gagal dikirim: ${error.message}`);
    }
    entry.ms = Math.round(performance.now() - t0);
    return entry;
  });
}

// Meniru notifyInteractionFailure (chat/router.js): handler melempar -> pengguna dapat balasan ephemeral singkat.
async function replyWithInteractionFailure(interaction, error) {
  if (error?.code === 10062 || error?.code === 40060) return;
  try {
    const payload = safeReplyOptions({ content: "Cok, ada error pas ngejalanin itu. Coba lagi bentar ya.", flags: MessageFlags.Ephemeral });
    if (interaction.deferred || interaction.replied) await interaction.followUp(payload);
    else await interaction.reply(payload);
  } catch {
    // sama seperti bot asli: kegagalan memberi tahu pengguna hanya dicatat.
  }
}

function interact({ channel: channelId, actor: actorKey, kind, customId, values = [], fields = {}, messageId = null }) {
  return serial(async () => {
    const channel = channelOf(channelId);
    const actor = actorOf(actorKey);
    if (!["button", "select", "modal"].includes(kind)) throw new Error(`jenis interaksi "${kind}" tidak dikenal`);
    if (typeof customId !== "string" || !customId) throw new Error("customId kosong");
    const label = { button: "tombol", select: "dropdown", modal: "form" }[kind];
    const detail = kind === "select" ? ` = ${values.join(",")}` : kind === "modal" ? ` {${Object.keys(fields).join(",")}}` : "";
    const entry = startLog(label, actorKey, `${customId}${detail}`);
    const message = messageId ? findMessage(channel, messageId) : null;
    const interaction = new FakeInteraction({ kind, customId, values, fields, actor, channel, message, entry });
    const route = findInteractionRoute(interaction);
    const t0 = performance.now();
    if (!route) {
      entry.issues.push(`Tidak ada rute untuk customId "${customId}" - tombolnya tidak akan merespons`);
    } else {
      try {
        await route.handler(interaction);
      } catch (error) {
        entry.error = error.message;
        entry.issues.push(`Handler melempar error: ${error.message}`);
        await replyWithInteractionFailure(interaction, error);
      }
    }
    entry.ms = Math.round(performance.now() - t0);
    entry.ack = interaction.ackKind;
    entry.ackMs = interaction.ackMs;
    if (route && !interaction.ackKind) entry.issues.push('Tidak ada respons sama sekali - Discord akan menampilkan "Interaksi ini gagal"');
    return { entry, modal: interaction.modalJson, ack: interaction.ackKind };
  });
}

function deleteMessage({ channel: channelId, id }) {
  return serial(async () => {
    const channel = channelOf(channelId);
    const removed = removeMessage(channel, id);
    startLog("sistem", "owner", removed ? `pesan ${id} dihapus manual dari Discord` : `pesan ${id} sudah tidak ada`);
    return removed;
  });
}

function setConfig(partial) {
  return serial(async () => {
    for (const key of Object.keys(config)) if (typeof partial?.[key] === "boolean") config[key] = partial[key];
    startLog("sistem", "owner", `pengaturan simulasi: ${JSON.stringify(config)}`);
  });
}

function advanceClock(minutes) {
  return serial(async () => {
    const m = Number(minutes);
    if (!Number.isFinite(m) || m < 0 || m > 24 * 60) throw new Error("menit harus 0-1440");
    clock.offsetMs = m === 0 ? 0 : clock.offsetMs + m * 60_000;
    startLog(
      "sistem",
      "owner",
      m === 0 ? "jam bot dikembalikan ke waktu asli" : `jam bot dimajukan ${m} menit (total +${Math.round(clock.offsetMs / 60_000)} menit)`,
    );
  });
}

// ------------------------------- data contoh -------------------------------

const SAMPLE_MEMBERS = [
  { username: "jkt48_lily", name: "Lily JKT48" },
  { username: "jkt48_levi", name: "Levi JKT48" },
  { username: "jkt48_nala", name: "Nala JKT48" },
  { username: "jkt48_aralie", name: "Aralie JKT48" },
  { username: "jkt48_delynn", name: "Delynn JKT48" },
  { username: "jkt48_christy", name: "Christy JKT48" },
  { username: "jkt48_gracia", name: "Gracia JKT48" },
  { username: "jkt48_marsha", name: "Marsha JKT48" },
];

function seedKnownMembers() {
  for (const member of SAMPLE_MEMBERS) recordLiveCompleted(member.username, member.name);
}
seedKnownMembers();

const fakeLink = (n) => `https://us02web.zoom.us/j/${String(81000000000 + n)}?pwd=contoh${n}`;
const plus = (days) => shiftDateWIB(getTodayWIB(), days);

// Baris contoh: sesi yang DIINGINKAN per hari; sesi sebenarnya diambil dari jadwal hari itu (vcSlots) supaya data contoh selalu
// valid, apa pun hari saat dijalankan (hari kerja cuma punya sesi 1-3).
function sampleRows(many) {
  if (!many) {
    return [
      { m: 0, day: 3, session: 2, tickets: 3, pass: "388756" },
      { m: 0, day: 3, session: 3, tickets: 5, pass: "087798" },
      { m: 1, day: 4, session: 1, tickets: 2, pass: null },
      { m: 2, day: 4, session: 1, tickets: null, pass: null },
      { m: 3, day: 2, session: 1, tickets: null, pass: null },
      { m: 4, day: 3, session: 3, tickets: 3, pass: "261337" },
    ];
  }
  const rows = [];
  for (let i = 0; i < 36; i++) {
    rows.push({
      m: i % SAMPLE_MEMBERS.length,
      day: 1 + (i % 12),
      session: 1 + (Math.floor(i / SAMPLE_MEMBERS.length) % 6),
      tickets: i % 4 === 0 ? null : (i % 6) + 1,
      pass: i % 3 === 0 ? String(100000 + i) : null,
    });
  }
  return rows;
}

function seed({ many = false } = {}) {
  return serial(async () => {
    ensurePeriod();
    let added = 0;
    const existing = [...loadVc().sessions]; // salinan: loadVc() mengembalikan objek cache yang sama dengan yang diubah addVcSession
    sampleRows(many).forEach((row, i) => {
      const member = SAMPLE_MEMBERS[row.m];
      const date = plus(row.day);
      const slots = slotsForDate(date);
      const slot = slots[(row.session - 1) % slots.length];
      if (existing.some((s) => s.username === member.username && s.date === date && s.session === slot.session)) return;
      const created = addVcSession({
        username: member.username,
        name: member.name,
        session: slot.session,
        date,
        open: slot.open,
        openEnd: slot.openEnd,
        start: startRange(slot).startFrom, // jam mulai contoh = awal rentang mulai (15 menit sebelum buka)
        tickets: row.tickets,
        link: fakeLink(i + 1),
        passcode: row.pass,
        note: generateNote({ name: member.name, tickets: row.tickets, open: slot.open, start: startRange(slot).startFrom }),
      });
      existing.push(created);
      added++;
    });
    const sync = await syncSummary(OWNER_ID);
    startLog(
      "sistem",
      "owner",
      `data contoh${many ? " (banyak)" : ""}: +${added} sesi, sinkron pesan rangkuman ${sync.ok ? "berhasil" : `gagal (${sync.reason})`}`,
    );
    return { added, sync };
  });
}

function reset() {
  return serial(async () => {
    getRegisteredStore("vc-schedule.json").store.save({ title: null, opener: null, sessions: [], nicknames: {}, nextId: 1, message: null });
    resetTransientState();
    for (const channel of Object.values(channels)) channel.messages.length = 0;
    log.length = 0;
    stats.blockedFetch = 0;
    startLog("sistem", "owner", "data VC, pesan, dan log dikosongkan");
  });
}

// --------------------------------- state ---------------------------------

function getState() {
  return {
    owner: OWNER_ID,
    actors: ACTORS,
    channels: Object.values(channels).map(({ id, label, isDm, messages }) => ({ id, label, isDm, messages })),
    vc: loadVc(),
    config: { ...config, blockedFetch: stats.blockedFetch, clockOffsetMin: Math.round(clock.offsetMs / 60_000) },
    log: log.slice(-150),
    now: realNow() + clock.offsetMs,
  };
}

module.exports = {
  OWNER_ID,
  OTHER_ID,
  getState,
  sendText,
  interact,
  deleteMessage,
  setConfig,
  advanceClock,
  seed,
  reset,
  validateMessage,
  validateModal,
  // Hanya untuk tes playground.
  _internals: { FakeInteraction, channels },
};
