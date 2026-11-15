# Third-party software

Suburban Cyber Agent OS is a layer on top of other projects. They keep their own
licenses. This file records what we use, where it comes from, and how.

| Project | License | How we use it |
|---|---|---|
| [Hermes Agent](https://github.com/NousResearch/hermes-agent) (Nous Research) | MIT | Official image, pinned by digest per release (currently v0.23.1). |
| [Paperclip](https://github.com/paperclipai/paperclip) | MIT | Unmodified build of a pinned commit, published as `ghcr.io/ajr1303/agent-os-paperclip`. |
| [Honcho](https://github.com/plastic-labs/honcho) (Plastic Labs) | AGPL-3.0 | Unmodified build of a pinned commit, published as `ghcr.io/ajr1303/agent-os-honcho`. The complete corresponding source is the upstream repository at the commit recorded in the image's `org.opencontainers.image.revision` label and in `docker-compose.yml`. |
| [n8n](https://github.com/n8n-io/n8n) | Sustainable Use License | Pulled from n8n's official registry, pinned by digest per release (currently 2.47.5). Not redistributed by us. Its license limits some commercial uses; review it for your own deployment. |
| nginx, cloudflared, PostgreSQL/pgvector | BSD-2 / Apache-2.0 / PostgreSQL | Official images, pinned. |
| [rclone](https://rclone.org) | MIT | Installed in the connectors image from the Debian package; copies encrypted backups to the storage you choose. |
| [age](https://github.com/FiloSottile/age) | BSD-3-Clause | Installed in the connectors image from the Debian package; encrypts backups. |
| OpenSSH client | BSD-style | Installed in the connectors image; used only when you allow model changes on an agent's own machine. |
| FastAPI, Uvicorn, httpx, cryptography and other Python packages | MIT / BSD / Apache-2.0 | Dependencies of the connectors service; see `connectors/requirements.txt`. |
| Google Fonts | SIL Open Font License | Fonts named in the dashboard theme are loaded by the viewer's browser from Google. |

We do not modify any of the above. If that changes for an AGPL component, the
modified source must be published.

The dashboard footer shows this product's name in place of the Hermes credit and
keeps "Powered by Hermes Agent · Nous Research (MIT)" as its hover text. Hermes
Agent's and Paperclip's MIT license texts ship inside their own images and source.

n8n: each install runs n8n for that business's own internal use. If you plan to sell
access to a hosted service built on this, read n8n's Sustainable Use License first and
take advice; that is outside what this project sets up.

