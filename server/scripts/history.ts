// Moves the history of finished chats into the tracker.
//
// The expensive part of a chat is its context; re-opening hundreds of chats to ask each one
// to report would pay for all of it again. So the work is split:
//
//   1. digest  (free)   reads the session files and writes a short digest of every chat:
//                       what the person asked, how each turn ended, which files changed,
//                       exact time and tokens. Digests are grouped into batches.
//   2. plan    (model)  an agent reads one batch and writes a plan: which tasks the chats
//                       amount to. It writes JSON; it does not touch the tracker.
//   3. import  (free)   checks the plans and writes tasks, time, attachments and results
//                       into the tracker, with their real dates and without notifications.
//
//   node history.ts digest --agent claude --cwd ~/Projects/Still_Here --project StillHere --out DIR
//   node history.ts status --out DIR
//   node history.ts import --out DIR [--dry-run]
//
// Everything is resumable: sessions already imported are skipped by digest, tasks already
// written are skipped by import (DIR/ledger.json).
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { find, read, summarize, type Session } from './lib/sessions.ts';

const BASE = (process.env.AI_TRACKER_URL ?? 'http://127.0.0.1:4600').replace(/\/$/, '');
const PERSON = process.env.AI_TRACKER_PERSON ?? 'shabanov';
const BATCH_CHARS = 110_000;
const PROMPT_CHARS = 2500;
const REPLY_CHARS = 1800;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    agent: { type: 'string' },
    cwd: { type: 'string' },
    project: { type: 'string' },
    out: { type: 'string' },
    'dry-run': { type: 'boolean' },
  },
});
const command = positionals[0];
const out = resolve(values.out ?? '');
if (!command || !values.out) {
  console.error('usage: node history.ts digest|status|import --out DIR [--agent claude|codex --cwd DIR --project NAME] [--dry-run]');
  process.exit(1);
}

type Meta = {
  id: string;
  file: string;
  agent: 'claude' | 'codex';
  title?: string;
  cwd?: string;
  started_at: string;
  ended_at: string;
  prompts: string[]; // when each prompt was sent; plans refer to prompts by number, from 1
  images: Record<string, string[]>; // prompt number -> saved pictures
  chars: number;
};
type Index = { agent: 'claude' | 'codex'; project: string; cwd: string; sessions: Meta[]; batches: string[][] };
type Ledger = { tasks: Record<string, number>; sessions: Record<string, number[]> };

const load = <T>(name: string, fallback: T): T =>
  existsSync(join(out, name)) ? JSON.parse(readFileSync(join(out, name), 'utf8')) : fallback;
const save = (name: string, data: unknown) => writeFileSync(join(out, name), JSON.stringify(data, null, 2));
const clip = (text: string, limit: number) =>
  text.length <= limit ? text : `${text.slice(0, limit)}\n[… ещё ${text.length - limit} знаков]`;

// ---------- digest ----------

