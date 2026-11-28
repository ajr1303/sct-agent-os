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

**How agents get work.** Agents do not poll for tasks. The team board starts an
agent when a task is assigned to it or someone comments on its task. If that start
fails (the agent is unavailable, out of allowance or its gateway errors), the task
waits in To do. The stuck-agent watch (every ten minutes) is what picks those up: it
starts one waiting task per idle agent per pass, using the board's Retry so a task
held for "execution recovery" is released, and gives tasks nobody owns to the lead
agent. A large backlog on one agent therefore clears at about six tasks an hour;
close tasks that are no longer needed to clear it faster.

A task whose run was cut off part way is held by the board for good, because it
cannot tell which steps already happened. Its card says so and offers **Start it
fresh**: a new task for the same agent that reads the old one first, with the old
one closed. Tasks the owner already put back to work are started fresh by the watch,
three per pass.

**Combining colleagues' work.** An agent that gave pieces of a job to colleagues has
two tools for the wait and the read:

- `wait_for_tasks` marks its task as waiting on the others. The team board wakes the
  agent when they are all finished. It should call it once and stop. Without it the
  agent is woken repeatedly with nothing to do, and each wake uses one of the task's
  run attempts (section 9) until the task is halted.
- `read_task` returns another task's request, status, replies and file names, and the
  text of one saved file when a file name is given (long files come in parts).

If a task was halted while waiting, press **Release** on it on the Tasks page, then
reply on the task so its agent is woken.

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
- **Clearing a backlog:** Tasks > With the team (or All) > **Select several** > Select all shown >
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
agents on this server. It gets the same task tools (`split_task`,
`complete_task`, `hand_off_task`, `need_owner_input`, `read_task`, `wait_for_tasks`,
`save_file`, plus `list_agents`) on the team
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
  refreshes every half hour; **Refresh the list** under the dropdowns re-reads it
  within about a minute (`sudo ./scripts/agent-models.sh` does the same).
- How it works: the agent's gateway address gets a tag
  (`https://hermes-gateway:8443/m/<tag>`). The TLS gateway sends that agent's
  `POST /v1/runs` through connectors `/gateway/run/<tag>`, which adds `provider` and
  `model` to the request; all other calls go to Hermes unchanged. Table
  `agent_local_model`.
- If an agent with its own model fails every task right after a change, the provider
  key is missing or the model name is not accepted: press **Use server default** and
  check Settings > Keys. A task that was already part-way done on the old model may
  need to be restarted.

## 29. A card for every AI provider, and connecting Meta (Muse)

**Cards.** The Overview has a **Your AI providers** row and the Usage page has one
card per provider. A provider gets a card when any agent's machine holds a key for
it, an agent runs on it, or this server used it in the last 14 days. Nothing is set
up by hand.

- A plan whose provider reports it (MiniMax today) shows percent left and the reset.
- Every other provider shows tokens, estimated spend and requests for the last 14
  days, **as counted by this server's own Hermes**. Agents on their own machines are
  listed on the card but their use is not in the figures.
- "Ready" means a key is set up and no agent uses the provider yet.
- Where the figures come from: Hermes `GET /api/analytics/models?days=14` (read in the
  browser) and connectors `GET /usage` (which providers, which agents). New keys show
  up at the next half-hourly model check.

**Meta (Muse models).** The pinned Hermes includes Meta's Model API as a provider
(`meta-ai`), so no extra install is needed.

1. Get an API key from Meta's developer site for the Model API.
2. Dashboard > Settings > **Keys** > find **Meta Model API** > paste the key > save.
3. Agents > pick an agent on this server > **Change model** > **Refresh the list** >
   choose Meta and a Muse model. To make it the default for every on-server agent,
   use Settings > AI models instead (Connect is on that page too).
4. If Meta does not appear after a refresh, press **Restart Gateway** in the left
   menu and refresh again.

For an agent on its own machine, add the key on that machine (its own Hermes), then
change its model from the Agents page as usual. Its Hermes needs to be a version that
includes the Meta provider.

## 30. Decisions with buttons, and what "Needs you" means

The owner should only see decisions. Everything else is the team's.

**Tasks > Needs you** shows cards, not a list of every waiting task:

