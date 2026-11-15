(function () {
  "use strict";
  var TAG = "[suburban-website]";
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
    function num(n) { try { return Number(n || 0).toLocaleString(); } catch (e) { return String(n); } }
    function changeText(pct) {
      if (pct == null) return "No earlier week to compare with";
      if (pct === 0) return "Same as the week before";
      return (pct > 0 ? "Up " : "Down ") + Math.abs(pct) + "% on the week before";
    }
    function when(iso) { try { return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); } catch (e) { return ""; } }

    function Website() {
      var s;
      s = useState(null);  var d = s[0], setD = s[1];
      s = useState(null);  var err = s[0], setErr = s[1];
      s = useState("");    var busy = s[0], setBusy = s[1];
      s = useState("");    var panel = s[0], setPanel = s[1];      // "" | "add" | "key"
      s = useState({ label: "", property_id: "", key_json: "" }); var f = s[0], setF = s[1];

      function load(site, refresh) {
        var q = [];
        if (site) q.push("site=" + encodeURIComponent(site));
        if (refresh) q.push("refresh=1");
        return api("/website" + (q.length ? "?" + q.join("&") : "")).then(function (x) { setD(x); setErr(null); })
          .catch(function (e) { setErr(String(e.message || e)); });
      }
      useEffect(function () { load(); }, []);
      function set(k) { return function (e) { var n = Object.assign({}, f); n[k] = e.target.value; setF(n); }; }
      function call(name, path, opts, after) {
        setBusy(name); setErr(null);
        return api(path, opts).then(function (x) { setBusy(""); setD(x); setF({ label: "", property_id: "", key_json: "" }); setPanel(""); if (after) after(x); })
          .catch(function (e) { setBusy(""); setErr(String(e.message || e)); });
      }
      function pick(id) { setBusy("pick"); load(id).then(function () { setBusy(""); }); }

      var KEY_STEPS = [
        h("li", { key: 1 }, "In Google Cloud Console (console.cloud.google.com), pick or create a project, then enable the ", h("b", null, "Google Analytics Data API"), "."),
        h("li", { key: 2 }, "Go to IAM & Admin > Service Accounts, create a service account, then under Keys choose Add key > Create new key > JSON. A file downloads."),
        h("li", { key: 3 }, "In Google Analytics, open Admin > Property access management, add the service account's email address (it ends in gserviceaccount.com) and give it the ", h("b", null, "Viewer"), " role."),
        h("li", { key: 4 }, "Still in Admin, open Property details and copy the numeric ", h("b", null, "Property ID"), " (not the G- measurement ID)."),
        h("li", { key: 5 }, "Enter the details and paste the whole contents of the downloaded file below.")];
      function keyField() {
        return h("label", { className: "sw-field" }, h("span", null, "Service-account key (contents of the .json file)"),
          h("textarea", { className: "sw-in sw-ta", value: f.key_json, onChange: set("key_json"), spellCheck: false, autoComplete: "off",
            placeholder: "{\n  \"type\": \"service_account\",\n  …\n}" }));
      }
      function siteFields() {
        return h("div", { className: "sw-two" },
          h("label", { className: "sw-field" }, h("span", null, "Name for this site"),
            h("input", { className: "sw-in", value: f.label, onChange: set("label"), placeholder: "My business", maxLength: 60, autoComplete: "off" })),
          h("label", { className: "sw-field" }, h("span", null, "Property ID"),
            h("input", { className: "sw-in", value: f.property_id, onChange: set("property_id"), placeholder: "123456789", inputMode: "numeric", autoComplete: "off" })));
      }

      // First-time connection: key + first site.
      function connectForm() {
        return h("form", { className: "sw-card", onSubmit: function (e) { e.preventDefault();
            call("save", "/website", { method: "PUT", body: JSON.stringify({ label: f.label.trim(), property_id: f.property_id.trim(), key_json: f.key_json }) }); } },
          h("div", { className: "sw-name" }, "Connect Google Analytics"),
          h("ol", { className: "sw-steps" }, KEY_STEPS),
          siteFields(), keyField(),
          err ? h("div", { className: "sw-msg" }, err) : null,
          h("div", { className: "sw-acts" },
            h("span", { className: "sw-hint" }, "Read-only. The key is tested, stored encrypted on this server, never shown again, and only ever sent to Google. You can add more sites afterwards."),
            h("button", { type: "submit", className: "sw-btn sw-primary", disabled: busy === "save" || !f.property_id.trim() || !f.key_json.trim() }, busy === "save" ? "Checking with Google…" : "Connect")));
      }
      // Another site read through the same key.
      function addForm() {
        return h("form", { className: "sw-card", onSubmit: function (e) { e.preventDefault();
            call("add", "/website/sites", { method: "POST", body: JSON.stringify({ label: f.label.trim(), property_id: f.property_id.trim() }) }); } },
          h("div", { className: "sw-name" }, "Add a site"),
          h("div", { className: "sw-p" }, "No new key is needed. In that site's Google Analytics, open Admin > Property access management and add this address as a ", h("b", null, "Viewer"), ":"),
          h("pre", { className: "sw-code" }, d.account || ""),
          h("div", { className: "sw-p" }, "Then enter a name and the site's numeric Property ID. For a client's site, they add the address themselves and can remove it at any time."),
          siteFields(),
          err ? h("div", { className: "sw-msg" }, err) : null,
          h("div", { className: "sw-acts" },
            h("button", { type: "button", className: "sw-btn", onClick: function () { setPanel(""); setErr(null); } }, "Cancel"),
            h("button", { type: "submit", className: "sw-btn sw-primary", disabled: busy === "add" || !f.property_id.trim() || !f.label.trim() }, busy === "add" ? "Checking with Google…" : "Add site")));
      }
      function keyForm() {
        return h("form", { className: "sw-card", onSubmit: function (e) { e.preventDefault();
            call("key", "/website/key", { method: "PUT", body: JSON.stringify({ key_json: f.key_json }) }); } },
          h("div", { className: "sw-name" }, "Replace the key"),
          h("div", { className: "sw-p" }, "Use this after making a new key for the same service account, or to switch to another one. The new key must be able to read your main site. Sites it cannot read will show a message until access is granted."),
          keyField(),
          err ? h("div", { className: "sw-msg" }, err) : null,
          h("div", { className: "sw-acts" },
            h("button", { type: "button", className: "sw-btn", onClick: function () { setPanel(""); setErr(null); } }, "Cancel"),
            h("button", { type: "submit", className: "sw-btn sw-primary", disabled: busy === "key" || !f.key_json.trim() }, busy === "key" ? "Checking with Google…" : "Replace key")));
      }

      function bars(rows, key, labelKey) {
        var max = Math.max.apply(null, rows.map(function (r) { return r[key] || 0; }).concat([1]));
        return h("div", { className: "sw-rows" }, rows.map(function (r, i) {
          return h("div", { key: i, className: "sw-row" },
            h("span", { className: "sw-rlabel", title: r[labelKey] }, r[labelKey] || "(not set)"),
            h("span", { className: "sw-track" }, h("span", { className: "sw-fill", style: { width: Math.max(2, Math.round((r[key] || 0) * 100 / max)) + "%" } })),
            h("span", { className: "sw-rval" }, num(r[key])));
        }));
      }

      if (d == null) return h("div", { className: "sw-wrap" }, h("div", { className: "sw-h1" }, "Website"),
        err ? h("div", { className: "sw-msg" }, err) : h("div", { className: "sw-dim" }, "Loading…"));

      var st = d.stats, sites = d.sites || [];
      var cur = null; for (var i = 0; i < sites.length; i++) if (sites[i].id === d.site_id) cur = sites[i];
      return h("div", { className: "sw-wrap" },
        h("div", { className: "sw-h1" }, "Website"),
        h("div", { className: "sw-sub" }, "How many people visit your website, from Google Analytics. Numbers cover the last 7 full days and can be a few hours behind."),
        !d.connected ? connectForm() : null,

        d.connected ? h("div", { className: "sw-sites" },
          sites.map(function (x) {
            return h("button", { key: x.id, type: "button", className: "sw-site" + (x.id === d.site_id ? " sw-on" : ""), disabled: busy === "pick",
              onClick: function () { if (x.id !== d.site_id) pick(x.id); } }, x.label, x.main ? h("span", { className: "sw-main" }, "main") : null);
          }),
          sites.length < (d.max_sites || 25) ? h("button", { type: "button", className: "sw-site sw-addbtn", onClick: function () { setPanel("add"); setErr(null); } }, "+ Add a site") : null) : null,
        d.connected && panel === "add" ? addForm() : null,

        d.connected && d.error ? h("div", { className: "sw-msg" }, (cur ? cur.label + ": " : "") + d.error) : null,
        d.connected && st ? h("div", { className: "sw-tiles" },
          h("div", { className: "sw-tile" }, h("div", { className: "sw-tlabel" }, "Visitors, 7 days"), h("div", { className: "sw-tval sw-accent" }, num(st.visitors)), h("div", { className: "sw-tnote" }, changeText(st.visitors_change))),
          h("div", { className: "sw-tile" }, h("div", { className: "sw-tlabel" }, "Visits, 7 days"), h("div", { className: "sw-tval" }, num(st.sessions)), h("div", { className: "sw-tnote" }, changeText(st.sessions_change)))) : null,
        d.connected && st && (st.pages || []).length ? h("div", { className: "sw-card" },
          h("div", { className: "sw-name" }, "Most viewed pages"), bars(st.pages, "views", "path")) : null,
        d.connected && st && (st.sources || []).length ? h("div", { className: "sw-card" },
          h("div", { className: "sw-name" }, "Where visits came from"), bars(st.sources, "sessions", "name")) : null,

        d.connected && cur ? h("div", { className: "sw-card" },
          h("div", { className: "sw-name" }, cur.label),
          h("div", { className: "sw-p" }, "Google Analytics property " + cur.property_id + "." + (st ? " Last read " + when(st.fetched_at) + "." : "")
            + (cur.main ? " This is your main site: its visitors show on the Overview." : "")),
          h("div", { className: "sw-acts sw-left" },
            h("button", { type: "button", className: "sw-btn", disabled: busy === "ref", onClick: function () { setBusy("ref"); load(cur.id, true).then(function () { setBusy(""); }); } }, busy === "ref" ? "Refreshing…" : "Refresh now"),
            !cur.main ? h("button", { type: "button", className: "sw-btn", disabled: busy === "main",
              onClick: function () { call("main", "/website/sites/" + cur.id + "/main", { method: "POST" }); } }, "Make this my main site") : null,
            h("button", { type: "button", className: "sw-btn", disabled: busy === "rmsite",
              onClick: function () { if (window.confirm("Remove “" + cur.label + "” from this page? Nothing changes in Google.")) call("rmsite", "/website/sites/" + cur.id, { method: "DELETE" }); } }, "Remove this site")),
          panel === "" && err ? h("div", { className: "sw-msg" }, err) : null) : null,

        d.connected ? h("div", { className: "sw-card" },
          h("div", { className: "sw-name" }, "Connection"),
          h("div", { className: "sw-p" }, sites.length + (sites.length === 1 ? " site is" : " sites are") + " read through " + (d.account || "a service account") + ". Anyone who can sign in to this dashboard can see every site listed here."),
          h("div", { className: "sw-acts sw-left" },
            h("button", { type: "button", className: "sw-btn", onClick: function () { setPanel("key"); setErr(null); } }, "Replace the key"),
            h("button", { type: "button", className: "sw-btn", disabled: busy === "rm",
              onClick: function () { if (window.confirm("Disconnect Google Analytics and remove every site from this page? Nothing changes in Google.")) call("rm", "/website", { method: "DELETE" }); } }, "Disconnect"))) : null,
        d.connected && panel === "key" ? keyForm() : null);
    }
    try { PLUGINS.register("suburban-website", Website); console.info(TAG, "registered"); }
    catch (e) { try { console.error(TAG, "register failed", e); } catch (e2) {} }
  });
})();