function digest(): void {
  const agent = values.agent;
  if (agent !== 'claude' && agent !== 'codex') throw new Error('--agent claude|codex');
  if (!values.cwd || !values.project) throw new Error('--cwd and --project are required');
  const cwd = resolve(values.cwd);
  for (const dir of ['sessions', 'images', 'batches', 'plans']) mkdirSync(join(out, dir), { recursive: true });

  const ledger = load<Ledger>('ledger.json', { tasks: {}, sessions: {} });
  const sessions: Meta[] = [];
  const skipped = { empty: 0, imported: 0, tracked: 0 };

  for (const file of find(agent, cwd, true, true).reverse()) {
    let session: Session;
    try {
      session = read(file);
    } catch {
      continue;
    }
    const id = session.id ?? basename(file, '.jsonl');
    if (!session.prompts.length || !session.messages.length) {
      skipped.empty++;
      continue;
    }
    if (ledger.sessions[id]) {
      skipped.imported++;
      continue;
    }
    // A chat that already wrote to the tracker itself has reported its own work.
    const raw = readFileSync(file, 'utf8');
    if (/ai[-_]tracker.{0,80}?(create_task|submit_result)/.test(raw) && /"(tool_use|function_call|mcp_tool_call|custom_tool_call)"/.test(raw)) {
      skipped.tracked++;
      continue;
    }

    const usage = summarize(session.messages, 0, Infinity);
    const first = Date.parse(session.prompts[0]!.at);
    const last = session.messages.at(-1)!.at;
    const images: Record<string, string[]> = {};
    const parts = [
      `# Session ${id}`,
      '',
      `- agent: ${agent}; models: ${usage.models.join(', ')}; effort: ${usage.efforts?.join(', ') ?? 'unknown'}`,
      session.title ? `- title of the chat: ${session.title}` : '',
      `- directory: ${session.cwd ?? cwd}`,
      `- from ${new Date(first).toISOString()} to ${new Date(last).toISOString()}`,
      `- prompts: ${session.prompts.length}; output tokens: ${usage.output_tokens}`,
      '',
    ];
    session.prompts.forEach((prompt, i) => {
      const n = i + 1;
      const saved = prompt.images.map((image, k) => {
        const ext = (image.mime.split('/')[1] ?? 'png').replace('jpeg', 'jpg');
        const path = join(out, 'images', `${id.slice(0, 8)}-p${n}-${k + 1}.${ext}`);
        writeFileSync(path, Buffer.from(image.data, 'base64'));
        return path;
      });
      if (saved.length) images[n] = saved;
      parts.push(`## Prompt ${n} — ${prompt.at}`, '', clip(prompt.text, PROMPT_CHARS) || '(no text)', '');
      if (saved.length) parts.push(`Pictures sent with it: ${saved.length}`, '');
      const closing = prompt.replies.at(-1);
      if (closing) parts.push('### How the turn ended', '', clip(closing, REPLY_CHARS), '');
      if (prompt.files.length) {
        parts.push(`Files changed: ${prompt.files.slice(0, 15).join(', ')}${prompt.files.length > 15 ? ` and ${prompt.files.length - 15} more` : ''}`, '');
      }
    });
    const text = parts.filter((line) => line !== undefined).join('\n');
    writeFileSync(join(out, 'sessions', `${id}.md`), text);
    sessions.push({
      id,
      file,
      agent,
      title: session.title,
      cwd: session.cwd,
      started_at: new Date(first).toISOString(),
      ended_at: new Date(last).toISOString(),
      prompts: session.prompts.map((p) => p.at),
      images,
      chars: text.length,
    });
  }

  // Chats of one stretch of work tend to follow each other, so batches go in time order.
  sessions.sort((a, b) => a.started_at.localeCompare(b.started_at));
  const batches: string[][] = [];
  let size = 0;
  for (const s of sessions) {
    if (!batches.length || (size + s.chars > BATCH_CHARS && batches.at(-1)!.length)) {
      batches.push([]);
      size = 0;
    }
    batches.at(-1)!.push(s.id);
    size += s.chars;
  }
  batches.forEach((ids, i) => {
    const name = `batch-${String(i + 1).padStart(3, '0')}`;
    const list = ids.map((id) => `- sessions/${id}.md`).join('\n');
    writeFileSync(join(out, 'batches', `${name}.md`), `# ${name}\n\nProject: ${values.project}\nWrite the plan to: plans/${name}.json\n\n${list}\n`);
  });
  save('index.json', { agent, project: values.project, cwd, sessions, batches } satisfies Index);

  const chars = sessions.reduce((n, s) => n + s.chars, 0);
  console.log(
    JSON.stringify(
      { project: values.project, agent, sessions: sessions.length, skipped, batches: batches.length, digest_chars: chars, approx_tokens: Math.round(chars / 3) },
      null,
      2,
    ),
  );
}

// ---------- plans ----------

const iso = z.iso.datetime({ offset: true });
const PlanTask = z.object({
  key: z.string().regex(/^[a-z0-9][a-z0-9-]{1,60}$/, 'lowercase letters, digits and dashes'),
  title: z.string().trim().min(3).max(300),
  description: z.string().trim().min(1).max(20_000),
  original_text: z.string().max(20_000).optional(),
  from_person: z.boolean().default(true),
  level: z.enum(['epic', 'story', 'task', 'subtask']).default('task'),
  kind: z.enum(['visual', 'technical']).optional(),
  parent_key: z.string().optional(),
  labels: z.array(z.string().trim().min(1).max(50)).max(8).default([]),
  status: z.enum(['done', 'review', 'in_progress', 'blocked', 'cancelled']),
  result: z.string().trim().max(50_000).optional(),
  work: z
    .array(
      z.object({
        session: z.string(),
        from_prompt: z.number().int().min(1).optional(),
        to_prompt: z.number().int().min(1).optional(),
      }),
    )
    .default([]),
  attachments: z.array(z.string()).max(12).default([]),
  notes: z
    .array(z.object({ at: iso, body: z.string().trim().min(1).max(20_000), original_text: z.string().optional() }))
    .max(20)
    .default([]),
  links: z
    .array(z.object({ to_key: z.string(), type: z.enum(['blocks', 'blocked_by', 'relates', 'duplicates']) }))
    .default([]),
});
const Plan = z.object({
  tasks: z.array(PlanTask).max(200).default([]),
  // Only in the structure plan: puts tasks of other plans under epics and stories.
  parents: z.record(z.string(), z.string()).default({}),
});
type PlanTask = z.infer<typeof PlanTask>;

