(function () {
  "use strict";
  var TAG = "[suburban-projects]";
  function whenReady(cb, tries) {
    tries = tries || 0;
    var P = window.__HERMES_PLUGINS__, S = window.__HERMES_PLUGIN_SDK__;
    if (P && S && S.React) { cb(P, S); return; }
    if (tries > 200) { try { console.warn(TAG, "SDK not ready"); } catch (e) {} return; }
    setTimeout(function () { whenReady(cb, tries + 1); }, 50);
  }
  whenReady(function (PLUGINS, SDK) {
    var h = SDK.React.createElement, hooks = SDK.hooks || {}, useState = hooks.useState, useEffect = hooks.useEffect, useRef = hooks.useRef;
    function parse(r) {
      return r.text().then(function (txt) {
        var j = {}; try { j = txt ? JSON.parse(txt) : {}; } catch (e) {}
        if (!r.ok) {
          if (r.status === 413) throw new Error("That file is too big to upload.");
          throw new Error((j && (j.error || j.detail)) || "That didn't work. Please try again.");
        }
        return j;
      });
    }
    function api(path, opts) {
      opts = opts || {}; opts.credentials = "same-origin";
      opts.headers = Object.assign({ "Content-Type": "application/json" }, opts.headers || {});
      return fetch("/api/connectors" + path, opts).then(parse);
    }
    function sendFile(pid, file) {
      return fetch("/api/connectors/projects/" + pid + "/files?name=" + encodeURIComponent(file.name), {
        method: "POST", credentials: "same-origin", body: file,
        headers: { "Content-Type": file.type || "application/octet-stream" }
      }).then(parse);
    }
    function size(n) { n = Number(n || 0); return n < 1048576 ? Math.max(1, Math.round(n / 1024)) + " KB" : (n / 1048576).toFixed(1) + " MB"; }
    function when(iso) { try { return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }); } catch (e) { return ""; } }
    function plural(n, one, many) { return n + " " + (n === 1 ? one : many); }
    function nice(s) { s = String(s || "").replace(/_/g, " "); return s ? s.charAt(0).toUpperCase() + s.slice(1) : "Not started"; }

    function Projects() {
      var s;
      s = useState(null);  var list = s[0], setList = s[1];
      s = useState(null);  var cur = s[0], setCur = s[1];          // open project (detail)
      s = useState(null);  var err = s[0], setErr = s[1];
      s = useState("");    var busy = s[0], setBusy = s[1];
      s = useState("");    var panel = s[0], setPanel = s[1];      // "" | "new" | "note" | "edit"
      s = useState({ name: "", description: "" }); var f = s[0], setF = s[1];
      s = useState({ title: "", text: "" }); var note = s[0], setNote = s[1];
      s = useState("");    var notes = s[0], setNotes = s[1];      // standing notes being edited
      s = useState(null);  var view = s[0], setView = s[1];        // file being read
      s = useState("");    var prog = s[0], setProg = s[1];
      s = useState(false); var over = s[0], setOver = s[1];
      var pick = useRef(null);

      function fail(e) { setBusy(""); setErr(String(e.message || e)); }
      function loadList() { return api("/projects").then(function (x) { setList(x); }).catch(fail); }
      function open(id) {
        setErr(null); setView(null); setPanel("");
        return api("/projects/" + id).then(function (x) { setCur(x); setNotes(x.instructions || ""); try { window.scrollTo(0, 0); } catch (e) {} }).catch(fail);
      }
      function got(x) { setBusy(""); setCur(x); setNotes(x.instructions || ""); }
      useEffect(function () {
        loadList().then(function () {
          var m = /[?&]p=(\d+)/.exec(window.location.search || "");
          if (m) open(m[1]);
        });
      }, []);
      function back() { setCur(null); setView(null); setErr(null); setPanel(""); loadList(); }

      function create() {
        setBusy("new"); setErr(null);
        api("/projects", { method: "POST", body: JSON.stringify(f) }).then(function (x) { setF({ name: "", description: "" }); setPanel(""); got(x); }).catch(fail);
      }
      function patch(body, name) {
        setBusy(name || "save"); setErr(null);
        return api("/projects/" + cur.id, { method: "PATCH", body: JSON.stringify(body) }).then(function (x) { got(x); setPanel(""); }).catch(fail);
      }
      function upload(files) {
        files = Array.prototype.slice.call(files || []);
        if (!files.length) return;
        var limit = (list && list.file_limit_bytes) || 20971520, problems = [], i = 0, pid = cur.id;
        setErr(null); setBusy("up");
        function next() {
          if (i >= files.length) {
            setBusy(""); setProg("");
            if (problems.length) setErr(problems.join(" "));
            return;
          }
          var file = files[i++];
          setProg("Uploading " + file.name + " (" + i + " of " + files.length + ")…");
          if (file.size > limit) { problems.push(file.name + " is bigger than " + Math.round(limit / 1048576) + " MB and was skipped."); return next(); }
          sendFile(pid, file).then(function (x) { setCur(x); next(); })
            .catch(function (e) { problems.push(file.name + ": " + String(e.message || e)); next(); });
        }
        next();
      }
      function saveNote() {
        setBusy("note"); setErr(null);
        api("/projects/" + cur.id + "/notes", { method: "POST", body: JSON.stringify(note) })
          .then(function (x) { setNote({ title: "", text: "" }); setPanel(""); got(x); }).catch(fail);
      }
      function read(file) {
        setBusy("read" + file.id); setErr(null);
        api("/projects/" + cur.id + "/files/" + file.id + "/text").then(function (x) { setBusy(""); setView(x); }).catch(fail);
      }
      function removeFile(file) {
        if (!window.confirm("Remove “" + file.name + "” from this project? This cannot be undone.")) return;
        setBusy("rm" + file.id); setErr(null);
        api("/projects/" + cur.id + "/files/" + file.id, { method: "DELETE" }).then(function (x) { if (view && view.id === file.id) setView(null); got(x); }).catch(fail);
      }
      function removeProject() {
        if (!window.confirm("Delete the project “" + cur.name + "” and every file and note in it? This cannot be undone. Its tasks stay on the Tasks page.")) return;
        setBusy("del"); setErr(null);
        api("/projects/" + cur.id, { method: "DELETE" }).then(function (x) { setBusy(""); setList(x); setCur(null); }).catch(fail);
      }
      function ask() {
        try { window.sessionStorage.setItem("sct-chat-prefill", "For my project “" + cur.name + "”: "); } catch (e) {}
        window.location.assign("/chat");
      }
      function field(obj, setObj, k) { return function (e) { var n = Object.assign({}, obj); n[k] = e.target.value; setObj(n); }; }

      if (!list && !err) return h("div", { className: "sp-wrap" }, h("div", { className: "sp-dim" }, "Loading…"));

      // ---------- one project ----------
      if (cur) {
        var files = cur.files || [], tasks = cur.tasks || [], archived = cur.status !== "active";
        return h("div", { className: "sp-wrap" },
          h("button", { type: "button", className: "sp-back", onClick: back }, "‹ All projects"),
          h("div", { className: "sp-head" },
            h("div", null,
              h("div", { className: "sp-h1" }, cur.name, archived ? h("span", { className: "sp-tag" }, "Archived") : null),
              cur.description ? h("div", { className: "sp-sub" }, cur.description) : null),
            h("div", { className: "sp-acts" },
              h("button", { type: "button", className: "sp-btn sp-primary", onClick: ask }, "Ask about this project"),
              h("button", { type: "button", className: "sp-btn", onClick: function () { setF({ name: cur.name, description: cur.description || "" }); setPanel(panel === "edit" ? "" : "edit"); } }, "Rename"))),
          err ? h("div", { className: "sp-msg", role: "alert" }, err) : null,

          panel === "edit" ? h("div", { className: "sp-card" },
            h("label", { className: "sp-field" }, h("span", null, "Name"),
              h("input", { className: "sp-in", value: f.name, maxLength: 80, onChange: field(f, setF, "name") })),
            h("label", { className: "sp-field" }, h("span", null, "What it is about"),
              h("input", { className: "sp-in", value: f.description, maxLength: 600, onChange: field(f, setF, "description") })),
            h("div", { className: "sp-acts" },
              h("button", { type: "button", className: "sp-btn", onClick: function () { setPanel(""); } }, "Cancel"),
              h("button", { type: "button", className: "sp-btn sp-primary", disabled: busy === "save" || !f.name.trim(), onClick: function () { patch(f); } }, busy === "save" ? "Saving…" : "Save"))) : null,

          h("div", { className: "sp-card" },
            h("div", { className: "sp-name" }, "Standing notes"),
            h("div", { className: "sp-p" }, "Anything your assistant and agents should always know or do for this project: the goal, who is involved, deadlines, how you want things written. They read this before working on it."),
            h("textarea", { className: "sp-in sp-ta", value: notes, maxLength: 8000, placeholder: "For example: The client is Maria at Lakeside Dental. Go-live is March 3. Keep everything in plain English and copy me on anything sent to her.",
              onChange: function (e) { setNotes(e.target.value); } }),
            h("div", { className: "sp-acts" },
              notes !== (cur.instructions || "") ? h("span", { className: "sp-hint" }, "Not saved yet") : null,
              h("button", { type: "button", className: "sp-btn sp-primary", disabled: busy === "notes" || notes === (cur.instructions || ""),
                onClick: function () { patch({ instructions: notes }, "notes"); } }, busy === "notes" ? "Saving…" : "Save notes"))),

          h("div", { className: "sp-card" },
            h("div", { className: "sp-row-head" },
              h("div", { className: "sp-name" }, "Files and notes", h("span", { className: "sp-count" }, files.length)),
              h("div", { className: "sp-acts" },
                h("button", { type: "button", className: "sp-btn", onClick: function () { setPanel(panel === "note" ? "" : "note"); } }, "Write a note"),
                h("button", { type: "button", className: "sp-btn sp-primary", disabled: busy === "up", onClick: function () { if (pick.current) pick.current.click(); } }, busy === "up" ? "Uploading…" : "Upload files"))),
            h("input", { type: "file", multiple: true, ref: pick, style: { display: "none" },
              onChange: function (e) { upload(e.target.files); e.target.value = ""; } }),
            h("div", { className: "sp-drop" + (over ? " sp-over" : ""),
              onDragOver: function (e) { e.preventDefault(); setOver(true); },
              onDragLeave: function () { setOver(false); },
              onDrop: function (e) { e.preventDefault(); setOver(false); if (busy !== "up") upload(e.dataTransfer && e.dataTransfer.files); } },
              prog || "Drop files here, or use Upload files. PDF, Word, PowerPoint, Excel, text and CSV files can be read by your assistant. Images and other types are kept but not read. Up to " + Math.round(((list && list.file_limit_bytes) || 20971520) / 1048576) + " MB each."),

            panel === "note" ? h("div", { className: "sp-inner" },
              h("label", { className: "sp-field" }, h("span", null, "Title"),
                h("input", { className: "sp-in", value: note.title, maxLength: 120, placeholder: "Call with Maria, Nov 17", onChange: field(note, setNote, "title") })),
              h("label", { className: "sp-field" }, h("span", null, "Note"),
                h("textarea", { className: "sp-in sp-ta", value: note.text, onChange: field(note, setNote, "text") })),
              h("div", { className: "sp-acts" },
                h("span", { className: "sp-hint" }, "A note with the same title as an existing one replaces it. Do not put passwords or keys in notes."),
                h("button", { type: "button", className: "sp-btn", onClick: function () { setPanel(""); } }, "Cancel"),
                h("button", { type: "button", className: "sp-btn sp-primary", disabled: busy === "note" || !note.title.trim() || !note.text.trim(), onClick: saveNote }, busy === "note" ? "Saving…" : "Save note"))) : null,

            files.length ? h("div", { className: "sp-files" }, files.map(function (x) {
              return h("div", { className: "sp-file", key: x.id },
                h("div", { className: "sp-fmain" },
                  h("div", { className: "sp-fname" }, x.name),
                  h("div", { className: "sp-fmeta" }, (x.kind === "note" ? "Note" : size(x.size)) + " · " + (x.added_by ? "from " + x.added_by + " · " : "") + when(x.updated_at)
                    + (x.kind !== "note" && !x.readable ? " · kept, but your assistant cannot read this type" : ""))),
                h("div", { className: "sp-facts" },
                  x.readable ? h("button", { type: "button", className: "sp-link", disabled: busy === "read" + x.id, onClick: function () { read(x); } }, "Read") : null,
                  h("a", { className: "sp-link", href: "/api/connectors/projects/" + cur.id + "/files/" + x.id, download: x.name }, "Download"),
                  h("button", { type: "button", className: "sp-link sp-danger", disabled: busy === "rm" + x.id, onClick: function () { removeFile(x); } }, "Remove")));
            })) : h("div", { className: "sp-dim" }, "Nothing here yet."),

            view ? h("div", { className: "sp-inner" },
              h("div", { className: "sp-row-head" },
                h("div", { className: "sp-name" }, view.name),
                h("button", { type: "button", className: "sp-btn", onClick: function () { setView(null); } }, "Close")),
              h("pre", { className: "sp-pre" }, view.text || "(empty)"),
              view.cut ? h("div", { className: "sp-dim" }, "Only the first part is shown. Download the file to see all of it.") : null) : null),

          h("div", { className: "sp-card" },
            h("div", { className: "sp-name" }, "Tasks", h("span", { className: "sp-count" }, tasks.length)),
            tasks.length ? h("div", { className: "sp-files" }, tasks.map(function (t) {
              return h("div", { className: "sp-file", key: t.key },
                h("div", { className: "sp-fmain" },
                  h("div", { className: "sp-fname" }, t.title || t.key),
                  h("div", { className: "sp-fmeta" }, t.key + " · " + nice(t.status) + (t.agent ? " · " + t.agent : ""))),
                h("div", { className: "sp-facts" }, h("a", { className: "sp-link", href: "/tasks" }, "Open Tasks")));
            })) : h("div", { className: "sp-p" }, "No tasks yet. In Chat, ask for work “for the " + cur.name + " project” and the task shows up here. The agent doing it reads this project's notes and files first.")),

          h("div", { className: "sp-acts sp-left" },
            h("button", { type: "button", className: "sp-btn", disabled: busy === "arch", onClick: function () { patch({ status: archived ? "active" : "archived" }, "arch"); } }, archived ? "Reopen project" : "Archive project"),
            h("button", { type: "button", className: "sp-btn sp-danger", disabled: busy === "del", onClick: removeProject }, "Delete project")));
      }

      // ---------- all projects ----------
      var all = (list && list.projects) || [];
      var live = all.filter(function (p) { return p.status === "active"; }), old = all.filter(function (p) { return p.status !== "active"; });
      function card(p) {
        return h("button", { type: "button", className: "sp-proj" + (p.status === "active" ? "" : " sp-old"), key: p.id, onClick: function () { open(p.id); } },
          h("div", { className: "sp-pname" }, p.name),
          p.description ? h("div", { className: "sp-pdesc" }, p.description) : null,
          h("div", { className: "sp-pmeta" }, plural(p.files, "file", "files") + " · " + plural(p.tasks, "task", "tasks") + " · updated " + when(p.updated_at)));
      }
      return h("div", { className: "sp-wrap" },
        h("div", { className: "sp-head" },
          h("div", null,
            h("div", { className: "sp-h1" }, "Projects"),
            h("div", { className: "sp-sub" }, "One place for each piece of work: its documents, your notes and its tasks. Your assistant and agents read a project before working on it, so you do not have to explain it again.")),
          h("div", { className: "sp-acts" },
            h("button", { type: "button", className: "sp-btn sp-primary", onClick: function () { setF({ name: "", description: "" }); setPanel(panel === "new" ? "" : "new"); setErr(null); } }, "New project"))),
        err ? h("div", { className: "sp-msg", role: "alert" }, err) : null,
        panel === "new" ? h("div", { className: "sp-card" },
          h("label", { className: "sp-field" }, h("span", null, "Name"),
            h("input", { className: "sp-in", value: f.name, maxLength: 80, autoFocus: true, placeholder: "Lakeside Dental website", onChange: field(f, setF, "name") })),
          h("label", { className: "sp-field" }, h("span", null, "What it is about (optional)"),
            h("input", { className: "sp-in", value: f.description, maxLength: 600, placeholder: "New site, booking form and email setup for Dr. Ortiz", onChange: field(f, setF, "description") })),
          h("div", { className: "sp-acts" },
            h("button", { type: "button", className: "sp-btn", onClick: function () { setPanel(""); } }, "Cancel"),
            h("button", { type: "button", className: "sp-btn sp-primary", disabled: busy === "new" || !f.name.trim(), onClick: create }, busy === "new" ? "Creating…" : "Create project"))) : null,
        live.length ? h("div", { className: "sp-grid" }, live.map(card))
          : (panel === "new" ? null : h("div", { className: "sp-card" },
              h("div", { className: "sp-name" }, "No projects yet"),
              h("div", { className: "sp-p" }, "Create one for a client, a job or anything you keep coming back to. Then upload the documents that go with it."))),
        old.length ? h("div", { className: "sp-sec" }, "Archived") : null,
        old.length ? h("div", { className: "sp-grid" }, old.map(card)) : null,
        list ? h("div", { className: "sp-dim" }, size(list.used_bytes) + " of " + size(list.limit_bytes) + " of project storage used. Projects are included in your backups.") : null);
    }
    try { PLUGINS.register("suburban-projects", Projects); console.info(TAG, "registered"); }
    catch (e) { try { console.error(TAG, "register failed", e); } catch (e2) {} }
  });
})();
