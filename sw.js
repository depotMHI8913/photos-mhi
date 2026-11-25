// Dépôt de photos MHI : la page s'ouvre aussi sans réseau, et les envois continuent quand la page est fermée
const V = 'mhi-depot-v3';
const SHELL = ['./', 'index.html', 'envoi.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];
importScripts('envoi.js');
self.addEventListener('install', (e) => { e.waitUntil(caches.open(V).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== V).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;   // envois vers le relais : jamais mis en cache
  // réseau d'abord (nouvelle version tout de suite), copie locale sinon
  e.respondWith(fetch(e.request).then((r) => { const c = r.clone(); caches.open(V).then((ca) => ca.put(e.request, c)); return r; })
    .catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match('index.html'))));
});
/* la page demande au service worker de finir les envois : ils continuent même si la page est fermée (Android, ordinateur) */
self.addEventListener('message', (e) => { if (e.data === 'envoyer') e.waitUntil(MHIQ.flush(true)); });
/* sans réseau au moment de l'envoi : le téléphone réveille le service worker dès que la connexion revient (Android) */
self.addEventListener('sync', (e) => { if (e.tag === 'mhi-envoi') e.waitUntil(MHIQ.flush(true).then(async () => { if (await MHIQ.pendingCount()) throw new Error('encore des photos en attente'); })); });
