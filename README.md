# Suburban Cyber Agent OS

A branded layer on top of [Hermes Agent](https://github.com/NousResearch/hermes-agent) (MIT): installer, dashboard theme, optional [Honcho](https://github.com/plastic-labs/honcho) long-term memory (AGPL-3.0, built unmodified from upstream at a pinned commit).

## Install (one command)

On a fresh Linux server (Ubuntu/Debian recommended), as a sudo user:

```bash
curl -fsSL https://raw.githubusercontent.com/ajr1303/sct-agent-os/main/get.sh | sudo bash
```

It installs git and Docker if missing, clones to `/opt/sct-agent-os`, and walks you through setup. Re-running updates the checkout.

Options: `curl ... | sudo bash -s -- --memory basic` (skip Honcho) or `--memory honcho`.

## Requirements

| | Minimum | Recommended |
|---|---|---|
| RAM | 4 GB | 8 GB |
| vCPU | 2 | 4 |
| Free disk | 20 GB | 40 GB |

(Estimates, not yet benchmarked.)

## Using it

Ports bind to localhost only. From your computer:

```bash
ssh -L 9119:127.0.0.1:9119 -L 8642:127.0.0.1:8642 user@server
```

Open http://localhost:9119 and choose the **Suburban Cyber** theme.

## Memory presets

economy (cheapest), balanced (default), deep (most recall, highest LLM cost).

## Status

**v0.2 - untested.** Not yet verified end to end: the `/api/health` smoke check on the Docker image, Honcho with non-OpenAI providers, and `hermes setup` ordering. Report issues on GitHub.

## Roadmap

Plugin for the dashboard overview, first-run wizard, remote access, installable ISO.

## Licenses

Installer scripts: MIT. Hermes Agent: MIT. Honcho: AGPL-3.0 (not modified or bundled; built from upstream source).
