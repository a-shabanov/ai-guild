// AI Guild service worker: offline shell, cached reads, push notifications, share target.
// VERSION is written by scripts/version.mjs. Each release caches its complete shell.
const VERSION = 'v0.3.7-b15';
const SHELL = `shell-${VERSION}`;
const API = `api-${VERSION}`; // last successful GET responses, for reading offline
const FILES = `files-${VERSION}`; // image attachments
const SHARE = 'share'; // payload handed over by the OS share sheet
const PUSH_NAVIGATION = 'push-navigation';
const PUSH_TARGET = '/__pending-push-navigation';
const PUSH_TARGET_TTL = 2 * 60 * 1000;

const SHELL_FILES = [
  '/',
  '/style.css',
  '/app.js',
  '/version.js',
  '/navigation.js',
  '/pull-to-refresh.js',
  '/pwa.js',
  '/client-device.js',
  '/i18n.js',
  '/i18n.en.js',
  '/manifest.webmanifest',
  "/icons/icon-512.png?v=314eb46d64bd",
  "/icons/maskable-512.png?v=314eb46d64bd",
  "/icons/apple-touch-icon.png?v=abe7666523c4",
  '/icons/icon-192.png?v=0a9b53376488',
  '/icons/favicon-32.png?v=c76fb7f1fa02',
];
const FILES_LIMIT = 120;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((cache) => cache.addAll(SHELL_FILES))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([SHELL, API, FILES, SHARE, PUSH_NAVIGATION]);
      for (const name of await caches.keys()) if (!keep.has(name)) await caches.delete(name);
      await self.clients.claim();
    })(),
  );
});

async function shell(request) {
  const cache = await caches.open(SHELL);
  const key = request.mode === 'navigate' ? '/' : request;
  const cached = await cache.match(key);
  // Keep app.js and version.js from the same release, even while a new worker installs.
  if (cached && new URL(request.url).pathname !== '/manifest.webmanifest') return cached;
  const fresh = fetch(request)
    .then((res) => {
      if (res.ok) cache.put(key, res.clone());
      return res;
    })
    .catch(() => null);
  // Installed apps compare the manifest's icon URLs to detect identity updates.
  if (new URL(request.url).pathname === '/manifest.webmanifest') {
    return (await fresh) ?? cached ?? new Response('Нет сети', { status: 503 });
  }
  // Serve the cached copy at once and refresh it in the background.
  return cached ?? (await fresh) ?? new Response('Нет сети', { status: 503 });
}

async function validApiRead(response) {
  if (!response.ok) return false;
  try {
    const data = await response.clone().json();
    return data !== null && typeof data === 'object';
  } catch { return false; }
}

async function apiRead(request) {
  const cache = await caches.open(API);
  try {
    const res = await fetch(request);
    if (await validApiRead(res)) await cache.put(request, res.clone()).catch(() => {});
    // The session ended: nothing cached may outlive it.
    if (res.status === 401) await dropPrivate();
    return res;
  } catch (err) {
    const cached = await cache.match(request);
    if (!cached || !(await validApiRead(cached))) {
      if (cached) await cache.delete(request);
      return Response.json({ error: 'Нет сети. Данные этого экрана ещё не сохранены на устройстве.' },
        { status: 503, headers: { 'X-Offline': '1' } });
    }
    const headers = new Headers(cached.headers);
    headers.set('X-From-Cache', '1');
    return new Response(cached.body, { status: cached.status, headers });
  }
}

async function attachment(request) {
  const cache = await caches.open(FILES);
  const cached = await cache.match(request);
  if (cached) return cached;
  const res = await fetch(request);
  if (res.ok && res.status === 200 && res.headers.get('content-type')?.startsWith('image/')) {
    await cache.put(request, res.clone());
    const keys = await cache.keys();
    for (const old of keys.slice(0, Math.max(0, keys.length - FILES_LIMIT))) await cache.delete(old);
  }
  return res;
}

