// The public surface for embedding the core. Changing this list is a breaking change for whoever embeds it,
// which is why it has to be changed here on purpose.
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('the embedding surface is exactly what is promised', async () => {
  const embed = await import('../src/embed.ts');
  assert.deepEqual(Object.keys(embed).sort(), [
    'buildApp', 'createAccount', 'deleteAccount', 'linkOidcIdentity', 'listAccounts', 'migrate', 'oidcAccount', 'pool', 'rotateKey', 'runInScope', 'updateAccount', 'writeExport',
  ]);
  await embed.pool.end();
});

test('importing it does not start a server', async () => {
  const { buildApp } = await import('../src/embed.ts');
  assert.equal(typeof buildApp, 'function');
  assert.equal(process.getActiveResourcesInfo().filter((r) => r === 'TCPServerWrap').length, 0);
});
