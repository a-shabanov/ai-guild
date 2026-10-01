// End-to-end tests against a real Postgres (database "aitracker_test", recreated per run).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createHash, generateKeyPairSync, randomBytes, sign, verify } from 'node:crypto';
import http2 from 'node:http2';
import pg from 'pg';

const baseUrl = process.env.DATABASE_URL ?? 'postgres://aitracker:aitracker@127.0.0.1:5433/aitracker';
const testUrl = new URL(baseUrl);
testUrl.pathname = '/aitracker_test';
process.env.DATABASE_URL = testUrl.href;
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'aitracker-test-'));
const ORIGIN = 'https://tracker.test';
process.env.WEBAUTHN_ORIGINS = ORIGIN;

// A stand-in for Apple's push service.
const apnsKey = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const apnsRequests: { path: string; headers: Record<string, any>; body: any }[] = [];
const fakeApns = http2.createServer();
fakeApns.on('stream', (stream: http2.ServerHttp2Stream, headers) => {
  let body = '';
  stream.on('data', (c) => (body += c));
  stream.on('end', () => {
    const path = String(headers[':path']);
    apnsRequests.push({ path, headers, body: JSON.parse(body) });
    const gone = path.endsWith('dead'.repeat(16));
    stream.respond({ ':status': gone ? 410 : 200 });
    stream.end(gone ? JSON.stringify({ reason: 'Unregistered' }) : '');
  });
});
await new Promise<void>((r) => fakeApns.listen(0, '127.0.0.1', r));
process.env.APNS_SANDBOX_URL = `http://127.0.0.1:${(fakeApns.address() as AddressInfo).port}`;
process.env.APNS_KEY = apnsKey.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
process.env.APNS_KEY_ID = 'KEY1234567';
process.env.APNS_TEAM_ID = 'TEAM123456';
process.env.APPLE_APP_IDS = 'TEAM123456.dev.aitracker.app';

let server: Server;
let url: string;
let pool: pg.Pool;
const keys: Record<string, string> = {};

