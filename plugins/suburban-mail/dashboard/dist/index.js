(function () {
  "use strict";
  var TAG = "[suburban-mail]";

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

    // Our own connectors service, behind the proxy. Cookies ride along and the
    // service validates them against Hermes, so this is authed with no extra login.
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

    function initial(addr) {
      addr = (addr || "").trim(); if (!addr) return "@";
      return addr.charAt(0).toUpperCase();
    }

    function Mailboxes() {
      var s;
      s = useState(null);  var providers = s[0], setProviders = s[1];
      s = useState([]);    var boxes = s[0], setBoxes = s[1];
      s = useState(null);  var summary = s[0], setSummary = s[1];
      s = useState("imap"); var provider = s[0], setProvider = s[1];
      s = useState("");    var emailv = s[0], setEmail = s[1];
      s = useState("");    var host = s[0], setHost = s[1];
      s = useState(993);   var port = s[0], setPort = s[1];
      s = useState("");    var username = s[0], setUsername = s[1];
      s = useState("");    var password = s[0], setPassword = s[1];
      s = useState("");    var label = s[0], setLabel = s[1];
      s = useState(false); var busy = s[0], setBusy = s[1];
      s = useState(null);  var err = s[0], setErr = s[1];
      s = useState(null);  var ok = s[0], setOk = s[1];
      s = useState(false); var showForm = s[0], setShowForm = s[1];
      s = useState(null);  var confirmId = s[0], setConfirmId = s[1];

      function refresh() {
        api("/mailboxes").then(setBoxes).catch(function () {});
        api("/summary").then(setSummary).catch(function () {});
      }

      function applyPreset(key, p) {
        p = p || providers; setProvider(key);
        if (p && p[key]) { setHost(p[key].imap_host || ""); setPort(p[key].imap_port || 993); }
      }

      useEffect(function () {
        api("/providers").then(function (p) { setProviders(p); applyPreset("imap", p); })
          .catch(function (e) { setErr("Connector service unavailable: " + (e.message || e)); });
        refresh();
        var t = setInterval(function () { api("/summary").then(setSummary).catch(function () {}); }, 60000);
        return function () { clearInterval(t); };
      }, []);

      function submit(e) {
        if (e) e.preventDefault();
        setErr(null); setOk(null);
        if (!emailv) { setErr("Enter the email address."); return; }
        if (!password) { setErr("Enter the password or app password."); return; }
        setBusy(true);
        api("/mailboxes", { method: "POST", body: JSON.stringify({
          label: label, email: emailv, provider: provider,
          imap_host: host, imap_port: +port || 993, use_ssl: true,
          username: username, password: password
        }) }).then(function () {
          setBusy(false); setOk("Mailbox connected."); setPassword(""); setEmail(""); setLabel(""); setUsername("");
          setShowForm(false); refresh();
        }).catch(function (e2) { setBusy(false); setErr(String(e2.message || e2)); });
      }

      function del(id) { setConfirmId(null); api("/mailboxes/" + id, { method: "DELETE" }).then(refresh).catch(function () {}); }

      function sumFor(id) {
        if (!summary || !summary.mailboxes) return null;
        for (var i = 0; i < summary.mailboxes.length; i++) if (summary.mailboxes[i].id === id) return summary.mailboxes[i];
        return null;
      }

      var provKeys = providers ? Object.keys(providers) : [];
      var hint = providers && providers[provider] ? providers[provider].hint : "";
      var isManual = provider === "imap";
      var totalUnread = summary ? summary.total_unread : null;

      // ---- Connect form ----
      function field(lbl, node) {
        return h("label", { className: "sm-field" }, h("span", { className: "sm-flabel" }, lbl), node);
      }
      var form = !showForm ? null : h("form", { className: "sm-form", onSubmit: submit },
        h("div", { className: "sm-form-grid" },
          field("Provider", h("select", { className: "sm-input", value: provider,
            onChange: function (e) { applyPreset(e.target.value); } },
            provKeys.map(function (k) { return h("option", { key: k, value: k }, providers[k].label); }))),
          field("Name (optional)", h("input", { className: "sm-input", value: label, placeholder: "e.g. Front desk",
            onChange: function (e) { setLabel(e.target.value); } })),
          field("Email address", h("input", { className: "sm-input", type: "email", value: emailv, placeholder: "you@domain.com",
            onChange: function (e) { setEmail(e.target.value); } })),
          field("Password / app password", h("input", { className: "sm-input", type: "password", value: password, placeholder: "••••••••",
            autoComplete: "new-password", onChange: function (e) { setPassword(e.target.value); } })),
          isManual ? field("IMAP host", h("input", { className: "sm-input", value: host, placeholder: "mail.yourdomain.com",
            onChange: function (e) { setHost(e.target.value); } })) : null,
          isManual ? field("IMAP port", h("input", { className: "sm-input", value: port, onChange: function (e) { setPort(e.target.value); } })) : null,
          isManual ? field("Username (optional)", h("input", { className: "sm-input", value: username, placeholder: "defaults to email",
            onChange: function (e) { setUsername(e.target.value); } })) : null
        ),
        hint ? h("div", { className: "sm-hint" }, hint) : null,
        err ? h("div", { className: "sm-msg sm-err" }, err) : null,
        h("div", { className: "sm-form-actions" },
          h("button", { type: "button", className: "sm-btn sm-ghost", onClick: function () { setShowForm(false); setErr(null); } }, "Cancel"),
          h("button", { type: "submit", className: "sm-btn sm-primary", disabled: busy }, busy ? "Connecting…" : "Connect mailbox"))
      );

      // ---- Mailbox cards ----
      var list = (boxes || []).map(function (b) {
        var sm = sumFor(b.id);
        var unread = sm && sm.unread != null ? sm.unread : null;
        var boxErr = sm && sm.error ? sm.error : null;
        var msgs = sm && sm.messages ? sm.messages : [];
        return h("div", { className: "sm-box", key: b.id },
          h("div", { className: "sm-box-head" },
            h("div", { className: "sm-ava" }, initial(b.email)),
            h("div", { className: "sm-box-id" },
              h("div", { className: "sm-box-label" }, b.label || b.email),
              h("div", { className: "sm-box-email" }, b.email)),
            h("div", { className: "sm-box-right" },
              boxErr ? h("span", { className: "sm-badge sm-badge-err", title: boxErr }, "error")
                : unread == null ? h("span", { className: "sm-badge sm-badge-mut" }, "…")
                : h("span", { className: "sm-badge" }, unread + " unread"),
              confirmId === b.id
                ? h("span", { className: "sm-confirm" },
                    h("button", { className: "sm-x", onClick: function () { del(b.id); } }, "Remove"),
                    h("button", { className: "sm-x sm-x-mut", onClick: function () { setConfirmId(null); } }, "Cancel"))
                : h("button", { className: "sm-iconbtn", title: "Remove", onClick: function () { setConfirmId(b.id); } }, "✕"))),
          boxErr ? h("div", { className: "sm-box-err" }, "Couldn't reach this mailbox: " + boxErr)
            : msgs.length === 0
              ? h("div", { className: "sm-box-empty" }, unread === 0 ? "Inbox zero — nothing unread." : "No unread preview.")
              : h("div", { className: "sm-msgs" }, msgs.map(function (m, i) {
                  return h("div", { className: "sm-msg-row", key: i },
                    h("div", { className: "sm-msg-from" }, m.from || "(unknown sender)"),
                    h("div", { className: "sm-msg-subj" }, m.subject),
                    h("div", { className: "sm-msg-date" }, (m.date || "").slice(0, 16)));
                })));
      });

      return h("div", { className: "sm-wrap" },
        h("div", { className: "sm-top" },
          h("div", null,
            h("div", { className: "sm-h1" }, "Mailboxes"),
            h("div", { className: "sm-sub" }, "Connect the email accounts your agents work with — multiple accounts, any provider.")),
          h("div", { className: "sm-top-right" },
            totalUnread != null ? h("span", { className: "sm-total" }, totalUnread + " unread across " + (summary.mailbox_count || 0)) : null,
            h("button", { className: "sm-btn sm-primary", onClick: function () { setShowForm(!showForm); setErr(null); setOk(null); } },
              showForm ? "Close" : "+ Connect a mailbox"))),
        ok ? h("div", { className: "sm-msg sm-ok" }, ok) : null,
        form,
        (boxes && boxes.length === 0 && !showForm)
          ? h("div", { className: "sm-zero" },
              h("div", { className: "sm-zero-title" }, "No mailboxes connected yet"),
              h("div", { className: "sm-zero-sub" }, "Connect Gmail, Microsoft 365, or any hosted-domain inbox to get started."),
              h("button", { className: "sm-btn sm-primary", onClick: function () { setShowForm(true); } }, "+ Connect a mailbox"))
          : h("div", { className: "sm-list" }, list),
        h("div", { className: "sm-foot" }, "Credentials are encrypted at rest. Passwords are never shown again after you connect.")
      );
    }

    try { PLUGINS.register("suburban-mail", Mailboxes); console.info(TAG, "registered"); }
    catch (e) { try { console.error(TAG, "register failed", e); } catch (e2) {} }

    // ---- Inject a "Mailboxes" nav item in the sidebar ----
    function norm(x) { return (x || "").replace(/\s+/g, " ").trim().toLowerCase(); }
    var NAV_LABELS = { chat: 1, sessions: 1, files: 1, models: 1, logs: 1, cron: 1, skills: 1, plugins: 1, config: 1, overview: 1 };
    function navTemplate() {
      var links = document.querySelectorAll("a[href]");
      for (var i = 0; i < links.length; i++) {
        var t = norm(links[i].textContent);
        if (NAV_LABELS[t]) { var r = links[i].getBoundingClientRect(); if (r.left < 360) return links[i]; }
      }
      return null;
    }
    function href() { return "/mailboxes" + (location.search || ""); }
    function markActive() {
      try {
        var el = document.getElementById("sm-nav"); if (!el) return;
        el.setAttribute("href", href());
        var on = location.pathname === "/mailboxes";
        el.style.borderLeft = on ? "2px solid var(--color-primary,#25c9ee)" : "2px solid transparent";
        el.style.background = on ? "var(--color-accent,rgba(37,201,238,.08))" : "";
      } catch (e) {}
    }
    function injectNav() {
      try {
        if (document.getElementById("sm-nav")) { markActive(); return; }
        var tmpl = navTemplate(); if (!tmpl || !tmpl.parentElement) return;
        var tmplLabel = norm(tmpl.textContent);
        var clone = tmpl.cloneNode(true);
        clone.id = "sm-nav";
        clone.setAttribute("href", href()); try { clone.href = href(); } catch (e) {}
        var w = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT, null), n;
        while ((n = w.nextNode())) { if (norm(n.nodeValue) === tmplLabel) { n.nodeValue = "Mailboxes"; break; } }
        // place it right after the template nav item
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
