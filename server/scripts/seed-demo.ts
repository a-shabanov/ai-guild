// Fills the database with demo data so the UI and analytics have something to show.
// Usage: DATABASE_URL=postgres://.../aitracker_demo node scripts/seed-demo.ts [keys-file]
import { writeFileSync } from 'node:fs';
import { migrate, pool, q } from '../src/db.ts';
import type { Actor } from '../src/auth.ts';
import * as svc from '../src/service.ts';
import { CreateTask } from '../src/schemas.ts';
import { config } from '../src/config.ts';

if (!new URL(config.databaseUrl).pathname.endsWith('_demo')) {
  throw new Error('Demo seeding requires a dedicated database whose name ends in _demo');
}

await migrate();
if (await svc.accountsExist()) {
  console.error('database already has accounts; refusing to seed');
  await pool.end();
  process.exit(1);
}

const keys: string[] = [];
async function account(name: string, kind: 'human' | 'agent', system?: string): Promise<Actor> {
  const { account, key } = await svc.createAccount({
    name,
    kind,
    system,
    role: kind === 'human' ? 'admin' : 'member',
  });
  keys.push(`${name}=${key}`);
  return account as Actor;
}

const human = await account('demo', 'human');
const claude = await account('claude', 'agent', 'claude');
const codex = await account('codex', 'agent', 'codex');

const runs = [
  { who: claude, model: 'claude-fable-5-1', effort: 'high', rate: 0.9 },
  { who: claude, model: 'claude-sonnet-5-5', effort: 'medium', rate: 0.3 },
  { who: claude, model: 'claude-opus-5-5', effort: 'xhigh', rate: 1.4 },
  { who: codex, model: 'gpt-5-codex', effort: 'medium', rate: 0.4 },
  { who: codex, model: 'gpt-5-codex', effort: 'high', rate: 0.7 },
];
const titles = [
  ['Launchpad', 'Fix sign-in when the session has expired'],
  ['Launchpad', 'Add pagination to the project feed'],
  ['Launchpad', 'Design the dark theme for settings'],
  ['Platform', 'Protect public API endpoints with rate limits'],
  ['Platform', 'Migrate the subscription data model'],
  ['Platform', 'Test the project export workflow'],
  ['Platform', 'Speed up the release container build'],
  ['Platform', 'Add alerts for API latency'],
  ['Pocket', 'Build the welcome screen and transitions'],
  ['Pocket', 'Cache the inbox for offline reading'],
];
const statuses = ['done', 'done', 'done', 'review', 'in_progress', 'done', 'review', 'todo', 'in_progress', 'blocked'];

// Deterministic pseudo-random so the demo looks the same on every seed.
let seed = 42;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32);

for (const [i, [project, title]] of titles.entries()) {
  const run = runs[i % runs.length]!;
  const info = { model: run.model, effort: run.effort };
  const task = await svc.createTask(i % 3 === 0 ? human : run.who, CreateTask.parse({
    title: title!,
    description: `Make the workflow reliable for a real user.\n\n- Reproduce the current behaviour.\n- Implement the smallest complete change.\n- Check success and failure paths.\n- Attach evidence and explain any limitations.`,
    status: 'todo',
    priority: (['normal', 'high', 'normal', 'urgent', 'low'] as const)[i % 5]!,
    project,
    labels: i % 2 ? ['backend'] : ['frontend'],
    assignee: run.who.name,
    ...(i % 3 === 0 ? {} : info),
  }));
  if (statuses[i] === 'todo') continue;

  for (let k = 0; k < 2 + (i % 3); k++) {
    const r = runs[(i + k) % runs.length]!;
    const seconds = Math.round(300 + rnd() * 3600);
    const daysAgo = Math.floor(rnd() * 28);
    await svc.logTime(r.who, task.id, {
      model: r.model,
      effort: r.effort,
      seconds,
      started_at: new Date(Date.now() - daysAgo * 86400e3 - rnd() * 40000e3).toISOString(),
      input_tokens: Math.round(seconds * 900 * r.rate),
      output_tokens: Math.round(seconds * 60 * r.rate),
      cost_usd: Math.round(seconds * 0.12 * r.rate) / 100,
    });
  }
  await svc.addComment(run.who, task.id, {
    body: `I found the cause and am preparing the change. @${run.who === claude ? 'codex' : 'claude'} please check whether this affects your module.`,
    ...info,
  });
  const other = run.who === claude ? runs[3]! : runs[0]!;
  await svc.addComment(other.who, task.id, {
    body: 'Checked: no impact on my module. Include the validation evidence with your result.',
    model: other.model,
    effort: other.effort,
  });
  await svc.addAttachment(run.who, task.id, {
    filename: 'demo-test-run.log',
    stream: (await import('node:stream')).Readable.from(
      Buffer.from('DEMO DATA — illustrative test output, not a real validation run.\n\n$ npm test\n42 checks passed\n0 failed\n'),
    ),
  });
  if (statuses[i] === 'in_progress') {
    await svc.startTimer(run.who, task.id, info);
  } else if (statuses[i] === 'blocked') {
    await svc.updateTask(run.who, task.id, { status: 'blocked', ...info });
  } else {
    await svc.submitResult(run.who, task.id, {
      result: `## Result\nThe issue is resolved and a regression check covers the original failure.\n\n## Evidence\nThe attached test log is synthetic demo data. Run the real suite on your own instance.`,
      status: 'review',
      ...info,
    });
    if (statuses[i] === 'done') await svc.updateTask(human, task.id, { status: 'done' });
    else await svc.addComment(human, task.id, { body: 'Please add a check for empty input before I accept this result.' });
  }
}
await q('update accounts set inbox_cursor = 0');

const file = process.argv[2];
if (file) {
  writeFileSync(file, keys.join('\n') + '\n', { mode: 0o600 });
  console.log(`seeded; keys written to ${file}`);
} else {
  console.log('seeded\n' + keys.join('\n'));
}
await pool.end();
