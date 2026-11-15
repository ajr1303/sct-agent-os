(function () {
  "use strict";
  var TAG = "[suburban-automations]";

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
          if (!r.ok) throw new Error((j && j.error) || ("HTTP " + r.status));
          return j;
        });
      });
    }

    // n8n editor runs on :5678 of whatever host the dashboard is on.
    function n8nUrl() { var L = window.__SCT_LINKS__; if (L && L.n8n) return L.n8n; return location.protocol + "//" + location.hostname + ":5678/"; }
    function openN8n() { try { window.open(n8nUrl(), "_blank", "noopener"); } catch (e) {} }

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

    function Automations() {
      var s;
      s = useState(null);  var status = s[0], setStatus = s[1];
      s = useState(null);  var wf = s[0], setWf = s[1];
      s = useState(null);  var ex = s[0], setEx = s[1];
      s = useState("");    var apiKey = s[0], setApiKey = s[1];
      s = useState(false); var busy = s[0], setBusy = s[1];
      s = useState(null);  var err = s[0], setErr = s[1];
      s = useState(null);  var reqs = s[0], setReqs = s[1];
      s = useState("");    var wfQ = s[0], setWfQ = s[1];
      s = useState(null);  var wfBusy = s[0], setWfBusy = s[1];
      s = useState(null);  var wfArm = s[0], setWfArm = s[1];   // id waiting for a second click
      s = useState(null);  var wfErr = s[0], setWfErr = s[1];
      // Turning a workflow ON can send email, post or publish, so it takes two
      // clicks. Turning one off is immediate.
      function toggleWf(w) {
        setWfErr(null);
        if (!w.active && wfArm !== w.id) { setWfArm(w.id); return; }
        setWfArm(null); setWfBusy(w.id);
        api("/automations/workflows/" + encodeURIComponent(w.id) + (w.active ? "/deactivate" : "/activate"), { method: "POST" })
          .then(function () { setWfBusy(null); loadData(); })
          .catch(function (e) { setWfBusy(null); setWfErr({ id: w.id, msg: String(e.message || e) }); });
      }
      s = useState(null);  var reqBusy = s[0], setReqBusy = s[1];
      s = useState(null);  var reqErr = s[0], setReqErr = s[1];

      function loadReqs() {
        api("/automations/requests").then(setReqs).catch(function () { setReqs(null); });
      }
      function decide(r, approve) {
        setReqErr(null); setReqBusy(r.id);
        api("/automations/requests/" + r.id + (approve ? "/approve" : "/decline"), { method: "POST" })
          .then(function () { setReqBusy(null); loadReqs(); loadData(); })
          .catch(function (e) { setReqBusy(null); setReqErr(String(e.message || e)); });
      }
      // Workflows an agent built and wants switched on. Only this button activates them.
      function approvals() {
        var pend = reqs && reqs.pending ? reqs.pending : [];
        if (!pend.length) return null;
        return h("div", { className: "sa-panel sa-approvals" },
          h("div", { className: "sa-panel-h" }, "WAITING FOR YOUR APPROVAL"),
          h("div", { className: "sa-apphint" }, "An agent built these workflows. They stay off until you approve."),
          pend.map(function (r) {
            return h("div", { className: "sa-app", key: r.id },
              h("div", { className: "sa-app-main" },
                h("div", { className: "sa-app-name" }, "Turn on: " + (r.workflow_name || "Workflow")),
                h("div", { className: "sa-app-sum" }, r.summary || ""),
                h("div", { className: "sa-app-meta" }, (r.requested_by ? "Requested by " + r.requested_by + " · " : "") + whenStr(r.created_at))),
              h("div", { className: "sa-app-acts" },
                h("button", { type: "button", className: "sa-btn sa-primary", disabled: reqBusy === r.id,
                  onClick: function () { decide(r, true); } }, reqBusy === r.id ? "Working…" : "Approve & turn on"),
                h("button", { type: "button", className: "sa-btn", disabled: reqBusy === r.id,
                  onClick: function () { decide(r, false); } }, "Decline")));
          }),
          reqErr ? h("div", { className: "sa-msg sa-err" }, reqErr) : null);
      }

      function loadData() {
        api("/automations/workflows").then(setWf).catch(function () { setWf(null); });
        api("/automations/executions").then(setEx).catch(function () { setEx(null); });
        loadReqs();
      }
      function loadStatus() {
        return api("/automations/status").then(function (st) {
          setStatus(st);
          if (st.connected) loadData();
          return st;
        }).catch(function (e) { setErr(String(e.message || e)); });
      }
      useEffect(function () {
        loadStatus();
        var t = setInterval(loadStatus, 30000);
        return function () { clearInterval(t); };
      }, []);

      function connect(e) {
        if (e) e.preventDefault();
        setErr(null);
        if (!apiKey.trim()) { setErr("Paste the n8n API key."); return; }
        setBusy(true);
        api("/automations/connect", { method: "POST", body: JSON.stringify({ api_key: apiKey }) })
          .then(function () { setBusy(false); setApiKey(""); loadStatus(); })
          .catch(function (e2) { setBusy(false); setErr(String(e2.message || e2)); });
      }
      function disconnect() {
        api("/automations/connection", { method: "DELETE" }).then(function () { setWf(null); setEx(null); loadStatus(); }).catch(function () {});
      }

      var up = status ? status.n8n_up : null;
      var connected = status ? status.connected : false;

      function header() {
        return h("div", { className: "sa-top" },
          h("div", null,
            h("div", { className: "sa-h1" }, "Automations"),
            h("div", { className: "sa-sub" }, "Your own n8n automation engine — build workflows once and let them run locally, off the token meter.")),
          h("div", { className: "sa-top-right" },
            h("span", { className: "sa-status" },
              up == null ? h("span", null, h("span", { className: "sa-dot sa-mut" }), "checking…")
                : up ? h("span", null, h("span", { className: "sa-dot sa-ok" }), "Engine running")
                : h("span", null, h("span", { className: "sa-dot sa-bad" }), "Engine starting…")),
            h("button", { className: "sa-btn sa-primary", disabled: !up, onClick: openN8n }, "Open builder ↗")));
      }

      // not connected yet -> onboarding
      function connectPanel() {
        return h("div", { className: "sa-panel" },
          h("div", { className: "sa-panel-h" }, "CONNECT YOUR AUTOMATION ENGINE"),
          h("div", { className: "sa-steps" },
            h("div", { className: "sa-step" }, h("span", { className: "sa-num" }, "1"),
              h("span", null, h("b", null, "Open the builder"), " above. First time, create your owner account.")),
            h("div", { className: "sa-step" }, h("span", { className: "sa-num" }, "2"),
              h("span", null, "In n8n go to ", h("b", null, "Settings › n8n API"), " and create an API key.")),
            h("div", { className: "sa-step" }, h("span", { className: "sa-num" }, "3"),
              h("span", null, "Paste the key here so this dashboard can show what's running."))),
          h("form", { className: "sa-connect", onSubmit: connect },
            h("input", { className: "sa-input", type: "password", value: apiKey, placeholder: "n8n API key",
              autoComplete: "new-password", onChange: function (e) { setApiKey(e.target.value); } }),
            h("button", { className: "sa-btn sa-primary", type: "submit", disabled: busy }, busy ? "Connecting…" : "Connect")),
          err ? h("div", { className: "sa-msg sa-err" }, err) : null);
      }

      function statCard(label, val, accent) {
        return h("div", { className: "sa-stat" },
          h("div", { className: "sa-stat-val" + (accent ? " sa-accent" : "") }, val),
          h("div", { className: "sa-stat-label" }, label));
      }

      // connected -> workflows + executions
      function dashboard() {
        var wfs = wf && wf.workflows ? wf.workflows : [];
        var exs = ex && ex.executions ? ex.executions : [];
        return h("div", { className: "sa-cols" },
          h("div", { className: "sa-col" },
            h("div", { className: "sa-stats" },
              statCard("Workflows", wf ? String(wf.count) : "—"),
              statCard("Active", wf ? String(wf.active) : "—", true)),
            h("div", { className: "sa-panel" },
              h("div", { className: "sa-panel-h" }, "WORKFLOWS"),
              wf == null ? h("div", { className: "sa-empty" }, "Loading…")
                : wfs.length === 0 ? h("div", { className: "sa-empty" }, "No workflows yet. Open the builder to create one.")
                : h("div", null,
                    wfs.length > 8 ? h("input", { className: "sa-wf-filter", value: wfQ, placeholder: "Filter " + wfs.length + " workflows…",
                      onChange: function (e) { setWfQ(e.target.value); } }) : null,
                    h("div", { className: "sa-list sa-wf-list" }, wfs.filter(function (w) {
                      return !wfQ || String(w.name).toLowerCase().indexOf(wfQ.toLowerCase()) !== -1;
                    }).map(function (w) {
                      var busy = wfBusy === w.id, armed = wfArm === w.id;
                      return h("div", { className: "sa-wf-wrap", key: w.id },
                        h("div", { className: "sa-wf" },
                          h("span", { className: "sa-wf-name", title: w.name }, w.name, w.archived ? h("span", { className: "sa-wf-arch" }, " archived") : null),
                          h("span", { className: "sa-wf-acts" },
                            h("span", { className: "sa-wf-state " + (w.active ? "on" : "off") }, w.active ? "active" : "inactive"),
                            w.archived ? null : h("button", { type: "button", disabled: busy,
                              className: "sa-btn sa-wf-btn" + (armed ? " sa-primary" : ""),
                              onClick: function () { toggleWf(w); },
                              onBlur: function () { if (armed) setWfArm(null); } },
                              busy ? "Working…" : w.active ? "Turn off" : armed ? "Confirm turn on" : "Turn on"))),
                        wfErr && wfErr.id === w.id ? h("div", { className: "sa-msg sa-err sa-wf-err" }, wfErr.msg) : null);
                    }))))),
          h("div", { className: "sa-col" },
            h("div", { className: "sa-panel" },
              h("div", { className: "sa-panel-h" }, "RECENT RUNS"),
              ex == null ? h("div", { className: "sa-empty" }, "Loading…")
                : exs.length === 0 ? h("div", { className: "sa-empty" }, "No runs yet.")
                : h("div", { className: "sa-list" }, exs.map(function (r, i) {
                    var st = (r.status || "").toLowerCase();
                    var cls = st === "success" ? "ok" : (st === "error" || st === "crashed" ? "bad" : "mut");
                    return h("div", { className: "sa-run", key: i },
                      h("span", { className: "sa-run-dot sa-" + cls }),
                      h("span", { className: "sa-run-name" }, r.workflow),
                      h("span", { className: "sa-run-status " + cls }, r.status || "—"),
                      h("span", { className: "sa-run-time" }, whenStr(r.started)));
                  }))),
            h("div", { className: "sa-managed" },
              h("div", { className: "sa-managed-row" }, h("span", { className: "sa-muted" }, "Engine"), h("span", null, "n8n (bundled)")),
              h("div", { className: "sa-managed-row" }, h("span", { className: "sa-muted" }, "API key"), h("span", null, "connected")),
              h("button", { className: "sa-btn sa-ghost sa-dc", onClick: disconnect }, "Disconnect"))));
      }

      return h("div", { className: "sa-wrap" },
        header(),
        up === false ? h("div", { className: "sa-note" }, "The automation engine is still starting — this can take a minute after a deploy. The status dot turns green when it's ready.") : null,
        (up && !connected) ? connectPanel() : null,
        connected ? approvals() : null,
        connected ? dashboard() : null,
        h("div", { className: "sa-foot" }, "Local automations run on your server, not through the model — use them for scheduled jobs, data moves, and glue work to save tokens.")
      );
    }

    try { PLUGINS.register("suburban-automations", Automations); console.info(TAG, "registered"); }
    catch (e) { try { console.error(TAG, "register failed", e); } catch (e2) {} }

    // ---- Inject an "Automations" nav item ----
    function norm(x) { return (x || "").replace(/\s+/g, " ").trim().toLowerCase(); }
    var NAV_LABELS = { chat: 1, sessions: 1, files: 1, models: 1, logs: 1, cron: 1, skills: 1, plugins: 1, config: 1, overview: 1, mailboxes: 1, bookings: 1 };
    function navTemplate() {
      var links = document.querySelectorAll("a[href]");
      for (var i = 0; i < links.length; i++) {
        var t = norm(links[i].textContent);
        if (NAV_LABELS[t]) { var r = links[i].getBoundingClientRect(); if (r.left < 360) return links[i]; }
      }
      return null;
    }
    function href() { return "/automations" + (location.search || ""); }
    function markActive() {
      try {
        var el = document.getElementById("sa-nav"); if (!el) return;
        el.setAttribute("href", href());
        var on = location.pathname === "/automations";
        el.style.borderLeft = on ? "2px solid var(--color-primary,#25c9ee)" : "2px solid transparent";
        el.style.background = on ? "var(--color-accent,rgba(37,201,238,.08))" : "";
      } catch (e) {}
    }
    function injectNav() {
      try {
        if (window.__SCT_NAV__) return;  // brand/nav.js arranges the sidebar with Hermes' own links
        if (document.getElementById("sa-nav")) { markActive(); return; }
        var tmpl = navTemplate(); if (!tmpl || !tmpl.parentElement) return;
        var tmplLabel = norm(tmpl.textContent);
        var clone = tmpl.cloneNode(true);
        clone.id = "sa-nav";
        clone.setAttribute("href", href()); try { clone.href = href(); } catch (e) {}
        var w = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT, null), n;
        while ((n = w.nextNode())) { if (norm(n.nodeValue) === tmplLabel) { n.nodeValue = "Automations"; break; } }
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
