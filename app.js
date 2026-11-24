/* ============================================================
   1호선 알리미 · app.js
   - 출발역 → 도착역을 고르면 노선 그래프(stations.js)로 진행 방향과
     경로를 정하고, 그 종착역이 도착역까지 실제로 닿는 열차만 판정한다.
     예) 두정 → 아산 : 천안행은 천안에서 끝나므로 제외, 신창행만 표시
   - 서울시 실시간 도착정보(OA-12764) / 열차 위치(OA-12601) 클라이언트
   - 코레일 구간(두정·천안 등)은 barvlDt가 비어 오므로
     arvlMsg2/arvlMsg3/실시간 위치를 역간 소요시간으로 환산해 도착 시각을 추정
   - API 키가 없으면 두정역 실데이터 형식의 데모 시뮬레이션으로 동작
   ============================================================ */
(function () {
  'use strict';

  var D = window.Subway1Data;
  var LS_KEY = 'subway1.settings.v2';
  var LS_OLD = 'subway1.settings.v1';
  var API_BASE = 'http://swopenAPI.seoul.go.kr/api/subway';
  var REFRESH_SEC = 30;
  var BOARD_MARGIN = 1; // 분: 승강장 도착 후 최소 여유
  var LIST_MAX = 4;     // 다가오는 열차 목록에 보여 줄 최대 대수

  // 배포된 Cloudflare Worker 프록시(https+CORS 중계). 열자마자 실시간 LIVE로 동작
  var DEFAULT_PROXY = 'https://subway-proxy.chldbxo.workers.dev';

  var DEFAULTS = {
    source: 'proxy',  // demo | key | proxy
    key: '',
    proxy: DEFAULT_PROXY,
    walk: 10,
    dep: '두정',
    arr: '아산',
    auto: true,
    ready: false      // 준비하기(출발 벨소리) 켜 둔 상태
  };

  /* ── 상태 ──────────────────────────────────────────── */
  var S = {
    s: loadSettings(),
    tab: 'down',
    data: { up: [], down: [] },
    meta: { mode: 'demo', fetchedAt: 0, error: '', lastTrainsAt: 0, positions: 0, added: 0 },
    countdown: REFRESH_SEC,
    loading: false,
    ticker: null
  };
  S.tab = D.dirToward(S.s.dep, S.s.arr) || 'down';

  /* 출발 벨소리 상태 */
  var ready = {
    armed: false,
    ringing: false,
    latched: false,
    timer: null,
    ctx: null,
    wake: null,
    beats: 0
  };

  var el = {};
  var sheetTarget = 'dep';

  /* 즐겨찾기 역(★) — 역 선택 목록 맨 위에 고정 */
  var LS_FAV = 'subway1.favorites.v1';
  var FAV = loadFavorites();

  /* ── 저장소 ────────────────────────────────────────── */
  function loadSettings() {
    var out = {}, k, raw = null;
    for (k in DEFAULTS) out[k] = DEFAULTS[k];
    try {
      raw = localStorage.getItem(LS_KEY) || localStorage.getItem(LS_OLD);
    } catch (e) { raw = null; }
    if (raw) {
      try {
        var parsed = JSON.parse(raw);
        for (var key in out) {
          if (parsed[key] !== undefined && parsed[key] !== null) out[key] = parsed[key];
        }
        // v1(기준역 + 상·하행) 설정 이어받기
        if (parsed.dep === undefined && parsed.station) out.dep = D.normalize(parsed.station);
      } catch (e) { /* 저장소가 깨졌으면 기본값 */ }
    }
    // 예전 버전에서 데모로 저장된 설정(프록시 주소 없음)은 실시간 프록시로 승격
    if (out.source === 'demo' && !out.proxy) {
      out.source = 'proxy';
      out.proxy = DEFAULT_PROXY;
    }
    out.walk = Math.min(30, Math.max(1, parseInt(out.walk, 10) || 10));
    if (!D.isStation(out.dep)) out.dep = '두정';
    out.arr = D.normalize(out.arr);
    if (!D.isStation(out.arr) || out.arr === out.dep) out.arr = out.dep === '아산' ? '두정' : '아산';
    out.auto = out.auto !== false;
    out.ready = !!out.ready;
    return out;
  }

  function saveSettings() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(S.s)); } catch (e) {}
  }

  function loadFavorites() {
    var out = [];
    var raw = null;
    try { raw = localStorage.getItem(LS_FAV); } catch (e) { raw = null; }
    if (!raw) return out;
    try {
      var arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return out;
      arr.forEach(function (n) {
        var v = D.normalize(n);
        if (D.isStation(v) && out.indexOf(v) < 0) out.push(v);
      });
    } catch (e) { /* 깨진 저장소는 빈 목록으로 */ }
    return out;
  }

  function saveFavorites() {
    try { localStorage.setItem(LS_FAV, JSON.stringify(FAV)); } catch (e) {}
  }

  function isFav(name) {
    return FAV.indexOf(D.normalize(name)) >= 0;
  }

  function toggleFav(name) {
    var n = D.normalize(name);
    if (!D.isStation(n)) return;
    var i = FAV.indexOf(n);
    if (i >= 0) {
      FAV.splice(i, 1);
      showToast(n + '역 즐겨찾기 해제');
    } else {
      FAV.push(n);
      showToast(n + '역을 맨 위에 고정했어요');
    }
    saveFavorites();
    // 목록을 다시 그려도 보던 위치를 유지한다
    var scroller = el.stationList ? el.stationList.parentNode : null;
    var top = scroller ? scroller.scrollTop : 0;
    renderStationList(el.stationSearch ? el.stationSearch.value : '');
    if (scroller) scroller.scrollTop = top;
  }

  /* ── 유틸 ──────────────────────────────────────────── */
  function $(id) { return document.getElementById(id); }

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  function clock(ts) {
    var d = new Date(ts);
    return pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function clockSec(ts) {
    var d = new Date(ts);
    return clock(ts) + ':' + pad(d.getSeconds());
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function stationLabel(name) {
    return /역$/.test(name) ? name : name + '역';
  }

  function showToast(msg) {
    var t = el.toast;
    if (!t) return;
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(function () { t.classList.add('hidden'); }, 2400);
  }

  function parseRecptn(str) {
    if (!str) return NaN;
    var m = String(str).match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/);
    if (!m) return NaN;
    return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
  }

  function routeDir() { return D.dirToward(S.s.dep, S.s.arr) || 'down'; }
  function routeLabel() { return routeDir() === 'up' ? '상행' : '하행'; }
  function routeArrow() { return routeDir() === 'up' ? '↑' : '↓'; }

  /* ── 도착 메시지 해석 ──────────────────────────────── */
  /* 예: "[2]번째 전역 (성환)", "3분 후 (천안)", "당역 도착", "전역 출발" */
  function parseMessage(text) {
    var msg = String(text || '').replace(/\s+/g, ' ').trim();
    if (!msg) return null;

    var m = msg.match(/\[?(\d+)\]?\s*번째\s*전역/);
    if (m) {
      var pm = msg.match(/\(([^)]+)\)/);
      return { count: parseInt(m[1], 10), station: pm ? D.normalize(pm[1]) : null };
    }

    if (/전역\s*(출발|도착|진입)/.test(msg) || /전역$/.test(msg)) {
      return { count: 1, station: null };
    }

    if (/당역|이번\s*역|도착|진입/.test(msg)) {
      if (/진입/.test(msg)) return { sec: 25 };
      return { sec: 5 };
    }

    var mm = msg.match(/(\d+)\s*분\s*(후|뒤|남음)?/);
    if (mm) {
      var pm2 = msg.match(/\(([^)]+)\)/);
      return { sec: parseInt(mm[1], 10) * 60, station: pm2 ? D.normalize(pm2[1]) : null };
    }

    if (/곧|잠시|조금/.test(msg)) return { sec: 40 };

    var ss = msg.match(/(\d+)\s*초/);
    if (ss) return { sec: parseInt(ss[1], 10) };

    return null;
  }

  function stationMinutes(from, ref, express) {
    if (!from) return null;
    var mins = D.minutesBetween(from, ref);
    if (mins == null) return null;
    if (express) mins = mins * 0.85;
    return mins;
  }

  /* ── 도착 정보 분석 ────────────────────────────────── */
  function analyze(raw, ref, dir, arr) {
    var express = /급행|특급|ITX/i.test(raw.btrainSttus || '') || /급행/.test(raw.trainLineNm || '');
    var itx = /ITX/i.test(raw.btrainSttus || '') || /ITX/.test(raw.trainLineNm || '');
    var recptn = parseRecptn(raw.recptnDt);
    var age = isFinite(recptn) ? Math.max(0, (Date.now() - recptn) / 1000) : 0;
    var msg2 = String(raw.arvlMsg2 || '');
    var msg3 = String(raw.arvlMsg3 || '');
    var arvlCd = String(raw.arvlCd || '');
    var etaSec = null;
    var source = '';
    var atStation = null;
    var away = null;
    var stateLabel = '';

    // 1) 이미 역에 진입/도착/출발한 상태
    if (arvlCd === '0') { etaSec = 20; source = 'state'; stateLabel = '진입'; }
    else if (arvlCd === '1') { etaSec = 4; source = 'state'; stateLabel = '도착'; }
    else if (arvlCd === '2') { etaSec = 0; source = 'state'; stateLabel = '출발'; }

    // 2) 도착예정시간(초) — 서울교통공사 구간은 정확히 내려온다
    var barvl = parseInt(raw.barvlDt, 10);
    if (etaSec === null && isFinite(barvl) && barvl > 0 && barvl <= 5400) {
      etaSec = Math.max(0, barvl - Math.min(age, 120));
      source = 'barvlDt';
    }

    // 3) 메시지 파싱 — 코레일 구간의 주 경로
    function applyMessage(text) {
      var p = parseMessage(text);
      if (!p) return false;
      if (p.sec != null) {
        etaSec = p.sec;
        source = 'msg';
        if (/진입/.test(text)) stateLabel = '진입';
        else if (/도착/.test(text)) stateLabel = '도착';
        else if (/출발/.test(text)) stateLabel = '출발';
        return true;
      }
      var st = p.station;
      var count = p.count;
      if (!st && count) {
        // 메시지에 역명이 없으면 출발역으로 들어오는 쪽 역 목록에서 찾는다
        var appr = D.incomingSide(ref, arr, count);
        st = appr[count - 1] || null;
      }
      if (st) {
        var mins = stationMinutes(st, ref, express);
        if (mins != null) {
          var dirSign = D.directionBetween(st, ref);
          if (dirSign === 0) { etaSec = 10; }
          else {
            etaSec = Math.max(15, (mins - 0.5) * 60);
          }
          atStation = st;
          away = count || null;
          if (!stateLabel) stateLabel = '전역';
          source = 'msg';
          return true;
        }
      }
      return false;
    }

    if (etaSec === null) {
      if (!applyMessage(msg2)) applyMessage(msg3);
    } else if (source === 'barvlDt') {
      // 위치 설명용 역명만 확보
      var p2 = parseMessage(msg2);
      if (p2 && p2.station) { atStation = p2.station; away = p2.count || null; }
    }

    return {
      raw: raw,
      dir: dir,
      express: express,
      itx: itx,
      lastTrain: String(raw.lstcarAt) === '1' || /막차/.test(raw.trainLineNm || ''),
      etaSec: etaSec,
      source: source,
      atStation: atStation,
      away: away,
      stateLabel: stateLabel,
      msg2: msg2,
      msg3: msg3,
      dest: raw.bstatnNm || destFromLineNm(raw.trainLineNm),
      trainNo: raw.btrainNo || '',
      reaches: null,
      baseAt: Date.now()
    };
  }

  /* 도착정보는 "상행"/"하행", 위치정보는 "0"/"1" 로 내려온다 */
  function dirOf(value) {
    var v = String(value == null ? '' : value).trim();
    if (v === '0' || v === '상행' || v === '상행선' || v === '내선') return 'up';
    if (v === '1' || v === '하행' || v === '하행선' || v === '외선') return 'down';
    return null;
  }

  function destFromLineNm(nm) {
    var m = String(nm || '').match(/^([^\s(]+)행/);
    return m ? m[1] : '';
  }

  /* 원시 도착정보 → 경로 기준으로 방향·도달 가능 여부를 붙인 열차 객체 */
  function routeTrain(raw, dep, arr) {
    var dest = D.normalize(raw.bstatnNm || destFromLineNm(raw.trainLineNm));
    var fallback = dirOf(raw.updnLine) || routeDir();
    var dir = D.dirToward(dep, dest) || fallback;
    var t = analyze(raw, dep, dir, arr);
    t.dest = dest;
    t.reaches = D.reaches(dep, arr, dest);
    return t;
  }

  function applyPosition(train, pos, ref, arr) {
    if (!pos || !pos.statnNm) return false;

    // 종착역을 실시간 위치 정보에서 보완 (statnTnm = 열차 종착역)
    if (!train.dest && pos.statnTnm) {
      var td = D.normalize(pos.statnTnm);
      if (td) {
        train.dest = td;
        var dd = D.dirToward(ref, td);
        if (dd) train.dir = dd;
        train.reaches = D.reaches(ref, arr, td);
      }
    }

    var st = D.normalize(pos.statnNm);
    var mins = stationMinutes(st, ref, train.express);
    if (mins == null) return false;
    // 지나간 역이면 무시
    var sign = train.dir === 'up' ? 1 : -1;
    if (D.directionBetween(st, ref) !== sign) return false;
    if (String(pos.directAt) === '1') train.express = true;
    var sttus = String(pos.trainSttus || '');
    var adj = mins;
    if (sttus === '0') adj -= 0.35;      // 진입
    else if (sttus === '1') adj -= 0.6;  // 도착
    else if (sttus === '2' || sttus === '3') adj -= 0.45; // 출발/전역출발
    else adj -= 0.2;
    train.etaSec = Math.max(0, adj * 60);
    train.source = 'position';
    train.atStation = st;
    train.stateLabel = train.stateLabel || (sttus === '0' ? '진입' : sttus === '1' ? '도착' : '전역');
    train.baseAt = Date.now();
    return true;
  }

  /* ── 위치 정보로 보정·보충───────────────────────── */

  /* API 역명을 1호선 데이터의 역명으로 ('서울' → '서울역', '천안아산' → '아산') */
  function apiStation(name) {
    var n = D.normalize(name);
    if (D.isStation(n)) return n;
    var alias = D.aliasOf(name);
    return alias || n;
  }

  /* 도착정보로 받은 열차들에 같은 열차번호의 위치를 붙인다.
     도착예정시간(초)처럼 정확한 값이 오는 구간은 예측치로 덮어쓰지 않고
     위치 설명만 채운다. */
  function applyPositions(trains, positions, dep, arr) {
    if (!positions || !positions.length) return;
    var byNo = {};
    positions.forEach(function (p) {
      var k = String(p.trainNo || '');
      if (k && !byNo[k]) byNo[k] = p;
    });
    trains.forEach(function (t) {
      var p = byNo[String(t.trainNo)];
      if (!p) return;
      if (t.source === 'barvlDt' || t.source === 'state') {
        var st = apiStation(p.statnNm);
        if (st && D.isStation(st) && !t.atStation) t.atStation = st;
        return;
      }
      applyPosition(t, p, dep, arr);
    });
  }

  /* 원거리 열차 보충.
     출발역 도착정보는 최대 4대뿐이라, 앞쪽이 천안행처럼 도착역 전에 끝나는
     열차로만 차 있으면 아산까지 가는 열차(신창행)가 화면에서 사라져
     고장난 것처럼 보인다. 그래서 전 노선 열차 위치(realtimePosition)에서
     지금 이 출발역으로 들어오면서 도착역까지 가는 열차를 찾아 넣는다.
     · 도착정보에 이미 있는 열차(열차번호)는 건너뛴다.
     · 이미 출발역을 지난 열차, 반대 방향 열차, 다른 지선으로 빠지는 열차는
       stations.js 의 경로 판정(catchableFrom)이 걸러낸다. */
  function supplementTrains(trains, dep, arr, positions) {
    if (!positions || !positions.length) return 0;
    var known = {};
    trains.forEach(function (t) { if (t.trainNo) known[String(t.trainNo)] = true; });
    var found = [];
    positions.forEach(function (p) {
      var no = String(p.trainNo || '');
      if (!no || known[no]) return;
      if (p.subwayId && String(p.subwayId) !== '1001') return;
      var cur = apiStation(p.statnNm);
      var term = apiStation(p.statnTnm);
      var path = D.catchableFrom(dep, arr, cur, term);
      if (!path) return;
      known[no] = true;
      found.push({ p: p, path: path, cur: cur, term: term });
    });
    found.forEach(function (x) {
      trains.push(positionTrain(x, dep, arr));
    });
    return found.length;
  }

  /* 위치 정보만으로 만든 열차 객체 — routeTrain 결과와 같은 형식 */
  function positionTrain(x, dep, arr) {
    var p = x.p;
    var sttus = String(p.trainSttus == null ? '' : p.trainSttus);
    var express = String(p.directAt) === '1';
    var mins = x.path.mins;
    if (sttus === '0') mins += 0.35;                    // 현재역 진입 중
    else if (sttus === '1') mins -= 0.1;                // 현재역 도착
    else if (sttus === '2' || sttus === '3') mins -= 0.45; // 출발·전역 출발
    else mins += 0.15;
    if (express) mins = mins * 0.85;
    var recptn = parseRecptn(p.recptnDt);
    var age = isFinite(recptn) ? Math.max(0, (Date.now() - recptn) / 1000) : 0;
    mins = Math.max(0, mins - Math.min(age, 90) / 60);

    var stateLabel = sttus === '0' ? '진입' : sttus === '1' ? '도착' : '전역';
    return {
      raw: p,
      dir: D.dirToward(dep, arr) || routeDir(),
      express: express,
      itx: false,
      lastTrain: String(p.lstcarAt) === '1',
      etaSec: Math.max(0, mins * 60),
      source: 'position',
      atStation: x.cur,
      away: x.path.stops || null,
      stateLabel: stateLabel,
      msg2: '',
      msg3: '',
      dest: x.term,
      trainNo: String(p.trainNo || ''),
      reaches: true,
      approx: true,   // 출발역 도착정보가 아니라 전 노선 위치로 잡은 열차
      baseAt: Date.now()
    };
  }

  /* ── 데모 시뮬레이션 ───────────────────────────────── */
  var DEMO_OFFSETS = [3.2, 7.9, 13.4, 19.2, 25.1, 31.0];

  /* 데모 종착역 후보: 진행 방향이 같고, 도착역 전에 끝나는 역도 섞는다 */
  function demoTrainDests(dep, arr, dir) {
    var list = [];
    D.stationList().forEach(function (s) {
      if (s.name === dep) return;
      if (D.dirToward(dep, s.name) !== dir) return;
      var min = D.minutesBetween(dep, s.name);
      if (min == null || min <= 0) return;
      list.push({ name: s.name, min: min, ok: D.reaches(dep, arr, s.name) === true });
    });
    list.sort(function (a, b) { return a.min - b.min; });
    return list;
  }

  function demoDests(dep, arr, dir) {
    var list = demoTrainDests(dep, arr, dir);
    if (!list.length) return [];
    var before = list.filter(function (x) { return !x.ok; });
    var after = list.filter(function (x) { return x.ok; });
    var out = [];
    function add(x) { if (x && out.length < 6) out.push(x.name); }
    // 가까운 곳에서 끝나는 열차(필터 확인용)와 도착역까지 가는 열차를 섞는다
    add(before[0]);
    add(after[0]);
    add(before[1]);
    add(after[1]);
    add(after[after.length - 1]);
    add(after[2]);
    if (!out.length) add(list[0]);
    while (out.length < 6) out.push(out[out.length - 1] || list[0].name);
    return out.slice(0, 6);
  }

  function demoPosition(dep, arr, etaMin) {
    var appr = D.incomingSide(dep, arr, 10);
    if (!appr.length) return null;
    var nodes = [];
    var dist = 0;
    var prev = dep;
    for (var i = 0; i < appr.length; i++) {
      var seg = D.minutesBetween(appr[i], prev);
      dist += (seg == null ? 2 : seg);
      nodes.push({ name: appr[i], dist: dist });
      prev = appr[i];
    }
    var k = 0;
    for (var j = 0; j < nodes.length; j++) {
      if (nodes[j].dist >= etaMin) { k = j; break; }
      k = j;
    }
    return { nodes: nodes, k: k };
  }

  function buildDemo(dep, arr) {
    var dir = routeDir();
    var dests = demoDests(dep, arr, dir);
    if (!dests.length) return [];
    var nowSec = Date.now() / 1000;
    var period = 36 * 60;
    var hour = new Date().getHours();
    var out = [];

    DEMO_OFFSETS.forEach(function (off, i) {
      var etaSec = ((off * 60 - nowSec) % period + period) % period;
      var etaMin = etaSec / 60;
      var dest = dests[i % dests.length];
      var ddir = D.dirToward(dep, dest) || dir;
      var pos = demoPosition(dep, arr, etaMin);
      var msg2 = '';
      var arvlCd = '99';
      var barvlDt = '';

      if (etaMin <= 0.4) {
        msg2 = '당역 도착';
        arvlCd = '1';
      } else if (pos) {
        msg2 = '[' + (pos.k + 1) + ']번째 전역 (' + pos.nodes[pos.k].name + ')';
      } else {
        msg2 = '전역 진입';
        arvlCd = '4';
      }

      // 절반의 열차는 서울교통공사처럼 초 단위 도착예정시간이 함께 온다
      if (i % 2 === 0 && etaSec > 30) barvlDt = String(Math.round(etaSec));

      var type = i % 5 === 3 ? 'ITX' : (i % 3 === 1 ? '급행' : '일반');

      out.push({
        subwayId: '1001',
        updnLine: ddir === 'up' ? '0' : '1',
        trainLineNm: dest + '행(' + (type === '일반' ? '일반' : type) + ') - ' + dep + '방면',
        btrainSttus: type,
        barvlDt: barvlDt,
        btrainNo: String(4100 + i * 37),
        bstatnNm: dest,
        arvlCd: arvlCd,
        arvlMsg2: msg2,
        arvlMsg3: etaMin < 1 ? '곧 도착' : Math.round(etaMin) + '분 후 (' + (pos ? pos.nodes[pos.k].name : dep) + ')',
        lstcarAt: ((hour >= 22 || hour < 2) && i === DEMO_OFFSETS.length - 1) ? '1' : '0',
        recptnDt: fmtStamp(new Date())
      });
    });

    return out;
  }

  function fmtStamp(d) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
      pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  /* ── API 호출 ──────────────────────────────────────── */
  function apiUrl(service, args) {
    if (S.s.source === 'proxy' && S.s.proxy) {
      return S.s.proxy.replace(/\/+$/, '') + '/' + service + '/' + args.join('/');
    }
    if (S.s.source === 'key' && S.s.key) {
      return API_BASE + '/' + encodeURIComponent(S.s.key) + '/json/' + service + '/' + args.join('/');
    }
    return null;
  }

  /* 서울시 API의 정상/빈 데이터 응답인지 판별.
     서울시는 정상일 때도 errorMessage.code(INFO-000/INFO-200)를 함께 내려준다.
     배포된 프록시(Worker)가 이 정상 본문을 HTTP 502로 감싸 보내는 경우가 있어,
     상태 코드만으로 실패를 판단하지 않는다. */
  function isUsableSubwayJson(json) {
    if (!json || typeof json !== 'object') return false;
    if (Array.isArray(json.realtimeArrivalList) || Array.isArray(json.realtimePositionList)) return true;
    var code = (json.errorMessage && json.errorMessage.code) || json.code ||
      (json.RESULT && json.RESULT.CODE) || '';
    return code === 'INFO-000' || code === 'INFO-200';
  }

  function fetchJsonOnce(url) {
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, 12000);
    return fetch(url, { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined })
      .then(function (res) {
        return res.text().then(function (text) {
          var json = null;
          try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
          if (json && (res.ok || isUsableSubwayJson(json))) return json;
          if (!json) {
            throw new Error('응답이 JSON이 아니에요 (HTTP ' + res.status + ' · 프록시 주소를 확인해 주세요)');
          }
          throw new Error('HTTP ' + res.status);
        });
      })
      .finally(function () { clearTimeout(timer); });
  }

  function fetchJson(url) {
    return fetchJsonOnce(url).catch(function (err) {
      var msg = String((err && err.message) || err);
      var retriable = /^HTTP 5\d\d$/.test(msg) || msg.indexOf('JSON이 아니에요') >= 0 ||
        (err && err.name === 'TypeError');
      if (err && err.name === 'AbortError') retriable = false; // 시간 초과는 재시도해도 같다
      if (!retriable) throw err;
      // 5xx 빈 응답·일시적 네트워크 실패는 0.9초 뒤 한 번만 다시 시도
      return new Promise(function (resolve) { setTimeout(resolve, 900); })
        .then(function () { return fetchJsonOnce(url); });
    });
  }

  function readList(json, listKey) {
    if (json && Array.isArray(json[listKey])) return json[listKey];
    var em = json && json.errorMessage;
    var code = (em && em.code) || (json && json.code) ||
      (json && json.RESULT && json.RESULT.CODE) || '';
    var msg = (em && (em.message || em.code)) || (json && json.message) ||
      (json && json.RESULT && json.RESULT.MESSAGE) || '';
    // INFO-000(정상) · INFO-200(해당 데이터 없음)은 오류가 아니라 빈 목록
    if (code === 'INFO-000' || code === 'INFO-200') return [];
    if (code) throw new Error('API 오류 ' + code + ' ' + msg);
    if (json && json.ok === false) throw new Error(json.error || '프록시 오류');
    return [];
  }

  function fetchArrivals(stationName) {
    var url = apiUrl('realtimeStationArrival', [0, 30, encodeURIComponent(stationName)]);
    if (!url) return Promise.reject(new Error('데이터 소스가 설정되지 않았어요'));
    return fetchJson(url).then(function (json) {
      var list = readList(json, 'realtimeArrivalList');
      return list.filter(function (r) { return String(r.subwayId) === '1001'; });
    });
  }

  function fetchPositions() {
    var url = apiUrl('realtimePosition', [0, 300, encodeURIComponent('1호선')]);
    if (!url) return Promise.resolve([]);
    return fetchJson(url).then(function (json) {
      return readList(json, 'realtimePositionList');
    }).catch(function () { return []; });
  }

  /* ── 데이터 갱신 ───────────────────────────────────── */
  function bucket(trains) {
    var up = [], down = [];
    trains.forEach(function (t) { (t.dir === 'up' ? up : down).push(t); });
    return { up: sortByEta(up), down: sortByEta(down) };
  }

  function refresh() {
    var dep = S.s.dep;
    var arr = S.s.arr;
    S.countdown = REFRESH_SEC;
    S.loading = true;
    var mode = S.s.source;

    if (mode === 'demo' || (mode === 'key' && !S.s.key) || (mode === 'proxy' && !S.s.proxy)) {
      S.data = bucket(buildDemo(dep, arr).map(function (r) { return routeTrain(r, dep, arr); }));
      S.meta = { mode: 'demo', fetchedAt: Date.now(), error: '', lastTrainsAt: Date.now(), positions: 0, added: 0 };
      S.loading = false;
      renderAll();
      return;
    }

    // https 페이지에서 http API 직접 호출은 브라우저가 막는다
    if (mode === 'key' && location.protocol === 'https:') {
      S.meta.error = '이 페이지는 https라서 http 서울시 API를 직접 부를 수 없어요. 설정에서 프록시 URL을 넣어 주세요.';
      S.meta.mode = 'demo';
      S.loading = false;
      renderAll();
      return;
    }

    // 도착정보(출발역 기준)와 전 노선 열차 위치를 함께 받아 온다.
    // 위치 정보는 ① 도착정보 열차의 위치·도착시각 보정 ② 도착정보에 없는
    // 원거리 목적지행 열차 보충 에 함께 쓰인다.
    Promise.all([fetchArrivals(dep), fetchPositions()]).then(function (res) {
      var list = res[0] || [];
      var positions = res[1] || [];
      var trains = list.map(function (raw) { return routeTrain(raw, dep, arr); });
      applyPositions(trains, positions, dep, arr);
      var added = supplementTrains(trains, dep, arr, positions);
      S.data = bucket(trains);
      S.meta = {
        mode: 'live', fetchedAt: Date.now(), error: '', lastTrainsAt: Date.now(),
        positions: positions.length, added: added
      };
    }).catch(function (err) {
      var msg = String(err && err.message || err);
      if (/Failed to fetch|NetworkError|Load failed|aborted|abort/i.test(msg)) {
        msg = '실데이터를 받지 못했어요(CORS/네트워크). 설정에서 프록시 URL을 쓰면 대부분 해결돼요.';
      }
      S.meta.error = msg;
      if (!S.data.up.length && !S.data.down.length) {
        S.data = bucket(buildDemo(dep, arr).map(function (r) { return routeTrain(r, dep, arr); }));
        S.meta.mode = 'demo';
      }
    }).then(function () {
      S.loading = false;
      renderAll();
    });
  }

  function sortByEta(list) {
    return list.sort(function (a, b) {
      return (a.etaSec == null ? 1e9 : a.etaSec) - (b.etaSec == null ? 1e9 : b.etaSec);
    });
  }

  /* ── 도착역까지 가는 열차만 ────────────────────────── */
  function visibleRows() {
    var all = S.data[S.tab] || [];
    var kept = [];
    var excluded = [];
    all.forEach(function (t) {
      if (t.reaches === false) { excluded.push(t.dest || '행선지 미상'); return; }
      kept.push(t);
    });
    return { kept: kept, excluded: excluded.length, excludedDests: excluded, total: all.length };
  }

  /* ── 계산: 지금 나가야 할까? ───────────────────────── */
  function liveEta(t, now) {
    if (t.etaSec == null) return null;
    var passed = (now - t.baseAt) / 1000;
    return Math.max(0, t.etaSec - passed);
  }

  function judgeTrains(list, walk, now) {
    var out = [];
    list.forEach(function (t) {
      var eta = liveEta(t, now);
      if (eta == null) { out.push({ t: t, eta: null }); return; }
      if (eta < -90) return; // 이미 떠난 열차
      var etaMin = eta / 60;
      var slack = etaMin - walk;
      var kind, departIn;
      if (slack < -0.5) { kind = 'miss'; departIn = 0; }
      else if (slack <= 1.5) { kind = 'go'; departIn = 0; }
      else { kind = 'wait'; departIn = Math.max(1, Math.ceil(etaMin - walk - BOARD_MARGIN)); }
      out.push({ t: t, eta: eta, etaMin: etaMin, slack: slack, kind: kind, departIn: departIn });
    });
    return out.sort(function (a, b) {
      return (a.eta == null ? 1e9 : a.eta) - (b.eta == null ? 1e9 : b.eta);
    });
  }

  function verdictFor(rows, walk, view) {
    rows = rows.filter(function (r) { return r.eta != null; });
    if (!rows.length) {
      if (!S.meta.fetchedAt) {
        return {
          kind: 'none',
          title: '불러오는 중…',
          sub: '출발역 도착정보와 전 노선 열차 위치를 확인하고 있어요.'
        };
      }
      if (view && view.excluded) {
        return {
          kind: 'none',
          title: S.s.arr + '까지 가는 열차가 없어요',
          sub: '지금 오는 ' + view.excluded + '대는 ' + S.s.arr + ' 전에 종착해요' +
            (S.meta.positions ? ' · 1호선 전체 열차 위치에도 없어요' : '') +
            ' · 잠시 뒤 다시 확인해 주세요.'
        };
      }
      return {
        kind: 'none',
        title: S.s.arr + '까지 가는 열차가 없어요',
        sub: S.meta.positions
          ? '1호선 전체 열차 위치까지 확인했어요 · 잠시 뒤 다시 확인해 주세요.'
          : '잠시 뒤 새로고침하거나 설정에서 데이터 소스를 확인해 주세요.'
      };
    }
    var best = null;
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].eta != null && rows[i].kind !== 'miss') { best = rows[i]; break; }
    }
    if (!best) {
      var first = rows[0];
      var nearestMin = Math.round(first.etaMin);
      var needWalk = Math.max(1, Math.ceil(first.etaMin - 0.5));
      var missSub = '이동 ' + walk + '분으론 놓쳐요 · 다음 열차 ' + nearestMin + '분 뒤';
      if (needWalk >= 1 && needWalk < walk) {
        missSub += ' (이동 ' + needWalk + '분이면 탑승)';
      }
      return {
        kind: 'miss',
        title: '늦었어요',
        sub: missSub,
        best: first,
        next: first,
        missed: true
      };
    }
    var dest = (best.t.dest || '열차');
    if (best.kind === 'go') {
      var slackTxt = best.slack >= 0.5 ? ' · 여유 ' + Math.round(best.slack) + '분' : '';
      return {
        kind: 'go',
        title: '지금 출발!',
        sub: dest + '행 ' + Math.round(best.etaMin) + '분 뒤 도착' + slackTxt,
        best: best
      };
    }
    return {
      kind: 'wait',
      title: best.departIn + '분 뒤 출발',
      sub: Math.max(0, Math.round(best.slack - BOARD_MARGIN)) + '분 대기 · ' + dest + '행',
      best: best
    };
  }

  /* ── 렌더 ──────────────────────────────────────────── */
  function renderAll() {
    renderStation();
    renderLive();
  }

  function renderStation() {
    el.depName.textContent = S.s.dep;
    el.arrName.textContent = S.s.arr;
    el.walkValue.textContent = S.s.walk;
    syncWalkButtons();
    el.autoToggle.checked = !!S.s.auto;
    renderReady();
  }

  function syncWalkButtons() {
    el.walkMinus.disabled = S.s.walk <= 1;
    el.walkPlus.disabled = S.s.walk >= 30;
  }

  function renderLive() {
    var now = Date.now();
    var view = visibleRows();
    var rows = judgeTrains(view.kept, S.s.walk, now);
    var v = verdictFor(rows, S.s.walk, view);

    renderVerdict(v, now);
    renderTrack(rows);
    renderTrainList(rows, view, now);
    renderStatus(now);
    renderReady();
    maybeAlarm(v);

    if (S.s.auto) {
      el.countdown.textContent = Math.max(0, S.countdown) + '초 뒤 갱신';
    } else {
      el.countdown.textContent = '자동 갱신 꺼짐';
    }
    el.modeBadge.className = 'badge ' + (S.meta.mode === 'demo' ? 'badge-demo' : 'badge-live');
    el.modeBadge.textContent = S.meta.mode === 'demo' ? '데모' : 'LIVE';
    el.modeText.textContent = S.meta.mode === 'demo' ? '데모 모드 · 시뮬레이션' : '실시간 데이터';
  }

  function renderVerdict(v, now) {
    var icon = v.kind === 'go' ? '🏃' : v.kind === 'wait' ? '⏳' : v.kind === 'miss' ? '😵‍💫' : '🚉';
    var departAt = v.best && v.best.eta != null ? now + v.best.eta * 1000 : null;

    var html = '<div class="v-main"><div class="v-icon" aria-hidden="true">' + icon + '</div>' +
      '<div class="v-maintext"><h2 class="v-title">' + esc(v.title) + '</h2></div></div>';

    html += '<div class="v-info">' +
      '<div class="v-stat"><span class="v-stat-label">현재시각</span>' +
      '<b class="v-stat-val">' + clock(now) + '</b></div>' +
      '<div class="v-stat"><span class="v-stat-label">열차출발</span>' +
      '<b class="v-stat-val">' + (departAt ? clock(departAt) : '–') + '</b></div>' +
      '</div>';

    el.verdictCard.setAttribute('data-kind', v.kind);
    el.verdictBody.innerHTML = html;
  }

  function renderTrack(rows) {
    var dep = S.s.dep;
    var arr = S.s.arr;
    var incoming = D.incomingSide(dep, arr, 3);
    var ahead = D.routeAhead(dep, arr, 2);

    el.trackCaption.textContent = dep + ' → ' + arr + ' · ' + routeLabel() + ' ' + routeArrow();

    if (!incoming.length && !ahead.length) {
      el.track.innerHTML = '<div class="track-empty">이 구간 열차 위치를 그릴 수 없어요</div>';
      return;
    }

    var nodes = [{ name: dep, pos: 0, here: true }];
    var p = 0, prev = dep;
    incoming.forEach(function (n) {
      var seg = D.minutesBetween(n, prev);
      p -= (seg == null ? 2 : seg);
      nodes.push({ name: n, pos: p });
      prev = n;
    });
    var q = 0, pv = dep;
    ahead.forEach(function (n) {
      var seg = D.minutesBetween(pv, n);
      q += (seg == null ? 2 : seg);
      nodes.push({ name: n, pos: q });
      pv = n;
    });

    var minPos = Math.min.apply(null, nodes.map(function (n) { return n.pos; }));
    var maxPos = Math.max.apply(null, nodes.map(function (n) { return n.pos; }));
    if (maxPos - minPos < 1) maxPos = minPos + 1;

    function xOf(pos) {
      return 8 + ((pos - minPos) / (maxPos - minPos)) * 84;
    }

    var html = '<div class="track-rail"></div>';

    // 라벨이 겹치는 역은 이름을 숨기고 점만 남긴다(출발역은 항상 표시)
    var W = el.track.clientWidth || 360;
    var estPct = function (n) {
      return ((n.name.length * 10.5) + ((n.here || n.name === arr) ? 20 : 0)) * 100 / W;
    };
    var spans = [];
    nodes.forEach(function (n) {
      if (!n.here) return;
      var x = xOf(n.pos), h = estPct(n) / 2;
      spans.push({ l: x - h, r: x + h });
    });
    nodes.forEach(function (n) {
      if (n.here) return;
      var x = xOf(n.pos), h = estPct(n) / 2;
      var clash = spans.some(function (s) { return (x - h) < (s.r + 0.8) && (x + h) > (s.l - 0.8); });
      if (clash) n.tight = true;
      else spans.push({ l: x - h, r: x + h });
    });

    nodes.forEach(function (n) {
      var isHere = !!n.here;
      var isDest = n.name === arr;
      html += '<div class="t-node' + (isHere ? ' is-here' : '') + (isDest ? ' is-dest' : '') +
        (n.tight ? ' no-label' : '') + '" style="left:' + xOf(n.pos).toFixed(2) + '%">' +
        '<span class="t-dot"></span>' +
        '<span class="t-name">' + esc(n.name) + '</span>' +
        (isHere ? '<span class="t-sub">출발역</span>' : isDest ? '<span class="t-sub">도착역</span>' : '') +
        '</div>';
    });

    // 열차 마커: 남은 시간 → 출발역에서 떨어진 분. 화면 밖 먼 열차는 왼쪽에 점선으로
    var lanes = [10, 30];
    var placed = [];
    var windowMin = Math.abs(minPos);
    rows.forEach(function (r) {
      if (r.eta == null) return;
      if (r.eta > 60 * 120) return;
      var outside = windowMin < 0.5 || r.eta / 60 > windowMin;
      var x = outside ? 5.5 : xOf(-Math.min(r.eta / 60, windowMin));
      var lane = -1;
      // 화면 밖 먼 열차는 노선 위가 아니라 왼쪽 여백에 위아래로 쌓아 보여 준다
      var order = [0, 1];
      for (var k = 0; k < order.length; k++) {
        var i = order[k];
        var busy = placed.some(function (p) { return p.lane === i && Math.abs(p.x - x) < 9; });
        if (!busy) { lane = i; break; }
      }
      if (lane < 0) return;
      placed.push({ x: x, lane: lane });
      var minTxt = r.eta < 45 ? '곧' : Math.round(r.eta / 60) + '분';
      var cls = 't-train ' + (lane ? 'lane-b' : 'lane-a') + (outside ? ' is-outside' : '') +
        (r.t.express ? ' is-exp' : '') + (r.kind === 'miss' ? ' is-late' : '') +
        (r.eta < 30 ? ' is-ref' : '');
      html += '<div class="' + cls + '" style="left:' + x.toFixed(2) + '%;top:' + lanes[lane] + 'px">' +
        '<span class="t-train-body">' + minTxt + '</span>' +
        '<span class="t-train-label">' + esc(r.t.dest || '') + '</span>' +
        '</div>';
    });

    el.track.innerHTML = html;
  }

  /* 행 오른쪽 두 줄
     · 위: 그 열차가 출발역을 떠나는 시각 (HH:MM 출발)
     · 아래: 도착역에 닿는 시각 (HH:MM 도착)
       도착 시각 = 출발 시각 + 구간 소요시간(stations.js, 급행·ITX는 0.85배) */
  function statusOf(r, now) {
    if (r.eta == null) return { cls: 'st-none', dep: '확인 중', arr: '–' };
    var cls = r.kind === 'go' ? 'st-go' : r.kind === 'wait' ? 'st-wait' : 'st-miss';
    var depAt = now + r.eta * 1000;
    var ride = stationMinutes(S.s.dep, S.s.arr, r.t.express);
    return {
      cls: cls,
      dep: clock(depAt) + ' 출발',
      arr: ride == null ? '–' : clock(depAt + ride * 60000) + ' 도착'
    };
  }

  function sourceChip(t) {
    if (t.approx) return '전 노선 위치';
    if (t.source === 'barvlDt') return '도착예정 ' + Math.round(t.etaSec) + '초';
    if (t.source === 'state') return '역 ' + (t.stateLabel || '도착');
    if (t.source === 'msg') return '메시지로 추정';
    if (t.source === 'position') return '위치로 추정';
    return '정보 없음';
  }

  function renderTrainList(rows, view, now) {
    var html = '';
    var shown = 0;
    var visible = rows.slice(0, LIST_MAX);
    var hasExpress = false;

    visible.forEach(function (r) {
      var t = r.t;
      var st = statusOf(r, now);
      if (t.express || t.itx) hasExpress = true;
      var typePill = t.itx ? '<span class="pill pill-itx">ITX</span>' :
        t.express ? '<span class="pill pill-exp">급행</span>' :
          '<span class="pill pill-normal">일반</span>';
      var lastPill = t.lastTrain ? '<span class="pill pill-last">막차</span>' : '';
      var etaTxt = r.eta == null ? '–' : (r.eta < 45 ? '곧' : String(Math.round(r.eta / 60)));
      var etaUnit = r.eta == null ? '' : (r.eta < 45 ? '도착' : '분');
      var loc = '';
      if (t.atStation) {
        var stTxt = t.stateLabel === '전역' || !t.stateLabel ? '출발' : t.stateLabel;
        loc = stationLabel(t.atStation) + ' ' + stTxt + (t.away ? ' · ' + t.away + '개 역 전' : '');
      }
      else if (t.stateLabel) loc = '출발역 ' + t.stateLabel;
      else loc = t.msg2 ? t.msg2 : '위치 확인 중';

      var reachPill = t.reaches === null && !t.dest ? '<span class="pill pill-normal">행선지 미상</span>' : '';

      html += '<article class="tcard" data-state="' + (r.eta == null ? 'none' : r.kind) + '">' +
        '<div class="tcard-eta' + (r.eta != null && r.eta < 45 ? ' is-now' : '') + '"><b>' + etaTxt + '</b><span>' + etaUnit + '</span></div>' +
        '<div class="tcard-main">' +
        '<div class="tcard-dest"><span class="tdest">' + esc(t.dest || '행선지 미상') + '<span class="to">행</span></span>' + typePill + lastPill + reachPill + '</div>' +
        '</div>' +
        '<div class="tcard-times">' +
        '<span class="tcard-status ' + st.cls + '">' + st.dep + '</span>' +
        '<span class="tcard-arr">' + st.arr + '</span>' +
        '</div>' +
        '<div class="tcard-src"><span class="tcard-loc">' + esc(loc) + '</span>' +
        '<span class="src-chip">' + esc(sourceChip(t)) + '</span>' +
        (t.trainNo ? '<span>#' + esc(t.trainNo) + '</span>' : '') +
        (r.kind === 'miss' && r.etaMin != null ? '<span>' + Math.round(-r.slack) + '분 늦어요</span>' : '') +
        '</div>' +
        '</article>';
      shown++;
    });

    el.trainList.innerHTML = html;
    var total = view.kept.length;
    el.trainCount.textContent = total
      ? routeLabel() + ' ' + total + '대' + (total > visible.length ? ' · 가까운 ' + visible.length + '대' : '')
      : '';

    if (view.excluded || S.meta.added) {
      var notes = [];
      if (view.excluded) {
        var dests = view.excludedDests.slice(0, 3).join('·');
        notes.push('도착역까지 못 가는 열차 <b>' + view.excluded + '대</b> 제외됨' +
          (dests ? ' (' + esc(dests) + '행)' : ''));
      }
      if (S.meta.added) {
        notes.push('전 노선 위치에서 <b>' + S.meta.added + '대</b>를 더 찾았어요');
      }
      el.filterNote.innerHTML = notes.join(' · ');
      el.filterNote.classList.remove('hidden');
    } else {
      el.filterNote.classList.add('hidden');
      el.filterNote.innerHTML = '';
    }

    if (hasExpress) {
      el.expNote.textContent = '급행·ITX는 정차역이 달라요 · ' + S.s.arr + '역 정차 여부를 승강장 안내로 확인하세요.';
      el.expNote.classList.remove('hidden');
    } else {
      el.expNote.classList.add('hidden');
    }

    if (!shown) {
      el.trainEmpty.classList.remove('hidden');
      if (!S.meta.fetchedAt) {
        el.trainEmpty.innerHTML = '열차 정보를 불러오는 중…';
      } else if (S.meta.error) {
        el.trainEmpty.innerHTML = '실시간 정보를 불러오지 못했어요.<br><small>' + esc(S.meta.error) + '</small>';
      } else if (S.meta.positions) {
        el.trainEmpty.innerHTML = '지금은 ' + esc(S.s.arr) + '까지 가는 열차가 없어요.<br><small>' +
          '1호선 전체 열차 위치까지 확인했어요 · 운행 시간대가 아니거나 곧 들어올 수 있어요.</small>';
      } else {
        el.trainEmpty.innerHTML = '지금은 ' + esc(S.s.arr) + '까지 가는 열차가 안 보여요.<br><small>운행 시간대가 아니거나 데이터가 비어 있어요.</small>';
      }
    } else {
      el.trainEmpty.classList.add('hidden');
    }
  }

  function renderStatus(now) {
    var txt = S.meta.mode === 'demo' ? '데모 데이터' : '서울시 실시간 데이터';
    if (S.meta.fetchedAt) txt += ' · ' + clockSec(S.meta.fetchedAt) + ' 갱신';
    el.statusMeta.textContent = txt;
    if (S.meta.error) {
      el.statusError.classList.remove('hidden');
      el.statusError.textContent = S.meta.error;
    } else {
      el.statusError.classList.add('hidden');
      el.statusError.textContent = '';
    }
  }

  /* ── 준비하기 · 출발 알람 소리 ────────────────────────
     승강장에 열차가 들어올 때 울리는 밝은 브라스 팡파르(도·미·솔 화음)를
     Web Audio로 직접 합성한다. 음원 파일을 받아 오지 않으므로 지하철
     지하처럼 네트워크가 약한 곳에서도 바로 울린다.

     소리 경로
       음(브라스 + 차임) → 재생 게인 → 컴프레서 → 마스터 → 소프트 클립 → 스피커
     · 컴프레서: 음이 겹쳐도 찢어지지 않게 눌러 주고
     · 마스터: 컴프레서 뒤에서 한 번 더 키워 폰 스피커에서도 크게
     · 소프트 클립(tanh): 0 dB를 넘어도 둥글게 눌러 찌그러짐(클리핑)을 막는다
     ─────────────────────────────────────────────────── */
  var SOUND = {
    ctx: null,
    input: null,   // 재생 게인들이 모이는 입력
    comp: null,
    master: null,
    clip: null,
    live: []       // 지금 울리는 재생 게인들(알람 끄기에서 바로 끊는다)
  };

  var ALARM = {
    master: 2.2,      // 컴프레서 뒤 최종 증폭 — 체감 음량(실측 RMS 약 -7.7 dB)
    peak: 0.96,       // 소프트 클립이 넘지 않는 최대치
    threshold: -13,   // 컴프레서 문턱(dB)
    ratio: 6,         // 문턱을 넘은 만큼 눌러 주는 비율
    knee: 10,
    attack: 0.004,
    release: 0.22,
    note: 0.46,       // 음 하나의 기준 음량
    drive: 1.15       // 소프트 클립 곡선의 세기
  };

  /* 승강장 도착 팡파르 — 솔-도-미-솔로 올라가 두 번 울리고 마지막 음을 길게 끈다.
     t: 시작(초) · d: 길이(초) · v: 세기 · bell: 차임 겹치기 · chord: 화음 */
  var PITCH = {
    G4: 392.00, C5: 523.25, E5: 659.25, G5: 783.99, C6: 1046.50, E6: 1318.51
  };

  var MELODY = [
    /* 1구절 — 빠밤, 빠바밤~ (도 미 솔 도) */
    { f: PITCH.G4, t: 0.00, d: 0.11, v: 0.55 },
    { f: PITCH.C5, t: 0.12, d: 0.11, v: 0.70 },
    { f: PITCH.E5, t: 0.25, d: 0.12, v: 0.80 },
    { f: PITCH.G5, t: 0.39, d: 0.30, v: 1.00, bell: 1 },
    { f: PITCH.E5, t: 0.74, d: 0.10, v: 0.60 },
    { f: PITCH.G5, t: 0.85, d: 0.10, v: 0.75 },
    { f: PITCH.C6, t: 0.97, d: 0.55, v: 1.00, bell: 1, chord: [PITCH.E5, PITCH.G5] },
    /* 2구절 — 같은 리듬을 한 옥타브 위에서 한 번 더 */
    { f: PITCH.G5, t: 1.62, d: 0.11, v: 0.60 },
    { f: PITCH.C6, t: 1.74, d: 0.11, v: 0.80 },
    { f: PITCH.E6, t: 1.87, d: 0.11, v: 0.55 },
    { f: PITCH.G5, t: 2.01, d: 0.10, v: 0.60 },
    { f: PITCH.C6, t: 2.13, d: 0.10, v: 0.80 },
    { f: PITCH.C6, t: 2.26, d: 0.85, v: 1.00, bell: 1, chord: [PITCH.G5, PITCH.E5] }
  ];

  var INTRO_SEC = 0.72;   // 준비하기를 누를 때 들려줄 앞소절(도-미-솔-도)
  var RING_EVERY = 3400;  // 알람 반복 간격 — 멜로디 3.1초 + 숨 고르기

  /* tanh 소프트 클립 곡선 — 최대 ±ALARM.peak 안에서 둥글게 눌러 준다 */
  function softCurve(n, drive) {
    var curve = new Float32Array(n);
    var k = Math.tanh(drive);
    for (var i = 0; i < n; i++) {
      var x = (i / (n - 1)) * 2 - 1;
      curve[i] = ALARM.peak * Math.tanh(x * drive) / k;
    }
    return curve;
  }

  function buildSound() {
    var ctx = ready.ctx;
    if (!ctx) return null;
    if (SOUND.input && SOUND.ctx === ctx) return SOUND;

    var input = ctx.createGain();
    input.gain.value = 1;

    var comp = ctx.createDynamicsCompressor();
    comp.threshold.value = ALARM.threshold;
    comp.knee.value = ALARM.knee;
    comp.ratio.value = ALARM.ratio;
    comp.attack.value = ALARM.attack;
    comp.release.value = ALARM.release;

    var master = ctx.createGain();
    master.gain.value = ALARM.master;

    var clip = ctx.createWaveShaper();
    clip.curve = softCurve(1024, ALARM.drive);
    clip.oversample = '4x';

    input.connect(comp);
    comp.connect(master);
    master.connect(clip);
    clip.connect(ctx.destination);

    SOUND.ctx = ctx;
    SOUND.input = input;
    SOUND.comp = comp;
    SOUND.master = master;
    SOUND.clip = clip;
    SOUND.live = [];
    return SOUND;
  }

  function unlockAudio() {
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      if (!ready.ctx) ready.ctx = new AC();
      if (ready.ctx.state === 'suspended') ready.ctx.resume();
      return !!buildSound();
    } catch (e) { return false; }
  }

  /* 이번 재생 전용 게인 — '알람 끄기'에서 이 게인만 0으로 내려 바로 끊는다 */
  function liveGain() {
    var ctx = ready.ctx;
    var g = ctx.createGain();
    g.gain.value = 1;
    g.connect(SOUND.input);
    SOUND.live.push(g);
    setTimeout(function () {
      var i = SOUND.live.indexOf(g);
      if (i >= 0) SOUND.live.splice(i, 1);
      try { g.disconnect(); } catch (e) {}
    }, 5200);
    return g;
  }

  /* 브라스 한 음 — 톱니 두 겹 + 한 옥타브 아래 사각파를 저역통과에 물려
     팡파르 특유의 밝고 두꺼운 소리를 만든다 */
  function brassVoice(dest, freq, at, dur, amp) {
    var ctx = ready.ctx;
    var out = ctx.createGain();
    var tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.Q.value = 1.2;
    tone.frequency.setValueAtTime(Math.min(11000, freq * 6), at);
    tone.frequency.exponentialRampToValueAtTime(
      Math.max(600, freq * 2.2), at + Math.max(0.12, dur * 0.55));

    var a = ctx.createOscillator();
    a.type = 'sawtooth';
    a.frequency.setValueAtTime(freq * 0.982, at);   // 살짝 올려 부는 어택
    a.frequency.exponentialRampToValueAtTime(freq, at + 0.03);
    a.detune.setValueAtTime(-5, at);

    var b = ctx.createOscillator();
    b.type = 'sawtooth';
    b.frequency.setValueAtTime(freq, at);
    b.detune.setValueAtTime(7, at);

    var sub = ctx.createOscillator();
    sub.type = 'square';
    sub.frequency.setValueAtTime(freq * 0.5, at);
    var subGain = ctx.createGain();
    subGain.gain.value = 0.22;

    a.connect(tone);
    b.connect(tone);
    sub.connect(subGain);
    subGain.connect(tone);
    tone.connect(out);
    out.connect(dest);

    out.gain.setValueAtTime(0.0001, at);
    out.gain.exponentialRampToValueAtTime(amp, at + 0.022);
    out.gain.exponentialRampToValueAtTime(amp * 0.66, at + 0.14);
    if (dur > 0.26) out.gain.setValueAtTime(amp * 0.66, at + dur - 0.06);
    out.gain.exponentialRampToValueAtTime(0.0001, at + dur);

    [a, b, sub].forEach(function (o) { o.start(at); o.stop(at + dur + 0.06); });
  }

  /* 차임 — 사인 배음이 빠르게 사그라드는 종소리. 작은 스피커에서도 또렷하다 */
  function bellVoice(dest, freq, at, dur, amp) {
    var ctx = ready.ctx;
    [[1, 1], [2.01, 0.5], [3.02, 0.24], [4.06, 0.1]].forEach(function (p) {
      var o = ctx.createOscillator();
      var g = ctx.createGain();
      o.type = 'sine';
      o.frequency.setValueAtTime(freq * p[0], at);
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(amp * p[1], at + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0001, at + dur * (p[0] === 1 ? 1 : 0.6));
      o.connect(g);
      g.connect(dest);
      o.start(at);
      o.stop(at + dur + 0.05);
    });
  }

  /* 멜로디 한 번. until(초)을 주면 그 시점까지만 잘라 울린다(앞소절 미리듣기) */
  function playMelody(until, scale) {
    var ctx = ready.ctx;
    if (!ctx || !SOUND.input) return false;
    var s = typeof scale === 'number' ? scale : 1;
    var dest = liveGain();
    var t0 = ctx.currentTime + 0.04;
    MELODY.forEach(function (n) {
      if (until && n.t >= until) return;
      var dur = Math.min(n.d, (until || 99) - n.t);
      if (dur < 0.04) return;
      var amp = ALARM.note * n.v * s;
      brassVoice(dest, n.f, t0 + n.t, dur, amp);
      if (n.chord) {
        n.chord.forEach(function (f) { brassVoice(dest, f, t0 + n.t, dur, amp * 0.45); });
      }
      if (n.bell) bellVoice(dest, n.f * 2, t0 + n.t, Math.max(0.35, dur), ALARM.note * s * 0.30);
    });
    return true;
  }

  /* 오디오 잠금이 풀렸는지 확인하고 소리를 낸다(첫 터치·일시 중단 복귀) */
  function playNow(fn) {
    unlockAudio();
    var ctx = ready.ctx;
    if (!ctx) return false;
    if (ctx.state === 'running') { fn(); return true; }
    var p = ctx.resume();
    if (p && p.then) p.then(fn, fn);
    else fn();
    return true;
  }

  /* 울리던 소리를 곧바로 멈춘다 — 예약해 둔 음까지 끊는다 */
  function cutSound() {
    var ctx = ready.ctx;
    if (!ctx || !SOUND.live.length) return;
    var t = ctx.currentTime;
    var cut = SOUND.live;
    SOUND.live = [];
    cut.forEach(function (g) {
      try {
        g.gain.cancelScheduledValues(t);
        g.gain.setValueAtTime(g.gain.value, t);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);
      } catch (e) {}
    });
    setTimeout(function () {
      cut.forEach(function (g) { try { g.disconnect(); } catch (e) {} });
    }, 200);
  }

  function vibrate() {
    if (!navigator.vibrate) return;
    try { navigator.vibrate([0, 90, 90, 90, 90, 260]); } catch (e) {}
  }

  function requestWake() {
    if (!navigator.wakeLock || ready.wake) return;
    if (!ready.armed && !ready.ringing) return;
    try {
      navigator.wakeLock.request('screen').then(function (sentinel) {
        ready.wake = sentinel;
        sentinel.addEventListener('release', function () { ready.wake = null; });
      }).catch(function () {});
    } catch (e) {}
  }

  function releaseWake() {
    if (!ready.wake) return;
    try { ready.wake.release(); } catch (e) {}
    ready.wake = null;
  }

  function startRing(v) {
    if (ready.ringing) return;
    ready.ringing = true;
    ready.latched = true;
    ready.beats = 0;
    if (!ready.ctx) unlockAudio();
    if (el.alarmSub) el.alarmSub.textContent = (v && v.sub) ? v.sub : (S.s.arr + '까지 갈 열차가 곧 도착해요');
    if (el.alarmBanner) el.alarmBanner.classList.remove('hidden');
    ringOnce();
    if (ready.timer) clearInterval(ready.timer);
    ready.timer = setInterval(function () {
      ready.beats++;
      ringOnce();
    }, RING_EVERY);
    requestWake();
    renderReady();
  }

  /* 알람 한 번 — 도착 멜로디 + 진동 */
  function ringOnce() {
    playNow(function () { playMelody(0, 1); });
    vibrate();
  }

  function stopRing(quiet) {
    if (ready.timer) { clearInterval(ready.timer); ready.timer = null; }
    if (ready.ringing) {
      ready.ringing = false;
      ready.latched = true;
    }
    cutSound(); // 멜로디가 길어졌으니 끄는 즉시 예약된 음까지 끊는다
    if (el.alarmBanner) el.alarmBanner.classList.add('hidden');
    if (navigator.vibrate) { try { navigator.vibrate(0); } catch (e) {} }
    renderReady();
    if (!quiet) showToast('알람을 껐어요');
  }

  function maybeAlarm(v) {
    if (!ready.armed) return;
    if (v.kind === 'go') {
      if (!ready.ringing && !ready.latched) startRing(v);
    } else if (!ready.ringing) {
      ready.latched = false; // 다음 '지금 출발' 순간을 다시 기다린다
    }
  }

  function armReady() {
    ready.armed = true;
    ready.latched = false;
    S.s.ready = true;
    saveSettings();
    var ok = unlockAudio();
    requestWake();
    renderReady();
    showToast(ok ? '준비 완료 · 지금 출발!이 되면 도착 멜로디가 울려요' : '이 브라우저는 벨소리를 재생할 수 없어요');
    renderLive(); // 이미 '지금 출발!'이면 바로 울린다
    // 아직 울릴 때가 아니라면 바뀐 멜로디·볼륨을 앞소절로 들려 바로 체감하게 한다
    if (ok && !ready.ringing) playNow(function () { playMelody(INTRO_SEC, 0.95); });
  }

  function disarmReady(silent) {
    ready.armed = false;
    ready.latched = false;
    S.s.ready = false;
    saveSettings();
    stopRing(true);
    releaseWake();
    renderReady();
    if (!silent) showToast('준비를 껐어요');
  }

  function toggleReady() {
    if (ready.armed) disarmReady();
    else armReady();
  }

  function renderReady() {
    if (!el.readyBtn) return;
    el.readyBtn.classList.toggle('is-on', ready.armed);
    el.readyBtn.classList.toggle('is-ringing', ready.ringing);
    el.readyBtn.setAttribute('aria-pressed', ready.armed ? 'true' : 'false');
    el.readyBtn.querySelector('.rb-txt').textContent = ready.armed ? '준비 중' : '준비하기';
    el.readyTest.classList.toggle('hidden', !ready.armed);
    el.readyHint.classList.toggle('hidden', !ready.armed);
  }

  /* ── 이벤트 ────────────────────────────────────────── */
  function bind() {
    el.refreshBtn.addEventListener('click', function () {
      refresh();
      showToast('새로고침했어요');
    });

    el.depBtn.addEventListener('click', function () { openStationSheet('dep'); });
    el.arrBtn.addEventListener('click', function () { openStationSheet('arr'); });
    el.swapBtn.addEventListener('click', function () { swapEnds(false); });
    el.settingsBtn.addEventListener('click', function () { openSettings(); });

    el.readyBtn.addEventListener('click', toggleReady);
    el.readyTest.addEventListener('click', previewBell);
    el.alarmStop.addEventListener('click', function () {
      stopRing(true);
      disarmReady(true);
      showToast('알람을 끄고 준비를 마쳤어요');
    });

    bindStep(el.walkMinus, -1);
    bindStep(el.walkPlus, 1);

    el.autoToggle.addEventListener('change', function () {
      S.s.auto = el.autoToggle.checked;
      S.countdown = REFRESH_SEC;
      saveSettings();
      renderLive();
    });

    Array.prototype.forEach.call(document.querySelectorAll('[data-close]'), function (b) {
      b.addEventListener('click', function () { closeSheets(); });
    });

    Array.prototype.forEach.call(document.querySelectorAll('.sheet-backdrop'), function (bd) {
      bd.addEventListener('click', function (e) {
        if (e.target === bd) closeSheets();
      });
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeSheets();
    });

    el.stationSearch.addEventListener('input', function () { renderStationList(el.stationSearch.value); });

    el.saveBtn.addEventListener('click', saveSettingsFromSheet);
    el.testBtn.addEventListener('click', testConnection);
    el.bellTest.addEventListener('click', previewBell);

    Array.prototype.forEach.call(document.querySelectorAll('input[name="source"]'), function (r) {
      r.addEventListener('change', syncSourceFields);
    });

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) return;
      if (ready.armed) { requestWake(); unlockAudio(); }
      if (S.s.auto && Date.now() - S.meta.fetchedAt > REFRESH_SEC * 1000) refresh();
    });

    // 준비 중에는 아무 터치나 오디오 잠금 해제 계기로 쓴다
    document.addEventListener('pointerdown', function () {
      if (ready.armed) unlockAudio();
    }, true);
  }

  function previewBell() {
    var ok = unlockAudio();
    if (!ok) { showToast('이 브라우저는 벨소리를 재생할 수 없어요'); return; }
    cutSound();
    playNow(function () { playMelody(0, 1); });
    showToast('도착 멜로디 미리듣기');
  }

  function stepWalk(delta) {
    var next = Math.min(30, Math.max(1, S.s.walk + delta));
    if (next === S.s.walk) return;
    S.s.walk = next;
    el.walkValue.textContent = next;
    syncWalkButtons();
    saveSettings();
    renderLive();
  }

  /* −/+ 를 길게 누르면 빠르게 연속 조절 (한 번 탭은 1분) */
  function bindStep(btn, delta) {
    var holdTimer = null;
    var repeatTimer = null;
    var repeated = false;

    function stop() {
      clearTimeout(holdTimer);
      clearInterval(repeatTimer);
      holdTimer = null;
      repeatTimer = null;
    }

    btn.addEventListener('pointerdown', function () {
      repeated = false;
      stop();
      holdTimer = setTimeout(function () {
        repeated = true;
        repeatTimer = setInterval(function () { stepWalk(delta); }, 110);
      }, 420);
    });

    ['pointerup', 'pointercancel', 'pointerleave', 'blur'].forEach(function (ev) {
      btn.addEventListener(ev, stop);
    });

    btn.addEventListener('click', function () {
      if (repeated) { repeated = false; return; }
      stepWalk(delta);
    });

    btn.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  }

  /* ── 출발역/도착역 바꾸기 ──────────────────────────── */
  function swapEnds(silent) {
    var d = S.s.dep;
    S.s.dep = S.s.arr;
    S.s.arr = d;
    saveSettings();
    S.tab = D.dirToward(S.s.dep, S.s.arr) || 'down';
    stopRing(true);
    ready.latched = false;
    renderStation();
    renderLive();
    refresh();
    if (!silent) showToast('출발역과 도착역을 바꿨어요');
  }

  function routeChanged() {
    S.tab = D.dirToward(S.s.dep, S.s.arr) || 'down';
    stopRing(true);
    ready.latched = false;
    renderStation();
    renderLive();
    refresh();
  }

  /* ── 역 선택 시트 ──────────────────────────────────── */
  function openStationSheet(which) {
    sheetTarget = which === 'arr' ? 'arr' : 'dep';
    el.stationSheetTitle.textContent = sheetTarget === 'dep' ? '출발역 선택' : '도착역 선택';
    el.stationSearch.placeholder = sheetTarget === 'dep' ? '출발역 검색 (예: 두정, 아산)' : '도착역 검색 (예: 아산, 서울)';
    el.stationSearch.value = '';
    renderStationList('');
    el.stationSheet.classList.remove('hidden');
    setTimeout(function () {
      el.stationSearch.focus();
      var cur = el.stationList.querySelector('.is-current');
      if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'center' });
    }, 120);
  }

  function stationItem(s) {
    var isDep = s.name === S.s.dep;
    var isArr = s.name === S.s.arr;
    var isCurrent = sheetTarget === 'dep' ? isDep : isArr;
    var fav = isFav(s.name);
    var badge = isDep ? '<span class="st-end">출발</span>'
      : isArr ? '<span class="st-end st-end-arr">도착</span>' : '';
    return '<div class="st-row' + (isCurrent ? ' is-current' : '') + '">' +
      '<button class="st-item' + (isCurrent ? ' is-current' : '') + '" type="button" data-station="' + esc(s.name) + '">' +
      '<span><span class="st-name">' + esc(s.name) + '</span>' +
      (s.transfer ? '<span class="st-transfer">' + esc(s.transfer) + '</span>' : '') + '</span>' +
      badge + '</button>' +
      '<button class="st-star' + (fav ? ' is-on' : '') + '" type="button" data-fav="' + esc(s.name) + '"' +
      ' aria-pressed="' + (fav ? 'true' : 'false') + '"' +
      ' aria-label="' + esc(stationLabel(s.name)) + ' 즐겨찾기 ' + (fav ? '해제' : '추가') + '"' +
      ' title="' + (fav ? '즐겨찾기 해제' : '즐겨찾기') + '">' + (fav ? '★' : '☆') + '</button>' +
      '</div>';
  }

  function renderStationList(query) {
    var q = String(query || '').trim();
    var html = '';
    var list = q ? D.searchStations(q) : D.stationList();
    var shown = {};

    function group(items) {
      var out = '';
      items.forEach(function (s) { shown[s.name] = true; out += stationItem(s); });
      return out;
    }

    // 즐겨찾기 역은 검색 중에도 항상 맨 위에 고정한다
    var favItems = FAV.map(function (n) {
      for (var i = 0; i < list.length; i++) if (list[i].name === n) return list[i];
      return null;
    }).filter(Boolean);

    if (favItems.length) {
      html += '<div class="st-group st-group-fav"><span class="st-group-star" aria-hidden="true">★</span> 즐겨찾기</div>';
      html += group(favItems);
    }

    var rest = list.filter(function (s) { return !shown[s.name]; });

    if (q) {
      if (!list.length) html += '<div class="st-group">검색 결과가 없어요</div>';
      if (rest.length) {
        if (favItems.length) html += '<div class="st-group">검색 결과</div>';
        html += group(rest);
      }
      var alias = D.aliasOf(q);
      if (alias && alias !== D.normalize(q)) {
        html += '<div class="st-group">‘' + esc(q) + '’ → ' + esc(alias) + '역으로 찾았어요</div>';
      }
    } else {
      html += '<div class="st-group">주요 역</div>';
      html += group(rest.filter(function (s) { return s.major; }));
      html += '<div class="st-group">1호선 전체 역</div>';
      html += group(rest.filter(function (s) { return !s.major; }));
    }

    el.stationList.innerHTML = html;
    Array.prototype.forEach.call(el.stationList.querySelectorAll('[data-station]'), function (b) {
      b.addEventListener('click', function () { pickStation(b.getAttribute('data-station')); });
    });
    Array.prototype.forEach.call(el.stationList.querySelectorAll('[data-fav]'), function (b) {
      b.addEventListener('click', function () { toggleFav(b.getAttribute('data-fav')); });
    });
  }

  function pickStation(name) {
    var other = sheetTarget === 'dep' ? S.s.arr : S.s.dep;
    if (name === other) {
      closeSheets();
      swapEnds(false);
      return;
    }
    if (sheetTarget === 'dep') S.s.dep = name;
    else S.s.arr = name;
    saveSettings();
    closeSheets();
    routeChanged();
    showToast((sheetTarget === 'dep' ? '출발역을 ' : '도착역을 ') + stationLabel(name) + '으로 바꿨어요');
  }

  /* ── 설정 시트 ─────────────────────────────────────── */
  function openSettings() {
    Array.prototype.forEach.call(document.querySelectorAll('input[name="source"]'), function (r) {
      r.checked = r.value === S.s.source;
    });
    el.apiKey.value = S.s.key;
    el.proxyUrl.value = S.s.proxy;
    el.testResult.textContent = '';
    el.testResult.className = 'test-result';
    syncSourceFields();
    el.settingsSheet.classList.remove('hidden');
  }

  function syncSourceFields() {
    var picked = document.querySelector('input[name="source"]:checked');
    var val = picked ? picked.value : 'demo';
    el.keyField.classList.toggle('is-dim', val !== 'key');
    el.proxyField.classList.toggle('is-dim', val !== 'proxy');
    Array.prototype.forEach.call(document.querySelectorAll('.radio'), function (lab) {
      var input = lab.querySelector('input');
      lab.classList.toggle('is-off', input.checked === false);
    });
  }

  function saveSettingsFromSheet() {
    var picked = document.querySelector('input[name="source"]:checked');
    var val = picked ? picked.value : 'demo';
    var key = el.apiKey.value.trim();
    var proxy = el.proxyUrl.value.trim();
    if (val === 'key' && !key) { setTest('인증키를 넣어 주세요.', 'err'); return; }
    if (val === 'proxy' && !proxy) { setTest('프록시 주소를 넣어 주세요.', 'err'); return; }
    if (proxy && !/^https?:\/\//i.test(proxy)) { setTest('프록시 주소는 http:// 또는 https://로 시작해야 해요.', 'err'); return; }
    S.s.source = val;
    S.s.key = key;
    S.s.proxy = proxy;
    saveSettings();
    closeSheets();
    refresh();
    showToast(val === 'demo' ? '데모 모드로 돌아왔어요' : '실데이터로 연결해 볼게요');
  }

  function setTest(msg, kind) {
    el.testResult.textContent = msg;
    el.testResult.className = 'test-result' + (kind ? ' is-' + kind : '');
  }

  function testConnection() {
    var picked = document.querySelector('input[name="source"]:checked');
    var val = picked ? picked.value : 'demo';
    var key = el.apiKey.value.trim();
    var proxy = el.proxyUrl.value.trim();

    if (val === 'demo') { setTest('데모 모드는 연결 테스트가 필요 없어요. 저장하면 시뮬레이션이 흘러요.', 'ok'); return; }
    if (val === 'key' && !key) { setTest('인증키를 먼저 넣어 주세요.', 'err'); return; }
    if (val === 'proxy' && !proxy) { setTest('프록시 주소를 먼저 넣어 주세요.', 'err'); return; }
    if (val === 'key' && location.protocol === 'https:') {
      setTest('https 페이지에서는 http API 호출이 차단돼요. 프록시를 쓰거나 http로 열어 주세요.', 'err');
      return;
    }

    var saved = { source: S.s.source, key: S.s.key, proxy: S.s.proxy };
    S.s.source = val; S.s.key = key; S.s.proxy = proxy;
    setTest('확인 중…');
    el.testBtn.disabled = true;

    fetchArrivals(S.s.dep).then(function (list) {
      if (!list.length) {
        setTest('연결은 됐지만 ' + S.s.dep + '역 1호선 데이터가 비어 있어요. (운행 시간대 확인)', 'err');
      } else {
        setTest('성공! 열차 ' + list.length + '대를 받았어요. 저장하면 화면에 반영돼요.', 'ok');
      }
    }).catch(function (err) {
      var m = String(err && err.message || err);
      if (/Failed to fetch|NetworkError|aborted|abort/i.test(m)) m = '네트워크/CORS로 막혔어요. 프록시 URL을 권장해요.';
      setTest('실패: ' + m, 'err');
    }).then(function () {
      el.testBtn.disabled = false;
      S.s.source = saved.source; S.s.key = saved.key; S.s.proxy = saved.proxy;
    });
  }

  function closeSheets() {
    el.stationSheet.classList.add('hidden');
    el.settingsSheet.classList.add('hidden');
  }

  /* ── 시계 ──────────────────────────────────────────── */
  function tick() {
    if (S.s.auto) {
      S.countdown -= 1;
      if (S.countdown <= 0 && !S.loading) { refresh(); return; }
    }
    renderLive();
  }

  /* ── 시작 ──────────────────────────────────────────── */
  function init() {
    el = {
      toast: $('toast'),
      modeBadge: $('modeBadge'),
      modeText: $('modeText'),
      refreshBtn: $('refreshBtn'),
      settingsBtn: $('settingsBtn'),
      depBtn: $('depBtn'),
      arrBtn: $('arrBtn'),
      swapBtn: $('swapBtn'),
      depName: $('depName'),
      arrName: $('arrName'),
      verdictCard: $('verdictCard'),
      verdictBody: $('verdictBody'),
      walkValue: $('walkValue'),
      walkMinus: $('walkMinus'),
      walkPlus: $('walkPlus'),
      readyBtn: $('readyBtn'),
      readyTest: $('readyTest'),
      readyHint: $('readyHint'),
      alarmBanner: $('alarmBanner'),
      alarmSub: $('alarmSub'),
      alarmStop: $('alarmStop'),
      bellTest: $('bellTest'),
      autoToggle: $('autoToggle'),
      countdown: $('countdown'),
      statusMeta: $('statusMeta'),
      statusError: $('statusError'),
      track: $('track'),
      trackCaption: $('trackCaption'),
      trainList: $('trainList'),
      trainCount: $('trainCount'),
      filterNote: $('filterNote'),
      expNote: $('expNote'),
      trainEmpty: $('trainEmpty'),
      stationSheet: $('stationSheet'),
      stationSheetTitle: $('stationSheetTitle'),
      stationSearch: $('stationSearch'),
      stationList: $('stationList'),
      settingsSheet: $('settingsSheet'),
      apiKey: $('apiKey'),
      proxyUrl: $('proxyUrl'),
      keyField: $('keyField'),
      proxyField: $('proxyField'),
      testBtn: $('testBtn'),
      saveBtn: $('saveBtn'),
      testResult: $('testResult')
    };

    bind();

    // 지난번에 준비하기를 켜 둔 상태라면 이어서 감시한다(소리는 첫 터치 뒤부터)
    ready.armed = !!S.s.ready;
    if (ready.armed) requestWake();

    renderAll();
    refresh();

    S.ticker = setInterval(tick, 1000);

    if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
      window.addEventListener('load', function () {
        navigator.serviceWorker.register('sw.js').catch(function () {});
      });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
