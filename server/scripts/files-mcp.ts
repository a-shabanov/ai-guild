// Local companion of the tracker: moves files between this computer and the tracker.
//
// The tracker's own MCP server is remote and cannot see local files, and the commands an
// agent runs are often sandboxed without network access (Codex), so `curl` uploads fail there.
// MCP servers run outside that sandbox: the agent names a file, this process reads and sends it.
//
//   node files-mcp.ts            (stdio MCP server; started by Claude Code / Codex)
//
// Environment: AI_TRACKER_URL (default http://127.0.0.1:4600), and the key either in
// AI_TRACKER_KEY or in ~/.config/ai-tracker/<AI_TRACKER_ACCOUNT>.key.
import { readFileSync, statSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const BASE = (process.env.AI_TRACKER_URL ?? 'http://127.0.0.1:4600').replace(/\/$/, '');
const LIMIT = 500 * 1024 * 1024;

function key(): string {
  if (process.env.AI_TRACKER_KEY) return process.env.AI_TRACKER_KEY.trim();
  const account = process.env.AI_TRACKER_ACCOUNT;
  if (!account) throw new Error('set AI_TRACKER_KEY or AI_TRACKER_ACCOUNT for this MCP server');
  return readFileSync(join(homedir(), '.config', 'ai-tracker', `${account}.key`), 'utf8').trim();
}

// What must never leave the machine through an attachment, whatever the agent was told.
const SECRET_NAMES = /^(\.env(\..*)?|\.keys.*|.*\.pem|.*\.p8|.*\.p12|.*\.key|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|auth\.json|credentials(\.json)?|\.netrc|\.npmrc)$/i;
const SECRET_DIRS = ['.ssh', '.aws', '.gnupg', join('.config', 'ai-tracker'), 'Keychains'].map(
  (d) => join(homedir(), d) + sep,
);

function checked(path: string): { path: string; size: number } {
  const real = realpathSync(resolve(path));
  const info = statSync(real);
  if (!info.isFile()) throw new Error(`${path} is not a file`);
  if (info.size === 0) throw new Error(`${path} is empty`);
  if (info.size > LIMIT) throw new Error(`${path} is larger than ${LIMIT / 1024 ** 2} MB`);
  if (SECRET_NAMES.test(basename(real)) || SECRET_DIRS.some((d) => real.startsWith(d))) {
    throw new Error(`${path} looks like a credential and will not be uploaded`);
  }
  return { path: real, size: info.size };
}

async function api(method: string, path: string, body?: FormData): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(BASE + path, { method, headers: { Authorization: `Bearer ${key()}` }, body });
  } catch {
    throw new Error(`the tracker at ${BASE} is not reachable`);
  }
  if (!res.ok) {
    const message = await res.json().then((j: any) => j.error, () => res.statusText);
    throw new Error(`tracker answered ${res.status}: ${message}`);
  }
  return res;
}

const server = new McpServer(
  { name: 'ai-tracker-files', version: '0.1.0' },
  {
    instructions:
      'Attaches local files (screenshots, renders, video, archives, logs) to tasks in AI Tracker and ' +
      'downloads attachments. Use it instead of curl: it works where shell commands have no network.',
  },
);

const fail = (err: unknown) => ({
  content: [{ type: 'text' as const, text: err instanceof Error ? err.message : String(err) }],
  isError: true,
});

server.registerTool(
  'attach_files',
  {
    description:
      'Upload local files to a task. Returns their names as stored; show a picture in a description, ' +
      'comment or result by writing ![what it shows](name.png).',
    inputSchema: {
      task_id: z.number().int(),
      paths: z.array(z.string().min(1)).min(1).max(20).describe('Absolute paths, or relative to cwd'),
      cwd: z.string().optional().describe('Directory that relative paths are resolved against'),
      comment_id: z.number().int().optional().describe('Attach to this comment of the task'),
    },
  },
  async ({ task_id, paths, cwd, comment_id }) => {
    try {
      const form = new FormData();
      for (const given of paths) {
        const file = checked(cwd ? resolve(cwd, given) : given);
        form.append('file', new Blob([readFileSync(file.path)]), basename(file.path));
      }
      const query = comment_id ? `?comment_id=${comment_id}` : '';
      const res = await api('POST', `/api/tasks/${task_id}/attachments${query}`, form);
      const saved = (await res.json()) as any[];
      const lines = saved.map((a) => `${a.filename} (${a.kind}, ${a.size} bytes, attachment ${a.id})`);
      return { content: [{ type: 'text' as const, text: `Attached to task ${task_id}:\n${lines.join('\n')}` }] };
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  'download_attachment',
  {
    description: 'Save an attachment of a task to a local file.',
    inputSchema: {
      attachment_id: z.number().int(),
      to: z.string().min(1).describe('Where to save it: a file path, absolute or relative to cwd'),
      cwd: z.string().optional(),
    },
  },
  async ({ attachment_id, to, cwd }) => {
    try {
      const target = cwd ? resolve(cwd, to) : resolve(to);
      const res = await api('GET', `/api/attachments/${attachment_id}/content`);
      const data = Buffer.from(await res.arrayBuffer());
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, data, { flag: 'wx' });
      return { content: [{ type: 'text' as const, text: `Saved ${data.length} bytes to ${target}` }] };
    } catch (err: any) {
      if (err?.code === 'EEXIST') return fail(new Error(`${to} already exists; choose another name`));
      return fail(err);
    }
  },
);

await server.connect(new StdioServerTransport());
