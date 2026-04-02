// Lumina Service Worker v2 — with Push Notifications
const CACHE_NAME = 'lumina-v3';
const BASE_PATH  = '/lumina';

const PRECACHE = [
  `${BASE_PATH}/`,
  `${BASE_PATH}/index.html`,
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  const passthroughHosts = ['api.anthropic.com','api.jsonbin.io','api.open-meteo.com','api.bigdatacloud.net','allcazaucorvjwfejfoq.supabase.co','lumina-api.g-mennonna.workers.dev'];
  if (passthroughHosts.includes(url.hostname)) return;

  if (url.pathname === `${BASE_PATH}/` || url.pathname === `${BASE_PATH}/index.html`) {
    event.respondWith(
      fetch(event.request)
        .then(response => { caches.open(CACHE_NAME).then(cache => cache.put(event.request, response.clone())); return response; })
        .catch(() => caches.match(event.request))
    );
    return;
  }
  event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
});

// ── Push Notifications ──
self.addEventListener('push', event => {
  let data = { title: 'Lumina', body: 'Something new from your partner' };
  try { data = event.data?.json() || data; } catch(e) {}

  const options = {
    body: data.body,
    icon: `${BASE_PATH}/icon-192.png`,
    badge: `${BASE_PATH}/icon-192.png`,
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
