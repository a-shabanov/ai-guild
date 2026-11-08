import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../../', import.meta.url));

test('Cursor wake preserves the prompt, selects its own identity and keeps sandbox enabled', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cursor-wake-test-'));
  try {
    const fake = join(dir, 'agent');
    const output = join(dir, 'args.json');
    const key = join(dir, 'cursor.key');
    writeFileSync(key, 'dedicated-test-key\n');
    writeFileSync(fake, '#!/usr/bin/env node\nrequire("fs").writeFileSync(process.env.TEST_OUTPUT, JSON.stringify({args:process.argv.slice(2), key:process.env.AI_TRACKER_KEY, account:process.env.AI_TRACKER_ACCOUNT}));\n');
    chmodSync(fake, 0o755);
    const prompt = `Read #514; $(touch ${dir}/unexpected) "quotes"\nsecond line`;
    const result = spawnSync('sh', [join(root, 'server/scripts/cursor-wake.sh'), prompt, '--model', 'auto'], {
      cwd: dir,
      env: { ...process.env, AI_TRACKER_KEY: 'wrong-parent-identity', AI_TRACKER_CURSOR_BIN: fake, AI_TRACKER_CURSOR_KEY_FILE: key, TEST_OUTPUT: output },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const actual = JSON.parse(readFileSync(output, 'utf8'));
    assert.equal(actual.key, 'dedicated-test-key');
    assert.equal(actual.account, 'cursor');
    assert.deepEqual(actual.args.slice(0, -1), ['--print', '--output-format', 'stream-json', '--sandbox', 'enabled', '--force', '--model', 'auto']);
    assert.ok(actual.args.at(-1).endsWith(prompt));
    assert.ok(actual.args.at(-1).includes('cursor-auto'));
    assert.ok(actual.args.at(-1).includes('не запускай session-usage.ts --find codex или claude'));
    assert.equal(result.stdout.includes('dedicated-test-key'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
