// Service worker: интерфейс и учебные файлы живут в Cache Storage,
// прогресс — в IndexedDB. Обновление версии НИКОГДА не трогает IndexedDB.
const VERSION = 'v30';
// Имена кэшей с префиксом приложения: на общем адресе (например, *.github.io) рядом живут другие сайты
// со своими кэшами — трогаем только свои.
const PREFIX = 'hanzi-hsk123-';
const SHELL = `${PREFIX}shell-${VERSION}`;
const DATA = `${PREFIX}data`;        // скачанные данные не зависят от версии оболочки: обновление их не стирает
const OLD_DATA = 'data', OLD_SHELL = /^shell-v\d+$/;   // имена до v23 (адрес Netlify)

const SHELL_FILES = [
  './', './index.html', './app.css', './manifest.webmanifest', './icons/icon.svg',
  './icons/icon-180.png', './icons/icon-192.png', './icons/icon-512.png', './export-legacy.html',
  './js/app.js', './js/db.js', './js/store.js', './js/catalog.js', './js/model.js', './js/migrate.js', './js/recover.js', './js/speech.js', './js/practice.js', './js/sync.js', './js/safety.js',
  './data/textbook/basic-chinese-40/manifest.json', './data/hsk/index.json', './data/migration-v1-to-v2.json',
  // словарь уроков (words.json) в списке не указан: на публичном адресе его нет; где он есть — кэшируется при первом чтении
  './data/demo/demo-ru.json', './data/confusables.json', './data/examples/levels.json', './data/templates/textbook-import-template.csv'
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    // по одному: один недоступный файл не должен срывать всю установку
    // cache: 'reload' — мимо HTTP-кэша браузера (Safari), иначе новая оболочка может собраться из старых файлов
    await Promise.all(SHELL_FILES.map(u => cache.add(new Request(u, { cache: 'reload' })).catch(err => console.warn('sw: не закэшировано', u, err))));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    // свои старые оболочки — удалить; чужие кэши (без нашего префикса) — не трогать
    await Promise.all(keys.filter(k => k.startsWith(PREFIX) && k !== SHELL && k !== DATA).map(k => caches.delete(k)));
    // кэши до v23 без префикса: считаются нашими, только если ВСЕ адреса в них — в области этого приложения
    for (const k of keys.filter(k => k === OLD_DATA || OLD_SHELL.test(k))) {
      try {
        const old = await caches.open(k), reqs = await old.keys();
        if (!reqs.every(r => r.url.startsWith(self.registration.scope))) continue;
        if (k === OLD_DATA) { const nw = await caches.open(DATA); for (const r of reqs) if (!(await nw.match(r))) { const res = await old.match(r); if (res) await nw.put(r, res); } }
        await caches.delete(k);
      } catch (err) { console.warn('sw: старый кэш не перенесён', k, err); }
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', (e) => {
  if (e.data?.type === 'precache') {
    e.waitUntil(caches.open(SHELL).then(c => Promise.all(SHELL_FILES.map(u => c.add(u).catch(() => {})))));
  }
  if (e.data?.type === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;

  // навигация: офлайн отдаём сохранённую оболочку
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try { return await fetch(req); }
      catch { return (await caches.match('./index.html')) || (await caches.match('./')) || Response.error(); }
    })());
    return;
  }

  // номер опубликованной версии — только из сети
  if (sameOrigin && url.pathname.endsWith('/version.json')) {
    e.respondWith(fetch(req, { cache: 'no-store' }).catch(() => Response.error()));
    return;
  }

  // облако (GitHub API): только сеть, мимо кэша — личные данные и ответы с ключом не сохраняются в Cache Storage
  if (url.hostname === 'api.github.com') return;

  if (!sameOrigin) {
    // внешние адреса (словарь с сайта): сеть, при неудаче — то, что уже скачано
    e.respondWith(fetch(req).then(r => {
      if (r.ok) caches.open(DATA).then(c => c.put(req, r.clone()));
      return r;
    }).catch(() => caches.match(req).then(r => r || Response.error())));
    return;
  }

  const isData = url.pathname.includes('/data/');
  e.respondWith((async () => {
    const cache = await caches.open(isData ? DATA : SHELL);
    const cached = await cache.match(req);
    if (cached && !isData) {
      fetch(req).then(r => { if (r.ok) cache.put(req, r.clone()); }).catch(() => {});
      return cached;                       // оболочка: быстро из кэша, обновление в фоне
    }
    try {
      const fresh = await fetch(req);
      if (fresh.ok) cache.put(req, fresh.clone());
      return fresh;
    } catch (err) {
      if (cached) return cached;
      throw err;
    }
  })());
});
