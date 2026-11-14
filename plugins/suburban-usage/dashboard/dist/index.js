(function () {
  "use strict";
  var TAG = "[suburban-usage]";
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
          if (!r.ok) throw new Error((j && (j.error || j.detail)) || ("HTTP " + r.status));
          return j;
        });
      });
    }
    function dur(s) {
      s = Math.max(0, Math.round(s || 0));
      var d = Math.floor(s / 86400), hh = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
      if (d) return d + " d " + hh + " h";
      if (hh) return hh + " h " + m + " min";
      return m + " min";
    }
    function when(iso) { try { return new Date(iso).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" }); } catch (e) { return ""; } }
    function money(n) { return "$" + (n < 10 ? n.toFixed(2) : n.toFixed(0)); }

    function Usage() {
      var s;
      s = useState(null);  var data = s[0], setData = s[1];
      s = useState(null);  var err = s[0], setErr = s[1];
      s = useState(null);  var edit = s[0], setEdit = s[1];      // provider id being set up
      s = useState({ key: "", plan_name: "", monthly_price: "" }); var f = s[0], setF = s[1];
      s = useState(false); var busy = s[0], setBusy = s[1];
      s = useState(null);  var ferr = s[0], setFerr = s[1];

      function load() { return api("/usage").then(function (d) { setData(d); setErr(null); }).catch(function (e) { setErr(String(e.message || e)); }); }
      useEffect(function () { load(); var t = setInterval(load, 60000); return function () { clearInterval(t); }; }, []);

      function startEdit(p) { setEdit(p.id); setFerr(null); setF({ key: "", plan_name: p.plan_name || "", monthly_price: p.monthly_price != null ? String(p.monthly_price) : "" }); }
      function save(e) {
        e.preventDefault(); setBusy(true); setFerr(null);
        var body = { plan_name: f.plan_name };
        if (f.key.trim()) body.key = f.key.trim();
        if (f.monthly_price !== "") body.monthly_price = Number(f.monthly_price);
        api("/usage/" + edit, { method: "PUT", body: JSON.stringify(body) })
          .then(function () { setBusy(false); setEdit(null); return load(); })
          .catch(function (e2) { setBusy(false); setFerr(String(e2.message || e2)); });
      }
      function set(k) { return function (e) { var n = Object.assign({}, f); n[k] = e.target.value; setF(n); }; }

      function bar(label, w) {
        if (!w) return null;
        var lvl = w.remaining_percent <= 10 ? "su-bad" : (w.on_pace_to_run_out || w.remaining_percent <= 25) ? "su-warn" : "su-ok";
        return h("div", { className: "su-win " + lvl },
          h("div", { className: "su-win-top" },
            h("span", { className: "su-win-name" }, label),
            h("span", { className: "su-win-num" }, h("b", null, w.remaining_percent + "%"), " left · " + w.used_percent + "% used")),
          h("div", { className: "su-track", role: "progressbar", "aria-valuenow": w.used_percent, "aria-valuemin": 0, "aria-valuemax": 100, "aria-label": label + " used" },
            h("div", { className: "su-fill", style: { width: Math.min(100, w.used_percent) + "%" } })),
          h("div", { className: "su-win-sub" }, "Resets in " + dur(w.resets_in_seconds) + " (" + when(w.resets_at) + ")",
            w.on_pace_to_run_out
              ? h("span", { className: "su-flag" }, " · At this week's pace it runs out in about " + dur(w.runs_out_in_seconds) + ", before the reset.")
              : (w.runs_out_in_seconds != null ? " · On pace to last until the reset." : "")));
      }
      function form(p) {
        return h("form", { className: "su-form", onSubmit: save },
          h("label", { className: "su-field" }, h("span", null, p.configured ? "Replace the key (leave empty to keep it)" : "Plan key"),
            h("input", { className: "su-in", type: "password", autoComplete: "off", value: f.key, onChange: set("key"),
              placeholder: "The plan's Subscription Key" })),
          h("div", { className: "su-row" },
            h("label", { className: "su-field" }, h("span", null, "Plan name"),
              h("input", { className: "su-in", value: f.plan_name, maxLength: 80, onChange: set("plan_name"), placeholder: "e.g. M Plan Explore" })),
            h("label", { className: "su-field" }, h("span", null, "Price per month (USD)"),
              h("input", { className: "su-in", type: "number", min: "0", step: "0.01", value: f.monthly_price, onChange: set("monthly_price"), placeholder: "optional" }))),
          ferr ? h("div", { className: "su-msg" }, ferr) : null,
          h("div", { className: "su-acts" },
            h("span", { className: "su-hint" }, "The key is checked with the provider, stored encrypted on this server, and never shown again."),
            h("button", { type: "button", className: "su-btn", onClick: function () { setEdit(null); } }, "Cancel"),
            h("button", { type: "submit", className: "su-btn su-primary", disabled: busy || (!p.configured && !f.key.trim()) }, busy ? "Checking…" : "Save")));
      }
      function card(p) {
        var u = p.usage, runs = data && data.runs;
        var per = (p.monthly_price && runs && runs.total) ? (p.monthly_price * (runs.days / 30)) / runs.total : null;
        return h("div", { key: p.id, className: "su-card" },
          h("div", { className: "su-card-h" },
            h("div", null,
              h("div", { className: "su-name" }, p.label),
              h("div", { className: "su-plan" }, !p.supported ? "Usage not connected yet" : p.configured ? ((p.plan_name || "Plan") + (p.monthly_price ? " · " + money(p.monthly_price) + " a month" : "")) : "Not set up")),
            edit === p.id || !p.supported ? null : h("button", { type: "button", className: "su-btn", onClick: function () { startEdit(p); } }, p.configured ? "Edit" : "Set up")),
          p.agents && p.agents.length ? h("div", { className: "su-agents" },
            h("span", { className: "su-agents-l" }, p.agents.length + (p.agents.length === 1 ? " agent" : " agents") + " on this provider: "),
            p.agents.map(function (a, i) { return h("span", { key: a.name }, (i ? ", " : "") + a.name, a.model ? h("span", { className: "su-dim" }, " (" + a.model + ")") : null); })) : null,
          !p.supported ? h("div", { className: "su-empty" }, "Live usage for " + p.label + " isn't connected in this version, so there are no figures to show yet. The agents above were read from each agent's own Hermes.") : null,
          edit === p.id ? form(p) : null,
          p.supported && !p.configured && edit !== p.id ? h("div", { className: "su-empty" }, "Add this plan's key to see how much is used and what is left.") : null,
          p.configured && u && !u.ok ? h("div", { className: "su-msg" }, u.error) : null,
          p.configured && u && u.ok ? u.groups.map(function (g) {
            return h("div", { key: g.name, className: "su-group" },
              u.groups.length > 1 ? h("div", { className: "su-gname" }, g.name) : null,
              bar("This 5-hour window", g.five_hour), bar("This week", g.weekly));
          }) : null,
          p.configured && u && u.ok ? h("div", { className: "su-foot" },
            per != null ? h("span", null, "About " + money(per) + " per agent run over the last " + runs.days + " days (" + runs.total + " runs). ") : null,
            h("span", null, "When a window runs out, every agent on this plan stops until it resets. Checked " + when(u.checked_at) + ".")) : null);
      }
      return h("div", { className: "su-wrap" },
        h("div", { className: "su-h1" }, "Usage"),
        h("div", { className: "su-sub" }, "How much of your AI plan the team has used, what is left, and when it resets. Read live from the provider."),
        err ? h("div", { className: "su-msg" }, err) : null,
        data == null ? h("div", { className: "su-empty" }, "Loading…")
          : (data.providers || []).length === 0 ? h("div", { className: "su-empty" }, "No agent has reported an AI provider yet. A card appears here for each provider your agents use, within about half an hour of an agent being added.")
          : h("div", { className: "su-cards" }, (data.providers || []).map(card)));
    }
    try { PLUGINS.register("suburban-usage", Usage); console.info(TAG, "registered"); }
    catch (e) { try { console.error(TAG, "register failed", e); } catch (e2) {} }
  });
})();
