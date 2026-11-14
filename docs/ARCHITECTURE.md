# Architecture

Suburban Cyber Agent OS is a **layer**, not a fork. The upstream pieces run unmodified:

- **Hermes Agent** (`nousresearch/hermes-agent`, pinned by digest) — the agent runtime, gateway, and dashboard (the cockpit).
- **Paperclip** (prebuilt from a pinned commit, `control-plane` profile) — agent orchestration.
- **n8n** (pinned by digest, `automation` profile) — bundled workflow automation.
- **Honcho** + **Postgres/pgvector** (prebuilt from a pinned commit, `memory` profile) — long-term memory.

Suburban Cyber adds: a dashboard **theme** and **seven dashboard plugins** dropped into the Hermes data dir (`/opt/data` ← `./data/hermes`); an nginx **proxy** that fronts the dashboard and injects branding, the links config and the sidebar script; a set of **chat tools** (an MCP endpoint in connectors) plus a routing **skill**; a **connectors** service (FastAPI, Fernet-encrypted SQLite) that bridges email/bookings/n8n/Paperclip; a **gateway-tls** terminator so Paperclip reaches the Hermes runs API over HTTPS (with a per-task run fast-stop via nginx `auth_request`); and an optional **cloudflared** tunnel. Nothing patches Hermes' own code.

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
- **Company selection:** first company Paperclip lists, or `PAPERCLIP_COMPANY_ID`.

## Supply chain

- Hermes and n8n: official images pinned by digest in `docker-compose.yml`.
- Paperclip and Honcho: `.github/workflows/images.yml` builds each from its pinned
  commit, unmodified, and pushes to `ghcr.io/<owner>/agent-os-*`. Compose keeps the
  `build:` context as a fallback. CI checks the workflow's refs match compose.
- `scripts/show-versions.sh` prints the digests a tested box is running.

## Operations

- `watchdog.sh` (cron, */5) restarts stopped/unhealthy `agent-os` containers and writes `data/health.json`.
- `backup.sh` (cron, 03:30) runs `pg_dump` of Honcho into `backups/`, pruning past 14 days.
- `smoke-test.sh` checks the dashboard (`:9119`), the gateway health (`:8642/health`), Honcho, connectors, n8n and Paperclip health, and that the theme is installed.
- Operator scripts: `set-hostnames.sh`, `paperclip-connect.sh`, `paperclip-reset-password.sh`, `install-memory-plugin.sh`, `show-versions.sh` (see the runbook).
