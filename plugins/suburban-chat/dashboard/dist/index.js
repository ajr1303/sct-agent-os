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

    function extractText(c) {
      if (c == null) return "";
      if (typeof c === "string") return c;
      if (Array.isArray(c)) return c.map(function (p) { return typeof p === "string" ? p : ((p && (p.text || p.content)) || ""); }).join("");
      if (typeof c === "object") return c.text || c.content || "";
      return String(c);
    }
    function wsProto() { return location.protocol === "https:" ? "wss" : "ws"; }

    function ChatPage() {
      var m0 = useState([]), messages = m0[0], setMessages = m0[1];
      var s0 = useState(null), sid = s0[0], setSid = s0[1];
      var st0 = useState("connecting"), status = st0[0], setStatus = st0[1];
      var i0 = useState(""), input = i0[0], setInput = i0[1];
      var p0 = useState([]), pending = p0[0], setPending = p0[1];
      var wsRef = useRef(null), sidRef = useRef(null), scrollRef = useRef(null), bufRef = useRef("");

      function resolveFull(shortId) {
        return Promise.resolve(api.getSessions()).then(function (ss) {
          var arr = Array.isArray(ss) ? ss : (ss.sessions || ss.items || []);
          var f = arr.find(function (s) { return String(s.id).indexOf(shortId) !== -1; });
          return f ? f.id : ("local-" + shortId);
        }).catch(function () { return "local-" + shortId; });
      }

      function connect() {
        try { if (wsRef.current) wsRef.current.close(); } catch (e) {}
        setStatus("connecting"); setMessages([]); setPending([]); setSid(null);
        sidRef.current = null; bufRef.current = "";
        Promise.resolve(api && SDK.buildWsAuthParam ? SDK.buildWsAuthParam() : null).then(function (pair) {
          if (!pair) { setStatus("error"); return; }
          var url = wsProto() + "://" + location.host + "/api/pty?" + encodeURIComponent(pair[0]) + "=" + encodeURIComponent(pair[1]);
          var ws = new WebSocket(url); ws.binaryType = "arraybuffer"; wsRef.current = ws;
          var dec = new TextDecoder();
          ws.onopen = function () { try { ws.send("RESIZE 120 40"); } catch (e) {} setStatus("ready"); };
          ws.onmessage = function (ev) {
            if (sidRef.current) return;
            try { bufRef.current += (typeof ev.data === "string" ? ev.data : dec.decode(new Uint8Array(ev.data))); } catch (e) {}
            var clean = bufRef.current.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
            var mm = clean.match(/Session:\s*([0-9a-fA-F]{6,})/);
            if (mm) { var shortId = mm[1]; sidRef.current = shortId; resolveFull(shortId).then(function (full) { sidRef.current = full; setSid(full); }); }
          };
          ws.onclose = function () { setStatus("closed"); };
          ws.onerror = function () { setStatus("error"); };
        }).catch(function () { setStatus("error"); });
      }

      useEffect(function () { connect(); return function () { try { wsRef.current && wsRef.current.close(); } catch (e) {} }; }, []);

      useEffect(function () {
        if (!sid) return; var alive = true;
        function poll() {
          Promise.resolve(api.getSessionMessages(sid)).then(function (mm) {
            if (!alive) return;
            var arr = Array.isArray(mm) ? mm : (mm.messages || mm.items || mm.data || []);
            setMessages(arr);
          }).catch(function () {});
        }
        poll(); var t = setInterval(poll, 1500);
        return function () { alive = false; clearInterval(t); };
      }, [sid]);

      useEffect(function () { try { var el = scrollRef.current; if (el) el.scrollTop = el.scrollHeight; } catch (e) {} });

      function send() {
        var text = (input || "").trim(); if (!text) return;
        var ws = wsRef.current;
        if (ws && ws.readyState === 1) { try { ws.send(text + "\r"); } catch (e) {} }
        else { connect(); }
        setPending(function (p) { return p.concat([{ text: text, at: Date.now() }]); });
        setInput("");
      }
      function onKey(e) { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }

      var bubbles = [];
      (messages || []).forEach(function (msg, i) {
        var role = msg.role;
        if (role !== "user" && role !== "assistant") return;
        var txt = extractText(msg.content || msg.api_content);
        if (!txt || !txt.trim()) return;
        bubbles.push(h("div", { key: "m" + i, className: "scc-row scc-" + role },
          h("div", { className: "scc-bubble" }, txt)));
      });
      var serverUser = (messages || []).filter(function (x) { return x.role === "user"; }).map(function (x) { return extractText(x.content).trim(); });
      (pending || []).forEach(function (p, i) {
        if (serverUser.indexOf(p.text.trim()) !== -1) return;
        bubbles.push(h("div", { key: "p" + i, className: "scc-row scc-user" },
          h("div", { className: "scc-bubble scc-pending" }, p.text)));
      });

      var connLabel = status === "ready" ? "Connected" : status === "connecting" ? "Connecting…" : status === "closed" ? "Reconnect" : "Offline";

      return h("div", { className: "scc-wrap" },
        h("div", { className: "scc-head" },
          h("div", { className: "scc-title" }, "Chat"),
          h("div", { className: "scc-actions" },
            h("span", { className: "scc-conn scc-" + status }, connLabel),
            h("button", { className: "scc-btn", onClick: connect }, "New chat"))),
        h("div", { className: "scc-scroll", ref: scrollRef },
          bubbles.length === 0
            ? h("div", { className: "scc-empty" },
                h("div", { className: "scc-empty-t" }, "Start chatting with your agent"),
                h("div", { className: "scc-empty-s" }, "Type a message below. Replies appear here as the agent responds."))
            : bubbles),
        h("div", { className: "scc-inputbar" },
          h("textarea", { className: "scc-input", value: input, placeholder: "Message your agent…", rows: 1,
            onChange: function (e) { setInput(e.target.value); }, onKeyDown: onKey }),
          h("button", { className: "scc-send", onClick: send, disabled: !input.trim() }, "Send")));
    }

    try { PLUGINS.register("suburban-chat", ChatPage); console.info(TAG, "registered"); }
    catch (e) { try { console.error(TAG, "register failed", e); } catch (e2) {} }
  });
})();
