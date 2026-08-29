/* ==========================================================================
   WeTab Service Worker

   目的只有一个：没网也能打开。旅行时用得最多的场合，往往正是没数据的时候。

   策略：stale-while-revalidate
     打开时先用缓存（瞬间显示），同时在后台悄悄拉一份新的存起来。
     所以你永远不用等网络，而下一次打开就是最新版——不需要手动清缓存，
     也不需要每次发版去改版本号。

   不缓存的东西：
     · Supabase（账本同步）—— 必须拿最新的，拿旧的会覆盖对方的改动
     · frankfurter（汇率）  —— app 自己有当天缓存和离线兜底汇率
   ========================================================================== */

/* 换了名字，旧缓存会在 activate 时被清掉。
   平时不需要动它 —— stale-while-revalidate 自己会更新。
   只有「必须让所有人立刻拿到新外壳」时才改，比如换图标：
   新图标的地址写在 index.html 里，而 index.html 自己还在旧缓存中，不换名就绕不出去。 */
const CACHE = 'wetab-shell-v2';

/* 相对路径：GitHub Pages 上跑在 /wetab/ 子目录，本机跑在根目录，两边都要对 */
const SHELL = [
  './',
  './index.html',
  './app.js',
  './i18n.js',
  './styles.css',
  './config.js',
  './sprite.svg',
  './manifest.webmanifest',
  './favicon.svg',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable.png',
  './apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      // 单个资源 404 不该让整次安装失败，所以逐个 add
      .then((c) => Promise.allSettled(SHELL.map((u) => c.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // Supabase / 汇率，一律直连

  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(req, { ignoreSearch: true });

      const fresh = fetch(req)
        .then((res) => {
          if (res && res.ok) cache.put(req, res.clone());
          return res;
        })
        .catch(() => null);

      // 有缓存就先给缓存，后台再更新；没缓存就等网络
      if (cached) return cached;

      const res = await fresh;
      if (res) return res;

      // 彻底没网且没缓存：导航请求退回首页外壳，其余放弃
      if (req.mode === 'navigate') {
        const shell = await cache.match('./index.html', { ignoreSearch: true });
        if (shell) return shell;
      }
      return new Response('离线，且没有缓存', { status: 503, statusText: 'Offline' });
    })
  );
});
