# Security policy

This project is an early self-hosted preview. There is no promise yet of production support, a security response SLA or multi-tenant isolation. Security fixes target the latest source; a supported-release policy will be added with the first stable release.

## Reporting a vulnerability

Do not put exploitable details, keys, private data or a live proof of exploitation in a public issue. Once the repository is published, use GitHub's private vulnerability reporting if it is enabled. A verified private contact must be added before public release; until then, contact the repository owner privately through an existing channel.

Include the affected revision, deployment mode, impact and a minimal reproduction using synthetic data. Do not test another person's deployment without their authorisation.

## Deployment boundaries

- The current application is one shared team, not an isolation boundary between unrelated customers.
- Use HTTPS and unique credentials outside localhost.
- Protect both PostgreSQL and attachment storage, and validate recovery.
- The local read-only demo automatically authorises reads from its sample database. It is bound to localhost and must not be used with confidential data.
- The optional local watcher can launch coding agents on an operator's machine. Restrict its human initiators and project paths to people you trust.
