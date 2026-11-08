// Agent tools AI Tracker can be installed into. Ids, skills folders and command folders follow
// OpenSpec's table (https://openspec.dev/docs/supported-tools), checked against its 1.16.1 adapters.

export type CommandFormat =
  | 'md' // description in frontmatter
  | 'md-named' // name and description in frontmatter
  | 'md-plain' // no frontmatter
  | 'prompt-md' // *.prompt.md, description in frontmatter
  | 'continue' // *.prompt with name, description and invokable
  | 'toml'; // description and prompt

export type AgentTool = {
  id: string;
  name: string;
  /** Project-relative folder holding <skill>/SKILL.md; starts with ~/ when the tool only reads it from home. */
  skills: string;
  /** Project-relative folder for slash commands; absent when the tool uses skills only. */
  commands?: string;
  format?: CommandFormat;
  /** The `system` of the tool's tracker account, when it differs from the id. */
  system?: string;
};

const t = (
  id: string,
  name: string,
  skills: string,
  commands?: string,
  format?: CommandFormat,
  system?: string,
): AgentTool => ({ id, name, skills, commands, format, system });

export const AGENT_TOOLS: AgentTool[] = [
  t('amazon-q', 'Amazon Q Developer', '.amazonq/skills', '.amazonq/prompts', 'md'),
  t('amp', 'Amp', '.agents/skills'),
  t('antigravity', 'Antigravity', '.agents/skills', '.agents/workflows', 'md'),
  t('atomcode', 'AtomCode', '.atomcode/skills', '.atomcode/commands', 'md-named'),
  t('auggie', 'Auggie (Augment CLI)', '.augment/skills', '.augment/commands', 'md'),
  t('bob', 'IBM Bob', '.bob/skills', '.bob/commands', 'md'),
  t('claude', 'Claude Code', '.claude/skills', '.claude/commands', 'md'),
  t('cline', 'Cline', '.cline/skills', '.clinerules/workflows', 'md-plain'),
  t('codeartsagent', 'CodeArts', '.codeartsdoer/skills'),
  t('codebuddy', 'CodeBuddy Code (CLI)', '.codebuddy/skills', '.codebuddy/commands', 'md-named'),
  t('codestudio', 'Code Studio', '.codestudio/skills', '.codestudio/prompts', 'prompt-md'),
  t('codex', 'Codex', '.agents/skills'),
  t('continue', 'Continue', '.continue/skills', '.continue/prompts', 'continue'),
  // CoStrict's command folder belongs to OpenSpec (.cospec/openspec/commands), so it gets the skill only.
  t('costrict', 'CoStrict', '.cospec/skills'),
  t('crush', 'Crush', '.crush/skills', '.crush/commands', 'md-named'),
  t('cursor', 'Cursor', '.cursor/skills', '.cursor/commands', 'md-named'),
  t('dsh', 'DeepSeek Harness', '.dsh/skills', undefined, undefined, 'deepseek'),
  t('devin', 'Devin Desktop (formerly Windsurf)', '.devin/skills', '.devin/workflows', 'md-named', 'windsurf'),
  t('easycode', 'EasyCode', '.easycode/skills', '.easycode/commands', 'toml'),
  t('factory', 'Factory Droid', '.factory/skills', '.factory/commands', 'md'),
  t('forgecode', 'ForgeCode', '.forge/skills'),
  t('gemini', 'Gemini CLI', '.gemini/skills', '.gemini/commands', 'toml'),
  t('gigacode', 'GigaCode', '.gigacode/skills', '.gigacode/commands', 'md'),
  t('github-copilot', 'GitHub Copilot', '.github/skills', '.github/prompts', 'prompt-md', 'copilot'),
  t('grok', 'Grok Build', '.grok/skills'),
  t('gsd', 'GSD', '.agents/skills'),
  t('hermes', 'Hermes Agent', '.hermes/skills'),
  t('iflow', 'iFlow', '.iflow/skills', '.iflow/commands', 'md-named'),
  t('junie', 'Junie', '.junie/skills', '.junie/commands', 'md'),
  t('kilocode', 'Kilo Code', '.kilocode/skills', '.kilo/command', 'md-plain'),
  t('kimi', 'Kimi Code', '.kimi-code/skills'),
  t('kiro', 'Kiro', '.kiro/skills', '.kiro/prompts', 'prompt-md'),
  t('lingma', 'Lingma', '.lingma/skills', '.lingma/commands', 'md-named'),
  t('minimax-code', 'MiniMax Code', '~/.minimax/skills'),
  t('vibe', 'Mistral Vibe', '.vibe/skills', undefined, undefined, 'mistral'),
  t('oh-my-pi', 'Oh My Pi', '.omp/skills', '.omp/commands', 'md'),
  t('opencode', 'OpenCode', '.opencode/skills', '.opencode/commands', 'md'),
  t('pi', 'Pi', '.pi/skills', '.pi/prompts', 'md'),
  t('qoder', 'Qoder', '.qoder/skills', '.qoder/commands', 'md-named'),
  t('qwen', 'Qwen Code', '.qwen/skills', '.qwen/commands', 'md'),
  t('trae', 'Trae', '.trae/skills', '.trae/commands', 'md-named'),
  t('veai', 'Veai', '.veai/skills'),
  t('warp', 'Warp', '.warp/skills'),
  t('zcode', 'ZCode', '.zcode/skills', '.zcode/commands', 'md-named'),
  t('roocode', 'Zoo Code', '.roo/skills', '.roo/commands', 'md-plain'),
  t('agents', 'Other / Universal', '.agents/skills'),
];

