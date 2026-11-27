(function () {
  "use strict";
  var TAG = "[suburban-clients]";
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
      if (!opts.raw) opts.headers = Object.assign({ "Content-Type": "application/json" }, opts.headers || {});
      return fetch("/api/connectors" + path, opts).then(function (r) {
        return r.text().then(function (txt) {
          var j = {}; try { j = txt ? JSON.parse(txt) : {}; } catch (e) {}
          if (r.status === 413) throw new Error("That file is too big to upload.");
          if (!r.ok) throw new Error((j && (j.error || j.detail)) || "That didn't work. Please try again.");
          return j;
        });
      });
    }
    function when(iso) {
      if (!iso) return "";
      try { return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }); }
      catch (e) { return ""; }
    }
    function size(n) { return n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB"; }
    function stateWord(s) { return s === "ONLINE" ? "online" : (s ? s.toLowerCase().replace(/_/g, " ") : "unknown"); }
    function plural(n, one, many) { return n + " " + (n === 1 ? one : many); }
    // "unifi:abc123" -> "UniFi site abc123": the scan stores a site's id, not its name.
    function siteWord(ref) {
      var i = ref.indexOf(":"), src = ref.slice(0, i), id = ref.slice(i + 1);
      return (src === "unifi" ? "UniFi" : src) + " site " + (id.length > 10 ? id.slice(0, 8) + "…" : id);
    }
    var FIELDS = ["name", "contact_name", "contact_email", "contact_phone", "address", "website", "plan", "plan_price", "plan_renews", "plan_details", "about"];
    var TABS = [["overview", "Overview"], ["equipment", "Equipment"], ["notes", "Notes"], ["docs", "Documents"], ["leaving", "If they leave"]];

    function Clients() {
      var s;
      s = useState(null);  var list = s[0], setList = s[1];
      s = useState(null);  var cur = s[0], setCur = s[1];        // the open client's whole record
      s = useState(null);  var err = s[0], setErr = s[1];
      s = useState(null);  var msg = s[0], setMsg = s[1];
      s = useState("");    var busy = s[0], setBusy = s[1];
      s = useState("overview"); var tab = s[0], setTab = s[1];
      s = useState(null);  var add = s[0], setAdd = s[1];        // the Add a client form
      s = useState({});    var f = s[0], setF = s[1];            // edits to the open client, not yet saved
      s = useState("");    var q = s[0], setQ = s[1];
      s = useState("active"); var show = s[0], setShow = s[1];
      s = useState("");    var note = s[0], setNote = s[1];
      s = useState(null);  var eq = s[0], setEq = s[1];          // the Add equipment form
      s = useState(false); var linking = s[0], setLinking = s[1];
      s = useState(false); var over = s[0], setOver = s[1];

      function loadList() {
        return api("/clients").then(function (x) { setList(x.clients); setErr(null); })
          .catch(function (e) { setErr(String(e.message || e)); });
      }
      useEffect(function () { loadList(); }, []);

      function take(x) {            // every client route answers with the client, or the list after a delete
        if (!x) return x;
        if (x.clients) { setList(x.clients); setCur(null); }
        else if (x.id) { setCur(x); }
        if (x.message) setMsg(x.message);
        return x;
      }
      function call(name, path, opts) {
        setBusy(name); setErr(null); setMsg(null);
        return api(path, opts).then(function (x) { setBusy(""); return take(x); })
          .catch(function (e) { setBusy(""); setErr(String(e.message || e)); return null; });
      }
      function post(name, path, body, method) {
        return call(name, path, { method: method || "POST", body: JSON.stringify(body || {}) });
      }
      function open(id) {
        setF({}); setTab("overview"); setNote(""); setEq(null); setLinking(false);
        call("open:" + id, "/clients/" + id);
      }
      function back() { setCur(null); setF({}); setMsg(null); setErr(null); loadList(); }
      function create() {
        post("add", "/clients", add).then(function (x) { if (x) { setAdd(null); setF({}); setTab("overview"); } });
      }
      function save() {
        post("save", "/clients/" + cur.id, f, "PATCH").then(function (x) { if (x) { setF({}); setMsg("Saved."); } });
      }
      function upload(files) {
        var todo = Array.prototype.slice.call(files || []);
        if (!todo.length) return;
        setBusy("up"); setErr(null); setMsg(null);
        var failed = [];
        function next() {
          var file = todo.shift();
          if (!file) { setBusy(""); if (failed.length) setErr(failed.join(" ")); return; }
          api("/clients/" + cur.id + "/docs?name=" + encodeURIComponent(file.name),
            { method: "POST", raw: true, body: file, headers: { "Content-Type": file.type || "application/octet-stream" } })
            .then(function (x) { take(x); }, function (e) { failed.push(file.name + ": " + String(e.message || e)); })
            .then(next);
        }
        next();
      }

      function input(label, key, opts) {
        opts = opts || {};
        var val = f[key] !== undefined ? f[key] : (cur[key] || "");
        var props = { className: "cl-in", value: val, placeholder: opts.placeholder || "", spellCheck: !!opts.area,
          onChange: function (e) { var n = Object.assign({}, f); n[key] = e.target.value; setF(n); } };
        if (!opts.area) props.type = opts.type || "text";
        return h("label", { key: key, className: "cl-field" + (opts.wide || opts.area ? " cl-wide" : "") },
          h("span", null, label), h(opts.area ? "textarea" : "input", props));
      }

      function overview() {
        var dirty = FIELDS.some(function (k) { return f[k] !== undefined && f[k] !== (cur[k] || ""); });
        return h("div", { className: "cl-card" },
          h("div", { className: "cl-form" },
            input("Business name", "name"),
            input("Website", "website", { placeholder: "https://" }),
            input("Main contact", "contact_name"),
            input("Email", "contact_email", { type: "email" }),
            input("Phone", "contact_phone", { type: "tel" }),
            input("Address", "address"),
            h("div", { className: "cl-h2 cl-wide" }, "Plan"),
            input("Plan they are on", "plan", { placeholder: "Managed IT, monitoring only, hourly…" }),
            input("Price", "plan_price", { placeholder: "$450 a month" }),
            input("Renews on", "plan_renews", { placeholder: "YYYY-MM-DD" }),
            input("What the plan covers", "plan_details", { area: true }),
            h("div", { className: "cl-h2 cl-wide" }, "About this client"),
            input("Anything worth knowing: how they like to be reached, office hours, who decides", "about", { area: true })),
          h("div", { className: "cl-acts" },
            dirty ? h("button", { type: "button", className: "cl-btn", onClick: function () { setF({}); } }, "Undo changes") : null,
            h("button", { type: "button", className: "cl-btn cl-primary", disabled: !dirty || busy === "save", onClick: save },
              busy === "save" ? "Saving…" : "Save")));
      }

      function unlinkBtn(kind, ref, label) {
        return h("button", { type: "button", className: "cl-btn", disabled: busy === "ul:" + ref,
          onClick: function () { post("ul:" + ref, "/clients/" + cur.id + "/unlink", { kind: kind, ref: ref }); } }, label || "Unlink");
      }
      function linkBtn(kind, ref, owner) {
        return h("button", { type: "button", className: "cl-btn", disabled: busy === "ln:" + ref, onClick: function () {
          if (owner && !window.confirm("This is linked to " + owner + " now. Move it to " + cur.name + "?")) return;
          post("ln:" + ref, "/clients/" + cur.id + "/links", { kind: kind, ref: ref }); } }, owner ? "Move here" : "Link");
      }
      function row(key, dot, name, dim, right, badge) {
        return h("div", { key: key, className: "cl-row cl-row-sm" },
          h("div", { className: "cl-main" },
            dot === null ? null : h("span", { className: "cl-dot" + (dot === "on" ? " cl-dot-on" : (dot === "bad" ? " cl-dot-bad" : "")), "aria-hidden": "true" }),
            h("div", { className: "cl-meta" },
              h("div", { className: "cl-name" }, name, badge || null),
              dim ? h("div", { className: "cl-dim" }, dim) : null),
            right || null));
      }
      function gearDim(g) { return [g.model, g.ip, stateWord(g.state), g.firmware ? "firmware " + g.firmware : ""].filter(Boolean).join(" · "); }
      function compDim(c) {
        return [c.host && c.host.toLowerCase() !== c.name.toLowerCase() ? c.host : "", c.os_name,
          c.last_seen ? (c.reporting ? "reporting" : "last reported " + when(c.last_seen)) : "no report yet"].concat(c.problems).filter(Boolean).join(" · ");
      }

      function linkPanel() {
        var a = cur.available, none = !a.sites.length && !a.gear.length && !a.computers.length;
        return h("div", { className: "cl-card" },
          h("div", { className: "cl-name" }, "Link equipment from My devices"),
          h("div", { className: "cl-dim" }, "Each device or computer belongs to one client. Link a whole site and gear added to it later is theirs too."),
          none ? h("div", { className: "cl-dim" }, "Nothing left to link. Connect a network or add computers on the My devices page first.") : null,
          a.sites.length ? h("div", { className: "cl-lab" }, "Whole sites") : null,
          a.sites.length ? h("div", { className: "cl-list" }, a.sites.map(function (x) {
            return row("s" + x.ref, null, siteWord(x.ref), plural(x.count, "device", "devices") + ": " + x.names.join(", ") + (x.count > x.names.length ? "…" : "") +
              (x.client ? " · linked to " + x.client : ""), linkBtn("site", x.ref, x.client)); })) : null,
          a.gear.length ? h("div", { className: "cl-lab" }, "Network gear") : null,
          a.gear.length ? h("div", { className: "cl-list" }, a.gear.map(function (g) {
            return row("g" + g.ref, g.state === "ONLINE" ? "on" : "bad", g.name, gearDim(g) + (g.client ? " · linked to " + g.client : ""), linkBtn("device", g.ref, g.client)); })) : null,
          a.computers.length ? h("div", { className: "cl-lab" }, "Computers and servers") : null,
          a.computers.length ? h("div", { className: "cl-list" }, a.computers.map(function (c) {
            return row("c" + c.ref, c.reporting ? "on" : "", c.name, compDim(c) + (c.client ? " · linked to " + c.client : ""), linkBtn("computer", c.ref, c.client)); })) : null,
          h("div", { className: "cl-acts" }, h("button", { type: "button", className: "cl-btn", onClick: function () { setLinking(false); } }, "Done")));
      }

      function equipment() {
        var empty = !cur.gear.length && !cur.computers.length && !cur.equipment.length;
        return h("div", { className: "cl-wrap" },
          h("div", { className: "cl-bar" },
            h("div", { className: "cl-dim" }, empty ? "Nothing linked yet." : "Live status comes from the My devices page."),
            linking || eq ? null : h("div", { className: "cl-acts" },
              h("button", { type: "button", className: "cl-btn", onClick: function () { setEq({ name: "", kind: "", detail: "" }); } }, "Add by hand"),
              h("button", { type: "button", className: "cl-btn cl-primary", onClick: function () { setLinking(true); } }, "Link from My devices"))),
          linking ? linkPanel() : null,
          eq ? h("div", { className: "cl-card" },
            h("div", { className: "cl-name" }, "Add equipment by hand"),
            h("div", { className: "cl-dim" }, "For things nothing scans in: a printer, a phone system, another brand of firewall. Do not put passwords here."),
            h("div", { className: "cl-form" },
              h("label", { className: "cl-field" }, h("span", null, "Name"),
                h("input", { className: "cl-in", type: "text", value: eq.name, onChange: function (e) { setEq(Object.assign({}, eq, { name: e.target.value })); } })),
              h("label", { className: "cl-field" }, h("span", null, "What it is"),
                h("input", { className: "cl-in", type: "text", placeholder: "Firewall, printer, NAS…", value: eq.kind, onChange: function (e) { setEq(Object.assign({}, eq, { kind: e.target.value })); } })),
              h("label", { className: "cl-field cl-wide" }, h("span", null, "Details"),
                h("input", { className: "cl-in", type: "text", placeholder: "Model, serial number, where it sits, warranty date", value: eq.detail,
                  onChange: function (e) { setEq(Object.assign({}, eq, { detail: e.target.value })); } }))),
            h("div", { className: "cl-acts" },
              h("button", { type: "button", className: "cl-btn", onClick: function () { setEq(null); } }, "Cancel"),
              h("button", { type: "button", className: "cl-btn cl-primary", disabled: busy === "eq" || !eq.name.trim(),
                onClick: function () { post("eq", "/clients/" + cur.id + "/equipment", eq).then(function (x) { if (x) setEq(null); }); } }, busy === "eq" ? "Adding…" : "Add"))) : null,
          cur.sites.length ? h("div", { className: "cl-h2" }, "Linked sites") : null,
          cur.sites.length ? h("div", { className: "cl-list" }, cur.sites.map(function (ref) {
            return row("s" + ref, null, siteWord(ref), "Everything in this site belongs to this client.", unlinkBtn("site", ref, "Unlink site")); })) : null,
          cur.gear.length ? h("div", { className: "cl-h2" }, "Network gear (" + cur.gear.length + ")") : null,
          cur.gear.length ? h("div", { className: "cl-list" }, cur.gear.map(function (g) {
            return row("g" + g.ref, g.state === "ONLINE" ? "on" : "bad", g.name, gearDim(g) + (g.via_site ? " · from a linked site" : ""),
              g.via_site ? null : unlinkBtn("device", g.ref), g.update_waiting ? h("span", { className: "cl-badge" }, "Update waiting") : null); })) : null,
          cur.computers.length ? h("div", { className: "cl-h2" }, "Computers and servers (" + cur.computers.length + ")") : null,
          cur.computers.length ? h("div", { className: "cl-list" }, cur.computers.map(function (c) {
            return row("c" + c.ref, c.reporting ? "on" : (c.last_seen ? "bad" : ""), c.name, compDim(c), unlinkBtn("computer", c.ref),
              c.problems.length ? h("span", { className: "cl-badge" }, "Needs a look") : null); })) : null,
          cur.equipment.length ? h("div", { className: "cl-h2" }, "Added by hand (" + cur.equipment.length + ")") : null,
          cur.equipment.length ? h("div", { className: "cl-list" }, cur.equipment.map(function (e) {
            return row("e" + e.id, null, e.name, [e.kind, e.detail].filter(Boolean).join(" · "),
              h("button", { type: "button", className: "cl-btn", disabled: busy === "eqrm:" + e.id, onClick: function () {
                if (window.confirm("Remove " + e.name + " from this client?")) call("eqrm:" + e.id, "/clients/" + cur.id + "/equipment/" + e.id, { method: "DELETE" }); } }, "Remove")); })) : null,
          cur.missing.length ? h("div", { className: "cl-h2" }, "No longer on My devices") : null,
          cur.missing.length ? h("div", { className: "cl-list" }, cur.missing.map(function (m) {
            return row("m" + m.kind + m.ref, "", m.kind === "site" ? siteWord(m.ref) : (m.kind === "computer" ? "A computer that was removed" : "A device that is gone"),
              "It was removed, or the network it was on is no longer connected.", unlinkBtn(m.kind, m.ref, "Clear")); })) : null);
      }

      function notes() {
        return h("div", { className: "cl-wrap" },
          h("div", { className: "cl-card" },
            h("label", { className: "cl-field cl-wide", style: { maxWidth: "none" } }, h("span", null, "New note"),
              h("textarea", { className: "cl-in", value: note, placeholder: "What was done, what was agreed, what to remember. Do not put passwords here.",
                onChange: function (e) { setNote(e.target.value); } })),
            h("div", { className: "cl-acts" },
              h("button", { type: "button", className: "cl-btn cl-primary", disabled: busy === "note" || !note.trim(),
                onClick: function () { post("note", "/clients/" + cur.id + "/notes", { text: note }).then(function (x) { if (x) setNote(""); }); } },
                busy === "note" ? "Saving…" : "Add note"))),
          cur.notes.length ? h("div", { className: "cl-list" }, cur.notes.map(function (n) {
            return h("div", { key: n.id, className: "cl-row" },
              h("div", { className: "cl-bar" },
                h("span", { className: "cl-dim" }, when(n.created_at) + (n.added_by && n.added_by !== "You" ? " · " + n.added_by : "")),
                h("button", { type: "button", className: "cl-link", disabled: busy === "nrm:" + n.id, onClick: function () {
                  if (window.confirm("Delete this note?")) call("nrm:" + n.id, "/clients/" + cur.id + "/notes/" + n.id, { method: "DELETE" }); } }, "Delete")),
              h("div", { className: "cl-note" }, n.text)); }))
            : h("div", { className: "cl-dim" }, "No notes yet. Your agents can add notes here too when they do work for this client."));
      }

      function docs() {
        return h("div", { className: "cl-wrap" },
          h("div", { className: "cl-drop" + (over ? " cl-drop-on" : ""),
            onDragOver: function (e) { e.preventDefault(); setOver(true); }, onDragLeave: function () { setOver(false); },
            onDrop: function (e) { e.preventDefault(); setOver(false); if (busy !== "up") upload(e.dataTransfer && e.dataTransfer.files); } },
            h("label", { className: "cl-btn cl-primary" }, busy === "up" ? "Uploading…" : "Choose files",
              h("input", { type: "file", multiple: true, disabled: busy === "up", style: { position: "absolute", width: "1px", height: "1px", opacity: 0 },
                onChange: function (e) { upload(e.target.files); e.target.value = ""; } })),
            h("span", { className: "cl-dim" }, "or drop them here. Contracts, network diagrams, quotes, licences. Up to 20 MB each.")),
          cur.docs.length ? h("div", { className: "cl-list" }, cur.docs.map(function (d) {
            return row("d" + d.id, null, d.name, size(d.size) + " · added " + when(d.created_at),
              h("div", { className: "cl-acts" },
                h("a", { className: "cl-link", href: "/api/connectors/clients/" + cur.id + "/docs/" + d.id, download: d.name }, "Download"),
                h("button", { type: "button", className: "cl-btn", disabled: busy === "drm:" + d.id, onClick: function () {
                  if (window.confirm("Delete " + d.name + "? This cannot be undone.")) call("drm:" + d.id, "/clients/" + cur.id + "/docs/" + d.id, { method: "DELETE" }); } }, "Delete"))); }))
            : h("div", { className: "cl-dim" }, "No documents yet."));
      }

      function leaving() {
        var left = cur.offboard.filter(function (x) { return !x.done_at; }).length, archived = cur.status === "archived";
        return h("div", { className: "cl-wrap" },
          h("div", { className: "cl-card" },
            h("div", { className: "cl-name" }, "When this client leaves"),
            h("div", { className: "cl-dim" }, "Most of your access lives on their systems, so Agent OS cannot take it away for you. Tick each step as you do it, then archive the client. " +
              "Archiving keeps the record, notes and documents and changes nothing on their side."),
            cur.offboard.map(function (x) {
              return h("label", { key: x.key, className: "cl-tick" },
                h("input", { type: "checkbox", checked: !!x.done_at, disabled: busy === "off:" + x.key,
                  onChange: function (e) { post("off:" + x.key, "/clients/" + cur.id + "/offboard", { step: x.key, done: e.target.checked }); } }),
                h("span", null, h("strong", null, x.title), h("div", { className: "cl-dim" }, x.help + (x.done_at ? " Done " + when(x.done_at) + "." : "")))); }),
            h("div", { className: "cl-acts cl-left" },
              archived
                ? h("button", { type: "button", className: "cl-btn", disabled: busy === "st", onClick: function () { post("st", "/clients/" + cur.id, { status: "active" }, "PATCH"); } }, "Make active again")
                : h("button", { type: "button", className: "cl-btn cl-primary", disabled: busy === "st", onClick: function () {
                    if (left && !window.confirm(plural(left, "step is", "steps are") + " not ticked yet. Archive anyway?")) return;
                    post("st", "/clients/" + cur.id, { status: "archived" }, "PATCH"); } }, "Archive client"))),
          h("div", { className: "cl-card" },
            h("div", { className: "cl-name" }, "Delete this client"),
            h("div", { className: "cl-dim" }, "Removes the record with its notes and documents for good. Their devices stay on My devices, unlinked."),
            h("div", { className: "cl-acts cl-left" },
              h("button", { type: "button", className: "cl-btn cl-danger", disabled: busy === "del", onClick: function () {
                if (window.confirm("Delete " + cur.name + " with all its notes and documents? This cannot be undone."))
                  call("del", "/clients/" + cur.id, { method: "DELETE" }); } }, "Delete client"))));
      }

      var banners = [msg ? h("div", { key: "m", className: "cl-msg cl-good", role: "status" }, msg) : null,
        err ? h("div", { key: "e", className: "cl-msg cl-bad", role: "alert" }, err) : null];

      if (cur) {
        return h("div", { className: "cl-wrap" },
          h("div", null, h("button", { type: "button", className: "cl-link", onClick: back }, "← All clients")),
          h("div", { className: "cl-h1" }, cur.name),
          h("div", { className: "cl-sub" }, [cur.status === "archived" ? "Archived" : "", cur.plan, cur.contact_name,
            plural(cur.gear.length + cur.computers.length + cur.equipment.length, "piece of equipment", "pieces of equipment"),
            cur.trouble ? cur.trouble + " need a look" : ""].filter(Boolean).join(" · ")),
          banners,
          h("div", { className: "cl-chips", role: "tablist" }, TABS.map(function (t) {
            return h("button", { key: t[0], type: "button", role: "tab", "aria-selected": tab === t[0], className: "cl-chip" + (tab === t[0] ? " cl-chip-on" : ""),
              onClick: function () { setTab(t[0]); setMsg(null); setErr(null); } },
              t[1] + (t[0] === "notes" && cur.notes.length ? " (" + cur.notes.length + ")" : "") + (t[0] === "docs" && cur.docs.length ? " (" + cur.docs.length + ")" : "")); })),
          tab === "overview" ? overview() : tab === "equipment" ? equipment() : tab === "notes" ? notes() : tab === "docs" ? docs() : leaving());
      }

      if (!list && !err) return h("div", { className: "cl-wrap" }, h("div", { className: "cl-dim" }, "Loading your clients…"));
      var all = list || [], ql = q.trim().toLowerCase();
      var archivedN = all.filter(function (c) { return c.status === "archived"; }).length;
      var shown = all.filter(function (c) {
        if (((archivedN && show === "archived")) !== (c.status === "archived")) return false;
        return !ql || (c.name + " " + c.contact_name + " " + c.plan).toLowerCase().indexOf(ql) >= 0;
      });
      return h("div", { className: "cl-wrap" },
        h("div", { className: "cl-h1" }, "Clients"),
        h("div", { className: "cl-sub" }, "Each business you look after, with its contact, plan, equipment, notes and documents in one place."),
        banners,
        h("div", { className: "cl-bar" },
          all.length ? h("div", { className: "cl-main" },
            h("input", { className: "cl-in cl-search", type: "search", placeholder: "Search name, contact or plan", "aria-label": "Search clients", value: q,
              onChange: function (e) { setQ(e.target.value); } }),
            archivedN ? h("div", { className: "cl-chips", role: "group", "aria-label": "Show" }, [["active", "Active"], ["archived", "Archived (" + archivedN + ")"]].map(function (c) {
              return h("button", { key: c[0], type: "button", className: "cl-chip" + (show === c[0] ? " cl-chip-on" : ""), "aria-pressed": show === c[0],
                onClick: function () { setShow(c[0]); } }, c[1]); })) : null) : h("span", null),
          add ? null : h("button", { type: "button", className: "cl-btn cl-primary", onClick: function () { setAdd({ name: "", contact_name: "", contact_email: "" }); } }, "Add a client")),
        add ? h("div", { className: "cl-card" },
          h("div", { className: "cl-name" }, "Add a client"),
          h("div", { className: "cl-form" },
            [["name", "Business name", "text"], ["contact_name", "Main contact", "text"], ["contact_email", "Email", "email"]].map(function (x) {
              return h("label", { key: x[0], className: "cl-field" }, h("span", null, x[1]),
                h("input", { className: "cl-in", type: x[2], value: add[x[0]], onChange: function (e) { var n = Object.assign({}, add); n[x[0]] = e.target.value; setAdd(n); } })); })),
          h("div", { className: "cl-dim" }, "You can fill in the plan, equipment, notes and documents next."),
          h("div", { className: "cl-acts" },
            h("button", { type: "button", className: "cl-btn", onClick: function () { setAdd(null); } }, "Cancel"),
            h("button", { type: "button", className: "cl-btn cl-primary", disabled: busy === "add" || !add.name.trim(), onClick: create }, busy === "add" ? "Adding…" : "Add client"))) : null,
        shown.length ? h("div", { className: "cl-grid" }, shown.map(function (c) {
          return h("button", { key: c.id, type: "button", className: "cl-tile" + (c.status === "archived" ? " cl-tile-off" : ""), disabled: busy === "open:" + c.id,
            onClick: function () { open(c.id); } },
            h("div", { className: "cl-name" }, c.name,
              c.status === "archived" ? h("span", { className: "cl-badge cl-badge-declined" }, "Archived") : null,
              c.trouble ? h("span", { className: "cl-badge" }, c.trouble + " need a look") : null),
            h("div", { className: "cl-dim" }, [c.plan, c.contact_name].filter(Boolean).join(" · ") || "No plan or contact yet"),
            h("div", { className: "cl-dim" }, [plural(c.equipment, "piece of equipment", "pieces of equipment"), plural(c.notes, "note", "notes"), plural(c.docs, "document", "documents")].join(" · "))); }))
          : (add ? null : h("div", { className: "cl-dim" }, all.length ? "Nothing matches." : "No clients yet. Add your first one to keep everything about them in one place.")));
    }
    try { PLUGINS.register("suburban-clients", Clients); console.info(TAG, "registered"); }
    catch (e) { try { console.error(TAG, "register failed", e); } catch (e2) {} }
  });
})();
