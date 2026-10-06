import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from './config.ts';
import { pool, q1 } from './db.ts';
import { requireAdmin, type Actor } from './auth.ts';
import { HttpError } from './errors.ts';
import { CATALOG_AVATAR_IDS } from './world-agents.ts';

export const AVATAR_LIMIT = 5 * 1024 * 1024;
const directory = join(config.dataDir, 'avatars');

export function validateAvatarPreset(preset: string | null | undefined, kind: string): void {
  if (preset != null && (kind !== 'agent' || !CATALOG_AVATAR_IDS.has(preset))) {
    throw new HttpError(400, 'choose an agent avatar from the catalog');
  }
}

export async function removeAvatar(key: string | null): Promise<void> {
  if (key) await rm(join(directory, key), { force: true }).catch(() => {});
}

// Identify raster content ourselves; a filename or caller-supplied MIME is not trusted.
function imageMime(data: Buffer): string {
  if (!Buffer.isBuffer(data) || data.length === 0) throw new HttpError(400, 'empty image');
  if (data.length > AVATAR_LIMIT) throw new HttpError(413, 'avatar exceeds 5 MB');
  if (data.length >= 33 && data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
      && data.toString('ascii', 12, 16) === 'IHDR'
      && data.readUInt32BE(16) > 0 && data.readUInt32BE(20) > 0) return 'image/png';
  if (data.length >= 4 && data[0] === 255 && data[1] === 216 && data[2] === 255
      && data[data.length - 2] === 255 && data[data.length - 1] === 217) return 'image/jpeg';
  if (data.length >= 20 && data.toString('ascii', 0, 4) === 'RIFF'
      && data.toString('ascii', 8, 12) === 'WEBP' && ['VP8 ', 'VP8L', 'VP8X'].includes(data.toString('ascii', 12, 16))) return 'image/webp';
  throw new HttpError(415, 'upload a PNG, JPEG or WebP image');
}

export async function setAccountAvatar(actor: Actor, id: number, data: Buffer): Promise<void> {
  await authorizeAvatar(actor, id);
  const mime = imageMime(data);
  const key = randomUUID();
  const client = await pool.connect();
  let previous: string | null = null;
  try {
    await client.query('begin');
    const account = (await client.query('select kind, avatar_key from accounts where id = $1 and deleted_at is null for update', [id])).rows[0];
    if (!account) throw new HttpError(404, 'account not found');
    if (account.kind !== 'agent') throw new HttpError(400, 'avatar uploads are for agents');
    previous = account.avatar_key;
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, key), data, { flag: 'wx' });
    await client.query('update accounts set avatar_key = $2, avatar_mime = $3, avatar_preset = null where id = $1', [id, key, mime]);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    await removeAvatar(key);
    throw error;
  } finally {
    client.release();
  }
  await removeAvatar(previous);
}

export async function getAccountAvatar(id: number, version?: string): Promise<{ path: string; mime: string }> {
  const row = await q1('select avatar_key, avatar_mime from accounts where id = $1', [id]);
  if (!row?.avatar_key || (version !== undefined && version !== row.avatar_key)) throw new HttpError(404, 'avatar not found');
  return { path: join(directory, row.avatar_key), mime: row.avatar_mime };
}

export async function authorizeAvatar(actor: Actor, id: number): Promise<void> {
  // An agent may change its own picture; managing another account requires an admin.
  if (actor.id !== id) requireAdmin(actor);
  const account = await q1('select kind from accounts where id = $1 and deleted_at is null', [id]);
  if (!account) throw new HttpError(404, 'account not found');
  if (account.kind !== 'agent') throw new HttpError(400, 'avatar selection is for agents');
}

export async function validatePreset(preset: string | null | undefined): Promise<void> {
  validateAvatarPreset(preset, 'agent');
}

export async function pickAvatar(actor: Actor, id: number, preset: string | null): Promise<void> {
  await authorizeAvatar(actor, id);
  await validatePreset(preset);
  const client = await pool.connect();
  let previous: string | null = null;
  try {
    await client.query('begin');
    const account = (await client.query('select avatar_key from accounts where id = $1 and deleted_at is null for update', [id])).rows[0];
    if (!account) throw new HttpError(404, 'account not found');
    previous = account.avatar_key;
    await client.query('update accounts set avatar_preset = $2, avatar_key = null, avatar_mime = null where id = $1', [id, preset]);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
  await removeAvatar(previous);
}

export async function uploadAvatar(actor: Actor, id: number, data: Buffer, declaredMime?: string): Promise<void> {
  await authorizeAvatar(actor, id);
  const detected = imageMime(data);
  if (declaredMime !== detected) throw new HttpError(415, 'image content does not match its type');
  await setAccountAvatar(actor, id, data);
}

export const getAvatar = getAccountAvatar;
