/* AI 판독(5단계)
   - 판독대기 영수증을 하나씩 중계 서버(/v1/ocr → DeepSeek)로 보내 거래일시·금액·가맹점·주소·결제 수단·카드사를 채움
   - 사진: 폰에 남아 있으면 그것을, 없으면 Drive 원본을 받아 긴 변 1300px JPEG로 줄여 보냄
   - 결과가 확실하면 보관중, 거래일·금액이 비거나 AI가 확신하지 못하면 확인필요(사유 적음)
   - 이미 사람이 적어 둔 칸은 덮어쓰지 않음. 실패하면 판독 시도를 1 올리고, 3번 실패하면 확인필요 */
(function () {
  'use strict';

  var MAX_TRIES = 3, LONG = 1300;
  var running = false;

  // 사진 → 긴 변 1300px JPEG(base64)
  async function toBase64(blob) {
    var src;
    try { src = await createImageBitmap(blob); }
    catch (e) {
      src = await new Promise(function (res, rej) {
        var u = URL.createObjectURL(blob), im = new Image();
        im.onload = function () { URL.revokeObjectURL(u); res(im); };
        im.onerror = function () { URL.revokeObjectURL(u); rej(new Error('사진을 열지 못했습니다')); };
        im.src = u;
      });
    }
    var w = src.width, h = src.height, s = Math.min(1, LONG / Math.max(w, h));
    var c = document.createElement('canvas');
    c.width = Math.round(w * s); c.height = Math.round(h * s);
    c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
    var url = c.toDataURL('image/jpeg', 0.85);
    return url.slice(url.indexOf(',') + 1);
  }

  // 카드사 이름을 앱 목록 이름으로 맞춤(인쇄된 이름이 제각각이라)
  var COMPANIES = [[/신한/, '신한카드'], [/삼성/, '삼성카드'], [/현대/, '현대카드'], [/국민|KB/i, 'KB국민카드'], [/롯데/, '롯데카드'],
    [/하나|외환/, '하나카드'], [/우리/, '우리카드'], [/BC|비씨/i, 'BC카드'], [/농협|NH/i, 'NH농협카드'], [/씨티|citi/i, '씨티카드'], [/카카오/, '카카오뱅크카드'], [/토스/, '토스카드']];
  function normCompany(s) {
    if (!s) return '';
    for (var i = 0; i < COMPANIES.length; i++) if (COMPANIES[i][0].test(s)) return COMPANIES[i][1];
    return String(s).slice(0, 20);
  }

  // 카드 번호 끝 4자리가 회사 법인카드(이름 끝 4자리)와 같으면 그 법인카드
  function corpMatch(num, cards) {
    var m = /(\d{4})\D*$/.exec(String(num || ''));
    if (!m) return '';
    var hit = (cards || []).filter(function (c) { var x = /(\d{4})\s*$/.exec(c); return x && x[1] === m[1]; });
    return hit.length === 1 ? hit[0] : '';
  }

  // 판독 결과 → 시트에 쓸 값과 상태. row = 지금 시트 값(rowToObj 결과)
  function decide(res, row, cards) {
    var ch = {}, why = [];
    var date = res.txDate, conf = res.confidence || {};
    if (date && !row.txAt) ch.txAt = date + (res.txTime ? ' ' + res.txTime : '');
    if (ch.txAt) ch.month = date.slice(0, 7);                      // 귀속 월 = 거래일의 달
    if (res.amount && !row.hasAmount) ch.amount = res.amount;
    if (res.merchant && !row.merchant) ch.merchant = res.merchant;
    if (res.address && !row.address) ch.address = res.address;
    if (!row.cardType) {                                           // 사람이 고른 결제 수단은 그대로
      if (res.payMethod === 'cash') { ch.cardType = '현금'; if (!row.card) ch.card = '현금'; }
      else if (res.payMethod === 'card' || res.cardCompany || res.cardNumber) {
        var corp = corpMatch(res.cardNumber, cards);
        if (corp) { ch.cardType = '법인카드'; ch.corpCard = corp; }
        else ch.cardType = '개인카드';
        if (!row.card && res.cardCompany) ch.card = normCompany(res.cardCompany);
      }
    }
    ch.conf = ['tx_date', 'amount', 'merchant', 'address'].map(function (k) { return k + ':' + (conf[k] === 'high' ? 'high' : 'low'); }).join(' ');
    if (!res.isReceipt) why.push('영수증이 아닌 것 같습니다');
    var hasDate = !!(row.txAt || date), hasAmt = !!(row.hasAmount || res.amount);
    if (!hasDate) why.push('거래일을 읽지 못했습니다');
    else if (ch.txAt && conf.tx_date !== 'high') why.push('거래일이 확실하지 않습니다');
    if (!hasAmt) why.push('금액을 읽지 못했습니다');
    else if (ch.amount && conf.amount !== 'high') why.push('금액이 확실하지 않습니다');
    if (res.note && /취소/.test(res.note)) why.push('취소 영수증일 수 있습니다');
    ch.status = why.length ? '확인필요' : '보관중';
    ch.reason = why.join(' · ');
    return ch;
  }

  // 시트에서 지금 줄을 다시 읽고(그 사이 사람이 고쳤을 수 있음) 판독대기일 때만 씀
  async function apply(ws, id, fn) {
    var f = await RSStore.findRow(ws, id);
    if (!f) return null;
    var row = RSStore.parseRow(f.values);
    if (row.status !== '판독대기') return null;
    var ch = fn(row);
    if (!ch) return null;
    ch.updatedAt = RSQueue.localIso(new Date());
    await RSStore.writeCells(ws, f.row, ch);
    return ch;
  }

  // list = 판독대기 영수증들. ctx = { blobOf(it), cards(), onStep(n, total) }
  // 돌려주는 값: { done, need, failed, stop(멈춘 이유 문구) }
  async function run(ws, list, ctx) {
    if (running) return null;
    running = true;
    var out = { done: 0, need: 0, failed: 0, stop: '' };
    try {
      for (var i = 0; i < list.length; i++) {
        var it = list[i];
        if (ctx.onStep) ctx.onStep(i + 1, list.length);
        var res;
        try {
          var blob = (await ctx.blobOf(it)) || await RSStore.download(it.fileId);
          var b64 = await toBase64(blob);
          res = (await RSAuth.authed('/v1/ocr', { image: b64 })).result;
        } catch (e) {
          // 설정·상한·로그인·인터넷 문제는 뒤의 것도 같으므로 멈춤(시도 횟수는 올리지 않음)
          if (e.code === 'NO_KEY' || e.status === 404) { out.stop = 'AI 판독이 아직 준비되지 않았습니다. 직접 입력해도 됩니다'; break; }
          if (e.code === 'DAILY_LIMIT' || e.notApproved || e.needLogin || e.status === 401 || e instanceof TypeError || !navigator.onLine) {
            out.stop = e.message || 'AI 판독을 잠시 멈췄습니다'; break;
          }
          // 그 밖(AI 오류·응답 늦음·사진 문제)은 이 영수증만 시도 횟수를 올림
          console.warn('ocr', it.id, e.code || e.message);
          var tries = (it.tries || 0) + 1;
          await apply(ws, it.id, function () {
            return tries >= MAX_TRIES ? { tries: tries, status: '확인필요', reason: 'AI 판독 실패(' + tries + '번). 직접 입력해 주세요' } : { tries: tries };
          }).catch(function () {});
          out.failed++;
          continue;
        }
        var ch = await apply(ws, it.id, function (row) {
          var c = decide(res, row, ctx.cards());
          c.tries = (row.tries || 0) + 1;
          return c;
        });
        if (ch) { if (ch.status === '보관중') out.done++; else out.need++; if (ctx.onDone) ctx.onDone(it.id); }
      }
    } finally {
      running = false;
    }
    return out;
  }

  window.RSOcr = {
    run: run,
    busy: function () { return running; },
    MAX_TRIES: MAX_TRIES,
    _test: { decide: decide, corpMatch: corpMatch, normCompany: normCompany }
  };
})();
