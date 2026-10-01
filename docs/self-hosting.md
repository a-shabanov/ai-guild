# Self-hosting the current preview

The server runs on Node.js and PostgreSQL, with attachments and project logos under `DATA_DIR`. The web client ships with the server. Use the [quick start](../README.md#get-started) locally and the [full Russian guide](ru/guide.md) for all existing configuration.

## Before exposing an instance

- Use a supported Node LTS and validate `npm ci`, type checking and tests on it. The current source minimum is 23.6; production LTS validation is still pending.
- Set unique PostgreSQL credentials. The root Compose file contains local development defaults and binds PostgreSQL to localhost.
- Put the app behind an HTTPS reverse proxy. Set `PUBLIC_URL` to the real public origin and validate proxy trust settings for your network; the current Express configuration trusts loopback proxies.
- Persist both PostgreSQL and `DATA_DIR`. A database backup alone does not preserve attachment bytes or logos.
- Limit upload sizes, requests and exposed ports according to your environment. A production configuration and security acceptance test are planned.
- Create an administrator locally with the account CLI, then invite the trusted people who should use this instance.

This preview has a single shared team: members can see the team's projects and tasks. It does not isolate unrelated organisations in a shared SaaS deployment.

## Optional integrations

| Capability | Requirements and current limits |
| --- | --- |
| Google / Telegram | Configure provider credentials and callback origin; use administrator invitations |
| Optional email / Telegram codes | SMTP with TLS or a started Telegram bot, verified channel and a separate HMAC secret; disabled until delivery is configured. See [setup](ru/guide.md#второй-шаг-входа-по-желанию) |
| Web passkeys | HTTPS origin and matching WebAuthn RP configuration |
| Native iOS passkeys | The server's domain must be associated with the signed app; arbitrary server URLs do not enable native passkeys automatically |
| Web push | HTTPS, supported browser, VAPID configuration |
| Native push | Apple Developer signing and APNs key/team/bundle configuration |
| Local agent watcher | Runs on the operator's machine; human requests can cause local agent execution. Restrict it to trusted people and projects |

Basic task tracking, API keys, work logs and reviews do not require an account in a central SaaS.

## Configuration

The existing environment reference is in [the setup guide](ru/guide.md#настройки-переменные-окружения). `server/.env.example` covers optional social login. Keep real secrets outside the repository and do not include them in build contexts, screenshots or support reports.

## Updates and recovery

Version metadata is shared through `version.json` and `scripts/version.mjs`. SQL migrations run on server startup using a lock and individual transactions. A production release needs a tested upgrade path and a coordinated backup of PostgreSQL plus files. Rolling an image back does not reverse a database migration.

Clean installation, upgrade and restore acceptance tests are release prerequisites in [the roadmap](roadmap.md). Do not treat this document as confirmation that those tests have already passed.