| Card | Where it comes from | Buttons |
|---|---|---|
| Decision | An agent called `need_owner_input` (summary, question, recommendation) | Approve, Decline, Tell me more |
| Approval | A pending approval on the team board | Approve, Decline, Ask for changes |
| Decision / Question | A confirmation or question card an agent left on a task | Approve and Decline for yes-or-no cards; others are answered on the board |
| Review | Finished work the board says is waiting for the owner's review | Approve (closes it), Send back, Tell me more |
| Stuck task | A blocked task the board says needs a person, with no clear question | Hand to the lead agent, Close it, Tell me more |

- **Add a note** on any card sends your words to the agent along with the button.
- **Tell me more** sends the task back to the agent with a request for a plain,
  short explanation; it returns as a new card when the agent asks again.
- **With the team** is every blocked or in-review task that has no card: agents
  waiting on each other. Nothing there needs the owner.
- Failed runs and agent errors are **alerts**, listed under the cards, not decisions.
- The list of what needs a person comes from Paperclip (`GET
  /api/companies/<id>/attention`), plus the table `owner_asks`. The Overview's
  "Waiting on you" panel shows the same count.

**The lead agent sorts out stuck work first** (Account > "Send stuck work to my lead
agent first", on by default). The lead agent is the one with the CEO role.

- Each time the stuck-agent watch runs, up to 5 stuck tasks with no clear question
  are handed to the lead agent with instructions: finish it, hand it off, split it or
  close it, and ask the owner only about the owner-only list, through
  `need_owner_input`. A task is handed over once.
- A task that ignored two reminders also goes to the lead agent before the owner.
- While the watch is running, stuck tasks that have not been through the lead agent
  are held back from "Needs you" ("N stuck tasks are going to ... first"). If the
  watch has not run in two hours they are shown straight away with a "Hand to" button.
- Needs: the stuck-agent watch switched on (Automations), and an agent with the CEO
  role that is not paused. Agents on their own machines also need the task tools in
  their instructions (section 22a) so they can ask properly.

**How agents must ask.** `need_owner_input` now requires `summary` (2 to 4 plain
sentences), `question` (one yes-or-no question) and `recommendation`. A call without
them is refused with instructions. Agents that park a task as blocked or in review
for the owner without the tool produce a "Stuck task" card, which the lead agent
picks up.

**Task pages** show, in order: the decision (if one is waiting), the latest update,
the request, earlier activity, the reply box and files. Agent text is formatted
(headings, lists, tables, code). The working notes Agent OS adds to a task for the
agent are hidden from this view.

## 31. Agents that stop with an error

Paperclip marks an agent **error** whenever its last run failed, and leaves it that
way until a run succeeds or someone clears it. The stuck-agent watch (every 10
minutes, Automations page) now deals with these itself.

For each agent in error it reads the error and the last failed run, names the cause,
and acts:

| Cause | What the watch does |
|---|---|
| Provider busy or rate-limited | Waits 10 minutes, clears the error, restarts the agent |
| Gateway could not be reached | Waits 10 minutes, clears, restarts |
| Ran out of time on a big job | Clears, restarts, and tells the agent on the task to split it |
| Unknown failure | Clears and restarts |
| Key rejected, no credit left, spending limit | Leaves it and tells the owner what to fix |

- Up to **3 automatic tries** per agent, waiting 0, 20 and 60 minutes. After the
  third it becomes a card under **Tasks > Needs you** ("Agent stopped") with the cause
  in plain words and two buttons: **Retry now** and **Pause this agent**.
- The count starts over once the agent has been healthy for two hours, or when the
  owner presses Retry now.
- Agents handled automatically appear only in the alerts list under the cards, with
  what was done. The Agents page shows "Why it stopped" on an agent in error.
- Switch: Automations > stuck-agent watch > "When an agent stops with an error...".
  On by default. The watch itself has to be switched on.
- Paperclip calls used: `POST /api/agents/<id>/clear-error`, `POST
  /api/agents/<id>/wakeup`, `GET /api/companies/<id>/heartbeat-runs?agentId=`.
- The cause is matched from the error text, so an unusual message lands in
  "unknown" and is simply retried. The watch log on the Automations page shows each
  action.

### An agent that cannot work at all (0.77.1)

The section above only covers an agent the team board has marked **error**. An agent whose
AI call hangs never gets that mark: its own watchdog cuts the run off, the run ends
`cancelled`, the agent stays `idle`, and the board holds the task ("a step may already have
happened"). With the model out of credit, that is every task the agent has.

So each pass of the watch also reads the last 500 runs (`_down_scan` in `connectors/app.py`):

- **Down** means `DOWN_MIN_STREAK` (3) finished runs in a row that did not succeed, on at
  least two tasks, or `DOWN_ONE_TASK_STREAK` (5) on one task, the newest within 7 days. Runs
  cancelled because a task was reassigned do not count. One bad task is not a down agent.
- **Why** comes from the assistant's own `logs/errors.log` (read-only mount), matched by
  time to the failed runs: credit, a rejected key, a spending limit, or a busy provider.
  When the log is on another machine or says nothing clear, the card says the AI stopped
  answering and points at the agent's model, sign-in and plan.
- **While down:** one card under Needs you (`down:<agent id>`), no card for each of its
  stopped tasks, no automatic fresh starts or nudges for them, no revive, and the lead
  agent gets nothing if the lead is the one that is down. The record is in the `kv` table
  under `agent_down`; the log shows `not working`, `tried again`, `working again`.
- **Trying again:** one task after 30, 60, 120, then every 240 minutes
  (`DOWN_PROBE_WAIT_MIN`), counted from the last failure or the last try. A queued task
  first; else a held task whose broken run provably took no step; else a plain wake-up.
  **Try it now** on the card does the same at once and may use any one held task, since
  the owner asked. **Pause this agent** stops the tries and keeps the card.
- **Back:** the first run that succeeds clears the record. Held tasks then start fresh
  three per pass as before, and the twice-a-day limit per task title starts from zero.

**Restart all / Close all** (`POST /orchestration/decisions/act-many`) act on a group of
stopped-task cards. Restart marks held tasks with the owner's go-ahead (the same comment
the single button writes, plus an `ownergo` row so the card is hidden and counted as
"starting again"), and the watch starts those three per pass; tasks the board does not
hold go back to `todo` and one per agent is woken.

## 32. Memory page, and upgrading the memory service

**The Memory page** (menu: Memory) shows what the assistant has learned about the
owner:

- **Your profile:** the short card the assistant keeps in mind in every chat.
- **Recent reviews:** the memory service looks over what it knows from time to time
  ("dreaming" in Honcho's words). Each review lists what it learned and the
  statements it was based on, what it tidied away, and how the profile changed.
  Reviews are kept for about 30 days.
- **Everything it knows about you:** each item, whether you said it or it was
  worked out, and **Not right?** to remove it. The same sentence stored more than
  once is shown once and removed everywhere.
- **Review now** starts a review. It uses the AI model, so it is limited to one every
  ten minutes.

It reads Honcho on the internal network (`/v3/workspaces/<ws>/dreams`, `conclusions`,
`peers/<id>/card`), using the workspace and names in `data/hermes/honcho.json`. Needs
Honcho 3.6 or later for the reviews list; on an older one the rest still shows. With
basic memory (no Honcho) the page says so.

**Upgrading the memory service.** A release that pins a newer Honcho changes the
memory database the first time the new version starts, and the old version cannot
read the changed database. `scripts/update.sh` handles this through
`scripts/upgrade-memory.sh`:

1. Stops Honcho and saves the memory database to
   `backups/honcho-before-upgrade-<time>.sql.gz` (kept 14 days). If the copy cannot be
   saved, the memory service is left on its current version.
2. Starts the new version and waits up to 15 minutes for it to report healthy.
3. If it does not, restores the copy, returns to the version that was running, and
   pins it in `.env` (`HONCHO_IMAGE=`). The reason is in
   `backups/memory-upgrade-failed.log`. The rest of the update carries on.

- `sudo ./scripts/upgrade-memory.sh status` says which version runs.
- `sudo ./scripts/upgrade-memory.sh retry` tries a rolled-back upgrade again. A
  later release with a different Honcho version retries on its own.
- To restore the copy by hand: stop `honcho-api` and `honcho-deriver`, then
  `docker exec agent-os-honcho-db psql -U honcho -d postgres -c 'DROP DATABASE IF
  EXISTS honcho WITH (FORCE)' -c 'CREATE DATABASE honcho'` and
  `gunzip -c backups/honcho-before-upgrade-<time>.sql.gz | docker exec -i
  agent-os-honcho-db psql -U honcho -d honcho`, set `HONCHO_IMAGE` in `.env` to the
  old image, and `docker compose up -d`.
- 3.2.0 to 3.6.1 was tested on a restored backup: 19 database changes, a few
  seconds on a small install and 13 seconds with 150,000 messages.

## 33. AI models page, and the profile switcher

**AI models** (Settings > AI models) is the owner's page for models. It replaces
Hermes's own Models page in the menu.

- **Your main model:** what the assistant and the on-server agents without their own
  model use. **Change** picks a connected provider, then a model. Recommended models
  come first; "Show all" lists the rest. Prices are shown where Hermes knows them. An
  expensive model asks for a second confirmation. The change applies to new chats
  and tasks.
- **AI providers:** each one is Connected or Not connected. **Connect** takes the API
  key from the owner's account with that provider; it is stored on the server and
  not shown again. **Replace key** and **Disconnect** are on connected ones (not on
  the provider the main model comes from). If a new key does not show as connected
  within a minute, press Restart Gateway.
- **Agents on a different model:** read-only list; change them on the Agents page.
- It uses Hermes's own routes (`/api/model/options`, `/api/model/set`, `/api/env`),
  so anything set here is what Hermes itself reads.
- Hermes's page (helper-task models, mixture of agents, custom endpoints) is under
  **Operator tools > Advanced models**.

**Profile switcher.** The "managing profile" box at the top of the menu is hidden.
Owners stay with the main assistant, which hands work to the others. With **Operator
tools** switched on (Account), the box comes back. Addresses that carry `?profile=`
are left alone: Hermes adds that itself on every page (0.55.0 removed it and
reloaded, which looped; fixed in 0.55.1).

## 34. The Overview summary card

The card at the top of the lower half of Overview answers "what happened while I
was away". It is read from `GET /api/connectors/orchestration/summary`, which takes
`since` and `until` (seconds, sent by the browser because the server does not know
the owner's timezone) and `label` (`today`, `yesterday`, `week`).

- **The sentences** are fixed patterns filled with real counts: tasks finished in
  the period, tasks in progress, decision cards waiting, agents stopped. No AI model
  is involved, so the card costs nothing and cannot invent anything.
- **Spent** is the board's cost ledger for the period when it has one, otherwise the
  cost recorded on each run. If neither exists (some agents report tokens only), the
  tile shows tokens instead.
- **Heavy runs**: 30 minutes or more, $1 or more, or three times that agent's usual
  time (and at least 20 minutes), cost (at least $0.25) or tokens (at least 500,000),
  judged against its earlier runs. The limits are `HEAVY_MIN`, `HEAVY_COST` and
  `HEAVY_TOKENS` in `connectors/app.py`.
- **"About double a normal day"** compares the period with the same stretch of
  earlier days, and only appears with at least two earlier days to compare.
- **Your day**: stopped agents, a decision waiting more than a day, tasks with no
  progress for over a day, then today's remaining appointments from the connected
  booking apps. Paperclip tasks carry no due date, so the card cannot say what is
  due today.
- The answer is cached for a minute; the card refreshes every two minutes.

## 35. Today's idea

One suggestion a day on Overview, written by the lead agent. Unlike the summary
card this one uses an AI model: one small task a day on the lead agent's model.

- **When it is written.** The stuck-agent watch asks for it on its first pass after
  5 am in the owner's timezone (the browser reports the timezone the first time the
  card is opened; until then, after 10:00 UTC). If the watch is off, the card shows
  **Get today's idea**. At most three requests a day, counting retries.
- **How.** The lead gets a low-priority task, "Today's idea for the owner", holding
  the facts and the rules, and answers with the `post_idea` tool (also reachable by
  agents on their own machines at `/api/agent-os/call/post_idea`). The tool only
  works on that task, for the agent it is assigned to, and closes it. No answer
  within 45 minutes shows as "did not arrive" with a retry.
- **Kinds.** `post`, `agent`, `follow_up`, `savings`. One is suggested each day in
  rotation; the lead may pick another with a stronger reason, or `none`.
- **Buttons.** Do it files a normal task with the named colleague (or the lead).
  Not today skips it. Not for me switches that kind off; **Turn off** on the card
  stops ideas altogether, and switching back on brings every kind back.
- **Needs.** The built-in team board and an agent with the CEO role. Ideas are kept
  in the `ideas` table of the connectors database; settings in `kv` (`idea_prefs`).
- **Quality** follows the business profile (Account). The fuller it is, the more
  specific the ideas.

## 36. The business plan

**Plan** in the menu holds one document the team works from. It is plain text with
headings (`## What we do`, `## Who we serve`, `## Goals for this quarter`,
`## How the team helps`, `## What to avoid`), up to 12,000 characters.

- **Writing it.** With no plan yet, the page offers **Have my lead agent write it**
  (the lead drafts from the business profile and recent work, and writes "To decide:"
  where it does not know) or **Write it myself**.
- **Changing it.** Type the change in the box at the top and press **Ask**: the lead
  gets a task holding the request and the current plan, and the page updates when it
  answers (it shows as working for up to 45 minutes). Or press **Edit**.
- **Versions.** Every save is kept (the last 60). Click one to read it;
  **Bring this version back** makes it current again as a new version.
- **Who can change it.** The owner, and the lead agent. Any other agent calling
  `update_business_plan` is refused and told to raise it with the lead or the owner.
- **Where it is used.** Agents call `get_business_plan` when direction matters, and
  the daily idea task includes it. It is not pasted into every task, to keep tasks
  short; the short business profile in Account still is.

## 37. Files

**Files** in the menu lists what agents have handed over. A file gets there when an
agent calls `save_file` on the task it is working, so the page fills up as agents
start using the tool.

- **Agents on this server** have the tool straight away. **Agents on their own
  machines** learn about it from their instructions: Agents, choose the agent,
  **Add task tools to instructions**, Save changes. Do this once per agent after
  updating to 0.59.0.
- **What can be saved.** Text files (md, txt, csv, json, html and a few code types)
  up to 400,000 characters; PDF, png, jpg, gif, webp, docx, xlsx, pptx and zip up to
  4 MB. Nothing else is accepted.
- **Reading.** Markdown and CSV are shown formatted; other text is shown as plain
  text; pictures are shown; everything else is download only. An HTML file is shown
  as its source and never runs in the dashboard.
- **Limits.** 20 files a task, 3,000 files and 500 MB in total (set
  `TEAM_FILES_MAX_MB` in `.env` to change the total). When full, agents are told to
  ask the owner, who can delete old files on the page. Nothing is deleted
  automatically.
- **Backups.** Files live in the connectors database, so they are in every backup.
- Files made before this version, and anything an agent wrote only to its own disk,
  are not on the page.

## 38. Model advice

**AI models** shows a Model advice panel when the team board is connected.

- **What it looks at.** Each agent's runs from the last 7 days: how many, how long
  they usually take, how many failed, and what they cost where the board records it.
- **Cheaper.** An agent on the stronger model of a checked pair, with at least 5 runs,
  a usual run of 8 minutes or less and no more than 15% failed.
- **Stronger.** An agent on the cheaper model with 30% or more of its runs failed.
- **Never moved down:** the lead agent. Agents with fewer than 5 runs get no advice.
- **Pairs.** Only models listed in `MODEL_TIERS` in `connectors/app.py` are ever
  suggested. Add a provider there after checking its model ids and prices.
- **Switch** uses the same change as the Agents page: on this server it applies to
  the agent's next task; on the agent's own machine it backs up the config, changes
  it, restarts the gateway and puts everything back if the gateway does not answer
  with the new model. That needs `scripts/agent-ssh.sh add <user>@<host>` to have
  been run for the machine, and the restart to be allowed without a password.
- **Show the steps** appears when that is not set up, with commands to run by hand.
- The saving is half of that agent's recorded cost for the week, shown only when
  the board recorded a cost. It is an estimate.

## 39. What an update does to running tasks

From 0.61.0, `scripts/update.sh` (and so **Update now**) does this before it
restarts anything:

1. Asks how many tasks are running. If any are, it waits, checking every 15 seconds,
   for up to 5 minutes. `AOS_UPDATE_WAIT=600 ./scripts/update.sh` waits 10 minutes;
   `AOS_UPDATE_WAIT=0` does not wait.
2. Once nothing is running, it pauses the team, so no task starts during the restart.
   It never pauses while work is running, because pausing a team in Paperclip stops
   its running work.
3. If tasks are still running when the wait is over, it goes ahead without pausing
   and says which agents were busy. Paperclip retries a run that was cut off, and the
   stuck-agent watch picks up anything left idle.
4. After the services are back, it switches the team on again. It does the same if
   the update stops with an error.

A team that was already paused (by the owner or a budget) is left exactly as it was.
If the update dies so hard that step 4 never runs, the stuck-agent watch switches
the team back on once the pause is 45 minutes old.

Agents on their own machines keep working through an update; what they cannot do
while the board restarts is report back, which the same retry covers.

## 40. Team templates

**Agents**, at the bottom of the page.

- **Save this team as a template** downloads `<business>-team-template.json`. It
  holds, for each agent: name, role, title, description, who it reports to and its
  instructions. The task-tools note added for agents on their own machines is left
  out, because it names this server's address. Text that looks like a key, token or
  password is replaced with `[removed]`; read the file before sending it to anyone,
  since that check cannot catch everything.
- **Install a template** on another server: choose the file, read the list (Add or
  Skip for each agent), press Add. Up to 30 agents.
- **What installing does.** Each new agent is created on that server, running on its
  Hermes with the server's main AI model. An agent whose name is already taken is
  skipped and never changed. If the server already has a lead agent, a lead in the
  template joins as a regular agent. Reporting lines are set afterwards for the new
  agents.
- **What it does not do.** It does not set up agents on their own machines, copy
  models, or bring any data. The instructions were written for another business:
  open each new agent and adjust them, and fill in the business profile and the plan.

## 41. Security check, Help, and installing as an app

- **Security check** (Overview, right column) reads `GET /api/connectors/security/check`
  and the hourly update status. A green dot is fine; an amber one has a line saying
  what to do and links to the page for it. Items: two-step sign-in, recovery codes
  (flagged at two or fewer), backups (flagged when none, failed, older than 36 hours,
  or kept on this server only), the team's monthly spending limit, updates.
- **Help** is the last entry under Settings. The support line comes from the operator
  name and contact given at install (`OPERATOR_NAME`, `SUPPORT_CONTACT` in
  `.env`; re-run `scripts/sync-branding.sh` after changing them).
- **Install as an app.** iPhone: open the dashboard in Safari, Share, Add to Home
  Screen. Android and desktop Chrome or Edge: the browser menu, Install app. It is
  the same site in its own window; it does not work offline and there are no
  notifications. The name and colors are in `brand/manifest.json`.

## 41a. Adding a dashboard page

A page is a folder in `plugins/`. Hermes leaves it out of the menu, without an error
the owner would see, unless all of this is true (`python3 scripts/check-plugins.py`
checks it, and so do the automated checks):

- `plugin.yaml` and `__init__.py` at the top of the folder (copy another page's);
- `dashboard/manifest.json`, with the `entry` and `css` files it names;
- the folder is listed in `scripts/enable-plugins.sh` and `scripts/sync-branding.sh`;
- its `tab.path` is not used by another page or by a built-in Hermes page (`/files`,
  `/models`, `/sessions` and the rest are taken).

Then give it a place in the menu in `brand/nav.js` (`GROUPS`).

## 42. Agents on their own machines: checking and changing the model by hand

Learned the hard way on 2026-11-19. Use this when the dashboard cannot change a
machine itself (Model advice shows **Show the steps**), or to check what an agent is
really running.

**Find Hermes.** It is often not on the PATH. Installs made through the npm bridge
keep it inside `~/.hermes`:

```bash
H=$(command -v hermes || echo ~/.hermes/node_modules/hermes-agent/runtime/hermes-agent/venv/bin/hermes)
$H --version
```

**See what it is set to, and what it really used.** The setting and the truth can
differ, so check both:

```bash
$H config get model.provider
$H config get model.default
grep 'API call' ~/.hermes/logs/agent.log | tail -1
```

The log line names the model and provider of the last call. It only moves when the
agent runs a task, and its times are UTC. "Config key not set" means Hermes is using
its own default, whatever the file appears to say.

**Do not edit `config.yaml` by hand.** Some machines have a block like this:

```yaml
llm:
  provider: minimax
  model: MiniMax-M3
  baseUrl: https://api.minimax.io/v1
```

Hermes does not read an `llm:` block (checked in the 0.23.1 source). Changing it does
nothing, and `diff` will still show a tidy one-line change. Always use Hermes' own
command, which writes the `model:` section it does read:

```bash
cp ~/.hermes/config.yaml ~/.hermes/config.yaml.before-change
$H config set model.default MiniMax-M3.1-Flash
$H config get model.default
```

**Use the provider's own model name.** For MiniMax called directly that is
`MiniMax-M3.1-Flash`, not the lowercase `minimax/minimax-m3.1-flash` form that model
marketplaces use.

**Restart the gateway. Its service name differs between machines** (`hgw.service` on
some, `hermes-gateway.service` on others), and it may be a system service or a user
one:

```bash
SVC=$(systemctl list-units --type=service --no-legend | grep -i -E 'hgw|hermes' | awk '{print $1}' | head -1)
if systemctl cat "$SVC" >/dev/null 2>&1; then
  sudo systemctl restart "$SVC" && systemctl is-active "$SVC"
else
  systemctl --user restart "$SVC" && systemctl --user is-active "$SVC"
fi
```

**Prove it.** Give the agent one small task with no side effects ("Reply in one
sentence saying what you are responsible for"), wait for it to finish, and run the
`grep 'API call'` line again. Only a log line with the new model and a fresh time
counts.

**Never paste the service's settings into a chat or ticket.**
`systemctl cat <service>` prints `API_SERVER_KEY`, the key the team board uses to reach
that agent. If it is exposed, replace it in both places: the service on the machine,
and the agent's gateway key on the team board.

**To undo:** `cp ~/.hermes/config.yaml.before-change ~/.hermes/config.yaml`, then
restart the service.

## 43. Running an agent on a Claude subscription (experimental)

An agent on its own machine can use the owner's Claude Pro or Max plan instead of an
API key, through Nous Research's official plugin **Claude Subscription DirectSDK
(Experimental)**. The plugin runs Anthropic's own unmodified Claude Code program for
each request; Hermes never holds the login. First run on Iris on 2026-11-19, on a Max
plan, with Sonnet.

**Read before using it**

- It is experimental; the plugin's own page calls it a review build.
- The agent shares the owner's plan limits (the five-hour and weekly limits that the
  Claude apps and Claude Code also use). A busy agent can lock the owner out.
- The plugin's page measured this path at roughly 1.7 times the rate of interactive
  use. Each call from Iris carried about 34,000 tokens.
- The agent's background calls (approvals, titles) go through the plan too.
- Anthropic's terms say plan limits assume ordinary, individual use and that it may
  enforce without notice. One or two agents on the owner's own account is one thing;
  a whole always-on team is a different question. Ask Anthropic if in doubt.
- The owner's own account only. Never a client's agents on your plan: each client
  needs their own plan or API key.
- Turn off extra usage on the Claude account first, so reaching a limit stops the
  agent and does not bill.
- Do not use community patches that make Hermes pose as Claude Code. That is the
  route Anthropic prohibits.

**The no-risk alternative.** Max, Ultra and Team plans include monthly API credits
($100 on Max). Link a Claude Console organization under Settings, Billing on
claude.ai, make an API key there, and add it under AI models. That is ordinary API
use and does not touch the plan's chat limits. Credits do not roll over.

**Setup, on the agent's machine, as the user its gateway runs under.** Needs Hermes
0.21.4 or newer.

```bash
H=$(command -v hermes || echo ~/.hermes/node_modules/hermes-agent/runtime/hermes-agent/venv/bin/hermes)
npm install -g @anthropic-ai/claude-code
$H plugins install claude-subscription-directsdk
claude auth login            # prints a link; sign in on your own computer, paste the code back
claude auth status           # "loggedIn": true, "subscriptionType": "max"
which claude                 # must be in a folder on the gateway service's PATH
cp ~/.hermes/config.yaml ~/.hermes/config.yaml.before-claude
$H config set model.provider claude-subscription-directsdk-experimental
$H config set model.default sonnet
```

Restart the gateway and prove it as in section 42. The log line should read
`model=sonnet provider=claude-subscription-directsdk-experimental`. Claude Code does
not leave session files in `~/.claude/projects` on this path, so do not look there.

The login expires (about a month on the first run); `claude auth status` shows when.
When it does, the agent's runs fail until `claude auth login` is run again.

**Not supported yet:** agents that run on the main server. Hermes there lives in a
container without Claude Code.

## Connecting business apps

Open **Connections**, pick the app, follow the three steps on its card and paste the key.
Agent OS checks the key with the app before saving it. From then on every agent and Chat can
use it (tools `connected_apps`, `app_action`, `app_get`), and n8n has the same login as
"<App> (Agent OS)". Use **Make read only** to stop agents changing anything in that app, and
**Recent use** to see who did what. To add an app, add an entry to
`connectors/business_apps.py` (fields, how requests are signed, a test call, the actions, and
the n8n credential type).

## My devices

The **My devices** tab (`plugins/suburban-devices`) is where UniFi is connected and where
everything it finds is listed. `_devices_scan` in `connectors/app.py` reads every site's
devices and clients into the `devices` table (connectors.db) on connect, on **Scan now**, and
in the 10-minute check; the last scan's outcome is in kv `devices_scan`. Clients that have
left are kept as offline for 30 days. Restart and Update on the page create an
already-approved row in `action_requests` (the owner's click is the approval) and follow the
same run-and-verify path as agent proposals. Agents read the list with `my_devices`. If the
list is empty or stale, press Scan now: the error from the controller is shown on the page.
To add another source of devices, write its rows into `devices` with its own `source`.

**Computers and servers** report in themselves. **Add a computer** creates a row in
`computers` (only a hash of the token is stored) and shows one install command. The
command downloads `connectors/reporter/install.ps1` or `install.sh` from this box, which
saves `report.ps1` / `report.sh` and the token (Windows: `%ProgramData%\AgentOS`, a scheduled
task named "Agent OS report" running as SYSTEM; Linux: `/opt/agent-os-report` and
`/etc/cron.d/agent-os-report`). Every 5 minutes the script posts to
`/api/connectors/devices/report`; nginx lets that path and `/devices/reporter/` through
without a browser session because the token is the check. Veeam Agent results come from the
"Veeam Agent" Windows event log ("... finished with Success/Warning/Failed") and from
`veeamconfig session list` on Linux; `_veeam_jobs` in `connectors/app.py` turns them into
jobs, so a wording difference in a Veeam version is fixed there, not on the machines. **Set up many
(MDM)** stores a hash of one enrollment key in kv `computer_enroll` and returns the same
install scripts with the key inside instead of a token; a machine running one calls
`/api/connectors/devices/enroll` with its hostname, gets its own token, and (if approval is
on) is listed as waiting until the owner approves it. A
computer that shows "no report yet": run `report.ps1` / `report.sh` by hand on it and read
the error, and check the machine can open the Agent OS address used in the command.

## Actions that need the owner's approval

Some app actions can interrupt the business (restart a UniFi device, power-cycle a port,
install firmware). They are marked `approval=True` in `connectors/business_apps.py` and
cannot be run with `app_action`. An agent calls `propose_action`; the owner sees a card
under **Needs you** and presses Approve or Decline. Agent OS then runs the stored action
(straight away, or at the proposed time, checked every 10 minutes), calls the app's
`confirm` check until the device is back, and records the result on the task and in
**Recent use** on Connections. To add such an action for another app, add it to the
catalog with `approval=True` and teach `describe` (pre-check and plain wording) and
`confirm` (how to tell it worked) about it.

