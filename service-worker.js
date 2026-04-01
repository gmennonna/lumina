// Lumina Service Worker
// Strategy: Cache-first for assets, network-first for API calls

const CACHE_NAME = 'lumina-v1';
const BASE_PATH  = '/lumina';

// Files to pre-cache on install
const PRECACHE = [
  `${BASE_PATH}/`,
  `${BASE_PATH}/index.html`,
  'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js',
];

// ── Install: pre-cache core assets ──
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

// ── Activate: clean up old caches ──
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

// ── Fetch: smart routing ──
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Never intercept: API calls (Anthropic, JSONBin, Open-Meteo, BigDataCloud)
  const passthroughHosts = [
    'api.anthropic.com',
    'api.jsonbin.io',
    'api.open-meteo.com',
    'api.bigdatacloud.net',
  ];
  if (passthroughHosts.includes(url.hostname)) {
    return; // Let browser handle it normally
  }

  // For app shell (HTML) — network first, fall back to cache
  if (url.pathname === `${BASE_PATH}/` || url.pathname === `${BASE_PATH}/index.html`) {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          // Update cache with fresh version
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // For CDN assets (xlsx, etc.) — cache first
  if (url.hostname === 'cdnjs.cloudflare.com') {
    event.respondWith(
      caches.match(event.request).then(cached => {
        if (cached) return cached;
        return fetch(event.request).then(response => {
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, response.clone()));
          return response;
        });
      })
    );
    return;
  }

  // For icons and local assets — cache first
  if (url.pathname.startsWith(`${BASE_PATH}/icons/`)) {
    event.respondWith(
      caches.match(event.request).then(cached => cached || fetch(event.request))
    );
    return;
  }

  // Default: network with cache fallback
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});
