// Wakes the agents on this computer when a person writes to them in the tracker.
//
// The tracker may live on another machine; the agents, their keys and the repositories live
// here. So it is this program, not the server, that starts them: it watches the inbox of every
// agent and, when a person has commented, assigned or returned a task, runs the agent in the
// directory of the task's project. It needs nothing from the server but its HTTP API.
//
//   npm run wake            watch until stopped with Ctrl-C
//   npm run wake -- --once  look once, run what is due, wait for it and exit
//   npm run wake -- --dry   show what would be started, start nothing
//   npm run wake -- --run codex 404   start this agent for this task now, e.g. after a failed run
//
// Settings: ~/.config/ai-tracker/wake.json (written with defaults on the first run).
// Keys: ~/.config/ai-tracker/<agent>.key. Output of the runs: ~/.config/ai-tracker/wake-logs/.
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { read, summarize } from './lib/sessions.ts';

type Settings = {
  url: string;
  /** Tracker project -> directory of its repository on this computer. */
  projects: Record<string, string>;
  /** Account name -> command; "{prompt}" is replaced with the instructions for the run,
   *  "{session}" with a new session id, by which the transcript is found afterwards. */
  agents: Record<string, { command: string[] }>;
  parallel: number;
  timeout_minutes: number;
  poll_seconds: number;
};

type Event = {
  id: number;
  task_id: number;
  task_title: string;
  project: string | null;
  assignee_name: string | null;
  actor_name: string;
  actor_kind: 'human' | 'agent';
  type: string;
  data: Record<string, any>;
};

type Run = {
  agent: string;
  task: number;
  title: string;
  project: string;
  dir: string;
  trigger: number;
  /** The agent does the task; otherwise it was only asked something in it. */
  owner: boolean;
  startedAt?: number;
  session?: string;
};

// What arrives this soon after a start belongs to the same request: a comment and the status
// change that came with it. The agent has not read the task yet and will see both.
const SAME_REQUEST_MS = 30_000;

const home = join(homedir(), '.config', 'ai-tracker');
const settingsFile = process.env.AI_TRACKER_WAKE_CONFIG ?? join(home, 'wake.json');
const stateFile = settingsFile.replace(/\.json$/, '') + '-state.json';
const logDir = join(home, 'wake-logs');
// Another set of keys, for trying the watcher against a test tracker.
const keyDir = process.env.AI_TRACKER_KEYS ?? home;

const DEFAULTS: Settings = {
  url: process.env.AI_TRACKER_URL ?? 'http://127.0.0.1:4600',
  projects: {
    'AI-tracker': '~/Projects/AI-tracker',
    StillHere: '~/Projects/Still_Here',
    Drop: '~/Projects/DemoDDThai',
  },
  agents: {
    // Without a terminal nobody can approve anything, so the run gets what it needs up front:
    // edits in the project and the tools of the tracker. Shell commands follow the rules in
    // ~/.claude/settings.json.
    claude: {
      command: [
        'claude', '-p', '{prompt}', '--session-id', '{session}', '--permission-mode', 'acceptEdits',
        '--allowedTools', 'mcp__ai-tracker', 'mcp__ai-tracker-files',
        // Commands a run may use by itself: building, the simulator, tests, the project's scripts.
        ...['Bash(xcodebuild *)', 'Bash(xcrun simctl *)', 'Bash(npm test)', 'Bash(npm test *)', 'Bash(npm run *)', 'Bash(node scripts/*)', 'Bash(node server/scripts/*)', 'Bash(node ~/Projects/AI-tracker/server/scripts/*)', 'Bash(git status)', 'Bash(git status *)', 'Bash(git diff)', 'Bash(git diff *)'],
      ],
    },
    // Not every project is a git repository; the sandbox lets the run write inside the project only.
    codex: { command: ['codex', 'exec', '--skip-git-repo-check', '--sandbox', 'workspace-write', '{prompt}'] },
  },
  parallel: 2,
  timeout_minutes: 45,
  poll_seconds: 15,
};

const once = process.argv.includes('--once');
const dry = process.argv.includes('--dry');
const expand = (path: string) => path.replace(/^~(?=\/|$)/, homedir());
const stamp = () => new Date().toLocaleTimeString('ru-RU');
const say = (...words: unknown[]) => console.log(stamp(), ...words);

function readSettings(): Settings {
  if (!existsSync(settingsFile)) {
    mkdirSync(home, { recursive: true });
    writeFileSync(settingsFile, JSON.stringify(DEFAULTS, null, 2) + '\n', { mode: 0o600 });
    say(`настройки записаны в ${settingsFile}`);
  }
  return { ...DEFAULTS, ...JSON.parse(readFileSync(settingsFile, 'utf8')) };
}

