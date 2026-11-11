# Changelog

All notable changes to Suburban Cyber Agent OS. Dates are UTC.

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
