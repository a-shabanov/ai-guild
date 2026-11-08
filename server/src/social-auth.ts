import { createHash, randomBytes } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { config } from './config.ts';
import { hashKey, requireAdmin, type Actor } from './auth.ts';
import { pool, q, q1, type Row } from './db.ts';
import { HttpError } from './errors.ts';

export type Provider = 'google' | 'telegram' | 'oidc';
const random = () => randomBytes(32).toString('base64url');
export const pkceChallenge = (value: string) => createHash('sha256').update(value).digest('base64url');

// Endpoints are fixed, never taken from a request or an unverified JWT.
export const providers = {
  google: {
    authorization: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    jwks: 'https://www.googleapis.com/oauth2/v3/certs',
    issuer: ['https://accounts.google.com', 'accounts.google.com'],
    scope: 'openid email profile',
  },
  telegram: {
    authorization: 'https://oauth.telegram.org/auth',
    token: 'https://oauth.telegram.org/token',
    jwks: 'https://oauth.telegram.org/.well-known/jwks.json',
    issuer: ['https://oauth.telegram.org'],
    scope: 'openid profile',
  },
};
const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export function providerName(value: unknown): Provider {
  if (value !== 'google' && value !== 'telegram' && value !== 'oidc') throw new HttpError(404, 'unknown sign-in provider');
  return value;
}

const isLocal = (hostname: string) => ['localhost', '127.0.0.1', '[::1]'].includes(hostname) || hostname.endsWith('.localhost');
function isSafeUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return !url.username && !url.password && !url.hash && (url.protocol === 'https:' || (url.protocol === 'http:' && isLocal(url.hostname)));
  } catch { return false; }
}
// A shared secret here would let anyone holding the client secret forge an ID token.
const asymmetricAlgorithms = new Set(['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512', 'EdDSA']);

// Null until every setting is present and safe: a half-filled provider must not appear at all.
function oidcEndpoints() {
  const c = config.socialAuth.oidc;
  const algorithms = c.algorithms?.length ? c.algorithms : ['RS256', 'ES256'];
  if (!c.clientId || !c.clientSecret || ![c.issuer, c.authorizationUrl, c.tokenUrl, c.jwksUrl].every(isSafeUrl) ||
      !algorithms.every((a) => asymmetricAlgorithms.has(a))) return null;
  return {
    clientId: c.clientId, clientSecret: c.clientSecret, authorization: c.authorizationUrl, token: c.tokenUrl, jwks: c.jwksUrl,
    issuer: [c.issuer], scope: c.scope ?? 'openid email profile', algorithms,
  };
}

export function configured(provider: Provider): boolean {
  if (provider === 'oidc') return Boolean(oidcEndpoints());
  const c = config.socialAuth[provider];
  return Boolean(c.clientId && c.clientSecret);
}

// Otherwise a typo looks exactly like nothing was set. Names the settings, never their values.
if (Object.values(config.socialAuth.oidc).some(Boolean) && !configured('oidc')) {
  console.warn('OIDC sign-in is off: OIDC_ISSUER, OIDC_AUTHORIZATION_URL, OIDC_TOKEN_URL, OIDC_JWKS_URL, OIDC_CLIENT_ID and OIDC_CLIENT_SECRET are all required, addresses must use HTTPS, algorithms must be asymmetric.');
}

/** What the sign-in button calls the configured provider; null when there is none. */
export const oidcLabel = (): string | null => (configured('oidc') ? config.socialAuth.oidc.label ?? 'SSO' : null);

function settings(provider: Provider) {
  if (!configured(provider)) throw new HttpError(503, 'sign-in provider is not configured');
  const origin = new URL(config.publicUrl).origin;
  const url = new URL(origin);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocal(url.hostname))) {
    throw new HttpError(503, 'social sign-in requires a public HTTPS URL');
  }
  const redirectUri = `${origin}/api/auth/${provider}/callback`;
  if (provider === 'oidc') return { ...oidcEndpoints()!, redirectUri };
  return { ...config.socialAuth[provider], ...providers[provider], algorithms: ['RS256'], redirectUri };
}

// With the issuer, so a new provider that reuses a subject never gets someone else's account.
const oidcSubject = (issuer: string, subject: string) => `${issuer}#${subject}`;

