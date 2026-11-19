# Changelog

All notable changes to Suburban Cyber Agent OS. Dates are UTC.

## [0.64.0] — 2026-11-19

### Added
- **Security check card** on Overview: two-step sign-in, recovery codes running
  low, backups (recent, and whether a copy is kept off the server), a monthly
  spending limit for the team, and whether an update is waiting. Each line links to
  the page that fixes it (`GET /security/check`).
- **Help page** (Settings, Help): what each page is for, eight common how-tos, and
  the support contact set for this install. It takes the place of the removed
  Documentation link.
- **Install as an app.** The dashboard now carries an app manifest and icons, so a
  phone or desktop browser can add it to the home screen and open it full screen.

## [0.63.0] — 2026-11-19

### Added
- **Board view on Tasks.** A List / Board switch at the top right. The board shows
  the same tasks in four columns: Needs you, In progress, Up next and Done. Clicking
  a card opens the task underneath. The choice is remembered on that browser.
  Done shows the latest eight, the other columns up to 25, each with a link to the
  full list.

## [0.62.0] — 2026-11-19

### Added
- **Team templates** on the Agents page. **Save this team as a template** downloads
  one file with each agent's name, role, title, description, manager and
  instructions. **Install a template** reads such a file on another server, shows
  exactly which agents it will add, and adds them.
- A template never contains keys, gateway addresses, budgets, tasks, files, memory,
  the business plan or the business profile. Anything in the instructions that looks
  like a key or password is removed on the way out, and the page says so.
- Installing never changes or replaces an agent that is already there (same name is
  skipped), and a second lead agent joins as a regular agent.

## [0.61.0] — 2026-11-19

### Added
- **Safe updates.** Before restarting anything, the updater waits for running tasks
  to finish (up to 5 minutes; `AOS_UPDATE_WAIT` seconds to change it), then pauses
  the team so no task starts during the restart, and switches it back on at the end,
  including when the update fails. A team the owner had already paused is left
  paused. If an update dies before resuming, the team switches itself back on within
  45 minutes.
- Takes effect from the update *after* this one: the wait runs against the service
  that is already installed, and the installed one does not know how to answer yet.

## [0.60.0] — 2026-11-19

### Added
- **Model advice** on the AI models page. From each agent's last 7 days of runs it
  suggests moving short, routine work to a cheaper model, or moving an agent whose
  runs keep failing to a stronger one, with the reason and an estimated saving.
  **Switch** applies it where this server can; otherwise **Show the steps** gives
  the exact commands for that agent's machine. The lead agent is never moved down.
  Only model pairs checked by hand are suggested (`MODEL_TIERS`; MiniMax-M3 and
  MiniMax-M3.1-Flash for now).

### Fixed
- Changing a model on an agent's own machine now works when Hermes was installed
  through the npm bridge (not on the PATH) and when the config keeps the model under
  `model: model:` instead of `model: default:`. It changes the key that is there,
  and still restores the old settings if the gateway does not come back.
- A model checked by hand can be chosen even when that machine's Hermes is too old
  to list it, as long as the provider is set up there.

## [0.59.0] — 2026-11-19

### Added
- **Files page.** One place for what the team hands over: reports, drafts, lists,
  spreadsheets, images. Search, filter by agent, read text, Markdown and CSV in the
  page, copy, download, delete. Each file shows the agent and the task it came from,
  and the task page lists its files.
- **`save_file` tool for agents**, also reachable from agents on their own machines.
  Text up to 400,000 characters, or PDF, image and Office files up to 4 MB. Saving
  the same name on the same task replaces the file. 20 files a task, 500 MB in all
  (`TEAM_FILES_MAX_MB`).
- The agents' writing guide tells them to save a document rather than paste it into
  the task.

### Changed
- The task tools address accepts bodies up to 6 MB (was 256 KB) so files fit.

## [0.58.0] — 2026-11-19

### Added
- **Plan page.** One business plan the whole team works from: what the business
  does, who it serves, this quarter's goals, what to avoid. The owner can ask the
  lead agent to write it or change it in plain words, or edit it directly. Every
  change is a saved version that can be viewed and brought back.
- Agents read the plan with `get_business_plan`. Only the lead agent can change it
  (`update_business_plan`), must send the whole plan with a one-sentence summary,
  and is refused if it sends less than half of the current plan by mistake.
- Today's idea now reads the plan, so ideas follow the owner's stated goals.

## [0.57.2] — 2026-11-19

### Changed
- Overview is laid out as two columns that stack on their own, so a tall card no
  longer leaves a gap beside a short one: summary, idea and activity log on the
  left; decisions, team and system on the right.
- The team list is compact (one line per agent, working and stopped agents first)
  and shows eight, with "Show all".
- The page uses more of a wide screen (up to 1480px).

## [0.57.1] — 2026-11-19

### Changed
- Overview: the Agents tile no longer says "Managed by Paperclip". It shows how
  many agents are working right now.

## [0.57.0] — 2026-11-19

### Added
- **Today's idea card on Overview.** Once a day the lead agent (the one with the
  CEO role) suggests one specific thing for the business: a post, an agent worth
  building, a follow-up, or a saving. Each idea carries its reason and what the
  team will do, with three buttons: **Do it** (files the task with the right
  agent), **Not today**, and **Not for me** (stops that kind of idea).
- The lead works from facts the system already holds (business profile, the
  week's summary, recently finished work, the team, upcoming appointments, past
  ideas and how the owner answered them) and answers through a new `post_idea`
  tool, so the card always gets clean fields. It may answer "nothing today".
- While the business profile is nearly empty, the card also asks one short
  question and saves the answer to the profile.
- Pressing Do it never approves publishing, sending or spending; the agent still
  asks for those with a decision card.

## [0.56.0] — 2026-11-19

### Added
- **Summary card on Overview** ("Today so far", with "Since yesterday" and "This
  week"). Two or three plain sentences, four numbers (finished, in progress, need
  you, spent), up to three heavy runs, and "Your day": anything that needs the
  owner first, then appointments still ahead today. Every sentence is built from
  counts read off the board (`GET /orchestration/summary`); no AI model writes it.
- A run counts as heavy at 30 minutes or $1, or at three times that agent's usual
  time, cost or tokens. Quiet sections hide themselves.

### Changed
- Overview layout: the summary sits beside Waiting on you and Your agents, with
  Activity log and Your system in a row below.

## [0.55.1] — 2026-11-19

### Fixed
- The dashboard reloaded forever after updating to 0.55.0. The menu removed
  `?profile=` from the address and reloaded, and Hermes put it straight back.
  The reload is gone; the profile box is still hidden unless Operator tools is on.

## [0.55.0] — 2026-11-19

- **New AI models page.** A simpler page in the Agent OS style: see your main model,
  change it in two steps (provider, then model, with recommended ones first and
  prices shown), and connect or disconnect AI providers by pasting a key. Agents on
  a different model are listed with a link to the Agents page.
- **The profile switcher is gone from the menu.** Owners stay with the main
  assistant. It comes back when Operator tools is switched on.
- Hermes's own Models page is still there for operators, as "Advanced models".

## [0.54.0] — 2026-11-19

- **Memory page.** See what your assistant has learned about you, the statements each
  conclusion was based on, and how your profile changed after each review. **Not
  right?** removes anything that is wrong, and **Review now** asks it to look over
  recent conversations.
- **Memory service upgraded to Honcho 3.6.1** (from 3.2.0). This adds the record of
  reviews the Memory page shows, and brings fixes: memory jobs no longer fail when an
  OpenAI-compatible model leaves out token counts, Claude 5 models work as the memory
  model, and the memory worker no longer stalls on one bad item.
