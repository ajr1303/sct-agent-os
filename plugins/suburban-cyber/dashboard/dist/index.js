(function () {
  "use strict";
  var TAG = "[suburban-cyber]";
  var BRAND = "Suburban Cyber";

  // Illustrative content for panels Hermes has no API for (approvals) + static managed-service info.
  // Optional, set per install in .env (OPERATOR_NAME / SUPPORT_CONTACT) and
  // published by sync-branding.sh. Nothing is shown when they are not set.
  var BR = (typeof window !== "undefined" && window.__SCT_BRAND__) || {};
  var OPERATOR = String(BR.operator || "").slice(0, 60);
  var SUPPORT = String(BR.support || "").slice(0, 80);
  var SAMPLE = {
    approvals: [
      { agent: "Front Desk", risk: "medium", title: "Send 3 overdue-invoice reminders",
        detail: "Outbound email to customers always needs your sign-off." },
      { agent: "Books", risk: "high", title: "Delete 214 spam messages older than 90 days",
        detail: "Permanent deletion is always held for review. Nothing is removed until you approve." }
    ],
    managed: { backup: "Backups" }
  };

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
    var api = SDK.api || {};

    function pick(o, keys) { for (var i = 0; i < keys.length; i++) { if (o && o[keys[i]] != null) return o[keys[i]]; } return null; }
    function toList(x) { return Array.isArray(x) ? x : (x && (x.sessions || x.items || x.data || x.profiles)) || []; }
    function fmtNum(n) { n = +n || 0; if (n >= 1e6) return (n / 1e6).toFixed(1) + "M"; if (n >= 1e3) return (n / 1e3).toFixed(1) + "k"; return String(n); }
    function fmtCost(n) { n = +n || 0; return "$" + (n < 100 ? n.toFixed(2) : Math.round(n)); }
    function call(fn, arg) { try { if (typeof api[fn] === "function") return Promise.resolve(api[fn](arg)); } catch (e) {} return null; }
    function timeAgo(t) { try { if (t == null) return ""; return typeof t === "number" ? SDK.utils.timeAgo(t) : SDK.utils.isoTimeAgo(t); } catch (e) { return ""; } }

    function Stat(label, value, note, accent) {
      return h("div", { className: "sc-stat" },
        h("div", { className: "sc-stat-label" }, label),
        h("div", { className: "sc-stat-val" + (accent ? " sc-accent" : "") }, value),
        h("div", { className: "sc-stat-note" }, note));
    }
    // Tokens and estimated spend per provider, from Hermes's own 14-day record on this server.
    function provFam(slug) {
      var s = String(slug || "").trim().toLowerCase(), F = ["minimax", "openai", "anthropic", "meta", "kimi", "alibaba", "tencent", "copilot", "xai"];
      for (var i = 0; i < F.length; i++) if (s === F[i] || s.indexOf(F[i] + "-") === 0) return F[i];
      return s;
    }
    function provStats(res) {
      var out = {}, rows = (res && res.models) || [];
      for (var i = 0; i < rows.length; i++) {
        var r = rows[i], k = provFam(r.provider); if (!k) continue;
        var o = out[k] || (out[k] = { tokens: 0, cost: 0, calls: 0 });
        o.tokens += (+r.input_tokens || 0) + (+r.output_tokens || 0);
        o.cost += (+r.estimated_cost || 0); o.calls += (+r.api_calls || 0);
      }
      return out;
    }
    function provLabel(k) {
      var L = { minimax: "MiniMax", anthropic: "Anthropic", openai: "OpenAI", openrouter: "OpenRouter", meta: "Meta", gemini: "Google Gemini", google: "Google Gemini", xai: "xAI", deepseek: "DeepSeek", nous: "Nous Portal" };
      return L[k] || (k.charAt(0).toUpperCase() + k.slice(1)).replace(/-/g, " ");
    }

    function Panel(title, right, children) {
      return h("div", { className: "sc-panel" },
        h("div", { className: "sc-panel-h" },
          h("span", { className: "sc-panel-t" }, title),
          right ? h("span", { className: "sc-panel-r" }, right) : null),
        h("div", { className: "sc-panel-b" }, children));
    }

    // "Today so far": a short written summary, four numbers, heavy runs and the owner's day.
    // The sentences come from the server, built from real counts (no AI model involved).
    function SummaryCard() {
      var a = useState("today"), range = a[0], setRange = a[1];
      var b = useState(null), data = b[0], setData = b[1];
      var c = useState(false), busy = c[0], setBusy = c[1];
      var d = useState(false), all = d[0], setAll = d[1];
      function load(r) {
        var m = new Date(); m.setHours(0, 0, 0, 0);
        var since = m.getTime() - (r === "yesterday" ? 86400000 : r === "week" ? 6 * 86400000 : 0);
        var until = m.getTime() + 86400000;
        setBusy(true);
        try {
          fetch("/api/connectors/orchestration/summary?label=" + r + "&since=" + Math.floor(since / 1000) + "&until=" + Math.floor(until / 1000),
            { credentials: "same-origin" })
            .then(function (x) { return x.ok ? x.json() : null; })
            .then(function (v) { if (v) setData(v); setBusy(false); }).catch(function () { setBusy(false); });
        } catch (e) { setBusy(false); }
      }
      useEffect(function () {
        load(range);
        var t = setInterval(function () { load(range); }, 120000);
        return function () { clearInterval(t); };
      }, [range]);
      function clock(iso) { try { return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); } catch (e) { return ""; } }
      function money(n) { return "$" + Number(n).toFixed(2); }
      function big(n) { n = Number(n) || 0; return n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? Math.round(n / 1e3) + "K" : String(n); }
      function span(mn) { mn = Number(mn) || 0; return mn >= 90 ? (mn / 60).toFixed(1) + " hr" : mn + " min"; }
      var q = location.search || "";
      var titles = { today: "Today so far", yesterday: "Since yesterday", week: "This week" };
      var tabs = h("span", { className: "sc-sum-tabs" }, ["today", "yesterday", "week"].map(function (r) {
        return h("button", { key: r, className: "sc-sum-tab" + (r === range ? " on" : ""), onClick: function () { setAll(false); setRange(r); } },
          r === "today" ? "Today" : r === "yesterday" ? "Since yesterday" : "This week");
      }));
      var body;
      if (!data) body = h("div", { className: "sc-empty" }, "Loading…");
      else {
        var n = data.numbers || {}, heavy = data.heavy || [], day = data.day || [];
        var tiles = data.ok && !data.quiet ? h("div", { className: "sc-sum-nums" },
          h("div", { className: "sc-sum-num" }, h("span", null, "Finished"), h("b", null, String(n.finished == null ? "0" : n.finished))),
          h("div", { className: "sc-sum-num" }, h("span", null, "In progress"), h("b", null, String(n.in_progress || 0))),
          h("a", { className: "sc-sum-num" + (n.need_you ? " warn" : ""), href: "/tasks" + q }, h("span", null, "Need you"), h("b", null, String(n.need_you || 0))),
          n.spent != null
            ? h("div", { className: "sc-sum-num" }, h("span", null, "Spent"), h("b", null, money(n.spent)))
            : h("div", { className: "sc-sum-num" }, h("span", null, "AI usage"), h("b", null, big(n.tokens) + " tokens"))) : null;
        body = h("div", null,
          h("p", { className: "sc-sum-text" }, data.text || ""),
          tiles,
          heavy.length ? h("div", { className: "sc-sum-sec" },
            h("div", { className: "sc-sum-h" }, "Heavy runs"),
            heavy.map(function (x, i) {
              var right = [span(x.minutes) + (x.running ? " so far" : "")];
              if (x.cost != null) right.push(money(x.cost)); else if (x.tokens) right.push(big(x.tokens) + " tokens");
              return h("div", { className: "sc-sum-row", key: i },
                h("span", { className: "sc-sum-l" }, h("i", { className: "sc-sum-dot hot" }), x.agent + (x.task ? ", " + x.task : "")),
                h("span", { className: "sc-sum-r" }, right.join(", ")));
            }),
            data.heavy_more ? h("a", { className: "sc-link sc-sum-more", href: "/usage" + q }, "and " + data.heavy_more + " more in Usage →") : null) : null,
          day.length ? h("div", { className: "sc-sum-sec" },
            h("div", { className: "sc-sum-h" }, "Your day"),
            (all ? day : day.slice(0, 4)).map(function (x, i) {
              var txt = x.kind === "event" ? clock(x.at) + " " + x.text : x.text;
              var inner = [h("i", { key: "d", className: "sc-sum-dot " + (x.kind === "alert" ? "bad" : x.kind === "warn" ? "hot" : "ok") }), txt];
              return x.href ? h("a", { className: "sc-sum-row sc-sum-a", key: i, href: x.href + q }, h("span", { className: "sc-sum-l" }, inner))
                            : h("div", { className: "sc-sum-row", key: i }, h("span", { className: "sc-sum-l" }, inner));
            }),
            data.day_more ? h("div", { className: "sc-sum-more sc-muted" }, "and " + data.day_more + " more") : null) : null);
      }
      return h("div", { className: "sc-panel sc-sum" },
        h("div", { className: "sc-panel-h" },
          h("span", { className: "sc-panel-t" }, titles[range]),
          h("span", { className: "sc-sum-meta" }, tabs,
            h("button", { className: "sc-sum-ref", title: "Refresh", disabled: busy, onClick: function () { load(range); } },
              data && data.at ? "Updated " + clock(data.at) + " ↻" : "↻"))),
        h("div", { className: "sc-panel-b" }, body));
    }

    // "Today's idea": one suggestion a day from the lead agent, with three buttons.
    function IdeaCard() {
      var a = useState(null), d = a[0], setD = a[1];
      var b = useState(""), msg = b[0], setMsg = b[1];
      var c = useState(false), busy = c[0], setBusy = c[1];
      var e = useState(""), ans = e[0], setAns = e[1];
      function get() {
        try {
          fetch("/api/connectors/orchestration/idea?tz=" + new Date().getTimezoneOffset(), { credentials: "same-origin" })
            .then(function (x) { return x.ok ? x.json() : null; }).then(function (v) { if (v) setD(v); }).catch(function () {});
        } catch (err) {}
      }
      function post(path, body) {
        setBusy(true); setMsg("");
        fetch("/api/connectors/orchestration/idea/" + path, { method: "POST", credentials: "same-origin",
          headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) })
          .then(function (x) { return x.json().then(function (v) { return { ok: x.ok, v: v }; }); })
          .then(function (r) {
            setBusy(false);
            if (!r.ok) { setMsg((r.v && r.v.detail) || "That did not work. Try again."); return; }
            setD(r.v); setMsg(r.v.message || "");
          }).catch(function () { setBusy(false); setMsg("That did not work. Try again."); });
      }
      useEffect(function () { get(); var t = setInterval(get, 20000); return function () { clearInterval(t); }; }, []);
      var q = location.search || "", body, idea = d && d.idea;
      function act(action, extra) { post("act", Object.assign({ id: idea.id, action: action }, extra || {})); }
      var again = d && d.can_request
        ? h("button", { className: "sc-idea-b", disabled: busy, onClick: function () { post("request"); } }, "Get another idea") : null;
      if (!d) body = h("div", { className: "sc-empty" }, "Loading…");
      else if (d.state === "off") body = h("div", { className: "sc-idea-line" }, "Daily ideas are switched off. ",
        h("button", { className: "sc-idea-b", disabled: busy, onClick: function () { post("settings", { enabled: true }); } }, "Switch on"));
      else if (d.state === "none") body = h("div", { className: "sc-idea-line" },
        "Each morning your lead agent suggests one thing worth doing, based on your business and what the team has been working on. ",
        h("button", { className: "sc-idea-go", disabled: busy, onClick: function () { post("request"); } }, busy ? "Asking…" : "Get today's idea"));
      else if (d.state === "working") body = h("div", { className: "sc-idea-line" }, h("i", { className: "sc-idea-spin" }),
        "Your lead agent is writing today's idea. This usually takes a few minutes.");
      else if (d.state === "failed") body = h("div", { className: "sc-idea-line" }, "Today's idea did not arrive. ", again);
      else if (d.state === "empty") body = h("div", { className: "sc-idea-line" },
        "Nothing worth suggesting today. Your lead agent would sooner say so than make something up. ", again);
      else if (d.state === "ready") body = h("div", null,
        h("div", { className: "sc-idea-t" }, idea.title),
        h("p", { className: "sc-idea-why" }, idea.why),
        h("p", { className: "sc-idea-plan" }, h("b", null, "If you say yes: "), idea.plan),
        h("div", { className: "sc-idea-btns" },
          h("button", { className: "sc-idea-go", disabled: busy, onClick: function () { act("do"); } }, "Do it"),
          h("button", { className: "sc-idea-b", disabled: busy, onClick: function () { act("later"); } }, "Not today"),
          h("button", { className: "sc-idea-b", disabled: busy, title: "Stops this kind of idea (" + (idea.kind_label || "") + ")",
            onClick: function () { act("never"); } }, "Not for me")),
        idea.question ? h("div", { className: "sc-idea-q" },
          h("div", { className: "sc-idea-ql" }, "One question, to make future ideas better: ", h("b", null, idea.question)),
          h("div", { className: "sc-idea-qr" },
            h("input", { className: "sc-idea-in", value: ans, maxLength: 400, placeholder: "Your answer",
              onChange: function (ev) { setAns(ev.target.value); } }),
            h("button", { className: "sc-idea-b", disabled: busy || ans.trim().length < 2,
              onClick: function () { act("answer", { answer: ans }); setAns(""); } }, "Save"))) : null);
      else body = h("div", null,
        h("div", { className: "sc-idea-t sc-idea-done" }, idea.title || "Today's idea"),
        h("div", { className: "sc-idea-line" },
          idea.status === "done" ? h("span", null, "The team is on it. ", h("a", { className: "sc-link", href: "/tasks" + q }, "See task " + (idea.task_key || "") + " →"), " ")
            : idea.status === "later" ? "Skipped for today. " : "You turned this kind of idea off. ", again));
      return h("div", { className: "sc-panel sc-idea" },
        h("div", { className: "sc-panel-h" },
          h("span", { className: "sc-panel-t" }, "Today's idea",
            d && d.state === "ready" && idea.kind_label ? h("span", { className: "sc-idea-tag" }, idea.kind_label) : null),
          d && d.state !== "off" ? h("button", { className: "sc-sum-ref", onClick: function () { post("settings", { enabled: false }); } }, "Turn off") : null),
        h("div", { className: "sc-panel-b" }, body, msg ? h("div", { className: "sc-idea-msg" }, msg) : null));
    }

    function Overview() {
      var sa = useState(null), status = sa[0], setStatus = sa[1];
      var sb = useState(null), sessions = sb[0], setSessions = sb[1];
      var sc = useState(null), analytics = sc[0], setAnalytics = sc[1];
      var sd = useState(null), agents = sd[0], setAgents = sd[1];
      var se = useState(null), pcOv = se[0], setPcOv = se[1];
      var su = useState(null), planUse = su[0], setPlanUse = su[1];
      var su2 = useState(null), byProv = su2[0], setByProv = su2[1];   // provider family -> {tokens, cost, calls}, 14 days
      var sk = useState(null), bk = sk[0], setBk = sk[1];
      var sz = useState(""), bizName = sz[0], setBizName = sz[1];
      var sa = useState(null), autos = sa[0], setAutos = sa[1];      // {count, active} once Automations is connected
      var sw = useState(null), watch = sw[0], setWatch = sw[1];
      var sk2 = useState(null), bookWeek = sk2[0], setBookWeek = sk2[1];   // appointment start times, next 7 days
      var sg = useState(null), site = sg[0], setSite = sg[1];              // website visitors (Google Analytics)
      var sg = useState(null), upd = sg[0], setUpd = sg[1];
      var sh = useState(0), updBump = sh[0], setUpdBump = sh[1];
      var ck = useState(""), chk = ck[0], setChk = ck[1];
      var sj = useState(null), updRun = sj[0], setUpdRun = sj[1];      // {pending, waiting_seconds, state} from the server
      var sj2 = useState(""), updMsg = sj2[0], setUpdMsg = sj2[1];
      var sj3 = useState(false), updBusy = sj3[0], setUpdBusy = sj3[1];

      useEffect(function () {
        function load() {
          var p1 = call("getStatus"); if (p1) p1.then(setStatus).catch(function () {});
          var p2 = call("getSessions"); if (p2) p2.then(function (v) { setSessions(toList(v)); }).catch(function () {});
          var p3 = call("getAnalytics", 14); if (p3) p3.then(setAnalytics).catch(function () {});
          var p3b = call("getModelsAnalytics", 14); if (p3b) p3b.then(function (v) { setByProv(provStats(v)); }).catch(function () {});
          var p4 = call("getProfiles"); if (p4) p4.then(function (v) { setAgents(toList(v)); }).catch(function () {});
          try {
            fetch("/api/connectors/usage", { credentials: "same-origin" }).then(function (r) { return r.ok ? r.json() : null; })
              .then(function (v) { if (v) setPlanUse(v); }).catch(function () {});
            fetch("/api/connectors/bookings/week", { credentials: "same-origin" }).then(function (r) { return r.ok ? r.json() : null; })
              .then(function (v) { if (v && v.account_count > 0) setBookWeek(v); }).catch(function () {});
            fetch("/api/connectors/website", { credentials: "same-origin" }).then(function (r) { return r.ok ? r.json() : null; })
              .then(function (v) { if (v && v.connected && v.stats) setSite(v.stats); }).catch(function () {});
            fetch("/api/connectors/automations/workflows", { credentials: "same-origin" }).then(function (r) { return r.ok ? r.json() : null; })
              .then(function (v) { if (v && typeof v.active === "number") setAutos(v); }).catch(function () {});
            fetch("/api/connectors/automations/stuck-watch", { credentials: "same-origin" }).then(function (r) { return r.ok ? r.json() : null; })
              .then(function (v) { if (v) setWatch(v); }).catch(function () {});
            fetch("/api/connectors/orchestration/business", { credentials: "same-origin" }).then(function (r) { return r.ok ? r.json() : null; })
              .then(function (v) { if (v && v.name) setBizName(String(v.name)); }).catch(function () {});
            fetch("/api/connectors/backups", { credentials: "same-origin" }).then(function (r) { return r.ok ? r.json() : null; })
              .then(function (v) { if (v) setBk(v); }).catch(function () {});
            fetch("/api/connectors/orchestration/overview", { credentials: "same-origin" })
              .then(function (r) { return r.ok ? r.json() : null; })
              .then(function (v) { if (v) setPcOv(v); }).catch(function () {});
          } catch (e) {}
          try {
            fetch("/sct-brand/update-status.json", { cache: "no-store" })
              .then(function (r) { return r.ok ? r.json() : null; })
              .then(function (v) { if (v) setUpd(v); }).catch(function () {});
          } catch (e) {}
        }
        load();
        var t = setInterval(load, 20000);
        return function () { clearInterval(t); };
      }, []);

      // Everything below is wrapped so an unexpected data shape can never blank
      // the whole page — on a throw we show a retry state, and the 20s poll recovers.
      try {
      var up = status ? status.gateway_running : null;
      var activeSessions = status ? pick(status, ["active_sessions"]) : null;
      var activeAgents = status ? pick(status, ["active_agents"]) : null;
      var version = status ? pick(status, ["version"]) : null;
      var tot = (analytics && analytics.totals) || {};
      var tokens = (+tot.total_input || 0) + (+tot.total_output || 0);
      var recent = (sessions || []).slice(0, 5);
      var today = new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });

      var ATT_KINDS = [["approval", "Approvals"], ["decision", "Decisions"], ["review", "Reviews"], ["failed_run", "Failed runs"], ["budget_alert", "Budget alerts"], ["agent_error_alert", "Agent errors"], ["blocker_attention", "Blockers"], ["join_request", "Join requests"], ["recovery_action", "Recovery actions"], ["productivity_review", "Productivity reviews"], ["issue_thread_interaction", "Messages"]];
      function orchHref() { return "/orchestration" + (location.search || ""); }
      // What the last backup actually did, not what is scheduled.
      function backupLine(b) {
        var st = b && b.status;
        if (!b) return "—";
        if (!st) return "None yet";
        var hrs = (Date.now() - new Date(st.at).getTime()) / 3600000;
        if (!st.ok) return "Last one failed";
        if (hrs > 36) return Math.round(hrs / 24) + " days old";
        var age = hrs < 1.5 ? "under an hour ago" : Math.round(hrs) + " h ago";
        return (st.uploaded ? "Off-site copy · " : "This server only · ") + age;
      }
      function waitingBody() {
        if (pcOv == null) return h("div", { className: "sc-empty" }, "Checking the control plane…");
        if (!pcOv.paperclip_up) return h("div", { className: "sc-empty" }, h("span", null, "Control plane is off. ", h("a", { href: orchHref(), className: "sc-link" }, "Set it up in Orchestration →")));
        var att = pcOv.attention, own = pcOv.owner;
        // Decisions for the owner, separated from alerts and from work the team is sorting out.
        if (own) {
          var tasksHref = "/tasks" + (location.search || "");
          return h("div", null,
            h("div", { className: "sc-wait-total" }, own.decisions === 0 ? "Nothing needs you right now" : own.decisions + " decision" + (own.decisions === 1 ? "" : "s") + " waiting for you"),
            h("div", { className: "sc-wait-rows" },
              own.with_lead ? h("div", { className: "sc-wait-row" }, h("span", { className: "sc-wait-n" }, own.with_lead), h("span", null, "With " + (own.lead || "your lead agent") + " to sort out first")) : null,
              own.alerts ? h("div", { className: "sc-wait-row" }, h("span", { className: "sc-wait-n" }, own.alerts), h("span", null, "Alerts (failed runs, agent errors)")) : null),
            h("a", { href: tasksHref, className: "sc-link sc-wait-cta" }, own.decisions ? "Answer them in Tasks →" : "Open Tasks →"));
        }
        if (!att) return h("div", { className: "sc-empty" }, h("span", null, "Connect Paperclip in ", h("a", { href: orchHref(), className: "sc-link" }, "Orchestration →"), " to see approvals here."));
        var total = att.totalCount || 0;
        if (total === 0) return h("div", { className: "sc-empty" }, "Nothing waiting. Agents ask here before they send, publish, or delete.");
        var counts = att.countsBySourceKind || {};
        var rows = ATT_KINDS.filter(function (k) { return (counts[k[0]] || 0) > 0; }).map(function (k) {
          return h("div", { className: "sc-wait-row", key: k[0] },
            h("span", { className: "sc-wait-n" }, counts[k[0]]),
            h("span", null, k[1]));
        });
        return h("div", null,
          h("div", { className: "sc-wait-total" }, total + " item" + (total === 1 ? "" : "s") + " need your attention"),
          h("div", { className: "sc-wait-rows" }, rows),
          h("a", { href: orchHref(), className: "sc-link sc-wait-cta" }, "Review in Orchestration →"));
      }

      // Unified agent view: prefer the Paperclip-managed roster (with roles),
      // enriched with the model from the matching Hermes profile; fall back to
      // Hermes profiles when the control plane isn't connected.
      var useManaged = !!(pcOv && pcOv.paperclip_up && pcOv.company_id && Array.isArray(pcOv.agents));
      var managedAgents = useManaged ? pcOv.agents : null;
      function slug(x) { return String(x || "").toLowerCase().replace(/\s+/g, "-"); }
      function hermesModelFor(nm) {
        var list = agents || [], n = slug(nm);
        for (var i = 0; i < list.length; i++) { if (slug(pick(list[i], ["name", "display_name"])) === n) return pick(list[i], ["model"]); }
        return null;
      }
      var work = useManaged && pcOv.work ? pcOv.work : null;
      // Appointments: "today" is the viewer's own calendar day.
      function bookTile() {
        if (!bookWeek) return null;
        var now = new Date(), today = 0, starts = bookWeek.starts || [];
        for (var i = 0; i < starts.length; i++) {
          var d = new Date(starts[i]);
          if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()) today++;
        }
        var note = starts.length + " in the next 7 days" + (bookWeek.failed ? " · one calendar could not be read" : "");
        return Stat("Appointments today", String(today), note, today > 0);
      }
      function siteTile() {
        if (!site) return null;
        var c = site.visitors_change;
        var note = c == null ? "No earlier week to compare with" : c === 0 ? "Same as the week before" : (c > 0 ? "Up " : "Down ") + Math.abs(c) + "% on the week before";
        return Stat("Website visitors, 7 days", fmtNum(site.visitors || 0), note);
      }
      // One tile for every AI provider that has a key, an agent on it, or use in the last 14 days.
      function llmTiles() {
        var ps = ((planUse && planUse.providers) || []).slice(), st = byProv || {}, seen = {}, k;
        for (var i = 0; i < ps.length; i++) seen[ps[i].id] = 1;
        var extra = []; for (k in st) if (!seen[k] && st[k].tokens > 0) extra.push({ id: k, label: provLabel(k), agents: [] });
        extra.sort(function (a, b) { return st[b.id].tokens - st[a.id].tokens; });
        ps = ps.concat(extra).slice(0, 10);
        return ps.map(function (p) {
          var u = p.usage, w = u && u.ok && u.groups && u.groups[0] && u.groups[0].weekly;
          if (w) {
            var hrs = Math.round((w.resets_in_seconds || 0) / 3600);
            var note = w.on_pace_to_run_out ? "On pace to run out before it resets" : ("Resets in " + (hrs >= 48 ? Math.round(hrs / 24) + " days" : hrs + " h"));
            return h("div", { key: p.id, style: { display: "contents" } }, Stat(p.label + " plan, this week", w.remaining_percent + "% left", note, w.on_pace_to_run_out || w.remaining_percent <= 25));
          }
          var ag = p.agents || [], n = ag.length, away = ag.filter(function (a) { return !a.local; }).length;
          var who = n ? n + (n === 1 ? " agent" : " agents") : "", s14 = st[p.id], tile;
          if (s14 && s14.tokens > 0) {
            var paid = s14.cost >= 0.005;
            tile = Stat(p.label + ", 14 days", paid ? fmtCost(s14.cost) : fmtNum(s14.tokens),
              (paid ? fmtNum(s14.tokens) + " tokens" : "Tokens") + " on this server" + (who ? " · " + who : ""));
          } else if (n) {
            tile = Stat(p.label, who, away === n ? "On their own machines · use isn't counted here" : "No use on this server in 14 days");
          } else {
            tile = Stat(p.label, "Ready", "Key added · no agent uses it yet");
          }
          return h("div", { key: p.id, style: { display: "contents" } }, tile);
        });
      }
      var agentTileLabel = useManaged ? "Agents" : "Active agents";
      var agentTileVal = useManaged ? String(managedAgents.length) : (status ? String(activeAgents != null ? activeAgents : 0) : "—");
      var agentTileSub = useManaged ? "Managed by Paperclip" : "Running right now";

      function updDismissed(ver) { try { return localStorage.getItem("sc-upd-dismissed") === ver; } catch (e) { return false; } }
      function dismissUpd(ver) { try { localStorage.setItem("sc-upd-dismissed", ver); } catch (e) {} setUpdBump(updBump + 1); }
      function updWatching(v) {
        try {
          if (v === undefined) return sessionStorage.getItem("sc-upd-watching") === "1";
          if (v) sessionStorage.setItem("sc-upd-watching", "1"); else sessionStorage.removeItem("sc-upd-watching");
        } catch (e) {}
        return !!v;
      }
      function updPoll() {
        return fetch("/api/connectors/system/update", { credentials: "same-origin", cache: "no-store" })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (v) {
            if (!v) return;                       // the dashboard restarts during an update: keep waiting
            setUpdRun(v);
            var st = v.state && v.state.state;
            if (updWatching() && !v.pending && st === "done") {
              updWatching(false);
              setUpdMsg("Updated" + (v.state.to ? " to v" + v.state.to : "") + ". Reloading…");
              setTimeout(function () { window.location.reload(); }, 2500);
            } else if (updWatching() && !v.pending && st === "failed") {
              updWatching(false);
            }
          }).catch(function () {});
      }
      useEffect(function () {
        updPoll();
        var t = setInterval(function () {
          if (updWatching() || (updRun && (updRun.pending || (updRun.state && updRun.state.state === "running")))) updPoll();
        }, 8000);
        return function () { clearInterval(t); };
      }, [updRun && updRun.pending, updRun && updRun.state && updRun.state.state]);
      function startUpd() {
        if (!window.confirm("Update now?\n\nA backup is taken first. The dashboard then restarts and can be unavailable for a few minutes. Agents that are working are interrupted and pick their tasks up again afterwards.")) return;
        setUpdBusy(true); setUpdMsg("");
        fetch("/api/connectors/system/update", { method: "POST", credentials: "same-origin" })
          .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, j: j }; }); })
          .then(function (x) {
            setUpdBusy(false);
            if (!x.ok) { setUpdMsg((x.j && x.j.detail) || "The update could not be started. Try again in a minute."); return; }
            updWatching(true); updPoll();
          }).catch(function () { setUpdBusy(false); setUpdMsg("The update could not be started. Try again in a minute."); });
      }
      // "Check for updates": the server looks once an hour by itself. This asks it to
      // look now, then waits for its answer (its jobs run once a minute).
      function checkUpd() {
        var before = upd && upd.checked_at, tries = 0;
        setChk("Checking…");
        try { localStorage.removeItem("sc-upd-dismissed"); } catch (e) {}
        fetch("/api/connectors/system/update/check", { method: "POST", credentials: "same-origin" })
          .then(function (r) { if (!r.ok) throw new Error(); })
          .then(function wait() {
            setTimeout(function () {
              fetch("/sct-brand/update-status.json", { cache: "no-store" })
                .then(function (r) { return r.ok ? r.json() : null; })
                .then(function (v) {
                  if (v && v.checked_at && v.checked_at !== before) {
                    setUpd(v); setUpdBump(function (n) { return n + 1; });
                    setChk(v.update_available ? "" : "You are up to date (v" + (v.current || "?") + ").");
                    return;
                  }
                  if (++tries < 18) return wait();
                  setChk("The server did not answer. Try again in a few minutes.");
                }).catch(function () { if (++tries < 18) wait(); else setChk("Could not check. Try again in a few minutes."); });
            }, 5000);
          }).catch(function () { setChk("Could not check. Try again in a few minutes."); });
      }
      function updBanner() {
        var st = updRun && updRun.state ? updRun.state : null;
        var pending = !!(updRun && updRun.pending), running = !!(st && st.state === "running");
        if (updMsg && updMsg.indexOf("Updated") === 0)
          return h("div", { className: "sc-updbar" }, h("div", { className: "sc-updbar-l" }, h("span", { className: "sc-updbar-dot" }), h("span", null, h("b", null, updMsg))));
        if (pending || running) {
          var slow = pending && (updRun.waiting_seconds || 0) > 180;
          return h("div", { className: "sc-updbar" },
            h("div", { className: "sc-updbar-l" },
              h("span", { className: "sc-updbar-dot sc-updbar-pulse" }),
              h("span", null, h("b", null, running ? "Updating" + (upd && upd.latest ? " to v" + upd.latest : "") + "…" : "Starting the update…"), " ",
                slow ? "The server has not picked this up yet. If this does not change in a few minutes, its scheduled jobs are not running: ask whoever looks after the server to run the update by hand."
                  : running ? "A backup is taken first, then the dashboard restarts. It can be unavailable for a few minutes. This page reloads by itself when the update is done."
                  : "This begins within a minute. You can keep working until the dashboard restarts.")));
        }
        if (!upd || !upd.update_available || updDismissed(upd.latest)) return null;
        var failed = !!(st && st.state === "failed");
        return h("div", { className: "sc-updbar" },
          h("div", { className: "sc-updbar-l" },
            h("span", { className: "sc-updbar-dot" }),
            h("span", null, h("b", null, "Update available"), " — v" + (upd.current || "?") + " → v" + (upd.latest || "?") + ". ",
              updMsg ? updMsg
                : failed ? "The last update did not finish. Everything that was running is still running. Try again, or ask whoever looks after the server to check it."
                : "Takes a few minutes. A backup is taken first.")),
          h("div", { className: "sc-updbar-r" },
            upd.notes_url ? h("a", { className: "sc-link", href: upd.notes_url, target: "_blank", rel: "noopener" }, "What's changed") : null,
            h("button", { className: "sc-updbar-x", onClick: function () { dismissUpd(upd.latest); } }, "Later"),
            h("button", { className: "sc-updbar-go", disabled: updBusy, onClick: startUpd }, updBusy ? "Starting…" : "Update now")));
      }

      return h("div", { className: "sc-wrap" },
        updBanner(),
        h("div", { className: "sc-top" },
          h("div", null,
            h("div", { className: "sc-date" }, today),
            h("div", { className: "sc-h1" }, (bizName ? "Today at " + bizName : "Today"))),
          h("div", { className: "sc-topr" },
            h("div", { className: "sc-chip" }, up == null ? "connecting…" :
              h("span", null, h("span", { className: "sc-dot " + (up ? "sc-ok" : "sc-bad") }), up ? "Gateway running" : "Gateway down")),
            chk && chk !== "Checking…" ? h("span", { className: "sc-chk" }, chk)
              : h("button", { type: "button", className: "sc-chk sc-chk-btn", disabled: chk === "Checking…", onClick: checkUpd }, chk || "Check for updates"))),

        h("div", { className: "sc-stats" },
          Stat(agentTileLabel, agentTileVal, agentTileSub, true),
          work ? Stat("Agent runs, " + (work.days || 14) + " days", fmtNum(work.runs || 0),
            (work.succeeded || 0) + " succeeded · " + (work.failed || 0) + " failed · " + (work.runs_today || 0) + " today") : null,
          work ? Stat("Tasks in progress", String(work.tasks_in_progress != null ? work.tasks_in_progress : "—"),
            (work.tasks_open != null ? work.tasks_open : "—") + " open in total") : null,
          autos ? Stat("Active automations", String(autos.active),
            autos.count + " workflow" + (autos.count === 1 ? "" : "s") + " in total" + (watch && watch.active ? " · stuck-agent watch on" : ""), autos.active > 0) : null,
          bookTile(),
          siteTile(),
          Stat("Chat sessions, 14 days", analytics ? String(tot.total_sessions || 0) : "—", useManaged ? "On this server only" : "Conversations and automations"),
          Stat("Tokens, 14 days", analytics ? fmtNum(tokens) : "—", useManaged ? "This server only · input + output" : "Input + output"),
          Stat("AI spend, 14 days", analytics ? fmtCost(tot.total_estimated_cost) : "—", useManaged ? "This server only · estimated" : "Estimated from usage")),

        (function () {
          var tiles = llmTiles();
          return tiles.length ? h("div", { className: "sc-llm" },
            h("div", { className: "sc-llm-h" }, h("span", null, "Your AI providers"),
              h("a", { className: "sc-link", href: "/usage" + (location.search || "") }, "Details in Usage →")),
            h("div", { className: "sc-stats" }, tiles)) : null;
        })(),

        h("div", { className: "sc-cols sc-cols-sum" },
          h("div", { className: "sc-col" }, h(SummaryCard, null), h(IdeaCard, null)),
          h("div", { className: "sc-col" },
            Panel("Waiting on you", "Only decisions. The team handles the rest.", waitingBody()),
            useManaged
              ? Panel("Your agents", managedAgents.length + " managed",
                  managedAgents.length === 0
                    ? h("div", { className: "sc-empty" }, h("span", null, "No managed agents yet. ", h("a", { href: orchHref(), className: "sc-link" }, "Create one in Orchestration →")))
                    : managedAgents.map(function (a, i) {
                        var model = hermesModelFor(a.name);
                        return h("div", { className: "sc-agentrow", key: a.id || i },
                          h("div", null,
                            h("div", { className: "sc-agentname" }, a.name),
                            h("div", { className: "sc-agentdesc" }, (a.role ? String(a.role).toUpperCase() : "AGENT") + (a.status ? " · " + a.status : ""))),
                          h("div", { className: "sc-agentmeta" },
                            model ? h("span", { className: "sc-tag" }, model) : null));
                      }))
              : Panel("Your agents", agents == null ? "" : agents.length + " configured",
                  agents == null
                    ? h("div", { className: "sc-empty" }, "Loading…")
                    : agents.length === 0
                      ? h("div", { className: "sc-empty" }, "No agents yet. Create one in the Agents tab.")
                      : agents.map(function (ag, i) {
                          var name = pick(ag, ["display_name", "name", "bot_title"]) || "Agent";
                          var desc = pick(ag, ["description", "description_auto"]) || "Agent profile";
                          var model = pick(ag, ["model"]);
                          return h("div", { className: "sc-agentrow", key: i },
                            h("div", null,
                              h("div", { className: "sc-agentname" }, name),
                              h("div", { className: "sc-agentdesc" }, String(desc).slice(0, 80))),
                            h("div", { className: "sc-agentmeta" },
                              model ? h("span", { className: "sc-tag" }, model) : null,
                              h("span", { className: "sc-skill" }, (ag.skill_count != null ? ag.skill_count : 0) + " skills")));
                        }))
          )
        ),
        h("div", { className: "sc-cols sc-cols-low" },
          h("div", { className: "sc-col" },
            Panel("Activity log", "Live from your gateway",
              recent.length === 0
                ? h("div", { className: "sc-empty" }, sessions == null ? "Loading…" : "No recent sessions yet.")
                : recent.map(function (s, i) {
                    var title = pick(s, ["title", "preview", "name", "id"]) || "Session";
                    return h("div", { className: "sc-log", key: i },
                      h("span", { className: "sc-log-t" }, timeAgo(pick(s, ["last_active", "updated_at", "created_at", "started_at"])) || "recent"),
                      h("span", null, String(title).slice(0, 60)));
                  }))),
          h("div", { className: "sc-col" },
            h("div", { className: "sc-managed" },
              h("div", { className: "sc-managed-h" }, OPERATOR ? "MANAGED BY " + OPERATOR.toUpperCase() : "YOUR SYSTEM"),
              SUPPORT ? h("div", { className: "sc-managed-row" }, h("span", { className: "sc-muted" }, "Support"), h("span", null, SUPPORT)) : null,
              h("div", { className: "sc-managed-row" }, h("span", { className: "sc-muted" }, "Active sessions"), h("span", null, activeSessions == null ? "—" : String(activeSessions))),
              h("div", { className: "sc-managed-row" }, h("span", { className: "sc-muted" }, "Hermes version"), h("span", null, version || "—")),
              h("div", { className: "sc-managed-row" }, h("span", { className: "sc-muted" }, SAMPLE.managed.backup),
                h("a", { href: "/backups" + (location.search || ""), className: "sc-link" }, backupLine(bk))))
          )
        ),
        h("div", { className: "sc-foot" }, "Suburban Cyber Agent OS · built on Hermes Agent (Nous Research)")
      );
      } catch (e) {
        try { console.error(TAG, "Overview render failed", e); } catch (e2) {}
        return h("div", { className: "sc-wrap" },
          h("div", { className: "sc-top" },
            h("div", null,
              h("div", { className: "sc-h1" }, (bizName ? "Today at " + bizName : "Today")))),
          h("div", { className: "sc-empty" },
            "Something hiccupped loading your dashboard. It will retry automatically — or refresh the page."));
      }
    }

    try { PLUGINS.register("suburban-cyber", Overview); console.info(TAG, "registered, sdk=" + (SDK.sdkVersion || "?")); }
    catch (e) { try { console.error(TAG, "register failed", e); } catch (e2) {} }

    // ---- Branding, nav injection, relabels ----
    function norm(x) { return (x || "").replace(/\s+/g, " ").trim().toLowerCase(); }
    var NAV_LABELS = { chat:1, sessions:1, files:1, models:1, logs:1, cron:1, skills:1, plugins:1, config:1 };

    function rebrand() {
      try {
        if (!/suburban/i.test(document.title)) document.title = BRAND + " Agent OS";
        var all = document.querySelectorAll("a,div,span,h1,h2,p");
        for (var i = 0; i < all.length; i++) {
          var el = all[i];
          if (el.querySelector && el.querySelector(".sc-brand-logo")) continue;
          if (el.childElementCount > 3) continue;
          var t = norm(el.textContent);
          if (t !== "hermes agent" && t !== "hermesagent" && t !== "suburban cyber") continue;
          var r = el.getBoundingClientRect();
          if (r.top < 220 && r.left < 360 && r.width < 420) el.innerHTML = '<span class="sc-brand-logo" role="img" aria-label="Suburban Cyber"></span>';
        }
      } catch (e) {}
    }
    function findNavTemplate() {
      var links = document.querySelectorAll("a[href]");
      for (var i = 0; i < links.length; i++) {
        var t = norm(links[i].textContent);
        if (NAV_LABELS[t]) { var r = links[i].getBoundingClientRect(); if (r.left < 360) return links[i]; }
      }
      return null;
    }
    function homeHref() { return "/" + (location.search || ""); }
    function markActive() {
      try { var el = document.getElementById("sc-overview-nav"); if (!el) return;
        el.setAttribute("href", homeHref());
        var on = location.pathname === "/";
        el.style.borderLeft = on ? "2px solid var(--color-primary,#25c9ee)" : "2px solid transparent";
        el.style.background = on ? "var(--color-accent,rgba(37,201,238,.08))" : "";
      } catch (e) {}
    }
    function injectNav() {
      try {
        if (document.getElementById("sc-overview-nav")) { markActive(); return; }
        var tmpl = findNavTemplate(); if (!tmpl || !tmpl.parentElement) return;
        var tmplLabel = norm(tmpl.textContent);
        var clone = tmpl.cloneNode(true);
        clone.id = "sc-overview-nav";
        clone.setAttribute("href", homeHref()); try { clone.href = homeHref(); } catch (e) {}
        var w = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT, null), n;
        while ((n = w.nextNode())) { if (norm(n.nodeValue) === tmplLabel) { n.nodeValue = "Overview"; break; } }
        tmpl.parentElement.insertBefore(clone, tmpl.parentElement.firstChild);
        markActive();
      } catch (e) {}
    }
    function relabel() {
      try {
        var w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null), n;
        while ((n = w.nextNode())) {
          var t = norm(n.nodeValue);
          if (t !== "cron" && t !== "profiles" && t !== "sessions" && t !== "models") continue;
          var el = n.parentElement; if (!el) continue;
          if (el.id === "sc-overview-nav" || (el.closest && el.closest("#sc-overview-nav"))) continue;
          var r = el.getBoundingClientRect(); if (!r.width) continue;
          var inSidebar = r.left < 240, inHeader = r.top < 150 && r.left >= 240 && r.width < 700;
          if (!inSidebar && !inHeader) continue;
          if (t === "cron") n.nodeValue = "Scheduled Jobs";
          else if (t === "profiles") n.nodeValue = "Hermes profiles";
          else if (t === "models") n.nodeValue = "Local models";
          else if (t === "sessions" && inHeader && location.pathname === "/") n.nodeValue = "Overview";
        }
      } catch (e) {}
    }
    function tick() { rebrand(); injectNav(); relabel(); }
    try {
      var mo = new MutationObserver(function () { if (tick._p) return; tick._p = setTimeout(function () { tick._p = null; tick(); }, 120); });
      if (document.body) { mo.observe(document.body, { childList: true, subtree: true, characterData: true }); window.addEventListener("popstate", markActive); tick(); setTimeout(tick, 500); setTimeout(tick, 1500); }
    } catch (e) {}
  });
})();
