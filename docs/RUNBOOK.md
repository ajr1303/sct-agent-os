# Agent OS — Deployment Runbook

The operator runbook for standing up and hosting an Agent OS box. This supersedes
the older Hyper-V/LAN walkthrough. Two rules changed from that version:

- **Keep Secure Boot ON.** Ubuntu runs fine under Secure Boot on a Gen-2 VM with
  the "Microsoft UEFI Certificate Authority" template. Don't disable it.
- **Don't expose services on the LAN.** The dashboard, n8n, and Paperclip are
  reached over a tunnel or an SSH tunnel — never a plain-HTTP LAN bind. n8n and
  Paperclip are loopback-only by design and can't be published to the network.

---

## 1. Host preparation

| Item | Value |
|---|---|
| OS | Ubuntu 22.04/24.04 LTS (or Debian) |
| vCPU / RAM / disk | Minimum 4 vCPU / 16 GB / 60 GB. Recommended 8 vCPU / 32 GB / 80 GB+ |
| Secure Boot | **On** (Microsoft UEFI CA template) |
| Inbound ports | **None required** with a tunnel. (Direct-TLS mode only: 443.) |
| Outbound | HTTPS to GitHub (incl. ghcr.io), Docker Hub, PyPI, the LLM provider, and (tunnel mode) Cloudflare |

The box only needs **outbound** access. A tunnel dials out, so you never open a
port on the client's firewall.

## 2. Install

As a sudo user on the fresh box:

```bash
curl -fsSL https://raw.githubusercontent.com/ajr1303/sct-agent-os/main/get.sh | sudo bash
```

The installer checks the machine, asks a few questions, writes `/opt/sct-agent-os/.env`
with generated secrets, pulls/builds images, and brings the stack up. Re-running
the one-liner on an existing box **updates in place** (it keeps `.env` and routes
to `update.sh`) — it never regenerates secrets.

When it asks **how you'll reach the box**, pick:

- **1) This machine / SSH tunnel** — most secure, nothing exposed. Reach it with
  `ssh -L 9119:127.0.0.1:9119 user@box` then `http://localhost:9119`.
- **2) Cloudflare Tunnel** — public HTTPS URL, no open ports. Paste the tunnel
  token (see §3). This is the recommended client option.
- **3) Direct LAN / public HTTP** — not recommended; trusted LAN only.

The installer prints the dashboard login (`admin` + a generated password), also in
`.env` as `DASHBOARD_PASSWORD`.

**Entering secrets.** Tunnel token and API key prompts are hidden. Nothing appears
as you paste; press Enter once. If a key is ever pasted at a visible prompt, or an
install log containing the dashboard password is shared, rotate it.

**Timing.** With the prebuilt images an install takes a few minutes. If they cannot
be pulled, Paperclip and Honcho build from source instead (about 35 minutes).

**Hermes setup** runs inside the installer: pick the model provider and, optionally,
messaging channels. The chat model chosen here is what delegated tasks run on.

## 3. Cloudflare Tunnel setup (recommended, per client)

All tunnels live under the **operator's** one Cloudflare account. The client
never needs an account. One tunnel + one set of hostnames per box.

**DNS prerequisite:** the domain you publish under (e.g. `example.com`) must
be on Cloudflare DNS. Per-client hostnames use one level so the free Universal SSL
cert covers them (`acme-agentos.example.com`, not a nested
`acme.agentos.example.com`, which would need Advanced Certificate Manager).

### Create the tunnel
1. Cloudflare → **Zero Trust → Networks → Tunnels → Create a tunnel → Cloudflared**.
2. Name it for the box (e.g. `agentos-acme`). Save.
3. Copy the **token** from the install screen (ignore their install command — we run
   our own `cloudflared` container).

### Add the routes (Routes → Add route → Published application)
| Subdomain | Service URL |
|---|---|
| `<client>-agentos` | `http://proxy:9119` |
| `<client>-agentos-paperclip` | `http://paperclip:3100` |
| `<client>-agentos-n8n` | `http://n8n:5678` |

Each adds the DNS record automatically. Service URLs use the **compose service
names** (`proxy`, `paperclip`, `n8n`), which `cloudflared` reaches over the internal
network even though those ports are loopback-only on the host.

### Configure the box
One command sets every hostname setting and applies it. Give it the dashboard
hostname; it derives the `-paperclip` and `-n8n` names shown above:
```bash
cd /opt/sct-agent-os && sudo ./scripts/set-hostnames.sh <client>-agentos.example.com
```
It backs up `.env`, replaces any existing values, prints the three routes to create
in Cloudflare, and runs `update.sh`. (If the installer was not run in Cloudflare
mode, also set `ACCESS_MODE=cloudflare`, `CLOUDFLARE_TUNNEL_TOKEN=` and add `,tunnel`
to `COMPOSE_PROFILES=` in `.env` first.)

