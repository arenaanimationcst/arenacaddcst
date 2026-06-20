const CACHE_NAME = 'caddesk-cst-v1';
const SHELL_FILES = [
  './index.html',
  './manifest.json'
];
 
// Install: pre-cache the app shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});
 
// Activate: clean up old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});
 
// Fetch: network-first for Firebase/API calls, cache-first for the app shell.
// This keeps attendance data always live while letting the app shell open instantly offline.
self.addEventListener('fetch', (event) => {
  const url = event.request.url;
 
  // Never intercept Firebase/Firestore or other live API calls — always go to network
  if (url.includes('firestore.googleapis.com') || url.includes('firebaseapp.com') || url.includes('googleapis.com')) {
    return;
  }
 
  event.respondWith(
    caches.match(event.request).then((cached) => {
      return cached || fetch(event.request).then((response) => {
        // Cache successful same-origin GET responses for next time
        if (event.request.method === 'GET' && response.ok && url.startsWith(self.location.origin)) {
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, responseClone));
        }
        return response;
      }).catch(() => cached);
    })
  );
});
 
