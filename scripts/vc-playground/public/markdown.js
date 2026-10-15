// Pendekatan markdown Discord untuk pratinjau playground (BUKAN renderer resmi Discord): heading #/##/###, subteks -#,
// kutipan > dan >>>, daftar, blok kode, **tebal**, *miring*/_miring_, __garis bawah__, ~~coret~~, `kode`, <url>, URL polos,
// mention, dan escape dengan backslash. Sama-sama dimuat di browser (window.DiscordMarkdown) dan Node (untuk tes).
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.DiscordMarkdown = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  const esc = (text) => String(text).replace(/[&<>"']/g, (c) => ESCAPES[c]);

  const link = (url) => `<a class="md-link" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(url)}</a>`;

  // Satu lintasan kiri-ke-kanan untuk token yang harus menang atas format lain: escape, kode, <url>, mention, URL polos.
  const TOKEN = /\\([\\`*_~|>#[\]()<:-])|`([^`\n]+)`|<(https?:\/\/[^\s<>]+)>|<@&\d+>|<@!?\d+>|<#\d+>|(https?:\/\/[^\s<>]+)/g;

  function inline(raw) {
    const held = [];
    const hold = (html) => {
      held.push(html);
      return `${held.length - 1}`;
    };
    let s = String(raw).replace(TOKEN, (match, escaped, code, angleUrl, bareUrl) => {
      if (escaped !== undefined) return hold(esc(escaped));
      if (code !== undefined) return hold(`<code class="md-inline-code">${esc(code)}</code>`);
      if (angleUrl !== undefined) return hold(link(angleUrl));
      if (bareUrl !== undefined) return hold(link(bareUrl));
      if (match.startsWith("<@&")) return hold('<span class="md-mention">@peran</span>');
      if (match.startsWith("<#")) return hold('<span class="md-mention">#channel</span>');
      return hold('<span class="md-mention">@pengguna</span>');
    });
    s = esc(s);
    s = s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/__(.+?)__/g, "<u>$1</u>");
    s = s.replace(/~~(.+?)~~/g, "<s>$1</s>");
    s = s.replace(/\*(?!\s)([^*\n]+?)(?<!\s)\*/g, "<em>$1</em>");
    s = s.replace(/(^|[^\w])_(?!\s)([^_\n]+?)(?<!\s)_(?!\w)/g, "$1<em>$2</em>");
    return s.replace(/(\d+)/g, (_, i) => held[Number(i)]);
  }

  function blocks(lines) {
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];

      if (/^```/.test(line)) {
        const code = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++]);
        i++; // baris penutup (kalau tidak ada, sisa pesan dianggap kode - sama seperti Discord)
        out.push(`<pre class="md-code">${esc(code.join("\n"))}</pre>`);
        continue;
      }

      if (/^>>> ?/.test(line)) {
        const rest = [line.replace(/^>>> ?/, ""), ...lines.slice(i + 1)];
        out.push(`<blockquote class="md-quote">${blocks(rest)}</blockquote>`);
        break;
      }

      if (/^> |^>$/.test(line)) {
        const quoted = [];
        while (i < lines.length && /^> |^>$/.test(lines[i])) quoted.push(lines[i++].replace(/^> ?/, ""));
        out.push(`<blockquote class="md-quote">${blocks(quoted)}</blockquote>`);
        continue;
      }

      const heading = /^(#{1,3}) (.+)$/.exec(line);
      if (heading) {
        out.push(`<h${heading[1].length} class="md-h md-h${heading[1].length}">${inline(heading[2])}</h${heading[1].length}>`);
        i++;
        continue;
      }

      const subtext = /^-# (.+)$/.exec(line);
      if (subtext) {
        out.push(`<div class="md-subtext">${inline(subtext[1])}</div>`);
        i++;
        continue;
      }

      if (/^\s*[-*] \S/.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*[-*] \S/.test(lines[i])) items.push(`<li>${inline(lines[i++].replace(/^\s*[-*] /, ""))}</li>`);
        out.push(`<ul class="md-list">${items.join("")}</ul>`);
        continue;
      }

      if (/^\d+\. \S/.test(line)) {
        const start = Number(/^(\d+)\./.exec(line)[1]);
        const items = [];
        while (i < lines.length && /^\d+\. \S/.test(lines[i])) items.push(`<li>${inline(lines[i++].replace(/^\d+\. /, ""))}</li>`);
        out.push(`<ol class="md-list" start="${start}">${items.join("")}</ol>`);
        continue;
      }

      out.push(line.trim() === "" ? '<div class="md-gap"></div>' : `<div class="md-line">${inline(line)}</div>`);
      i++;
    }
    return out.join("");
  }

  function render(text) {
    return blocks(String(text ?? "").split("\n"));
  }

  return { render, inline, esc };
});
