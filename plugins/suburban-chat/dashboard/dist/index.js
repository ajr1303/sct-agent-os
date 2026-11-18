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
    // A conversation that stopped on an unanswered step long ago is not "working".
    function msgFresh(m) {
      var t = m && m.timestamp;
      if (t == null || t === "") return true;
      var ms = typeof t === "number" ? (t < 1e12 ? t * 1000 : t) : new Date(t).getTime();
      return !ms || (Date.now() - ms) < 15 * 60 * 1000;
    }
    function wsProto() { return location.protocol === "https:" ? "wss" : "ws"; }
    function sessTitle(s) { return (s.title && s.title.trim()) || (s.last_activity_description && s.last_activity_description.trim()) || "New conversation"; }

    // Escapes quotes too: without &quot;/&#39; a markdown link could close the
    // href attribute and inject event handlers (onfocus/onmouseover) that run in
    // the dashboard origin — reachable via prompt injection.
    function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;"); }
    // Turning an answer into HTML is the costly part of drawing a chat, and the page
    // redraws on every keystroke and every check for new messages. Each answer is
    // converted once and remembered.
    var mdCache = {}, mdCount = 0;
    function mdToHtml(src) {
      if (!src) return "";
      var k = String(src);
      if (Object.prototype.hasOwnProperty.call(mdCache, k)) return mdCache[k];
      if (mdCount > 400) { mdCache = {}; mdCount = 0; }
      mdCount++;
      return (mdCache[k] = mdRender(k));
    }
    var FILE_PATH = "/api/connectors/chat/files/";
    function mdRender(src) {
      var text = String(src), blocks = [], pics = [];
      text = text.replace(/```[a-zA-Z0-9]*\n?([\s\S]*?)```/g, function (_, code) { blocks.push(code.replace(/\n$/, "")); return "\u0000C" + (blocks.length - 1) + "\u0000"; });
      text = esc(text);
      // Pictures the assistant made or was given. Only this install's own chat-file
      // address is ever drawn as an image; any host written in front of it is dropped.
      text = text.replace(/!?\[([^\]]*)\]\((?:https?:\/\/[^\s)\/]+)?\/api\/connectors\/chat\/files\/(\d{1,12})(?:\?[^\s)]*)?\)/g, function (_, alt, id) {
        pics.push('<a class="scc-piclink" href="' + FILE_PATH + id + '?download=1" title="Download"><img class="scc-pic" loading="lazy" alt="' + alt + '" src="' + FILE_PATH + id + '"></a>');
        return "\n\u0000P" + (pics.length - 1) + "\u0000\n";
      });
      text = text.replace(/`([^`\n]+)`/g, function (_, c) { return "<code>" + c + "</code>"; });
      text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
      text = text.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
      // Validate each link's URL instead of trusting the captured text: parse it,
      // allow only http/https, and re-escape the normalized href. A URL that is
      // invalid or uses any other scheme renders as plain label text.
      text = text.replace(/\[([^\]]+)\]\(([^\s)]+)\)/g, function (_, label, raw) {
        var url = raw.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
        try {
          var u = new URL(url);
          if (u.protocol !== "http:" && u.protocol !== "https:") return label;
          return '<a href="' + esc(u.href) + '" target="_blank" rel="noopener noreferrer">' + label + "</a>";
        } catch (e) { return label; }
      });
      // Tables: a header row, a |---| row, then rows. Built from text that is already
      // escaped, and swapped back in after line breaks are added.
      var tables = [];
      text = text.replace(/(^|\n)((?:[ \t]*\|[^\n]*\|[ \t]*(?:\n|$)){2,})/g, function (m, lead, block) {
        var lines = block.replace(/\n$/, "").split("\n");
        if (!/^[ \t]*\|[\s:|-]+\|[ \t]*$/.test(lines[1]) || lines[1].indexOf("-") < 0) return m;
        function cells(l) { return l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(function (c) { return c.trim(); }); }
        var head = cells(lines[0]), rows = lines.slice(2).map(cells);
        var html = '<div class="scc-tablewrap"><table class="scc-table"><thead><tr>' + head.map(function (c) { return "<th>" + c + "</th>"; }).join("") + "</tr></thead><tbody>"
          + rows.map(function (r) { return "<tr>" + r.map(function (c) { return "<td>" + c + "</td>"; }).join("") + "</tr>"; }).join("") + "</tbody></table></div>";
        tables.push(html);
        return lead + "\u0000T" + (tables.length - 1) + "\u0000\n";
      });
      // Blocks: headings, bullet and numbered lists, quotes, rules and paragraphs, so an
      // answer reads like a short note instead of a wall of text.
      var lines = text.split("\n"), out = [], para = [], list = null, m;
      function flushPara() { if (para.length) { out.push("<p>" + para.join("<br>") + "</p>"); para = []; } }
      function flushList() {
        if (list) { out.push("<" + list.tag + ' class="scc-list">' + list.items.map(function (i) { return "<li>" + i + "</li>"; }).join("") + "</" + list.tag + ">"); list = null; }
      }
      function flush() { flushPara(); flushList(); }
      function item(tag, body) { flushPara(); if (!list || list.tag !== tag) { flushList(); list = { tag: tag, items: [] }; } list.items.push(body); }
      for (var li = 0; li < lines.length; li++) {
        var line = lines[li], t = line.trim();
        if (!t) { flush(); continue; }
        if (/^\u0000[TCP]\d+\u0000$/.test(t)) { flush(); out.push(t); continue; }
        if ((m = /^(#{1,6})\s+(.+)$/.exec(t))) { flush(); out.push('<div class="scc-h scc-h' + Math.min(m[1].length, 3) + '">' + m[2].replace(/\s*#+\s*$/, "") + "</div>"); continue; }
        if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) { flush(); out.push('<hr class="scc-hr">'); continue; }
        if ((m = /^[-*\u2022]\s+(.+)$/.exec(t))) { item("ul", m[1]); continue; }
        if ((m = /^\d{1,3}[.)]\s+(.+)$/.exec(t))) { item("ol", m[1]); continue; }
        if ((m = /^&gt;\s?(.*)$/.exec(t))) { flush(); out.push('<blockquote class="scc-quote">' + m[1] + "</blockquote>"); continue; }
        if (list && /^\s{2,}\S/.test(line)) { list.items[list.items.length - 1] += " " + t; continue; }   // wrapped list item
        flushList(); para.push(t);
      }
      flush();
      text = out.join("");
      text = text.replace(/\u0000T(\d+)\u0000/g, function (_, i) { return tables[+i]; });
      text = text.replace(/\u0000P(\d+)\u0000/g, function (_, i) { return pics[+i]; });
      text = text.replace(/\u0000C(\d+)\u0000/g, function (_, i) { return '<pre class="scc-code">' + esc(blocks[+i]) + "</pre>"; });
      return text;
    }

    function ChatPage() {
      var m0 = useState([]), messages = m0[0], setMessages = m0[1];
      var se0 = useState([]), sessions = se0[0], setSessions = se0[1];
      // On a phone there is room for the list of chats or the conversation, not both.
      var sm0 = useState("chat"), phoneView = sm0[0], setPhoneView = sm0[1];
      var a0 = useState(null), activeSid = a0[0], setActiveSid = a0[1];
      var st0 = useState("idle"), status = st0[0], setStatus = st0[1];
      var i0 = useState(""), input = i0[0], setInput = i0[1];
      // A page such as Projects can hand over the start of a question.
      useEffect(function () {
        try {
          var pre = window.sessionStorage.getItem("sct-chat-prefill");
          if (pre) { window.sessionStorage.removeItem("sct-chat-prefill"); setInput(String(pre).slice(0, 400)); }
        } catch (e) {}
      }, []);
      var p0 = useState([]), pending = p0[0], setPending = p0[1];
      var an0 = useState("Agent"), agentName = an0[0], setAgentName = an0[1];
      var ed0 = useState(null), editingId = ed0[0], setEditingId = ed0[1];
      var et0 = useState(""), editTitle = et0[0], setEditTitle = et0[1];
      var cf0 = useState(null), confirmId = cf0[0], setConfirmId = cf0[1];
      var cp0 = useState(null), copiedKey = cp0[0], setCopiedKey = cp0[1];
      var ab0 = useState(true), atBottom = ab0[0], setAtBottom = ab0[1];
      var wsRef = useRef(null), activeRef = useRef(null), baseRef = useRef(null), scrollRef = useRef(null), atBottomRef = useRef(true);
      var waitingRef = useRef(false), pollNowRef = useRef(null), fileRef = useRef(null), sinceRef = useRef(0);
      var at0 = useState([]), atts = at0[0], setAtts = at0[1];          // files being attached to the next message
      var dr0 = useState(false), dragging = dr0[0], setDragging = dr0[1];
      var tk0 = useState(0), tick = tk0[0], setTick = tk0[1];
      var er0 = useState(""), attErr = er0[0], setAttErr = er0[1];

      useEffect(function () {
        var hidden = [];
        function hideTitle() {
          try {
            var all = document.querySelectorAll("header h1, header h2, main h1, main h2, h1, h2");
            for (var i = 0; i < all.length; i++) {
              var el = all[i];
              if (el.childElementCount > 0) continue;
              if ((el.textContent || "").trim().toLowerCase() !== "chat") continue;
              if (el.closest && (el.closest(".scc-wrap") || el.closest("aside") || el.closest("nav") || el.closest("a"))) continue;
              var r = el.getBoundingClientRect();
              if (r.top < 140 && r.left >= 250 && r.left < 640 && el.style.display !== "none") { el.style.display = "none"; hidden.push(el); }
            }
          } catch (e) {}
        }
        // A few tries while the page settles, then stop: this used to scan the whole
        // page every 400 ms for as long as Chat was open.
        var tries = 0;
        hideTitle(); var t = setInterval(function () { hideTitle(); if (++tries > 12 || hidden.length) clearInterval(t); }, 400);
        return function () { clearInterval(t); hidden.forEach(function (el) { try { el.style.display = ""; } catch (e) {} }); };
      }, []);

      useEffect(function () {
        Promise.resolve(api.getProfiles ? api.getProfiles() : null).then(function (p) {
          var a = arr(p); var def = a.find(function (x) { return x.is_default; }) || a[0];
          if (def) setAgentName(function (cur) { return cur !== "Agent" ? cur : (def.display_name || def.name || "Agent"); });
        }).catch(function () {});
        // The owner's name for their main assistant (set when the first agent is
        // created, or on the Account page) replaces the profile's technical name.
        fetch("/api/connectors/account/me", { credentials: "same-origin" }).then(function (r) { return r.ok ? r.json() : null; })
          .then(function (m) { if (m && m.main_agent) setAgentName(m.main_agent); }).catch(function () {});
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
        setPhoneView("chat");
        setMessages([]); setPending([]); setActiveSid(null); activeRef.current = null; setConfirmId(null); setEditingId(null);
        Promise.resolve(api.getSessions()).then(function (ss) { baseRef.current = {}; arr(ss).forEach(function (s) { baseRef.current[s.id] = 1; }); })
          .catch(function () { baseRef.current = {}; }).then(function () { openPty(null); });
      }
      function openSession(s) {
        setPhoneView("chat");
        if (activeRef.current === s.id) return;
        setMessages([]); setPending([]); baseRef.current = null; setConfirmId(null); setEditingId(null);
        setActiveSid(s.id); activeRef.current = s.id; atBottomRef.current = true; setAtBottom(true);
        openPty(s.id);
      }

      useEffect(function () { newChat(); return function () { try { wsRef.current && wsRef.current.close(); } catch (e) {} }; }, []);

      // Checking for new messages. Quick while an answer is on its way, relaxed when
      // nothing is happening, and nearly idle when the tab is in the background. The
      // page is only redrawn when something actually changed.
      useEffect(function () {
        var alive = true, timer = null, n = 0, sessSig = "", msgSig = "";
        function sig(mm) {
          var last = mm.length ? mm[mm.length - 1] : null;
          return activeRef.current + ":" + mm.length + ":" + (last ? (last.role + ":" + extractText(last.content || last.api_content).length + ":" + (last.timestamp || "")) : "");
        }
        function getMessages() {
          if (!activeRef.current) return null;
          var sid = activeRef.current;
          return Promise.resolve(api.getSessionMessages(sid)).then(function (mm) {
            if (!alive || activeRef.current !== sid) return;
            var list = arr(mm), g = sig(list);
            if (g !== msgSig) { msgSig = g; setMessages(list); }
          });
        }
        function getSessions() {
          return Promise.resolve(api.getSessions()).then(function (ss) {
            if (!alive) return;
            var list = arr(ss).slice().sort(function (a, b) { return ts(b) - ts(a); });
            var g = list.slice(0, 80).map(function (x) { return x.id + "|" + (x.title || "") + "|" + (x.message_count || 0) + "|" + (x.last_activity_description || ""); }).join(";");
            if (g !== sessSig) { sessSig = g; setSessions(list); }
            if (!activeRef.current) {
              var base = baseRef.current || {};
              var fresh = list.filter(function (x) { return !base[x.id]; });
              if (fresh.length) { activeRef.current = fresh[0].id; setActiveSid(fresh[0].id); }
            }
          });
        }
        function poll() {
          var busy = waitingRef.current, hidden = false;
          try { hidden = document.hidden; } catch (e) {}
          // The list of chats changes rarely: look at it when a new chat is waiting
          // for its id, and otherwise only now and then.
          var needList = !activeRef.current || n % (busy ? 8 : 3) === 0;
          n++;
          var p = needList ? getSessions().then(getMessages) : Promise.resolve(getMessages());
          p.catch(function () {}).then(function () {
            if (!alive) return;
            timer = setTimeout(poll, hidden ? 6000 : (waitingRef.current ? 700 : 2500));
          });
        }
        function wake() { try { if (!document.hidden) { clearTimeout(timer); poll(); } } catch (e) {} }
        pollNowRef.current = function () { clearTimeout(timer); n = 0; poll(); };
        poll();
        document.addEventListener("visibilitychange", wake);
        return function () { alive = false; clearTimeout(timer); document.removeEventListener("visibilitychange", wake); };
      }, []);

      useEffect(function () { try { var el = scrollRef.current; if (el && atBottomRef.current) el.scrollTop = el.scrollHeight; } catch (e) {} });
      // A once-a-second tick, only while an answer is on its way, for the elapsed time.
      useEffect(function () {
        var t = setInterval(function () { if (waitingRef.current) setTick(function (x) { return x + 1; }); }, 1000);
        return function () { clearInterval(t); };
      }, []);
      function onScroll(e) { try { var el = e.target; var b = (el.scrollHeight - el.scrollTop - el.clientHeight) < 60; atBottomRef.current = b; setAtBottom(b); } catch (x) {} }
      function toBottom() { try { var el = scrollRef.current; if (el) { el.scrollTop = el.scrollHeight; atBottomRef.current = true; setAtBottom(true); } } catch (e) {} }

      // ---- attachments -------------------------------------------------------------
      var MAX_ATT = 6, MAX_BYTES = 20 * 1024 * 1024;
      function patchAtt(key, change) { setAtts(function (list) { return list.map(function (x) { return x.key === key ? Object.assign({}, x, change) : x; }); }); }
      function attach(fileList) {
        var files = Array.prototype.slice.call(fileList || []);
        if (!files.length) return;
        setAttErr("");
        var room = MAX_ATT - atts.length;
        if (files.length > room) { setAttErr("Up to " + MAX_ATT + " files a message."); files = files.slice(0, Math.max(0, room)); }
        files.forEach(function (file, i) {
          var name = file.name || ("pasted-" + Date.now() + ".png");
          if (file.size > MAX_BYTES) { setAttErr(name + " is bigger than 20 MB."); return; }
          var key = Date.now() + "-" + i + "-" + Math.random().toString(36).slice(2, 7);
          setAtts(function (list) { return list.concat([{ key: key, name: name, state: "up" }]); });
          fetch(FILE_PATH.replace(/\/$/, "") + "?name=" + encodeURIComponent(name), { method: "POST", credentials: "same-origin", body: file,
            headers: { "Content-Type": file.type || "application/octet-stream" } })
            .then(function (r) { return r.text().then(function (t) { var j = {}; try { j = JSON.parse(t); } catch (e) {} if (!r.ok) throw new Error(j.error || j.detail || (r.status === 413 ? "That file is too big." : "Could not attach that file.")); return j; }); })
            .then(function (j) { patchAtt(key, { state: "ok", id: j.id, image: !!j.image, path: j.path, name: j.name || name }); })
            .catch(function (e) { setAtts(function (list) { return list.filter(function (x) { return x.key !== key; }); }); setAttErr(name + ": " + String(e.message || e)); });
        });
      }
      function dropAtt(key) { setAtts(function (list) { return list.filter(function (x) { return x.key !== key; }); }); }
      function onPaste(e) {
        try { var f = e.clipboardData && e.clipboardData.files; if (f && f.length) { e.preventDefault(); attach(f); } } catch (x) {}
      }
      function marker(a) {
        return "[attached " + (a.image ? "image" : "file") + " #" + a.id + ' "' + String(a.name).replace(/["\[\]\r\n]/g, "'") + '" saved at ' + a.path + "]";
      }
      var uploading = atts.some(function (x) { return x.state === "up"; });
      var ready = atts.filter(function (x) { return x.state === "ok"; });

      function send() {
        if (uploading) return;
        var text = (input || "").trim();
        if (!text && !ready.length) return;
        if (!text) text = ready.some(function (x) { return x.image; }) ? "Please look at this." : "Please read this.";
        if (ready.length) text += " " + ready.map(marker).join(" ");
        var ws = wsRef.current;
        if (ws && ws.readyState === 1) { try { ws.send(text + "\r"); } catch (e) {} }
        else { openPty(activeRef.current); setTimeout(function () { try { wsRef.current && wsRef.current.readyState === 1 && wsRef.current.send(text + "\r"); } catch (e) {} }, 900); }
        setPending(function (p) { return p.concat([text]); }); setInput(""); setAtts([]); setAttErr(""); atBottomRef.current = true; setAtBottom(true);
        sinceRef.current = Date.now(); waitingRef.current = true;
        if (pollNowRef.current) setTimeout(pollNowRef.current, 250);
      }
      function stop() { try { var ws = wsRef.current; if (ws && ws.readyState === 1) ws.send("\x03"); } catch (e) {} }
      function onKey(e) { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }

      function doRename(id) {
        var title = (editTitle || "").trim(); setEditingId(null);
        if (!title) return;
        setSessions(function (list) { return list.map(function (s) { return s.id === id ? Object.assign({}, s, { title: title }) : s; }); });
        Promise.resolve(api.renameSession(id, title)).catch(function () {});
      }
      function doDelete(id) {
        setConfirmId(null);
        setSessions(function (list) { return list.filter(function (s) { return s.id !== id; }); });
        Promise.resolve(api.deleteSession(id)).catch(function () {});
        if (activeRef.current === id) newChat();
      }
      function copyMsg(key, text) {
        try { navigator.clipboard.writeText(text); setCopiedKey(key); setTimeout(function () { setCopiedKey(null); }, 1200); } catch (e) {}
      }

      function avatar(role) {
        if (role === "user") return h("div", { className: "scc-av scc-av-user" }, "You");
        return h("div", { className: "scc-av scc-av-agent" }, (agentName || "A").slice(0, 1).toUpperCase());
      }
      function msgRow(key, role, text, time, pend) {
        var body;
        if (role === "assistant" && !pend) {
          body = h("div", { className: "scc-bubble scc-md", dangerouslySetInnerHTML: { __html: mdToHtml(text) } });
        } else {
          // What was attached is shown as pictures and file chips, not as the note the
          // assistant reads.
          var files = [], shown = String(text).replace(/\s*\[attached (image|file) #(\d{1,12}) "([^"\]]*)" saved at [^\]]*\]/g, function (_, kind, id, name) {
            files.push({ id: id, name: name, image: kind === "image" }); return "";
          }).trim();
          body = h("div", { className: "scc-bubble" + (pend ? " scc-pending" : "") },
            shown,
            files.length ? h("div", { className: "scc-atts" }, files.map(function (f) {
              return f.image
                ? h("a", { key: f.id, className: "scc-att scc-att-img", href: FILE_PATH + f.id, target: "_blank", rel: "noopener", title: f.name },
                    h("img", { src: FILE_PATH + f.id, alt: f.name, loading: "lazy" }))
                : h("a", { key: f.id, className: "scc-att", href: FILE_PATH + f.id + "?download=1", title: "Download" }, h("span", { className: "scc-att-ic" }, "FILE"), h("span", { className: "scc-att-n" }, f.name));
            })) : null);
          text = shown || text;
        }
        return h("div", { className: "scc-msg scc-" + role, key: key },
          avatar(role),
          h("div", { className: "scc-col" },
            h("div", { className: "scc-meta" },
              h("span", { className: "scc-who" }, role === "user" ? "You" : agentName),
              time ? h("span", { className: "scc-time" }, time) : null,
              pend ? null : h("button", { className: "scc-copy", onClick: function () { copyMsg(key, text); } }, copiedKey === key ? "Copied" : "Copy")),
            body));
      }

      var rows = [];
      (messages || []).forEach(function (msg, i) {
        var role = msg.role; if (role !== "user" && role !== "assistant") return;
        var txt = extractText(msg.content || msg.api_content); if (!txt || !txt.trim()) return;
        rows.push(msgRow("m" + i, role, txt, when(msg.timestamp), false));
      });
      var serverUser = (messages || []).filter(function (x) { return x.role === "user"; }).map(function (x) { return extractText(x.content).trim(); });
      (pending || []).forEach(function (t, i) { if (serverUser.indexOf(t.trim()) !== -1) return; rows.push(msgRow("p" + i, "user", t, "", true)); });
      // Still working: the owner's message has no answer yet, or the newest thing in
      // the conversation is a tool step rather than words from the assistant.
      var lastMsg = messages.length ? messages[messages.length - 1] : null;
      var waiting = (pending || []).some(function (t) { return serverUser.indexOf(t.trim()) === -1; }) ||
        !!(lastMsg && msgFresh(lastMsg) && (lastMsg.role !== "assistant" || !extractText(lastMsg.content || lastMsg.api_content).trim()));
      waitingRef.current = !!waiting;
      if (waiting && !sinceRef.current) sinceRef.current = Date.now();
      if (!waiting) sinceRef.current = 0;
      var secs = waiting ? Math.max(0, Math.round((Date.now() - sinceRef.current) / 1000)) : 0;
      // Steps the assistant has taken since the last message from the owner (tools it
      // called, notes it read), so a long answer does not look stuck.
      var steps = 0;
      for (var mi = (messages || []).length - 1; mi >= 0 && messages[mi].role !== "user"; mi--) steps++;
      if (waiting) rows.push(h("div", { className: "scc-msg scc-assistant", key: "typing" }, avatar("assistant"),
        h("div", { className: "scc-col" }, h("div", { className: "scc-bubble scc-typing" },
          h("span", { className: "scc-dots" }, "• • •"),
          secs >= 4 ? h("span", { className: "scc-working" }, (steps > 0 ? "Working, " + steps + (steps === 1 ? " step" : " steps") + " so far" : "Thinking") + " · " + (secs < 60 ? secs + "s" : Math.floor(secs / 60) + "m " + (secs % 60) + "s")) : null))));

      var connLabel = status === "ready" ? "Connected" : status === "connecting" ? "Connecting…" : status === "closed" ? "Reconnect" : status === "error" ? "Offline" : "Ready";

      var railItems = (sessions || []).filter(function (s) { return (s.message_count || 0) > 0 || s.id === activeSid; }).slice(0, 80).map(function (s) {
        if (editingId === s.id) {
          return h("div", { key: s.id, className: "scc-sess scc-sess-edit" },
            h("input", { className: "scc-renameinput", autoFocus: true, value: editTitle,
              onChange: function (e) { setEditTitle(e.target.value); },
              onKeyDown: function (e) { if (e.key === "Enter") doRename(s.id); if (e.key === "Escape") setEditingId(null); },
              onBlur: function () { doRename(s.id); } }));
        }
        if (confirmId === s.id) {
          return h("div", { key: s.id, className: "scc-sess scc-sess-confirm" },
            h("span", { className: "scc-confirm-t" }, "Delete this chat?"),
            h("div", { className: "scc-confirm-b" },
              h("button", { className: "scc-mini scc-mini-danger", onClick: function () { doDelete(s.id); } }, "Delete"),
              h("button", { className: "scc-mini", onClick: function () { setConfirmId(null); } }, "Cancel")));
        }
        return h("div", { key: s.id, className: "scc-sess" + (s.id === activeSid ? " scc-sess-active" : "") },
          h("button", { className: "scc-sess-open", onClick: function () { openSession(s); } },
            h("div", { className: "scc-sess-t" }, sessTitle(s)),
            h("div", { className: "scc-sess-m" }, (s.message_count || 0) + " msgs · " + (when(s.last_activity_at) || ""))),
          h("div", { className: "scc-sess-actions" },
            h("button", { title: "Rename", className: "scc-ic", onClick: function () { setEditTitle(sessTitle(s)); setEditingId(s.id); } }, "✎"),
            h("button", { title: "Delete", className: "scc-ic", onClick: function () { setConfirmId(s.id); } }, "✕")));
      });

      return h("div", { className: "scc-wrap scc-phone-" + phoneView },
        h("div", { className: "scc-rail" },
          h("button", { className: "scc-newbtn", onClick: newChat }, "+  New chat"),
          h("div", { className: "scc-sesslist" }, railItems.length ? railItems : h("div", { className: "scc-railempty" }, "No conversations yet"))),
        h("div", { className: "scc-main" + (dragging ? " scc-dragging" : ""),
            onDragOver: function (e) { try { if (e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], "Files") !== -1) { e.preventDefault(); setDragging(true); } } catch (x) {} },
            onDragLeave: function (e) { if (e.currentTarget === e.target || !e.currentTarget.contains(e.relatedTarget)) setDragging(false); },
            onDrop: function (e) { if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) { e.preventDefault(); setDragging(false); attach(e.dataTransfer.files); } } },
          dragging ? h("div", { className: "scc-dropnote" }, "Drop to attach") : null,
          h("div", { className: "scc-head" },
            h("button", { type: "button", className: "scc-back", onClick: function () { setPhoneView("list"); }, "aria-label": "All chats" }, "‹ Chats"),
            h("div", { className: "scc-agentchip" },
              h("span", { className: "scc-av scc-av-agent scc-av-sm" }, (agentName || "A").slice(0, 1).toUpperCase()),
              h("span", { className: "scc-agentname" }, agentName)),
            h("span", { className: "scc-conn scc-" + status }, connLabel)),
          h("div", { className: "scc-scrollwrap" },
            h("div", { className: "scc-scroll", ref: scrollRef, onScroll: onScroll },
              h("div", { className: "scc-inner" },
                rows.length === 0
                  ? h("div", { className: "scc-empty" },
                      h("div", { className: "scc-empty-av" }, (agentName || "A").slice(0, 1).toUpperCase()),
                      h("div", { className: "scc-empty-t" }, "Chat with " + agentName),
                      h("div", { className: "scc-empty-s" }, "Ask a question or pick a past conversation on the left."))
                  : rows)),
            atBottom ? null : h("button", { className: "scc-jump", onClick: toBottom }, "↓ Latest")),
          h("div", { className: "scc-inputbar" },
            atts.length || attErr ? h("div", { className: "scc-attbar" },
              atts.map(function (a) {
                return h("div", { key: a.key, className: "scc-chip" + (a.state === "up" ? " scc-chip-up" : "") },
                  a.state === "ok" && a.image ? h("img", { className: "scc-chip-img", src: FILE_PATH + a.id, alt: "" }) : null,
                  h("span", { className: "scc-chip-n" }, a.state === "up" ? "Attaching " + a.name + "…" : a.name),
                  h("button", { type: "button", className: "scc-chip-x", "aria-label": "Remove " + a.name, onClick: function () { dropAtt(a.key); } }, "✕"));
              }),
              attErr ? h("div", { className: "scc-atterr", role: "alert" }, attErr) : null) : null,
            h("div", { className: "scc-inputinner" },
              h("input", { type: "file", multiple: true, ref: fileRef, style: { display: "none" },
                onChange: function (e) { attach(e.target.files); e.target.value = ""; } }),
              h("button", { type: "button", className: "scc-attach", title: "Attach photos or files", "aria-label": "Attach photos or files",
                onClick: function () { if (fileRef.current) fileRef.current.click(); } }, "+"),
              h("textarea", { className: "scc-input", value: input, placeholder: "Message " + agentName + "…", rows: 1,
                onChange: function (e) { setInput(e.target.value); }, onKeyDown: onKey, onPaste: onPaste }),
              waiting ? h("button", { className: "scc-stop", onClick: stop, title: "Stop the answer" }, "Stop") : null,
              !waiting || input.trim() || ready.length
                ? h("button", { className: "scc-send", onClick: send, disabled: uploading || (!input.trim() && !ready.length) }, uploading ? "Attaching…" : "Send") : null))));
    }

    try { PLUGINS.register("suburban-chat", ChatPage); console.info(TAG, "registered"); }
    catch (e) { try { console.error(TAG, "register failed", e); } catch (e2) {} }
  });
})();
