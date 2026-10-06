// Preset of well-known agent systems for the accounts UI (story #476).
// Bundled PNGs live in public/avatars/{id}.png; missing files fall back to colour + letters.

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from './config.ts';
import { WORLD_AGENTS } from './world-agents.ts';

export type AgentSystem = {
  id: string;
  name: string;
  color: string;
};

export const AGENT_SYSTEMS: AgentSystem[] = WORLD_AGENTS;

const avatarsDir = join(config.publicDir, 'avatars');
let bundledCache: { at: number; ids: Set<string> } | null = null;

export async function bundledAvatarIds(): Promise<Set<string>> {
  const now = Date.now();
  if (bundledCache && now - bundledCache.at < 5_000) return bundledCache.ids;
  let ids = new Set<string>();
  try {
    const files = await readdir(avatarsDir);
    ids = new Set(files.filter((f) => f.endsWith('.png')).map((f) => f.slice(0, -4).toLowerCase()));
  } catch {
    ids = new Set();
  }
  bundledCache = { at: now, ids };
  return ids;
}

export async function listAgentSystems(): Promise<
  Array<AgentSystem & { avatar_url: string | null }>
> {
  const bundled = await bundledAvatarIds();
  return AGENT_SYSTEMS.map((s) => ({
    ...s,
    avatar_url: bundled.has(s.id) ? `/avatars/${s.id}.png` : null,
  }));
}

export function systemColor(system: string | null | undefined): string | null {
  if (!system) return null;
  const found = AGENT_SYSTEMS.find((s) => s.id === system.toLowerCase());
  return found?.color ?? null;
}
