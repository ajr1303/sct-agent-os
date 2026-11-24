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

    // Text from agents is written as light markdown. Everything is escaped first, so
    // nothing an agent (or a web page an agent read) wrote can run in the dashboard.
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
    function Md(src, cls) { return h("div", { className: "st-md" + (cls ? " " + cls : ""), dangerouslySetInnerHTML: { __html: md(src) } }); }

    // Map a task to a friendly bucket. A blocked or in-review task only "needs you"
    // when there is a decision for the owner; otherwise it is waiting on the team.
    function bucket(status, waitingOn) {
      var s = (status || "").toLowerCase();
      if (/(done|closed|complete|resolved|finished|succeed|success)/.test(s)) return { k: "done", label: "Done" };
      if (/(in[_ -]?progress|working|running|active|executing|live)/.test(s)) return { k: "working", label: "Working" };
      if (/(review|needs|blocked|attention|approval|waiting|paused|failed|error)/.test(s))
        return waitingOn === "team" ? { k: "team", label: "With the team" } : { k: "attn", label: "Needs you" };
      return { k: "queued", label: s ? (s.charAt(0).toUpperCase() + s.slice(1)) : "Queued" };
    }

    function chip(status, running, waitingOn) {
      var b = bucket(status, waitingOn);
      if (running) return h("span", { className: "st-chip st-working" }, h("span", { className: "st-spin" }), "Running now");
      return h("span", { className: "st-chip st-" + b.k }, b.k === "working" ? "In progress" : b.label);
    }
    function initials(n) { n = String(n || "?").trim(); return (n.charAt(0) || "?").toUpperCase(); }
    // Notes the system posts on a task, as opposed to an agent's own words.
    function isAsk(m) { return /^\*\*Decision needed from the owner\*\*/.test(String(m.text || "")); }
    function isAuto(m) { return /^(Automatic check:|\*\*Sent to |Split into \d+ smaller|Handed to |Closed by the owner)/.test(String(m.text || "")); }

    var decFirst = false;
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
      s = useState(false); var picking = s[0], setPicking = s[1];  // choosing several tasks to close at once
      s = useState({});    var picked = s[0], setPicked = s[1];    // key -> true
      s = useState(false); var bulkBusy = s[0], setBulkBusy = s[1];
      s = useState(null);  var bulkMsg = s[0], setBulkMsg = s[1];
      s = useState(false); var replyMode = s[0], setReplyMode = s[1];   // the open text box is a reply, not a note
      s = useState(null);  var dec = s[0], setDec = s[1];          // {decisions, alerts, with_lead, lead}
      s = useState(null);  var dBusy = s[0], setDBusy = s[1];      // "<card id>:<action>" while a button is working
      s = useState({});    var dMsg = s[0], setDMsg = s[1];        // card id -> what happened
      s = useState(null);  var noteFor = s[0], setNoteFor = s[1];  // card id with the note box open
      s = useState("");    var note = s[0], setNote = s[1];
      s = useState(false); var showAlerts = s[0], setShowAlerts = s[1];
      s = useState(false); var askOpen = s[0], setAskOpen = s[1];  // full request shown
      s = useState(function () { try { return localStorage.getItem("sct-tasks-view") === "board" ? "board" : "list"; } catch (e) { return "list"; } });
      var view = s[0], setViewRaw = s[1];                          // list | board
      function setView(v) { try { localStorage.setItem("sct-tasks-view", v); } catch (e) {} setViewRaw(v); }

      function loadList() {
        return api("/orchestration/tasks").then(function (d) { setList(d); setErr(null); return d; })
          .catch(function (e) { setErr(String(e.message || e)); });
      }
      function loadBlocked() {
        return api("/gateway/blocked").then(function (d) { setBlocked((d && d.blocked) || []); })
          .catch(function () { /* non-fatal: banner just won't show */ });
      }
      function loadDec() {
        return api("/orchestration/decisions").then(function (d) {
          setDec(d);
          if (!decFirst) { decFirst = true; if ((d.decisions || []).length) setFilter("attn"); }   // open on what needs an answer
          return d;
        }).catch(function () { /* the list still works without the cards */ });
      }
      function decide(card, action) {
        if (dBusy) return;
        // Reply opens a text box first; the second press sends what was typed.
        if (action === "reply" && !(noteFor === card.id && replyMode)) { setNoteFor(card.id); setNote(""); setReplyMode(true); return; }
        if (action === "reply" && !note.trim()) return;
        setDBusy(card.id + ":" + action);
        var body = { id: card.id, action: action, note: noteFor === card.id ? note.trim() : "" };
        api("/orchestration/decisions/act", { method: "POST", body: JSON.stringify(body) })
          .then(function (r) {
            var m = {}; for (var k in dMsg) m[k] = dMsg[k]; m[card.id] = { ok: true, text: r.message || "Done." }; setDMsg(m);
            setDBusy(null); setNoteFor(null); setNote(""); setReplyMode(false);
            return Promise.all([loadDec(), loadList(), sel ? loadDetail(sel) : null]);
          })
          .catch(function (e) {
            var m = {}; for (var k in dMsg) m[k] = dMsg[k]; m[card.id] = { ok: false, text: String(e.message || e) }; setDMsg(m);
            setDBusy(null); loadDec();
          });
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
      function open(key) { setSel(key); setDetail(null); setReply(""); setRErr(null); setAskCancel(false); setAskOpen(false); loadDetail(key); }
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
        loadList(); loadBlocked(); loadDec();
        var t = setInterval(function () { loadList(); loadBlocked(); loadDec(); }, 15000);
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
      function inFilter(t, f) { return f === "all" || bucket(t.status, t.waiting_on).k === f || (f === "working" && t.running); }
      var cards = (dec && dec.decisions) || null;
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
            h("div", { className: "st-sub" }, "What your agents are working on and what they've produced. Decisions that need you come first; everything else is handled by the team.")),
          h("div", { className: "st-view" }, ["list", "board"].map(function (v) {
            return h("button", { type: "button", key: v, className: "st-view-b" + (view === v ? " on" : ""), onClick: function () { setView(v); } }, v === "list" ? "List" : "Board");
          })));
      }
      // Board: the same tasks in four columns. A card opens the task underneath.
      function boardPane() {
        if (up === false) return h("div", { className: "st-empty" }, "Team management is starting. Tasks will appear once it's up.");
        if (list == null) return h("div", { className: "st-empty" }, err ? "Couldn't load tasks. Try again in a minute." : "Loading…");
        if (list.connected === false) return h("div", { className: "st-empty" }, "Your team isn't linked yet. ",
          h("a", { href: "/orchestration" + (location.search || "") }, "Finish setup on the Orchestration page"), ".");
        var cols = [["you", "Needs you", []], ["doing", "In progress", []], ["next", "Up next", []], ["done", "Done", []]];
        tasks.forEach(function (t) {
          var st = String(t.status || "").toLowerCase();
          var i = isClosed(st) ? 3 : t.waiting_on === "owner" ? 0 : (t.running || st === "in_progress") ? 1 : 2;
          cols[i][2].push(t);
        });
        return h("div", { className: "st-board" }, cols.map(function (c) {
          var items = c[2], CAP = c[0] === "done" ? 8 : 25;      // finished work is history: a short tail keeps the board even
          return h("div", { className: "st-bcol st-bcol-" + c[0], key: c[0] },
            h("div", { className: "st-bcol-h" }, h("span", null, c[1]), h("span", { className: "st-bcol-n" }, items.length)),
            items.length === 0 ? h("div", { className: "st-bcol-e" }, c[0] === "you" ? "Nothing needs you." : "Nothing here.")
              : items.slice(0, CAP).map(function (t) {
                  return h("button", { type: "button", key: t.key, className: "st-bcard" + (sel === t.key ? " sel" : ""),
                      onClick: function () { open(t.key); setTimeout(function () { try { var el = document.querySelector(".st-bdetail"); if (el) el.scrollIntoView({ behavior: "smooth", block: "start" }); } catch (e) {} }, 60); } },
                    h("span", { className: "st-bcard-t" }, t.title),
                    h("span", { className: "st-bcard-m" }, (t.agentName ? t.agentName + " · " : "") + t.key + (t.updatedAt ? " · " + whenStr(t.updatedAt) : "")));
                }),
            items.length > CAP ? h("button", { type: "button", className: "st-linkbtn st-bmore", onClick: function () { setView("list"); } }, "and " + (items.length - CAP) + " more in the list") : null);
        }));
      }

      function filters() {
        var opts = [["attn", "Needs you"], ["working", "Working"], ["team", "With the team"], ["done", "Done"], ["all", "All"]];
        return h("div", { className: "st-filters" }, opts.map(function (o) {
          var n = o[0] === "attn" && cards ? cards.length : countFor(o[0]);
          return h("button", { key: o[0], className: "st-filt" + (filter === o[0] ? " on" : ""),
            onClick: function () { setFilter(o[0]); } }, o[1], o[0] !== "all" && list ? h("span", { className: "st-count" }, n) : null);
        }));
      }

      function pickedKeys() { return Object.keys(picked).filter(function (k) { return picked[k]; }); }
      function togglePick(key) { var n = Object.assign({}, picked); if (n[key]) delete n[key]; else n[key] = true; setPicked(n); }
      function stopPicking() { setPicking(false); setPicked({}); }
      function bulkClose(st) {
        var keys = pickedKeys(); if (!keys.length) return;
        var word = st === "done" ? "done" : "cancelled";
        if (!window.confirm("Mark " + keys.length + " task" + (keys.length === 1 ? "" : "s") + " " + word + "?\n\nAgents waiting on these will not get an answer from you. You can reopen a task later from its page.")) return;
        setBulkBusy(true); setBulkMsg(null);
        api("/orchestration/tasks/bulk-status", { method: "POST", body: JSON.stringify({ keys: keys.slice(0, 100), status: st }) })
          .then(function (d) {
            setBulkBusy(false); setPicked({});
            var f = (d.failed || []).length;
            setBulkMsg(d.ok + " task" + (d.ok === 1 ? "" : "s") + " marked " + word + "." + (f ? " " + f + " could not be changed: " + d.failed[0].error : ""));
            loadList();
          }).catch(function (e) { setBulkBusy(false); setBulkMsg(String(e.message || e)); });
      }
      function bulkBar() {
        var writable = !(list && list.connected === false);
        if (!writable || !shown.length) return null;
        var open = shown.filter(function (t) { return !isClosed(t.status); });
        if (!picking) return h("div", { className: "st-bulk" },
          h("button", { type: "button", className: "st-bulk-btn", onClick: function () { setPicking(true); setBulkMsg(null); } }, "Select several"),
          bulkMsg ? h("span", { className: "st-bulk-msg" }, bulkMsg) : null);
        var n = pickedKeys().length;
        return h("div", { className: "st-bulk st-bulk-on" },
          h("button", { type: "button", className: "st-bulk-btn", onClick: function () { var m = {}; open.slice(0, 100).forEach(function (t) { m[t.key] = true; }); setPicked(m); } },
            "Select all shown" + (open.length > 100 ? " (first 100)" : "")),
          h("button", { type: "button", className: "st-bulk-btn st-bulk-go", disabled: !n || bulkBusy, onClick: function () { bulkClose("done"); } }, bulkBusy ? "Working…" : "Mark " + n + " done"),
          h("button", { type: "button", className: "st-bulk-btn", disabled: !n || bulkBusy, onClick: function () { bulkClose("cancelled"); } }, "Cancel " + n),
          h("button", { type: "button", className: "st-bulk-btn", onClick: stopPicking }, "Finish"),
          bulkMsg ? h("span", { className: "st-bulk-msg" }, bulkMsg) : null);
      }
      function row(t) {
        if (picking) {
          var closed = isClosed(t.status);
          return h("label", { key: t.key, className: "st-row st-row-pick" + (picked[t.key] ? " sel" : "") + (closed ? " st-row-off" : "") },
            h("input", { type: "checkbox", className: "st-pick", checked: !!picked[t.key], disabled: closed, onChange: function () { togglePick(t.key); } }),
            h("div", { className: "st-row-main" },
              h("div", { className: "st-row-title" }, t.title),
              h("div", { className: "st-row-meta" },
                t.agentName ? h("span", { className: "st-agent" }, t.agentName) : null,
                h("span", { className: "st-key" }, t.key),
                t.updatedAt ? h("span", { className: "st-time" }, whenStr(t.updatedAt)) : null)),
            chip(t.status, t.running, t.waiting_on));
        }
        return h("button", { key: t.key, className: "st-row" + (sel === t.key ? " sel" : ""), onClick: function () { open(t.key); } },
          h("div", { className: "st-row-main" },
            h("div", { className: "st-row-title" }, t.title),
            h("div", { className: "st-row-meta" },
              t.agentName ? h("span", { className: "st-agent" }, t.agentName) : null,
              h("span", { className: "st-key" }, t.key),
              t.updatedAt ? h("span", { className: "st-time" }, whenStr(t.updatedAt)) : null)),
          chip(t.status, t.running, t.waiting_on));
      }

      // One decision: what it is about, what the agent recommends, and the buttons.
      function card(c, inDetail) {
        var msg = dMsg[c.id], canAct = !dec || dec.can_act !== false;
        return h("div", { key: c.id, className: "st-card st-card-" + c.kind + (!inDetail && c.key && sel === c.key ? " sel" : "") },
          h("div", { className: "st-card-top" },
            h("span", { className: "st-tag st-tag-" + c.kind }, c.tag),
            c.agent ? h("span", { className: "st-agent" }, c.agent) : null,
            c.key ? h("span", { className: "st-key" }, c.key) : null,
            c.at ? h("span", { className: "st-time" }, whenStr(c.at)) : null),
          inDetail ? null : (c.key
            ? h("button", { type: "button", className: "st-card-title st-card-open", onClick: function () { open(c.key); } }, c.title)
            : h("div", { className: "st-card-title" }, c.title)),
          c.summary ? Md(c.summary, "st-card-sum") : null,
          c.question ? h("div", { className: "st-card-q" }, h("span", { className: "st-card-l" }, "Question"), Md(c.question)) : null,
          c.recommendation ? h("div", { className: "st-card-rec" }, h("span", { className: "st-card-l" }, "Recommended"), Md(c.recommendation)) : null,
          noteFor === c.id ? h("textarea", { className: "st-reply-in st-card-note", rows: replyMode ? 3 : 2, maxLength: 1500, value: note, autoFocus: true,
            "aria-label": replyMode ? "Your reply to " + (c.agent || "the agent") : "Note for the agent",
            placeholder: replyMode ? "Type your answer to " + (c.agent || "the agent") + ", then press Send reply"
              : "Add a note for the agent, then press a button (optional)", onChange: function (e) { setNote(e.target.value); } }) : null,
          canAct && noteFor === c.id && replyMode ? h("div", { className: "st-card-acts" },
            h("button", { type: "button", disabled: !!dBusy || !note.trim(), className: "st-btn st-dbtn st-primary", onClick: function () { decide(c, "reply"); } },
              dBusy === c.id + ":reply" ? "Sending…" : "Send reply"),
            h("button", { type: "button", className: "st-linkbtn", onClick: function () { setNoteFor(null); setNote(""); setReplyMode(false); } }, "Cancel")) : null,
          canAct && !(noteFor === c.id && replyMode) ? h("div", { className: "st-card-acts" },
            (c.buttons || []).map(function (b) {
              var busy = dBusy === c.id + ":" + b.id;
              return h("button", { key: b.id, type: "button", disabled: !!dBusy,
                className: "st-btn st-dbtn" + (b.style === "primary" ? " st-primary" : "") + (b.id === "decline" || b.id === "close" ? " st-quiet" : ""),
                onClick: function () { decide(c, b.id); } }, busy ? "Working…" : b.label);
            }),
            (c.buttons || []).length && noteFor !== c.id
              && (c.buttons || []).some(function (b) { return b.id !== "reply"; })
              ? h("button", { type: "button", className: "st-linkbtn", onClick: function () { setNoteFor(c.id); setNote(""); setReplyMode(false); } }, "Add a note") : null,
            c.open_in_board && c.key ? h("a", { className: "st-link", href: pcTaskUrl(c.key), target: "_blank", rel: "noopener" }, "Answer on the team board ↗") : null) : null,
          msg ? h("div", { className: "st-card-msg" + (msg.ok ? "" : " st-err") }, msg.text) : null);
      }
      function cleanup() {
        if (dBusy) return;
        setDBusy("cleanup");
        api("/orchestration/decisions/cleanup", { method: "POST", body: JSON.stringify({ days: 3, dry_run: true }) })
          .then(function (r) {
            if (!r.count) { setDBusy(null); setDMsg(Object.assign({}, dMsg, { _cleanup: { ok: true, text: "Nothing has been waiting on you for more than 3 days." } })); return null; }
            var list = (r.items || []).slice(0, 15).map(function (i) { return "• " + (i.key ? i.key + " " : "") + i.title; }).join("\n");
            if (!window.confirm("Close " + r.count + " task" + (r.count === 1 ? "" : "s") + " that have waited on you for more than 3 days with no answer?\n\n"
                + list + (r.count > 15 ? "\n…and " + (r.count - 15) + " more" : "") + "\n\nYou can reopen any of them from its page.")) { setDBusy(null); return null; }
            return api("/orchestration/decisions/cleanup", { method: "POST", body: JSON.stringify({ days: 3, dry_run: false }) })
              .then(function (d) {
                setDBusy(null); setDMsg(Object.assign({}, dMsg, { _cleanup: { ok: true, text: d.message || "Done." } }));
                return Promise.all([loadDec(), loadList()]);
              });
          })
          .catch(function (e) { setDBusy(null); setDMsg(Object.assign({}, dMsg, { _cleanup: { ok: false, text: String(e.message || e) } })); });
      }
      function decisionPane() {
        var al = (dec && dec.alerts) || [];
        var done = []; for (var k in dMsg) if (dMsg[k].ok && !cards.some(function (c) { return c.id === k; })) done.push(dMsg[k].text);
        return h("div", null,
          dec.with_lead ? h("div", { className: "st-lead" }, dec.with_lead + " stuck task" + (dec.with_lead === 1 ? " is" : "s are") + " going to " + (dec.lead || "your lead agent")
            + " to sort out first. You'll only see one if it still needs you.") : null,
          cards.length === 0
            ? h("div", { className: "st-empty st-clear" }, h("div", { className: "st-clear-h" }, "Nothing needs you right now."),
                done.length ? done[done.length - 1] + " " : "", "Your team is handling the rest. Anything that needs a decision shows up here with buttons.")
            : h("div", { className: "st-cards" },
                h("div", { className: "st-cleanup" },
                  h("button", { type: "button", className: "st-linkbtn", disabled: !!dBusy, onClick: cleanup },
                    dBusy === "cleanup" ? "Checking…" : "Clear tasks waiting more than 3 days"),
                  dMsg._cleanup ? h("span", { className: dMsg._cleanup.ok ? "st-done" : "st-err" }, " " + dMsg._cleanup.text) : null),
                cards.map(function (c) { return card(c, false); })),
          al.length ? h("div", { className: "st-alerts" },
            h("button", { type: "button", className: "st-linkbtn", onClick: function () { setShowAlerts(!showAlerts); } },
              (showAlerts ? "Hide " : "Show ") + al.length + " alert" + (al.length === 1 ? "" : "s") + " (failed runs and agent errors, not decisions)"),
            showAlerts ? h("div", { className: "st-alert-list" }, al.map(function (a, i) {
              return h("div", { key: i, className: "st-alert" },
                h("span", { className: "st-tag st-tag-alert" }, a.kind), h("span", { className: "st-alert-t" }, a.title),
                a.why ? h("span", { className: "st-alert-w" }, a.why) : null);
            })) : null) : null);
      }

      function listPane() {
        return h("div", { className: "st-listpane" },
          filters(),
          filter === "attn" && cards ? null : bulkBar(),
          filter === "attn" && cards && up !== false && list && list.connected !== false ? decisionPane()
          : up === false ? h("div", { className: "st-empty" }, "Team management is starting. Tasks will appear once it's up.")
            : list == null ? h("div", { className: "st-empty" }, err ? "Couldn't load tasks. Try again in a minute." : "Loading…")
            : list.connected === false ? h("div", { className: "st-empty" }, "Your team isn't linked yet. ",
                h("a", { href: "/orchestration" + (location.search || "") }, "Finish setup on the Orchestration page"), ".")
            : shown.length === 0 ? h("div", { className: "st-empty" }, tasks.length === 0 ? "No tasks yet. Create an agent, or assign one a task, and it'll show here."
                : filter === "team" ? "Nothing is waiting between agents right now." : "Nothing matches this filter.")
            : h("div", { className: "st-list" }, shown.map(row)));
      }

      function msg(m, i) {
        var mine = m.role === "user", who = mine ? "You" : (m.author || "Agent");
        if (isAsk(m)) return h("div", { className: "st-note", key: i },
          h("span", { className: "st-note-dot" }), h("span", { className: "st-note-text" }, (m.author || "The agent") + " asked you for a decision."), m.at ? h("span", { className: "st-msg-at" }, whenStr(m.at)) : null);
        if (isAuto(m)) return h("div", { className: "st-note", key: i },
          h("span", { className: "st-note-dot" }), Md(m.text, "st-note-text"), m.at ? h("span", { className: "st-msg-at" }, whenStr(m.at)) : null);
        return h("div", { className: "st-msg " + (mine ? "me" : "agent"), key: i },
          h("div", { className: "st-ava" + (mine ? " st-ava-me" : "") }, initials(who)),
          h("div", { className: "st-msg-body" },
            h("div", { className: "st-msg-who" }, h("b", null, who), m.at ? h("span", { className: "st-msg-at" }, whenStr(m.at)) : null),
            Md(m.text || "", "st-msg-text")));
      }

      function detailPane() {
        if (!sel) return h("div", { className: "st-detail st-detail-empty" },
          h("div", { className: "st-empty" }, filter === "attn" && cards ? "Open a decision to read the full task." : "Select a task to see the agent's work."));
        var d = detail;
        var cur = tasks.filter(function (t) { return t.key === sel; })[0] || { key: sel };
        var title = cur.title || (d && d.title) || sel, agentName = cur.agentName || (d && d.agentName);
        var status = (d && d.issue_status) || cur.status;
        var msgs = (d && d.messages) ? d.messages : [];
        var dels = (d && d.deliverables) ? d.deliverables : [];
        var mine = (cards || []).filter(function (c) { return c.key && c.key === sel; })[0];
        // The newest thing an agent actually wrote is the headline; the rest is history.
        var latestIdx = -1;
        for (var i = msgs.length - 1; i >= 0; i--) { if (msgs[i].role !== "user" && !isAuto(msgs[i]) && !isAsk(msgs[i]) && (msgs[i].text || "").trim()) { latestIdx = i; break; } }
        var latest = latestIdx >= 0 ? msgs[latestIdx] : null;
        var earlier = msgs.filter(function (_, idx) { return idx !== latestIdx; });
        var desc = (d && d.description) || "", longAsk = desc.length > 700;
        return h("div", { className: "st-detail" },
          h("div", { className: "st-dhead" },
            h("div", { className: "st-dtitle" }, title),
            h("div", { className: "st-dmeta" },
              chip(status, cur.running, mine ? "owner" : cur.waiting_on),
              agentName ? h("span", { className: "st-agent" }, agentName) : null,
              h("span", { className: "st-key" }, sel),
              (cur.updatedAt || (d && d.updatedAt)) ? h("span", { className: "st-time" }, "Updated " + whenStr(cur.updatedAt || d.updatedAt)) : null,
              h("a", { className: "st-link", href: pcTaskUrl(sel), target: "_blank", rel: "noopener" }, "Open on the team board ↗"))),
          dLoad && !d ? h("div", { className: "st-empty" }, "Loading…") : null,
          mine ? h("div", { className: "st-sec" }, h("div", { className: "st-section-h" }, "Your decision"), card(mine, true)) : null,
          latest ? h("div", { className: "st-sec" },
            h("div", { className: "st-section-h" }, "Latest update", h("span", { className: "st-section-r" }, (latest.author || agentName || "Agent") + (latest.at ? " · " + whenStr(latest.at) : ""))),
            h("div", { className: "st-latest" }, Md(latest.text))) : null,
          desc ? h("div", { className: "st-sec" },
            h("div", { className: "st-section-h" }, "The request"),
            h("div", { className: "st-ask" + (longAsk && !askOpen ? " st-ask-clip" : "") }, Md(desc)),
            longAsk ? h("button", { type: "button", className: "st-linkbtn st-ask-more", onClick: function () { setAskOpen(!askOpen); } }, askOpen ? "Show less" : "Show the full request") : null) : null,
          h("div", { className: "st-sec" },
            h("div", { className: "st-section-h" }, latest ? "Earlier activity" : "Activity", earlier.length ? h("span", { className: "st-section-r" }, earlier.length + (earlier.length === 1 ? " entry" : " entries")) : null),
            earlier.length === 0
              ? h("div", { className: "st-empty st-sm" }, dLoad ? "Loading…" : latest ? "Nothing before the latest update." : "No messages yet. The agent may still be working.")
              : h("div", { className: "st-thread" }, earlier.map(msg))),
          d && d.can_reply ? (function () {
            var st = d.issue_status || cur.status, closed = isClosed(st), who = agentName || "the agent";
            return h("form", { className: "st-reply", onSubmit: function (e) { sendReply(e, closed); } },
              h("textarea", { className: "st-reply-in", value: reply, maxLength: 8000, rows: 3,
                placeholder: closed ? "Reply to reopen this task and send " + who + " back to work…" : "Reply to " + who + "…",
                onChange: function (e) { setReply(e.target.value); },
                onKeyDown: function (e) { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) sendReply(e, closed); } }),
              rErr ? h("div", { className: "st-msgbar st-err" }, rErr) : null,
              h("div", { className: "st-reply-row" },
                h("span", { className: "st-reply-hint" }, /^backlog$/i.test(String(st || ""))
                  ? "This task is in the backlog: your reply is saved, but nobody starts on it until it is scheduled."
                  : agentName
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
          (d && d.files && d.files.length) ? h("div", { className: "st-sec" },
            h("div", { className: "st-section-h" }, "Files from this task"),
            h("div", { className: "st-files" }, d.files.map(function (f) {
              return h("div", { className: "st-file", key: f.id },
                h("a", { className: "st-file-n", href: "/api/connectors/files/" + f.id, title: "Download" }, f.name),
                f.summary ? h("span", { className: "st-file-s" }, f.summary) : null);
            }), h("a", { className: "st-file-all", href: "/team-files" + (location.search || "") }, "Read them in Files →"))) : null,
          dels.length ? h("div", { className: "st-sec" },
            h("div", { className: "st-section-h" }, "Files"),
            h("div", { className: "st-dels" }, dels.map(function (w, i) {
              return h("a", { key: i, className: "st-del", href: pcTaskUrl(sel), target: "_blank", rel: "noopener" },
                h("span", { className: "st-del-name" }, w.name),
                w.kind ? h("span", { className: "st-del-kind" }, String(w.kind)) : null);
            }))) : null);
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
        view === "board"
          ? h("div", { className: "st-boardwrap" }, boardPane(), sel ? h("div", { className: "st-bdetail" }, detailPane()) : null)
          : h("div", { className: "st-cols" }, listPane(), detailPane()),
        h("div", { className: "st-foot" }, "Answer decisions, reply, reopen, finish or cancel a task here. The full history and file downloads open on the team board."));
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