async function receiveShare(request) {
  const form = await request.formData();
  const cache = await caches.open(SHARE);
  for (const key of await cache.keys()) await cache.delete(key);
  const files = form.getAll('files').filter((f) => f instanceof File && f.size > 0);
  await cache.put(
    '/__share/meta',
    Response.json({
      title: form.get('title') ?? '',
      text: [form.get('text'), form.get('url')].filter(Boolean).join('\n'),
      files: files.map((f) => f.name),
    }),
  );
  for (const [i, file] of files.entries()) {
    await cache.put(
      `/__share/file/${i}`,
      new Response(file, {
        headers: {
          'Content-Type': file.type || 'application/octet-stream',
          'X-Filename': encodeURIComponent(file.name),
        },
      }),
    );
  }
  return Response.redirect('/#/share', 303);
}

function dropPrivate() {
  return Promise.all([caches.delete(API), caches.delete(FILES), caches.delete(SHARE), caches.delete(PUSH_NAVIGATION)]);
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.method === 'POST' && url.pathname === '/share') {
    event.respondWith(receiveShare(request));
    return;
  }
  if (request.method !== 'GET') return;
  if (url.pathname === '/mcp' || url.pathname === '/healthz') return;
  if (url.pathname.startsWith('/api/auth/')) return;
  if (url.pathname === '/api/push/preferences') return; // Never offer stale notification switches offline.
  if (url.pathname === '/api/devices' || url.pathname.startsWith('/api/devices/')) return;

  if (/^\/api\/attachments\/\d+\/content$/.test(url.pathname)) {
    // Video seeks with Range requests; those go straight to the network.
    if (!request.headers.has('range')) event.respondWith(attachment(request));
    return;
  }
  if (/^\/api\/projects\/\d+\/logo$/.test(url.pathname)) {
    event.respondWith(attachment(request));
    return;
  }
  if (url.pathname.startsWith('/api/')) {
    if (url.pathname !== '/api/openapi.json') event.respondWith(apiRead(request));
    return;
  }
  event.respondWith(shell(request));
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'logout') event.waitUntil(dropPrivate());
  if (event.data?.type === 'navigation-ready' || event.data?.type === 'navigation-ack') {
    event.waitUntil((async () => {
      const cache = await caches.open(PUSH_NAVIGATION);
      const response = await cache.match(PUSH_TARGET);
      if (!response) return;
      const target = await response.json();
      if (Date.now() - target.at > PUSH_TARGET_TTL) return void await cache.delete(PUSH_TARGET);
      if (!event.source || (target.clientId && target.clientId !== event.source.id)) return;
      if (event.data.type === 'navigation-ready') event.source.postMessage({ type: 'navigate', url: target.url });
      else if (event.data.url === target.url) await cache.delete(PUSH_TARGET);
    })());
  }
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data?.json() ?? {};
  } catch {
    data = { body: event.data?.text() };
  }
  event.waitUntil(
    (async () => {
      await self.registration.showNotification(data.title ?? 'AI Guild', {
        body: data.body ?? '',
        tag: data.tag,
        renotify: Boolean(data.tag),
        icon: '/icons/icon-192.png?v=0a9b53376488',
        badge: '/icons/badge-96.png',
        data: { url: data.url ?? '/#/inbox' },
      });
      const open = await self.registration.getNotifications();
      await self.navigator.setAppBadge?.(open.length).catch(() => {});
    })(),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  // Only same-origin paths: the payload must not be able to send the user elsewhere.
  let target;
  try { target = new URL(event.notification.data?.url ?? '/#/inbox', self.location.origin); }
  catch { target = new URL('/#/inbox', self.location.origin); }
  const url = target.origin === self.location.origin ? target.href : self.location.origin + '/#/inbox';
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const existing = windows.find((client) => client.visibilityState === 'visible') ?? windows[0];
      const cache = await caches.open(PUSH_NAVIGATION);
      // iOS can launch at start_url or reject focus on an inert WindowClient.
      // Keep the intent until the app's listener is ready and acknowledges it.
      await cache.put(PUSH_TARGET, new Response(JSON.stringify({ url, at: Date.now(), clientId: existing?.id ?? null })));
      if (existing) {
        existing.postMessage({ type: 'navigate', url });
        try { await existing.focus(); }
        catch {
          await cache.put(PUSH_TARGET, new Response(JSON.stringify({ url, at: Date.now(), clientId: null })));
          const opened = await self.clients.openWindow(url);
          opened?.postMessage({ type: 'navigate', url });
        }
      } else {
        const opened = await self.clients.openWindow(url);
        opened?.postMessage({ type: 'navigate', url });
      }
    })(),
  );
});
