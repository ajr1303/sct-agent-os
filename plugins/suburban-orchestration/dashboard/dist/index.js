(function () {
  "use strict";
  var TAG = "[suburban-orchestration]";

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
    var hapi = SDK.api || {};

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

    function attentionCount(att) {
      if (att == null) return null;
      if (typeof att === "number") return att;
      var keys = ["total", "count", "pending", "waiting", "open", "needsAttention"];
      for (var i = 0; i < keys.length; i++) if (typeof att[keys[i]] === "number") return att[keys[i]];
      // sum numeric leaf values as a fallback
      var sum = 0, found = false;
      try { Object.keys(att).forEach(function (k) { if (typeof att[k] === "number") { sum += att[k]; found = true; } }); } catch (e) {}
      return found ? sum : null;
    }

    function pcUrl() { var L = window.__SCT_LINKS__; if (L && L.paperclip) return L.paperclip; return location.protocol + "//" + location.hostname + ":3100/"; }
    function openPc() { try { window.open(pcUrl(), "_blank", "noopener"); } catch (e) {} }

    function Orchestration() {
      var s;
      s = useState(null); var status = s[0], setStatus = s[1];
      s = useState(null); var ov = s[0], setOv = s[1];
      s = useState("");   var apiKey = s[0], setApiKey = s[1];
      s = useState(false); var busy = s[0], setBusy = s[1];
      s = useState(null); var err = s[0], setErr = s[1];
      s = useState(false); var showCreate = s[0], setShowCreate = s[1];
      s = useState("");   var cName = s[0], setCName = s[1];
      s = useState("");   var cInstr = s[0], setCInstr = s[1];
      s = useState("general"); var cRole = s[0], setCRole = s[1];
      s = useState("");   var cModel = s[0], setCModel = s[1];
      s = useState([]);   var modelOpts = s[0], setModelOpts = s[1];
      s = useState(false); var cBusy = s[0], setCBusy = s[1];
      s = useState(null); var cErr = s[0], setCErr = s[1];
      s = useState(null); var delId = s[0], setDelId = s[1];
      s = useState(null); var editId = s[0], setEditId = s[1];
      s = useState("general"); var eRole = s[0], setERole = s[1];
      s = useState("");   var eInstr = s[0], setEInstr = s[1];
      s = useState(false); var eBusy = s[0], setEBusy = s[1];
      s = useState(false); var eLoad = s[0], setELoad = s[1];
      s = useState(null); var eErr = s[0], setEErr = s[1];
      s = useState("create"); var cTab = s[0], setCTab = s[1];   // create | invite
      s = useState("");   var iMsg = s[0], setIMsg = s[1];
      s = useState(null); var iRes = s[0], setIRes = s[1];
      s = useState(false); var iBusy = s[0], setIBusy = s[1];
      s = useState(null); var iErr = s[0], setIErr = s[1];
      s = useState(false); var iCopied = s[0], setICopied = s[1];
      s = useState([]);   var tpls = s[0], setTpls = s[1];
      s = useState("");   var tplId = s[0], setTplId = s[1];
      s = useState(null); var runBusy = s[0], setRunBusy = s[1];  // agent id mid pause/resume
      s = useState(null); var runErr = s[0], setRunErr = s[1];
      s = useState(null); var company = s[0], setCompany = s[1];
      s = useState(false); var coBusy = s[0], setCoBusy = s[1];

      function resumeCompany() {
        setRunErr(null); setCoBusy(true);
        api("/orchestration/company/resume", { method: "POST" })
          .then(function () { setCoBusy(false); load(); })
          .catch(function (e2) { setCoBusy(false); setRunErr("Couldn't resume the company: " + String(e2.message || e2)); });
      }
      function capOffAndResume() {
        setRunErr(null); setCoBusy(true);
        api("/orchestration/budget", { method: "POST", body: JSON.stringify({ budget_cents: 0 }) })
          .then(function () { return api("/orchestration/company/resume", { method: "POST" }); })
          .then(function () { setCoBusy(false); load(); })
          .catch(function (e2) { setCoBusy(false); setRunErr("Couldn't turn off the cap / resume: " + String(e2.message || e2)); });
      }
      function pauseWhy(r) {
        r = String(r || "").toLowerCase();
        if (r === "budget") return "its dollar budget hard-stop tripped. With Hermes agents this usually happens at $0 spent: their runs report tokens but no dollar cost, so Paperclip can't price them and fails closed. Agent OS protects spend with the run fast-stop and your LLM provider's spend limit instead, so turning this cap off is the recommended fix.";
        if (r === "company_archived") return "the company was archived.";
        return "it was paused manually (likely during the earlier runaway-cost cleanup).";
      }

      function isPaused(a) { return String(a.status || "").toLowerCase() === "paused"; }
      function toggleRun(a) {
        setRunErr(null); setRunBusy(a.id);
        var act = isPaused(a) ? "resume" : "pause";
        api("/orchestration/agents/" + encodeURIComponent(a.id) + "/" + act, { method: "POST" })
          .then(function () { setRunBusy(null); load(); })
          .catch(function (e2) { setRunBusy(null); setRunErr((act === "resume" ? "Couldn't resume " : "Couldn't pause ") + a.name + ": " + String(e2.message || e2)); });
      }
      function genInvite(e) {
        if (e) e.preventDefault();
        setIErr(null); setIRes(null); setICopied(false); setIBusy(true);
        api("/orchestration/invite-prompt", { method: "POST", body: JSON.stringify({ message: iMsg }) })
          .then(function (r) { setIBusy(false); setIRes(r); })
          .catch(function (e2) { setIBusy(false); setIErr(String(e2.message || e2)); });
      }
      function copyInvite() {
        var t = (iRes && iRes.inviteMessage) || "";
        try {
          navigator.clipboard.writeText(t).then(function () { setICopied(true); setTimeout(function () { setICopied(false); }, 2500); });
        } catch (e) {}
      }

      function load() {
        api("/orchestration/status").then(function (st) {
          setStatus(st);
          if (st.connected) {
            api("/orchestration/overview").then(setOv).catch(function () {});
            api("/orchestration/company").then(setCompany).catch(function () { setCompany(null); });
          }
        }).catch(function () { setStatus({ paperclip_up: false, connected: false }); });
      }
      useEffect(function () {
        load();
        api("/orchestration/agent-templates").then(function (d) { setTpls((d && d.templates) || []); }).catch(function () {});
        try {
          Promise.resolve(hapi.getModelOptions && hapi.getModelOptions()).then(function (m) {
            if (!m || !m.providers) return;
            var opts = [];
            m.providers.forEach(function (p) {
              if (!p.authenticated) return;
              (p.models || []).forEach(function (md) {
                var id = (md && (md.id || md.slug || md.name)) || md;
                if (typeof id !== "string") return;
                opts.push({ v: p.slug + "|" + id, label: p.name + " · " + id });
              });
            });
            setModelOpts(opts);
            if (opts.length) setCModel(opts[0].v);
          }).catch(function () {});
        } catch (e) {}
        var t = setInterval(load, 30000);
        return function () { clearInterval(t); };
      }, []);

      function connect(e) {
        if (e) e.preventDefault();
        setErr(null);
        if (!apiKey.trim()) { setErr("Paste the Paperclip board API key."); return; }
        setBusy(true);
        api("/orchestration/connect", { method: "POST", body: JSON.stringify({ api_key: apiKey }) })
          .then(function () { setBusy(false); setApiKey(""); load(); })
          .catch(function (e2) { setBusy(false); setErr(String(e2.message || e2)); });
      }
      function disconnect() {
        api("/orchestration/connection", { method: "DELETE" }).then(function () { setOv(null); load(); }).catch(function () {});
      }
      function createAgent(e) {
        if (e) e.preventDefault();
        setCErr(null);
        var nm = cName.trim();
        if (!nm) { setCErr("Enter an agent name."); return; }
        setCBusy(true);
        // 1) Create the Hermes runtime profile (this is the agent in the Agents tab,
        //    with the chosen model). createProfile sets the model inline.
        var parts = (cModel || "").split("|");
        var provider = parts[0], model = parts[1];
        var profileBody = (provider && model) ? { name: nm, provider: provider, model: model } : { name: nm };
        Promise.resolve(hapi.createProfile ? hapi.createProfile(profileBody) : null)
          .then(function (res) {
            if (res && res.ok === false) throw new Error(res.error || res.message || "Could not create the Hermes profile.");
            // 2) Register it in Paperclip for management (role, org, approvals).
            return api("/orchestration/agents", { method: "POST", body: JSON.stringify({ name: nm, instructions: cInstr, role: cRole }) });
          })
          .then(function () { setCBusy(false); setShowCreate(false); setCName(""); setCInstr(""); setCRole("general"); setTplId(""); load(); })
          .catch(function (e2) { setCBusy(false); setCErr(String(e2.message || e2)); });
      }
      function delAgent(a) {
        setDelId(null);
        api("/orchestration/agents/" + a.id, { method: "DELETE" })
          .then(function () {
            // Also remove the matching Hermes profile for unified agents (best-effort).
            try { if (hapi.deleteProfile && a.name) Promise.resolve(hapi.deleteProfile(a.name)).catch(function () {}); } catch (e) {}
            load();
          })
          .catch(function (e2) { setCErr("Delete failed: " + String(e2.message || e2)); load(); });
      }
      function openEdit(a) {
        setDelId(null); setEErr(null); setEditId(a.id);
        setERole(a.role || "general"); setEInstr(""); setELoad(true);
        // Pull the current instructions (role we already have from the roster).
        api("/orchestration/agents/" + a.id)
          .then(function (d) { setELoad(false); if (d) { setERole(d.role || a.role || "general"); setEInstr(d.instructions || ""); } })
          .catch(function (e2) { setELoad(false); setEErr("Couldn't load current instructions: " + String(e2.message || e2)); });
      }
      function saveEdit(e, a) {
        if (e) e.preventDefault();
        setEErr(null); setEBusy(true);
        api("/orchestration/agents/" + a.id, { method: "PUT", body: JSON.stringify({ role: eRole, instructions: eInstr }) })
          .then(function () { setEBusy(false); setEditId(null); load(); })
          .catch(function (e2) { setEBusy(false); setEErr(String(e2.message || e2)); });
      }
      var ROLES = [["general", "General"], ["ceo", "CEO"], ["cto", "CTO"], ["cmo", "CMO"], ["cfo", "CFO"], ["security", "Security"], ["engineer", "Engineer"], ["designer", "Designer"], ["pm", "PM"], ["qa", "QA"], ["devops", "DevOps"], ["researcher", "Researcher"]];

      var up = status ? status.paperclip_up : null;
      var mode = status ? status.mode : null;
      var connected = status ? status.connected : false;
      var agents = ov && ov.agents ? ov.agents : [];
      var att = ov ? attentionCount(ov.attention) : null;

      function stat(label, val, accent) {
        return h("div", { className: "so-stat" },
          h("div", { className: "so-stat-val" + (accent ? " so-accent" : "") }, val),
          h("div", { className: "so-stat-label" }, label));
      }

      return h("div", { className: "so-wrap" },
        h("div", { className: "so-top" },
          h("div", null,
            h("div", { className: "so-h1" }, "Orchestration"),
            h("div", { className: "so-sub" }, "The management layer behind your agents — org chart, schedules, approvals, and audit trail. Agents run in Hermes; Paperclip drives them.")),
          h("div", { className: "so-top-right" },
            mode ? h("span", { className: "so-mode" }, mode === "external" ? "Connected · observe-only" : "Bundled") : null,
            h("span", { className: "so-status" },
              up == null ? h("span", null, h("span", { className: "so-dot so-mut" }), "checking…")
                : up ? h("span", null, h("span", { className: "so-dot so-ok" }), "Control plane running")
                : h("span", null, h("span", { className: "so-dot so-bad" }), "Control plane off")))),

        up === false ? h("div", { className: "so-note" },
          "The orchestration control plane isn't running. It's an opt-in profile (it builds Paperclip from source on first start). Enable it with the ",
          h("code", null, "control-plane"), " compose profile, then redeploy.") : null,

        // running but no key yet -> one-time connect flow
        up && !connected ? h("div", { className: "so-panel" },
          h("div", { className: "so-panel-h" }, "CONNECT THE CONTROL PLANE"),
          h("div", { className: "so-steps" },
            h("div", { className: "so-step" }, h("span", { className: "so-num" }, "1"),
              h("span", null, h("b", null, "Open Paperclip"), " below. First time, create your owner account.")),
            h("div", { className: "so-step" }, h("span", { className: "so-num" }, "2"),
              h("span", null, "In Paperclip, create a ", h("b", null, "board API key"), " (Settings) and copy it.")),
            h("div", { className: "so-step" }, h("span", { className: "so-num" }, "3"),
              h("span", null, "Paste it here so the dashboard can read your agents and approvals."))),
          h("div", { className: "so-connect" },
            h("button", { type: "button", className: "so-btn", onClick: openPc }, "Open Paperclip ↗"),
            h("form", { className: "so-keyform", onSubmit: connect },
              h("input", { className: "so-input", type: "password", value: apiKey, placeholder: "Paperclip board API key",
                autoComplete: "new-password", onChange: function (e) { setApiKey(e.target.value); } }),
              h("button", { className: "so-btn so-primary", type: "submit", disabled: busy }, busy ? "Connecting…" : "Connect"))),
          err ? h("div", { className: "so-msg so-err" }, err) : null) : null,

        up && connected ? h("div", { className: "so-stats" },
          stat("Managed agents", ov ? String(agents.length) : "—"),
          stat("Waiting on you", att == null ? "—" : String(att), true),
          stat("Mode", mode === "external" ? "External" : "Bundled")) : null,

        up && connected && mode !== "external" && company && String(company.status).toLowerCase() === "paused"
          ? h("div", { className: "so-cobanner" },
              h("div", { className: "so-cobanner-txt" },
                h("b", null, "Your company is paused, so no agent can run. "),
                "Paperclip paused it because " + pauseWhy(company.pauseReason)),
              String(company.pauseReason || "").toLowerCase() === "budget"
                ? h("div", { className: "so-cobanner-acts" },
                    h("button", { className: "so-btn so-primary", disabled: coBusy, onClick: capOffAndResume }, coBusy ? "Working…" : "Turn off cap & resume"),
                    h("button", { className: "so-btn", disabled: coBusy, onClick: resumeCompany, title: "Resume but keep the cap (it may pause again)" }, "Resume only"))
                : h("button", { className: "so-btn so-primary", disabled: coBusy, onClick: resumeCompany }, coBusy ? "Resuming…" : "▶ Resume company"))
          : null,

        up && connected ? h("div", { className: "so-panel" },
          h("div", { className: "so-panel-h so-panel-h-row" },
            h("span", null, "MANAGED AGENTS"),
            h("button", { className: "so-btn so-primary so-sm", onClick: function () { setShowCreate(!showCreate); setCErr(null); } }, showCreate ? "Close" : "+ Create agent")),
          showCreate ? h("div", { className: "so-ctabs" },
            h("button", { type: "button", className: "so-ctab" + (cTab === "create" ? " on" : ""), onClick: function () { setCTab("create"); } }, "Create here"),
            h("button", { type: "button", className: "so-ctab" + (cTab === "invite" ? " on" : ""), onClick: function () { setCTab("invite"); } }, "Invite an agent")) : null,
          showCreate && cTab === "invite" ? h("form", { className: "so-createform", onSubmit: genInvite },
            h("div", { className: "so-createhint" },
              "Bring in an agent that already runs somewhere else — another Hermes, OpenClaw, Claude, or any agent that can read a URL. Generate a prompt, paste it into that agent, and it sends a join request. Approve it under Waiting on you and it joins your org."),
            h("textarea", { className: "so-input so-ta", value: iMsg, maxLength: 4000,
              placeholder: "Optional note for the agent — e.g. \"Join as our Front Desk agent and handle inbound bookings.\"",
              onChange: function (e) { setIMsg(e.target.value); } }),
            iErr ? h("div", { className: "so-msg so-err" }, iErr) : null,
            h("div", { className: "so-createactions" },
              h("button", { type: "submit", className: "so-btn so-primary", disabled: iBusy }, iBusy ? "Generating…" : (iRes ? "Generate a new prompt" : "Generate invite prompt"))),
            iRes ? h("div", { className: "so-invite" },
              h("div", { className: "so-flabel" }, "Paste this into the agent"),
              h("textarea", { className: "so-input so-ta so-invite-text", readOnly: true, value: iRes.inviteMessage || "",
                onFocus: function (e) { try { e.target.select(); } catch (x) {} } }),
              h("div", { className: "so-createactions" },
                h("button", { type: "button", className: "so-btn so-primary", onClick: copyInvite }, iCopied ? "Copied ✓" : "Copy prompt")),
              h("div", { className: "so-createhint" },
                (iRes.expiresAt ? "Single-use invite, expires " + new Date(iRes.expiresAt).toLocaleString() + ". " : "") +
                "Treat it like a password — anyone with it can request to join. The join request lands in Waiting on you for approval.")) : null) : null,
          showCreate && cTab === "create" ? h("form", { className: "so-createform", onSubmit: createAgent },
            tpls.length ? h("div", { className: "so-tpls" },
              h("div", { className: "so-flabel" }, "Start from a template"),
              h("div", { className: "so-tplrow" },
                tpls.map(function (t) {
                  return h("button", { key: t.id, type: "button", title: t.summary,
                    className: "so-tpl" + (tplId === t.id ? " on" : ""),
                    onClick: function () { setTplId(t.id); setCName(t.name); setCRole(t.role || "general"); setCInstr(t.instructions || ""); } },
                    h("span", { className: "so-tplname" }, t.name),
                    h("span", { className: "so-tplsum" }, t.summary));
                })),
              h("div", { className: "so-createhint" }, "Fills in the name, role and instructions below. Edit anything before you create.")) : null,
            h("div", { className: "so-createrow" },
              h("input", { className: "so-input", value: cName, placeholder: "Agent name (e.g. Front Desk)",
                onChange: function (e) { setCName(e.target.value); } }),
              h("select", { className: "so-input so-rolesel", value: cRole, onChange: function (e) { setCRole(e.target.value); } },
                ROLES.map(function (r) { return h("option", { key: r[0], value: r[0] }, r[1]); }))),
            modelOpts.length
              ? h("label", { className: "so-field" }, h("span", { className: "so-flabel" }, "Model"),
                  h("select", { className: "so-input", value: cModel, onChange: function (e) { setCModel(e.target.value); } },
                    modelOpts.map(function (o) { return h("option", { key: o.v, value: o.v }, o.label); })))
              : h("div", { className: "so-createhint" }, "No connected models found — add a provider key in the Keys tab, then the agent will use the default model."),
            h("textarea", { className: "so-input so-ta", value: cInstr, placeholder: "Instructions (optional) — what should this agent do?",
              onChange: function (e) { setCInstr(e.target.value); } }),
            h("div", { className: "so-createhint" }, "Creates the agent in your Agents tab (Hermes, with this model) and registers it in Paperclip with the role. Pick CEO to make it your lead."),
            cErr ? h("div", { className: "so-msg so-err" }, cErr) : null,
            h("div", { className: "so-createactions" },
              h("button", { type: "submit", className: "so-btn so-primary", disabled: cBusy }, cBusy ? "Creating…" : "Create agent"))) : null,
          runErr ? h("div", { className: "so-msg so-err" }, runErr) : null,
          ov == null ? h("div", { className: "so-empty" }, "Loading…")
            : (ov.errors && ov.errors.length) ? h("div", { className: "so-empty" }, "Paperclip: " + ov.errors.join("; "))
            : agents.length === 0 ? h("div", { className: "so-empty" }, "No managed agents yet. Use + Create agent to make one.")
            : h("div", { className: "so-list" }, agents.map(function (a, i) {
                var isEditing = editId === a.id;
                return h("div", { className: "so-agentwrap", key: a.id || i },
                  h("div", { className: "so-agent" },
                    h("span", { className: "so-agent-name" }, a.name),
                    h("span", { className: "so-agent-right" },
                      a.role ? h("span", { className: "so-agent-role" + (a.role === "ceo" ? " ceo" : "") }, String(a.role).toUpperCase()) : null,
                      a.status ? h("span", { className: "so-agent-state" + (isPaused(a) ? " paused" : "") }, String(a.status)) : null,
                      mode !== "external" && a.status
                        ? h("button", { className: "so-runbtn" + (isPaused(a) ? " resume" : ""), disabled: runBusy === a.id,
                            title: isPaused(a) ? "Let Paperclip assign and run work for this agent" : "Stop this agent from picking up new work",
                            onClick: function () { toggleRun(a); } },
                            runBusy === a.id ? "…" : (isPaused(a) ? "▶ Resume" : "❚❚ Pause"))
                        : null,
                      delId === a.id
                        ? h("span", { className: "so-confirm" },
                            h("button", { className: "so-x", onClick: function () { delAgent(a); } }, "Delete"),
                            h("button", { className: "so-x so-x-mut", onClick: function () { setDelId(null); } }, "Cancel"))
                        : h("span", { className: "so-agent-btns" },
                            h("button", { className: "so-iconbtn", title: "Edit agent", onClick: function () { if (isEditing) { setEditId(null); } else { openEdit(a); } } }, isEditing ? "Close" : "✎"),
                            h("button", { className: "so-iconbtn", title: "Delete agent", onClick: function () { setEditId(null); setDelId(a.id); } }, "✕")))),
                  isEditing ? h("form", { className: "so-editform", onSubmit: function (e) { saveEdit(e, a); } },
                    eLoad ? h("div", { className: "so-createhint" }, "Loading current settings…") : null,
                    h("label", { className: "so-field" }, h("span", { className: "so-flabel" }, "Role"),
                      h("select", { className: "so-input", value: eRole, onChange: function (e) { setERole(e.target.value); } },
                        ROLES.map(function (r) { return h("option", { key: r[0], value: r[0] }, r[1]); }))),
                    h("label", { className: "so-field" }, h("span", { className: "so-flabel" }, "Instructions"),
                      h("textarea", { className: "so-input so-ta", value: eInstr, placeholder: "What should this agent do?",
                        onChange: function (e) { setEInstr(e.target.value); } })),
                    h("div", { className: "so-createhint" }, "Name and model aren't editable here — model lives on the Hermes profile (Agents tab), and renaming means recreating the agent."),
                    eErr ? h("div", { className: "so-msg so-err" }, eErr) : null,
                    h("div", { className: "so-createactions" },
                      h("button", { type: "submit", className: "so-btn so-primary", disabled: eBusy || eLoad }, eBusy ? "Saving…" : "Save changes"),
                      h("button", { type: "button", className: "so-btn so-ghost", onClick: function () { setEditId(null); } }, "Cancel"))) : null);
              }))) : null,

        up && connected && mode === "external" ? h("div", { className: "so-note so-obs" },
          "Observe-only: this is pointed at an existing Paperclip instance. Agent OS reads status here but does not approve, act, or change anything — use Paperclip directly for those.") : null,

        up && connected ? h("div", { className: "so-managed-foot" },
          h("button", { className: "so-btn so-ghost", onClick: openPc }, "Open Paperclip ↗"),
          h("button", { className: "so-btn so-ghost", onClick: disconnect }, "Disconnect key")) : null,

        h("div", { className: "so-explain" },
          h("div", { className: "so-explain-h" }, "HOW IT FITS"),
          h("div", { className: "so-explain-row" }, h("b", null, "Hermes"), " — the engine room. Where each agent actually runs: model, tools, chat, sessions."),
          h("div", { className: "so-explain-row" }, h("b", null, "Paperclip"), " — the management office. The org chart, task assignment, schedules, budgets, approvals and audit ledger. It drives agents; it doesn't run them."),
          h("div", { className: "so-explain-row" }, h("b", null, "This dashboard"), " — the only cockpit. Paperclip runs headless; you manage everything from here.")),

        h("div", { className: "so-foot" }, "Create, invite, edit, pause/resume and remove agents from here. Model lives on the Hermes profile (Agents tab). A paused agent won't pick up work until you resume it.")
      );
    }

    try { PLUGINS.register("suburban-orchestration", Orchestration); console.info(TAG, "registered"); }
    catch (e) { try { console.error(TAG, "register failed", e); } catch (e2) {} }

    // ---- Inject an "Orchestration" nav item ----
    function norm(x) { return (x || "").replace(/\s+/g, " ").trim().toLowerCase(); }
    var NAV_LABELS = { chat: 1, sessions: 1, files: 1, models: 1, logs: 1, cron: 1, skills: 1, plugins: 1, config: 1, overview: 1, mailboxes: 1, bookings: 1, automations: 1 };
    function navTemplate() {
      var links = document.querySelectorAll("a[href]");
      for (var i = 0; i < links.length; i++) {
        var t = norm(links[i].textContent);
        if (NAV_LABELS[t]) { var r = links[i].getBoundingClientRect(); if (r.left < 360) return links[i]; }
      }
      return null;
    }
    function href() { return "/orchestration" + (location.search || ""); }
    function markActive() {
      try {
        var el = document.getElementById("so-nav"); if (!el) return;
        el.setAttribute("href", href());
        var on = location.pathname === "/orchestration";
        el.style.borderLeft = on ? "2px solid var(--color-primary,#25c9ee)" : "2px solid transparent";
        el.style.background = on ? "var(--color-accent,rgba(37,201,238,.08))" : "";
      } catch (e) {}
    }
    function injectNav() {
      try {
        if (document.getElementById("so-nav")) { markActive(); return; }
        var tmpl = navTemplate(); if (!tmpl || !tmpl.parentElement) return;
        var tmplLabel = norm(tmpl.textContent);
        var clone = tmpl.cloneNode(true);
        clone.id = "so-nav";
        clone.setAttribute("href", href()); try { clone.href = href(); } catch (e) {}
        var w = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT, null), n;
        while ((n = w.nextNode())) { if (norm(n.nodeValue) === tmplLabel) { n.nodeValue = "Orchestration"; break; } }
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
