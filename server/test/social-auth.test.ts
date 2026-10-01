import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { fakeOidc } from './helpers/oidc.ts';

const database = new URL(process.env.DATABASE_URL ?? 'postgres://aitracker:aitracker@127.0.0.1:5433/aitracker');
database.pathname = '/aitracker_social_test';
process.env.DATABASE_URL = database.href;
process.env.GOOGLE_CLIENT_ID = process.env.TELEGRAM_CLIENT_ID = 'test-client';
process.env.GOOGLE_CLIENT_SECRET = process.env.TELEGRAM_CLIENT_SECRET = 'test-secret';
const { config } = await import('../src/config.ts');
const social = await import('../src/social-auth.ts');
const db = await import('../src/db.ts');
const svc = await import('../src/service.ts');
const { authenticate, hashKey } = await import('../src/auth.ts');
const { buildApp } = await import('../src/server.ts');
const oidc = await fakeOidc();
let server: Server;
let url: string;
let adminKey: string;
let memberKey: string;
let agentKey: string;
let memberId: number;
let adminId: number;

before(async () => {
  const maintenance = new URL(database); maintenance.pathname = '/postgres';
  const client = new pg.Client({ connectionString: maintenance.href });
  await client.connect();
  await client.query('drop database if exists aitracker_social_test with (force)');
  await client.query('create database aitracker_social_test');
  await client.end();
  await db.migrate();
  const admin = await svc.createAccount({ name: 'admin', kind: 'human', role: 'admin' });
  const member = await svc.createAccount({ name: 'member', kind: 'human', role: 'member' });
  const agent = await svc.createAccount({ name: 'agent', kind: 'agent', role: 'member' });
  adminKey = admin.key; memberKey = member.key; agentKey = agent.key;
  memberId = member.account.id; adminId = admin.account.id;
  server = buildApp().listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  config.publicUrl = url;
  for (const provider of ['google', 'telegram'] as const) {
    social.providers[provider].token = `${oidc.url}/${provider}/token`;
    social.providers[provider].jwks = `${oidc.url}/jwks`;
  }
});
after(async () => { server?.close(); await oidc.close(); await db.pool.end(); });

async function post(path: string, body: unknown = {}, key?: string, origin?: string) {
  return fetch(url + path, { method: 'POST', headers: { 'Content-Type': 'application/json',
    ...(key && { Authorization: `Bearer ${key}` }), ...(origin && { Origin: origin }) }, body: JSON.stringify(body), redirect: 'manual' });
}
const cookies = (r: Response) => r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
async function invitation(id = memberId) {
  const result = await post(`/api/accounts/${id}/invitation`, {}, adminKey);
  assert.equal(result.status, 201);
  const body = await result.json();
  return { ...body, token: new URL(body.url).hash.split('/').at(-1) };
}
async function start(provider = 'google', body = {}, key?: string) {
  const result = await post(`/api/auth/${provider}/start`, body, key, url);
  assert.equal(result.status, 200, await result.clone().text());
  return { response: result, authorization_url: (await result.json()).authorization_url as string, cookie: cookies(result) };
}
async function finish(provider: string, flow: Awaited<ReturnType<typeof start>>, claims = {}, invalidSignature = false) {
  const callback = oidc.issue(provider, flow.authorization_url, claims, invalidSignature);
  return fetch(callback, { headers: { Cookie: flow.cookie }, redirect: 'manual' });
}
async function me(cookie: string) { return fetch(url + '/api/me', { headers: { Cookie: cookie } }); }
async function newPerson(name: string) { return svc.createAccount({ name, kind: 'human', role: 'member' }); }

test('providers advertise availability without credentials; unavailable providers fail clearly', async () => {
  const response = await fetch(url + '/api/config');
  const text = await response.text();
  assert.ok(!text.includes('test-secret') && !text.includes('test-client'));
  assert.deepEqual(JSON.parse(text).providers, { google: true, telegram: true });
  config.socialAuth.google.clientSecret = '';
  assert.equal((await post('/api/auth/google/start')).status, 503);
  config.socialAuth.google.clientSecret = 'test-secret';
  assert.equal((await post('/api/auth/unknown/start')).status, 404);
  const contract = await (await fetch(url + '/api/openapi.json')).json();
  assert.deepEqual(contract.paths['/api/auth/{provider}/start'].post.security, []);
  assert.equal(contract.paths['/api/auth/identities'].get.security, undefined);
  assert.match(contract.paths['/api/accounts/{id}/invitation'].post.summary, /admin only/);
});

