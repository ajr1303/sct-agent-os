(function () {
  "use strict";
  var TAG = "[suburban-connections]";
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
    function initials(label) { return (label || "?").replace(/[^A-Za-z0-9 ]/g, "").split(" ").map(function (w) { return w[0]; }).join("").slice(0, 2).toUpperCase(); }

    function Connections() {
      var s;
      s = useState(null);  var d = s[0], setD = s[1];
      s = useState(null);  var err = s[0], setErr = s[1];
      s = useState(null);  var msg = s[0], setMsg = s[1];
      s = useState("");    var busy = s[0], setBusy = s[1];
      s = useState(null);  var open = s[0], setOpen = s[1];       // app id whose form is open
      s = useState({});    var f = s[0], setF = s[1];
      s = useState("write"); var access = s[0], setAccess = s[1];
      s = useState("all"); var cat = s[0], setCat = s[1];
      s = useState("");    var q = s[0], setQ = s[1];

      function load() { return api("/apps").then(function (x) { setD(x); setErr(null); }).catch(function (e) { setErr(String(e.message || e)); }); }
      useEffect(function () { load(); }, []);

      function call(name, path, opts) {
        setBusy(name); setErr(null); setMsg(null);
        return api(path, opts).then(function (x) { setBusy(""); setD(x); if (x.message) setMsg(x.message); return x; })
          .catch(function (e) { setBusy(""); setErr(String(e.message || e)); return null; });
      }
      function startConnect(a) {
        setOpen(a.id); setF({}); setErr(null); setMsg(null);
        setAccess(a.read_only || !a.has_writes ? "read" : (a.access || "write"));
      }
      function submit(a) {
        call("connect:" + a.id, "/apps/" + a.id + "/connect", { method: "POST", body: JSON.stringify({ fields: f, access: access }) })
          .then(function (x) { if (x) { setOpen(null); setF({}); } });
      }

      if (!d && !err) return h("div", { className: "cx-wrap" }, h("div", { className: "cx-dim" }, "Loading connections…"));
      if (!d) return h("div", { className: "cx-wrap" }, h("div", { className: "cx-msg cx-bad" }, err));

      var apps = d.apps || [];
      var cats = ["all"].concat(apps.map(function (a) { return a.category; }).filter(function (c, i, l) { return l.indexOf(c) === i; }));
      var connected = apps.filter(function (a) { return a.connected; });
      var ql = q.trim().toLowerCase();
      var shown = apps.filter(function (a) {
        if (cat !== "all" && a.category !== cat) return false;
        return !ql || (a.label + " " + a.about + " " + a.category).toLowerCase().indexOf(ql) >= 0;
      });

      function form(a) {
        return h("div", { className: "cx-form" },
          h("ol", { className: "cx-steps" }, a.steps.map(function (t, i) { return h("li", { key: i }, t); })),
          a.fields.map(function (fl) {
            return h("label", { key: fl.key, className: "cx-field" },
              h("span", null, fl.label + (fl.optional ? " (optional)" : "")),
              h("input", { className: "cx-in", type: fl.secret ? "password" : "text", autoComplete: "off", spellCheck: false,
                placeholder: a.connected && fl.secret ? "Leave blank to keep the saved one" : (fl.placeholder || ""),
                value: f[fl.key] || "",
                onChange: function (e) { var n = Object.assign({}, f); n[fl.key] = e.target.value; setF(n); } }));
          }),
          a.has_writes && !a.read_only ? h("fieldset", { className: "cx-access" },
            h("legend", null, "What agents may do"),
            h("label", null, h("input", { type: "radio", name: "acc-" + a.id, checked: access === "write", onChange: function () { setAccess("write"); } }),
              " Read and make changes (" + a.actions.filter(function (x) { return x.write; }).map(function (x) { return x.name.replace(/_/g, " "); }).join(", ") + ")"),
            h("label", null, h("input", { type: "radio", name: "acc-" + a.id, checked: access === "read", onChange: function () { setAccess("read"); } }),
              " Read only")) : h("div", { className: "cx-dim" }, "Agents can only read from " + a.label + "."),
          h("div", { className: "cx-dim" }, "The login is checked with " + a.label + " before it is saved, stored encrypted on this box, and never shown again. " +
            (d.n8n_connected ? "It is also saved in n8n so workflows can use it." : "Connect n8n on the Automations page to have it saved there too.")),
          h("div", { className: "cx-acts" },
            h("button", { type: "button", className: "cx-btn", onClick: function () { setOpen(null); setF({}); } }, "Cancel"),
            h("button", { type: "button", className: "cx-btn cx-primary", disabled: busy === "connect:" + a.id,
              onClick: function () { submit(a); } }, busy === "connect:" + a.id ? "Checking…" : (a.connected ? "Save" : "Connect"))));
      }

      function card(a) {
        var isOpen = open === a.id;
        return h("div", { key: a.id, className: "cx-card" + (a.connected ? " cx-on" : "") + (isOpen ? " cx-open" : "") },
          h("div", { className: "cx-top" },
            h("div", { className: "cx-logo", "aria-hidden": "true" }, initials(a.label)),
            h("div", { className: "cx-meta" },
              h("div", { className: "cx-name" }, a.label),
              h("div", { className: "cx-cat" }, a.category)),
            a.connected ? h("span", { className: "cx-badge" }, a.access === "read" ? "Connected · read only" : "Connected") : null),
          h("div", { className: "cx-about" }, a.about),
          a.connected ? h("div", { className: "cx-dim" }, "As " + (a.connected_as || "?") + " · last used " + when(a.last_used_at) +
            (a.in_n8n ? " · in n8n" : "")) : null,
          a.connected && a.n8n_note && !a.in_n8n ? h("div", { className: "cx-dim" }, a.n8n_note) : null,
          isOpen ? form(a) : h("div", { className: "cx-acts cx-left" },
            a.connected ? [
              h("button", { key: "t", type: "button", className: "cx-btn", disabled: busy === "test:" + a.id,
                onClick: function () { call("test:" + a.id, "/apps/" + a.id + "/test", { method: "POST" }); } }, busy === "test:" + a.id ? "Testing…" : "Test"),
              a.has_writes && !a.read_only ? h("button", { key: "a", type: "button", className: "cx-btn", disabled: busy === "acc:" + a.id,
                onClick: function () { call("acc:" + a.id, "/apps/" + a.id + "/access", { method: "POST", body: JSON.stringify({ access: a.access === "read" ? "write" : "read" }) }); } },
                a.access === "read" ? "Allow changes" : "Make read only") : null,
              h("button", { key: "e", type: "button", className: "cx-btn", onClick: function () { startConnect(a); } }, "Change login"),
              h("button", { key: "x", type: "button", className: "cx-btn", disabled: busy === "rm:" + a.id,
                onClick: function () { if (window.confirm("Disconnect " + a.label + "? Agents and n8n lose access. Nothing changes in " + a.label + ".")) call("rm:" + a.id, "/apps/" + a.id, { method: "DELETE" }); } }, "Disconnect")
            ] : h("button", { type: "button", className: "cx-btn cx-primary", onClick: function () { startConnect(a); } }, "Connect")));
      }

      return h("div", { className: "cx-wrap" },
        h("div", { className: "cx-h1" }, "Connections"),
        h("div", { className: "cx-sub" }, "Connect a business app once and every agent, Chat and n8n can use it. " +
          connected.length + " of " + apps.length + " connected."),
        msg ? h("div", { className: "cx-msg cx-good", role: "status" }, msg) : null,
        err ? h("div", { className: "cx-msg cx-bad", role: "alert" }, err) : null,
        h("div", { className: "cx-bar" },
          h("input", { className: "cx-in cx-search", type: "search", placeholder: "Search apps", "aria-label": "Search apps", value: q,
            onChange: function (e) { setQ(e.target.value); } }),
          h("div", { className: "cx-chips", role: "group", "aria-label": "Filter by category" }, cats.map(function (c) {
            return h("button", { key: c, type: "button", className: "cx-chip" + (cat === c ? " cx-chip-on" : ""), "aria-pressed": cat === c,
              onClick: function () { setCat(c); } }, c === "all" ? "All" : c);
          }))),
        h("div", { className: "cx-grid" }, shown.map(card)),
        shown.length ? null : h("div", { className: "cx-dim" }, "No app matches."),
        h("div", { className: "cx-h2" }, "Coming with one-click sign-in"),
        h("div", { className: "cx-grid" }, (d.coming || []).map(function (c) {
          return h("div", { key: c.id, className: "cx-card cx-soon" },
            h("div", { className: "cx-top" },
              h("div", { className: "cx-logo", "aria-hidden": "true" }, initials(c.label)),
              h("div", { className: "cx-meta" }, h("div", { className: "cx-name" }, c.label), h("div", { className: "cx-cat" }, c.category)),
              h("span", { className: "cx-badge cx-badge-soon" }, "Coming")),
            h("div", { className: "cx-about" }, c.about),
            h("div", { className: "cx-dim" }, c.today));
        })),
        (d.activity || []).length ? h("div", { className: "cx-h2" }, "Recent use") : null,
        (d.activity || []).length ? h("div", { className: "cx-log" }, d.activity.slice(0, 25).map(function (x, i) {
          return h("div", { key: i, className: "cx-row" + (x.ok ? "" : " cx-row-bad") },
            h("span", { className: "cx-when" }, when(x.at)),
            h("span", null, (x.who || "agent") + " · " + x.app + " · " + x.action.replace(/_/g, " ") + (x.write ? " (change)" : "")),
            (x.ok && !x.note) ? null : h("span", { className: "cx-why" }, x.note || "failed"));
        })) : null);
    }
    try { PLUGINS.register("suburban-connections", Connections); console.info(TAG, "registered"); }
    catch (e) { try { console.error(TAG, "register failed", e); } catch (e2) {} }
  });
})();