function plans(): { name: string; tasks: PlanTask[]; error?: string }[] {
  const dir = join(out, 'plans');
  const parents: Record<string, string> = {};
  const loaded = (existsSync(dir) ? readdirSync(dir) : [])
    .filter((n) => n.endsWith('.json'))
    .sort()
    .map((file) => {
      const name = basename(file, '.json');
      try {
        const parsed = Plan.safeParse(JSON.parse(readFileSync(join(dir, file), 'utf8')));
        if (!parsed.success) return { name, tasks: [], error: z.prettifyError(parsed.error) };
        Object.assign(parents, parsed.data.parents);
        return { name, tasks: parsed.data.tasks };
      } catch (err: any) {
        return { name, tasks: [], error: `not valid JSON: ${err.message}` };
      }
    });
  for (const plan of loaded) {
    for (const task of plan.tasks) if (parents[task.key]) task.parent_key = parents[task.key];
  }
  const keys = new Set(loaded.flatMap((p) => p.tasks.map((t) => t.key)));
  const stray = Object.keys(parents).filter((k) => !keys.has(k));
  if (stray.length) loaded.push({ name: 'structure', tasks: [], error: `parents names unknown tasks: ${stray.join(', ')}` });
  return loaded;
}

/** Problems that would make the import wrong rather than merely incomplete. */
function problems(index: Index, all: ReturnType<typeof plans>): string[] {
  const found: string[] = [];
  const known = new Map(index.sessions.map((s) => [s.id, s]));
  const keys = new Map<string, PlanTask>();
  for (const plan of all) {
    if (plan.error) found.push(`${plan.name}: ${plan.error}`);
    for (const task of plan.tasks) {
      if (keys.has(task.key)) found.push(`${plan.name}: key "${task.key}" is used twice`);
      keys.set(task.key, task);
    }
  }
  const rank = ['epic', 'story', 'task', 'subtask'];
  for (const [key, task] of keys) {
    if (task.parent_key) {
      const parent = keys.get(task.parent_key);
      if (!parent) found.push(`${key}: parent "${task.parent_key}" is not in any plan`);
      else if (rank.indexOf(parent.level) >= rank.indexOf(task.level)) {
        found.push(`${key}: a ${task.level} cannot be part of a ${parent.level} ("${task.parent_key}")`);
      }
    }
    for (const link of task.links) {
      if (!keys.has(link.to_key)) found.push(`${key}: link to unknown task "${link.to_key}"`);
    }
    for (const work of task.work) {
      const session = known.get(work.session);
      if (!session) found.push(`${key}: unknown session "${work.session}"`);
      else if ((work.to_prompt ?? 1) > session.prompts.length || (work.from_prompt ?? 1) > session.prompts.length) {
        found.push(`${key}: session ${work.session} has only ${session.prompts.length} prompts`);
      }
    }
    if (task.status !== 'in_progress' && task.status !== 'blocked' && !task.result) {
      found.push(`${key}: a ${task.status} task needs a result`);
    }
  }
  return found;
}

