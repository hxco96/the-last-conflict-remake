// Offline support. The core game (~9 MB) is cached at install; maps and audio are cached the first
// time they are played (or all at once via Settings → "Download everything for offline").
// Bump VERSION whenever files change so installed copies update.
const VERSION = 'tlcr-v9';
const SHELL = [
  './', 'index.html', 'manifest.webmanifest',
  'js/main.js', 'js/assets.js', 'js/data.js', 'js/game.js', 'js/map.js', 'js/nav.js', 'js/actors.js',
  'js/combat.js', 'js/npc.js', 'js/modes.js', 'js/profile.js', 'js/lobby.js', 'js/session.js', 'js/tiers.js', 'js/input.js', 'js/sfx.js',
  'js/net.js', 'js/coop.js', 'js/survival.js', 'js/vendor/peerjs.min.js',
  'assets/img/all_infecteds.json', 'assets/img/all_infecteds.png', 'assets/img/core_custom.json', 'assets/img/core_custom.png',
  'assets/img/combat_anims.json', 'assets/img/combat_anims.png', 'assets/img/all_lights.json', 'assets/img/all_lights.png',
  'assets/img/all_tilesets-0.png', 'assets/img/all_tilesets-1.png', 'assets/img/titlescreen.png', 'assets/img/BebasNeue-Regular.ttf',
  'assets/img/icons/icon-192.png', 'assets/img/icons/icon-512.png',
  'assets/data/tables.json', 'assets/data/tilesets.json', 'assets/data/barks.json',
  'assets/maps/index.json', 'assets/audio/index.json',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Serve a byte range out of a full cached response (the <audio> music player asks for ranges).
async function rangeFrom(res, range) {
  const buf = await res.arrayBuffer();
  const m = /bytes=(\d*)-(\d*)/.exec(range) || [];
  const start = m[1] ? +m[1] : 0, end = m[2] ? Math.min(+m[2], buf.byteLength - 1) : buf.byteLength - 1;
  return new Response(buf.slice(start, end + 1), {
    status: 206,
    headers: { 'Content-Type': res.headers.get('Content-Type') || 'audio/ogg', 'Content-Range': `bytes ${start}-${end}/${buf.byteLength}`, 'Content-Length': String(end - start + 1), 'Accept-Ranges': 'bytes' },
  });
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  const key = url.origin + url.pathname; // ignore query strings
  const isCode = /\.(html|js|webmanifest)$/.test(url.pathname) || url.pathname.endsWith('/');

  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const range = req.headers.get('range');
    if (isCode) {
      // network first so updates arrive; cached copy when offline
      try {
        const res = await fetch(req);
        if (res.ok) cache.put(key, res.clone());
        return res;
      } catch {
        return (await cache.match(key)) || (await cache.match(url.origin + url.pathname.replace(/[^/]*$/, '') + 'index.html')) || Response.error();
      }
    }
    // assets: cache first; fetch the full file once, then answer ranges from it
    let hit = await cache.match(key);
    if (!hit) {
      try {
        const res = await fetch(key);
        if (!res.ok) return res;
        await cache.put(key, res.clone());
        hit = res;
      } catch {
        return Response.error();
      }
    }
    return range ? rangeFrom(hit.clone(), range) : hit;
  })());
});

// Settings → "Download everything for offline" sends a list of URLs to cache.
self.addEventListener('message', (e) => {
  if (!e.data || e.data.type !== 'cache-all') return;
  e.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    let done = 0;
    for (const u of e.data.urls) {
      const key = new URL(u, self.registration.scope).href;
      if (!(await cache.match(key))) {
        try { const r = await fetch(key); if (r.ok) await cache.put(key, r); } catch { /* keep going */ }
      }
      done++;
      if (done % 10 === 0 || done === e.data.urls.length) e.source.postMessage({ type: 'cache-progress', done, total: e.data.urls.length });
    }
  })());
});
