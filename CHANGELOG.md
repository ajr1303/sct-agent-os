# Changelog

All notable changes to Suburban Cyber Agent OS. Dates are UTC.

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
