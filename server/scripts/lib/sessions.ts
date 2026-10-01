// Reads the session records of Claude Code and Codex: usage, what the person wrote, what the
// agent answered and which files it changed.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// USD per million tokens: [input, output, cache read, optional cache write].
// Claude's cache writes use the provider's 5-minute and 1-hour multipliers below.
const PRICES: Record<string, [number, number, number, number?]> = {
  'claude-fable-5-1': [10, 50, 0.25],
  'claude-fable-5': [10, 50, 1],
  'claude-opus-5-5': [4, 20, 0.2],
  'claude-opus-5': [5, 25, 0.5],
  'claude-opus-4-8': [5, 25, 0.5],
  'claude-sonnet-5-5': [2, 10, 0.2],
  'claude-sonnet-5': [2, 10, 0.2],
  'claude-haiku-4-5': [1, 5, 0.1],
  // OpenAI, Standard tier, short context (developers.openai.com/api/docs/pricing, 2026-09-29).
  // Cache-write prices are explicit where the official pricing table publishes them.
  // Older models do not publish cache-write rates. Models without a cached-input
  // price use the input rate as a conservative estimate if cached usage is reported.
  'gpt-6-astra': [10, 50, 1, 12.5],
  'gpt-6-sol': [2, 10, 0.2, 2.5],
  'gpt-6-luna': [0.1, 0.5, 0.01, 0.125],
  'gpt-5.6-sol': [4, 20, 0.4, 5],
  'gpt-5.6-terra': [2, 12, 0.2, 2.5],
  'gpt-5.6-luna': [0.2, 1.2, 0.02, 0.25],
  'gpt-5.6-cyber': [12.5, 75, 1.25, 15.625],
  'gpt-5.5': [5, 30, 0.5],
  'gpt-5.5-pro': [30, 180, 30],
  'gpt-5.4': [2.5, 15, 0.25],
  'gpt-5.4-pro': [30, 180, 30],
  'gpt-5.4-mini': [0.75, 4.5, 0.075],
  'gpt-5.4-nano': [0.2, 1.25, 0.02],
  'gpt-5.3-codex': [1.75, 14, 0.175],
  'gpt-5.2': [1.75, 14, 0.175],
  'gpt-5.2-pro': [21, 168, 21],
  'gpt-5.1': [1.25, 10, 0.125],
  'gpt-5': [1.25, 10, 0.125],
  'gpt-5-mini': [0.25, 2, 0.025],
  'gpt-5-nano': [0.05, 0.4, 0.005],
  'gpt-5-pro': [15, 120, 15],
  'gpt-4.1': [2, 8, 0.5],
  'gpt-4.1-mini': [0.4, 1.6, 0.1],
  'gpt-4o': [2.5, 10, 1.25],
  'gpt-4o-mini': [0.15, 0.6, 0.075],
};
const WRITE_5M = 1.25;
const WRITE_1H = 2;
const IDLE_MS = 5 * 60 * 1000;

export type Message = {
  at: number;
  model: string;
  effort?: string;
  input: number;
  output: number;
  cacheRead: number;
  write5m: number;
  write1h: number;
};
export type Mark = { at: number; label: string };
export type Prompt = {
  at: string;
  text: string;
  images: { mime: string; data: string }[];
  /** What the agent wrote in reply, in order; the last one closes the turn. */
  replies: string[];
  /** Files the agent created or changed while answering. */
  files: string[];
};
export type Session = {
  agent: 'claude' | 'codex';
  id?: string;
  title?: string;
  cwd?: string;
  messages: Message[];
  marks: Mark[];
  prompts: Prompt[];
};

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

// Harness-injected text that arrives in the user role but was not written by the person.
const isInjected = (text: string) =>
  /^\s*<(system-reminder|command-name|command-message|local-command|task-notification|environment_context|user_instructions)/.test(text) ||
  text.startsWith('[SYSTEM NOTIFICATION') ||
  text.startsWith('[Request interrupted') ||
  text.startsWith('Caveat: The messages below');

function lines(path: string): any[] {
  const out: any[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {}
  }
  return out;
}

