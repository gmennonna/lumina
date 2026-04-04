// Lumina Service Worker — Push Notifications only, no caching during development
const VERSION = 'lumina-dev-3';

self.addEventListener('install', event => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// ── Push Notifications ──
self.addEventListener('push', event => {
  let data = { title: 'Lumina', body: 'Something new from your partner' };
  try { data = event.data?.json() || data; } catch(e) {}

  const options = {
    body: data.body,
    icon: '/lumina/icon-192.png',
    badge: '/lumina/icon-192.png',
    vibrate: [200, 100, 200],
    data: { url: data.data?.url || 'https://gmennonna.github.io/lumina/' },
    actions: [{ action: 'open', title: 'Open Lumina' }]
  };

  event.waitUntil(
    self.registration.showNotification(data.title || 'Lumina', options)
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification.data?.url || 'https://gmennonna.github.io/lumina/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
      for (const client of windowClients) {
        if (client.url.includes('gmennonna.github.io/lumina') && 'focus' in client) {
          return client.focus();
        }
      }
      return clients.openWindow(url);
    })
  );
});
