# Architecture

Suburban Cyber Agent OS is a **layer**, not a fork. The upstream pieces run unmodified:

- **Hermes Agent** (`nousresearch/hermes-agent`, pinned by digest) — the agent runtime, gateway, and dashboard (the cockpit).
- **Paperclip** (prebuilt from a pinned commit, `control-plane` profile) — agent orchestration.
- **n8n** (pinned by digest, `automation` profile) — bundled workflow automation.
- **Honcho** + **Postgres/pgvector** (prebuilt from a pinned commit, `memory` profile) — long-term memory.

Suburban Cyber adds: a dashboard **theme** and **twelve dashboard plugins** dropped into the Hermes data dir (`/opt/data` ← `./data/hermes`); an nginx **proxy** that fronts the dashboard and injects branding, the links config and the sidebar script; a set of **chat tools** (an MCP endpoint in connectors) plus a routing **skill**; a **connectors** service (FastAPI, Fernet-encrypted SQLite) that bridges email/bookings/n8n/Paperclip; a **gateway-tls** terminator so Paperclip reaches the Hermes runs API over HTTPS (with a per-task run fast-stop via nginx `auth_request`); and an optional **cloudflared** tunnel. Nothing patches Hermes' own code.

```
                         Internet (LLM, GitHub, Docker Hub, Cloudflare)
                                           ▲ outbound only
  ┌──────────────────────────────── Docker (agent-os) ───────────────────────────────┐
  │                                                                                   │
  │  cloudflared ──┐  (tunnel profile; dials OUT, no inbound ports)                   │
  │                ▼                                                                   │
  │   :9119  proxy (nginx) ──► hermes dashboard  ◄── theme + 7 plugins                │
  │             │           └► connectors (/api/connectors/*) ──► n8n / paperclip     │
  │   hermes ──MCP (bearer, internal only)──► connectors /mcp  (chat tools)           │
  │             │                                                                     │
  │   paperclip ──HTTPS──► gateway-tls :8443 ──► hermes runs API :8642                │
  │     (control-plane)        (auth_request run fast-stop → connectors)              │
  │   n8n (automation)                                                                │
  │   honcho-api ─ honcho-deriver ─ honcho-db   (memory profile)                      │
  │                                                                                   │
  │   /opt/data ◄── data/hermes (themes, plugins, brand/links.js, config, .env)       │
  └───────────────────────────────────────────────────────────────────────────────────┘
```

**Binds:** only the proxy (`:9119`) follows `DASHBOARD_BIND`. n8n (`:5678`) and
Paperclip (`:3100`) always bind loopback (`INTERNAL_BIND`) and are reached through
the dashboard, the tunnel, or an SSH tunnel. The Hermes runs API (`:8642`) is
loopback-only. See [RUNBOOK.md](RUNBOOK.md) for access setup.

## Dashboard extension points (as used here)

The Hermes dashboard scans `~/.hermes/plugins/<name>/dashboard/manifest.json` (here `/opt/data/plugins/...`). Plugins are **opt-in**: a plugin must also be enabled with `hermes plugins enable <name>`, which is why each plugin ships a `plugin.yaml` and the installer runs the enable step. Discovery can be refreshed at runtime via `GET /api/dashboard/plugins/rescan`.

A plugin's `dist/index.js` is a plain IIFE (no bundler). It reads two globals the dashboard injects:

- `window.__HERMES_PLUGIN_SDK__` — `React`, `hooks`, `components`, `api` (the typed dashboard REST client), `utils`, `buildWsAuthParam`, etc.
- `window.__HERMES_PLUGINS__` — `register(name, Component)` and `registerSlot(slot, name, Component)`.

`manifest.json` fields used:

- `tab.override: "/"` or `"/chat"` — replace a built-in route with the plugin's component. (Nav-tab *injection* via `tab.position` does not render in Hermes v0.22.7, so the Overview nav item is inserted into the sidebar from JS instead.)
- `entry` / `css` — the bundle and stylesheet, served next to each other, so the theme logo is referenced from CSS with a relative `url()`.

### Theme

