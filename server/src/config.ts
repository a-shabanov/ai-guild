import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
// Shared with the iOS app; changed by scripts/version.mjs.
const release: { version: string; build: number } = JSON.parse(
  readFileSync(resolve(root, '..', 'version.json'), 'utf8'),
);
const port = Number(process.env.PORT ?? 4600);

// Passkeys are bound to the site's origin. They need a secure context: https, or http://localhost.
const origins = (process.env.WEBAUTHN_ORIGINS ?? process.env.PUBLIC_URL ?? `http://localhost:${port}`)
  .split(',')
  .map((o) => new URL(o.trim()).origin);

export const config = {
  version: release.version,
  build: release.build,
  port,
  host: process.env.HOST ?? '127.0.0.1',
  databaseUrl:
    process.env.DATABASE_URL ?? 'postgres://aitracker:aitracker@127.0.0.1:5433/aitracker',
  dataDir: resolve(process.env.DATA_DIR ?? resolve(root, 'data')),
  publicDir: resolve(root, 'public'),
  migrationsDir: resolve(root, 'migrations'),
  maxUploadBytes: Number(process.env.MAX_UPLOAD_BYTES ?? 2 * 1024 ** 3),
  // Public base URL agents see in upload hints returned by MCP tools.
  publicUrl: process.env.PUBLIC_URL ?? `http://127.0.0.1:${port}`,
  webauthn: {
    origins,
    rpId: process.env.WEBAUTHN_RP_ID ?? new URL(origins[0]!).hostname,
    rpName: 'AI Tracker',
  },
  sessionDays: Number(process.env.SESSION_DAYS ?? 90),
  socialAuth: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID ?? '',
      clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
    },
    telegram: {
      clientId: process.env.TELEGRAM_CLIENT_ID ?? '',
      clientSecret: process.env.TELEGRAM_CLIENT_SECRET ?? '',
    },
  },
  // Contact that push services (Apple, Google, Mozilla) see; must be a mailto: or https: URL.
  vapidSubject: process.env.VAPID_SUBJECT ?? 'mailto:ai-tracker@example.com',
  // Native iOS app. APNs needs a key from the Apple Developer account (Keys -> APNs).
  apns: {
    key: process.env.APNS_KEY ?? (process.env.APNS_KEY_PATH ? readFileSync(process.env.APNS_KEY_PATH, 'utf8') : ''),
    keyId: process.env.APNS_KEY_ID ?? '',
    teamId: process.env.APNS_TEAM_ID ?? '',
    bundleId: process.env.APNS_BUNDLE_ID ?? 'dev.aitracker.app',
    // Overridable so tests can stand in for Apple.
    urls: {
      sandbox: process.env.APNS_SANDBOX_URL ?? 'https://api.sandbox.push.apple.com',
      production: process.env.APNS_PRODUCTION_URL ?? 'https://api.push.apple.com',
    },
  },
  // "<TeamID>.<bundle id>" of apps allowed to use this site's passkeys (comma-separated).
  appleAppIds: (process.env.APPLE_APP_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
};
