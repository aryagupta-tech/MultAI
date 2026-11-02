// Caches only the app's own files so it opens without a network. API calls always go to the network:
// session content, credentials and control requests are never cached.
const CACHE = 'multai-companion-v1';
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(['/app/', '/app/manifest.webmanifest', '/app/icon-192.png'])).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || !url.pathname.startsWith('/app/')) return;
  if (url.pathname.startsWith('/app/assets/')) {
    // Hashed file names never change: cache first.
    event.respondWith(caches.match(event.request).then(hit => hit || fetch(event.request).then(response => {
      if (response.ok) {const copy = response.clone(); caches.open(CACHE).then(cache => cache.put(event.request, copy));}
      return response;
    })));
    return;
  }
  // The page itself: network first, so an update shows up on the next open; the cache only when offline.
  event.respondWith(fetch(event.request).then(response => {
    if (response.ok && event.request.mode === 'navigate') {const copy = response.clone(); caches.open(CACHE).then(cache => cache.put('/app/', copy));}
    return response;
  }).catch(() => caches.match(event.request.mode === 'navigate' ? '/app/' : event.request).then(hit => hit || Response.error())));
});
