/* 보관함(4단계 1번)
   - 구분 하나를 골라 그 구분의 영수증을 봄(PDF를 구분별로 만들기 때문)
   - 탭 3개: 보관중(업로드 대기·판독 대기·확인 필요 포함) / 청구완료 / 제외
   - 선택 월(홈에서 고른 달, 귀속 월 기준)을 먼저 보여 주고 [전체]로 다른 달도 봄
   - 체크는 "보관중" 상태만 가능. 체크한 건수·합계를 아래 고정 바에 표시
   - 목록은 시트 + 폰에만 있는(아직 못 올린) 영수증을 합쳐서 보여 줌
   - 썸네일: 이 폰에서 찍은 것은 폰에 남은 썸네일, 다른 폰에서 찍은 것은 Drive 원본을 받아 작게 만들어 폰에 보관 */
(function () {
  'use strict';

  var CATEGORIES = ['경비', '접대비', '회의비', '출장비'];
  var CAT_KEY = 'rs.box.cat';
  var THUMB_CACHE = 'rs-thumbs-v1';
  var KEEP = { upload: 1, '판독대기': 1, '확인필요': 1, '보관중': 1 };

  var B = { cat: null, tab: 'keep', all: false, sel: {}, open: {} };
  var local = [];          // 폰 대기열의 항목(썸네일·아직 못 올린 것)
  var localEmail = '';
  var thumbs = {};         // id → objectURL | 'fail'
  var thumbWait = [], thumbBusy = 0, thumbQueued = {};
  var ctx = null;

  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function won(n) { return Number(n || 0).toLocaleString('ko-KR'); }
  function el(html) { var t = document.createElement('template'); t.innerHTML = html.trim(); return t.content; }

  var ICON = {
    camera: '<svg viewBox="0 0 24 24"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>',
    clip: '<svg viewBox="0 0 24 24"><path d="M20 11l-8.5 8.5a5 5 0 01-7-7L13 4a3.5 3.5 0 015 5l-8.5 8.5a2 2 0 01-3-3L14 7"/></svg>',
    sheet: '<svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 10h16M4 15h16M10 4v16"/></svg>',
    reload: '<svg viewBox="0 0 24 24"><path d="M20 12a8 8 0 11-2.3-5.6"/><path d="M20 4v5h-5"/></svg>',
    check: '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
    doc: '<svg viewBox="0 0 24 24"><path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5"/></svg>'
  };

  function lastCat() {
    var c = '';
    try { c = localStorage.getItem(CAT_KEY) || ''; } catch (e) { /* 무시 */ }
    return CATEGORIES.indexOf(c) >= 0 ? c : CATEGORIES[0];
  }
  function setCat(c) {
    if (B.cat !== c) { B.sel = {}; B.remake = null; }
    B.cat = c;
    try { localStorage.setItem(CAT_KEY, c); } catch (e) { /* 무시 */ }
  }

  // ── 폰 대기열 읽기 ──
  function loadLocal() {
    if (!ctx) return;
    var email = ctx.email;
    RSQueue.all(email).then(function (list) {
      local = list; localEmail = email;
      if (ctx && ctx.isActive()) ctx.rerender();
    }).catch(function () {});
  }
  RSQueue.onChange(function () { loadLocal(); }); // 촬영 화면에서 저장한 것도 돌아왔을 때 바로 보이게

  // ── 날짜 ──
  function parts(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(iso || '');
    if (!m) return null;
    return { y: +m[1], mo: +m[2], d: +m[3], hh: m[4] || '00', mm: m[5] || '00' };
  }
  function shortDate(iso, withTime) {
    var p = parts(iso);
    if (!p) return '';
    var t = p.mo + '/' + p.d;
    if (withTime && !(p.hh === '00' && p.mm === '00')) t += ' ' + p.hh + ':' + p.mm;
    return t;
  }
  function sortKey(it) { return (it.txAt || it.capturedAt || '') + '|' + it.id; }

  // ── 목록 만들기: 시트 + 폰에만 있는 것 ──
  function normSt(st) { return ({ '판독대기': 1, '확인필요': 1, '보관중': 1, '청구완료': 1, '제외': 1 })[st] ? st : '판독대기'; }
  function items(receipts, email) {
    receipts = receipts || ctx.receipts; email = email || ctx.email;
    var seen = {}, out = [];
    (receipts || []).forEach(function (r) {
      seen[r.id] = 1;
      out.push(Object.assign({}, r, { st: normSt(r.status) }));
    });
    if (localEmail === email) {
      local.forEach(function (q) {
        if (seen[q.id] || q.stage === 'done') return;
        var m = q.meta || {};
        out.push({
          id: q.id, st: 'upload', kind: '영수증', category: m.category || '', capturedAt: m.capturedAt || '',
          txAt: '', month: m.month || '', amount: 0, hasAmount: false, merchant: '', desc: '', memo: m.memo || '',
          widthMm: m.widthMm || 80, fileId: q.fileId || '', pdfId: '', claimedAt: '', upError: q.error || ''
        });
      });
    }
    return out;
  }

  function inRemake(it) { return !!(B.remake && it.st === '청구완료' && it.pdfId === B.remake.pdfId); }
  function inTab(it) {
    if (B.tab === 'keep') return !!KEEP[it.st] || inRemake(it);
    if (B.tab === 'done') return it.st === '청구완료';
    return it.st === '제외';
  }

  // ── 그리기 ──
  function render(root, c) {
    ctx = c;
    if (localEmail !== ctx.email) { local = []; loadLocal(); }
    if (c.category && CATEGORIES.indexOf(c.category) >= 0) setCat(c.category);
    if (!B.cat) B.cat = lastCat();

    var month = ctx.month, mNum = Number(month.slice(5, 7));
    var all = items();
    var ofCat = all.filter(function (it) { return it.category === B.cat; });
    var inMonth = function (it) { return B.all || it.month === month || inRemake(it); };
    var list = ofCat.filter(function (it) { return inTab(it) && inMonth(it); })
      .sort(function (a, b) { return sortKey(a) < sortKey(b) ? -1 : 1; });
    var keepCount = ofCat.filter(function (it) { return KEEP[it.st] && inMonth(it); }).length;
    var otherMonth = B.all ? 0 : ofCat.filter(function (it) { return KEEP[it.st] && it.month !== month; }).length;

    // 보이지 않거나 체크할 수 없게 된 항목은 선택에서 뺌
    var checkable = {};
    if (B.tab === 'keep') list.forEach(function (it) { if (it.st === '보관중' || inRemake(it)) checkable[it.id] = it; });
    if (B.tab === 'excl') list.forEach(function (it) { checkable[it.id] = it; });
    Object.keys(B.sel).forEach(function (id) { if (!checkable[id]) delete B.sel[id]; });
    var selIds = Object.keys(B.sel), selSum = 0;
    selIds.forEach(function (id) { selSum += checkable[id].amount || 0; });
    var nCheckable = Object.keys(checkable).length;

    var catChips = CATEGORIES.map(function (cn) {
      return '<button type="button" class="bx-cat' + (cn === B.cat ? ' on' : '') + '" data-cat="' + cn + '">' + cn + '</button>';
    }).join('');

    var body;
    if (ctx.loading && !all.length) {
      body = '<div class="bx-list">' + new Array(5).join('<div class="bx-row sk"><i></i><div><b></b><b></b></div></div>') + '<div class="bx-row sk"><i></i><div><b></b><b></b></div></div></div>';
    } else if (!list.length) {
      body = emptyState();
    } else if (B.tab === 'done') {
      body = doneGroups(list);
    } else if (B.cat === '출장비') {
      body = tripGroups(list, checkable);
    } else {
      body = '<div class="bx-list">' + list.map(row).join('') + '</div>';
    }

    var bar = '';
    if (B.tab === 'keep') {
      var allOn = nCheckable > 0 && selIds.length === nCheckable;
      var canPdf = selIds.length > 0 && navigator.onLine;
      bar = '<div class="bx-bar">' +
        '<button type="button" class="bx-all' + (allOn ? ' on' : '') + '" id="bxAll"' + (nCheckable ? '' : ' disabled') + '><span class="bx-ck">' + ICON.check + '</span>전체</button>' +
        '<div class="bx-selsum"><b>' + selIds.length + '건</b> · ' + won(selSum) + '원</div>' +
        (B.remake ? '' : '<button type="button" class="bx-excl" id="bxExcl"' + (selIds.length && navigator.onLine ? '' : ' disabled') + '>제외</button>') +
        '<button type="button" class="bx-pdf" id="bxPdf"' + (canPdf ? '' : ' disabled') + '>A4 미리보기·PDF</button>' +
      '</div>' +
      (selIds.length && !navigator.onLine ? '<p class="hint">온라인에서만 PDF를 만들 수 있습니다.</p>' : '');
    }

    if (B.tab === 'excl' && list.length) {
      var allOn2 = nCheckable > 0 && selIds.length === nCheckable, can = selIds.length > 0 && navigator.onLine;
      bar = '<div class="bx-bar">' +
        '<button type="button" class="bx-all' + (allOn2 ? ' on' : '') + '" id="bxAll"><span class="bx-ck">' + ICON.check + '</span>전체</button>' +
        '<div class="bx-selsum"><b>' + selIds.length + '건</b> · ' + won(selSum) + '원</div>' +
        '<button type="button" class="bx-excl" id="bxRestore"' + (can ? '' : ' disabled') + '>복원</button>' +
        '<button type="button" class="bx-pdf bx-del" id="bxDel"' + (can ? '' : ' disabled') + '>영구 삭제</button>' +
      '</div>';
    }

    root.appendChild(el(
      '<header class="bx-top"><h1>보관함</h1>' +
        '<div class="bx-icons">' +
          (ctx.ws ? '<a class="icon-btn" href="' + RSStore.sheetUrl(ctx.ws) + '" target="_blank" rel="noopener" aria-label="시트 열기">' + ICON.sheet + '</a>' : '') +
          '<button class="icon-btn' + (ctx.loading ? ' spin' : '') + '" id="bxReload" type="button" aria-label="새로고침">' + ICON.reload + '</button>' +
        '</div></header>' +
      '<div class="bx-actions">' +
        '<button type="button" class="bx-act" id="bxCap">' + ICON.camera + '영수증 촬영</button>' +
        '<button type="button" class="bx-act" id="bxAttach">' + ICON.clip + '파일 첨부</button>' +
      '</div>' +
      '<div class="bx-cats" role="tablist" aria-label="구분">' + catChips + '</div>' +
      '<div class="bx-month">' +
        '<div class="seg2"><button type="button" data-m="month"' + (B.all ? '' : ' class="on"') + '>' + (Number(month.slice(0, 4)) !== new Date().getFullYear() ? month.slice(2, 4) + '년 ' : '') + mNum + '월 ▾</button>' +
        '<button type="button" data-m="all"' + (B.all ? ' class="on"' : '') + '>전체</button></div>' +
        (otherMonth ? '<button type="button" class="bx-other" id="bxOther">다른 달 ' + otherMonth + '건 ›</button>' : '') +
      '</div>' +
      '<div class="bx-tabs" role="tablist">' +
        tabBtn('keep', '보관중 ' + keepCount) + tabBtn('done', '청구완료') + tabBtn('excl', '제외') +
      '</div>' +
      (B.remake && B.tab === 'keep' ? '<div class="banner bx-remake"><b>다시 만들기</b> · ' + esc(B.remake.name || 'PDF') +
        '<br>넣을 영수증은 체크하고 뺄 영수증은 체크를 푼 뒤 [A4 미리보기·PDF]를 눌러 주세요. <button class="mini" id="bxRemakeCancel" type="button">취소</button></div>' : '') +
      (ctx.error ? '<div class="banner warn" role="alert">' + esc(ctx.error) + '</div>' : '') +
      (ctx.offline ? '<div class="banner">오프라인입니다. 마지막으로 불러온 목록을 보여 줍니다.</div>' : '') +
      body + bar + (bar ? '<div class="bx-space"></div>' : '')
    ));

    bind(root, checkable, list);
    requestThumbs(list);
  }

  function tabBtn(k, label) {
    return '<button type="button" role="tab" data-tab="' + k + '" aria-selected="' + (B.tab === k) + '"' + (B.tab === k ? ' class="on"' : '') + '>' + esc(label) + '</button>';
  }

  function emptyState() {
    if (B.tab === 'keep') {
      return '<div class="empty"><b>보관 중인 영수증이 없습니다</b>' + esc(B.cat) + (B.all ? '' : ' · ' + Number(ctx.month.slice(5, 7)) + '월') + ' 기준입니다.' +
        '<div class="bx-empty-btns"><button type="button" class="mini ok" id="bxCap2">영수증 촬영</button><button type="button" class="mini" id="bxAttach2">파일 첨부</button></div></div>';
    }
    if (B.tab === 'done') return '<div class="empty"><b>아직 청구한 영수증이 없습니다</b></div>';
    return '<div class="empty"><b>제외한 영수증이 없습니다</b></div>';
  }

  var BADGE = {
    upload: ['업로드 대기', 'b-up'], '판독대기': ['판독 대기', 'b-wait'], '확인필요': ['확인 필요', 'b-need']
  };

  function row(it) {
    var canCheck = (B.tab === 'keep' && (it.st === '보관중' || inRemake(it))) || B.tab === 'excl';
    var on = !!B.sel[it.id];
    var isFile = it.kind === '첨부';
    var title = isFile ? (it.desc || it.work || it.topic || '파일 첨부') :
      (it.merchant || (it.st === 'upload' || it.st === '판독대기' ? '판독 전 영수증' : '가맹점명 없음'));
    var date = it.txAt ? shortDate(it.txAt, true) : (it.capturedAt ? '촬영 ' + shortDate(it.capturedAt, true) : '');
    var sub = [date, it.card || '', it.memo ? it.memo.slice(0, 24) : ''].filter(Boolean).join(' · ');
    var badges = [];
    if (inRemake(it) && B.tab === 'keep') badges.push('<span class="bdg b-up">이 PDF에 들어 있음</span>');
    if (BADGE[it.st]) badges.push('<span class="bdg ' + BADGE[it.st][1] + '">' + BADGE[it.st][0] + '</span>');
    var tp = parts(it.txAt);
    if (tp && it.month && it.month !== tp.y + '-' + String(tp.mo).padStart(2, '0')) badges.push('<span class="bdg b-month">귀속 ' + Number(it.month.slice(5, 7)) + '월</span>');
    if (B.all && it.month) badges.push('<span class="bdg b-mon">' + Number(it.month.slice(5, 7)) + '월</span>');
    if (isFile) badges.unshift('<span class="bdg b-file">첨부 PDF</span>');
    var th = thumbs[it.id];
    var img = isFile ? '<span class="bx-th file">' + ICON.doc + '</span>' :
      '<span class="bx-th" data-th="' + esc(it.id) + '">' + (th && th !== 'fail' ? '<img src="' + th + '" alt=""' + (it.rot ? ' class="r' + it.rot + '"' : '') + '>' : '') + '</span>';
    return '<div class="bx-row' + (on ? ' sel' : '') + '" data-id="' + esc(it.id) + '">' +
      (B.tab === 'keep' || B.tab === 'excl' ? '<button type="button" class="bx-ck' + (on ? ' on' : '') + (canCheck ? '' : ' off') + '" data-ck="' + esc(it.id) + '"' +
        (canCheck ? ' aria-label="선택"' : ' aria-label="아직 선택할 수 없음" aria-disabled="true"') + '>' + ICON.check + '</button>' : '') +
      img +
      '<div class="bx-main"><div class="bx-t">' + esc(title) + '</div>' +
        '<div class="bx-s">' + esc(sub) + '</div>' +
        (badges.length ? '<div class="bx-b">' + badges.join('') + '</div>' : '') + '</div>' +
      '<div class="bx-amt">' + (it.hasAmount ? won(it.amount) + '<small>원</small>' : '<span class="bx-noamt">' + (it.st === 'upload' || it.st === '판독대기' ? '금액<br>판독 전' : '금액<br>미입력') + '</span>') + '</div>' +
    '</div>';
  }

  // 출장비: 출장일별로 묶음(같은 출장의 영수증을 한 번에 고름)
  function tripGroups(list, checkable) {
    var groups = {}, order = [];
    list.forEach(function (it) {
      var k = it.tripDate || '';
      if (!groups[k]) { groups[k] = []; order.push(k); }
      groups[k].push(it);
    });
    order.sort(function (a, b) { return !a ? 1 : !b ? -1 : a < b ? -1 : 1; });
    return order.map(function (k) {
      var g = groups[k], sum = 0, ids = g.filter(function (it) { return checkable[it.id]; }).map(function (it) { return it.id; });
      g.forEach(function (it) { sum += it.hasAmount ? it.amount : 0; });
      var allOn = ids.length && ids.every(function (id) { return B.sel[id]; });
      var p = /^(\d{4})-(\d{2})-(\d{2})/.exec(k);
      var title = p ? Number(p[2]) + '월 ' + Number(p[3]) + '일 출장' : '출장일 없음';
      return '<div class="bx-group"><div class="bx-gh"><b>' + title + '</b> · ' + g.length + '건 · ' + won(sum) + '원' +
        (ids.length ? '<button type="button" class="bx-gsel' + (allOn ? ' on' : '') + '" data-gsel="' + esc(ids.join(',')) + '">' + (allOn ? '선택 해제' : '이 출장 전체 선택') + '</button>' : '') +
        (p ? '' : '<span class="bx-ghint">상세에서 출장일을 적어 주세요</span>') + '</div>' +
        '<div class="bx-list">' + g.map(row).join('') + '</div></div>';
    }).join('');
  }

  // 청구완료: 청구 PDF별로 묶음
  function doneGroups(list) {
    var groups = {}, order = [];
    list.forEach(function (it) {
      var k = it.pdfId || '(PDF 정보 없음)';
      if (!groups[k]) { groups[k] = []; order.push(k); }
      groups[k].push(it);
    });
    return order.map(function (k) {
      var g = groups[k], sum = 0, when = '';
      g.forEach(function (it) { sum += it.amount; if (it.claimedAt > when) when = it.claimedAt; });
      var has = k !== '(PDF 정보 없음)', nm = has ? pdfName(k) : '', open = !!B.open[k];
      // PDF 한 묶음 = 카드 한 장(파일 아이콘·파일명·합계·사진 띠). 영수증 목록은 접어 두고 눌러서 펼침
      var strip = g.slice(0, 5).map(function (it) {
        var th = thumbs[it.id];
        return '<span class="bx-th sm" data-th="' + esc(it.id) + '">' + (th && th !== 'fail' ? '<img src="' + th + '" alt=""' + (it.rot ? ' class="r' + it.rot + '"' : '') + '>' : '') + '</span>';
      }).join('') + (g.length > 5 ? '<span class="pc-more">+' + (g.length - 5) + '</span>' : '');
      return '<div class="pc-card">' +
        '<div class="pc-head"><span class="pc-icon">PDF</span><div class="pc-main">' +
          '<div class="pc-name"' + (has ? ' data-pdfname="' + esc(k) + '"' : '') + '>' + esc(has ? (nm || 'PDF 이름 불러오는 중…') : '청구 PDF 정보 없음') + '</div>' +
          '<div class="pc-meta">' + (when ? shortDate(when) + ' 청구' : '청구') + ' · 영수증 ' + g.length + '건</div></div>' +
          '<div class="pc-amt">' + won(sum) + '<small>원</small></div></div>' +
        '<div class="pc-strip">' + strip + '</div>' +
        (has ? '<div class="pc-btns"><a class="mini" href="https://drive.google.com/file/d/' + encodeURIComponent(k) + '/view" target="_blank" rel="noopener">PDF 열기</a>' +
          '<button class="mini ok" type="button" data-remake="' + esc(k) + '">다시 만들기</button>' +
          '<button class="mini" type="button" data-unclaim="' + esc(k) + '">전체 되돌리기</button></div>' : '') +
        (has && B.cat === '출장비' ? gapjiRow(k) : '') +
        '<button class="pc-toggle" type="button" data-open="' + esc(k) + '">' + (open ? '영수증 접기 ▴' : '영수증 ' + g.length + '건 보기 ▾') + '</button>' +
        (open ? '<div class="pc-list">' + g.map(row).join('') + '</div>' : '') +
      '</div>';
    }).join('');
  }

  // 출장비: 결재 끝난 지출결의서(갑지)를 청구 PDF 앞에 붙인 합본(새 파일)
  var merged = {};
  function mergedOf(id) {
    if (merged[id] !== undefined) return merged[id];
    try { var c = JSON.parse(localStorage.getItem('rs.merged.' + id) || 'null'); if (c) { merged[id] = c; return c; } } catch (e) { /* 무시 */ }
    merged[id] = null;
    ctx.findMerged(id).then(function (f) {
      if (!f) return;
      merged[id] = f; try { localStorage.setItem('rs.merged.' + id, JSON.stringify(f)); } catch (e) { /* 무시 */ }
      if (ctx.isActive()) ctx.rerender();
    }).catch(function () { delete merged[id]; });
    return null;
  }
  function gapjiRow(k) {
    var m = mergedOf(k), busy = B.gapjiBusy === k;
    return '<div class="pc-gapji">' + (m ? '<div class="pc-gname">' + esc(m.name) + '</div>' : '<div class="pc-ghint">결재가 끝난 출장비 지출결의서를 출력(PDF)해 붙이면 "갑지+영수증" PDF를 따로 만듭니다.</div>') +
      '<div class="pc-btns">' + (m ? '<a class="mini ok" href="https://drive.google.com/file/d/' + encodeURIComponent(m.id) + '/view" target="_blank" rel="noopener">갑지+영수증 열기</a>' : '') +
      '<label class="mini' + (m ? '' : ' ok') + (busy ? ' dis' : '') + '"><input type="file" accept="application/pdf,.pdf" data-gapji="' + esc(k) + '" hidden' + (busy ? ' disabled' : '') + '>' +
        (busy ? '만드는 중…' : m ? '갑지 다시 붙이기' : '결재 갑지 붙이기') + '</label></div></div>';
  }

  // 청구 PDF 파일명(Drive에서 한 번 읽어 폰에 기억)
  var names = {};
  function pdfName(id) {
    if (names[id] !== undefined) return names[id];
    try { var c = localStorage.getItem('rs.pdfname.' + id); if (c) { names[id] = c; return c; } } catch (e) { /* 무시 */ }
    names[id] = '';
    ctx.fileInfo(id).then(function (f) {
      names[id] = f && f.name ? f.name : '';
      try { if (names[id]) localStorage.setItem('rs.pdfname.' + id, names[id]); } catch (e) { /* 무시 */ }
      var el2 = document.querySelector('[data-pdfname="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"]');
      if (el2) el2.textContent = names[id] || '(PDF 이름을 읽지 못했습니다)';
    }).catch(function () { delete names[id]; });
    return '';
  }

  function bind(root, checkable, list) {
    root.querySelectorAll('[data-open]').forEach(function (b) {
      b.onclick = function () { var k = b.dataset.open; B.open[k] = !B.open[k]; ctx.rerender(); };
    });
    root.querySelectorAll('[data-gapji]').forEach(function (inp) {
      inp.onchange = function () {
        var f = inp.files && inp.files[0], id = inp.dataset.gapji; if (!f) return;
        B.gapjiBusy = id; ctx.rerender();
        ctx.mergeGapji(id, f, merged[id] || null).then(function (r) {
          if (r) { merged[id] = r; try { localStorage.setItem('rs.merged.' + id, JSON.stringify(r)); } catch (e) { /* 무시 */ } }
        }).catch(function () {}).then(function () { B.gapjiBusy = null; ctx.rerender(); });
      };
    });
    root.querySelectorAll('[data-remake]').forEach(function (b) {
      b.onclick = function () {
        var id = b.dataset.remake, ids = list.filter(function (it) { return it.pdfId === id; }).map(function (it) { return it.id; });
        B.remake = { pdfId: id, name: names[id] || '', ids: ids };
        B.tab = 'keep'; B.sel = {}; ids.forEach(function (x) { B.sel[x] = 1; });
        ctx.rerender(); window.scrollTo(0, 0);
      };
    });
    root.querySelectorAll('[data-unclaim]').forEach(function (b) {
      b.onclick = function () {
        var id = b.dataset.unclaim, ids = list.filter(function (it) { return it.pdfId === id; }).map(function (it) { return it.id; });
        if (!confirm(ids.length + '건을 모두 보관중으로 되돌릴까요?\n이미 만든 PDF 파일은 지우지 않습니다.')) return;
        ctx.unclaimAll(ids);
      };
    });
    var rc = root.querySelector('#bxRemakeCancel');
    if (rc) rc.onclick = function () { B.remake = null; B.sel = {}; B.tab = 'done'; ctx.rerender(); };
    root.querySelectorAll('.bx-cat').forEach(function (b) {
      b.onclick = function () { setCat(b.dataset.cat); ctx.rerender(); };
    });
    root.querySelectorAll('.seg2 button').forEach(function (b) {
      b.onclick = function () {
        // 이미 월 보기일 때 한 번 더 누르면 달 고르기 창(과거 내역 보기)
        if (b.dataset.m === 'month' && !B.all) { monthPicker(); return; }
        B.all = b.dataset.m === 'all'; ctx.rerender();
      };
    });
    var ob = root.querySelector('#bxOther');
    if (ob) ob.onclick = function () { B.all = true; ctx.rerender(); };
    root.querySelectorAll('.bx-tabs button').forEach(function (b) {
      b.onclick = function () { B.tab = b.dataset.tab; B.sel = {}; B.remake = null; ctx.rerender(); window.scrollTo(0, 0); };
    });
    root.querySelector('#bxReload').onclick = function () { ctx.refresh(); };
    var cap = function () { ctx.go('#/capture?cat=' + encodeURIComponent(B.cat) + '&from=box'); };
    var att = function () { ctx.go('#/attach?cat=' + encodeURIComponent(B.cat)); };
    root.querySelector('#bxCap').onclick = cap;
    root.querySelector('#bxAttach').onclick = att;
    var c2 = root.querySelector('#bxCap2'); if (c2) c2.onclick = cap;
    var a2 = root.querySelector('#bxAttach2'); if (a2) a2.onclick = att;

    root.querySelectorAll('[data-ck]').forEach(function (b) {
      b.onclick = function (e) {
        e.stopPropagation();
        var id = b.dataset.ck;
        if (!checkable[id]) { explain(list.find(function (x) { return x.id === id; })); return; }
        if (B.sel[id]) delete B.sel[id]; else B.sel[id] = 1;
        ctx.rerender();
      };
    });
    root.querySelectorAll('[data-gsel]').forEach(function (b) {
      b.onclick = function () {
        var ids = b.dataset.gsel.split(','), on = ids.every(function (id) { return B.sel[id]; });
        ids.forEach(function (id) { if (on) delete B.sel[id]; else B.sel[id] = 1; });
        ctx.rerender();
      };
    });
    root.querySelectorAll('.bx-row[data-id]').forEach(function (r) {
      var it = list.find(function (x) { return x.id === r.dataset.id; });
      r.onclick = function () {
        if (r.dataset.swiped) { delete r.dataset.swiped; return; }
        if (it) ctx.go('#/detail?id=' + encodeURIComponent(it.id));
      };
      if (it) gestures(r, it);
    });
    var ab = root.querySelector('#bxAll');
    if (ab) ab.onclick = function () {
      var ids = Object.keys(checkable);
      if (ids.length && Object.keys(B.sel).length === ids.length) B.sel = {};
      else { B.sel = {}; ids.forEach(function (id) { B.sel[id] = 1; }); }
      ctx.rerender();
    };
    var selected = function () { return list.filter(function (it) { return B.sel[it.id]; }); };
    var xb = root.querySelector('#bxExcl');
    if (xb) xb.onclick = function () {
      var s = selected(); if (!s.length) return;
      B.sel = {}; ctx.bulkStatus('exclude', s);
    };
    var rb = root.querySelector('#bxRestore');
    if (rb) rb.onclick = function () {
      var s = selected(); if (!s.length) return;
      B.sel = {}; ctx.bulkStatus('restore', s);
    };
    var db = root.querySelector('#bxDel');
    if (db) db.onclick = function () {
      var s = selected(); if (!s.length) return;
      if (!confirm(s.length + '건을 영구 삭제합니다.\n\n· 구글 시트에서 줄이 지워집니다(되돌릴 수 없음)\n· 원본 사진은 Drive 휴지통으로 갑니다(30일 안에 Drive에서 되살릴 수 있음)\n\n계속할까요?')) return;
      B.sel = {}; ctx.deleteForever(s.map(function (it) { return it.id; }));
    };
    var pb = root.querySelector('#bxPdf');
    if (pb) pb.onclick = function () {
      var ids = list.filter(function (it) { return B.sel[it.id]; }).map(function (it) { return it.id; }); // 목록 순서대로
      var leftOut = list.filter(function (it) { return it.st === '판독대기' || it.st === '확인필요' || it.st === 'upload'; }).length;
      ctx.startPreview({ ids: ids, category: B.cat, leftOut: leftOut, remake: B.remake || null });
    };
  }

  // ── 왼쪽으로 밀어 제외 · 길게 눌러 빠른 메뉴 ──
  function gestures(r, it) {
    var sx = 0, sy = 0, dx = 0, timer = null, moved = false, swiping = false, bg = null;
    var canSwipe = KEEP[it.st] && it.st !== 'upload' && B.tab === 'keep';
    r.addEventListener('touchstart', function (e) {
      var t = e.touches[0]; sx = t.clientX; sy = t.clientY; dx = 0; moved = false; swiping = false;
      timer = setTimeout(function () { timer = null; if (!moved) { r.dataset.swiped = '1'; quickMenu(it); } }, 550);
    }, { passive: true });
    r.addEventListener('touchmove', function (e) {
      var t = e.touches[0], mx = t.clientX - sx, my = t.clientY - sy;
      if (Math.abs(mx) > 8 || Math.abs(my) > 8) { moved = true; if (timer) { clearTimeout(timer); timer = null; } }
      if (!canSwipe) return;
      if (!swiping && Math.abs(mx) > 14 && Math.abs(mx) > Math.abs(my) * 1.5 && mx < 0) swiping = true;
      if (swiping) {
        if (!bg) {
          bg = document.createElement('div'); bg.className = 'bx-swbg';
          bg.innerHTML = '<span>' + TRASH + '제외</span>';
          bg.style.top = r.offsetTop + 'px'; bg.style.height = r.offsetHeight + 'px';
          r.parentNode.insertBefore(bg, r);
        }
        dx = Math.min(0, mx); r.style.transform = 'translateX(' + dx + 'px)';
        bg.classList.toggle('go', dx < -90);
      }
    }, { passive: true });
    r.addEventListener('touchend', function () {
      if (timer) { clearTimeout(timer); timer = null; }
      if (swiping) {
        r.dataset.swiped = '1';
        if (dx < -90) { r.style.transform = 'translateX(-100%)'; ctx.statusAction('exclude', it); }
        else { r.style.transform = ''; if (bg) { bg.remove(); bg = null; } }
      }
    });
    r.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  }

  // 달 고르기(1~12월, 연도 ‹ ›). 이번 달보다 뒤는 고를 수 없음
  function monthPicker() {
    var cur = ctx.month, y = Number(cur.slice(0, 4)), now = new Date(), ny = now.getFullYear(), nm = now.getMonth() + 1;
    var wrap = document.createElement('div');
    wrap.className = 'sheet-backdrop';
    var draw = function () {
      var btns = '';
      for (var m = 1; m <= 12; m++) {
        var key = y + '-' + String(m).padStart(2, '0'), future = y > ny || (y === ny && m > nm);
        btns += '<button type="button" class="mp-m' + (key === cur ? ' on' : '') + '" data-mm="' + m + '"' + (future ? ' disabled' : '') + '>' + m + '월</button>';
      }
      wrap.innerHTML = '<div class="sheet" role="dialog" aria-label="달 고르기"><div class="grab"></div>' +
        '<div class="mp-y"><button class="icon-btn" id="mpPrev" type="button" aria-label="이전 해">‹</button><b>' + y + '년</b>' +
        '<button class="icon-btn" id="mpNext" type="button" aria-label="다음 해"' + (y >= ny ? ' disabled' : '') + '>›</button></div>' +
        '<div class="mp-grid">' + btns + '</div>' +
        '<button class="sheet-item sub" id="mpClose" type="button">닫기</button></div>';
      wrap.querySelector('#mpPrev').onclick = function () { y--; draw(); };
      wrap.querySelector('#mpNext').onclick = function () { if (y < ny) { y++; draw(); } };
      wrap.querySelector('#mpClose').onclick = function () { wrap.remove(); };
      wrap.querySelectorAll('[data-mm]').forEach(function (b) {
        b.onclick = function () { wrap.remove(); B.all = false; B.sel = {}; ctx.setMonth(y, Number(b.dataset.mm)); };
      });
    };
    wrap.onclick = function (e) { if (e.target === wrap) wrap.remove(); };
    draw();
    document.body.appendChild(wrap);
  }

  var TRASH = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6"/></svg>';

  function quickMenu(it) {
    if (it.st === 'upload') { explain(it); return; }
    var ro = it.st === '청구완료';
    var wrap = document.createElement('div');
    wrap.className = 'sheet-backdrop';
    var cats = CATEGORIES.filter(function (c) { return c !== it.category; });
    wrap.innerHTML = '<div class="sheet" role="dialog" aria-label="빠른 메뉴"><div class="grab"></div>' +
      '<div class="sheet-email"><b>' + esc(it.merchant || '영수증') + '</b> · ' + esc(it.category) + '</div>' +
      (ro ? '<div class="sheet-item sub">청구완료된 영수증은 상세에서 [보관중으로 되돌리기] 후 고칠 수 있습니다.</div>' :
        cats.map(function (c) { return '<button class="sheet-item" data-cat="' + c + '" type="button">' + c + '(으)로 구분 바꾸기</button>'; }).join('') +
        '<div class="sheet-row"><span>귀속 월</span><input type="month" id="qmMonth" value="' + esc(it.month) + '"><button class="mini ok" id="qmMonthOk" type="button">바꾸기</button></div>' +
        (it.st === '제외' ? '<button class="sheet-item" id="qmRestore" type="button">복원</button>' : '<button class="sheet-item danger" id="qmExclude" type="button">제외</button>')) +
      '<button class="sheet-item sub" id="qmClose" type="button">닫기</button></div>';
    document.body.appendChild(wrap);
    var close = function () { wrap.remove(); };
    wrap.onclick = function (e) { if (e.target === wrap) close(); };
    wrap.querySelector('#qmClose').onclick = close;
    wrap.querySelectorAll('[data-cat]').forEach(function (b) {
      b.onclick = function () { close(); ctx.quickEdit(it, { category: b.dataset.cat }, b.dataset.cat + '(으)로 바꿨습니다'); };
    });
    var mo = wrap.querySelector('#qmMonthOk');
    if (mo) mo.onclick = function () {
      var v = wrap.querySelector('#qmMonth').value;
      if (!/^\d{4}-\d{2}$/.test(v)) { ctx.toast('귀속 월을 골라 주세요'); return; }
      close(); if (v !== it.month) ctx.quickEdit(it, { month: v }, '귀속 월을 ' + Number(v.slice(5)) + '월로 바꿨습니다');
    };
    var ex = wrap.querySelector('#qmExclude');
    if (ex) ex.onclick = function () { close(); ctx.statusAction('exclude', it); };
    var rs = wrap.querySelector('#qmRestore');
    if (rs) rs.onclick = function () { close(); ctx.statusAction('restore', it); };
  }

  // 체크할 수 없는 항목을 눌렀을 때 이유
  function explain(it) {
    if (!it) return;
    if (it.st === 'upload') ctx.toast(it.upError ? '아직 Drive에 못 올렸습니다. 인터넷이 연결되면 다시 올립니다' : 'Drive에 올리는 중입니다');
    else if (it.st === '판독대기' || it.st === '확인필요') {
      // 체크칸을 눌러도 바로 입력 화면으로 보냄(거래일·금액을 넣고 저장하면 고를 수 있음)
      ctx.go('#/detail?id=' + encodeURIComponent(it.id));
      setTimeout(function () { ctx.toast('거래일·금액을 넣고 [저장]을 누르면 고를 수 있습니다'); }, 50);
    }
  }

  // ── 썸네일 ──
  var rotOf = {};
  function setThumb(id, url) {
    thumbs[id] = url;
    if (url === 'fail') return;
    document.querySelectorAll('.bx-th[data-th="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"]').forEach(function (box) {
      box.innerHTML = '<img src="' + url + '" alt=""' + (rotOf[id] ? ' class="r' + rotOf[id] + '"' : '') + '>';
    });
  }

  function requestThumbs(list) {
    var byLocal = {};
    local.forEach(function (q) { if (q.thumb) byLocal[q.id] = q.thumb; });
    list.forEach(function (it) {
      rotOf[it.id] = it.rot || 0;
      if (it.kind === '첨부' || thumbs[it.id] || thumbQueued[it.id]) return;
      if (byLocal[it.id]) { thumbs[it.id] = URL.createObjectURL(byLocal[it.id]); setThumb(it.id, thumbs[it.id]); return; }
      if (!it.fileId) return;
      thumbQueued[it.id] = 1;
      thumbWait.push(it);
    });
    pumpThumbs();
  }

  function pumpThumbs() {
    while (thumbBusy < 2 && thumbWait.length) {
      var it = thumbWait.shift();
      thumbBusy++;
      loadThumb(it).then(function (r) { setThumb(r.id, r.url); }, function (r) { if (navigator.onLine) thumbs[r.id] = 'fail'; })
        .then(function () { thumbBusy--; pumpThumbs(); });
    }
  }

  async function loadThumb(it) {
    var key = location.origin + '/__thumb/' + encodeURIComponent(it.id);
    try {
      var cache = window.caches ? await caches.open(THUMB_CACHE) : null;
      var hit = cache ? await cache.match(key) : null;
      if (hit) return { id: it.id, url: URL.createObjectURL(await hit.blob()) };
      if (!navigator.onLine) throw new Error('offline');
      var blob = await RSStore.download(it.fileId);
      var small = await shrink(blob, 240);
      if (cache) await cache.put(key, new Response(small, { headers: { 'Content-Type': 'image/jpeg' } }));
      return { id: it.id, url: URL.createObjectURL(small) };
    } catch (e) {
      delete thumbQueued[it.id];
      throw { id: it.id, error: e };
    }
  }

  function shrink(blob, max) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(blob), img = new Image();
      img.onload = function () {
        var s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
        var c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(img.naturalWidth * s)); c.height = Math.max(1, Math.round(img.naturalHeight * s));
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        c.toBlob(function (b) { b ? resolve(b) : reject(new Error('toBlob')); }, 'image/jpeg', 0.75);
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('image')); };
      img.src = url;
    });
  }

  window.RSBox = {
    render: render,
    itemById: function (id, receipts, email) {
      return items(receipts || [], email).find(function (x) { return x.id === id; }) || null;
    },
    localBlob: function (id) { var q = local.find(function (x) { return x.id === id; }); return q && q.blob ? q.blob : null; },
    endRemake: function () { B.remake = null; B.sel = {}; },
    reset: function () {
      B = { cat: null, tab: 'keep', all: false, sel: {}, open: {} };
      Object.keys(thumbs).forEach(function (k) { if (thumbs[k] !== 'fail') URL.revokeObjectURL(thumbs[k]); });
      thumbs = {}; thumbQueued = {}; thumbWait = []; local = []; localEmail = '';
      if (window.caches) caches.delete(THUMB_CACHE).catch(function () {});
    }
  };
})();
