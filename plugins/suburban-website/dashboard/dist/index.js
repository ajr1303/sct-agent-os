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
      s = useState(false); var edit = s[0], setEdit = s[1];
      s = useState({ property_id: "", key_json: "" }); var f = s[0], setF = s[1];

      function load(refresh) {
        return api("/website" + (refresh ? "?refresh=1" : "")).then(function (x) { setD(x); setErr(null); })
          .catch(function (e) { setErr(String(e.message || e)); });
      }
      useEffect(function () { load(); }, []);
      function set(k) { return function (e) { var n = Object.assign({}, f); n[k] = e.target.value; setF(n); }; }
      function save(e) {
        e.preventDefault(); setBusy("save"); setErr(null);
        api("/website", { method: "PUT", body: JSON.stringify({ property_id: f.property_id.trim(), key_json: f.key_json }) })
          .then(function (x) { setBusy(""); setD(x); setEdit(false); setF({ property_id: "", key_json: "" }); })
          .catch(function (e2) { setBusy(""); setErr(String(e2.message || e2)); });
      }
      function disconnect() {
        if (!window.confirm("Disconnect Google Analytics? The numbers stop showing here; nothing changes in Google.")) return;
        setBusy("rm"); api("/website", { method: "DELETE" }).then(function (x) { setBusy(""); setD(x); }).catch(function (e) { setBusy(""); setErr(String(e.message || e)); });
      }

      function setup() {
        return h("form", { className: "sw-card", onSubmit: save },
          h("div", { className: "sw-name" }, d && d.connected ? "Change the connection" : "Connect Google Analytics"),
          h("ol", { className: "sw-steps" },
            h("li", null, "In Google Cloud Console (console.cloud.google.com), pick or create a project, then enable the ", h("b", null, "Google Analytics Data API"), "."),
            h("li", null, "Go to IAM & Admin > Service Accounts, create a service account, then under Keys choose Add key > Create new key > JSON. A file downloads."),
            h("li", null, "In Google Analytics, open Admin > Property access management, add the service account's email address (it ends in gserviceaccount.com) and give it the ", h("b", null, "Viewer"), " role."),
            h("li", null, "Still in Admin, open Property details and copy the numeric ", h("b", null, "Property ID"), " (not the G- measurement ID)."),
            h("li", null, "Enter the Property ID and paste the whole contents of the downloaded file below.")),
          h("label", { className: "sw-field" }, h("span", null, "Property ID"),
            h("input", { className: "sw-in", value: f.property_id, onChange: set("property_id"), placeholder: "123456789", inputMode: "numeric", autoComplete: "off" })),
          h("label", { className: "sw-field" }, h("span", null, "Service-account key (contents of the .json file)"),
            h("textarea", { className: "sw-in sw-ta", value: f.key_json, onChange: set("key_json"), spellCheck: false, autoComplete: "off",
              placeholder: "{\n  \"type\": \"service_account\",\n  …\n}" })),
          err ? h("div", { className: "sw-msg" }, err) : null,
          h("div", { className: "sw-acts" },
            h("span", { className: "sw-hint" }, "Read-only. The key is tested, stored encrypted on this server, never shown again, and only ever sent to Google."),
            d && d.connected ? h("button", { type: "button", className: "sw-btn", onClick: function () { setEdit(false); setErr(null); } }, "Cancel") : null,
            h("button", { type: "submit", className: "sw-btn sw-primary", disabled: busy === "save" || !f.property_id.trim() || !f.key_json.trim() }, busy === "save" ? "Checking with Google…" : "Connect")));
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

      var st = d.stats;
      return h("div", { className: "sw-wrap" },
        h("div", { className: "sw-h1" }, "Website"),
        h("div", { className: "sw-sub" }, "How many people visit your website, from Google Analytics. Numbers cover the last 7 full days and can be a few hours behind."),
        !d.connected ? setup() : null,
        d.connected && d.error ? h("div", { className: "sw-msg" }, d.error) : null,
        d.connected && st ? h("div", { className: "sw-tiles" },
          h("div", { className: "sw-tile" }, h("div", { className: "sw-tlabel" }, "Visitors, 7 days"), h("div", { className: "sw-tval sw-accent" }, num(st.visitors)), h("div", { className: "sw-tnote" }, changeText(st.visitors_change))),
          h("div", { className: "sw-tile" }, h("div", { className: "sw-tlabel" }, "Visits, 7 days"), h("div", { className: "sw-tval" }, num(st.sessions)), h("div", { className: "sw-tnote" }, changeText(st.sessions_change)))) : null,
        d.connected && st && (st.pages || []).length ? h("div", { className: "sw-card" },
          h("div", { className: "sw-name" }, "Most viewed pages"), bars(st.pages, "views", "path")) : null,
        d.connected && st && (st.sources || []).length ? h("div", { className: "sw-card" },
          h("div", { className: "sw-name" }, "Where visits came from"), bars(st.sources, "sessions", "name")) : null,
        d.connected && !edit ? h("div", { className: "sw-card" },
          h("div", { className: "sw-name" }, "Connection"),
          h("div", { className: "sw-p" }, "Google Analytics property " + d.property_id + ", read through " + (d.account || "a service account") + "." + (st ? " Last read " + when(st.fetched_at) + "." : "")),
          !st && !d.error ? h("div", { className: "sw-dim" }, "No numbers yet.") : null,
          h("div", { className: "sw-acts sw-left" },
            h("button", { type: "button", className: "sw-btn", disabled: busy === "ref", onClick: function () { setBusy("ref"); load(true).then(function () { setBusy(""); }); } }, busy === "ref" ? "Refreshing…" : "Refresh now"),
            h("button", { type: "button", className: "sw-btn", onClick: function () { setEdit(true); setErr(null); } }, "Change"),
            h("button", { type: "button", className: "sw-btn", disabled: busy === "rm", onClick: disconnect }, "Disconnect"))) : null,
        d.connected && edit ? setup() : null);
    }
    try { PLUGINS.register("suburban-website", Website); console.info(TAG, "registered"); }
    catch (e) { try { console.error(TAG, "register failed", e); } catch (e2) {} }
  });
})();
