// Fills the database with demo data so the UI and analytics have something to show.
// Usage: DATABASE_URL=postgres://.../aitracker_demo node scripts/seed-demo.ts [keys-file]
import { writeFileSync } from 'node:fs';
import { migrate, pool, q } from '../src/db.ts';
import type { Actor } from '../src/auth.ts';
import * as svc from '../src/service.ts';

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
  ['webapp', 'Починить 500 на логине при пустой сессии'],
  ['webapp', 'Добавить пагинацию в список заказов'],
  ['webapp', 'Тёмная тема для страницы настроек'],
  ['api', 'Rate limiting для публичных эндпоинтов'],
  ['api', 'Миграция на новую схему платежей'],
  ['api', 'Покрыть тестами модуль экспорта'],
  ['infra', 'Ускорить сборку Docker-образа'],
  ['infra', 'Настроить алерты по p95 latency'],
  ['mobile', 'Экран онбординга: вёрстка и анимации'],
  ['mobile', 'Офлайн-кэш для ленты'],
];
const statuses = ['done', 'done', 'done', 'review', 'in_progress', 'done', 'review', 'todo', 'in_progress', 'blocked'];

// Deterministic pseudo-random so the demo looks the same on every seed.
let seed = 42;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32);

for (const [i, [project, title]] of titles.entries()) {
  const run = runs[i % runs.length]!;
  const info = { model: run.model, effort: run.effort };
  const task = await svc.createTask(i % 3 === 0 ? human : run.who, {
    title: title!,
    description: `Контекст и критерии приёмки для задачи.\n\n- воспроизвести\n- исправить\n- добавить тест`,
    status: 'todo',
    priority: (['normal', 'high', 'normal', 'urgent', 'low'] as const)[i % 5]!,
    project,
    labels: i % 2 ? ['backend'] : ['frontend'],
    assignee: run.who.name,
    ...(i % 3 === 0 ? {} : info),
  });
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
    body: `Нашёл причину, готовлю исправление. @${run.who === claude ? 'codex' : 'claude'} посмотри, не заденет ли это твой модуль.`,
    ...info,
  });
  const other = run.who === claude ? runs[3]! : runs[0]!;
  await svc.addComment(other.who, task.id, {
    body: 'Проверил — не заденет. Только обнови `CHANGELOG.md`.',
    model: other.model,
    effort: other.effort,
  });
  await svc.addAttachment(run.who, task.id, {
    filename: 'test-run.log',
    stream: (await import('node:stream')).Readable.from(
      Buffer.from('$ npm test\n\n✔ 42 passing (3s)\n✖ 0 failing\n'),
    ),
  });
  if (statuses[i] === 'in_progress') {
    await svc.startTimer(run.who, task.id, info);
  } else if (statuses[i] === 'blocked') {
    await svc.updateTask(run.who, task.id, { status: 'blocked', ...info });
  } else {
    await svc.submitResult(run.who, task.id, {
      result: `## Что сделано\n- исправлена причина\n- добавлен регрессионный тест\n\nВсе тесты зелёные.`,
      status: 'review',
      ...info,
    });
    if (statuses[i] === 'done') await svc.updateTask(human, task.id, { status: 'done' });
    else await svc.addComment(human, task.id, { body: 'Почти. Добавь ещё тест на пустой ввод.' });
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
