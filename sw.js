const VERSION = 'v10';
const CACHE_NAME = `m4shlab-${VERSION}`;
const RUNTIME_CACHE = `m4shlab-runtime-${VERSION}`;
const APP_SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './parser/mp4.js',
  './parser/nal.js',
  './parser/sps.js',
  './parser/hevc.js',
  './merge.js',
  './mosh.js',
  './webcodecs.js',
  './webcodecs-muxer.js',
  './converter.js',
  './conversion-settings.js',
  './classic-mosh.js',
  './speed.js',
  './randomize.js',
  './audio.js',
  './hybrid-encoder.js',
  './manifest.json',
  './favicon.svg',
  './favicon-32.png',
  './icon.svg',
  './icon-192.png',
  './icon-512.png',
  './icon-180.png',
];
const FFMPEG_CORE_PREFIX = '/npm/@ffmpeg/core@0.12.10/dist/esm/';
const SHELL_URLS = new Set(APP_SHELL.map(path => new URL(path, self.registration.scope).href));

function withoutSearch(url) {
  const key = new URL(url);
  key.search = '';
  key.hash = '';
  return key.href;
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(withoutSearch(request.url), {ignoreVary: true});
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) await cache.put(withoutSearch(request.url), response.clone());
  return response;
}

async function navigationResponse(request) {
  const cache = await caches.open(CACHE_NAME);
  const indexUrl = new URL('./index.html', self.registration.scope).href;
  const cached = await cache.match(indexUrl, {ignoreSearch: true, ignoreVary: true});
  if (cached) return cached;
  try {
    return await fetch(request);
  } catch {
    return new Response('m4shlab is offline and its app shell has not been cached yet.', {
      status: 503,
      headers: {'Content-Type': 'text/plain; charset=utf-8'},
    });
  }
}

async function runtimeCacheFirst(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  const cached = await cache.match(request, {ignoreVary: true});
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok || response.type === 'opaque') {
    await cache.put(request, response.clone());
  }
  return response;
}

function isAppShell(url) {
  return url.origin === self.location.origin && SHELL_URLS.has(withoutSearch(url.href));
}

function isConversionWorker(url) {
  return url.origin === self.location.origin && url.pathname.endsWith('/converter-worker.js');
}

function isFfmpegCore(url) {
  return url.origin === 'https://cdn.jsdelivr.net' && url.pathname.startsWith(FFMPEG_CORE_PREFIX);
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(APP_SHELL.map(path => new Request(new URL(path, self.registration.scope), {cache: 'reload'})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keep = new Set([CACHE_NAME, RUNTIME_CACHE]);
    const names = await caches.keys();
    await Promise.all(names.filter(name => !keep.has(name)).map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);

  if (event.request.mode === 'navigate') {
    event.respondWith(navigationResponse(event.request));
    return;
  }
  if (isAppShell(url)) {
    event.respondWith(cacheFirst(event.request));
    return;
  }
  if (isConversionWorker(url) || isFfmpegCore(url)) {
    event.respondWith(runtimeCacheFirst(event.request));
  }
});
