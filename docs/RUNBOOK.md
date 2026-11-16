# Agent OS — Deployment Runbook

The operator runbook for standing up and looking after an Agent OS box. Two rules:

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
| vCPU / RAM / disk | Minimum 2 vCPU / 8 GB / 40 GB. Recommended 4 vCPU / 16 GB / 80 GB+ SSD |
| Secure Boot | **On** (Microsoft UEFI CA template) |
| Inbound ports | **None required** with a tunnel. |
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
2. Back in the dashboard, on Orchestration, press **Link my team** (takes up to a
   minute). From a shell, this does the same:
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
- `sudo crontab -l | grep -c agent-os-managed` prints **6** (watchdog, nightly backup,
  backup requests, upload retry, update check, dashboard requests). If not,
  `sudo ./scripts/install-cron.sh`.
- Overview shows the business name, the tiles for what is connected, and a backup line.

## 5. Per-client provisioning checklist

1. Provision the VM (§1), Secure Boot on.
2. Install (§2), access mode = Cloudflare.
3. Create the tunnel + 3 routes (§3).
4. `set-hostnames.sh` (§3).
5. First-time Paperclip and n8n setup (§3a); fill in **About your business** and create the first agents from templates.
6. Verify (§4), including `hermes memory status` (§7).
7. **Set a hard monthly spend limit at the LLM provider** (Nous Portal, OpenRouter, Anthropic/OpenAI console). That is the real dollar ceiling — see §9.
8. Set up team sign-in with Cloudflare Access if more than one person will use it (§11).
9. Backups (§13): save the recovery kit with the client, connect their storage, run
   one backup and see the file arrive. Set `OPERATOR_BACKUP_PUBKEY` if you will hold
   the second key.
10. Two-step sign-in (§16): turn it on with the client's phone and have them store
    the recovery codes away from the server.
11. Optional connections: bookings, mailboxes, website visitors (§17).
12. Turn on the stuck-agent watch once the team is linked and Automations is
    connected (§15).
13. Reboot the server once and confirm everything returns (§14).
14. Hand the client their dashboard URL + login. Rotate the dashboard password first
   if it was ever shown over a non-tunnel connection.

## 6. Updating

Two ways, same updater:

- **From the dashboard:** when a release is out, the Overview shows "Update available".
  Press **Update now**. Needs the every-minute job (`sudo ./scripts/install-cron.sh`).
- **On the server:**
  ```bash
  cd /opt/sct-agent-os && sudo ./scripts/update.sh
  ```

Either way a backup is taken first.

| Dashboard shows | Meaning |
|---|---|
| Starting the update… for more than a few minutes | The every-minute job is not running. `sudo ./scripts/install-cron.sh`, or run the updater on the server. |
| The last update did not finish | Read `sudo tail -40 /opt/sct-agent-os/data/backup/update.log`, fix the cause, press the button again or run the updater. Running services were left alone. |
| Updating… for more than 90 minutes | It is treated as failed. Check the log as above. |

A dashboard update is limited to 90 minutes and only one runs at a time. An install
older than v0.33 has no button yet: update it once from the server.

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
| Dashboard (`admin`) | The client | Client: Security page, or "Forgot password?" with their reset code. Operator: `sudo ./scripts/dashboard-password.sh` |
| Paperclip | Operator | `sudo ./scripts/paperclip-reset-password.sh` |
| n8n (owner email) | Operator | n8n's own reset; needs mail configured or a command-line reset. Not yet validated on this stack. |

The dashboard has one shared login. Do not hand a shared password to a team; use
Cloudflare Access so each person signs in as themselves.

### Dashboard password

- **Change it:** Dashboard > Security > Password > **Change password** (current password,
  then the new one twice). The dashboard restarts for about a minute; agents and
  automations keep running. Afterwards the page shows a new **reset code**.
- **Reset code:** one code, shown once, that sets a new password without the old one.
  Every successful change or reset replaces it. On an install that has none yet:
  Security > **Get a reset code** (asks for the current password). Have the client
  store it away from the server, next to the two-step recovery codes.
- **Forgot it:** the sign-in page has **Forgot password?**. Enter the reset code and a
  new password. Five wrong codes lock the page for 15 minutes, then longer. With
  two-step sign-in on, the code from the phone is asked for first.
- **No reset code either:** on the server, `sudo ./scripts/dashboard-password.sh`
  prints a new random password (`--ask` to type one). Give it to the owner directly
  and have them change it and save a new reset code.
- Passwords are 12 to 128 characters: letters, numbers and `! @ % ^ * ( ) _ + . , : ; ? ~ -`.
- Stuck on "Working…": the every-minute job is not running (`sudo ./scripts/install-cron.sh`).

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

