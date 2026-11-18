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
| Dashboard | The client | Client: Account page, or "Forgot password?" with their reset code. Operator: `sudo ./scripts/dashboard-password.sh` |
| Paperclip | Operator | `sudo ./scripts/paperclip-reset-password.sh` |
| n8n (owner email) | Operator | n8n's own reset; needs mail configured or a command-line reset. Not yet validated on this stack. |

The dashboard has one shared login. Do not hand a shared password to a team; use
Cloudflare Access so each person signs in as themselves.

### First sign-in and the Account page

- A **new install** prints a temporary sign-in (`admin` plus a random password). The
  first sign-in opens the welcome screen: name, email, a sign-in name and password of
  the owner's own, then the reset code to save. The dashboard restarts and they sign in
  again with the new details. "Skip for now" keeps the temporary sign-in.
- Hand the temporary password to the owner and let them do this step themselves, so
  nobody else knows the final password.
- **Installs made before v0.36 are not affected**: no welcome screen, and the sign-in
  stays as it was. To offer it on an older install:
  `sudo touch /opt/sct-agent-os/data/backup/setup-needed`.
- **Account page** (the tab formerly called Security; clicking the name at the bottom
  of the sidebar opens it): name and email, **Change sign-in name** (asks for the
  current password, restarts the dashboard), password, reset code, reset by email,
  two-step sign-in.
- The sign-in name is `DASHBOARD_USER` in `.env`. Forgotten: `grep DASHBOARD_USER .env`.

### The menu, and operator tools

- **Your team / Connections / Settings** are what an owner sees. Hermes pages an owner
  uses carry plain names: Messaging (Channels), Messaging access (Pairing), AI models
  (Local Models), Keys, Skills, Chat history (Sessions).
- **Operator tools** (Hermes Profiles, MCP, Plugins, Scheduled Jobs, Files, Webhooks,
  Config, System, Logs) are hidden until Account > **Show operator tools in the menu**
  is ticked. This tidies the menu and is not a lock: with one shared sign-in the
  pages still open by address. Several of them can stop the system (System can stop
  the gateway and wipe agent memory, Files can delete agent data, Plugins can install
  code), and Hermes' own backup/restore on System is separate from Agent OS backups.
- Kanban, Achievements and Hermes' Documentation are not listed. Tasks replaces Kanban.
- **Main assistant's name:** the Chat page shows the name of the first agent the owner
  creates. Change it on Account > Your details. Older installs show "default" until a
  name is entered there.

### Dashboard password

- **Change it:** Dashboard > Account > Password > **Change password** (current password,
  then the new one twice). The dashboard restarts for about a minute; agents and
  automations keep running. Afterwards the page shows a new **reset code**.
- **Reset code:** one code, shown once, that sets a new password without the old one.
  Every successful change or reset replaces it. On an install that has none yet:
  Account > **Get a reset code** (asks for the current password). Have the client
  store it away from the server, next to the two-step recovery codes.
- **Forgot it:** the sign-in page has **Forgot password?**. Enter the reset code and a
  new password. A wrong code is simply refused (the page is never locked, so nobody else can lock
  the owner out). With
  two-step sign-in on, the code from the phone is asked for first.
- **Reset by email (optional):** Account > Password > **Set up reset by email**. Enter
  the address that should receive the link and an outgoing mail account for the server
  to send from (Gmail: `smtp.gmail.com`, 587, the address, an app password; Microsoft
  365: `smtp.office365.com`, 587), plus the current dashboard password. A test message
  must go through before it turns on. "Forgot password?" then offers **Email me a
  reset link**: good for 30 minutes, works once, at most three an hour. Whoever can
  read that mailbox can reset the dashboard password, so it should have its own
  two-step sign-in. If the dashboard's web address changes, save the settings again so
  the link points at the new address.
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

Dashboard > Account. Adds a code from an authenticator app to the dashboard password.

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

## 19. Email for agents

Agents on this server get `list_mailboxes`, `list_mail`, `read_mail` and `draft_reply`
through the Agent OS tool server. Nothing to install: connect a mailbox and they work.

- **Switch per mailbox:** Mailboxes page, tick "Agents can read this mailbox…". New
  connections have it ticked unless the owner unticks it. Mailboxes connected before
  v0.38 are off until ticked.
- **What an agent can do:** list unread mail, read a message as text (8,000 characters
  at most), and save a reply to Drafts. It cannot send, delete, move or mark mail.
- **Drafts:** saved to the folder the mail server marks as Drafts (falls back to common
  names). If none is found the agent is told to post its reply on the task instead.
- **Kept from agents:** messages whose subject or opening lines look like a sign-in
  code, a reset link or an account confirmation. This is pattern matching and will
  miss unusual wording, so advise a shared business inbox, never the owner's personal
  one, and never the address that receives Agent OS reset links.