`templates/dashboard-themes/suburban-cyber.yaml` sets palette, typography (IBM Plex + Chakra Petch), 2px radius, and `colorOverrides` (cyan `#25c9ee` primary/accent/ring). It's copied to `/opt/data/dashboard-themes/` and selected with `hermes config set dashboard.theme suburban-cyber`. **Permissions matter:** the container runs as a non-root user, so the installer `chmod`s the theme/plugin files world-readable (the installer's `umask 077` would otherwise hide them).

## `suburban-cyber` plugin

- **Overview page** (`override: "/"`): live data from `api.getStatus()` (gateway/version/active sessions/agents), `api.getAnalytics(days)` (sessions, tokens, `total_estimated_cost`), and `api.getProfiles()` (the agent list). The approvals panel is sample data — no approvals API exists.
- **Branding**: a `MutationObserver` swaps the "HERMES AGENT" sidebar wordmark for the Suburban Cyber logo (a CSS background on an injected element) and sets the tab title.
- **Nav**: clones a native sidebar link to inject an **Overview** item (Hermes has no tab for `/`), and relabels **Cron → Scheduled Jobs** and **Profiles → Agents**. Ordering and grouping are done by `brand/nav.js` (below), not by plugins.

## `suburban-chat` plugin

Replaces the built-in terminal chat (`override: "/chat"`) with a bubble UI. The key finding: **Hermes has no chat-send API**. The terminal is a real PTY — the browser speaks to `ws://<host>/api/pty?ticket=<t>`, sending keystrokes up and receiving terminal bytes down. So the plugin:

1. Gets a ticket with `SDK.buildWsAuthParam()` → `["ticket", <token>]` and opens `ws://host/api/pty?ticket=…`.
2. Snapshots existing session ids, so the session the PTY creates can be identified as the "new" one (session ids are timestamped; the terminal banner's short id does not match the store id).
3. **Sends** a message by writing `"<text>\r"` to the PTY socket.
4. **Renders** the conversation as bubbles by polling `api.getSessionMessages(sessionId)` (each message has `role`, `content`, `timestamp`) — i.e. the transcript comes from the reliable REST store, not from parsing terminal bytes.

This cleanly separates input (PTY) from display (message API). Replies appear once the agent's model actually responds; a provider with exhausted credits returns a billing notice as the assistant message.

## Sidebar (`brand/nav.js`)

Hermes renders built-in tabs and plugin tabs as two separate lists. `nav.js`, loaded
on every page by the proxy, is the only thing that arranges the sidebar. It never
moves or clones Hermes' own links (so navigation stays in-app and the active
highlight works): it flattens the wrappers with `display: contents`, sets CSS `order`
on each item, hides duplicates and stock list titles, and adds three group headers.
"Advanced" is collapsible and remembered in `localStorage`. `sct.css` hides the stock
list until it is arranged and reveals it after 2.5 s regardless, so a script failure
degrades to the stock sidebar.

## Chat tools (MCP) and routing

`connectors` serves a stateless MCP endpoint (`POST /mcp`, JSON-RPC, bearer token
`CHAT_TOOLS_TOKEN`). `scripts/sync-chat-tools.sh` writes it into the Hermes config as
the `agent_os` server (`connectors/mcp_config.py`) and installs the
`running-the-business` skill. The proxy returns 404 for `/api/connectors/mcp`, so it
is reachable only inside the Docker network.

Agents invited from other machines cannot reach that endpoint. They get the task tools
only (`split_task`, `complete_task`, `hand_off_task`, `need_owner_input`,
`read_task`, `wait_for_tasks`, `save_file`, `list_agents`) at `/api/agent-os/` on the team board's public address. The proxy
routes that prefix to `connectors` (`/agent-tools/*`), which checks the caller's own
Paperclip API key against Paperclip (`GET /api/agents/me`) and acts only as that agent.

