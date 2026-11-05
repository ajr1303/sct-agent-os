(function () {
  "use strict";
  var TAG = "[suburban-cyber]";
  var BRAND = "Suburban Cyber";

  function whenReady(cb, tries) {
    tries = tries || 0;
    var P = window.__HERMES_PLUGINS__;
    var S = window.__HERMES_PLUGIN_SDK__;
    if (P && S && S.React) { cb(P, S); return; }
    if (tries > 200) { try { console.warn(TAG, "SDK not ready after wait"); } catch (e) {} return; }
    setTimeout(function () { whenReady(cb, tries + 1); }, 50);
  }

  whenReady(function (PLUGINS, SDK) {
    var h = SDK.React.createElement;
    var hooks = SDK.hooks || {};
    var useState = hooks.useState, useEffect = hooks.useEffect;

    function row(label, value, valClass) {
      return h("div", { className: "scagent-row" },
        h("span", null, label),
        h("span", { className: valClass || "" }, value));
    }
    function card(title, children) {
      return h("div", { className: "scagent-card" },
        h("div", { className: "scagent-card-h" }, title),
        h("div", { className: "scagent-card-b" }, children));
    }
    function callApi(name) {
      try {
        if (SDK.api && typeof SDK.api[name] === "function") return Promise.resolve(SDK.api[name]());
      } catch (e) {}
      return null;
    }
    function toList(x) { return Array.isArray(x) ? x : (x && (x.sessions || x.items || x.data)) || []; }
    function pick(o, keys) { for (var i = 0; i < keys.length; i++) { if (o && o[keys[i]] != null) return o[keys[i]]; } return null; }

    function Overview() {
      var s1 = useState(null), status = s1[0], setStatus = s1[1];
      var s2 = useState(null), sessions = s2[0], setSessions = s2[1];
      useEffect(function () {
        function load() {
          var ps = callApi("getStatus"); if (ps) ps.then(setStatus).catch(function () {});
          var pl = callApi("getSessions"); if (pl) pl.then(function (v) { setSessions(toList(v)); }).catch(function () {});
        }
        load();
        var t = setInterval(load, 15000);
        return function () { clearInterval(t); };
      }, []);

      var up = status ? pick(status, ["gateway_running", "gatewayRunning"]) : null;
      if (up == null && status && status.gateway) up = pick(status.gateway, ["running", "ok"]);
      var version = status ? pick(status, ["version", "hermes_version"]) : null;
      var count = sessions == null ? "-" : String(sessions.length);

      var links = [["Chat", "/chat"], ["Sessions", "/sessions"], ["Cron", "/cron"],
                   ["Skills", "/skills"], ["Channels", "/channels"], ["Config", "/config"]];

      return h("div", { className: "scagent-wrap" },
        h("div", { className: "scagent-hero" },
          h("div", { className: "scagent-hero-title" }, "Suburban Cyber Agent OS"),
          h("div", { className: "scagent-hero-sub" }, "Your private AI agent, powered by Hermes.")),
        h("div", { className: "scagent-grid" },
          card("Agent status", [
            row("Gateway", up == null ? (status ? "unknown" : "loading…")
              : h("span", { className: "scagent-pill " + (up ? "scagent-ok" : "scagent-bad") }, up ? "running" : "stopped")),
            version ? row("Hermes", String(version)) : null
          ]),
          card("Sessions", h("div", null,
            h("div", { className: "scagent-big" }, count),
            h("div", { className: "scagent-muted" }, "total"))),
          card("Quick links", h("div", { className: "scagent-links" },
            links.map(function (l) { return h("a", { key: l[0], href: l[1] }, l[0]); })))
        ),
        h("div", { className: "scagent-foot" }, "Suburban Cyber Agent OS · built on Hermes Agent (Nous Research)")
      );
    }

    try {
      PLUGINS.register("suburban-cyber", Overview);
      console.info(TAG, "registered overview tab, sdkVersion=" + (SDK.sdkVersion || "?"));
    } catch (e) {
      try { console.error(TAG, "register failed", e); } catch (e2) {}
    }

    // ---- Branding: rename the sidebar wordmark + tab title. Isolated so it can never block registration.
    try {
      function norm(x){ return (x || "").replace(/\s+/g, " ").trim().toLowerCase(); }
      function rebrand() {
        try {
          if (!/suburban/i.test(document.title)) document.title = BRAND + " Agent OS";
          var all = document.querySelectorAll("a,div,span,h1,h2,p");
          for (var i = 0; i < all.length; i++) {
            var el = all[i];
            if (el.childElementCount > 3) continue;
            var t = norm(el.textContent);
            if (t !== "hermes agent" && t !== "hermesagent") continue;
            var r = el.getBoundingClientRect();
            if (r.top < 220 && r.left < 360 && r.width < 420) { el.textContent = BRAND; }
          }
        } catch (e) {}
      }
      var mo = new MutationObserver(function () {
        if (rebrand._p) return;
        rebrand._p = setTimeout(function () { rebrand._p = null; rebrand(); }, 120);
      });
      if (document.body) {
        mo.observe(document.body, { childList: true, subtree: true, characterData: true });
        rebrand();
        setTimeout(rebrand, 400);
        setTimeout(rebrand, 1200);
      }
      console.info(TAG, "branding active");
    } catch (e) {
      try { console.warn(TAG, "branding init failed", e); } catch (e2) {}
    }
  });
})();
