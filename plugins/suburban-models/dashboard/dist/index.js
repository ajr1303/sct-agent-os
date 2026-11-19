(function () {
  "use strict";
  var TAG = "[suburban-models]";
  function whenReady(cb, tries) {
    tries = tries || 0;
    var P = window.__HERMES_PLUGINS__, S = window.__HERMES_PLUGIN_SDK__;
    if (P && S && S.React) { cb(P, S); return; }
    if (tries > 200) { try { console.warn(TAG, "SDK not ready"); } catch (e) {} return; }
    setTimeout(function () { whenReady(cb, tries + 1); }, 50);
  }
  whenReady(function (PLUGINS, SDK) {
    var h = SDK.React.createElement, hooks = SDK.hooks || {}, useState = hooks.useState, useEffect = hooks.useEffect;
    function hermes(name) {
      var a = SDK.api, args = Array.prototype.slice.call(arguments, 1);
      if (!a || typeof a[name] !== "function") return Promise.reject(new Error("This page needs a newer dashboard. Update Agent OS and try again."));
      try { return Promise.resolve(a[name].apply(a, args)); } catch (e) { return Promise.reject(e); }
    }
    function conn(path, opts) {
      opts = opts || {}; opts.credentials = "same-origin";
      opts.headers = Object.assign({ "Content-Type": "application/json" }, opts.headers || {});
      return fetch("/api/connectors" + path, opts).then(function (r) { return r.text().then(function (t) { var j = {}; try { j = t ? JSON.parse(t) : {}; } catch (e) {} if (!r.ok) throw new Error(j.error || j.detail || "That didn't work."); return j; }); });
    }
    function errText(e) {
      var m = String((e && e.message) || e || "");
      try { var j = JSON.parse(m.replace(/^\d+:\s*/, "")); if (j && j.detail) m = String(j.detail); } catch (x) {}
      return m.replace(/^\d{3}:\s*/, "") || "That didn't work. Please try again.";
    }
    // Plain names, and the ones most owners use first.
    var NAMES = { anthropic: "Anthropic (Claude)", openai: "OpenAI (ChatGPT)", "openai-codex": "OpenAI (ChatGPT sign-in)", minimax: "MiniMax", "meta-ai": "Meta (Muse)",
      gemini: "Google Gemini", google: "Google Gemini", openrouter: "OpenRouter", xai: "xAI (Grok)", deepseek: "DeepSeek", nous: "Nous Portal" };
    var POPULAR = ["anthropic", "openai", "minimax", "meta-ai", "gemini", "openrouter", "xai", "deepseek"];
    var ABOUT = { anthropic: "Claude models. Strong at writing, reasoning and careful work.", openai: "GPT models. A solid all-rounder.",
      minimax: "Low-cost models that suit everyday agent work.", "meta-ai": "Meta's Muse models.", gemini: "Google's Gemini models.",
      openrouter: "One key for many providers' models.", xai: "Grok models.", deepseek: "Low-cost models, good at code." };
    function label(p) { return NAMES[p.slug] || p.name || p.slug; }
    function price(p, m) {
      var pr = p.pricing && p.pricing[m];
      if (!pr) return "";
      if (pr.free) return "Free";
      if (!pr.input && !pr.output) return "";
      return (pr.input || "?") + " in · " + (pr.output || "?") + " out, per million tokens";
    }

    function Models() {
      var s;
      s = useState(null);  var opts = s[0], setOpts = s[1];        // {providers, model, provider}
      s = useState(null);  var env = s[0], setEnv = s[1];          // key name -> {is_set, url}
      s = useState(null);  var team = s[0], setTeam = s[1];        // providers with agents, from the Usage data
      s = useState(null);  var err = s[0], setErr = s[1];
      s = useState(false); var picking = s[0], setPicking = s[1];
      s = useState("");    var pSel = s[0], setPSel = s[1];
      s = useState("");    var mSel = s[0], setMSel = s[1];
      s = useState(false); var allModels = s[0], setAllModels = s[1];
      s = useState(null);  var confirm = s[0], setConfirm = s[1];  // warning text for an expensive model
      s = useState(false); var busy = s[0], setBusy = s[1];
      s = useState(null);  var msg = s[0], setMsg = s[1];
      s = useState(null);  var keyFor = s[0], setKeyFor = s[1];    // provider slug with the key box open
      s = useState("");    var keyVal = s[0], setKeyVal = s[1];
      s = useState(null);  var askRemove = s[0], setAskRemove = s[1];
      s = useState(false); var showAll = s[0], setShowAll = s[1];
      var operator = false; try { operator = window.localStorage.getItem("sct-operator") === "1"; } catch (e) {}

      function load(refresh) {
        return hermes("getModelOptions", refresh ? { refresh: true } : undefined).then(function (o) { setOpts(o); setErr(null); return o; })
          .catch(function (e) { setErr(errText(e)); });
      }
      function loadEnv() { return hermes("getEnvVars").then(setEnv).catch(function () {}); }
      function loadTeam() { return conn("/usage").then(function (u) { setTeam(u.providers || []); }).catch(function () {}); }
      useEffect(function () { load(false); loadEnv(); loadTeam(); }, []);

      var provs = (opts && opts.providers) || [];
      function bySlug(slug) { for (var i = 0; i < provs.length; i++) if (provs[i].slug === slug) return provs[i]; return null; }
      var connected = provs.filter(function (p) { return p.authenticated; });
      var cur = opts ? bySlug(opts.provider) : null;

      function startPick() {
        setPicking(true); setMsg(null); setConfirm(null); setAllModels(false);
        var p = cur && cur.authenticated ? cur : connected[0];
        setPSel(p ? p.slug : ""); setMSel(p && opts.provider === p.slug ? (opts.model || "") : "");
      }
      function save(force) {
        if (!pSel || !mSel) return;
        setBusy(true); setMsg(null);
        var body = { scope: "main", provider: pSel, model: mSel };
        if (force) body.confirm_expensive_model = true;
        hermes("setModelAssignment", body).then(function (r) {
          setBusy(false);
          if (r && r.confirm_required) { setConfirm(r.confirm_message || "This model costs more than most. Use it anyway?"); return; }
          setConfirm(null); setPicking(false);
          setMsg({ ok: true, text: "Saved. New chats and tasks use " + mSel + ". Anything already running finishes on the model it started with." });
          load(false); conn("/orchestration/team/models/refresh", { method: "POST" }).catch(function () {});
        }).catch(function (e) { setBusy(false); setMsg({ ok: false, text: errText(e) }); });
      }
      function saveKey(p) {
        var v = keyVal.trim();
        if (!v || !p.key_env) return;
        setBusy(true); setMsg(null);
        hermes("setEnvVar", p.key_env, v).then(function () {
          setKeyVal(""); setKeyFor(null);
          return Promise.all([load(true), loadEnv()]);
        }).then(function (res) {
          setBusy(false);
          var o = res && res[0], now = null;
          if (o && o.providers) for (var i = 0; i < o.providers.length; i++) if (o.providers[i].slug === p.slug) now = o.providers[i];
          setMsg(now && now.authenticated
            ? { ok: true, text: label(p) + " is connected. You can now choose one of its models." }
            : { ok: true, text: "Key saved. If " + label(p) + " does not show as connected in a minute, press Restart Gateway in the left menu." });
          conn("/orchestration/team/models/refresh", { method: "POST" }).catch(function () {});
        }).catch(function (e) { setBusy(false); setMsg({ ok: false, text: errText(e) }); });
      }
      function removeKey(p) {
        setBusy(true); setMsg(null);
        hermes("deleteEnvVar", p.key_env).then(function () { setAskRemove(null); return Promise.all([load(true), loadEnv()]); })
          .then(function () { setBusy(false); setMsg({ ok: true, text: label(p) + " was disconnected." }); })
          .catch(function (e) { setBusy(false); setAskRemove(null); setMsg({ ok: false, text: errText(e) }); });
      }

      function picker() {
        var p = bySlug(pSel), models = (p && p.models) || [], feat = (p && p.featured_models) || [];
        var rec = feat.filter(function (m) { return models.indexOf(m) >= 0; });
        var list = allModels || !rec.length ? models : rec;
        if (mSel && list.indexOf(mSel) < 0 && models.indexOf(mSel) >= 0) list = [mSel].concat(list);
        return h("div", { className: "sx-pick" },
          h("div", { className: "sx-step" }, h("span", { className: "sx-num" }, "1"), "Choose a provider"),
          connected.length === 0 ? h("div", { className: "sx-empty" }, "No provider is connected yet. Connect one below first.")
            : h("div", { className: "sx-chips" }, connected.map(function (c) {
                return h("button", { key: c.slug, type: "button", className: "sx-chip" + (pSel === c.slug ? " on" : ""),
                  onClick: function () { setPSel(c.slug); setMSel(""); setAllModels(false); setConfirm(null); } }, label(c));
              })),
          p ? h("div", null,
            h("div", { className: "sx-step" }, h("span", { className: "sx-num" }, "2"), "Choose a model"),
            list.length === 0 ? h("div", { className: "sx-empty" }, "This provider has not listed its models yet. Try again in a minute.")
              : h("div", { className: "sx-models" }, list.map(function (m, i) {
                  var caps = (p.capabilities && p.capabilities[m]) || {}, isRec = rec.indexOf(m) === 0;
                  return h("button", { key: m, type: "button", className: "sx-model" + (mSel === m ? " on" : ""), onClick: function () { setMSel(m); setConfirm(null); } },
                    h("span", { className: "sx-radio" }),
                    h("span", { className: "sx-model-main" },
                      h("span", { className: "sx-model-n" }, m,
                        isRec ? h("span", { className: "sx-tag sx-tag-rec" }, "Recommended") : null,
                        caps.fast ? h("span", { className: "sx-tag" }, "Fast") : null,
                        caps.reasoning ? h("span", { className: "sx-tag" }, "Thinks things through") : null,
                        opts.provider === p.slug && opts.model === m ? h("span", { className: "sx-tag" }, "In use now") : null),
                      price(p, m) ? h("span", { className: "sx-model-p" }, price(p, m)) : null));
                })),
            rec.length && models.length > rec.length ? h("button", { type: "button", className: "sx-link", onClick: function () { setAllModels(!allModels); } },
              allModels ? "Show the recommended ones only" : "Show all " + models.length + " models") : null) : null,
          confirm ? h("div", { className: "sx-warn" }, confirm) : null,
          h("div", { className: "sx-acts" },
            confirm ? h("button", { type: "button", className: "sx-btn", disabled: busy, onClick: function () { save(true); } }, busy ? "Saving…" : "Use it anyway")
              : h("button", { type: "button", className: "sx-btn", disabled: busy || !pSel || !mSel, onClick: function () { save(false); } }, busy ? "Saving…" : "Use this model"),
            h("button", { type: "button", className: "sx-btn sx-quiet", disabled: busy, onClick: function () { setPicking(false); setConfirm(null); } }, "Cancel")));
      }

      function provCard(p) {
        var info = (env && p.key_env && env[p.key_env]) || {}, keyed = !!p.key_env, on = !!p.authenticated;
        var agents = 0; (team || []).forEach(function (t) { if (t.id === p.slug || p.slug.indexOf(t.id + "-") === 0) agents += (t.agents || []).length; });
        return h("div", { key: p.slug, className: "sx-prov" + (on ? " on" : "") },
          h("div", { className: "sx-prov-top" },
            h("div", { className: "sx-prov-n" }, label(p)),
            h("span", { className: "sx-status" + (on ? " ok" : "") }, on ? "Connected" : "Not connected")),
          h("div", { className: "sx-prov-d" }, ABOUT[p.slug] || (on ? ((p.models || []).length + " models available.") : "Add a key to use its models."),
            on && agents ? " " + agents + (agents === 1 ? " agent uses it." : " agents use it.") : "",
            opts.provider === p.slug ? " Your main model is from here." : ""),
          p.warning ? h("div", { className: "sx-prov-w" }, p.warning) : null,
          keyFor === p.slug
            ? h("div", { className: "sx-key" },
                h("input", { className: "sx-in", type: "password", autoComplete: "off", autoFocus: true, value: keyVal, placeholder: "Paste the API key from " + label(p),
                  onChange: function (e) { setKeyVal(e.target.value); }, onKeyDown: function (e) { if (e.key === "Enter") saveKey(p); } }),
                h("div", { className: "sx-acts" },
                  h("button", { type: "button", className: "sx-btn", disabled: busy || !keyVal.trim(), onClick: function () { saveKey(p); } }, busy ? "Saving…" : "Save key"),
                  h("button", { type: "button", className: "sx-btn sx-quiet", onClick: function () { setKeyFor(null); setKeyVal(""); } }, "Cancel"),
                  info.url ? h("a", { className: "sx-link", href: info.url, target: "_blank", rel: "noopener noreferrer" }, "Where do I get a key? ↗") : null),
                h("div", { className: "sx-hint" }, "The key is stored on this server and is never shown again."))
            : askRemove === p.slug
              ? h("div", { className: "sx-acts" }, h("span", { className: "sx-hint" }, "Disconnect " + label(p) + "? Agents using it will stop working until you pick another model for them."),
                  h("button", { type: "button", className: "sx-btn sx-danger", disabled: busy, onClick: function () { removeKey(p); } }, "Disconnect"),
                  h("button", { type: "button", className: "sx-btn sx-quiet", onClick: function () { setAskRemove(null); } }, "Keep"))
              : h("div", { className: "sx-acts" },
                  !keyed ? h("span", { className: "sx-hint" }, on ? "Signed in on this server." : "This provider uses a sign-in, which is set up from the server.")
                    : on ? h("button", { type: "button", className: "sx-btn sx-quiet", onClick: function () { setKeyFor(p.slug); setKeyVal(""); setMsg(null); } }, "Replace key")
                    : h("button", { type: "button", className: "sx-btn", onClick: function () { setKeyFor(p.slug); setKeyVal(""); setMsg(null); } }, "Connect"),
                  keyed && on && info.is_set && opts.provider !== p.slug ? h("button", { type: "button", className: "sx-link", onClick: function () { setAskRemove(p.slug); } }, "Disconnect") : null,
                  keyed && !on && info.url ? h("a", { className: "sx-link", href: info.url, target: "_blank", rel: "noopener noreferrer" }, "Get a key ↗") : null));
      }

      if (err && !opts) return h("div", { className: "sx-wrap" }, h("div", { className: "sx-title" }, "AI models"), h("div", { className: "sx-empty" }, err));
      if (!opts) return h("div", { className: "sx-wrap" }, h("div", { className: "sx-title" }, "AI models"), h("div", { className: "sx-empty" }, "Loading…"));

      var first = [], rest = [];
      provs.forEach(function (p) { if (p.is_user_defined && !p.authenticated) return; (p.authenticated || POPULAR.indexOf(p.slug) >= 0 ? first : rest).push(p); });
      first.sort(function (a, b) { return (b.authenticated ? 1 : 0) - (a.authenticated ? 1 : 0) || (POPULAR.indexOf(a.slug) < 0 ? 99 : POPULAR.indexOf(a.slug)) - (POPULAR.indexOf(b.slug) < 0 ? 99 : POPULAR.indexOf(b.slug)); });
      var others = []; (team || []).forEach(function (t) { (t.agents || []).forEach(function (a) { if (a.model && !(a.local && a.model === opts.model)) others.push({ name: a.name, model: a.model, where: a.local ? "This server" : "Its own machine", prov: t.label }); }); });

      return h("div", { className: "sx-wrap" },
        h("div", { className: "sx-title" }, "AI models"),
        h("div", { className: "sx-sub" }, "Choose the AI model your assistant thinks with, and connect the AI providers you have an account with."),
        msg ? h("div", { className: "sx-msg" + (msg.ok ? "" : " sx-err") }, msg.text) : null,

        h("div", { className: "sx-panel" },
          h("div", { className: "sx-panel-h" }, "Your main model", h("span", { className: "sx-panel-r" }, "Used by your assistant and by agents on this server that have no model of their own")),
          h("div", { className: "sx-main" },
            h("div", null,
              h("div", { className: "sx-main-m" }, opts.model || "Not chosen yet"),
              h("div", { className: "sx-main-p" }, cur ? "From " + label(cur) + (price(cur, opts.model) ? " · " + price(cur, opts.model) : "") : (opts.provider || ""))),
            picking ? null : h("button", { type: "button", className: "sx-btn", onClick: startPick }, opts.model ? "Change" : "Choose a model")),
          cur && !cur.authenticated && !picking ? h("div", { className: "sx-warn sx-warn-in" }, label(cur) + " is not connected, so this model will not answer. Connect it below or choose another model.") : null,
          picking ? picker() : null),

        h("div", { className: "sx-panel" },
          h("div", { className: "sx-panel-h" }, "AI providers", h("span", { className: "sx-panel-r" }, "Connect a provider with the API key from your account there")),
          h("div", { className: "sx-provs" }, first.map(provCard)),
          rest.length ? h("div", { className: "sx-more" },
            h("button", { type: "button", className: "sx-link", onClick: function () { setShowAll(!showAll); } }, showAll ? "Show fewer providers" : "Show " + rest.length + " more providers"),
            showAll ? h("div", { className: "sx-provs sx-provs-in" }, rest.map(provCard)) : null) : null),

        others.length ? h("div", { className: "sx-panel" },
          h("div", { className: "sx-panel-h" }, "Agents on a different model", h("span", { className: "sx-panel-r" }, "Change these on the Agents page")),
          h("div", { className: "sx-rows" }, others.map(function (o, i) {
            return h("div", { key: i, className: "sx-row" }, h("span", { className: "sx-row-n" }, o.name), h("span", { className: "sx-row-m" }, o.model), h("span", { className: "sx-row-w" }, o.prov + " · " + o.where));
          })),
          h("div", { className: "sx-foot" }, h("a", { className: "sx-link", href: "/team" + (location.search || "") }, "Open Agents →"))) : null,

        operator ? h("div", { className: "sx-foot sx-foot-out" }, "Helper-task models, mixture of agents and custom endpoints are on the ",
          h("a", { className: "sx-link", href: "/models" + (location.search || "") }, "advanced models page"), ".") : null);
    }

    try { PLUGINS.register("suburban-models", Models); } catch (e) { try { console.error(TAG, e); } catch (e2) {} }
  });
})();
