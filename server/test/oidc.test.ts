// A provider set by configuration: what it accepts, and what must never get anyone in.
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import pg from 'pg';
import { fakeOidc } from './helpers/oidc.ts';

const database = new URL(process.env.DATABASE_URL ?? 'postgres://aitracker:aitracker@127.0.0.1:5433/aitracker');
database.pathname = '/aitracker_oidc_test';
process.env.DATABASE_URL = database.href;
const oidc = await fakeOidc();
const ISSUER = 'https://id.example.test';
const AUTHORIZE = `${ISSUER}/authorize`;
Object.assign(process.env, {
  OIDC_ISSUER: ISSUER, OIDC_AUTHORIZATION_URL: AUTHORIZE, OIDC_TOKEN_URL: `${oidc.url}/oidc/token`, OIDC_JWKS_URL: `${oidc.url}/jwks`,
  OIDC_CLIENT_ID: 'test-client', OIDC_CLIENT_SECRET: 'test-secret', OIDC_LABEL: 'Acme SSO', OIDC_ALGORITHMS: 'RS256',
});
const { config } = await import('../src/config.ts');
const social = await import('../src/social-auth.ts');
const db = await import('../src/db.ts');
const svc = await import('../src/service.ts');
const { authenticate } = await import('../src/auth.ts');
const { runInScope } = await import('../src/scope.ts');
const { buildApp } = await import('../src/server.ts');

const good = {
  issuer: ISSUER, authorizationUrl: AUTHORIZE, tokenUrl: `${oidc.url}/oidc/token`, jwksUrl: `${oidc.url}/jwks`,
  clientId: 'test-client', clientSecret: 'test-secret', algorithms: ['RS256'],
};
let server: Server;
let scoped: Server[] = [];
let url: string;
let adminKey: string;
let adminId: number;
let memberKey: string;
let memberId: number;

// The same core in a scope of its own, on its own address, as a service around it would run it.
async function inScope(oidcSettings: typeof good | Record<string, string>) {
  const app = buildApp();
  const holder: { url?: string } = {};
  const site = http.createServer((req, res) => {
    runInScope({ key: `scope-${site.address() && (site.address() as AddressInfo).port}`, publicUrl: holder.url, oidc: oidcSettings as typeof good },
      () => app(req as never, res as never));
  }).listen(0, '127.0.0.1');
  await new Promise<void>((r) => site.once('listening', r));
  holder.url = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  scoped.push(site);
  return holder.url;
}

before(async () => {
  const maintenance = new URL(database); maintenance.pathname = '/postgres';
  const client = new pg.Client({ connectionString: maintenance.href });
  await client.connect();
  await client.query('drop database if exists aitracker_oidc_test with (force)');
  await client.query('create database aitracker_oidc_test');
  await client.end();
  await db.migrate();
  const admin = await svc.createAccount({ name: 'admin', kind: 'human', role: 'admin' });
  const member = await svc.createAccount({ name: 'member', kind: 'human', role: 'member' });
  adminKey = admin.key; adminId = admin.account.id;
  memberKey = member.key; memberId = member.account.id;
  server = buildApp().listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  config.publicUrl = url;
});
after(async () => {
  for (const site of [server, ...scoped]) site?.close();
  await oidc.close();
  await db.pool.end();
});

const cookies = (r: Response) => r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
async function start(base = url, path = '/api/auth/oidc/start', body: unknown = {}, headers: Record<string, string> = {}) {
  const response = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, ...headers }, body: JSON.stringify(body) });
  assert.equal(response.status, 200, await response.clone().text());
  return { authorization_url: (await response.json()).authorization_url as string, cookie: cookies(response) };
}
type Flow = Awaited<ReturnType<typeof start>>;
const callbackOf = (flow: Flow, claims: Record<string, unknown> = {}, invalidSignature = false, sharedSecret?: string) =>
  oidc.issue('oidc', flow.authorization_url, { iss: ISSUER, sub: 'oidc-person', ...claims }, invalidSignature, sharedSecret);
const finish = (flow: Flow, ...rest: Parameters<typeof callbackOf> extends [unknown, ...infer R] ? R : never) =>
  fetch(callbackOf(flow, ...rest), { headers: { Cookie: flow.cookie }, redirect: 'manual' });
const me = (cookie: string, base = url) => fetch(`${base}/api/me`, { headers: { Cookie: cookie } });
const failed = (result: Response) => {
  assert.match(result.headers.get('location') ?? '', /auth_error=/);
  assert.ok(!cookies(result).includes('ait_session'));
};
const accountCount = async () => Number((await db.q1('select count(*) as n from accounts'))!.n);

