import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import pg from 'pg';

const base = process.env.DATABASE_URL ?? 'postgres://aitracker:aitracker@127.0.0.1:5433/aitracker';
const database = `ait_avatar_test_${process.pid}`;
const databaseUrl = new URL(base); databaseUrl.pathname = `/${database}`;
process.env.DATABASE_URL = databaseUrl.href;
process.env.DATA_DIR = await mkdtemp(join(tmpdir(), 'ait-avatar-test-'));
let server: Server;
let pool: pg.Pool;
let url: string;
let adminKey: string;
let ownerKey: string;
let otherKey: string;
let agentId: number;
let adminId: number;

async function request(key: string, method: string, path: string, body?: object | Buffer, mime = 'application/json') {
  const res = await fetch(url + path, { method, headers: { Authorization: `Bearer ${key}`, ...(body && { 'Content-Type': mime }) }, body: body instanceof Buffer ? new Uint8Array(body) : body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
}

before(async () => {
  const admin = new pg.Client({ connectionString: base }); await admin.connect();
  try { await admin.query(`create database ${database}`); } finally { await admin.end(); }
  const db = await import('../src/db.ts'); pool = db.pool; await db.migrate();
  const svc = await import('../src/service.ts');
  const human = await svc.createAccount({ name: 'avatar-admin', kind: 'human', role: 'admin' });
  adminKey = human.key; adminId = human.account.id;
  const agent = await svc.createAccount({ name: 'avatar-agent', kind: 'agent', system: 'codex', role: 'member' });
  ownerKey = agent.key; agentId = agent.account.id;
  otherKey = (await svc.createAccount({ name: 'other-agent', kind: 'agent', role: 'member' })).key;
  const { buildApp } = await import('../src/server.ts');
  server = buildApp().listen(0, '127.0.0.1'); await new Promise((r) => server.once('listening', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server?.closeAllConnections();
  await new Promise<void>((r) => server ? server.close(() => r()) : r()); await pool?.end();
  const admin = new pg.Client({ connectionString: base }); await admin.connect();
  try { await admin.query(`drop database if exists ${database} with (force)`); } finally { await admin.end(); }
  await rm(process.env.DATA_DIR!, { recursive: true, force: true });
});

test('catalog contains all 21 images; picks persist independently of system', async () => {
  const catalog = await request(ownerKey, 'GET', '/api/agent-systems');
  assert.equal(catalog.status, 200); assert.equal(catalog.body.length, 21);
  for (const entry of catalog.body) {
    assert.equal(entry.avatar_url, `/avatars/${entry.id}.png`);
    const image = await fetch(url + entry.avatar_url); assert.equal(image.status, 200); await image.arrayBuffer();
  }
  const picked = await request(ownerKey, 'PATCH', `/api/accounts/${agentId}/avatar`, { avatar_preset: 'windsurf' });
  assert.equal(picked.status, 200); assert.equal(picked.body.avatar_preset, 'windsurf'); assert.equal(picked.body.system, 'codex');
  const me = await request(ownerKey, 'GET', '/api/me'); assert.equal(me.body.avatar_preset, 'windsurf');
  assert.equal(me.body.avatar_key, undefined); assert.equal(me.body.key_hash, undefined);
  const created = await request(adminKey, 'POST', '/api/accounts', { name: 'new-preset-agent', kind: 'agent', system: 'custom', avatar_preset: 'amp' });
  assert.equal(created.status, 201); assert.equal(created.body.account.avatar_preset, 'amp');
  assert.equal((await request(ownerKey, 'PATCH', `/api/accounts/${agentId}/avatar`, { avatar_preset: '../bad' })).status, 400);
  assert.equal((await request(ownerKey, 'PATCH', `/api/accounts/${agentId}/avatar`, { avatar_preset: 'unknown' })).status, 400);
});

test('only admin or owner changes avatars; human accounts and cross-origin requests are rejected', async () => {
  assert.equal((await request(otherKey, 'PATCH', `/api/accounts/${agentId}/avatar`, { avatar_preset: 'claude' })).status, 403);
  assert.equal((await request(otherKey, 'PUT', `/api/accounts/${agentId}/avatar`, Buffer.from('bad'), 'image/png')).status, 403);
  assert.equal((await request(adminKey, 'PATCH', `/api/accounts/${adminId}/avatar`, { avatar_preset: 'claude' })).status, 400);
  const cross = await fetch(url + `/api/accounts/${agentId}/avatar`, { method: 'PATCH', headers: { Authorization: `Bearer ${adminKey}`, Origin: 'https://evil.test', 'Content-Type': 'application/json' }, body: '{"avatar_preset":"claude"}' });
  assert.equal(cross.status, 403);
  assert.equal((await fetch(url + `/api/accounts/${agentId}/avatar`)).status, 401);
});

test('upload, replace, reset, cleanup and rejected uploads preserve previous avatar', async () => {
  const png = await readFile(new URL('../public/avatars/gemini.png', import.meta.url));
  const uploaded = await request(adminKey, 'PUT', `/api/accounts/${agentId}/avatar`, png, 'image/png');
  assert.equal(uploaded.status, 200); assert.equal(uploaded.body.avatar_preset, null);
  const firstUrl = uploaded.body.avatar_url;
  const downloaded = await fetch(url + firstUrl, { headers: { Authorization: `Bearer ${ownerKey}` } });
  assert.equal(downloaded.status, 200); assert.equal(downloaded.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), png);
  for (const [body, mime, expected] of [[Buffer.from('<svg></svg>'), 'image/svg+xml', 415], [Buffer.from('not PNG'), 'image/png', 415], [Buffer.alloc(0), 'image/png', 400], [Buffer.alloc(5 * 1024 ** 2 + 1), 'image/png', 413]] as const) {
    assert.equal((await request(ownerKey, 'PUT', `/api/accounts/${agentId}/avatar`, body, mime)).status, expected);
    assert.equal((await request(ownerKey, 'GET', '/api/me')).body.avatar_url, firstUrl);
  }
  const second = await request(ownerKey, 'PUT', `/api/accounts/${agentId}/avatar`, png, 'image/png');
  assert.notEqual(second.body.avatar_url, firstUrl);
  assert.equal((await readdir(join(process.env.DATA_DIR!, 'avatars'))).length, 1);
  assert.equal((await fetch(url + firstUrl, { headers: { Authorization: `Bearer ${ownerKey}` } })).status, 404);
  const reset = await request(adminKey, 'PATCH', `/api/accounts/${agentId}`, { avatar_preset: 'goose' });
  assert.equal(reset.status, 200); assert.equal(reset.body.avatar_preset, 'goose'); assert.equal(reset.body.avatar_url, null);
  assert.equal((await readdir(join(process.env.DATA_DIR!, 'avatars'))).length, 0);
  const auto = await request(ownerKey, 'PATCH', `/api/accounts/${agentId}/avatar`, { avatar_preset: null });
  assert.equal(auto.body.avatar_preset, null);
});
