(function () {
  "use strict";
  var TAG = "[suburban-help]";
  function whenReady(cb, tries) {
    tries = tries || 0;
    var P = window.__HERMES_PLUGINS__, S = window.__HERMES_PLUGIN_SDK__;
    if (P && S && S.React) { cb(P, S); return; }
    if (tries > 200) { try { console.warn(TAG, "SDK not ready"); } catch (e) {} return; }
    setTimeout(function () { whenReady(cb, tries + 1); }, 50);
  }
  whenReady(function (PLUGINS, SDK) {
    var h = SDK.React.createElement, hooks = SDK.hooks || {}, useState = hooks.useState;
    var PAGES = [
      ["/overview", "Overview", "Today at a glance: a short summary, today's idea, decisions waiting on you, your team and a security check."],
      ["/sc-chat", "Chat", "Talk to your assistant. Ask it for anything; it hands work to the right agent."],
      ["/tasks", "Tasks", "Everything the team is working on. Decisions that need you are at the top, with buttons to approve or decline."],
      ["/plan", "Plan", "The one-page business plan your team works from. Ask your lead agent to change it, or edit it yourself."],
      ["/files", "Files", "Reports, drafts and lists your agents have handed over."],
      ["/projects", "Projects", "Keep the files, notes and tasks for one piece of work together."],
      ["/memory", "Memory", "What your assistant has learned about you, and a way to remove anything that is wrong."],
      ["/team", "Agents", "Your agents: what each one does, its instructions and its AI model."],
      ["/usage", "Usage", "How much AI each provider and agent has used, and what it cost."],
      ["/ai-models", "AI models", "Choose the AI model, connect providers, and see advice on cheaper or stronger models."],
      ["/backups", "Backups", "Nightly copies of everything, and how to keep one off this server."],
      ["/security", "Account", "Your name and password, two-step sign-in, and a few switches for how the team behaves."]
    ];
    var HOW = [
      ["Give the team something to do", "Open Chat and say what you need in plain words. Your assistant creates the task and passes it to the right agent. You can follow it on the Tasks page."],
      ["Answer a decision", "When an agent needs you, a card appears under Tasks and on the Overview. Read the summary and press Approve, Decline or Tell me more. Nothing is published, sent or bought without one of these."],
      ["Find what an agent produced", "Short answers are on the task itself. Documents such as reports, drafts and lists are on the Files page, and each one shows the task it came from."],
      ["An agent has stopped", "The system retries by itself a few times and tells you why if it can't recover. Look for an “Agent stopped” card under Tasks, with Retry now and Pause this agent."],
      ["Spend less on AI", "Open AI models and look at Model advice. It suggests cheaper models for agents doing short, routine work, and shows the saving."],
      ["Update the system", "On the Overview, press Check for updates, then Update now. The update waits for running tasks to finish before it restarts anything. Afterwards, refresh the page."],
      ["Use it like an app on your phone", "Open this dashboard in your phone's browser. On iPhone: Share, then Add to Home Screen. On Android: the menu, then Install app or Add to Home screen. It then opens full screen from its own icon."],
      ["Forgot your password", "Press Forgot password? on the sign-in page and use your reset code. If you don't have one, whoever manages your server can reset it."]
    ];
    function Help() {
      var a = useState(-1), open = a[0], setOpen = a[1];
      var B = window.__SCT_BRAND__ || {}, q = location.search || "";
      var sup = String(B.support || ""), isMail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(sup), isUrl = /^https?:\/\//i.test(sup);
      return h("div", { className: "sh-wrap" },
        h("div", { className: "sh-title" }, "Help"),
        h("div", { className: "sh-sub" }, "What each page is for, how to do the common things, and who to ask."),
        h("div", { className: "sh-cols" },
          h("div", { className: "sh-col" },
            h("div", { className: "sh-panel" },
              h("div", { className: "sh-panel-h" }, "How do I…"),
              HOW.map(function (x, i) {
                return h("div", { className: "sh-q" + (open === i ? " open" : ""), key: i },
                  h("button", { type: "button", className: "sh-q-b", onClick: function () { setOpen(open === i ? -1 : i); } },
                    h("span", { className: "sh-chev" }, open === i ? "−" : "+"), x[0]),
                  open === i ? h("div", { className: "sh-a" }, x[1]) : null);
              }))),
          h("div", { className: "sh-col" },
            h("div", { className: "sh-panel" },
              h("div", { className: "sh-panel-h" }, "Get support"),
              h("div", { className: "sh-pad" },
                sup ? h("div", null, (B.operator ? B.operator + " looks after this system. " : "") + "Contact: ",
                        isMail ? h("a", { className: "sh-link", href: "mailto:" + sup }, sup) : isUrl ? h("a", { className: "sh-link", href: sup, target: "_blank", rel: "noopener noreferrer" }, sup) : h("b", null, sup))
                    : h("div", null, "Whoever set up this system for you is the best person to ask."),
                h("div", { className: "sh-ver" }, "Agent OS" + (B.version ? " version " + B.version : "")))),
            h("div", { className: "sh-panel" },
              h("div", { className: "sh-panel-h" }, "What each page is for"),
              PAGES.map(function (p) {
                return h("a", { className: "sh-page", key: p[0], href: p[0] + q }, h("span", { className: "sh-page-n" }, p[1]), h("span", { className: "sh-page-d" }, p[2]));
              })))));
    }
    try { PLUGINS.register("suburban-help", Help); } catch (e) { try { console.error(TAG, e); } catch (e2) {} }
  });
})();
