(function () {
  var SDK = window.__HERMES_PLUGIN_SDK__;
  if (!SDK || !window.__HERMES_PLUGINS__) return;
  var h = SDK.React.createElement;
  var useState = SDK.hooks.useState, useEffect = SDK.hooks.useEffect;
  var C = SDK.components;
  var BRAND = "Suburban Cyber";

  // ---- Branding: rewrite the sidebar title and browser tab title -----------------
  function rebrand() {
    try {
      var w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      var n;
      while ((n = w.nextNode())) {
        if (!/^\s*hermes\s+agent\s*$/i.test(n.nodeValue)) continue;
        var el = n.parentElement;
        if (!el) continue;
        var r = el.getBoundingClientRect();
        if (r.left < 300 && r.top < 160) n.nodeValue = BRAND;
      }
      if (/hermes/i.test(document.title)) document.title = document.title.replace(/hermes agent/i, BRAND + " Agent OS");
    } catch (e) {}
  }
  var pending = null;
  new MutationObserver(function () {
    if (pending) return;
    pending = setTimeout(function () { pending = null; rebrand(); }, 150);
  }).observe(document.body, { childList: true, subtree: true, characterData: true });
  rebrand();

  // ---- Helpers (response shapes vary by Hermes version, so read defensively) -----
  function list(x) { return Array.isArray(x) ? x : (x && (x.sessions || x.items || x.data)) || []; }
  function pick(o, keys) { for (var i = 0; i < keys.length; i++) { if (o && o[keys[i]] != null) return o[keys[i]]; } return null; }
  function gatewayUp(s) {
    if (!s) return null;
    var v = pick(s, ["gateway_running", "gatewayRunning"]);
    if (v == null && s.gateway) v = pick(s.gateway, ["running", "ok", "alive"]);
    if (v == null) { var st = pick(s, ["gateway_state", "gateway_status", "gateway"]); if (typeof st === "string") v = /run|up|ok|alive/i.test(st); }
    return v == null ? null : !!v;
  }
  function when(s) {
    var t = pick(s, ["last_active", "updated_at", "started_at", "created_at"]);
    if (t == null) return "";
    try { return typeof t === "number" ? SDK.utils.timeAgo(t) : SDK.utils.isoTimeAgo(t); } catch (e) { return String(t); }
  }

  function Overview() {
    var a = useState(null), status = a[0], setStatus = a[1];
    var b = useState(null), sessions = b[0], setSessions = b[1];
    var c = useState(null), err = c[0], setErr = c[1];
    useEffect(function () {
      function load() {
        Promise.resolve(SDK.api.getStatus()).then(setStatus).catch(function (e) { setErr(String(e)); });
        Promise.resolve(SDK.api.getSessions()).then(function (s) { setSessions(list(s)); }).catch(function () { setSessions([]); });
      }
      load();
      var t = setInterval(load, 15000);
      return function () { clearInterval(t); };
    }, []);

    var up = gatewayUp(status);
    var recent = (sessions || []).slice(0, 8);
    var version = status && pick(status, ["version", "hermes_version"]);

    return h("div", { className: "scagent-grid" },
      h(C.Card, null,
        h(C.CardHeader, null, h(C.CardTitle, null, "Agent status")),
        h(C.CardContent, null,
          h("div", { className: "scagent-row" }, h("span", null, "Gateway"),
            up == null ? h("span", { className: "scagent-muted" }, status ? "unknown" : "loading")
              : h("span", { className: "scagent-pill " + (up ? "scagent-ok" : "scagent-bad") }, up ? "running" : "stopped")),
          version ? h("div", { className: "scagent-row" }, h("span", null, "Hermes version"), h("span", null, String(version))) : null,
          err ? h("div", { className: "scagent-row scagent-bad" }, err) : null)),
      h(C.Card, null,
        h(C.CardHeader, null, h(C.CardTitle, null, "Sessions")),
        h(C.CardContent, null,
          h("div", { className: "scagent-big" }, sessions == null ? "-" : String(sessions.length)),
          h("div", { className: "scagent-muted" }, "total sessions"))),
      h(C.Card, null,
        h(C.CardHeader, null, h(C.CardTitle, null, "Quick links")),
        h(C.CardContent, null,
          h("div", { className: "scagent-links" },
            [["Chat", "/chat"], ["Sessions", "/sessions"], ["Cron", "/cron"], ["Skills", "/skills"], ["Channels", "/channels"], ["Config", "/config"]]
              .map(function (l) { return h("a", { key: l[0], href: l[1] }, l[0]); })))),
      h(C.Card, { className: "scagent-wide" },
        h(C.CardHeader, null, h(C.CardTitle, null, "Recent sessions")),
        h(C.CardContent, null,
          recent.length === 0
            ? h("div", { className: "scagent-muted" }, sessions == null ? "Loading..." : "No sessions yet. Open Chat to start one.")
            : recent.map(function (s, i) {
                var title = pick(s, ["title", "preview", "name", "id"]) || "Untitled";
                return h("div", { className: "scagent-row", key: pick(s, ["id"]) || i },
                  h("span", null, String(title).slice(0, 90)), h("span", { className: "scagent-muted" }, when(s)));
              }))),
      h("div", { className: "scagent-wide scagent-muted", style: { fontSize: 12 } },
        "Suburban Cyber Agent OS, powered by Hermes Agent (Nous Research).")
    );
  }

  window.__HERMES_PLUGINS__.register("suburban-cyber", Overview);
})();
