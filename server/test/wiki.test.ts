import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const baseUrl = process.env.DATABASE_URL ?? 'postgres://aitracker:aitracker@127.0.0.1:5433/aitracker';
const testUrl = new URL(baseUrl);
testUrl.pathname = '/aitracker_wiki_test';
process.env.DATABASE_URL = testUrl.href;
let server: Server, url: string, pool: pg.Pool;
let humanKey: string, agentKey: string;
let project: number, other: number;

async function api(method: string, path: string, body?: object, key = humanKey) {
  const response = await fetch(url + '/api' + path, { method,
    headers: { Authorization: `Bearer ${key}`, ...(body && { 'Content-Type': 'application/json' }) },
    body: body && JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}
const path = (id?: number, scope = project) => `/projects/${scope}/wiki${id ? `/${id}` : ''}`;
async function create(title: string, parent_id: number | null = null, scope = project) {
  const res = await api('POST', path(undefined, scope), { title, parent_id, content: '# Hello\n\n**Markdown**' });
  assert.equal(res.status, 201, JSON.stringify(res.body)); return res.body;
}

before(async () => {
  const admin = new pg.Client({ connectionString: baseUrl });
  await admin.connect();
  await admin.query('drop database if exists aitracker_wiki_test with (force)');
  await admin.query('create database aitracker_wiki_test'); await admin.end();
  const db = await import('../src/db.ts'); pool = db.pool; await db.migrate();
  const svc = await import('../src/service.ts');
  humanKey = (await svc.createAccount({ name: 'wiki-human', kind: 'human', role: 'admin' })).key;
  agentKey = (await svc.createAccount({ name: 'wiki-agent', kind: 'agent', role: 'member' })).key;
  const { buildApp } = await import('../src/server.ts');
  server = buildApp().listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  project = (await api('POST', '/projects', { name: 'Wiki tests' })).body.id;
  other = (await api('POST', '/projects', { name: 'Other wiki' })).body.id;
});
after(async () => { server?.close(); await pool?.end(); });

test('creates and reads nested pages; project renaming preserves the wiki', async () => {
  const root = await create('Guide'); const child = await create('Setup', root.id);
  assert.equal(child.parent_id, root.id); assert.equal(child.revision, 1);
  const list = await api('GET', path()); assert.equal(list.status, 200);
  assert.equal(list.body.find((p: any) => p.id === child.id).content, undefined);
  assert.equal((await api('GET', path(child.id))).body.content, '# Hello\n\n**Markdown**');
  await api('PATCH', `/projects/${project}`, { name: 'Renamed wiki' });
  assert.equal((await api('GET', path(child.id))).body.parent_id, root.id);
  const edit = await api('PATCH', path(child.id), { revision: 1, title: 'Installation', content: '', parent_id: null });
  assert.equal(edit.status, 200); assert.equal(edit.body.content, ''); assert.equal(edit.body.parent_id, null);
  assert.equal(edit.body.revision, 2);
});
test('rejects cross-project references, cycles, invalid input and stale revisions', async () => {
  const root = await create('Architecture'), child = await create('Details', root.id);
  const outsider = await create('Other', null, other);
  assert.equal((await api('POST', path(), { title: 'bad', parent_id: outsider.id })).status, 400);
  assert.equal((await api('PATCH', path(root.id), { revision: 1, parent_id: child.id })).status, 400);
  assert.equal((await api('PATCH', path(root.id), { revision: 1, parent_id: root.id })).status, 400);
  assert.equal((await api('PATCH', path(root.id), { revision: 1, parent_id: outsider.id })).status, 400);
  assert.equal((await api('POST', path(), { title: '  ' })).status, 400);
  assert.equal((await api('GET', path(root.id, other))).status, 404);
  assert.equal((await api('GET', '/projects/999999/wiki')).status, 404);
  assert.equal((await api('GET', `/projects/${project}/wiki/nope`)).status, 400);
  assert.equal((await api('PATCH', path(child.id), { revision: 1, content: 'first' })).status, 200);
  assert.equal((await api('PATCH', path(child.id), { revision: 1, content: 'lost edit' })).status, 409);
  assert.equal((await api('DELETE', path(child.id), { revision: 1 })).status, 409);
  assert.equal((await api('GET', path(child.id))).body.content, 'first');
});
test('concurrent moves cannot create cycles; concurrent edits cannot lose content', async () => {
  const a = await create('Concurrent A'), b = await create('Concurrent B');
  const moves = await Promise.all([
    api('PATCH', path(a.id), { revision: 1, parent_id: b.id }),
    api('PATCH', path(b.id), { revision: 1, parent_id: a.id })]);
  assert.deepEqual(moves.map(r => r.status).sort(), [200,400]);
  const page = await create('Concurrent edit');
  const edits = await Promise.all(['a','b'].map(content => api('PATCH', path(page.id), { revision: 1, content })));
  assert.deepEqual(edits.map(r => r.status).sort(), [200,409]);
});
test('deleting a section promotes children and preserves grandchildren and content', async () => {
  const root = await create('Delete root'), section = await create('Delete section', root.id);
  const child = await create('Preserved child', section.id), grandchild = await create('Preserved grandchild', child.id);
  assert.equal((await api('DELETE', path(section.id), { revision: 1 })).status, 200);
  const kept = (await api('GET', path(child.id))).body;
  assert.equal(kept.parent_id, root.id); assert.equal(kept.revision, 2); assert.equal(kept.content, child.content);
  assert.equal((await api('GET', path(grandchild.id))).body.parent_id, child.id);
  assert.equal((await api('GET', path(section.id))).status, 404);
  assert.equal((await api('DELETE', path(root.id), { revision: 1 })).status, 200);
  assert.equal((await api('GET', path(child.id))).body.parent_id, null);
});
test('authentication and agent run metadata are required; OpenAPI exposes the contract', async () => {
  assert.equal((await fetch(url + '/api' + path())).status, 401);
  assert.equal((await api('POST', path(), { title: 'No run info' }, agentKey)).status, 400);
  const page = await api('POST', path(), { title: 'Agent page', model: 'test-model', effort: 'high' }, agentKey);
  assert.equal(page.status, 201); assert.equal(page.body.updated_by_name, 'wiki-agent');
  assert.equal((await api('PATCH', path(page.body.id), { revision: 1, content: 'Missing run' }, agentKey)).status, 400);
  assert.equal((await api('DELETE', path(page.body.id), { revision: 1 }, agentKey)).status, 400);
  const crossOrigin = await fetch(url + '/api' + path(), { method: 'POST',
    headers: { Authorization: `Bearer ${humanKey}`, Origin: 'https://untrusted.test', 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Cross-origin page' }) });
  assert.equal(crossOrigin.status, 403);
  const doc = await (await fetch(url + '/api/openapi.json')).json();
  assert.ok(doc.paths['/api/projects/{id}/wiki/{pageId}'].patch);
  assert.ok(doc.paths['/api/projects/{id}/wiki/{pageId}'].patch.parameters.some((p: any) => p.name === 'pageId' && p.required));
});
test('MCP supports the same wiki lifecycle', async () => {
  const client = new Client({ name: 'wiki-test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${agentKey}` } } }));
  const call = async (name: string, args: object) => {
    const result: any = await client.callTool({ name, arguments: args as any });
    assert.equal(result.isError, undefined, JSON.stringify(result)); return JSON.parse(result.content[0].text);
  };
  try {
    const run = { project_id: project, model: 'test-model', effort: 'high' };
    const page = await call('create_wiki_page', { ...run, title: 'MCP wiki', content: 'Agent documentation' });
    const ref = { project_id: project, page_id: page.id };
    assert.equal((await call('get_wiki_page', ref)).content, 'Agent documentation');
    assert.ok((await call('list_wiki_pages', { project_id: project })).some((p: any) => p.id === page.id));
    const edit = await call('update_wiki_page', { ...run, page_id: page.id, revision: 1, title: 'MCP edited' });
    assert.equal(edit.revision, 2);
    assert.equal((await call('delete_wiki_page', { ...run, page_id: page.id, revision: 2 })).ok, true);
  } finally { await client.close(); }
});
