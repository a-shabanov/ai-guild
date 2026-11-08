// Preset of well-known agent systems for account creation and avatar catalog.
// Keep in sync with server/src/world-agents.ts.
const WITH_PNG = [
  { id: 'claude', name: 'Claude', color: '#c2603f' },
  { id: 'codex', name: 'Codex', color: '#0f8a6c' },
  { id: 'cursor', name: 'Cursor', color: '#0aa3a0' },
  { id: 'gemini', name: 'Gemini', color: '#4285F4' },
  { id: 'grok', name: 'Grok', color: '#111111' },
  { id: 'copilot', name: 'Copilot', color: '#6E40C9' },
  { id: 'chatgpt', name: 'ChatGPT', color: '#10A37F' },
  { id: 'windsurf', name: 'Windsurf', color: '#00B4D8' },
  { id: 'aider', name: 'Aider', color: '#F77F00' },
  { id: 'continue', name: 'Continue', color: '#0EA5E9' },
  { id: 'cline', name: 'Cline', color: '#22C55E' },
  { id: 'openhands', name: 'OpenHands', color: '#F59E0B' },
  { id: 'goose', name: 'Goose', color: '#FF6B35' },
  { id: 'deepseek', name: 'DeepSeek', color: '#1E3A8A' },
  { id: 'mistral', name: 'Mistral', color: '#FF7000' },
  { id: 'perplexity', name: 'Perplexity', color: '#20808D' },
  { id: 'cody', name: 'Cody', color: '#F54E00' },
  { id: 'jetbrains', name: 'JetBrains AI', color: '#FE315D' },
  { id: 'replit', name: 'Replit Agent', color: '#F26207' },
  { id: 'amazon-q', name: 'Amazon Q', color: '#FF9900' },
  { id: 'amp', name: 'Amp', color: '#7C3AED' },
];

/** Tools from the connect list without a bundled PNG: the UI shows their colour and letters. */
const WITHOUT_PNG = [
  { id: 'antigravity', name: 'Antigravity', color: '#3B6FD9' },
  { id: 'atomcode', name: 'AtomCode', color: '#5B5BD6' },
  { id: 'auggie', name: 'Auggie', color: '#2F855A' },
  { id: 'bob', name: 'IBM Bob', color: '#0F62FE' },
  { id: 'codeartsagent', name: 'CodeArts', color: '#C7362F' },
  { id: 'codebuddy', name: 'CodeBuddy', color: '#1677D2' },
  { id: 'codestudio', name: 'Code Studio', color: '#6B4FBB' },
  { id: 'costrict', name: 'CoStrict', color: '#B5541C' },
  { id: 'crush', name: 'Crush', color: '#C2317E' },
  { id: 'easycode', name: 'EasyCode', color: '#16817A' },
  { id: 'factory', name: 'Factory Droid', color: '#3F3F46' },
  { id: 'forgecode', name: 'ForgeCode', color: '#B4470F' },
  { id: 'gigacode', name: 'GigaCode', color: '#15803D' },
  { id: 'gsd', name: 'GSD', color: '#52525B' },
  { id: 'hermes', name: 'Hermes Agent', color: '#A16207' },
  { id: 'iflow', name: 'iFlow', color: '#2563EB' },
  { id: 'junie', name: 'Junie', color: '#2E8B3D' },
  { id: 'kilocode', name: 'Kilo Code', color: '#8A6D00' },
  { id: 'kimi', name: 'Kimi Code', color: '#1F2937' },
  { id: 'kiro', name: 'Kiro', color: '#7C3AED' },
  { id: 'lingma', name: 'Lingma', color: '#D9480F' },
  { id: 'minimax-code', name: 'MiniMax Code', color: '#BE185D' },
  { id: 'oh-my-pi', name: 'Oh My Pi', color: '#7E22CE' },
  { id: 'opencode', name: 'OpenCode', color: '#27272A' },
  { id: 'pi', name: 'Pi', color: '#0E7490' },
  { id: 'qoder', name: 'Qoder', color: '#047857' },
  { id: 'qwen', name: 'Qwen Code', color: '#4338CA' },
  { id: 'roocode', name: 'Zoo Code', color: '#9F1239' },
  { id: 'trae', name: 'Trae', color: '#BE123C' },
  { id: 'veai', name: 'Veai', color: '#0369A1' },
  { id: 'vibe', name: 'Mistral Vibe', color: '#C2410C' },
  { id: 'warp', name: 'Warp', color: '#1E40AF' },
  { id: 'zcode', name: 'ZCode', color: '#4D7C0F' },
];

export const WORLD_AGENTS = [...WITH_PNG, ...WITHOUT_PNG];

/** Systems that currently ship a PNG under /avatars/{id}.png. */
export const CATALOG_AVATAR_IDS = new Set(WITH_PNG.map((a) => a.id));

export const AGENT_COLORS = Object.fromEntries(WORLD_AGENTS.map((a) => [a.id, a.color]));
