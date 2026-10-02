import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import vm from 'node:vm';

function worker() {
  const storage = new Map<string, Response>();
  let writable = true;
  const key = (request: Request | string) => typeof request === 'string' ? request : request.url;
  const cache = {
    match: async (request: Request | string) => storage.get(key(request))?.clone(),
    put: async (request: Request | string, response: Response) => {
      if (!writable) throw new Error('cache storage full');
      storage.set(key(request), response.clone());
    },
    delete: async (request: Request | string) => storage.delete(key(request)),
  };
  let network: (() => Response) | null = () => Response.json([{id:1}]);
  const deleted: string[] = [];
  const context: any = { Response, Headers, URL, Request,
    self: {addEventListener() {}},
    caches: {open: async () => cache, delete: async (name: string) => {deleted.push(name);storage.clear();return true;}},
    fetch: async () => { if (!network) throw new Error('offline'); return network(); },
  };
  vm.createContext(context);
  vm.runInContext(readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8') +
    '\nglobalThis.read = apiRead;globalThis.shellFiles = SHELL_FILES;', context);
  const request = new Request('https://tracker.test/api/tasks');
  return { storage, deleted, request, shellFiles: context.shellFiles as string[], read: () => context.read(request) as Promise<Response>,
    failWrites: () => { writable = false; },
    offline: () => {network = null;}, respond: (response: () => Response) => {network = response;} };
}

test('every mandatory offline shell asset is present in the release', () => {
  for (const asset of worker().shellFiles) {
    const path = new URL(asset, 'https://tracker.test').pathname;
    const source = new URL('../public' + (path === '/' ? '/index.html' : path), import.meta.url);
    assert(existsSync(source), `Missing offline shell asset: ${asset}`);
  }
});

test('offline cached JSON remains readable; missing and corrupt cache entries return an explicit offline response', async () => {
  const f = worker();
  assert.deepEqual(await (await f.read()).json(), [{id:1}]);
  f.offline();
  const cached = await f.read();
  assert.equal(cached.headers.get('X-From-Cache'), '1');
  assert.deepEqual(await cached.json(), [{id:1}]);
  for (const value of ['null', '<html>offline</html>']) {
    f.storage.set(f.request.url, new Response(value));
    const response = await f.read();
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('X-Offline'), '1');
    assert.match((await response.json()).error, /Нет сети/);
    assert.equal(f.storage.size, 0);
  }
  assert.equal((await f.read()).status, 503);
});

test('a cache write failure never hides a valid fresh server response', async () => {
  const f = worker();
  await f.read();
  f.failWrites();
  f.respond(() => Response.json([{id:2}]));
  const response = await f.read();
  assert.equal(response.headers.has('X-From-Cache'), false);
  assert.deepEqual(await response.json(), [{id:2}]);
  assert.deepEqual(await f.storage.get(f.request.url)!.clone().json(), [{id:1}]);
});

test('invalid successful responses cannot overwrite useful offline data; session expiry still clears private cache', async () => {
  const f = worker();
  await f.read();
  for (const body of ['null', '', '<html>gateway response</html>']) {
    f.respond(() => new Response(body));
    await f.read();
    assert.deepEqual(await f.storage.get(f.request.url)!.clone().json(), [{id:1}]);
  }
  f.respond(() => Response.json({error:'not signed in'}, {status:401}));
  assert.equal((await f.read()).status, 401);
  assert.equal(f.storage.size, 0);
  assert.equal(f.deleted.length, 4);
});