function readClaude(entries: any[]): Session {
  // A message is written once per content block while it streams; the last entry has the totals.
  const byId = new Map<string, Message>();
  const marks: Mark[] = [];
  const prompts: Prompt[] = [];
  let cwd: string | undefined;
  const addPrompt = (at: number, text: string, images: Prompt['images']) => {
    const clean = text.trim();
    if ((!clean && !images.length) || isInjected(clean)) return;
    // Sent while the agent was busy, a message is stored when queued and again when delivered.
    if (prompts.some((p) => p.text === clean && Math.abs(Date.parse(p.at) - at) < 30 * 60_000)) return;
    prompts.push({ at: new Date(at).toISOString(), text: clean, images, replies: [], files: [] });
    marks.push({ at, label: 'prompt: ' + oneLine(clean).slice(0, 60) });
  };
  let id: string | undefined;
  let title: string | undefined;

  for (const entry of entries) {
    id ??= entry.sessionId;
    if (typeof entry.customTitle === 'string') title = entry.customTitle;
    const at = Date.parse(entry.timestamp);
    if (Number.isNaN(at)) continue;
    cwd ??= entry.cwd;
    const message = entry.message ?? {};
    if (entry.type === 'assistant' && !entry.isSidechain && Array.isArray(message.content)) {
      const turn = prompts.at(-1);
      for (const block of message.content) {
        if (!turn) break;
        if (block.type === 'text' && block.text?.trim()) turn.replies.push(block.text.trim());
        const file = block.type === 'tool_use' && ['Write', 'Edit', 'NotebookEdit'].includes(block.name) && block.input?.file_path;
        if (file && !turn.files.includes(file)) turn.files.push(file);
      }
    }

    if (entry.type === 'queue-operation' && entry.operation === 'enqueue' && typeof entry.content === 'string') {
      addPrompt(at, entry.content, []);
    }
    if (entry.type === 'user' && !entry.isMeta && !entry.isSidechain) {
      if (typeof message.content === 'string') addPrompt(at, message.content, []);
      else if (Array.isArray(message.content) && !message.content.some((b: any) => b.type === 'tool_result')) {
        const text = message.content.filter((b: any) => b.type === 'text' && !isInjected(b.text ?? '')).map((b: any) => b.text).join('\n');
        const images = message.content
          .filter((b: any) => b.type === 'image' && b.source?.type === 'base64')
          .map((b: any) => ({ mime: b.source.media_type, data: b.source.data }));
        addPrompt(at, text, images);
      }
    }
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (block.type === 'tool_use' && String(block.name).endsWith('mark_chapter')) {
        marks.push({ at, label: 'chapter: ' + block.input?.title });
      }
    }
    const usage = message.usage;
    if (!usage || !message.id || entry.isSidechain) continue;
    const write1h = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
    byId.set(message.id, {
      at,
      model: message.model ?? 'unknown',
      effort: typeof entry.effort === 'string' ? entry.effort : undefined,
      input: usage.input_tokens ?? 0,
      output: usage.output_tokens ?? 0,
      cacheRead: usage.cache_read_input_tokens ?? 0,
      write1h,
      write5m: (usage.cache_creation_input_tokens ?? 0) - write1h,
    });
  }
  return { agent: 'claude', id, title, cwd, messages: [...byId.values()], marks, prompts };
}

function readCodex(entries: any[]): Session {
  const messages: Message[] = [];
  const marks: Mark[] = [];
  const prompts: Prompt[] = [];
  let cwd: string | undefined;
  let model = 'unknown';
  let effort: string | undefined;
  let id: string | undefined;
  const seen = new Set<string>();

  for (const entry of entries) {
    const at = Date.parse(entry.timestamp);
    const p = entry.payload ?? {};
    if (Number.isNaN(at)) continue;
    if (entry.type === 'session_meta') {
      cwd = p.cwd;
      id = p.session_id ?? p.id;
    }
    if (entry.type === 'response_item' && p.type === 'message' && p.role === 'assistant') {
      const text = (Array.isArray(p.content) ? p.content : [])
        .filter((c: any) => c.type === 'output_text')
        .map((c: any) => c.text)
        .join('\n')
        .trim();
      if (text) prompts.at(-1)?.replies.push(text);
    }
    if (entry.type === 'response_item' && typeof p.input === 'string' && p.input.includes('*** ')) {
      const turn = prompts.at(-1);
      for (const m of p.input.matchAll(/\*\*\* (?:Add|Update) File: (.+)/g)) {
        if (turn && !turn.files.includes(m[1].trim())) turn.files.push(m[1].trim());
      }
    }
    if (entry.type === 'turn_context') {
      model = p.model ?? model;
      effort = p.effort ?? effort;
    }
    if (entry.type === 'response_item' && p.type === 'message' && p.role === 'user') {
      const parts = Array.isArray(p.content) ? p.content : [];
      const text = parts.filter((c: any) => c.type === 'input_text' && !isInjected(c.text ?? '')).map((c: any) => c.text).join('\n').trim();
      const images = parts
        .filter((c: any) => c.type === 'input_image' && String(c.image_url).startsWith('data:'))
        .map((c: any) => {
          const [head, data] = String(c.image_url).split(',', 2);
          return { mime: head!.slice(5).split(';')[0]!, data: data ?? '' };
        });
      if (text || images.length) {
        prompts.push({ at: new Date(at).toISOString(), text, images, replies: [], files: [] });
        marks.push({ at, label: 'prompt: ' + oneLine(text).slice(0, 60) });
      }
    }
    // One record per API response. OpenAI counts cached tokens inside input_tokens.
    if (entry.type === 'token_usage_record' && p.usage && !seen.has(p.response_id)) {
      seen.add(p.response_id);
      const cached = p.usage.cached_input_tokens ?? 0;
      messages.push({
        at,
        model,
        effort,
        input: Math.max(0, (p.usage.input_tokens ?? 0) - cached - (p.usage.cache_write_input_tokens ?? 0)),
        output: p.usage.output_tokens ?? 0,
        cacheRead: cached,
        write5m: p.usage.cache_write_input_tokens ?? 0,
        write1h: 0,
      });
    }
  }
  return { agent: 'codex', id, cwd, messages, marks, prompts };
}