## 13. Backups

A full backup runs every night at 03:30 (`scripts/backup.sh`) and lands in `backups/`
as one file, `agent-os-<date>.tar.gz` (or `.tar.gz.age` once encryption is on).

| In the backup | What it is |
|---|---|
| Team database | Paperclip: agents, tasks, routines, history |
| Team files and keys | Paperclip's secrets key, uploads, agent instructions |
| Agent memory | Honcho database |
| Automations | n8n workflows and credentials (credentials stay encrypted) |
| Dashboard connections | Mailboxes, bookings, usage plans, agent settings |
| Hermes | Profiles, skills, sessions, plugins (no logs or caches) |
| Settings | `.env`, certificates, agent SSH access, backup settings |

Not included: n8n run history and logins (workflows and credentials are), logs, and
agents that run on their own machines (section 12), which keep their own data.

### Turn on encryption and an off-site copy

Do this on the dashboard under **Connections > Backups**, or during `./install.sh`.

1. **Lock your backups.** Create the recovery kit, download it, store it off the
   server (password manager, or printed), then confirm. The server deletes its copy
   and keeps only the public half. The kit opens every backup this install makes.
2. **Second key (recommended when you manage the box for someone else).** On your
   own computer, once: `age-keygen -o operator-backup.key` (install `age` first:
   Windows `winget install FiloSottile.age`, Mac `brew install age`, then a new terminal). Keep that file private;
   it prints a public key starting `age1`. Paste the public key on the Backups page,
   or set it for every install you do: `OPERATOR_BACKUP_PUBKEY=age1... ./install.sh`.
   You can then restore a client's backup even if they lose their kit. Without a
   second key, a lost kit means the backups cannot be opened by anyone.
3. **Keep a copy somewhere else.**
   - *Google Drive:* on a computer with a browser, install rclone (Windows
     `winget install Rclone.Rclone`, Mac `brew install rclone`) and run
     `rclone authorize "drive"`, sign in with the account that should hold the
     backups, and paste the `{...}` block it prints.
   - *S3-compatible* (Backblaze B2, Wasabi, Cloudflare R2, MinIO, Amazon S3): endpoint,
     access key and secret. Use a key limited to the one bucket.
   - *OneDrive, SharePoint, Dropbox, anything else:* run `rclone config` on a computer
     with a browser, then paste that section from `rclone config show`.

   The connection is tested by writing and deleting a small file. Backups are only
   uploaded when they are encrypted. Kept 14 days on the server and 30 days in the
   cloud by default; both are adjustable on the page.

If an upload fails (Google Drive sometimes answers `rateLimitExceeded` when signed in
through rclone's shared app), the backup stays on the server and the upload is retried
about every 30 minutes. Send it again immediately with
`sudo ./scripts/backup.sh --retry-upload`. If it keeps happening, reconnect Google Drive
with your own Google client ID (the option is on the Backups page).

**Back up now** on the page starts a backup within five minutes. From a shell:
`sudo ./scripts/backup.sh`.

### Check a backup opens

```bash
sudo ./scripts/restore.sh backups/agent-os-<date>.tar.gz.age /path/to/recovery-kit.txt
```
This decrypts the backup into a temporary folder, checks every part against the
fingerprints recorded when it was made, and changes nothing. Do it after first setup
and every few months. The temporary folder contains secrets; delete it afterwards.

### Restore onto a server

1. On the new or repaired server, run `./install.sh` so the services exist.
2. Copy the backup file and the key file to it (download the backup from your cloud
   storage first).
3. `sudo ./scripts/restore.sh <backup file> <key file> --apply`, and type `RESTORE`.

This restores settings, Hermes, dashboard connections, agent memory, the team's files
and keys, and automations (workflows come back switched off). **The team database is
not loaded automatically yet.** The dump is left in the unpacked folder as
`paperclip-db.sql.gz`; it is a plain SQL file that drops and recreates each table.
Load it into Paperclip's embedded database from inside the container (it listens on
`127.0.0.1:54329`, database, user and password all `paperclip`) and restart Paperclip.
This last step has not yet been proven end to end on a live server, so rehearse a
restore on a spare machine before you rely on it.

## 14. Reboot test

Every service is set to restart by itself and nothing needs a human after a reboot.
Prove it once per install, and again after big changes.

1. `cd /opt/sct-agent-os && sudo ./scripts/smoke-test.sh` (all `[ok]`)
2. `sudo docker ps --format '{{.Names}} {{.Status}}' | sort > ~/before.txt`
3. `systemctl is-enabled docker cron` (both `enabled`)
4. `sudo crontab -l | grep -c agent-os-managed` (expect `6`)
5. `sudo reboot`
6. Wait six minutes without touching anything, then
   `sudo docker ps -a --format '{{.Names}} {{.Status}}' | sort`
