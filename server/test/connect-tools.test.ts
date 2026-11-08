import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { AGENT_TOOLS, MCP_RECIPES, commandExtension, formatCommand } from '../scripts/lib/agent-tools.ts';
import { CATALOG_AVATAR_IDS, WORLD_AGENTS } from '../src/world-agents.ts';
import * as publicCatalog from '../public/world-agents.js';

const server = fileURLToPath(new URL('../', import.meta.url));
const script = join(server, 'scripts/connect-tools.ts');
const SECRET = 'tracker-test-secret-key';

function run(args: string[], home: string) {
  return spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', script, ...args], {
    env: { ...process.env, HOME: home, AI_TRACKER_KEY: SECRET, AI_TRACKER_URL: '' },
    encoding: 'utf8',
  });
}

function withProject(body: (project: string, home: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'connect-tools-test-'));
  try {
    const project = join(dir, 'project');
    const home = join(dir, 'home');
    mkdirSync(project);
    mkdirSync(home);
    body(project, home);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const install = (project: string, tools: string, url = 'https://tracker.example.com/') => [
  '--project', project, '--tools', tools, '--human', 'ivan', '--url', url,
];

test('the registry covers every tool of the OpenSpec table, each with a catalog system', () => {
  assert.equal(AGENT_TOOLS.length, 46);
  assert.equal(new Set(AGENT_TOOLS.map((tool) => tool.id)).size, 46);
  const systems = new Set(WORLD_AGENTS.map((agent) => agent.id));
  for (const tool of AGENT_TOOLS) {
    if (tool.id !== 'agents') assert.ok(systems.has(tool.system ?? tool.id), `no system for ${tool.id}`);
    assert.equal(Boolean(tool.commands), Boolean(tool.format), `command folder and format of ${tool.id}`);
  }
  for (const id of Object.keys(MCP_RECIPES)) assert.ok(AGENT_TOOLS.some((tool) => tool.id === id), id);
});

test('the catalog is the same on both sides and promises only images that exist', () => {
  assert.deepEqual(publicCatalog.WORLD_AGENTS, WORLD_AGENTS);
  assert.deepEqual([...publicCatalog.CATALOG_AVATAR_IDS], [...CATALOG_AVATAR_IDS]);
  assert.ok(!CATALOG_AVATAR_IDS.has('opencode'));
  for (const id of CATALOG_AVATAR_IDS) assert.ok(existsSync(join(server, 'public/avatars', `${id}.png`)), id);
});

test('command files follow the format of their tool', () => {
  const command = { name: 'tracker-plan', description: 'План: "задачи"', body: 'Разбей работу.\n' };
  assert.equal(formatCommand('md', command), '---\ndescription: "План: \\"задачи\\""\n---\n\nРазбей работу.\n');
  assert.equal(formatCommand('md-plain', command), 'Разбей работу.\n');
  assert.ok(formatCommand('md-named', command).startsWith('---\nname: tracker-plan\n'));
  assert.ok(formatCommand('continue', command).includes('invokable: true'));
  assert.equal(formatCommand('toml', command), `description = "План: \\"задачи\\""\n\nprompt = '''\nРазбей работу.\n'''\n`);
  assert.equal(commandExtension('prompt-md'), 'prompt.md');
  assert.throws(() => formatCommand('toml', { ...command, body: "a ''' b" }));
});

test('installs the skill and command without the owner\'s details or any key', () => {
  withProject((project, home) => {
    const result = run(install(project, 'qwen,gemini,kiro,warp'), home);
    assert.equal(result.status, 0, result.stderr);
    const skill = readFileSync(join(project, '.qwen/skills/ai-tracker/SKILL.md'), 'utf8');
    assert.ok(skill.startsWith('---\nname: ai-tracker'));
    assert.ok(skill.includes('`ivan`'));
    assert.ok(!/shabanov|~\/Projects/.test(skill));
    assert.ok(readFileSync(join(project, '.qwen/commands/tracker-plan.md'), 'utf8').startsWith('---\ndescription:'));
    assert.ok(readFileSync(join(project, '.gemini/commands/tracker-plan.toml'), 'utf8').startsWith('description = '));
    assert.ok(existsSync(join(project, '.kiro/prompts/tracker-plan.prompt.md')));
    assert.ok(existsSync(join(project, '.warp/skills/ai-tracker/SKILL.md')));
    assert.ok(!existsSync(join(project, '.warp/commands')));
    assert.ok(!result.stdout.includes(SECRET));
    assert.ok(result.stdout.includes('npm run account -- create --name qwen --kind agent --system qwen'));
    for (const recipe of Object.values(MCP_RECIPES)) {
      const path = join(project, recipe.file);
      if (existsSync(path)) assert.ok(!readFileSync(path, 'utf8').includes(SECRET), recipe.file);
    }
  });
});

test('tools sharing a folder get one copy, and "all" stays inside the project', () => {
  withProject((project, home) => {
    const result = run(['--project', project, '--tools', 'all', '--human', 'ivan'], home);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(existsSync(join(project, '.agents/skills/ai-tracker/SKILL.md')));
    assert.ok(!existsSync(join(home, '.minimax')));
    const global = run(['--project', project, '--tools', 'minimax-code', '--human', 'ivan'], home);
    assert.equal(global.status, 0, global.stderr);
    assert.ok(existsSync(join(home, '.minimax/skills/ai-tracker/SKILL.md')));
    assert.ok(global.stdout.includes('Installed outside the project'));
  });
});

test('wrong input changes nothing', () => {
  withProject((project, home) => {
    for (const args of [
      ['--project', project, '--tools', 'gemini,nonsense', '--human', 'ivan'],
      ['--project', project, '--tools', 'gemini', '--human', '../ivan'],
      ['--project', project, '--tools', 'gemini'],
      ['--project', join(project, 'missing'), '--tools', 'gemini', '--human', 'ivan'],
      ['--project', project, '--tools', 'gemini', '--human', 'ivan', '--url', 'ftp://host'],
    ]) {
      assert.equal(run(args, home).status, 1, args.join(' '));
    }
    assert.ok(!existsSync(join(project, '.gemini')));
  });
});

test('a dry run writes nothing', () => {
  withProject((project, home) => {
    const result = run([...install(project, 'gemini'), '--dry-run'], home);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes('Dry run'));
    assert.ok(!existsSync(join(project, '.gemini')));
  });
});

