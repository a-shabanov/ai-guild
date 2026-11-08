import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../../', import.meta.url));

for (const trackerProject of [true, false]) {
  test(`Codex watcher grants isolated browser tools ${trackerProject ? 'in tracker' : 'in another project'}`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-wake-test-'));
    try {
      const fake = join(dir, 'codex');
      writeFileSync(fake, '#!/bin/sh\nprintf "%s\\n" "$@"\n');
      chmodSync(fake, 0o755);
      const prompt = 'Проверь #499; $(do-not-run) "quotes"\nsecond line';
      const result = spawnSync('sh', [join(root, 'server/scripts/codex-wake.sh'), prompt], {
        cwd: trackerProject ? root : dir,
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
        encoding: 'utf8',
      });
      assert.equal(result.status, 0, result.stderr);
      assert.ok(result.stdout.endsWith(`${prompt}\n`));
      const args = result.stdout.slice(0, -(prompt.length + 1)).trim().split('\n');
      assert.deepEqual(args.slice(0, 4), ['exec', '--skip-git-repo-check', '--sandbox', 'workspace-write']);
      assert.equal(args.includes('sandbox_workspace_write.network_access=true'), trackerProject);
      const mcp = args.find(arg => arg.startsWith('mcp_servers.playwright='));
      assert.ok(mcp);
      assert.ok(mcp.includes('default_tools_approval_mode="approve"'));
      assert.ok(mcp.includes('"--headless","--isolated"'));
      assert.ok(mcp.includes('"@playwright/mcp@0.0.76"'));
      assert.equal(args.includes('--dangerously-bypass-approvals-and-sandbox'), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