7. `sudo ./scripts/smoke-test.sh` and `cat data/health.json`
8. Wait ten more minutes and repeat steps 6 and 7.

**Pass:** the same container names as `before.txt`, all `Up`, none `Restarting` or
`Exited`; the smoke test is all `[ok]`; `health.json` shows `"restarted":0` both times;
you can sign in, and Tasks, Orchestration and Automations load; a test task given to an
agent completes.

If a service keeps restarting, look at it before anything else:
`sudo docker compose logs --tail 100 <service>`.

Agents that run on their own machines (section 12) need the same check on each
machine: the gateway service starts at boot, its HTTPS address still answers, and a
test task completes.

## 15. Stuck-agent watch

Dashboard > Automations > **Stuck-agent watch**. Needs Automations connected and the
team linked.

1. Press **Check now (changes nothing)** to see what it would do.
2. Press **Turn on**. It installs a workflow in n8n and runs every ten minutes.
3. Optional alert: open the workflow *Agent OS: stuck-agent watch* in the builder and
   add an email, Telegram or Slack step after "Add your alert here". Use
   `{{ $json.summary }}` as the message. That step only runs when something needs you.
4. Optional restarts: the checkbox appears once at least one agent machine was added
   with `sudo ./scripts/agent-ssh.sh add <user>@<host>` and allows restarts.

What it will not do: touch paused agents or a paused company, interrupt a task that is
being worked on, act on work that has been idle for more than a week, or push the same
agent or task more than twice. If the workflow's first run fails in n8n, turn the
watch off and report it; the "Check now" button works without n8n.

## 16. Two-step sign-in

Dashboard > Security. Adds a code from an authenticator app to the dashboard password.

1. **Set up two-step sign-in**, scan the QR code with the app, enter the code it shows.
2. Save the eight recovery codes somewhere that is not this server.
3. Within a minute the page shows **On**. From then on every browser is asked for a
   code before the password page.

- The server's clock must be right (codes are time-based). `timedatectl` should show
  "System clock synchronized: yes".
- Lost phone: use a recovery code on the code page, then set it up again.
- Lost phone and codes: `sudo ./scripts/mfa-reset.sh` on the server.
- Stuck on "Turning on…" for more than five minutes: the every-minute job is not
  running. `sudo ./scripts/install-cron.sh`, then `sudo ./scripts/host-requests.sh`.
- It protects the dashboard address only. Turn on n8n's own two-factor setting inside
  n8n (Settings > Personal), and keep the Paperclip owner password strong.

## 17. Website visitors (Google Analytics)

Dashboard > Website. Read-only visitor numbers from Google Analytics 4, and the
**Website visitors** tile on the Overview.

1. Google Cloud Console: pick or create a project, enable the **Google Analytics Data
   API**.
2. IAM & Admin > Service Accounts: create a service account, then Keys > Add key >
   Create new key > JSON. A file downloads.
3. Google Analytics > Admin > Property access management: add the service account's
   address (ends in `gserviceaccount.com`) as **Viewer**.
4. Admin > Property details: copy the numeric **Property ID** (not the `G-` tag ID).
5. On the Website page enter a name, the Property ID, and paste the whole key file.

- **More sites:** no new key. Add the same address as Viewer on the other property,
  then **Add a site** with its name and Property ID. **Make this my main site** chooses
  which site the Overview shows.
- **Client sites:** the client adds the address on their own property and can remove
  it whenever they like. Every site on the page is visible to anyone who can sign in
  to this dashboard, so do not mix clients on a dashboard they share.
- **Replace the key:** use it after making a new key for the same service account.
- Numbers cover the last 7 full days, are cached for 30 minutes and can be a few
  hours behind Google's own screens.

| Message | Cause |
|---|---|
| This is not a Google service-account key | The paste is not the JSON file's contents. Open the file in a plain text editor and copy all of it. |
| This service account cannot see that property | The address is not a Viewer on that property yet. |
| Google did not recognise that property number | Use the numeric Property ID, not the `G-` measurement ID. |
| Google Analytics is limiting requests | Wait and try again later. |

## 18. Overview tiles

The top row adapts to what is connected. Nothing needs configuring.

| Tile | Shown when | Source |
|---|---|---|
| Active automations | Automations is connected | Workflows switched on in n8n |
| Appointments today | A booking account is connected | Appointments on today's date in the viewer's time zone |
| Website visitors | A website is connected | Main site, last 7 full days against the 7 before |
| Backup line | Always | Last backup time and whether the off-site copy worked |

A tile that stays empty after connecting: reload the page, then check the matching
page (Automations, Bookings, Website) for an error message.
