# Third-party software

Suburban Cyber Agent OS is a layer on top of other projects. They keep their own
licenses. This file records what we use, where it comes from, and how.

| Project | License | How we use it |
|---|---|---|
| [Hermes Agent](https://github.com/NousResearch/hermes-agent) (Nous Research) | MIT | Official image, pinned per release. |
| [Paperclip](https://github.com/paperclipai/paperclip) | MIT | Unmodified build of a pinned commit, published as `ghcr.io/ajr1303/agent-os-paperclip`. |
| [Honcho](https://github.com/plastic-labs/honcho) (Plastic Labs) | AGPL-3.0 | Unmodified build of a pinned commit, published as `ghcr.io/ajr1303/agent-os-honcho`. The complete corresponding source is the upstream repository at the commit recorded in the image's `org.opencontainers.image.revision` label and in `docker-compose.yml`. |
| [n8n](https://github.com/n8n-io/n8n) | Sustainable Use License | Pulled from n8n's official registry, pinned per release. Not redistributed by us. Its license limits some commercial uses; review it for your own deployment. |
| nginx, cloudflared, PostgreSQL/pgvector | BSD-2 / Apache-2.0 / PostgreSQL | Official images, pinned. |

We do not modify any of the above. If that changes for an AGPL component, the
modified source must be published.