- **The upgrade protects your memory.** The updater saves a copy of the memory
  database first, waits for the new version to come up healthy, and puts the copy back
  on the old version if it does not. The first update takes a few minutes longer.

## [0.53.0] — 2026-11-18

- **Agents in error are cleared and restarted automatically.** The stuck-agent watch
  now reads why an agent stopped (provider busy, gateway unreachable, job too big,
  key rejected, no credit), clears the error and restarts the agent, up to three
  times with a longer wait each time. A job that ran out of time is told to split.
- **You are only told when you have to act.** A rejected key, no credit, or three
  failed retries becomes an "Agent stopped" card under Tasks > Needs you, with the
  cause in plain words and **Retry now** / **Pause this agent** buttons.
- The Agents page shows why an agent stopped and what is being done about it.

## [0.52.0] — 2026-11-18

- **"Needs you" now means a decision.** The Tasks page used to count every blocked
  or in-review task as waiting on you, though most were agents waiting on each other.
  Those are now under **With the team**. Needs you shows only what a person has to
  decide.
- **Decisions come as cards with buttons.** Each one has a short summary, the
  question and the agent's recommendation, with **Approve**, **Decline** and **Tell
  me more**. You can add a note with any button. Approvals and reviews from the team
  board get the same buttons.
- **Your lead agent sorts out stuck work first.** Stuck tasks with no clear question
  go to the agent with the CEO role, who finishes, reassigns or closes them and only
  asks you when a real decision is needed. Switch on Account; needs the stuck-agent
  watch.
- **Agents must ask properly.** A question for the owner has to include a plain
  summary, one yes-or-no question and a recommendation.
- **Cleaner task pages.** The latest update comes first, agent text is formatted
  (headings, lists, tables), system notes are small, and the working notes added for
  agents are hidden.
- Failed runs and agent errors are listed as alerts, apart from decisions.

## [0.51.0] — 2026-11-18

- **A card for every AI provider.** The Overview has a new "Your AI providers" row and
  the Usage page shows one card for each provider you have a key for. Plans that
  report it show percent left; the rest show tokens, estimated spend and requests for
  the last 14 days as counted on this server.
- **Meta (Muse) models.** Meta is labelled properly on the cards and in the model
  list. Add the key under Settings > Keys ("Meta Model API"), then pick a Muse model
  under Agents > Change model.
- **Refresh the list.** After adding a provider key, the Change model panel can
  re-read the available models in about a minute instead of waiting half an hour.

## [0.50.0] — 2026-11-18

- **Agents on their own servers can split, finish and pass on tasks.** Until now only
  agents running on the Agent OS server had these tools, so an invited agent given a
  big job could not break it into parts. Invited agents now reach the same task tools
  on the team board's address, signed in with the Paperclip key they already hold.
  Each agent can only act on tasks assigned to it.
- **One step for agents you invited earlier:** Agents > pick the agent > **Add task
  tools to instructions** > Save changes. New invites and tasks filed from Chat
  include the instructions already.

## [0.49.4] — 2026-11-18

- **Pictures show in Chat wherever the assistant saved them.** Edited photos and other
  pictures it stored outside its usual image folder still came back as a server path.
  Any picture path in an answer is now shown as the picture.

## [0.49.3] — 2026-11-18

- **Attaching a file over 1 MB works with two-step sign-in on.** Uploads in Chat and
  Projects failed with "Could not attach that file" on any install that had two-step
  sign-in switched on.
- **Buttons under every picture in Chat:** Download, Try another version, and Change
  something (which starts your next message for you). Clicking the picture now opens
  it full size.

## [0.49.2] — 2026-11-18

- **Generated pictures show in the chat.** When the assistant made an image with its
  own built-in image tool it replied with a folder path on the server. The picture now
  appears in the answer in place of that path, and clicking it downloads it.

## [0.49.1] — 2026-11-18

- **Updates show up sooner.** The server now looks for a new version every hour
  instead of every six, and the Overview has a **Check for updates** link that looks
  right away (it answers within about a minute).

## [0.49.0] — 2026-11-18 — A model of its own for any agent

- **Change model works for agents on this server.** Open the agent on the Agents page
  and pick a provider and model. Only that agent changes; the others stay on the
  server's default, nothing restarts, and it applies to the agent's next task. "Use
  server default" puts it back. Providers appear once their key is under Settings, Keys.

## [0.48.0] — 2026-11-18 — One answer per question

- **Chat shows one answer, not the working.** The assistant's notes to itself while
  it uses its tools ("Let me check...") are no longer shown. You see your question, a
  "Working on it" note with the time, then a single answer. With Operator tools on,
  a small "Show working" link under an answer opens the hidden notes.
- **The assistant is told to work quietly** and reply once, on every install (writing
  rules, the writing skill and the tool instructions).

## [0.47.0] — 2026-11-18 — Chat: attachments, pictures, and a lighter page

- **Attach photos and files in Chat.** Use the + button, drag and drop, or paste a
  screenshot. Documents are read as text; photos are opened with the assistant's
  vision tool (this depends on the AI model in use).
- **Ask for pictures.** After a one-time setup on the Account page (OpenAI or MiniMax
  key), the assistant and agents can make images, for example for social media. The
  picture shows in the chat and can be downloaded or kept in a project.
- **A lighter chat page.** Typing no longer redraws every answer, the page checks for
  new messages faster while one is on its way and rests otherwise, and it shows how
  long the assistant has been working and how many steps it has taken. You can also
  send a follow-up while an answer is in progress.

## [0.46.0] — 2026-11-18 — Projects, and a sign-in gate for Team and Automations

- **Projects.** A new page under Chat. Create a project for a client or a job, upload
  its documents, write standing notes, and see its tasks. The assistant and the agents
  read a project before working on it, can search its files, and can save notes back.
  PDF, Word, PowerPoint, Excel and text files are readable; images are stored only.
  Projects are part of every backup.
- **Team and Automations addresses are no longer open to the internet.** On installs
  that use the tunnel, opening the Paperclip or n8n address now goes through the
  dashboard sign-in (and two-step code) first. Nothing changes in Cloudflare.
  Webhooks, forms and calls that carry an API key keep working.
- **Heads-up:** the tunnel can now only reach the proxy. A tunnel route that points
  at any other container stops working (see RUNBOOK section 25).
- **New Paperclip accounts are closed once your team is linked**, so nobody else can
  sign up on your board.

## [0.45.0] — 2026-11-17 — Security sweep

- **Updated libraries.** The web framework and encryption library the connectors
  service is built on had published security advisories. Both are updated; the audit
  now reports no known vulnerabilities.
- **Nobody can lock the owner out of "Forgot password?".** Five wrong reset codes
  used to lock the page, and that lock also blocked the emailed link, so a stranger
  could keep the owner out. The lock is gone (the code and link are far too long to
  guess; wrong tries are slowed instead). Asking for a new emailed link no longer
  cancels one already in the inbox.
- **Built-in workflows are off limits to agents.** Agents can no longer create, change
  or ask to switch on a workflow named "Agent OS: ...", which stops look-alike copies
  of the built-in ones. The internal token inside those workflows is hidden when an
  agent reads one.
- **You approve exactly what you were shown.** If a workflow is changed after an agent
  asked for approval, the request is withdrawn and has to be asked for again, so a
  workflow cannot be altered between the request and your click.

## [0.44.0] — 2026-11-17 — The dashboard on a phone

- **One title per page.** On a phone the page title was shown twice, with the first one
  half hidden under the top bar. The top bar is now shorter and the repeated title is
  gone.
