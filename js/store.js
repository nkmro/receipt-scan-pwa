/* Google Drive·시트 연결
   - 처음 로그인하면 내 Drive에 "영수증 스캔" 폴더(원본·청구본 하위 폴더)와 "영수증 장부" 시트를 만듦
   - 이미 있으면(다른 기기에서 만든 것 포함) 찾아서 씀. appProperties 표시로 찾으므로 이름을 바꿔도 찾음
   - drive.file 권한이라 앱이 만든 파일만 보임 */
(function () {
  'use strict';

  var DRIVE = 'https://www.googleapis.com/drive/v3/files';
  var SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';
  var FOLDER = 'application/vnd.google-apps.folder';
  var SHEET = 'application/vnd.google-apps.spreadsheet';
  var SCHEMA_VERSION = 7; // 7: AL열(카드 번호, AI가 읽은 *포함 번호) 추가. 6: AK열(법인카드) 추가. // 2: 카드사 열(F) 추가, 3: 카드 구분 열(G) 추가, 4: 맨 오른쪽 W~AH열(회전·구분별 추가 입력) 추가, 5: AI·AJ열(교통수단·운행시간) 추가, Z열 이름 '회의 내용'→'내용'(접대비·회의비 공용)

  // 열 순서는 "데이터·API 스펙" 탭 표 순서(A~V)
  var RECEIPT_HEADERS = ['ID', '유형', '촬영일시', '구분', '상태', '카드사', '카드 구분', '거래일시', '귀속 월', '금액', '가맹점명', '가맹점 주소',
    '내역', '메모', '영수증 폭', '판독 신뢰도', '확인 사유', '판독 시도', '원본 파일 ID', '청구 PDF ID', '청구일시', '앱 수정일시',
    // 4판에서 추가(W~AH): 기존 열은 움직이지 않고 오른쪽에 붙임
    '회전', '출장일', '접대상대방', '내용', '계정', '주유량(L)', '업무내용', '업무용 차량', '출발지', '도착지', '운행거리(km)', '참석자', '교통수단', '운행시간', '법인카드', '카드 번호'];
  var LAST_COL = 'AL';
  // 열 번호(0부터). 상세 화면 저장에서 씀
  var F = { category: 3, status: 4, card: 5, cardType: 6, txAt: 7, month: 8, amount: 9, merchant: 10, address: 11, desc: 12, memo: 13,
    widthMm: 14, conf: 15, reason: 16, tries: 17, pdfId: 19, claimedAt: 20, updatedAt: 21, rot: 22, tripDate: 23, guest: 24, topic: 25, account: 26,
    fuel: 27, work: 28, car: 29, from: 30, to: 31, km: 32, attendees: 33, transport: 34, driveTime: 35, corpCard: 36, cardNo: 37 };
  var DATE_FIELDS = { txAt: 1, tripDate: 1 }; // 시트에서 날짜로 보이게(PC에서 정렬·필터 가능) 입력
  var BUDGET_HEADERS = ['ID', '적용 월', '구분', '유형', '이월 방식', '금액', '메모', '앱 수정일시'];
  var COL = { id: 0, kind: 1, capturedAt: 2, category: 3, status: 4, card: 5, cardType: 6, txAt: 7, month: 8, amount: 9 };

  function wsKey(email) { return 'rs.ws.' + email; }
  function loadWs(email) { try { return JSON.parse(localStorage.getItem(wsKey(email)) || 'null'); } catch (e) { return null; } }
  function saveWs(email, ws) { try { localStorage.setItem(wsKey(email), JSON.stringify(ws)); } catch (e) { /* 무시 */ } }

  async function api(url, opt, retried) {
    opt = opt || {};
    var token = await RSAuth.getToken();
    var headers = Object.assign({ Authorization: 'Bearer ' + token }, opt.headers || {});
    if (opt.json !== undefined) { headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(opt.json); }
    var r = await fetch(url, { method: opt.method || 'GET', headers: headers, body: opt.body });
    if (r.status === 401 && !retried) { RSAuth.invalidate(); return api(url, opt, true); }
    if (!r.ok) {
      var detail = await r.text().catch(function () { return ''; });
      var err = new Error('Google API 오류 ' + r.status);
      err.status = r.status; err.detail = detail.slice(0, 300);
      throw err;
    }
    return r.status === 204 ? null : r.json();
  }

  async function findByRole(role) {
    var q = "appProperties has { key='rsRole' and value='" + role + "' } and trashed=false";
    var d = await api(DRIVE + '?q=' + encodeURIComponent(q) + '&fields=files(id,name,createdTime)&orderBy=createdTime&pageSize=10&spaces=drive');
    return d.files && d.files[0] ? d.files[0].id : null;
  }

  async function create(name, mimeType, role, parent) {
    var meta = { name: name, mimeType: mimeType, appProperties: { rsRole: role } };
    if (parent) meta.parents = [parent];
    var d = await api(DRIVE + '?fields=id', { method: 'POST', json: meta });
    return d.id;
  }

  async function findOrCreate(name, mimeType, role, parent) {
    return (await findByRole(role)) || (await create(name, mimeType, role, parent));
  }

  async function exists(id) {
    try {
      var d = await api(DRIVE + '/' + id + '?fields=id,trashed');
      return d && !d.trashed;
    } catch (e) {
      if (e.status === 404) return false;
      throw e;
    }
  }

  async function initLedger(sheetId) {
    var info = await api(SHEETS + '/' + sheetId + '?fields=sheets.properties');
    var titles = info.sheets.map(function (s) { return s.properties.title; });
    if (titles.indexOf('영수증') >= 0) return; // 이미 준비됨
    var first = info.sheets[0].properties.sheetId;
    await api(SHEETS + '/' + sheetId + ':batchUpdate', {
      method: 'POST', json: { requests: [
        { updateSheetProperties: { properties: { sheetId: first, title: '영수증', gridProperties: { frozenRowCount: 1 } }, fields: 'title,gridProperties.frozenRowCount' } },
        { addSheet: { properties: { title: '예산', gridProperties: { frozenRowCount: 1 } } } },
        { addSheet: { properties: { title: '메타' } } }
      ] }
    });
    await api(SHEETS + '/' + sheetId + '/values:batchUpdate', {
      method: 'POST', json: {
        valueInputOption: 'RAW',
        data: [
          { range: '영수증!A1:V1', values: [RECEIPT_HEADERS.slice(0, 22)] },
          { range: '예산!A1:H1', values: [BUDGET_HEADERS] },
          { range: '메타!A1:B1', values: [['스키마 버전', 3]] } // 나머지 열은 migrate가 붙임
        ]
      }
    });
  }

  // 예전 형식 시트를 새 형식으로 고침(버전마다 열 하나씩 끼워 넣음, 기존 데이터는 오른쪽으로 밀림)
  var MIGRATIONS = [
    { to: 2, index: 5, cell: 'F1', header: '카드사' },
    { to: 3, index: 6, cell: 'G1', header: '카드 구분' }
  ];

  async function migrate(sheetId) {
    var meta = await api(SHEETS + '/' + sheetId + '/values/' + encodeURIComponent('메타!B1') + '?valueRenderOption=UNFORMATTED_VALUE');
    var ver = Number(meta.values && meta.values[0] && meta.values[0][0]) || 1;
    if (ver >= SCHEMA_VERSION) return;
    var info = await api(SHEETS + '/' + sheetId + '?fields=sheets.properties');
    var tab = info.sheets.find(function (s) { return s.properties.title === '영수증'; });
    if (!tab) return;
    if (ver >= 3) { await addTailColumns(sheetId, tab); return; }
    for (var i = 0; i < MIGRATIONS.length; i++) {
      var mg = MIGRATIONS[i];
      if (ver >= mg.to) continue;
      var head = await api(SHEETS + '/' + sheetId + '/values/' + encodeURIComponent('영수증!' + mg.cell));
      var already = head.values && head.values[0] && head.values[0][0] === mg.header;
      if (!already) {
        await api(SHEETS + '/' + sheetId + ':batchUpdate', {
          method: 'POST', json: { requests: [{ insertDimension: {
            range: { sheetId: tab.properties.sheetId, dimension: 'COLUMNS', startIndex: mg.index, endIndex: mg.index + 1 },
            inheritFromBefore: false } }] }
        });
      }
      await api(SHEETS + '/' + sheetId + '/values:batchUpdate', {
        method: 'POST', json: { valueInputOption: 'RAW', data: [
          { range: '영수증!' + mg.cell, values: [[mg.header]] },
          { range: '메타!B1', values: [[mg.to]] }
        ] }
      });
      ver = mg.to;
    }
    await addTailColumns(sheetId, tab);
  }

  // 4판: 맨 오른쪽에 W~AH 열 머리글을 붙임(칸이 모자라면 열을 늘림). 기존 데이터는 그대로
  async function addTailColumns(sheetId, tab) {
    var need = RECEIPT_HEADERS.length;
    var have = (tab.properties.gridProperties || {}).columnCount || 26;
    if (have < need) {
      await api(SHEETS + '/' + sheetId + ':batchUpdate', {
        method: 'POST', json: { requests: [{ appendDimension: { sheetId: tab.properties.sheetId, dimension: 'COLUMNS', length: need - have } }] }
      });
    }
    await api(SHEETS + '/' + sheetId + '/values:batchUpdate', {
      method: 'POST', json: { valueInputOption: 'RAW', data: [
        { range: '영수증!W1:' + LAST_COL + '1', values: [RECEIPT_HEADERS.slice(22)] },
        { range: '메타!B1', values: [[SCHEMA_VERSION]] }
      ] }
    });
  }

  // 로그인 직후 한 번: 폴더·시트 준비
  async function ensureWorkspace(email, onStep) {
    var ws = loadWs(email);
    if (ws && ws.sheetId && await exists(ws.sheetId)) { await migrate(ws.sheetId); return ws; }
    onStep && onStep('Drive에 폴더를 준비하는 중…');
    var root = await findOrCreate('영수증 스캔', FOLDER, 'root');
    var originals = await findOrCreate('원본', FOLDER, 'originals', root);
    var claims = await findOrCreate('청구본', FOLDER, 'claims', root);
    onStep && onStep('영수증 장부 시트를 준비하는 중…');
    var sheetId = await findOrCreate('영수증 장부', SHEET, 'ledger', root);
    await initLedger(sheetId);
    await migrate(sheetId);
    ws = { rootId: root, originalsId: originals, claimsId: claims, sheetId: sheetId };
    saveWs(email, ws);
    return ws;
  }

  // 시트 날짜 칸 → 문자열. PC에서 날짜를 입력하면 시트가 숫자(일련번호)로 줄 수 있음
  function serialToIso(v, monthOnly) {
    if (typeof v !== 'number') return String(v || '');
    var dt = new Date(Date.UTC(1899, 11, 30) + Math.round(v * 86400000));
    var p = function (n) { return String(n).padStart(2, '0'); };
    var d = dt.getUTCFullYear() + '-' + p(dt.getUTCMonth() + 1);
    if (monthOnly) return d;
    return d + '-' + p(dt.getUTCDate()) + 'T' + p(dt.getUTCHours()) + ':' + p(dt.getUTCMinutes()) + ':00';
  }

  // 영수증 탭 전체 읽기 → [{id, category, status, month, amount, …}]
  async function readReceipts(ws) {
    var d = await api(SHEETS + '/' + ws.sheetId + '/values/' + encodeURIComponent('영수증!A2:' + LAST_COL) + '?valueRenderOption=UNFORMATTED_VALUE');
    return (d.values || []).filter(function (r) { return r[COL.id]; }).map(rowToObj);
  }

  function rowToObj(r, i) {
      var amt = r[COL.amount];
      if (typeof amt === 'string') amt = amt.trim() === '' ? NaN : Number(amt.replace(/[^\d.-]/g, ''));
      if (amt === undefined || amt === '') amt = NaN;
      var w = Number(r[14]);
      return {
        id: String(r[COL.id]),
        row: i + 2,                                   // 시트의 줄 번호(2단계 상세 저장에서 씀)
        kind: r[COL.kind] || '영수증',
        capturedAt: serialToIso(r[COL.capturedAt]),
        category: r[COL.category] || '',
        status: r[COL.status] || '',
        card: r[COL.card] || '',
        cardType: r[COL.cardType] || '',
        txAt: serialToIso(r[COL.txAt]),
        month: serialToIso(r[COL.month], true).slice(0, 7),
        amount: isFinite(amt) ? Number(amt) : 0,
        hasAmount: isFinite(amt),
        merchant: String(r[10] || ''),
        desc: String(r[12] || ''),
        memo: String(r[13] || ''),
        widthMm: w > 0 ? w : 80,
        reason: String(r[16] || ''),
        tries: Number(r[17]) || 0,                    // AI 판독 시도 횟수
        fileId: String(r[18] || ''),
        pdfId: String(r[19] || ''),
        claimedAt: serialToIso(r[20]),
        rot: ((Math.round(Number(r[F.rot]) / 90) % 4) + 4) % 4 || 0,   // 회전(0~3 = 0°·90°·180°·270°)
        tripDate: serialToIso(r[F.tripDate]).slice(0, 10),
        guest: String(r[F.guest] || ''),
        topic: String(r[F.topic] || ''),
        account: String(r[F.account] || ''),
        fuel: r[F.fuel] === undefined || r[F.fuel] === '' ? '' : String(r[F.fuel]),
        work: String(r[F.work] || ''),
        car: String(r[F.car] || ''),
        from: String(r[F.from] || ''),
        to: String(r[F.to] || ''),
        km: r[F.km] === undefined || r[F.km] === '' ? '' : String(r[F.km]),
        address: String(r[F.address] || ''),
        attendees: String(r[F.attendees] || ''),
        transport: String(r[F.transport] || ''),
        driveTime: String(r[F.driveTime] || ''),
        corpCard: String(r[F.corpCard] || ''),
        cardNo: String(r[F.cardNo] || '')            // AI가 읽은 카드 번호(*포함)
      };
  }

  // 사진 크기(가로·세로 px). Drive가 아직 계산하지 않았으면 null
  async function imageSize(fileId) {
    var d = await api(DRIVE + '/' + fileId + '?fields=imageMediaMetadata(width,height)');
    var m = d && d.imageMediaMetadata;
    return m && m.width > 0 && m.height > 0 ? { w: m.width, h: m.height } : null;
  }

  // Drive 파일 내용 받기(썸네일 만들 때 씀)
  async function download(fileId) {
    var token = await RSAuth.getToken();
    var r = await fetch(DRIVE + '/' + fileId + '?alt=media', { headers: { Authorization: 'Bearer ' + token } });
    if (r.status === 401) { RSAuth.invalidate(); token = await RSAuth.getToken(); r = await fetch(DRIVE + '/' + fileId + '?alt=media', { headers: { Authorization: 'Bearer ' + token } }); }
    if (!r.ok) { var e = new Error('Google API 오류 ' + r.status); e.status = r.status; throw e; }
    return r.blob();
  }

  // ── 촬영한 영수증 올리기(업로드 대기열이 씀) ──
  var UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';

  // 원본/2026-09 같은 달 폴더. 없으면 만듦(appProperties로 찾으므로 이름을 바꿔도 찾음)
  async function monthFolder(ws, month, email) {
    var key = 'rs.mf.' + email + '.' + month;
    var cached = null;
    try { cached = localStorage.getItem(key); } catch (e) { /* 무시 */ }
    if (cached && await exists(cached)) return cached;
    var q = "appProperties has { key='rsRole' and value='month' } and appProperties has { key='rsMonth' and value='" + month + "' }" +
      " and '" + ws.originalsId + "' in parents and trashed=false";
    var d = await api(DRIVE + '?q=' + encodeURIComponent(q) + '&fields=files(id)&orderBy=createdTime&pageSize=5&spaces=drive');
    var id = d.files && d.files[0] ? d.files[0].id : null;
    if (!id) {
      var r = await api(DRIVE + '?fields=id', { method: 'POST', json: {
        name: month, mimeType: FOLDER, parents: [ws.originalsId], appProperties: { rsRole: 'month', rsMonth: month } } });
      id = r.id;
    }
    try { localStorage.setItem(key, id); } catch (e) { /* 무시 */ }
    return id;
  }

  // 같은 영수증 ID로 이미 올린 파일이 있으면 그 ID(재시도해도 중복으로 올리지 않기 위함)
  async function findUpload(receiptId) {
    var q = "appProperties has { key='rsReceiptId' and value='" + receiptId + "' } and trashed=false";
    var d = await api(DRIVE + '?q=' + encodeURIComponent(q) + '&fields=files(id)&pageSize=1&spaces=drive');
    return d.files && d.files[0] ? d.files[0].id : null;
  }

  async function uploadJpeg(parentId, receiptId, blob) {
    var meta = { name: receiptId + '.jpg', mimeType: 'image/jpeg', parents: [parentId], appProperties: { rsReceiptId: receiptId } };
    var b = 'rs' + Math.random().toString(36).slice(2);
    var body = new Blob([
      '--' + b + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify(meta) + '\r\n',
      '--' + b + '\r\nContent-Type: image/jpeg\r\n\r\n', blob, '\r\n--' + b + '--'
    ]);
    var d = await api(UPLOAD + '?uploadType=multipart&fields=id', { method: 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + b }, body: body });
    return d.id;
  }

  // ── 파일 첨부(PDF 한 건을 영수증처럼 1건으로 등록) ──
  async function uploadPdfFile(parentId, id, blob, name) {
    var meta = { name: name || (id + '.pdf'), mimeType: 'application/pdf', parents: [parentId], appProperties: { rsReceiptId: id, rsRole: 'attach' } };
    var b = 'rs' + Math.random().toString(36).slice(2);
    var body = new Blob([
      '--' + b + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify(meta) + '\r\n',
      '--' + b + '\r\nContent-Type: application/pdf\r\n\r\n', blob, '\r\n--' + b + '--'
    ]);
    var d = await api(UPLOAD + '?uploadType=multipart&fields=id', { method: 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + b }, body: body });
    return d.id;
  }
  // a = {id, category, txDate, amount, cardType, corpCard, desc, memo, fileId, capturedAt, updatedAt}
  async function appendAttachment(ws, a) {
    var row = new Array(RECEIPT_HEADERS.length).fill('');
    row[COL.id] = a.id;
    row[COL.kind] = '첨부';
    row[COL.capturedAt] = a.capturedAt;
    row[COL.category] = a.category;
    row[COL.status] = '보관중';
    row[COL.cardType] = a.cardType || '';
    row[COL.card] = a.card || '';
    row[COL.txAt] = a.txDate;
    row[COL.month] = a.txDate.slice(0, 7);
    row[COL.amount] = a.amount === '' || a.amount == null ? '' : Number(a.amount);
    // 적은 내역은 인트라넷 칸으로: 경비 = 업무내용, 접대비·회의비 = 내용, 출장비 = 내역
    if (a.category === '경비') row[F.work] = a.desc || '';
    else if (a.category === '접대비' || a.category === '회의비') row[F.topic] = a.desc || '';
    else row[12] = a.desc || '';
    row[13] = a.memo || '';
    row[17] = 0;
    row[18] = a.fileId;
    row[21] = a.updatedAt;
    row[F.rot] = 0;
    row[F.tripDate] = a.category === '출장비' ? a.txDate : '';
    row[F.corpCard] = a.cardType === '법인카드' ? (a.corpCard || '') : '';
    // 줄을 붙인 뒤 날짜 칸만 다시 써서 시트가 날짜로 알아보게 함(USER_ENTERED)
    await api(SHEETS + '/' + ws.sheetId + '/values/' + encodeURIComponent('영수증!A1') + ':append?valueInputOption=RAW&insertDataOption=INSERT_ROWS', {
      method: 'POST', json: { values: [row] } });
    var found = await findRow(ws, a.id);
    if (found) await writeCells(ws, found.row, a.category === '출장비' ? { txAt: a.txDate, tripDate: a.txDate } : { txAt: a.txDate });
  }

  async function hasReceiptRow(ws, receiptId) {
    var d = await api(SHEETS + '/' + ws.sheetId + '/values/' + encodeURIComponent('영수증!A2:A'));
    return (d.values || []).some(function (r) { return r[0] === receiptId; });
  }

  // 영수증 탭에 한 줄 추가(열 순서는 RECEIPT_HEADERS)
  async function appendReceipt(ws, r) {
    var row = new Array(RECEIPT_HEADERS.length).fill('');
    row[COL.id] = r.id;
    row[COL.kind] = '영수증';
    row[COL.capturedAt] = r.capturedAt;
    row[COL.category] = r.category;
    row[COL.status] = '판독대기';
    row[COL.card] = '';
    row[COL.cardType] = r.cardType;
    row[COL.month] = r.month;
    row[13] = r.memo || '';          // 메모
    row[14] = r.widthMm;             // 영수증 폭
    row[17] = 0;                     // 판독 시도
    row[18] = r.fileId;              // 원본 파일 ID
    row[21] = r.updatedAt;           // 앱 수정일시
    row[F.rot] = 0;
    row[F.tripDate] = r.tripDate || '';
    await api(SHEETS + '/' + ws.sheetId + '/values/' + encodeURIComponent('영수증!A1') + ':append?valueInputOption=RAW&insertDataOption=INSERT_ROWS', {
      method: 'POST', json: { values: [row] } });
  }

  // ── 청구본 PDF(4단계 4번) ──
  // 청구본/2026-09 같은 달 폴더. 없으면 만듦
  async function claimFolder(ws, month) {
    var q = "appProperties has { key='rsRole' and value='claimMonth' } and appProperties has { key='rsMonth' and value='" + month + "' }" +
      " and '" + ws.claimsId + "' in parents and trashed=false";
    var d = await api(DRIVE + '?q=' + encodeURIComponent(q) + '&fields=files(id)&orderBy=createdTime&pageSize=5&spaces=drive');
    if (d.files && d.files[0]) return d.files[0].id;
    var r = await api(DRIVE + '?fields=id', { method: 'POST', json: {
      name: month, mimeType: FOLDER, parents: [ws.claimsId], appProperties: { rsRole: 'claimMonth', rsMonth: month } } });
    return r.id;
  }

  // 같은 폴더에 같은 이름이 있으면 _2, _3 …을 붙인 이름
  async function freeName(folderId, name) {
    var base = name.replace(/\.pdf$/i, ''), n = 1, cand = name;
    for (;;) {
      var q = "name = '" + cand.replace(/'/g, "\\'") + "' and '" + folderId + "' in parents and trashed=false";
      var d = await api(DRIVE + '?q=' + encodeURIComponent(q) + '&fields=files(id)&pageSize=1&spaces=drive');
      if (!d.files || !d.files.length) return cand;
      n++; cand = base + '_' + n + '.pdf';
    }
  }

  function multipart(meta, blob, type) {
    var b = 'rs' + Math.random().toString(36).slice(2);
    return { boundary: b, body: new Blob([
      '--' + b + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify(meta) + '\r\n',
      '--' + b + '\r\nContent-Type: ' + type + '\r\n\r\n', blob, '\r\n--' + b + '--'
    ]) };
  }

  // 새 PDF 올리기. keepRevisionForever: 나중에 [다시 만들기]로 내용을 바꿔도 이 버전이 Drive 버전 기록에 계속 남음
  async function uploadPdf(folderId, name, blob) {
    var m = multipart({ name: name, mimeType: 'application/pdf', parents: [folderId], appProperties: { rsRole: 'claimPdf' } }, blob, 'application/pdf');
    return api(UPLOAD + '?uploadType=multipart&keepRevisionForever=true&fields=id,name', {
      method: 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + m.boundary }, body: m.body });
  }

  // 출장비: 결재 끝난 지출결의서(갑지)를 앞에 붙인 합본 PDF. 청구 PDF와는 별개 파일(rsGapjiOf = 청구 PDF ID)
  async function uploadMerged(folderId, name, blob, ofId) {
    var m = multipart({ name: name, mimeType: 'application/pdf', parents: [folderId], appProperties: { rsRole: 'gapjiPdf', rsGapjiOf: ofId } }, blob, 'application/pdf');
    return api(UPLOAD + '?uploadType=multipart&keepRevisionForever=true&fields=id,name', {
      method: 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + m.boundary }, body: m.body });
  }
  async function findMerged(ofId) {
    var q = "appProperties has { key='rsGapjiOf' and value='" + ofId + "' } and trashed=false";
    var d = await api(DRIVE + '?q=' + encodeURIComponent(q) + '&fields=files(id,name)&orderBy=createdTime desc&pageSize=1&spaces=drive');
    return d.files && d.files[0] ? d.files[0] : null;
  }

  // 보관중으로 되돌릴 때: 청구 PDF와 그 PDF로 만든 갑지+영수증 합본을 Drive 휴지통으로(30일 뒤 Drive가 자동으로 비움)
  async function trashClaimFiles(pdfId) {
    var ids = [pdfId], failed = 0;
    try {
      var q = "appProperties has { key='rsGapjiOf' and value='" + pdfId + "' } and trashed=false";
      var d = await api(DRIVE + '?q=' + encodeURIComponent(q) + '&fields=files(id)&pageSize=20&spaces=drive');
      (d.files || []).forEach(function (f) { ids.push(f.id); });
    } catch (e) { /* 합본 찾기 실패해도 청구 PDF는 지움 */ }
    for (var i = 0; i < ids.length; i++) {
      try { await api(DRIVE + '/' + ids[i] + '?fields=id', { method: 'PATCH', json: { trashed: true } }); }
      catch (e) { if (e.status !== 404) failed++; }
    }
    try { localStorage.removeItem('rs.merged.' + pdfId); } catch (e) { /* 무시 */ }
    return { trashed: ids.length - failed, failed: failed };
  }

  // [다시 만들기]: 같은 파일(같은 ID·이름)의 내용만 새 PDF로 바꿈
  async function replacePdf(fileId, blob) {
    return api(UPLOAD + '/' + fileId + '?uploadType=media&keepRevisionForever=true&fields=id,name', {
      method: 'PATCH', headers: { 'Content-Type': 'application/pdf' }, body: blob });
  }

  async function fileInfo(fileId) {
    return api(DRIVE + '/' + fileId + '?fields=id,name,size,webViewLink,trashed,parents');
  }

  // 여러 영수증의 상태·청구 PDF ID·청구일시를 한 번에 바꿈. list = [{id, status, pdfId, claimedAt, expect:[허용 상태]}]
  // 시트의 지금 상태가 expect에 없으면(PC에서 바뀜) 그 줄은 건너뛰고 skipped로 돌려줌
  async function setClaimStatus(ws, list, updatedAt) {
    var d = await api(SHEETS + '/' + ws.sheetId + '/values:batchGet?ranges=' + encodeURIComponent('영수증!A2:A') + '&ranges=' + encodeURIComponent('영수증!E2:E'));
    var ids = (d.valueRanges[0].values || []), sts = (d.valueRanges[1].values || []);
    var rowOf = {};
    ids.forEach(function (r, i) { if (r[0]) rowOf[r[0]] = { row: i + 2, status: (sts[i] && sts[i][0]) || '' }; });
    var data = [], skipped = [];
    list.forEach(function (x) {
      var cur = rowOf[x.id];
      if (!cur || (x.expect && x.expect.indexOf(cur.status) < 0)) { skipped.push(x.id); return; }
      data.push({ range: '영수증!E' + cur.row, values: [[x.status]] });
      data.push({ range: '영수증!T' + cur.row + ':V' + cur.row, values: [[x.pdfId, x.claimedAt, updatedAt]] });
    });
    if (data.length) await api(SHEETS + '/' + ws.sheetId + '/values:batchUpdate', { method: 'POST', json: { valueInputOption: 'RAW', data: data } });
    return { skipped: skipped };
  }

  // 영구 삭제: 제외 상태인 영수증만. 시트 줄을 지우고 원본 사진은 Drive 휴지통으로(30일 안에 Drive에서 되살릴 수 있음)
  async function deleteReceipts(ws, ids) {
    var info = await api(SHEETS + '/' + ws.sheetId + '?fields=sheets.properties');
    var tab = info.sheets.find(function (s) { return s.properties.title === '영수증'; });
    if (!tab) throw new Error('시트에 영수증 탭이 없습니다');
    var d = await api(SHEETS + '/' + ws.sheetId + '/values:batchGet?ranges=' + encodeURIComponent('영수증!A2:A') + '&ranges=' + encodeURIComponent('영수증!E2:E') + '&ranges=' + encodeURIComponent('영수증!S2:S'));
    var idv = d.valueRanges[0].values || [], stv = d.valueRanges[1].values || [], fv = d.valueRanges[2].values || [];
    var want = {}; ids.forEach(function (id) { want[id] = 1; });
    var rows = [], files = [], skipped = [], found = {};
    idv.forEach(function (r, i) {
      var id = r[0]; if (!id || !want[id]) return;
      found[id] = 1;
      if (((stv[i] && stv[i][0]) || '') !== '제외') { skipped.push(id); return; }  // PC에서 상태가 바뀌었으면 지우지 않음
      rows.push(i + 2);
      if (fv[i] && fv[i][0]) files.push(String(fv[i][0]));
    });
    ids.forEach(function (id) { if (!found[id]) skipped.push(id); });
    rows.sort(function (a, b) { return b - a; });                                   // 아래 줄부터 지워야 줄 번호가 안 밀림
    if (rows.length) await api(SHEETS + '/' + ws.sheetId + ':batchUpdate', { method: 'POST', json: { requests: rows.map(function (n) {
      return { deleteDimension: { range: { sheetId: tab.properties.sheetId, dimension: 'ROWS', startIndex: n - 1, endIndex: n } } };
    }) } });
    var trashFailed = 0;
    for (var i = 0; i < files.length; i++) {
      try { await api(DRIVE + '/' + files[i] + '?fields=id', { method: 'PATCH', json: { trashed: true } }); } catch (e) { trashFailed++; }
    }
    return { deleted: rows.length, skipped: skipped, trashFailed: trashFailed };
  }

  // ── 상세 화면 저장 ──
  function colName(i) { var s = ''; i++; while (i > 0) { var m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; }

  // 영수증 ID로 지금 줄 번호와 그 줄 값을 찾음(PC에서 줄을 지우거나 정렬해도 맞는 줄에 쓰도록 저장 때마다 찾음)
  async function findRow(ws, id) {
    var d = await api(SHEETS + '/' + ws.sheetId + '/values/' + encodeURIComponent('영수증!A2:A'));
    var list = d.values || [];
    for (var i = 0; i < list.length; i++) if (list[i][0] === id) {
      var n = i + 2;
      var r = await api(SHEETS + '/' + ws.sheetId + '/values/' + encodeURIComponent('영수증!A' + n + ':' + LAST_COL + n) + '?valueRenderOption=UNFORMATTED_VALUE');
      return { row: n, values: (r.values && r.values[0]) || [] };
    }
    return null;
  }

  // 바뀐 칸만 씀. changes = { 필드키: 값 }. 날짜 칸은 시트가 날짜로 알아보게(USER_ENTERED), 나머지는 글자 그대로(RAW)
  async function writeCells(ws, row, changes) {
    var raw = [], dates = [];
    Object.keys(changes).forEach(function (k) {
      if (F[k] === undefined) return;
      var cell = { range: '영수증!' + colName(F[k]) + row, values: [[changes[k]]] };
      (DATE_FIELDS[k] && changes[k] !== '' ? dates : raw).push(cell);
    });
    if (raw.length) await api(SHEETS + '/' + ws.sheetId + '/values:batchUpdate', { method: 'POST', json: { valueInputOption: 'RAW', data: raw } });
    if (dates.length) await api(SHEETS + '/' + ws.sheetId + '/values:batchUpdate', { method: 'POST', json: { valueInputOption: 'USER_ENTERED', data: dates } });
  }

  // ── 내 정보(시트 '설정' 탭): 갑지 머리글에 씀. A열 항목, B열 값. PC에서 B열을 고쳐도 됨 ──
  var SETTING_KEYS = ['사번', '팀명', '사원명', '회사명', '승인자', '차량번호', '회사 차량'];
  async function ensureSettingsTab(ws) {
    var info = await api(SHEETS + '/' + ws.sheetId + '?fields=sheets.properties.title');
    if (info.sheets.some(function (s) { return s.properties.title === '설정'; })) return;
    await api(SHEETS + '/' + ws.sheetId + ':batchUpdate', { method: 'POST', json: { requests: [{ addSheet: { properties: { title: '설정' } } }] } });
    await api(SHEETS + '/' + ws.sheetId + '/values:batchUpdate', { method: 'POST', json: { valueInputOption: 'RAW', data: [
      { range: '설정!A1:C1', values: [['항목', '값', '설명']] },
      { range: '설정!A2:A' + (SETTING_KEYS.length + 1), values: SETTING_KEYS.map(function (k) { return [k]; }) },
      { range: '설정!C2:C' + (SETTING_KEYS.length + 1), values: [['갑지에 그대로 들어갑니다 (예: 2-027)'], ['예: 동부지역'], ['예: 홍길동'], ['예: 엔케이엠알오'], ['경비 갑지 승인자'],
        ['예: 183허5450'], ['예 = 회사 차량 / 아니오 = 개인 차량']] }
    ] } });
  }
  async function readSettings(ws) {
    var d;
    try { d = await api(SHEETS + '/' + ws.sheetId + '/values/' + encodeURIComponent('설정!A2:B30')); }
    catch (e) { if (e.status !== 400) throw e; await ensureSettingsTab(ws); return {}; }
    var o = {};
    (d.values || []).forEach(function (r) { if (r[0]) o[String(r[0]).trim()] = String(r[1] == null ? '' : r[1]).trim(); });
    return o;
  }
  // 항목 이름으로 줄을 찾아 B열만 고침(없는 항목은 아래에 붙임)
  async function writeSettings(ws, obj) {
    await ensureSettingsTab(ws);
    var d = await api(SHEETS + '/' + ws.sheetId + '/values/' + encodeURIComponent('설정!A2:A30'));
    var rows = (d.values || []).map(function (r) { return String(r[0] || '').trim(); });
    var data = [];
    Object.keys(obj).forEach(function (k) {
      var i = rows.indexOf(k);
      if (i < 0) { rows.push(k); i = rows.length - 1; data.push({ range: '설정!A' + (i + 2), values: [[k]] }); }
      data.push({ range: '설정!B' + (i + 2), values: [[obj[k] == null ? '' : String(obj[k])]] });
    });
    if (data.length) await api(SHEETS + '/' + ws.sheetId + '/values:batchUpdate', { method: 'POST', json: { valueInputOption: 'RAW', data: data } });
  }

  // ── 예산(시트 '예산' 탭). 유형: 기본(적용 월부터 계속) · 이월(그 달만) · 추가(그 달만, 메모=기안 내용) ──
  async function ensureBudgetTab(ws) {
    var info = await api(SHEETS + '/' + ws.sheetId + '?fields=sheets.properties.title');
    if (info.sheets.some(function (s) { return s.properties.title === '예산'; })) return;
    await api(SHEETS + '/' + ws.sheetId + ':batchUpdate', { method: 'POST', json: { requests: [{ addSheet: { properties: { title: '예산', gridProperties: { frozenRowCount: 1 } } } }] } });
    await api(SHEETS + '/' + ws.sheetId + '/values:batchUpdate', { method: 'POST', json: { valueInputOption: 'RAW', data: [{ range: '예산!A1:H1', values: [BUDGET_HEADERS] }] } });
  }
  function budgetMonth(v) {
    if (typeof v === 'number') return serialToIso(v, true);
    var m = String(v || '').trim().match(/^(\d{4})[-.\/년\s]*(\d{1,2})/);
    return m ? m[1] + '-' + m[2].padStart(2, '0') : '';
  }
  async function readBudgets(ws) {
    var d;
    try { d = await api(SHEETS + '/' + ws.sheetId + '/values/' + encodeURIComponent('예산!A2:H1000') + '?valueRenderOption=UNFORMATTED_VALUE'); }
    catch (e) { if (e.status !== 400) throw e; await ensureBudgetTab(ws); return []; }
    return (d.values || []).map(function (r) {
      var a = r[5];
      if (typeof a === 'string') a = Number(a.replace(/[^\d.-]/g, ''));
      return { id: String(r[0] || ''), month: budgetMonth(r[1]), category: String(r[2] || '').trim(), type: String(r[3] || '').trim(),
        amount: isFinite(a) ? Number(a) : 0, memo: String(r[6] || ''), updatedAt: String(r[7] || '') };
    }).filter(function (b) { return b.month && b.category && b.type; });
  }
  // 예산 탭 전체를 목록으로 다시 씀(내 장부라 동시에 고치는 사람이 없음)
  async function saveBudgets(ws, list) {
    await ensureBudgetTab(ws);
    var nowIso = new Date().toISOString().slice(0, 19).replace('T', ' ');
    var rows = list.map(function (b) { return [b.id, b.month, b.category, b.type, '', b.amount, b.memo || '', b.updatedAt || nowIso]; });
    await api(SHEETS + '/' + ws.sheetId + '/values/' + encodeURIComponent('예산!A2:H1000') + ':clear', { method: 'POST', json: {} });
    if (rows.length) await api(SHEETS + '/' + ws.sheetId + '/values/' + encodeURIComponent('예산!A2:H' + (rows.length + 1)) + '?valueInputOption=RAW', { method: 'PUT', json: { values: rows } });
  }

  // ── 카드 기억(시트 '카드' 탭): AI가 읽은 카드 번호 → 사용자가 고른 결제 수단·카드사·법인카드 ──
  // 처음 보는 카드는 사용자가 상세에서 고르고, 그 선택을 여기에 적어 두었다가 다음 판독 때 자동으로 채움
  var CARD_HEADERS = ['카드 번호', '결제 수단', '카드사', '법인카드', '수정일시'];
  var CARD_AMBIG = '(여러 장)';   // 같은 번호로 찍히는 법인카드가 여러 장일 때
  function cardKey(num) { var k = String(num || '').replace(/[^\d*]/g, ''); return (k.match(/\d/g) || []).length >= 4 ? k : ''; }
  async function ensureCardTab(ws) {
    var info = await api(SHEETS + '/' + ws.sheetId + '?fields=sheets.properties.title');
    if (info.sheets.some(function (s) { return s.properties.title === '카드'; })) return;
    await api(SHEETS + '/' + ws.sheetId + ':batchUpdate', { method: 'POST', json: { requests: [{ addSheet: { properties: { title: '카드', gridProperties: { frozenRowCount: 1 } } } }] } });
    await api(SHEETS + '/' + ws.sheetId + '/values:batchUpdate', { method: 'POST', json: { valueInputOption: 'RAW', data: [{ range: '카드!A1:E1', values: [CARD_HEADERS] }] } });
  }
  async function readCards(ws) {
    var d;
    try { d = await api(SHEETS + '/' + ws.sheetId + '/values/' + encodeURIComponent('카드!A2:E500')); }
    catch (e) { if (e.status !== 400) throw e; await ensureCardTab(ws); return {}; }
    var o = {};
    (d.values || []).forEach(function (r) {
      var k = cardKey(r[0]);
      if (k) o[k] = { type: String(r[1] || '').trim(), card: String(r[2] || '').trim(), corpCard: String(r[3] || '').trim() };
    });
    return o;
  }
  // 한 줄 고치거나 추가. e = {type, card, corpCard}
  async function writeCard(ws, key, e) {
    await ensureCardTab(ws);
    var d = await api(SHEETS + '/' + ws.sheetId + '/values/' + encodeURIComponent('카드!A2:A500'));
    var rows = (d.values || []).map(function (r) { return cardKey(r[0]); });
    var i = rows.indexOf(key), n = (i < 0 ? rows.length : i) + 2;
    var nowIso = new Date().toISOString().slice(0, 19).replace('T', ' ');
    await api(SHEETS + '/' + ws.sheetId + '/values/' + encodeURIComponent('카드!A' + n + ':E' + n) + '?valueInputOption=RAW', {
      method: 'PUT', json: { values: [[key, e.type, e.card || '', e.corpCard || '', nowIso]] } });
  }

  window.RSStore = {
    readCards: readCards,
    writeCard: writeCard,
    cardKey: cardKey,
    CARD_AMBIG: CARD_AMBIG,
    monthFolder: monthFolder,
    findUpload: findUpload,
    uploadJpeg: uploadJpeg,
    hasReceiptRow: hasReceiptRow,
    appendReceipt: appendReceipt,
    ensureWorkspace: ensureWorkspace,
    readReceipts: readReceipts,
    download: download,
    claimFolder: claimFolder,
    freeName: freeName,
    uploadPdf: uploadPdf,
    replacePdf: replacePdf,
    fileInfo: fileInfo,
    setClaimStatus: setClaimStatus,
    imageSize: imageSize,
    findRow: findRow,
    readSettings: readSettings,
    uploadPdfFile: uploadPdfFile,
    uploadMerged: uploadMerged,
    findMerged: findMerged,
    appendAttachment: appendAttachment,
    deleteReceipts: deleteReceipts,
    writeSettings: writeSettings,
    trashClaimFiles: trashClaimFiles,
    readBudgets: readBudgets,
    saveBudgets: saveBudgets,
    SETTING_KEYS: SETTING_KEYS,
    writeCells: writeCells,
    parseRow: function (r) { return rowToObj(r, 0); },
    FIELDS: F,
    workspace: loadWs,
    sheetUrl: function (ws) { return 'https://docs.google.com/spreadsheets/d/' + ws.sheetId + '/edit'; },
    folderUrl: function (ws) { return 'https://drive.google.com/drive/folders/' + ws.rootId; }
  };
})();
