/**
 * ENSO Monitor — Service Worker
 * -----------------------------
 * Caches the app shell so the PWA opens with no connection. The live NOAA
 * data still needs internet (it comes via the Cloudflare Worker), but the
 * app itself — UI, help guide, map, QR — works fully offline, and the page
 * falls back to the last-fetched data saved in localStorage.
 *
 * Bump CACHE_VERSION whenever index.html or this file changes, so users get
 * the new version instead of a stale cached one.
 */
const CACHE_VERSION = 'enso-v1.7.0';
const SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
];

// Install: pre-cache the app shell.
self.addEventListener('install', function(event){
  event.waitUntil(
    caches.open(CACHE_VERSION).then(function(cache){
      return cache.addAll(SHELL);
    }).then(function(){ return self.skipWaiting(); })
  );
});

// Activate: drop old caches.
self.addEventListener('activate', function(event){
  event.waitUntil(
    caches.keys().then(function(keys){
      return Promise.all(keys.map(function(k){
        if (k !== CACHE_VERSION) return caches.delete(k);
      }));
    }).then(function(){ return self.clients.claim(); })
  );
});

// Fetch strategy:
//  - NOAA data requests (the Cloudflare Worker): network-only. Never cache
//    these at the SW level — freshness matters, and the page handles offline
//    fallback itself via localStorage. If offline, let it fail so the page's
//    catch runs.
//  - Everything else (the app shell): cache-first, so the app opens offline.
self.addEventListener('fetch', function(event){
  var url = event.request.url;
  // Let data/API calls go straight to the network (don't serve stale from SW).
  if (url.indexOf('workers.dev') !== -1 || url.indexOf('feed=') !== -1) {
    return; // default browser handling; page catches failures
  }
  // App shell: cache-first, fall back to network, update cache on success.
  event.respondWith(
    caches.match(event.request).then(function(cached){
      if (cached) return cached;
      return fetch(event.request).then(function(resp){
        // Only cache successful same-origin GETs.
        if (resp && resp.status === 200 && event.request.method === 'GET') {
          var copy = resp.clone();
          caches.open(CACHE_VERSION).then(function(c){ c.put(event.request, copy); });
        }
        return resp;
      }).catch(function(){
        // Offline and not cached: for navigations, fall back to index.html.
        if (event.request.mode === 'navigate') return caches.match('./index.html');
      });
    })
  );
});