// Read again for every run, so a corrected command works without restarting the watcher.
let settings = readSettings();
const base = settings.url.replace(/\/$/, '');
/** Agent -> the last event that has been looked at. */
const seen: Record<string, number> = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : {};
const saveSeen = () => dry || writeFileSync(stateFile, JSON.stringify(seen) + '\n', { mode: 0o600 });

function key(agent: string): string | null {
  const file = join(keyDir, `${agent}.key`);
  return existsSync(file) ? readFileSync(file, 'utf8').trim() : null;
}

async function api(agent: string, method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(base + path, {
    method,
    headers: { Authorization: `Bearer ${key(agent)}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

/** Whether the event is a person speaking to this agent. */
function calls(event: Event, agent: string, agents: string[]): boolean {
  // What an agent wrote down for a person comes from a chat that is already running.
  if (event.actor_kind !== 'human' || event.data.recorded_by) return false;
  const mine = event.assignee_name === agent;
  switch (event.type) {
    case 'comment_added': {
      const body = String(event.data.body ?? '').toLowerCase();
      const named = agents.filter((name) => new RegExp(`(^|\\s)@${name.toLowerCase()}(?![\\w.-])`).test(body));
      // A comment that names agents is for them; any other one is for whoever does the task.
      return named.length ? named.includes(agent) : mine;
    }
    case 'task_created':
      return mine;
    case 'task_assigned':
      return event.data.assignee === agent;
    case 'status_changed':
      return mine && ['todo', 'in_progress'].includes(event.data.to) && event.data.from !== 'todo';
    default:
      return false;
  }
}

function prompt(run: Run): string {
  return [
    `Тебя запустил AI Tracker: человек написал тебе в задаче #${run.task} «${run.title}» (проект ${run.project}).`,
    'Это автономный запуск: человека в чате нет, вопросы задавать некому.',
    '',
    `1. Вызови get_inbox и get_task для задачи #${run.task}: прочитай, что просит человек.`,
    ...(run.owner
      ? [
          '2. Сделай это. Работай по правилам трекера: настоящие model и effort, вложения.',
          '3. Сдай работу через submit_result и подтверди входящие через ack_inbox.',
          '',
          'Если просьба непонятна или нужно решение человека — не гадай: задай вопрос через add_comment,',
          'переведи задачу в blocked и закончи.',
        ]
      : [
          '2. Задачу ведёт другой исполнитель, тебя в ней только о чём-то попросили. Сделай, что просят,',
          '   и ответь через add_comment, с вложениями, если они есть.',
          '3. Не вызывай submit_result и не меняй статус, исполнителя и описание задачи: результат и статус',
          '   принадлежат исполнителю. Подтверди входящие через ack_inbox.',
          '',
          'Если просьба непонятна — задай вопрос через add_comment и закончи.',
        ]),
    '',
    'Время и расход токенов запишет сторож после запуска: таймер не запускай и log_time не вызывай.',
  ].join('\n');
}

/** What the run has spent, read from the transcript that the agent left behind. */
function usage(run: Run) {
  const since = run.startedAt! - 2000;
  let file: string | undefined;
  if (run.agent === 'claude' || settings.agents[run.agent].command.includes('{session}')) {
    const path = join(homedir(), '.claude', 'projects', run.dir.replace(/[^a-zA-Z0-9]/g, '-'), `${run.session}.jsonl`);
    if (existsSync(path)) file = path;
  } else {
    // Codex names its sessions itself: take the one that began after the start with this prompt.
    // Only the folders of the days of the run are read: there are thousands of sessions.
    const days = new Set([run.startedAt!, Date.now()].map((at) => {
      const d = new Date(at);
      return join(String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
    }));
    file = [...days]
      .map((day) => join(homedir(), '.codex', 'sessions', day))
      .filter((dir) => existsSync(dir))
      .flatMap((dir) => readdirSync(dir).filter((name) => name.endsWith('.jsonl')).map((name) => join(dir, name)))
      .filter((path) => statSync(path).birthtimeMs >= since)
      .find((path) => readFileSync(path, 'utf8').includes(`в задаче #${run.task} `));
  }
  if (!file) return null;
  const spent = summarize(read(file).messages, run.startedAt!, Infinity);
  return spent.responses ? spent : null;
}

async function account(run: Run): Promise<void> {
  const spent = usage(run);
  if (!spent) return say(`${run.agent} · #${run.task}: записи сессии нет, расход не посчитан`);
  const numbers = {
    input_tokens: spent.input_tokens,
    output_tokens: spent.output_tokens,
    cache_read_tokens: spent.cache_read_tokens,
    cache_write_tokens: spent.cache_write_tokens,
    ...('cost_usd' in spent ? { cost_usd: spent.cost_usd } : {}),
  };
  const task = await api(run.agent, 'GET', `/api/tasks/${run.task}`);
  // The agent was told not to keep time. If it did anyway, its entry gets the numbers.
  const own = task.time_logs.filter(
    (log: any) => log.account_name === run.agent && log.seconds != null && Date.parse(log.started_at) >= run.startedAt! - 2000,
  );
  if (own.length) {
    await api(run.agent, 'PATCH', `/api/time-logs/${own.at(-1).id}`, numbers);
  } else {
    await api(run.agent, 'POST', `/api/tasks/${run.task}/time`, {
      model: spent.models[0],
      effort: spent.efforts?.[0] ?? 'default',
      seconds: spent.seconds,
      started_at: new Date(run.startedAt!).toISOString(),
      worker: 'автономный запуск',
      note: 'Записано сторожем по записи сессии.' + ('cost_usd' in spent ? '' : ' Стоимость не посчитана: цена модели неизвестна.'),
      ...numbers,
    });
  }
  say(`${run.agent} · #${run.task}: ${spent.seconds} с, ${spent.output_tokens} out${'cost_usd' in spent ? `, $${spent.cost_usd}` : ''}`);
}

const queue: Run[] = [];
const active = new Map<string, Run>();
const slot = (run: Pick<Run, 'agent' | 'task'>) => `${run.agent}#${run.task}`;

function enqueue(run: Run): void {
  // One run reads everything that has piled up in the task, so one in the queue is enough.
  if (queue.some((waiting) => slot(waiting) === slot(run))) return;
  queue.push(run);
}

function pump(): void {
  while (active.size < settings.parallel) {
    const at = queue.findIndex((run) => !active.has(slot(run)));
    if (at < 0) return;
    start(queue.splice(at, 1)[0]);
  }
}

function start(run: Run): void {
  settings = readSettings();
  run.session = randomUUID();
  run.startedAt = Date.now();
  const [program, ...args] = settings.agents[run.agent].command.map((part) =>
    part.replaceAll('{prompt}', prompt(run)).replaceAll('{session}', run.session!),
  );
  mkdirSync(logDir, { recursive: true });
  const logFile = join(logDir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${run.agent}-${run.task}.log`);
  const log = createWriteStream(logFile);
  let tail = '';
  const keep = (chunk: Buffer) => {
    log.write(chunk);
    tail = (tail + chunk.toString('utf8')).slice(-1500);
  };

  active.set(slot(run), run);
  say(`▶ ${run.agent} · #${run.task} ${run.title} · ${run.dir}`);
  report(run, 'started');

  // No shell in between: the prompt is one argument, whatever it contains.
  const child = spawn(program, args, {
    cwd: run.dir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, AI_TRACKER_URL: base, AI_TRACKER_KEY: key(run.agent) ?? '', AI_TRACKER_WAKE: '1' },
  });
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  const timer = setTimeout(() => {
    keep(Buffer.from(`\n[wake] остановлен: работал дольше ${settings.timeout_minutes} мин\n`));
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 10_000).unref();
  }, settings.timeout_minutes * 60_000);

  let ended = false;
  const end = (problem: string | null) => {
    if (ended) return;
    ended = true;
    clearTimeout(timer);
    log.end();
    active.delete(slot(run));
    say(`${problem ? '✖' : '✔'} ${run.agent} · #${run.task}${problem ? ` · ${problem}` : ''} · ${logFile}`);
    report(run, problem ? 'failed' : 'finished', problem ? `${problem}\n${tail.trim()}`.trim() : undefined);
    account(run).catch((err) => say(`${run.agent} · #${run.task}: расход не записан (${err.message})`));
    pump();
  };
  child.on('error', (err) => end(`не запустился: ${err.message}`));
  child.on('close', (code, signal) => end(code === 0 ? null : signal ? `остановлен (${signal})` : `код выхода ${code}`));
}

function report(run: Run, state: string, detail?: string): void {
  api(run.agent, 'POST', `/api/tasks/${run.task}/runs`, { state, trigger: run.trigger || undefined, detail: detail?.slice(-4000) }).catch(
    (err) => say(`не удалось записать в задачу #${run.task}: ${err.message}`),
  );
}

let looking = false;
let again = false;
/** One look at a time; a signal that arrives meanwhile asks for another one right after. */
async function lookNow(): Promise<void> {
  if (looking) {
    again = true;
    return;
  }
  looking = true;
  try {
    do {
      again = false;
      await look();
    } while (again);
  } finally {
    looking = false;
  }
}

/** Listens to the tracker, so that an agent starts at once and not at the next look. */
async function listen(agent: string): Promise<void> {
  for (let wait = 1000; ; wait = Math.min(wait * 2, 30_000)) {
    try {
      const res = await fetch(`${base}/api/events/stream`, { headers: { Authorization: `Bearer ${key(agent)}` } });
      if (!res.ok || !res.body) throw new Error(String(res.status));
      say('на связи с трекером: агенты запускаются сразу');
      wait = 1000;
      for await (const chunk of res.body) {
        if (Buffer.from(chunk).toString('utf8').includes('data:')) lookNow().catch(() => {});
      }
    } catch {
      // Looking every poll_seconds goes on meanwhile.
    }
    await new Promise((done) => setTimeout(done, wait));
  }
}

async function look(): Promise<void> {
  const agents = Object.keys(settings.agents).filter((agent) => key(agent));
  for (const agent of agents) {
    let events: Event[];
    try {
      // The first look only marks the place: what was written before is not acted upon.
      if (seen[agent] === undefined) {
        const all: Event[] = (await api(agent, 'GET', '/api/activity?limit=1'));
        seen[agent] = all[0]?.id ?? 0;
        saveSeen();
        say(`${agent}: слежу с события ${seen[agent]}`);
        continue;
      }
      events = (await api(agent, 'GET', `/api/inbox?after=${seen[agent]}&limit=200`)).events;
    } catch (err: any) {
      say(`${agent}: трекер не отвечает (${err.message})`);
      continue;
    }
    for (const event of events) {
      seen[agent] = Math.max(seen[agent], event.id);
      if (!calls(event, agent, agents)) continue;
      const dir = event.project ? settings.projects[event.project] : undefined;
      if (!dir || !existsSync(expand(dir)) || !statSync(expand(dir)).isDirectory()) {
        say(`${agent}: #${event.task_id} пропущена — для проекта «${event.project ?? 'без проекта'}» нет каталога в ${settingsFile}`);
        continue;
      }
      const run: Run = {
        agent,
        task: event.task_id,
        title: event.task_title,
        project: event.project!,
        dir: expand(dir),
        trigger: event.id,
        owner: event.assignee_name === agent,
      };
      const running = active.get(slot(run));
      if (running && Date.now() - running.startedAt! < SAME_REQUEST_MS) continue;
      if (dry) say(`запустил бы ${agent} для #${run.task} «${run.title}» в ${run.dir} (событие ${event.id}: ${event.type})`);
      else enqueue(run);
    }
    saveSeen();
  }
  pump();
}

const idle = () => new Promise<void>((done) => {
  const check = () => (active.size || queue.length ? setTimeout(check, 500) : done());
  check();
});

say(`слежу за ${base} · агенты: ${Object.keys(settings.agents).filter((a) => key(a)).join(', ') || 'нет ключей'}${dry ? ' · пробный режим' : ''}`);
const manual = process.argv.indexOf('--run');
if (manual > 0) {
  const [agent, id] = process.argv.slice(manual + 1);
  if (!settings.agents[agent] || !key(agent) || !Number(id)) {
    console.error('usage: npm run wake -- --run <agent> <task id>');
    process.exit(1);
  }
  const task = await api(agent, 'GET', `/api/tasks/${id}`);
  const dir = settings.projects[task.project];
  if (!dir || !existsSync(expand(dir))) {
    console.error(`для проекта «${task.project}» нет каталога в ${settingsFile}`);
    process.exit(1);
  }
  enqueue({ agent, task: task.id, title: task.title, project: task.project, dir: expand(dir), trigger: 0, owner: task.assignee_name === agent });
  pump();
  await idle();
  await new Promise((done) => setTimeout(done, 1500));
} else if (once) {
  await look();
  await idle();
  // Let the last report reach the tracker.
  await new Promise((done) => setTimeout(done, 500));
} else {
  let stopping = false;
  process.on('SIGINT', () => {
    if (stopping || !active.size) process.exit(0);
    stopping = true;
    say(`жду, пока закончат ${active.size} запущенных; Ctrl-C ещё раз — выйти сразу`);
    queue.length = 0;
    idle().then(() => process.exit(0));
  });
  const listener = Object.keys(settings.agents).find((agent) => key(agent));
  if (listener && !dry) listen(listener);
  while (!stopping) {
    await lookNow();
    await new Promise((done) => setTimeout(done, settings.poll_seconds * 1000));
  }
}
