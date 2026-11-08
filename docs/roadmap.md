# From preview to production

The first target is open source and on-premise distribution. SaaS and mobile store releases follow after the shared foundation is ready.

## Now: a useful public source repository

- [x] Existing REST/MCP server, web/PWA and native iOS source.
- [x] Source separated from local secrets, data, chat transcripts and build products.
- [x] Product screenshots and a reproducible local read-only tour.
- [x] Product name: AI Guild.
- [x] Blue-gradient human + agent mark with a shared orange result applied to the product.
- [x] Apache License 2.0.
- [x] Public GitHub repository, project metadata and contribution process.

Source previews are available on [GitHub Releases](https://github.com/a-shabanov/ai-guild/releases). The production distribution has its own acceptance criteria below.

## First production on-premise release

- [ ] Supported LTS runtime, reproducible install and isolated CI checks.
- [ ] App container and production Compose, persistent database and files.
- [ ] Hardened bootstrap, HTTPS/proxy, limits and negative security tests.
- [ ] Backup/restore rehearsal and tested update/rollback procedure.
- [ ] Versioned GitHub Release, downloadable bundle, container digest and checksums.
- [ ] Clean-machine acceptance: install → use web/MCP → restart → update → restore.

A public source repository or a green type check alone does not establish production readiness.

## SaaS

A hosted service is being built around this repository, in a separate private one. This repository stays a complete product for one team and carries no organisations, sign-up, plans or billing.

| | This repository (Apache 2.0) | Hosted service (private) |
| --- | --- | --- |
| Contains | Server, web/PWA, iOS, REST, MCP, OIDC sign-in | Landing, sign-up, organisations and their members, limits, later billing |
| Teams | One | Many, each with its own PostgreSQL schema, files and subdomain |
| How they connect | Publishes commits and the [embedding surface](self-hosting.md#embedding-the-core) | Pins a commit as a git submodule and runs isolation tests before moving to a new one |

Features go here only when they make sense for a single team. What a host needs from the core stays generic: a scope for a piece of work, and settings that can follow it.

## Mobile

The existing iOS app already accepts a server URL. The release needs a polished choice of shared service or own server, API/capability negotiation, isolation of tokens/caches/queued actions, physical-device validation and TestFlight/store preparation. Native passkeys and push have deployment-specific requirements. Native Android is a separate decision; the web/PWA is already included.

## A separate direction: gamification

Guild mechanics and gamification are deferred to a separate idea-generation epic. They are not part of the current product or the repository launch. Evaluate cooperative roles, reputation for accepted results, guild development and useful achievements before choosing an experiment. Avoid rewarding token consumption or artificial task volume.
