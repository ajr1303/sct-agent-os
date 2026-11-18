/* Agent OS sidebar: one fixed, grouped order for every page.
 *
 * Hermes renders its built-in tabs and its plugin tabs as two separate lists, and
 * our plugins used to each inject their own copy of a link whenever they happened
 * to load, so the order changed from page to page and every click reloaded the
 * app. This script is now the only thing that arranges the sidebar:
 *   - it never moves or clones Hermes' own links (so clicks stay in-app and the
 *     active highlight keeps working); it only sets CSS `order` on them;
 *   - items are grouped: everyday pages, connections, settings. Hermes' technical
 *     pages sit in a collapsible "Operator tools" group that only appears when the
 *     owner turns it on (Account page); a few Hermes pages that duplicate ours or
 *     do nothing for an owner are not listed at all. This tidies the menu; it is
 *     not access control.
 * Loaded on every page by the proxy (templates/nginx.conf). Safe to fail: if it
 * throws, sct.css reveals the stock sidebar after a short delay.
 */
(function () {
  "use strict";
  if (window.__SCT_NAV__) return;
  window.__SCT_NAV__ = true;

  // path -> [group, position]. Anything not listed lands at the end of Advanced.
  var GROUPS = [
    { id: "main", label: "", items: ["/chat", "/projects"] },                    // Overview is added in front of Chat
    { id: "team", label: "Your team", items: ["/tasks", "/team", "/orchestration", "/automations", "/usage"] },
    { id: "conn", label: "Connections", items: ["/bookings", "/mailboxes", "/website", "/channels", "/pairing", "/backups"] },
    { id: "set", label: "Settings", items: ["/security", "/models", "/env", "/skills", "/sessions"] },
    { id: "adv", label: "Operator tools", items: ["/profiles", "/mcp", "/plugins", "/cron", "/files", "/webhooks",
        "/config", "/system", "/logs"] }
  ];
  // Hermes pages left out of the menu: its own task board (Tasks replaces it), usage
  // badges, and its own manual.
  var GONE = { "/kanban": 1, "/achievements": 1, "/docs": 1 };
  // Plain names for Hermes pages an owner uses.
  var RENAME = { "/channels": "Messaging", "/pairing": "Messaging access", "/models": "AI models", "/env": "Keys", "/sessions": "Chat history" };
  var OPKEY = "sct-operator";
  function operatorOn() { return store(OPKEY) === "1"; }
  function relabel(a, text) {
    try {
      var w = document.createTreeWalker(a, NodeFilter.SHOW_TEXT, null), t;
      while ((t = w.nextNode())) {
        if (!(t.nodeValue || "").trim()) continue;
        if (t.nodeValue.trim() !== text) t.nodeValue = text;
        return;
      }
    } catch (e) {}
  }
  var CLONES = { "sc-overview-nav": 1, "so-nav": 1, "st-nav": 1, "sa-nav": 1, "sm-nav": 1, "sb-nav": 1 };
  var KEY = "sct-nav-advanced";
  var pos = {}, n = 0;
  GROUPS.forEach(function (g, gi) {
    g.base = (gi + 1) * 1000;
    g.items.forEach(function (p, i) { pos[p] = { g: g, order: g.base + 10 + i }; });
  });
  var ADV = GROUPS[GROUPS.length - 1];

  function store(k, v) {
    try { if (v === undefined) return window.localStorage.getItem(k); window.localStorage.setItem(k, v); } catch (e) {}
    return null;
  }
  function pathOf(a) {
    var h = (a.getAttribute("href") || "").split("?")[0].split("#")[0];
    return h.length > 1 ? h.replace(/\/+$/, "") : h;
  }
  function nativeLink(li) {
    var as = li.querySelectorAll("a[href]");
    for (var i = 0; i < as.length; i++) if (!CLONES[as[i].id]) return as[i];
    return null;
  }
  function header(nav, g) {
    var id = "sct-navh-" + g.id, el = document.getElementById(id);
    if (el && el.parentElement === nav) return el;
    if (el) el.remove();
    el = document.createElement(g.id === "adv" ? "button" : "div");
    el.id = id;
    el.className = "sct-navh" + (g.id === "adv" ? " sct-navh-btn" : "");
    el.style.order = String(g.base);
    if (g.id === "adv") {
      el.type = "button";
      el.addEventListener("click", function () {
        var open = !nav.classList.contains("sct-adv-open");
        nav.classList.toggle("sct-adv-open", open);
        el.setAttribute("aria-expanded", open ? "true" : "false");
        store(KEY, open ? "1" : "0");
      });
    }
    el.textContent = g.label;
    nav.appendChild(el);
    return el;
  }

  function arrange() {
    var side = document.getElementById("app-sidebar");
    var nav = side && side.querySelector("nav");
    if (!nav) return;
    var lis = nav.querySelectorAll("li");
    if (!lis.length) return;

    // Flatten: every wrapper between <nav> and the <li>s stops making its own box,
    // so all items become siblings in one flex column and `order` works across
    // Hermes' two lists. Anything else in there (dividers, list titles) is hidden.
    var extra = ADV.base + 500, cur = location.pathname.replace(/\/+$/, "") || "/", curInAdv = false, seen = {};
    for (var i = 0; i < lis.length; i++) {
      var li = lis[i], a = nativeLink(li);
      for (var p = li.parentElement; p && p !== nav; p = p.parentElement) p.classList.add("sct-flat");
      if (!a) { li.classList.add("sct-hide"); continue; }
      var path = pathOf(a), slot = pos[path];
      if (seen[path] || GONE[path]) { li.classList.add("sct-hide"); continue; }   // a duplicate, or a page we leave out
      seen[path] = 1;
      if (RENAME[path]) relabel(a, RENAME[path]);
      li.classList.remove("sct-hide");
      var isAdv = !slot || slot.g === ADV;
      li.style.order = String(slot ? slot.order : extra++);
      li.classList.toggle("sct-adv", isAdv);
      if (isAdv && (cur === path || cur.indexOf(path + "/") === 0)) curInAdv = true;
    }
    // Hide what is left between the items: dividers and Hermes' own list titles
    // (for example the "Plugins" heading), at the top level and inside wrappers.
    var rest = nav.querySelectorAll(":scope > *, .sct-flat > *");
    for (var r = 0; r < rest.length; r++) {
      var c = rest[r];
      if (c.tagName === "LI" || /^sct-navh-/.test(c.id || "")) continue;
      if (!c.querySelector("li")) c.classList.add("sct-hide");
    }
    for (var gi = 1; gi < GROUPS.length; gi++) header(nav, GROUPS[gi]);
    // Operator tools only show when switched on, or when you are on one of those pages.
    nav.classList.toggle("sct-op", operatorOn() || curInAdv);

    if (!nav.classList.contains("sct-nav")) {
      nav.classList.add("sct-nav");
      // First arrangement on this page load: restore the remembered state.
      var open = store(KEY) === "1" || curInAdv;
      nav.classList.toggle("sct-adv-open", open);
      var b = document.getElementById("sct-navh-adv");
      if (b) b.setAttribute("aria-expanded", open ? "true" : "false");
    } else if (curInAdv && !nav.classList.contains("sct-adv-open")) {
      nav.classList.add("sct-adv-open");   // never hide the page you are on
    }
  }

  // The Overview link is our own (Hermes has no tab for "/"). Navigate in-app
  // instead of reloading: push the URL and let the router pick it up.
  document.addEventListener("click", function (e) {
    var a = e.target && e.target.closest ? e.target.closest("#sc-overview-nav") : null;
    if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (location.pathname === "/") { e.preventDefault(); return; }
    try {
      var href = "/" + (location.search || "");
      e.preventDefault();
      window.history.pushState(null, "", href);
      window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
    } catch (err) { window.location.assign("/" + (location.search || "")); }
  }, true);

  var pending = null;
  function schedule() {
    if (pending) return;
    pending = setTimeout(function () { pending = null; try { arrange(); } catch (e) {} }, 60);
  }
  function start() {
    try { arrange(); } catch (e) {}
    try { new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true }); } catch (e) {}
    window.addEventListener("popstate", schedule);
  }
  if (document.body) start(); else document.addEventListener("DOMContentLoaded", start);

  // Two-step sign-in: if this browser's code has expired while the dashboard is open,
  // go to the code page instead of leaving every button failing quietly.
  function codeCheck() {
    try {
      fetch("/api/connectors/mfa/status", { credentials: "same-origin" }).then(function (r) { return r.ok ? r.json() : null; })
        .then(function (s) { if (s && s.required && !s.ok) window.location.assign("/sct-brand/mfa.html"); }).catch(function () {});
    } catch (e) {}
  }
  window.addEventListener("sct-operator", schedule);

  // Account: a new install's first sign-in goes to the welcome screen. On every install,
  // the sign-in name at the bottom of the sidebar shows the owner's name and opens Account.
  var acct = null;
  function nameTag() {
    if (!acct) return;
    try {
      var w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null), t;
      while ((t = w.nextNode())) {
        var v = (t.nodeValue || "").trim();
        if (v !== acct.username && v !== acct.name) continue;
        var el = t.parentElement, box = el && el.parentElement;
        if (!el || !box || el.closest("a,main,[role=main]") || !/\bvia\s/i.test(box.textContent || "")) continue;
        if (acct.name && v === acct.username) t.nodeValue = t.nodeValue.replace(acct.username, acct.name);
        if (!box.getAttribute("data-sc-acct")) {
          box.setAttribute("data-sc-acct", "1"); box.style.cursor = "pointer"; box.title = "Your account";
          box.addEventListener("click", function (e) {
            if (e.target.closest && e.target.closest("button,a")) return;      // leave sign out alone
            var link = document.querySelector('nav a[href="/security"], a[href="/security"]');
            if (link) link.click(); else window.location.assign("/security");
          });
        }
        return;
      }
    } catch (e) {}
  }
  try {
    fetch("/api/connectors/account/me", { credentials: "same-origin" }).then(function (r) { return r.ok ? r.json() : null; })
      .then(function (a) {
        if (!a) return;
        if (a.setup_needed) { window.location.assign("/sct-brand/welcome.html"); return; }
        acct = a; nameTag();
        if ((a.operator_tools ? "1" : "0") !== (store(OPKEY) || "0")) { store(OPKEY, a.operator_tools ? "1" : "0"); schedule(); }
        try { new MutationObserver(function () { clearTimeout(nameTag._t); nameTag._t = setTimeout(nameTag, 150); }).observe(document.body, { childList: true, subtree: true }); } catch (e) {}
      }).catch(function () {});
  } catch (e) {}

  window.addEventListener("focus", codeCheck);
  setInterval(codeCheck, 5 * 60 * 1000);
})();