async function api(
  who: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const res = await fetch(url + path, {
    method,
    headers: {
      Authorization: `Bearer ${keys[who]}`,
      ...(body !== undefined && { 'Content-Type': 'application/json' }),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const claude = { model: 'claude-fable-5-1', effort: 'high' };
const codex = { model: 'gpt-5-codex', effort: 'medium' };

before(async () => {
  const admin = new pg.Client({ connectionString: baseUrl });
  await admin.connect();
  await admin.query('drop database if exists aitracker_test with (force)');
  await admin.query('create database aitracker_test');
  await admin.end();

  const db = await import('../src/db.ts');
  const svc = await import('../src/service.ts');
  const { buildApp } = await import('../src/server.ts');
  pool = db.pool;
  await db.migrate();
  keys.ivan = (await svc.createAccount({ name: 'ivan', kind: 'human', role: 'admin' })).key;
  server = buildApp().listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server?.close();
  fakeApns.close();
  await pool?.end();
  rmSync(process.env.DATA_DIR!, { recursive: true, force: true });
});

test('rejects missing and wrong keys', async () => {
  assert.equal((await fetch(url + '/api/tasks')).status, 401);
  keys.nobody = 'ait_wrong';
  assert.equal((await api('nobody', 'GET', '/api/tasks')).status, 401);
});

test('admin creates agent accounts; members cannot', async () => {
  for (const name of ['claude', 'codex']) {
    const res = await api('ivan', 'POST', '/api/accounts', { name, kind: 'agent', system: name });
    assert.equal(res.status, 201);
    assert.match(res.body.key, /^ait_/);
    assert.equal(res.body.account.key_hash, undefined);
    keys[name] = res.body.key;
  }
  const denied = await api('claude', 'POST', '/api/accounts', { name: 'x', kind: 'agent' });
  assert.equal(denied.status, 403);
  const dup = await api('ivan', 'POST', '/api/accounts', { name: 'Claude', kind: 'agent' });
  assert.equal(dup.status, 409, 'names are unique case-insensitively');
  const temp = await api('ivan', 'POST', '/api/accounts', { name: 'temp', kind: 'agent' });
  await api('ivan', 'PATCH', `/api/accounts/${temp.body.account.id}`, { disabled: true });
  keys.disabled = temp.body.key;
  assert.equal((await api('disabled', 'GET', '/api/me')).status, 401);
});

test('agents must state model and effort; humans need not', async () => {
  const bad = await api('claude', 'POST', '/api/tasks', { title: 'no run info' });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /model.*effort/);
  const human = await api('ivan', 'POST', '/api/tasks', { title: 'human task', assignee: 'claude' });
  assert.equal(human.status, 201);
  assert.equal(human.body.assignee_name, 'claude');
});

test('full task lifecycle with discussion, time and review loop', async () => {
  const created = await api('claude', 'POST', '/api/tasks', {
    title: 'Fix login bug',
    description: 'Users get 500 on login',
    project: 'webapp',
    assignee: 'me',
    labels: ['bug'],
    ...claude,
  });
  assert.equal(created.status, 201);
  const id = created.body.id;
  assert.equal(created.body.model, claude.model);

  const timer = await api('claude', 'POST', `/api/tasks/${id}/timer/start`, claude);
  assert.equal(timer.status, 201);
  assert.equal(timer.body.seconds, null);
  assert.equal((await api('claude', 'GET', `/api/tasks/${id}`)).body.status, 'in_progress');

  const c1 = await api('codex', 'POST', `/api/tasks/${id}/comments`, {
    body: '@claude check the session middleware',
    ...codex,
  });
  assert.equal(c1.status, 201);

  const stopped = await api('claude', 'POST', `/api/tasks/${id}/timer/stop`, {
    input_tokens: 1000,
    output_tokens: 500,
    cost_usd: 0.25,
  });
  assert.equal(stopped.status, 200);
  assert.ok(stopped.body.seconds >= 1);

  const logged = await api('codex', 'POST', `/api/tasks/${id}/time`, {
    seconds: 600,
    input_tokens: 2000,
    output_tokens: 100,
    cost_usd: 0.1,
    ...codex,
  });
  assert.equal(logged.status, 201);
  assert.equal(logged.body.seconds, 600);

  const result = await api('claude', 'POST', `/api/tasks/${id}/result`, {
    result: 'Fixed null check in session middleware',
    ...claude,
  });
  assert.equal(result.body.status, 'review');
  assert.equal(result.body.result_model, claude.model);

  // The human reviews and asks for more; the agent sees it in the inbox.
  await api('ivan', 'POST', `/api/tasks/${id}/comments`, { body: 'Add a regression test please' });
  await api('ivan', 'PATCH', `/api/tasks/${id}`, { status: 'in_progress' });

  const inbox = await api('claude', 'GET', '/api/inbox');
  const types = inbox.body.events.filter((e: any) => e.task_id === id).map((e: any) => e.type);
  assert.deepEqual(types, ['comment_added', 'comment_added', 'status_changed']);
  const human = inbox.body.events.find((e: any) => e.actor_name === 'ivan' && e.type === 'comment_added');
  assert.equal(human.data.body, 'Add a regression test please');
  assert.ok(inbox.body.events.every((e: any) => e.actor_name !== 'claude'));

  const last = inbox.body.events.at(-1).id;
  await api('claude', 'POST', '/api/inbox/ack', { up_to: last });
  assert.equal((await api('claude', 'GET', '/api/inbox')).body.events.length, 0);

  const done = await api('ivan', 'PATCH', `/api/tasks/${id}`, { status: 'done' });
  assert.ok(done.body.completed_at);
  assert.equal(done.body.comments.length, 2);
  assert.equal(done.body.time_logs.length, 2);
  assert.ok(done.body.total_seconds >= 601);
});

test('attachments: multipart and raw upload, download with range, no inline html', async () => {
  const task = (await api('codex', 'POST', '/api/tasks', { title: 'attachments', ...codex })).body;
  const form = new FormData();
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
  );
  form.append('file', new Blob([png]), 'скриншот.png');
  form.append('file', new Blob(['line1\nline2\n']), 'build.log');
  const up = await fetch(`${url}/api/tasks/${task.id}/attachments`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${keys.codex}` },
    body: form,
  });
  assert.equal(up.status, 201);
  const files = await up.json();
  assert.deepEqual(files.map((f: any) => [f.filename, f.kind, f.mime]), [
    ['скриншот.png', 'image', 'image/png'],
    ['build.log', 'log', 'text/plain'],
  ]);

  const raw = await fetch(`${url}/api/tasks/${task.id}/attachments?filename=demo.mp4`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${keys.codex}`, 'Content-Type': 'video/mp4' },
    body: Buffer.alloc(5000, 7),
  });
  assert.equal(raw.status, 201);
  const [video] = await raw.json();
  assert.equal(video.kind, 'video');

  const range = await fetch(url + video.url, {
    headers: { Authorization: `Bearer ${keys.ivan}`, Range: 'bytes=0-99' },
  });
  assert.equal(range.status, 206);
  assert.equal((await range.arrayBuffer()).byteLength, 100);
  assert.equal(range.headers.get('content-type'), 'video/mp4');

  const html = await fetch(`${url}/api/tasks/${task.id}/attachments?filename=x.html`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${keys.codex}` },
    body: '<script>alert(1)</script>',
  });
  const [page] = await html.json();
  const got = await fetch(url + page.url, { headers: { Authorization: `Bearer ${keys.ivan}` } });
  assert.match(got.headers.get('content-type')!, /^text\/plain/);
  assert.equal(got.headers.get('x-content-type-options'), 'nosniff');

  // The preview frame gets the page, locked into a sandbox without network access.
  const framed = await fetch(`${url}${page.url}?render=1`, { headers: { Authorization: `Bearer ${keys.ivan}` } });
  assert.match(framed.headers.get('content-type')!, /^text\/html/);
  const policy = framed.headers.get('content-security-policy')!;
  assert.match(policy, /default-src 'none'/);
  assert.match(policy, /sandbox allow-scripts$/);
  assert.doesNotMatch(policy, /allow-same-origin/);
  const notPage = await fetch(`${url}${video.url}?render=1`, { headers: { Authorization: `Bearer ${keys.ivan}` } });
  assert.equal(notPage.headers.get('content-type'), 'video/mp4');

  assert.equal((await fetch(url + video.url)).status, 401);
  assert.equal((await api('ivan', 'GET', `/api/tasks/${task.id}`)).body.attachments.length, 4);
});

test('analytics groups by model and effort', async () => {
  const res = await api('ivan', 'GET', '/api/analytics?group_by=model,effort');
  assert.equal(res.status, 200);
  const row = res.body.rows.find((r: any) => r.keys[0] === codex.model);
  assert.deepEqual(row.keys, [codex.model, codex.effort]);
  assert.equal(row.seconds, 600);
  assert.equal(row.input_tokens, 2000);
  assert.equal(row.cost_usd, 0.1);
  assert.equal(res.body.totals.entries, 2);
  assert.equal(res.body.tasks_by_status.done, 1);

  const byDay = await api('ivan', 'GET', '/api/analytics?group_by=day');
  assert.match(byDay.body.rows[0].keys[0], /^\d{4}-\d{2}-\d{2}$/);
  assert.equal((await api('ivan', 'GET', '/api/analytics?group_by=nope')).status, 400);

  const unknown = (await api('codex', 'POST', '/api/tasks', { title: 'unknown cost', project: 'UnpricedTest', ...codex })).body;
  await api('codex', 'POST', `/api/tasks/${unknown.id}/time`, { seconds: 60, ...codex });
  const unpriced = (await api('ivan', 'GET', '/api/analytics?group_by=model&project=UnpricedTest')).body;
  assert.equal(unpriced.rows[0].unpriced_entries, 1);
  assert.equal(unpriced.totals.unpriced_entries, 1);
});

test('cookie session works for the web UI', async () => {
  const login = await fetch(url + '/api/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: keys.ivan }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')!;
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  const me = await fetch(url + '/api/me', { headers: { Cookie: cookie.split(';')[0]! } });
  assert.equal((await me.json()).name, 'ivan');
});

test('a person oversees agents: results and blockers reach them without being involved', async () => {
  const before = (await api('ivan', 'GET', '/api/inbox')).body.events;
  if (before.length) await api('ivan', 'POST', '/api/inbox/ack', { up_to: before.at(-1).id });

  const task = (await api('claude', 'POST', '/api/tasks', { title: 'agents only', assignee: 'codex', ...claude })).body;
  await api('codex', 'POST', `/api/tasks/${task.id}/comments`, { body: 'working on it', ...codex });
  await api('codex', 'POST', `/api/tasks/${task.id}/result`, { result: 'done', ...codex });
  await api('codex', 'PATCH', `/api/tasks/${task.id}`, { status: 'blocked', ...codex });

  const human = (await api('ivan', 'GET', '/api/inbox')).body.events.filter((e: any) => e.task_id === task.id);
  assert.deepEqual(human.map((e: any) => e.type), ['task_created', 'result_submitted', 'status_changed']);

  // Another agent that has nothing to do with the task hears nothing.
  const other = await api('ivan', 'POST', '/api/accounts', { name: 'bystander', kind: 'agent' });
  keys.bystander = other.body.key;
  const agent = (await api('bystander', 'GET', '/api/inbox')).body.events;
  assert.equal(agent.filter((e: any) => e.task_id === task.id).length, 0);
});

test('a watcher reads the inbox from its own place and reports the runs it starts', async () => {
  const task = (await api('ivan', 'POST', '/api/tasks', { title: 'wake me', assignee: 'codex', project: 'Wake' })).body;
  const first = (await api('ivan', 'POST', `/api/tasks/${task.id}/comments`, { body: '@codex start' })).body;
  const inbox = (await api('codex', 'GET', '/api/inbox?limit=200')).body.events;
  const mine = inbox.filter((e: any) => e.task_id === task.id);
  assert.deepEqual(mine.map((e: any) => e.type), ['task_created', 'comment_added']);
  assert.equal(mine[0].project, 'Wake');
  assert.equal(mine[0].assignee_name, 'codex');

  // Reading on from the last seen event acknowledges nothing.
  const last = mine.at(-1).id;
  await api('ivan', 'POST', `/api/tasks/${task.id}/comments`, { body: 'and one more thing' });
  const next = (await api('codex', 'GET', `/api/inbox?after=${last}`)).body;
  assert.deepEqual(next.events.map((e: any) => e.data.body), ['and one more thing']);
  assert.ok(next.cursor < last);
  assert.ok(first.id);

  assert.equal((await api('ivan', 'POST', `/api/tasks/${task.id}/runs`, { state: 'started' })).status, 403);
  assert.equal((await api('codex', 'POST', `/api/tasks/${task.id}/runs`, { state: 'started', trigger: last })).status, 201);
  assert.equal((await api('codex', 'POST', `/api/tasks/${task.id}/runs`, { state: 'failed', detail: 'exit 1' })).status, 201);
  const events = (await api('ivan', 'GET', `/api/tasks/${task.id}`)).body.events.filter((e: any) => e.type === 'agent_run');
  assert.deepEqual(events.map((e: any) => e.data.state), ['started', 'failed']);
  // The person hears about the failure only; other agents hear nothing.
  const human = (await api('ivan', 'GET', '/api/inbox?limit=200')).body.events.filter((e: any) => e.type === 'agent_run');
  assert.deepEqual(human.map((e: any) => e.data.state), ['failed']);
  const agent = (await api('claude', 'GET', '/api/inbox?limit=200')).body.events.filter((e: any) => e.type === 'agent_run');
  assert.equal(agent.length, 0);
});

test('inbox: a task that was opened is read, until something new happens in it', async () => {
  const mine = async () => (await api('ivan', 'GET', '/api/inbox?limit=200')).body.events;
  const a = (await api('claude', 'POST', '/api/tasks', { title: 'read me', ...claude })).body;
  const b = (await api('claude', 'POST', '/api/tasks', { title: 'leave me', ...claude })).body;
  await api('claude', 'POST', `/api/tasks/${a.id}/result`, { result: 'done', ...claude });
  assert.equal((await mine()).filter((e: any) => e.task_id === a.id).length, 2);

  assert.equal((await api('ivan', 'POST', '/api/inbox/read', { task_id: a.id })).status, 200);
  const after = await mine();
  assert.equal(after.filter((e: any) => e.task_id === a.id).length, 0);
  assert.equal(after.filter((e: any) => e.task_id === b.id).length, 1);

  await api('claude', 'PATCH', `/api/tasks/${a.id}`, { status: 'blocked', ...claude });
  assert.deepEqual((await mine()).filter((e: any) => e.task_id === a.id).map((e: any) => e.type), ['status_changed']);
  assert.equal((await api('ivan', 'POST', '/api/inbox/read', { task_id: 999999 })).status, 404);
});

test('an agent writes down what the person asked for, under the person\'s name', async () => {
  const task = await api('claude', 'POST', '/api/tasks', {
    title: 'Добавить экспорт в CSV',
    description: 'Нужен экспорт списка задач в CSV.',
    original_text: 'сделай чтоб в csv выгружалось',
    on_behalf_of: 'ivan',
    happened_at: '2026-09-01T09:00:00Z',
    assignee: 'me',
    ...claude,
  });
  assert.equal(task.status, 201);
  assert.equal(task.body.created_by_name, 'ivan');
  assert.equal(task.body.recorded_by_name, 'claude');
  assert.equal(task.body.original_text, 'сделай чтоб в csv выгружалось');
  assert.equal(task.body.model, null, 'a person has no model');
  assert.equal(new Date(task.body.created_at).toISOString(), '2026-09-01T09:00:00.000Z');
  assert.equal(task.body.assignee_name, 'claude');

  const note = await api('claude', 'POST', `/api/tasks/${task.body.id}/comments`, {
    body: 'Разделитель — точка с запятой.',
    on_behalf_of: 'ivan',
    ...claude,
  });
  assert.equal(note.body.author_name, 'ivan');
  assert.equal(note.body.recorded_by_name, 'claude');

  // The one who wrote it down is not told about it; nobody may speak for an agent.
  const inbox = (await api('claude', 'GET', '/api/inbox')).body.events;
  assert.equal(inbox.filter((e: any) => e.task_id === task.body.id).length, 0);
  const forAgent = await api('claude', 'POST', '/api/tasks', { title: 'x', on_behalf_of: 'codex', ...claude });
  assert.equal(forAgent.status, 400);
  const future = await api('claude', 'POST', '/api/tasks', { title: 'x', happened_at: '2999-01-01T00:00:00Z', ...claude });
  assert.equal(future.status, 400);
});

test('hierarchy: epic > story > task > subtask, with kinds and rolled-up time', async () => {
  const make = (body: object) => api('claude', 'POST', '/api/tasks', { ...body, ...claude });
  const epic = (await make({ title: 'Epic', level: 'epic', project: 'Tree' })).body;
  const story = (await make({ title: 'Story', level: 'story', parent_id: epic.id, kind: 'visual' })).body;
  const task = (await make({ title: 'Task', parent_id: story.id, kind: 'technical' })).body;
  const sub = (await make({ title: 'Sub', level: 'subtask', parent_id: task.id })).body;
  assert.equal(task.level, 'task', 'task is the default level');
  assert.equal(sub.project, 'Tree', 'children inherit the project');
  assert.deepEqual(sub.ancestors.map((a: any) => a.title), ['Epic', 'Story', 'Task']);

  const upside = await make({ title: 'x', level: 'story', parent_id: task.id });
  assert.equal(upside.status, 400);
  assert.match(upside.body.error, /story cannot be part of a task/);
  assert.equal((await make({ title: 'x', level: 'epic', parent_id: epic.id })).status, 400);
  assert.equal((await make({ title: 'x', kind: 'audio' })).status, 400);

  const demote = await api('claude', 'PATCH', `/api/tasks/${story.id}`, { level: 'subtask', ...claude });
  assert.equal(demote.status, 400, 'it has a task under it');
  const moved = await api('claude', 'PATCH', `/api/tasks/${sub.id}`, { parent_id: null, kind: 'visual', ...claude });
  assert.equal(moved.body.parent_id, null);
  await api('claude', 'PATCH', `/api/tasks/${sub.id}`, { parent_id: task.id, ...claude });

  await api('claude', 'POST', `/api/tasks/${sub.id}/time`, { seconds: 100, ...claude });
  await api('claude', 'POST', `/api/tasks/${task.id}/time`, { seconds: 50, ...claude });
  await api('claude', 'PATCH', `/api/tasks/${sub.id}`, { status: 'done', ...claude });
  const top = (await api('ivan', 'GET', `/api/tasks/${epic.id}`)).body;
  assert.equal(top.total_seconds, 0);
  assert.equal(top.tree_seconds, 150);
  assert.deepEqual(top.children.map((c: any) => [c.title, c.level, c.kind]), [['Story', 'story', 'visual']]);
  const mid = (await api('ivan', 'GET', `/api/tasks/${task.id}`)).body;
  assert.deepEqual([mid.child_count, mid.child_done], [1, 1]);

  const list = (q: string) => api('ivan', 'GET', `/api/tasks?project=Tree&status=&${q}`).then((r) => r.body.map((x: any) => x.title).sort());
  assert.deepEqual(await list('level=epic,story'), ['Epic', 'Story']);
  assert.deepEqual(await list('kind=technical'), ['Task']);
  assert.deepEqual(await list('parent=none'), ['Epic']);
  assert.deepEqual(await list(`parent=${task.id}`), ['Sub']);
});

test('links: blocks, relates, duplicates, read from both sides', async () => {
  const make = (title: string) => api('claude', 'POST', '/api/tasks', { title, ...claude }).then((r) => r.body.id);
  const [a, b, c] = [await make('A'), await make('B'), await make('C')];
  const link = (from: number, body: object) => api('claude', 'POST', `/api/tasks/${from}/links`, body);

  const first = await link(a, { to: b, type: 'blocks' });
  assert.equal(first.status, 201);
  assert.deepEqual(first.body.links.map((l: any) => [l.type, l.task.title]), [['blocks', 'B']]);
  await link(a, { to: c, type: 'blocked_by' });
  await link(a, { to: c, type: 'relates' });

  const seenFromB = (await api('ivan', 'GET', `/api/tasks/${b}`)).body.links;
  assert.deepEqual(seenFromB.map((l: any) => [l.type, l.task.title]), [['blocked_by', 'A']]);
  const seenFromC = (await api('ivan', 'GET', `/api/tasks/${c}`)).body.links;
  assert.deepEqual(seenFromC.map((l: any) => [l.type, l.task.title]), [['blocks', 'A'], ['relates', 'A']]);

  assert.equal((await link(b, { to: a, type: 'blocks' })).status, 409, 'nothing blocks what blocks it');
  assert.equal((await link(c, { to: a, type: 'relates' })).status, 409, 'relates has no direction');
  assert.equal((await link(a, { to: a, type: 'relates' })).status, 400);
  assert.equal((await link(a, { to: 999999, type: 'relates' })).status, 404);

  const gone = await api('claude', 'DELETE', `/api/tasks/${b}/links/${seenFromB[0].id}`);
  assert.equal(gone.status, 200, JSON.stringify(gone.body));
  assert.equal(gone.body.links.length, 0);
  assert.equal((await api('ivan', 'GET', `/api/tasks/${a}`)).body.links.length, 2);
});

test('history: recorded with its own dates and without notifying anyone', async () => {
  const before = (await api('ivan', 'GET', '/api/inbox')).body.events.length;
  const old = (path: string, body: object) =>
    fetch(url + path, {
      method: 'POST',
      headers: { Authorization: `Bearer ${keys.claude}`, 'Content-Type': 'application/json', 'X-Tracker-History': '1' },
      body: JSON.stringify({ ...body, ...claude }),
    }).then((r) => r.json());
  const task = await old('/api/tasks', { title: 'Old work', on_behalf_of: 'ivan', assignee: 'me', happened_at: '2026-08-01T10:00:00Z' });
  await old(`/api/tasks/${task.id}/time`, { seconds: 600, started_at: '2026-08-01T10:00:00Z' });
  const done = await old(`/api/tasks/${task.id}/result`, { result: 'was done', status: 'done', happened_at: '2026-08-01T10:10:00Z' });
  assert.equal(new Date(done.created_at).toISOString(), '2026-08-01T10:00:00.000Z');
  assert.equal(new Date(done.completed_at).toISOString(), '2026-08-01T10:10:00.000Z');
  assert.equal(new Date(done.updated_at).toISOString(), '2026-08-01T10:10:00.000Z');
  assert.ok(done.events.every((e: any) => e.data.history === true));
  assert.equal((await api('ivan', 'GET', '/api/inbox')).body.events.length, before, 'nothing new in the inbox');
});

test('timeline: work by day in the asked time zone', async () => {
  const task = (await api('claude', 'POST', '/api/tasks', { title: 'Timed', project: 'Line', ...claude })).body;
  const log = (seconds: number, started_at: string) => api('claude', 'POST', `/api/tasks/${task.id}/time`, { seconds, started_at, ...claude });
  await log(600, '2026-09-01T10:00:00Z');
  await log(300, '2026-09-01T12:00:00Z');
  await log(120, '2026-09-02T20:00:00Z'); // already 3 September in Makassar (UTC+8)
  await api('claude', 'POST', '/api/tasks', { title: 'Untimed', project: 'Line', ...claude });

  const utc = (await api('ivan', 'GET', '/api/timeline?project=Line')).body.tasks;
  assert.deepEqual(utc.map((t: any) => t.title), ['Timed', 'Untimed']);
  assert.deepEqual(utc[0].days, { '2026-09-01': 900, '2026-09-02': 120 });
  assert.equal(utc[0].seconds, 1020);
  assert.equal(new Date(utc[0].ended_at).toISOString(), '2026-09-02T20:02:00.000Z');
  assert.deepEqual(utc[1].days, {});

  const local = (await api('ivan', 'GET', '/api/timeline?project=Line&tz=Asia/Makassar')).body.tasks;
  assert.deepEqual(local[0].days, { '2026-09-01': 900, '2026-09-03': 120 });
  assert.equal((await api('ivan', 'GET', "/api/timeline?tz=UTC';drop")).status, 400);
});

test('projects exist before their first task and ignore letter case', async () => {
  const made = await api('claude', 'POST', '/api/projects', { name: 'Drop', description: 'x' });
  assert.equal(made.status, 201);
  assert.equal(made.body.tasks, 0);
  assert.equal((await api('claude', 'POST', '/api/projects', { name: 'drop' })).status, 409);

  const task = await api('ivan', 'POST', '/api/tasks', { title: 'in drop', project: 'DROP' });
  assert.equal(task.body.project, 'Drop');
  const auto = await api('ivan', 'POST', '/api/tasks', { title: 'new one', project: 'Fresh' });
  assert.equal(auto.body.project, 'Fresh');

  const names = (await api('ivan', 'GET', '/api/projects')).body;
  assert.ok(['Drop', 'Fresh', 'webapp'].every((n) => names.includes(n)));
  const details = (await api('ivan', 'GET', '/api/projects?details=1')).body;
  assert.equal(details.find((p: any) => p.name === 'Drop').tasks, 1);
  assert.equal(details.find((p: any) => p.name === 'webapp').total_seconds > 600, true);
});

test('several models work on one task in parallel, each with its own entry', async () => {
  const task = (await api('claude', 'POST', '/api/tasks', { title: 'parallel', ...claude })).body;
  const start = (body: object) => api('claude', 'POST', `/api/tasks/${task.id}/timer/start`, body);
  const main = (await start({ ...claude, worker: 'main session' })).body;
  const sub = (await start({ model: 'claude-haiku-4-5', effort: 'low', worker: 'sub-agent: tests' })).body;
  const twin = (await start({ model: 'claude-haiku-4-5', effort: 'low', worker: 'sub-agent: docs' })).body;
  assert.equal(new Set([main.id, sub.id, twin.id]).size, 3);
  await api('codex', 'POST', `/api/tasks/${task.id}/timer/start`, codex);

  const stop = (body: object) => api('claude', 'POST', `/api/tasks/${task.id}/timer/stop`, body);
  const unclear = await stop({});
  assert.equal(unclear.status, 409);
  assert.match(unclear.body.error, /sub-agent: tests/);
  assert.equal((await stop({ model: 'claude-haiku-4-5' })).status, 409, 'two haiku timers');

  assert.equal((await stop({ worker: 'sub-agent: tests', output_tokens: 10 })).body.id, sub.id);
  assert.equal((await stop({ time_log_id: twin.id })).body.id, twin.id);
  assert.equal((await stop({ time_log_id: twin.id })).status, 404, 'already stopped');
  assert.equal((await stop({})).body.id, main.id, 'one left: nothing to choose');

  const logs = (await api('ivan', 'GET', `/api/tasks/${task.id}`)).body.time_logs;
  assert.equal(logs.length, 4);
  assert.deepEqual(logs.filter((l: any) => l.seconds === null).map((l: any) => l.account_name), ['codex']);
  const byWorker = (await api('ivan', 'GET', '/api/analytics?group_by=worker,model')).body.rows;
  assert.ok(byWorker.some((r: any) => r.keys[0] === 'sub-agent: tests' && r.keys[1] === 'claude-haiku-4-5'));
});

test('time logs carry cache tokens and can be corrected by their author', async () => {
  const task = (await api('claude', 'POST', '/api/tasks', { title: 'usage', ...claude })).body;
  const log = (await api('claude', 'POST', `/api/tasks/${task.id}/time`, { seconds: 60, ...claude })).body;
  assert.equal(log.cache_read_tokens, null);

  const fixed = await api('claude', 'PATCH', `/api/time-logs/${log.id}`, {
    seconds: 300,
    started_at: '2026-09-01T10:00:00Z',
    input_tokens: 10,
    output_tokens: 2000,
    cache_read_tokens: 500000,
    cache_write_tokens: 8000,
    cost_usd: 0.39,
  });
  assert.equal(fixed.status, 200);
  assert.equal(fixed.body.seconds, 300);
  assert.equal(fixed.body.cache_read_tokens, 500000);
  assert.equal(new Date(fixed.body.ended_at).toISOString(), '2026-09-01T10:05:00.000Z');
  assert.equal(fixed.body.model, claude.model, 'untouched fields stay');

  assert.equal((await api('codex', 'PATCH', `/api/time-logs/${log.id}`, { cost_usd: 0 })).status, 403);
  assert.equal((await api('ivan', 'PATCH', `/api/time-logs/${log.id}`, { note: 'checked' })).status, 200);

  const row = (await api('ivan', 'GET', '/api/analytics?group_by=task')).body.rows
    .find((r: any) => r.keys[0] === `#${task.id} usage`);
  assert.equal(row.cache_read_tokens, 500000);
  assert.equal(row.cache_write_tokens, 8000);
});

test('project pages: description, colour, logo, rename follows tasks', async () => {
  const p = (await api('ivan', 'POST', '/api/projects', { name: 'Pages', color: '#ff6a3d' })).body;
  assert.equal(p.logo_url, null);
  await api('claude', 'POST', '/api/tasks', { title: 'in pages', project: 'Pages', assignee: 'codex', ...claude });

  const put = (type: string, body: Buffer) =>
    fetch(`${url}/api/projects/${p.id}/logo`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${keys.ivan}`, 'Content-Type': type },
      body: new Uint8Array(body),
    });
  assert.equal((await put('image/svg+xml', Buffer.from('<svg/>'))).status, 415);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  const withLogo = await (await put('image/png', png)).json();
  assert.match(withLogo.logo_url, /^\/api\/projects\/\d+\/logo\?v=/);
  const img = await fetch(url + withLogo.logo_url, { headers: { Authorization: `Bearer ${keys.claude}` } });
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.equal((await img.arrayBuffer()).byteLength, png.length);
  assert.equal((await fetch(url + withLogo.logo_url)).status, 401);

  const renamed = await api('ivan', 'PATCH', `/api/projects/${p.id}`, { name: 'Pages 2', description: '**hi**' });
  assert.equal(renamed.body.tasks, 1, 'tasks followed the rename');
  assert.deepEqual(renamed.body.tasks_by_status, { todo: 1 });
  assert.deepEqual(renamed.body.members.map((m: any) => m.name).sort(), ['claude', 'codex']);
  assert.equal(renamed.body.color, '#ff6a3d');
});

test('openapi document is generated', async () => {
  const doc = await (await fetch(url + '/api/openapi.json')).json();
  assert.ok(doc.paths['/api/tasks'].post.requestBody);
  assert.ok(doc.paths['/api/tasks/{id}/time'].post);
});

test('MCP: agent works through tools end to end', async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import(
    '@modelcontextprotocol/sdk/client/streamableHttp.js'
  );
  const connect = async (who: string) => {
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(url + '/mcp'), {
        requestInit: { headers: { Authorization: `Bearer ${keys[who]}` } },
      }),
    );
    return client;
  };
  const call = async (client: any, name: string, args: object = {}) => {
    const res = await client.callTool({ name, arguments: args });
    const text = res.content[0].text;
    let data: any = text;
    try {
      data = JSON.parse(text);
    } catch {}
    return { isError: !!res.isError, data, content: res.content };
  };

  await assert.rejects(connect('nobody'));

  const c = await connect('claude');
  assert.match(c.getInstructions()!, /get_inbox/);
  const tools = (await c.listTools()).tools;
  const createTool = tools.find((t: any) => t.name === 'create_task')!;
  assert.ok((createTool.inputSchema.required as string[]).includes('model'));
  assert.ok((createTool.inputSchema.required as string[]).includes('effort'));

  assert.equal((await call(c, 'whoami')).data.name, 'claude');

  const task = (await call(c, 'create_task', { title: 'via mcp', assignee: 'me', ...claude })).data;
  assert.equal(task.assignee, 'claude');

  await call(c, 'start_timer', { task_id: task.id, ...claude });
  const att = await call(c, 'attach_text', {
    task_id: task.id,
    filename: 'run.log',
    content: 'a'.repeat(50) + 'THE END',
  });
  assert.equal(att.data.kind, 'log');
  const tail = await call(c, 'read_attachment', {
    attachment_id: att.data.id,
    tail: true,
    max_bytes: 7,
  });
  assert.match(tail.data, /THE END$/);

  await api('ivan', 'POST', `/api/tasks/${task.id}/comments`, { body: 'looks wrong, redo' });
  const inbox = await call(c, 'get_inbox');
  const ev = inbox.data.events.find((e: any) => e.task_id === task.id);
  assert.equal(ev.body, 'looks wrong, redo');
  assert.equal(ev.by, 'ivan (human)');
  await call(c, 'ack_inbox', { up_to: inbox.data.events.at(-1).event_id });
  assert.equal((await call(c, 'get_inbox')).data, 'Inbox is empty.');

  await call(c, 'stop_timer', { task_id: task.id, input_tokens: 10, output_tokens: 5 });
  const res = await call(c, 'submit_result', { task_id: task.id, result: 'done', ...claude });
  assert.equal(res.data.status, 'review');

  const missing = await call(c, 'get_task', { task_id: 999999 });
  assert.equal(missing.isError, true);
  assert.match(missing.data, /not found/);

  const mine = await call(c, 'list_tasks', { assignee: 'me' });
  assert.ok(mine.data.some((t: any) => t.id === task.id));
  await c.close();
});

// ---- passkeys ----

const b64u = (b: Uint8Array) => Buffer.from(b).toString('base64url');
const sha256 = (b: string | Uint8Array) => createHash('sha256').update(b).digest();

// A software authenticator standing in for Face ID: an ES256 key pair that signs challenges.
function fakeAuthenticator(origin = ORIGIN, rpId = new URL(ORIGIN).hostname) {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const credId = randomBytes(16);
  const id = b64u(credId);
  const cose = Buffer.concat([
    Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]),
    Buffer.from(jwk.x!, 'base64url'),
    Buffer.from([0x22, 0x58, 0x20]),
    Buffer.from(jwk.y!, 'base64url'),
  ]);
  let counter = 0;
  const authData = (flags: number, extra = Buffer.alloc(0)) => {
    const count = Buffer.alloc(4);
    count.writeUInt32BE(++counter);
    return Buffer.concat([sha256(rpId), Buffer.from([flags]), count, extra]);
  };
  const clientData = (type: string, challenge: string) =>
    Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  const base = { id, rawId: id, type: 'public-key', clientExtensionResults: {} };
  return {
    register(options: any) {
      const len = Buffer.alloc(2);
      len.writeUInt16BE(credId.length);
      const ad = authData(0x45, Buffer.concat([Buffer.alloc(16), len, credId, cose]));
      const attestation = Buffer.concat([
        Buffer.from([0xa3, 0x63]), Buffer.from('fmt'), Buffer.from([0x64]), Buffer.from('none'),
        Buffer.from([0x67]), Buffer.from('attStmt'), Buffer.from([0xa0]),
        Buffer.from([0x68]), Buffer.from('authData'), Buffer.from([0x58, ad.length]), ad,
      ]);
      return {
        ...base,
        response: {
          clientDataJSON: b64u(clientData('webauthn.create', options.challenge)),
          attestationObject: b64u(attestation),
          transports: ['internal'],
        },
      };
    },
    login(options: any, { verified = true } = {}) {
      const ad = authData(verified ? 0x05 : 0x01);
      const cd = clientData('webauthn.get', options.challenge);
      return {
        ...base,
        response: {
          clientDataJSON: b64u(cd),
          authenticatorData: b64u(ad),
          signature: b64u(sign('sha256', Buffer.concat([ad, sha256(cd)]), privateKey)),
        },
      };
    },
  };
}

async function post(path: string, body?: unknown, cookie?: string) {
  const res = await fetch(url + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie && { Cookie: cookie }) },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, body: await res.json(), cookie: res.headers.get('set-cookie')?.split(';')[0] };
}

async function passkeyLogin(device: ReturnType<typeof fakeAuthenticator>, opts?: { verified: boolean }) {
  const { body } = await post('/api/passkeys/login/options');
  return post('/api/passkeys/login/verify', {
    challenge_id: body.challenge_id,
    response: device.login(body.options, opts),
  });
}

test('passkeys: register, sign in without a key, revoke', async () => {
  const device = fakeAuthenticator();
  const reg = await api('ivan', 'POST', '/api/passkeys/register/options');
  assert.equal(reg.body.options.rp.id, 'tracker.test');
  assert.equal(reg.body.options.authenticatorSelection.userVerification, 'required');
  assert.equal(reg.body.options.authenticatorSelection.residentKey, 'required');

  const credential = device.register(reg.body.options);
  const saved = await api('ivan', 'POST', '/api/passkeys/register/verify', {
    challenge_id: reg.body.challenge_id,
    response: credential,
    name: 'iPhone',
  });
  assert.equal(saved.status, 201);
  assert.equal(saved.body.name, 'iPhone');
  assert.equal(saved.body.public_key, undefined);

  const replay = await api('ivan', 'POST', '/api/passkeys/register/verify', {
    challenge_id: reg.body.challenge_id,
    response: credential,
  });
  assert.equal(replay.status, 400, 'a challenge works once');

  const login = await passkeyLogin(device);
  assert.equal(login.status, 200);
  assert.equal(login.body.name, 'ivan');
  assert.match(login.cookie!, /^ait_session=ats_/);
  const me = await fetch(url + '/api/me', { headers: { Cookie: login.cookie! } });
  assert.equal((await me.json()).name, 'ivan');

  assert.equal((await passkeyLogin(device, { verified: false })).status, 401, 'biometrics required');
  assert.equal((await passkeyLogin(fakeAuthenticator())).status, 401, 'unknown passkey');

  const list = await api('ivan', 'GET', '/api/passkeys');
  assert.equal(list.body.length, 1);
  assert.ok(list.body[0].last_used_at);

  // Someone else cannot delete it; the owner can, and that ends passkey sessions.
  const foreign = await fetch(`${url}/api/passkeys/${list.body[0].id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${keys.claude}` },
  });
  assert.equal(foreign.status, 404);
  await api('ivan', 'DELETE', `/api/passkeys/${list.body[0].id}`);
  assert.equal((await passkeyLogin(device)).status, 401);
  const after = await fetch(url + '/api/me', { headers: { Cookie: login.cookie! } });
  assert.equal(after.status, 401);
});

test('passkeys: a phishing origin is rejected', async () => {
  const device = fakeAuthenticator('https://tracker.evil.test');
  const reg = await api('ivan', 'POST', '/api/passkeys/register/options');
  const res = await api('ivan', 'POST', '/api/passkeys/register/verify', {
    challenge_id: reg.body.challenge_id,
    response: device.register(reg.body.options),
  });
  assert.equal(res.status, 400);
  assert.equal((await api('ivan', 'GET', '/api/passkeys')).body.length, 0);
});

test('sessions: cookie holds a token, not the key; sign-out kills it', async () => {
  const login = await post('/api/session', { key: keys.ivan });
  assert.match(login.cookie!, /^ait_session=ats_/);
  assert.ok(!login.cookie!.includes(keys.ivan!));
  await fetch(url + '/api/session', { method: 'DELETE', headers: { Cookie: login.cookie! } });
  const me = await fetch(url + '/api/me', { headers: { Cookie: login.cookie! } });
  assert.equal(me.status, 401);
});

test('push: subscriptions only for real push services', async () => {
  const key = await api('ivan', 'GET', '/api/push/key');
  assert.ok(key.body.key.length > 80);
  assert.equal((await api('ivan', 'GET', '/api/push/key')).body.key, key.body.key, 'key is stable');

  const keysPart = { p256dh: 'x', auth: 'y' };
  const evil = await api('ivan', 'POST', '/api/push/subscriptions', {
    endpoint: 'https://internal.example.com/hook',
    keys: keysPart,
  });
  assert.equal(evil.status, 400);
  const endpoint = 'https://web.push.apple.com/abc';
  const good = await api('ivan', 'POST', '/api/push/subscriptions', { endpoint, keys: keysPart });
  assert.equal(good.status, 201);
  assert.equal((await api('ivan', 'DELETE', '/api/push/subscriptions', { endpoint })).status, 200);
  const left = await pool.query('select count(*)::int as n from push_subscriptions');
  assert.equal(left.rows[0].n, 0);
});

test('native app: sign-in returns a bearer token, browsers never see it', async () => {
  const native = await post('/api/session', { key: keys.ivan });
  assert.match(native.body.session_token, /^ats_/);
  const me = await fetch(url + '/api/me', {
    headers: { Authorization: `Bearer ${native.body.session_token}` },
  });
  assert.equal((await me.json()).name, 'ivan');

  const browser = await fetch(url + '/api/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: url },
    body: JSON.stringify({ key: keys.ivan }),
  });
  assert.equal((await browser.json()).session_token, undefined);

  await fetch(url + '/api/session', {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${native.body.session_token}` },
  });
  const after = await fetch(url + '/api/me', {
    headers: { Authorization: `Bearer ${native.body.session_token}` },
  });
  assert.equal(after.status, 401);

  const aasa = await (await fetch(url + '/.well-known/apple-app-site-association')).json();
  assert.deepEqual(aasa, { webcredentials: { apps: ['TEAM123456.dev.aitracker.app'] } });
});