| Tool | Purpose |
|---|---|
| `list_agents`, `assign_task`, `list_tasks`, `task_status` | Delegation through Paperclip issues |
| `request_hiring_review` | Task for the CEO agent to propose (never create) a new agent |
| `complete_task`, `need_owner_input` | An agent closes or parks its own task (caller's Agent ID must match the assignee) |
| `get_business_profile` | Name and description of the business |
| `list_workflows`, `get_workflow`, `workflow_failures`, `failed_run_detail` | Read n8n |
| `create_workflow`, `update_workflow` | Build workflows; always inactive, live ones are not editable |
| `request_activation` | File an approval request; only the owner's click in Automations activates |

Guardrails are enforced in connectors, not in prompts: no activate tool exists,
task creation is rate-limited, and against an external Paperclip the delegation
tools refuse. The routing ladder is repeated in the tool descriptions because the
skill is not always loaded.

**Run path for delegated tasks:** Paperclip → `gateway-tls` (nginx, `auth_request`
to connectors `/gateway/authorize`, which meters `POST /v1/runs` per session key and
denies after `RUN_MAX_ATTEMPTS`) → Hermes runs API on the **default profile**.

## Orchestration and Tasks plugins

- **Team chart** (`suburban-orchestration`): `/orchestration/overview` returns each
  agent's `title`, `status` and `reports_to`; the plugin builds the tree client-side
  and re-reads it every 30 seconds. Managers with more than four leaf reports wrap
  them in rows. Read-only.
- **Task actions** (`suburban-tasks`): `POST /orchestration/tasks/{key}/reply` posts an
  owner comment to Paperclip (`reopen` for finished tasks; Paperclip wakes the
  assignee) and `POST /orchestration/tasks/{key}/status` accepts `done`, `todo` or
  `cancelled`. Both require the dashboard session, validate the key, and are refused
  in external (read-only) mode.
- **Agents page** (`suburban-agents`, tab `/team`): `GET /orchestration/team` lists every
  non-terminated agent; `GET`/`PUT /orchestration/team/{id}` read and save name, title,
  role, `reportsTo`, `capabilities` and instructions. Instructions are the agent's entry
  instruction file when it has one (saved with the hash that was loaded, so a stale
  edit is refused), otherwise the inline `adapterConfig.instructions` our own agents
  use. Local agents (gateway on this box) cannot be renamed. Refused in external mode.
- **Agent models:** `scripts/agent-models.sh` copies `scripts/lib/agent-models.mjs` into the
  Paperclip container and runs it there. For each `hermes_gateway` agent it resolves the
  gateway key (inline, or a `local_encrypted` secret decrypted with the instance key and
  checked against its stored hash), calls `GET <gateway>/api/model/options`, and prints
  one JSON line. The output is piped into `store_agent_models.py` in the connectors
  container (table `agent_models`). Keys never leave the Paperclip container and are
  not sent to non-HTTPS remote addresses. Run by `update.sh` and every 30 minutes by cron.
- **Model change:** `scripts/agent-ssh.sh` keeps an SSH key and `hosts.json` (gateway host ->
  ssh target, service, scope) in `data/agent-ssh/`, mounted read-only at `/agent-ssh` in
  connectors. `POST /orchestration/team/{id}/model` validates the choice against what the
  machine reported, then runs a fixed remote script over SSH in a background thread
  (`hermes config set model.default|model.provider`, restart, verify via the gateway's
  `/api/model/options`, restore `config.yaml.bak-agent-os` on failure). The page polls
  `GET .../model` for the job state. Host keys are pinned at `add` time.
- **Plan usage** (`suburban-usage`, tab `/usage`): `GET /usage` calls each configured
  provider's quota endpoint with a Fernet-encrypted key from table `usage_providers`
  (60-second cache) and adds Paperclip's 14-day run count. MiniMax: `GET
  https://api.minimax.io/v1/token_plan/remains`, using `current_interval_remaining_percent`,
  `current_weekly_remaining_percent`, `remains_time` and `weekly_remains_time`.
  `PUT /usage/{provider}` validates a key against the provider before storing it.
- **Company selection:** first company Paperclip lists, or `PAPERCLIP_COMPANY_ID`.

## Supply chain

- Hermes and n8n: official images pinned by digest in `docker-compose.yml`.
- Paperclip and Honcho: `.github/workflows/images.yml` builds each from its pinned
  commit, unmodified, and pushes to `ghcr.io/<owner>/agent-os-*`. Compose keeps the
  `build:` context as a fallback. CI checks the workflow's refs match compose.
- `scripts/show-versions.sh` prints the digests a tested box is running.

## Operations

- `watchdog.sh` (cron, */5) restarts stopped/unhealthy `agent-os` containers and writes `data/health.json`.
- `backup.sh` (cron, 03:30; and every 5 minutes with `--if-requested` for the dashboard's
  "Back up now") collects every component into `backups/.stage`: Honcho `pg_dump`, a
  Paperclip database dump plus its instance files (keys, uploads, instructions), n8n
  workflow and credential exports, the connectors SQLite database, the Hermes home
  (no logs or caches) and settings (`.env`, certificates, agent SSH access). It then
  calls `connectors/backup_tool.py finish` inside the connectors container, which
  writes a manifest with a SHA-256 per part, packs one `tar.gz`, encrypts it with
  `age` to every recipient, uploads it with `rclone`, prunes old copies and writes
  `backups/status.json`. `age` and `rclone` ship in the connectors image.
- Backup encryption has up to two recipients: the owner's recovery kit (generated on
  the box, downloaded once, then deleted from it) and an optional operator public key
  (`OPERATOR_BACKUP_PUBKEY` or the Backups page). Either private key opens an archive;
  the box keeps public keys only. Unencrypted archives are never uploaded.
