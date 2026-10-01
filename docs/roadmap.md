# From preview to production

The first target is open source and on-premise distribution. SaaS and mobile store releases follow after the shared foundation is ready.

## Now: a useful public source repository

- [x] Existing REST/MCP server, web/PWA and native iOS source.
- [x] Source separated from local secrets, data, chat transcripts and build products.
- [x] Product screenshots and a reproducible local read-only tour.
- [x] Product name: AI Guild.
- [x] Blue-gradient human + agent mark with a shared orange result applied to the product.
- [x] Apache License 2.0.
- [ ] Public GitHub repository, project metadata and contribution process.

## First production on-premise release

- [ ] Supported LTS runtime, reproducible install and isolated CI checks.
- [ ] App container and production Compose, persistent database and files.
- [ ] Hardened bootstrap, HTTPS/proxy, limits and negative security tests.
- [ ] Backup/restore rehearsal and tested update/rollback procedure.
- [ ] Versioned GitHub Release, downloadable bundle, container digest and checksums.
- [ ] Clean-machine acceptance: install → use web/MCP → restart → update → restore.

A public source repository or a green type check alone does not establish production readiness.

## SaaS

Organisation boundaries, membership, scoped credentials and cross-tenant tests must cover REST, MCP, attachments, events, inbox, analytics and client caches. Then come onboarding, quotas, staging/production operations, recovery, support and the chosen access/billing model.

## Mobile

The existing iOS app already accepts a server URL. The release needs a polished choice of shared service or own server, API/capability negotiation, isolation of tokens/caches/queued actions, physical-device validation and TestFlight/store preparation. Native passkeys and push have deployment-specific requirements. Native Android is a separate decision; the web/PWA is already included.

## A separate direction: gamification

Guild mechanics and gamification are deferred to a separate idea-generation epic. They are not part of the current product or the repository launch. Evaluate cooperative roles, reputation for accepted results, guild development and useful achievements before choosing an experiment. Avoid rewarding token consumption or artificial task volume.
