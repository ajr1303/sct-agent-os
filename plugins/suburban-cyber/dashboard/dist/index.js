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
    managed: { backup: "Memory backup · nightly" }
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
    function Panel(title, right, children) {
      return h("div", { className: "sc-panel" },
        h("div", { className: "sc-panel-h" },
          h("span", { className: "sc-panel-t" }, title),
          right ? h("span", { className: "sc-panel-r" }, right) : null),
        h("div", { className: "sc-panel-b" }, children));
    }

    function Overview() {
      var sa = useState(null), status = sa[0], setStatus = sa[1];
      var sb = useState(null), sessions = sb[0], setSessions = sb[1];
      var sc = useState(null), analytics = sc[0], setAnalytics = sc[1];
      var sd = useState(null), agents = sd[0], setAgents = sd[1];
      var se = useState(null), pcOv = se[0], setPcOv = se[1];
      var sg = useState(null), upd = sg[0], setUpd = sg[1];
      var sh = useState(0), updBump = sh[0], setUpdBump = sh[1];

      useEffect(function () {
        function load() {
          var p1 = call("getStatus"); if (p1) p1.then(setStatus).catch(function () {});
          var p2 = call("getSessions"); if (p2) p2.then(function (v) { setSessions(toList(v)); }).catch(function () {});
          var p3 = call("getAnalytics", 14); if (p3) p3.then(setAnalytics).catch(function () {});
          var p4 = call("getProfiles"); if (p4) p4.then(function (v) { setAgents(toList(v)); }).catch(function () {});
          try {
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
      function waitingBody() {
        if (pcOv == null) return h("div", { className: "sc-empty" }, "Checking the control plane…");
        if (!pcOv.paperclip_up) return h("div", { className: "sc-empty" }, h("span", null, "Control plane is off. ", h("a", { href: orchHref(), className: "sc-link" }, "Set it up in Orchestration →")));
        var att = pcOv.attention;
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
      var agentTileLabel = useManaged ? "Agents" : "Active agents";
      var agentTileVal = useManaged ? String(managedAgents.length) : (status ? String(activeAgents != null ? activeAgents : 0) : "—");
      var agentTileSub = useManaged ? "Managed by Paperclip" : "Running right now";

      function updDismissed(ver) { try { return localStorage.getItem("sc-upd-dismissed") === ver; } catch (e) { return false; } }
      function dismissUpd(ver) { try { localStorage.setItem("sc-upd-dismissed", ver); } catch (e) {} setUpdBump(updBump + 1); }
      function updBanner() {
        if (!upd || !upd.update_available || updDismissed(upd.latest)) return null;
        return h("div", { className: "sc-updbar" },
          h("div", { className: "sc-updbar-l" },
            h("span", { className: "sc-updbar-dot" }),
            h("span", null, h("b", null, "Update available"), " — v" + (upd.current || "?") + " → v" + (upd.latest || "?") + ". Run ",
              h("code", { className: "sc-updcode" }, "sudo ./scripts/update.sh"), " on the server when you're ready.")),
          h("div", { className: "sc-updbar-r" },
            upd.notes_url ? h("a", { className: "sc-link", href: upd.notes_url, target: "_blank", rel: "noopener" }, "What's changed") : null,
            h("button", { className: "sc-updbar-x", onClick: function () { dismissUpd(upd.latest); } }, "Dismiss")));
      }

      return h("div", { className: "sc-wrap" },
        updBanner(),
        h("div", { className: "sc-top" },
          h("div", null,
            h("div", { className: "sc-date" }, today),
            h("div", { className: "sc-h1" }, "Today at Suburban Cyber")),
          h("div", { className: "sc-chip" }, up == null ? "connecting…" :
            h("span", null, h("span", { className: "sc-dot " + (up ? "sc-ok" : "sc-bad") }), up ? "Gateway running" : "Gateway down"))),

        h("div", { className: "sc-stats" },
          Stat("Sessions, 14 days", analytics ? String(tot.total_sessions || 0) : "—", "Conversations and automations"),
          Stat("Tokens, 14 days", analytics ? fmtNum(tokens) : "—", "Input + output"),
          Stat(agentTileLabel, agentTileVal, agentTileSub, true),
          Stat("AI spend, 14 days", analytics ? fmtCost(tot.total_estimated_cost) : "—", "Estimated from usage")),

        h("div", { className: "sc-cols" },
          h("div", { className: "sc-col" },
            Panel("Waiting on you", "Agents ask before they send, publish or delete.", waitingBody()),
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
          ),
          h("div", { className: "sc-col" },
            Panel("Activity log", "Live from your gateway",
              recent.length === 0
                ? h("div", { className: "sc-empty" }, sessions == null ? "Loading…" : "No recent sessions yet.")
                : recent.map(function (s, i) {
                    var title = pick(s, ["title", "preview", "name", "id"]) || "Session";
                    return h("div", { className: "sc-log", key: i },
                      h("span", { className: "sc-log-t" }, timeAgo(pick(s, ["last_active", "updated_at", "created_at", "started_at"])) || "recent"),
                      h("span", null, String(title).slice(0, 60)));
                  })),
            h("div", { className: "sc-managed" },
              h("div", { className: "sc-managed-h" }, OPERATOR ? "MANAGED BY " + OPERATOR.toUpperCase() : "YOUR SYSTEM"),
              SUPPORT ? h("div", { className: "sc-managed-row" }, h("span", { className: "sc-muted" }, "Support"), h("span", null, SUPPORT)) : null,
              h("div", { className: "sc-managed-row" }, h("span", { className: "sc-muted" }, "Active sessions"), h("span", null, activeSessions == null ? "—" : String(activeSessions))),
              h("div", { className: "sc-managed-row" }, h("span", { className: "sc-muted" }, "Hermes version"), h("span", null, version || "—")),
              h("div", { className: "sc-managed-sub" }, SAMPLE.managed.backup))
          )
        ),
        h("div", { className: "sc-foot" }, "Suburban Cyber Agent OS · built on Hermes Agent (Nous Research)")
      );
      } catch (e) {
        try { console.error(TAG, "Overview render failed", e); } catch (e2) {}
        return h("div", { className: "sc-wrap" },
          h("div", { className: "sc-top" },
            h("div", null,
              h("div", { className: "sc-h1" }, "Today at Suburban Cyber"))),
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
