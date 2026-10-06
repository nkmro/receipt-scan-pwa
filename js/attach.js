/* 파일 첨부(4단계 5번) = 영수증을 손으로 1건 등록
   - AI 판독이 안 되는 영수증 묶음(통신비 내역서, 한 달 치 하이패스 내역 등)을 PDF로 올리고 거래일·금액·결제 수단·내역을 직접 적음
   - 청구 PDF에는 찍은 영수증 쪽 뒤에 올린 PDF가 그대로 붙고, 갑지에는 1줄로 들어감
   - PDF는 여러 개 올릴 수 있음(올린 순서대로 1개로 합침, ▲로 순서 변경). 암호 PDF는 비밀번호를 한 번 물어 풂
   - 순서: 구분 → PDF → 거래일·금액·결제 수단 → 내역 → 저장 → 상세에서 인트라넷 칸(계정 등) 채움 */
(function () {
  'use strict';

  var CATEGORIES = ['경비', '접대비', '회의비', '출장비'];
  var PAYS = ['개인카드', '법인카드', '현금'];
  var CARDS = ['신한카드', '삼성카드', '현대카드', 'KB국민카드', '롯데카드', '하나카드', '우리카드', 'BC카드', 'NH농협카드'];
  var MAX = 10 * 1024 * 1024;
  var A = null, ctx = null;

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function won(n) { return Number(n || 0).toLocaleString('ko-KR'); }
  function p2(n) { return String(n).padStart(2, '0'); }
  function today() { var d = new Date(); return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()); }
  function el(html) { var t = document.createElement('template'); t.innerHTML = html.trim(); return t.content; }
  var BACK = '<svg viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6"/></svg>';

  function field(label, input, req, hint) {
    return '<div class="dt-f"><span class="dt-l">' + label + (req ? ' <em>필수</em>' : '') + '</span>' + input +
      (hint ? '<span class="dt-hint">' + esc(hint) + '</span>' : '') + '</div>';
  }
  function seg(key, list, cur) {
    return '<div class="dt-seg">' + list.map(function (x) {
      var v = Array.isArray(x) ? x[0] : x, t = Array.isArray(x) ? x[1] : x;
      return '<button type="button" data-a="' + key + '" data-v="' + esc(v) + '"' + (cur === v ? ' class="on"' : '') + '>' + esc(t) + '</button>';
    }).join('') + '</div>';
  }

  function render(root, c) {
    ctx = c;
    if (!A) A = { category: CATEGORIES.indexOf(c.category) >= 0 ? c.category : '경비', files: [], date: today(),
      amount: '', pay: '', card: '', corpCard: '', desc: '', busy: '', error: '' };
    var trip = A.category === '출장비';
    var h = '<header class="dt-top"><button class="icon-btn" id="atBack" aria-label="뒤로">' + BACK + '</button><h1>파일 첨부</h1></header>' +
      '<p class="hint" style="margin-top:0">AI가 읽기 어려운 영수증(통신비 내역서, 한 달 치 하이패스 내역 등)을 PDF로 올리고 금액을 직접 적어 1건으로 등록합니다.</p>';
    if (A.error) h += '<div class="banner warn" role="alert">' + esc(A.error) + '</div>';
    h += '<section class="dt-sec"><div class="dt-sec-h">무엇을 올리나요</div><div class="dt-sec-b">' +
      field('구분', seg('category', CATEGORIES, A.category), true) +
      field('PDF 파일' + (A.files.length > 1 ? ' (' + A.files.length + '개 · 올린 순서대로 1개로 합침)' : ''), A.files.map(function (f, i) {
        var st = f.checking ? esc(f.checking) : f.lock ? '암호 걸림' : f.unlocked ? '암호 풀림' : '';
        return '<div class="at-row"><span class="at-no">' + (i + 1) + '</span><span class="at-name">' + esc(f.name) +
          '<small>' + (f.file ? (f.file.size / 1048576).toFixed(1) + 'MB' : '') + (st ? (f.file ? ' · ' : '') + st : '') + '</small></span>' +
          '<button type="button" class="mini" data-up="' + i + '"' + (i ? '' : ' disabled') + ' aria-label="위로">▲</button>' +
          '<button type="button" class="mini" data-del="' + i + '" aria-label="빼기">빼기</button></div>' +
          (f.lock ? '<div class="at-pw"><input type="password" data-pw="' + i + '" autocomplete="off" placeholder="비밀번호 (예: 생년월일 6자리)">' +
            '<button type="button" class="mini ok" data-unlock="' + i + '"' + (f.checking ? ' disabled' : '') + '>암호 풀기</button></div>' +
            '<span class="dt-hint">' + (f.lock.wrong ? '비밀번호가 맞지 않습니다. 다시 입력해 주세요' : '암호가 걸린 PDF입니다. 비밀번호를 한 번 입력하면 암호 없는 PDF로 바꿔 올립니다(비밀번호는 저장하지 않음)') + '</span>' : '');
      }).join('') +
        '<label class="at-file"><input type="file" id="atFile" accept="application/pdf,.pdf" multiple hidden><span>' + (A.files.length ? '+ PDF 더 추가' : 'PDF 고르기 (여러 개 가능)') + '</span></label>', true,
        A.files.length > 1 ? '위에서부터 순서대로 한 PDF로 합쳐집니다. ▲로 순서를 바꿀 수 있습니다' : '') +
      '</div></section>';
    h += '<section class="dt-sec"><div class="dt-sec-h">결제</div><div class="dt-sec-b">' +
      '<div class="dt-2">' + field(trip ? '출장일' : '거래일', '<input type="date" data-a="date" max="' + today() + '" value="' + esc(A.date) + '">', true,
        trip ? '같은 출장일의 영수증과 묶입니다' : '') +
      field('금액', '<div class="dt-won"><input type="text" inputmode="numeric" data-a="amount" value="' + esc(A.amount ? won(A.amount) : '') + '" placeholder="0"><span>원</span></div>', true) + '</div>' +
      field('결제 수단', seg('pay', PAYS, A.pay), true, A.pay ? '' : 'AI 판독을 하지 않으니 직접 골라 주세요 (홈 카드별 합계에 쓰임)') +
      (A.pay === '개인카드' ? field('카드사', '<input type="text" data-a="card" list="atCards" maxlength="20" placeholder="예: 신한카드" value="' + esc(A.card) + '">' +
        '<datalist id="atCards">' + CARDS.map(function (c) { return '<option value="' + c + '">'; }).join('') + '</datalist>', true) : '') +
      (A.pay === '법인카드' ? field('법인카드', '<select data-a="corpCard"><option value="">선택</option>' + RSAuth.corpCards().map(function (cc) {
        return '<option' + (A.corpCard === cc ? ' selected' : '') + '>' + esc(cc) + '</option>';
      }).join('') + '</select>', true) : '') +
      field(descLabel(), '<input type="text" data-a="desc" maxlength="100" placeholder="예: 9월 통신비, 9월 하이패스" value="' + esc(A.desc) + '">', true,
        '인트라넷 ' + descLabel() + ' 칸에 들어가고, 보관함 목록에도 이 이름으로 보입니다. 나머지 인트라넷 칸(계정 등)은 저장한 뒤 상세 화면에서 채웁니다') +
      '</div></section>';
    var ok = validate() === '';
    h += '<div class="dt-bar"><button class="cta" id="atSave" type="button"' + (ok && !A.busy && navigator.onLine ? '' : ' disabled') + '>' +
      (A.busy ? esc(A.busy) : '저장하고 상세 보기') + '</button></div><div class="bx-space"></div>';
    if (!navigator.onLine) h = h.replace('<div class="dt-bar">', '<div class="banner">온라인에서만 올릴 수 있습니다.</div><div class="dt-bar">');
    root.appendChild(el(h));
    bind(root);
  }

  // 적은 내용이 들어갈 인트라넷 칸 이름
  function descLabel() { return A.category === '경비' ? '업무내용' : (A.category === '접대비' || A.category === '회의비') ? '내용' : '내역'; }

  function validate() {
    if (!A.files.length) return 'PDF 파일을 골라 주세요';
    if (A.files.some(function (f) { return f.checking; })) return 'PDF 확인 중입니다';
    if (A.files.some(function (f) { return !f.file; })) return '암호 걸린 PDF의 암호를 풀어 주세요';
    var tot = A.files.reduce(function (s, f) { return s + f.file.size; }, 0);
    if (tot > MAX) return 'PDF를 합치면 10MB가 넘습니다(지금 ' + (tot / 1048576).toFixed(1) + 'MB). 일부를 빼 주세요';
    if (!A.date) return '날짜를 적어 주세요';
    if (!(Number(A.amount) > 0)) return '금액을 적어 주세요';
    if (!A.desc.trim()) return descLabel() + '을(를) 적어 주세요';
    if (!A.pay) return '결제 수단을 골라 주세요';
    if (A.pay === '개인카드' && !A.card.trim()) return '카드사를 적어 주세요';
    if (A.pay === '법인카드' && !A.corpCard) return '법인카드를 골라 주세요';
    return '';
  }

  function redraw() { var y = window.scrollY; ctx.rerender(); window.scrollTo(0, y); }
  function refreshBtn(root) {
    var b = root.querySelector('#atSave');
    if (b) b.disabled = !(validate() === '' && !A.busy && navigator.onLine);
  }

  function bind(root) {
    root.querySelector('#atBack').onclick = function () { A = null; ctx.back(); };
    root.querySelectorAll('button[data-a]').forEach(function (b) {
      b.onclick = function () {
        var k = b.dataset.a; A[k] = b.dataset.v;
        if (k === 'pay' && A.pay !== '법인카드') A.corpCard = '';
        if (k === 'pay' && A.pay !== '개인카드') A.card = '';
        redraw();
      };
    });
    root.querySelectorAll('input[data-a], select[data-a]').forEach(function (i) {
      var k = i.dataset.a;
      i.oninput = i.onchange = function () {
        if (k === 'amount') {
          var d = i.value.replace(/[^\d]/g, '').replace(/^0+(?=\d)/, '');
          A.amount = d; var f = d ? won(d) : ''; if (i.value !== f) i.value = f;
        } else A[k] = i.value;
        refreshBtn(root);
      };
    });
    var f = root.querySelector('#atFile');
    f.onchange = function () {
      var list = Array.prototype.slice.call(f.files || []);
      list.forEach(function (file) {
        if (!/pdf$/i.test(file.type) && !/\.pdf$/i.test(file.name)) { ctx.toast('PDF 파일만 올릴 수 있습니다: ' + file.name); return; }
        if (file.size > MAX) { ctx.toast('10MB가 넘는 파일은 올릴 수 없습니다: ' + file.name); return; }
        var item = { name: file.name, file: null, lock: null, unlocked: false, checking: 'PDF 확인 중…' };
        A.files.push(item);
        if (!A.desc) A.desc = file.name.replace(/\.pdf$/i, '').slice(0, 100);
        check(item, file);
      });
      redraw();
    };
    root.querySelectorAll('[data-del]').forEach(function (b) { b.onclick = function () { A.files.splice(+b.dataset.del, 1); redraw(); }; });
    root.querySelectorAll('[data-up]').forEach(function (b) {
      b.onclick = function () { var i = +b.dataset.up; if (i > 0) { var x = A.files[i]; A.files[i] = A.files[i - 1]; A.files[i - 1] = x; redraw(); } };
    });
    root.querySelectorAll('[data-unlock]').forEach(function (b) {
      var i = +b.dataset.unlock, pw = root.querySelector('[data-pw="' + i + '"]');
      b.onclick = function () { unlock(A.files[i], pw.value); };
      pw.onkeydown = function (e) { if (e.key === 'Enter') unlock(A.files[i], pw.value); };
    });
    var s = root.querySelector('#atSave');
    s.onclick = save;
  }

  // 고른 PDF가 암호 PDF인지 확인. 열람 암호 없이 열리는 것(편집 제한만 걸린 것)은 바로 풀어 줌
  async function check(item, file) {
    try {
      var buf = await file.arrayBuffer();
      if (!(await RSPdf.isEncrypted(buf))) { item.file = file; return; }
      item.lock = { buf: buf, wrong: false };
      try { await unlockNow(item, '', true); } catch (e) { /* 비밀번호 필요 → 입력 칸 보여 줌 */ }
    } catch (e) {
      ctx.toast((e.message || 'PDF를 확인하지 못했습니다') + ': ' + item.name);
      var i = A ? A.files.indexOf(item) : -1; if (i >= 0) A.files.splice(i, 1);
    } finally { item.checking = ''; if (A) redraw(); }
  }
  async function unlockNow(item, password, quiet) {
    var blob = await RSPdf.unlock(item.lock.buf, password, function (m) { item.checking = m; if (A) redraw(); });
    if (blob.size > MAX) throw new Error('암호를 푼 PDF가 10MB를 넘습니다. 쪽수를 나눠 올려 주세요');
    item.file = new File([blob], item.name, { type: 'application/pdf' });
    item.unlocked = true; item.lock = null;
    if (!quiet) ctx.toast('암호를 풀었습니다');
  }
  async function unlock(item, password) {
    if (!item || !item.lock || item.checking) return;
    if (!password) { ctx.toast('비밀번호를 입력해 주세요'); return; }
    item.checking = '암호 푸는 중…'; redraw();
    try { await unlockNow(item, password); }
    catch (e) {
      if (e.pw === 'wrong' || e.pw === 'need') item.lock.wrong = true;
      else ctx.toast(e.message || '암호를 풀지 못했습니다');
    } finally { item.checking = ''; if (A) redraw(); }
  }

  // 여러 PDF를 올린 순서대로 1개로 합침
  async function joined(onStep) {
    if (A.files.length === 1) return A.files[0].file;
    onStep('PDF ' + A.files.length + '개를 합치는 중…');
    var L = await RSPdf.lib('pdflib'), out = await L.PDFDocument.create();
    for (var i = 0; i < A.files.length; i++) {
      var doc = await L.PDFDocument.load(await A.files[i].file.arrayBuffer());
      (await out.copyPages(doc, doc.getPageIndices())).forEach(function (pg) { out.addPage(pg); });
    }
    var blob = new Blob([await out.save()], { type: 'application/pdf' });
    if (blob.size > MAX) throw new Error('합친 PDF가 10MB를 넘습니다. 일부를 빼 주세요');
    return new File([blob], (A.desc.trim() || 'attach') + '.pdf', { type: 'application/pdf' });
  }

  async function save() {
    var msg = validate();
    if (msg) { ctx.toast(msg); return; }
    A.busy = 'PDF 준비 중…'; A.error = ''; redraw();
    try {
      var file = await joined(function (m) { A.busy = m; redraw(); });
      A.busy = 'Drive에 올리는 중…'; redraw();
      var id = await ctx.saveAttachment({
        category: A.category, file: file, txDate: A.date,
        amount: A.amount === '' ? '' : Number(A.amount), cardType: A.pay, corpCard: A.pay === '법인카드' ? A.corpCard : '',
        card: A.pay === '개인카드' ? A.card.trim() : A.pay === '현금' ? '현금' : '',
        desc: A.desc.trim()
      }, function (m) { A.busy = m; redraw(); });
      A = null;
      ctx.done(id);
    } catch (e) {
      A.busy = ''; A.error = '올리지 못했습니다. ' + (e.message || e); redraw();
    }
  }

  window.RSAttach = { render: render, reset: function () { A = null; } };
})();