for (const [name, change] of [
  ['no issuer', { issuer: '' }], ['no client', { clientId: '' }], ['no secret', { clientSecret: '' }], ['no token address', { tokenUrl: '' }],
  ['no key address', { jwksUrl: '' }], ['plain HTTP issuer', { issuer: 'http://id.example.test' }], ['plain HTTP token address', { tokenUrl: 'http://id.example.test/token' }],
  ['credentials in an address', { tokenUrl: 'https://user:pass@id.example.test/token' }], ['a fragment in the issuer', { issuer: `${ISSUER}#x` }], ['not an address', { jwksUrl: 'keys' }],
  ['a shared-secret algorithm', { algorithms: ['RS256', 'HS256'] }], ['no signature at all', { algorithms: ['none'] }],
] as const) {
  test(`does not appear with ${name}`, () => {
    runInScope({ key: 'probe', oidc: { ...good, ...change } as typeof good }, () => {
      assert.equal(social.configured('oidc'), false);
      assert.equal(social.oidcLabel(), null);
    });
  });
}

test('without settings the sign-in is absent from the config and refuses to start', async () => {
  const site = await inScope({ issuer: '', authorizationUrl: '', tokenUrl: '', jwksUrl: '', clientId: '', clientSecret: '' });
  const body = await (await fetch(`${site}/api/config`)).json();
  assert.equal(body.providers.oidc, false);
  assert.equal(body.oidc_label, null);
  const response = await fetch(`${site}/api/auth/oidc/start`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: site }, body: '{}' });
  assert.equal(response.status, 503);
});

test('the config names the provider and gives away nothing else', async () => {
  const text = await (await fetch(`${url}/api/config`)).text();
  const body = JSON.parse(text);
  assert.equal(body.providers.oidc, true);
  assert.equal(body.oidc_label, 'Acme SSO');
  for (const secret of ['test-secret', 'test-client', ISSUER, oidc.url]) assert.ok(!text.includes(secret), secret);
});

test('addresses come from the settings, whatever the request says', async () => {
  const evil = 'https://attacker.test';
  const flow = await start(url, `/api/auth/oidc/start?issuer=${evil}&authorization_url=${evil}&redirect_uri=${evil}`, {}, { 'X-Forwarded-Host': 'attacker.test', 'X-Forwarded-Proto': 'https' });
  const auth = new URL(flow.authorization_url);
  assert.equal(auth.origin + auth.pathname, AUTHORIZE);
  assert.equal(auth.searchParams.get('redirect_uri'), `${url}/api/auth/oidc/callback`);
  assert.equal(auth.searchParams.get('client_id'), 'test-client');
  assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(auth.searchParams.get('scope'), 'openid email profile');
  assert.ok(auth.searchParams.get('nonce') && auth.searchParams.get('state'));
  assert.ok(!flow.authorization_url.includes('attacker') && !flow.authorization_url.includes('test-secret'));
});

test('an identity nobody linked gets no session and no account', async () => {
  const before = await accountCount();
  failed(await finish(await start(), { sub: 'stranger', email: 'admin@example.test', email_verified: true, preferred_username: 'admin' }));
  assert.equal(await accountCount(), before);
});

test('a linked person signs in; the identity keeps its issuer and the session its method', async () => {
  await social.linkOidcIdentity(memberId, 'oidc-person', 'first label');
  const result = await finish(await start());
  assert.equal(result.headers.get('location'), '/?auth=signed-in#/projects');
  const cookie = cookies(result);
  assert.equal((await (await me(cookie)).json()).id, memberId);
  const identity = await db.q1(`select subject, label from account_identities where account_id = $1 and provider = 'oidc'`, [memberId]);
  assert.equal(identity!.subject, `${ISSUER}#oidc-person`);
  assert.equal(identity!.label, 'person@example.test');
  const session = await db.q1(`select method from sessions where account_id = $1`, [memberId]);
  assert.equal(session!.method, 'oidc');
});

test('an invitation binds the provider; unlinking ends its sessions', async () => {
  const person = await svc.createAccount({ name: 'invited', kind: 'human', role: 'member' });
  const created = await fetch(`${url}/api/accounts/${person.account.id}/invitation`, { method: 'POST', headers: { Authorization: `Bearer ${adminKey}`, 'Content-Type': 'application/json' }, body: '{}' });
  const token = new URL((await created.json()).url).hash.split('/').at(-1);
  const result = await finish(await start(url, '/api/auth/oidc/start', { invitation_token: token }), { sub: 'invited-person' });
  assert.equal(result.headers.get('location'), '/?auth=linked#/profile');
  const cookie = cookies(result);
  assert.equal((await me(cookie)).status, 200);
  await social.unlink(await authenticate(person.key), 'oidc');
  assert.equal((await me(cookie)).status, 401);
});

for (const [name, claims, invalidSignature, sharedSecret] of [
  ['someone else\'s issuer', { iss: 'https://attacker.test' }, false, undefined],
  ['a wrong nonce', { nonce: 'attacker' }, false, undefined],
  ['another audience', { aud: 'attacker' }, false, undefined],
  ['another authorized party', { azp: 'attacker' }, false, undefined],
  ['an expired token', { exp: 1 }, false, undefined],
  ['no subject', { sub: '' }, false, undefined],
  ['a token signed by someone else', {}, true, undefined],
  ['a token signed with the client secret', {}, false, 'test-secret-that-is-long-enough-for-hs256'],
] as const) {
  test(`rejects ${name}`, async () => {
    failed(await finish(await start(), claims as Record<string, unknown>, invalidSignature, sharedSecret));
  });
}

