# Architecture

Suburban Cyber Agent OS is a **layer**, not a fork. Three upstream pieces run unmodified:

- **Hermes Agent** (Docker image `nousresearch/hermes-agent`) — the agent runtime, gateway, and dashboard.
- **Honcho** (built from a pinned upstream commit) — optional long-term memory.
- **Postgres + pgvector** — Honcho's store.

Everything Suburban Cyber adds is data dropped into the Hermes data directory (`/opt/data`, mounted as `./data/hermes`): a dashboard **theme**, and two dashboard **plugins**. Nothing patches Hermes' own code, so upstream updates are a tag bump in `docker-compose.yml`.

```
          ┌─────────────────────────── Docker ───────────────────────────┐
  :9119   │  Hermes dashboard  ◄── theme (yaml) + plugins (js/css)        │
  :8642   │  Hermes gateway/API                                          │
          │  /opt/data  ◄── data/hermes  (themes, plugins, config, .env) │
          │                                                              │
          │  honcho-api ─ honcho-deriver ─ honcho-db   (memory profile)  │
          └──────────────────────────────────────────────────────────────┘
```

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
- **Nav**: clones a native sidebar link to inject an **Overview** item (pointing at `/`), and relabels **Cron → Scheduled Jobs** and **Profiles → Agents** in the sidebar and page headers.

## `suburban-chat` plugin

Replaces the built-in terminal chat (`override: "/chat"`) with a bubble UI. The key finding: **Hermes has no chat-send API**. The terminal is a real PTY — the browser speaks to `ws://<host>/api/pty?ticket=<t>`, sending keystrokes up and receiving terminal bytes down. So the plugin:

1. Gets a ticket with `SDK.buildWsAuthParam()` → `["ticket", <token>]` and opens `ws://host/api/pty?ticket=…`.
2. Snapshots existing session ids, so the session the PTY creates can be identified as the "new" one (session ids are timestamped; the terminal banner's short id does not match the store id).
3. **Sends** a message by writing `"<text>\r"` to the PTY socket.
4. **Renders** the conversation as bubbles by polling `api.getSessionMessages(sessionId)` (each message has `role`, `content`, `timestamp`) — i.e. the transcript comes from the reliable REST store, not from parsing terminal bytes.

This cleanly separates input (PTY) from display (message API). Replies appear once the agent's model actually responds; a provider with exhausted credits returns a billing notice as the assistant message.

## Operations

- `watchdog.sh` (cron, */5) restarts stopped/unhealthy `agent-os` containers and writes `data/health.json`.
- `backup.sh` (cron, 03:30) runs `pg_dump` of Honcho into `backups/`, pruning past 14 days.
- `smoke-test.sh` checks the dashboard (`:9119`), the gateway health (`:8642/health`), Honcho health, and that the theme is installed.