### Team sign-in
To give each person their own sign-in (and hide the login page from the internet), put
**Cloudflare Access** in front of the box. See §11.

## 3a. First-time Paperclip and n8n setup

**Paperclip**
1. Open Paperclip (dashboard → Orchestration → Open Paperclip) and create the owner
   account.
2. On the box, link the dashboard to it:
   ```bash
   cd /opt/sct-agent-os && sudo ./scripts/paperclip-connect.sh
   ```
   This issues a Paperclip board key for the owner and stores it in the dashboard's
   encrypted key store. The key is never displayed. (Paperclip has an API for board
   keys but no screen to create one, and keys made through its own flow expire after
   30 days; this one does not.) Re-run it any time to replace the key.
3. Refresh Orchestration. Agents can now be created.

**n8n**
1. Open n8n (Automations → Open builder) and create the owner account.
2. In n8n: Settings → n8n API → create an API key and paste it into the Automations
   tab.

A fresh n8n starts with its own encryption key. To carry saved credentials over from
another n8n you need that server's database **and** its encryption key, set as
`N8N_ENCRYPTION_KEY` before this n8n is first started. Workflows alone can be brought
over with n8n's own `import:workflow` command; credentials are then re-entered.

## 4. Verify

- Cloudflare tunnel shows **HEALTHY** (Tunnels → your tunnel → Overview).
- `https://<client>-agentos.example.com` loads the dashboard over real HTTPS.
- "Open Paperclip" / "Open builder" open the Paperclip/n8n hostnames (fresh login
  at each — new host = new session; n8n logs in by **email**, not `admin`).
- `sudo docker compose ps` — all services healthy.

## 5. Per-client provisioning checklist

1. Provision the VM (§1), Secure Boot on.
2. Install (§2), access mode = Cloudflare.
3. Create the tunnel + 3 routes (§3).
4. `set-hostnames.sh` (§3).
5. First-time Paperclip and n8n setup (§3a); fill in **About your business** and create the first agents from templates.
6. Verify (§4), including `hermes memory status` (§7).
7. **Set a hard monthly spend limit at the LLM provider** (Nous Portal, OpenRouter, Anthropic/OpenAI console). That is the real dollar ceiling — see §9.
8. Set up team sign-in with Cloudflare Access if more than one person will use it (§11).
9. Hand the client their dashboard URL + login. Rotate the dashboard password first
   if it was ever shown over a non-tunnel connection.

## 6. Updating

```bash
cd /opt/sct-agent-os && sudo ./scripts/update.sh
```
Pulls `main`, pulls the pinned images, regenerates branding/links, rebuilds
`connectors`, refreshes the chat tools, restarts Hermes, the proxy and gateway-tls,
and re-enables plugins. `.env` is preserved. Updating can move a box to newer pinned
versions of Hermes and n8n, so click through the dashboard afterward.

**Versions are pinned.** Hermes and n8n are locked by image digest in
`docker-compose.yml`. To adopt a newer upstream version: set `HERMES_IMAGE=` or
`N8N_IMAGE=` in a test box's `.env`, test, run `sudo ./scripts/show-versions.sh`,
and put the printed digests into the next release.

## 7. Memory (Honcho)

Honcho (long-term memory) runs under the `memory` profile as three containers. The
installer also installs the Honcho plugin into Hermes. Verify:
```bash
sudo docker compose exec -T hermes hermes memory status
```
Expect `Provider: honcho` and `Status: available`. If the plugin is missing or
unavailable:
```bash
sudo ./scripts/install-memory-plugin.sh
```
`available` means the plugin started. To confirm recall, tell the agent a fact in one
chat and ask for it in a new chat.

## 8. Troubleshooting

- **cloudflared "Unsupported" in the Cloudflare panel** — the pinned tag aged out.
  Set `CLOUDFLARED_TAG=<current>` in `.env` and `docker compose up -d cloudflared`.
- **Orchestration says Paperclip rejected the request / not connected** — run
  `sudo ./scripts/paperclip-connect.sh` (the stored key is missing, revoked or expired).
- **Forgot the Paperclip password** — `sudo ./scripts/paperclip-reset-password.sh` (lists
  accounts, hidden prompt for the new password). Paperclip has no reset email.
- **n8n login rejects `admin`** — n8n logs in by the owner **email**, not username.
- **Paperclip/n8n unreachable via tunnel** — confirm the route's Service URL uses the
  compose service name (`paperclip`/`n8n`), and that the hostname is in
  `PAPERCLIP_ALLOWED_HOSTNAMES` (Paperclip) / set as `N8N_HOST` (n8n).
