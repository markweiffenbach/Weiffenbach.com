// Offline-Zwischenspeicher für unterwegs (z. B. an Bord ohne Internet).
// Seite, Daten, Skripte und Stile: erst Netz (mit kurzer Wartezeit), sonst die gespeicherte Fassung –
// so passen sie nach einem Update immer zusammen. Fotos, Landkarte, Bibliotheken und das Hintergrundfoto:
// sofort aus dem Speicher, im Hintergrund aktualisieren.
// Alles Gespeicherte ist dieselbe öffentliche bzw. verschlüsselte Fassung, die auch der Server ausliefert.
const CACHE = 'wb-offline-v1';
const SHELL = [
  './', 'index.html', 'data/data.enc.json',
  'assets/css/site.css', 'assets/vendor/leaflet/leaflet.css', 'assets/vendor/leaflet/leaflet.js', 'assets/vendor/topojson-client.min.js',
  'assets/geo/countries-50m.json',
  'assets/js/app.js', 'assets/js/archive.js', 'assets/js/charts.js', 'assets/js/crypto.js', 'assets/js/diary.js',
  'assets/js/map.js', 'assets/js/seas.js', 'assets/js/ships.js', 'assets/js/trip.js',
];
const FRESH = /\/(index\.html)?$|\/data\/data\.enc\.json$|\/assets\/(js|css)\//;

self.addEventListener('install', (ev) => {
  ev.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (ev) => {
  ev.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    const res = await Promise.race([fetch(req), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000))]);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch {
    return (await cache.match(req, { ignoreSearch: true })) || (req.mode === 'navigate' && (await cache.match('index.html'))) || Response.error();
  }
}

async function cacheFirst(req, ev) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  const update = fetch(req).then((res) => { if (res.ok || res.type === 'opaque') cache.put(req, res.clone()); return res; });
  if (hit) { ev.waitUntil(update.catch(() => {})); return hit; }
  return update;
}

self.addEventListener('fetch', (ev) => {
  const req = ev.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const same = url.origin === location.origin;
  if (same && (req.mode === 'navigate' || FRESH.test(url.pathname))) { ev.respondWith(networkFirst(req)); return; }
  // eigene Dateien und das Hintergrundfoto
  if (same || url.hostname === 'images.unsplash.com') ev.respondWith(cacheFirst(req, ev));
});