- Backups page (`suburban-backups`, tab `/backups`): `GET /backups` and the setup
  endpoints under it. Settings live in `data/backup/` (`settings.json`, `rclone.conf`).
- `restore.sh <file> [key]` decrypts, verifies every part against the manifest and
  changes nothing; `--apply` restores onto an installed box.
- `smoke-test.sh` checks the dashboard (`:9119`), the gateway health (`:8642/health`), Honcho, connectors, n8n and Paperclip health, and that the theme is installed.
- Operator scripts: `set-hostnames.sh`, `paperclip-connect.sh`, `paperclip-reset-password.sh`, `install-memory-plugin.sh`, `show-versions.sh` (see the runbook).

## Stuck-agent watch

- Logic: `stuck_watch_run()` in `connectors/app.py`. It reads agents, live runs and
  in-progress/queued tasks from Paperclip, and keeps what it has already tried in the
  `stuck_watch` table (two pushes per agent or task, then escalate).
- Schedule: an n8n workflow (*Agent OS: stuck-agent watch*) created by
  `POST /automations/stuck-watch/on`. Every ten minutes it posts to
  `http://connectors:8000/internal/stuck-watch/run` with a token stored in the
  workflow. `/api/connectors/internal/` is blocked at the public proxy.
- Actions: `POST /api/agents/{id}/lifecycle/retry`; a board comment on the task (which
  wakes its agent); after two tries a comment plus status `blocked`, which the
  dashboard shows under "Needs you". Optional: restart the agent's gateway over the
  SSH access set up by `scripts/agent-ssh.sh`.
- The response carries `needs_attention` and `summary`, which the workflow's last
  step exposes for an alert node the owner adds.

## Overview tiles from connections

- **Appointments today:** `GET /bookings/week` returns the start time of every
  appointment in the next 7 days across connected calendars (cached 5 minutes); the
  browser counts the ones on the viewer's own calendar day.
- **Website visitors:** `GET /website` (plugin `suburban-website`, tab `/website`).
- **AI models:** plugin `suburban-models`, tab `/ai-models`. Browser-only: it calls Hermes's own model and key
  routes through the dashboard session. Hermes's `/models` page moves under Operator tools.
- **Plan:** plugin `suburban-plan`, tab `/plan`. `connectors` routes `/plan*` keep the business plan in
  table `business_plan` (every save is a new row; 60 kept). Agents read it with `get_business_plan`;
  only the lead (CEO role) can write it, with `update_business_plan`. Today's idea reads it.
- **Files:** plugin `suburban-files`, tab `/team-files`. Agents hand over documents with the `save_file` tool
  (text, or base64 up to 4 MB); `connectors` keeps them in `team_files` / `team_blobs` and serves them at
  `/files*`. Downloads are always attachments with a sandbox policy; only real image types preview inline.
