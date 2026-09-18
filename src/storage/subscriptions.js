const path = require("path");
const { CACHE_DIR } = require("../config");
const { createJsonStore } = require("./jsonStore");

// Fitur: SIAPA AJA (bukan cuma owner) bisa "cok ingetin <nama>" buat di-tag
// pribadi tiap kali member itu mulai live - beda dari member prioritas yang
// hardcoded/custom-by-owner, ini per-user dan bisa buat member manapun.
// Disimpen keyword -> daftar user ID yang subscribe.
const SUBSCRIPTIONS_FILE = path.join(CACHE_DIR, "subscriptions.json");
const store = createJsonStore(SUBSCRIPTIONS_FILE, {}, { errorLabel: "daftar subscription" });

function loadSubscriptions() {
  return store.load();
}

function saveSubscriptions(map) {
  store.save(map);
}

function addSubscription(rawKeyword, userId) {
  const keyword = (rawKeyword || "").trim().toLowerCase();
  if (!keyword) return { ok: false, reason: "empty" };
  if (keyword.length < 3) return { ok: false, reason: "too_short" };

  const subs = loadSubscriptions();
  const list = subs[keyword] || [];
  if (list.includes(userId)) return { ok: false, reason: "already" };

  list.push(userId);
  subs[keyword] = list;
  saveSubscriptions(subs);
  return { ok: true };
}

function removeSubscription(rawKeyword, userId) {
  const keyword = (rawKeyword || "").trim().toLowerCase();
  const subs = loadSubscriptions();
  const list = subs[keyword] || [];
  const filtered = list.filter((id) => id !== userId);
  if (filtered.length === list.length) return { ok: false, reason: "not_found" };

  if (filtered.length === 0) delete subs[keyword];
  else subs[keyword] = filtered;
  saveSubscriptions(subs);
  return { ok: true };
}

module.exports = { loadSubscriptions, saveSubscriptions, addSubscription, removeSubscription };
