import assert from 'node:assert/strict';
import test from 'node:test';
import { summarize, type Message } from '../scripts/lib/sessions.ts';

const at = Date.parse('2026-09-29T00:00:00Z');

test('GPT-6 cost uses distinct input, cached input, cache write and output rates', () => {
  const messages: Message[] = [{
    at: at + 1000,
    model: 'gpt-6-sol',
    input: 1_000_000,
    cacheRead: 1_000_000,
    write5m: 1_000_000,
    write1h: 0,
    output: 1_000_000,
  }];
  const result = summarize(messages, at, at + 2000);
  assert.ok('cost_usd' in result);
  assert.equal(result.cost_usd, 14.7);
});

test('unknown GPT cache write price does not produce an incomplete cost', () => {
  const messages: Message[] = [{
    at: at + 1000,
    model: 'gpt-5.4',
    input: 100,
    cacheRead: 0,
    write5m: 100,
    write1h: 0,
    output: 100,
  }];
  const result = summarize(messages, at, at + 2000);
  assert.ok('unpriced_models' in result);
  assert.deepEqual(result.unpriced_models, ['gpt-5.4 cache writes']);
  assert.equal('cost_usd' in result, false);
});