export function read(path: string): Session {
  const entries = lines(path);
  const codex = entries.some((e) => e.type === 'session_meta' || e.type === 'turn_context');
  const session = codex ? readCodex(entries) : readClaude(entries);
  session.messages.sort((a, b) => a.at - b.at);
  session.marks.sort((a, b) => a.at - b.at);
  return session;
}

export function summarize(messages: Message[], from: number, to: number, label?: string) {
  const inside = messages.filter((m) => m.at >= from && m.at < to);
  const sum = (pick: (m: Message) => number) => inside.reduce((n, m) => n + pick(m), 0);
  let cost = 0;
  const unpriced = new Set<string>();
  for (const m of inside) {
    const price = PRICES[m.model];
    if (!price) {
      unpriced.add(m.model);
      continue;
    }
    const [input, output, cacheRead, cacheWrite] = price;
    if (m.model.startsWith('gpt-') && (m.write5m || m.write1h) && cacheWrite === undefined) {
      unpriced.add(m.model + ' cache writes');
      continue;
    }
    cost += (m.input * input + m.output * output + m.cacheRead * cacheRead
      + m.write5m * (cacheWrite ?? input * WRITE_5M)
      + m.write1h * (cacheWrite ?? input * WRITE_1H)) / 1e6;
  }
  // Working time is the sum of the steps between responses. A long silence is the person
  // being away (or the chat being closed), not work, so each step counts for IDLE at most.
  let active = 0;
  let previous = from;
  for (const m of inside) {
    active += Math.min(m.at - previous, IDLE_MS);
    previous = m.at;
  }
  const efforts = [...new Set(inside.map((m) => m.effort).filter(Boolean))];
  return {
    ...(label && { label }),
    started_at: new Date(from).toISOString(),
    seconds: inside.length ? Math.max(1, Math.round(active / 1000)) : 0,
    responses: inside.length,
    models: [...new Set(inside.map((m) => m.model))],
    ...(efforts.length && { efforts }),
    input_tokens: sum((m) => m.input),
    output_tokens: sum((m) => m.output),
    cache_read_tokens: sum((m) => m.cacheRead),
    cache_write_tokens: sum((m) => m.write5m + m.write1h),
    // No price known for some of the models: leave the cost out rather than understate it.
    ...(unpriced.size ? { unpriced_models: [...unpriced] } : { cost_usd: Math.round(cost * 100) / 100 }),
  };
}

function walk(dir: string, out: string[] = []): string[] {
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    const path = join(dir, name);
    if (name.endsWith('.jsonl')) out.push(path);
    else if (!name.includes('.') && statSync(path).isDirectory()) walk(path, out);
  }
  return out;
}

/** Session files of a directory, most recent first. With `deep`, of everything under it too. */
export function find(agent: string, cwd: string, all: boolean, deep = false): string[] {
  const newestFirst = (paths: string[]) =>
    paths.map((p) => [p, statSync(p).mtimeMs] as const).sort((a, b) => b[1] - a[1]).map(([p]) => p);
  if (agent === 'claude') {
    // Claude Code names the folder after the directory, every non-alphanumeric character as "-".
    const base = join(homedir(), '.claude', 'projects');
    const slug = cwd.replace(/[^a-zA-Z0-9]/g, '-');
    const dirs = readdirSync(base).filter((d) => d === slug || (deep && d.startsWith(slug + '-')));
    const found = newestFirst(
      dirs.flatMap((d) => readdirSync(join(base, d)).filter((n) => n.endsWith('.jsonl')).map((n) => join(base, d, n))),
    );
    return all ? found : found.slice(0, 1);
  }
  const inside = (path: string) => {
    try {
      const first = JSON.parse(readFileSync(path, 'utf8').split('\n', 1)[0]!);
      const at = first.payload?.cwd ?? '';
      return at === cwd || at.startsWith(cwd + '/');
    } catch {
      return false;
    }
  };
  const found = newestFirst(walk(join(homedir(), '.codex', 'sessions'))).filter(inside);
  return all ? found : found.slice(0, 1);
}
