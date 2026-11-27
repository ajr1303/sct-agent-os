(function () {
  "use strict";
  var TAG = "[suburban-devices]";
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
      if (!iso) return "never";
      try { return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); }
      catch (e) { return ""; }
    }
    // The next 11 PM on this computer's clock, as a full time with its offset.
    function tonight() {
      var d = new Date(); var today = d.getHours() < 23;
      if (!today) d.setDate(d.getDate() + 1);
      d.setHours(23, 0, 0, 0);
      function p(n) { return (n < 10 ? "0" : "") + n; }
      var off = -d.getTimezoneOffset(), sign = off < 0 ? "-" : "+"; off = Math.abs(off);
      return { label: today ? "Tonight at 11 PM" : "Tomorrow at 11 PM",
        iso: d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + "T23:00:00" + sign + p(Math.floor(off / 60)) + ":" + p(off % 60) };
    }
    var STATE = { ONLINE: "Online", OFFLINE: "Offline", REMOVED: "Removed from UniFi", UPDATING: "Updating", PENDING_ADOPTION: "Waiting to be adopted",
      GETTING_READY: "Starting up", ADOPTING: "Being adopted", DELETING: "Being removed", CONNECTION_INTERRUPTED: "Connection interrupted", ISOLATED: "Isolated" };
    function stateWord(s) { return STATE[s] || (s ? s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, " ") : "Unknown"); }
    var ACT = { restart_device: "Restart", update_firmware: "Firmware update", power_cycle_port: "Port power cycle" };
    var STATUS = { pending: "Waiting for your approval", approved: "Scheduled", running: "Running now", done: "Worked", failed: "Did not work",
      declined: "Not run", expired: "Lapsed" };

    function Devices() {
      var s;
      s = useState(null);  var d = s[0], setD = s[1];
      s = useState(null);  var err = s[0], setErr = s[1];
      s = useState(null);  var msg = s[0], setMsg = s[1];
      s = useState("");    var busy = s[0], setBusy = s[1];
      s = useState(false); var setup = s[0], setSetup = s[1];
      s = useState({});    var f = s[0], setF = s[1];
      s = useState(null);  var ask = s[0], setAsk = s[1];        // {id, action} waiting for the owner's choice of time
      s = useState("all"); var show = s[0], setShow = s[1];
      s = useState("");    var q = s[0], setQ = s[1];
      s = useState(60);    var cap = s[0], setCap = s[1];
      s = useState(null);  var add = s[0], setAdd = s[1];        // the Add a computer form: {name, os, base}
      s = useState(null);  var inst = s[0], setInst = s[1];      // the install command, shown once
      s = useState(false); var copied = s[0], setCopied = s[1];

      function load(quiet) {
        return api("/devices").then(function (x) { setD(x); if (!quiet) setErr(null); })
          .catch(function (e) { if (!quiet) setErr(String(e.message || e)); });
      }
      useEffect(function () { load(); }, []);
      var live = d && ((d.actions || []).some(function (a) { return a.status === "running" || a.status === "approved"; }) ||
        (d.computers || []).some(function (c) { return !c.last_seen; }));
      var fresh = d && d.unifi.connected && !(d.scan || {}).at;
      useEffect(function () {
        if (!live && !fresh) return;
        var t = setInterval(function () { load(true); }, fresh ? 3000 : 15000);
        return function () { clearInterval(t); };
      }, [live, fresh]);

      function call(name, path, opts) {
        setBusy(name); setErr(null); setMsg(null);
        return api(path, opts).then(function (x) { setBusy(""); if (x.devices) setD(x); if (x.message) setMsg(x.message); return x; })
          .catch(function (e) { setBusy(""); setErr(String(e.message || e)); return null; });
      }
      function connect() {
        call("connect", "/apps/unifi/connect", { method: "POST", body: JSON.stringify({ fields: f, access: "write" }) })
          .then(function (x) { if (x) { setSetup(false); setF({}); setMsg("UniFi is connected. Scanning your network now."); load(true); } });
      }
      function addComputer() {
        call("add", "/devices/computers", { method: "POST", body: JSON.stringify(add) })
          .then(function (x) { if (x && x.install) { setInst(x.install); setAdd(null); setCopied(false); } });
      }
      function copy(text) {
        try { navigator.clipboard.writeText(text).then(function () { setCopied(true); }); } catch (e) {}
      }
      function bar(label, pct, note) {
        if (pct === null || pct === undefined) return null;
        return h("div", { className: "dv-meter", key: label },
          h("div", { className: "dv-meter-top" }, h("span", null, label), h("span", null, Math.round(pct) + "%" + (note ? " · " + note : ""))),
          h("div", { className: "dv-track", role: "img", "aria-label": label + " " + Math.round(pct) + " percent" },
            h("div", { className: "dv-fill" + (pct >= 90 ? " dv-fill-bad" : (pct >= 75 ? " dv-fill-warn" : "")), style: { width: Math.min(100, Math.max(2, pct)) + "%" } })));
      }
      function computer(c) {
        var v = c.veeam;
        return h("div", { key: c.id, className: "dv-card dv-comp" + (c.problems.length ? " dv-comp-warn" : "") },
          h("div", { className: "dv-main" },
            h("span", { className: "dv-dot" + (c.reporting ? " dv-dot-on" : (c.last_seen ? " dv-dot-bad" : "")), "aria-hidden": "true" }),
            h("div", { className: "dv-meta" },
              h("div", { className: "dv-name" }, c.name, c.reboot_pending ? h("span", { className: "dv-badge" }, "Restart needed for updates") : null),
              h("div", { className: "dv-dim" }, [c.host && c.host.toLowerCase() !== c.name.toLowerCase() ? c.host : "", c.os_name || (c.os === "windows" ? "Windows" : "Linux"),
                c.uptime_days !== null ? "up " + c.uptime_days + " days" : "", c.last_seen ? "reported " + when(c.last_seen) : "no report yet"].filter(Boolean).join(" · "))),
            h("button", { type: "button", className: "dv-btn", disabled: busy === "rmc:" + c.id, onClick: function () {
              if (window.confirm("Remove " + c.name + " from My devices? Its reports are refused from then on.")) call("rmc:" + c.id, "/devices/computers/" + c.id, { method: "DELETE" }); } }, "Remove")),
          c.problems.length ? h("ul", { className: "dv-probs" }, c.problems.map(function (t, i) { return h("li", { key: i }, t); })) : null,
          c.last_seen ? h("div", { className: "dv-meters" },
            bar("CPU", c.cpu), bar("Memory", c.mem_pct, c.mem_gb ? c.mem_gb + " GB" : ""),
            c.disks.map(function (x) { return bar("Disk " + x.name, x.pct, x.free_gb + " GB free of " + x.size_gb); })) : null,
          v ? h("div", { className: "dv-veeam" },
            h("div", { className: "dv-lab" }, "Veeam backups" + (v.version ? " · agent " + v.version : "")),
            v.jobs.length ? v.jobs.map(function (j, i) {
              return h("div", { key: i, className: "dv-job" },
                h("span", { className: "dv-badge dv-badge-" + (j.result === "Success" ? "done" : (j.result === "Warning" ? "warn" : "failed")) }, j.result),
                h("span", { className: "dv-jobname" }, j.job),
                h("span", { className: "dv-dim" }, "last ran " + when(j.at) + (j.result !== "Success" && j.last_success && j.last_success !== j.at ? " · last completed " + when(j.last_success) : "") +
                  (j.result !== "Success" && j.detail ? " · " + j.detail : "")));
            }) : h("div", { className: "dv-dim" }, "No finished backup found yet.")) : null);
      }
      function addForm() {
        return h("div", { className: "dv-card" },
          h("div", { className: "dv-name" }, "Add a computer or server"),
          h("div", { className: "dv-dim" }, "You get one command to run on that machine. It installs a small task that sends its CPU, memory, disk and Veeam backup results here every 5 minutes. " +
            "It only reads, and Agent OS never logs in to the machine or stores a password for it."),
          h("label", { className: "dv-field" }, h("span", null, "Name to show"),
            h("input", { className: "dv-in", type: "text", placeholder: "Front office PC, Hyper-V host, NAS…", value: add.name,
              onChange: function (e) { setAdd(Object.assign({}, add, { name: e.target.value })); } })),
          h("fieldset", { className: "dv-pick" }, h("legend", null, "It runs"),
            ["windows", "linux"].map(function (o) { return h("label", { key: o },
              h("input", { type: "radio", name: "dv-os", checked: add.os === o, onChange: function () { setAdd(Object.assign({}, add, { os: o })); } }), o === "windows" ? " Windows" : " Linux"); })),
          h("label", { className: "dv-field" }, h("span", null, "Agent OS address, as that machine reaches it"),
            h("input", { className: "dv-in", type: "text", spellCheck: false, value: add.base,
              onChange: function (e) { setAdd(Object.assign({}, add, { base: e.target.value })); } })),
          h("div", { className: "dv-acts" },
            h("button", { type: "button", className: "dv-btn", onClick: function () { setAdd(null); } }, "Cancel"),
            h("button", { type: "button", className: "dv-btn dv-primary", disabled: busy === "add" || !add.name.trim(), onClick: addComputer }, busy === "add" ? "Adding…" : "Get the command")));
      }

      function act(dev, action, iso) {
        setAsk(null);
        call("act:" + dev.id, "/devices/" + dev.id + "/action", { method: "POST", body: JSON.stringify({ action: action, when: iso || "" }) });
      }

      if (!d && !err) return h("div", { className: "dv-wrap" }, h("div", { className: "dv-dim" }, "Loading your devices…"));
      if (!d) return h("div", { className: "dv-wrap" }, h("div", { className: "dv-msg dv-bad" }, err));

      var u = d.unifi, scan = d.scan || {}, all = d.devices || [];
      var gear = all.filter(function (x) { return x.kind === "network"; });
      var clients = all.filter(function (x) { return x.kind === "client"; });
      var updates = gear.filter(function (x) { return x.updatable; }).length;
      var down = gear.filter(function (x) { return x.state !== "ONLINE"; }).length;
      var canAct = u.access === "write";
      var comps = d.computers || [];
      var trouble = comps.filter(function (c) { return c.problems.length; }).length;
      var open = {};      // device "site/id" -> its action in progress or waiting
      (d.actions || []).forEach(function (a) { if (!open[a.device] && (a.status === "running" || a.status === "approved" || a.status === "pending")) open[a.device] = a; });

      function form() {
        return h("div", { className: "dv-card" },
          h("div", { className: "dv-name" }, u.connected ? "Change the UniFi login" : "Connect UniFi Network"),
          h("div", { className: "dv-dim" }, "Agent OS reads your gateway, switches, access points and everything connected to them, and keeps this page current."),
          h("ol", { className: "dv-steps" }, u.steps.map(function (t, i) { return h("li", { key: i }, t); })),
          u.fields.map(function (fl) {
            return h("label", { key: fl.key, className: "dv-field" },
              h("span", null, fl.label),
              h("input", { className: "dv-in", type: fl.secret ? "password" : "text", autoComplete: "off", spellCheck: false,
                placeholder: u.connected && fl.secret ? "Leave blank to keep the saved one" : (fl.placeholder || ""), value: f[fl.key] || "",
                onChange: function (e) { var n = Object.assign({}, f); n[fl.key] = e.target.value; setF(n); } }));
          }),
          h("div", { className: "dv-dim" }, "The key is checked with your controller before it is saved, stored encrypted on this box, and never shown again. " +
            "Agents can look, but a restart or update only runs when you press it here or approve it."),
          h("div", { className: "dv-acts" },
            u.connected ? h("button", { type: "button", className: "dv-btn", onClick: function () { setSetup(false); setF({}); } }, "Cancel") : null,
            h("button", { type: "button", className: "dv-btn dv-primary", disabled: busy === "connect", onClick: connect },
              busy === "connect" ? "Checking…" : (u.connected ? "Save" : "Connect"))));
      }

      function gearRow(x) {
        var a = open[x.ext_id], asking = ask && ask.id === x.id, tn = tonight();
        var online = x.state === "ONLINE";
        return h("div", { key: x.id, className: "dv-row" + (online ? "" : " dv-row-off") },
          h("div", { className: "dv-main" },
            h("span", { className: "dv-dot" + (online ? " dv-dot-on" : (x.state === "REMOVED" ? "" : " dv-dot-bad")), "aria-hidden": "true" }),
            h("div", { className: "dv-meta" },
              h("div", { className: "dv-name" }, x.name, x.updatable ? h("span", { className: "dv-badge" }, "Update waiting") : null),
              h("div", { className: "dv-dim" }, [x.model, x.ip, stateWord(x.state), x.firmware ? "firmware " + x.firmware : ""].filter(Boolean).join(" · "))),
            a ? h("div", { className: "dv-prog" },
                h("span", null, ACT[a.action] + ": " + (a.status === "approved" ? "scheduled for " + (a.run_at_words || when(a.run_at)) :
                  (a.status === "pending" ? "an agent asked; see Needs you on Tasks" : "running, checking it comes back…"))),
                a.status === "approved" ? h("button", { type: "button", className: "dv-btn", disabled: busy === "cancel:" + a.id,
                  onClick: function () { call("cancel:" + a.id, "/devices/actions/" + a.id + "/cancel", { method: "POST" }); } }, "Cancel") : null)
              : (canAct && online && !asking ? h("div", { className: "dv-acts" },
                  x.updatable ? h("button", { type: "button", className: "dv-btn dv-primary", disabled: busy === "act:" + x.id,
                    onClick: function () { setAsk({ id: x.id, action: "update" }); } }, "Update") : null,
                  h("button", { type: "button", className: "dv-btn", disabled: busy === "act:" + x.id,
                    onClick: function () { setAsk({ id: x.id, action: "restart" }); } }, "Restart")) : null)),
          asking ? h("div", { className: "dv-ask", role: "group", "aria-label": "Confirm" },
            h("div", null, ask.action === "update"
              ? "Install the firmware update on " + x.name + "? It restarts, and everything connected through it is offline for several minutes."
              : "Restart " + x.name + "? Everything connected through it drops for a few minutes."),
            h("div", { className: "dv-acts dv-left" },
              h("button", { type: "button", className: "dv-btn dv-primary", onClick: function () { act(x, ask.action, tn.iso); } }, tn.label),
              h("button", { type: "button", className: "dv-btn", onClick: function () { act(x, ask.action, ""); } }, "Do it now"),
              h("button", { type: "button", className: "dv-btn", onClick: function () { setAsk(null); } }, "Cancel"))) : null);
      }

      var ql = q.trim().toLowerCase();
      var shown = clients.filter(function (c) {
        if (show === "online" && c.state !== "ONLINE") return false;
        if (show === "wired" && c.link !== "wired") return false;
        if (show === "wifi" && c.link !== "wireless") return false;
        return !ql || (c.name + " " + c.ip + " " + c.mac).toLowerCase().indexOf(ql) >= 0;
      });
      var chips = [["all", "All"], ["online", "Online now"], ["wired", "Wired"], ["wifi", "Wi-Fi"]];

      return h("div", { className: "dv-wrap" },
        h("div", { className: "dv-h1" }, "My devices"),
        h("div", { className: "dv-sub" }, "Your computers, servers and backups, and your network gear with everything connected to it, in one place."),
        msg ? h("div", { className: "dv-msg dv-good", role: "status" }, msg) : null,
        err ? h("div", { className: "dv-msg dv-bad", role: "alert" }, err) : null,
        h("div", { className: "dv-bar" },
          h("div", { className: "dv-h2 dv-h2-flat" }, "Computers and servers (" + comps.length + ")" + (trouble ? " · " + trouble + " need a look" : "")),
          add ? null : h("button", { type: "button", className: "dv-btn", onClick: function () { setInst(null); setAdd({ name: "", os: "windows", base: window.location.origin }); } }, "Add a computer")),
        add ? addForm() : null,
        inst ? h("div", { className: "dv-card dv-inst" },
          h("div", { className: "dv-name" }, "Run this once on " + inst.name),
          h("div", { className: "dv-dim" }, "Paste it into " + inst.where + ". It is shown only this once; if you lose it, remove the computer and add it again."),
          h("pre", { className: "dv-cmd" }, inst.command),
          h("div", { className: "dv-acts dv-left" },
            h("button", { type: "button", className: "dv-btn dv-primary", onClick: function () { copy(inst.command); } }, copied ? "Copied" : "Copy command"),
            h("button", { type: "button", className: "dv-btn", onClick: function () { setInst(null); } }, "Done"))) : null,
        comps.length ? h("div", { className: "dv-comps" }, comps.map(computer))
          : (add || inst ? null : h("div", { className: "dv-dim" }, "None yet. Add a computer to see its CPU, memory, disk space and Veeam backups here.")),
        u.connected ? h("div", { className: "dv-h2" }, "Network") : null,
        (!u.connected || setup) ? form() : null,
        u.connected ? h("div", { className: "dv-stats" },
          [[gear.length, "Network devices"], [down, "Not online"], [updates, "Updates waiting"], [clients.filter(function (c) { return c.state === "ONLINE"; }).length, "Connected now"]]
            .map(function (t, i) { return h("div", { key: i, className: "dv-stat" + (i && i < 3 && t[0] ? " dv-stat-warn" : "") },
              h("div", { className: "dv-num" }, t[0]), h("div", { className: "dv-lab" }, t[1])); })) : null,
        u.connected ? h("div", { className: "dv-bar" },
          h("span", { className: "dv-dim" }, (u.connected_as || "UniFi") + " · " + (scan.at ? "scanned " + when(scan.at) : "first scan running…") +
            (scan.at && !scan.ok ? " · the last scan failed: " + (scan.note || "no answer") : "")),
          h("div", { className: "dv-acts" },
            h("button", { type: "button", className: "dv-btn", disabled: busy === "scan", onClick: function () { call("scan", "/devices/scan", { method: "POST" }); } },
              busy === "scan" ? "Scanning…" : "Scan now"),
            !canAct ? h("button", { type: "button", className: "dv-btn", onClick: function () {
              call("acc", "/apps/unifi/access", { method: "POST", body: JSON.stringify({ access: "write" }) }).then(function () { load(true); }); } }, "Allow changes") : null,
            h("button", { type: "button", className: "dv-btn", onClick: function () { setSetup(!setup); setF({}); } }, "Change login"),
            h("button", { type: "button", className: "dv-btn", disabled: busy === "rm", onClick: function () {
              if (window.confirm("Disconnect UniFi? This list is cleared and agents lose access. Nothing changes on your network."))
                call("rm", "/apps/unifi", { method: "DELETE" }).then(function () { load(true); }); } }, "Disconnect"))) : null,
        u.connected ? h("div", { className: "dv-h2" }, "Network gear") : null,
        u.connected ? (gear.length ? h("div", { className: "dv-list" }, gear.map(gearRow))
          : h("div", { className: "dv-dim" }, scan.at ? "UniFi reported no gateways, switches or access points." : "Scanning…")) : null,
        u.connected ? h("div", { className: "dv-h2" }, "Connected to your network (" + clients.length + ")") : null,
        u.connected && clients.length ? h("div", { className: "dv-bar" },
          h("input", { className: "dv-in dv-search", type: "search", placeholder: "Search name, address or MAC", "aria-label": "Search connected devices", value: q,
            onChange: function (e) { setQ(e.target.value); } }),
          h("div", { className: "dv-chips", role: "group", "aria-label": "Filter" }, chips.map(function (c) {
            return h("button", { key: c[0], type: "button", className: "dv-chip" + (show === c[0] ? " dv-chip-on" : ""), "aria-pressed": show === c[0],
              onClick: function () { setShow(c[0]); } }, c[1]); }))) : null,
        u.connected && clients.length ? h("div", { className: "dv-list" }, shown.slice(0, cap).map(function (c) {
          var on = c.state === "ONLINE";
          return h("div", { key: c.id, className: "dv-row dv-row-sm" + (on ? "" : " dv-row-off") },
            h("div", { className: "dv-main" },
              h("span", { className: "dv-dot" + (on ? " dv-dot-on" : ""), "aria-hidden": "true" }),
              h("div", { className: "dv-meta" }, h("div", { className: "dv-name" }, c.name),
                h("div", { className: "dv-dim" }, [c.ip, c.mac, c.link === "wireless" ? "Wi-Fi" : (c.link === "wired" ? "Wired" : c.link),
                  on ? "online" : "last seen " + when(c.last_seen), "first seen " + when(c.first_seen)].filter(Boolean).join(" · ")))));
        })) : null,
        u.connected && shown.length > cap ? h("button", { type: "button", className: "dv-btn dv-more", onClick: function () { setCap(cap + 200); } },
          "Show more (" + (shown.length - cap) + " left)") : null,
        u.connected && clients.length && !shown.length ? h("div", { className: "dv-dim" }, "Nothing matches.") : null,
        (d.actions || []).length ? h("div", { className: "dv-h2" }, "Restarts and updates, last 7 days") : null,
        (d.actions || []).length ? h("div", { className: "dv-list" }, d.actions.map(function (a) {
          return h("div", { key: a.id, className: "dv-row dv-row-sm" + (a.status === "failed" ? " dv-row-bad" : "") },
            h("div", { className: "dv-main" }, h("div", { className: "dv-meta" },
              h("div", { className: "dv-name" }, ACT[a.action] + " · " + a.target, h("span", { className: "dv-badge dv-badge-" + a.status }, STATUS[a.status] || a.status)),
              h("div", { className: "dv-dim" }, [a.agent === "You" ? "Started by you" : "Asked by " + (a.agent || "an agent") + ": " + a.why,
                a.result, a.finished_at ? when(a.finished_at) : ""].filter(Boolean).join(" · ")))));
        })) : null);
    }
    try { PLUGINS.register("suburban-devices", Devices); console.info(TAG, "registered"); }
    catch (e) { try { console.error(TAG, "register failed", e); } catch (e2) {} }
  });
})();
