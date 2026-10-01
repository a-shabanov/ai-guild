# Contributing

Start with a focused issue describing the user-visible problem, expected behaviour and a way to reproduce it. For a larger feature, discuss the API and data-model impact before implementing it.

## Local development

Use Docker Compose for a separate development PostgreSQL instance, then `npm ci` in `server/`. Run `npm run dev` for the app. Keep database credentials, account keys, files and local configuration out of commits.

Run `npm run typecheck` and the tests relevant to your change. The integration suite drops and recreates `aitracker_test` and `aitracker_social_test` on the configured PostgreSQL host. Run it only on an isolated development/test instance. The demo requires a dedicated database ending in `_demo`.

Interface text supports English and Russian; see [the localisation guide](docs/localization.md) when changing UI labels.

## Pull requests

Explain the concrete problem, final behaviour and validation. Include screenshots for interface changes, and state what you did not check. Avoid including real customer/project data in examples. Keep commits focused and use a clear action in each commit message.

Use `server/src/schemas.ts` for contract changes and add SQL migrations rather than editing applied migrations. Check web and iOS compatibility when changing API fields. Version updates use `node scripts/version.mjs`; release infrastructure is still being prepared.

Report sensitive vulnerabilities privately using [SECURITY.md](SECURITY.md). Contributions are made under the [Apache License, Version 2.0](LICENSE), unless explicitly stated otherwise.
