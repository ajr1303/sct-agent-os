# Suburban Cyber Agent OS

A branded, self-hosted **agent operating system** from Suburban Cyber Technologies: a thin, maintainable layer on top of the open-source [Hermes Agent](https://github.com/NousResearch/hermes-agent) (MIT). It turns a bare Linux box into a running AI-agent platform with a single command: an isolated agent runtime, a branded dashboard, a chat assistant that delegates work to a team of agents, bundled automations, and long-term memory.

> **What this is:** an installer, a dashboard theme, seven dashboard plugins, a small connectors service, and the scripts to run it. It does **not** fork anything. [Hermes Agent](https://github.com/NousResearch/hermes-agent), [Paperclip](https://github.com/paperclipai/paperclip), [n8n](https://n8n.io) and [Honcho](https://github.com/plastic-labs/honcho) run unmodified at pinned versions; everything Suburban Cyber adds lives in `plugins/`, `connectors/`, `brand/`, `skills/`, `scripts/` and `templates/`. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

---

## Quick start

On a fresh Linux server (Ubuntu/Debian recommended), as a user with sudo:

```bash
curl -fsSL https://raw.githubusercontent.com/ajr1303/sct-agent-os/main/get.sh | sudo bash
```

That one command:

1. Installs `git` and Docker if they're missing (Docker's official convenience script).
2. Clones this repo to `/opt/sct-agent-os`.
3. Runs `install.sh`, which checks the machine, asks a few questions (including how you will reach the box), writes config with generated secrets, pulls the pinned images, starts everything, installs the theme, plugins, chat tools and memory plugin, and runs a smoke test.

By default this installs the **full stack** and requires a 16 GB+ box (see [Requirements](#requirements)).

**Options** (append after `bash`):

```bash
curl -fsSL .../get.sh | sudo bash -s -- --yes                       # accept defaults, non-interactive
curl -fsSL .../get.sh | sudo bash -s -- --profiles "automation"     # advanced: install a subset (dev boxes)
```

Re-running the command updates the checkout in place. For routine updates, prefer `sudo ./scripts/update.sh` (see [Updating](#updating)).

---

## What you get

| Area | Detail |
|---|---|
| **Agent runtime** | One isolated Hermes instance in Docker (pinned to a tested version). Dashboard on `9119`, agent API on `127.0.0.1:8642`. |
| **Dashboard** | Suburban Cyber branding, favicon and theme. A fixed, grouped sidebar: Overview, Chat · *Your team*: Tasks, Orchestration, Automations · *Connections*: Bookings, Mailboxes · *Advanced* (operator tabs, collapsed). |
| **Chat** | A clean bubble chat in place of the raw terminal. The chat agent acts as chief of staff: it answers quick questions, builds an automation for repeatable work, hands judgment work to the right agent, or asks the CEO agent for a hiring review. |
| **Orchestration** | Bundled **Paperclip** control plane. Create an agent from nine starter **templates** (or blank), pause/resume, edit, delete, or **invite** an external agent with a paste-ready prompt. A live **team chart** shows who reports to whom and each agent's status. An **About your business** profile is shared with every agent. |
| **Agents** | Every agent on the team in one list. Open one to edit its name, title, role, manager, description and instructions, or pause it. Hermes' own Profiles page moves to Advanced as *Hermes profiles*. |
| **Usage** | How much of your AI provider plan is used, what is left, when it resets, and whether it is on pace to run out first. MiniMax M Plan supported today. |
| **Tasks** | Tasks delegated to agents, their status, replies and files. **Reply, reopen, mark done or cancel** from the dashboard; a reply wakes the assigned agent. Agents close their own tasks; runaway tasks are halted automatically and can be released. |
| **Automations** | Bundled **n8n**. Workflow and run status, **turn workflows on and off** from the dashboard, one-click open, and **Waiting for your approval**: agents can build workflows but only the owner can switch one on. |
| **Mailboxes** | Connect email accounts (Gmail, Microsoft 365, any IMAP) and see a combined unread/preview. View-only today. Credentials encrypted at rest. |
| **Bookings** | Connect a scheduling app (Cal.com, Calendly, Acuity, Setmore, or an iCal link) and see upcoming appointments. View-only today. |
| **Memory** | Self-hosted Honcho long-term memory (Postgres + pgvector + deriver), wired into Hermes. |
| **Access** | Loopback by default; SSH tunnel, **Cloudflare Tunnel** (HTTPS, no open ports), or LAN. Per-person team sign-in via Cloudflare Access. |
| **Spend protection** | Per-task run fast-stop, a task-creation rate limit, and a provider-side monthly limit as the dollar ceiling. |
| **Operations** | Watchdog (every 5 min), nightly **full backup** (encrypted, copied to Google Drive / S3 / any rclone storage, with a tested restore check), smoke test, update check, in-place updater, and one-step scripts for hostnames, Paperclip connect and password reset. |

---

## Requirements

Agent OS installs the **full stack** — Hermes runtime, branded dashboard, connectors, Honcho memory, the n8n automation engine, and the Paperclip orchestrator — as one system. It isn't a pick-and-choose install; the installer sizes for the whole thing and **refuses to install on a box that can't run it**, rather than quietly degrading. One spec, with headroom to grow:

| | Minimum | Recommended |
|---|---|---|
| OS | Linux x86_64 | Ubuntu 22.04+ / Debian 12+ |
| RAM | **16 GB** | 32 GB |
| vCPU | 4 | 8 |
| Free disk | **60 GB** | 80 GB+ |
| Network | Outbound HTTPS to Docker Hub, GitHub (incl. ghcr.io), your LLM provider, and Cloudflare if tunnelled | |

The installer's preflight enforces this and stops early if the box is too small. Numbers are conservative estimates, not yet load-benchmarked.

> **Advanced / development:** `--profiles "..."` installs a subset instead of the full stack (and relaxes the RAM floor to 4 GB). This is an escape hatch for dev boxes, not the supported product shape — a client install is always the full stack.

### What's in the stack (compose profiles)

The stack is one `docker-compose.yml`; `COMPOSE_PROFILES` in `.env` records what runs (all of them, by default):

- `memory` — Honcho long-term memory.
- `automation` — the bundled n8n engine.
- `control-plane` — the bundled Paperclip orchestrator (headless).

Hermes + dashboard/proxy + connectors always run. A full install sets `COMPOSE_PROFILES=memory,automation,control-plane`; `docker compose up -d` applies changes. The advanced subset form at install time:

```bash
curl -fsSL .../get.sh | sudo bash -s -- --profiles "automation,control-plane" --yes
```

---

## Using the dashboard

Everything binds to `127.0.0.1` by default, and **n8n and Paperclip are *always* loopback-only** — they're never published on your network, regardless of how you reach the dashboard. The installer asks how you want to reach the box:

**1 — This machine / SSH tunnel (default, most secure).** Nothing is exposed; reach it over SSH:

```bash
ssh -L 9119:127.0.0.1:9119 user@server
# then open http://localhost:9119
```

**2 — Cloudflare Tunnel (public HTTPS URL, no open ports).** Recommended when you want a browser-reachable URL without touching the client's firewall. `cloudflared` dials *out* to Cloudflare (works behind any NAT), Cloudflare provides the TLS cert, and you map a hostname to the box in your own Zero Trust dashboard. Create a tunnel, paste its token during install, and point the public hostname at `http://proxy:9119`. Gate it with Cloudflare Access if it shouldn't be public. You use **your own** Cloudflare account — nothing routes through anyone else.

**3 — Direct LAN / public HTTP (not recommended).** Plain HTTP on your network (`DASHBOARD_BIND=0.0.0.0`). Only on a trusted LAN; prefer option 1 or 2 anywhere else.

To reach n8n or Paperclip directly, use the dashboard's links, an SSH tunnel (`-L 5678:127.0.0.1:5678`, `-L 3100:127.0.0.1:3100`), or give them their own tunnel hostnames (recommended behind a tunnel). One command sets every hostname setting and applies it:

```bash
sudo ./scripts/set-hostnames.sh agent-os.example.com
```

It derives `agent-os-paperclip.example.com` and `agent-os-n8n.example.com` (one-level names, so the free Cloudflare certificate covers them), writes the settings to `.env`, prints the three tunnel routes to create, and runs the updater. Details in [docs/RUNBOOK.md](docs/RUNBOOK.md) §3.

**Login:** the installer generates a random dashboard password (user `admin`) and prints it at the end; it's also stored in `/opt/sct-agent-os/.env` as `DASHBOARD_PASSWORD`. Change it there and restart to rotate.

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

Agent OS ships its **own fresh [n8n](https://n8n.io) instance** (the `automation` compose profile, on by default), pinned to a tested version, on a dedicated volume with its own encryption key.

- **Builder:** the **Automations** page opens n8n in one click (via the tunnel hostname when configured).
- **At a glance:** create an n8n API key (n8n › Settings › n8n API) and paste it into the Automations page; the dashboard then shows workflows, recent runs and counts through the connectors service, so the key stays server-side.
- **Built from chat:** the chat agent and the Automation Engineer agent can list workflows, read failed runs and build new workflows. Workflows are always created **inactive**; switching one on needs the owner's approval under **Waiting for your approval**. Live workflows cannot be edited by agents.
- **Why workflows:** repeatable work runs on your server instead of through a model on every step. The routing rules prefer a workflow over an agent or a scheduled AI job whenever the steps are the same each time.

To run without n8n, remove `automation` from `COMPOSE_PROFILES` in `.env` and `docker compose up -d`.

## Orchestration (bundled Paperclip)

With the `control-plane` profile, Agent OS bundles its **own fresh [Paperclip](https://github.com/paperclipai/paperclip)** instance: the management layer (org chart, tasks, approvals, audit ledger). **Hermes runs the agents; Paperclip manages them; the dashboard is the cockpit.**

**First-time setup**

1. Open Paperclip from the Orchestration page and create the owner account.
2. On the box: `sudo ./scripts/paperclip-connect.sh`. This issues a non-expiring Paperclip board key for the owner and stores it in the dashboard's encrypted key store without displaying it. (Paperclip has no screen for creating board keys.)
3. Refresh Orchestration.

**What the page does**

- **Create an agent** from a template (Automation Engineer, Front Desk, Lead Qualifier, Customer Support, Social Media Manager, Review & Reputation, Bookkeeping Assistant, IT Helpdesk, CEO) or from scratch. Templates are in `connectors/agent_templates.json`.
- **Invite an agent** that already runs elsewhere: generates a paste-ready, single-use prompt (72 hours); approve the join under Waiting on you.
- **Pause / resume / edit / delete** agents, and resume the company if it was paused.
- **About your business:** name and a free-text description every agent can read, attached to every task created from chat.
- **Team chart:** drawn from Paperclip's reporting lines, with each agent's title and live status. It refreshes every 30 seconds, so agents added, removed or moved under another manager show up on their own.

**Editing agents.** The Agents page lists every agent Paperclip manages, wherever it runs, and saves changes back to Paperclip: name, title, role, who it reports to, what it does, and its main instruction file. An agent that runs on this server keeps its name, because the name links it to its Hermes profile. Gateway address, keys, budgets and extra instruction files stay in Paperclip.

**Which model each agent uses.** The Agents page shows the model and provider each agent's own Hermes reports, refreshed every 30 minutes by `scripts/agent-models.sh`. The check runs inside the Paperclip container using the gateway key Paperclip already holds; the key is not copied anywhere and only model names reach the dashboard. Hermes' own Models page (now *Local models*, under Advanced) only describes the Hermes on this server.

**Changing an agent's model.** For an agent on its own Linux machine, first give this server SSH access to it: `sudo ./scripts/agent-ssh.sh add <user>@<host>` (the host name must match the agent's gateway address; it asks for that machine's password once). The Agents page then offers the providers that machine has a key for and their models. Saving backs up the machine's Hermes config, applies the change, restarts the gateway and confirms the new model, restoring the old one if that fails. It is refused while the agent is mid-task. Agents on this server use *Local models* instead; Windows machines are changed on the machine.

**Answering tasks.** On the Tasks page, open a task to see what was asked and the conversation, then reply, reopen, mark it done or cancel it. A reply is posted as the owner and Paperclip wakes the assigned agent; replying on a finished task reopens it. Approvals, full run history and file downloads still open in Paperclip.

**More than one company in Paperclip.** The dashboard shows the first company Paperclip lists. To pin it to another, set `PAPERCLIP_COMPANY_ID=<company id>` in `.env` and run `docker compose up -d connectors`. This alone keeps the dashboard fully writable.

**Agents that run on their own machines.** An agent can keep its own Hermes gateway elsewhere and be managed from this Paperclip. This Paperclip build refuses a gateway address that is plain `http://` unless it is on the same machine, so give each remote gateway an HTTPS address (for example `tailscale serve --bg --https=443 http://127.0.0.1:<port>` on the agent's machine) and use that as the agent's gateway URL. See [docs/RUNBOOK.md](docs/RUNBOOK.md) §12.

**How delegated work runs.** A task assigned to an agent is executed by Paperclip through the Hermes gateway. Agents finish with `complete_task` or park the task with `need_owner_input`. All Paperclip-run agents currently execute on Hermes' **default profile**, so the model chosen when creating an agent applies to chatting with that agent's profile, not to its delegated tasks.

**Spend protection.** Paperclip's dollar budget is off by default because it cannot price Hermes runs and pauses the company at $0. Protection comes from the per-task run fast-stop (`RUN_MAX_ATTEMPTS`), the chat task limit (`CHAT_TASKS_PER_HOUR`) and a hard monthly limit at the LLM provider. See [docs/RUNBOOK.md](docs/RUNBOOK.md) §9.

**Connect-to-existing (optional):** point the bridge at an existing Paperclip with `PAPERCLIP_URL` (and `PAPERCLIP_API_KEY`, `PAPERCLIP_COMPANY_ID`). That path is **read-only by design**: Agent OS shows status but never creates tasks, replies, approves or changes anything on an instance it does not own.

Forgot the Paperclip password? `sudo ./scripts/paperclip-reset-password.sh`.

## Hosting it for clients

Agent OS is built so a consultant or MSP can run one isolated box per client: each
client gets their own VM and their own stack, and nothing is shared between them.

A per-client provision is the standard install on a 16 GB+ VM, reached over a
**Cloudflare Tunnel** under the operator's own Cloudflare account: a branded HTTPS
URL, no open ports at the client, and a free certificate. The client never needs a
Cloudflare account. Optionally set `OPERATOR_NAME=` and `SUPPORT_CONTACT=` in `.env`
to show who manages the box on the Overview page.

**See [docs/RUNBOOK.md](docs/RUNBOOK.md)** for the full per-client checklist: VM prep
(Secure Boot on), install, tunnel and routes, hostnames, first-time setup, team
sign-in and verification.

## Memory (Honcho)

With `--memory honcho` (the default; `--memory basic` skips it), the stack adds:

- `honcho-db` — Postgres 16 + pgvector.
- `honcho-api` — Honcho API, an unmodified build of a pinned upstream commit.
- `honcho-deriver` — the background worker that derives long-term memory.

The installer installs the Honcho plugin into Hermes and points it at the local service. Check with `docker compose exec -T hermes hermes memory status` (expect `Provider: honcho`, `Status: available`); repair with `sudo ./scripts/install-memory-plugin.sh`.

Honcho uses **your** LLM provider for its model slots and embeddings; a cost preset (economy / balanced / deep) tunes how often and how deeply memory is derived. Honcho's AGPL-3.0 license applies to Honcho itself, not to this installer or your agent configuration.

---

## Updating

```bash
cd /opt/sct-agent-os && sudo ./scripts/update.sh
```

Pulls the latest repo, re-syncs the theme and plugins with correct permissions, rebuilds local services, restarts, and re-enables the plugins. This updates **everything**, including the pinned versions of Hermes, n8n, Paperclip and Honcho, because the repo is the single source of truth. Hermes and n8n are pinned by image digest; Paperclip and Honcho come as prebuilt images from this repo's container registry (built from pinned commits by `.github/workflows/images.yml`), falling back to a local build if they cannot be pulled. To move to a newer upstream version, test it on a test box, run `scripts/show-versions.sh` there, and update the pins in a release. Then hard-refresh the dashboard (Ctrl+Shift+R).

> Note: `update.sh` pulls a new copy of itself; if the update script *itself* changed, run it a second time so the new logic takes effect.

### Update notifications (notify-only)

Each install checks for updates on a schedule (`scripts/check-updates.sh`, every 6 hours) and, when a newer release is published, shows an **"Update available" banner on the dashboard Overview** — current → latest, a "what's changed" link, and the one command to run. **Nothing updates automatically**; the customer runs `update.sh` when they're ready.

The release marker is the repo's **`VERSION`** file: bump it (and tag/release) when you cut a release, and every instance's next check surfaces the banner. The check only calls out to GitHub to read that file; it never changes the box. Override the source/notes URLs with `UPDATE_VERSION_URL` / `UPDATE_NOTES_URL` in `.env` if you host your own release channel.

---

## Repository layout

```
get.sh                      One-line bootstrap (installs Docker/git, clones, runs install.sh)
install.sh                  Interactive installer (preflight, access mode, config, first run, cron, smoke test)
docker-compose.yml          The whole stack; profiles: memory, automation, control-plane, tunnel
VERSION / CHANGELOG.md      Release marker and history
THIRD_PARTY_NOTICES.md      Upstream projects, licenses and how each is used
brand/                      Logo, favicons, sct.css, login.js, nav.js (sidebar arrangement)
connectors/
  app.py                    Connectors service (FastAPI): mail, bookings, n8n and Paperclip bridges,
                            run fast-stop ledger, chat tools (MCP), workflow approvals, business profile
  agent_templates.json      Starter agents for the Create panel
  mcp_config.py             Writes the chat-tools entry into the Hermes config
plugins/
  suburban-cyber/           Overview page, branding
  suburban-chat/            Bubble chat
  suburban-orchestration/   Agents: templates, invite, pause/resume, business profile
  suburban-tasks/           Delegated tasks, halted-task release
  suburban-automations/     n8n status, workflow approvals
  suburban-mail/            Mailboxes
  suburban-bookings/        Bookings
skills/agent-os/            Routing skill for the chat agent (running-the-business)
scripts/
  update.sh                 In-place update + restart
  set-hostnames.sh          Set all tunnel hostname settings in one step
  paperclip-connect.sh      Link the dashboard to Paperclip (issues + stores the board key)
  paperclip-reset-password.sh  Reset a Paperclip login
  install-memory-plugin.sh  Install/repair the Honcho memory plugin
  show-versions.sh          Print the upstream image digests a box is running (for pinning)
  sync-branding.sh          Copy theme, plugins and brand files; generate links.js
  sync-chat-tools.sh        Install the chat-tools config and routing skill
  backup.sh, restore.sh     Nightly full backup; open, check and restore one
  enable-plugins.sh, gen-tls.sh, watchdog.sh, smoke-test.sh, check-updates.sh
templates/                  nginx configs, dashboard themes, Honcho wiring
.github/workflows/          check.yml (lint, compose validation), images.yml (prebuilt images)
docs/RUNBOOK.md             Operator runbook: install, tunnel, first-time setup, logins, troubleshooting
docs/ARCHITECTURE.md        How the layer works
```

---

## Status

**v0.26 — a clean one-command install has been run end to end** on a fresh VM (Hermes v0.23.1, n8n 2.47.5) and reached through a Cloudflare Tunnel.

Verified live:

- Install, theme, branding, fixed sidebar, Overview, bubble chat.
- Cloudflare Tunnel for the dashboard, Paperclip and n8n.
- Agent templates, create/pause/resume, invite prompt, company resume.
- Chat delegation end to end: chat assigns a task, the agent delivers it; the Automation Engineer built an inactive n8n workflow and the approval gate held.
- Per-task run fast-stop, with halted tasks released from the Tasks page.
- A dozen agents on their own Hermes gateways (Linux and Windows) managed from the bundled Paperclip over HTTPS.
- Honcho memory plugin installed and reporting available.

Known limitations:

- **Team chart, task replies and the Agents page (v0.20 to v0.26) are tested against stand-ins** (a mock board, and for the model check a local database and mock gateways), not yet confirmed on a live one.
- **Bookings and Mailboxes are view-only.** Agents cannot yet book appointments or send/draft email.
- **Per-agent model choice does not apply to delegated tasks** (all Paperclip runs use the default Hermes profile).
- **The dashboard has one shared login.** Per-person sign-in comes from Cloudflare Access in front of it; per-person roles are not built.
- **Task completion by agents and the business profile** are built but not yet verified on a live box.
- **Workflow failures do not surface in "Waiting on you"** on their own; the chat agent or Automation Engineer reads them on request.
- **Token and cost figures** in the dashboard are incomplete (they exclude auxiliary model calls); the provider's own usage page is the source of truth.
- n8n's license (Sustainable Use License) limits some commercial uses; review it for your deployment.

## Roadmap

- Single sign-in for the dashboard (verify Cloudflare Access tokens at the proxy; the `admin` password stays as fallback).
- Ready-made workflow templates in Automations.
- Tab-by-tab redesign for non-technical owners, an Overview "Today" rail, a calendar view in Bookings, and owner/staff roles.
- Agent actions for bookings and email, with owner approval.
- Run each agent's tasks under its own Hermes profile (per-agent models).
- Security backlog: signed/verified install, network segmentation, Content Security Policy.
- Backups: one-click "Sign in with Google / Microsoft" for storage, and automatic reload of the team database on restore.

---

## Licenses

| Component | License | Notes |
|---|---|---|
| Suburban Cyber installer, scripts, plugins, connectors, themes | MIT | This repository |
| Hermes Agent | MIT | Official image, pinned by digest, unmodified |
| Paperclip | MIT | Unmodified build of a pinned commit |
| Honcho | AGPL-3.0 | Unmodified build of a pinned commit |
| n8n | Sustainable Use License | Official image, pinned by digest, not redistributed |

Full details in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

© 2026 Suburban Cyber Technologies LLC.
