// Two scopes on one core: what a host of many teams builds on. The scopes here are chosen by
// subdomain in a few lines of test code; the core itself does not know how or why.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import pg from 'pg';

const database = new URL('postgres://aitracker:aitracker@127.0.0.1:5433/aitracker_scope_test');
process.env.DATABASE_URL = database.href;
process.env.DB_SCOPED = '1';
process.env.DB_SCHEMA = '';
process.env.DB_POOL_MAX = '2'; // few connections: scopes must share and reuse them
process.env.DB_MAX_CONNECTIONS_PER_SCHEMA = '1';
const dataDir = mkdtempSync(join(tmpdir(), 'aitracker-scope-'));
process.env.DATA_DIR = dataDir;
delete process.env.VAPID_PUBLIC_KEY;
delete process.env.VAPID_PRIVATE_KEY;

const { migrate, pool, q } = await import('../src/db.ts');
const { runInScope } = await import('../src/scope.ts');
const svc = await import('../src/service.ts');
const { buildApp } = await import('../src/server.ts');

const scopeOf = (name: string) => ({
  key: name,
  dbSchema: `s_${name}`,
  dataDir: join(dataDir, name),
  publicUrl: `https://${name}.example.test`,
  maxUploadBytes: name === 'alpha' ? 20 : 1000,
});

let server: Server;
let port = 0;
const keys: Record<string, string> = {};
const run = { model: 'claude-opus-5-5', effort: 'high' };

type Reply = { status: number; body: any; text: string };
type Options = { key?: string; json?: unknown; raw?: Buffer; headers?: Record<string, string> };
function call(name: string, method: string, path: string, opts: Options = {}): Promise<Reply> {
  const headers: Record<string, string> = { Host: `${name}.example.test`, ...opts.headers };
  const key = opts.key ?? keys[name];
  if (key) headers.Authorization = `Bearer ${key}`;
  const payload = opts.raw ?? (opts.json !== undefined ? Buffer.from(JSON.stringify(opts.json)) : undefined);
  if (opts.json !== undefined) headers['Content-Type'] = 'application/json';
  if (payload) headers['Content-Length'] = String(payload.length);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let body: any = null;
        try { body = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode!, body, text });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}
const task = (name: string, title: string) => call(name, 'POST', '/api/tasks', { json: { title, assignee: `${name}-admin`, ...run } });
const upload = (name: string, id: number, data: string) => call(name, 'POST', `/api/tasks/${id}/attachments?filename=f.txt`, {
  raw: Buffer.from(data), headers: { 'Content-Type': 'application/octet-stream' },
});

