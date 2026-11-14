(function () {
  "use strict";
  var TAG = "[suburban-agents]";

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

    function api(path, opts) {
      opts = opts || {};
      opts.credentials = "same-origin";
      opts.headers = Object.assign({ "Content-Type": "application/json" }, opts.headers || {});
      return fetch("/api/connectors" + path, opts).then(function (r) {
        return r.text().then(function (txt) {
          var j = {}; try { j = txt ? JSON.parse(txt) : {}; } catch (e) {}
          if (!r.ok) throw new Error((j && (j.error || j.detail)) || ("HTTP " + r.status));
          return j;
        });
      });
    }
    function whenStr(iso) {
      try {
        var d = new Date(iso); if (!iso || isNaN(d.getTime())) return "never";
        var secs = Math.floor((Date.now() - d.getTime()) / 1000);
        if (secs < 60) return "just now";
        if (secs < 3600) return Math.floor(secs / 60) + " min ago";
        if (secs < 86400) return Math.floor(secs / 3600) + " h ago";
        return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
      } catch (e) { return ""; }
    }
    var ROLES = [["general", "General"], ["ceo", "CEO"], ["cto", "CTO"], ["cmo", "CMO"], ["cfo", "CFO"], ["security", "Security"], ["engineer", "Engineer"], ["designer", "Designer"], ["pm", "PM"], ["qa", "QA"], ["devops", "DevOps"], ["researcher", "Researcher"]];
    var ST = { running: ["sg-run", "Working"], active: ["sg-ok", "Ready"], idle: ["sg-ok", "Ready"], paused: ["sg-off", "Paused"],
               error: ["sg-warn", "Needs attention"], pending_approval: ["sg-warn", "Awaiting approval"] };
    function st(a) { return ST[String(a.status || "").toLowerCase()] || ["sg-off", a.status || "Unknown"]; }
    function roleLabel(r) { for (var i = 0; i < ROLES.length; i++) if (ROLES[i][0] === r) return ROLES[i][1]; return r || "General"; }
    function pcBase() { var L = window.__SCT_LINKS__; if (L && L.paperclip) return L.paperclip.replace(/\/+$/, ""); return location.protocol + "//" + location.hostname + ":3100"; }

    function Agents() {
      var s;
      s = useState(null);  var data = s[0], setData = s[1];        // {agents, can_edit, paperclip_up}
      s = useState(null);  var sel = s[0], setSel = s[1];          // agent id
      s = useState(null);  var det = s[0], setDet = s[1];          // loaded detail
      s = useState(null);  var f = s[0], setF = s[1];              // form values
      s = useState(false); var busy = s[0], setBusy = s[1];
      s = useState(null);  var msg = s[0], setMsg = s[1];          // {ok, text}
      s = useState(null);  var err = s[0], setErr = s[1];
      s = useState("");    var q = s[0], setQ = s[1];
      s = useState(null);  var mi = s[0], setMi = s[1];            // model-change info for the open agent
      s = useState(null);  var mSel = s[0], setMSel = s[1];        // {provider, model} picked
      s = useState(false); var mAsk = s[0], setMAsk = s[1];

      function load() {
        return api("/orchestration/team").then(function (d) { setData(d); setErr(null); return d; })
          .catch(function (e) { setErr(String(e.message || e)); });
      }
      function loadModel(id) {
        return api("/orchestration/team/" + encodeURIComponent(id) + "/model").then(function (m) { setMi(m); return m; })
          .catch(function () { setMi({ can_change: false, why_not: null, options: [] }); });
      }
      function pollModel(id) {
        setTimeout(function () {
          loadModel(id).then(function (m) {
            if (m && m.job && m.job.state === "running") { pollModel(id); return; }
            api("/orchestration/team/" + encodeURIComponent(id)).then(function (d) {
              setDet(function (old) { return old && old.id === id ? Object.assign({}, old, { model: d.model, provider: d.provider, hermes_version: d.hermes_version, model_checked_at: d.model_checked_at, model_error: d.model_error }) : old; });
            }).catch(function () {});
            load();
          });
        }, 5000);
      }
      function changeModel() {
        var id = sel, pick = mSel;
        setMAsk(false);
        api("/orchestration/team/" + encodeURIComponent(id) + "/model", { method: "POST", body: JSON.stringify(pick) })
          .then(function (r) { setMi(function (old) { return Object.assign({}, old || {}, { job: r.job }); }); setMSel(null); pollModel(id); })
          .catch(function (e) { setMi(function (old) { return Object.assign({}, old || {}, { job: { state: "failed", message: String(e.message || e) } }); }); });
      }
      function modelPanel() {
        if (!mi) return null;
        var job = mi.job, running = job && job.state === "running";
        var jobLine = job ? h("div", { className: "sg-msg " + (job.state === "done" ? "sg-msg-ok" : job.state === "running" ? "" : "sg-msg-err") }, job.message) : null;
        if (!mi.can_change) return (mi.why_not || jobLine) ? h("div", { className: "sg-model" },
          h("div", { className: "sg-flabel" }, "Change model"), jobLine,
          mi.why_not ? h("div", { className: "sg-hint" }, mi.why_not) : null) : null;
        var opts = mi.options || [];
        var curP = (mSel && mSel.provider) || det.provider || (opts[0] && opts[0].slug) || "";
        var prov = opts.filter(function (o) { return o.slug === curP; })[0] || opts[0] || { slug: "", models: [] };
        var curM = (mSel && mSel.model) || (prov.models.indexOf(det.model) >= 0 ? det.model : prov.models[0]) || "";
        var changed = prov.slug !== det.provider || curM !== det.model;
        return h("div", { className: "sg-model" },
          h("div", { className: "sg-flabel" }, "Change model"),
          h("div", { className: "sg-model-row" },
            h("select", { className: "sg-in", "aria-label": "Provider", value: prov.slug, disabled: running,
              onChange: function (e) { var o = opts.filter(function (x) { return x.slug === e.target.value; })[0]; setMSel({ provider: o.slug, model: o.models[0] }); setMAsk(false); } },
              opts.map(function (o) { return h("option", { key: o.slug, value: o.slug }, o.name || o.slug); })),
            h("select", { className: "sg-in", "aria-label": "Model", value: curM, disabled: running,
              onChange: function (e) { setMSel({ provider: prov.slug, model: e.target.value }); setMAsk(false); } },
              prov.models.map(function (m) { return h("option", { key: m, value: m }, m); })),
            mAsk
              ? h("span", { className: "sg-dacts" },
                  h("button", { type: "button", className: "sg-btn sg-primary", onClick: changeModel }, "Yes, switch and restart"),
                  h("button", { type: "button", className: "sg-btn", onClick: function () { setMAsk(false); } }, "Cancel"))
              : h("button", { type: "button", className: "sg-btn", disabled: running || !changed || mi.busy,
                  onClick: function () { setMSel({ provider: prov.slug, model: curM }); setMAsk(true); } }, running ? "Switching…" : "Change model")),
          jobLine,
          h("div", { className: "sg-hint" }, mAsk
            ? "This restarts " + det.name + "'s gateway on its own machine, which takes about a minute. If the new model doesn't come up, the previous one is restored."
            : mi.busy ? det.name + " is working on a task right now. Change its model when it is idle."
            : "Only providers that machine already has a key for are listed. To use another provider, add its key on the machine first."));
      }
      function toForm(d) {
        return { name: d.name || "", title: d.title || "", role: d.role || "general", reports_to: d.reports_to || "",
                 capabilities: d.capabilities || "", instructions: (d.instructions && d.instructions.text) || "" };
      }
      function open(id) {
        setSel(id); setDet(null); setF(null); setMsg(null);
        setMi(null); setMSel(null); setMAsk(false); loadModel(id);
        api("/orchestration/team/" + encodeURIComponent(id)).then(function (d) { setDet(d); setF(toForm(d)); })
          .catch(function (e) { setDet({ id: id, error: String(e.message || e) }); });
      }
      useEffect(function () {
        load();
        var t = setInterval(load, 30000);
        return function () { clearInterval(t); };
      }, []);

      var agents = (data && data.agents) || [];
      var canEdit = !!(data && data.can_edit);
      var byId = {}; agents.forEach(function (a) { byId[a.id] = a; });
      var shown = agents.filter(function (a) {
        var t = q.trim().toLowerCase();
        return !t || (a.name + " " + (a.title || "") + " " + (a.runs_on || "")).toLowerCase().indexOf(t) >= 0;
      });
      var dirty = !!(det && f && JSON.stringify(f) !== JSON.stringify(toForm(det)));

      function set(k) { return function (e) { var n = Object.assign({}, f); n[k] = e.target.value; setF(n); setMsg(null); }; }
      function save(e) {
        e.preventDefault();
        if (!dirty || busy) return;
        var o = toForm(det), body = {};
        Object.keys(f).forEach(function (k) { if (f[k] !== o[k]) body[k] = f[k]; });
        if (body.instructions !== undefined && det.instructions) body.instructions_hash = det.instructions.hash || null;
        setBusy(true); setMsg(null);
        api("/orchestration/team/" + encodeURIComponent(sel), { method: "PUT", body: JSON.stringify(body) })
          .then(function () { return Promise.all([api("/orchestration/team/" + encodeURIComponent(sel)), load()]); })
          .then(function (r) { setBusy(false); setDet(r[0]); setF(toForm(r[0])); setMsg({ ok: true, text: "Saved. The agent uses this from its next task." }); })
          .catch(function (e2) { setBusy(false); setMsg({ ok: false, text: String(e2.message || e2) }); });
      }
      function toggle() {
        var act = String(det.status).toLowerCase() === "paused" ? "resume" : "pause";
        setBusy(true); setMsg(null);
        api("/orchestration/agents/" + encodeURIComponent(sel) + "/" + act, { method: "POST" })
          .then(function () { return Promise.all([api("/orchestration/team/" + encodeURIComponent(sel)), load()]); })
          .then(function (r) { setBusy(false); setDet(Object.assign({}, det, { status: r[0].status, pause_reason: r[0].pause_reason })); })
          .catch(function (e2) { setBusy(false); setMsg({ ok: false, text: String(e2.message || e2) }); });
      }

      function row(a) {
        var x = st(a);
        return h("button", { type: "button", key: a.id, className: "sg-row " + x[0] + (sel === a.id ? " on" : ""), onClick: function () { open(a.id); } },
          h("span", { className: "sg-row-main" },
            h("span", { className: "sg-row-name" }, a.name),
            h("span", { className: "sg-row-sub" }, (a.title || roleLabel(a.role)) + " · " + (a.model || a.runs_on))),
          h("span", { className: "sg-row-st" }, h("span", { className: "sg-dot" }), x[1]));
      }
      function field(label, control, hint) {
        return h("label", { className: "sg-field" }, h("span", { className: "sg-flabel" }, label), control,
          hint ? h("span", { className: "sg-hint" }, hint) : null);
      }
      function modelFact(a) {
        if (a.model) return h("span", null, a.model, a.provider ? h("span", { className: "sg-dim" }, " · " + a.provider) : null,
          h("span", { className: "sg-fact-s" }, "Reported by its Hermes" + (a.hermes_version ? " " + a.hermes_version : "") + ", " + whenStr(a.model_checked_at)));
        if (a.model_checked_at) return h("span", null, h("span", { className: "sg-dim" }, "Unknown"),
          h("span", { className: "sg-fact-s" }, (a.model_error || "Its gateway did not answer.") + " Checked " + whenStr(a.model_checked_at) + "."));
        return h("span", null, h("span", { className: "sg-dim" }, "Not checked yet"),
          h("span", { className: "sg-fact-s" }, "Read from the agent's own Hermes every 30 minutes."));
      }
      function fact(label, val) { return h("div", { className: "sg-fact" }, h("div", { className: "sg-fact-l" }, label), h("div", { className: "sg-fact-v" }, val)); }

      function detail() {
        if (!sel) return h("div", { className: "sg-detail sg-empty" }, "Select an agent to see and edit its details.");
        if (!det) return h("div", { className: "sg-detail sg-empty" }, "Loading…");
        if (det.error) return h("div", { className: "sg-detail sg-empty" }, "Couldn't load this agent: " + det.error);
        var x = st(det), ro = !canEdit, ins = det.instructions || {};
        var mgrs = agents.filter(function (a) { return a.id !== det.id; });
        return h("form", { className: "sg-detail", onSubmit: save },
          h("div", { className: "sg-dhead " + x[0] },
            h("div", null,
              h("div", { className: "sg-dname" }, det.name),
              h("div", { className: "sg-dsub" }, h("span", { className: "sg-dot" }), x[1],
                det.pause_reason ? " (" + String(det.pause_reason).replace(/_/g, " ") + ")" : "")),
            h("div", { className: "sg-dacts" },
              canEdit ? h("button", { type: "button", className: "sg-btn", disabled: busy, onClick: toggle },
                String(det.status).toLowerCase() === "paused" ? "▶ Resume" : "Pause") : null,
              h("a", { className: "sg-link", href: pcBase() + "/", target: "_blank", rel: "noopener" }, "Open Paperclip ↗"))),
          h("div", { className: "sg-facts" },
            fact("Runs on", det.runs_on),
            fact("Model", modelFact(det)),
            fact("Last active", whenStr(det.last_active)),
            fact("Reports to", det.reports_to && byId[det.reports_to] ? byId[det.reports_to].name : "Nobody (top of the team)")),
          modelPanel(),
          ro ? h("div", { className: "sg-note" }, "This dashboard is connected to an external Paperclip in read-only mode. Edit agents there.") : null,
          h("div", { className: "sg-grid" },
            field("Name", h("input", { className: "sg-in", value: f.name, maxLength: 80, disabled: ro || det.local, onChange: set("name") }),
              det.local ? "Runs on this server; the name is tied to its Hermes profile and can't be changed." : null),
            field("Title", h("input", { className: "sg-in", value: f.title, maxLength: 120, disabled: ro, placeholder: "e.g. Help Desk Lead", onChange: set("title") })),
            field("Role", h("select", { className: "sg-in", value: f.role, disabled: ro, onChange: set("role") },
              ROLES.map(function (r) { return h("option", { key: r[0], value: r[0] }, r[1]); }))),
            field("Reports to", h("select", { className: "sg-in", value: f.reports_to, disabled: ro, onChange: set("reports_to") },
              [h("option", { key: "", value: "" }, "Nobody (top of the team)")].concat(
                mgrs.map(function (a) { return h("option", { key: a.id, value: a.id }, a.name + (a.title ? " · " + a.title : "")); }))))),
          field("What this agent does", h("textarea", { className: "sg-in sg-ta", rows: 4, value: f.capabilities, maxLength: 4000, disabled: ro,
            placeholder: "A short description. Other agents and the chat read this to decide who should get a task.", onChange: set("capabilities") })),
          field("Instructions" + (ins.source === "file" && ins.path ? " (" + ins.path + ")" : ""),
            h("textarea", { className: "sg-in sg-ta sg-instr", rows: 16, value: f.instructions, disabled: ro, spellCheck: false,
              placeholder: "How this agent should work: its job, its limits, how it hands work over.", onChange: set("instructions") }),
            ins.other_files ? "This agent has " + ins.other_files + " more instruction file" + (ins.other_files === 1 ? "" : "s") + " in Paperclip. Only the main one is edited here." : null),
          msg ? h("div", { className: "sg-msg " + (msg.ok ? "sg-msg-ok" : "sg-msg-err") }, msg.text) : null,
          canEdit ? h("div", { className: "sg-save" },
            h("span", { className: "sg-hint" }, "Gateway address, keys, budgets and run history are managed in Paperclip."),
            h("span", { className: "sg-dacts" },
              dirty ? h("button", { type: "button", className: "sg-btn", disabled: busy, onClick: function () { setF(toForm(det)); setMsg(null); } }, "Discard") : null,
              h("button", { type: "submit", className: "sg-btn sg-primary", disabled: busy || !dirty }, busy ? "Saving…" : "Save changes"))) : null);
      }

      var up = data ? data.paperclip_up : null;
      return h("div", { className: "sg-wrap" },
        h("div", { className: "sg-top" },
          h("div", null,
            h("div", { className: "sg-h1" }, "Agents"),
            h("div", { className: "sg-sub" }, "Everyone on your team. Open an agent to change what it does, who it reports to and how it works.")),
          agents.length > 6 ? h("input", { className: "sg-in sg-search", value: q, placeholder: "Filter agents…", onChange: function (e) { setQ(e.target.value); } }) : null),
        err ? h("div", { className: "sg-msg sg-msg-err" }, err) : null,
        up === false ? h("div", { className: "sg-note" }, "The control plane isn't running, so there are no agents to show yet.") : null,
        h("div", { className: "sg-cols" },
          h("div", { className: "sg-list" },
            data == null ? h("div", { className: "sg-empty" }, "Loading…")
              : shown.length === 0 ? h("div", { className: "sg-empty" }, agents.length ? "No agent matches." : "No agents yet. Create one on the Orchestration page.")
              : shown.map(row)),
          detail()));
    }

    try { PLUGINS.register("suburban-agents", Agents); console.info(TAG, "registered"); }
    catch (e) { try { console.error(TAG, "register failed", e); } catch (e2) {} }
  });
})();
