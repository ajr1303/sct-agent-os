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

    // Password: change it, and keep a reset code for the day it is forgotten.
    function PasswordCard() {
      var s;
      s = useState(null);  var info = s[0], setInfo = s[1];
      s = useState("");    var mode = s[0], setMode = s[1];          // "" | "change" | "code" | "email"
      var BLANK = { current: "", next: "", again: "", to: "", host: "", port: "587", user: "", mailpw: "" };
      s = useState(BLANK); var f = s[0], setF = s[1];
      s = useState("");    var err = s[0], setErr = s[1];
      s = useState("");    var waitId = s[0], setWaitId = s[1];
      s = useState(null);  var done = s[0], setDone = s[1];          // {mode, reset_code}
      s = useState(false); var saved = s[0], setSaved = s[1];
      var KEY = "aos-pw-id";
      function stored(v) { try { if (v === undefined) return sessionStorage.getItem(KEY) || ""; if (v) sessionStorage.setItem(KEY, v); else sessionStorage.removeItem(KEY); } catch (e) {} return v || ""; }
      function load() { return api("/security/password").then(setInfo).catch(function () {}); }
      useEffect(function () { load(); var id = stored(); if (id) setWaitId(id); }, []);
      useEffect(function () {
        if (!waitId) return;
        var stop = false, tries = 0;
        function tick() {
          if (stop) return;
          fetch("/api/connectors/account/password-result?id=" + waitId, { credentials: "same-origin", cache: "no-store" })
            .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, status: r.status, j: j }; }); })
            .then(function (x) {
              if (stop) return;
              if (x.ok && x.j.done) {
                stored(""); setWaitId(""); setF(BLANK);
                if (x.j.ok) { setMode(""); setDone({ mode: x.j.mode, reset_code: x.j.reset_code }); load(); }
                else setErr(x.j.message || "That did not work. Please try again.");
                return;
              }
              if (x.status === 404 || x.status === 400) { stored(""); setWaitId(""); return; }
              next();
            }).catch(next);
        }
        function next() { tries++; if (tries > 80) { stored(""); setWaitId(""); setErr("This is taking longer than expected. Reload the page in a few minutes."); return; } setTimeout(tick, 4000); }
        tick();
        return function () { stop = true; };
      }, [waitId]);
      function set(k) { return function (e) { var n = Object.assign({}, f); n[k] = e.target.value; setF(n); }; }
      function submit(e) {
        e.preventDefault(); setErr("");
        if (mode === "change" && f.next !== f.again) { setErr("The two new passwords do not match."); return; }
        var call = mode === "email"
          ? api("/security/password-email", { method: "POST", body: JSON.stringify({ current: f.current, to: f.to, host: f.host, port: parseInt(f.port, 10) || 587, user: f.user, password: f.mailpw }) })
          : api("/security/password", { method: "POST", body: JSON.stringify({ current: f.current, "new": mode === "change" ? f.next : "" }) });
        call.then(function (x) { stored(x.id); setWaitId(x.id); })
          .catch(function (e2) { setErr(String(e2.message || e2)); });
      }
      function download() {
        var text = "Agent OS password reset code\n" + new Date().toISOString().slice(0, 10) + "\n\nUse this on the sign-in page (Forgot password?) to set a new password. It works once.\n\n" + done.reset_code + "\n";
        var a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([text], { type: "text/plain" })); a.download = "agent-os-reset-code.txt";
        document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
      }
      function txt(label, k, ph, type) {
        return h("label", { className: "ss-field" }, h("span", null, label),
          h("input", { className: "ss-in", type: type || "text", autoComplete: "off", spellCheck: false, placeholder: ph || "", value: f[k], maxLength: 300, onChange: set(k) }));
      }
      function emailOff() {
        if (!window.confirm("Turn off reset by email? Forgot password will then need your reset code.")) return;
        api("/security/password-email", { method: "DELETE" }).then(load).catch(function (e2) { setErr(String(e2.message || e2)); });
      }
      function pw(label, k, auto) {
        return h("label", { className: "ss-field" }, h("span", null, label),
          h("input", { className: "ss-in", type: "password", autoComplete: auto, value: f[k], maxLength: 256, onChange: set(k) }));
      }

      if (done && done.mode === "email") return h("div", { className: "ss-card" },
        h("div", { className: "ss-name" }, "Reset by email is on"),
        h("div", { className: "ss-p" }, "A test message was sent to the address you gave. Check that it arrived. From now on, “Forgot password?” on the sign-in page can email a reset link there. Anyone who can read that mailbox can reset this password, so keep that mailbox well protected."),
        h("div", { className: "ss-acts ss-left" }, h("button", { type: "button", className: "ss-btn ss-primary", onClick: function () { setDone(null); } }, "Done")));
      if (done) return h("div", { className: "ss-card" },
        h("div", { className: "ss-name" }, done.mode === "change" ? "Password changed. Save your new reset code" : "Save your reset code"),
        h("div", { className: "ss-p" }, "If you ever forget the password, this code lets you set a new one from the sign-in page (Forgot password?). It works once, and any earlier reset code has stopped working. Keep it somewhere safe that is not this server: a password manager, or printed. It is not shown again."),
        done.reset_code ? h("code", { className: "ss-secret" }, done.reset_code)
          : h("div", { className: "ss-msg" }, "The code could not be shown. Use “Get a new reset code” below to make another."),
        done.reset_code ? h("div", { className: "ss-acts ss-left" }, h("button", { type: "button", className: "ss-btn", onClick: download }, "Download as a file")) : null,
        h("label", { className: "ss-check" }, h("input", { type: "checkbox", checked: saved, onChange: function (e) { setSaved(e.target.checked); } }),
          h("span", null, "I have saved this code.")),
        h("div", { className: "ss-acts ss-left" }, h("button", { type: "button", className: "ss-btn ss-primary", disabled: !saved && !!done.reset_code,
          onClick: function () { setDone(null); setSaved(false); } }, "Done")),
        done.mode === "change" ? h("div", { className: "ss-dim ss-small" }, "You may be asked to sign in again with the new password.") : null);

      if (waitId) return h("div", { className: "ss-card" },
        h("div", { className: "ss-head" }, h("div", { className: "ss-name" }, "Password"), h("span", { className: "ss-state ss-wait" }, "Working…")),
        h("div", { className: "ss-p" }, "The server is checking your password" + (mode === "change" ? " and applying the new one. The dashboard restarts, so this can take a minute or two and you may be asked to sign in again." : mode === "email" ? ", then sending a test message. This takes up to a minute." : ". This takes up to a minute.") + " Keep this page open."));

      return h("div", { className: "ss-card" },
        h("div", { className: "ss-head" }, h("div", { className: "ss-name" }, "Password"),
          info ? h("span", { className: "ss-state " + (info.reset_code_set ? "ss-on" : "ss-wait") }, info.reset_code_set ? "Reset code saved" : "No reset code yet") : null),
        h("div", { className: "ss-p" }, "The password for signing in to this dashboard as admin. A reset code lets you set a new password yourself if you forget it."
          + (info && info.reset_code_set && info.reset_code_at ? " Your reset code was made on " + when(info.reset_code_at) + "." : "")),
        info && !info.reset_code_set && !mode ? h("div", { className: "ss-msg" }, "You have no reset code. If the password is forgotten, only someone with access to the server can reset it. Get a code now.") : null,
        info && !mode ? h("div", { className: "ss-facts" },
          h("div", null, h("span", { className: "ss-dim" }, "Reset by email"), h("b", null, info.email ? "On, sends to " + info.email.to : "Off"))) : null,
        mode ? h("form", { className: "ss-ask", onSubmit: submit },
            mode === "email" ? h("div", { className: "ss-p ss-dim" }, "“Forgot password?” will email a one-time link to this address. The server needs a mail account to send from. Gmail: smtp.gmail.com, port 587, your address, and an app password. Microsoft 365: smtp.office365.com, port 587. Anyone who can read the receiving mailbox can reset this password.") : null,
            mode === "email" ? txt("Send the reset link to", "to", "you@example.com", "email") : null,
            mode === "email" ? txt("Outgoing mail server", "host", "smtp.gmail.com") : null,
            mode === "email" ? txt("Port", "port", "587") : null,
            mode === "email" ? txt("Mail account username", "user", "you@example.com") : null,
            mode === "email" ? txt("Mail account password (app password)", "mailpw", "", "password") : null,
            pw(mode === "email" ? "Current dashboard password" : "Current password", "current", "current-password"),
            mode === "change" ? pw("New password", "next", "new-password") : null,
            mode === "change" ? pw("New password again", "again", "new-password") : null,
            mode === "change" && info ? h("div", { className: "ss-dim ss-small" }, info.rule) : null,
            mode === "change" ? h("div", { className: "ss-dim ss-small" }, "The dashboard restarts for about a minute. Agents and automations keep running.") : null,
            err ? h("div", { className: "ss-msg" }, err) : null,
            h("div", { className: "ss-acts ss-left" },
              h("button", { type: "submit", className: "ss-btn ss-primary", disabled: !f.current || (mode === "change" && (f.next.length < 12 || !f.again)) || (mode === "email" && (!f.to || !f.host || !f.user || !f.mailpw)) }, mode === "change" ? "Change password" : mode === "email" ? "Send a test and turn on" : "Get the code"),
              h("button", { type: "button", className: "ss-btn", onClick: function () { setMode(""); setErr(""); setF(BLANK); } }, "Cancel")))
          : h("div", { className: "ss-acts ss-left" },
              err ? h("div", { className: "ss-msg" }, err) : null,
              h("button", { type: "button", className: "ss-btn", onClick: function () { setMode("change"); setErr(""); } }, "Change password"),
              h("button", { type: "button", className: "ss-btn", onClick: function () { setMode("code"); setErr(""); } }, info && info.reset_code_set ? "Get a new reset code" : "Get a reset code"),
              h("button", { type: "button", className: "ss-btn", onClick: function () { setMode("email"); setErr(""); if (info && info.email) setF(Object.assign({}, BLANK, { to: info.email.to || "", host: info.email.host || "", port: String(info.email.port || 587), user: info.email.user || "" })); } }, info && info.email ? "Change email settings" : "Set up reset by email"),
              info && info.email ? h("button", { type: "button", className: "ss-btn", onClick: emailOff }, "Turn off reset by email") : null));
    }

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
        h("div", { className: "ss-sub" }, "Your password and extra protection for signing in to this dashboard."),
        h(PasswordCard),
        body);
    }
    try { PLUGINS.register("suburban-security", Security); console.info(TAG, "registered"); }
    catch (e) { try { console.error(TAG, "register failed", e); } catch (e2) {} }
  });
})();
