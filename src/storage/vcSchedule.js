const path = require("path");
const { CACHE_DIR } = require("../config");
const { createJsonStore } = require("./jsonStore");
const { getTodayWIB, formatMonthLabel } = require("../utils");

// Rangkuman VC (Video Call) member yang diinput owner lewat DM ("input vc", chat/vcFlow.js). Satu periode aktif:
//   {
//     title:    "VC Oktober 2026",
//     opener:   kalimat pembuka absurd (digenerate sekali, disimpan supaya pesan tidak berubah tiap di-render),
//     sessions: [{ id, username|null, name, session, date: "YYYY-MM-DD", open: "HH:MM", start: "HH:MM",
//                  tickets: angka|null, link, passcode|null, note }],
//     nicknames: { <kunci member>: "julukan" },   // kunci = username, atau "name:<nama huruf kecil>" untuk member non-IDN
//     nextId:   penghitung id sesi,
//     message:  { channelId, ids: [id pesan rangkuman] } | null   // pesan yang di-edit terus di DM owner
//   }
// Berisi link Zoom (+ kode sandi): hanya hidup di DM owner dan ikut backup (yang juga dikirim ke DM owner).
const VC_FILE = path.join(CACHE_DIR, "vc-schedule.json");

const emptyVc = () => ({ title: null, opener: null, sessions: [], nicknames: {}, nextId: 1, message: null });
const store = createJsonStore(VC_FILE, emptyVc, { errorLabel: "rangkuman VC" });

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// File bisa diedit tangan / dipulihkan dari backup lama: bentuk dipaksa lengkap supaya pemanggil tidak perlu cek.
function loadVc() {
  const raw = store.load();
  if (!isPlainObject(raw)) {
    const fresh = emptyVc();
    store.save(fresh);
    return fresh;
  }
  if (!Array.isArray(raw.sessions)) raw.sessions = [];
  if (!isPlainObject(raw.nicknames)) raw.nicknames = {};
  if (!Number.isInteger(raw.nextId) || raw.nextId < 1) raw.nextId = raw.sessions.reduce((max, s) => Math.max(max, Number(s?.id) || 0), 0) + 1;
  if (typeof raw.title !== "string") raw.title = null;
  if (typeof raw.opener !== "string") raw.opener = null;
  if (!isPlainObject(raw.message) || !Array.isArray(raw.message.ids)) raw.message = null;
  return raw;
}

function saveVc(data) {
  store.save(data);
}

// "VC Oktober 2026" - judul bawaan periode baru (bulan berjalan WIB).
function defaultVcTitle() {
  return `VC ${formatMonthLabel(getTodayWIB().slice(0, 7))}`;
}

function addVcSession(fields) {
  const data = loadVc();
  const session = { ...fields, id: data.nextId };
  data.nextId += 1;
  data.sessions.push(session);
  saveVc(data);
  return session;
}

function getVcSession(id) {
  return loadVc().sessions.find((s) => s.id === Number(id)) || null;
}

// Balikin sesi hasil update, atau null kalau id-nya sudah tidak ada (mis. keburu dihapus).
function updateVcSession(id, patch) {
  const data = loadVc();
  const session = data.sessions.find((s) => s.id === Number(id));
  if (!session) return null;
  Object.assign(session, patch);
  saveVc(data);
  return session;
}

function removeVcSession(id) {
  const data = loadVc();
  const before = data.sessions.length;
  data.sessions = data.sessions.filter((s) => s.id !== Number(id));
  if (data.sessions.length === before) return false;
  saveVc(data);
  return true;
}

// text kosong/null = hapus julukan.
function setVcNickname(memberKey, text) {
  const data = loadVc();
  if (text) data.nicknames[memberKey] = text;
  else delete data.nicknames[memberKey];
  saveVc(data);
}

// Periode baru: sesi dikosongkan, judul kembali ke bawaan bulan ini. Julukan dan referensi pesan rangkuman TETAP.
function resetVcPeriod(opener) {
  const data = loadVc();
  data.sessions = [];
  data.title = defaultVcTitle();
  data.opener = opener;
  saveVc(data);
  return data;
}

module.exports = { loadVc, saveVc, defaultVcTitle, addVcSession, getVcSession, updateVcSession, removeVcSession, setVcNickname, resetVcPeriod };
