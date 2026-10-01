// AI Tracker service worker: offline shell, cached reads, push notifications, share target.
// Bump VERSION when the caching rules change; shell files themselves refresh on every visit.
const VERSION = 'v7';
const SHELL = `shell-${VERSION}`;
const API = `api-${VERSION}`; // last successful GET responses, for reading offline
const FILES = `files-${VERSION}`; // image attachments
const SHARE = 'share'; // payload handed over by the OS share sheet

const SHELL_FILES = [
  '/',
  '/style.css',
  '/app.js',
  '/pwa.js',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/favicon-32.png',
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
      const keep = new Set([SHELL, API, FILES, SHARE]);
      for (const name of await caches.keys()) if (!keep.has(name)) await caches.delete(name);
      await self.clients.claim();
    })(),
  );
});

async function shell(request) {
  const cache = await caches.open(SHELL);
  const key = request.mode === 'navigate' ? '/' : request;
  const cached = await cache.match(key);
  const fresh = fetch(request)
    .then((res) => {
      if (res.ok) cache.put(key, res.clone());
      return res;
    })
    .catch(() => null);
  // Serve the cached copy at once and refresh it in the background.
  return cached ?? (await fresh) ?? new Response('Нет сети', { status: 503 });
}

async function apiRead(request) {
  const cache = await caches.open(API);
  try {
    const res = await fetch(request);
    if (res.ok) cache.put(request, res.clone());
    // The session ended: nothing cached may outlive it.
    if (res.status === 401) await dropPrivate();
    return res;
  } catch (err) {
    const cached = await cache.match(request);
    if (!cached) throw err;
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
  return Promise.all([caches.delete(API), caches.delete(FILES), caches.delete(SHARE)]);
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
      await self.registration.showNotification(data.title ?? 'AI Tracker', {
        body: data.body ?? '',
        tag: data.tag,
        renotify: Boolean(data.tag),
        icon: '/icons/icon-192.png',
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
  const target = new URL(event.notification.data?.url ?? '/', self.location.origin);
  const url = target.origin === self.location.origin ? target.href : self.location.origin + '/';
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const existing = windows[0];
      if (existing) {
        await existing.focus();
        existing.postMessage({ type: 'navigate', url });
      } else {
        await self.clients.openWindow(url);
      }
    })(),
  );
});
