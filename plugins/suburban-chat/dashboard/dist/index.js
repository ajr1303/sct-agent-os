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

    function arr(x) { return Array.isArray(x) ? x : ((x && (x.sessions || x.messages || x.items || x.data)) || []); }
    function extractText(c) {
      if (c == null) return "";
      if (typeof c === "string") return c;
      if (Array.isArray(c)) return c.map(function (p) { return typeof p === "string" ? p : ((p && (p.text || p.content)) || ""); }).join("");
      if (typeof c === "object") return c.text || c.content || "";
      return String(c);
    }
    function ts(s) { return new Date(s.last_activity_at || s.started_at || s.created_at || 0).getTime() || 0; }
    function wsProto() { return location.protocol === "https:" ? "wss" : "ws"; }

    function ChatPage() {
      var m0 = useState([]), messages = m0[0], setMessages = m0[1];
      var s0 = useState(null), sid = s0[0], setSid = s0[1];
      var st0 = useState("connecting"), status = st0[0], setStatus = st0[1];
      var i0 = useState(""), input = i0[0], setInput = i0[1];
      var p0 = useState([]), pending = p0[0], setPending = p0[1];
      var wsRef = useRef(null), sidRef = useRef(null), scrollRef = useRef(null), baseRef = useRef(null);

      function openPty() {
        try { if (wsRef.current) wsRef.current.close(); } catch (e) {}
        setStatus("connecting");
        Promise.resolve(SDK.buildWsAuthParam()).then(function (pair) {
          var url = wsProto() + "://" + location.host + "/api/pty?" + encodeURIComponent(pair[0]) + "=" + encodeURIComponent(pair[1]);
          var ws = new WebSocket(url); ws.binaryType = "arraybuffer"; wsRef.current = ws;
          ws.onopen = function () { try { ws.send("RESIZE 120 40"); } catch (e) {} setStatus("ready"); };
          ws.onclose = function () { setStatus("closed"); };
          ws.onerror = function () { setStatus("error"); };
        }).catch(function () { setStatus("error"); });
      }

      function newChat() {
        // snapshot existing sessions BEFORE opening pty, so the pty's new session is detectable
        setMessages([]); setPending([]); setSid(null); sidRef.current = null;
        Promise.resolve(api.getSessions()).then(function (ss) {
          baseRef.current = {}; arr(ss).forEach(function (s) { baseRef.current[s.id] = 1; });
        }).catch(function () { baseRef.current = {}; }).then(openPty);
      }

      useEffect(function () { newChat(); return function () { try { wsRef.current && wsRef.current.close(); } catch (e) {} }; }, []);

      // single poll loop: find the session created after connect, render its messages
      useEffect(function () {
        var alive = true;
        function poll() {
          Promise.resolve(api.getSessions()).then(function (ss) {
            if (!alive) return;
            var base = baseRef.current || {};
            var fresh = arr(ss).filter(function (s) { return !base[s.id]; });
            if (!fresh.length) return;
            fresh.sort(function (a, b) { return ts(b) - ts(a); });
            var s = fresh[0];
            if (sidRef.current !== s.id) { sidRef.current = s.id; setSid(s.id); }
            return api.getSessionMessages(s.id).then(function (mm) { if (alive) setMessages(arr(mm)); });
          }).catch(function () {});
        }
        poll(); var t = setInterval(poll, 1500);
        return function () { alive = false; clearInterval(t); };
      }, []);

      useEffect(function () { try { var el = scrollRef.current; if (el) el.scrollTop = el.scrollHeight; } catch (e) {} });

      function send() {
        var text = (input || "").trim(); if (!text) return;
        var ws = wsRef.current;
        if (ws && ws.readyState === 1) { try { ws.send(text + "\r"); } catch (e) {} } else { openPty(); }
        setPending(function (p) { return p.concat([text]); });
        setInput("");
      }
      function onKey(e) { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }

      var rendered = [];
      (messages || []).forEach(function (msg, i) {
        var role = msg.role;
        if (role !== "user" && role !== "assistant") return;
        var txt = extractText(msg.content || msg.api_content);
        if (!txt || !txt.trim()) return;
        rendered.push(h("div", { key: "m" + i, className: "scc-row scc-" + role }, h("div", { className: "scc-bubble" }, txt)));
      });
      var serverUser = (messages || []).filter(function (x) { return x.role === "user"; }).map(function (x) { return extractText(x.content).trim(); });
      (pending || []).forEach(function (t, i) {
        if (serverUser.indexOf(t.trim()) !== -1) return;
        rendered.push(h("div", { key: "p" + i, className: "scc-row scc-user" }, h("div", { className: "scc-bubble scc-pending" }, t)));
      });
      var waiting = (pending || []).some(function (t) { return serverUser.indexOf(t.trim()) === -1; }) ||
        (messages.length && messages[messages.length - 1].role === "user");
      if (waiting) rendered.push(h("div", { key: "typing", className: "scc-row scc-assistant" }, h("div", { className: "scc-bubble scc-typing" }, "• • •")));

      var connLabel = status === "ready" ? "Connected" : status === "connecting" ? "Connecting…" : status === "closed" ? "Reconnect" : "Offline";

      return h("div", { className: "scc-wrap" },
        h("div", { className: "scc-head" },
          h("div", { className: "scc-title" }, "Chat"),
          h("div", { className: "scc-actions" },
            h("span", { className: "scc-conn scc-" + status }, connLabel),
            h("button", { className: "scc-btn", onClick: newChat }, "New chat"))),
        h("div", { className: "scc-scroll", ref: scrollRef },
          rendered.length === 0
            ? h("div", { className: "scc-empty" },
                h("div", { className: "scc-empty-t" }, "Start chatting with your agent"),
                h("div", { className: "scc-empty-s" }, "Type a message below. Replies appear here as the agent responds."))
            : rendered),
        h("div", { className: "scc-inputbar" },
          h("textarea", { className: "scc-input", value: input, placeholder: "Message your agent…", rows: 1,
            onChange: function (e) { setInput(e.target.value); }, onKeyDown: onKey }),
          h("button", { className: "scc-send", onClick: send, disabled: !input.trim() }, "Send")));
    }

    try { PLUGINS.register("suburban-chat", ChatPage); console.info(TAG, "registered"); }
    catch (e) { try { console.error(TAG, "register failed", e); } catch (e2) {} }
  });
})();