function status(): void {
  const index = load<Index | null>('index.json', null);
  if (!index) throw new Error(`no index.json in ${out}; run digest first`);
  const ledger = load<Ledger>('ledger.json', { tasks: {}, sessions: {} });
  const all = plans();
  const planned = new Set(all.flatMap((p) => p.tasks.flatMap((t) => t.work.map((w) => w.session))));
  const batches = index.batches.map((ids, i) => {
    const name = `batch-${String(i + 1).padStart(3, '0')}`;
    const plan = all.find((p) => p.name === name);
    return { name, sessions: ids.length, plan: plan ? (plan.error ? 'invalid' : `${plan.tasks.length} tasks`) : 'missing' };
  });
  console.log(
    JSON.stringify(
      {
        project: index.project,
        agent: index.agent,
        sessions: index.sessions.length,
        sessions_in_plans: [...planned].filter((id) => index.sessions.some((s) => s.id === id)).length,
        tasks_planned: all.reduce((n, p) => n + p.tasks.length, 0),
        tasks_imported: Object.keys(ledger.tasks).length,
        batches_without_plan: batches.filter((b) => b.plan === 'missing').map((b) => b.name),
        problems: problems(index, all),
      },
      null,
      2,
    ),
  );
}

// ---------- import ----------

const SECRET_NAMES = /^(\.env(\..*)?|\.keys.*|.*\.pem|.*\.p8|.*\.p12|.*\.key|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|auth\.json|credentials(\.json)?|\.netrc|\.npmrc)$/i;
const SECRET_DIRS = ['.ssh', '.aws', '.gnupg', join('.config', 'ai-tracker')].map((d) => join(homedir(), d) + sep);
const ATTACH_LIMIT = 50 * 1024 * 1024;

function attachable(path: string): string | null {
  try {
    const real = realpathSync(path);
    const info = statSync(real);
    if (!info.isFile() || info.size === 0 || info.size > ATTACH_LIMIT) return null;
    if (SECRET_NAMES.test(basename(real)) || SECRET_DIRS.some((d) => real.startsWith(d))) return null;
    return real;
  } catch {
    return null;
  }
}