/** The account already tied to this person at the configured provider, so a repeat never makes a second one. */
export async function oidcAccount(subject: string): Promise<number | null> {
  const { issuer: [issuer] } = settings('oidc');
  const found = await q1(
    `select a.id from account_identities i join accounts a on a.id = i.account_id
     where i.provider = 'oidc' and i.subject = $1 and a.deleted_at is null`, [oidcSubject(issuer!, subject)]);
  return found ? Number(found.id) : null;
}

/**
 * Binds an account to a person at the OIDC provider, for a service that vouches for both, such as one that
 * runs the provider and holds the list of members. Sign-in itself never creates or matches accounts.
 */
export async function linkOidcIdentity(accountId: number, subject: string, label: string): Promise<void> {
  const { issuer: [issuer] } = settings('oidc');
  try {
    const linked = await q1(
      `insert into account_identities(account_id, provider, subject, label)
       select a.id, 'oidc', $2, $3 from accounts a where a.id = $1 and a.kind = 'human' and a.deleted_at is null
       on conflict (provider, subject) do update set label = excluded.label
         where account_identities.account_id = excluded.account_id
       returning id`, [accountId, oidcSubject(issuer!, subject), label.slice(0, 255)]);
    if (!linked) throw new HttpError(409, 'provider account is already linked');
  } catch (error) {
    if ((error as { code?: string }).code === '23505') throw new HttpError(409, 'provider is already linked; unlink it first');
    throw error;
  }
}

function authorizationUrl(provider: Provider, state: string, flow: Row): string {
  const c = settings(provider);
  const url = new URL(c.authorization);
  url.search = new URLSearchParams({
    client_id: c.clientId, redirect_uri: c.redirectUri, response_type: 'code',
    scope: c.scope, state, nonce: flow.nonce,
    code_challenge: pkceChallenge(flow.verifier), code_challenge_method: 'S256',
    ...(provider === 'google' && { prompt: 'select_account' }),
  }).toString();
  return url.href;
}

