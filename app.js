/* ============================================================
   1호선 레이더 · app.js
   - 서울시 실시간 도착정보(OA-12764) / 열차 위치(OA-12601) 클라이언트
   - 코레일 구간(두정·천안 등)은 barvlDt가 비어 오므로
     arvlMsg2/arvlMsg3/실시간 위치를 역간 소요시간으로 환산해 도착 시각을 추정
   - API 키가 없으면 두정역 실데이터 형식의 데모 시뮬레이션으로 동작
   ============================================================ */
(function () {
  'use strict';

  var D = window.Subway1Data;
  var LS_KEY = 'subway1.settings.v1';
  var API_BASE = 'http://swopenAPI.seoul.go.kr/api/subway';
  var REFRESH_SEC = 30;
  var BOARD_MARGIN = 1; // 분: 승강장 도착 후 최소 여유

  var DEFAULTS = {
    source: 'demo',   // demo | key | proxy
    key: '',
    proxy: '',
    walk: 10,
    station: '두정',
    auto: true,
    dir: 'up',
    flip: false
  };

  /* ── 상태 ──────────────────────────────────────────── */
  var S = {
    s: loadSettings(),
    tab: 'up',
    data: { up: [], down: [] },
    meta: { mode: 'demo', fetchedAt: 0, error: '', lastTrainsAt: 0 },
    countdown: REFRESH_SEC,
    loading: false,
    ticker: null,
    lastVisible: Date.now()
  };
  S.tab = S.s.dir === 'down' ? 'down' : 'up';

  var el = {};

  /* ── 저장소 ────────────────────────────────────────── */
  function loadSettings() {
    var out = {};
    for (var k in DEFAULTS) out[k] = DEFAULTS[k];
    try {
      var raw = localStorage.getItem(LS_KEY);
      if (raw) {
        var parsed = JSON.parse(raw);
        for (var key in out) {
          if (parsed[key] !== undefined && parsed[key] !== null) out[key] = parsed[key];
        }
      }
    } catch (e) { /* 저장소를 못 쓰면 기본값 */ }
    out.walk = Math.min(30, Math.max(1, parseInt(out.walk, 10) || 10));
    if (!D.axisOf(out.station)) out.station = '두정';
    return out;
  }

  function saveSettings() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(S.s)); } catch (e) {}
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

  function showToast(msg) {
    var t = el.toast;
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
  function analyze(raw, ref, dir) {
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
        var appr = D.approachStations(ref, dir, count + 1);
        // count번째 전역의 역명을 노선 데이터에서 가져온다
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

    // 4) 메시지로도 모르면 실시간 위치로 보정(호출부에서 posRaw 전달)
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

  function applyPosition(train, pos, ref) {
    if (!pos || !pos.statnNm) return false;
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

  /* ── 데모 시뮬레이션 ───────────────────────────────── */
  var DEMO_UP = ['연천', '소요산', '광운대', '청량리', '서울역', '영등포', '구로', '부평', '인천', '수원'];
  var DEMO_DOWN = ['신창', '천안', '서동탄', '아산', '온양온천', '평택', '수원', '병점', '인천', '구로'];

  function demoDests(ref, dir) {
    var src = dir === 'up' ? DEMO_UP : DEMO_DOWN;
    var sign = dir === 'up' ? 1 : -1;
    var out = src.filter(function (n) { return D.directionBetween(ref, n) === sign; });
    return out.length ? out.slice(0, 4) : [];
  }

  function demoPosition(ref, dir, etaMin) {
    var appr = D.approachStations(ref, dir, 10);
    if (!appr.length) return null;
    var nodes = [];
    var dist = 0;
    var prev = ref;
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

  function buildDemo(ref, dir) {
    var dests = demoDests(ref, dir);
    if (!dests.length) return [];
    var nowSec = Date.now() / 1000;
    var period = 36 * 60;
    var offsets = [3.2, 7.9, 13.4, 19.2, 25.1, 31.0];
    var hour = new Date().getHours();
    var out = [];

    offsets.forEach(function (off, i) {
      var etaSec = ((off * 60 - nowSec) % period + period) % period;
      var etaMin = etaSec / 60;
      var dest = dests[i % dests.length];
      var pos = demoPosition(ref, dir, etaMin);
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
        updnLine: dir === 'up' ? '0' : '1',
        trainLineNm: dest + '행(' + (type === '일반' ? '일반' : type) + ') - ' + ref + '방면',
        btrainSttus: type,
        barvlDt: barvlDt,
        btrainNo: String(4100 + i * 37),
        bstatnNm: dest,
        arvlCd: arvlCd,
        arvlMsg2: msg2,
        arvlMsg3: etaMin < 1 ? '곧 도착' : Math.round(etaMin) + '분 후 (' + (pos ? pos.nodes[pos.k].name : ref) + ')',
        lstcarAt: ((hour >= 22 || hour < 2) && i === offsets.length - 1) ? '1' : '0',
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

  function fetchJson(url) {
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, 12000);
    return fetch(url, { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.text();
      })
      .then(function (text) {
        var json;
        try { json = JSON.parse(text); } catch (e) {
          throw new Error('응답이 JSON이 아니에요 (프록시 주소를 확인해 주세요)');
        }
        return json;
      })
      .finally(function () { clearTimeout(timer); });
  }

  function readList(json, listKey) {
    if (json && json[listKey]) return json[listKey];
    if (json && json.errorMessage) {
      var em = json.errorMessage;
      throw new Error('API 오류 ' + (em.code || '') + ' ' + (em.message || em.code || ''));
    }
    if (json && json.RESULT && json.RESULT.CODE && json.RESULT.CODE !== 'INFO-000') {
      throw new Error('API 오류 ' + json.RESULT.CODE + ' ' + (json.RESULT.MESSAGE || ''));
    }
    if (json && json.ok === false) throw new Error(json.error || '프록시 오류');
    return [];
  }

  function fetchArrivals(stationName) {
    var url = apiUrl('realtimeStationArrival', [0, 30, encodeURIComponent(stationName)]);
    if (!url) throw new Error('데이터 소스가 설정되지 않았어요');
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
  function refresh(reason) {
    var ref = S.s.station;
    S.countdown = REFRESH_SEC;
    S.loading = true;
    var mode = S.s.source;

    if (mode === 'demo' || (mode === 'key' && !S.s.key) || (mode === 'proxy' && !S.s.proxy)) {
      var up = buildDemo(ref, 'up');
      var down = buildDemo(ref, 'down');
      S.data.up = sortByEta(up.map(function (r) { return analyze(r, ref, 'up'); }));
      S.data.down = sortByEta(down.map(function (r) { return analyze(r, ref, 'down'); }));
      S.meta = { mode: 'demo', fetchedAt: Date.now(), error: '', lastTrainsAt: Date.now() };
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

    fetchArrivals(ref).then(function (list) {
      var up = [], down = [];
      list.forEach(function (raw) {
        var dir = dirOf(raw.updnLine) || 'down';
        if (S.s.flip) dir = dir === 'up' ? 'down' : 'up';
        var t = analyze(raw, ref, dir);
        if (t.etaSec == null) t.etaSec = null;
        (dir === 'up' ? up : down).push(t);
      });

      var needPos = up.concat(down).some(function (t) { return t.etaSec == null || t.source === 'msg'; });

      var afterPos = needPos
        ? fetchPositions().then(function (positions) {
          if (!positions.length) return;
          var byNo = {};
          positions.forEach(function (p) { byNo[String(p.trainNo)] = p; });
          up.concat(down).forEach(function (t) {
            var p = byNo[String(t.trainNo)];
            if (p && (t.etaSec == null || t.source === 'msg')) applyPosition(t, p, ref);
          });
        })
        : Promise.resolve();

      return afterPos.then(function () {
        up.sort(function (a, b) { return (a.etaSec == null ? 1e9 : a.etaSec) - (b.etaSec == null ? 1e9 : b.etaSec); });
        down.sort(function (a, b) { return (a.etaSec == null ? 1e9 : a.etaSec) - (b.etaSec == null ? 1e9 : b.etaSec); });
        S.data.up = up;
        S.data.down = down;
        S.meta = { mode: 'live', fetchedAt: Date.now(), error: '', lastTrainsAt: Date.now() };
      });
    }).catch(function (err) {
      var msg = String(err && err.message || err);
      if (/Failed to fetch|NetworkError|Load failed|aborted|abort/i.test(msg)) {
        msg = '실데이터를 받지 못했어요(CORS/네트워크). 설정에서 프록시 URL을 쓰면 대부분 해결돼요.';
      }
      S.meta.error = msg;
      if (!S.data.up.length && !S.data.down.length) {
        S.data.up = sortByEta(buildDemo(ref, 'up').map(function (r) { return analyze(r, ref, 'up'); }));
        S.data.down = sortByEta(buildDemo(ref, 'down').map(function (r) { return analyze(r, ref, 'down'); }));
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

  function verdictFor(rows, walk) {
    rows = rows.filter(function (r) { return r.eta != null; });
    if (!rows.length) {
      return {
        kind: 'none',
        title: '열차 정보가 없어요',
        sub: '잠시 뒤 새로고침하거나 설정에서 데이터 소스를 확인해 주세요.'
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
      var missSub = '이동 ' + walk + '분으로는 놓쳐요 · 가장 가까운 열차가 ' + nearestMin + '분 뒤 도착해요';
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
      var slackTxt = best.slack >= 0.5 ? '여유 ' + Math.round(best.slack) + '분' : '지금 나가면 딱 맞아요';
      return {
        kind: 'go',
        title: '지금 출발!',
        sub: dest + '행이 ' + Math.round(best.etaMin) + '분 뒤 도착해요 · ' + slackTxt,
        best: best
      };
    }
    return {
      kind: 'wait',
      title: best.departIn + '분 뒤 출발',
      sub: '지금 나가면 ' + Math.round(best.slack - BOARD_MARGIN) + '분 더 기다려요 · ' + dest + '행',
      best: best
    };
  }

  /* ── 렌더 ──────────────────────────────────────────── */
  function renderAll() {
    renderStation();
    renderTabs();
    renderLive();
  }

  function renderStation() {
    var ref = S.s.station;
    el.stationName.textContent = ref;
    el.walkRange.value = S.s.walk;
    el.walkValue.textContent = S.s.walk;
    updateRangeFill();
    el.autoToggle.checked = !!S.s.auto;
  }

  function renderTabs() {
    var meta = D.directionMeta(S.s.station);
    Array.prototype.forEach.call(document.querySelectorAll('.dir-tab'), function (btn) {
      var dir = btn.getAttribute('data-dir');
      var active = dir === S.tab;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
      btn.querySelector('.dir-label').textContent = meta[dir].label;
      btn.querySelector('.dir-hint').textContent = meta[dir].hint;
      btn.querySelector('.dir-arrow').textContent = meta[dir].arrow;
    });
  }

  function updateRangeFill() {
    var pct = ((S.s.walk - 1) / 29) * 100;
    el.walkRange.style.setProperty('--fill', pct.toFixed(1) + '%');
  }

  function renderLive() {
    var now = Date.now();
    var rows = judgeTrains(S.data[S.tab] || [], S.s.walk, now);
    var v = verdictFor(rows, S.s.walk);
    renderVerdict(v, now);
    renderTrack(rows, now);
    renderTrainList(rows, now);
    renderStatus(now, rows);

    if (S.s.auto) {
      var left = Math.max(0, S.countdown);
      el.countdown.textContent = left + '초 뒤 갱신';
    } else {
      el.countdown.textContent = '자동 갱신 꺼짐';
    }
    el.modeBadge.className = 'badge ' + (S.meta.mode === 'demo' ? 'badge-demo' : 'badge-live');
    el.modeBadge.textContent = S.meta.mode === 'demo' ? '데모' : 'LIVE';
    el.modeText.textContent = S.meta.mode === 'demo' ? '데모 모드 · 시뮬레이션' : '실시간 데이터';
  }

  function renderVerdict(v, now) {
    var meta = D.directionMeta(S.s.station);
    var walk = S.s.walk;
    var html = '';
    html += '<div class="v-top"><span class="v-kicker">' + esc(S.s.station) + '역 · ' +
      esc(meta[S.tab].label) + ' ' + esc(meta[S.tab].hint) + '</span><span>' + clock(now) + '</span></div>';

    var icon = v.kind === 'go' ? '🏃' : v.kind === 'wait' ? '⏳' : v.kind === 'miss' ? '😵‍💫' : '🚉';
    html += '<div class="v-main"><div class="v-icon" aria-hidden="true">' + icon + '</div>' +
      '<div class="v-maintext"><h2 class="v-title">' + esc(v.title) + '</h2>' +
      '<p class="v-sub">' + esc(v.sub) + '</p></div></div>';

    html += '<div class="v-facts">';
    if (v.kind === 'miss') {
      html += '<div class="v-fact"><span>가장 가까운 열차</span><b>' +
        (v.next && v.next.eta != null ? Math.round(v.next.eta / 60) + '분 후' : '–') + '</b></div>';
      html += '<div class="v-fact"><span>지금 나가면</span><b>' + clock(now + walk * 60000) + ' 도착</b></div>';
    } else {
      var leaveAt = v.best ? (v.kind === 'go' ? now : now + v.best.departIn * 60000) : null;
      var arriveAt = v.best && v.best.eta != null ? now + v.best.eta * 1000 : null;
      html += '<div class="v-fact"><span>나갈 시각</span><b>' +
        (v.kind === 'go' ? '지금 (' + clock(now) + ')' : leaveAt ? clock(leaveAt) : '–') + '</b></div>';
      html += '<div class="v-fact"><span>' + (v.best && v.best.t.dest ? esc(v.best.t.dest) + '행 도착' : '열차 도착') + '</span><b>' +
        (arriveAt ? clock(arriveAt) + ' · ' + Math.max(0, Math.round((arriveAt - now) / 60000)) + '분 후' : '–') + '</b></div>';
    }
    html += '</div>';

    var badges = '';
    if (v.best) {
      if (v.best.t.express) badges += '<span class="pill pill-exp">급행</span>';
      if (v.best.t.lastTrain) badges += '<span class="pill pill-last">막차</span>';
      if (v.best.t.trainNo) badges += '<span>#' + esc(v.best.t.trainNo) + '</span>';
    }
    html += '<div class="v-train"><span>' + (S.s.walk) + '분 이동 기준</span>' + badges + '</div>';

    el.verdictCard.setAttribute('data-kind', v.kind);
    el.verdictCard.innerHTML = html;
  }

  function renderTrack(rows, now) {
    var ref = S.s.station;
    var dir = S.tab;
    var appr = D.approachStations(ref, dir, 3);
    var dep = D.departureStations(ref, dir, 2);

    if (!appr.length && !dep.length) {
      el.track.innerHTML = '<div class="track-empty">이 방향 열차가 없는 종점이에요</div>';
      return;
    }

    var nodes = [{ name: ref, pos: 0, here: true }];
    var p = 0, prev = ref;
    appr.forEach(function (n) {
      var seg = D.minutesBetween(n, prev);
      p -= (seg == null ? 2 : seg);
      nodes.push({ name: n, pos: p });
      prev = n;
    });
    var q = 0, pv = ref;
    dep.forEach(function (n) {
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

    nodes.forEach(function (n) {
      var isHere = !!n.here;
      html += '<div class="t-node' + (isHere ? ' is-here' : '') + '" style="left:' + xOf(n.pos).toFixed(2) + '%">' +
        '<span class="t-dot"></span>' +
        '<span class="t-name">' + esc(n.name) + '</span>' +
        (isHere ? '<span class="t-sub">기준역</span>' : '') +
        '</div>';
    });

    // 열차 마커: 남은 시간 → 기준역에서 떨어진 분
    var lanes = [0, 30];
    var placed = [];
    var outsideShown = 0;
    rows.forEach(function (r) {
      if (r.eta == null) return;
      if (r.eta > 60 * 120) return;
      var windowMin = Math.abs(minPos);
      var beyond = r.eta / 60 > windowMin;
      if (beyond) {
        if (outsideShown >= 2) return; // 아주 먼 열차는 생략
        outsideShown++;
      }
      var pos = -Math.min(r.eta / 60, windowMin);
      var x = xOf(pos);
      var lane = 0;
      for (var i = 0; i < placed.length; i++) {
        if (Math.abs(placed[i] - x) < 13) { lane = 1; break; }
      }
      placed.push(x);
      var minTxt = r.eta < 45 ? '곧' : Math.round(r.eta / 60) + '분';
      var cls = 't-train' + (r.t.express ? ' is-exp' : '') + (r.kind === 'miss' ? ' is-late' : '') +
        (r.eta < 30 ? ' is-ref' : '') + (beyond ? ' is-outside' : '');
      html += '<div class="' + cls + '" style="left:' + x.toFixed(2) + '%;top:' + lanes[lane] + 'px">' +
        '<span class="t-train-body">' + minTxt + '</span>' +
        '<span class="t-train-label">' + esc(r.t.dest || '') + '</span>' +
        '</div>';
    });

    el.track.innerHTML = html;
    el.trackCaption.textContent = dir === 'up' ? '← 왼쪽에서 진입 · 상행' : '← 왼쪽에서 진입 · 하행';
  }

  function statusOf(r) {
    if (r.eta == null) return { cls: 'st-none', text: '확인 중' };
    if (r.kind === 'go') return { cls: 'st-go', text: '지금 출발' };
    if (r.kind === 'wait') return { cls: 'st-wait', text: r.departIn + '분 뒤 출발' };
    return { cls: 'st-miss', text: '늦음' };
  }

  function sourceChip(t) {
    if (t.source === 'barvlDt') return '도착예정 ' + Math.round(t.etaSec) + '초';
    if (t.source === 'state') return '역 ' + (t.stateLabel || '도착');
    if (t.source === 'msg') return '메시지로 추정';
    if (t.source === 'position') return '위치로 추정';
    return '정보 없음';
  }

  function renderTrainList(rows, now) {
    var html = '';
    var shown = 0;
    var visible = rows.slice(0, 8);
    visible.forEach(function (r) {
      var t = r.t;
      var st = statusOf(r);
      var typePill = t.itx ? '<span class="pill pill-itx">ITX</span>' :
        t.express ? '<span class="pill pill-exp">급행</span>' :
          '<span class="pill pill-normal">일반</span>';
      var lastPill = t.lastTrain ? '<span class="pill pill-last">막차</span>' : '';
      var etaTxt = r.eta == null ? '–' : (r.eta < 45 ? '곧' : String(Math.round(r.eta / 60)));
      var etaUnit = r.eta == null ? '' : (r.eta < 45 ? '도착' : '분');
      var loc = '';
      if (t.atStation) {
        var stTxt = t.stateLabel === '전역' || !t.stateLabel ? '출발' : t.stateLabel;
        loc = t.atStation + '역 ' + stTxt + (t.away ? ' · ' + t.away + '개 역 전' : '');
      }
      else if (t.stateLabel) loc = '기준역 ' + t.stateLabel;
      else loc = t.msg2 ? t.msg2 : '위치 확인 중';

      html += '<article class="tcard" data-state="' + (r.eta == null ? 'none' : r.kind) + '">' +
        '<div class="tcard-eta' + (r.eta != null && r.eta < 45 ? ' is-now' : '') + '"><b>' + etaTxt + '</b><span>' + etaUnit + '</span></div>' +
        '<div class="tcard-main">' +
        '<div class="tcard-dest">' + esc(t.dest || '행선지 미상') + ' <span class="to">방면</span>' + typePill + lastPill + '</div>' +
        '<div class="tcard-loc">' + esc(loc) + '</div>' +
        '</div>' +
        '<span class="tcard-status ' + st.cls + '">' + st.text + '</span>' +
        '<div class="tcard-src"><span class="src-chip">' + esc(sourceChip(t)) + '</span>' +
        (t.trainNo ? '<span>#' + esc(t.trainNo) + '</span>' : '') +
        (r.kind === 'miss' && r.etaMin != null ? '<span>' + Math.round(-r.slack) + '분 늦어요</span>' : '') +
        '</div>' +
        '</article>';
      shown++;
    });

    el.trainList.innerHTML = html;
    var total = rows.length;
    el.trainCount.textContent = total ? (S.tab === 'up' ? '상행' : '하행') + ' ' + total + '대' +
      (total > visible.length ? ' · 가까운 ' + visible.length + '대' : '') : '';

    if (!shown) {
      el.trainEmpty.classList.remove('hidden');
      el.trainEmpty.innerHTML = S.meta.error
        ? '실시간 정보를 불러오지 못했어요.<br><small>' + esc(S.meta.error) + '</small>'
        : '이 방향으로 오는 열차가 지금은 없어요.<br><small>운행 시간대가 아니거나 데이터가 비어 있어요.</small>';
    } else {
      el.trainEmpty.classList.add('hidden');
    }
  }

  function renderStatus(now, rows) {
    var txt = S.meta.mode === 'demo' ? '데모 데이터' : '서울시 실시간 데이터';
    if (S.meta.fetchedAt) txt += ' · ' + clockSec(S.meta.fetchedAt) + ' 갱신';
    if (S.s.flip) txt += ' · 방향 반전됨';
    el.statusMeta.textContent = txt;
    if (S.meta.error) {
      el.statusError.classList.remove('hidden');
      el.statusError.textContent = S.meta.error;
    } else {
      el.statusError.classList.add('hidden');
      el.statusError.textContent = '';
    }
  }

  /* ── 이벤트 ────────────────────────────────────────── */
  function bind() {
    el.refreshBtn.addEventListener('click', function () {
      refresh('manual');
      showToast('새로고침했어요');
    });

    el.stationBtn.addEventListener('click', function () { openStationSheet(); });
    el.settingsBtn.addEventListener('click', function () { openSettings(); });

    Array.prototype.forEach.call(document.querySelectorAll('.dir-tab'), function (btn) {
      btn.addEventListener('click', function () {
        S.tab = btn.getAttribute('data-dir');
        S.s.dir = S.tab;
        saveSettings();
        renderTabs();
        renderLive();
      });
    });

    el.walkRange.addEventListener('input', function () {
      S.s.walk = Math.min(30, Math.max(1, parseInt(el.walkRange.value, 10) || 10));
      el.walkValue.textContent = S.s.walk;
      updateRangeFill();
      saveSettings();
      renderLive();
    });

    el.walkMinus.addEventListener('click', function () { stepWalk(-1); });
    el.walkPlus.addEventListener('click', function () { stepWalk(1); });

    el.autoToggle.addEventListener('change', function () {
      S.s.auto = el.autoToggle.checked;
      S.countdown = REFRESH_SEC;
      saveSettings();
      renderLive();
    });

    el.mirrorBtn.addEventListener('click', function () {
      S.s.flip = !S.s.flip;
      saveSettings();
      showToast(S.s.flip ? '상·하행 방향을 뒤집었어요' : '방향을 원래대로 돌렸어요');
      refresh('flip');
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

    Array.prototype.forEach.call(document.querySelectorAll('input[name="source"]'), function (r) {
      r.addEventListener('change', syncSourceFields);
    });

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) {
        S.lastVisible = Date.now();
      } else if (S.s.auto && Date.now() - S.meta.fetchedAt > REFRESH_SEC * 1000) {
        refresh('visible');
      }
    });
  }

  function stepWalk(delta) {
    var next = Math.min(30, Math.max(1, S.s.walk + delta));
    if (next === S.s.walk) return;
    S.s.walk = next;
    el.walkRange.value = next;
    el.walkValue.textContent = next;
    updateRangeFill();
    saveSettings();
    renderLive();
  }

  /* ── 기준역 시트 ───────────────────────────────────── */
  function openStationSheet() {
    el.stationSearch.value = '';
    renderStationList('');
    el.stationSheet.classList.remove('hidden');
    setTimeout(function () { el.stationSearch.focus(); }, 120);
  }

  function renderStationList(query) {
    var q = D.normalize(query || '');
    var all = D.stationList();
    var list = q ? all.filter(function (s) { return s.name.indexOf(q) >= 0; })
      : all.filter(function (s) { return s.major; });
    var html = '';
    if (!q) html += '<div class="st-group">주요 역</div>';
    else if (!list.length) html += '<div class="st-group">검색 결과가 없어요</div>';

    list.forEach(function (s) {
      html += '<button class="st-item' + (s.name === S.s.station ? ' is-current' : '') + '" type="button" data-station="' + esc(s.name) + '">' +
        '<span><span class="st-name">' + esc(s.name) + '</span>' +
        (s.transfer ? '<span class="st-transfer">' + esc(s.transfer) + '</span>' : '') + '</span>' +
        (s.name === S.s.station ? '<span class="st-check">✓</span>' : '') +
        '</button>';
    });

    if (!q) {
      html += '<div class="st-group">1호선 전체 역</div>';
      all.forEach(function (s) {
        if (s.major) return;
        html += '<button class="st-item' + (s.name === S.s.station ? ' is-current' : '') + '" type="button" data-station="' + esc(s.name) + '">' +
          '<span><span class="st-name">' + esc(s.name) + '</span>' +
          (s.transfer ? '<span class="st-transfer">' + esc(s.transfer) + '</span>' : '') + '</span>' +
          (s.name === S.s.station ? '<span class="st-check">✓</span>' : '') +
          '</button>';
      });
    }

    el.stationList.innerHTML = html;
    Array.prototype.forEach.call(el.stationList.querySelectorAll('[data-station]'), function (b) {
      b.addEventListener('click', function () {
        var name = b.getAttribute('data-station');
        S.s.station = name;
        saveSettings();
        closeSheets();
        renderStation();
        renderTabs();
        refresh('station');
        showToast(name + '역 기준으로 바꿨어요');
      });
    });
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
    refresh('settings');
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

    fetchArrivals(S.s.station).then(function (list) {
      if (!list.length) {
        setTest('연결은 됐지만 ' + S.s.station + '역 1호선 데이터가 비어 있어요. (운행 시간대 확인)', 'err');
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
      if (S.countdown <= 0 && !S.loading) { refresh('timer'); return; }
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
      stationBtn: $('stationBtn'),
      stationName: $('stationName'),
      verdictCard: $('verdictCard'),
      walkRange: $('walkRange'),
      walkValue: $('walkValue'),
      walkMinus: $('walkMinus'),
      walkPlus: $('walkPlus'),
      autoToggle: $('autoToggle'),
      countdown: $('countdown'),
      mirrorBtn: $('mirrorBtn'),
      statusMeta: $('statusMeta'),
      statusError: $('statusError'),
      track: $('track'),
      trackCaption: $('trackCaption'),
      trainList: $('trainList'),
      trainCount: $('trainCount'),
      trainEmpty: $('trainEmpty'),
      stationSheet: $('stationSheet'),
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
    renderStation();
    renderTabs();
    renderLive();
    refresh('boot');

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
