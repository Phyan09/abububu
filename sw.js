const CACHE = 'roco-nature-v126';
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './fonts/ZCOOLKuaiLe.ttf',
  './fonts/RocoTitle.woff2',
  './fonts/RocoTitle.ttf',
  './css/style.css',
  './js/rational.js',
  './js/interval.js',
  './js/catalog.js',
  './js/stats.js',
  './js/damage.js',
  './js/solver.js',
  './js/health.js',
  './js/icons.js',
  './js/assets.js',
  './js/element-colors.js',
  './js/img-store.js',
  './js/wiki-update.js',
  './js/app.js',
  './data/catalog.json',
  './data/battle-skill-rules.json',
  './assets/elements_pick2/t2.png',
  './assets/elements_pick2/t3.png',
  './assets/elements_pick2/t4.png',
  './assets/elements_pick2/t5.png',
  './assets/elements_pick2/t6.png',
  './assets/elements_pick2/t8.png',
  './assets/elements_pick2/t9.png',
  './assets/elements_pick2/t10.png',
  './assets/elements_pick2/t11.png',
  './assets/elements_pick2/t12.png',
  './assets/elements_pick2/t13.png',
  './assets/elements_pick2/t14.png',
  './assets/elements_pick2/t15.png',
  './assets/elements_pick2/t16.png',
  './assets/elements_pick2/t17.png',
  './assets/elements_pick2/t18.png',
  './assets/elements_pick2/t19.png',
  './assets/elements_pick2/t20.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || !new URL(request.url).origin.startsWith('http')) return;
  // 网络优先：优先取本地最新资源（安装包升级后立刻生效），离线时回落到缓存
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const resp = await fetch(request);
      if (resp && resp.ok) cache.put(request, resp.clone());
      return resp;
    } catch (err) {
      const hit = await cache.match(request);
      if (hit) return hit;
      if (request.mode === 'navigate') {
        const fallback = await cache.match('./index.html');
        if (fallback) return fallback;
      }
      throw err;
    }
  })());
});
