import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNavigation, type NavigationContext, type NavigationEntry } from '../public/navigation.js';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

function fixture(limit = 8) {
  type View = { key: string; draft?: string };
  const requests: Array<{ key: string; context: NavigationContext; result: ReturnType<typeof deferred<View>> }> = [];
  let displayed: View | null = null;
  let entry: NavigationEntry<View> | null = null;
  let scroll = 0;
  const pending: string[] = [];
  const navigation = createNavigation<View>({
    load: async (key, context) => {
      const result = deferred<View>();
      requests.push({ key, context, result });
      return result.promise;
    },
    show: view => { displayed = view; scroll = 0; },
    loading: key => { pending.push(key); displayed = null; },
    error: key => ({ key: `error:${key}` }),
    changed: next => { entry = next; },
    getScroll: () => scroll,
    setScroll: top => { scroll = top; },
    cacheable: key => key !== 'profile',
    limit,
  });
  return { navigation, requests, pending,
    get displayed() { return displayed; },
    get entry() { return entry; },
    get scroll() { return scroll; },
    set scroll(value) { scroll = value; },
  };
}

test('cold navigation changes the active tab and shows its loading state synchronously', async () => {
  const f = fixture();
  const work = f.navigation.navigate('tasks');
  assert.equal(f.entry?.key, 'tasks');
  assert.deepEqual(f.pending, ['tasks']);
  assert.equal(f.requests.length, 0);
  await tick();
  f.requests[0].result.resolve({ key: 'tasks' });
  await work;
  assert.equal(f.displayed?.key, 'tasks');
});

test('a visited tab, its draft and scroll return before the background response', async () => {
  const f = fixture();
  const first = f.navigation.navigate('tasks');
  await tick();
  const view = { key: 'tasks', draft: 'keep my input' };
  f.requests[0].result.resolve(view);
  await first;
  f.scroll = 640;
  const next = f.navigation.navigate('inbox');
  await tick();
  f.requests[1].result.resolve({ key: 'inbox' });
  await next;
  f.scroll = 100;
  const returning = f.navigation.navigate('tasks');
  assert.equal(f.displayed, view);
  assert.equal(f.displayed?.draft, 'keep my input');
  assert.equal(f.scroll, 640);
  assert.deepEqual(f.pending, ['tasks', 'inbox']);
  await tick();
  // The user can scroll during the refresh. Replacing the DOM must preserve that position.
  f.scroll = 720;
  f.requests[2].result.resolve({ key: 'tasks' });
  await returning;
  assert.equal(f.scroll, 720);
});

test('slow old screens cannot steal the newer screen, title or poll', async () => {
  const f = fixture();
  const old = f.navigation.navigate('tasks');
  await tick();
  const latest = f.navigation.navigate('inbox');
  await tick();
  let oldPolls = 0;
  let newPolls = 0;
  f.requests[1].context.setPoll(async () => { newPolls++; });
  f.requests[1].context.setTitle('Inbox');
  f.requests[1].result.resolve({ key: 'inbox' });
  await latest;
  f.requests[0].context.setPoll(async () => { oldPolls++; });
  f.requests[0].context.setTitle('Tasks');
  f.requests[0].result.resolve({ key: 'tasks' });
  await old;
  assert.equal(f.displayed?.key, 'inbox');
  assert.equal(f.entry?.title, 'Inbox');
  assert.equal(f.requests[0].context.isActive(), false);
  await f.navigation.refresh();
  assert.equal(oldPolls, 0);
  assert.equal(newPolls, 1);
});

test('returning to an unfinished screen reuses the request', async () => {
  const f = fixture();
  const tasks = f.navigation.navigate('tasks');
  await tick();
  const inbox = f.navigation.navigate('inbox');
  await tick();
  const returning = f.navigation.navigate('tasks');
  await tick();
  assert.equal(f.requests.length, 2);
  f.requests[0].result.resolve({ key: 'tasks' });
  f.requests[1].result.resolve({ key: 'inbox' });
  await Promise.all([tasks, inbox, returning]);
  assert.equal(f.displayed?.key, 'tasks');
});

test('polling is deduplicated while a request is pending', async () => {
  const f = fixture();
  const loading = f.navigation.navigate('tasks');
  await tick();
  let polls = 0;
  const pending = deferred<void>();
  f.requests[0].context.setPoll(async () => { polls++; await pending.promise; });
  f.requests[0].result.resolve({ key: 'tasks' });
  await loading;
  const one = f.navigation.refresh();
  const two = f.navigation.refresh();
  await tick();
  assert.equal(polls, 1);
  assert.equal(one, two);
  pending.resolve();
  await Promise.all([one, two]);
});

