/* sw.js — PWA Service Worker для MAX (GitHub Pages friendly)
   — Скоуп-осознанные пути (работает в подкаталоге /repo/)
   — Предкеш оболочки, оффлайн-страница, SPA-фоллбек
   — Навигационный preload, кэш Google Fonts
   — Обновления через SKIP_WAITING + clients.claim()
   Цвета: theme=#667eea, background=#E8E5FF
*/
const VERSION = '1.3.0';
const PREFIX  = 'maxdemo';
const SHELL   = `${PREFIX}-shell-${VERSION}`;
const RUNTIME = `${PREFIX}-rt-${VERSION}`;

const THEME = '#667eea';
const BG    = '#E8E5FF';

/* ВСПОМОГАТЕЛЬНОЕ:
   Гарантируем, что любые относительные пути резолвятся в рамки текущего scope SW
   (например, https://username.github.io/repo/).
*/
const SCOPE = self.registration?.scope || self.location.href;
const U = (p) => new URL(p, SCOPE);           // URL-объект внутри scope
const US = (p) => U(p).toString();             // строка URL

// Что кэшируем как оболочку приложения:
const APP_SHELL = [
  US('./'),                 // корень страницы в подкаталоге
  US('index.html'),
  US('manifest.json'),
  US('icons/icon-192.png'),
  US('icons/icon-512.png')
];

// оффлайн-экран (встроенный)
const OFFLINE_HTML = `
<!doctype html><html lang="ru"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Нет сети</title><meta name="theme-color" content="${THEME}">
<style>
:root{--bg:${BG};--accent:${THEME};--fg:#1a1534;--muted:#4b4a63}
*{box-sizing:border-box}html,body{height:100%;margin:0;background:var(--bg);color:var(--fg);
font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Cantarell,Arial}
.wrap{min-height:100%;display:grid;place-items:center;padding:24px}
.card{width:min(560px,92vw);background:#fff;border-radius:16px;padding:20px;box-shadow:0 12px 30px rgba(0,0,0,.12);border:2px solid var(--accent)}
h1{margin:0 0 6px 0;font-size:18px}p{margin:0 0 12px 0;color:var(--muted)}
.row{display:flex;gap:8px;flex-wrap:wrap}
button{cursor:pointer;border:0;border-radius:12px;padding:10px 14px;font-weight:600}
.primary{background:var(--accent);color:#fff}.ghost{background:#f4f2ff;color:#2b2463;border:1px solid #ded9ff}
small{display:block;margin-top:10px;color:#6b6a86}
</style></head><body>
<div class="wrap"><div class="card" role="status" aria-live="polite">
<h1>Вы оффлайн</h1><p>Подключите интернет и попробуйте снова.</p>
<div class="row"><button class="primary" onclick="location.reload()">Перезагрузить</button>
<button class="ghost" onclick="history.back()">Назад</button></div>
<small>Демо оффлайн-страница (theme=${THEME}, bg=${BG})</small>
</div></div></body></html>`;

// Куда положим встроенный оффлайн HTML в кэш (внутри scope!)
const OFFLINE_KEY = US('__offline.html');

// -------------------- INSTALL --------------------
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    // Предкеш оболочки
    for (const url of APP_SHELL) {
      try {
        await cache.add(new Request(url, { credentials: 'same-origin' }));
      } catch (_) { /* мимо */ }
    }
    // Встроенный оффлайн
    await cache.put(OFFLINE_KEY, new Response(OFFLINE_HTML, {
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    }));
    await self.skipWaiting();
  })());
});

// -------------------- ACTIVATE --------------------
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Навигационный preload
    if (self.registration.navigationPreload) {
      try { await self.registration.navigationPreload.enable(); } catch (_) {}
    }
    // Сносим старые кэши
    const keys = await caches.keys();
    await Promise.all(
      keys.map(k => (k.startsWith(PREFIX) && k !== SHELL && k !== RUNTIME) ? caches.delete(k) : null)
    );
    // Захватываем клиентов сразу
    await self.clients.claim();
  })());
});

// -------------------- MESSAGES --------------------
self.addEventListener('message', (event) => {
  const msg = event?.data || {};
  if (msg.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (msg.type === 'SILENT_TERMINATE') {
    event.waitUntil((async () => {
      const clientsList = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
      for (const c of clientsList) {
        try { await c.navigate(US('__closed.html')); } catch (_) {}
      }
      // Можно дополнительно сделать: await self.registration.unregister();
    })());
  }
});

// -------------------- HELPERS --------------------
async function offlineFallback() {
  // сначала пробуем явный оффлайн-ресурс в кэше по ключу OFFLINE_KEY
  const cached = await caches.match(OFFLINE_KEY);
  if (cached) return cached;
  // на крайний случай — восстановим из строки
  return new Response(OFFLINE_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

function isStaticAsset(url) {
  return /\.(css|js|mjs|png|jpg|jpeg|gif|webp|svg|ico|woff2?|ttf|otf)$/i.test(url.pathname);
}

// -------------------- FETCH --------------------
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Google Fonts — отдельная стратегия (кросс-домен)
  const isGF = (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com');

  // HTML-навигации: network-first (+preload) → кэш оболочки → оффлайн/SPA-фоллбек
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        // навигационный preload, если браузер поддерживает
        const preload = await event.preloadResponse;
        if (preload) return preload;

        const network = await fetch(request, { credentials: 'same-origin' });
        // Если сеть вернула 2xx — отдаём как есть
        if (network && network.ok) return network;

        // При 4xx/5xx стараемся вернуть закэшированную оболочку (SPA-фоллбек)
        const shell = await caches.match(US('index.html')) || await caches.match(request);
        return shell || await offlineFallback();
      } catch (_) {
        // Нет сети → оболочка или оффлайн
        const shell = await caches.match(US('index.html')) || await caches.match(request);
        return shell || await offlineFallback();
      }
    })());
    return;
  }

  // Google Fonts: stale-while-revalidate (разрешаем opaque)
  if (isGF) {
    event.respondWith((async () => {
      const cache = await caches.open(RUNTIME);
      const cached = await cache.match(request);
      const fetched = fetch(request, { mode: 'no-cors' }).then(resp => {
        if (resp) {
          cache.put(request, resp.clone()).catch(() => {});
        }
        return resp;
      }).catch(() => null);
      return cached || (await fetched) || new Response('', { status: 504 });
    })());
    return;
  }

  // Своя статика: stale-while-revalidate
  if (url.origin === location.origin && isStaticAsset(url)) {
    event.respondWith((async () => {
      const cache = await caches.open(RUNTIME);
      const cached = await cache.match(request);
      const fetched = fetch(request).then(resp => {
        if (resp && (resp.status === 200 || resp.type === 'opaque')) {
          cache.put(request, resp.clone()).catch(() => {});
        }
        return resp;
      }).catch(() => null);
      return cached || (await fetched) || (await caches.match(request)) || new Response('', { status: 504 });
    })());
    return;
  }

  // Прочие запросы: сеть → кэш → оффлайн
  event.respondWith((async () => {
    try { return await fetch(request); }
    catch (_) { return (await caches.match(request)) || await offlineFallback(); }
  })());
});
