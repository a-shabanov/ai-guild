import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { currentScope, type OidcSettings } from './scope.ts';

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
const baseWebauthn = {
  origins,
  rpId: process.env.WEBAUTHN_RP_ID ?? new URL(origins[0]!).hostname,
  rpName: 'AI Guild',
};
const baseDataDir = resolve(process.env.DATA_DIR ?? resolve(root, 'data'));
const baseMaxUploadBytes = Number(process.env.MAX_UPLOAD_BYTES ?? 2 * 1024 ** 3);
let basePublicUrl = process.env.PUBLIC_URL ?? `http://127.0.0.1:${port}`;
const optionalNumber = (value: string | undefined) => (value ? Number(value) : undefined);
// Addresses come only from here, never from a request or a discovery document.
const baseOidc: OidcSettings = {
  issuer: process.env.OIDC_ISSUER ?? '',
  authorizationUrl: process.env.OIDC_AUTHORIZATION_URL ?? '',
  tokenUrl: process.env.OIDC_TOKEN_URL ?? '',
  jwksUrl: process.env.OIDC_JWKS_URL ?? '',
  clientId: process.env.OIDC_CLIENT_ID ?? '',
  clientSecret: process.env.OIDC_CLIENT_SECRET ?? '',
  scope: process.env.OIDC_SCOPE || undefined,
  algorithms: process.env.OIDC_ALGORITHMS?.split(',').map((s) => s.trim()).filter(Boolean),
  label: process.env.OIDC_LABEL || undefined,
};

export const config = {
  version: release.version,
  build: release.build,
  port,
  host: process.env.HOST ?? '127.0.0.1',
  databaseUrl:
    process.env.DATABASE_URL ?? 'postgres://aitracker:aitracker@127.0.0.1:5433/aitracker',
  db: {
    /** The pg default of 10 unless set. */
    poolMax: optionalNumber(process.env.DB_POOL_MAX),
    /** Connections are replaced after this long; none by default. */
    maxLifetimeSeconds: optionalNumber(process.env.DB_MAX_LIFETIME_SECONDS),
    /** Connections start with an empty search_path and take their schema from the scope. */
    scoped: process.env.DB_SCOPED === '1',
    /** With DB_SCOPED: the schema for work outside any scope. Without one, such SQL fails. */
    schema: process.env.DB_SCHEMA ?? '',
    /** With DB_SCOPED: how many pool connections one schema may hold; no limit by default. */
    maxPerSchema: optionalNumber(process.env.DB_MAX_CONNECTIONS_PER_SCHEMA),
  },
  // These follow the scope of the current request; see scope.ts.
  get dataDir() {
    return currentScope()?.dataDir ?? baseDataDir;
  },
  publicDir: resolve(root, 'public'),
  migrationsDir: resolve(root, 'migrations'),
  get maxUploadBytes() {
    return currentScope()?.maxUploadBytes ?? baseMaxUploadBytes;
  },
  // Public base URL agents see in upload hints returned by MCP tools.
  get publicUrl() {
    return currentScope()?.publicUrl ?? basePublicUrl;
  },
  set publicUrl(url: string) {
    basePublicUrl = url;
  },
  get webauthn() {
    const url = currentScope()?.publicUrl;
    if (!url) return baseWebauthn;
    return { ...baseWebauthn, origins: [new URL(url).origin], rpId: new URL(url).hostname };
  },
  sessionDays: Number(process.env.SESSION_DAYS ?? 90),
  twoFactor: {
    secret: process.env.TWO_FACTOR_SECRET ?? '',
    smtpHost: process.env.SMTP_HOST ?? '',
    smtpPort: Number(process.env.SMTP_PORT ?? 587),
    smtpUser: process.env.SMTP_USER ?? '',
    smtpPassword: process.env.SMTP_PASSWORD ?? '',
    emailFrom: process.env.EMAIL_FROM ?? '',
    telegramGatewayToken: process.env.TELEGRAM_GATEWAY_TOKEN ?? '',
  },
  socialAuth: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID ?? '',
      clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
    },
    telegram: {
      clientId: process.env.TELEGRAM_CLIENT_ID ?? '',
      clientSecret: process.env.TELEGRAM_CLIENT_SECRET ?? '',
    },
    // Follows the scope, so each organization of a shared process can have a client of its own.
    get oidc() {
      return currentScope()?.oidc ?? baseOidc;
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
