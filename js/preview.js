/* A4 미리보기(4단계 3번)
   - 보관함에서 체크한 영수증을 설계서 A4 배치 규칙(RSLayout)대로 놓아 페이지별로 보여 줌
   - 영수증 실제 크기 = 촬영 때 고른 폭(mm) × 사진 비율. 회전 값을 적용함
   - 파일명 규칙: YYMMDD_구분_영수증_이름.pdf (출장비 = 출장일, 그 외 = 청구월 말일)
   - [PDF로 저장하고 청구완료]: PDF 만들기 → Drive 청구본/YYYY-MM/에 저장 → 시트에서 청구완료 처리(설계서 저장 순서)
     PDF 저장 뒤 시트만 실패하면 PDF는 다시 만들지 않고 청구완료 처리만 다시 시도
   - [다시 만들기]로 들어오면 같은 PDF 파일의 내용을 바꾸고, 빠진 영수증은 보관중으로 되돌림 */
(function () {
  'use strict';

  var P = null;     // { key, items, pages, dims, status, error }
  var ctx = null;
  var imgs = {};    // id → objectURL(미리보기용으로 작게 만든 사진)
  var DIM_KEY = 'rs.dim.';
  var MODE_KEY = 'rs.gapji.';   // 구분별로 마지막에 고른 [갑지+영수증 · 갑지만 · 영수증만]
  var MODES = [['both', '갑지+영수증'], ['sheet', '갑지만'], ['receipts', '영수증만']];
  var sheetPrev = { key: '', urls: [] }; // 미리보기용 작은 갑지 그림

  function getMode(cat) {
    if (!window.RSGapji || RSGapji.KINDS.indexOf(cat) < 0) return 'receipts'; // 출장비는 영수증만
    try { var m = localStorage.getItem(MODE_KEY + cat); if (m === 'both' || m === 'sheet' || m === 'receipts') return m; } catch (e) { /* 무시 */ }
    return 'both';
  }
  function setMode(cat, m) { try { localStorage.setItem(MODE_KEY + cat, m); } catch (e) { /* 무시 */ } }
  // PDF 전 필수 값(인트라넷 청구에 꼭 필요한 칸)
  var REQUIRED = {
    '경비': [['account', '계정']],
    '접대비': [['topic', '내용'], ['guest', '접대상대방']],
    '회의비': [['topic', '내용'], ['attendees', '회의참석자']],
    '출장비': []   // 출장비는 아래 missingOf에서 결제 수단·카드사를 봄
  };
  function isAtt(it) { return it.kind === '첨부'; }   // 파일 첨부로 손입력한 건(올린 PDF가 그대로 붙음)
  function missingOf(cat, it) {
    var m = [];
    if (!it.hasAmount || !(Number(it.amount) > 0)) m.push('금액');
    (REQUIRED[cat] || []).forEach(function (f) { if (!String(it[f[0]] || '').trim()) m.push(f[1]); });
    if ((cat === '접대비' || cat === '회의비') && it.cardType === '법인카드' && !it.corpCard) m.push('법인카드');
    if (cat === '출장비') {   // 출장비: 결제 수단을 꼭 고르고, 개인카드면 카드사·법인카드면 어느 카드인지까지
      if (!it.cardType) m.push('결제 수단');
      else if (it.cardType === '개인카드' && !String(it.card || '').trim()) m.push('카드사');
      else if (it.cardType === '법인카드' && !it.corpCard) m.push('법인카드');
    }
    return m;
  }
  function claimMonth(items) { return mostCommon(items.map(function (it) { return it.month; })) || ''; }

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function won(n) { return Number(n || 0).toLocaleString('ko-KR'); }
  function el(html) { var t = document.createElement('template'); t.innerHTML = html.trim(); return t.content; }
  var ICON = { back: '<svg viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6"/></svg>' };

  // ── 파일명 ──
  function lastDay(ym) { var y = +ym.slice(0, 4), m = +ym.slice(5, 7); return new Date(y, m, 0).getDate(); }
  function mostCommon(list) {
    var c = {}, best = '', n = 0;
    list.forEach(function (v) { if (!v) return; c[v] = (c[v] || 0) + 1; });
    Object.keys(c).sort().forEach(function (v) { if (c[v] >= n) { n = c[v]; best = v; } }); // 같으면 늦은 쪽
    return best;
  }
  function safeName(s) { return String(s || '').replace(/[\\/:*?"<>|\s]+/g, '').slice(0, 20); }
  function fileName(category, items, userName, mode) {
    var who = safeName(userName) || '이름없음', date;
    if (category === '출장비') {
      var trips = items.map(function (it) { return it.tripDate; }).filter(Boolean).sort();
      date = trips[0] || (items.map(function (it) { return (it.txAt || it.capturedAt || '').slice(0, 10); }).sort()[0] || '');
      return (date ? date.slice(2, 4) + date.slice(5, 7) + date.slice(8, 10) : '000000') + '_출장_영수증_' + who + '.pdf';
    }
    var ym = mostCommon(items.map(function (it) { return it.month; }));
    date = ym ? ym.slice(2, 4) + ym.slice(5, 7) + String(lastDay(ym)).padStart(2, '0') : '000000';
    var corp = category === '경비' && items.length && items.every(function (it) { return it.cardType === '법인카드'; }) ? '법인_' : ''; // 경비 법인카드는 따로 청구
    return date + '_' + category + '_' + corp + (mode === 'sheet' ? '갑지' : '영수증') + '_' + who + '.pdf';
  }

  // ── 그리기 ──
  function render(root, c) {
    ctx = c;
    if (P && P.done) return renderDone(root, P.done);
    var sel = c.selection;
    if (!sel || !sel.ids.length) {
      root.appendChild(el('<div class="empty"><b>고른 영수증이 없습니다</b>보관함에서 영수증을 체크한 뒤 [A4 미리보기·PDF]를 눌러 주세요.</div>'));
      setTimeout(function () { ctx.back(); }, 1200);
      return;
    }
    var key = sel.category + '|' + sel.ids.join(',') + '|' + (sel.remake ? sel.remake.pdfId : '');
    if (!P || P.key !== key) start(sel, key);
    else if (!P.busy && !P.savedPdf) P.items = sel.items.slice(); // 상세에서 고친 값(내용 등)을 바로 반영

    var items = P.items, sum = 0;
    items.forEach(function (it) { sum += it.amount || 0; });
    var remake = sel.remake || null;
    var mode = getMode(sel.category), withSheet = mode !== 'receipts';
    var info = ctx.info() || {};
    var name = remake && remake.name ? remake.name : fileName(sel.category, items, ctx.userName, mode);
    var warns = [];
    // 사용구분(개인청구·법인카드)이 섞이면 갑지를 따로 만들어야 함
    var uses = {}; items.forEach(function (it) { var u = RSGapji.useType(it); (uses[u] = uses[u] || []).push(it.id); });
    var mixed = sel.category === '경비' && Object.keys(uses).length > 1; // 경비는 사용내역별로 아예 따로 청구(접대비·회의비는 한 PDF에 함께)
    var useLabel = sel.category === '경비' ? { '개인청구': '현금경비', '법인카드': '법인카드' } : { '개인청구': '개인청구', '법인카드': '법인카드' };
    var lacks = REQUIRED[sel.category] ? items.map(function (it) { return { it: it, m: missingOf(sel.category, it) }; }).filter(function (x) { return x.m.length; }) : [];
    var noInfo = withSheet && !(info['사번'] && info['사원명'] && info['팀명']);
    if (sel.category === '출장비') {
      var trips = {}; items.forEach(function (it) { trips[it.tripDate || '없음'] = 1; });
      if (Object.keys(trips).length > 1) warns.push('출장일이 다른 영수증이 섞여 있습니다. 파일명에는 가장 이른 출장일을 씁니다.');
      if (trips['없음']) warns.push('출장일이 없는 영수증이 있습니다.');
    } else {
      var ms = {}; items.forEach(function (it) { ms[it.month] = 1; });
      if (Object.keys(ms).length > 1) warns.push('귀속 월이 다른 영수증이 섞여 있습니다(' + Object.keys(ms).sort().map(function (m) { return Number(m.slice(5)) + '월'; }).join('·') + '). 파일명에는 가장 많은 달을 씁니다.');
    }
    if (sel.leftOut) warns.push('판독 대기·확인 필요 ' + sel.leftOut + '건은 아직 값이 없어 PDF에 들어가지 않습니다.');

    var h = '<header class="dt-top"><button class="icon-btn" id="pvBack" aria-label="뒤로">' + ICON.back + '</button><h1>' + (remake ? '다시 만들기' : 'A4 미리보기') + '</h1></header>' +
      (remake ? '<div class="banner">이 PDF 파일의 내용을 새로 바꿉니다. 파일명과 Drive 위치는 그대로이고, 바뀌기 전 내용은 Drive 버전 기록에 남습니다.</div>' : '') +
      '<div class="pv-sum"><b>' + esc(sel.category) + '</b> · ' + items.length + '건 · ' + won(sum) + '원' +
        '<!--np-->' + '</div>' +
      '<div class="pv-name"><span>파일명' + (remake ? ' (그대로)' : '') + '</span><b>' + esc(name) + '</b>' +
        (P.size ? '<span>PDF 크기 약 ' + (P.size / 1048576).toFixed(1) + 'MB' + (P.reduced ? ' · 10MB를 넘지 않게 화질을 조금 낮춤' : '') + '</span>' : '') + '</div>' +
      (P.tooBig ? '<div class="banner warn">화질을 낮춰도 10MB를 넘습니다. 인트라넷에 올라가지 않을 수 있으니 영수증을 두 번에 나눠 만들어 주세요.</div>' : '') +
      warns.map(function (w) { return '<div class="banner warn">' + esc(w) + '</div>'; }).join('') +
      (RSGapji.KINDS.indexOf(sel.category) >= 0 ? '<div class="pv-mode" role="group" aria-label="PDF 구성">' + MODES.map(function (m) {
        return '<button type="button" data-mode="' + m[0] + '"' + (mode === m[0] ? ' class="on"' : '') + '>' + m[1] + '</button>';
      }).join('') + '</div>' : '') +
      (mixed ? '<div class="banner warn">' + useLabel['개인청구'] + ' ' + uses['개인청구'].length + '건과 법인카드 ' + uses['법인카드'].length + '건이 섞여 있습니다. ' +
        (sel.category === '경비' ? '경비는 사용내역(현금경비·법인카드)별로 따로 청구합니다.' : '갑지는 사용구분별로 따로 만듭니다.') + ' 한쪽만 골라 주세요.' +
        '<div class="pv-split"><button class="mini" type="button" data-use="개인청구">' + useLabel['개인청구'] + ' ' + uses['개인청구'].length + '건만</button>' +
        '<button class="mini" type="button" data-use="법인카드">법인카드 ' + uses['법인카드'].length + '건만</button></div></div>' : '') +
      (lacks.length ? '<div class="banner warn" role="alert"><b>빈 칸이 있어 PDF를 만들 수 없습니다 (' + lacks.length + '건)</b>' +
        '<ul class="pv-lack">' + lacks.map(function (x) {
          var d = String(x.it.txAt || x.it.capturedAt || '').slice(5, 10).replace('-', '/');
          return '<li><button type="button" class="linkish" data-fix="' + esc(x.it.id) + '">' + esc(d + ' ' + (x.it.merchant || '') + (x.it.hasAmount ? ' · ' + won(x.it.amount) + '원' : '')) + '</button> — ' + esc(x.m.join(', ')) + ' 없음</li>';
        }).join('') + '</ul>항목을 누르면 상세 화면에서 바로 채울 수 있습니다. 구글 시트에서 채워도 됩니다.</div>' : '') +
      (noInfo ? '<div class="banner">갑지 머리글(사번·팀명·사원명 등)이 비어 있습니다. <button class="mini" id="pvMe" type="button">내 정보 채우기</button></div>' : '') +
      (P.error ? '<div class="banner warn" role="alert">' + esc(P.error) + ' <button class="mini" id="pvRetry" type="button">다시 시도</button></div>' : '');

    var atts = mode === 'sheet' ? [] : items.filter(isAtt);       // 손입력 영수증의 PDF(영수증 쪽 뒤에 붙음)
    var sheets = withSheet && !mixed ? sheetUrls(sel.category, items, info) : [];
    var nRec = mode === 'sheet' ? 0 : (P.pages ? P.pages.length : 0);
    var nPages = sheets.length + nRec;
    var extra = atts.length;
    h = h.replace('<!--np-->', nPages || extra ? ' · <b>' + (nPages ? nPages + '쪽' : '') + (extra ? (nPages ? ' + ' : '') + 'PDF ' + extra + '개' : '') + '</b>' : '');
    var attCard = function (label, name, sub, href, del) {
      return '<div class="pv-pl">' + label + '</div><div class="pv-att">' +
        '<svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="#8A8D94" stroke-width="1.6" stroke-linejoin="round"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 12h6M9 16h6"/></svg>' +
        '<b>' + esc(name) + '</b>' + (sub ? esc(sub) : '') + '<span>올린 PDF의 모든 쪽이 이 자리에 그대로 들어갑니다</span>' +
        (href ? '<a class="mini" href="' + href + '" target="_blank" rel="noopener">PDF 열기</a>' : '') + (del || '') + '</div>';
    };
    h += sheets.map(function (u, i) {
      return '<div class="pv-pl">갑지 ' + (i + 1) + (sheets.length > 1 ? ' / ' + sheets.length : '') + '</div><div class="pv-page pv-sheet"><img src="' + u + '" alt="갑지 ' + (i + 1) + '쪽"></div>';
    }).join('');
    if (mode === 'sheet') {
      h += '<p class="hint">갑지만 PDF로 만듭니다. 영수증 사진은 넣지 않습니다.</p>';
    } else if (!P.pages) {
      h += '<div class="empty"><b>배치를 계산하는 중…</b>' + esc(P.status || '') + '</div>';
    } else if (P.pages.length) {
      h += P.pages.map(function (pg) {
        return '<div class="pv-pl">영수증 ' + (pg.page + 1) + ' / ' + P.pages.length + '쪽' + (pg.scale < 0.999 ? ' · ' + Math.round(pg.scale * 100) + '%로 줄임' : '') + '</div>' +
          '<div class="pv-page">' + pg.boxes.map(function (b) {
            var st = 'left:' + (b.x / 210 * 100) + '%;top:' + (b.y / 297 * 100) + '%;width:' + (b.w / 210 * 100) + '%;height:' + (b.h / 297 * 100) + '%';
            return '<div class="pv-box" style="' + st + '" data-pv="' + esc(b.id) + '">' + (imgs[b.id] ? '<img src="' + imgs[b.id] + '" alt="">' : '') + '</div>';
          }).join('') + '</div>';
      }).join('');
      h += '<p class="hint">흰 종이 = A4 한 장(여백 10mm). 영수증은 실제 크기로 놓고, 넘치는 쪽만 조금 줄입니다(85%까지).</p>';
    }
    h += atts.map(function (it) {
      return attCard('첨부 영수증 PDF', it.desc || it.work || it.topic || 'PDF 첨부', ' · ' + won(it.amount) + '원', it.fileId ? 'https://drive.google.com/file/d/' + encodeURIComponent(it.fileId) + '/view' : '');
    }).join('');
    h += '<div class="dt-bar"><button class="btn-alt pv-alt" id="pvBack2" type="button">고르기로</button>' +
      '<button class="cta" id="pvSave" type="button"' + (P.pages && !P.busy && !mixed && !lacks.length && navigator.onLine ? '' : ' disabled') + '>' +
        (P.busy ? esc(P.busy) : P.savedPdf ? '청구완료 처리 다시 시도' : remake ? 'PDF 바꾸고 청구완료' : 'PDF로 저장하고 청구완료') + '</button></div><div class="bx-space"></div>';
    if (!navigator.onLine) h = h.replace('<div class="dt-bar">', '<div class="banner">온라인에서만 PDF를 저장할 수 있습니다.</div><div class="dt-bar">');

    root.appendChild(el(h));
    var back = function () { ctx.back(); };
    root.querySelector('#pvBack').onclick = back;
    root.querySelector('#pvBack2').onclick = back;
    root.querySelector('#pvSave').onclick = function () { save(sel, name, mode, info); };
    root.querySelectorAll('[data-mode]').forEach(function (b) {
      b.onclick = function () { if (P.busy || P.savedPdf) return; setMode(sel.category, b.dataset.mode); redraw(); };
    });
    root.querySelectorAll('[data-use]').forEach(function (b) { b.onclick = function () { ctx.narrow(uses[b.dataset.use]); }; });
    root.querySelectorAll('[data-fix]').forEach(function (b) { b.onclick = function () { ctx.openDetail(b.dataset.fix); }; });
    var me = root.querySelector('#pvMe');
    if (me) me.onclick = function () { ctx.gotoMe(); };
    var rt = root.querySelector('#pvRetry');
    if (rt) rt.onclick = function () { P = null; ctx.rerender(); };
  }

  // ── 저장 ──
  async function save(sel, name, mode, info) {
    var p = P;
    if (p.busy) return;
    if (REQUIRED[sel.category] && p.items.some(function (it) { return missingOf(sel.category, it).length; })) return;
    p.error = '';
    var remake = sel.remake || null;
    var byId = {}; p.items.forEach(function (it) { byId[it.id] = it; });
    try {
      if (!p.savedPdf) {
        p.busy = 'PDF를 만드는 중…'; redraw();
        // 갑지 쪽 = A4 전체를 차지하는 그림 한 장
        var all = [], cv = mode === 'receipts' ? [] : RSGapji.draw(sel.category, p.items, info, claimMonth(p.items), 200);
        cv.forEach(function (c, i) {
          var gid = '__gapji' + i;
          byId[gid] = { id: gid, rot: 0, canvas: c };
          all.push({ page: all.length, scale: 1, boxes: [{ id: gid, x: 0, y: 0, w: 210, h: 297, scale: 1, sheet: true }] });
        });
        if (mode !== 'sheet') p.pages.forEach(function (pg) { all.push(pg); });
        // 첨부 PDF 받아 두기(크기만큼 사진 PDF 한도를 줄임)
        var atts = mode === 'sheet' ? [] : p.items.filter(isAtt);
        var attBufs = [], attSize = 0;
        for (var ai = 0; ai < atts.length; ai++) {
          p.busy = '첨부 PDF 받는 중 ' + (ai + 1) + ' / ' + atts.length; setBusy(p.busy);
          var ab = await (await ctx.photoBlob(atts[ai])).arrayBuffer();
          attBufs.push({ it: atts[ai], buf: ab }); attSize += ab.byteLength;
        }
        var built = all.length ? await RSPdf.build(all, byId, function (it) { return it.canvas ? Promise.resolve(it.canvas) : ctx.photoBlob(it).then(decode); },
          function (msg) { p.busy = msg; setBusy(msg); }, Math.max(1024 * 1024, RSPdf.LIMIT - attSize)) : { blob: null, reduced: false };
        if (attBufs.length) {
          p.busy = 'PDF 합치는 중…'; setBusy(p.busy);
          built.blob = await mergePdf(null, built.blob, attBufs);
          built.tooBig = built.blob.size > RSPdf.LIMIT;
        }
        p.size = built.blob.size; p.reduced = built.reduced; p.tooBig = !!built.tooBig;
        if (p.tooBig && !confirm('PDF가 ' + (p.size / 1048576).toFixed(1) + 'MB로 인트라넷 한도(10MB)를 넘습니다. 그래도 저장할까요?')) { p.busy = ''; redraw(); return; }
        p.busy = 'Drive에 저장하는 중…'; redraw();
        var f;
        if (remake) f = await ctx.replacePdf(remake.pdfId, built.blob);
        else {
          var folder = await ctx.claimFolder(monthOfName(name, sel, p.items));
          f = await ctx.uploadPdf(folder, await ctx.freeName(folder, name), built.blob);
        }
        p.savedPdf = { id: f.id, name: f.name || name };
      }
      p.busy = '청구완료 처리 중…'; redraw();
      var now = ctx.nowIso(), list = p.items.map(function (it) {
        return { id: it.id, status: '청구완료', pdfId: p.savedPdf.id, claimedAt: now, expect: remake ? ['보관중', '청구완료'] : ['보관중'] };
      });
      if (remake) remake.ids.forEach(function (id) {
        if (!byId[id]) list.push({ id: id, status: '보관중', pdfId: '', claimedAt: '', expect: ['청구완료'] });
      });
      var res = await ctx.setClaimStatus(list);
      var removed = remake ? remake.ids.filter(function (id) { return !byId[id]; }).length : 0;
      p.busy = '';
      p.done = { name: p.savedPdf.name, id: p.savedPdf.id, count: p.items.length, removed: removed, skipped: res.skipped.length, size: p.size, remake: !!remake };
      ctx.claimed();
      redraw();
    } catch (e) {
      p.busy = '';
      p.error = (p.savedPdf ? 'PDF는 Drive에 저장했지만 청구완료 처리를 하지 못했습니다. ' : 'PDF를 저장하지 못했습니다. ') + (e.message || e);
      redraw();
    }
  }

  // 미리보기용 갑지(작게). 값이 같으면 다시 그리지 않음
  function sheetUrls(cat, items, info) {
    var key = cat + '|' + JSON.stringify(info) + '|' + items.map(function (it) {
      return [it.id, it.txAt, it.amount, it.account, it.work, it.fuel, it.topic, it.guest, it.attendees, it.from, it.to, it.transport, it.driveTime, it.km, it.car, it.cardType, it.month].join('~');
    }).join('|');
    if (sheetPrev.key !== key) {
      sheetPrev.key = key;
      sheetPrev.urls = RSGapji.draw(cat, items, info, claimMonth(items), 110).map(function (c) { return c.toDataURL('image/png'); });
    }
    return sheetPrev.urls;
  }

  // PDF 합치기: [출장비 인트라넷 갑지] → 앱 갑지·영수증 쪽 → 첨부 영수증 PDF. pdf-lib(MIT)을 필요할 때만 불러옴
  function loadPdfLib() { return RSPdf.lib('pdflib'); }
  async function mergePdf(frontBuf, appBlob, attBufs) {
    await loadPdfLib();
    var L = window.PDFLib, out = await L.PDFDocument.create();
    var add = async function (buf, label) {
      var doc;
      try { doc = await L.PDFDocument.load(buf); }
      catch (e) { throw new Error('"' + label + '" PDF를 열 수 없습니다(암호가 걸렸거나 손상된 파일). 다른 PDF로 바꿔 주세요'); }
      (await out.copyPages(doc, doc.getPageIndices())).forEach(function (pg) { out.addPage(pg); });
    };
    if (frontBuf) await add(frontBuf, '출장비 갑지');
    if (appBlob) await add(await appBlob.arrayBuffer(), '영수증');
    for (var i = 0; i < attBufs.length; i++) await add(attBufs[i].buf, attBufs[i].it.desc || attBufs[i].it.work || attBufs[i].it.topic || '첨부');
    return new Blob([await out.save()], { type: 'application/pdf' });
  }

  function setBusy(msg) { var b = document.getElementById('pvSave'); if (b) b.textContent = msg; }

  // 청구본 폴더의 달: 파일명 앞 날짜의 달(출장비는 출장일, 그 외는 청구월)
  function monthOfName(name, sel, items) {
    var m = /^(\d{2})(\d{2})\d{2}_/.exec(name);
    if (m) return '20' + m[1] + '-' + m[2];
    return (items[0] && items[0].month) || new Date().toISOString().slice(0, 7);
  }

  function renderDone(root, d) {
    root.appendChild(el('<header class="dt-top"><h1 style="padding-left:12px">' + (d.remake ? 'PDF를 바꿨습니다' : '청구완료') + '</h1></header>' +
      '<div class="pv-done"><div class="pv-ok">✓</div><b>' + esc(d.name) + '</b>' +
      '<p>' + d.count + '건을 청구완료로 바꿨습니다' + (d.removed ? ' · ' + d.removed + '건은 보관중으로 되돌렸습니다' : '') + '.<br>PDF 크기 약 ' + (d.size / 1048576).toFixed(1) + 'MB · Drive "영수증 스캔/청구본" 폴더</p>' +
      (d.skipped ? '<p class="err">' + d.skipped + '건은 PC에서 상태가 바뀌어 있어 그대로 두었습니다.</p>' : '') +
      '<a class="cta pv-open" href="https://drive.google.com/file/d/' + encodeURIComponent(d.id) + '/view" target="_blank" rel="noopener">PDF 열기</a>' +
      '<button class="btn-alt pv-alt2" id="pvDone" type="button">보관함으로</button></div>'));
    root.querySelector('#pvDone').onclick = function () { P = null; ctx.finish(); };
  }

  function start(sel, key) {
    P = { key: key, items: sel.items.slice(), pages: null, dims: {}, status: '', error: '' };
    prepare(P).catch(function (e) {
      if (P && P.key === key) { P.error = '배치를 계산하지 못했습니다 (' + (e.message || e) + ')'; redraw(); }
    });
  }

  function redraw() { if (ctx && ctx.isActive()) { var y = window.scrollY; ctx.rerender(); window.scrollTo(0, y); } }

  // 사진 크기를 알아낸 뒤 배치 → 사진 불러오기
  async function prepare(p) {
    var items = p.items.filter(function (it) { return !isAtt(it); }), done = 0;
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      p.dims[it.id] = await dimsOf(it);
      done++;
      if (P !== p) return;
      p.status = '사진 크기 확인 ' + done + ' / ' + items.length;
      if (done % 3 === 0 || done === items.length) redraw();
    }
    var input = items.map(function (it) {
      var d = p.dims[it.id], odd = (it.rot || 0) % 2 === 1;
      var pw = odd ? d.h : d.w, ph = odd ? d.w : d.h;
      var wmm = Number(it.widthMm) || 80;
      return { id: it.id, realW: wmm, realH: wmm * ph / pw, date: it.txAt || it.capturedAt || '' };
    });
    p.pages = RSLayout.layout(input);
    redraw();
    // 사진은 두 장씩 차례로 불러와 끼워 넣음
    var queue = p.pages.reduce(function (a, pg) { return a.concat(pg.boxes.map(function (b) { return b.id; })); }, []);
    var byId = {}; items.forEach(function (it) { byId[it.id] = it; });
    var worker = async function () {
      while (queue.length && P === p) {
        var id = queue.shift();
        if (imgs[id]) { place(id); continue; }
        try { imgs[id] = await smallImage(byId[id], 900); place(id); } catch (e) { /* 사진 없이 자리만 보임 */ }
      }
    };
    await Promise.all([worker(), worker()]);
  }

  function place(id) {
    var box = document.querySelector('.pv-box[data-pv="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"]');
    if (box && imgs[id]) box.innerHTML = '<img src="' + imgs[id] + '" alt="">';
  }

  async function dimsOf(it) {
    try { var c = JSON.parse(localStorage.getItem(DIM_KEY + it.id) || 'null'); if (c && c.w > 0 && c.h > 0) return c; } catch (e) { /* 무시 */ }
    var d = null;
    if (it.fileId) { try { d = await ctx.imageSize(it.fileId); } catch (e) { d = null; } }
    if (!d) { var img = await decode(await ctx.photoBlob(it)); d = { w: img.naturalWidth, h: img.naturalHeight }; }
    try { localStorage.setItem(DIM_KEY + it.id, JSON.stringify(d)); } catch (e) { /* 무시 */ }
    return d;
  }

  function decode(blob) {
    return new Promise(function (res, rej) {
      var u = URL.createObjectURL(blob), im = new Image();
      im.onload = function () { URL.revokeObjectURL(u); res(im); };
      im.onerror = function () { URL.revokeObjectURL(u); rej(new Error('사진을 열 수 없습니다')); };
      im.src = u;
    });
  }

  async function smallImage(it, max) {
    var img = await decode(await ctx.photoBlob(it));
    var s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    var c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    c = RSImaging.rotate(c, it.rot || 0);
    var b = await new Promise(function (res) { c.toBlob(res, 'image/jpeg', 0.8); });
    return URL.createObjectURL(b);
  }

  window.RSPreview = {
    render: render,
    fileName: fileName,
    reset: function () { P = null; Object.keys(imgs).forEach(function (k) { URL.revokeObjectURL(imgs[k]); }); imgs = {}; }
  };
})();
