/* ============================================================
   1호선 알리미 · Cloudflare Worker 프록시
   ------------------------------------------------------------
   왜 필요한가:
     서울시 열린데이터광장 지하철 API는 http://swopenAPI.seoul.go.kr 만 제공합니다.
     GitHub Pages 같은 https 사이트에서는 Mixed Content 로 막히고,
     swopenAPI 는 Access-Control-Allow-Origin 헤더도 주지 않아 브라우저 fetch 가
     CORS 로 실패합니다. 이 Worker 가 https + CORS 를 붙여 중계합니다.

   배포:
     1) npm i -g wrangler
     2) wrangler init subway-proxy  (또는 이 파일을 src/index.js 로)
     3) wrangler secret put SEOUL_API_KEY   ← 서울 열린데이터광장 인증키
     4) wrangler deploy
     5) 앱 설정 → 데이터 소스 "프록시 URL" → https://subway-proxy.<계정>.workers.dev

   앱이 호출하는 경로:
     GET /realtimeStationArrival/0/30/두정
     GET /realtimePosition/0/300/1호선
     GET /realtimeStationArrival/ALL
   ============================================================ */

const UPSTREAM = 'http://swopenAPI.seoul.go.kr/api/subway';
const ALLOWED = {
  realtimeStationArrival: { minParts: 3, maxParts: 4 }, // start/end/역명
  realtimePosition: { minParts: 3, maxParts: 4 },       // start/end/호선명
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

function json(body, status, extra) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...CORS,
      ...(extra || {}),
    },
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }
    if (request.method !== 'GET') {
      return json({ ok: false, error: 'GET 요청만 지원합니다.' }, 405);
    }

    // 인증키: Worker 환경변수 우선, 없으면 ?key= (테스트용)
    const key = (env && env.SEOUL_API_KEY) || url.searchParams.get('key');
    if (!key) {
      return json({
        ok: false,
        error: 'SEOUL_API_KEY 가 없습니다. wrangler secret put SEOUL_API_KEY 로 넣거나 ?key=로 전달하세요.',
      }, 500);
    }

    const parts = url.pathname.replace(/^\/+/, '').split('/').filter(Boolean);
    const service = parts[0];

    // 전체 역 일괄 도착정보
    if (service === 'realtimeStationArrival' && parts[1] === 'ALL') {
      return proxy(key, 'realtimeStationArrival/ALL', ctx);
    }

    const rule = ALLOWED[service];
    if (!rule) {
      return json({ ok: false, error: '허용되지 않은 경로: ' + url.pathname }, 404);
    }
    if (parts.length < rule.minParts + 1 || parts.length > rule.maxParts + 1) {
      return json({ ok: false, error: '경로 형식은 /' + service + '/시작/끝/검색어 입니다.' }, 400);
    }

    const start = Number(parts[1]);
    const end = Number(parts[2]);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end - start > 1000) {
      return json({ ok: false, error: '시작/끝 번호가 올바르지 않습니다.' }, 400);
    }

    let keyword = '';
    try { keyword = decodeURIComponent(parts[3] || ''); } catch (e) { keyword = parts[3] || ''; }
    const target = service + '/' + start + '/' + end + '/' + encodeURIComponent(keyword);
    return proxy(key, target, ctx);
  },
};

async function proxy(key, path, ctx) {
  const upstream = UPSTREAM + '/' + encodeURIComponent(key) + '/json/' + path;
  const cacheKey = new Request('https://subway-proxy.cache/' + path, { method: 'GET' });
  const cache = caches.default;

  const hit = await cache.match(cacheKey);
  if (hit) {
    const res = new Response(hit.body, hit);
    res.headers.set('X-Proxy-Cache', 'HIT');
    return res;
  }

  let upstreamRes;
  try {
    upstreamRes = await fetch(upstream, { cf: { cacheTtl: 15, cacheEverything: true } });
  } catch (err) {
    return json({ ok: false, error: '상류 API 연결 실패: ' + (err && err.message) }, 502);
  }

  const text = await upstreamRes.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch (err) {
    return json({ ok: false, error: '상류 응답이 JSON이 아닙니다.', raw: text.slice(0, 200) }, 502);
  }

  // 서울시 API는 성공·실패 가리지 않고 HTTP 200 + JSON 본문으로 내려온다.
  // errorMessage 는 "오류" 표시가 아니라 응답 봉투(envelope)이고,
  // 성공(INFO-000)·빈 데이터(INFO-200)일 때도 함께 온다.
  // → 봉투를 보고 상태 코드를 502로 바꾸면 브라우저 fetch 가 멀쩡한 데이터를
  //   실패로 버린다(예전 동작). 성공/실패 판단은 본문 코드로 하고 HTTP 는 200.
  const res = new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=15',
      'X-Proxy-Cache': 'MISS',
      ...CORS,
    },
  });

  if (ctx && ctx.waitUntil) {
    ctx.waitUntil(cache.put(cacheKey, res.clone()));
  }
  return res;
}
