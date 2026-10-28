// Service worker: receives the push and shows the "order ready" notification,
// even when the page is closed and the phone is locked.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : '' };
  }
  const title = data.title || 'Your order is ready';
  event.waitUntil(
    (async () => {
      await self.registration.showNotification(title, {
        body: data.body || 'Pick it up at the counter.',
        tag: data.tag || 'order-ready',
        renotify: true, // sound and vibrate again even if a notification with this tag is showing
        requireInteraction: true, // stays on screen until tapped or dismissed
        vibrate: [400, 150, 400, 150, 400],
        icon: '/icons/icon-192.png',
        badge: '/icons/badge-96.png',
        data: { url: data.url || '/' },
      });
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      windows.forEach((client) => client.postMessage({ type: 'order-ready', url: data.url }));
    })(),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || '/', self.location.origin);
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const existing = windows.find((c) => new URL(c.url).pathname === target.pathname);
      if (existing) {
        await existing.focus();
        return;
      }
      await self.clients.openWindow(target.href);
    })(),
  );
});