- **"pull access denied" for a `ghcr.io/ajr1303/agent-os-*` image** — the prebuilt
  image is not public or not reachable; the stack builds it locally instead. To fix
  permanently, make the package public in GitHub Packages.
- **Memory status "not available" / plugin install "Permission denied"** — run
  `sudo ./scripts/install-memory-plugin.sh`.
- **"install out of sync (pnpm…)"** on Hermes commands — a Hermes packaging notice;
  harmless.
- **Open Paperclip / Open builder go to localhost** — hostnames not set; run
  `sudo ./scripts/set-hostnames.sh <dashboard-hostname>`.
- **Dashboard shows the wrong company** — Paperclip has more than one and the dashboard
  takes the first. Set `PAPERCLIP_COMPANY_ID=<company id>` in `.env`, then
  `docker compose up -d connectors`.
- **An agent's tasks stay "queued" and never start** — Paperclip is still running its
  connection check on that agent. `GET /api/agents/{id}` shows `lifecycleState`
  (`verifying` until it passes) and the reason in `lifecycleError`. The usual cause is
  a gateway address that is plain `http://` on another machine; see §12.
- **A script gets HTTP 403 from the Paperclip hostname behind Cloudflare** — Cloudflare
  blocks Python's default request signature. Send your own `User-Agent` header. A
  `curl` test passing does not prove a Python script will.
- **Agents page shows a model as "Unknown" or "Not checked yet"** — run
  `sudo ./scripts/agent-models.sh` and read its last line. The page states the reason per
  agent: gateway unreachable, key refused, address not HTTPS, or a Hermes version without
  `/api/model/options`.
- **Sidebar order looks stock or reshuffles** — hard-refresh (Ctrl+Shift+R); the
  arrangement script is `brand/nav.js`.

## 9. Spend protection

Two layers protect a box from runaway cost:

1. **Run fast-stop (built in, on by default).** The gateway counts run attempts per
   task and halts a task after `RUN_MAX_ATTEMPTS` (default 6). Works regardless of
   model or pricing. Halted tasks show on the Tasks page with a Release button.
2. **Provider spend limit (set this per client).** A hard monthly cap in the LLM
   provider's console is the true dollar ceiling.

**Paperclip's dollar budget is off by default** (`COMPANY_BUDGET_CENTS=0`). Its
hard-stop fails closed on usage it can't price, and Hermes-gateway runs report
tokens but usually no dollar cost — so a cap pauses the whole company at $0 spent
while being blind to real spend. Only enable it for models whose runs report cost.
If a company ever shows "paused by budget", the Orchestration page offers
**Turn off cap & resume**.

## 10. Chat tools (delegation and workflows from chat)