test('only admins issue human invitations; tokens are hashed, expiring and replaceable', async () => {
  assert.equal((await post(`/api/accounts/${memberId}/invitation`, {}, memberKey)).status, 403);
  const agent = await authenticate(agentKey);
  assert.equal((await post(`/api/accounts/${agent.id}/invitation`, {}, adminKey)).status, 400);
  const first = await invitation();
  const row = await db.q1('select token_hash from account_invitations where account_id = $1', [memberId]);
  assert.equal(row!.token_hash, hashKey(first.token));
  assert.ok(!JSON.stringify(row).includes(first.token));
  const second = await invitation();
  assert.equal((await post('/api/auth/invitations/inspect', { token: first.token })).status, 403);
  assert.equal((await post('/api/auth/invitations/inspect', { token: second.token })).status, 200);
  await db.q(`update account_invitations set expires_at = now() - interval '1 second' where account_id = $1`, [memberId]);
  assert.equal((await post('/api/auth/invitations/inspect', { token: second.token })).status, 403);
});

test('Google invitation binds the assigned member, logs in, and cannot be reused', async () => {
  const invite = await invitation();
  const flow = await start('google', { invitation_token: invite.token });
  const auth = new URL(flow.authorization_url);
  assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(auth.searchParams.get('scope'), 'openid email profile');
  assert.match(flow.response.headers.get('set-cookie')!, /HttpOnly.*SameSite=Lax/);
  const result = await finish('google', flow);
  assert.equal(result.status, 303);
  assert.equal(result.headers.get('location'), '/?auth=linked#/profile');
  const session = cookies(result);
  assert.match(session, /ait_session=ats_/);
  assert.equal((await (await me(session)).json()).id, memberId);
  assert.equal((await post('/api/auth/invitations/inspect', { token: invite.token })).status, 403);
  const identities = await social.listIdentities(await authenticate(memberKey));
  assert.equal(identities[0]!.label, 'person@example.test');
  assert.equal(identities[0]!.provider, 'google');
  assert.equal((await db.q1('select count(*) as n from accounts'))!.n, 3);
});

test('linked Google signs in; one-use callback and browser binding prevent replay and login CSRF', async () => {
  const flow = await start();
  const callback = oidc.issue('google', flow.authorization_url);
  const missingCookie = await fetch(callback, { redirect: 'manual' });
  assert.match(missingCookie.headers.get('location')!, /auth_error=/);
  const success = await fetch(callback, { headers: { Cookie: flow.cookie }, redirect: 'manual' });
  assert.equal(success.headers.get('location'), '/?auth=signed-in#/projects');
  assert.equal((await me(cookies(success))).status, 200);
  const replay = await fetch(callback, { headers: { Cookie: flow.cookie }, redirect: 'manual' });
  assert.match(replay.headers.get('location')!, /auth_error=/);
});

test('unlinked identities never create or merge accounts by email or username', async () => {
  const flow = await start();
  const result = await finish('google', flow, { sub: 'unknown-person', email: 'person@example.test' });
  assert.match(result.headers.get('location')!, /auth_error=/);
  assert.ok(!cookies(result).includes('ait_session'));
  assert.equal((await db.q1('select count(*) as n from accounts'))!.n, 3);
});

test('cancelled sign-in preserves invitation; replacement invalidates unfinished flows', async () => {
  const person = await newPerson('cancelled');
  const invite = await invitation(person.account.id);
  const flow = await start('telegram', { invitation_token: invite.token });
  const state = new URL(flow.authorization_url).searchParams.get('state');
  const cancel = await fetch(`${url}/api/auth/telegram/callback?state=${state}&error=access_denied`, { headers: { Cookie: flow.cookie }, redirect: 'manual' });
  assert.match(cancel.headers.get('location')!, /auth_error=/);
  assert.equal((await post('/api/auth/invitations/inspect', { token: invite.token })).status, 200);
  const stale = await start('telegram', { invitation_token: invite.token });
  await invitation(person.account.id);
  const result = await finish('telegram', stale);
  assert.match(result.headers.get('location')!, /auth_error=/);
});