export async function begin(
  provider: Provider,
  link?: { actor: Actor; credential: string },
  nativeChallenge?: string,
  invitationToken?: string,
): Promise<{ authorization_url: string; browser?: string }> {
  settings(provider);
  const invitation = invitationToken ? await inspectInvitation(invitationToken) : null;
  if (invitation && (link || nativeChallenge)) throw new HttpError(400, 'open the invitation in your browser');
  if (link && link.actor.kind !== 'human') throw new HttpError(403, 'only human accounts can link sign-in providers');
  const state = random();
  const browser = nativeChallenge ? null : random();
  const ticket = nativeChallenge ? random() : null;
  const flow = { verifier: random(), nonce: random() };
  await q('delete from auth_flows where expires_at < now()');
  await q('delete from auth_exchanges where expires_at < now()');
  await q(
    `insert into auth_flows(state_hash, provider, browser_hash, ticket_hash, verifier, nonce,
       account_id, link_credential_hash, native_challenge, invitation_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [hashKey(state), provider, browser && hashKey(browser), ticket && hashKey(ticket), flow.verifier,
      flow.nonce, link?.actor.id ?? invitation?.account_id ?? null, link ? hashKey(link.credential) : null,
      nativeChallenge ?? null, invitation?.id ?? null],
  );
  if (ticket) {
    // The system browser claims the ticket and gets its own binding cookie.
    return { authorization_url: `${new URL(config.publicUrl).origin}/api/auth/${provider}/browser?ticket=${ticket}&state=${state}` };
  }
  return { authorization_url: authorizationUrl(provider, state, flow), browser: browser! };
}

export async function claimBrowser(provider: Provider, ticket: string, state: string) {
  const browser = random();
  const flow = await q1(
    `update auth_flows set ticket_hash = null, browser_hash = $1
     where state_hash = $2 and ticket_hash = $3 and provider = $4 and expires_at > now()
     returning *`, [hashKey(browser), hashKey(state), hashKey(ticket), provider],
  );
  if (!flow) throw new HttpError(400, 'invalid or expired sign-in');
  return { browser, authorization_url: authorizationUrl(provider, state, flow) };
}

export async function consumeFlow(provider: Provider, state: string, browser: string | undefined): Promise<Row> {
  if (!browser) throw new HttpError(400, 'invalid or expired sign-in');
  const flow = await q1(
    `delete from auth_flows where state_hash = $1 and browser_hash = $2 and provider = $3
      and expires_at > now() returning *`, [hashKey(state), hashKey(browser), provider],
  );
  if (!flow) throw new HttpError(400, 'invalid or expired sign-in');
  return flow;
}

async function identity(provider: Provider, code: string, flow: Row) {
  const c = settings(provider);
  const body = new URLSearchParams({
    grant_type: 'authorization_code', code, redirect_uri: c.redirectUri,
    client_id: c.clientId, code_verifier: flow.verifier,
  });
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' };
  if (provider === 'telegram') {
    headers.Authorization = `Basic ${Buffer.from(`${c.clientId}:${c.clientSecret}`).toString('base64')}`;
  } else if (provider === 'oidc') {
    // The default method of the OpenID Connect specification, which encodes both parts.
    headers.Authorization = `Basic ${Buffer.from(`${encodeURIComponent(c.clientId)}:${encodeURIComponent(c.clientSecret)}`).toString('base64')}`;
  } else {
    body.set('client_secret', c.clientSecret);
  }
  try {
    const response = await fetch(c.token, { method: 'POST', headers, body, signal: AbortSignal.timeout(10_000), redirect: 'error' });
    if (!response.ok) throw new Error('token exchange failed');
    const tokens = await response.json() as { id_token?: unknown };
    if (typeof tokens.id_token !== 'string' || tokens.id_token.length > 32_768) throw new Error('missing ID token');
    let keys = keySets.get(c.jwks);
    if (!keys) {
      keys = createRemoteJWKSet(new URL(c.jwks), { timeoutDuration: 10_000 });
      keySets.set(c.jwks, keys);
    }
    const { payload } = await jwtVerify(tokens.id_token, keys, {
      issuer: c.issuer, audience: c.clientId, algorithms: c.algorithms,
      requiredClaims: ['sub', 'iat', 'exp', 'nonce'], maxTokenAge: '10m', clockTolerance: 5,
    });
    if (payload.nonce !== flow.nonce || !payload.sub || payload.sub.length > 255 ||
        (payload.azp !== undefined && payload.azp !== c.clientId) ||
        (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== c.clientId)) {
      throw new Error('invalid ID token');
    }
    const label = provider !== 'telegram' && payload.email_verified === true && typeof payload.email === 'string'
      ? payload.email : typeof payload.preferred_username === 'string' ? `@${payload.preferred_username}`
        : typeof payload.name === 'string' ? payload.name : provider;
    return { subject: provider === 'oidc' ? oidcSubject(c.issuer[0]!, payload.sub) : payload.sub, label: label.slice(0, 255) };
  } catch {
    // Provider responses may contain codes, credentials and tokens. Never log them.
    throw new HttpError(401, 'provider verification failed');
  }
}

export async function complete(provider: Provider, code: string, flow: Row): Promise<{ actor: Actor; identityId: number }> {
  const external = await identity(provider, code, flow);
  const client = await pool.connect();
  try {
    await client.query('begin');
    let actor: Actor;
    let identityId: number;
    if (flow.account_id) {
      const found = await client.query(
        `select a.id, a.name, a.kind, a.system, a.role from accounts a
         where a.id = $1 and not a.disabled and a.kind = 'human' and
           ($3::boolean or a.key_hash = $2 or exists (select 1 from sessions s where s.account_id = a.id
              and s.token_hash = $2 and s.expires_at > now())) for update`,
        [flow.account_id, flow.link_credential_hash, Boolean(flow.invitation_id)],
      );
      if (!found.rows[0]) throw new HttpError(401, 'linking session expired');
      actor = found.rows[0] as Actor;
      if (flow.invitation_id) {
        const invitation = await client.query(
          `update account_invitations set used_at = now() where id = $1 and account_id = $2
           and used_at is null and expires_at > now() returning id`, [flow.invitation_id, flow.account_id]);
        if (!invitation.rowCount) throw new HttpError(403, 'invitation is invalid or expired');
      }
      // Never infer ownership from an email, display name or Telegram username.
      const linked = await client.query(
        `insert into account_identities(account_id, provider, subject, label) values ($1,$2,$3,$4)
         on conflict (provider, subject) do update set label = excluded.label
           where account_identities.account_id = excluded.account_id
         returning id`, [actor.id, provider, external.subject, external.label],
      );
      if (!linked.rowCount) throw new HttpError(409, 'provider account is already linked');
      identityId = linked.rows[0].id;
    } else {
      const found = await client.query(
        `select a.id, a.name, a.kind, a.system, a.role, i.id as identity_id from account_identities i
         join accounts a on a.id = i.account_id
         where i.provider = $1 and i.subject = $2 and not a.disabled and a.kind = 'human'
         for update of a, i`, [provider, external.subject],
      );
      if (!found.rows[0]) throw new HttpError(403, 'provider account is not linked');
      const { identity_id, ...account } = found.rows[0];
      actor = account as Actor;
      identityId = identity_id;
      await client.query('update account_identities set last_used_at = now(), label = $3 where provider = $1 and subject = $2',
        [provider, external.subject, external.label]);
    }
    await client.query('commit');
    return { actor, identityId };
  } catch (error) {
    await client.query('rollback');
    if ((error as { code?: string }).code === '23505') throw new HttpError(409, 'provider is already linked; unlink it first');
    throw error;
  } finally { client.release(); }
}

export async function nativeResult(actor: Actor, provider: Provider, flow: Row, identityId: number): Promise<string> {
  const code = random();
  await q(`insert into auth_exchanges(code_hash, account_id, provider, challenge, linking, identity_id)
    values ($1,$2,$3,$4,$5,$6)`, [hashKey(code), actor.id, provider, flow.native_challenge, Boolean(flow.account_id), identityId]);
  return code;
}

export async function exchange(code: string, verifier: string): Promise<{ actor: Actor; provider: Provider; linking: boolean; identityId: number }> {
  const result = await q1(
    `delete from auth_exchanges where code_hash = $1 and challenge = $2 and expires_at > now() returning *`,
    [hashKey(code), pkceChallenge(verifier)],
  );
  if (!result) throw new HttpError(400, 'invalid or expired sign-in');
  const actor = await q1(`select id, name, kind, system, role from accounts where id = $1 and not disabled and kind = 'human'`, [result.account_id]);
  if (!actor) throw new HttpError(401, 'account is disabled');
  // An unlink between callback and exchange must invalidate the pending sign-in too.
  if (!await q1('select id from account_identities where account_id = $1 and provider = $2', [actor.id, result.provider])) {
    throw new HttpError(401, 'provider account is not linked');
  }
  return { actor: actor as Actor, provider: result.provider, linking: result.linking, identityId: result.identity_id };
}

export async function listIdentities(actor: Actor) {
  return q('select provider, label, created_at, last_used_at from account_identities where account_id = $1 order by provider', [actor.id]);
}

export async function unlink(actor: Actor, provider: Provider) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('select id from accounts where id = $1 for update', [actor.id]);
    await client.query('delete from account_identities where account_id = $1 and provider = $2', [actor.id, provider]);
    await client.query('delete from sessions where account_id = $1 and method = $2', [actor.id, provider]);
    await client.query('delete from auth_flows where account_id = $1 and provider = $2', [actor.id, provider]);
    await client.query('delete from auth_exchanges where account_id = $1 and provider = $2', [actor.id, provider]);
    await client.query('commit');
  } catch (error) { await client.query('rollback'); throw error; }
  finally { client.release(); }
}

export async function createInvitation(actor: Actor, accountId: number) {
  requireAdmin(actor);
  const token = random();
  // Reissuing also invalidates old, unfinished OAuth flows via ON DELETE CASCADE.
  const client = await pool.connect();
  try {
    await client.query('begin');
    const account = (await client.query('select kind, disabled from accounts where id=$1 and deleted_at is null for update', [accountId])).rows[0];
    if (!account) throw new HttpError(404, 'account not found');
    if (account.kind !== 'human' || account.disabled) throw new HttpError(400, 'invitation requires an enabled human account');
    await client.query('delete from account_invitations where account_id = $1', [accountId]);
    const result = await client.query(`insert into account_invitations(account_id, token_hash, created_by)
      values ($1,$2,$3) returning expires_at`, [accountId, hashKey(token), actor.id]);
    await client.query('commit');
    return { url: `${new URL(config.publicUrl).origin}/#/invite/${token}`, expires_at: result.rows[0].expires_at };
  } catch (error) { await client.query('rollback'); throw error; }
  finally { client.release(); }
}

export async function inspectInvitation(token: string): Promise<Row> {
  const invite = await q1(`select i.id, i.account_id, a.name, i.expires_at from account_invitations i
    join accounts a on a.id = i.account_id where i.token_hash = $1 and i.used_at is null
    and i.expires_at > now() and not a.disabled and a.kind = 'human'`, [hashKey(token)]);
  if (!invite) throw new HttpError(403, 'invitation is invalid or expired');
  return invite;
}
