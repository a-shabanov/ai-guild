// Installs AI Tracker into a project for any of the supported agent tools:
//   npm run connect -- --list
//   npm run connect -- --project ~/Projects/app --tools gemini,opencode --human ivan --url https://tracker.example.com
// Writes the tracker skill, the planning command and, where the format is known, the MCP entry.
// Keys never go into files: MCP entries refer to the AI_TRACKER_KEY environment variable.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  AGENT_TOOLS,
  AGENT_TOOL_IDS,
  MCP_RECIPES,
  commandExtension,
  formatCommand,
  type AgentTool,
  type McpRecipe,
} from './lib/agent-tools.ts';

const KEY_ENV = 'AI_TRACKER_KEY';
const SERVER = 'ai-tracker';
const prompts = fileURLToPath(new URL('../../prompts/', import.meta.url));

const USAGE = `Usage:
  npm run connect -- --list
  npm run connect -- --project DIR --tools ID[,ID...]|all --human NAME [--url URL] [--dry-run]

  --project  project folder to install into
  --tools    tool ids from --list, or "all" (all project-level tools)
  --human    the person's account name in the tracker
  --url      tracker address; AI_TRACKER_URL is used when omitted. Without it MCP is not configured
  --dry-run  show what would change and write nothing`;

function fail(message: string): never {
  console.error(`${message}\n\n${USAGE}`);
  process.exit(1);
}

/** Removes what only makes sense on the tracker owner's machine from a prompt. */
function personalize(text: string, human: string): string {
  return text
    .replace(/Проект — по репозиторию:[^\n]*/g, 'Проект — по имени репозитория.')
    .replaceAll('~/Projects/AI-tracker', '$AI_TRACKER_REPO')
    .replaceAll('shabanov', human);
}

function parseCommand(source: string): { description: string; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(source);
  const description = match && /^description:\s*(.+)$/m.exec(match[1])?.[1];
  if (!match || !description) throw new Error('a command file needs a description in its frontmatter');
  return { description, body: match[2] };
}

type Change = 'created' | 'updated' | 'unchanged';

function writeOwned(path: string, content: string, dryRun: boolean): Change {
  const previous = existsSync(path) ? readFileSync(path, 'utf8') : null;
  if (previous === content) return 'unchanged';
  if (!dryRun) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  return previous === null ? 'created' : 'updated';
}

type McpResult = { status: string; manual: boolean };

function tomlLines(table: string, entry: Record<string, unknown>): string {
  const value = (item: unknown): string =>
    item !== null && typeof item === 'object'
      ? `{ ${Object.entries(item).map(([key, inner]) => `${JSON.stringify(key)} = ${value(inner)}`).join(', ')} }`
      : JSON.stringify(item);
  const lines = Object.entries(entry).map(([key, item]) => `${key} = ${value(item)}`);
  return `[${table}]\n${lines.join('\n')}\n`;
}

function writeMcp(project: string, recipe: McpRecipe, url: string, dryRun: boolean): McpResult {
  const path = join(project, recipe.file);
  const entry = recipe.entry(url, KEY_ENV);
  const previous = existsSync(path) ? readFileSync(path, 'utf8') : null;

  if (recipe.format === 'toml') {
    const table = `${recipe.key}.${SERVER}`;
    if (previous?.includes(`[${table}]`)) return { status: `${recipe.file}: already has ${SERVER}, kept`, manual: false };
    const block = tomlLines(table, entry);
    if (!dryRun) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, previous ? `${previous.trimEnd()}\n\n${block}` : block);
    }
    return { status: `${recipe.file}: added`, manual: false };
  }

  let config: Record<string, any> = {};
  if (previous !== null) {
    try {
      config = JSON.parse(previous);
    } catch {
      return { status: `${recipe.file}: not plain JSON, left as is; add the server by hand`, manual: true };
    }
    if (config === null || typeof config !== 'object' || Array.isArray(config)) {
      return { status: `${recipe.file}: unexpected content, left as is; add the server by hand`, manual: true };
    }
  }
  const servers = config[recipe.key];
  if (servers !== undefined && (servers === null || typeof servers !== 'object' || Array.isArray(servers))) {
    return { status: `${recipe.file}: unexpected "${recipe.key}", left as is; add the server by hand`, manual: true };
  }
  if (servers?.[SERVER] !== undefined) {
    return JSON.stringify(servers[SERVER]) === JSON.stringify(entry)
      ? { status: `${recipe.file}: unchanged`, manual: false }
      : { status: `${recipe.file}: already has a different ${SERVER}, kept`, manual: false };
  }
  config[recipe.key] = { ...servers, [SERVER]: entry };
  if (!dryRun) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  }
  return { status: `${recipe.file}: added`, manual: false };
}

