/* ============================================================
   1호선 알리미 · 역/구간 데이터
   - 수도권 전철 1호선(경부·경인·장항선) 역 순서와 인접 역 평균 소요시간(분)
   - 코레일 구간은 도착 API의 barvlDt(초)가 비어 오는 경우가 많아,
     arvlMsg2("[2]번째 전역 (성환)")나 실시간 위치(statnNm)만으로
     기준역까지 남은 시간을 계산할 수 있도록 구간 시간표를 내장한다.
   - 소요시간은 평시 기준 근사값(역간 2~6분)이며, 실제 운행과는
     ±1~2분 차이가 날 수 있다.
   - 출발역 → 도착역을 받으면 노선 그래프에서 방향(상·하행), 경로,
     그리고 "이 종착역이 도착역까지 실제로 닿는지"를 판정한다.
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

  /* 노선 경로(역 순서). 축 값이 커지는 방향이 상행(서울·청량리·연천 방면) */
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

  /* 검색 별칭: 헷갈리기 쉬운 이름 → 1호선 역명 */
  const ALIASES = {
    '천안아산': '아산',
    '천안아산역': '아산',
    '천안아산(KTX)': '아산',
    '서울': '서울역',
    '서울역(KTX)': '서울역',
    '서울역ktx': '서울역',
    '청량리역': '청량리',
    '수원역': '수원',
    '인천역': '인천',
    '부평역': '부평',
    '평택역': '평택'
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

  function isStation(name) {
    return AXIS.hasOwnProperty(normalize(name));
  }

  /* 검색어의 별칭 대상 역명 (없으면 '') */
  function aliasOf(query) {
    var s = String(query || '').trim();
    if (!s) return '';
    var low = s.toLowerCase();
    if (ALIASES.hasOwnProperty(s)) return ALIASES[s];
    if (ALIASES.hasOwnProperty(low)) return ALIASES[low];
    var n = normalize(s);
    if (ALIASES.hasOwnProperty(n)) return ALIASES[n];
    if (ALIASES.hasOwnProperty(n.toLowerCase())) return ALIASES[n.toLowerCase()];
    if (AXIS.hasOwnProperty(n)) return n;
    return '';
  }

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

  /* 두 역 사이 경유역 목록(최단 경로) */
  function pathBetween(a, b) {
    a = normalize(a); b = normalize(b);
    if (!AXIS.hasOwnProperty(a) || !AXIS.hasOwnProperty(b)) return null;
    if (a === b) return [a];
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

  /* 출발역에서 도착역으로 갈 때의 진행 방향: 'up' | 'down' | null
     (막다른 지선·같은 역이면 null. 첫 구간의 축 변화로 판단한다) */
  function dirToward(from, to) {
    from = normalize(from); to = normalize(to);
    if (from === to) return null;
    const p = pathBetween(from, to);
    if (!p || p.length < 2) return null;
    const a = AXIS[p[0]], b = AXIS[p[1]];
    if (a === undefined || b === undefined) return null;
    return b > a ? 'up' : 'down';
  }

  /* 종착역(terminal)이 출발역 → 도착역 구간을 지나 도착역까지 닿는지
     true = 탈 수 있음, false = 도착역 전에 끝남, null = 역명을 모름 */
  function reaches(dep, arr, terminal) {
    dep = normalize(dep); arr = normalize(arr);
    const t = normalize(terminal);
    if (!t || !AXIS.hasOwnProperty(t) || !AXIS.hasOwnProperty(dep) || !AXIS.hasOwnProperty(arr)) return null;
    if (t === dep) return false;
    const p = pathBetween(dep, t);
    if (!p) return null;
    return p.indexOf(arr) >= 0;
  }

  /* 경로의 정거장 수(구간 수) */
  function stopsBetween(a, b) {
    const p = pathBetween(a, b);
    return p ? p.length - 1 : null;
  }

  /* 출발역에서 도착역 방향으로 이어지는 역 목록(가까운 역부터) */
  function routeAhead(dep, arr, count) {
    const p = pathBetween(dep, arr);
    if (!p || p.length < 2) return [];
    return p.slice(1, 1 + count);
  }

  /* 출발역으로 들어오는 쪽 역 목록(도착역 반대편, 가까운 역부터)
     - 출발역에서 도착역으로 나가는 첫 구간을 뺀 나머지 이웃에서
       노선 본선 쪽(축 값이 큰 쪽)을 따라간다. */
  function incomingSide(dep, arr, count) {
    dep = normalize(dep); arr = normalize(arr);
    const p = pathBetween(dep, arr);
    const outgoing = p && p.length > 1 ? p[1] : null;
    const seen = {}; seen[dep] = true;

    function nextFrom(cur) {
      const cand = Object.keys(ADJ[cur] || {}).filter(function (n) {
        return !seen[n] && n !== outgoing;
      });
      cand.sort(function (a, b) {
        const av = AXIS[a] === undefined ? -1e9 : AXIS[a];
        const bv = AXIS[b] === undefined ? -1e9 : AXIS[b];
        return bv - av;
      });
      return cand.length ? cand[0] : null;
    }

    var cur = nextFrom(dep);
    const out = [];
    for (var i = 0; i < count && cur; i++) {
      out.push(cur);
      seen[cur] = true;
      cur = nextFrom(cur);
    }
    return out;
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

  /* 역 검색(별칭 포함): '천안아산' → 아산 처럼 헷갈리는 이름도 찾아 준다 */
  function searchStations(query) {
    const raw = String(query || '').trim();
    const n = normalize(raw);
    const alias = aliasOf(raw);
    const list = stationList();
    if (!raw) return list;
    return list.filter(function (s) {
      if (s.name.indexOf(n) >= 0) return true;
      return !!alias && s.name === alias;
    }).map(function (s) {
      const byAlias = !!alias && s.name === alias && s.name.indexOf(n) < 0;
      return { name: s.name, transfer: s.transfer, major: s.major, alias: byAlias };
    });
  }

  global.Subway1Data = {
    SEGMENTS: SEGMENTS,
    NAMES: NAMES,
    MAJOR: MAJOR,
    TRANSFER: TRANSFER,
    ALIASES: ALIASES,
    normalize: normalize,
    isStation: isStation,
    aliasOf: aliasOf,
    minutesBetween: minutesBetween,
    pathBetween: pathBetween,
    dirToward: dirToward,
    reaches: reaches,
    stopsBetween: stopsBetween,
    routeAhead: routeAhead,
    incomingSide: incomingSide,
    directionBetween: directionBetween,
    axisOf: axisOf,
    stationList: stationList,
    searchStations: searchStations
  };
})(window);