export const AGENT_TOOL_IDS = new Set(AGENT_TOOLS.map((tool) => tool.id));

/** How a tool reads a remote MCP server from project config, without the key in the file. */
export type McpRecipe = {
  file: string;
  format: 'json' | 'toml';
  /** Top-level key that holds the servers. */
  key: string;
  /** The server's entry. `env` is the variable that holds the key. */
  entry: (url: string, env: string) => Record<string, unknown>;
  doc: string;
  /** What the person has to do before the tool uses the entry. */
  note?: string;
};

const bearer = (url: string, value: string, extra: Record<string, unknown> = {}) => ({
  ...extra,
  url,
  headers: { Authorization: `Bearer ${value}` },
});

/**
 * Only formats whose environment-variable syntax the tool's own documentation shows for a remote
 * server. Checked against the pages in `doc` on 2026-11-08. Add a tool here only with the same evidence:
 * a wrong guess would send a literal "${VAR}" or tempt someone to put the key in the file.
 */
export const MCP_RECIPES: Record<string, McpRecipe> = {
  auggie: {
    file: '.augment/settings.json',
    format: 'json',
    key: 'mcpServers',
    entry: (url, env) => bearer(url, `\${${env}}`, { type: 'http' }),
    doc: 'https://docs.augmentcode.com/cli/integrations',
  },
  claude: {
    file: '.mcp.json',
    format: 'json',
    key: 'mcpServers',
    entry: (url, env) => bearer(url, `\${${env}}`, { type: 'http' }),
    doc: 'https://code.claude.com/docs/en/mcp',
    note: 'approve the project server when Claude Code asks',
  },
  codex: {
    file: '.codex/config.toml',
    format: 'toml',
    key: 'mcp_servers',
    entry: (url, env) => ({ url, bearer_token_env_var: env }),
    doc: 'https://developers.openai.com/codex/config-reference',
    note: 'Codex reads this file only in a trusted project',
  },
  cursor: {
    file: '.cursor/mcp.json',
    format: 'json',
    key: 'mcpServers',
    entry: (url, env) => bearer(url, `\${env:${env}}`),
    doc: 'https://cursor.com/docs/context/mcp',
  },
  factory: {
    file: '.factory/mcp.json',
    format: 'json',
    key: 'mcpServers',
    entry: (url, env) => bearer(url, `\${${env}}`, { type: 'http' }),
    doc: 'https://docs.factory.com/cli/configuration/mcp',
  },
  grok: {
    file: '.grok/config.toml',
    format: 'toml',
    key: 'mcp_servers',
    entry: (url, env) => bearer(url, `\${${env}}`),
    doc: 'https://docs.x.ai/build/features/mcp-servers',
  },
  kimi: {
    file: '.kimi-code/mcp.json',
    format: 'json',
    key: 'mcpServers',
    entry: (url, env) => ({ url, bearerTokenEnvVar: env }),
    doc: 'https://moonshotai.github.io/kimi-code/en/customization/mcp',
    note: 'trust the workspace when Kimi Code asks',
  },
  kiro: {
    file: '.kiro/settings/mcp.json',
    format: 'json',
    key: 'mcpServers',
    entry: (url, env) => bearer(url, `\${${env}}`),
    doc: 'https://kiro.dev/docs/mcp/configuration/',
    note: 'add AI_TRACKER_KEY to "Mcp Approved Env Vars" in Kiro settings',
  },
};

/** Extension of a command file in the given format. */
export function commandExtension(format: CommandFormat): string {
  if (format === 'toml') return 'toml';
  if (format === 'prompt-md') return 'prompt.md';
  if (format === 'continue') return 'prompt';
  return 'md';
}

/** Turns a command's description and body into the file a tool expects. */
export function formatCommand(
  format: CommandFormat,
  command: { name: string; description: string; body: string },
): string {
  const body = command.body.trim();
  const yaml = (value: string) => JSON.stringify(value);
  switch (format) {
    case 'md':
    case 'prompt-md':
      return `---\ndescription: ${yaml(command.description)}\n---\n\n${body}\n`;
    case 'md-named':
      return `---\nname: ${command.name}\ndescription: ${yaml(command.description)}\n---\n\n${body}\n`;
    case 'md-plain':
      return `${body}\n`;
    case 'continue':
      return `---\nname: ${command.name}\ndescription: ${yaml(command.description)}\ninvokable: true\n---\n\n${body}\n`;
    case 'toml':
      // A literal multi-line string needs no escaping unless the body has ''' in it.
      if (body.includes("'''")) throw new Error(`command ${command.name} contains ''' and cannot be written as TOML`);
      return `description = ${JSON.stringify(command.description)}\n\nprompt = '''\n${body}\n'''\n`;
  }
}
