/**
 * ENSO Monitor — Service Worker
 * -----------------------------
 * Caches the app shell so the PWA opens with no connection. The live NOAA data
 * still needs internet (it comes via the Cloudflare Worker), but the app itself
 * — UI, help guide, map, QR — works fully offline, and the page falls back to
 * the last-fetched data saved in localStorage.
 *
 * UPDATE MODEL — read this before editing:
 *
 * This worker deliberately does NOT call skipWaiting() during install. A new
 * worker installs, then WAITS. The page notices it waiting, shows an update
 * bar, and only when the user taps it does the page post SKIP_WAITING. That
 * ordering matters: activating immediately would swap the cache underneath a
 * page whose HTML and JS are still the old build, so the running app would be
 * half old and half new until the user happened to reload.
 *
 * Navigations are network-first. Cache-first on index.html meant the shell
 * could stay stale for as long as CACHE_VERSION was unchanged — including
 * across a deploy where the bump was forgotten. Now a reload with a connection
 * always gets the real file, and the cache is purely the offline fallback.
 *
 * Bump CACHE_VERSION on every deploy. It is reported to the page (VERSION
 * message) and shown in the footer, so a stale install is visible rather than
 * something you have to guess at.
 */
const CACHE_VERSION = "enso-v1.19.0";
const SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
];

// Install: pre-cache the shell, then WAIT. No skipWaiting() here on purpose.
self.addEventListener('install', function(event){
  event.waitUntil(
    caches.open(CACHE_VERSION).then(function(cache){
      // reload: bypass the HTTP cache, or a fresh install can re-cache the
      // very stale copies we are trying to replace.
      return cache.addAll(SHELL.map(function(u){
        return new Request(u, { cache: 'reload' });
      }));
    })
  );
});

// Activate: drop old caches and take over open pages.
self.addEventListener('activate', function(event){
  event.waitUntil(
    caches.keys().then(function(keys){
      return Promise.all(keys.map(function(k){
        if (k !== CACHE_VERSION) return caches.delete(k);
      }));
    }).then(function(){
      // Navigation preload, where supported, so network-first navigations do
      // not pay for worker startup.
      if (self.registration.navigationPreload) {
        return self.registration.navigationPreload.enable().catch(function(){});
      }
    }).then(function(){ return self.clients.claim(); })
  );
});

// The page drives activation, and can ask which version is running.
self.addEventListener('message', function(event){
  var d = event.data || {};
  if (d.type === 'SKIP_WAITING') self.skipWaiting();
  if (d.type === 'VERSION' && event.ports && event.ports[0]) {
    event.ports[0].postMessage({ version: CACHE_VERSION });
  }
});

// Fetch strategy:
//  - NOAA data (the Cloudflare Worker): network-only, never cached here.
//    Freshness matters and the page handles offline fallback itself.
//  - Navigations: network-first, cache as fallback. This is what makes a new
//    deploy visible on the next reload even if CACHE_VERSION was not bumped.
//  - Other shell assets: cache-first, revalidating in the background.
self.addEventListener('fetch', function(event){
  var req = event.request, url = req.url;
  if (req.method !== 'GET') return;

  if (url.indexOf('workers.dev') !== -1 || url.indexOf('feed=') !== -1
      || url.indexOf('open-meteo.com') !== -1) {
    return; // default browser handling; the page catches failures
  }

  if (req.mode === 'navigate') {
    event.respondWith(
      (event.preloadResponse || Promise.resolve(null)).then(function(pre){
        return pre || fetch(req);
      }).then(function(resp){
        var copy = resp.clone();
        caches.open(CACHE_VERSION).then(function(c){ c.put('./index.html', copy); });
        return resp;
      }).catch(function(){
        return caches.match('./index.html').then(function(hit){
          return hit || caches.match('./');
        });
      })
    );
    return;
  }

  event.respondWith(
    caches.match(req).then(function(cached){
      var net = fetch(req).then(function(resp){
        if (resp && resp.status === 200) {
          var copy = resp.clone();
          caches.open(CACHE_VERSION).then(function(c){ c.put(req, copy); });
        }
        return resp;
      }).catch(function(){ return cached; });
      // Serve the cached copy at once, but keep refreshing it behind the scenes
      // so an icon or manifest change lands without waiting for a version bump.
      return cached || net;
    })
  );
});