test('APNs: involved people get a push; dead tokens are forgotten', async () => {
  const live = 'ab12'.repeat(16);
  const dead = 'dead'.repeat(16);
  assert.equal((await api('ivan', 'POST', '/api/push/apns', { token: 'nope', environment: 'sandbox' })).status, 400);
  for (const token of [live, dead]) {
    const res = await api('ivan', 'POST', '/api/push/apns', { token, environment: 'sandbox' });
    assert.equal(res.status, 201);
  }
  const task = (await api('ivan', 'POST', '/api/tasks', { title: 'push me', assignee: 'claude' })).body;
  assert.equal(apnsRequests.length, 0, 'no push for your own actions');

  apnsRequests.length = 0;
  await api('claude', 'POST', `/api/tasks/${task.id}/comments`, { body: 'готово, посмотри', ...claude });
  for (let i = 0; i < 50 && apnsRequests.length < 2; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(apnsRequests.length, 2);

  const sent = apnsRequests.find((r) => r.path === `/3/device/${live}`)!;
  assert.equal(sent.headers['apns-topic'], 'dev.aitracker.app');
  assert.equal(sent.headers['apns-push-type'], 'alert');
  assert.equal(sent.body.aps.alert.body, 'готово, посмотри');
  assert.match(sent.body.aps.alert.title, /^claude · #\d+ push me$/);
  assert.equal(sent.body.task_id, task.id);

  const [head, claims, signature] = String(sent.headers.authorization).replace('bearer ', '').split('.');
  assert.deepEqual(JSON.parse(Buffer.from(head!, 'base64url').toString()), { alg: 'ES256', kid: 'KEY1234567' });
  assert.equal(JSON.parse(Buffer.from(claims!, 'base64url').toString()).iss, 'TEAM123456');
  assert.ok(
    verify('sha256', Buffer.from(`${head}.${claims}`), { key: apnsKey.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature!, 'base64url')),
    'provider token is signed with the APNs key',
  );

  for (let i = 0; i < 50; i++) {
    const left = await pool.query('select token from apns_devices order by token');
    if (left.rows.length === 1) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  const left = await pool.query('select token from apns_devices');
  assert.deepEqual(left.rows.map((r) => r.token), [live]);
  await api('ivan', 'DELETE', '/api/push/apns', { token: live });
  assert.equal((await api('ivan', 'GET', '/api/config')).body.apns, true);
});