- **Memory:** plugin `suburban-memory`, tab `/memory`. `connectors` routes `/memory*` read Honcho's dream
  history, conclusions and peer card for the owner (`data/hermes/honcho.json` names the workspace and peers).
- **Projects:** plugin `suburban-projects`, tab `/projects`. Tables `projects`,
  `project_files` (metadata + extracted text), `project_blobs` (the bytes),
  `project_tasks`. Routes `GET/POST /projects`, `GET/PATCH/DELETE /projects/{id}`,
  `POST /projects/{id}/files?name=` (raw body, 25 MB proxy limit on this route only),
  `POST /projects/{id}/notes`, `GET /projects/{id}/files/{fid}` (always an attachment)
  and `/text`. Text is extracted at upload (`pypdf` for PDF, zip/XML for Office
  files). Tools for both scopes: `list_projects`, `get_project`, `read_project_file`,
  `search_project`, `save_project_note`, `create_project`, `system_health`, `manage_task` (Chat only, while the owner is chatting) (all of these also reach agents off the box); `assign_task` takes an optional `project`.
- **Chat files and images:** `POST /chat/files?name=` (raw body), `GET /chat/files/{id}`
  (inline only for PNG/JPEG/GIF/WebP by magic bytes, otherwise an attachment; CSP
  sandbox, nosniff). Copies are written to `/chat-files` (host `data/hermes/chat-files`,
  `/opt/data/chat-files` inside Hermes). Image settings in kv `image_gen` (provider,
  model, Fernet-encrypted key): `GET/POST/DELETE /chat/images/settings`. Tools:
  `read_chat_file`, `generate_image` (OpenAI `/v1/images/generations` or MiniMax
  `/v1/image_generation`, hourly cap), `save_chat_file_to_project` (chat only). The
  chat renderer draws `![..](/api/connectors/chat/files/N)` as an image and nothing else.
- **Service gate:** nginx listens on 3100 and 5678 for the tunnel (network `edge`,
  where `paperclip` and `n8n` are aliases of the proxy) and asks `GET /gate/check`.
  Not let in: `/gate/begin` redirects a page load to
  `https://<dashboard>/api/connectors/gate/start`, which (dashboard session and
  two-step cookie required) returns a 60-second signed pass for that host;
  `/_aos/enter` on the service host swaps it for the `aos_gate` cookie (24 h, HMAC
  bound to the host). Passes are only issued for the configured public hosts or the
  dashboard's `-paperclip`/`-n8n` siblings.
  The connectors service signs a short-lived token request with the stored Google
  service-account key and calls the Google Analytics Data API `runReport` for the
  property: totals for the last 7 full days and the 7 before, top pages and channels.
  Cached 30 minutes. Token and API hosts are fixed in code; nothing in the pasted key
  can redirect a request.
- One key, several sites: `website_sites` lists the Analytics properties read through
  the stored key (`POST /website/sites`, `DELETE /website/sites/{id}`,
  `POST /website/sites/{id}/main`). `GET /website?site=<id>` returns one site's
  numbers; without `site` it returns the main site, which is what the Overview shows.
- Each tile is shown only when its connection exists, so the row adapts per business.

## Two-step sign-in

- TOTP (RFC 6238: SHA-1, 30 s, 6 digits) implemented in `connectors/app.py`; the
  secret is Fernet-encrypted in the `kv` table. Recovery codes are stored hashed.
- Enforcement is in the proxy, not the app: `templates/nginx.conf` includes
  `/etc/nginx/aos/mfa-gate-page*.inc` in `location /` and `mfa-gate-api*.inc` in
  `location /api/connectors/`. When present, those files add
  `auth_request /_mfa_check`, which calls `GET /mfa/check`; a 401 sends pages to
  `/sct-brand/mfa.html` and answers API calls with a 401. `/api/connectors/mfa/`
  and `/sct-brand/` stay reachable so the code page works.
