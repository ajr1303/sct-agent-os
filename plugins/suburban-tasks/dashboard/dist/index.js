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

    function chip(status, running) {
      var b = bucket(status);
      if (running) return h("span", { className: "st-chip st-working" }, h("span", { className: "st-spin" }), "Running now");
      return h("span", { className: "st-chip st-" + b.k }, b.k === "working" ? "In progress" : b.label);
    }

    function Tasks() {
      var s;
      s = useState(null);  var list = s[0], setList = s[1];        // {tasks, company_slug, paperclip_up}
      s = useState(null);  var sel = s[0], setSel = s[1];          // selected task key
      s = useState(null);  var detail = s[0], setDetail = s[1];    // detail of selected
      s = useState(false); var dLoad = s[0], setDLoad = s[1];
      s = useState("all"); var filter = s[0], setFilter = s[1];    // all|working|attn|done
      s = useState(null);  var err = s[0], setErr = s[1];
      s = useState([]);    var blocked = s[0], setBlocked = s[1];  // tasks halted by the fast-stop
      s = useState(null);  var unblk = s[0], setUnblk = s[1];      // session_key being unblocked
      s = useState("");    var reply = s[0], setReply = s[1];      // owner reply being typed
      s = useState(false); var rBusy = s[0], setRBusy = s[1];
      s = useState(null);  var rErr = s[0], setRErr = s[1];
      s = useState(false); var askCancel = s[0], setAskCancel = s[1];

      function loadList() {
        return api("/orchestration/tasks").then(function (d) { setList(d); setErr(null); return d; })
          .catch(function (e) { setErr(String(e.message || e)); });
      }
      function loadBlocked() {
        return api("/gateway/blocked").then(function (d) { setBlocked((d && d.blocked) || []); })
          .catch(function () { /* non-fatal: banner just won't show */ });
      }
      function unblock(sk) {
        setUnblk(sk);
        api("/gateway/unblock", { method: "POST", body: JSON.stringify({ session_key: sk }) })
          .then(function () { return loadBlocked(); })
          .catch(function (e) { setErr(String(e.message || e)); })
          .then(function () { setUnblk(null); });
      }
      function loadDetail(key) {
        setDLoad(true);
        return api("/orchestration/tasks/" + encodeURIComponent(key))
          .then(function (d) { setDLoad(false); setDetail(d); })
          .catch(function (e) { setDLoad(false); setDetail({ key: key, messages: [], deliverables: [], errors: [String(e.message || e)] }); });
      }
      function open(key) { setSel(key); setDetail(null); setReply(""); setRErr(null); setAskCancel(false); loadDetail(key); }
      function isClosed(st) { return /^(done|cancelled)$/.test(String(st || "").toLowerCase()); }
      function after(p) {
        return p.then(function () { setRBusy(false); setAskCancel(false); return Promise.all([loadDetail(sel), loadList()]); })
          .catch(function (e) { setRBusy(false); setRErr(String(e.message || e)); });
      }
      function sendReply(e, closed) {
        if (e) e.preventDefault();
        var text = reply.trim();
        if (!text || rBusy) return;
        setRBusy(true); setRErr(null);
        after(api("/orchestration/tasks/" + encodeURIComponent(sel) + "/reply",
          { method: "POST", body: JSON.stringify({ text: text, reopen: !!closed }) }).then(function () { setReply(""); }));
      }
      function setTaskStatus(st) {
        if (rBusy) return;
        setRBusy(true); setRErr(null);
        after(api("/orchestration/tasks/" + encodeURIComponent(sel) + "/status", { method: "POST", body: JSON.stringify({ status: st }) }));
      }

      useEffect(function () {
        loadList(); loadBlocked();
        var t = setInterval(function () { loadList(); loadBlocked(); }, 15000);
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
      function inFilter(t, f) { return f === "all" || bucket(t.status).k === f || (f === "working" && t.running); }
      var shown = tasks.filter(function (t) { return inFilter(t, filter); })
        .sort(function (x, y) { return (y.running ? 1 : 0) - (x.running ? 1 : 0); });   // live work first; otherwise newest first as delivered
      function countFor(f) { var n = 0; for (var i = 0; i < tasks.length; i++) if (inFilter(tasks[i], f)) n++; return n; }

      function pcBase() { var L = window.__SCT_LINKS__; if (L && L.paperclip) return L.paperclip.replace(/\/+$/, ""); return location.protocol + "//" + location.hostname + ":3100"; }
      function pcTaskUrl(key) {
        var slug = list && list.company_slug;
        return slug ? (pcBase() + "/" + slug + "/issues/" + key) : (pcBase() + "/");
      }

      function header() {
        return h("div", { className: "st-top" },
          h("div", null,
            h("div", { className: "st-h1" }, "Tasks"),
            h("div", { className: "st-sub" }, "What your agents are working on and what they've produced. Shows work in progress, what's waiting on you, and the most recent finished tasks.")));
      }

      function filters() {
        var opts = [["all", "All"], ["working", "Working"], ["attn", "Needs you"], ["done", "Done"]];
        return h("div", { className: "st-filters" }, opts.map(function (o) {
          return h("button", { key: o[0], className: "st-filt" + (filter === o[0] ? " on" : ""),
            onClick: function () { setFilter(o[0]); } }, o[1], o[0] !== "all" && list ? h("span", { className: "st-count" }, countFor(o[0])) : null);
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
          chip(t.status, t.running));
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
              chip(cur.status || (d && d.status)),
              cur.agentName ? h("span", { className: "st-agent" }, cur.agentName) : null,
              h("a", { className: "st-link", href: pcTaskUrl(sel), target: "_blank", rel: "noopener" }, "View in Paperclip ↗"))),
          dLoad && !d ? h("div", { className: "st-empty" }, "Loading…") : null,
          d && d.description ? h("div", { className: "st-ask" },
            h("div", { className: "st-section-h" }, "What was asked"),
            h("div", { className: "st-ask-text" }, d.description)) : null,
          h("div", { className: "st-section-h" }, "Conversation"),
          msgs.length === 0
            ? h("div", { className: "st-empty st-sm" }, dLoad ? "Loading…" : "No messages yet — the agent may still be working.")
            : h("div", { className: "st-thread" }, msgs.map(msg)),
          d && d.can_reply ? (function () {
            var st = d.issue_status || cur.status, closed = isClosed(st), who = cur.agentName || "the agent";
            return h("form", { className: "st-reply", onSubmit: function (e) { sendReply(e, closed); } },
              h("textarea", { className: "st-reply-in", value: reply, maxLength: 8000, rows: 3,
                placeholder: closed ? "Reply to reopen this task and send " + who + " back to work…" : "Reply to " + who + "…",
                onChange: function (e) { setReply(e.target.value); },
                onKeyDown: function (e) { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) sendReply(e, closed); } }),
              rErr ? h("div", { className: "st-msgbar st-err" }, rErr) : null,
              h("div", { className: "st-reply-row" },
                h("span", { className: "st-reply-hint" }, /^backlog$/i.test(String(st || ""))
                  ? "This task is in the backlog: your reply is saved, but nobody starts on it until it is scheduled."
                  : cur.agentName
                  ? (closed ? "Sending reopens the task and wakes " + who + "." : who + " is woken to read your reply.")
                  : "No agent is assigned, so nobody is woken by a reply."),
                h("span", { className: "st-reply-acts" },
                  askCancel
                    ? h("span", { className: "st-confirm" }, "Cancel this task?",
                        h("button", { type: "button", className: "st-btn st-danger", disabled: rBusy, onClick: function () { setTaskStatus("cancelled"); } }, "Yes, cancel it"),
                        h("button", { type: "button", className: "st-btn", onClick: function () { setAskCancel(false); } }, "Keep"))
                    : closed
                      ? h("button", { type: "button", className: "st-btn", disabled: rBusy, onClick: function () { setTaskStatus("todo"); } }, "Reopen")
                      : h("span", { className: "st-reply-acts" },
                          h("button", { type: "button", className: "st-btn", disabled: rBusy, onClick: function () { setAskCancel(true); } }, "Cancel task"),
                          h("button", { type: "button", className: "st-btn", disabled: rBusy, onClick: function () { setTaskStatus("done"); } }, "Mark done")),
                  h("button", { type: "submit", className: "st-btn st-primary", disabled: rBusy || !reply.trim() },
                    rBusy ? "Sending…" : (closed ? "Reply & reopen" : "Send reply")))));
          })() : null,
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

      function blockedLabel(b) {
        var m = tasks.filter(function (t) { return t.key === b.issue_key; })[0];
        if (m && m.title) return m.title;
        return b.issue_key ? ("Task " + b.issue_key) : "A task";
      }
      function blockedBanner() {
        if (!blocked || blocked.length === 0) return null;
        return h("div", { className: "st-halt" },
          h("div", { className: "st-halt-head" },
            h("span", { className: "st-halt-ic" }, "⛔"),
            h("span", null, blocked.length === 1
              ? "1 task was automatically stopped after repeated retries."
              : (blocked.length + " tasks were automatically stopped after repeated retries."))),
          h("div", { className: "st-halt-sub" },
            "Agent OS halts a task once it has tried to run too many times, so a stuck task can't keep spending. Look at what it was doing, then release it to let the agent try again."),
          h("div", { className: "st-halt-list" }, blocked.map(function (b, i) {
            return h("div", { className: "st-halt-row", key: b.session_key || i },
              h("span", { className: "st-halt-name" }, blockedLabel(b)),
              h("span", { className: "st-halt-n" }, (b.attempts || 0) + " tries"),
              h("button", { className: "st-halt-btn", disabled: unblk === b.session_key,
                onClick: function () { unblock(b.session_key); } },
                unblk === b.session_key ? "Releasing…" : "Release"));
          })));
      }

      return h("div", { className: "st-wrap" },
        header(),
        err ? h("div", { className: "st-msgbar st-err" }, err) : null,
        blockedBanner(),
        h("div", { className: "st-cols" }, listPane(), detailPane()),
        h("div", { className: "st-foot" }, "Reply, reopen, finish or cancel a task here. Approvals, the full history and file downloads still open in Paperclip."));
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
        if (window.__SCT_NAV__) return;  // brand/nav.js arranges the sidebar with Hermes' own links
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
