/* 1호선 알리미 서비스 워커
   - 앱 껍데기(HTML/CSS/JS/아이콘)는 캐시에서 먼저 응답
   - 서울시 API·프록시 요청은 캐시하지 않고 그대로 네트워크로 보냄
   - 설치할 때는 cache: 'reload' 로 받아 브라우저 HTTP 캐시(깃허브 페이지
     max-age=600)에 남은 예전 파일이 새 캐시에 들어가지 않게 한다.
     (버전만 올렸을 때 예전 파일이 그대로 캐시되는 문제 방지) */
const CACHE = 'subway1-radar-v13';
const SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './stations.js',
  './manifest.json',
  './icons/icon-192-v2.png',
  './icons/icon-512-v2.png',
  './icons/maskable-512-v2.png',
  './icons/apple-touch-icon-v2.png',
  './icons/favicon-32-v2.png'
];

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
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
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
      }).catch(() => caches.match('./index.html'));
    })
  );
});