- **Chat fits a phone.** It shows the list of chats or the conversation, not both
  squeezed side by side, with a "Chats" button to go back to the list.
- **Overview, Tasks and Orchestration** no longer wrap one word per line or run off the
  right edge: the heading and status stack, agent rows stack their buttons, and page
  margins are smaller.

## [0.43.0] — 2026-11-17 — Chat answers that are easy to read

- **Chat lays answers out properly.** Headings, bullet and numbered lists, tables,
  quotes and paragraphs are now drawn as such, with more comfortable spacing, instead
  of one block of text with symbols in it.
- **The assistant is told how to write to an owner.** Answer first, plain words, short
  sentences, names instead of IDs, a list or small table only when it helps, no
  technical notes tacked on the end. This is added to the assistant's standing
  instructions on every install and update; anything the owner wrote there is kept.
- How closely it follows this depends on the AI model the assistant runs on.

## [0.42.2] — 2026-11-17 — Memory in chat: the real cause

- **"Honcho memory is off for this session" at the end of chat answers.** The memory
  settings file was owned by root, and the agent service, which runs as its own user,
  could not read it. The updater and the installer now give the file the right owner.
  (0.42.1 fixed a different, rarer cause: an empty owner name.)

## [0.42.1] — 2026-11-17 — Memory note in chat, full workflow list, tables in chat

- **Memory switched off in chat.** Installs made before the installer gave the owner a
  default name could have an empty name in the memory settings. Hermes then turned
  memory off and said so at the end of every answer. The updater now fills the gap.
- **Agents saw only the first 100 workflows.** The workflow list given to agents, and
  the names on the Automations run list, now cover every workflow.
- **Tables in chat** are drawn as tables instead of rows of bars.

## [0.42.0] — 2026-11-16 — Big jobs are split into small tasks