async function importPlans(): Promise<void> {
  const index = load<Index | null>('index.json', null);
  if (!index) throw new Error(`no index.json in ${out}; run digest first`);
  const all = plans();
  const found = problems(index, all);
  if (found.length) {
    console.error(`The plans have problems; nothing was written.\n- ${found.join('\n- ')}`);
    process.exit(1);
  }
  const account = index.agent;
  const key = (process.env.AI_TRACKER_KEY ?? readFileSync(join(homedir(), '.config', 'ai-tracker', `${account}.key`), 'utf8')).trim();
  const ledger = load<Ledger>('ledger.json', { tasks: {}, sessions: {} });
  const sessions = new Map(index.sessions.map((s) => [s.id, s]));
  const parsed = new Map<string, Session>();
  const dry = values['dry-run'] ?? false;

  const call = async (method: string, path: string, body?: unknown): Promise<any> => {
    const form = body instanceof FormData;
    const res = await fetch(BASE + path, {
      method,
      headers: {
        Authorization: `Bearer ${key}`,
        'X-Tracker-History': '1',
        ...(body && !form ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? (form ? body : JSON.stringify(body)) : undefined,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${data?.error ?? ''}`);
    return data;
  };

  const rank = ['epic', 'story', 'task', 'subtask'];
  const tasks = all.flatMap((p) => p.tasks).sort((a, b) => rank.indexOf(a.level) - rank.indexOf(b.level));
  const totals = { created: 0, skipped: 0, time_logs: 0, attachments: 0, seconds: 0, cost_usd: 0, missing_files: 0 };

  for (const task of tasks) {
    if (ledger.tasks[task.key]) {
      totals.skipped++;
      continue;
    }
    // Usage of each stretch of work, straight from the session file.
    const stretches = task.work.map((work) => {
      const meta = sessions.get(work.session)!;
      if (!parsed.has(meta.id)) parsed.set(meta.id, read(meta.file));
      const session = parsed.get(meta.id)!;
      const from = Date.parse(meta.prompts[(work.from_prompt ?? 1) - 1]!);
      const next = work.to_prompt !== undefined ? meta.prompts[work.to_prompt] : undefined;
      const to = next ? Date.parse(next) : Infinity;
      const pictures = Object.entries(meta.images)
        .filter(([n]) => Number(n) >= (work.from_prompt ?? 1) && Number(n) <= (work.to_prompt ?? Infinity))
        .flatMap(([, paths]) => paths);
      const lastResponse = session.messages.filter((m) => m.at >= from && m.at < to).at(-1)?.at ?? from;
      return { meta, usage: summarize(session.messages, from, to), pictures, ended_at: new Date(lastResponse).toISOString() };
    }).filter((s) => s.usage.responses > 0);

    const started = stretches.map((s) => s.usage.started_at).sort()[0] ?? task.notes[0]?.at;
    const ended = stretches.map((s) => s.ended_at).sort().at(-1);
    const run = { model: stretches[0]?.usage.models[0] ?? 'unknown', effort: stretches[0]?.usage.efforts?.[0] ?? 'unknown' };
    const files = [...new Set([...stretches.flatMap((s) => s.pictures), ...task.attachments])];
    const ready = files.map(attachable).filter((f): f is string => f !== null);
    totals.missing_files += files.length - ready.length;

    if (dry) {
      console.log(`${task.level.padEnd(7)} ${task.key}  "${task.title}"  ${task.status}  work=${stretches.length} files=${ready.length}`);
      totals.created++;
      continue;
    }

    const created = await call('POST', '/api/tasks', {
      title: task.title,
      description: task.description,
      original_text: task.original_text,
      level: task.level,
      kind: task.kind,
      labels: task.labels,
      project: index.project,
      assignee: 'me',
      parent_id: task.parent_key ? ledger.tasks[task.parent_key] : undefined,
      happened_at: started,
      ...(task.from_person ? { on_behalf_of: PERSON } : {}),
      ...run,
    });
    ledger.tasks[task.key] = created.id;

    for (const { meta, usage } of stretches) {
      await call('POST', `/api/tasks/${created.id}/time`, {
        seconds: Math.min(usage.seconds, 7 * 24 * 3600),
        started_at: usage.started_at,
        model: usage.models[0] ?? 'unknown',
        effort: usage.efforts?.[0] ?? 'unknown',
        worker: `чат ${meta.title ?? meta.id.slice(0, 8)}`.slice(0, 100),
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        cache_read_tokens: usage.cache_read_tokens,
        cache_write_tokens: usage.cache_write_tokens,
        ...('cost_usd' in usage ? { cost_usd: usage.cost_usd } : {}),
        note: `Перенесено из истории чата ${meta.id}. Время и токены — из файла сессии.`,
      });
      (ledger.sessions[meta.id] ??= []).push(created.id);
      totals.time_logs++;
      totals.seconds += usage.seconds;
      totals.cost_usd += 'cost_usd' in usage ? (usage.cost_usd as number) : 0;
    }
    for (const note of task.notes) {
      await call('POST', `/api/tasks/${created.id}/comments`, {
        body: note.body,
        original_text: note.original_text,
        happened_at: note.at,
        on_behalf_of: PERSON,
        ...run,
      });
    }
    for (let i = 0; i < ready.length; i += 10) {
      const form = new FormData();
      for (const file of ready.slice(i, i + 10)) form.append('file', new Blob([readFileSync(file)]), basename(file));
      await call('POST', `/api/tasks/${created.id}/attachments`, form);
      totals.attachments += Math.min(10, ready.length - i);
    }
    if (task.result) {
      await call('POST', `/api/tasks/${created.id}/result`, { result: task.result, status: task.status, happened_at: ended, ...run });
    } else if (task.status !== 'in_progress') {
      await call('PATCH', `/api/tasks/${created.id}`, { status: task.status, ...run });
    } else {
      await call('PATCH', `/api/tasks/${created.id}`, { status: 'in_progress', ...run });
    }
    save('ledger.json', ledger);
    totals.created++;
  }

  if (!dry) {
    for (const task of tasks) {
      for (const link of task.links) {
        await call('POST', `/api/tasks/${ledger.tasks[task.key]}/links`, { to: ledger.tasks[link.to_key], type: link.type }).catch(
          (err) => (String(err.message).includes('409') ? null : console.error(String(err.message))),
        );
      }
    }
    save('ledger.json', ledger);
  }
  totals.cost_usd = Math.round(totals.cost_usd * 100) / 100;
  console.log(JSON.stringify({ project: index.project, dry_run: dry, ...totals }, null, 2));
}

function outline(): void {
  for (const plan of plans()) {
    for (const t of plan.tasks) {
      const day = t.notes[0]?.at.slice(0, 10) ?? '';
      console.log([t.key, t.level, t.kind ?? '-', t.status, t.parent_key ?? '-', day, t.title].join(' | '));
    }
  }
}

if (command === 'digest') digest();
else if (command === 'outline') outline();
else if (command === 'status') status();
else if (command === 'import') await importPlans();
else throw new Error(`unknown command "${command}"`);
