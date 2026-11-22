// Lets the CRM be installed on a phone's home screen and open quickly.
// App files: always try the network first (so updates show up straight away),
// fall back to the saved copy when offline. Fonts and icons: saved copy first.
// Data itself always goes to the database; nothing here stores customer data.
const CACHE = 'mp-crm-shell-v1';
const SHELL = ['./', 'index.html', 'config.js', 'backend.js', 'manifest.webmanifest',
  'vendor/design-runtime.js', 'vendor/react.production.min.js', 'vendor/react-dom.production.min.js',
  'vendor/supabase.js', 'assets/logo.png', 'assets/icon-192.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {}).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  const stale = /\/(fonts|assets)\//.test(url.pathname);
  const put = res => { if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); } return res; };
  if (stale) e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request).then(put)));
  else e.respondWith(fetch(e.request).then(put).catch(() => caches.match(e.request, { ignoreSearch: true })));
});
