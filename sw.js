/* 1호선 알리미 서비스 워커
   - 앱 껍데기(HTML/CSS/JS/아이콘)는 캐시에서 먼저 응답
   - 서울시 API·프록시 요청은 캐시하지 않고 그대로 네트워크로 보냄
   - 설치할 때 껍데기 파일을 버전 쿼리(?v=)로 새 URL 에서 받는다.
     같은 URL 은 브라우저 HTTP 캐시와 GitHub Pages CDN 캐시(max-age=600)에
     예전 내용이 남아 있어, 버전만 올리면 새 캐시에 예전 파일이 들어간다.
     쿼리를 바꾸면 캐시 키가 달라져 항상 새로 받는다.
     (화면은 ignoreSearch 로 캐시를 찾으므로 쿼리 유무는 상관없다) */
const VERSION = '20';
const CACHE = 'subway1-radar-v' + VERSION;
const FILES = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './stations.js',
  './assets/arrival-bell.mp3',
  './manifest.json',
  './icons/icon-192-v2.png',
  './icons/icon-512-v2.png',
  './icons/maskable-512-v2.png',
  './icons/apple-touch-icon-v2.png',
  './icons/favicon-32-v2.png'
];
const SHELL = FILES.map((f) => f + (f.indexOf('?') < 0 ? '?v=' + VERSION : ''));

/* 새 캐시에는 네트워크에서 새로 받은 파일만 넣는다 */
function seed(cache, url) {
  return fetch(url, { cache: 'reload' })
    .then((res) => {
      if (!res || !res.ok) throw new Error('HTTP ' + (res && res.status));
      return cache.put(url, res);
    })
    .catch(() => fetch(url, { cache: 'no-store' })
      .then((res) => { if (res && res.ok) return cache.put(url, res); })
      .catch(() => {}));
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => Promise.all(SHELL.map((url) => seed(cache, url))))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      const old = keys.filter((k) => k !== CACHE);
      return Promise.all(old.map((k) => caches.delete(k))).then(() => old.length > 0);
    }).then((updated) =>
      self.clients.claim().then(() => {
        // 예전 버전이 깔려 있던 기기: 열려 있는 화면을 한 번 새로 고쳐
        // 최신 코드가 바로 뜨게 한다. (처음 설치 때는 새로 고침하지 않음)
        if (!updated) return;
        return self.clients.matchAll({ type: 'window' }).then((list) => {
          list.forEach((c) => { if (c.navigate) c.navigate(c.url).catch(() => {}); });
        });
      })
    )
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  if (!sameOrigin) return; // API·프록시는 그대로 통과

  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => {
      if (hit) {
        // 뒤에서 조용히 최신화
        fetch(req).then((res) => {
          if (res && res.ok) caches.open(CACHE).then((c) => c.put(req, res.clone()));
        }).catch(() => {});
        return hit;
      }
      return fetch(req).then((res) => {
        if (res && res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => caches.match('./index.html', { ignoreSearch: true }));
    })
  );
});
