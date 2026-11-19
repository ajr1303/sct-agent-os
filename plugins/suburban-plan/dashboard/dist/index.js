(function () {
  "use strict";
  var TAG = "[suburban-plan]";
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
        return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + ", " + d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
      } catch (e) { return ""; }
    }
    // Markdown to safe HTML: everything is escaped first, then a small set of tags is added back.
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

    var STARTER = "## What we do\n\n\n## Who we serve\n\n\n## Goals for this quarter\n- \n\n## How the team helps\n\n\n## What to avoid\n";

    function Plan() {
      var a = useState(null), d = a[0], setD = a[1];
      var b = useState(null), msg = b[0], setMsg = b[1];
      var c = useState(false), busy = c[0], setBusy = c[1];
      var e = useState(null), draft = e[0], setDraft = e[1];          // text being edited, or null
      var f = useState(""), ask = f[0], setAsk = f[1];
      var g = useState(null), old = g[0], setOld = g[1];              // an older version being looked at
      function load() { api("/plan").then(setD).catch(function () {}); }
      useEffect(function () { load(); var t = setInterval(load, 15000); return function () { clearInterval(t); }; }, []);
      function run(p, okMsg) {
        setBusy(true); setMsg(null);
        return p.then(function (v) { setBusy(false); if (v && v.versions) setD(v); setMsg({ t: (v && v.message) || okMsg }); return v; })
          .catch(function (er) { setBusy(false); setMsg({ t: er.message, err: true }); });
      }
      function save() { run(api("/plan", { method: "PUT", body: JSON.stringify({ body: draft }) }), "Saved. Your team works from this version now.").then(function (v) { if (v) setDraft(null); }); }
      function askLead() { run(api("/plan/ask", { method: "POST", body: JSON.stringify({ request: ask }) }), "").then(function (v) { if (v) setAsk(""); }); }
      function open(v) { setMsg(null); api("/plan/versions/" + v.id).then(setOld).catch(function (er) { setMsg({ t: er.message, err: true }); }); }
      function restore() { run(api("/plan/restore/" + old.id, { method: "POST" }), "That version is the current plan again.").then(function (v) { if (v) setOld(null); }); }
      if (!d) return h("div", { className: "sp-wrap" }, h("div", { className: "sp-empty" }, "Loading…"));
      var cur = d.current, pend = d.pending, limit = d.limit || 12000;
      var head = h("div", { className: "sp-head" },
        h("div", null,
          h("div", { className: "sp-title" }, "Business plan"),
          h("div", { className: "sp-sub" }, "The one page your team works from: what you do, who you serve, this quarter's goals and what to avoid. "
            + "Your lead agent keeps it up to date, and every version is saved.")));
      var note = msg ? h("div", { className: "sp-msg" + (msg.err ? " sp-err" : "") }, msg.t) : null;
      var working = pend ? h("div", { className: "sp-pend" }, h("i", { className: "sp-spin" }),
        h("span", null, "Your lead agent is working on the plan", pend.request ? ": “" + pend.request + "”" : "", ". This usually takes a few minutes.")) : null;

      if (!cur && draft == null) {
        return h("div", { className: "sp-wrap" }, head, note,
          h("div", { className: "sp-panel sp-first" },
            h("div", { className: "sp-first-t" }, "You don't have a plan yet"),
            h("div", { className: "sp-first-s" }, "Your lead agent can write a first version from your business profile and what the team has been doing. "
              + "Where it doesn't know something, it leaves a question for you. You can change anything afterwards."),
            working || h("div", null,
              h("textarea", { className: "sp-in sp-in-sm", value: ask, maxLength: 1500, placeholder: "Anything it should know first (optional). For example: we want three new clients this quarter.",
                onChange: function (ev) { setAsk(ev.target.value); } }),
              h("div", { className: "sp-row" },
                h("button", { type: "button", className: "sp-btn", disabled: busy, onClick: askLead }, busy ? "Asking…" : "Have my lead agent write it"),
                h("button", { type: "button", className: "sp-btn sp-quiet", disabled: busy, onClick: function () { setDraft(STARTER); } }, "Write it myself")))));
      }

      var main;
      if (draft != null) {
        var over = draft.length > limit;
        main = h("div", { className: "sp-panel" },
          h("div", { className: "sp-panel-h" }, h("span", null, cur ? "Editing the plan" : "Writing the plan"),
            h("span", { className: "sp-panel-r" + (over ? " sp-over" : "") }, draft.length.toLocaleString() + " of " + limit.toLocaleString() + " characters")),
          h("div", { className: "sp-pad" },
            h("textarea", { className: "sp-in sp-in-lg", value: draft, onChange: function (ev) { setDraft(ev.target.value); } }),
            h("div", { className: "sp-hint" }, "Headings start with ##, list items with a dash."),
            h("div", { className: "sp-row" },
              h("button", { type: "button", className: "sp-btn", disabled: busy || over || draft.trim().length < 20, onClick: save }, busy ? "Saving…" : "Save"),
              h("button", { type: "button", className: "sp-btn sp-quiet", disabled: busy, onClick: function () { setDraft(null); } }, "Cancel"))));
      } else if (old) {
        main = h("div", { className: "sp-panel" },
          h("div", { className: "sp-old" },
            h("span", null, "You are looking at an older version, from " + when(old.at) + (old.author ? " (" + old.author + ")" : "") + "."),
            h("span", { className: "sp-row sp-row-tight" },
              h("button", { type: "button", className: "sp-btn", disabled: busy, onClick: restore }, "Bring this version back"),
              h("button", { type: "button", className: "sp-btn sp-quiet", onClick: function () { setOld(null); } }, "Back to current"))),
          h("div", { className: "sp-pad st-md", dangerouslySetInnerHTML: { __html: md(old.body) } }));
      } else {
        main = h("div", { className: "sp-panel" },
          h("div", { className: "sp-panel-h" },
            h("span", null, "Current plan"),
            h("span", { className: "sp-panel-r" }, "Changed " + when(cur.at) + (cur.author ? " by " + cur.author : "") + (cur.note ? ": " + cur.note : "")),
            h("button", { type: "button", className: "sp-link", onClick: function () { setMsg(null); setDraft(cur.body); } }, "Edit")),
          h("div", { className: "sp-pad st-md", dangerouslySetInnerHTML: { __html: md(cur.body) } }));
      }
      var askBox = cur && draft == null && !old ? h("div", { className: "sp-panel sp-ask" },
        working || h("div", { className: "sp-askrow" },
          h("input", { className: "sp-in", value: ask, maxLength: 1500, placeholder: "Ask your lead agent to change the plan. For example: add a goal to sign five new clients.",
            onChange: function (ev) { setAsk(ev.target.value); },
            onKeyDown: function (ev) { if (ev.key === "Enter" && ask.trim().length >= 5 && !busy) askLead(); } }),
          h("button", { type: "button", className: "sp-btn", disabled: busy || ask.trim().length < 5, onClick: askLead }, busy ? "Asking…" : "Ask"))) : null;
      var vs = d.versions || [];
      var side = h("div", { className: "sp-panel" },
        h("div", { className: "sp-panel-h" }, h("span", null, "Versions"), h("span", { className: "sp-panel-r" }, vs.length ? String(vs.length) : "")),
        vs.length <= 1 ? h("div", { className: "sp-empty" }, "Each change is saved here, so you can always look back or undo one.")
          : h("div", null, vs.map(function (v, i) {
              var on = old ? old.id === v.id : i === 0;
              return h("button", { type: "button", key: v.id, className: "sp-ver" + (on ? " on" : ""),
                onClick: function () { if (i === 0) setOld(null); else open(v); } },
                h("span", { className: "sp-ver-t" }, (i === 0 ? "Current · " : "") + when(v.at) + (v.author ? " · " + v.author : "")),
                h("span", { className: "sp-ver-n" }, v.note || "Changed"));
            })));
      return h("div", { className: "sp-wrap" }, head, note,
        h("div", { className: "sp-cols" },
          h("div", { className: "sp-main" }, askBox, main),
          h("div", { className: "sp-side" }, side)));
    }

    try { PLUGINS.register("suburban-plan", Plan); } catch (e) { try { console.error(TAG, e); } catch (e2) {} }
  });
})();