for (const [id, recipe] of Object.entries(MCP_RECIPES)) {
  test(`MCP for ${id} keeps other settings, refers to the key by name and is repeatable`, () => {
    withProject((project, home) => {
      const path = join(project, recipe.file);
      mkdirSync(join(path, '..'), { recursive: true });
      if (recipe.format === 'json') writeFileSync(path, JSON.stringify({ theme: 'dark', [recipe.key]: { other: { url: 'x' } } }));
      else writeFileSync(path, 'model = "x"\n');

      assert.equal(run(install(project, id), home).status, 0);
      const first = readFileSync(path, 'utf8');
      assert.ok(first.includes('https://tracker.example.com/mcp'));
      assert.ok(first.includes('AI_TRACKER_KEY'));
      assert.ok(!first.includes(SECRET));
      if (recipe.format === 'json') {
        const config = JSON.parse(first);
        assert.equal(config.theme, 'dark');
        assert.deepEqual(config[recipe.key].other, { url: 'x' });
        assert.ok(config[recipe.key]['ai-tracker']);
      } else {
        assert.ok(first.startsWith('model = "x"\n'));
      }

      assert.equal(run(install(project, id), home).status, 0);
      assert.equal(readFileSync(path, 'utf8'), first);
    });
  });
}

test('MCP entries use the syntax each tool documents', () => {
  const entry = (id: string) => MCP_RECIPES[id].entry('https://h/mcp', 'AI_TRACKER_KEY');
  assert.deepEqual(entry('claude'), { type: 'http', url: 'https://h/mcp', headers: { Authorization: 'Bearer ${AI_TRACKER_KEY}' } });
  assert.deepEqual(entry('cursor'), { url: 'https://h/mcp', headers: { Authorization: 'Bearer ${env:AI_TRACKER_KEY}' } });
  assert.deepEqual(entry('codex'), { url: 'https://h/mcp', bearer_token_env_var: 'AI_TRACKER_KEY' });
  assert.deepEqual(entry('kimi'), { url: 'https://h/mcp', bearerTokenEnvVar: 'AI_TRACKER_KEY' });
  withProject((project, home) => {
    assert.equal(run(install(project, 'grok'), home).status, 0);
    assert.equal(
      readFileSync(join(project, '.grok/config.toml'), 'utf8'),
      '[mcp_servers.ai-tracker]\nurl = "https://tracker.example.com/mcp"\nheaders = { "Authorization" = "Bearer ${AI_TRACKER_KEY}" }\n',
    );
  });
});

test('MCP config that is not plain JSON stays untouched and is reported', () => {
  const entry = Object.entries(MCP_RECIPES).find(([, recipe]) => recipe.format === 'json');
  if (!entry) return;
  withProject((project, home) => {
    const [id, recipe] = entry;
    const path = join(project, recipe.file);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, '{ // my comment\n}\n');
    const result = run(install(project, id), home);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(path, 'utf8'), '{ // my comment\n}\n');
    assert.ok(result.stdout.includes('not plain JSON'));
  });
});