- **Outside content:** every message carries a notice that it is information, not
  instructions. That lowers the risk of a hostile email steering an agent; it does not
  remove it, which is why agents cannot send or change anything.
- **Audit:** "What agents did with your mail" on the Mailboxes page (last 500 kept).
- Agents that run on their own servers do not have these tools.
- Problems: "Could not sign in" means the mailbox password or app password changed;
  remove and reconnect it.

## 20. Passing a task between agents

Agents on this server have `hand_off_task`: the agent holding a task can pass it to a
named colleague with a reason. The task stays open and moves to that agent.

Limits enforced by the system, whatever the agent's instructions say:
- only the agent the task is assigned to can pass it on, and never to itself;
- not to an agent that is paused, in error or awaiting approval;
- not back to an agent that already had the task;
- at most three hand-offs per task. After that, or when nobody fits, the agent has to
  ask the owner (`need_owner_input`), which puts the task in "Waiting on you".

If the team board refuses to move a task, a linked task ("Handed over: …") is opened
for the colleague and the original is left waiting on it.

Agents still cannot create fresh tasks of their own; only the chat assistant and the
owner do that. Agents on their own servers reach this tool over HTTP (section 22a).

## 21. Fewer "Needs you" items, and the daily task summary

- **Account > "Let agents finish routine work without asking me"** (on by default).
  With it on, an agent that asks the owner only to verify, confirm or close finished
  work is refused and told to close it with `complete_task`. Agents still ask about:
  money; anything sent, published or promised outside the business; prices, dates and
  scope; passwords, codes and access; deleting data; security incidents; hiring; and
  genuine choices. Untick it to have agents ask about everything again.
- The check is on the wording of the question, so it catches the common
  "please verify and close" pattern and lets anything that names a real decision through.
- It applies to agents that run on this server, and to agents on their own servers
  when they ask through the task tools (section 22a).
- **Automations > Daily task summary.** "Show today's summary" previews it. "Create the
  workflow" adds "Agent OS: daily task summary" to n8n, switched off: add an email
  (or Telegram, Slack) step using `{{ $json.text }}` and switch it on. To include it
  in an existing daily brief, copy the "Get the task summary" step into that workflow.
- The summary lists what was closed in the last 24 hours, what is waiting on the owner
  (total and new), what is in progress, hand-offs, and agents in error.
- The summary step carries an internal token in the workflow, the same one the
  stuck-agent watch uses. The address only answers inside the server.
- **Clearing a backlog:** Tasks > Needs you > **Select several** > Select all shown >
  Mark done (up to 100 at a time; the list reloads with the next batch). Closed tasks
  can be reopened one at a time from the task itself.

## 22. Big tasks are split, not run until they time out

