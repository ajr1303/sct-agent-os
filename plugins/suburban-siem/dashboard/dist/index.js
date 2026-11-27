(function () {
  "use strict";
  var TAG = "[suburban-siem]";
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
      if (!iso) return "";
      try { return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); }
      catch (e) { return ""; }
    }
    var SEV = [["critical", "Critical"], ["high", "High"], ["medium", "Medium"], ["low", "Low"]];
    var SEV_MIN = { critical: 15, high: 12, medium: 7, low: 0 };
    var PERIODS = [[24, "Last 24 hours"], [168, "7 days"], [720, "30 days"]];
    var LEVELS = [[7, "Worth a look"], [12, "Serious only"], [0, "Everything"]];

    function Siem() {
      var s;
      s = useState(null);  var st = s[0], setSt = s[1];
      s = useState(null);  var err = s[0], setErr = s[1];
      s = useState("");    var busy = s[0], setBusy = s[1];
      s = useState(false); var wantConsole = s[0], setWantConsole = s[1];
      s = useState("alerts"); var tab = s[0], setTab = s[1];
      s = useState(null);  var data = s[0], setData = s[1];      // alerts answer
      s = useState(null);  var src = s[0], setSrc = s[1];        // who is sending
      s = useState(null);  var loadErr = s[0], setLoadErr = s[1];
      s = useState(24);    var hours = s[0], setHours = s[1];
      s = useState(7);     var level = s[0], setLevel = s[1];
      s = useState("");    var q = s[0], setQ = s[1];
      s = useState("");    var asked = s[0], setAsked = s[1];    // the search actually sent
      s = useState(null);  var open = s[0], setOpen = s[1];

      function loadStatus() {
        return api("/siem").then(function (x) { setSt(x); return x; })
          .catch(function (e) { setErr(String(e.message || e)); });
      }
      var state = st ? (st.requested && st.state !== "installing" ? "requested" : st.state) : null;
      useEffect(function () { loadStatus(); }, []);
      // While it is being set up, or a request is waiting for the server, keep looking.
      useEffect(function () {
        if (state !== "requested" && state !== "installing") return undefined;
        var t = setInterval(loadStatus, 5000);
        return function () { clearInterval(t); };
      }, [state]);

      function loadAlerts() {
        setLoadErr(null);
        return api("/siem/alerts?hours=" + hours + "&min_level=" + level + "&limit=150&q=" + encodeURIComponent(asked))
          .then(function (x) { setData(x); }).catch(function (e) { setLoadErr(String(e.message || e)); });
      }
      useEffect(function () {
        if (state !== "running") return undefined;
        loadAlerts();
        var t = setInterval(loadAlerts, 60000);
        return function () { clearInterval(t); };
      }, [state, hours, level, asked]);
      useEffect(function () {
        if (state !== "running" || tab !== "sending") return;
        setLoadErr(null);
        api("/siem/sources").then(function (x) { setSrc(x); }).catch(function (e) { setLoadErr(String(e.message || e)); });
      }, [state, tab]);

      function act(name, path, body) {
        setBusy(name); setErr(null);
        return api(path, { method: "POST", body: JSON.stringify(body || {}) })
          .then(function (x) { setBusy(""); setSt(x); })
          .catch(function (e) { setBusy(""); setErr(String(e.message || e)); });
      }

      var head = [h("div", { key: "h", className: "se-h1" }, "Security events"),
        h("div", { key: "s", className: "se-sub" }, "Your own SIEM: computers and network gear send their logs here, and anything suspicious shows up as an alert."),
        err ? h("div", { key: "e", className: "se-msg se-bad", role: "alert" }, err) : null];

      if (!st) return h("div", { className: "se-wrap" }, head, err ? null : h("div", { className: "se-dim" }, "Loading…"));

      if (state === "requested" || state === "installing") {
        return h("div", { className: "se-wrap" }, head,
          h("div", { className: "se-card", role: "status" },
            h("div", { className: "se-name" }, state === "installing" ? "Setting up the SIEM" : "Asking the server…"),
            h("div", { className: "se-dim" }, state === "installing" ? (st.step || "Working…") + " The first set-up downloads a few GB and can take 10 to 20 minutes. You can leave this page."
              : (st.host_not_listening ? "The server has not picked this up after several minutes. Its scheduled jobs may not be installed: run scripts/install-cron.sh on the server."
                : "The server checks for requests once a minute."))));
      }

      if (state !== "running") {
        return h("div", { className: "se-wrap" }, head,
          state === "failed" ? h("div", { className: "se-msg se-bad", role: "alert" }, "Setting up did not finish. " + (st.step || "")) : null,
          h("div", { className: "se-card" },
            h("div", { className: "se-name" }, state === "stopped" ? "The SIEM is turned off" : "Turn on the built-in SIEM"),
            h("div", { className: "se-dim" }, state === "stopped" ? "Everything it collected is kept. Nothing is being collected while it is off."
              : "Agent OS sets up Wazuh, an open-source SIEM, on this server. Then you point your firewalls, switches and access points at it and install its small agent on your computers and servers."),
            state === "stopped" ? null : h("ul", { className: "se-dim", style: { margin: 0, paddingLeft: "18px", lineHeight: 1.7 } },
              h("li", null, "Needs a server with at least 12 GB of memory and 40 GB of free disk. It will refuse to start on less."),
              h("li", null, "Downloads a few GB the first time."),
              h("li", null, "Devices on your network reach it on ports 514 (UDP), 1514 and 1515. Nothing is opened to the internet.")),
            h("label", { className: "se-tick" },
              h("input", { type: "checkbox", checked: wantConsole, onChange: function (e) { setWantConsole(e.target.checked); } }),
              h("span", null, "Also start Wazuh's own console", h("div", { className: "se-dim" }, "For technicians who want its full screens. Uses about 1 GB more memory. You can leave this off and use this page."))),
            h("div", { className: "se-acts se-left" },
              h("button", { type: "button", className: "se-btn se-primary", disabled: busy === "on", onClick: function () { act("on", "/siem/on", { console: wantConsole }); } },
                busy === "on" ? "Asking…" : (state === "stopped" ? "Turn back on" : state === "failed" ? "Try again" : "Turn on")))));
      }

      function alertsTab() {
        var totals = (data && data.totals) || {}, list = (data && data.alerts) || [];
        return h("div", { className: "se-wrap" },
          h("div", { className: "se-stats" }, SEV.map(function (x) {
            return h("button", { key: x[0], type: "button", className: "se-stat" + (level === SEV_MIN[x[0]] ? " se-stat-on" : ""),
              "aria-label": x[1] + " and above", onClick: function () { setLevel(SEV_MIN[x[0]]); } },
              h("div", { className: "se-num se-" + x[0] }, data ? String(totals[x[0]] || 0) : "–"),
              h("div", { className: "se-dim" }, x[1])); })),
          h("div", { className: "se-bar" },
            h("div", { className: "se-chips", role: "group", "aria-label": "Period" }, PERIODS.map(function (p) {
              return h("button", { key: p[0], type: "button", className: "se-chip" + (hours === p[0] ? " se-chip-on" : ""), "aria-pressed": hours === p[0],
                onClick: function () { setHours(p[0]); } }, p[1]); })),
            h("div", { className: "se-chips", role: "group", "aria-label": "Show" }, LEVELS.map(function (p) {
              return h("button", { key: p[0], type: "button", className: "se-chip" + (level === p[0] ? " se-chip-on" : ""), "aria-pressed": level === p[0],
                onClick: function () { setLevel(p[0]); } }, p[1]); }))),
          h("form", { className: "se-main", onSubmit: function (e) { e.preventDefault(); setAsked(q.trim()); } },
            h("input", { className: "se-in se-search", type: "search", placeholder: "Search alerts: a name, an address, a word", "aria-label": "Search alerts", value: q,
              onChange: function (e) { setQ(e.target.value); if (!e.target.value) setAsked(""); } }),
            h("button", { type: "submit", className: "se-btn" }, "Search")),
          loadErr ? h("div", { className: "se-msg se-bad", role: "alert" }, loadErr) : null,
          !data && !loadErr ? h("div", { className: "se-dim" }, "Loading alerts…") : null,
          data && !list.length ? h("div", { className: "se-dim" }, asked || level ? "Nothing matches. Try Everything, or a longer period."
            : "No alerts yet. Once devices are sending their logs, alerts appear here. See Sending logs here.") : null,
          list.length ? h("div", { className: "se-box" }, list.map(function (a) {
            var isOpen = open === a.id;
            return h("div", { key: a.id, className: "se-item" },
              h("button", { type: "button", className: "se-alert", "aria-expanded": isOpen, onClick: function () { setOpen(isOpen ? null : a.id); } },
                h("div", { className: "se-name" }, h("span", { className: "se-sev se-" + a.severity }, a.severity), a.rule || "Alert"),
                h("div", { className: "se-dim" }, [when(a.time), a.source ? a.kind + " " + a.source : "", a.src_ip ? "from " + a.src_ip : "", a.user ? "user " + a.user : "", "level " + a.level].filter(Boolean).join(" · "))),
              isOpen ? h("pre", { className: "se-log" }, a.log || "No log line was kept for this alert.") : null); })) : null,
          data && data.total > list.length ? h("div", { className: "se-dim" }, "Showing the newest " + list.length + " of " + data.total + ". Narrow the period or search to see others.") : null);
      }

      function sendingTab() {
        var su = st.setup || {}, host = su.host || "this server's address";
        return h("div", { className: "se-wrap" },
          loadErr ? h("div", { className: "se-msg se-bad", role: "alert" }, loadErr) : null,
          h("div", { className: "se-card" },
            h("div", { className: "se-name" }, "Network gear: firewalls, switches, access points"),
            h("div", { className: "se-dim" }, "In the device's or controller's settings, find remote logging (often called syslog or SIEM server) and enter:"),
            h("code", { className: "se-code" }, "Server " + host + "    Port 514    Protocol UDP"),
            h("div", { className: "se-dim" }, "Only private addresses are accepted. An alert appears when a log line matches one of the SIEM's rules, so quiet gear can send logs and show nothing here."),
            src && src.gear.length ? h("div", { className: "se-list" }, src.gear.map(function (g) {
              return h("div", { key: g.address, className: "se-row se-row-sm" }, h("div", { className: "se-main" },
                h("span", { className: "se-dot se-dot-on", "aria-hidden": "true" }),
                h("div", { className: "se-meta" }, h("div", { className: "se-name" }, g.address),
                  h("div", { className: "se-dim" }, g.alerts + " alerts this week · last " + when(g.last_seen))))); }))
              : h("div", { className: "se-dim" }, src ? "No network gear has raised an alert this week." : "")),
          h("div", { className: "se-card" },
            h("div", { className: "se-name" }, "Computers and servers"),
            h("div", { className: "se-dim" }, "Install the SIEM's agent on each one. The commands below already hold this server's address and the enrolment password, so treat them like a password. Run as an administrator."),
            h("div", { className: "se-lab" }, "Windows (PowerShell)"),
            h("code", { className: "se-code" }, su.windows || ""),
            h("div", { className: "se-dim" }, "Then start it:"),
            h("code", { className: "se-code" }, su.windows_start || ""),
            h("div", { className: "se-lab" }, "Linux (Debian, Ubuntu)"),
            h("code", { className: "se-code" }, su.linux || ""),
            h("div", { className: "se-dim" }, "If your computers reach this server by another address (a VPN or mesh address, say), replace " + host + " in the command. They need to reach ports " + (su.agent_ports || "1514 and 1515") + "."),
            src && src.computers.length ? h("div", { className: "se-list" }, src.computers.map(function (c) {
              return h("div", { key: c.id, className: "se-row se-row-sm" }, h("div", { className: "se-main" },
                h("span", { className: "se-dot" + (c.status === "active" ? " se-dot-on" : " se-dot-bad"), "aria-hidden": "true" }),
                h("div", { className: "se-meta" }, h("div", { className: "se-name" }, c.name),
                  h("div", { className: "se-dim" }, [c.os, c.ip, c.status === "active" ? "sending" : c.status.replace(/_/g, " "), c.last_seen ? "last heard " + when(c.last_seen) : ""].filter(Boolean).join(" · "))))); }))
              : h("div", { className: "se-dim" }, src ? "No computers are enrolled yet." : "Loading…")),
          h("div", { className: "se-card" },
            h("div", { className: "se-name" }, "Turn the SIEM off"),
            h("div", { className: "se-dim" }, "Stops collecting and frees its memory. What it collected is kept for when you turn it back on." +
              (su.console_port ? " Wazuh's own console is at https://" + host + ":" + su.console_port + " (user admin; the password is on the server in data/siem/siem.env)." : "")),
            h("div", { className: "se-acts se-left" },
              h("button", { type: "button", className: "se-btn", disabled: busy === "off", onClick: function () {
                if (window.confirm("Turn the SIEM off? Nothing is collected while it is off.")) act("off", "/siem/off"); } }, busy === "off" ? "Asking…" : "Turn off"))));
      }

      return h("div", { className: "se-wrap" }, head,
        h("div", { className: "se-chips", role: "tablist" }, [["alerts", "Alerts"], ["sending", "Sending logs here"]].map(function (t) {
          return h("button", { key: t[0], type: "button", role: "tab", "aria-selected": tab === t[0], className: "se-chip" + (tab === t[0] ? " se-chip-on" : ""),
            onClick: function () { setTab(t[0]); setLoadErr(null); } }, t[1]); })),
        tab === "alerts" ? alertsTab() : sendingTab());
    }
    try { PLUGINS.register("suburban-siem", Siem); console.info(TAG, "registered"); }
    catch (e) { try { console.error(TAG, "register failed", e); } catch (e2) {} }
  });
})();
