# Suburban Cyber Agent OS — Deployment Runbook

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
| vCPU / RAM / disk | 4 vCPU / 16 GB / 80 GB (full stack with memory) |
| Secure Boot | **On** (Microsoft UEFI CA template) |
| Inbound ports | **None required** with a tunnel. (Direct-TLS mode only: 443.) |
| Outbound | HTTPS to GitHub, Docker Hub, PyPI, the LLM provider, and (tunnel mode) Cloudflare |

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

## 3. Cloudflare Tunnel setup (recommended, per client)

All tunnels live under the **one** Suburban Cyber Cloudflare account. The client
never needs an account. One tunnel + one set of hostnames per box.

**DNS prerequisite:** the domain you publish under (e.g. `suburbancyber.com`) must
be on Cloudflare DNS. Per-client hostnames use one level so the free Universal SSL
cert covers them (`acme-agentos.suburbancyber.com`, not a nested
`acme.agentos.suburbancyber.com`, which would need Advanced Certificate Manager).

### Create the tunnel
1. Cloudflare → **Zero Trust → Networks → Tunnels → Create a tunnel → Cloudflared**.
2. Name it for the box (e.g. `sct-aos-acme`). Save.
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
In `/opt/sct-agent-os/.env`:
```
ACCESS_MODE=cloudflare
CLOUDFLARE_TUNNEL_TOKEN=<token from above>
# so the dashboard's Open buttons and the services use the tunnel hostnames:
PAPERCLIP_PUBLIC_URL=https://<client>-agentos-paperclip.suburbancyber.com
PAPERCLIP_ALLOWED_HOSTNAMES=paperclip,localhost,127.0.0.1,<client>-agentos-paperclip.suburbancyber.com
N8N_PUBLIC_URL=https://<client>-agentos-n8n.suburbancyber.com/
N8N_PROTOCOL=https
N8N_HOST=<client>-agentos-n8n.suburbancyber.com
N8N_SECURE_COOKIE=true
N8N_PROXY_HOPS=1
```
Add `,tunnel` to the `COMPOSE_PROFILES=` line, then:
```bash
cd /opt/sct-agent-os && sudo ./scripts/update.sh
```

### Team sign-in
To give each person their own sign-in (and hide the login page from the internet), put
**Cloudflare Access** in front of the box. See §11.

## 4. Verify

- Cloudflare tunnel shows **HEALTHY** (Tunnels → your tunnel → Overview).
- `https://<client>-agentos.suburbancyber.com` loads the dashboard over real HTTPS.
- "Open Paperclip" / "Open builder" open the Paperclip/n8n hostnames (fresh login
  at each — new host = new session; n8n logs in by **email**, not `admin`).
- `sudo docker compose ps` — all services healthy.

## 5. Per-client provisioning checklist

1. Provision the VM (§1), Secure Boot on.
2. Install (§2), access mode = Cloudflare.
3. Create the tunnel + 3 routes (§3).
4. Set `.env` + `update.sh` (§3).
5. Verify (§4).
6. **Set a hard monthly spend limit at the LLM provider** (Nous Portal, OpenRouter, Anthropic/OpenAI console). That is the real dollar ceiling — see §9.
7. Set up team sign-in with Cloudflare Access if more than one person will use it (§11).
8. Hand the client their dashboard URL + login. Rotate the dashboard password first
   if it was ever shown over a non-tunnel connection.

## 6. Updating

```bash
cd /opt/sct-agent-os && sudo ./scripts/update.sh
```
Pulls `main`, regenerates branding/links, rebuilds `connectors`, restarts the proxy,
gateway-tls, and cloudflared, and re-enables plugins. `.env` is preserved.

## 7. Memory (Honcho)

Honcho (long-term memory) runs under the `memory` profile and builds from a pinned
upstream commit on first start (a few minutes). If it's enabled, the install builds
the `agent-os/honcho` image locally — it is **not** on any registry, so a box must
build it rather than pull it (handled by the compose build context).

## 8. Troubleshooting

- **cloudflared "Unsupported" in the Cloudflare panel** — the pinned tag aged out.
  Set `CLOUDFLARED_TAG=<current>` in `.env` and `docker compose up -d cloudflared`.
- **Forgot the Paperclip password** — `sudo ./scripts/paperclip-reset-password.sh` (lists
  accounts, hidden prompt for the new password). Paperclip has no reset email.
- **n8n login rejects `admin`** — n8n logs in by the owner **email**, not username.
- **Paperclip/n8n unreachable via tunnel** — confirm the route's Service URL uses the
  compose service name (`paperclip`/`n8n`), and that the hostname is in
  `PAPERCLIP_ALLOWED_HOSTNAMES` (Paperclip) / set as `N8N_HOST` (n8n).
- **"pull access denied for agent-os/honcho"** — update to the current version; the
  honcho image is a local build (fixed by the deriver build context).
- **Honcho plugin "Permission denied /opt/data/plugins"** — fixed; the install step
  now runs as root to write the bind-mounted plugins dir.

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
- Give another agent profile the n8n tools: add its profile name to
  `N8N_TOOLS_PROFILES=` in `.env` and run update.
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
   - Domain: the dashboard hostname, e.g. `<client>-agentos.suburbancyber.com`
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