The chat agent has an `agent_os` tool server (connectors' MCP endpoint) and a
routing skill. Ask it for help running the business and it will: answer quick
questions itself, build an n8n workflow for repeatable work, hand judgment work to
the matching agent, or send the CEO agent a hiring review when no agent fits.

Routing rules the agents follow: recurring work becomes an n8n workflow, not a
Hermes scheduled job (which runs the model every time); "someone to handle X" is a
role and goes to a hiring review; money never moves on its own.

What needs the owner:
- **Turning a workflow on.** Agents build workflows inactive and file a request.
  Approve or decline under **Waiting for your approval** in the Automations tab.
- **Hiring.** The CEO's recommendation arrives as a task; the owner creates the
  agent (or not) in Orchestration.
- **Credentials.** Agents never handle logins; add them as credentials inside n8n.

Prerequisites: n8n connected in the Automations tab, Paperclip connected in
Orchestration, and at least one agent. A CEO agent is needed for hiring reviews.

Operations:
- Setup runs on install/update: `./scripts/sync-chat-tools.sh` (then restart
  Hermes). Check the tools are loaded in the dashboard's MCP tab (`agent_os`).
- Agents run by Paperclip use the default Hermes profile, so they see the same
  `agent_os` tools as chat, including `complete_task` and `need_owner_input`.
- Limit how many tasks chat can create: `CHAT_TASKS_PER_HOUR` (default 20).
- Turn the tools off: blank `CHAT_TOOLS_TOKEN=` in `.env`, remove `agent_os` from
  `data/hermes/config.yaml`, update.

## 11. Logins, password resets and team access

### The three logins
| Login | Used by | Reset |
|---|---|---|
| Dashboard (`admin`) | The client | Change `DASHBOARD_PASSWORD` in `.env`, then `sudo ./scripts/update.sh` |
| Paperclip | Operator | `sudo ./scripts/paperclip-reset-password.sh` |
| n8n (owner email) | Operator | n8n's own reset; needs mail configured or a command-line reset. Not yet validated on this stack. |

The dashboard has one shared login. Do not hand a shared password to a team; use
Cloudflare Access so each person signs in as themselves.

### Team access with Cloudflare Access (hosted boxes)
Each person signs in with their own email (one-time code, or Google/Microsoft if you
add that identity provider). Adding or removing someone is a list edit; there are no
passwords to reset. Menu names below are as of late 2026 and may move.

1. **Sign-in method:** Zero Trust → Integrations → Identity providers. One-time PIN
   is available by default; add Google or Microsoft 365 if the client uses them.
2. **Create the application:** Access controls → Applications → Add web
   applications → **Self-hosted public application**.
   - Name: `<client> Agent OS`
   - Domain: the dashboard hostname, e.g. `<client>-agentos.example.com`
   - Session duration: 24 hours is a reasonable default for office staff.
3. **Policy:** action **Allow**, include **Emails** (list each person) or **Emails
   ending in** `@clientdomain.com`. Add your own operator address.
4. **Test** in a private window: the hostname should show the Cloudflare sign-in
   first, then the dashboard login.

What to protect:
- **Dashboard hostname: yes.** This is the one the team uses.
- **Paperclip hostname: yes, operator emails only**, unless external agents were
  invited (Orchestration → Invite an agent). Invited agents call Paperclip's API and
  Access would block them; leave it open or issue them a service token (Access
  controls → Service credentials).
- **n8n hostname: protect the editor, not the webhooks.** Workflows triggered by
  outside systems receive calls on `/webhook/` and `/webhook-test/`. Add a second
  application for those two paths with a **Bypass** policy for Everyone, or forms and
  integrations will stop working.

Limits:
- Access decides who gets in, not what they can do. Everyone who passes it then uses
  the same dashboard `admin` login and sees everything. Keep the dashboard password
  set; Access is a layer in front of it, not a replacement.
- Per-person roles (owner vs staff views) are not built yet.
- Self-hosted installs without Cloudflare keep the single login.

Offboarding: remove the person's email from the policy. If they knew the dashboard
password, rotate `DASHBOARD_PASSWORD` too.

## 12. Agents on their own machines

An agent does not have to run on the box. It can keep its own Hermes gateway on
another machine and take its work from this Paperclip. Only the management layer is
shared; the agent's files, model keys and tools stay where they are.

**What Paperclip needs for each such agent**

1. **An HTTPS gateway address.** This Paperclip build refuses a gateway URL that is
   plain `http://` unless the host is loopback, and its "allow insecure" setting does
   not get past the connection check. On a tailnet the simplest fix is, on the agent's
   machine:
   ```bash
   sudo tailscale serve --bg --https=443 http://127.0.0.1:<gateway port>
   ```
   and then use `https://<machine>.<tailnet>.ts.net` as the agent's gateway URL
   (`adapterConfig.apiBaseUrl`). The address is reachable only inside the tailnet.
2. **The gateway's key**, stored as a Paperclip company secret and referenced from the
   agent (`adapterConfig.apiKey = {type: "secret_ref", secretId, version: "latest"}`).
   On Hermes this is `API_SERVER_KEY` in the Hermes `.env`.
3. **The address agents report back to**: `adapterConfig.paperclipApiUrl` set to this
   Paperclip's public hostname.
4. **A Paperclip key on the agent's machine** (`POST /api/agents/{id}/keys`), saved in
   the Hermes `.env` as `PAPERCLIP_API_KEY` with `PAPERCLIP_API_URL`, followed by a
   gateway restart. Without it the agent can reply but cannot change a task's status.

Pipe keys between machines; do not display or paste them.

**Checking it worked.** Resume the agent and wait for `lifecycleState` to become
`ready`. Then give it one small task with a unique title and confirm it replies and
sets the task to done. Allow several minutes for a first run.

**Moving agents from another Paperclip.** Import the company paused, hold every agent
individually before resuming the company (resuming releases agents held only by the
company pause), then move agents one at a time: pause the agent on the old instance
before testing it on the new one, and switch each schedule off there as you switch it
on here. Anything outside Paperclip that files tasks (monitoring bridges, mail intake,
self-healing scripts) carries the old address, company id and agent ids and must be
repointed or stopped separately. Agent ids change on import.

**Windows agents.** There is usually no inbound SSH, so run the key exchange from the
agent's machine. Hermes lives in `%LOCALAPPDATA%\hermes`, and the gateway is started
by a scheduled task or `hermes gateway restart`.