test('logout clears cached views and invalidates in-flight responses across login', async () => {
  const f = fixture();
  const old = f.navigation.navigate('tasks');
  await tick();
  f.navigation.clear();
  const newLogin = f.navigation.navigate('tasks');
  await tick();
  f.requests[1].result.resolve({ key: 'new account' });
  await newLogin;
  f.requests[0].context.setTitle('Private old account');
  f.requests[0].result.resolve({ key: 'old account' });
  await old;
  assert.equal(f.displayed?.key, 'new account');
  assert.equal(f.entry?.title, 'AI Guild');
});

test('an explicit refresh keeps current content and scroll while fetching new data', async () => {
  const f = fixture();
  const first = f.navigation.navigate('tasks');
  await tick();
  f.requests[0].result.resolve({ key: 'tasks' });
  await first;
  f.scroll = 500;
  const update = f.navigation.navigate('tasks', { reload: true });
  assert.equal(f.displayed?.key, 'tasks');
  assert.equal(f.scroll, 500);
  await tick();
  f.requests[1].result.resolve({ key: 'updated' });
  await update;
  assert.equal(f.displayed?.key, 'updated');
  assert.equal(f.scroll, 500);
});

test('errors on a cold visit are retried; failed background refreshes retain readable content', async () => {
  const f = fixture();
  const first = f.navigation.navigate('tasks');
  await tick();
  f.requests[0].result.reject(new Error('offline'));
  await first;
  assert.equal(f.displayed?.key, 'error:tasks');
  const retry = f.navigation.navigate('tasks');
  await tick();
  f.requests[1].result.resolve({ key: 'tasks' });
  await retry;
  const update = f.navigation.navigate('tasks');
  await tick();
  f.requests[2].result.reject(new Error('offline'));
  await update;
  assert.equal(f.displayed?.key, 'tasks');
});

test('an old failed request cannot remove a newer cached version of the same tab', async () => {
  const f = fixture();
  const old = f.navigation.navigate('tasks');
  await tick();
  const replacement = f.navigation.navigate('tasks', { reload: true });
  await tick();
  f.requests[1].result.resolve({ key: 'new tasks' });
  await replacement;
  f.requests[0].result.reject(new Error('old failure'));
  await old;
  const inbox = f.navigation.navigate('inbox');
  await tick();
  f.requests[2].result.resolve({ key: 'inbox' });
  await inbox;
  const back = f.navigation.navigate('tasks');
  assert.equal(f.displayed?.key, 'new tasks');
  await tick();
  f.requests[3].result.resolve({ key: 'refreshed tasks' });
  await back;
});

test('the cache is bounded and sensitive profile screens are excluded', async () => {
  const f = fixture(2);
  for (const key of ['tasks', 'inbox', 'projects', 'profile']) {
    const pending = f.navigation.navigate(key);
    await tick();
    f.requests.at(-1)!.result.resolve({ key });
    await pending;
  }
  const oldest = f.navigation.navigate('tasks');
  assert.equal(f.displayed, null);
  await tick();
  f.requests.at(-1)!.result.resolve({ key: 'tasks' });
  await oldest;
  const profile = f.navigation.navigate('profile');
  assert.equal(f.displayed, null);
  await tick();
  f.requests.at(-1)!.result.resolve({ key: 'profile' });
  await profile;
});

test('manual refresh updates screens without polling and preserves a polled draft', async () => {
  const f = fixture();
  const first = f.navigation.navigate('inbox');
  await tick();
  f.requests[0].result.resolve({ key: 'inbox' });
  await first;
  const reload = f.navigation.refresh({ rebuild: true });
  await tick();
  assert.equal(f.displayed?.key, 'inbox');
  f.requests[1].result.resolve({ key: 'new inbox' });
  await reload;
  assert.equal(f.displayed?.key, 'new inbox');

  const task = f.navigation.navigate('task');
  await tick();
  const view = { key: 'task', draft: 'unsent comment' };
  let polls = 0;
  f.requests[2].context.setPoll(async () => { polls++; });
  f.requests[2].result.resolve(view);
  await task;
  await f.navigation.refresh({ rebuild: true });
  assert.equal(polls, 1);
  assert.equal(f.displayed, view);
  assert.equal(f.displayed?.draft, 'unsent comment');
  assert.equal(f.requests.length, 3);
});
