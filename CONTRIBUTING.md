# Contributing

Start with a focused issue describing the user-visible problem, expected behaviour and a way to reproduce it. For a larger feature, discuss the API and data-model impact before implementing it.

## Local development

Use Docker Compose for a separate development PostgreSQL instance, then `npm ci` in `server/`. Run `npm run dev` for the app. Keep database credentials, account keys, files and local configuration out of commits.

Run `npm run typecheck` and the tests relevant to your change. The integration suite drops and recreates `aitracker_test` and `aitracker_social_test` on the configured PostgreSQL host. Run it only on an isolated development/test instance. The demo requires a dedicated database ending in `_demo`.

Interface text supports English and Russian; see [the localisation guide](docs/localization.md) when changing UI labels.

## Pull requests

Explain the concrete problem, final behaviour and validation. Include screenshots for interface changes, and state what you did not check. Avoid including real customer/project data in examples. Keep commits focused and use a clear action in each commit message.

Use `server/src/schemas.ts` for contract changes and add SQL migrations rather than editing applied migrations. Check web and iOS compatibility when changing API fields.

## Releases

Update shared metadata with `node scripts/version.mjs set <version>`. Add the version/build to
`docs/releases/index.json` and write `docs/releases/v<version>.md` with changes, actual validation
and anything unverified. Commit the final version, then run `node scripts/releases.mjs` to validate
the exact release commits without publishing. Verify deployment before pushing the release notes
to `main`. The GitHub release workflow publishes missing releases and tags using its temporary
repository-scoped token; existing releases and tags are preserved. It can also be rerun manually
from Actions on `main`. No personal GitHub token is required.

GitHub source releases do not by themselves certify the on-premise install/upgrade/restore
acceptance or native store binaries; those have separate criteria in `docs/roadmap.md`.

Report sensitive vulnerabilities privately using [SECURITY.md](SECURITY.md). Contributions are made under the [Apache License, Version 2.0](LICENSE), unless explicitly stated otherwise.
