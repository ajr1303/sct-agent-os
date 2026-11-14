(function () {
  "use strict";
  var TAG = "[suburban-backups]";
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
    function size(b) { b = b || 0; return b >= 1e9 ? (b / 1e9).toFixed(1) + " GB" : b >= 1e6 ? (b / 1e6).toFixed(1) + " MB" : Math.max(1, Math.round(b / 1e3)) + " KB"; }
    function when(iso) { try { return new Date(iso).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); } catch (e) { return ""; } }
    function ago(iso) {
      var s = (Date.now() - new Date(iso).getTime()) / 1000;
      if (!(s >= 0)) return "";
      if (s < 5400) return Math.max(1, Math.round(s / 60)) + " min ago";
      if (s < 129600) return Math.round(s / 3600) + " hours ago";
      return Math.round(s / 86400) + " days ago";
    }
    var PART = { "honcho.sql.gz": "agent memory", "paperclip-db.sql.gz": "team database", "paperclip-files.tar.gz": "team files and keys",
      "n8n.tar.gz": "automations", "connectors.db": "dashboard connections", "hermes-home.tar.gz": "Hermes profiles and skills", "config.tar.gz": "settings" };

    function Backups() {
      var s;
      s = useState(null);  var d = s[0], setD = s[1];
      s = useState(null);  var err = s[0], setErr = s[1];
      s = useState("");    var busy = s[0], setBusy = s[1];
      s = useState(null);  var msg = s[0], setMsg = s[1];          // {where, text}
      s = useState(false); var saved = s[0], setSaved = s[1];
      s = useState("");    var opKey = s[0], setOpKey = s[1];
      s = useState(false); var opEdit = s[0], setOpEdit = s[1];
      s = useState(false); var stEdit = s[0], setStEdit = s[1];
      s = useState({ kind: "gdrive", path: "Agent OS backups", token: "", access_key_id: "", secret_access_key: "", endpoint: "", region: "", config: "" });
      var f = s[0], setF = s[1];

      function load() { return api("/backups").then(function (x) { setD(x); setErr(null); }).catch(function (e) { setErr(String(e.message || e)); }); }
      useEffect(function () { load(); var t = setInterval(load, 30000); return function () { clearInterval(t); }; }, []);
      function call(name, where, path, opts, after) {
        setBusy(name); setMsg(null);
        return api(path, opts).then(function (x) { setBusy(""); setD(x); if (after) after(); })
          .catch(function (e) { setBusy(""); setMsg({ where: where, text: String(e.message || e) }); });
      }
      function note(where) { return msg && msg.where === where ? h("div", { className: "sbk-msg" }, msg.text) : null; }
      function set(k) { return function (e) { var n = Object.assign({}, f); n[k] = e.target.value; setF(n); }; }
      function field(label, k, extra) {
        return h("label", { className: "sbk-field" }, h("span", null, label),
          h("input", Object.assign({ className: "sbk-in", value: f[k], onChange: set(k), autoComplete: "off" }, extra || {})));
      }
      function downloadKit() {
        setMsg(null);
        fetch("/api/connectors/backups/kit", { credentials: "same-origin" }).then(function (r) {
          if (!r.ok) throw new Error("The recovery kit is no longer on this server.");
          return r.blob();
        }).then(function (b) {
          var a = document.createElement("a"); a.href = URL.createObjectURL(b); a.download = "agent-os-recovery-kit.txt";
          document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
        }).catch(function (e) { setMsg({ where: "kit", text: String(e.message || e) }); });
      }

      if (d == null) return h("div", { className: "sbk-wrap" }, h("div", { className: "sbk-h1" }, "Backups"),
        err ? h("div", { className: "sbk-msg" }, err) : h("div", { className: "sbk-dim" }, "Loading…"));

      var st = d.status, enc = d.encryption, rem = d.remote;
      var old = st && (Date.now() - new Date(st.at).getTime()) > 36 * 3600 * 1000;

      // --- last backup -------------------------------------------------------
      var level = !st ? "sbk-warn" : (!st.ok || old) ? "sbk-bad" : (st.uploaded && !(st.missing || []).length) ? "sbk-ok" : "sbk-warn";
      var headline = !st ? "No backup has been made yet"
        : !st.ok ? "The last backup failed"
        : old ? "The last backup is " + ago(st.at).replace(" ago", "") + " old"
        : st.uploaded ? "Backed up and copied off this server" : "Backed up on this server only";
      var statusCard = h("div", { className: "sbk-card sbk-status " + level },
        h("div", { className: "sbk-card-h" },
          h("div", null, h("div", { className: "sbk-name" }, headline),
            st ? h("div", { className: "sbk-sub2" }, when(st.at) + " (" + ago(st.at) + ")" + (st.ok ? " · " + size(st.bytes) : "")) :
              h("div", { className: "sbk-sub2" }, "One runs every night at 3:30am. You can also start one now.")),
          h("button", { type: "button", className: "sbk-btn", disabled: busy === "run" || d.run_requested,
            onClick: function () { call("run", "run", "/backups/run", { method: "POST" }); } },
            d.run_requested ? "Starting within 5 minutes…" : "Back up now")),
        note("run"),
        st && !st.ok && st.error ? h("div", { className: "sbk-msg" }, st.error) : null,
        st && st.ok ? h("div", { className: "sbk-facts" },
          h("div", null, h("span", { className: "sbk-dim" }, "Encrypted"), h("b", null, st.encrypted ? "Yes" : "No")),
          h("div", null, h("span", { className: "sbk-dim" }, "Off-site copy"), h("b", null, st.uploaded ? (rem.kind_label || "Yes") : "No")),
          h("div", null, h("span", { className: "sbk-dim" }, "Parts saved"), h("b", null, (st.components || []).filter(function (c) { return c.ok; }).length + " of " + ((st.components || []).length + (st.missing || []).filter(function (m) { return !(st.components || []).some(function (c) { return c.file === m; }); }).length)))) : null,
        st && st.ok && (st.missing || []).length ? h("div", { className: "sbk-msg" }, "Not in this backup: " +
          st.missing.map(function (m) { return PART[m] || m; }).join(", ") + ". Everything else was saved.") : null,
        st && st.upload_error ? h("div", { className: "sbk-msg" }, st.upload_error) : null,
        st && st.ok && !st.uploaded && !st.upload_error ? h("div", { className: "sbk-dim sbk-p" },
          "This copy lives on the same server as the system it protects. It covers a bad update, not a lost or broken machine. Finish the two steps below to keep a copy somewhere else.") : null);

      // --- step 1: encryption --------------------------------------------------
      var kitBody;
      if (!enc.kit_created) {
        kitBody = h("div", { className: "sbk-col" },
          h("div", { className: "sbk-p" }, "Backups are locked before they leave this server. The recovery kit is the file that opens them. You download it once and keep it somewhere that is not this server."),
          h("div", { className: "sbk-acts" }, h("button", { type: "button", className: "sbk-btn sbk-primary", disabled: busy === "kit",
            onClick: function () { call("kit", "kit", "/backups/kit", { method: "POST", body: "{}" }); } }, "Create recovery kit")));
      } else if (enc.kit_waiting_download) {
        kitBody = h("div", { className: "sbk-col" },
          h("div", { className: "sbk-p" }, "Download the recovery kit and put it in a password manager, or print it and lock it away. Once you confirm, it is deleted from this server and cannot be downloaded again."),
          h("div", { className: "sbk-acts sbk-left" },
            h("button", { type: "button", className: "sbk-btn sbk-primary", onClick: downloadKit }, "Download recovery kit")),
          h("label", { className: "sbk-check" },
            h("input", { type: "checkbox", checked: saved, onChange: function (e) { setSaved(e.target.checked); } }),
            h("span", null, "I have saved the recovery kit somewhere safe that is not this server.")),
          h("div", { className: "sbk-acts sbk-left" }, h("button", { type: "button", className: "sbk-btn", disabled: !saved || busy === "saved",
            onClick: function () { call("saved", "kit", "/backups/kit/saved", { method: "POST" }); } }, "Confirm and remove it from this server")));
      } else {
        kitBody = h("div", { className: "sbk-col" },
          h("div", { className: "sbk-p" }, "Recovery kit saved " + when(enc.kit_saved_at) + ". It is no longer on this server."),
          h("div", { className: "sbk-acts sbk-left" }, h("button", { type: "button", className: "sbk-btn", disabled: busy === "kit",
            onClick: function () {
              if (window.confirm("Make a new recovery kit? Backups made from now on open with the new kit. Older backups still need the old one, so keep both.")) {
                setSaved(false); call("kit", "kit", "/backups/kit", { method: "POST", body: JSON.stringify({ replace: true }) });
              }
            } }, "Lost it? Make a new kit")));
      }
      var opBody = h("div", { className: "sbk-col sbk-op" },
        h("div", { className: "sbk-gname" }, "Second key (optional)"),
        enc.operator_key && !opEdit
          ? h("div", { className: "sbk-p" }, "A second key can also open these backups (ends in " + enc.operator_key_tail + "). If the recovery kit is ever lost, whoever holds that key can still restore this system. ",
              h("button", { type: "button", className: "sbk-link", onClick: function () { setOpEdit(true); setOpKey(""); } }, "Change or remove"))
          : h("div", { className: "sbk-col" },
              h("div", { className: "sbk-p" }, "If someone manages this system for you, paste their public backup key here. They can then restore your backups even if the recovery kit is lost. Only the public half is stored: it can lock backups, not open them."),
              h("div", { className: "sbk-row2" },
                h("input", { className: "sbk-in", value: opKey, placeholder: "age1…", autoComplete: "off", onChange: function (e) { setOpKey(e.target.value); } }),
                h("button", { type: "button", className: "sbk-btn", disabled: busy === "op" || (!opKey.trim() && !enc.operator_key),
                  onClick: function () { call("op", "op", "/backups/operator-key", { method: "PUT", body: JSON.stringify({ key: opKey.trim() }) }, function () { setOpEdit(false); setOpKey(""); }); } },
                  opKey.trim() || !enc.operator_key ? "Save key" : "Remove key"),
                opEdit ? h("button", { type: "button", className: "sbk-btn", onClick: function () { setOpEdit(false); } }, "Cancel") : null)),
        note("op"));
      var encCard = h("div", { className: "sbk-card" },
        h("div", { className: "sbk-step" }, h("span", { className: "sbk-num" + (enc.kit_created && !enc.kit_waiting_download ? " sbk-done" : "") }, "1"),
          h("div", null, h("div", { className: "sbk-name" }, "Lock your backups"),
            h("div", { className: "sbk-sub2" }, enc.recipients === 0 ? "Not set up" : enc.recipients === 1 ? "On · 1 key can open them" : "On · 2 keys can open them"))),
        kitBody, note("kit"), opBody);

      // --- step 2: storage -------------------------------------------------------
      var storeBody;
      if (rem.configured && !stEdit) {
        storeBody = h("div", { className: "sbk-col" },
          h("div", { className: "sbk-p" }, "Connected to " + rem.kind_label + ", folder “" + rem.path + "”. Each night's backup is copied there after it is locked."),
          h("div", { className: "sbk-acts sbk-left" },
            h("button", { type: "button", className: "sbk-btn", onClick: function () { setStEdit(true); setF(Object.assign({}, f, { kind: rem.kind, path: rem.path })); } }, "Change"),
            h("button", { type: "button", className: "sbk-btn", disabled: busy === "rm",
              onClick: function () { if (window.confirm("Stop copying backups to " + rem.kind_label + "? Backups already there are left alone.")) call("rm", "st", "/backups/remote", { method: "DELETE" }); } }, "Disconnect")));
      } else if (!enc.recipients) {
        storeBody = h("div", { className: "sbk-dim sbk-p" }, "Finish step 1 first. Backups only leave this server locked.");
      } else {
        var k = f.kind, fields = {};
        if (k === "gdrive") fields = { token: f.token.trim() };
        if (k === "s3") fields = { access_key_id: f.access_key_id.trim(), secret_access_key: f.secret_access_key.trim(), endpoint: f.endpoint.trim(), region: f.region.trim() };
        if (k === "custom") fields = { config: f.config };
        storeBody = h("form", { className: "sbk-col", onSubmit: function (e) {
            e.preventDefault();
            call("st", "st", "/backups/remote", { method: "PUT", body: JSON.stringify({ kind: k, path: f.path.trim(), fields: fields }) },
              function () { setStEdit(false); setF(Object.assign({}, f, { token: "", secret_access_key: "", config: "" })); });
          } },
          h("div", { className: "sbk-row" },
            h("label", { className: "sbk-field" }, h("span", null, "Where"),
              h("select", { className: "sbk-in", value: k, onChange: set("kind") },
                Object.keys(d.kinds).map(function (id) { return h("option", { key: id, value: id }, d.kinds[id]); }))),
            field(k === "s3" ? "Bucket/folder" : "Folder", "path", { maxLength: 200, placeholder: k === "s3" ? "my-bucket/agent-os" : "Agent OS backups" })),
          k === "gdrive" ? h("div", { className: "sbk-col" },
            h("ol", { className: "sbk-steps" },
              h("li", null, "On your own computer (not this server), install rclone. Windows: open PowerShell and run ", h("code", null, "winget install Rclone.Rclone"), ", then open a new PowerShell window. Mac: ", h("code", null, "brew install rclone"), ". Or download it from rclone.org/downloads."),
              h("li", null, "Run the command below. Your browser opens: sign in with the Google account that should hold the backups and click Allow."),
              h("li", null, "Back in the terminal, copy the block that starts with { and ends with }. Leave out the two arrow lines around it."),
              h("li", null, "Paste it into Token and click Connect. Treat the token like a password.")),
            h("pre", { className: "sbk-code" }, "rclone authorize \"drive\""),
            h("label", { className: "sbk-field" }, h("span", null, "Token"),
              h("textarea", { className: "sbk-in sbk-ta", value: f.token, onChange: set("token"), placeholder: "{\"access_token\":\"…\",\"refresh_token\":\"…\",…}", spellCheck: false, autoComplete: "off" }))) : null,
          k === "s3" ? h("div", { className: "sbk-col" },
            h("div", { className: "sbk-p" }, "Works with Backblaze B2, Wasabi, Cloudflare R2, MinIO and Amazon S3. Use a key that can only reach this one bucket."),
            h("div", { className: "sbk-row" }, field("Endpoint", "endpoint", { placeholder: "https://s3.us-west-002.backblazeb2.com" }), field("Region (if required)", "region", { placeholder: "optional" })),
            h("div", { className: "sbk-row" }, field("Access key ID", "access_key_id"), field("Secret access key", "secret_access_key", { type: "password" }))) : null,
          k === "custom" ? h("div", { className: "sbk-col" },
            h("div", { className: "sbk-p" }, "For OneDrive, SharePoint, Dropbox and anything else rclone supports: on a computer with a browser run “rclone config”, create the connection, then run “rclone config show” and paste that one section here."),
            h("label", { className: "sbk-field" }, h("span", null, "rclone config section"),
              h("textarea", { className: "sbk-in sbk-ta", value: f.config, onChange: set("config"), placeholder: "type = onedrive\ntoken = {…}\ndrive_id = …\ndrive_type = business", spellCheck: false, autoComplete: "off" }))) : null,
          note("st"),
          h("div", { className: "sbk-acts" },
            h("span", { className: "sbk-hint" }, "The connection is tested by writing and deleting a small file. It is stored on this server and never shown again."),
            stEdit ? h("button", { type: "button", className: "sbk-btn", onClick: function () { setStEdit(false); setMsg(null); } }, "Cancel") : null,
            h("button", { type: "submit", className: "sbk-btn sbk-primary", disabled: busy === "st" || !f.path.trim() }, busy === "st" ? "Testing…" : "Connect")));
      }
      var storeCard = h("div", { className: "sbk-card" },
        h("div", { className: "sbk-step" }, h("span", { className: "sbk-num" + (rem.configured ? " sbk-done" : "") }, "2"),
          h("div", null, h("div", { className: "sbk-name" }, "Keep a copy somewhere else"),
            h("div", { className: "sbk-sub2" }, rem.configured ? rem.kind_label : "Not connected"))),
        storeBody, rem.configured && !stEdit ? note("st") : null);

      // --- what is kept ------------------------------------------------------------
      function keep(label, key) {
        return h("label", { className: "sbk-field" }, h("span", null, label),
          h("select", { className: "sbk-in", value: String(d[key]), disabled: busy === "keep", onChange: function (e) {
              var b = {}; b[key] = Number(e.target.value); call("keep", "keep", "/backups/settings", { method: "PUT", body: JSON.stringify(b) });
            } }, [7, 14, 30, 60, 90, 180, 365].concat([d[key]]).filter(function (v, i, a) { return a.indexOf(v) === i; }).sort(function (a, b) { return a - b; })
              .map(function (n) { return h("option", { key: n, value: String(n) }, n + " days"); })));
      }
      var keepCard = h("div", { className: "sbk-card" },
        h("div", { className: "sbk-name" }, "How long backups are kept"),
        h("div", { className: "sbk-row" }, keep("On this server", "keep_local_days"), keep("In cloud storage", "keep_remote_days")),
        note("keep"),
        (d.files || []).length ? h("div", { className: "sbk-files" },
          h("div", { className: "sbk-gname" }, "On this server now"),
          d.files.map(function (x) { return h("div", { key: x.name, className: "sbk-file" }, h("span", null, x.name), h("span", { className: "sbk-dim" }, size(x.bytes) + (x.encrypted ? "" : " · not locked"))); })) : null,
        h("div", { className: "sbk-dim sbk-p" }, "To open or restore a backup, run scripts/restore.sh on the server with the backup file and the recovery kit. Without --apply it only checks that the backup opens and is intact."));

      return h("div", { className: "sbk-wrap" },
        h("div", { className: "sbk-h1" }, "Backups"),
        h("div", { className: "sbk-sub" }, "A full copy of this system is made every night: the team, their memory, automations, connections and settings. Lock it and keep a copy off this server so it survives the machine."),
        err ? h("div", { className: "sbk-msg" }, err) : null,
        statusCard, encCard, storeCard, keepCard);
    }
    try { PLUGINS.register("suburban-backups", Backups); console.info(TAG, "registered"); }
    catch (e) { try { console.error(TAG, "register failed", e); } catch (e2) {} }
  });
})();
