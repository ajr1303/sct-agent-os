/* Suburban Cyber Agent OS - login page rebrand (runs pre-auth, injected by the proxy). */
(function () {
  "use strict";
  var CSS =
    ":root{--color-primary:#25c9ee!important;--color-primary-foreground:#04202a!important;" +
    "--color-accent:#25c9ee!important;--color-ring:#25c9ee!important;" +
    "--midground:#e6eef0!important;--midground-base:#e6eef0!important;" +
    "--background:#071217!important;--background-base:#071217!important;}" +
    ".sct-login-logo{display:inline-block;width:220px;height:64px;max-width:70vw;" +
    "background:url(/sct-brand/logo.png) no-repeat center/contain;}";
  function norm(x) { return (x || "").replace(/\s+/g, " ").trim().toLowerCase(); }
  function ensureStyle() {
    if (!document.getElementById("sct-login-style")) {
      var s = document.createElement("style"); s.id = "sct-login-style"; s.textContent = CSS;
      (document.head || document.documentElement).appendChild(s);
    }
  }
  function run() {
    try {
      if (!/\/login/.test(location.pathname)) { var ex = document.getElementById("sct-login-style"); if (ex) ex.remove(); return; }
      ensureStyle();
      if (/hermes|nous/i.test(document.title)) document.title = "Suburban Cyber Agent OS";
      // swap the NOUS RESEARCH wordmark for our logo
      var all = document.querySelectorAll("a,div,span,h1,h2,p");
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        if (el.childElementCount > 3) continue;
        if (el.querySelector && el.querySelector(".sct-login-logo")) continue;
        var t = norm(el.textContent).replace(/[^a-z ]/g, "").replace(/\s+/g, " ").trim();
        if (t === "nous research" || t === "nousresearch") {
          el.innerHTML = '<span class="sct-login-logo" role="img" aria-label="Suburban Cyber"></span>';
        }
      }
      // rename "Hermes Agent" -> brand in the subtitle text
      var wk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null), tn;
      while ((tn = wk.nextNode())) {
        if (tn.nodeValue && tn.nodeValue.indexOf("Hermes Agent") !== -1) tn.nodeValue = tn.nodeValue.replace(/Hermes Agent/g, "Suburban Cyber Agent OS");
      }
      // recolor the SIGN IN button to brand cyan
      var btns = document.querySelectorAll("button");
      for (var b = 0; b < btns.length; b++) {
        if (norm(btns[b].textContent) === "sign in") {
          btns[b].style.setProperty("background", "#25c9ee", "important");
          btns[b].style.setProperty("color", "#04202a", "important");
          btns[b].style.setProperty("border-color", "#25c9ee", "important");
        }
      }
    } catch (e) {}
  }
  function start() {
    if (!document.body) { setTimeout(start, 50); return; }
    var mo = new MutationObserver(function () { if (run._p) return; run._p = setTimeout(function () { run._p = null; run(); }, 120); });
    mo.observe(document.body, { childList: true, subtree: true, characterData: true });
    window.addEventListener("popstate", run);
    run(); setTimeout(run, 400); setTimeout(run, 1200);
  }
  start();
})();