before(async () => {
  const maintenance = new URL(database);
  maintenance.pathname = '/postgres';
  const admin = new pg.Client({ connectionString: maintenance.href });
  await admin.connect();
  await admin.query('drop database if exists aitracker_scope_test with (force)');
  await admin.query('create database aitracker_scope_test');
  await admin.end();
  for (const name of ['alpha', 'beta']) {
    await runInScope(scopeOf(name), () => migrate({ quiet: true }));
    keys[name] = (await runInScope(scopeOf(name), () => svc.createAccount({ name: `${name}-admin`, kind: 'human', role: 'admin' }))).key;
  }
  const core = buildApp();
  const app = express();
  app.use((req, res, next) => {
    const name = req.hostname.split('.')[0]!;
    if (!(name in keys)) return void res.status(404).json({ error: 'unknown' });
    runInScope(scopeOf(name), () => core(req, res, next));
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  port = (server.address() as AddressInfo).port;
});

after(async () => {
  server?.closeAllConnections();
  server?.close();
  await pool.end();
  rmSync(dataDir, { recursive: true, force: true });
});

test('a key of one scope is not valid in another', async () => {
  assert.equal((await call('alpha', 'GET', '/api/tasks')).status, 200);
  assert.equal((await call('beta', 'GET', '/api/tasks', { key: keys.alpha })).status, 401);
  assert.equal((await call('alpha', 'GET', '/api/tasks', { key: keys.beta })).status, 401);
});

test('same ids, different data: nothing crosses by known id', async () => {
  const a = (await task('alpha', 'secret of alpha')).body;
  const b = (await task('beta', 'secret of beta')).body;
  assert.equal(a.id, b.id, 'each schema has its own id sequence');
  assert.equal((await call('alpha', 'GET', `/api/tasks/${a.id}`)).body.title, 'secret of alpha');
  assert.equal((await call('beta', 'GET', `/api/tasks/${a.id}`)).body.title, 'secret of beta');
  const only = (await task('beta', 'only in beta')).body;
  assert.equal((await call('alpha', 'GET', `/api/tasks/${only.id}`)).status, 404);
  assert.equal((await call('alpha', 'PATCH', `/api/tasks/${only.id}`, { json: { title: 'hijacked', ...run } })).status, 404);
  assert.equal((await call('beta', 'GET', `/api/tasks/${only.id}`)).body.title, 'only in beta');
});

test('MCP stays in its scope', async () => {
  const rpc = await call('beta', 'POST', '/mcp', {
    headers: { Accept: 'application/json, text/event-stream' },
    json: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_tasks', arguments: { q: 'secret' } } },
  });
  assert.equal(rpc.status, 200, rpc.text);
  assert.ok(rpc.text.includes('secret of beta'), rpc.text);
  assert.ok(!rpc.text.includes('secret of alpha'), rpc.text);
});

test('files stay in the directory of their scope, including multipart uploads', async () => {
  const a = (await task('alpha', 'with file')).body;
  const b = (await task('beta', 'with file')).body;
  const upA = await upload('alpha', a.id, 'bytes of alpha');
  const upB = await upload('beta', b.id, 'bytes of beta');
  assert.equal(upA.status, 201, upA.text);
  assert.equal(upB.status, 201, upB.text);
  assert.equal(upA.body[0].id, upB.body[0].id);
  assert.equal((await call('alpha', 'GET', `/api/attachments/${upA.body[0].id}/content`)).text, 'bytes of alpha');
  assert.equal((await call('beta', 'GET', `/api/attachments/${upA.body[0].id}/content`)).text, 'bytes of beta');
  const boundary = 'scopeboundary';
  const multipart = await call('beta', 'POST', `/api/tasks/${b.id}/attachments`, {
    raw: Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="m.txt"\r\nContent-Type: text/plain\r\n\r\nmultipart\r\n--${boundary}--\r\n`),
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
  });
  assert.equal(multipart.status, 201, multipart.text);
  assert.equal(readdirSync(join(dataDir, 'alpha', 'attachments')).length, 1);
  assert.equal(readdirSync(join(dataDir, 'beta', 'attachments')).length, 2);
  assert.equal(existsSync(join(dataDir, 'attachments')), false, 'nothing lands in the shared directory');
});

test('deleting an attachment touches only the scope it was asked in', async () => {
  const a = (await task('alpha', 'delete in scope')).body;
  const b = (await task('beta', 'delete in scope')).body;
  // Equal ids on purpose: each scope numbers its attachments on its own, so the one behind catches up.
  let kept = (await upload('alpha', a.id, 'alpha keeps this')).body[0];
  let dropped = (await upload('beta', b.id, 'beta drops this')).body[0];
  while (kept.id < dropped.id) kept = (await upload('alpha', a.id, 'alpha keeps this')).body[0];
  while (dropped.id < kept.id) dropped = (await upload('beta', b.id, 'beta drops this')).body[0];
  const id = kept.id;
  const alphaFiles = readdirSync(join(dataDir, 'alpha', 'attachments')).length;
  const betaFiles = readdirSync(join(dataDir, 'beta', 'attachments')).length;
  assert.equal((await call('beta', 'DELETE', `/api/attachments/${id}`)).status, 200);
  assert.equal(readdirSync(join(dataDir, 'beta', 'attachments')).length, betaFiles - 1);
  assert.equal(readdirSync(join(dataDir, 'alpha', 'attachments')).length, alphaFiles);
  assert.equal((await call('alpha', 'GET', `/api/attachments/${id}/content`)).text, 'alpha keeps this');
  assert.equal((await call('beta', 'GET', `/api/attachments/${id}/content`)).status, 404);
});

test('the upload limit follows the scope', async () => {
  const a = (await task('alpha', 'limits')).body;
  const b = (await task('beta', 'limits')).body;
  const big = 'x'.repeat(100);
  assert.equal((await upload('alpha', a.id, big)).status, 413);
  assert.equal((await upload('beta', b.id, big)).status, 201);
});

test('the event stream does not tell one scope about another', async () => {
  const heard: string[] = [];
  const stream = http.request({ host: '127.0.0.1', port, path: '/api/events/stream', headers: { Host: 'beta.example.test', Authorization: `Bearer ${keys.beta}` } });
  stream.on('response', (res) => res.on('data', (c) => heard.push(c.toString())));
  stream.on('error', () => {});
  stream.end();
  const settled = () => new Promise((r) => setTimeout(r, 200));
  await settled();
  await task('alpha', 'news of alpha');
  await settled();
  const fromAlpha = heard.join('').includes('data:');
  await task('beta', 'news of beta');
  await settled();
  stream.destroy();
  assert.equal(fromAlpha, false, 'beta heard an event that happened in alpha');
  assert.ok(heard.join('').includes('data:'), 'beta hears its own events');
});

test('the origin check and passkeys use the address of the scope', async () => {
  const cross = await call('alpha', 'DELETE', '/api/session', { headers: { Origin: 'https://beta.example.test' } });
  assert.equal(cross.status, 403);
  const same = await call('alpha', 'DELETE', '/api/session', { headers: { Origin: 'https://alpha.example.test' } });
  assert.notEqual(same.status, 403, same.text);
  const options = await call('alpha', 'POST', '/api/passkeys/login/options', { headers: { Origin: 'https://alpha.example.test' }, json: {} });
  assert.equal(options.status, 200, options.text);
  assert.equal(options.body.options?.rpId ?? options.body.rpId, 'alpha.example.test');
});

test('a passkey challenge issued in one scope cannot be used in another', async () => {
  const issued = await call('alpha', 'POST', '/api/passkeys/login/options', { headers: { Origin: 'https://alpha.example.test' }, json: {} });
  const challengeId = issued.body.challenge_id;
  assert.ok(challengeId, issued.text);
  const verify = await call('beta', 'POST', '/api/passkeys/login/verify', {
    headers: { Origin: 'https://beta.example.test' },
    json: { challenge_id: challengeId, response: { id: 'x', rawId: 'x', type: 'public-key', response: {} } },
  });
  assert.equal(verify.status, 400);
  assert.match(verify.text, /challenge/);
});

test('push keys are generated and kept per scope', async () => {
  const a = await call('alpha', 'GET', '/api/push/key');
  const b = await call('beta', 'GET', '/api/push/key');
  assert.equal(a.status, 200, a.text);
  assert.ok(a.body.key);
  assert.notEqual(a.body.key, b.body.key);
  assert.equal((await call('alpha', 'GET', '/api/push/key')).body.key, a.body.key);
});

test('SQL with no scope fails, also on a connection a scope has just used', async () => {
  await call('alpha', 'GET', '/api/tasks');
  await call('beta', 'GET', '/api/tasks');
  for (let i = 0; i < 4; i++) {
    await assert.rejects(q('select * from tasks'), /relation "tasks" does not exist/);
    await assert.rejects(q('select * from accounts'), /relation "accounts" does not exist/);
  }
  const client = await pool.connect();
  try {
    assert.equal((await client.query(`select current_setting('search_path') as p`)).rows[0].p, '""');
  } finally {
    client.release();
  }
});

test('a schema name that is not a plain identifier is refused', async () => {
  await assert.rejects(runInScope({ key: 'x', dbSchema: 'a"; drop schema s_alpha cascade; --' }, () => q('select 1')), /bad schema name/);
  assert.equal((await runInScope(scopeOf('alpha'), () => q('select count(*) as n from accounts')))[0]!.n, 1);
});

test('concurrent requests over two connections never cross', async () => {
  const pick = Array.from({ length: 200 }, (_, i) => (i % 2 ? 'alpha' : 'beta'));
  const replies = await Promise.all(pick.map(async (name) => [name, await call(name, 'GET', '/api/tasks?q=secret')] as const));
  for (const [name, reply] of replies) {
    assert.equal(reply.status, 200);
    assert.ok(reply.text.includes(`secret of ${name}`), `${name} lost its own data`);
    assert.ok(!reply.text.includes(`secret of ${name === 'alpha' ? 'beta' : 'alpha'}`), `${name} read the other one`);
  }
});

test('one schema cannot take every connection of the pool', async () => {
  // Limit 1 per schema and 2 connections in all: while alpha holds its one, beta still gets through.
  const held = await runInScope(scopeOf('alpha'), () => pool.connect());
  let second = false;
  const waiting = runInScope(scopeOf('alpha'), () => pool.connect()).then((c) => { second = true; return c; });
  const other = await runInScope(scopeOf('beta'), () => q('select count(*) as n from accounts'));
  assert.equal(other[0]!.n, 1);
  assert.equal(second, false, 'alpha waits for its own connection to come back');
  held.release();
  (await waiting).release();
  assert.equal(second, true);
});

test('migrate can run for a schema on its own, separately from starting the app', async () => {
  const scope = { key: 'gamma', dbSchema: 's_gamma' };
  await runInScope(scope, () => migrate({ quiet: true }));
  const rows = await runInScope(scope, () => q('select count(*) as n from schema_migrations'));
  assert.ok(rows[0]!.n > 0);
  const again = await runInScope(scope, () => q('select count(*) as n from schema_migrations'));
  await runInScope(scope, () => migrate({ quiet: true }));
  assert.equal(again[0]!.n, rows[0]!.n);
});
