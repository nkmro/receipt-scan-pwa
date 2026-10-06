/* 영수증 스캔 PWA — 개발 2단계: 뼈대 + 홈 껍데기 + Google 로그인
   - 하단 메뉴 3개(홈·보관함·예산), 해시 주소(#/home 등)로 화면 전환
   - 로그인하면 Drive에 "영수증 스캔" 폴더와 "영수증 장부" 시트를 자동으로 만들고,
     홈 합계는 시트의 영수증 탭(귀속 월, 금액, 구분)을 읽어 계산
   - 예산: 접대비·회의비만(시트 '예산' 탭). 경비·출장비는 금액만 */
(function () {
  'use strict';

  var APP_VERSION = '0.19.2';
  var CATEGORIES = ['경비', '접대비', '회의비', '출장비'];
  var CACHE_KEY = 'rs.cache.receipts';
  var SET_KEY = 'rs.cache.settings';
  var BUD_KEY = 'rs.cache.budgets';
  var CARD_KEY = 'rs.cache.cardMemory';
  var BUDGET_CATS = ['접대비', '회의비'];   // 예산이 있는 구분(경비·출장비는 예산 없음)

  // ── 상태 ──
  var state = {
    user: RSAuth.user(),   // { email, approved } 또는 null
    pending: null,         // 승인 대기: { status, message }
    nameSaving: false,
    uploadWaiting: 0,      // 폰에 저장됐지만 아직 Drive·시트에 못 올린 건수
    uploadError: '',
    admin: { list: null, loading: false, error: '', waiting: 0 }, // 관리자 화면
    ws: null,              // 폴더·시트 ID
    receipts: loadCache(), // 시트에서 읽은 영수증 목록
    settings: loadSettingsCache(), // 내 정보(시트 '설정' 탭)
    budgets: loadJson(BUD_KEY, []), // 예산(시트 '예산' 탭)
    cardMemory: loadJson(CARD_KEY, {}), // 카드 기억(시트 '카드' 탭): 카드 번호 → {type, card, corpCard}
    loading: false,
    step: '',              // 준비 중 안내 문구
    error: '',
    offline: false
  };

  function loadCache() {
    try { return JSON.parse(localStorage.getItem(CACHE_KEY) || '[]'); } catch (e) { return []; }
  }
  function loadJson(k, d) { try { return JSON.parse(localStorage.getItem(k) || 'null') || d; } catch (e) { return d; } }
  function setBudgets(list) {
    state.budgets = list || [];
    try { localStorage.setItem(BUD_KEY, JSON.stringify(state.budgets)); } catch (e) { /* 무시 */ }
  }
  function setCardMemory(o) {
    state.cardMemory = o || {};
    try { localStorage.setItem(CARD_KEY, JSON.stringify(state.cardMemory)); } catch (e) { /* 무시 */ }
  }
  // 상세에서 처음 보는 카드의 결제 수단을 고르면 기억(같은 번호에 다른 법인카드를 고른 적이 있으면 "여러 장"으로)
  function learnCard(cardNo, v) {
    var key = RSStore.cardKey(cardNo);
    if (!key || !v.cardType || !state.ws) return;
    var e = { type: v.cardType, card: v.cardType === '현금' ? '현금' : (v.card || ''), corpCard: v.cardType === '법인카드' ? (v.corpCard || '') : '' };
    var old = state.cardMemory[key];
    if (old && old.type === '법인카드' && e.type === '법인카드') {
      if (!e.corpCard) e.corpCard = old.corpCard;
      else if (old.corpCard && old.corpCard !== e.corpCard) e.corpCard = RSStore.CARD_AMBIG;
    }
    if (old && old.type === e.type && old.card === e.card && old.corpCard === e.corpCard) return;
    var m = Object.assign({}, state.cardMemory); m[key] = e; setCardMemory(m);
    RSStore.writeCard(state.ws, key, e).catch(function (err) { console.warn('카드 기억 저장 실패', err); });
  }
  function loadSettingsCache() {
    try { return JSON.parse(localStorage.getItem(SET_KEY) || '{}') || {}; } catch (e) { return {}; }
  }
  function setSettings(o) {
    state.settings = o || {};
    try { localStorage.setItem(SET_KEY, JSON.stringify(state.settings)); } catch (e) { /* 무시 */ }
  }
  async function saveSettings(ch) {
    if (!navigator.onLine) throw new Error('오프라인입니다. 온라인에서 다시 저장해 주세요');
    if (!state.ws) throw new Error('아직 시트를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요');
    await RSStore.writeSettings(state.ws, ch);
    setSettings(Object.assign({}, state.settings, ch));
  }
  function saveCache(list) {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(list)); } catch (e) { /* 무시 */ }
  }

  // ── 월 ──
  var now = new Date();
  var current = { y: now.getFullYear(), m: now.getMonth() + 1 };
  var view = { y: current.y, m: current.m };
  function ym(v) { return v.y + '-' + String(v.m).padStart(2, '0'); }
  function isCurrent(v) { return v.y === current.y && v.m === current.m; }
  function shift(v, d) {
    var m = v.m + d, y = v.y;
    if (m < 1) { m = 12; y--; }
    if (m > 12) { m = 1; y++; }
    return { y: y, m: m };
  }
  function won(n) { return Number(n || 0).toLocaleString('ko-KR'); }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  function el(html) {
    var t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content;
  }

  var ICON = {
    prev: '<svg viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6"/></svg>',
    next: '<svg viewBox="0 0 24 24"><path d="M9 18l6-6-6-6"/></svg>',
    camera: '<svg viewBox="0 0 24 24"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>',
    clock: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#5E626A" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
    google: '<svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9 3.6l6.7-6.7C35.6 2.5 30.2 0 24 0 14.6 0 6.6 5.4 2.7 13.3l7.8 6C12.4 13.7 17.7 9.5 24 9.5z"/><path fill="#4285F4" d="M46.1 24.6c0-1.6-.1-3.1-.4-4.6H24v9h12.4c-.5 2.9-2.2 5.3-4.6 6.9l7.4 5.8c4.3-4 6.9-9.9 6.9-17.1z"/><path fill="#FBBC05" d="M10.5 28.7c-.5-1.4-.8-3-.8-4.7s.3-3.2.8-4.7l-7.8-6C1 16.6 0 20.2 0 24s1 7.4 2.7 10.7l7.8-6z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.4-5.8c-2.1 1.4-4.8 2.3-8.5 2.3-6.3 0-11.6-4.2-13.5-10l-7.8 6C6.6 42.6 14.6 48 24 48z"/></svg>'
  };

  // ── 화면: 로그인 전 ──
  function renderLogin(root) {
    root.appendChild(el(
      '<section class="welcome">' +
        '<img src="icons/icon-192.png" alt="" width="72" height="72">' +
        '<h1>영수증 스캔</h1>' +
        '<p>영수증을 찍어 구분별로 모으고<br>A4 청구본 PDF로 만듭니다.</p>' +
        '<button class="google-btn" id="loginBtn" type="button">' + ICON.google + 'Google로 로그인</button>' +
        (state.error ? '<p class="err" role="alert">' + esc(state.error) + '</p>' : '') +
        '<ul class="notes">' +
          '<li>사진과 장부는 <b>내 Google Drive</b>의 "영수증 스캔" 폴더에 저장됩니다.</li>' +
          '<li>앱은 자기가 만든 파일만 볼 수 있고, 다른 Drive 파일은 보지 않습니다.</li>' +
        '</ul>' +
        '<a class="policy" href="privacy.html">개인정보 처리방침</a>' +
      '</section>'
    ));
    root.querySelector('#loginBtn').onclick = onLogin;
  }

  async function onLogin(ev) {
    var btn = ev.currentTarget;
    btn.disabled = true;
    state.error = '';
    try {
      var u = await RSAuth.login();
      state.user = u;
      state.pending = null;
      render();
      await refresh();
    } catch (e) {
      if (e.notApproved) {
        state.user = { email: e.email, approved: false, name: e.name || '' };
        state.pending = { status: e.approvalStatus, message: e.message, googleName: e.googleName };
      } else {
        state.error = e.message || '로그인하지 못했습니다';
      }
      render();
    }
  }

  // ── 화면: 승인 대기 ──
  var PENDING_TEXT = {
    pending: ['관리자 승인을 기다리고 있습니다', '관리자가 승인하면 아래 [다시 확인]을 눌러 주세요.'],
    rejected: ['사용이 승인되지 않았습니다', '필요하면 관리자에게 문의해 주세요.'],
    disabled: ['사용이 중지되었습니다', '필요하면 관리자에게 문의해 주세요.']
  };
  function renderPending(root) {
    var st = (state.pending && state.pending.status) || 'pending';
    var t = PENDING_TEXT[st] || PENDING_TEXT.pending;
    var saved = state.user.name || '';
    var gname = (state.pending && state.pending.googleName) || '';
    var nameBox = st === 'pending' ?
      '<div class="namebox">' +
        '<label for="nameInput">이름 <span>관리자가 누구인지 알아볼 수 있게 적어 주세요</span></label>' +
        '<div class="namerow">' +
          '<input id="nameInput" type="text" maxlength="30" autocomplete="name" placeholder="예: 홍길동 대리" value="' + esc(state.nameSaving ? state.nameDraft : (saved || (state.pending && state.pending.googleName) || '')) + '">' +
          '<button class="mini ok" id="nameSave" type="button"' + (state.nameSaving ? ' disabled' : '') + '>' + (state.nameSaving ? '저장 중' : '저장') + '</button>' +
        '</div>' +
        '<div class="namestate' + (saved ? ' ok' : '') + '">' + (saved ? '관리자에게 보이는 이름: ' + esc(saved) : '아직 이름이 저장되지 않았습니다') + '</div>' +
        '<div class="gname">Google 계정 이름: ' + (gname ? '<b>' + esc(gname) + '</b>' : '<span class="none">아직 없음</span>') + '</div>' +
        (gname ? '' : '<button class="mini" id="gnameBtn" type="button">Google 이름 불러오기</button>' +
          '<div class="gnote">관리자가 본인 확인에 씁니다. 누르면 Google 로그인 창이 한 번 뜹니다.</div>') +
      '</div>' : '';
    root.appendChild(el(
      '<section class="welcome">' +
        '<img src="icons/icon-192.png" alt="" width="72" height="72">' +
        '<h1>' + esc(t[0]) + '</h1>' +
        '<p>' + esc(state.user.email) + '</p>' +
        nameBox +
        '<p>' + esc(t[1]) + '</p>' +
        '<button class="google-btn" id="recheckBtn" type="button">다시 확인</button>' +
        (state.error ? '<p class="err" role="alert">' + esc(state.error) + '</p>' : '') +
        '<button class="linkish" id="otherBtn" type="button">다른 계정으로 로그인</button>' +
      '</section>'
    ));
    root.querySelector('#recheckBtn').onclick = function (ev) {
      ev.currentTarget.disabled = true;
      state.pending = null; state.error = '';
      refresh();
    };
    root.querySelector('#otherBtn').onclick = logout;
    var ns = root.querySelector('#nameSave');
    if (ns) ns.onclick = function () { saveName(root.querySelector('#nameInput').value); };
    // Google 이름 불러오기: 로그인 창을 다시 띄워 이름(profile) 권한을 받음(버튼 클릭 안에서 호출해야 팝업이 열림)
    var gb = root.querySelector('#gnameBtn');
    if (gb) gb.onclick = onLogin;
  }

  async function saveName(value) {
    var v = String(value || '').replace(/\s+/g, ' ').trim();
    if (!v) { toast('이름을 적어 주세요'); return; }
    state.nameSaving = true; state.nameDraft = v; state.error = ''; render();
    try {
      state.user.name = await RSAuth.setName(v);
      toast('이름을 저장했습니다');
    } catch (e) {
      if (e.needLogin || e.status === 401) { state.error = '로그인이 만료되었습니다. [다른 계정으로 로그인]으로 다시 로그인해 주세요'; }
      else toast(e.message || '저장하지 못했습니다');
    } finally {
      state.nameSaving = false; render();
    }
  }

  async function logout() {
    await RSAuth.logout();
    RSCapture.reset();
    RSBox.reset();
    RSDetail.reset();
    RSPreview.reset();
    RSAttach.reset();
    state.selection = null;
    state.user = null; state.ws = null; state.receipts = []; state.error = ''; state.pending = null;
    state.admin = { list: null, loading: false, error: '', waiting: 0 };
    saveCache([]); setSettings({}); setBudgets([]); setCardMemory({});
    location.hash = '#/home';
    render();
  }

  // ── 화면: 홈 ──
  function renderHome(root) {
    if (!state.user) return renderLogin(root);
    if (state.pending) return renderPending(root);
    var month = ym(view);
    var total = 0, byCat = {}, pending = 0, need = 0;
    CATEGORIES.forEach(function (c) { byCat[c] = 0; });
    state.receipts.forEach(function (r) {
      if (r.month !== month || r.status === '제외') return;
      if (byCat[r.category] !== undefined) byCat[r.category] += r.amount;
      total += r.amount;
      if (r.status === '판독대기') pending++;
      if (r.status === '확인필요') need++;   // 합계에는 포함(금액이 있는 것만), 건수만 따로 알림
    });

    function catCard(c) {
      var body = '';
      if (BUDGET_CATS.indexOf(c) >= 0) {
        var b = budgetOf(c, month), left = b.total - byCat[c];
        var pct = b.total > 0 ? Math.min(100, Math.round(byCat[c] / b.total * 100)) : (byCat[c] > 0 && b.has ? 100 : 0);
        var over = b.has && left < 0;
        body = '<div class="bar' + (over ? ' over' : '') + '"><i style="width:' + pct + '%"></i></div>' +
          (b.has ? '<div class="budget">예산 <b>' + won(b.total) + '</b><br>잔액 <b' + (over ? ' class="neg">' + won(left) + ' (초과)' : '>' + won(left)) + '</b></div>'
                 : '<div class="budget">예산 —<br>잔액 —</div>');
      }
      return '<a class="cat' + (body ? '' : ' small') + '" href="#/box?cat=' + encodeURIComponent(c) + '" data-cat="' + c + '">' +
        '<div class="name">' + c + '</div>' +
        '<div class="sum">' + won(byCat[c]) + '<small>원</small></div>' + body +
      '</a>';
    }
    var cards = '<div class="grid">' + catCard('경비') + catCard('출장비') + '</div>' +
      '<div class="grid grid2">' + catCard('접대비') + catCard('회의비') + '</div>';
    var pays = payBreakdown(month);

    var banner = '';
    if (state.step) banner = '<div class="banner">' + esc(state.step) + '</div>';
    else if (state.error) banner = '<div class="banner warn" role="alert">' + esc(state.error) + '</div>';
    else if (state.offline) banner = '<div class="banner">오프라인입니다. 마지막으로 불러온 합계를 보여 줍니다.</div>';
    if (state.ocrStep) banner += '<div class="banner">AI가 영수증을 읽는 중 ' + esc(state.ocrStep) + ' · 앱을 닫지 말아 주세요</div>';
    if (state.uploadWaiting) {
      banner += RSQueue.busy()
        ? '<div class="banner up">Drive에 올리는 중 ' + state.uploadWaiting + '건 · 앱을 닫지 말아 주세요</div>'
        : '<button class="banner up" id="upBtn" type="button">업로드 대기 ' + state.uploadWaiting + '건' +
          (!navigator.onLine ? ' · 인터넷이 연결되면 올립니다' : ' · 누르면 다시 시도') + '</button>';
    }

    root.appendChild(el(
      '<header class="topbar">' +
        '<div class="month">' +
          '<button class="icon-btn" id="prevMonth" aria-label="이전 달">' + ICON.prev + '</button>' +
          '<h1>' + view.y + '년 ' + view.m + '월</h1>' +
          '<button class="icon-btn" id="nextMonth" aria-label="다음 달"' + (isCurrent(view) ? ' disabled' : '') + '>' + ICON.next + '</button>' +
        '</div>' +
        '<button class="avatar" id="avatar" aria-label="계정 메뉴">' + esc((state.user.name || state.user.email).charAt(0).toUpperCase()) + '</button>' +
      '</header>' +
      (RSAuth.isAdmin() && state.admin.waiting ? '<a class="banner" href="#/admin">승인을 기다리는 사용자가 ' + state.admin.waiting + '명 있습니다 ›</a>' : '') +
      banner +
      '<section class="total" aria-label="이번 달 사용 합계">' +
        '<div class="label">' + (isCurrent(view) ? '이번 달' : view.m + '월') + ' 사용 합계' + (state.loading ? ' · 불러오는 중' : '') + '</div>' +
        '<div class="amount"><b>' + won(total) + '</b><span>원</span></div>' +
        (pays.length ? '<div class="paylist">' + pays.map(function (p) {
          return '<div class="' + (p.sub ? 'sub' : '') + '"><span>' + (p.sub ? '└ ' : '') + esc(p.name) + '</span><b>' + won(p.amount) + '원</b></div>';
        }).join('') + '</div>' : '') +
      '</section>' +
      '<div class="section-head"><h2>구분별 사용</h2>' +
        ((pending || need) ? '<div class="chips">' +
          (pending ? '<div class="chip">' + ICON.clock + '판독 대기 ' + pending + '건</div>' : '') +
          (need ? '<a class="chip warn" href="#/box">확인 필요 ' + need + '건</a>' : '') + '</div>' : '') +
      '</div>' +
      cards +
      '<div class="cta-wrap"><button class="cta" id="capture">' + ICON.camera + '영수증 촬영</button></div>' +
      '<div class="version">v' + APP_VERSION + '</div>'
    ));

    root.querySelector('#prevMonth').onclick = function () { view = shift(view, -1); render(); };
    root.querySelector('#nextMonth').onclick = function () {
      if (!isCurrent(view)) { view = shift(view, 1); render(); }
    };
    root.querySelector('#capture').onclick = function () { location.hash = '#/capture'; };
    var ub = root.querySelector('#upBtn');
    if (ub) ub.onclick = function () { if (state.ws) kickQueue(); else refresh(); };
    root.querySelector('#avatar').onclick = openAccountSheet;
  }

  // 이번 달 결제 수단별 합계: 개인카드는 카드사별, 법인카드는 합계 + 카드별, 현금. 쓴 것만(0원은 안 보임)
  function payBreakdown(month) {
    var personal = {}, pOrder = [], corp = 0, corpBy = {}, cOrder = [], cash = 0;
    state.receipts.forEach(function (r) {
      if (r.month !== month || r.status === '제외' || !(r.amount > 0)) return;
      if (r.cardType === '법인카드') {
        corp += r.amount;
        var k = r.corpCard || '카드 미선택';
        if (!(k in corpBy)) { corpBy[k] = 0; cOrder.push(k); }
        corpBy[k] += r.amount;
      } else if (r.cardType === '현금' || String(r.card).trim() === '현금') {
        cash += r.amount;
      } else {
        var n = String(r.card || '').trim() || '카드사 미입력';
        if (!(n in personal)) { personal[n] = 0; pOrder.push(n); }
        personal[n] += r.amount;
      }
    });
    var out = [];
    pOrder.sort(function (a, b) { return personal[b] - personal[a]; }).forEach(function (n) { out.push({ name: n, amount: personal[n] }); });
    if (corp > 0) {
      out.push({ name: '법인카드', amount: corp });
      cOrder.sort(function (a, b) { return corpBy[b] - corpBy[a]; }).forEach(function (n) { out.push({ name: n, amount: corpBy[n], sub: true }); });
    }
    if (cash > 0) out.push({ name: '현금', amount: cash });
    return out;
  }

  // ── 예산 계산 ──
  function spentOf(cat, month) {
    return state.receipts.reduce(function (a, r) { return a + (r.month === month && r.status !== '제외' && r.category === cat ? r.amount : 0); }, 0);
  }
  // 기본 = 그 달 이전(포함)에 정한 것 중 가장 최근. 이월·추가 = 그 달 것만
  function budgetOf(cat, month) {
    var base = null, carry = null, adds = [];
    state.budgets.forEach(function (b) {
      if (b.category !== cat) return;
      if (b.type === '기본' && b.month <= month && (!base || b.month >= base.month)) base = b;
      else if (b.type === '이월' && b.month === month) carry = b;
      else if (b.type === '추가' && b.month === month) adds.push(b);
    });
    var total = (base ? base.amount : 0) + (carry ? carry.amount : 0) + adds.reduce(function (a, b) { return a + b.amount; }, 0);
    return { base: base, carry: carry, adds: adds, total: total, has: !!(base || carry || adds.length) };
  }
  function digits(v) { var d = String(v || '').replace(/[^\d]/g, ''); return d === '' ? null : Number(d); }
  function newBudgetId() { return 'B' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

  // ── 화면: 예산 ──
  function renderBudget(root) {
    if (!state.user) return renderLogin(root);
    if (state.pending) return renderPending(root);
    var month = ym(view), pv = shift(view, -1), pmonth = ym(pv);
    var dis = '';
    function inp(attrs, val) {
      return '<input class="bg-in" type="text" inputmode="numeric" autocomplete="off" ' + attrs + ' value="' + (val == null ? '' : won(val)) + '" placeholder="0"' + dis + '>';
    }
    var cardsHtml = BUDGET_CATS.map(function (c) {
      var b = budgetOf(c, month), used = spentOf(c, month), left = b.total - used;
      var p = budgetOf(c, pmonth), pleft = p.total - spentOf(c, pmonth);
      var baseNote = b.base && b.base.month !== month ? Number(b.base.month.slice(5)) + '월에 정한 금액 · 바꾸면 이 달부터' : '매달 자동 적용 · 바꾸면 이 달부터';
      return '<div class="bg-card" data-cat="' + c + '"><h3>' + c + '<small>' + view.m + '월</small></h3>' +
        '<div class="bg-row"><div class="l">기본 월 예산<small>' + baseNote + '</small></div>' + inp('data-b="base"', b.base ? b.base.amount : null) + '</div>' +
        '<div class="bg-row"><div class="l">전월 이월<small>이 달만 · 직접 입력</small>' +
          (p.has ? '<div class="bg-hint">참고: ' + pv.m + '월 잔액 ' + won(pleft) + '원</div>' : '') + '</div>' +
          inp('data-b="carry"', b.carry ? b.carry.amount : null) + '</div>' +
        b.adds.map(function (a) {
          return '<div class="bg-row bg-addrow"><div class="l">추가 예산<input class="bg-memo" type="text" maxlength="40" data-b="memo" data-id="' + esc(a.id) + '" value="' + esc(a.memo) + '" placeholder="메모 (예: 9/28 추가 기안)"' + dis + '></div>' +
            '<div class="bg-r">' + inp('data-b="add" data-id="' + esc(a.id) + '"', a.amount || null) +
            '<button class="bg-x" type="button" data-del="' + esc(a.id) + '" aria-label="추가 예산 빼기"' + dis + '>×</button></div></div>';
        }).join('') +
        '<button class="bg-add" type="button" data-addcat="' + c + '"' + dis + '>+ 추가 예산 넣기 (기안)</button>' +
        '<div class="bg-sum"><div>이 달 예산<b>' + won(b.total) + '</b></div><div>사용<b>' + won(used) + '</b></div>' +
          '<div>잔액<b' + (left < 0 ? ' class="neg"' : '') + '>' + won(left) + '</b></div></div>' +
      '</div>';
    }).join('');
    root.appendChild(el(
      '<header class="topbar">' +
        '<div class="month">' +
          '<button class="icon-btn" id="prevMonth" aria-label="이전 달">' + ICON.prev + '</button>' +
          '<h1>' + view.y + '년 ' + view.m + '월</h1>' +
          '<button class="icon-btn" id="nextMonth" aria-label="다음 달"' + (isCurrent(view) ? ' disabled' : '') + '>' + ICON.next + '</button>' +
        '</div>' +
        '<button class="avatar" id="avatar" aria-label="계정 메뉴">' + esc((state.user.name || state.user.email).charAt(0).toUpperCase()) + '</button>' +
      '</header>' +
      '<h1 class="page-title bg-title">예산</h1>' +
      '<div class="bg-note">접대비·회의비만 예산이 있어요. 경비·출장비는 예산 없이 사용 금액만 봅니다.<br>금액을 넣으면 바로 저장됩니다 (시트 \'예산\' 탭).</div>' +
      cardsHtml
    ));
    root.querySelector('#prevMonth').onclick = function () { view = shift(view, -1); render(); };
    root.querySelector('#nextMonth').onclick = function () { if (!isCurrent(view)) { view = shift(view, 1); render(); } };
    root.querySelector('#avatar').onclick = openAccountSheet;
    root.querySelectorAll('.bg-in').forEach(function (i) {
      i.oninput = function () { var d = digits(i.value); i.value = d == null ? '' : won(d); };
      i.onfocus = function () { try { i.select(); } catch (e) { /* 무시 */ } };
      i.onchange = function () { onBudgetChange(i.closest('.bg-card').dataset.cat, month, i.dataset.b, i.dataset.id, digits(i.value)); };
    });
    root.querySelectorAll('.bg-memo').forEach(function (i) {
      i.onchange = function () { onBudgetChange(i.closest('.bg-card').dataset.cat, month, 'memo', i.dataset.id, i.value.trim()); };
    });
    root.querySelectorAll('[data-del]').forEach(function (bt) {
      bt.onclick = function () { onBudgetChange(bt.closest('.bg-card').dataset.cat, month, 'del', bt.dataset.del); };
    });
    root.querySelectorAll('[data-addcat]').forEach(function (bt) {
      bt.onclick = function () {
        var list = state.budgets.slice();
        list.push({ id: newBudgetId(), month: month, category: bt.dataset.addcat, type: '추가', amount: 0, memo: '' });
        saveBudgetList(list, true, function () {
          var ins = document.querySelectorAll('.bg-card[data-cat="' + bt.dataset.addcat + '"] input[data-b="add"]');
          if (ins.length) ins[ins.length - 1].focus();
        });
      };
    });
  }

  function onBudgetChange(cat, month, what, id, val) {
    var list = state.budgets.map(function (b) { return Object.assign({}, b); });
    var now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    function upsert(type) {
      var i = list.findIndex(function (b) { return b.category === cat && b.type === type && b.month === month; });
      if (val == null || (type === '이월' && val === 0)) { if (i >= 0) list.splice(i, 1); }   // 비우면 그 달 값 지움(기본은 이전 달 금액으로 돌아감)
      else if (i >= 0) { list[i].amount = val; list[i].updatedAt = now; }
      else list.push({ id: newBudgetId(), month: month, category: cat, type: type, amount: val, memo: '', updatedAt: now });
    }
    if (what === 'base') upsert('기본');
    else if (what === 'carry') upsert('이월');
    else {
      var j = list.findIndex(function (b) { return b.id === id; });
      if (j < 0) return;
      if (what === 'del') list.splice(j, 1);
      else if (what === 'add') { list[j].amount = val || 0; list[j].updatedAt = now; }
      else if (what === 'memo') { list[j].memo = val; list[j].updatedAt = now; }
    }
    saveBudgetList(list, what === 'del');
  }

  // 화면에 먼저 반영하고, 시트 저장은 순서대로 한 번씩(빠르게 여러 칸을 고쳐도 앞의 변경이 사라지지 않게)
  // 금액·메모를 고칠 때는 화면을 다시 그리지 않고 합계만 바꿈(다른 칸을 누른 것이 끊기지 않게)
  var budgetChain = Promise.resolve();
  function saveBudgetList(list, full, after) {
    if (!navigator.onLine) { toast('오프라인입니다. 온라인에서 다시 입력해 주세요'); render(); return; }
    if (!state.ws) { toast('아직 시트를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요'); render(); return; }
    setBudgets(list);
    if (full) { render(); if (after) after(); } else updateBudgetSums();
    budgetChain = budgetChain.then(async function () {
      try {
        await RSStore.saveBudgets(state.ws, state.budgets);
        toast('저장했습니다');
      } catch (e) {
        console.warn(e, e.detail);
        toast('저장하지 못했습니다. 시트 값으로 되돌립니다');
        try { setBudgets(await RSStore.readBudgets(state.ws)); } catch (e2) { /* 무시 */ }
        if (document.querySelector('.bg-card')) render();
      }
    });
  }
  function updateBudgetSums() {
    var month = ym(view);
    document.querySelectorAll('.bg-card').forEach(function (card) {
      var c = card.dataset.cat, b = budgetOf(c, month), used = spentOf(c, month), left = b.total - used;
      card.querySelector('.bg-sum').innerHTML = '<div>이 달 예산<b>' + won(b.total) + '</b></div><div>사용<b>' + won(used) + '</b></div>' +
        '<div>잔액<b' + (left < 0 ? ' class="neg"' : '') + '>' + won(left) + '</b></div>';
      var bi = card.querySelector('[data-b="base"]');
      if (bi && document.activeElement !== bi) bi.value = b.base ? won(b.base.amount) : '';
    });
  }

  // ── 계정 메뉴 ──
  function openAccountSheet() {
    var ws = state.ws || RSStore.workspace(state.user.email);
    var wrap = document.createElement('div');
    wrap.className = 'sheet-backdrop';
    wrap.innerHTML =
      '<div class="sheet" role="dialog" aria-label="계정">' +
        '<div class="grab"></div>' +
        '<div class="sheet-email">' + (state.user.name ? '<b>' + esc(state.user.name) + '</b><br>' : '') + esc(state.user.email) + '</div>' +
        '<a class="sheet-item" href="#/me" id="meLink">내 정보 (갑지 머리글·차량)</a>' +
        (ws ? '<a class="sheet-item" href="' + RSStore.sheetUrl(ws) + '" target="_blank" rel="noopener">영수증 장부(시트) 열기</a>' +
              '<a class="sheet-item" href="' + RSStore.folderUrl(ws) + '" target="_blank" rel="noopener">Drive 폴더 열기</a>' : '') +
        (RSAuth.isAdmin() ? '<a class="sheet-item" href="#/admin" id="adminLink">사용자 승인' + (state.admin.waiting ? ' (' + state.admin.waiting + ')' : '') + '</a>' : '') +
        '<button class="sheet-item" id="reloadBtn" type="button">새로고침</button>' +
        '<button class="sheet-item danger" id="logoutBtn" type="button">로그아웃</button>' +
        '<a class="sheet-item sub" href="privacy.html">개인정보 처리방침</a>' +
      '</div>';
    wrap.onclick = function (e) { if (e.target === wrap) wrap.remove(); };
    document.body.appendChild(wrap);
    wrap.querySelector('#meLink').onclick = function () { wrap.remove(); };
    wrap.querySelector('#reloadBtn').onclick = function () { wrap.remove(); refresh(); };
    var al = wrap.querySelector('#adminLink');
    if (al) al.onclick = function () { wrap.remove(); };
    wrap.querySelector('#logoutBtn').onclick = function () { wrap.remove(); logout(); };
  }

  // ── 시트에서 다시 읽기 ──
  async function refresh() {
    if (!state.user || state.loading) return;
    state.loading = true; state.error = ''; render();
    try {
      // 로그인 확인(승인 여부 포함)을 먼저 하고, 관리자면 승인 목록은 시트와 별개로 불러옴
      await RSAuth.getToken();
      state.authChecked = true;
      state.user.name = (RSAuth.user() || {}).name || '';
      if (RSAuth.isAdmin()) loadAdmin(true);
      state.ws = await RSStore.ensureWorkspace(state.user.email, function (msg) { state.step = msg; render(); });
      state.step = '';
      state.receipts = await RSStore.readReceipts(state.ws);
      try { setSettings(await RSStore.readSettings(state.ws)); } catch (e) { console.warn('설정 탭', e, e.detail); }
      try { setBudgets(await RSStore.readBudgets(state.ws)); } catch (e) { console.warn('예산 탭', e, e.detail); }
      try { setCardMemory(await RSStore.readCards(state.ws)); } catch (e) { console.warn('카드 탭', e, e.detail); }
      state.offline = false;
      saveCache(state.receipts);
      kickQueue();
      kickOcr();
      RSQueue.cleanup(state.user.email).catch(function () {});
      runBackup();
    } catch (e) {
      state.step = ''; state.authChecked = true;
      if (e.notApproved) {
        state.pending = { status: e.approvalStatus, message: e.message, googleName: e.googleName };
        state.user.name = e.name || '';
      } else if (e.needLogin) {
        state.user = null;
        state.error = e.message;
      } else if (!navigator.onLine || e instanceof TypeError) {
        state.offline = true;
      } else {
        state.error = '시트를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요. (' + (e.message || '오류') + ')';
        console.warn(e, e.detail);
      }
    } finally {
      state.loading = false;
      render();
    }
  }

  // ── 화면: 보관함·예산 (자리만) ──
  function renderPlaceholder(root, title, msg) {
    root.appendChild(el(
      '<h1 class="page-title">' + title + '</h1>' +
      '<div class="empty"><b>준비 중</b>' + msg + '</div>'
    ));
  }

  // ── 화면: 사용자 승인(관리자) ──
  var STATUS_LABEL = { pending: '승인 대기', approved: '사용 중', disabled: '사용 중지', rejected: '거절됨' };
  async function loadAdmin(quiet) {
    state.admin.loading = true; if (!quiet) render();
    try {
      var d = await RSAuth.admin('/v1/admin/users');
      state.admin.list = d.users || [];
      state.admin.waiting = state.admin.list.filter(function (u) { return u.status === 'pending'; }).length;
      state.admin.error = '';
    } catch (e) {
      state.admin.error = e.message || '목록을 불러오지 못했습니다';
    } finally {
      state.admin.loading = false; render();
    }
  }
  async function setStatus(email, status, label, name) {
    if (!confirm((name ? name + ' (' + email + ')' : email) + '\n' + label + ' 처리할까요?')) return;
    try {
      await RSAuth.admin('/v1/admin/users/status', { email: email, status: status });
      toast(label + ' 처리했습니다');
    } catch (e) { toast(e.message || '처리하지 못했습니다'); }
    loadAdmin(true);
  }
  function fmtDate(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }
  function renderAdmin(root) {
    if (!RSAuth.isAdmin()) {
      // 앱을 막 열어 로그인 확인 중이면 잠시 기다림
      if (!state.authChecked) { root.appendChild(el('<div class="empty"><b>확인 중…</b></div>')); return; }
      location.hash = '#/home'; return;
    }
    if (!state.admin.list && !state.admin.loading) loadAdmin();
    var a = state.admin;
    var rows = (a.list || []).map(function (u) {
      var btns = '';
      if (!u.isAdmin) {
        if (u.status === 'pending') btns = '<button class="mini ok" data-e="' + esc(u.email) + '" data-n="' + esc(u.name || '') + '" data-s="approved" data-l="승인">승인</button><button class="mini" data-e="' + esc(u.email) + '" data-n="' + esc(u.name || '') + '" data-s="rejected" data-l="거절">거절</button>';
        else if (u.status === 'approved') btns = '<button class="mini" data-e="' + esc(u.email) + '" data-n="' + esc(u.name || '') + '" data-s="disabled" data-l="사용 중지">사용 중지</button>';
        else btns = '<button class="mini ok" data-e="' + esc(u.email) + '" data-n="' + esc(u.name || '') + '" data-s="approved" data-l="승인">승인</button>';
      }
      return '<div class="urow">' +
        '<div class="uinfo"><div class="uname' + (u.name ? '' : ' none') + '">' + (u.name ? esc(u.name) : '이름 없음') + (u.isAdmin ? ' <span class="tag">관리자</span>' : '') + '</div>' +
        '<div class="ugname">Google 이름: ' + (u.googleName ? esc(u.googleName) : '<span class="m m-none">아직 없음</span>') + '</div>' +
        '<div class="uemail">' + esc(u.email) + '</div>' +
        '<div class="umeta"><span class="st st-' + u.status + '">' + (STATUS_LABEL[u.status] || u.status) + '</span>' +
        (u.requestedAt ? ' · 신청 ' + fmtDate(u.requestedAt) : '') + '</div></div>' +
        '<div class="ubtns">' + btns + '</div></div>';
    }).join('');
    root.appendChild(el(
      '<header class="topbar"><div class="month"><a class="icon-btn" href="#/home" aria-label="홈으로">' + ICON.prev + '</a><h1 style="text-align:left">사용자 승인</h1></div></header>' +
      (a.error ? '<div class="banner warn" role="alert">' + esc(a.error) + '</div>' : '') +
      '<div class="ulist">' + (a.loading && !a.list ? '<div class="empty">불러오는 중…</div>' : (rows || '<div class="empty">아직 로그인한 사용자가 없습니다</div>')) + '</div>' +
      '<p class="hint">직원이 앱에서 Google로 로그인하면 여기에 "승인 대기"로 나타납니다.</p>'
    ));
    root.querySelectorAll('button.mini').forEach(function (b) {
      b.onclick = function () { setStatus(b.dataset.e, b.dataset.s, b.dataset.l, b.dataset.n); };
    });
  }

  // ── 업로드 대기열 ──
  function updateWaiting() {
    if (!state.user) return;
    RSQueue.pending(state.user.email).then(function (list) {
      state.uploadWaiting = list.length;
      var last = list.filter(function (x) { return x.error; })[0];
      state.uploadError = last ? last.error : '';
      var t = currentTab();
      if (t === 'home' || t === 'box') render();
    }).catch(function () {});
  }
  RSQueue.onChange(updateWaiting);

  // 백업: 하루 한 번(이 기기에서 그날 처음 연 때) 장부 시트를 Drive '백업' 폴더에 복사. 관리자는 서버 자료도 저장. 실패해도 앱 사용에는 영향 없음
  function runBackup() {
    var d = new Date(), p2 = function (n) { return String(n).padStart(2, '0'); };
    var day = d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
    var key = 'rs.backup.' + state.user.email;
    try { if (localStorage.getItem(key) === day) return; } catch (e) { /* 무시 */ }
    var ws = state.ws;
    (async function () {
      await RSStore.backupLedger(ws, day);
      if (RSAuth.isAdmin()) await RSStore.backupServer(ws, day, await RSAuth.admin('/v1/admin/backup'));
      try { localStorage.setItem(key, day); } catch (e) { /* 무시 */ }
    })().catch(function (e) { console.warn('백업 실패(다음에 앱을 열 때 다시 시도)', e, e && e.detail); });
  }

  // AI 판독: 판독대기 영수증을 하나씩 판독(앱이 열려 있을 때만). 설정·상한·인터넷 문제로 멈추면 5분 뒤에 다시 시도
  var ocrPausedUntil = 0;
  function kickOcr() {
    if (!window.RSOcr || RSOcr.busy() || !state.user || !state.ws || !navigator.onLine || Date.now() < ocrPausedUntil) return;
    var list = state.receipts.filter(function (r) {
      return r.status === '판독대기' && r.kind !== '첨부' && r.fileId && (r.tries || 0) < RSOcr.MAX_TRIES;
    });
    if (!list.length) return;
    state.ocrStep = '0/' + list.length; render();
    RSOcr.run(state.ws, list, {
      blobOf: function (it) { return RSQueue.get(it.id).then(function (q) { return q && q.blob ? q.blob : null; }).catch(function () { return null; }); },
      memory: function () { return state.cardMemory; },
      onStep: function (n, total) { state.ocrStep = n + '/' + total; if (currentTab() === 'home') render(); },
      onDone: function (id) { RSQueue.release(id).catch(function () {}); }
    }).then(function (out) {
      state.ocrStep = '';
      if (!out) return;
      if (out.stop) { ocrPausedUntil = Date.now() + 5 * 60000; toast(out.stop); }
      var msg = [];
      if (out.done) msg.push(out.done + '건 판독 완료');
      if (out.need) msg.push(out.need + '건 확인 필요');
      if (msg.length) toast('AI 판독: ' + msg.join(' · '));
      if (out.done || out.need || out.failed) refresh(); else render();
    }).catch(function (e) { state.ocrStep = ''; console.warn('ocr', e); render(); });
  }

  function kickQueue() {
    if (!state.user || !state.ws || !navigator.onLine) { updateWaiting(); return; }
    RSQueue.process(state.ws, state.user.email).then(function (changed) {
      if (changed) toast('Drive에 올렸습니다' + (changed > 1 ? ' (' + changed + '장)' : ''));
      // 새 줄이 시트에 들어갔으면 합계를 다시 읽음(촬영 화면에 있는 동안은 돌아왔을 때)
      if (changed) { if (currentTab() === 'capture') state.needRefresh = true; else refresh(); }
    }).catch(function (e) {
      if (e && e.notApproved) state.pending = { status: e.approvalStatus, message: e.message, googleName: e.googleName };
      updateWaiting();
    });
  }

  function query() {
    var q = {}, s = location.hash.split('?')[1] || '';
    s.split('&').forEach(function (kv) { if (!kv) return; var i = kv.indexOf('='); q[decodeURIComponent(i < 0 ? kv : kv.slice(0, i))] = i < 0 ? '' : decodeURIComponent(kv.slice(i + 1)); });
    return q;
  }

  function renderCapture(root) {
    var q = query();
    if (q.from) state.captureFrom = q.from;
    RSCapture.mount(root, {
      email: state.user.email,
      category: q.cat || '',
      toast: toast,
      onSaved: function () { updateWaiting(); kickQueue(); },
      onClose: function (n) {
        var from = state.captureFrom; state.captureFrom = '';
        location.hash = from === 'box' ? '#/box' : '#/home';
        if (n) toast(n + '장 저장했습니다');
        if (state.needRefresh) { state.needRefresh = false; refresh(); }
      }
    });
  }

  // ── 화면: 보관함 ──
  function renderBox(root) {
    if (!state.user || state.pending) return renderHome(root);
    var q = query();
    RSBox.render(root, {
      email: state.user.email,
      receipts: state.receipts,
      month: ym(view),
      category: q.cat || '',
      loading: state.loading,
      error: state.error,
      offline: state.offline,
      ws: state.ws,
      toast: toast,
      refresh: function () { refresh(); kickQueue(); },
      go: function (h) { location.hash = h; },
      isActive: function () { return currentTab() === 'box'; },
      rerender: render,
      statusAction: statusAction,
      bulkStatus: bulkStatus,
      deleteForever: function (ids) {
        if (!state.ws || !navigator.onLine) { toast('온라인에서만 삭제할 수 있습니다'); return; }
        toast('삭제하는 중…');
        RSStore.deleteReceipts(state.ws, ids).then(function (r) {
          toast(r.deleted + '건을 영구 삭제했습니다' + (r.skipped.length ? ' · ' + r.skipped.length + '건은 PC에서 상태가 바뀌어 그대로 둠' : '') + (r.trashFailed ? ' · 사진 ' + r.trashFailed + '장은 휴지통으로 못 옮김' : ''));
          refresh();
        }).catch(function (e) { toast(e.message || '삭제하지 못했습니다'); refresh(); });
      },
      startPreview: function (sel) { state.selection = sel; location.hash = '#/preview'; },
      setMonth: function (y, m) { view = { y: y, m: m }; render(); },
      fileInfo: function (id) { return RSStore.fileInfo(id); },
      findMerged: function (id) { return RSStore.findMerged(id); },
      mergeGapji: mergeGapji,
      unclaimAll: function (ids, pdfId) {
        RSStore.setClaimStatus(state.ws, ids.map(function (id) { return { id: id, status: '보관중', pdfId: '', claimedAt: '', expect: ['청구완료'] }; }), localIsoNow())
          .then(async function (r) {
            var n = ids.length - r.skipped.length;
            // 모두 되돌렸을 때만 파일을 지움(PC에서 바뀐 줄이 남아 있으면 그 줄이 아직 이 PDF를 가리킴)
            if (pdfId && !r.skipped.length) {
              var t = await RSStore.trashClaimFiles(pdfId);
              toast(n + '건을 보관중으로 되돌리고 PDF 파일을 휴지통으로 옮겼습니다' + (t.failed ? ' (' + t.failed + '개는 못 옮김)' : ''));
            } else toast(n + '건을 보관중으로 되돌렸습니다' + (r.skipped.length ? ' · PC에서 바뀐 ' + r.skipped.length + '건이 있어 PDF 파일은 그대로 둠' : ''));
            refresh();
          })
          .catch(function (e) { toast(e.message || '되돌리지 못했습니다'); });
      },
      quickEdit: function (it, ch, msg) {
        editReceipt(it.id, ch, it).then(function (res) { toast(res.conflicts.length ? 'PC에서 수정된 값으로 바뀌었습니다' : msg); render(); })
          .catch(function (e) { toast(e.message || '바꾸지 못했습니다'); });
      }
    });
    // 구분을 주소에 남기지 않음(다시 그릴 때 사용자가 고른 구분이 덮어써지지 않게)
    if (q.cat) history.replaceState(null, '', '#/box');
  }

  // ── 화면: 영수증 상세 ──
  // 이 PDF로 청구된 다른 영수증 수(except = 빼고 셀 영수증)
  function pdfShare(pdfId, except) {
    return state.receipts.filter(function (r) { return r.pdfId === pdfId && r.id !== except && r.status === '청구완료'; }).length;
  }
  function findItem(id) { return RSBox.itemById(id, state.receipts, state.user.email); }
  function renderDetail(root) {
    if (!state.user || state.pending) return renderHome(root);
    var id = query().id || '';
    RSDetail.render(root, {
      receipt: findItem(id),
      offline: state.offline || !navigator.onLine,
      toast: toast,
      back: function () { var b = state.detailBack || '#/box'; state.detailBack = ''; location.hash = b; },
      isActive: function () { return currentTab() === 'detail'; },
      rerender: render,
      edit: editReceipt,
      statusAction: statusAction,
      pdfShare: pdfShare,
      learnCard: learnCard,
      retryUpload: kickQueue,
      settings: function () { return state.settings || {}; },
      saveSettings: saveSettings,
      photoBlob: async function (r) {
        var b = RSBox.localBlob(r.id);
        if (b) return b;
        if (!r.fileId) throw new Error('원본 파일 없음');
        return RSStore.download(r.fileId);
      }
    });
  }

  // 영수증 값 고치기: 바뀐 칸만 씀. orig = 화면을 열 때의 값. 그사이 PC에서 같은 칸이 바뀌었으면 PC 값을 남김
  var FIELD_LABEL = { category: '구분', txAt: '거래일시', amount: '금액', merchant: '가맹점명', address: '가맹점 주소', desc: '내역', memo: '메모',
    month: '귀속 월', widthMm: '영수증 폭', rot: '회전', guest: '접대상대방', topic: '내용', transport: '교통수단', driveTime: '운행시간', account: '계정', fuel: '주유량', work: '업무내용',
    car: '업무용 차량', from: '출발지', to: '도착지', km: '운행거리', tripDate: '출장일', attendees: '참석자', card: '카드사', cardType: '카드 구분', corpCard: '법인카드', status: '상태', reason: '확인 사유', pdfId: '청구 PDF', claimedAt: '청구일시' };
  function cmpVal(r, k) {
    if (k === 'amount') return r.hasAmount ? String(r.amount) : '';
    if (k === 'rot') return String((r.rot || 0) * 90);
    if (k === 'txAt') return String(r.txAt || '').slice(0, 16);
    if (k === 'tripDate') return String(r.tripDate || '').slice(0, 10);
    if (k === 'widthMm') return String(r.widthMm || '');
    return String(r[k] == null ? '' : r[k]);
  }
  async function editReceipt(id, ch, orig) {
    if (!navigator.onLine) throw new Error('오프라인입니다. 온라인에서 다시 저장해 주세요');
    if (!state.ws) throw new Error('아직 시트를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요');
    var found = await RSStore.findRow(state.ws, id);
    if (!found) throw new Error('시트에서 이 영수증을 찾지 못했습니다. PC에서 줄이 지워졌을 수 있습니다');
    var cur = RSStore.parseRow(found.values), conflicts = [], write = {};
    Object.keys(ch).forEach(function (k) {
      if (orig && cmpVal(cur, k) !== cmpVal(orig, k)) { conflicts.push(FIELD_LABEL[k] || k); return; }
      write[k] = ch[k];
    });
    // 상태가 PC에서 바뀌었으면 상태에 딸린 칸도 쓰지 않음
    if (write.status === undefined && ch.status !== undefined) { delete write.reason; delete write.pdfId; delete write.claimedAt; }
    if (Object.keys(write).length) {
      write.updatedAt = localIsoNow();
      await RSStore.writeCells(state.ws, found.row, write);
    }
    var again = await RSStore.findRow(state.ws, id);
    if (again) {
      var nr = RSStore.parseRow(again.values);
      state.receipts = state.receipts.map(function (x) { return x.id === id ? nr : x; });
      if (!state.receipts.some(function (x) { return x.id === id; })) state.receipts.push(nr);
      saveCache(state.receipts);
    }
    return { conflicts: conflicts };
  }
  function localIsoNow() {
    var d = new Date(), p = function (n) { return String(n).padStart(2, '0'); };
    var off = -d.getTimezoneOffset(), sign = off >= 0 ? '+' : '-'; off = Math.abs(off);
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) + sign + p(Math.floor(off / 60)) + ':' + p(off % 60);
  }

  // 제외 · 복원 · 보관중으로 되돌리기
  async function statusAction(kind, it) {
    var ch, msg;
    if (kind === 'exclude') { ch = { status: '제외' }; msg = '제외했습니다'; }
    else if (kind === 'restore') { ch = { status: it.txAt && it.hasAmount ? '보관중' : (it.reason ? '확인필요' : '판독대기') }; msg = '복원했습니다'; }
    else { ch = { status: '보관중', pdfId: '', claimedAt: '' }; msg = '보관중으로 되돌렸습니다'; }
    var prev = it.status, oldPdf = kind === 'unclaim' ? it.pdfId : '';
    try {
      var res = await editReceipt(it.id, ch, it);
      render();
      if (res.conflicts.length) { toast('PC에서 상태가 바뀌어 있어 그대로 두었습니다'); return; }
      if (kind === 'exclude') {
        undoToast(msg, function () {
          var now = findItem(it.id);
          editReceipt(it.id, { status: prev }, now).then(function () { toast('되돌렸습니다'); render(); })
            .catch(function (e) { toast(e.message || '되돌리지 못했습니다'); });
        });
      } else if (oldPdf && !pdfShare(oldPdf, it.id)) {
        // 이 PDF에 남은 영수증이 없으면 파일(갑지 합본 포함)을 휴지통으로
        var t = await RSStore.trashClaimFiles(oldPdf);
        toast(msg + ' · PDF 파일을 휴지통으로 옮겼습니다' + (t.failed ? ' (' + t.failed + '개는 못 옮김)' : ''));
      } else if (oldPdf) toast(msg + ' · 이 PDF에 다른 영수증이 남아 있어 파일은 그대로 둡니다');
      else toast(msg);
    } catch (e) {
      toast(e.message || '처리하지 못했습니다');
      render();
      throw e;
    }
  }

  // 출장비: 결재 갑지 PDF + 청구(영수증) PDF → "갑지+영수증" 새 파일(같은 청구본 폴더). 이미 있으면 그 파일 내용을 바꿈
  async function mergeGapji(pdfId, file, existing) {
    try {
      if (!navigator.onLine || !state.ws) throw new Error('온라인에서만 만들 수 있습니다');
      toast('갑지를 붙이는 중…');
      var gbuf = await file.arrayBuffer();
      if (await RSPdf.isEncrypted(gbuf)) {
        var plain = null, pw = '';
        for (var tries = 0; tries < 3 && !plain; tries++) {
          try { plain = await RSPdf.unlock(gbuf, pw); }
          catch (e) {
            if (!e.pw) throw e;
            pw = prompt((e.pw === 'wrong' ? '비밀번호가 맞지 않습니다. ' : '') + '갑지 PDF 비밀번호를 입력해 주세요 (저장하지 않음)');
            if (pw === null) return null;
          }
        }
        if (!plain) throw new Error('갑지 PDF 암호를 풀지 못했습니다');
        gbuf = await plain.arrayBuffer();
      }
      var claim = await RSStore.download(pdfId);
      var L = await RSPdf.lib('pdflib'), out = await L.PDFDocument.create();
      var add = async function (buf) { var d = await L.PDFDocument.load(buf); (await out.copyPages(d, d.getPageIndices())).forEach(function (p) { out.addPage(p); }); };
      await add(gbuf);
      await add(await claim.arrayBuffer());
      var blob = new Blob([await out.save()], { type: 'application/pdf' });
      var r;
      if (existing && existing.id) { r = await RSStore.replacePdf(existing.id, blob); r = { id: existing.id, name: (r && r.name) || existing.name }; }
      else {
        var info = await RSStore.fileInfo(pdfId);
        var base = (info.name || '출장_영수증.pdf');
        var name = /_영수증_/.test(base) ? base.replace('_영수증_', '_갑지+영수증_') : base.replace(/\.pdf$/i, '') + '_갑지.pdf';
        var folder = info.parents && info.parents[0];
        name = await RSStore.freeName(folder, name);
        r = await RSStore.uploadMerged(folder, name, blob, pdfId);
      }
      toast('"' + r.name + '"을 만들었습니다' + (blob.size > RSPdf.LIMIT ? ' · 10MB 넘음(' + (blob.size / 1048576).toFixed(1) + 'MB)' : ''));
      return r;
    } catch (e) {
      toast(e.message || '갑지를 붙이지 못했습니다');
      throw e;
    }
  }

  // 여러 건 한 번에 제외·복원(보관함 선택 바)
  function restoreStatus(it) { return it.txAt && it.hasAmount ? '보관중' : (it.reason ? '확인필요' : '판독대기'); }
  function bulkStatus(kind, items, quiet) {
    if (!state.ws || !navigator.onLine) { toast('온라인에서만 바꿀 수 있습니다'); return Promise.resolve(); }
    var now = localIsoNow(), list = items.map(function (it) {
      return kind === 'exclude' ? { id: it.id, status: '제외', pdfId: it.pdfId || '', claimedAt: it.claimedAt || '', expect: ['보관중', '판독대기', '확인필요'] }
        : { id: it.id, status: kind === 'back' ? it.st : restoreStatus(it), pdfId: it.pdfId || '', claimedAt: it.claimedAt || '', expect: ['제외'] };
    });
    return RSStore.setClaimStatus(state.ws, list, now).then(function (r) {
      var n = items.length - r.skipped.length, skip = r.skipped.length ? ' · ' + r.skipped.length + '건은 PC에서 상태가 바뀌어 그대로 둠' : '';
      if (kind === 'exclude' && n) undoToast(n + '건을 제외했습니다' + skip, function () { bulkStatus('back', items.filter(function (it) { return r.skipped.indexOf(it.id) < 0; }), true); });
      else if (!quiet) toast(n + '건을 ' + (kind === 'exclude' ? '제외' : '복원') + '했습니다' + skip);
      else toast('되돌렸습니다');
      return refresh();
    }).catch(function (e) { toast(e.message || '바꾸지 못했습니다'); });
  }

  var undoTimer;
  function undoToast(msg, fn) {
    var t = document.getElementById('utoast');
    if (!t) { t = document.createElement('div'); t.id = 'utoast'; t.setAttribute('role', 'status'); document.getElementById('app').appendChild(t); }
    t.innerHTML = '<span></span><button type="button">되돌리기</button>';
    t.firstChild.textContent = msg;
    t.hidden = false;
    clearTimeout(undoTimer);
    undoTimer = setTimeout(function () { t.hidden = true; }, 5000);
    t.lastChild.onclick = function () { clearTimeout(undoTimer); t.hidden = true; fn(); };
  }

  // ── 화면: A4 미리보기 ──
  function renderPreview(root) {
    if (!state.user || state.pending) return renderHome(root);
    var sel = state.selection;
    var items = sel ? sel.ids.map(findItem).filter(function (it) {
      return it && (it.st === '보관중' || (sel.remake && it.st === '청구완료' && it.pdfId === sel.remake.pdfId));
    }) : [];
    RSPreview.render(root, {
      selection: sel ? { ids: items.map(function (it) { return it.id; }), items: items, category: sel.category, leftOut: sel.leftOut, remake: sel.remake || null } : null,
      userName: (state.settings || {})['사원명'] || state.user.name || (state.user.email || '').split('@')[0],
      toast: toast,
      back: function () { location.hash = '#/box'; },
      isActive: function () { return currentTab() === 'preview'; },
      rerender: render,
      imageSize: function (fileId) { return RSStore.imageSize(fileId); },
      claimFolder: function (month) { return RSStore.claimFolder(state.ws, month); },
      freeName: RSStore.freeName,
      uploadPdf: RSStore.uploadPdf,
      replacePdf: RSStore.replacePdf,
      setClaimStatus: function (list) { return RSStore.setClaimStatus(state.ws, list, localIsoNow()); },
      nowIso: localIsoNow,
      claimed: function () { refresh(); },
      info: function () { return state.settings || {}; },
      narrow: function (ids) { state.selection = Object.assign({}, state.selection, { ids: ids }); render(); },
      gotoMe: function () { state.meBack = '#/preview'; location.hash = '#/me'; },
      openDetail: function (id) { state.detailBack = '#/preview'; location.hash = '#/detail?id=' + encodeURIComponent(id); },
      finish: function () { state.selection = null; RSBox.endRemake(); location.hash = '#/box'; },
      photoBlob: async function (r) {
        var b = RSBox.localBlob(r.id);
        if (b) return b;
        if (!r.fileId) throw new Error('원본 파일 없음');
        return RSStore.download(r.fileId);
      }
    });
  }

  // ── 화면: 내 정보(갑지 머리글·차량) ──
  var ME_FIELDS = [['사번', '예: 2-027'], ['팀명', '예: 동부지역'], ['사원명', '예: 홍길동'], ['회사명', '예: 엔케이엠알오'], ['승인자', '경비 갑지에 들어감']];
  function renderMe(root) {
    if (!state.user || state.pending) return renderHome(root);
    var s = state.settings || {};
    if (!state.meDraft) {
      state.meDraft = {};
      RSStore.SETTING_KEYS.forEach(function (k) { state.meDraft[k] = s[k] || ''; });
      if (!state.meDraft['사원명']) state.meDraft['사원명'] = state.user.name || '';
    }
    var d = state.meDraft;
    var inp = function (k, ph) {
      return '<div class="dt-f"><span class="dt-l">' + k + '</span><input type="text" maxlength="40" data-me="' + k + '" placeholder="' + esc(ph) + '" value="' + esc(d[k] || '') + '"></div>';
    };
    root.appendChild(el(
      '<header class="dt-top"><button class="icon-btn" id="meBack" aria-label="뒤로">' + ICON.prev + '</button><h1>내 정보</h1></header>' +
      '<p class="hint" style="margin-top:0">경비·접대비·회의비 갑지 머리글에 그대로 들어갑니다. 구글 시트 "설정" 탭에서 고쳐도 됩니다.</p>' +
      '<section class="dt-sec"><div class="dt-sec-h">갑지 머리글</div><div class="dt-sec-b">' +
        ME_FIELDS.map(function (f) { return inp(f[0], f[1]); }).join('') + '</div></section>' +
      '<section class="dt-sec"><div class="dt-sec-h">업무용 차량</div><div class="dt-sec-b">' +
        inp('차량번호', '예: 183허5450') +
        '<div class="dt-f"><span class="dt-l">회사 차량인가요?</span><div class="dt-seg dt-seg2">' +
          [['예', '회사 차량'], ['아니오', '개인 차량']].map(function (o) {
            return '<button type="button" data-car="' + o[0] + '"' + (d['회사 차량'] === o[0] ? ' class="on"' : '') + '>' + o[1] + '</button>';
          }).join('') + '</div>' +
          '<span class="dt-hint">회사 차량이면 주유비·차량유지관리비·주차/통행료 영수증의 업무용승용차 칸에 "차량번호(사원명)"이 자동으로 들어갑니다.</span></div>' +
      '</div></section>' +
      (RSAuth.isAdmin() ? cardAdmin() : '') +
      '<div class="dt-bar"><button class="cta" id="meSave" type="button"' + (state.meSaving ? ' disabled' : '') + '>' + (state.meSaving ? '저장 중…' : '저장') + '</button></div><div class="bx-space"></div>'
    ));
    root.querySelectorAll('[data-me]').forEach(function (i) { i.oninput = function () { d[i.dataset.me] = i.value.trim(); }; });
    root.querySelectorAll('[data-car]').forEach(function (b) {
      b.onclick = function () { d['회사 차량'] = d['회사 차량'] === b.dataset.car ? '' : b.dataset.car; render(); };
    });
    bindCardAdmin(root);
    var leave = function () { state.meDraft = null; state.cardDraft = null; var b = state.meBack || '#/home'; state.meBack = ''; location.hash = b; };
    root.querySelector('#meBack').onclick = leave;
    root.querySelector('#meSave').onclick = function () {
      if (d['차량번호'] && !d['회사 차량']) { toast('회사 차량인지 개인 차량인지 골라 주세요'); return; }
      state.meSaving = true; render();
      var ch = {}; RSStore.SETTING_KEYS.forEach(function (k) { ch[k] = d[k] || ''; });
      saveSettings(ch).then(function () {
        // 사원명 = 앱 이름(관리자 화면·PDF 파일명). 바뀌었으면 함께 바꿈
        var nm = ch['사원명'];
        if (nm && nm !== state.user.name) return RSAuth.setName(nm).then(function (v) { state.user.name = v || nm; }).catch(function () { toast('관리자 화면 이름은 바꾸지 못했습니다'); });
      }).then(function () { state.meSaving = false; toast('내 정보를 저장했습니다'); leave(); })
        .catch(function (e) { state.meSaving = false; toast(e.message || '저장하지 못했습니다'); render(); });
    };
  }

  // ── 관리자: 회사 법인카드 목록(모든 직원의 접대비·회의비 "법인카드" 선택지) ──
  function cardAdmin() {
    if (!state.cardDraft) state.cardDraft = RSAuth.corpCards().slice();
    var list = state.cardDraft;
    return '<section class="dt-sec"><div class="dt-sec-h">법인카드 목록 (관리자)</div><div class="dt-sec-b">' +
      '<p class="hint" style="margin:6px 0 4px;padding:0">여기서 고친 목록이 모든 직원 앱의 접대비·회의비 "법인카드" 선택지로 나옵니다. 직원 앱에는 다음에 앱을 열 때 반영됩니다.</p>' +
      list.map(function (c, i) {
        return '<div class="cd-row"><input type="text" maxlength="30" data-card="' + i + '" value="' + esc(c) + '" placeholder="예: NK하나9798">' +
          '<button type="button" class="mini" data-cdel="' + i + '" aria-label="삭제">삭제</button></div>';
      }).join('') +
      '<div class="cd-btns"><button type="button" class="mini" id="cdAdd">+ 카드 추가</button>' +
      '<button type="button" class="mini ok" id="cdSave"' + (state.cardSaving ? ' disabled' : '') + '>' + (state.cardSaving ? '저장 중…' : '법인카드 목록 저장') + '</button></div>' +
    '</div></section>';
  }
  function bindCardAdmin(root) {
    if (!state.cardDraft) return;
    var list = state.cardDraft;
    root.querySelectorAll('[data-card]').forEach(function (i) { i.oninput = function () { list[+i.dataset.card] = i.value; }; });
    root.querySelectorAll('[data-cdel]').forEach(function (b) { b.onclick = function () { list.splice(+b.dataset.cdel, 1); render(); }; });
    var add = root.querySelector('#cdAdd');
    if (add) add.onclick = function () { list.push(''); render(); var ins = document.querySelectorAll('[data-card]'); if (ins.length) ins[ins.length - 1].focus(); };
    var sv = root.querySelector('#cdSave');
    if (sv) sv.onclick = function () {
      var clean = list.map(function (c) { return String(c || '').trim(); }).filter(Boolean);
      if (!confirm('법인카드 목록을 저장할까요?\n\n' + (clean.join('\n') || '(없음)'))) return;
      state.cardSaving = true; render();
      RSAuth.saveCards(clean).then(function (cards) { state.cardDraft = cards.slice(); toast('법인카드 목록을 저장했습니다 (' + cards.length + '장)'); })
        .catch(function (e) { toast(e.message || '저장하지 못했습니다'); })
        .then(function () { state.cardSaving = false; render(); });
    };
  }

  // ── 화면: 파일 첨부 ──
  function renderAttach(root) {
    if (!state.user || state.pending) return renderHome(root);
    RSAttach.render(root, {
      category: query().cat || '',
      toast: toast,
      rerender: render,
      back: function () { location.hash = '#/box'; },
      saveAttachment: async function (a, step) {
        if (!navigator.onLine) throw new Error('오프라인입니다');
        if (!state.ws) throw new Error('아직 시트를 불러오지 못했습니다');
        var id = (crypto.randomUUID ? crypto.randomUUID() : 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2));
        var folder = await RSStore.monthFolder(state.ws, a.txDate.slice(0, 7), state.user.email);
        var fileId = await RSStore.uploadPdfFile(folder, id, a.file, id + '.pdf');
        step('시트에 기록하는 중…');
        var now = localIsoNow();
        await RSStore.appendAttachment(state.ws, Object.assign({ id: id, fileId: fileId, capturedAt: now, updatedAt: now }, a));
        step('불러오는 중…');
        await refresh();
        return id;
      },
      done: function (id) { toast('첨부했습니다 · 인트라넷 칸을 채워 주세요'); location.hash = '#/detail?id=' + encodeURIComponent(id); }
    });
  }

  var ROUTES = {
    attach: renderAttach,
    me: renderMe,
    preview: renderPreview,
    detail: renderDetail,
    capture: renderCapture,
    admin: renderAdmin,
    home: renderHome,
    box: renderBox,
    budget: renderBudget
  };

  function currentTab() {
    var t = (location.hash.replace(/^#\/?/, '') || 'home').split('?')[0];
    return ROUTES[t] ? t : 'home';
  }

  function render() {
    var tab = state.user && !state.pending ? currentTab() : 'home';
    var root = document.getElementById('view');
    root.innerHTML = '';
    ROUTES[tab](root);
    var nav = document.querySelector('.tabbar');
    nav.hidden = !state.user || !!state.pending || tab === 'admin' || tab === 'capture' || tab === 'detail' || tab === 'preview' || tab === 'me' || tab === 'attach';
    document.querySelectorAll('.tabbar a').forEach(function (a) {
      if (a.dataset.tab === tab) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
  }

  var toastTimer;
  function toast(msg) {
    var t = document.getElementById('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 2200);
  }

  window.addEventListener('hashchange', render);
  // 앱으로 돌아올 때 시트를 다시 읽음(설계서 동기화 규칙: 앱을 열 때, 돌아올 때)
  var lastRefresh = 0;
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && Date.now() - lastRefresh > 30000) { lastRefresh = Date.now(); refresh(); }
  });
  window.addEventListener('online', function () { refresh(); });

  if (state.user && state.user.approved === false) state.pending = { status: 'pending' };
  if (state.user) updateWaiting();
  render();
  if (state.user) { lastRefresh = Date.now(); if (!state.pending) refresh(); }

  // ── 오프라인 캐시(서비스 워커) ──
  if ('serviceWorker' in navigator) {
    // 새 버전이 설치되면 한 번만 자동 새로고침(처음 설치 때는 하지 않음)
    var hadController = !!navigator.serviceWorker.controller, reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (hadController && !reloaded) { reloaded = true; location.reload(); }
    });
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function (e) {
        console.warn('서비스 워커 등록 실패', e);
      });
    });
  }
})();