function list(): void {
  console.table(
    AGENT_TOOLS.map((tool) => ({
      id: tool.id,
      name: tool.name,
      skills: tool.skills,
      command: tool.commands ? 'yes' : 'no',
      mcp: MCP_RECIPES[tool.id] ? 'automatic' : 'by hand',
    })),
  );
}

function selectTools(raw: string): AgentTool[] {
  const ids = raw.split(',').map((id) => id.trim()).filter(Boolean);
  if (ids.length === 0) fail('--tools is empty');
  if (ids.includes('all')) return AGENT_TOOLS.filter((tool) => !tool.skills.startsWith('~/'));
  const unknown = ids.filter((id) => !AGENT_TOOL_IDS.has(id));
  if (unknown.length > 0) fail(`Unknown tools: ${unknown.join(', ')}. See --list.`);
  return AGENT_TOOLS.filter((tool) => ids.includes(tool.id));
}

function main(): void {
  const { values } = parseArgs({
    options: {
      list: { type: 'boolean' },
      project: { type: 'string' },
      tools: { type: 'string' },
      human: { type: 'string' },
      url: { type: 'string' },
      'dry-run': { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) return console.log(USAGE);
  if (values.list) return list();

  if (!values.project) fail('--project is required');
  if (!values.tools) fail('--tools is required');
  if (!values.human || !/^[\w.-]+$/.test(values.human)) fail('--human must be an account name');
  const project = resolve(values.project);
  if (!existsSync(project) || !statSync(project).isDirectory()) fail(`Not a folder: ${project}`);
  const tools = selectTools(values.tools);

  const base = (values.url ?? process.env.AI_TRACKER_URL ?? '').replace(/\/+$/, '');
  if (base && !/^https?:\/\/[^\s/]+/.test(base)) fail(`Not an http(s) address: ${base}`);
  const url = base ? `${base}/mcp` : null;
  const dryRun = values['dry-run'] === true;
  const human = values.human;

  const skill = personalize(readFileSync(join(prompts, 'skills/ai-tracker/SKILL.md'), 'utf8'), human);
  const plan = parseCommand(personalize(readFileSync(join(prompts, 'tracker-plan.md'), 'utf8'), human));

  const seen = new Map<string, Change>();
  const once = (path: string, content: string): Change => {
    const known = seen.get(path);
    if (known) return known;
    const change = writeOwned(path, content, dryRun);
    seen.set(path, change);
    return change;
  };

  const manual: AgentTool[] = [];
  const outside: string[] = [];
  for (const tool of tools) {
    const skillsDir = tool.skills.startsWith('~/') ? join(homedir(), tool.skills.slice(2)) : join(project, tool.skills);
    if (tool.skills.startsWith('~/')) outside.push(`${tool.name}: ${skillsDir}`);
    const lines = [`skill ${once(join(skillsDir, SERVER, 'SKILL.md'), skill)}`];
    if (tool.commands && tool.format) {
      const file = `tracker-plan.${commandExtension(tool.format)}`;
      const content = formatCommand(tool.format, { name: 'tracker-plan', ...plan });
      lines.push(`command ${once(join(project, tool.commands, file), content)}`);
    }
    const recipe = MCP_RECIPES[tool.id];
    if (recipe && url) {
      const result = writeMcp(project, recipe, url, dryRun);
      lines.push(`mcp ${result.status}`);
      if (result.manual) manual.push(tool);
      else if (recipe.note) lines.push(`then ${recipe.note}`);
    } else {
      lines.push(recipe ? 'mcp skipped, no --url' : 'mcp by hand');
      if (!recipe) manual.push(tool);
    }
    console.log(`${tool.name} (${tool.id}): ${lines.join('; ')}`);
  }

  if (dryRun) console.log('\nDry run: nothing was written.');
  if (outside.length > 0) console.log(`\nInstalled outside the project:\n  ${outside.join('\n  ')}`);
  if (manual.length > 0) {
    console.log(`\nConnect MCP by hand in: ${manual.map((tool) => tool.name).join(', ')}.`);
    console.log(`  Server: ${url ?? 'https://your-host/mcp'}, HTTP transport`);
    console.log(`  Header: Authorization: Bearer <the key from ${KEY_ENV}>; do not put the key in a committed file.`);
  }
  console.log('\nThese tools have not been certified: see docs/agents.md for what was checked.');
  console.log('Next, for each tool, on the tracker server:');
  for (const tool of tools) {
    console.log(`  npm run account -- create --name ${tool.id} --kind agent --system ${tool.system ?? tool.id}`);
  }
  console.log(`Start each tool with its own key in ${KEY_ENV}: one account per agent. Restart a running tool to pick up changes.`);
}

main();
