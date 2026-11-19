(function () {
  "use strict";
  var TAG = "[suburban-memory]";
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
    function when(iso) {
      try {
        var d = new Date(iso), mins = Math.round((Date.now() - d.getTime()) / 60000);
        if (mins < 1) return "just now";
        if (mins < 60) return mins + " min ago";
        if (mins < 1440) return Math.round(mins / 60) + " h ago";
        return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + ", " + d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
      } catch (e) { return ""; }
    }
    function plural(n, one, many) { return n + " " + (n === 1 ? one : many); }
    // What one review did, in a sentence.
    function reviewLine(r) {
      var bits = [];
      if (r.added) bits.push("learned " + plural(r.added, "new thing", "new things"));
      if (r.removed) bits.push("tidied away " + plural(r.removed, "old one", "old ones"));
      if (r.card_updated) bits.push("updated your profile");
      if (r.status === "running") return "In progress…";
      if (!bits.length) return r.status === "failed" ? "Did not finish" : "Nothing new to learn";
      var s = bits.join(", "); return s.charAt(0).toUpperCase() + s.slice(1);
    }

    function Memory() {
      var s;
      s = useState(null);  var data = s[0], setData = s[1];
      s = useState(null);  var err = s[0], setErr = s[1];
      s = useState(null);  var sel = s[0], setSel = s[1];          // open review id
      s = useState(null);  var det = s[0], setDet = s[1];
      s = useState(null);  var msg = s[0], setMsg = s[1];
      s = useState(false); var busy = s[0], setBusy = s[1];
      s = useState(null);  var ask = s[0], setAsk = s[1];          // fact id awaiting "remove?" confirmation
      s = useState("");    var q = s[0], setQ = s[1];

      function load() { return api("/memory").then(function (d) { setData(d); setErr(null); return d; }).catch(function (e) { setErr(String(e.message || e)); }); }
      useEffect(function () { load(); var t = setInterval(load, 30000); return function () { clearInterval(t); }; }, []);
      function openReview(id) {
        if (sel === id) { setSel(null); setDet(null); return; }
        setSel(id); setDet(null);
        api("/memory/reviews/" + encodeURIComponent(id)).then(setDet).catch(function (e) { setDet({ error: String(e.message || e) }); });
      }
      function reviewNow() {
        setBusy(true); setMsg(null);
        api("/memory/review", { method: "POST" }).then(function (r) { setMsg({ ok: true, text: r.message }); setBusy(false); load(); setTimeout(load, 20000); setTimeout(load, 60000); })
          .catch(function (e) { setMsg({ ok: false, text: String(e.message || e) }); setBusy(false); });
      }
      function forget(f) {
        setBusy(true); setMsg(null);
        api("/memory/facts/" + encodeURIComponent(f.id), { method: "DELETE" })
          .then(function (r) { setMsg({ ok: true, text: r.message }); setAsk(null); setBusy(false); load(); })
          .catch(function (e) { setMsg({ ok: false, text: String(e.message || e) }); setAsk(null); setBusy(false); });
      }

      function detail() {
        if (!det) return h("div", { className: "sm-empty" }, "Loading…");
        if (det.error) return h("div", { className: "sm-empty" }, det.error);
        var nothing = !det.added.length && !det.removed.length && !det.card;
        return h("div", { className: "sm-det" },
          nothing ? h("div", { className: "sm-empty" }, det.trimmed ? "The details of this review are older than the memory service keeps." : "This review looked over what it knows and found nothing to change.") : null,
          det.added.length ? h("div", { className: "sm-block" },
            h("div", { className: "sm-h" }, "What it learned"),
            det.added.map(function (a, i) {
              return h("div", { key: i, className: "sm-learn" },
                h("div", { className: "sm-fact-t" }, a.text || "(no longer stored)", a.still_there === false ? h("span", { className: "sm-tag sm-tag-off" }, "since removed") : null),
                h("div", { className: "sm-kind" }, a.kind),
                a.because && a.because.length ? h("div", { className: "sm-because" },
                  h("div", { className: "sm-because-h" }, "Because of"),
                  a.because.map(function (b, j) { return h("div", { key: j, className: "sm-because-i" }, b.text || "(something no longer stored)"); })) : null);
            })) : null,
          det.removed.length ? h("div", { className: "sm-block" },
            h("div", { className: "sm-h" }, "What it tidied away"),
            det.removed.map(function (r, i) {
              return h("div", { key: i, className: "sm-gone" }, h("span", { className: "sm-strike" }, r.text),
                r.replaced_by ? h("div", { className: "sm-kind" }, "Merged into: " + r.replaced_by) : null);
            })) : null,
          det.card && (det.card.added.length || det.card.dropped.length) ? h("div", { className: "sm-block" },
            h("div", { className: "sm-h" }, "Changes to your profile"),
            det.card.added.map(function (x, i) { return h("div", { key: "a" + i, className: "sm-plus" }, "+ " + x); }),
            det.card.dropped.map(function (x, i) { return h("div", { key: "d" + i, className: "sm-minus" }, "– " + x); })) : null);
      }

      if (err && !data) return h("div", { className: "sm-wrap" }, h("div", { className: "sm-title" }, "Memory"), h("div", { className: "sm-empty" }, err));
      if (!data) return h("div", { className: "sm-wrap" }, h("div", { className: "sm-title" }, "Memory"), h("div", { className: "sm-empty" }, "Loading…"));
      if (!data.available) return h("div", { className: "sm-wrap" }, h("div", { className: "sm-title" }, "Memory"), h("div", { className: "sm-empty" }, data.why));

      var facts = data.facts || [], needle = q.trim().toLowerCase();
      var shown = needle ? facts.filter(function (f) { return String(f.text).toLowerCase().indexOf(needle) >= 0; }) : facts;
      var wait = data.review_wait || 0;
      return h("div", { className: "sm-wrap" },
        h("div", { className: "sm-head" },
          h("div", null,
            h("div", { className: "sm-title" }, "Memory"),
            h("div", { className: "sm-sub" }, "What " + (data.assistant || "your assistant") + " has learned about you from your conversations, where each thing came from, and a way to remove anything that is wrong.")),
          data.history ? h("button", { type: "button", className: "sm-btn", disabled: busy || wait > 0, onClick: reviewNow,
            title: "Looks over recent conversations now. Uses your AI model, so it is limited to one every ten minutes." },
            wait > 0 ? "Review again in " + Math.ceil(wait / 60) + " min" : "Review now") : null),
        msg ? h("div", { className: "sm-msg" + (msg.ok ? "" : " sm-err") }, msg.text) : null,

        h("div", { className: "sm-cols" },
          h("div", { className: "sm-col" },
            h("div", { className: "sm-panel" },
              h("div", { className: "sm-panel-h" }, "Your profile", h("span", { className: "sm-panel-r" }, "The short version it keeps in mind in every chat")),
              (data.card || []).length ? h("ul", { className: "sm-card" }, data.card.map(function (c, i) { return h("li", { key: i }, c); }))
                : h("div", { className: "sm-empty" }, "No profile yet. It builds up after a few conversations.")),
            h("div", { className: "sm-panel" },
              h("div", { className: "sm-panel-h" }, "Recent reviews", h("span", { className: "sm-panel-r" }, "It looks over what it knows from time to time")),
              !data.history ? h("div", { className: "sm-empty" }, "This memory service is an older version that does not keep a record of its reviews. Update Agent OS to get it.")
                : (data.reviews || []).length === 0 ? h("div", { className: "sm-empty" }, "No reviews yet. One runs on its own once enough new things have been said, or press Review now.")
                : h("div", { className: "sm-reviews" }, data.reviews.map(function (r) {
                    return h("div", { key: r.id, className: "sm-review" + (sel === r.id ? " open" : "") },
                      h("button", { type: "button", className: "sm-review-b", onClick: function () { openReview(r.id); } },
                        h("span", { className: "sm-review-l" }, reviewLine(r)),
                        h("span", { className: "sm-review-w" }, (r.asked ? "You asked · " : "") + when(r.at)),
                        h("span", { className: "sm-chev" }, sel === r.id ? "–" : "+")),
                      sel === r.id ? detail() : null);
                  })))),
          h("div", { className: "sm-col" },
            h("div", { className: "sm-panel" },
              h("div", { className: "sm-panel-h" }, "Everything it knows about you",
                h("span", { className: "sm-panel-r" }, plural(facts.length, "item", "items") + (data.facts_total > 100 ? ", newest shown" : ""))),
              facts.length > 8 ? h("input", { className: "sm-search", value: q, placeholder: "Search…", onChange: function (e) { setQ(e.target.value); } }) : null,
              shown.length === 0 ? h("div", { className: "sm-empty" }, facts.length ? "Nothing matches." : "Nothing yet. It learns as you talk to it.")
                : h("div", { className: "sm-facts" }, shown.map(function (f) {
                    return h("div", { key: f.id, className: "sm-fact" },
                      h("div", { className: "sm-fact-main" },
                        h("div", { className: "sm-fact-t" }, f.text),
                        h("div", { className: "sm-kind" }, f.kind + (f.at ? " · " + when(f.at) : ""))),
                      ask === f.id
                        ? h("span", { className: "sm-confirm" },
                            h("button", { type: "button", className: "sm-btn sm-danger", disabled: busy, onClick: function () { forget(f); } }, "Remove"),
                            h("button", { type: "button", className: "sm-btn sm-quiet", onClick: function () { setAsk(null); } }, "Keep"))
                        : h("button", { type: "button", className: "sm-link", onClick: function () { setAsk(f.id); }, title: "Remove this if it is wrong" }, "Not right?"));
                  })),
              h("div", { className: "sm-foot" }, "Removing something stops the assistant using it. Your profile catches up at its next review.")))));
    }

    try { PLUGINS.register("suburban-memory", Memory); } catch (e) { try { console.error(TAG, e); } catch (e2) {} }
  });
})();
