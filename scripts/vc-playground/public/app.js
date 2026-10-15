// UI playground "input vc": menggambar percakapan ala Discord dari state yang dikirim server, dan meneruskan klik tombol /
// pilihan dropdown / isian form ke server (yang menjalankan kode bot asli). Tidak ada logika bot di sini.
(function () {
  "use strict";

  const MD = window.DiscordMarkdown;
  const ui = { channel: "dm-owner", actor: "owner", raw: false, side: "log", openSelect: null, onlyIssues: false, counts: {} };
  let state = null;
  let noticeTimer = null;

  const $ = (id) => document.getElementById(id);

  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value === undefined || value === null || value === false) continue;
      if (key === "class") el.className = value;
      else if (key === "text") el.textContent = value;
      else if (key === "html") el.innerHTML = value;
      else if (key === "value") el.value = value;
      else if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
      else el.setAttribute(key, value === true ? "" : value);
    }
    for (const kid of kids.flat()) {
      if (kid === null || kid === undefined || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }

  const clock = (ts) => new Date(ts).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "Asia/Jakarta" });
  const clockShort = (ts) => new Date(ts).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Jakarta" });
  const actorName = (key) => (state.actors[key] ? state.actors[key].name : key);
  const currentChannel = () => state.channels.find((c) => c.id === ui.channel);

  // ----------------------------------- jaringan -----------------------------------

  async function api(path, body) {
    const options = body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
    const response = await fetch(path, options);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    if (data.state) state = data.state;
    return data;
  }

  async function run(task) {
    document.body.classList.add("busy");
    try {
      await task();
    } catch (error) {
      showNotice([error.message], "bad");
    } finally {
      document.body.classList.remove("busy");
      render();
    }
  }

  function showNotice(lines, kind) {
    const box = $("notice");
    clearTimeout(noticeTimer);
    box.className = kind === "ok" ? "notice ok" : "notice";
    box.replaceChildren(
      lines.length === 1
        ? document.createTextNode(lines[0])
        : h(
            "div",
            {},
            kind === "ok" ? "" : "Ada masalah:",
            h(
              "ul",
              {},
              lines.map((l) => h("li", { text: l })),
            ),
          ),
    );
    box.hidden = false;
    if (kind === "ok") noticeTimer = setTimeout(() => (box.hidden = true), 4000);
  }
  const clearNotice = () => {
    $("notice").hidden = true;
  };

  function handleResult(result, sourceMessageId) {
    const { entry, modal } = result.result;
    if (entry.issues.length > 0) showNotice(entry.issues, "bad");
    else clearNotice();
    if (modal) openModal(modal, sourceMessageId);
  }

  // ------------------------------------ aksi ------------------------------------

  const press = (message, component) =>
    run(async () => {
      clearNotice();
      handleResult(
        await api("/api/interact", { channel: ui.channel, actor: ui.actor, kind: "button", customId: component.custom_id, messageId: message.id }),
        message.id,
      );
    });

  const choose = (message, component, value) =>
    run(async () => {
      ui.openSelect = null;
      clearNotice();
      handleResult(
        await api("/api/interact", {
          channel: ui.channel,
          actor: ui.actor,
          kind: "select",
          customId: component.custom_id,
          values: [value],
          messageId: message.id,
        }),
        message.id,
      );
    });

  const sendText = (text) =>
    run(async () => {
      clearNotice();
      const data = await api("/api/send", { channel: ui.channel, actor: ui.actor, text });
      if (data.result.issues.length > 0) showNotice(data.result.issues, "bad");
    });

  const removeMessage = (id, label) =>
    run(async () => {
      await api("/api/delete-message", { channel: ui.channel, id });
      showNotice([label], "ok");
    });

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const area = h("textarea", { value: text });
      document.body.append(area);
      area.select();
      document.execCommand("copy");
      area.remove();
    }
    showNotice(["Teks disalin."], "ok");
  }

  // ----------------------------------- gambar -----------------------------------

  function renderTabs() {
    $("chan-tabs").replaceChildren(
      ...state.channels.map((channel) =>
        h("button", {
          type: "button",
          role: "tab",
          "aria-selected": String(channel.id === ui.channel),
          text: `${channel.label}${channel.messages.length ? ` (${channel.messages.length})` : ""}`,
          onclick: () => {
            ui.channel = channel.id;
            ui.openSelect = null;
            render();
          },
        }),
      ),
    );
  }

  function renderButton(message, c) {
    if (c.style === 5)
      return h("a", { class: "dbtn s5", href: c.url || "#", target: "_blank", rel: "noopener noreferrer", text: c.label || "Tautan" });
    return h("button", {
      type: "button",
      class: `dbtn s${c.style}`,
      title: c.custom_id,
      disabled: c.disabled,
      text: c.label || "",
      onclick: () => press(message, c),
    });
  }

  function renderSelect(message, c) {
    const key = `${message.id}:${c.custom_id}`;
    const open = ui.openSelect === key;
    return h(
      "div",
      { class: "dselect" },
      h(
        "button",
        {
          type: "button",
          "aria-haspopup": "listbox",
          "aria-expanded": String(open),
          title: c.custom_id,
          disabled: c.disabled,
          onclick: (event) => {
            event.stopPropagation();
            ui.openSelect = open ? null : key;
            renderMessages();
          },
        },
        h("span", { text: c.placeholder || "Pilih…" }),
        h("span", { text: "▾", "aria-hidden": "true" }),
      ),
      open &&
        h(
          "ul",
          { role: "listbox" },
          c.options.map((option) =>
            h(
              "li",
              {},
              h(
                "button",
                { type: "button", role: "option", onclick: () => choose(message, c, option.value) },
                option.label,
                option.description && h("small", { text: option.description }),
              ),
            ),
          ),
        ),
    );
  }

  function renderEmbed(embed) {
    const el = h("div", { class: "embed" });
    if (typeof embed.color === "number") el.style.borderLeftColor = `#${embed.color.toString(16).padStart(6, "0")}`;
    if (embed.title) el.append(h("div", { class: "e-title", text: embed.title }));
    if (embed.description) el.append(ui.raw ? h("pre", { class: "raw", text: embed.description }) : h("div", { html: MD.render(embed.description) }));
    for (const field of embed.fields || [])
      el.append(h("div", { class: "e-field" }, h("b", { text: field.name }), h("div", { html: MD.render(field.value) })));
    return el;
  }

  function renderMessage(message, previous) {
    const isBot = message.author === "bot";
    const grouped =
      previous &&
      previous.author === message.author &&
      previous.authorId === message.authorId &&
      previous.ephemeral === message.ephemeral &&
      message.at - previous.at < 5 * 60_000;
    const name = isBot ? "JKT48 Notifier" : message.authorId === state.actors.owner.id ? actorName("owner") : actorName("other");
    const avatarClass = isBot ? "avatar" : message.authorId === state.actors.owner.id ? "avatar user" : "avatar other";
    const length = (message.content || "").length;

    const body = h("div", { class: "body" });
    if (message.content) {
      body.append(ui.raw ? h("pre", { class: "raw", text: message.content }) : h("div", { html: MD.render(message.content) }));
    }
    for (const embed of message.embeds) body.append(renderEmbed(embed));
    for (const file of message.files) body.append(h("span", { class: "chip", text: `📎 ${file.name}` }));
    for (const row of message.components) {
      body.append(
        h(
          "div",
          { class: "row" },
          row.components.map((c) => (c.type === 3 ? renderSelect(message, c) : renderButton(message, c))),
        ),
      );
    }
    if (message.ephemeral) body.append(h("div", { class: "eph-note", text: "Hanya kamu yang bisa melihat ini (pesan sementara)" }));

    const head = grouped
      ? null
      : h(
          "div",
          { class: "msg-head" },
          h("span", { class: "name", text: name }),
          isBot && h("span", { class: "tag", text: "BOT" }),
          h("span", { class: "time", text: clockShort(message.at) }),
          message.edited && h("span", { class: "edited", text: "(diedit)" }),
        );

    const counterClass = length > 2000 ? "counter bad" : length > 1800 ? "counter warn" : "counter";
    const actions = h(
      "div",
      { class: "actions" },
      message.content && h("button", { type: "button", text: "📋 Salin teks", onclick: () => copyText(message.content) }),
      message.ephemeral
        ? h("button", { type: "button", text: "✕ Tutup", onclick: () => removeMessage(message.id, "Pesan sementara ditutup.") })
        : h("button", {
            type: "button",
            text: "🗑 Hapus (simulasi)",
            title: "Meniru kamu menghapus pesan ini manual di Discord",
            onclick: () => removeMessage(message.id, "Pesan dihapus (simulasi hapus manual di Discord)."),
          }),
    );

    return h(
      "div",
      { class: `msg${grouped ? "" : " first"}${message.ephemeral ? " ephemeral" : ""}`, "data-id": message.id },
      grouped
        ? h("div", { class: "gutter", text: clockShort(message.at) })
        : h("div", { class: avatarClass, "aria-hidden": "true", text: isBot ? "JK" : name[0] }),
      h("div", {}, head, body, isBot && length >= 1500 && h("span", { class: counterClass, text: `${length}/2000 karakter` })),
      actions,
    );
  }

  function renderMessages() {
    const box = $("messages");
    const channel = currentChannel();
    const visible = channel.messages.filter((m) => !m.ephemeral || m.visibleTo === state.actors[ui.actor].id);
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 90;
    const previousTop = box.scrollTop;
    const grew = visible.length > (ui.counts[channel.id] ?? 0);
    ui.counts[channel.id] = visible.length;

    if (visible.length === 0) {
      box.replaceChildren(
        h(
          "div",
          { class: "empty" },
          "Belum ada pesan. Coba ketik ",
          h("code", { text: "input vc" }),
          " di bawah, atau isi data contoh dari tab “Alat uji”.",
        ),
      );
    } else {
      box.replaceChildren(...visible.map((m, i) => renderMessage(m, visible[i - 1])));
    }
    box.scrollTop = nearBottom || grew ? box.scrollHeight : previousTop;
  }

  const QUICK = ["input vc", "julukan vc lily = Cece Adik Aing Tersayang", "hapus julukan vc lily", "cok daftar prioritas", "cok bantuan"];
  function renderQuick() {
    $("quick").replaceChildren(...QUICK.map((text) => h("button", { type: "button", text, onclick: () => sendText(text) })));
  }

  // ------------------------------- panel samping -------------------------------

  function issueCount() {
    return state.log.filter((e) => e.issues.length > 0).length;
  }

  function renderSideTabs() {
    const labels = { log: "Log", data: "Data VC", tools: "Alat uji" };
    for (const button of $("side-tabs").children) {
      const tab = button.dataset.tab;
      button.setAttribute("aria-selected", String(tab === ui.side));
      button.replaceChildren(
        document.createTextNode(labels[tab]),
        ...(tab === "log" && issueCount() > 0 ? [h("span", { class: "badge", text: String(issueCount()) })] : []),
      );
    }
  }

  function renderLog() {
    const entries = state.log
      .filter((e) => !ui.onlyIssues || e.issues.length > 0)
      .slice()
      .reverse();
    return h(
      "div",
      {},
      h(
        "label",
        { class: "toggle" },
        h("input", {
          type: "checkbox",
          id: "only-issues",
          ...(ui.onlyIssues ? { checked: "" } : {}),
          onchange: (e) => ((ui.onlyIssues = e.target.checked), renderSide()),
        }),
        h("span", {}, "Hanya yang bermasalah", h("small", { text: "Pelanggaran aturan Discord, error, atau interaksi tanpa respons" })),
      ),
      entries.length === 0 && h("p", { class: "muted", text: "Belum ada aktivitas." }),
      entries.map((e) =>
        h(
          "div",
          { class: `log-item${e.issues.length ? " bad" : ""}` },
          h(
            "div",
            { class: "meta" },
            h("span", { text: `#${e.n} ${clock(e.at)}` }),
            h("span", { class: "kind", text: e.kind }),
            h("span", { text: actorName(e.actor) }),
            e.ack && h("span", { text: `respons: ${e.ack}${e.ackMs !== null ? ` (${e.ackMs} ms)` : ""}` }),
            e.ms !== null && h("span", { text: `total ${e.ms} ms` }),
          ),
          h("code", { text: e.summary }),
          e.issues.map((issue) => h("div", { class: "issue", text: issue })),
        ),
      ),
    );
  }

  function renderData() {
    const vc = state.vc;
    const dm = state.channels.find((c) => c.id === "dm-owner");
    const summaryMessages = ((vc.message && vc.message.ids) || []).map((id) => dm.messages.find((m) => m.id === id)).filter(Boolean);
    const stat = (label, value) => h("div", { class: "stat" }, h("span", { class: "muted", text: label }), h("span", { text: value }));
    return h(
      "div",
      {},
      h("h3", { text: "Periode" }),
      stat("Judul", vc.title || "(belum dibuat)"),
      stat("Jumlah sesi", String(vc.sessions.length)),
      stat(
        "Pesan rangkuman",
        summaryMessages.length
          ? `${summaryMessages.length} pesan · ${summaryMessages.map((m) => m.content.length).join(" + ")} karakter`
          : "belum ada",
      ),
      vc.opener && h("p", { html: MD.render(vc.opener) }),
      h("h3", { text: "Julukan" }),
      Object.keys(vc.nicknames).length === 0
        ? h("p", { class: "muted", text: "Belum ada. Coba: julukan vc lily = Cece" })
        : Object.entries(vc.nicknames).map(([key, nick]) => stat(key, nick)),
      h("h3", { text: "Sesi" }),
      vc.sessions.length === 0
        ? h("p", { class: "muted", text: "Belum ada sesi." })
        : h(
            "div",
            { class: "table-wrap" },
            h(
              "table",
              { class: "data" },
              h(
                "thead",
                {},
                h(
                  "tr",
                  {},
                  ["id", "Member", "Sesi", "Tanggal", "Buka", "Mulai", "Tiket"].map((t) => h("th", { text: t })),
                ),
              ),
              h(
                "tbody",
                {},
                vc.sessions.map((s) =>
                  h(
                    "tr",
                    {},
                    [s.id, s.name, s.session, s.date, s.open, s.start, s.tickets ?? "-"].map((cell) => h("td", { text: String(cell) })),
                  ),
                ),
              ),
            ),
          ),
      h("details", {}, h("summary", { text: "Data mentah (vc-schedule.json)" }), h("pre", { text: JSON.stringify(vc, null, 2) })),
    );
  }

  const SCENARIOS = [
    "Ketik “input vc”: muncul pesan rangkuman + panel tombol.",
    "➕ Tambah sesi → cari “lily” → pilih tanggal → isi form: rangkuman ter-update di pesan yang sama (muncul tanda “diedit”).",
    "Isi form dengan jam salah (mis. 25.00) dan sesi kosong: semua kesalahan tampil sekaligus, “Perbaiki” membuka form dengan isian terakhir.",
    "Tambah lagi member + tanggal + sesi yang sama: ditolak sebagai duplikat.",
    "Ganti “Bertindak sebagai” ke Orang lain lalu klik tombol di panel: ditolak (pesan sementara).",
    "Di tab “# channel bot (server)”, ketik “input vc” sebagai Owner: hanya disuruh pakai DM. Sebagai Orang lain: balasannya sama seperti sebelum fitur ada (menu umum), tanpa menyebut VC.",
    "Hapus pesan rangkuman (🗑) lalu ubah sesuatu: rangkuman dikirim ulang otomatis.",
    "“Isi banyak data” untuk melihat rangkuman terpecah >1 pesan (batas 2000 karakter).",
    "Nyalakan “Discord menolak DM” lalu tambah sesi: data tersimpan + peringatan di layar.",
    "Mulai tambah sesi, majukan jam bot +31 menit, lanjutkan: muncul “kelamaan/ke-reset”.",
  ];

  function renderTools() {
    const toggle = (key, title, hint) =>
      h(
        "label",
        { class: "toggle" },
        h("input", {
          type: "checkbox",
          ...(state.config[key] ? { checked: "" } : {}),
          onchange: (e) => run(() => api("/api/config", { [key]: e.target.checked })),
        }),
        h("span", {}, title, h("small", { text: hint })),
      );
    const tool = (title, hint, action) =>
      h("button", { type: "button", class: "tool-btn", onclick: () => run(action) }, title, h("small", { text: hint }));
    return h(
      "div",
      {},
      h("h3", { text: "Data" }),
      tool("Isi data contoh", "6 sesi dari 5 member (Lily/Levi sebagai prioritas)", async () => {
        const data = await api("/api/seed", { many: false });
        showNotice([`${data.result.added} sesi ditambahkan.`], "ok");
      }),
      tool("Isi banyak data (uji batas 2000 karakter)", "36 sesi: rangkuman harus terpecah jadi beberapa pesan", async () => {
        const data = await api("/api/seed", { many: true });
        showNotice([`${data.result.added} sesi ditambahkan.`], "ok");
      }),
      tool("Kosongkan semuanya", "Hapus data VC, semua pesan simulasi, dan log", async () => {
        await api("/api/reset", {});
        ui.counts = {};
      }),
      h("h3", { text: "Simulasi gangguan" }),
      toggle("failDm", "Discord menolak DM", "Bot gagal membuka DM ke owner (mis. DM ditutup)"),
      toggle("clientOff", "Bot belum login", "getDiscordClient() mengembalikan null"),
      toggle("idnDown", "IDN tidak bisa dihubungi", "Pencarian member yang tidak dikenal bot gagal"),
      toggle("slow", "Discord lambat", "+1,5 dtk di tiap panggilan kirim/edit/hapus pesan; tombol harus tetap di-ack <3 dtk"),
      h("h3", { text: "Waktu" }),
      tool(
        "Majukan jam bot +31 menit",
        `Menguji draft kedaluwarsa (30 menit). Sekarang: ${state.config.clockOffsetMin >= 0 ? "+" : ""}${state.config.clockOffsetMin} menit`,
        () => api("/api/clock", { minutes: 31 }),
      ),
      tool("Kembalikan jam bot", "Hapus pergeseran waktu", () => api("/api/clock", { minutes: 0 })),
      h("h3", { text: "Keamanan" }),
      h(
        "div",
        { class: "stat" },
        h("span", { class: "muted", text: "Panggilan jaringan yang diblokir" }),
        h("span", { text: String(state.config.blockedFetch) }),
      ),
      h("p", { class: "muted", text: "Tidak ada token/webhook asli, tidak ada koneksi ke Discord, data di folder sementara." }),
      h("h3", { text: "Skenario uji yang disarankan" }),
      h(
        "ol",
        { class: "scenarios" },
        SCENARIOS.map((text) => h("li", { text })),
      ),
    );
  }

  function renderSide() {
    renderSideTabs();
    const view = { log: renderLog, data: renderData, tools: renderTools }[ui.side]();
    $("side-body").replaceChildren(view);
  }

  // --------------------------------- form (modal) ---------------------------------

  let modalContext = null;

  function openModal(modal, messageId) {
    modalContext = { modal, messageId, channel: ui.channel, actor: ui.actor };
    $("modal-title").textContent = modal.title;
    const fields = $("modal-fields");
    fields.replaceChildren();
    for (const row of modal.components) {
      const input = row.components[0];
      const id = `f-${input.custom_id}`;
      const control =
        input.style === 2
          ? h("textarea", { id, name: input.custom_id, placeholder: input.placeholder || "", maxlength: input.max_length, value: input.value || "" })
          : h("input", {
              id,
              name: input.custom_id,
              type: "text",
              placeholder: input.placeholder || "",
              maxlength: input.max_length,
              value: input.value || "",
            });
      const count = h("div", { class: "count" });
      const refresh = () => {
        count.textContent = input.max_length ? `${control.value.length}/${input.max_length}` : "";
        validateModal();
      };
      control.addEventListener("input", refresh);
      fields.append(
        h(
          "div",
          { class: "field" },
          h("label", { for: id }, input.label, input.required !== false && h("span", { class: "req", text: " *" })),
          control,
          count,
        ),
      );
      count.textContent = input.max_length ? `${control.value.length}/${input.max_length}` : "";
    }
    validateModal();
    $("modal").showModal();
    const first = fields.querySelector("input, textarea");
    if (first) first.focus();
  }

  // Seperti klien Discord: tombol kirim mati selama isian wajib masih kosong.
  function validateModal() {
    if (!modalContext) return;
    const ok = modalContext.modal.components.every((row) => {
      const input = row.components[0];
      return input.required === false || $("f-" + input.custom_id).value.trim() !== "";
    });
    $("modal-submit").disabled = !ok;
  }

  function closeModal() {
    modalContext = null;
    if ($("modal").open) $("modal").close();
  }

  function submitModal(event) {
    event.preventDefault();
    if (!modalContext || $("modal-submit").disabled) return;
    const { modal, messageId, channel, actor } = modalContext;
    const fields = {};
    for (const row of modal.components) {
      const input = row.components[0];
      fields[input.custom_id] = $("f-" + input.custom_id).value;
    }
    closeModal();
    run(async () => {
      clearNotice();
      handleResult(await api("/api/interact", { channel, actor, kind: "modal", customId: modal.custom_id, fields, messageId }), messageId);
    });
  }

  // ----------------------------------- render -----------------------------------

  function render() {
    renderTabs();
    renderMessages();
    renderSide();
    $("safe-text").textContent = `Mode aman · tanpa Discord · jaringan diblokir (${state.config.blockedFetch} panggilan)`;
  }

  function setTheme(theme) {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("vc-playground-theme", theme);
    } catch {
      // penyimpanan browser tidak tersedia: tema hanya berlaku untuk sesi ini.
    }
  }

  function init() {
    let saved = null;
    try {
      saved = localStorage.getItem("vc-playground-theme");
    } catch {
      saved = null;
    }
    if (saved === "light" || saved === "dark") setTheme(saved);

    $("theme-btn").addEventListener("click", () => setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark"));
    for (const radio of document.querySelectorAll('input[name="actor"]')) {
      radio.addEventListener("change", (e) => {
        ui.actor = e.target.value;
        render();
      });
    }
    for (const radio of document.querySelectorAll('input[name="view"]')) {
      radio.addEventListener("change", (e) => {
        ui.raw = e.target.value === "raw";
        render();
      });
    }
    for (const tab of $("side-tabs").children) {
      tab.addEventListener("click", () => {
        ui.side = tab.dataset.tab;
        renderSide();
      });
    }
    $("composer").addEventListener("submit", (event) => {
      event.preventDefault();
      const input = $("composer-input");
      const text = input.value.trim();
      if (!text) return;
      input.value = "";
      sendText(text);
    });
    $("modal-form").addEventListener("submit", submitModal);
    $("modal-close").addEventListener("click", closeModal);
    $("modal-cancel").addEventListener("click", closeModal);
    $("modal").addEventListener("close", () => (modalContext = null));
    document.addEventListener("click", (event) => {
      if (ui.openSelect && !event.target.closest(".dselect")) {
        ui.openSelect = null;
        renderMessages();
      }
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && ui.openSelect) {
        ui.openSelect = null;
        renderMessages();
      }
    });
    renderQuick();

    api("/api/state")
      .then(render)
      .catch((error) => {
        document.body.prepend(h("div", { class: "notice", text: `Tidak bisa terhubung ke server playground: ${error.message}` }));
      });
  }

  init();
})();
