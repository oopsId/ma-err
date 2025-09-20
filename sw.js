/* sw.js — PWA Service Worker для MAX (демо, 404 + closed)
   Предкеш оболочки, оффлайн, обновления, навигационный preload,
   кэширование Google Fonts. Цвета: theme=#667eea, background=#E8E5FF
*/
const VERSION = '1.3.4';
const PREFIX  = 'maxdemo';
const SHELL   = `${PREFIX}-shell-${VERSION}`;
const RUNTIME = `${PREFIX}-rt-${VERSION}`;

const THEME = '#667eea';
const BG    = '#E8E5FF';

// База для абсолютных URL (работает и на user.github.io/repo, и на кастомном домене)
const SCOPE = self.registration ? new URL(self.registration.scope) : new URL('./', self.location);
const ORIGIN = SCOPE.origin;
const U = (p) => new URL(p, SCOPE).toString();

const APP_SHELL = [
  U('./'),
  U('index.html'),
  U('404.html'),
  U('__closed.html'),
  U('site.webmanifest'),
  U('icons/icon-192.png'),
  U('icons/icon-512.png')
];

// Оффлайн-экран (встроенный)
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

// Установка
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    for (const url of APP_SHELL) {
      try { await cache.add(new Request(url, { credentials: 'same-origin' })); } catch(_) {}
    }
    // подкинем встроенный оффлайн как отдельный ресурс
    await cache.put(U('__offline.html'), new Response(OFFLINE_HTML, { headers: {'Content-Type':'text/html; charset=utf-8'} }));
    await self.skipWaiting();
  })());
});

// Активация
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    if (self.registration.navigationPreload) {
      try { await self.registration.navigationPreload.enable(); } catch(_) {}
    }
    const keys = await caches.keys();
    await Promise.all(keys.map(k => (k.startsWith(PREFIX) && k !== SHELL && k !== RUNTIME) ? caches.delete(k) : null));
    await self.clients.claim();
  })());
});

// Сообщения от клиента
self.addEventListener('message', (event) => {
  const msg = event?.data || {};
  if (msg.type === 'SKIP_WAITING') self.skipWaiting();
  if (msg.type === 'SILENT_TERMINATE') {
    event.waitUntil((async () => {
      const clientsList = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
      for (const c of clientsList) {
        try { await c.navigate(U('__closed.html')); } catch(_) {}
      }
    })());
  }
});

// Хелпер оффлайна
async function offlineFallback() {
  return (await caches.match(U('__offline.html'))) ||
         new Response(OFFLINE_HTML, { headers:{'Content-Type':'text/html; charset=utf-8'} });
}

// Fetch
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  const isGoogleFonts = (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com');

  // Навигации (HTML)
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const preload = await event.preloadResponse;
        if (preload) return preload;

        const network = await fetch(request, { credentials: 'same-origin' });
        if (network && network.status === 404) {
          const page404 = await caches.match(U('404.html'));
          return page404 || new Response('Not found', { status: 404 });
        }
        if (network && network.ok) return network;

        // Не OK, попробуем shell → 404 → оффлайн
        const shell = await caches.match(U('index.html'));
        if (shell) return shell;
        const page404 = await caches.match(U('404.html'));
        return page404 || await offlineFallback();
      } catch (_) {
        // Сеть упала: shell → 404 → оффлайн
        const shell = await caches.match(U('index.html'));
        if (shell) return shell;
        const page404 = await caches.match(U('404.html'));
        return page404 || await offlineFallback();
      }
    })());
    return;
  }

  // Google Fonts: stale-while-revalidate
  if (isGoogleFonts) {
    event.respondWith((async () => {
      const cache = await caches.open(RUNTIME);
      const cached = await cache.match(request);
      const fetched = fetch(request, { mode: 'no-cors' }).then(resp => {
        if (resp) cache.put(request, resp.clone()).catch(()=>{});
        return resp;
      }).catch(()=>null);
      return cached || (await fetched) || new Response('', { status: 504 });
    })());
    return;
  }

  // Своя статика: stale-while-revalidate
  if (url.origin === ORIGIN && /\.(css|js|mjs|png|jpg|jpeg|gif|webp|svg|ico|woff2?|ttf|otf)$/i.test(url.pathname)) {
    event.respondWith((async () => {
      const cache = await caches.open(RUNTIME);
      const cached = await cache.match(request);
      const fetched = fetch(request).then(resp => {
        if (resp && (resp.status === 200 || resp.type === 'opaque')) {
          cache.put(request, resp.clone()).catch(()=>{});
        }
        return resp;
      }).catch(()=>null);
      return cached || (await fetched) || (await caches.match(request)) || new Response('', { status: 504 });
    })());
    return;
  }

  // Прочее: сеть → кеш → оффлайн
  event.respondWith((async () => {
    try { return await fetch(request); }
    catch(_) { return (await caches.match(request)) || await offlineFallback(); }
  })());
});