- The connectors service writes `data/backup/mfa-state` (`on`/`off`, rewritten on
  every start from the database). `scripts/host-requests.sh` (cron, every minute)
  creates or removes the two include files in `data/proxy/`, checks the config with
  `nginx -t`, reloads the proxy, and records the result in `data/backup/mfa-applied`.
  A config that fails the check is rolled back.
- `POST /mfa/verify` sets an HMAC-signed, HttpOnly cookie (`aos_2step`), keyed per
  enrolment. With two-step on, the gate fails closed: if the connectors service is
  down the dashboard answers 500 until the watchdog restarts it.

## Update now

- The Overview banner posts `POST /system/update` (connectors), which only writes
  `data/backup/update-request`. `scripts/host-requests.sh` (cron, every minute) removes
  the request and starts `scripts/update-requested.sh` detached.
- That script holds a lock, writes `data/backup/update-state.json`
  (`running`, then `done` or `failed`, with from/to versions), and runs
  `scripts/update.sh` with a 90-minute limit; output goes to `data/backup/update.log`,
  which is never served.
- `GET /system/update` returns the request and state for the banner to poll. A
  `running` state with no live lock, or older than 100 minutes, is reported as failed.
- The request carries no parameters: the updater pulls only the repository and branch
  the install already tracks.

## Dashboard password

- The password is `DASHBOARD_PASSWORD` in the host's `.env`; Hermes reads it at start.
  The connectors service never sees it.
- Change: `POST /security/password {current, new}` writes `data/backup/password-request`
  (mode, random id, base64 current and new; mode 0600) and returns the id.
  `scripts/host-requests.sh` runs `scripts/dashboard-password.sh --from-request`, which
  deletes the request, compares `current` with `.env`, rewrites the line, recreates the
  `hermes` container, restarts the proxy and writes `password-result.json` with the id.
- The browser polls `GET /account/password-result?id=`; the id is the only credential
  (the session may not survive the restart). Only a hash of the id is stored.
- Reset code: 120 random bits, base32. Stored as a SHA-256 hash in `kv`
  (`password_state`). A new one is generated on every successful change, reset or
  current-password check, and handed over through the result call (kept encrypted for
  ten minutes so a reload can still show it).
- Forgot password: `brand/reset.html` (linked from the sign-in page by `brand/login.js`)
  calls `POST /account/reset {code, new}` with no session. There is no lock-out:
  the code is 120 random bits and a link token 256, so guessing is not a risk, and a
  lock-out would let a stranger block the owner's own reset. Wrong tries are slowed
  instead, and up to three unexpired emailed links stay valid until one is used. When two-step sign-in is on, the proxy gate applies
  to this call as to every other.
- Reset by email: `POST /security/password-email` (current password checked by the
  host as above) stores recipient, SMTP host, port, user and the encrypted SMTP
  password, plus the dashboard origin taken from that signed-in request. It is only
  kept if a test message sends. TLS is required (STARTTLS, or implicit on 465).
  `POST /account/reset-link` takes no input, mails a 256-bit token valid 30 minutes
  (hash stored), at most three an hour and one per two minutes. `POST /account/reset`
  accepts `token` in place of `code`. The link carries the token in the URL fragment,
  which the reset page removes from the address bar on load.

## Account and first run

- One dashboard sign-in. Name and password are `DASHBOARD_USER` / `DASHBOARD_PASSWORD`
  in `.env`, passed to Hermes as its basic-auth pair. The owner's display name and email
  are in connectors `kv` (`account`).
- `install.sh` leaves `data/backup/setup-needed`. `brand/nav.js` asks `GET /account/me`
  on load and sends the browser to `brand/welcome.html` while the flag exists. The flag
  is removed when a password or sign-in name change succeeds, or by
  `POST /account/setup-done` (skip). Updates never create the flag.
- A sign-in name change travels on the same host request as a password change (fifth
  line, base64) and is applied only in `change` mode after the current password check.
  `host-requests.sh` copies the current name to `data/backup/dashboard-user` for display.
- `nav.js` swaps the sign-in name shown at the foot of the sidebar for the display name
  and makes that block open `/security` (the Account tab). If Hermes changes that part
  of its page, the swap simply does not happen.

