import { createHash, randomBytes } from 'node:crypto';
import { config } from './config.ts';
import { q, q1 } from './db.ts';
import { HttpError } from './errors.ts';

export type Actor = {
  id: number;
  name: string;
  kind: 'human' | 'agent';
  system: string | null;
  role: 'admin' | 'member';
  /** Recording past work: what is written now must not notify anyone. */
  history?: boolean;
  passkeyId?: number;
};

export const KEY_PREFIX = 'ait_';
export const SESSION_PREFIX = 'ats_';
export type SessionMethod = 'key' | 'passkey' | 'google' | 'telegram';

export function generateKey(): string {
  return KEY_PREFIX + randomBytes(32).toString('base64url');
}

export function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

export async function createSession(
  accountId: number,
  method: SessionMethod,
  userAgent?: string,
  identityId?: number,
): Promise<string> {
  const token = SESSION_PREFIX + randomBytes(32).toString('base64url');
  if (method === 'google' || method === 'telegram') {
    const session = await q1(
      `insert into sessions(token_hash, account_id, method, user_agent, expires_at, identity_id)
       select $1, a.id, $3, $4, now() + make_interval(days => $5::int), i.id
       from accounts a join account_identities i on i.account_id = a.id
       where a.id = $2 and not a.disabled and i.provider = $3 and i.id = $6
       and not exists(select 1 from account_second_factors f where f.account_id = a.id) returning id`,
      [hashKey(token), accountId, method, userAgent?.slice(0, 300) ?? null, config.sessionDays, identityId],
    );
    if (!session) throw new HttpError(401, 'provider account is not linked');
  } else {
    const session = await q1(
    `insert into sessions(token_hash, account_id, method, user_agent, expires_at)
     select $1, a.id, $3, $4, now() + make_interval(days => $5::int) from accounts a
     where a.id=$2 and not a.disabled and not exists(select 1 from account_second_factors f where f.account_id=a.id) returning id`,
    [hashKey(token), accountId, method, userAgent?.slice(0, 300) ?? null, config.sessionDays],
    );
    if (!session) throw new HttpError(401, 'two-factor confirmation required');
  }
  q('delete from sessions where expires_at < now()').catch(() => {});
  return token;
}

export async function destroySession(token: string | undefined): Promise<void> {
  if (token?.startsWith(SESSION_PREFIX)) {
    await q('delete from sessions where token_hash = $1', [hashKey(token)]);
  }
}

async function authenticateSession(token: string, allowLocked = false): Promise<Actor> {
  const row = await q1(
    `update sessions s set last_used_at = now()
       from accounts a
      where s.token_hash = $1 and s.expires_at > now() and a.id = s.account_id and not a.disabled
        and (s.two_factor_at is not null or not exists(select 1 from account_second_factors f where f.account_id=a.id))
      returning a.id, a.name, a.kind, a.system, a.role, s.app_locked_at`,
    [hashKey(token)],
  );
  if (!row) throw new HttpError(401, 'session expired');
  if (row.app_locked_at && !allowLocked) throw new HttpError(423, 'app is locked');
  delete row.app_locked_at;
  q('update accounts set last_seen_at = now() where id = $1', [row.id]).catch(() => {});
  return row as Actor;
}

export async function authenticate(key: string | undefined, primaryOnly = false, allowLocked = false): Promise<Actor> {
  if (key?.startsWith(SESSION_PREFIX)) return authenticateSession(key, allowLocked);
  if (!key || !key.startsWith(KEY_PREFIX)) throw new HttpError(401, 'missing or malformed API key');
  const row = await q1(
    'select id, name, kind, system, role, disabled from accounts where key_hash = $1',
    [hashKey(key)],
  );
  if (!row || row.disabled) throw new HttpError(401, 'invalid API key');
  if (!primaryOnly && row.kind === 'human' && await q1('select id from account_second_factors where account_id=$1 limit 1',[row.id])) {
    throw new HttpError(401, 'two-factor confirmation required');
  }
  // Fire and forget: last_seen is informational only.
  q('update accounts set last_seen_at = now() where id = $1', [row.id]).catch(() => {});
  return { id: row.id, name: row.name, kind: row.kind, system: row.system, role: row.role };
}

export function requireAdmin(actor: Actor): void {
  if (actor.role !== 'admin') throw new HttpError(403, 'admin role required');
}