A run is cut off after a set time (the team board's limit for that agent). A task that
tries to do everything in one run ends as an error with nothing delivered. Three
things now prevent that for agents on this server:

- **When a task is assigned from Chat**, a job that plainly covers many things ("all
  the workflows", "every client", "140 records", a long list) is filed as a short
  planning task: the agent only works out the parts and splits it. The check reads the
  wording, so it will sometimes plan a job that was small (a short delay) and miss one
  that was big.
- **Every task** carries a line telling the agent to do the first part and split the
  rest if it will not fit.
- **`split_task`** lets the agent holding a task file the rest as 2 to 8 smaller tasks
  (kept by itself, or given to a named colleague) and closes the original with the
  list of parts. A part cannot be split again, so tasks cannot multiply; a part that
  still does not fit is closed with a note saying what is left.
- The stuck-agent watch's reminder now tells the agent to split instead of retrying
  the whole job.

New parts count toward the hourly task limit. Tasks created directly in Paperclip do
not carry the "how to work this task" lines; the agent's instructions have to cover it.

## 22a. Task tools for agents on their own servers

An invited agent runs on its own machine and cannot reach the tool endpoint used by
agents on this server. It gets the same four task tools (`split_task`,
`complete_task`, `hand_off_task`, `need_owner_input`, plus `list_agents`) on the team
board's public address:

- `GET  https://<paperclip address>/api/agent-os/` lists the tools and their fields.
- `POST https://<paperclip address>/api/agent-os/call/<tool>` with a JSON body. Reply:
  `{"ok": true, "result": "..."}` or `{"ok": false, "error": "..."}`.
- `POST https://<paperclip address>/api/agent-os/mcp` is the same set as an MCP server
  (streamable HTTP), for runtimes that prefer to add it as one.

How it is protected:
- The caller sends **its own Paperclip API key** as the Bearer token. Agent OS asks
  Paperclip whose key it is and acts only as that agent; a caller cannot name another
  agent. Board keys, gateway keys and keys from another company are refused.
- Same limits as on this server: only the agent a task is assigned to can change it,
  2 to 8 parts, a part cannot be split again, hand-off rules, hourly task limit.
- 60 calls a minute per agent; repeated refused keys are slowed for everyone for a
  minute. An identity is remembered for five minutes, so a revoked key can keep
  working for up to that long.
- These routes skip the browser sign-in on that address (agents have no browser).
  If Cloudflare Access protects the Paperclip hostname, agents already need a service
  token for it; nothing changes there.

How an agent learns about it:
- Tasks filed from Chat or by a split for an agent on its own server carry the
  instructions, and so does the stuck-agent reminder and the invite text.
- For agents invited before this version: **Agents > pick the agent > "Add task tools
  to instructions" > Save changes.** Do this once per agent. Without it, an agent only
  learns the address from a task that carries the note.
- The address in the note comes from `PAPERCLIP_PUBLIC_URL`, or the dashboard address
  with `-paperclip` added. An agent that reaches Paperclip some other way (a private
  network address that bypasses the proxy) will not find these routes.

## 23. "Honcho memory is off for this session" in chat

Hermes prints this when it cannot use `data/hermes/honcho.json`. Two causes, both
repaired by the updater:

1. **It cannot read the file** (most common). The file is owned by root, but Hermes
   runs as its own user. `hermes honcho peer --user X` then reports
   `Permission denied: '/opt/data/honcho.json'`. Fix by hand:
   `sudo chown --reference=data/hermes/config.yaml data/hermes/honcho.json && sudo docker compose restart hermes`
2. **The file names no owner**: an empty or missing `peerName`, which the updater
   fills with `owner`.
To use the owner's real name instead, set it once before any memories build up:

```bash
cd /opt/sct-agent-os && sudo docker compose exec -T hermes hermes honcho peer --user "Their Name"
sudo docker compose restart hermes
```

Changing the name later starts a new memory profile; what was learned under the old
name stays filed under it. If the note is still there after an update, read
`sudo cat data/hermes/honcho.json` (it holds no secrets) and check the `peerName` line.

## 24. How the assistant writes

- The house style lives in `templates/writing-style.md`. Each install and update copies
  it into `data/hermes/SOUL.md` between two `agent-os:writing-style` markers, and into
  a skill (`writing-to-the-owner`). Text outside the markers is the owner's and is
  never touched; edit there to add a persona or business-specific wording.
- To change the house style for one install, edit the block in `SOUL.md`; the next
  update puts the standard text back, so lasting changes belong outside the markers.
- The same guidance rides along with the Agent OS tools, so it also reaches agents
  working on tasks on this server.
- Results vary with the model. If answers are still dense, try a stronger model for
  the main assistant on the AI models page.


## 25. Team and Automations addresses sit behind the dashboard sign-in

When an install uses the Cloudflare tunnel, the Team (Paperclip) and Automations
(n8n) addresses no longer face the internet with only their own login pages.

- **What the owner sees:** opening either address from a browser that has not been
  let in goes to the dashboard sign-in (and the two-step code if it is on), then
  straight back. After that the app's own login still applies. It lasts 24 hours per
  browser.
- **How it works:** the tunnel container is on its own network (`edge`) where the
  names `paperclip` and `n8n` point at the proxy. The existing Cloudflare routes
  (`http://paperclip:3100`, `http://n8n:5678`) keep working unchanged, but now pass
  through `templates/nginx.conf`, which asks the connectors service (`/gate/check`).
- **Not affected:** n8n webhooks, forms and MCP triggers (`/webhook/`, `/form/`,
  `/mcp/` and their test/waiting variants); Paperclip API calls that carry a Bearer
  key (agents on other machines); n8n public API calls that carry `X-N8N-API-KEY`;
  everything inside the server; LAN installs, which reach the apps directly.
- **Tunnel routes must point at `proxy`, `paperclip` or `n8n`.** The tunnel can no
  longer reach any other container. A route to something else (for example
  `http://hermes:8642`) stops working after this update; route it through the proxy
  or remove it.
- **New Paperclip accounts are closed once the team is linked**
  (`PAPERCLIP_DISABLE_SIGNUP=true` in `.env`, added by the update or by "Link my
  team"; takes effect when the team service next restarts). Set it to `false` to
  reopen sign-up.
- **Switch the gate off:** `SERVICE_GATE=off` in `.env`, then `sudo ./scripts/update.sh`.
- **If the connectors service is down,** both addresses answer with an error until it
  is back. Webhooks keep working.
- **Check from outside:** `curl -sI https://<n8n address>/rest/settings` should show a
  redirect to the dashboard address, not `200`.
- A tunnel that runs outside this compose file (cloudflared installed on the host)
  is not covered: point its routes at `http://localhost:9119` only, or add a
  Cloudflare Access policy.

## 26. Projects

**Projects** (in the menu under Chat) keeps the documents, notes and tasks for one
piece of work together.

- **Create** a project, write **standing notes** (what the assistant and agents should
  always know or do for it), and **upload files** by button or drag and drop.
- **What can be read:** PDF, Word, PowerPoint, Excel (text cells), text, CSV, Markdown,
  HTML and similar. Images and other types are stored and can be downloaded, but the
  assistant cannot read them. Scanned PDFs with no text layer count as images.
- **Limits:** 20 MB a file, 300 files a project, 1 GB in total (`PROJECT_FILE_MAX_MB`,
  `PROJECT_STORE_MAX_MB` in `.env`).
- **In Chat:** "Ask about this project" starts a question for it. The assistant reads
  the project before answering. Asking for work "for the X project" files the task
  under the project, and the agent is told to read the project first.
- **Agents can save notes** into a project (findings, decisions, drafts). They cannot
  upload, delete or download files. Common password and key shapes are stripped from
  notes they save.
- **File content is treated as reference material.** The assistant is told not to
  follow instructions written inside a file.
- **Backups:** projects and their files live in the connectors database, so every
  backup includes them. Large files make backups larger.
- Uploaded files are only ever sent back as downloads, never shown as a page.

## 27. Chat: attachments, pictures and speed

- **Attach photos and files in Chat:** the **+** button, drag and drop, or paste a
  screenshot. Up to 6 files a message, 20 MB each. Documents (PDF, Word, PowerPoint,
  Excel, text) are read as text. Photos are opened with the assistant's vision tool.
- **Whether the assistant can see a photo depends on its AI model.** A model with
  vision sees it directly; otherwise Hermes uses its helper vision model if one is
  configured. If neither is available the assistant is told to say so instead of
  guessing. Test with one photo after updating.
- **How it works:** the file is stored in the connectors database (`chat_files`,
  `chat_blobs`) and copied to `data/hermes/chat-files/`, which the assistant sees as
  `/opt/data/chat-files/`. The message carries a short note
  (`[attached image #N "name" saved at ...]`) that the chat page shows as a thumbnail.
  Chat files are capped at 500 MB in total; the oldest are dropped when it is full
  (`CHAT_STORE_MAX_MB`). To keep one, ask the assistant to save it to a project.
- **Image generation:** Account > **Image generation** > Set up. Choose OpenAI or
  MiniMax and paste that account's API key (stored encrypted, never shown again). Then
  ask in Chat, for example "make a square image for a post about our backup service".
  The picture appears in the answer; click it to download. Agents (for example the
  social media manager) can use it too. Limit: 20 images an hour (`IMAGES_PER_HOUR`).
  Each image is billed by the chosen service. Nothing is posted anywhere by this.
- **Speed:** the chat page converts each answer once instead of on every keystroke,
  checks for new messages faster while an answer is on its way (0.7 s) and less often
  otherwise, and rests when the tab is in the background. While the assistant works
  it shows how long it has been and how many steps it has taken. How long an answer
  takes is still set by the AI model and by how many tools it uses.
- **One answer per question:** Chat shows only the last thing the assistant says in
  each turn. What it writes while working is hidden (Operator tools on: "Show
  working" under the answer). The full conversation is still on the Chat history page.

## 28a. When the update banner appears

The server looks for a new version once an hour (17 minutes past). **Check for
updates** at the top right of the Overview asks it to look now; the answer arrives
within about a minute, and it also brings back a banner hidden with "Later".

## 28. Giving one agent its own model

Agents page > open the agent > **Change model**.

- **Agent on its own machine:** the change is made on that machine over SSH and its
  gateway restarts (about a minute).
- **Agent on this server:** all on-server agents share one Hermes with one default
  model (Settings > AI models). Choosing a model here gives that one agent its own.
  Nothing restarts; it applies to the next task the agent starts. **Use server
  default** removes it.
- Only providers this server has a key for are listed (Settings > Keys). The list
  refreshes every few minutes; `sudo ./scripts/agent-models.sh` refreshes it now.
- How it works: the agent's gateway address gets a tag
  (`https://hermes-gateway:8443/m/<tag>`). The TLS gateway sends that agent's
  `POST /v1/runs` through connectors `/gateway/run/<tag>`, which adds `provider` and
  `model` to the request; all other calls go to Hermes unchanged. Table
  `agent_local_model`.
- If an agent with its own model fails every task right after a change, the provider
  key is missing or the model name is not accepted: press **Use server default** and
  check Settings > Keys. A task that was already part-way done on the old model may
  need to be restarted.
