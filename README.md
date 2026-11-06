# Suburban Cyber Agent OS

A branded, self-hosted **agent operating system** for Suburban Cyber Technologies clients — a thin, maintainable layer on top of the open-source [Hermes Agent](https://github.com/NousResearch/hermes-agent) (MIT). It turns a bare Linux box into a running AI-agent platform with a single command: isolated agent runtime, a branded dashboard, a simplified chat, and optional long-term memory.

> **What this is:** an installer + a dashboard theme + two dashboard plugins. It does **not** fork Hermes. Hermes and [Honcho](https://github.com/plastic-labs/honcho) are pulled from upstream and run unmodified; everything Suburban Cyber adds lives in `plugins/` and `templates/`. That keeps upstream updates cheap and the custom surface small.

---

## Quick start

On a fresh Linux server (Ubuntu/Debian recommended), as a user with sudo:

```bash
curl -fsSL https://raw.githubusercontent.com/ajr1303/sct-agent-os/main/get.sh | sudo bash
```

That one command:

1. Installs `git` and Docker if they're missing (Docker's official convenience script).
2. Clones this repo to `/opt/sct-agent-os`.
3. Runs `install.sh`, which checks the machine, asks a few questions, writes config, pulls the Hermes image, builds Honcho (if memory is enabled), starts everything, installs the theme + plugins, and enables them.

**Options** (append after `bash`):

```bash
curl -fsSL .../get.sh | sudo bash -s -- --memory basic   # skip Honcho long-term memory
curl -fsSL .../get.sh | sudo bash -s -- --memory honcho  # force Honcho on
curl -fsSL .../get.sh | sudo bash -s -- --yes            # accept defaults, non-interactive
```

Re-running the command updates the checkout in place. For routine updates, prefer `sudo ./scripts/update.sh` (see [Updating](#updating)).

---

## What you get

| Area | Detail |
|---|---|
| **Agent runtime** | One isolated Hermes instance in Docker. API server on `127.0.0.1:8642`, dashboard on `9119`. |
| **Branding** | Suburban Cyber logo in the sidebar, "Suburban Cyber" wordmark, dark-cyan theme, renamed nav (Overview, Scheduled Jobs, Agents). |
| **Overview page** | Landing page with live gateway status, sessions, token usage, AI spend, your agents, recent activity, and a managed-service card. |
| **Chat** | The raw Hermes terminal is replaced by a clean, bubble-style chatbot. |
| **Mailboxes** | Connect multiple email accounts (Gmail, Microsoft 365, any hosted-domain IMAP) and see combined unread/preview in the dashboard. Credentials encrypted at rest. |
| **Bookings** | Connect a scheduling app (Cal.com, Calendly, Acuity, Setmore, or a Google/Microsoft iCal link) and see combined upcoming appointments. Credentials encrypted at rest. |
| **Automations** | A bundled, self-hosted **n8n** engine (`automation` profile). The dashboard shows workflow + run status and opens the n8n builder in one click; local workflows run off the token meter. |
| **Orchestration** | A bundled, headless **Paperclip** control plane (`control-plane` profile). The dashboard surfaces Paperclip-managed agents and "waiting on you" items. Read-only today; one-flow create/manage next. |
| **Memory (optional)** | Honcho long-term memory (Postgres + pgvector + deriver), wired into Hermes. |
| **Operations** | Watchdog cron (every 5 min), nightly database backup (03:30, 14-day retention), a smoke test, and an in-place updater. |

---

## Requirements

Base OS: Linux (x86_64), Ubuntu 22.04+ / Debian 12+ recommended. Outbound HTTPS to Docker Hub, GitHub, and your LLM provider. The stack scales with the **compose profiles** you enable, so size the box to the tier:

| Tier | Profiles | RAM | Disk | What's included |
|---|---|---|---|---|
| **Lean** | *(none)* | 4 GB | 20 GB | Hermes + dashboard + connectors (email, bookings) |
| **+ Memory** | `memory` | 8 GB | 30 GB | adds Honcho long-term memory |
| **+ Automation** | `automation` | +1 GB | +5 GB | adds the bundled n8n engine |
| **+ Control plane** | `control-plane` | +2–3 GB | +5 GB (plus a heavier first build) | adds the bundled Paperclip orchestrator |
| **Full (hosted client)** | all | 16 GB | 60 GB | everything |

Thresholds are enforced by the installer's preflight check. Numbers are conservative estimates, not yet load-benchmarked. The `control-plane` profile builds Paperclip from source on first start — budget extra time and build RAM.

### Compose profiles

The stack is one `docker-compose.yml`; profiles decide what runs. They're stored in `COMPOSE_PROFILES` in `.env`:

- *(empty)* — **lean**: Hermes + dashboard/proxy + connectors.
- `memory` — Honcho long-term memory.
- `automation` — the bundled n8n engine.
- `control-plane` — the bundled Paperclip orchestrator (headless).

Combine them comma-separated (e.g. `COMPOSE_PROFILES=memory,automation,control-plane`), then `docker compose up -d`. Or set them at install time:

```bash
curl -fsSL .../get.sh | sudo bash -s -- --profiles "automation,control-plane" --yes
```

---

## Using the dashboard

Ports bind to `127.0.0.1` by default. The installer asks whether to also expose the dashboard on your LAN.

**Localhost / SSH tunnel (default):**

```bash
ssh -L 9119:127.0.0.1:9119 user@server
# then open http://localhost:9119
```

**LAN access:** choose "anyone on my network" during install (or set `DASHBOARD_BIND=0.0.0.0` in `.env` and `docker compose up -d`), then browse to `http://<server-ip>:9119`.

**Login:** the installer generates a random dashboard password (user `admin`) and prints it at the end; it's also stored in `/opt/sct-agent-os/.env` as `DASHBOARD_PASSWORD`. Change it there and restart to rotate.

> The dashboard is served over plain HTTP. On a LAN that's fine for internal use; for anything exposed beyond a trusted network, put it behind HTTPS (reverse proxy or Tailscale) first. This is on the roadmap.

---

## Adding LLM providers and agents

The installer configures one model/provider to start. To add more and assign them per agent, use the dashboard (all native Hermes features):

1. **Keys** tab → add your provider API keys (Anthropic, OpenAI, OpenRouter, …). These are written to `/opt/data/.env` inside the container.
2. **Models** tab → see the models those keys unlock.
3. **Agents** tab (Hermes "profiles") → create or edit an agent and pick its model/provider.

The Overview page's spend and token tiles populate from real usage once agents start running on a billed model.

---

## Connecting email

The **Mailboxes** page lets a user connect one or more email accounts:

- **Google / Gmail**, **Microsoft 365 / Outlook**, **Yahoo**, **iCloud** — pick the provider and the IMAP host/port are prefilled. Use an **app password** (not the normal account password) where the provider requires one.
- **Other (hosted domain)** — enter your own IMAP host (often `mail.yourdomain.com`).

Each account is verified by a live IMAP login before it's saved. Passwords are encrypted at rest with Fernet (key in `.env` as `CONNECTORS_KEY`) and are never displayed again or returned by the API. The dashboard shows combined unread counts and a short preview per mailbox.

Under the hood this is a small **connectors** service (`connectors/`) behind the reverse proxy at `/api/connectors/`. It authorizes every request by validating the dashboard session cookie against Hermes, so there's no second login. The same service is the foundation for the upcoming bookings and Paperclip connectors.

> **Scope note:** this first release uses IMAP, which works for Google, Microsoft 365, and hosted domains today. Native one-click OAuth sign-in (and outbound send/triage actions for agents) are the next additions.

## Connecting your booking app

The **Bookings** page connects a scheduling tool so agents can see what's on the calendar:

- **Cal.com** — API key (Settings › Developer › API keys).
- **Calendly** — personal access token (Integrations › API & Webhooks).
- **Acuity Scheduling** — User ID + API key (Integrations › API).
- **Setmore** — a Refresh Token (Settings › Integrations › API); the service exchanges it for a short-lived access token automatically.
- **Google / Microsoft / other** — paste the calendar's **secret iCal (ICS) URL** (Google Calendar › Settings › *Secret address in iCal format*; Outlook › *Publish calendar*). This is the no-OAuth path and covers any calendar that can publish an ICS feed.

Each account is verified with a live API call before it's saved, credentials are Fernet-encrypted at rest, and the dashboard shows combined upcoming appointments. This runs on the same **connectors** service as email (`/api/connectors/bookings/...`).

> **Scope note:** this reads upcoming appointments across providers. Native OAuth sign-in for Google/Microsoft, and booking/reschedule actions for agents, are later additions.

## Automations (bundled n8n)

Agent OS ships its **own fresh [n8n](https://n8n.io) instance** (the `automation` compose profile, on by default). It is never a migration of an existing instance — it starts empty on a dedicated volume with its own encryption key.

- **Builder:** n8n runs on port `5678` (bound to the same address as the dashboard). The **Automations** page opens it in one click.
- **At a glance:** once you create an n8n API key (n8n › Settings › n8n API) and paste it into the Automations page, the dashboard shows your workflows (active/inactive), recent run status, and counts — read through n8n's public API via the connectors service, so the key stays server-side.
- **Why local automations:** scheduled jobs, data moves, and glue work run on your server instead of going through the model on every step — that's the token-saving layer.

To run without n8n, remove `automation` from `COMPOSE_PROFILES` in `.env` and `docker compose up -d`.

> First run: open the builder once to create your owner account and the API key. Auto-provisioning that key (so the engine is zero-touch) is a planned enhancement. Native TLS/subdomain + single sign-on for n8n land with the HTTPS roadmap item.

## Orchestration (bundled Paperclip)

With the `control-plane` profile, Agent OS bundles its **own fresh [Paperclip](https://github.com/paperclipai/paperclip)** instance — the agent-orchestration layer (org chart, task/issue assignment, schedules, budgets, approvals, audit ledger). It is **not** a migration of any existing instance.

The model is **one cockpit, two engines**:

- **Hermes** is the engine room — where an agent actually runs (model, tools, chat, sessions).
- **Paperclip** is the management office — it drives agents, it doesn't run them. It ships a Hermes adapter for exactly this.
- **The Agent OS dashboard is the only cockpit.** Paperclip runs **headless** (`local_trusted` mode, reachable only on the compose network, never exposed), so there's no second login and no separate UI to learn.

The **Orchestration** page surfaces Paperclip's managed agents and "waiting on you" items. This first release is **read-only**; the unified "create an agent → wire Hermes runtime + Paperclip record in one flow" is the next phase.

**Connect-to-existing (optional):** a lab already running Paperclip can point the bridge at it instead of the bundled one — set `PAPERCLIP_URL` (and `PAPERCLIP_API_KEY`, `PAPERCLIP_COMPANY_ID`) in `.env`. That path is **observe-only by design**: the bridge is GET-only, so Agent OS reads status but never approves, acts, or changes anything on an instance it doesn't own.

> Paperclip builds from source (a Node monorepo) on first start, so the initial `control-plane` build is heavy. Native TLS/SSO and the full create/manage write flow land in later phases.

## Hosting clients

The long-term model is **managed hosting**: Suburban Cyber spins up the full stack per client on an individual VPS. Each client gets their own box and their own isolated stack — nothing is shared.

A per-client provision is a non-interactive install with the tier and LAN exposure chosen up front:

```bash
curl -fsSL https://raw.githubusercontent.com/ajr1303/sct-agent-os/main/get.sh \
  | sudo bash -s -- --profiles "memory,automation,control-plane" --memory honcho --yes
```

The installer generates all per-client secrets (dashboard password, API/encryption keys, Paperclip secrets), prints the dashboard login, and brings the stack up. Point DNS/TLS at the proxy per the HTTPS roadmap item, and you have a client instance.

## Memory (Honcho)

With `--memory honcho` (the default when RAM ≥ 8 GB), the stack adds:

- `honcho-db` — Postgres 16 + pgvector.
- `honcho-api` — Honcho API, built from a pinned upstream commit.
- `honcho-deriver` — the background worker that derives long-term memory.

Honcho is configured to use **your** LLM provider for all nine of its model slots (deriver, summary, both dream stages, and five dialectic levels) plus embeddings — see `install.sh` / `templates/honcho.json.tmpl`. A cost preset (economy / balanced / deep) tunes how often and how deeply memory is derived.

Honcho is built unmodified from upstream source at a pinned commit; its AGPL-3.0 license applies to Honcho itself, not to this installer or your agent configuration.

---

## Updating

```bash
cd /opt/sct-agent-os && sudo ./scripts/update.sh
```

Pulls the latest repo, re-syncs the theme and plugins with correct permissions, restarts Hermes, and re-enables the plugins. Then hard-refresh the dashboard (Ctrl+Shift+R).

> Note: `update.sh` pulls a new copy of itself; if the update script *itself* changed, run it a second time so the new logic takes effect.

---

## Repository layout

```
get.sh                      One-line bootstrap (installs Docker/git, clones, runs install.sh)
install.sh                  Interactive installer (preflight, config, first run, cron, smoke test)
docker-compose.yml          Hermes + optional Honcho (db/api/deriver) under a "memory" profile
scripts/
  sync-branding.sh          Copies themes + plugins into the Hermes data dir with correct perms
  update.sh                 In-place update + restart
  watchdog.sh               Restarts stopped/unhealthy containers (cron, every 5 min)
  backup.sh                 Nightly pg_dump of Honcho (cron, 03:30, 14-day retention)
  smoke-test.sh             Post-install health checks
templates/
  dashboard-themes/         suburban-cyber.yaml (dark) + suburban-cyber-light.yaml
  honcho.json.tmpl          Hermes↔Honcho wiring
  honcho-init.sql           pgvector extension
connectors/
  app.py                    Connectors service (FastAPI): mailboxes + IMAP, encrypted storage, Hermes-cookie auth
  Dockerfile, requirements.txt
plugins/
  suburban-cyber/           Overview page, branding, logo, nav rename (dashboard plugin)
  suburban-chat/            Bubble chat that replaces the terminal (dashboard plugin)
  suburban-mail/            Mailboxes page: connect email accounts, combined inbox (dashboard plugin)
  suburban-bookings/        Bookings page: connect a scheduling app, upcoming appointments (dashboard plugin)
  suburban-automations/     Automations page: embedded n8n status, workflows, one-click open (dashboard plugin)
  suburban-orchestration/   Orchestration page: Paperclip-managed agents + attention, read-only (dashboard plugin)
docs/ARCHITECTURE.md        How the layer works, incl. the chat integration
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how the plugins hook into the Hermes dashboard and how the bubble chat talks to the gateway.

---

## Status

**v0.3 — working, validated by in-place updates on a test VM.** Verified live: install/start, theme, branding/logo, nav renames, Overview with real data, and the bubble chat (send + render round-trip) on Hermes v0.22.7.

Not yet done / known limitations:

- A **from-scratch one-command install** has not been run end-to-end yet (iterated via in-place updates); that's the next validation.
- The Overview **"Waiting on you" approvals** panel is **sample data**, clearly tagged — Hermes has no dashboard approvals API, so a real approval queue would be a separate build.
- "Time saved" / review-schedule lines in the managed card are illustrative until wired to real sources.
- A reverse proxy now serves the dashboard and brands the login page; HTTPS termination on that proxy is the next step.
- The **Mailboxes** email connector (IMAP, multi-account) and **Bookings** connector (Cal.com / Calendly / Acuity / Setmore / iCal) are verified live. OAuth sign-in and agent send/triage/booking actions are not built yet.
- The bundled **n8n** automation engine runs on its own port with its own login (TLS/subdomain + SSO pending the HTTPS work); the API key that powers the dashboard view is pasted once (auto-provisioning planned).
- The bundled **Paperclip** control plane (`control-plane` profile) is new: it builds from source, runs headless, and the Orchestration page is read-only for now. The unified create/manage-agent write flow is the next phase.
- **Compose profiles** (lean / memory / automation / control-plane) and a scriptable per-client install (`--profiles`) are in place; requirement tiers are estimates, not yet load-benchmarked.

## Roadmap

- First-run setup wizard in the dashboard.
- Remote access with HTTPS (reverse proxy / Tailscale) and cloud-init for hosted clients.
- Multi-conversation history in the chat.
- Real approval queue + per-client managed-service config.
- Uninstall path and an installable ISO.

---

## Licenses

| Component | License | Notes |
|---|---|---|
| Suburban Cyber installer, scripts, plugins, themes | MIT | This repository |
| Hermes Agent | MIT | Pulled as an upstream Docker image, unmodified |
| Honcho | AGPL-3.0 | Built from upstream source at a pinned commit, unmodified |

© 2026 Suburban Cyber Technologies LLC.
