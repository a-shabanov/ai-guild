// An installed app keeps its cached screens until the service worker's cache gets a new name. A change to those files
// that keeps the name reaches nobody who has opened the app before, and nothing else would say so.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const publicDir = join(import.meta.dirname, '..', 'public');
const worker = readFileSync(join(publicDir, 'sw.js'), 'utf8');
const files = [...worker.match(/const SHELL_FILES = \[([\s\S]*?)\];/)![1]!.matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]!.split('?')[0]!);
const shellName = worker.match(/^const SHELL = `([^`]+)`;/m)![1]!;
const fingerprint = () => {
  const hash = createHash('sha256');
  // version.js changes with each release and the release changes the name anyway.
  for (const file of files.filter((f) => f !== '/version.js')) hash.update(`${file}\n`).update(readFileSync(join(publicDir, file === '/' ? 'index.html' : file)));
  return hash.digest('hex').slice(0, 16);
};
// One line per state of the screens that was released. Changed them? Add a mark to SHELL in sw.js, then a line here.
const released = JSON.parse(readFileSync(join(import.meta.dirname, 'shell-cache.json'), 'utf8')) as { shell: string; files: string }[];

test('changed screens come with a new name for the cache, or installed apps never see them', () => {
  const now = fingerprint();
  const entry = released.find((r) => r.files === now);
  assert.ok(entry, `the files of the app changed (${now}): add a mark to SHELL in public/sw.js and a line { shell, files } to test/shell-cache.json`);
  assert.equal(entry.shell, shellName.replace('${VERSION}', '{VERSION}'), 'this state of the files was released under another cache name');
  assert.equal(new Set(released.map((r) => r.shell)).size, released.length, 'one cache name was used for two different sets of files');
});
