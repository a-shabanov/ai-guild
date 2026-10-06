/** Preset of well-known agent systems for account creation and avatar catalog. */
export type WorldAgent = { id: string; name: string; color: string };

export const WORLD_AGENTS: WorldAgent[] = [
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

export const WORLD_AGENT_IDS = new Set(WORLD_AGENTS.map((a) => a.id));

/** Systems that currently ship a PNG under /avatars/{id}.png. */
export const CATALOG_AVATAR_IDS = new Set(WORLD_AGENTS.map((a) => a.id));
