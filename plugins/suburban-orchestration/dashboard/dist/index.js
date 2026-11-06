(function () {
  "use strict";
  var TAG = "[suburban-orchestration]";

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

    function api(path) {
      return fetch("/api/connectors" + path, { credentials: "same-origin" }).then(function (r) {
        return r.text().then(function (txt) {
          var j = {}; try { j = txt ? JSON.parse(txt) : {}; } catch (e) {}
          if (!r.ok) throw new Error((j && j.error) || ("HTTP " + r.status));
          return j;
        });
      });
    }

    function attentionCount(att) {
      if (att == null) return null;
      if (typeof att === "number") return att;
      var keys = ["total", "count", "pending", "waiting", "open", "needsAttention"];
      for (var i = 0; i < keys.length; i++) if (typeof att[keys[i]] === "number") return att[keys[i]];
      // sum numeric leaf values as a fallback
      var sum = 0, found = false;
      try { Object.keys(att).forEach(function (k) { if (typeof att[k] === "number") { sum += att[k]; found = true; } }); } catch (e) {}
      return found ? sum : null;
    }

    function Orchestration() {
      var s;
      s = useState(null); var status = s[0], setStatus = s[1];
      s = useState(null); var ov = s[0], setOv = s[1];

      function load() {
        api("/orchestration/status").then(function (st) {
          setStatus(st);
          if (st.paperclip_up) api("/orchestration/overview").then(setOv).catch(function () {});
        }).catch(function () { setStatus({ paperclip_up: false }); });
      }
      useEffect(function () {
        load();
        var t = setInterval(load, 30000);
        return function () { clearInterval(t); };
      }, []);

      var up = status ? status.paperclip_up : null;
      var mode = status ? status.mode : null;
      var agents = ov && ov.agents ? ov.agents : [];
      var att = ov ? attentionCount(ov.attention) : null;

      function stat(label, val, accent) {
        return h("div", { className: "so-stat" },
          h("div", { className: "so-stat-val" + (accent ? " so-accent" : "") }, val),
          h("div", { className: "so-stat-label" }, label));
      }

      return h("div", { className: "so-wrap" },
        h("div", { className: "so-top" },
          h("div", null,
            h("div", { className: "so-h1" }, "Orchestration"),
            h("div", { className: "so-sub" }, "The management layer behind your agents — org chart, schedules, approvals, and audit trail. Agents run in Hermes; Paperclip drives them.")),
          h("div", { className: "so-top-right" },
            mode ? h("span", { className: "so-mode" }, mode === "external" ? "Connected · observe-only" : "Bundled") : null,
            h("span", { className: "so-status" },
              up == null ? h("span", null, h("span", { className: "so-dot so-mut" }), "checking…")
                : up ? h("span", null, h("span", { className: "so-dot so-ok" }), "Control plane running")
                : h("span", null, h("span", { className: "so-dot so-bad" }), "Control plane off")))),

        up === false ? h("div", { className: "so-note" },
          "The orchestration control plane isn't running. It's an opt-in profile (it builds Paperclip from source on first start). Enable it with the ",
          h("code", null, "control-plane"), " compose profile, then redeploy.") : null,

        up ? h("div", { className: "so-stats" },
          stat("Managed agents", ov ? String(agents.length) : "—"),
          stat("Waiting on you", att == null ? "—" : String(att), true),
          stat("Mode", mode === "external" ? "External" : "Bundled")) : null,

        up ? h("div", { className: "so-panel" },
          h("div", { className: "so-panel-h" }, "MANAGED AGENTS"),
          ov == null ? h("div", { className: "so-empty" }, "Loading…")
            : agents.length === 0 ? h("div", { className: "so-empty" }, "No managed agents yet. Agents you create in Agent OS will register here.")
            : h("div", { className: "so-list" }, agents.map(function (a, i) {
                return h("div", { className: "so-agent", key: i },
                  h("span", { className: "so-agent-name" }, a.name),
                  a.status ? h("span", { className: "so-agent-state" }, String(a.status)) : null);
              }))) : null,

        up && mode === "external" ? h("div", { className: "so-note so-obs" },
          "Observe-only: this is pointed at an existing Paperclip instance. Agent OS reads status here but does not approve, act, or change anything — use Paperclip directly for those.") : null,

        h("div", { className: "so-explain" },
          h("div", { className: "so-explain-h" }, "HOW IT FITS"),
          h("div", { className: "so-explain-row" }, h("b", null, "Hermes"), " — the engine room. Where each agent actually runs: model, tools, chat, sessions."),
          h("div", { className: "so-explain-row" }, h("b", null, "Paperclip"), " — the management office. The org chart, task assignment, schedules, budgets, approvals and audit ledger. It drives agents; it doesn't run them."),
          h("div", { className: "so-explain-row" }, h("b", null, "This dashboard"), " — the only cockpit. Paperclip runs headless; you manage everything from here.")),

        h("div", { className: "so-foot" }, "Read-only view (phase 1). Creating and managing agents from one flow is the next phase.")
      );
    }

    try { PLUGINS.register("suburban-orchestration", Orchestration); console.info(TAG, "registered"); }
    catch (e) { try { console.error(TAG, "register failed", e); } catch (e2) {} }

    // ---- Inject an "Orchestration" nav item ----
    function norm(x) { return (x || "").replace(/\s+/g, " ").trim().toLowerCase(); }
    var NAV_LABELS = { chat: 1, sessions: 1, files: 1, models: 1, logs: 1, cron: 1, skills: 1, plugins: 1, config: 1, overview: 1, mailboxes: 1, bookings: 1, automations: 1 };
    function navTemplate() {
      var links = document.querySelectorAll("a[href]");
      for (var i = 0; i < links.length; i++) {
        var t = norm(links[i].textContent);
        if (NAV_LABELS[t]) { var r = links[i].getBoundingClientRect(); if (r.left < 360) return links[i]; }
      }
      return null;
    }
    function href() { return "/orchestration" + (location.search || ""); }
    function markActive() {
      try {
        var el = document.getElementById("so-nav"); if (!el) return;
        el.setAttribute("href", href());
        var on = location.pathname === "/orchestration";
        el.style.borderLeft = on ? "2px solid var(--color-primary,#25c9ee)" : "2px solid transparent";
        el.style.background = on ? "var(--color-accent,rgba(37,201,238,.08))" : "";
      } catch (e) {}
    }
    function injectNav() {
      try {
        if (document.getElementById("so-nav")) { markActive(); return; }
        var tmpl = navTemplate(); if (!tmpl || !tmpl.parentElement) return;
        var tmplLabel = norm(tmpl.textContent);
        var clone = tmpl.cloneNode(true);
        clone.id = "so-nav";
        clone.setAttribute("href", href()); try { clone.href = href(); } catch (e) {}
        var w = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT, null), n;
        while ((n = w.nextNode())) { if (norm(n.nodeValue) === tmplLabel) { n.nodeValue = "Orchestration"; break; } }
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