test('a callback and a code work once', async () => {
  const flow = await start();
  const callback = callbackOf(flow);
  const first = await fetch(callback, { headers: { Cookie: flow.cookie }, redirect: 'manual' });
  assert.equal((await me(cookies(first))).status, 200);
  failed(await fetch(callback, { headers: { Cookie: flow.cookie }, redirect: 'manual' }));
  // The same code again, under a flow that is still valid: the provider has already spent it.
  const next = await start();
  const state = new URL(next.authorization_url).searchParams.get('state')!;
  const spent = new URL(callback);
  spent.searchParams.set('state', state);
  failed(await fetch(spent, { headers: { Cookie: next.cookie }, redirect: 'manual' }));
});

test('someone else\'s state and a browser that did not start the flow are refused', async () => {
  const mine = await start();
  const theirs = await start();
  const callback = new URL(callbackOf(mine));
  failed(await fetch(callback, { redirect: 'manual' }));
  failed(await fetch(callback, { headers: { Cookie: theirs.cookie }, redirect: 'manual' }));
  callback.searchParams.set('state', 'not-a-real-state');
  failed(await fetch(callback, { headers: { Cookie: mine.cookie }, redirect: 'manual' }));
});

test('a new issuer that reuses a subject does not get the old account', async () => {
  const other = 'https://other-provider.test';
  const site = await inScope({ ...good, issuer: other });
  failed(await finish(await start(site), { iss: other, sub: 'oidc-person' }));
});

test('a token meant for another client of the same provider is refused', async () => {
  const site = await inScope({ ...good, clientId: 'client-b', clientSecret: 'secret-b' });
  const flow = await start(site);
  assert.equal(new URL(flow.authorization_url).searchParams.get('client_id'), 'client-b');
  failed(await finish(flow, { aud: 'test-client' }));
  // The other client's own token gets through to the identity check, which is what proves the refusal above was about aud.
  const again = await finish(await start(site), { aud: 'client-b', sub: 'nobody-here' });
  assert.match(decodeURIComponent(again.headers.get('location')!), /не привязан/);
});

test('settings of a scope stay in that scope', async () => {
  const site = await inScope({ ...good, clientId: 'client-b', clientSecret: 'secret-b' });
  assert.equal(new URL((await start(site)).authorization_url).searchParams.get('client_id'), 'client-b');
  assert.equal(new URL((await start()).authorization_url).searchParams.get('client_id'), 'test-client');
});

test('an account is found by its identity, and not once it is deleted', async () => {
  const person = await svc.createAccount({ name: 'findable', kind: 'human', role: 'member' });
  assert.equal(await social.oidcAccount('findable-person'), null);
  await social.linkOidcIdentity(person.account.id, 'findable-person', 'x');
  assert.equal(await social.oidcAccount('findable-person'), person.account.id);
  await runInScope({ key: 'other-issuer', oidc: { ...good, issuer: 'https://other-provider.test' } }, async () => {
    assert.equal(await social.oidcAccount('findable-person'), null);
  });
  await svc.deleteAccount(await authenticate(adminKey), person.account.id);
  assert.equal(await social.oidcAccount('findable-person'), null);
});

test('linking refuses another person\'s identity, a deleted account and an agent', async () => {
  await assert.rejects(social.linkOidcIdentity(adminId, 'oidc-person', 'x'), /already linked/);
  await assert.rejects(social.linkOidcIdentity(memberId, 'second-subject', 'x'), /already linked/);
  const agent = await svc.createAccount({ name: 'an-agent', kind: 'agent', role: 'member' });
  await assert.rejects(social.linkOidcIdentity(agent.account.id, 'agent-subject', 'x'), /already linked/);
  const gone = await svc.createAccount({ name: 'gone', kind: 'human', role: 'member' });
  await svc.deleteAccount(await authenticate(adminKey), gone.account.id);
  await assert.rejects(social.linkOidcIdentity(gone.account.id, 'gone-subject', 'x'), /already linked/);
  assert.ok(memberKey);
});

test('a removed person\'s identity stops working at once', async () => {
  const person = await svc.createAccount({ name: 'leaving', kind: 'human', role: 'member' });
  await social.linkOidcIdentity(person.account.id, 'leaving-person', 'x');
  const result = await finish(await start(), { sub: 'leaving-person' });
  const cookie = cookies(result);
  assert.equal((await me(cookie)).status, 200);
  const pending = await start();
  await svc.deleteAccount(await authenticate(adminKey), person.account.id);
  assert.equal((await me(cookie)).status, 401);
  failed(await finish(pending, { sub: 'leaving-person' }));
});
