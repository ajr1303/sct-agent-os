(function () {
  "use strict";
  var TAG = "[suburban-files]";
  function whenReady(cb, tries) {
    tries = tries || 0;
    var P = window.__HERMES_PLUGINS__, S = window.__HERMES_PLUGIN_SDK__;
    if (P && S && S.React) { cb(P, S); return; }
    if (tries > 200) { try { console.warn(TAG, "SDK not ready"); } catch (e) {} return; }
    setTimeout(function () { whenReady(cb, tries + 1); }, 50);
  }
  whenReady(function (PLUGINS, SDK) {
    var h = SDK.React.createElement, hooks = SDK.hooks || {}, useState = hooks.useState, useEffect = hooks.useEffect;
    function api(path, opts) {
      opts = opts || {}; opts.credentials = "same-origin";
      opts.headers = Object.assign({ "Content-Type": "application/json" }, opts.headers || {});
      return fetch("/api/connectors" + path, opts).then(function (r) {
        return r.text().then(function (txt) {
          var j = {}; try { j = txt ? JSON.parse(txt) : {}; } catch (e) {}
          if (!r.ok) throw new Error((j && (j.error || j.detail)) || "That didn't work. Please try again.");
          return j;
        });
      });
    }
    function when(iso) {
      try {
        var d = new Date(iso), mins = Math.round((Date.now() - d.getTime()) / 60000);
        if (mins < 1) return "just now";
        if (mins < 60) return mins + " min ago";
        if (mins < 1440) return Math.round(mins / 60) + " h ago";
        return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
      } catch (e) { return ""; }
    }
    function size(n) { n = Number(n) || 0; return n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : n >= 1024 ? Math.round(n / 1024) + " KB" : n + " bytes"; }
    function ext(name) { var i = String(name).lastIndexOf("."); return i > 0 ? String(name).slice(i + 1).toLowerCase() : ""; }
    function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;"); }
    var mdCache = {}, mdCount = 0;
    function md(src) {
      if (!src) return "";
      var k = String(src);
      if (Object.prototype.hasOwnProperty.call(mdCache, k)) return mdCache[k];
      if (mdCount > 300) { mdCache = {}; mdCount = 0; }
      mdCount++;
      return (mdCache[k] = mdRender(k));
    }
    function mdRender(src) {
      var text = String(src).replace(/\r\n?/g, "\n"), blocks = [];
      text = text.replace(/```[a-zA-Z0-9]*\n?([\s\S]*?)```/g, function (_, code) { blocks.push(code.replace(/\n$/, "")); return "\u0000C" + (blocks.length - 1) + "\u0000"; });
      text = esc(text);
      text = text.replace(/`([^`\n]+)`/g, function (_, c) { return "<code>" + c + "</code>"; });
      text = text.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
      text = text.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, "$1<em>$2</em>");
      text = text.replace(/\[([^\]]+)\]\(([^\s)]+)\)/g, function (_, label, raw) {
        var url = raw.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
        try {
          var u = new URL(url);
          if (u.protocol !== "http:" && u.protocol !== "https:") return label;
          return '<a href="' + esc(u.href) + '" target="_blank" rel="noopener noreferrer">' + label + "</a>";
        } catch (e) { return label; }     // board-relative links such as /SUB/agents/x: keep the name only
      });
      var tables = [];
      text = text.replace(/(^|\n)((?:[ \t]*\|[^\n]*\|[ \t]*(?:\n|$)){2,})/g, function (m, lead, block) {
        var lines = block.replace(/\n$/, "").split("\n");
        if (!/^[ \t]*\|[\s:|-]+\|[ \t]*$/.test(lines[1]) || lines[1].indexOf("-") < 0) return m;
        function cells(l) { return l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(function (c) { return c.trim(); }); }
        var head = cells(lines[0]), rows = lines.slice(2).map(cells);
        tables.push('<div class="st-md-tw"><table class="st-md-table"><thead><tr>' + head.map(function (c) { return "<th>" + c + "</th>"; }).join("") + "</tr></thead><tbody>"
          + rows.map(function (r) { return "<tr>" + r.map(function (c) { return "<td>" + c + "</td>"; }).join("") + "</tr>"; }).join("") + "</tbody></table></div>");
        return lead + "\u0000T" + (tables.length - 1) + "\u0000\n";
      });
      var lines = text.split("\n"), out = [], para = [], list = null, m;
      function flushPara() { if (para.length) { out.push("<p>" + para.join("<br>") + "</p>"); para = []; } }
      function flushList() { if (list) { out.push("<" + list.tag + ">" + list.items.map(function (i) { return "<li>" + i + "</li>"; }).join("") + "</" + list.tag + ">"); list = null; } }
      function flush() { flushPara(); flushList(); }
      function item(tag, body) { flushPara(); if (!list || list.tag !== tag) { flushList(); list = { tag: tag, items: [] }; } list.items.push(body); }
      for (var li = 0; li < lines.length; li++) {
        var line = lines[li], t = line.trim();
        if (!t) { flush(); continue; }
        if (/^\u0000[TC]\d+\u0000$/.test(t)) { flush(); out.push(t); continue; }
        if ((m = /^(#{1,6})\s+(.+)$/.exec(t))) { flush(); out.push('<div class="st-md-h st-md-h' + Math.min(m[1].length, 3) + '">' + m[2].replace(/\s*#+\s*$/, "") + "</div>"); continue; }
        if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) { flush(); out.push("<hr>"); continue; }
        if ((m = /^[-*•]\s+\[( |x|X)\]\s+(.+)$/.exec(t))) { item("ul", (m[1] === " " ? "☐ " : "☑ ") + m[2]); continue; }
        if ((m = /^[-*•]\s+(.+)$/.exec(t))) { item("ul", m[1]); continue; }
        if ((m = /^\d{1,3}[.)]\s+(.+)$/.exec(t))) { item("ol", m[1]); continue; }
        if ((m = /^&gt;\s?(.*)$/.exec(t))) { flush(); out.push("<blockquote>" + m[1] + "</blockquote>"); continue; }
        if (list && /^\s{2,}\S/.test(line)) { list.items[list.items.length - 1] += " " + t; continue; }
        flushList(); para.push(t);
      }
      flush();
      text = out.join("");
      text = text.replace(/\u0000T(\d+)\u0000/g, function (_, i) { return tables[+i]; });
      text = text.replace(/\u0000C(\d+)\u0000/g, function (_, i) { return "<pre>" + esc(blocks[+i]) + "</pre>"; });
      return text;
    }


    // A small CSV reader for the preview (quotes and commas inside quotes are handled).
    function csvRows(text, max) {
      var rows = [], row = [], cell = "", q = false, i = 0, c;
      for (; i < text.length && rows.length < max; i++) {
        c = text[i];
        if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
        else if (c === '"') q = true;
        else if (c === ",") { row.push(cell); cell = ""; }
        else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
        else if (c !== "\r") cell += c;
      }
      if ((cell || row.length) && rows.length < max) { row.push(cell); rows.push(row); }
      return rows;
    }

    function Files() {
      var a = useState(null), d = a[0], setD = a[1];
      var b = useState(null), sel = b[0], setSel = b[1];
      var c = useState(null), body = c[0], setBody = c[1];         // { id, text, cut } for the open file
      var e = useState(""), q = e[0], setQ = e[1];
      var f = useState(""), who = f[0], setWho = f[1];
      var g = useState(null), msg = g[0], setMsg = g[1];
      var k = useState(false), ask = k[0], setAsk = k[1];
      function load() { api("/files").then(setD).catch(function (er) { setMsg({ t: er.message, err: true }); }); }
      useEffect(function () { load(); var t = setInterval(load, 30000); return function () { clearInterval(t); }; }, []);
      function open(file) {
        setSel(file.id); setBody(null); setAsk(false); setMsg(null);
        if (file.readable) api("/files/" + file.id + "/text").then(function (v) { setBody(v); }).catch(function (er) { setMsg({ t: er.message, err: true }); });
      }
      function copy() {
        try { navigator.clipboard.writeText(body.text).then(function () { setMsg({ t: "Copied." }); }, function () { setMsg({ t: "Your browser blocked copying. Download the file instead.", err: true }); }); }
        catch (er) { setMsg({ t: "Your browser blocked copying. Download the file instead.", err: true }); }
      }
      function remove(file) {
        api("/files/" + file.id, { method: "DELETE" }).then(function (v) { setD(v); setSel(null); setBody(null); setAsk(false); setMsg({ t: "Deleted “" + file.name + "”." }); })
          .catch(function (er) { setMsg({ t: er.message, err: true }); });
      }
      if (!d) return h("div", { className: "sf-wrap" }, h("div", { className: "sf-empty" }, msg ? msg.t : "Loading…"));
      var all = d.files || [], needle = q.trim().toLowerCase();
      var list = all.filter(function (x) {
        if (who && x.agent !== who) return false;
        return !needle || (x.name + " " + x.summary + " " + x.task_title + " " + x.task + " " + x.agent).toLowerCase().indexOf(needle) >= 0;
      });
      var cur = all.filter(function (x) { return x.id === sel; })[0] || null;
      var head = h("div", { className: "sf-head" },
        h("div", null,
          h("div", { className: "sf-title" }, "Files"),
          h("div", { className: "sf-sub" }, "Everything your team has handed over, in one place: reports, drafts, lists and images. Each file shows the task it came from.")),
        all.length ? h("div", { className: "sf-count" }, d.count + (d.count === 1 ? " file" : " files") + " · " + size(d.bytes) + " of " + size(d.max_bytes)) : null);
      var note = msg ? h("div", { className: "sf-msg" + (msg.err ? " sf-err" : "") }, msg.t) : null;
      if (!all.length) return h("div", { className: "sf-wrap" }, head, note,
        h("div", { className: "sf-panel sf-none" },
          h("div", { className: "sf-none-t" }, "No files yet"),
          h("div", null, "When an agent's result is a document (a report, a draft post, a list of leads), it saves it here instead of pasting it into the task. "
            + "Agents on their own machines pick this up once their instructions are refreshed: Agents, choose the agent, “Add task tools to instructions”.")));
      var preview;
      if (!cur) preview = h("div", { className: "sf-empty" }, "Choose a file to read it.");
      else {
        var x = ext(cur.name), inner;
        if (cur.image) inner = h("img", { className: "sf-img", src: "/api/connectors/files/" + cur.id + "/image", alt: cur.name });
        else if (!cur.readable) inner = h("div", { className: "sf-empty" }, "This kind of file can't be shown here. Download it to open it.");
        else if (!body || body.id !== cur.id) inner = h("div", { className: "sf-empty" }, "Loading…");
        else if (x === "md") inner = h("div", { className: "st-md", dangerouslySetInnerHTML: { __html: md(body.text) } });
        else if (x === "csv") {
          var rows = csvRows(body.text, 201), more = rows.length > 200; rows = rows.slice(0, 200);
          inner = h("div", null, h("div", { className: "st-md-tw" }, h("table", { className: "st-md-table" },
            h("thead", null, h("tr", null, (rows[0] || []).map(function (v, i) { return h("th", { key: i }, v); }))),
            h("tbody", null, rows.slice(1).map(function (r, i) { return h("tr", { key: i }, r.map(function (v, j) { return h("td", { key: j }, v); })); })))),
            more ? h("div", { className: "sf-cut" }, "Showing the first 200 rows. Download the file for the rest.") : null);
        } else inner = h("pre", { className: "sf-pre" }, body.text);
        preview = h("div", null,
          h("div", { className: "sf-phead" },
            h("div", { className: "sf-pname" }, cur.name),
            cur.summary ? h("div", { className: "sf-psum" }, cur.summary) : null,
            h("div", { className: "sf-pmeta" }, (cur.agent || "An agent") + " · " + when(cur.at) + " · " + size(cur.size),
              cur.task ? h("span", null, " · from ", h("a", { className: "sf-link", href: "/tasks" + (location.search || "") }, cur.task), cur.task_title ? " " + cur.task_title : "") : null),
            h("div", { className: "sf-row" },
              cur.readable && body && body.id === cur.id ? h("button", { type: "button", className: "sf-btn", onClick: copy }, "Copy") : null,
              h("a", { className: "sf-btn" + (cur.readable ? " sf-quiet" : ""), href: "/api/connectors/files/" + cur.id }, "Download"),
              ask ? h("span", { className: "sf-row sf-row-in" }, h("span", { className: "sf-sure" }, "Delete for good?"),
                      h("button", { type: "button", className: "sf-btn sf-danger", onClick: function () { remove(cur); } }, "Delete"),
                      h("button", { type: "button", className: "sf-btn sf-quiet", onClick: function () { setAsk(false); } }, "Keep"))
                  : h("button", { type: "button", className: "sf-btn sf-quiet", onClick: function () { setAsk(true); } }, "Delete"))),
          h("div", { className: "sf-pbody" }, inner,
            body && body.id === cur.id && body.cut ? h("div", { className: "sf-cut" }, "This is the first part. Download the file for the rest.") : null));
      }
      return h("div", { className: "sf-wrap" }, head, note,
        h("div", { className: "sf-cols" },
          h("div", { className: "sf-panel sf-list" },
            h("div", { className: "sf-filter" },
              h("input", { className: "sf-in", value: q, placeholder: "Search files", onChange: function (ev) { setQ(ev.target.value); } }),
              (d.agents || []).length > 1 ? h("select", { className: "sf-in sf-sel", value: who, onChange: function (ev) { setWho(ev.target.value); } },
                h("option", { value: "" }, "Everyone"), d.agents.map(function (n) { return h("option", { key: n, value: n }, n); })) : null),
            list.length === 0 ? h("div", { className: "sf-empty" }, "Nothing matches.")
              : list.map(function (x) {
                  return h("button", { type: "button", key: x.id, className: "sf-item" + (x.id === sel ? " on" : ""), onClick: function () { open(x); } },
                    h("span", { className: "sf-ext" }, (ext(x.name) || "file").slice(0, 4)),
                    h("span", { className: "sf-it" },
                      h("span", { className: "sf-name" }, x.name),
                      h("span", { className: "sf-meta" }, (x.agent || "An agent") + " · " + when(x.at) + (x.task_title ? " · " + x.task_title : ""))));
                })),
          h("div", { className: "sf-panel sf-prev" }, preview)));
    }

    try { PLUGINS.register("suburban-files", Files); } catch (e) { try { console.error(TAG, e); } catch (e2) {} }
  });
})();
