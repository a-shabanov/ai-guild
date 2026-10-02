import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { pool, q, q1, type Row } from './db.ts';
import { hashKey, SESSION_PREFIX, type Actor } from './auth.ts';
import { HttpError } from './errors.ts';

const derive = (code: string, salt: string, size: number, options: {N:number;r:number;p:number;maxmem:number}) =>
  new Promise<Buffer>((resolve,reject) => scrypt(code,salt,size,options,(error,key) => error ? reject(error) : resolve(key)));
const options = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
export async function hashPasscode(code: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const hash = await derive(code, salt, 32, options) as Buffer;
  return `${salt}:${hash.toString('hex')}`;
}
async function matches(code: string, stored: string): Promise<boolean> {
  const [salt, hash] = stored.split(':');
  const candidate = await derive(code, salt, 32, options) as Buffer;
  const expected = Buffer.from(hash, 'hex');
  return expected.length === candidate.length && timingSafeEqual(expected, candidate);
}
export function sessionHash(token: string | undefined): string {
  if (!token?.startsWith(SESSION_PREFIX)) throw new HttpError(403, 'app lock requires a saved session');
  return hashKey(token);
}
const metadata = (row: Row) => ({
  configured: !!row.app_passcode_hash, locked: !!row.app_locked_at,
  setup_skipped: row.app_passcode_setup_skipped, biometric: row.app_biometric_unlock, retry_at: row.app_passcode_retry_at,
});
export async function status(actor: Actor, token: string | undefined) {
  const row = await q1('select * from sessions where token_hash=$1 and account_id=$2 and expires_at>now()', [sessionHash(token), actor.id]);
  if (!row) throw new HttpError(401, 'session expired');
  const passkeys = await q1('select id from passkeys where account_id=$1 limit 1', [actor.id]);
  return { ...metadata(row), passkey_available: !!passkeys };
}
export async function lock(actor: Actor, token: string | undefined) {
  await q(`update sessions set app_locked_at=case when app_passcode_hash is not null then now() else null end
    where token_hash=$1 and account_id=$2`, [sessionHash(token), actor.id]);
  return status(actor, token);
}
// Row locks serialize attempts and configuration, and failures commit before being reported.
async function withSession(actor: Actor, token: string | undefined, fn: (row: Row) => Promise<Record<string, unknown> | HttpError>) {
  const client = await pool.connect();
  let result;
  try {
    await client.query('begin');
    const row = (await client.query('select * from sessions where token_hash=$1 and account_id=$2 and expires_at>now() for update', [sessionHash(token), actor.id])).rows[0];
    if (!row) throw new HttpError(401, 'session expired');
    result = await fn({ ...row, db: client });
    await client.query('commit');
  } catch (error) {
    await client.query('rollback'); throw error;
  } finally { client.release(); }
  if (result instanceof HttpError) throw result;
  return result;
}
async function check(row: Row, code: string): Promise<HttpError | undefined> {
  if (row.app_passcode_retry_at && new Date(row.app_passcode_retry_at).getTime() > Date.now()) return new HttpError(429, 'passcode temporarily locked');
  if (!row.app_passcode_hash) return new HttpError(400, 'set an app passcode first');
  if (await matches(code, row.app_passcode_hash)) return;
  const attempts = row.app_passcode_attempts + 1;
  const seconds = attempts >= 5 ? Math.min(300, 30 * 2 ** Math.min(attempts - 5, 4)) : 0;
  await row.db.query(`update sessions set app_passcode_attempts=$2,
    app_passcode_retry_at=case when $3::int>0 then now()+make_interval(secs=>$3::int) else null end where id=$1`, [row.id, attempts, seconds]);
  return new HttpError(seconds ? 429 : 400, seconds ? 'passcode temporarily locked' : 'incorrect app passcode');
}
export async function unlock(actor: Actor, token: string | undefined, code: string) {
  return withSession(actor, token, async row => {
    const failure = await check(row, code); if (failure) return failure;
    await row.db.query('update sessions set app_locked_at=null, app_passcode_attempts=0, app_passcode_retry_at=null where id=$1', [row.id]);
    return { ok: true };
  });
}
export async function configure(actor: Actor, token: string | undefined, input: { code: string; current_code?: string; biometric: boolean }) {
  return withSession(actor, token, async row => {
    if (row.app_locked_at) return new HttpError(423, 'app is locked');
    if (row.app_passcode_hash) {
      const failure = await check(row, input.current_code ?? ''); if (failure) return failure;
    }
    if (input.biometric && !(await row.db.query('select id from passkeys where account_id=$1 limit 1', [actor.id])).rows.length) return new HttpError(400, 'add a passkey first');
    await row.db.query(`update sessions set app_passcode_hash=$2, app_biometric_unlock=$3,
      app_passcode_attempts=0, app_passcode_retry_at=null where id=$1`, [row.id, await hashPasscode(input.code), input.biometric]);
    return { ok: true };
  });
}
export async function unlockWithPasskey(actor: Actor, token: string | undefined) {
  await q(`update sessions set app_locked_at=null,app_passcode_attempts=0,app_passcode_retry_at=null
    where token_hash=$1 and account_id=$2 and app_biometric_unlock and app_passcode_hash is not null`, [sessionHash(token), actor.id]);
}

// Dismiss only the optional enrollment offer; a configured PIN cannot be bypassed.
export async function skipSetup(actor: Actor, token: string | undefined) {
  return withSession(actor, token, async row => {
    if (row.app_passcode_hash || row.app_locked_at) return new HttpError(409, 'app passcode is already configured');
    await row.db.query('update sessions set app_passcode_setup_skipped=true where id=$1', [row.id]);
    return {ok:true};
  });
}
export async function enableBiometric(actor: Actor, token: string | undefined) {
  return withSession(actor, token, async row => {
    if (!row.app_passcode_hash || row.app_locked_at) return new HttpError(423, 'app is locked');
    await row.db.query('update sessions set app_biometric_unlock=true where id=$1', [row.id]);
    return {ok:true};
  });
}
