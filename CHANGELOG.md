# Changelog

All notable changes to Suburban Cyber Agent OS. Dates are UTC.

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
- Path IDs sent to Paperclip are validated (F-17) on the new endpoints.

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

## [0.10.0] — 2026-11-11 — Access methods (F-04/F-05 groundwork)

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
