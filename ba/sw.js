/* Wizard Trees Field — service worker.
   Caches the app shell so it opens instantly + works offline for viewing.
   Network-first for the HTML (so deploys show up), cache-first for static assets.
   Supabase API/auth/storage calls are never cached (always go to network). */
// v3: v2 kept a full copy of the page for every update check (index.html?v=<time>);
// changing the name makes activate below delete that pile.
const CACHE = 'wt-field-v3';
const SHELL = ['./', './index.html', './manifest.webmanifest',
  './icons/icon-192.png', './icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) =>
    Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
// only a clean, same-origin 200 is safe to cache (fetch() resolves for 4xx/5xx/
// redirects too — caching those would strand users on a broken page after deploy)
const cacheable = (r) => r && r.ok && r.type === 'basic';

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;                 // never cache writes
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;  // let Supabase/CDN calls pass through
  // network-first for navigations/HTML (the app, and the schedule inside the pipeline's
  // frame, ?embed=schedule); fall back to the cached shell offline. Every query string
  // is the same page, so it is stored once, as ./index.html.
  if (req.mode === 'navigate' || req.destination === 'document') {
    e.respondWith(fetch(req).then((r) => {
      if (cacheable(r)) { const cp = r.clone(); caches.open(CACHE).then((c) => c.put('./index.html', cp)); }
      return r;
    }).catch(() => caches.match('./index.html')));
    return;
  }
  // Anything asked for with a query string or with cache:'no-store' (the update check's
  // ./index.html?v=<time>) goes straight to the network and is never stored: storing it
  // kept a new 450 KB copy of the page on every check, with nothing ever removing them.
  if (url.search || req.cache === 'no-store') return;
  // stale-while-revalidate for static assets: serve cache fast, refresh in the
  // background so a changed icon/manifest updates without a manual cache bump
  e.respondWith(caches.match(req).then((hit) => {
    const net = fetch(req).then((r) => {
      if (cacheable(r)) { const cp = r.clone(); caches.open(CACHE).then((c) => c.put(req, cp)); }
      return r;
    }).catch(() => hit);
    return hit || net;
  }));
});