for (const [name, claims, invalidSignature] of [
  ['wrong audience', { aud: 'attacker' }, false], ['wrong issuer', { iss: 'https://attacker.test' }, false],
  ['wrong nonce', { nonce: 'attacker' }, false], ['expired token', { exp: 1 }, false],
  ['missing subject', { sub: '' }, false], ['wrong authorized party', { azp: 'attacker' }, false],
  ['invalid signature', {}, true],
] as const) {
  test(`rejects ${name} without creating a session or consuming an invitation`, async () => {
    const person = await newPerson(name.replaceAll(' ', '-'));
    const invite = await invitation(person.account.id);
    const flow = await start('google', { invitation_token: invite.token });
    const result = await finish('google', flow, claims, invalidSignature);
    assert.match(result.headers.get('location')!, /auth_error=/);
    assert.ok(!cookies(result).includes('ait_session'));
    assert.equal((await post('/api/auth/invitations/inspect', { token: invite.token })).status, 200);
    assert.equal((await social.listIdentities(await authenticate(person.key))).length, 0);
  });
}

test('identity already owned by another account cannot be transferred by invitation', async () => {
  const invite = await invitation(adminId);
  const flow = await start('google', { invitation_token: invite.token });
  const result = await finish('google', flow);
  assert.match(result.headers.get('location')!, /auth_error=/);
  assert.equal((await post('/api/auth/invitations/inspect', { token: invite.token })).status, 200);
  assert.equal((await social.listIdentities(await authenticate(adminKey))).length, 0);
});

test('Telegram links to the same member; unlink revokes Telegram sessions and pending flows', async () => {
  const flow = await start('telegram', { intent: 'link' }, memberKey);
  const result = await finish('telegram', flow);
  assert.equal(result.headers.get('location'), '/?auth=linked#/profile');
  const login = await finish('telegram', await start('telegram'));
  const cookie = cookies(login);
  assert.equal((await me(cookie)).status, 200);
  const pending = await start('telegram', { intent: 'link' }, memberKey);
  const identities = await social.listIdentities(await authenticate(memberKey));
  assert.equal(identities.length, 2);
  assert.equal(identities.find((i) => i.provider === 'telegram')!.label, '@person');
  const unlinked = await fetch(url + '/api/auth/identities/telegram', { method: 'DELETE', headers: { Authorization: `Bearer ${memberKey}` } });
  assert.equal(unlinked.status, 200);
  assert.equal((await me(cookie)).status, 401);
  assert.match((await finish('telegram', pending)).headers.get('location')!, /auth_error=/);
  assert.equal((await post('/api/auth/telegram/start', { intent: 'link' }, agentKey)).status, 403);
});

