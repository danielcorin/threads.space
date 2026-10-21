// Keep in sync with client/src/lib/shareTarget.ts.
const SHARE_TARGET_PATH = '/share-target';
const SHARE_TARGET_CACHE = 'threads-share-target';

// This worker holds no caches of its own, so a new version can take over
// immediately; the share-target handler needs to be live as soon as it ships.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (
    event.request.method === 'POST' &&
    url.origin === self.location.origin &&
    url.pathname === SHARE_TARGET_PATH
  ) {
    event.respondWith(receiveShare(event.request));
  }
});

// Text rides along in the redirect URL; files can't, so they wait in Cache
// Storage until the page takes them.
async function receiveShare(request) {
  const params = new URLSearchParams({ 'share-target': '1' });
  await caches.delete(SHARE_TARGET_CACHE);
  try {
    const form = await request.formData();
    for (const key of ['title', 'text', 'url']) {
      const value = form.get(key);
      if (typeof value === 'string' && value) params.set(key, value);
    }
    const files = form.getAll('files').filter((f) => typeof f !== 'string' && f.size > 0);
    if (files.length > 0) {
      const cache = await caches.open(SHARE_TARGET_CACHE);
      await Promise.all(
        files.map((file, i) =>
          cache.put(
            `${SHARE_TARGET_PATH}/file/${i}`,
            new Response(file, {
              headers: {
                'Content-Type': file.type || 'application/octet-stream',
                'X-Filename': encodeURIComponent(file.name || `shared-file-${i + 1}`),
              },
            })
          )
        )
      );
    }
  } catch {
    // Still open the app; the share picker shows whatever made it through.
  }
  return Response.redirect(new URL(`/?${params}`, self.location.origin).href, 303);
}

function notificationUrl(data) {
  if (data?.url) return data.url;
  if (data?.type === 'message' && data.channelId) {
    const params = new URLSearchParams({ channel: data.channelId });
    if (data.messageId) params.set('msg', data.messageId);
    return `/?${params.toString()}`;
  }
  return '/';
}

self.addEventListener('push', (event) => {
  event.waitUntil(
    (async () => {
      const data = event.data?.json() ?? {};
      const title = data.title || 'Threads';
      const options = {
        body: data.body || '',
        tag: data.tag || 'default',
        data: { ...data, url: notificationUrl(data) },
        icon: '/icon-192.png',
        badge: '/icon-192.png',
      };
      await self.registration.showNotification(title, options);
    })()
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = notificationUrl(event.notification.data);
  event.waitUntil(
    clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((windowClients) => {
        for (const client of windowClients) {
          if (client.url.includes(self.location.origin) && 'focus' in client) {
            client.postMessage({ type: 'deep-link', url });
            return client.focus();
          }
        }
        // No existing window — open a new one with the deep link URL
        return clients.openWindow(url);
      })
  );
});
