/* ============================================================
   1호선 레이더 · 역/구간 데이터
   - 수도권 전철 1호선(경부·경인·장항선) 역 순서와 인접 역 평균 소요시간(분)
   - 코레일 구간은 도착 API의 barvlDt(초)가 비어 오는 경우가 많아,
     arvlMsg2("[2]번째 전역 (성환)")나 실시간 위치(statnNm)만으로
     기준역까지 남은 시간을 계산할 수 있도록 구간 시간표를 내장한다.
   - 소요시간은 평시 기준 근사값(역간 2~6분)이며, 실제 운행과는
     ±1~2분 차이가 날 수 있다.
   ============================================================ */
(function (global) {
  'use strict';

  /* 인접 역 구간 소요시간(분) */
  const SEGMENTS = [
    // ── 경인선(인천지선) ─────────────────────────────
    ['인천', '동인천', 2], ['동인천', '도원', 2], ['도원', '제물포', 2],
    ['제물포', '도화', 2], ['도화', '주안', 2], ['주안', '간석', 2],
    ['간석', '동암', 2], ['동암', '백운', 2], ['백운', '부평', 2],
    ['부평', '부개', 2], ['부개', '송내', 2], ['송내', '중동', 2],
    ['중동', '부천', 2], ['부천', '소사', 2], ['소사', '역곡', 2],
    ['역곡', '온수', 3], ['온수', '오류동', 2], ['오류동', '개봉', 2],
    ['개봉', '구일', 2], ['구일', '구로', 2],

    // ── 경부선 서울 구간 ─────────────────────────────
    ['구로', '신도림', 3], ['신도림', '영등포', 2], ['영등포', '신길', 2],
    ['신길', '대방', 2], ['대방', '노량진', 2], ['노량진', '용산', 4],
    ['용산', '남영', 2], ['남영', '서울역', 3], ['서울역', '시청', 2],
    ['시청', '종각', 2], ['종각', '종로3가', 2], ['종로3가', '종로5가', 2],
    ['종로5가', '동대문', 2], ['동대문', '동묘앞', 2], ['동묘앞', '신설동', 2],
    ['신설동', '제기동', 2], ['제기동', '청량리', 2], ['청량리', '회기', 2],
    ['회기', '외대앞', 2], ['외대앞', '신이문', 2], ['신이문', '석계', 2],
    ['석계', '광운대', 2], ['광운대', '월계', 2], ['월계', '녹천', 2],
    ['녹천', '창동', 3], ['창동', '방학', 2], ['방학', '도봉', 2],
    ['도봉', '도봉산', 2], ['도봉산', '망월사', 2], ['망월사', '회룡', 2],
    ['회룡', '덕계', 3], ['덕계', '덕정', 2], ['덕정', '지행', 2],
    ['지행', '동두천중앙', 2], ['동두천중앙', '보산', 2], ['보산', '동두천', 2],
    ['동두천', '소요산', 2], ['소요산', '청산', 5], ['청산', '전곡', 5],
    ['전곡', '연천', 4],

    // ── 경부선 남부(구로 이남) ───────────────────────
    ['구로', '가산디지털단지', 3], ['가산디지털단지', '독산', 2],
    ['독산', '금천구청', 2], ['금천구청', '석수', 3], ['석수', '관악', 2],
    ['관악', '안양', 2], ['안양', '명학', 2], ['명학', '금정', 2],
    ['금정', '군포', 3], ['군포', '당정', 2], ['당정', '의왕', 3],
    ['의왕', '성균관대', 3], ['성균관대', '화서', 3], ['화서', '수원', 2],
    ['수원', '세류', 3], ['세류', '병점', 4], ['병점', '세마', 3],
    ['세마', '오산', 3], ['오산', '진위', 3], ['진위', '송탄', 3],
    ['송탄', '서정리', 3], ['서정리', '지제', 4], ['지제', '평택', 3],
    ['평택', '성환', 6], ['성환', '직산', 4], ['직산', '두정', 3],
    ['두정', '천안', 3], ['천안', '봉명', 2], ['봉명', '쌍용', 2],
    ['쌍용', '아산', 2], ['아산', '탕정', 2], ['탕정', '배방', 2],
    ['배방', '온양온천', 4],
    ['온양온천', '신창', 4],

    // ── 서동탄지선 ───────────────────────────────────
    ['병점', '서동탄', 2]
  ];

  /* 노선 경로(역 순서). 상행 = 배열의 뒤쪽(축 값이 커지는 쪽) 방향 */
  const ROUTE_MAIN = [
    '인천', '동인천', '도원', '제물포', '도화', '주안', '간석', '동암',
    '백운', '부평', '부개', '송내', '중동', '부천', '소사', '역곡', '온수',
    '오류동', '개봉', '구일', '구로', '신도림', '영등포', '신길', '대방',
    '노량진', '용산', '남영', '서울역', '시청', '종각', '종로3가', '종로5가',
    '동대문', '동묘앞', '신설동', '제기동', '청량리', '회기', '외대앞',
    '신이문', '석계', '광운대', '월계', '녹천', '창동', '방학', '도봉',
    '도봉산', '망월사', '회룡', '덕계', '덕정', '지행', '동두천중앙', '보산',
    '동두천', '소요산', '청산', '전곡', '연천'
  ];
  const ROUTE_SOUTH = [
    '구로', '가산디지털단지', '독산', '금천구청', '석수', '관악', '안양',
    '명학', '금정', '군포', '당정', '의왕', '성균관대', '화서', '수원',
    '세류', '병점', '세마', '오산', '진위', '송탄', '서정리', '지제', '평택',
    '성환', '직산', '두정', '천안', '봉명', '쌍용', '아산', '탕정', '배방',
    '온양온천', '신창'
  ];
  const ROUTE_SEODONG = ['병점', '서동탄'];

  /* 환승 정보(역 선택 목록에 표시) */
  const TRANSFER = {
    '서울역': '4호선·공항철도·KTX',
    '시청': '2호선',
    '종로3가': '3·5호선',
    '동대문': '4호선',
    '동묘앞': '6호선',
    '청량리': '경의중앙·수인분당·KTX',
    '회기': '경의중앙',
    '석계': '6호선',
    '광운대': '경춘선',
    '창동': '4호선',
    '도봉산': '7호선',
    '회룡': '의정부경전철',
    '노량진': '9호선',
    '용산': '경의중앙',
    '신도림': '2호선',
    '영등포': '5호선',
    '신길': '5호선',
    '구로': '2호선·신안산선',
    '가산디지털단지': '7호선',
    '온수': '7호선',
    '부평': '인천1호선',
    '인천': '수인분당선',
    '금정': '4호선',
    '수원': '수인분당선·KTX',
    '병점': '서동탄지선',
    '천안': 'KTX·장항선',
    '아산': '장항선',
    '온양온천': '장항선',
    '평택': 'KTX(평택지제)'
  };

  /* 축(axis) 값: 값이 커지는 방향이 상행(서울·청량리·연천 방면) */
  const AXIS = {};
  ROUTE_MAIN.forEach(function (n, i) { AXIS[n] = i; });
  ROUTE_SOUTH.forEach(function (n, i) { if (n !== '구로') AXIS[n] = AXIS['구로'] - i; });
  AXIS['서동탄'] = AXIS['병점'] - 0.5;

  /* 역명 → 인접 구간 */
  const ADJ = {};
  SEGMENTS.forEach(function (e) {
    (ADJ[e[0]] = ADJ[e[0]] || {})[e[1]] = e[2];
    (ADJ[e[1]] = ADJ[e[1]] || {})[e[0]] = e[2];
  });

  function normalize(name) {
    var s = String(name || '').replace(/\s*\(.*\)\s*$/, '').trim();
    if (AXIS.hasOwnProperty(s)) return s;
    if (/역$/.test(s) && AXIS.hasOwnProperty(s.slice(0, -1))) return s.slice(0, -1);
    return s;
  }

  /* 역명 표기(API는 '서울역', 화면은 '서울역' 그대로 사용) */
  const NAMES = Object.keys(AXIS);

  /* 다익스트라: 두 역 사이 최소 구간 합(분) */
  function minutesBetween(a, b) {
    a = normalize(a); b = normalize(b);
    if (!AXIS.hasOwnProperty(a) || !AXIS.hasOwnProperty(b)) return null;
    if (a === b) return 0;
    const dist = {}; const done = {}; dist[a] = 0;
    for (;;) {
      let cur = null, best = Infinity;
      for (const k in dist) { if (!done[k] && dist[k] < best) { best = dist[k]; cur = k; } }
      if (cur === null) return null;
      if (cur === b) return dist[b];
      done[cur] = true;
      const nb = ADJ[cur] || {};
      for (const n in nb) {
        const nd = dist[cur] + nb[n];
        if (!done[n] && (dist[n] === undefined || nd < dist[n])) dist[n] = nd;
      }
    }
  }

  /* 두 역 사이 경유역 목록 */
  function pathBetween(a, b) {
    a = normalize(a); b = normalize(b);
    if (!AXIS.hasOwnProperty(a) || !AXIS.hasOwnProperty(b)) return null;
    const dist = {}; const prev = {}; const done = {}; dist[a] = 0;
    for (;;) {
      let cur = null, best = Infinity;
      for (const k in dist) { if (!done[k] && dist[k] < best) { best = dist[k]; cur = k; } }
      if (cur === null) return null;
      if (cur === b) break;
      done[cur] = true;
      const nb = ADJ[cur] || {};
      for (const n in nb) {
        const nd = dist[cur] + nb[n];
        if (!done[n] && (dist[n] === undefined || nd < dist[n])) { dist[n] = nd; prev[n] = cur; }
      }
    }
    const out = [b]; let c = b;
    while (prev[c]) { c = prev[c]; out.unshift(c); }
    return out;
  }

  /* 기준역에서 한쪽 방향으로 뻗는 역 순서 */
  function sideSequence(ref, dir, count) {
    ref = normalize(ref);
    const up = dir === 'up';
    const iMain = ROUTE_MAIN.indexOf(ref);
    const iSouth = ROUTE_SOUTH.indexOf(ref);
    const southRev = ROUTE_SOUTH.slice().reverse();

    if (up) {
      if (iMain >= 0) return ROUTE_MAIN.slice(iMain + 1, iMain + 1 + count);
      if (iSouth >= 0) {
        const i = southRev.indexOf(ref);
        return southRev.slice(i + 1, i + 1 + count);
      }
      return ref === '서동탄' ? ['병점'] : [];
    }

    // 하행
    if (ref === '구로') return ROUTE_SOUTH.slice(1, 1 + count);
    if (iMain >= 0) {
      if (AXIS[ref] < AXIS['구로']) {
        // 인천지선: 하행은 인천 쪽
        return ROUTE_MAIN.slice(0, iMain).reverse().slice(0, count);
      }
      // 구로 위쪽: 하행은 구로까지 내려간 뒤 경부선 남부로 이어진다
      var iGuro = ROUTE_MAIN.indexOf('구로');
      var toGuro = ROUTE_MAIN.slice(iGuro, iMain).reverse();
      return toGuro.concat(ROUTE_SOUTH.slice(1)).slice(0, count);
    }
    if (iSouth >= 0) return ROUTE_SOUTH.slice(iSouth + 1, iSouth + 1 + count);
    if (ref === '서동탄') return ['병점'];
    return [];
  }

  /* 기준역으로 들어오는 쪽(도착측) 역 목록: 가까운 역부터 */
  function approachStations(ref, dir, count) {
    return sideSequence(ref, dir === 'up' ? 'down' : 'up', count);
  }

  /* 기준역을 지나 나가는 쪽(출발측) 역 목록 */
  function departureStations(ref, dir, count) {
    return sideSequence(ref, dir, count);
  }

  /* 방향 라벨 */
  function directionMeta(ref) {
    ref = normalize(ref);
    const inIncheon = ROUTE_MAIN.indexOf(ref) >= 0 && AXIS[ref] <= AXIS['구일'];
    if (inIncheon) {
      return {
        up: { label: '상행', hint: '구로·서울 방면', arrow: '↑' },
        down: { label: '하행', hint: '인천 방면', arrow: '↓' }
      };
    }
    return {
      up: { label: '상행', hint: '서울·청량리·연천 방면', arrow: '↑' },
      down: { label: '하행', hint: '천안·신창 방면', arrow: '↓' }
    };
  }

  function axisOf(name) {
    const n = normalize(name);
    return AXIS.hasOwnProperty(n) ? AXIS[n] : null;
  }

  /* 두 역의 상하 관계: +1 = 상행(축 증가), -1 = 하행 */
  function directionBetween(from, to) {
    const a = axisOf(from), b = axisOf(to);
    if (a === null || b === null) return 0;
    if (b > a) return 1;
    if (b < a) return -1;
    return 0;
  }

  /* 역 선택 목록: 주요 역 우선 + 전체 */
  const MAJOR = [
    '연천', '소요산', '동두천', '광운대', '청량리', '회기', '서울역', '시청',
    '용산', '노량진', '영등포', '신도림', '구로', '부평', '부천', '인천',
    '안양', '금정', '수원', '병점', '서동탄', '오산', '평택', '성환',
    '두정', '천안', '아산', '탕정', '배방', '온양온천', '신창'
  ];

  const ALL = ROUTE_MAIN.concat(ROUTE_SOUTH.filter(function (n) {
    return ROUTE_MAIN.indexOf(n) < 0;
  })).concat(['서동탄']);

  function stationList() {
    const seen = {};
    const out = [];
    ALL.forEach(function (n) {
      if (seen[n]) return;
      seen[n] = true;
      out.push({ name: n, transfer: TRANSFER[n] || '', major: MAJOR.indexOf(n) >= 0 });
    });
    return out;
  }

  global.Subway1Data = {
    SEGMENTS: SEGMENTS,
    NAMES: NAMES,
    MAJOR: MAJOR,
    TRANSFER: TRANSFER,
    normalize: normalize,
    minutesBetween: minutesBetween,
    pathBetween: pathBetween,
    approachStations: approachStations,
    departureStations: departureStations,
    directionMeta: directionMeta,
    directionBetween: directionBetween,
    axisOf: axisOf,
    stationList: stationList
  };
})(window);