test('link flow stops when its original session was logged out', async () => {
  const session = await post('/api/session', { key: memberKey });
  const token = (await session.json()).session_token;
  const flow = await start('telegram', { intent: 'link' }, token);
  await fetch(url + '/api/session', { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
  assert.match((await finish('telegram', flow)).headers.get('location')!, /auth_error=/);
  assert.equal((await social.listIdentities(await authenticate(memberKey))).length, 1);
});

test('cross-site mutations and malformed state are rejected without raw provider errors', async () => {
  assert.equal((await post('/api/auth/google/start', { intent: 'link' }, memberKey, 'https://attacker.test')).status, 403);
  assert.equal((await post(`/api/accounts/${memberId}/invitation`, {}, adminKey, 'https://attacker.test')).status, 403);
  const result = await fetch(url + '/api/auth/google/callback?state=bad&error=secret-value', { redirect: 'manual' });
  assert.match(result.headers.get('location')!, /auth_error=/);
  assert.ok(!result.headers.get('location')!.includes('secret-value'));
  assert.equal(result.headers.get('cache-control'), 'no-store');
});

test('native browser tickets and exchanges are single use, bound to app PKCE, without session in URL', async () => {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = social.pkceChallenge(verifier);
  const started = await start('google', { code_challenge: challenge });
  const browser = await fetch(started.authorization_url, { redirect: 'manual' });
  assert.equal(browser.status, 303);
  assert.equal((await fetch(started.authorization_url, { redirect: 'manual' })).status, 400);
  const result = await finish('google', { ...started, authorization_url: browser.headers.get('location')!, cookie: cookies(browser) });
  const callback = new URL(result.headers.get('location')!);
  assert.equal(callback.protocol, 'aitracker:');
  assert.ok(!callback.href.includes('ats_'));
  const code = callback.searchParams.get('code');
  assert.equal((await post('/api/auth/exchange', { code, code_verifier: randomBytes(32).toString('base64url') })).status, 400);
  const exchange = await post('/api/auth/exchange', { code, code_verifier: verifier });
  assert.equal(exchange.status, 200);
  const body = await exchange.json();
  assert.match(body.session_token, /^ats_/);
  assert.equal(body.id, memberId);
  assert.equal((await post('/api/auth/exchange', { code, code_verifier: verifier })).status, 400);
});

test('disabled humans cannot sign in or redeem invites', async () => {
  const invite = await invitation();
  const flow = await start();
  await db.q('update accounts set disabled = true where id = $1', [memberId]);
  assert.equal((await post('/api/auth/invitations/inspect', { token: invite.token })).status, 403);
  assert.match((await finish('google', flow)).headers.get('location')!, /auth_error=/);
  await db.q('update accounts set disabled = false where id = $1', [memberId]);
});

test('two invitation callbacks racing can bind only one provider', async () => {
  const person = await newPerson('race');
  const invite = await invitation(person.account.id);
  const google = await start('google', { invitation_token: invite.token });
  const telegram = await start('telegram', { invitation_token: invite.token });
  const results = await Promise.all([
    finish('google', google, { sub: 'race-google' }),
    finish('telegram', telegram, { sub: 'race-telegram' }),
  ]);
  assert.equal(results.filter((r) => r.headers.get('location') === '/?auth=linked#/profile').length, 1);
  assert.equal((await social.listIdentities(await authenticate(person.key))).length, 1);
});

test('expired OAuth flows fail; cancellation keeps a retry link without provider details', async () => {
  const person = await newPerson('expired-flow');
  const invite = await invitation(person.account.id);
  const flow = await start('google', { invitation_token: invite.token });
  const state = new URL(flow.authorization_url).searchParams.get('state');
  const cancel = await fetch(`${url}/api/auth/google/callback?state=${state}&error=private-error`, {
    headers: { Cookie: flow.cookie }, redirect: 'manual',
  });
  assert.ok(cancel.headers.get('location')!.endsWith(`#/invite/${invite.token}`));
  assert.ok(!cancel.headers.get('location')!.includes('private-error'));
  const expired = await start();
  await db.q(`update auth_flows set expires_at = now() - interval '1 second' where state_hash = $1`,
    [hashKey(new URL(expired.authorization_url).searchParams.get('state')!)]);
  assert.match((await finish('google', expired)).headers.get('location')!, /auth_error=/);
});

test('native linking returns confirmation; unlink invalidates pending exchange codes', async () => {
  const verifier = randomBytes(32).toString('base64url');
  const started = await start('telegram', { intent: 'link', code_challenge: social.pkceChallenge(verifier) }, memberKey);
  const browser = await fetch(started.authorization_url, { redirect: 'manual' });
  const result = await finish('telegram', { ...started, authorization_url: browser.headers.get('location')!, cookie: cookies(browser) });
  const code = new URL(result.headers.get('location')!).searchParams.get('code');
  const redeemed = await post('/api/auth/exchange', { code, code_verifier: verifier });
  assert.equal(redeemed.status, 200);
  assert.deepEqual(await redeemed.json(), { ok: true });

  const next = await start('telegram', { code_challenge: social.pkceChallenge(verifier) });
  const nextBrowser = await fetch(next.authorization_url, { redirect: 'manual' });
  const nextResult = await finish('telegram', { ...next, authorization_url: nextBrowser.headers.get('location')!, cookie: cookies(nextBrowser) });
  const pending = new URL(nextResult.headers.get('location')!).searchParams.get('code');
  await social.unlink(await authenticate(memberKey), 'telegram');
  assert.equal((await post('/api/auth/exchange', { code: pending, code_verifier: verifier })).status, 400);
});

test('unlink and relink cannot resurrect a session for the removed identity', async () => {
  const actor = await authenticate(memberKey);
  const previous = await db.q1("select id from account_identities where account_id = $1 and provider = 'google'", [actor.id]);
  const { createSession } = await import('../src/auth.ts');
  const token = await createSession(actor.id, 'google', undefined, previous!.id);
  await social.unlink(actor, 'google');
  assert.equal((await fetch(url + '/api/me', { headers: { Authorization: `Bearer ${token}` } })).status, 401);
  const replacement = await start('google', { intent: 'link' }, memberKey);
  assert.equal((await finish('google', replacement)).headers.get('location'), '/?auth=linked#/profile');
  await assert.rejects(createSession(actor.id, 'google', undefined, previous!.id), /not linked/);
});
