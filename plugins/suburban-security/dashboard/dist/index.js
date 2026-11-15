(function () {
  "use strict";
  var TAG = "[suburban-security]";
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
    function when(iso) { try { return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }); } catch (e) { return ""; } }

    function Security() {
      var s;
      s = useState(null);  var d = s[0], setD = s[1];
      s = useState(null);  var err = s[0], setErr = s[1];
      s = useState("");    var busy = s[0], setBusy = s[1];
      s = useState(null);  var setup = s[0], setSetup = s[1];        // {secret, qr_svg} while scanning
      s = useState("");    var code = s[0], setCode = s[1];
      s = useState(null);  var codes = s[0], setCodes = s[1];        // recovery codes, shown once
      s = useState(false); var saved = s[0], setSaved = s[1];
      s = useState("");    var ask = s[0], setAsk = s[1];            // "" | "off" | "codes"

      function load() { return api("/security/mfa").then(function (x) { setD(x); }).catch(function (e) { setErr(String(e.message || e)); }); }
      useEffect(function () { load(); }, []);
      // After switching on, the server applies it within a minute: keep looking until it has.
      useEffect(function () {
        if (!d || !d.enabled || d.active) return;
        var t = setInterval(load, 8000); return function () { clearInterval(t); };
      }, [d && d.enabled, d && d.active]);

      function run(name, path, body, after) {
        setBusy(name); setErr(null);
        api(path, { method: "POST", body: JSON.stringify(body || {}) })
          .then(function (x) { setBusy(""); setCode(""); if (after) after(x); })
          .catch(function (e) { setBusy(""); setErr(String(e.message || e)); });
      }
      function codeInput(placeholder) {
        return h("input", { className: "ss-in ss-code", value: code, placeholder: placeholder || "123456", inputMode: "numeric", autoComplete: "one-time-code",
          maxLength: 12, onChange: function (e) { setCode(e.target.value); } });
      }
      function download() {
        var text = "Agent OS recovery codes\n" + new Date().toISOString().slice(0, 10) + "\n\nEach code works once, in place of the code from your authenticator app.\n\n" + codes.join("\n") + "\n";
        var a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([text], { type: "text/plain" })); a.download = "agent-os-recovery-codes.txt";
        document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
      }

      if (d == null) return h("div", { className: "ss-wrap" }, h("div", { className: "ss-h1" }, "Security"),
        err ? h("div", { className: "ss-msg" }, err) : h("div", { className: "ss-dim" }, "Loading…"));

      // Recovery codes are shown once, right after turning on or replacing them.
      if (codes) return h("div", { className: "ss-wrap" },
        h("div", { className: "ss-h1" }, "Security"),
        h("div", { className: "ss-card" },
          h("div", { className: "ss-name" }, "Save your recovery codes"),
          h("div", { className: "ss-p" }, "If you lose your phone, one of these gets you in instead of the app's code. Each works once. Keep them somewhere safe that is not this server: a password manager, or printed. They are not shown again."),
          h("div", { className: "ss-codes" }, codes.map(function (c) { return h("code", { key: c }, c); })),
          h("div", { className: "ss-acts ss-left" }, h("button", { type: "button", className: "ss-btn", onClick: download }, "Download as a file")),
          h("label", { className: "ss-check" }, h("input", { type: "checkbox", checked: saved, onChange: function (e) { setSaved(e.target.checked); } }),
            h("span", null, "I have saved these codes.")),
          h("div", { className: "ss-acts ss-left" }, h("button", { type: "button", className: "ss-btn ss-primary", disabled: !saved,
            onClick: function () { setCodes(null); setSaved(false); load(); } }, "Done"))));

      var body;
      if (!d.enabled && !setup) {
        body = h("div", { className: "ss-card" },
          h("div", { className: "ss-head" }, h("div", { className: "ss-name" }, "Two-step sign-in"), h("span", { className: "ss-state" }, "Off")),
          h("div", { className: "ss-p" }, "Adds a six-digit code from an authenticator app on your phone to the dashboard password. Someone who learns the password still cannot get in without your phone. Works with Google Authenticator, Microsoft Authenticator, 1Password and similar apps."),
          h("div", { className: "ss-p ss-dim" }, "It covers this dashboard. The automations builder (n8n) and Paperclip have their own sign-ins and are not covered by it. Everyone who uses this dashboard's shared login will need the same code, so set it up on the phone of whoever signs in."),
          err ? h("div", { className: "ss-msg" }, err) : null,
          h("div", { className: "ss-acts ss-left" }, h("button", { type: "button", className: "ss-btn ss-primary", disabled: busy === "setup",
            onClick: function () { run("setup", "/security/mfa/setup", {}, function (x) { setSetup(x); }); } }, busy === "setup" ? "Preparing…" : "Set up two-step sign-in")));
      } else if (!d.enabled && setup) {
        body = h("form", { className: "ss-card", onSubmit: function (e) { e.preventDefault();
            run("enable", "/security/mfa/enable", { code: code }, function (x) { setSetup(null); setD(x); setCodes(x.recovery_codes || []); }); } },
          h("div", { className: "ss-name" }, "Set up two-step sign-in"),
          h("ol", { className: "ss-steps" },
            h("li", null, "Open your authenticator app and choose to add an account (often a + button), then scan this code."),
            h("li", null, "The app shows a six-digit code for Agent OS. Enter it below to finish.")),
          h("div", { className: "ss-qrrow" },
            h("div", { className: "ss-qr", role: "img", "aria-label": "QR code for your authenticator app", dangerouslySetInnerHTML: { __html: setup.qr_svg } }),
            h("div", { className: "ss-manual" },
              h("div", { className: "ss-gname" }, "Can't scan? Enter this key by hand"),
              h("code", { className: "ss-secret" }, setup.secret),
              h("div", { className: "ss-dim ss-small" }, "Type: time-based. Account name: anything you like."))),
          h("label", { className: "ss-field" }, h("span", null, "Six-digit code from the app"), codeInput()),
          err ? h("div", { className: "ss-msg" }, err) : null,
          h("div", { className: "ss-acts" },
            h("span", { className: "ss-hint" }, "Nothing changes until the code is accepted."),
            h("button", { type: "button", className: "ss-btn", onClick: function () { setSetup(null); setCode(""); setErr(null); } }, "Cancel"),
            h("button", { type: "submit", className: "ss-btn ss-primary", disabled: busy === "enable" || code.replace(/\s/g, "").length < 6 }, busy === "enable" ? "Checking…" : "Turn on")));
      } else {
        body = h("div", { className: "ss-card" },
          h("div", { className: "ss-head" }, h("div", { className: "ss-name" }, "Two-step sign-in"),
            h("span", { className: "ss-state " + (d.active ? "ss-on" : "ss-wait") }, d.active ? "On" : "Turning on…")),
          d.active
            ? h("div", { className: "ss-p" }, "Signing in to this dashboard needs the password and a code from your authenticator app" + (d.enabled_at ? " (on since " + when(d.enabled_at) + ")" : "") + ". A browser is asked again after " + d.session_hours + " hours, or " + d.remember_days + " days if you tick “don't ask again”.")
            : h("div", { className: "ss-msg" }, d.applied === "error"
                ? "The server could not apply this to the sign-in page. Ask whoever looks after this server to run scripts/host-requests.sh and check the proxy."
                : "The server is applying this to the sign-in page. It takes up to a minute; this page updates by itself. If it still says this after five minutes, the server's scheduled jobs are not running: ask whoever looks after it to run scripts/install-cron.sh."),
          h("div", { className: "ss-facts" },
            h("div", null, h("span", { className: "ss-dim" }, "Recovery codes left"), h("b", { className: d.recovery_left <= 2 ? "ss-warnc" : "" }, String(d.recovery_left)))),
          d.recovery_left <= 2 ? h("div", { className: "ss-msg" }, "You are nearly out of recovery codes. Get new ones below.") : null,
          ask ? h("form", { className: "ss-ask", onSubmit: function (e) { e.preventDefault();
              if (ask === "off") run("off", "/security/mfa/disable", { code: code }, function (x) { setAsk(""); setD(x); });
              else run("codes", "/security/mfa/recovery", { code: code }, function (x) { setAsk(""); setD(x); setCodes(x.recovery_codes || []); }); } },
            h("label", { className: "ss-field" }, h("span", null, ask === "off" ? "Enter a current code (or a recovery code) to turn it off" : "Enter a current code from your app to get new recovery codes"), codeInput()),
            err ? h("div", { className: "ss-msg" }, err) : null,
            h("div", { className: "ss-acts ss-left" },
              h("button", { type: "submit", className: "ss-btn ss-primary", disabled: !!busy || code.replace(/[\s-]/g, "").length < 6 }, busy ? "Checking…" : (ask === "off" ? "Turn off" : "Get new codes")),
              h("button", { type: "button", className: "ss-btn", onClick: function () { setAsk(""); setCode(""); setErr(null); } }, "Cancel")))
          : h("div", { className: "ss-acts ss-left" },
              h("button", { type: "button", className: "ss-btn", onClick: function () { setAsk("codes"); setErr(null); } }, "New recovery codes"),
              h("button", { type: "button", className: "ss-btn", onClick: function () { setAsk("off"); setErr(null); } }, "Turn off")),
          h("div", { className: "ss-dim ss-small" }, "Lost the phone and the recovery codes? On the server, run: sudo ./scripts/mfa-reset.sh"));
      }
      return h("div", { className: "ss-wrap" },
        h("div", { className: "ss-h1" }, "Security"),
        h("div", { className: "ss-sub" }, "Extra protection for signing in to this dashboard."),
        body);
    }
    try { PLUGINS.register("suburban-security", Security); console.info(TAG, "registered"); }
    catch (e) { try { console.error(TAG, "register failed", e); } catch (e2) {} }
  });
})();
