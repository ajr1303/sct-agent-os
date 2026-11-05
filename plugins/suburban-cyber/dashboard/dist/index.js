(function () {
  "use strict";
  var TAG = "[suburban-cyber]";
  var BRAND = "Suburban Cyber";

  // Sample/preview content for panels Hermes does not yet expose. Operators replace this
  // per client once real sources (billing, approval queue) are wired. Clearly marked in the UI.
  var SAMPLE = {
    metrics: [
      { key: "tasks", label: "Tasks done, 14 days", value: "562", note: "Up 9% on the 14 days before" },
      { key: "time",  label: "Time saved",          value: "94 hrs", note: "Estimated at 10 min per task" },
      { key: "wait",  label: "Waiting on you",      value: null, note: "Agents pause until you answer", accent: true },
      { key: "spend", label: "AI spend, this month", value: "$62", note: "of $400 budget" }
    ],
    approvals: [
      { agent: "Front Desk", risk: "medium", title: "Send 3 overdue-invoice reminders",
        detail: "Outbound email to customers always needs your sign-off." },
      { agent: "Books", risk: "high", title: "Delete 214 spam messages older than 90 days",
        detail: "Permanent deletion is always held for review. Nothing is removed until you approve." }
    ],
    agents: [
      { name: "Front Desk", desc: "Sorts the shared inbox and drafts replies", tier: "free", status: "waiting" },
      { name: "Books", desc: "Matches payments and flags late invoices", tier: "free", status: "waiting" },
      { name: "Content", desc: "Drafts posts and updates the website", tier: "pro" },
      { name: "Watchtower", desc: "Watches sign-ins and device alerts", tier: "pro" }
    ],
    managed: {
      engineer: "Anibal Rodriguez",
      lastReview: "Last security review · Sept 30",
      backup: "Agent memory backup · nightly",
      nextReview: "Next monthly review · Oct 28"
    }
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

    function pick(o, keys) { for (var i = 0; i < keys.length; i++) { if (o && o[keys[i]] != null) return o[keys[i]]; } return null; }
    function toList(x) { return Array.isArray(x) ? x : (x && (x.sessions || x.items || x.data || x.profiles)) || []; }
    function callApi() {
      for (var i = 0; i < arguments.length; i++) {
        var n = arguments[i];
        try { if (SDK.api && typeof SDK.api[n] === "function") return Promise.resolve(SDK.api[n]()); } catch (e) {}
      }
      return null;
    }
    function timeAgo(t) {
      try {
        if (t == null) return "";
        if (typeof t === "number") return SDK.utils.timeAgo(t);
        return SDK.utils.isoTimeAgo(t);
      } catch (e) { return ""; }
    }

    function Stat(m, waitCount) {
      var v = m.value;
      if (m.key === "wait") v = String(waitCount);
      return h("div", { className: "sc-stat", key: m.key },
        h("div", { className: "sc-stat-label" }, m.label),
        h("div", { className: "sc-stat-val" + (m.accent ? " sc-accent" : "") }, v),
        h("div", { className: "sc-stat-note" }, m.note));
    }

    function Panel(title, right, children) {
      return h("div", { className: "sc-panel" },
        h("div", { className: "sc-panel-h" },
          h("span", { className: "sc-panel-t" }, title),
          right ? h("span", { className: "sc-panel-r" }, right) : null),
        h("div", { className: "sc-panel-b" }, children));
    }

    function Overview() {
      var a = useState(null), status = a[0], setStatus = a[1];
      var b = useState(null), sessions = b[0], setSessions = b[1];
      var c = useState(SAMPLE.approvals.slice()), approvals = c[0], setApprovals = c[1];

      useEffect(function () {
        function load() {
          var ps = callApi("getStatus"); if (ps) ps.then(setStatus).catch(function () {});
          var pl = callApi("getSessions"); if (pl) pl.then(function (v) { setSessions(toList(v)); }).catch(function () {});
        }
        load();
        var t = setInterval(load, 15000);
        return function () { clearInterval(t); };
      }, []);

      var up = status ? pick(status, ["gateway_running", "gatewayRunning"]) : null;
      if (up == null && status && status.gateway) up = pick(status.gateway, ["running", "ok"]);
      var active = status ? pick(status, ["active_sessions", "activeSessions"]) : null;
      var recent = (sessions || []).slice(0, 4);

      function decide(i) {
        var next = approvals.slice(); next.splice(i, 1); setApprovals(next);
      }

      var today = new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });

      return h("div", { className: "sc-wrap" },
        // header row
        h("div", { className: "sc-top" },
          h("div", null,
            h("div", { className: "sc-date" }, today),
            h("div", { className: "sc-h1" }, "Today at Suburban Cyber")),
          h("div", { className: "sc-chip" }, up == null ? "connecting…" :
            h("span", null, h("span", { className: "sc-dot " + (up ? "sc-ok" : "sc-bad") }), up ? "Gateway running" : "Gateway down"))),

        // stat tiles
        h("div", { className: "sc-stats" }, SAMPLE.metrics.map(function (m) { return Stat(m, approvals.length); })),

        // two columns
        h("div", { className: "sc-cols" },
          h("div", { className: "sc-col" },
            Panel("Waiting on you", "Agents ask before they send, publish or delete.",
              approvals.length === 0
                ? h("div", { className: "sc-empty" }, "Nothing waiting. You're all caught up.")
                : approvals.map(function (ap, i) {
                    return h("div", { className: "sc-appr", key: i },
                      h("div", { className: "sc-appr-l" },
                        h("div", { className: "sc-appr-top" },
                          h("span", { className: "sc-agent" }, ap.agent.toUpperCase()),
                          h("span", { className: "sc-risk sc-risk-" + ap.risk }, ap.risk + " risk")),
                        h("div", { className: "sc-appr-title" }, ap.title),
                        h("div", { className: "sc-appr-detail" }, ap.detail)),
                      h("div", { className: "sc-appr-btns" },
                        h("button", { className: "sc-btn sc-btn-ghost", onClick: function () { decide(i); } }, "Deny"),
                        h("button", { className: "sc-btn sc-btn-primary", onClick: function () { decide(i); } }, "Approve")));
                  })),
            Panel("Your agents", (SAMPLE.agents.filter(function(x){return x.tier==="free";}).length) + " on Free, " + (SAMPLE.agents.filter(function(x){return x.tier==="pro";}).length) + " in Pro",
              SAMPLE.agents.map(function (ag, i) {
                return h("div", { className: "sc-agentrow", key: i },
                  h("div", null,
                    h("div", { className: "sc-agentname" }, ag.name),
                    h("div", { className: "sc-agentdesc" }, ag.desc)),
                  ag.tier === "pro"
                    ? h("span", { className: "sc-tag sc-tag-pro" }, "See Pro")
                    : h("span", { className: "sc-tag sc-tag-wait" }, ag.status === "waiting" ? "Waiting on you" : "Active"));
              }))
          ),
          h("div", { className: "sc-col" },
            Panel("Activity log", "Live from your gateway",
              recent.length === 0
                ? h("div", { className: "sc-empty" }, sessions == null ? "Loading…" : "No recent sessions yet.")
                : recent.map(function (s, i) {
                    var title = pick(s, ["title", "preview", "name", "id"]) || "Session";
                    return h("div", { className: "sc-log", key: i },
                      h("span", { className: "sc-log-t" }, timeAgo(pick(s, ["last_active","updated_at","created_at","started_at"])) || "recent"),
                      h("span", null, String(title).slice(0, 70)));
                  })),
            h("div", { className: "sc-managed" },
              h("div", { className: "sc-managed-h" }, "MANAGED BY SUBURBAN CYBER"),
              h("div", { className: "sc-managed-row" }, h("span", { className: "sc-muted" }, "Your engineer"), h("span", null, SAMPLE.managed.engineer)),
              h("div", { className: "sc-managed-row" }, h("span", { className: "sc-muted" }, "Active sessions"), h("span", null, active == null ? "—" : String(active))),
              h("div", { className: "sc-managed-row" }, h("span", { className: "sc-muted" }, "Hermes"), h("span", null, status ? (pick(status,["version","hermes_version"])||"—") : "—")),
              h("div", { className: "sc-managed-sub" }, SAMPLE.managed.lastReview),
              h("div", { className: "sc-managed-sub" }, SAMPLE.managed.backup),
              h("button", { className: "sc-btn sc-btn-primary sc-managed-cta" }, "Request a change"))
          )
        ),
        h("div", { className: "sc-foot" },
          h("span", { className: "sc-pill-sample" }, "preview · sample data"),
          h("span", null, " Suburban Cyber Agent OS · built on Hermes Agent (Nous Research)"))
      );
    }

    try {
      PLUGINS.register("suburban-cyber", Overview);
      console.info(TAG, "registered, sdk=" + (SDK.sdkVersion || "?"));
    } catch (e) { try { console.error(TAG, "register failed", e); } catch (e2) {} }

    // Branding + nav injection. Isolated so nothing here can block registration.
    function norm(x) { return (x || "").replace(/\s+/g, " ").trim().toLowerCase(); }
    var NAV_LABELS = { chat:1, sessions:1, files:1, models:1, logs:1, cron:1, skills:1, plugins:1, config:1 };

    function rebrand() {
      try {
        if (!/suburban/i.test(document.title)) document.title = BRAND + " Agent OS";
        var all = document.querySelectorAll("a,div,span,h1,h2,p");
        for (var i = 0; i < all.length; i++) {
          var el = all[i];
          if (el.querySelector && el.querySelector(".sc-brand-logo")) continue; // already branded
          if (el.childElementCount > 3) continue;
          var t = norm(el.textContent);
          if (t !== "hermes agent" && t !== "hermesagent" && t !== "suburban cyber") continue;
          var r = el.getBoundingClientRect();
          if (r.top < 220 && r.left < 360 && r.width < 420) {
            el.innerHTML = '<span class="sc-brand-logo" role="img" aria-label="Suburban Cyber"></span>';
          }
        }
      } catch (e) {}
    }

    function findNavTemplate() {
      var links = document.querySelectorAll("a[href]");
      for (var i = 0; i < links.length; i++) {
        var t = norm(links[i].textContent);
        if (NAV_LABELS[t]) {
          var r = links[i].getBoundingClientRect();
          if (r.left < 360) return links[i];
        }
      }
      return null;
    }
    function homeHref() { return "/" + (location.search || ""); }
    function markActive() {
      try {
        var el = document.getElementById("sc-overview-nav"); if (!el) return;
        el.setAttribute("href", homeHref());           // keep profile query current, target the tiled landing page
        var on = location.pathname === "/";
        el.style.borderLeft = on ? "2px solid var(--color-primary,#25c9ee)" : "2px solid transparent";
        el.style.background = on ? "var(--color-accent,rgba(37,201,238,.08))" : "";
      } catch (e) {}
    }
    function injectNav() {
      try {
        if (document.getElementById("sc-overview-nav")) { markActive(); return; }
        var tmpl = findNavTemplate();
        if (!tmpl || !tmpl.parentElement) return;
        var tmplLabel = norm(tmpl.textContent);
        var clone = tmpl.cloneNode(true);
        clone.id = "sc-overview-nav";
        clone.setAttribute("href", homeHref());
        try { clone.href = homeHref(); } catch (e) {}
        var w = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT, null);
        var n;
        while ((n = w.nextNode())) { if (norm(n.nodeValue) === tmplLabel) { n.nodeValue = "Overview"; break; } }
        tmpl.parentElement.insertBefore(clone, tmpl.parentElement.firstChild);
        markActive();
        console.info(TAG, "nav item injected");
      } catch (e) {}
    }

    function tick() { rebrand(); injectNav(); }
    try {
      var mo = new MutationObserver(function () {
        if (tick._p) return; tick._p = setTimeout(function () { tick._p = null; tick(); }, 120);
      });
      if (document.body) {
        mo.observe(document.body, { childList: true, subtree: true, characterData: true });
        window.addEventListener("popstate", markActive);
        tick(); setTimeout(tick, 500); setTimeout(tick, 1500);
      }
    } catch (e) {}
  });
})();
