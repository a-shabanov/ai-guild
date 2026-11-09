import { before, after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, PassThrough } from 'node:stream';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import pg from 'pg';

const baseUrl = process.env.DATABASE_URL ?? 'postgres://aitracker:aitracker@127.0.0.1:5433/aitracker';
const testUrl = new URL(baseUrl);
testUrl.pathname = '/aitracker_portable_test';
process.env.DATABASE_URL = testUrl.href;
const dataDir = mkdtempSync(join(tmpdir(), 'portable-'));
process.env.DATA_DIR = dataDir;
const run = { model: 'test-model', effort: 'high' };
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c636000020000050001e226059b0000000049454e44ae426082', 'hex');

let server: Server, url: string, pool: pg.Pool;
let portable: typeof import('../src/portable.ts');
let service: typeof import('../src/service.ts');
let humanKey = '';
let agentKey = '';

async function api(method: string, path: string, body?: object, key = humanKey) {
  const response = await fetch(url + '/api' + path, { method, headers: { Authorization: `Bearer ${key}`, ...(body && { 'Content-Type': 'application/json' }) }, body: body && JSON.stringify(body) });
  const text = await response.text();
  let parsed: any = null;
  try { parsed = JSON.parse(text); } catch { /* a file */ }
  return { status: response.status, body: parsed };
}
async function exported() {
  const out = new PassThrough();
  const chunks: Buffer[] = [];
  out.on('data', (chunk) => chunks.push(chunk));
  const summary = await portable.writeExport(out);
  return { file: Buffer.concat(chunks), summary };
}
const tables = async () => (await pool.query(`select tablename from pg_tables where schemaname = current_schema()`)).rows.map((row) => row.tablename as string).sort();
const wipe = async () => {
  await pool.query(`truncate ${(await tables()).filter((table) => table !== 'schema_migrations').map((table) => pg.escapeIdentifier(table)).join(', ')} restart identity cascade`);
  for (const entry of readdirSync(dataDir)) rmSync(join(dataDir, entry), { recursive: true, force: true });
};
const snapshot = async () => {
  const all: Record<string, unknown[]> = {};
  for (const table of portable.dataTables) all[table] = (await pool.query(`select row_to_json(t)::text as line from ${pg.escapeIdentifier(table)} t order by 1`)).rows.map((row) => row.line);
  return all;
};
const entries = (file: Buffer) => {
  const raw = gunzipSync(file);
  const found: { name: string; size: number; at: number }[] = [];
  for (let at = 0; at + 512 <= raw.length;) {
    const name = raw.subarray(at, at + 100).toString().split('\0')[0]!;
    if (!name) break;
    const size = parseInt(raw.subarray(at + 124, at + 136).toString().split('\0')[0]!, 8);
    found.push({ name, size, at });
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return { raw, found };
};
const header = (name: string, size: number, type = '0') => {
  const block = Buffer.alloc(512);
  block.write(name, 0);
  block.write('0000644\0', 100);
  block.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
  block.write('        ', 148);
  block.write(type, 156);
  block.write(`${block.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0')}\0 `, 148);
  return block;
};
const withEntry = (file: Buffer, name: string, content: Buffer, type = '0') => {
  // Right after the manifest, which is where something added by hand would be read first.
  const { raw, found } = entries(file);
  const second = found[1]!.at;
  const pad = Buffer.alloc((512 - (content.length % 512)) % 512);
  return gzipSync(Buffer.concat([raw.subarray(0, second), header(name, content.length, type), content, pad, raw.subarray(second)]));
};
const seed = async () => {
  const { id: project } = (await api('POST', '/projects', { name: 'Main' })).body;
  const first = (await api('POST', '/tasks', { title: 'Родитель "с кавычками"\nи строкой', project: 'Main', ...run })).body;
  const child = (await api('POST', '/tasks', { title: 'Child', project: 'Main', ...run }, agentKey)).body;
  // A row pointing to a later row of the same table.
  await pool.query('update tasks set parent_id = $2 where id = $1', [first.id, child.id]);
  assert.equal((await api('POST', `/tasks/${child.id}/comments`, { body: 'A comment', ...run }, agentKey)).status, 201);
  assert.equal((await api('POST', `/projects/${project}/wiki`, { title: 'Page', content: '# Hello' })).status, 201);
  const form = new FormData();
  form.append('model', run.model);
  form.append('effort', run.effort);
  form.append('file', new Blob([PNG], { type: 'image/png' }), 'dot.png');
  const uploaded = await fetch(`${url}/api/tasks/${child.id}/attachments`, { method: 'POST', headers: { Authorization: `Bearer ${agentKey}` }, body: form });
  assert.equal(uploaded.status, 201, await uploaded.clone().text());
  return { project, child: child.id as number };
};

before(async () => {
  const admin = new pg.Client({ connectionString: baseUrl });
  await admin.connect();
  await admin.query('drop database if exists aitracker_portable_test with (force)');
  await admin.query('create database aitracker_portable_test');
  await admin.end();
  const db = await import('../src/db.ts');
  pool = db.pool;
  await db.migrate({ quiet: true });
  portable = await import('../src/portable.ts');
  service = await import('../src/service.ts');
  const { buildApp } = await import('../src/server.ts');
  server = buildApp().listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  setTimeout(() => process.exit(), 500).unref();
  await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
  await pool.end();
  rmSync(dataDir, { recursive: true, force: true });
});
beforeEach(async () => {
  await wipe();
  humanKey = (await service.createAccount({ name: 'person', kind: 'human', role: 'admin' })).key;
  agentKey = (await service.createAccount({ name: 'agent', kind: 'agent', role: 'member' })).key;
});

test('every table is known to travel or to stay: a new one has to be decided on', async () => {
  assert.deepEqual(await tables(), [...portable.dataTables, ...portable.leftBehind].sort());
});

test('the lists agree with the database: parents load first, and every sequence is continued', async () => {
  const { rows: links } = await pool.query(
    `select c.relname as child, p.relname as parent from pg_constraint k join pg_class c on c.oid = k.conrelid join pg_class p on p.oid = k.confrelid
     join pg_namespace n on n.oid = c.relnamespace where k.contype = 'f' and n.nspname = current_schema()`);
  for (const { child, parent } of links) {
    if (!portable.dataTables.includes(child) || child === parent) continue;
    assert.ok(portable.dataTables.includes(parent), `${child} points to ${parent}, which stays behind`);
    assert.ok(portable.dataTables.indexOf(parent) < portable.dataTables.indexOf(child), `${parent} must load before ${child}`);
  }
  const { rows: serials } = await pool.query(
    `select table_name as name, column_name as col from information_schema.columns where table_schema = current_schema() and column_default like 'nextval(%' and table_name = any($1)`, [portable.dataTables]);
  assert.deepEqual(serials.map(({ name, col }) => `${name}.${col}`).sort(), portable.tablesWithId.map((name) => `${name}.id`).sort());
  const { rows: generated } = await pool.query(
    `select c.relname, a.attname from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = current_schema() and a.attgenerated <> '' and c.relname = any($1)`, [portable.dataTables]);
  assert.deepEqual(generated, [], 'generated columns would need a column list when loading');
});

test('there and back: every row and file as it was, the keys work, and new rows do not collide', async () => {
  const { child } = await seed();
  const before = await snapshot();
  const file = readdirSync(join(dataDir, 'attachments'))[0]!;
  const bytes = createHash('sha256').update(readFileSync(join(dataDir, 'attachments', file))).digest('hex');
  const { file: archive, summary } = await exported();
  assert.equal(summary.files, 1);
  assert.equal(summary.tables.tasks, 2);

  await wipe();
  assert.equal(existsSync(join(dataDir, 'attachments', file)), false);
  assert.equal((await api('GET', '/tasks')).status, 401);

  const imported = await portable.readExport(Readable.from([archive]));
  assert.equal(imported.files, 1);
  assert.deepEqual(await snapshot(), before);
  assert.equal(createHash('sha256').update(readFileSync(join(dataDir, 'attachments', file))).digest('hex'), bytes);

  assert.equal((await api('GET', `/tasks/${child}`)).status, 200);
  assert.equal((await api('GET', '/me', undefined, agentKey)).status, 200);
  const task = await api('POST', '/tasks', { title: 'After the move', project: 'Main', ...run }, agentKey);
  assert.equal(task.status, 201, JSON.stringify(task.body));
  const account = await service.createAccount({ name: 'newcomer', kind: 'agent', role: 'member' });
  assert.equal((await api('GET', '/me', undefined, account.key)).status, 200);
});

test('nothing that only meant something on the old server travels', async () => {
  await seed();
  await pool.query(`insert into settings(key, value) values ('vapid', '{"privateKey":"secret-vapid-value"}')`);
  const { rows: [{ id }] } = await pool.query(`select id from accounts where name = 'person'`);
  await pool.query(`insert into sessions(token_hash, account_id, method, expires_at) values ('secret-session-hash', $1, 'key', now() + interval '1 day')`, [id]);
  const { raw, found } = entries((await exported()).file);
  const text = raw.toString();
  assert.ok(!text.includes('secret-vapid-value'));
  assert.ok(!text.includes('secret-session-hash'));
  for (const table of portable.leftBehind) assert.ok(!found.some(({ name }) => name.startsWith(`tables/${table}/`)), table);
  assert.ok(found.some(({ name }) => name.startsWith('tables/accounts/')));
  assert.equal(found[0]!.name, 'manifest.json');
  assert.equal(found.at(-1)!.name, 'end.json');
});

test('it does not need the only connection of its schema for what follows, and many rows go in parts', async () => {
  await seed();
  await pool.query(`insert into events(task_id, actor_id, type) select (select min(id) from tasks), (select min(id) from accounts), 'x' from generate_series(1, 450)`);
  const { file, summary } = await exported();
  await wipe();
  assert.deepEqual((await portable.readExport(Readable.from([file]))).tables, Object.fromEntries(Object.entries(summary.tables).filter(([, count]) => count > 0)));
});

test('it reads into an empty install only', async () => {
  await seed();
  const { file } = await exported();
  await assert.rejects(portable.readExport(Readable.from([file])), /already has data/);
  assert.equal((await pool.query(`select count(*)::int as n from tasks`)).rows[0].n, 2);
});

test('another schema is refused and says which version to install', async () => {
  await seed();
  const { file } = await exported();
  await wipe();
  await pool.query(`insert into schema_migrations(name) values ('999_future.sql')`);
  try {
    await assert.rejects(portable.readExport(Readable.from([file])), /from version .* different database schema/);
  } finally {
    await pool.query(`delete from schema_migrations where name = '999_future.sql'`);
  }
});

test('a file cut short, damaged or not ours leaves nothing behind', async () => {
  await seed();
  const { file } = await exported();
  await wipe();
  const leavesNothing = async (broken: Buffer, message: RegExp) => {
    await assert.rejects(portable.readExport(Readable.from([broken])), message);
    assert.equal((await pool.query('select count(*)::int as n from tasks')).rows[0].n, 0);
    assert.deepEqual(existsSync(join(dataDir, 'attachments')) ? readdirSync(join(dataDir, 'attachments')) : [], []);
  };
  await leavesNothing(file.subarray(0, file.length - 40), /./);
  const { raw, found } = entries(file);
  await leavesNothing(gzipSync(raw.subarray(0, found.at(-1)!.at)), /ends too early/);
  const flipped = Buffer.from(raw);
  flipped[found[1]!.at + 3] ^= 1;
  await leavesNothing(gzipSync(flipped), /damaged/);
  await leavesNothing(gzipSync(Buffer.alloc(1024)), /not a tracker export/);
  await assert.rejects(portable.readExport(Readable.from([Buffer.from('not gzip at all')])));
  // Counts that do not add up: an entry removed from the middle.
  const part = found.find(({ name }) => name.startsWith('files/'))!;
  const next = found[found.indexOf(part) + 1]!;
  await leavesNothing(gzipSync(Buffer.concat([raw.subarray(0, part.at), raw.subarray(next.at)])), /do not match/);
});

test('names from the file cannot reach outside the tracker\'s folders', async () => {
  await seed();
  const { file } = await exported();
  await wipe();
  const outside = join(dataDir, '..', 'portable-escape-check');
  const refused = ['files/attachments/../../portable-escape-check', 'files/attachments/..', '/etc/passwd', 'files/../secret', 'files/other/x', 'files/attachments', 'tables/sessions/000001.jsonl', 'tables/accounts/../sessions/1.jsonl', 'whatever.txt'];
  for (const name of refused) {
    await assert.rejects(portable.readExport(Readable.from([withEntry(file, name, Buffer.from('{}\n'))])), /unexpected/, name);
    assert.equal(existsSync(outside), false, name);
  }
  // A link is not a file, whatever its name.
  await assert.rejects(portable.readExport(Readable.from([withEntry(file, 'files/attachments/link', Buffer.alloc(0), '2')])), /unexpected/);
  assert.equal((await pool.query('select count(*)::int as n from accounts')).rows[0].n, 0);
});

test('a file already in the folder is not overwritten', async () => {
  await seed();
  const { file } = await exported();
  const name = readdirSync(join(dataDir, 'attachments'))[0]!;
  await wipe();
  mkdirSync(join(dataDir, 'attachments'), { recursive: true });
  writeFileSync(join(dataDir, 'attachments', name), 'already here');
  await assert.rejects(portable.readExport(Readable.from([file])), /EEXIST|exist/);
  assert.equal((await pool.query('select count(*)::int as n from tasks')).rows[0].n, 0);
});
