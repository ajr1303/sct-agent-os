(function () {
  "use strict";
  var TAG = "[suburban-bookings]";

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

    function whenStr(iso) {
      try {
        var d = new Date(iso);
        if (isNaN(d.getTime())) return iso || "";
        var now = new Date();
        var opts = { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };
        if (d.getFullYear() !== now.getFullYear()) opts.year = "numeric";
        return d.toLocaleString(undefined, opts);
      } catch (e) { return iso || ""; }
    }

    function Bookings() {
      var s;
      s = useState(null);  var providers = s[0], setProviders = s[1];
      s = useState([]);    var accounts = s[0], setAccounts = s[1];
      s = useState(null);  var summary = s[0], setSummary = s[1];
      s = useState("");    var provider = s[0], setProvider = s[1];
      s = useState({});    var vals = s[0], setVals = s[1];
      s = useState("");    var label = s[0], setLabel = s[1];
      s = useState(false); var busy = s[0], setBusy = s[1];
      s = useState(null);  var err = s[0], setErr = s[1];
      s = useState(null);  var ok = s[0], setOk = s[1];
      s = useState(false); var showForm = s[0], setShowForm = s[1];
      s = useState(null);  var confirmId = s[0], setConfirmId = s[1];

      function refresh() {
        api("/bookings/accounts").then(setAccounts).catch(function () {});
        api("/bookings/summary").then(setSummary).catch(function () {});
      }
      useEffect(function () {
        api("/bookings/providers").then(function (p) {
          setProviders(p);
          var keys = Object.keys(p || {});
          if (keys.length) setProvider(keys[0]);
        }).catch(function (e) { setErr("Connector service unavailable: " + (e.message || e)); });
        refresh();
        var t = setInterval(function () { api("/bookings/summary").then(setSummary).catch(function () {}); }, 60000);
        return function () { clearInterval(t); };
      }, []);

      function onProvider(key) { setProvider(key); setVals({}); setErr(null); }
      function setField(k, v) { var n = Object.assign({}, vals); n[k] = v; setVals(n); }

      function submit(e) {
        if (e) e.preventDefault();
        setErr(null); setOk(null);
        var meta = providers && providers[provider];
        if (!meta) { setErr("Pick a provider."); return; }
        for (var i = 0; i < meta.fields.length; i++) {
          var f = meta.fields[i];
          if (!(vals[f.key] || "").trim()) { setErr(f.label + " is required."); return; }
        }
        setBusy(true);
        api("/bookings/accounts", { method: "POST", body: JSON.stringify({ label: label, provider: provider, fields: vals }) })
          .then(function () { setBusy(false); setOk("Booking account connected."); setVals({}); setLabel(""); setShowForm(false); refresh(); })
          .catch(function (e2) { setBusy(false); setErr(String(e2.message || e2)); });
      }

      function del(id) { setConfirmId(null); api("/bookings/accounts/" + id, { method: "DELETE" }).then(refresh).catch(function () {}); }

      function acctSummary(id) {
        if (!summary || !summary.accounts) return null;
        for (var i = 0; i < summary.accounts.length; i++) if (summary.accounts[i].id === id) return summary.accounts[i];
        return null;
      }

      var provKeys = providers ? Object.keys(providers) : [];
      var meta = providers && providers[provider];
      var nextUp = summary && summary.next ? summary.next : [];

      function field(lbl, node) { return h("label", { className: "sb-field", key: lbl }, h("span", { className: "sb-flabel" }, lbl), node); }

      var form = !showForm ? null : h("form", { className: "sb-form", onSubmit: submit },
        h("div", { className: "sb-form-grid" },
          field("Provider", h("select", { className: "sb-input", value: provider, onChange: function (e) { onProvider(e.target.value); } },
            provKeys.map(function (k) { return h("option", { key: k, value: k }, providers[k].label); }))),
          field("Name (optional)", h("input", { className: "sb-input", value: label, placeholder: "e.g. Clinic calendar",
            onChange: function (e) { setLabel(e.target.value); } })),
          (meta ? meta.fields : []).map(function (f) {
            return field(f.label, h("input", {
              className: "sb-input", type: f.type === "password" ? "password" : "text",
              value: vals[f.key] || "", placeholder: f.placeholder || "",
              autoComplete: f.type === "password" ? "new-password" : "off",
              onChange: function (e) { setField(f.key, e.target.value); }
            }));
          })
        ),
        meta && meta.hint ? h("div", { className: "sb-hint" }, meta.hint) : null,
        err ? h("div", { className: "sb-msg sb-err" }, err) : null,
        h("div", { className: "sb-form-actions" },
          h("button", { type: "button", className: "sb-btn sb-ghost", onClick: function () { setShowForm(false); setErr(null); } }, "Cancel"),
          h("button", { type: "submit", className: "sb-btn sb-primary", disabled: busy }, busy ? "Connecting…" : "Connect")));

      var list = (accounts || []).map(function (a) {
        var sm = acctSummary(a.id);
        var up = sm && sm.upcoming ? sm.upcoming : [];
        var aerr = sm && sm.error ? sm.error : null;
        return h("div", { className: "sb-card", key: a.id },
          h("div", { className: "sb-card-head" },
            h("div", { className: "sb-card-id" },
              h("div", { className: "sb-card-label" }, a.label),
              h("div", { className: "sb-card-prov" }, a.provider_label || a.provider)),
            h("div", { className: "sb-card-right" },
              aerr ? h("span", { className: "sb-badge sb-badge-err", title: aerr }, "error")
                : h("span", { className: "sb-badge" }, up.length + " upcoming"),
              confirmId === a.id
                ? h("span", { className: "sb-confirm" },
                    h("button", { className: "sb-x", onClick: function () { del(a.id); } }, "Remove"),
                    h("button", { className: "sb-x sb-x-mut", onClick: function () { setConfirmId(null); } }, "Cancel"))
                : h("button", { className: "sb-iconbtn", title: "Remove", onClick: function () { setConfirmId(a.id); } }, "✕"))),
          aerr ? h("div", { className: "sb-card-err" }, aerr)
            : up.length === 0
              ? h("div", { className: "sb-card-empty" }, "No upcoming appointments.")
              : h("div", { className: "sb-appts" }, up.map(function (ev, i) {
                  return h("div", { className: "sb-appt", key: i },
                    h("div", { className: "sb-appt-when" }, whenStr(ev.start)),
                    h("div", { className: "sb-appt-title" }, ev.title),
                    h("div", { className: "sb-appt-who" }, ev.who || ""));
                })));
      });

      return h("div", { className: "sb-wrap" },
        h("div", { className: "sb-top" },
          h("div", null,
            h("div", { className: "sb-h1" }, "Bookings"),
            h("div", { className: "sb-sub" }, "Connect your scheduling app so agents can see what's on the calendar.")),
          h("button", { className: "sb-btn sb-primary", onClick: function () { setShowForm(!showForm); setErr(null); setOk(null); } },
            showForm ? "Close" : "+ Connect a booking app")),
        ok ? h("div", { className: "sb-msg sb-ok" }, ok) : null,
        form,
        nextUp.length > 0 ? h("div", { className: "sb-next" },
          h("div", { className: "sb-next-h" }, "NEXT UP"),
          nextUp.slice(0, 6).map(function (ev, i) {
            return h("div", { className: "sb-next-row", key: i },
              h("span", { className: "sb-next-when" }, whenStr(ev.start)),
              h("span", { className: "sb-next-title" }, ev.title),
              h("span", { className: "sb-next-acct" }, ev.account || ""));
          })) : null,
        (accounts && accounts.length === 0 && !showForm)
          ? h("div", { className: "sb-zero" },
              h("div", { className: "sb-zero-title" }, "No booking apps connected yet"),
              h("div", { className: "sb-zero-sub" }, "Cal.com, Calendly, Acuity, Setmore, or a Google / Microsoft iCal link."),
              h("button", { className: "sb-btn sb-primary", onClick: function () { setShowForm(true); } }, "+ Connect a booking app"))
          : h("div", { className: "sb-list" }, list),
        h("div", { className: "sb-foot" }, "Credentials are encrypted at rest and never shown again after you connect.")
      );
    }

    try { PLUGINS.register("suburban-bookings", Bookings); console.info(TAG, "registered"); }
    catch (e) { try { console.error(TAG, "register failed", e); } catch (e2) {} }

    // ---- Inject a "Bookings" nav item ----
    function norm(x) { return (x || "").replace(/\s+/g, " ").trim().toLowerCase(); }
    var NAV_LABELS = { chat: 1, sessions: 1, files: 1, models: 1, logs: 1, cron: 1, skills: 1, plugins: 1, config: 1, overview: 1, mailboxes: 1 };
    function navTemplate() {
      var links = document.querySelectorAll("a[href]");
      for (var i = 0; i < links.length; i++) {
        var t = norm(links[i].textContent);
        if (NAV_LABELS[t]) { var r = links[i].getBoundingClientRect(); if (r.left < 360) return links[i]; }
      }
      return null;
    }
    function href() { return "/bookings" + (location.search || ""); }
    function markActive() {
      try {
        var el = document.getElementById("sb-nav"); if (!el) return;
        el.setAttribute("href", href());
        var on = location.pathname === "/bookings";
        el.style.borderLeft = on ? "2px solid var(--color-primary,#25c9ee)" : "2px solid transparent";
        el.style.background = on ? "var(--color-accent,rgba(37,201,238,.08))" : "";
      } catch (e) {}
    }
    function injectNav() {
      try {
        if (document.getElementById("sb-nav")) { markActive(); return; }
        var tmpl = navTemplate(); if (!tmpl || !tmpl.parentElement) return;
        var tmplLabel = norm(tmpl.textContent);
        var clone = tmpl.cloneNode(true);
        clone.id = "sb-nav";
        clone.setAttribute("href", href()); try { clone.href = href(); } catch (e) {}
        var w = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT, null), n;
        while ((n = w.nextNode())) { if (norm(n.nodeValue) === tmplLabel) { n.nodeValue = "Bookings"; break; } }
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
