(function () {
  "use strict";
  var TAG = "[suburban-chat]";

  function whenReady(cb, tries) {
    tries = tries || 0;
    var P = window.__HERMES_PLUGINS__, S = window.__HERMES_PLUGIN_SDK__;
    if (P && S && S.React) { cb(P, S); return; }
    if (tries > 200) { try { console.warn(TAG, "SDK not ready"); } catch (e) {} return; }
    setTimeout(function () { whenReady(cb, tries + 1); }, 50);
  }

  whenReady(function (PLUGINS, SDK) {
    var h = SDK.React.createElement;
    var useState = SDK.hooks.useState, useEffect = SDK.hooks.useEffect, useRef = SDK.hooks.useRef;
    var api = SDK.api;

    function arr(x) { return Array.isArray(x) ? x : ((x && (x.sessions || x.messages || x.items || x.data || x.profiles)) || []); }
    function extractText(c) {
      if (c == null) return "";
      if (typeof c === "string") return c;
      if (Array.isArray(c)) return c.map(function (p) { return typeof p === "string" ? p : ((p && (p.text || p.content)) || ""); }).join("");
      if (typeof c === "object") return c.text || c.content || "";
      return String(c);
    }
    function ts(s) { return new Date(s.last_activity_at || s.started_at || s.created_at || 0).getTime() || 0; }
    function when(t) { try { if (t == null) return ""; return typeof t === "number" ? SDK.utils.timeAgo(t) : SDK.utils.isoTimeAgo(t); } catch (e) { return ""; } }
    function wsProto() { return location.protocol === "https:" ? "wss" : "ws"; }
    function sessTitle(s) { return (s.title && s.title.trim()) || (s.last_activity_description && s.last_activity_description.trim()) || "New conversation"; }

    function ChatPage() {
      var m0 = useState([]), messages = m0[0], setMessages = m0[1];
      var se0 = useState([]), sessions = se0[0], setSessions = se0[1];
      var a0 = useState(null), activeSid = a0[0], setActiveSid = a0[1];
      var st0 = useState("idle"), status = st0[0], setStatus = st0[1];
      var i0 = useState(""), input = i0[0], setInput = i0[1];
      var p0 = useState([]), pending = p0[0], setPending = p0[1];
      var an0 = useState("Agent"), agentName = an0[0], setAgentName = an0[1];
      var wsRef = useRef(null), activeRef = useRef(null), baseRef = useRef(null),
          scrollRef = useRef(null), atBottomRef = useRef(true);

      // hide the shell's duplicate "Chat" title
      useEffect(function () {
        var hidden = [];
        function hideTitle() {
          try {
            var all = document.querySelectorAll("h1,h2,div,span");
            for (var i = 0; i < all.length; i++) {
              var el = all[i];
              if (el.childElementCount > 0) continue;
              if ((el.textContent || "").trim().toLowerCase() !== "chat") continue;
              if (el.closest && el.closest(".scc-wrap")) continue;
              var r = el.getBoundingClientRect();
              if (r.top < 140 && r.left < 520 && el.style.display !== "none") { el.style.display = "none"; hidden.push(el); }
            }
          } catch (e) {}
        }
        hideTitle(); var t = setInterval(hideTitle, 400);
        return function () { clearInterval(t); hidden.forEach(function (el) { try { el.style.display = ""; } catch (e) {} }); };
      }, []);

      useEffect(function () {
        Promise.resolve(api.getProfiles ? api.getProfiles() : null).then(function (p) {
          var a = arr(p); var def = a.find(function (x) { return x.is_default; }) || a[0];
          if (def) setAgentName(def.display_name || def.name || "Agent");
        }).catch(function () {});
      }, []);

      function openPty(resumeId) {
        try { if (wsRef.current) wsRef.current.close(); } catch (e) {}
        setStatus("connecting");
        Promise.resolve(SDK.buildWsAuthParam()).then(function (pair) {
          var url = wsProto() + "://" + location.host + "/api/pty?" + encodeURIComponent(pair[0]) + "=" + encodeURIComponent(pair[1]);
          if (resumeId) url += "&resume=" + encodeURIComponent(resumeId);
          var ws = new WebSocket(url); ws.binaryType = "arraybuffer"; wsRef.current = ws;
          ws.onopen = function () { setStatus("ready"); };
          ws.onclose = function () { setStatus("closed"); };
          ws.onerror = function () { setStatus("error"); };
        }).catch(function () { setStatus("error"); });
      }

      function newChat() {
        setMessages([]); setPending([]); setActiveSid(null); activeRef.current = null;
        Promise.resolve(api.getSessions()).then(function (ss) {
          baseRef.current = {}; arr(ss).forEach(function (s) { baseRef.current[s.id] = 1; });
        }).catch(function () { baseRef.current = {}; }).then(function () { openPty(null); });
      }

      function openSession(s) {
        if (activeRef.current === s.id) return;
        setMessages([]); setPending([]); baseRef.current = null;
        setActiveSid(s.id); activeRef.current = s.id;
        atBottomRef.current = true;
        openPty(s.id);
      }

      useEffect(function () { newChat(); return function () { try { wsRef.current && wsRef.current.close(); } catch (e) {} }; }, []);

      // poll: refresh session list + active conversation messages
      useEffect(function () {
        var alive = true;
        function poll() {
          Promise.resolve(api.getSessions()).then(function (ss) {
            if (!alive) return;
            var list = arr(ss).slice().sort(function (a, b) { return ts(b) - ts(a); });
            setSessions(list);
            if (!activeRef.current) {
              var base = baseRef.current || {};
              var fresh = list.filter(function (s) { return !base[s.id]; });
              if (fresh.length) { activeRef.current = fresh[0].id; setActiveSid(fresh[0].id); }
            }
            if (activeRef.current) {
              return api.getSessionMessages(activeRef.current).then(function (mm) { if (alive) setMessages(arr(mm)); });
            }
          }).catch(function () {});
        }
        poll(); var t = setInterval(poll, 1500);
        return function () { alive = false; clearInterval(t); };
      }, []);

      useEffect(function () { try { var el = scrollRef.current; if (el && atBottomRef.current) el.scrollTop = el.scrollHeight; } catch (e) {} });
      function onScroll(e) { try { var el = e.target; atBottomRef.current = (el.scrollHeight - el.scrollTop - el.clientHeight) < 60; } catch (x) {} }

      function send() {
        var text = (input || "").trim(); if (!text) return;
        var ws = wsRef.current;
        if (ws && ws.readyState === 1) { try { ws.send(text + "\r"); } catch (e) {} }
        else { openPty(activeRef.current); setTimeout(function () { try { wsRef.current && wsRef.current.readyState === 1 && wsRef.current.send(text + "\r"); } catch (e) {} }, 900); }
        setPending(function (p) { return p.concat([text]); });
        setInput(""); atBottomRef.current = true;
      }
      function onKey(e) { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }

      function avatar(role) {
        if (role === "user") return h("div", { className: "scc-av scc-av-user" }, "You");
        return h("div", { className: "scc-av scc-av-agent" }, (agentName || "A").slice(0, 1).toUpperCase());
      }
      function msgRow(key, role, text, time, pend) {
        return h("div", { className: "scc-msg scc-" + role, key: key },
          avatar(role),
          h("div", { className: "scc-col" },
            h("div", { className: "scc-meta" },
              h("span", { className: "scc-who" }, role === "user" ? "You" : agentName),
              time ? h("span", { className: "scc-time" }, time) : null),
            h("div", { className: "scc-bubble" + (pend ? " scc-pending" : "") }, text)));
      }

      var rows = [];
      (messages || []).forEach(function (msg, i) {
        var role = msg.role; if (role !== "user" && role !== "assistant") return;
        var txt = extractText(msg.content || msg.api_content); if (!txt || !txt.trim()) return;
        rows.push(msgRow("m" + i, role, txt, when(msg.timestamp), false));
      });
      var serverUser = (messages || []).filter(function (x) { return x.role === "user"; }).map(function (x) { return extractText(x.content).trim(); });
      (pending || []).forEach(function (t, i) { if (serverUser.indexOf(t.trim()) !== -1) return; rows.push(msgRow("p" + i, "user", t, "", true)); });
      var waiting = (pending || []).some(function (t) { return serverUser.indexOf(t.trim()) === -1; }) ||
        (messages.length && messages[messages.length - 1].role === "user");
      if (waiting) rows.push(h("div", { className: "scc-msg scc-assistant", key: "typing" }, avatar("assistant"),
        h("div", { className: "scc-col" }, h("div", { className: "scc-bubble scc-typing" }, "• • •"))));

      var connLabel = status === "ready" ? "Connected" : status === "connecting" ? "Connecting…" : status === "closed" ? "Reconnect" : status === "error" ? "Offline" : "Ready";

      var railItems = (sessions || []).filter(function (s) { return (s.message_count || 0) > 0 || s.id === activeSid; }).slice(0, 60).map(function (s) {
        return h("button", { key: s.id, className: "scc-sess" + (s.id === activeSid ? " scc-sess-active" : ""), onClick: function () { openSession(s); } },
          h("div", { className: "scc-sess-t" }, sessTitle(s)),
          h("div", { className: "scc-sess-m" }, (s.message_count || 0) + " msgs · " + (when(s.last_activity_at) || "")));
      });

      return h("div", { className: "scc-wrap" },
        h("div", { className: "scc-rail" },
          h("button", { className: "scc-newbtn", onClick: newChat }, "+  New chat"),
          h("div", { className: "scc-sesslist" }, railItems.length ? railItems : h("div", { className: "scc-railempty" }, "No conversations yet"))),
        h("div", { className: "scc-main" },
          h("div", { className: "scc-head" },
            h("div", { className: "scc-agentchip" },
              h("span", { className: "scc-av scc-av-agent scc-av-sm" }, (agentName || "A").slice(0, 1).toUpperCase()),
              h("span", { className: "scc-agentname" }, agentName)),
            h("span", { className: "scc-conn scc-" + status }, connLabel)),
          h("div", { className: "scc-scroll", ref: scrollRef, onScroll: onScroll },
            h("div", { className: "scc-inner" },
              rows.length === 0
                ? h("div", { className: "scc-empty" },
                    h("div", { className: "scc-empty-av" }, (agentName || "A").slice(0, 1).toUpperCase()),
                    h("div", { className: "scc-empty-t" }, "Chat with " + agentName),
                    h("div", { className: "scc-empty-s" }, "Ask a question or pick a past conversation on the left."))
                : rows)),
          h("div", { className: "scc-inputbar" },
            h("div", { className: "scc-inputinner" },
              h("textarea", { className: "scc-input", value: input, placeholder: "Message " + agentName + "…", rows: 1,
                onChange: function (e) { setInput(e.target.value); }, onKeyDown: onKey }),
              h("button", { className: "scc-send", onClick: send, disabled: !input.trim() }, "Send")))));
    }

    try { PLUGINS.register("suburban-chat", ChatPage); console.info(TAG, "registered"); }
    catch (e) { try { console.error(TAG, "register failed", e); } catch (e2) {} }
  });
})();
