// Офлайн-кэш приложения + приём файла через «Поделиться» (Web Share Target)
const CACHE = 'schedule-app-v2';
const ASSETS = [
  './', 'index.html', 'style.css', 'app.js', 'parser.js', 'schedule.json', 'manifest.webmanifest',
  'vendor/cfb.min.js', 'vendor/jszip.min.js',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-180.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== 'shared-file').map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  if (e.request.method === 'POST' && url.pathname.endsWith('/share')) {
    e.respondWith((async () => {
      const form = await e.request.formData();
      const file = form.get('file');
      if (file && typeof file !== 'string') {
        const cache = await caches.open('shared-file');
        await cache.put('shared-file', new Response(file, { headers: { 'X-File-Name': encodeURIComponent(file.name || '') } }));
      }
      return Response.redirect('./?shared=1', 303);
    })());
    return;
  }

  if (e.request.method !== 'GET' || url.origin !== location.origin) return;

  // Сначала сеть (чтобы подтягивать обновления), при офлайне — кэш
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match('index.html')))
  );
});
