#!/usr/bin/env node
// Dry run by default. The workflow supplies a repository-scoped, short-lived token.
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const entries = JSON.parse(await readFile(resolve(root, 'docs/releases/index.json'), 'utf8'));
const current = JSON.parse(await readFile(resolve(root, 'version.json'), 'utf8'));
const publish = process.argv.includes('--publish');
const repository = process.env.GITHUB_REPOSITORY || 'a-shabanov/ai-guild';
const token = process.env.GITHUB_TOKEN;
if (publish && !token) throw new Error('Publishing requires GITHUB_TOKEN from the release workflow.');
if (!entries.some(entry => entry.version === current.version && entry.build === current.build)) {
  throw new Error(`Release notes are missing for ${current.version} (${current.build}).`);
}
const commits = git('log', '--format=%H', '--', 'version.json').split('\n');
const seen = new Set();
const plan = [];
// Validate the whole batch before making any external change.
for (const entry of entries) {
  if (!/^\d+\.\d+\.\d+$/.test(entry.version) || !Number.isInteger(entry.build) || entry.build < 1) throw new Error('Invalid release version/build.');
  const tag = `v${entry.version}`;
  if (seen.has(tag)) throw new Error(`Duplicate release: ${tag}`);
  seen.add(tag);
  let commit;
  for (const candidate of commits) {
    const version = JSON.parse(git('show', `${candidate}:version.json`));
    if (version.version === entry.version && version.build === entry.build) {commit = candidate;break;}
  }
  if (!commit) throw new Error(`No committed version matches ${tag} (${entry.build}).`);
  const notes = (await readFile(resolve(root, `docs/releases/${tag}.md`), 'utf8')).trim();
  if (!notes) throw new Error(`Empty release notes: ${tag}`);
  plan.push({ tag, commit, name: `AI Guild ${entry.version} (${entry.build})`,
    body: `${notes}\n\nSource: [${commit.slice(0, 7)}](https://github.com/${repository}/commit/${commit}).` });
}
if (!publish) {
  for (const release of plan) console.log(`${release.tag} → ${release.commit}: ${release.name}`);
  process.exit(0);
}

async function api(path, method = 'GET', body) {
  const response = await fetch(`https://api.github.com/repos/${repository}${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28', ...(body ? {'Content-Type': 'application/json'} : {}) },
    ...(body ? {body: JSON.stringify(body)} : {}),
    signal: AbortSignal.timeout(30000),
  });
  if (method === 'GET' && response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub ${method} ${path}: HTTP ${response.status}`);
  return response.json();
}
for (const release of plan) {
  const ref = await api(`/git/ref/tags/${release.tag}`);
  let tagCommit = ref?.object;
  while (tagCommit?.type === 'tag') tagCommit = (await api(`/git/tags/${tagCommit.sha}`)).object;
  if (tagCommit && (tagCommit.type !== 'commit' || tagCommit.sha !== release.commit)) {
    throw new Error(`${release.tag} already points elsewhere; refusing to move it.`);
  }
  const existing = await api(`/releases/tags/${release.tag}`);
  if (existing) {console.log(`Existing release preserved: ${existing.html_url}`);continue;}
  const created = await api('/releases', 'POST', {tag_name: release.tag,
    target_commitish: release.commit, name: release.name, body: release.body,
    draft: false, prerelease: false, make_latest: release === plan.at(-1) ? 'true' : 'false'});
  console.log(`Published: ${created.html_url}`);
}
