import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import nodemailer from 'nodemailer';
import type { PoolClient } from 'pg';
import { config } from './config.ts';
import { hashKey, requireAdmin, SESSION_PREFIX, type Actor, type SessionMethod } from './auth.ts';
import { pool, q, q1, type Row } from './db.ts';
import { HttpError } from './errors.ts';

export type Channel = 'email' | 'telegram';
const random = () => randomBytes(32).toString('base64url');
const message = (code: string) => `AI Tracker: код подтверждения ${code}. Действует 5 минут. Никому не сообщайте этот код. Если вы не запрашивали его, проигнорируйте сообщение.`;
export const delivery = {
  async email(destination: string, code: string) {
    const c = config.twoFactor;
    const transport = nodemailer.createTransport({ host: c.smtpHost, port: c.smtpPort,
      secure: c.smtpPort === 465, requireTLS: true,
      auth: c.smtpUser ? { user: c.smtpUser, pass: c.smtpPassword } : undefined,
      connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 15_000,
      disableFileAccess: true, disableUrlAccess: true, logger: false, debug: false });
    await transport.sendMail({ from: c.emailFrom, to: destination, subject: 'Код подтверждения AI Tracker', text: message(code) });
  },
  async telegram(destination: string, code: string) {
    const response = await fetch('https://gatewayapi.telegram.org/sendVerificationMessage', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.twoFactor.telegramGatewayToken}` },
      body: JSON.stringify({ phone_number: destination, code, ttl: 300 }),
      signal: AbortSignal.timeout(10_000), redirect: 'error',
    });
    const result = await response.json() as { ok?: boolean };
    if (!response.ok || result.ok !== true) throw new Error('delivery failed');
  },
};

export function available() {
  const c = config.twoFactor;
  const secret = c.secret.length >= 32;
  return { email: secret && Boolean(c.smtpHost && c.emailFrom),
    telegram: secret && Boolean(c.telegramGatewayToken) };
}
export const masked = (channel: Channel, destination: string) => channel === 'email'
  ? destination.replace(/^(.)([^@]*)@/, '$1***@') : `Telegram •••${destination.slice(-4)}`;
const digest = (tokenHash: string, code: string) => createHmac('sha256', config.twoFactor.secret).update(`${tokenHash}:${code}`).digest('hex');
const equal = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

async function transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try { await client.query('begin'); const result = await fn(client); await client.query('commit'); return result; }
  catch (error) { await client.query('rollback'); throw error; }
  finally { client.release(); }
}
async function lock(client: PoolClient, accountId: number): Promise<Row> {
  const result = await client.query('select * from accounts where id=$1 and not disabled and kind=\'human\' for update',[accountId]);
  if (!result.rows[0]) throw new HttpError(401, 'Аккаунт недоступен');
  if (result.rows[0].two_factor_locked_until && new Date(result.rows[0].two_factor_locked_until).getTime() > Date.now()) {
    throw new HttpError(429, 'Слишком много неверных кодов. Повторите через 15 минут.');
  }
  return result.rows[0];
}
async function fresh(client: PoolClient, actor: Actor, credential: string): Promise<Row> {
  if (!credential.startsWith(SESSION_PREFIX)) throw new HttpError(403, 'Войдите в браузере или приложении заново');
  const result = await client.query(`select s.* from sessions s where s.account_id=$1 and s.token_hash=$2 and s.expires_at>now()
    and case when exists(select 1 from account_second_factors f where f.account_id=$1)
      then s.two_factor_at>now()-interval '5 minutes' else s.created_at>now()-interval '10 minutes' end`,[actor.id,hashKey(credential)]);
  if (!result.rows[0]) throw new HttpError(403,'Для изменения 2FA выйдите и войдите снова');
  return result.rows[0];
}
async function throttle(client: PoolClient, account: Row) {
  const now = Date.now();
  if (account.two_factor_sent_at && now-new Date(account.two_factor_sent_at).getTime()<60_000) throw new HttpError(429,'Повторная отправка доступна через минуту');
  const recent = account.two_factor_send_window && now-new Date(account.two_factor_send_window).getTime()<3600_000;
  if (recent && account.two_factor_send_count>=5) throw new HttpError(429,'Достигнут лимит отправок. Повторите через час.');
  await client.query(`update accounts set two_factor_sent_at=now(),two_factor_send_window=case when $2 then two_factor_send_window else now() end,
    two_factor_send_count=case when $2 then two_factor_send_count+1 else 1 end where id=$1`,[account.id,Boolean(recent)]);
}
async function sendCode(channel: Channel, destination: string, code: string) {
  if (!available()[channel]) throw new HttpError(503,'Отправка кодов этим способом пока не настроена');
  try { await delivery[channel](destination,code); }
  catch { throw new HttpError(502,channel==='telegram' ? 'Не удалось отправить код в Telegram. Проверьте номер и повторите позже.' : 'Не удалось отправить письмо. Повторите позже.'); }
}
async function methods(accountId: number) {
  const rows = await q('select channel,destination from account_second_factors where account_id=$1 order by channel',[accountId]);
  return rows.map(row=>({ channel:row.channel as Channel, masked:masked(row.channel,row.destination), available:available()[row.channel as Channel] }));
}
export async function settings(actor: Actor) {
  const channels = await methods(actor.id);
  return { enabled: Boolean(channels.length), methods: channels, available: available() };
}
export async function beginLogin(actor: Actor, method: SessionMethod, identityId?: number, key?: string) {
  if (actor.kind !== 'human') return null;
  return transaction(async client=>{
    await lock(client,actor.id);
    if (!(await client.query('select id from account_second_factors where account_id=$1',[actor.id])).rowCount) return null;
    const token=random();
    await client.query('delete from two_factor_logins where expires_at<now()');
    // Bounded pending state per account; repeated primary logins never reset the code/attempt limits.
    await client.query(`delete from two_factor_logins where token_hash in (select token_hash from two_factor_logins where account_id=$1 order by expires_at desc offset 9)`,[actor.id]);
    const row=await client.query(`insert into two_factor_logins(token_hash,account_id,method,identity_id,passkey_id,key_hash)
      values($1,$2,$3,$4,$5,$6) returning expires_at`,[hashKey(token),actor.id,method,identityId??null,actor.passkeyId??null,method==='key'&&key?hashKey(key):null]);
    return { two_factor_required:true, challenge_token:token, methods:await methods(actor.id), expires_at:row.rows[0].expires_at };
  });
}
async function login(client: PoolClient, token: string): Promise<Row> {
  const result=await client.query(`select l.* from two_factor_logins l join accounts a on a.id=l.account_id
    where l.token_hash=$1 and l.expires_at>now() and not a.disabled
    and (l.method<>'key' or l.key_hash=a.key_hash)`,[hashKey(token)]);
  if (!result.rows[0]) throw new HttpError(401,'Подтверждение входа истекло. Войдите снова.');
  return result.rows[0];
}
export async function pending(token: string) {
  return transaction(async client=>{const row=await login(client,token); await lock(client,row.account_id);
    return {two_factor_required:true,methods:await methods(row.account_id),expires_at:row.expires_at};});
}
export async function cancel(token:string) { await q('delete from two_factor_logins where token_hash=$1',[hashKey(token)]); return {ok:true}; }
export async function sendLogin(token: string, channel: Channel) {
  const initial=await q1('select account_id from two_factor_logins where token_hash=$1',[hashKey(token)]);
  if (!initial) throw new HttpError(401,'Подтверждение входа истекло. Войдите снова.');
  const result = await transaction(async client=>{
    const account=await lock(client,initial.account_id); const flow=await login(client,token);
    const factor=(await client.query('select * from account_second_factors where account_id=$1 and channel=$2',[account.id,channel])).rows[0];
    if (!factor) throw new HttpError(400,'Способ подтверждения не подключён');
    if (!available()[channel]) throw new HttpError(503,'Отправка кодов этим способом пока не настроена');
    await throttle(client,account);
    await client.query('savepoint delivery');
    const code=String(randomInt(0,1_000_000)).padStart(6,'0');
    await client.query('delete from two_factor_codes where login_hash=$1',[flow.token_hash]);
    await client.query(`insert into two_factor_codes(token_hash,account_id,purpose,login_hash,factor_id,channel,destination,code_hash)
      values($1,$2,'login',$1,$3,$4,$5,$6)`,[flow.token_hash,account.id,factor.id,channel,factor.destination,digest(flow.token_hash,code)]);
    try { await sendCode(channel,factor.destination,code); }
    catch(error) { await client.query('rollback to savepoint delivery'); return {deliveryError:error}; }
    return {sent:true,masked:masked(channel,factor.destination),expires_in:300,resend_after:60};
  });
  if('deliveryError' in result)throw result.deliveryError;
  return result;
}
// Invalid attempts commit their counters. Throwing inside the transaction would undo the lockout.
async function checkCode(client: PoolClient, account: Row, row: Row|undefined, tokenHash: string, code: string) {
  if (!row || new Date(row.expires_at).getTime()<=Date.now() || !equal(row.code_hash,digest(tokenHash,code))) {
    await client.query(`update accounts set two_factor_failures=case when two_factor_locked_until<now() then 1 else two_factor_failures+1 end,
      two_factor_locked_until=case when two_factor_locked_until<now() then null when two_factor_failures>=4 then now()+interval '15 minutes' else two_factor_locked_until end where id=$1`,[account.id]);
    return false;
  }
  await client.query('update accounts set two_factor_failures=0,two_factor_locked_until=null where id=$1',[account.id]);
  return true;
}
export async function verifyLogin(token: string, code: string, userAgent?: string) {
  const initial=await q1('select account_id from two_factor_logins where token_hash=$1',[hashKey(token)]);
  if (!initial) throw new HttpError(401,'Подтверждение входа истекло. Войдите снова.');
  const result=await transaction(async client=>{
    const account=await lock(client,initial.account_id); const flow=await login(client,token);
    const row=(await client.query(`select * from two_factor_codes where token_hash=$1 and purpose='login'`,[flow.token_hash])).rows[0];
    if (!await checkCode(client,account,row,flow.token_hash,code)) return null;
    const session=SESSION_PREFIX+random();
    await client.query(`insert into sessions(token_hash,account_id,method,identity_id,user_agent,expires_at,two_factor_at)
      values($1,$2,$3,$4,$5,now()+make_interval(days=>$6::int),now())`,[hashKey(session),account.id,flow.method,flow.identity_id,userAgent?.slice(0,300)??null,config.sessionDays]);
    await client.query('delete from two_factor_logins where token_hash=$1',[flow.token_hash]);
    const actor:Actor={id:account.id,name:account.name,kind:account.kind,system:account.system,role:account.role};
    return {actor,session};
  });
  if (!result) throw new HttpError(400,'Неверный или просроченный код');
  return result;
}
export async function enroll(actor: Actor, credential: string, channel: Channel, email?: string, phone?: string) {
  const result = await transaction(async client=>{
    const account=await lock(client,actor.id); const session=await fresh(client,actor,credential);
    const destination = channel === 'email' ? email?.trim().toLowerCase() : phone?.trim();
    if (!destination || (channel==='email' && !/^[^\s@,;<>\r\n]+@[^\s@,;<>\r\n]+\.[^\s@,;<>\r\n]+$/.test(destination))
      || (channel==='telegram' && !/^\+[1-9]\d{7,14}$/.test(destination))) {
      throw new HttpError(400, channel === 'email' ? 'Укажите корректный email' : 'Укажите номер Telegram с кодом страны, например +79991234567');
    }
    if (!available()[channel]) throw new HttpError(503,'Отправка кодов этим способом пока не настроена');
    await throttle(client,account);
    await client.query('savepoint delivery');
    const token=random(),tokenHash=hashKey(token),code=String(randomInt(0,1_000_000)).padStart(6,'0');
    await client.query(`delete from two_factor_codes where account_id=$1 and purpose='enroll'`,[actor.id]);
    await client.query(`insert into two_factor_codes(token_hash,account_id,purpose,session_hash,channel,destination,code_hash)
      values($1,$2,'enroll',$3,$4,$5,$6)`,[tokenHash,actor.id,session.token_hash,channel,destination,digest(tokenHash,code)]);
    try { await sendCode(channel,destination,code); }
    catch(error) { await client.query('rollback to savepoint delivery'); return {deliveryError:error}; }
    return {enrollment_token:token,masked:masked(channel,destination),expires_in:300,resend_after:60};
  });
  if('deliveryError' in result)throw result.deliveryError;
  return result;
}
export async function confirmEnrollment(actor: Actor, credential: string, token: string, code: string) {
  const result=await transaction(async client=>{
    const account=await lock(client,actor.id); const session=await fresh(client,actor,credential);
    const tokenHash=hashKey(token);
    const row=(await client.query(`select * from two_factor_codes where token_hash=$1 and account_id=$2 and session_hash=$3 and purpose='enroll'`,[tokenHash,actor.id,session.token_hash])).rows[0];
    if (!await checkCode(client,account,row,tokenHash,code)) return false;
    await client.query(`insert into account_second_factors(account_id,channel,destination) values($1,$2,$3)
      on conflict(account_id,channel) do update set destination=excluded.destination,created_at=now()`,[actor.id,row.channel,row.destination]);
    await client.query('delete from sessions where account_id=$1 and token_hash<>$2',[actor.id,session.token_hash]);
    await client.query('update sessions set two_factor_at=now() where token_hash=$1',[session.token_hash]);
    await client.query('delete from two_factor_logins where account_id=$1',[actor.id]);
    await client.query('delete from two_factor_codes where account_id=$1',[actor.id]);
    await client.query('delete from auth_flows where account_id=$1',[actor.id]);
    await client.query('delete from auth_exchanges where account_id=$1',[actor.id]);
    return true;
  });
  if (!result) throw new HttpError(400,'Неверный или просроченный код');
  return {ok:true};
}
export async function remove(actor: Actor, credential: string, channel: Channel) {
  await transaction(async client=>{await lock(client,actor.id); const session=await fresh(client,actor,credential);
    await client.query('delete from account_second_factors where account_id=$1 and channel=$2',[actor.id,channel]);
    await client.query('delete from sessions where account_id=$1 and token_hash<>$2',[actor.id,session.token_hash]);
    await client.query('delete from two_factor_logins where account_id=$1',[actor.id]);
    await client.query('delete from two_factor_codes where account_id=$1',[actor.id]);});
  return {ok:true};
}
export async function reset(actor: Actor, credential: string, accountId: number) {
  requireAdmin(actor);
  await transaction(async client=>{await fresh(client,actor,credential);
    const row=(await client.query(`select id from accounts where id=$1 and kind='human' for update`,[accountId])).rows[0];
    if (!row) throw new HttpError(404,'Аккаунт не найден');
    await client.query('delete from account_second_factors where account_id=$1',[accountId]);
    await client.query('delete from sessions where account_id=$1',[accountId]);
    await client.query('delete from two_factor_logins where account_id=$1',[accountId]);
    await client.query('delete from two_factor_codes where account_id=$1',[accountId]);
    await client.query('update accounts set two_factor_failures=0,two_factor_locked_until=null where id=$1',[accountId]);
  }); return {ok:true};
}
