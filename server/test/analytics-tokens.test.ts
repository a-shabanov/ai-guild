import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const fn = source.slice(source.indexOf('function analyticsTokens('), source.indexOf('function analyticsCost('));
const context = vm.createContext({ fmtCompact: (n: number) => String(n) });
vm.runInContext(fn, context);
const format = (r: any, field?: string) => context.analyticsTokens(r, field);
test('token labels preserve known zero and distinguish missing and partial usage', () => {
  assert.equal(format({entries: 1, input_tokens: 0, output_tokens: 0, unknown_tokens_entries: 0}), '0');
  assert.equal(format({entries: 1, input_tokens: 0, output_tokens: 0, unknown_tokens_entries: 1}), '—');
  assert.equal(format({entries: 2, input_tokens: 100, output_tokens: 20, unknown_tokens_entries: 1}), '120 + ?');
  assert.equal(format({entries: 2, cache_read_tokens: 50, unknown_cache_read_tokens_entries: 1}, 'cache_read_tokens'), '50 + ?');
  assert.equal(format({entries: 1, output_tokens: 0, unknown_output_tokens_entries: 1}, 'output_tokens'), '—');
  assert.equal(format({entries: 0, input_tokens: 0, output_tokens: 0, unknown_tokens_entries: 0}), '0');
});
