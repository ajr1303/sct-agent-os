(function () {
  "use strict";
  var TAG = "[suburban-tasks]";

  function whenReady(cb, tries) {
    tries = tries || 0;
    var P = window.__HERMES_PLUGINS__, S = window.__HERMES_PLUGIN_SDK__;
    if (P && S && S.React) { cb(P, S); return; }
    if (tries > 200) { try { console.warn(TAG, "SDK not ready"); } catch (e) {} return; }
    setTimeout(function () { whenReady(cb, tries + 1); }, 50);
  }

  whenReady(function (PLUGINS, SDK) {
    var h = SDK.React.createElement;
    var hooks = SDK.hooks || {};
    var useState = hooks.useState, useEffect = hooks.useEffect;

    function api(path, opts) {
      opts = opts || {};
      opts.credentials = "same-origin";
      opts.headers = Object.assign({ "Content-Type": "application/json" }, opts.headers || {});
      return fetch("/api/connectors" + path, opts).then(function (r) {
        return r.text().then(function (txt) {
          var j = {}; try { j = txt ? JSON.parse(txt) : {}; } catch (e) {}
          if (!r.ok) throw new Error((j && (j.error || j.detail)) || ("HTTP " + r.status));
          return j;
        });
      });
    }

    function whenStr(iso) {
      try {
        var d = new Date(iso); if (isNaN(d.getTime())) return "";
        var secs = Math.floor((Date.now() - d.getTime()) / 1000);
        if (secs < 60) return secs + "s ago";
        if (secs < 3600) return Math.floor(secs / 60) + "m ago";
        if (secs < 86400) return Math.floor(secs / 3600) + "h ago";
        return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
      } catch (e) { return ""; }
    }

    // Map Paperclip issue/run status -> a friendly bucket for the chip.
    function bucket(status) {
      var s = (status || "").toLowerCase();
      if (/(done|closed|complete|resolved|finished|succeed|success)/.test(s)) return { k: "done", label: "Done" };
      if (/(in[_ -]?progress|working|running|active|executing|live)/.test(s)) return { k: "working", label: "Working" };
      if (/(review|needs|blocked|attention|approval|waiting|paused|failed|error)/.test(s)) return { k: "attn", label: "Needs you" };
      return { k: "queued", label: s ? (s.charAt(0).toUpperCase() + s.slice(1)) : "Queued" };
    }

    function chip(status) {
      var b = bucket(status);
      return h("span", { className: "st-chip st-" + b.k }, b.k === "working" ? h("span", { className: "st-spin" }) : null, b.label);
    }

    function Tasks() {
      var s;
      s = useState(null);  var list = s[0], setList = s[1];        // {tasks, company_slug, paperclip_up}
      s = useState(null);  var sel = s[0], setSel = s[1];          // selected task key
      s = useState(null);  var detail = s[0], setDetail = s[1];    // detail of selected
      s = useState(false); var dLoad = s[0], setDLoad = s[1];
      s = useState("all"); var filter = s[0], setFilter = s[1];    // all|working|attn|done
      s = useState(null);  var err = s[0], setErr = s[1];

      function loadList() {
        return api("/orchestration/tasks").then(function (d) { setList(d); setErr(null); return d; })
          .catch(function (e) { setErr(String(e.message || e)); });
      }
      function loadDetail(key) {
        setDLoad(true);
        return api("/orchestration/tasks/" + encodeURIComponent(key))
          .then(function (d) { setDLoad(false); setDetail(d); })
          .catch(function (e) { setDLoad(false); setDetail({ key: key, messages: [], deliverables: [], errors: [String(e.message || e)] }); });
      }
      function open(key) { setSel(key); setDetail(null); loadDetail(key); }

      useEffect(function () {
        loadList();
        var t = setInterval(loadList, 15000);
        return function () { clearInterval(t); };
      }, []);
      // Refresh the open task while it may still be working.
      useEffect(function () {
        if (!sel) return;
        var t = setInterval(function () { loadDetail(sel); }, 10000);
        return function () { clearInterval(t); };
      }, [sel]);

      var tasks = (list && list.tasks) ? list.tasks : [];
      var up = list ? list.paperclip_up : null;
      var shown = tasks.filter(function (t) { return filter === "all" || bucket(t.status).k === filter; });

      function pcBase() { return location.protocol + "//" + location.hostname + ":3100"; }
      function pcTaskUrl(key) {
        var slug = list && list.company_slug;
        return slug ? (pcBase() + "/" + slug + "/issues/" + key) : (pcBase() + "/");
      }

      function header() {
        return h("div", { className: "st-top" },
          h("div", null,
            h("div", { className: "st-h1" }, "Tasks"),
            h("div", { className: "st-sub" }, "What your agents are working on — and everything they've produced.")));
      }

      function filters() {
        var opts = [["all", "All"], ["working", "Working"], ["attn", "Needs you"], ["done", "Done"]];
        return h("div", { className: "st-filters" }, opts.map(function (o) {
          return h("button", { key: o[0], className: "st-filt" + (filter === o[0] ? " on" : ""),
            onClick: function () { setFilter(o[0]); } }, o[1]);
        }));
      }

      function row(t) {
        return h("button", { key: t.key, className: "st-row" + (sel === t.key ? " sel" : ""), onClick: function () { open(t.key); } },
          h("div", { className: "st-row-main" },
            h("div", { className: "st-row-title" }, t.title),
            h("div", { className: "st-row-meta" },
              t.agentName ? h("span", { className: "st-agent" }, t.agentName) : null,
              h("span", { className: "st-key" }, t.key),
              t.updatedAt ? h("span", { className: "st-time" }, whenStr(t.updatedAt)) : null)),
          chip(t.status));
      }

      function listPane() {
        return h("div", { className: "st-listpane" },
          filters(),
          up === false ? h("div", { className: "st-empty" }, "The control plane is starting — tasks will appear once it's up.")
            : list == null ? h("div", { className: "st-empty" }, "Loading…")
            : shown.length === 0 ? h("div", { className: "st-empty" }, tasks.length === 0 ? "No tasks yet. Create an agent, or assign one a task, and it'll show here." : "Nothing matches this filter.")
            : h("div", { className: "st-list" }, shown.map(row)));
      }

      function msg(m, i) {
        var mine = m.role === "user";
        return h("div", { className: "st-msg " + (mine ? "me" : "agent"), key: i },
          h("div", { className: "st-msg-who" }, mine ? "You" : (m.author || "Agent")),
          h("div", { className: "st-msg-text" }, m.text || ""),
          m.at ? h("div", { className: "st-msg-at" }, whenStr(m.at)) : null);
      }

      function detailPane() {
        if (!sel) return h("div", { className: "st-detail st-detail-empty" },
          h("div", { className: "st-empty" }, "Select a task to see the agent's work."));
        var d = detail;
        var cur = tasks.filter(function (t) { return t.key === sel; })[0] || { key: sel };
        var msgs = (d && d.messages) ? d.messages : [];
        var dels = (d && d.deliverables) ? d.deliverables : [];
        return h("div", { className: "st-detail" },
          h("div", { className: "st-dhead" },
            h("div", { className: "st-dtitle" }, cur.title || sel),
            h("div", { className: "st-dmeta" },
              chip((d && d.status) || cur.status),
              cur.agentName ? h("span", { className: "st-agent" }, cur.agentName) : null,
              h("a", { className: "st-link", href: pcTaskUrl(sel), target: "_blank", rel: "noopener" }, "View in Paperclip ↗"))),
          dLoad && !d ? h("div", { className: "st-empty" }, "Loading…") : null,
          h("div", { className: "st-section-h" }, "Output"),
          msgs.length === 0
            ? h("div", { className: "st-empty st-sm" }, dLoad ? "Loading…" : "No messages yet — the agent may still be working.")
            : h("div", { className: "st-thread" }, msgs.map(msg)),
          h("div", { className: "st-section-h" }, "Deliverables"),
          dels.length === 0
            ? h("div", { className: "st-empty st-sm" }, "No files produced for this task.")
            : h("div", { className: "st-dels" }, dels.map(function (w, i) {
                return h("a", { key: i, className: "st-del", href: pcTaskUrl(sel), target: "_blank", rel: "noopener" },
                  h("span", { className: "st-del-ic" }, "📄"),
                  h("span", { className: "st-del-name" }, w.name),
                  w.kind ? h("span", { className: "st-del-kind" }, String(w.kind)) : null);
              })));
      }

      return h("div", { className: "st-wrap" },
        header(),
        err ? h("div", { className: "st-msgbar st-err" }, err) : null,
        h("div", { className: "st-cols" }, listPane(), detailPane()),
        h("div", { className: "st-foot" }, "Read-only view of your agents' work. Open a task in Paperclip for approvals, the full history, and file downloads."));
    }

    try { PLUGINS.register("suburban-tasks", Tasks); console.info(TAG, "registered"); }
    catch (e) { try { console.error(TAG, "register failed", e); } catch (e2) {} }

    // ---- Inject a "Tasks" nav item (clone an existing sidebar link) ----
    function norm(x) { return (x || "").replace(/\s+/g, " ").trim().toLowerCase(); }
    var NAV_LABELS = { chat: 1, sessions: 1, files: 1, models: 1, logs: 1, cron: 1, skills: 1, plugins: 1, config: 1, overview: 1, mailboxes: 1, bookings: 1, automations: 1, orchestration: 1 };
    function navTemplate() {
      var links = document.querySelectorAll("a[href]");
      for (var i = 0; i < links.length; i++) {
        var t = norm(links[i].textContent);
        if (NAV_LABELS[t]) { var r = links[i].getBoundingClientRect(); if (r.left < 360) return links[i]; }
      }
      return null;
    }
    function href() { return "/tasks" + (location.search || ""); }
    function markActive() {
      try {
        var el = document.getElementById("st-nav"); if (!el) return;
        el.setAttribute("href", href());
        var on = location.pathname === "/tasks";
        el.style.borderLeft = on ? "2px solid var(--color-primary,#25c9ee)" : "2px solid transparent";
        el.style.background = on ? "var(--color-accent,rgba(37,201,238,.08))" : "";
      } catch (e) {}
    }
    function injectNav() {
      try {
        if (document.getElementById("st-nav")) { markActive(); return; }
        var tmpl = navTemplate(); if (!tmpl || !tmpl.parentElement) return;
        var tmplLabel = norm(tmpl.textContent);
        var clone = tmpl.cloneNode(true);
        clone.id = "st-nav";
        clone.setAttribute("href", href()); try { clone.href = href(); } catch (e) {}
        var w = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT, null), n;
        while ((n = w.nextNode())) { if (norm(n.nodeValue) === tmplLabel) { n.nodeValue = "Tasks"; break; } }
        if (tmpl.nextSibling) tmpl.parentElement.insertBefore(clone, tmpl.nextSibling);
        else tmpl.parentElement.appendChild(clone);
        markActive();
      } catch (e) {}
    }
    function tick() { injectNav(); }
    try {
      var mo = new MutationObserver(function () { if (tick._p) return; tick._p = setTimeout(function () { tick._p = null; tick(); }, 150); });
      if (document.body) {
        mo.observe(document.body, { childList: true, subtree: true });
        window.addEventListener("popstate", markActive);
        tick(); setTimeout(tick, 500); setTimeout(tick, 1500);
      }
    } catch (e) {}
  });
})();