- **A job that is really many jobs no longer runs until it is cut off.** When a task
  assigned from Chat covers a whole set of things ("all the workflows", "every
  client", a long list), it is filed as a short planning task, and the agent breaks
  it into smaller tasks first.
- **New tool on every install: split a task.** An agent that finds its task too big
  files the rest as 2 to 8 smaller tasks and closes the original. A part cannot be
  split again, so tasks cannot multiply.
- Every task now tells the agent what to do when the work will not fit, and the
  stuck-agent watch's reminder says to split instead of trying the whole job again.

## [0.41.0] — 2026-11-16 — Close several tasks at once

- **Tasks page: Select several.** Tick tasks (or "Select all shown") and mark them done
  or cancelled in one go, up to 100 at a time. Each gets a note that the owner closed
  it. Useful for clearing a backlog of items that only needed a look.
- The Tasks page now loads up to 200 items waiting on you, up from 80.

## [0.40.0] — 2026-11-16 — Agents close routine work; you get one daily summary

- **Fewer items waiting on you.** Agents are now trusted to finish routine work
  themselves. A request that only asks you to verify, confirm or close finished work
  is turned back and the agent closes it. Agents still ask before anything involving
  money, messages outside the business, prices or dates, passwords or access, deleting
  data, or a security incident. Switch it off on the Account page if you prefer to be
  asked about everything.
- **Daily task summary.** Automations has a new card: preview what your agents closed,
  what is waiting on you and what is in progress, and create a workflow that fetches
  it every morning for you to email or add to a daily brief you already have.

## [0.39.0] — 2026-11-16 — Agents can pass a task to a colleague

- **New tool on every install: hand a task over.** An agent working a task can pass
  it to a named colleague with the reason. The task stays open with the new agent.
- **It cannot go round in circles.** A task cannot be handed back to an agent that
  already had it, cannot go to an agent that is paused or in error, and can be passed
  on at most three times. After that the agent has to ask the owner.
- The starter templates now tell agents to use it instead of closing or guessing.
  Agents already created keep their instructions.

## [0.38.0] — 2026-11-16 — Agents can read mail and prepare replies

- **Mail tools for agents, on every install.** Agents can list unread messages, read
  one, and save a reply in the mailbox's Drafts folder. They cannot send, delete, move
  or mark mail; the owner sends drafts from their own mail app.
- **You choose per mailbox** on the Mailboxes page. It is ticked by default when
  connecting a mailbox. Mailboxes already connected stay off until you tick them.
- Sign-in codes, password resets and similar messages are kept from agents, and each
  email is handed over marked as outside content, not instructions.
- The Mailboxes page shows what agents did with your mail.
- The Customer Support, Lead Qualifier, Front Desk, IT Helpdesk and Review templates
  now tell the agent how to use mail. Agents already created keep their instructions.

## [0.37.0] — 2026-11-16 — A simpler menu, and a name for your main assistant

- **Menu.** "Advanced" is gone. Messaging and Messaging access move up to Connections.
  A new Settings group holds Account, AI models, Keys, Skills and Chat history.
- **Operator tools** (Hermes Profiles, MCP, Plugins, Scheduled Jobs, Files, Webhooks,
  Config, System, Logs) are hidden unless switched on from the Account page. This is
  to keep them out of the way, not to lock them.
- Kanban, Achievements and Hermes' Documentation are no longer listed.
- **Chat shows your main assistant's name** instead of "default". It is set from the
  first agent you create and can be changed on the Account page.

## [0.36.0] — 2026-11-16 — Welcome screen and Account page

- **Welcome screen on new installs.** The first sign-in asks the owner for their name
  and email and has them choose their own sign-in name and password, then shows the
  reset code to save. The installer's sign-in is now only temporary. It can be skipped.
- **Existing installs are unchanged**: no welcome screen appears and the sign-in stays
  as it is.
- **Account page.** The Security tab is now Account: your name and email, change your
  sign-in name, password, reset code, reset by email and two-step sign-in in one place.
- The name at the bottom of the sidebar shows the owner's name and opens Account.
- Changing only the sign-in name keeps the existing reset code.

## [0.35.0] — 2026-11-16 — Reset the password by email

- **Security page: Set up reset by email.** Give the address that should receive the
  link and a mail account for the server to send from. It turns on only after the
  current password is confirmed and a test message has been sent.
- **Forgot password?** now offers "Email me a reset link" when this is set up. The
  link lasts 30 minutes and works once; at most three are sent in an hour. The reset
  code still works alongside it.
- Anyone who can read the receiving mailbox can reset the dashboard password. The page
  says so, and it stays off unless the owner sets it up.

## [0.34.0] — 2026-11-16 — Change and reset the password from the dashboard

- **Security page: Change password.** Enter the current password and a new one. The
  dashboard restarts for about a minute; agents and automations keep running.
- **Reset code.** After each change the page shows a one-time code. Save it: it sets a
  new password if the old one is forgotten. Existing installs can get one with "Get a
  reset code" (asks for the current password).
- **Forgot password?** on the sign-in page takes the reset code and a new password, and
  then shows the next reset code. Wrong codes lock the page for a while.
- For whoever looks after the server: `sudo ./scripts/dashboard-password.sh` sets a new
  random password (or `--ask`), replacing the old "edit .env and run the updater".
- Passwords are 12 to 128 characters from letters, numbers and
  `! @ % ^ * ( ) _ + . , : ; ? ~ -`.

## [0.33.0] — 2026-11-16 — Update from the dashboard

- The "Update available" banner on the Overview now has an **Update now** button, so
  an owner without access to the server can update. It takes a backup, runs the
  updater on the server and reloads the page when it is done. The dashboard can be
  unavailable for a few minutes while it restarts. "Dismiss" is now **Later**.
- The banner shows progress, says plainly if an update did not finish (running
  services are left as they were) and says so if the server never picks the request up.
- One update at a time, limited to 90 minutes. An update interrupted by a restart is
  reported as not finished instead of "updating" forever.
- Nothing updates on its own. Running `sudo ./scripts/update.sh` on the server works
  as before, and is needed once to reach this version.

## [0.32.2] — 2026-11-15 — Documentation caught up

- README: new sections for the Website page (Google Analytics, several sites),
  Backups and two-step sign-in. Status lists what has now been confirmed on a live
  install: the Website page, two-step sign-in, creating an agent, and the stuck-agent
  watch's "Check now".
- Runbook: new §17 Website visitors and §18 Overview tiles; the per-client checklist
  now includes backups, two-step sign-in, the stuck-agent watch and a reboot test;
  Verify checks the six scheduled jobs.
- No code changes.

## [0.32.1] — 2026-11-15 — Recovery codes and keys were invisible

- On the Security page the recovery codes and the manual setup key were drawn in dark
  text on a dark box, so they looked empty. The dashboard theme colours that kind of
  text itself. Code-style text on every Agent OS page (Security, Backups, Website, the
  update banner) now takes the colour of the text around it, whatever the theme.

## [0.32.0] — 2026-11-15 — Two-step sign-in with an authenticator app

- **Security** page (under Connections): turn on a six-digit code from an
  authenticator app on top of the dashboard password. Scan a QR code with Google
  Authenticator, Microsoft Authenticator, 1Password or any similar app (standard
  time-based codes), enter one code to confirm, and it is on.
- **Sign-in:** a browser without a valid code is sent to a code page before anything
  else is served, including the password page and every dashboard API. A browser is
  asked again after 12 hours, or 30 days with "don't ask again on this browser".
- **Recovery codes:** eight one-time codes, shown once at setup, to get in without
  the phone. They can be replaced at any time.
- **Lost everything?** `sudo ./scripts/mfa-reset.sh` on the server turns it off.
- Five wrong codes lock the code page for a minute, then longer. A code works once.
  The secret is stored encrypted. Turning it off or setting it up again signs every
  browser out.
- Enforced at the proxy, which the server switches within a minute of turning it on.
  Installs that never turn it on are unchanged.
- It covers the dashboard only: n8n and Paperclip have their own sign-ins.

## [0.31.1] — 2026-11-15 — Website: accept a key that was damaged when copied

- A real Google key was refused with "That is not a Google service-account key". The
  page insisted on perfectly formed JSON, and a key copied from a terminal or editor
  often is not (hard line breaks inside the long key line, non-breaking spaces, a
  missing brace). The key is now read tolerantly, and the messages say what is
  actually wrong (cut off, no private key in the text, or damaged).

## [0.31.0] — 2026-11-15 — Several websites on one install

- The **Website** page can hold more than one site (up to 25), all read through the
  one Google key. Add a site with a name and its Property ID; the page shows the
  address to add as a Viewer in that site's Google Analytics and checks access before
  saving. Switch between sites with the buttons at the top.
- One site is your **main site**; its visitors are the ones on the Overview tile. Any
  site can be made the main one.
- **Replace the key** without re-entering sites, for example after rotating it.
- An install that had already connected a single site keeps it, as the main site.

## [0.30.0] — 2026-11-15 — Appointments and website visitors on the Overview

- **Appointments today** tile on the Overview, with the count for the next 7 days. It
  reads the calendars already connected under Bookings and appears once one is.
- **Website** connection (under Connections): visitor numbers from Google Analytics.
  Paste a read-only Google service-account key and the property number; the page
  checks it with Google before saving. Shows visitors and visits for the last 7 full
  days against the week before, the most viewed pages, and where visits came from.
- **Website visitors, 7 days** tile on the Overview once the Website connection is set.
- The key is stored encrypted, never returned, and only ever sent to Google. Numbers
  are cached for 30 minutes.

## [0.29.2] — 2026-11-15 — Active automations on the Overview

- The Overview has an **Active automations** tile: how many workflows are switched on,
  how many exist in total, and whether the stuck-agent watch is on. It appears once
  Automations is connected.

## [0.29.1] — 2026-11-15 — Backup uploads can no longer stall or pile up

- A Google Drive upload that was being rate limited ran for three hours before giving
  up, and held up an update the whole time. **An upload attempt is now stopped after
  45 minutes** and tried again later.
- **Only one upload runs at a time.** Retries used to be able to start on top of an
  attempt that was still running, which made rate limiting worse.
- Retries are spaced further apart each time (30 minutes, 1 hour, 2 hours, up to 6),
  eight attempts at most; `scripts/backup.sh --retry-upload` always tries once.
- The backup taken before an update never uploads inline; it is sent afterwards.

## [0.29.0] — 2026-11-14 — Stuck-agent watch

- **A built-in automation that notices agents that have stopped moving** and gives
  them a careful push. Turn it on from the Automations page (*Stuck-agent watch*).
  Every ten minutes it:
  - retries the connection of an agent whose connection check failed;
  - reminds an agent about a task in progress that has gone quiet (45 minutes by
    default, adjustable), or about assigned work an idle agent never started.
- **Two tries, then it stops.** After two reminders it marks the task as needing you
  and reports it, so nothing loops. It leaves paused agents, a paused company, tasks
  being worked on right now and old abandoned work alone, and does at most six things
  per pass.
- **Optional gateway restart.** If you allow it, and only on machines you already
  granted with `scripts/agent-ssh.sh`, it restarts the agent's gateway before the
  second reminder. Never while that agent is working, and at most once in six hours.
- **Check now (changes nothing)** shows what it would do before you turn it on.
- It runs as a normal n8n workflow, *Agent OS: stuck-agent watch*, so you can add
  your own email, Telegram or Slack alert after its last step. The checking itself
  stays in the connectors service; the workflow holds no Paperclip key.

## [0.28.0] — 2026-11-14 — Ready for first testers

**First run**
- **Link my team from the dashboard.** After creating the Paperclip owner account,
  press *Link my team* on the Orchestration page; no terminal needed. The server
  carries the request out within a minute (`scripts/host-requests.sh`).
- Agents and Tasks no longer show an error and "Loading…" before the team is
  linked; they point to the Orchestration page.
- The installer ends with the three things left to do (team, automations, backups).
- The Overview heading uses your business name.

**Installer**
- **Smaller servers allowed:** 8 GB RAM / 2 cores / 40 GB is the minimum; 16 GB / 4
  cores / 80 GB is recommended (warns below that, used to refuse below 16 GB).
- Long-term memory can be skipped at the prompt (it needs an OpenAI-compatible key);
  leaving the key empty no longer aborts the install.
- An install that failed partway is **resumed** by re-running the one-line command.
- `--profiles` without `memory` no longer asks for a memory key. An empty Cloudflare
  token is not accepted. Names are limited to safe characters. Default agent name is
  `assistant`. The automations timezone follows the server (existing installs keep
  the one they had).
- `--yes` is documented as what it is: it skips confirmations, not the questions.

**Updates, reboots and restore**
- The updater **backs up first**, follows a rewritten release history, installs any
  missing scheduled jobs, and says plainly if it stopped partway.
- The watchdog stands down during an update or restore, and Paperclip and n8n get
  five minutes to start before they count as unhealthy (slow disks, hard power-offs).
- **Restore onto a new server:** the memory database password and the automations
  encryption key are reconciled with the restored settings, a failed load is no
  longer reported as success, and the remaining manual steps are listed at the end.
- Backups: a "Back up now" pressed during a running backup is no longer lost; a
  failed n8n export is reported.

**Docs**
- README: "Before you start", what leaves your server, reporting a problem,
  uninstalling, client-hosted installs, current layout and status. Runbook: reboot test.

## [0.27.4] — 2026-11-14 — Security fixes from the pre-launch review

- **Backups: the pasted storage config could run a program.** The "OneDrive or other"
  option accepted any rclone setting, including ones that execute a command or point
  back at the server's own disk. It now accepts only plain cloud-storage types and
  ordinary `name = value` options. Update before giving anyone else a dashboard login.
- State-changing requests that a browser marks as coming from another website are
  refused.
- Three agent routes now validate the agent id like the rest.

## [0.27.3] — 2026-11-14 — Create Agent works when hires need approval

- Creating an agent from the Orchestration page failed with "Direct agent creation
  requires board approval" on companies that have that Paperclip setting on. The
  dashboard now files the hire and approves it in the same step, since the person
  pressing Create is the owner. The approval is recorded in Paperclip with a note.
- Pressing Create again after a failed attempt no longer trips over the Hermes
  profile the first attempt already made.

## [0.27.2] — 2026-11-14 — Backup uploads that survive rate limits

- A first real upload to Google Drive was refused with `rateLimitExceeded`. Uploads
  gave up too quickly: they now pace their requests, back off and retry several times.
- **A failed upload is retried automatically** about every 30 minutes (up to 12
  times) without making a new backup. To send it again right away:
  `sudo ./scripts/backup.sh --retry-upload`.
- Google Drive can be connected with **your own Google client ID**, which has its own
  request allowance instead of sharing rclone's. Optional, on the Backups page.
- Rate-limit errors are explained in plain words on the page.

## [0.27.1] — 2026-11-14 — Clearer Google Drive steps

- The Backups page now walks through connecting Google Drive step by step, including
  how to install rclone on Windows and Mac and exactly which part of its output to
  paste. The runbook also says how to install `age` for the second key.

## [0.27.0] — 2026-11-14 — Full backups: encrypted, off-site, restorable

- **The nightly backup now covers the whole system**, not just agent memory: the team
  database and its files and keys, agent memory, automations, dashboard connections,
  Hermes profiles and skills, and settings. One file per night in `backups/`.
- **Encryption with a recovery kit.** Create the kit on the new **Backups** page
  (under Connections), download it once, and the server deletes its copy. An optional
  **second key** lets whoever manages the install restore it if the owner loses the
  kit; the server only ever holds public keys.
- **Off-site copy** to Google Drive, any S3-compatible storage, or anything rclone
  supports (OneDrive, SharePoint, Dropbox). The connection is tested before it is
  saved, and a backup is only uploaded once it is encrypted.
- **`scripts/restore.sh`** opens a backup with either key, checks every part against
  fingerprints recorded at backup time, and with `--apply` restores it. Reloading the
  team database is still a manual step (see the runbook).
- **The Overview shows what the last backup actually did** (off-site copy, this
  server only, failed, or how old) instead of the fixed text "Memory backup · nightly".
- **Back up now** button, adjustable retention, and an optional backup step in the
  installer. Operators can pre-set their key: `OPERATOR_BACKUP_PUBKEY=age1... ./install.sh`.
- `age` and `rclone` ship inside the connectors image, so the host still needs only Docker.

## [0.26.3] — 2026-11-14 — Readable dropdowns on the Agents page

- The Agents page set its own dark text colour on dropdown options, which overrode
  the dashboard-wide rule and gave dark text on a dark list (role, reports to,
  provider and model). The page now uses the shared rule: light text on a dark list,
  with the highlighted option in the accent colour.

## [0.26.2] — 2026-11-14 — agent-ssh fixes

- `scripts/agent-ssh.sh add` now finds the `hermes` command when it is not on the
  path, by reading where the machine's own gateway service starts it from, and
  remembers that location for model changes. It prints the Hermes version it found.
- The "can this server restart the gateway" check now asks `sudo` about the exact
  restart command. The earlier check used a dry-run variant that a narrowly scoped
  sudoers rule (the one the script itself recommends) does not match, so it kept
  reporting "no" after the rule was added.

## [0.26.1] — 2026-11-14 — Usage cards follow your agents

- The Usage page now shows a card for **every AI provider at least one agent is
  on**, as reported by each agent's own Hermes, and lists those agents and their
  models on it. Put an agent on a new provider and its card appears after the next
  model check (every 30 minutes), with nothing to configure.
- Related provider names share a card (for example `minimax` and `minimax-oauth`).
- Providers without a usage connection in this version say so plainly instead of
  showing figures. MiniMax M Plan remains the one with live numbers.

## [0.26.0] — 2026-11-14 — AI plan usage

- **New Usage page** (under *Your team*): how much of an AI provider plan the team
  has used, what is left and when it resets, read live from the provider.
- **MiniMax M Plan (Token Plan)** is supported first: the rolling 5-hour window and
  the weekly window, each with percent left, time to reset, and a projection at the
  window's average pace that warns when the plan is on course to run out before it
  resets. Field meanings were checked against a live response and the provider's
  own usage page; only the percent and time fields are used, because the count
  fields can be zero on real plans.
- With a monthly price entered, the page shows an approximate cost per agent run
  from Paperclip's 14-day record.
- The plan key is typed in by the owner, checked with the provider before it is
  saved, stored encrypted on the server and never returned. Results are cached for
  a minute.
- **Overview** gains a tile for the plan's weekly allowance, highlighted when it is
  low or on pace to run out.
- OpenAI and Anthropic usage (spend against a budget, via their admin usage APIs)
  is planned and not in this release.

## [0.25.0] — 2026-11-14 — Tasks page on large boards, activity tiles

- **Tasks page now shows current work on boards with thousands of tasks.** It used
  to take an arbitrary first 50 tasks, so on a large board "Working" could be empty
  while agents were busy. It now asks Paperclip for tasks in progress, tasks waiting
  on the owner, queued tasks and the most recently finished, newest first.
- Tasks with an agent run in flight are marked **Running now** and listed first;
  other in-progress tasks read **In progress**. Filter buttons show counts. Task
  keys use Paperclip's identifier (for example `ABC-123`).
- **Overview: two new tiles**, from Paperclip: agent runs over the last 14 days
  (succeeded, failed, today) and tasks in progress (with total open). The chat
  session, token and spend tiles are labelled "this server only" when the team is
  managed by Paperclip, because they never included agents on other machines.

## [0.24.0] — 2026-11-14 — Change an agent's model from the dashboard

- **Agents page: Change model.** For an agent on its own Linux machine, pick a
  provider and model and the server applies it there: it backs up that machine's
  Hermes config, sets the model with Hermes' own `config set` command, restarts the
  gateway, and checks the gateway comes back reporting the new model. If it does
  not, the previous config is restored and the gateway restarted again.
- The choices offered are the providers that machine already holds a key for and
  the models it lists for each, as reported by its gateway. Nothing else is
  accepted. To use a new provider, add its key on the machine first.
- A change is refused while the agent is working on a task (the restart would
  interrupt it).
- New `scripts/agent-ssh.sh add <user>@<host>`: creates this server's SSH key
  (root only, in `data/agent-ssh/`), installs it on the machine, and records the
  gateway service and whether it can be restarted without a password. Where it
  cannot, it prints a one-line sudoers rule limited to that restart. `list` and
  `remove` are also available. The connectors image now includes an SSH client and
  mounts that folder read-only.
- Agents on this server keep using *Local models*; Windows machines are not
  supported by this path yet.

## [0.23.0] — 2026-11-14 — Each agent's real model

- **Agents page shows the model and provider each agent is actually configured
  to use**, as reported by that agent's own Hermes gateway, with the Hermes version
  and when it was last checked. Agents on other machines are included.
- New `scripts/agent-models.sh` (run by `update.sh`, then every 30 minutes from
  cron). The check runs inside the Paperclip container: each gateway's key is read
  in place from Paperclip's encrypted secret store, used for one read-only request,
  and never printed, copied out or stored elsewhere. A key is only sent over HTTPS,
  or over plain HTTP to a gateway on the same Docker network or loopback. Only model
  names reach the dashboard.
- When a gateway cannot be asked, the page says why (unreachable, key refused, not
  HTTPS, or a Hermes version that does not report its model) instead of guessing.
- Hermes' built-in Models page is now labelled **Local models** (Advanced). It only
  ever described the Hermes on this server.

## [0.22.0] — 2026-11-14 — Agents page

- **New Agents page** under *Your team*: every agent Paperclip manages, wherever it
  runs, with its status, title and where it runs. Open one to edit name, title,
  role, who it reports to, what it does and its main instructions, or to pause and
  resume it. Changes are saved to Paperclip and used from the agent's next task.
- Instructions are read from and saved to the agent's main instruction file when
  it has one; Paperclip refuses the save if the file changed since it was loaded.
  Agents created from this dashboard keep their inline instructions.
- An agent that runs on this server cannot be renamed here (its name links it to
  its Hermes profile).
- Hermes' built-in Profiles page is now labelled **Hermes profiles** (Advanced). It
  only ever listed profiles on this server, which is why agents on other machines
  never appeared there.
- Gateway address, keys, budgets, extra instruction files and run history stay in
  Paperclip.

## [0.21.1] — 2026-11-14 — Documentation

- README, runbook and architecture updated for the team chart and task replies.
- New runbook §12, **Agents on their own machines**: what Paperclip needs to manage
  an agent whose Hermes gateway runs elsewhere (HTTPS gateway address, gateway key
  as a secret, report-back address, a Paperclip key on the agent's machine), how to
  check it, moving agents from another Paperclip, and Windows agents.
- Troubleshooting: dashboard showing the wrong company (`PAPERCLIP_COMPANY_ID`),
  tasks stuck "queued" while an agent's connection check fails, and Cloudflare
  returning 403 to Python scripts that use the default request signature.

## [0.21.0] — 2026-11-14 — Answer tasks from the dashboard

- **Tasks: reply, reopen, mark done and cancel without opening Paperclip.** A reply
  is posted to the task as the owner and Paperclip wakes the assigned agent to
  read it. Replying on a finished or cancelled task reopens it. Cancelling takes
  two clicks. The task's original request is now shown above the conversation.
- New endpoints `POST /orchestration/tasks/{key}/reply` and `/status` (owner
  session only; refused when the install is connected to an external Paperclip in
  read-only mode). Task keys are validated before they reach Paperclip.
- Approvals, full history and file downloads still open in Paperclip.

## [0.20.0] — 2026-11-14 — Team chart

- **Orchestration: team chart.** A new panel draws who reports to whom from
  Paperclip's own reporting lines, with each agent's title and live status
  (working, ready, needs attention, paused). It refreshes with the rest of the
  tab every 30 seconds, so agents added, removed or re-parented in Paperclip or
  from this dashboard appear without a reload. A manager with more than four
  direct reports gets them wrapped in rows instead of one very wide line; agents
  with no manager sit at the top; a reporting loop is shown, not hidden.
- `/orchestration/overview` now returns each agent's `title` and `reports_to`.

## [0.19.0] — 2026-11-12 — Turn workflows on and off from the dashboard

- **Automations: Turn on / Turn off per workflow.** Turning one on takes two clicks
  (it can send email, post or publish); turning off is immediate. n8n's own reason
  is shown if it refuses (no trigger, missing credential, retired step). This is an
  owner action in the dashboard; agents still have no way to activate a workflow.
- Workflow list now loads every workflow (it stopped at 100), sorts active first,
  marks archived ones, and gains a filter box for long lists.
- **Overview "managed" card no longer carries built-in names or dates.** It shows
  `OPERATOR_NAME` / `SUPPORT_CONTACT` from `.env` when set and nothing otherwise;
  the non-functional "Request a change" button is gone.
- Docs and examples use neutral hostnames and addresses (`example.com`,
  documentation IP ranges) throughout.

## [0.18.3] — 2026-11-12 — Documentation refresh

- README, runbook and architecture brought up to date with everything through
  0.18: chat tools and routing, agent templates, business profile, fixed sidebar,
  tunnel hostnames, one-step Paperclip connect, memory plugin, pinned versions and
  prebuilt images, current status and limitations.
- Removed the n8n workflow import script added in 0.18.2; it is not part of the
  product.

## [0.18.1] — 2026-11-12 — One-step Paperclip connect

- `scripts/paperclip-connect.sh` links the dashboard to Paperclip: it issues a
  board key for the owner account and stores it in the dashboard's encrypted key
  store without ever displaying it. The dashboard used to tell you to create a
  board key under Paperclip's Settings, but this Paperclip version has no such
  screen. The key does not expire (Paperclip's default is 30 days).
- Orchestration's connect steps and error message now point at the script.

## [0.18.0] — 2026-11-12 — Hermes and n8n pinned

- Hermes and n8n are now pinned by image digest to the builds verified on a
  clean install: **Hermes Agent v0.23.1 (2026.9.24)** and **n8n 2.47.5**. New
  installs no longer take whatever `latest` is that day. (Two boxes installed days
  apart had already drifted from Hermes 0.22.7 to 0.23.1.)
- `HERMES_TAG` / `N8N_TAG` in `.env` are no longer used; override with
  `HERMES_IMAGE` / `N8N_IMAGE` if a box must differ.
- Updating an older box moves it to these versions.

## [0.17.2] — 2026-11-12 — One-step hostnames

- `scripts/set-hostnames.sh <dashboard-hostname>` writes all the tunnel hostname
  settings (Paperclip and n8n public URLs, allowed hosts, n8n proxy settings) and
  applies them, replacing seven hand-edited `.env` lines.
- `/orchestration/company` returns a clear "not connected" instead of a 500 on a
  box where Paperclip has not been connected yet.

## [0.17.1] — 2026-11-12 — Memory plugin fixes from the first clean install

- Memory plugin install no longer fails with a permission error: the plugins
  directory is handed to the user Hermes actually runs as (the image drops root
  even with `--user root`). `scripts/install-memory-plugin.sh` repairs an
  existing box.
- Hermes now gets a placeholder `HONCHO_API_KEY`. The plugin reported "not
  available" without one, although the self-hosted memory service does not use it.
- Installer: closing message is tunnel-aware; the memory-provider prompt only
  accepts 1 or 2 and warns if a key was pasted there.

## [0.17.0] — 2026-11-12 — Sidebar: fixed, grouped, no reloads

- **The sidebar no longer reshuffles.** Each plugin used to inject its own copy of
  its link whenever it happened to load, so the order changed between pages, the
  list flashed Hermes' stock order first, and every click on one of those copies
  reloaded the whole app. `brand/nav.js` is now the only thing that arranges the
  sidebar. It uses Hermes' own links (in-app navigation, working highlight) and
  sets a fixed order with CSS, so nothing moves.
- **Grouped:** Overview, Chat · *Your team*: Tasks, Orchestration, Automations ·
  *Connections*: Bookings, Mailboxes · *Advanced* (collapsed by default,
  remembered per browser, opens automatically when you are on one of its pages):
  Agents, Models, Skills, MCP, Plugins, Scheduled Jobs, Sessions, Files, Channels,
  Webhooks, Pairing, Keys, Config, System, Logs, Kanban, Achievements, Docs.
- Duplicate entries and Hermes' "Plugins" list title are hidden. The stock list is
  hidden until arranged (revealed after 2.5s regardless, if the script fails).
- Overview navigates in-app instead of reloading.

## [0.16.0] — 2026-11-12 — Supply chain: prebuilt images, version pins

Protects new installs from upstream repos changing or disappearing.

- **Prebuilt Paperclip and Honcho images.** `.github/workflows/images.yml` builds
  both from their pinned commits (unmodified) and publishes them to
  `ghcr.io/ajr1303/agent-os-paperclip` / `agent-os-honcho`. Install and update
  pull these first and only build locally if the pull fails.
- **Pin hooks for Hermes and n8n:** `HERMES_IMAGE` / `N8N_IMAGE` (accept a
  digest). `scripts/show-versions.sh` prints the exact images a tested box is
  running, as pin lines.
- `THIRD_PARTY_NOTICES.md` records each upstream project, its license and how it
  is used. n8n is pulled from its official registry and not redistributed.
- CI checks the workflow's refs match the commits pinned in `docker-compose.yml`.

## [0.15.0] — 2026-11-11 — Agents close their own tasks; business profile

- **Tasks finish properly.** Agents had no way to mark a task done, so delivered
  work showed as "blocked" and Paperclip re-ran the agent to "recover" it. New
  tools `complete_task` and `need_owner_input` (agent_os) let the assigned agent
  close its task or park it waiting on the owner. Connectors checks the caller's
  Agent ID against the task's assignee before changing anything.
- **Working rules on every agent.** A short footer is appended to each agent's
  instructions on create/edit (finish with `complete_task`, ask with
  `need_owner_input`, no placeholders, don't assign tasks to other agents). It is
  hidden when editing. Existing agents pick it up the next time they are saved.
- **About your business.** New panel in Orchestration (name + free text). Agents
  read it with `get_business_profile`, and it is attached to every task created
  from chat, so output stops coming back with "[Company Name]".
- Note: Paperclip-run agents all execute through the one Hermes gateway on the
  default profile, so every agent sees the same `agent_os` tools. The per-profile
  n8n subset from 0.14.0 only applies to chatting with a profile directly.

## [0.14.1] — 2026-11-11 — Routing fixes from first live test

- Recurring requests now go to **n8n, not Hermes scheduled jobs**. The first live
  test offered `cronjob_manage` for a daily lead summary; a scheduled job runs the
  model on every run. The tool descriptions (always in context) and the skill now
  say so explicitly.
- "I need someone to handle X" is treated as a **role** (hiring review), even when
  X happens on a schedule. Payroll was routed to a workflow build.
- **Money never moves on its own**: workflows and agents may prepare and remind;
  payments, payroll runs, refunds and transfers stay with the owner.

## [0.14.0] — 2026-11-11 — Chat tools: delegation + workflows from chat

The chat agent can now run the business instead of doing every job itself.

- **Chat tools (MCP).** Connectors serves an MCP endpoint (`/mcp`) that Hermes
  loads as the `agent_os` server. Tools: `list_agents`, `assign_task`,
  `list_tasks`, `task_status`, `request_hiring_review`, `list_workflows`,
  `workflow_failures`, `failed_run_detail`, `get_workflow`, `create_workflow`,
  `update_workflow`, `request_activation`.
- **Routing skill** (`skills/agent-os/running-the-business`): answer quick
  questions; repeatable work becomes an n8n workflow (preferred, no AI usage per
  run); judgment work goes to the matching agent; no matching agent sends the
  CEO a hiring review that proposes, never hires.
- **Approval is enforced in code, not in the prompt.** Workflows are always
  created inactive; there is no activate tool. Agents file an activation request
  and the owner approves it under **Waiting for your approval** in Automations
  (`/automations/requests`). Live workflows cannot be edited through the tools.
  Task creation is rate-limited (`CHAT_TASKS_PER_HOUR`, default 20). Against an
  external Paperclip the delegation tools are read-only.
- **Internal only.** Bearer token (`CHAT_TOOLS_TOKEN`, generated on update), and
  `/api/connectors/mcp` returns 404 on the public proxy.
- `scripts/sync-chat-tools.sh` writes the MCP entry into the Hermes config
  (backup kept as `config.yaml.pre-agent-os-tools`) and installs the skill; run
  by install and update. Agent profiles whose name contains "automation" or
  "n8n" (or listed in `N8N_TOOLS_PROFILES`) get the n8n-only subset
  (`/mcp/agent`).

## [0.13.0] — 2026-11-11 — Agent templates

- **Start from a template** in Orchestration → Create agent. Nine starter agents
  fill in the name, role and instructions (all editable before creating):
  Automation Engineer (n8n builds/fixes), Front Desk, Lead Qualifier, Customer
  Support, Social Media Manager, Review & Reputation, Bookkeeping Assistant,
  IT Helpdesk, and CEO (runs the hiring review for requests no agent covers).
- Templates live in `connectors/agent_templates.json`, served by
  `GET /orchestration/agent-templates`. Every template is approval-first: agents
  draft and propose; the owner approves sends, publishes, activations and hires.

## [0.12.4] — 2026-11-11 — Paperclip password reset

- New `scripts/paperclip-reset-password.sh`. Paperclip has no "forgot password"
  flow, so this lists the accounts, takes the new password at a hidden prompt, and
  writes a Better Auth-compatible scrypt hash for that user (and signs out their old
  sessions). The password never touches argv, env, history, or disk.

## [0.12.3] — 2026-11-11 — Clear per-agent budget caps too

- Turning the company cap off (`POST /orchestration/budget {budget_cents:0}`, the
  "Turn off cap & resume" button) now also clears **per-agent** caps and resumes
  agents held with `pauseReason: budget`. Per-agent caps are blind to Hermes cost
  the same way and kept agents paused after the company resumed (a manual resume
  clears manual holds only, not budget holds).
- `GET /orchestration/budget` now lists every active cap (company + agent).

## [0.12.2] — 2026-11-11 — Paperclip dollar budget off by default

- **Root cause of "company paused by budget" at $0 spent:** Paperclip's hard-stop
  fails closed on usage it can't price, and Hermes-gateway runs report tokens but
  usually no dollar cost. So the $100 cap paused the company as soon as it existed
  while being blind to real spend.
- `COMPANY_BUDGET_CENTS` now defaults to **0 (off)**. Spend protection is the run
  fast-stop (`RUN_MAX_ATTEMPTS`) plus a hard limit at the LLM provider.
- New `POST /orchestration/budget {budget_cents}` (0 = off). When the company is
  budget-paused, the Orchestration banner offers **Turn off cap & resume**.
- Runbook §9 "Spend protection" documents the model.

## [0.12.1] — 2026-11-11 — Company resume + full invite prompt

- **Company-level pause/resume.** Agents were stuck because the whole Paperclip
  company was paused (agent pause reason `company_paused`), which agent-level
  resume can't override. New `GET /orchestration/company` and
  `POST /orchestration/company/resume|pause`; the Orchestration page shows a
  banner explaining why the company is paused (budget hard-stop vs manual) with a
  Resume company button.
- **Invite prompt is now the full paste-ready prompt.** Paperclip's endpoint only
  returns the onboarding URL (its UI builds the prompt client-side); connectors now
  builds the equivalent prompt (onboarding URL, health check, join flow,
  Hermes/OpenClaw gateway notes, optional note). Errors clearly if
  PAPERCLIP_PUBLIC_URL isn't a reachable URL.
- Brand assets (`/sct-brand/`) are served `no-cache` so branding/version updates
  appear without a hard refresh.

## [0.12.0] — 2026-11-11 — Agent controls, invite, branding

- **Pause / Resume agents from the dashboard.** New connectors endpoints
  `POST /orchestration/agents/{id}/pause|resume` (board key) and a button on each
  agent row. Paused agents show an amber chip. Agent detail now includes
  `status` + `pauseReason`.
- **Invite an agent.** The Create panel has a second tab that generates
  Paperclip's invite prompt (`/openclaw/invite-prompt`) — copy-paste text an
  external agent (Hermes, OpenClaw, Claude…) reads to request to join; approve it
  under Waiting on you. Single-use, expires in 72h, links use the tunnel URL.
- **Readable dropdowns everywhere.** Global `sct.css` (injected by the proxy) sets
  `color-scheme: dark` and option colors, fixing light-on-white option lists.
- **Suburban Cyber favicon.** SC monogram (SVG at `/favicon.ico`, PNG + apple-touch
  icons) in the logo's sampled brand colors.
- **Footer rebrand.** "v0.22.7 · Nous Research" becomes "agent os v<version> ·
  Suburban Cyber", with a "Powered by Hermes Agent · Nous Research (MIT)" credit on
  hover. Version comes from `VERSION` via the generated `links.js`.
- Path IDs sent to Paperclip are validated on the new endpoints.

## [0.11.1] — 2026-11-11 — Honcho install fixes + docs

- **Honcho image no longer pull-fails.** `honcho-deriver` now declares the same
  build context as `honcho-api`, so `docker compose up` builds/reuses the local
  `agent-os/honcho` image instead of trying to pull it ("pull access denied …
  repository does not exist").
- **Honcho plugin install fixed.** `hermes plugins install honcho` now runs
  `--user root` so it can write the bind-mounted, root-owned `/opt/data/plugins`
  (was failing with `PermissionError: [Errno 13]`).
- **Docs:** new `docs/RUNBOOK.md` (deployment + per-client Cloudflare Tunnel
  checklist; Secure Boot stays on, no LAN-mode advice). Refreshed
  `docs/ARCHITECTURE.md` (real stack: proxy, connectors, gateway-tls, cloudflared,
  Paperclip, n8n, 7 plugins). README points at the runbook; memory-default note fixed.

## [0.11.0] — 2026-11-11 — Tunnel hostnames for Paperclip & n8n

Makes the "Open Paperclip" / "Open builder" buttons work through the tunnel, and
configures n8n to sit correctly behind an HTTPS reverse proxy.

- **Dashboard buttons now use configured public URLs.** `sync-branding.sh`
  generates `/sct-brand/links.js` (`window.__SCT_LINKS__`) from
  `PAPERCLIP_PUBLIC_URL` / `N8N_PUBLIC_URL`; the orchestration, automations, and
  tasks plugins use those for the open-in-new-tab links, falling back to the old
  `host:3100` / `host:5678` guess when unset.
- **n8n reverse-proxy settings parameterized:** `N8N_PROTOCOL`, `N8N_HOST`,
  `N8N_SECURE_COOKIE`, `N8N_PROXY_HOPS`, and `WEBHOOK_URL`/`N8N_EDITOR_BASE_URL`
  (from `N8N_PUBLIC_URL`). Defaults unchanged for LAN/local; set them for a tunnel.
- **cloudflared default bumped** 2024.12.2 → 2026.7.3 (the old pin was flagged
  "unsupported" by Cloudflare). Override with `CLOUDFLARED_TAG`.

Per-client naming note: one-level hostnames (e.g. `agent-os-paperclip.example.com`)
are covered by free Universal SSL; nested (`x.agent-os.example.com`) needs ACM.

## [0.10.0] — 2026-11-11 — Access methods

Reworks how a box is reached, secure by default, with a pluggable access method.
The product stays neutral — a self-hoster picks their own method; the managed
service is just the Cloudflare option operated on the client's behalf.

- **n8n and Paperclip now bind to loopback only** (`INTERNAL_BIND`, default
  `127.0.0.1`), decoupled from `DASHBOARD_BIND`. They are never published on the
  LAN, closing the "first visitor on the network claims the owner account" window.
- **Installer access menu:** `1) this machine / SSH tunnel` (default), `2) Cloudflare
  Tunnel` (collects a tunnel token), `3) direct LAN/public HTTP` (flagged not
  recommended). Writes `ACCESS_MODE`, `INTERNAL_BIND`, and `CLOUDFLARE_TUNNEL_TOKEN`.
- **`cloudflared` service** (compose profile `tunnel`): dials out to Cloudflare, no
  inbound ports, free TLS, hostname→service routing configured in Cloudflare Zero
  Trust. Works for any operator with their own Cloudflare account.
- README access-methods section rewritten; CI validates the `tunnel` profile.

Not yet done (next): tunnel hostnames for n8n/Paperclip and the dashboard's
"Open builder" links when tunneled; per-client tunnel automation; Tailscale path.

## [0.9.1] — 2026-11-10 — Security batch (pre-client-install blockers)

Addresses the "Immediate" items from the code & security review. All four were
validated live on the test box after deploy.

- **F-15 — Unauthenticated API docs disabled.** `FastAPI(docs_url=None,
  redoc_url=None, openapi_url=None)`. `/api/connectors/docs`, `/redoc`, and
  `/openapi.json` now return 404 instead of handing an attacker the API inventory.
- **F-31 — `HONCHO_DB_PASSWORD` is required.** Replaced the `${…:-unset}` literal
  fallback with `${…:?}`, so the Postgres volume can never initialise with a
  predictable password on a hand-edited or partially-restored `.env`.
- **F-10 — Installer no longer overwrites an existing `.env`.** `write_env()`
  detects an existing install, backs up `.env`, keeps every secret, and only
  refreshes dirs/branding. `get.sh` routes installs that already have a `.env` to
  `update.sh`. Prevents bricking Postgres / n8n / Fernet-encrypted connector
  credentials when the bootstrap one-liner is re-run.
- **F-03 — Chat renderer XSS fixed.** `esc()` now escapes `"` and `'`, and the
  markdown link rule validates each URL with `new URL()` (http/https only) and
  re-escapes the href. A crafted markdown link can no longer break out of the
  `href` attribute to inject event handlers.
- **CI:** completed the `docker compose config` env stub (all required secrets)
  and now validates the memory/automation/control-plane profiles together.

## [0.9.0] — 2026-11-10 — Per-task run fast-stop

- Per-task fast-stop at the TLS gateway: an nginx `auth_request` meters run
  creation (`POST /v1/runs`) per stable session key via connectors
  `/gateway/authorize`, backed by a persistent `run_budget` ledger. Over
  `RUN_MAX_ATTEMPTS` (default 6) the run is denied with a terminal status, so a
  looping task halts in seconds instead of burning spend. Status/events/stop
  always pass. Fails open on any ledger error.
- Tasks page shows a "halted" banner with a per-task **Release** button
  (`/gateway/blocked`, `/gateway/unblock`). The authorize endpoint is firewalled
  off the public proxy.
- `update.sh` now restarts `gateway-tls` so bind-mounted gateway config changes
  take effect on update.

## [0.8.0] — 2026-11-10 — Spend guardrail (dollar ceiling)

- Wired Paperclip's native budget hard-stop: a company-wide monthly ceiling
  (`COMPANY_BUDGET_CENTS`, default $100) is set idempotently on agent creation and
  auto-pauses on overspend. Optional per-agent cap (`AGENT_BUDGET_CENTS`).
  `/orchestration/budget` surfaces cap + spend for the dashboard.
