const CACHE_NAME = 'caddesk-cst-v2-networkfirst';
const SHELL_FILES = [
  './index.html',
  './manifest.json'
];

// Install: pre-cache the app shell (used only as an offline fallback now, not the primary source)
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

// Activate: clean up ALL old caches from previous versions of this service worker
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch: NETWORK-FIRST for everything. Always try to get the latest version from the
// server first. Only fall back to a cached copy if the network request fails entirely
// (e.g. genuinely offline). This guarantees the installed PWA always shows whatever
// is currently live on GitHub Pages, never a stale cached version.
self.addEventListener('fetch', (event) => {
  const url = event.request.url;

  // Never intercept Firebase/Firestore or other live API calls — always go straight to network
  if (url.includes('firestore.googleapis.com') || url.includes('firebaseapp.com') || url.includes('googleapis.com')) {
    return;
  }

  event.respondWith(
    fetch(event.request, { cache: 'no-store' })
      .then((response) => {
        // Cache the fresh response for offline fallback use only
        if (event.request.method === 'GET' && response.ok && url.startsWith(self.location.origin)) {
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, responseClone));
        }
        return response;
      })
      .catch(() => caches.match(event.request)) // offline fallback only
  );
});
