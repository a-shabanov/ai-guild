// Synthetic MCP workload, with no LLM calls. Run only against a new disposable database.
// BENCHMARK_DATABASE_URL=postgres://.../overhead_demo node scripts/benchmark-overhead.ts out.json
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const database = process.env.BENCHMARK_DATABASE_URL;
if (!database || !new URL(database).pathname.endsWith('_demo')) {
  throw new Error('BENCHMARK_DATABASE_URL must name a new disposable database ending in _demo');
}
const output = process.argv[2];
if (!output) throw new Error('Pass an output JSON path');
process.env.DATABASE_URL = database;
process.env.HOST = '127.0.0.1';
const storage = mkdtempSync(join(tmpdir(), 'ai-guild-overhead-'));
process.env.DATA_DIR = storage;
const [{ buildApp }, db, svc, schemas] = await Promise.all([
  import('../src/server.ts'), import('../src/db.ts'), import('../src/service.ts'), import('../src/schemas.ts'),
]);
const client = new Client({ name: 'overhead-reference', version: '1.0.0' });
let server: ReturnType<ReturnType<typeof buildApp>['listen']> | undefined;
try {
  await db.migrate();
  if (await svc.accountsExist()) throw new Error('Refusing a database with existing accounts');
  const { account: human } = await svc.createAccount({ name: 'demo', kind: 'human', role: 'admin' });
  const { key } = await svc.createAccount({ name: 'benchmark', kind: 'agent', role: 'member' });
  const task = await svc.createTask(human as any, schemas.CreateTask.parse({
    title: 'Fix the empty-state label', description: 'Use a clear English label and verify it in the browser.',
    project: 'Example', assignee: 'benchmark', level: 'task', kind: 'technical',
  }));
  server = buildApp().listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server!.once('listening', resolve); server!.once('error', reject);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a local TCP listener');
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${key}` } },
  }));
  const catalog = await client.listTools();
  const calls: { name: string; arguments: Record<string, unknown>; result: unknown; milliseconds: number }[] = [];
  async function call(name: string, args: Record<string, unknown> = {}) {
    const start = performance.now();
    const result = await client.callTool({ name, arguments: args });
    if (result.isError) throw new Error(`Reference call failed: ${name}`);
    calls.push({ name, arguments: args, result, milliseconds: performance.now() - start });
    return result;
  }
  function data(result: any) { return JSON.parse(result.content[0].text); }
  const inbox = data(await call('get_inbox'));
  await call('ack_inbox', { up_to: inbox.events.at(-1).event_id });
  await call('get_task', { task_id: task.id });
  const run = { model: 'synthetic-benchmark', effort: 'none', worker: 'reference fixture' };
  const timer = data(await call('start_timer', { task_id: task.id, ...run }));
  await call('add_comment', { task_id: task.id, model: run.model, effort: run.effort,
    body: 'The label is updated. I am checking the empty state in the browser.' });
  await call('stop_timer', { task_id: task.id, time_log_id: timer.id, ...run,
    input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0,
    note: 'Synthetic protocol workload; no LLM work performed.' });
  await call('submit_result', { task_id: task.id, model: run.model, effort: run.effort,
    result: 'Updated the empty-state label. Checked the English view in the browser. No backend behavior changed. This is a synthetic reference result, not real implementation work.' });
  writeFileSync(output, JSON.stringify({
    methodology: 'Synthetic short task; real MCP responses; no LLM generation or provider billing measured.',
    server: client.getServerVersion(), instructions: client.getInstructions(), tools: catalog.tools, calls,
  }, null, 2) + '\n');
  console.log(`Recorded ${calls.length} calls and ${catalog.tools.length} tool definitions; no credentials exported.`);
} finally {
  await client.close();
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  await db.pool.end();
  rmSync(storage, { recursive: true, force: true });
}
