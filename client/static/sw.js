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
