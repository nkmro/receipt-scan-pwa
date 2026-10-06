/* 업로드 대기열(설계서 "처리 순서")
   1) 폰에 저장(IndexedDB) → 업로드대기
   2) Drive 업로드 → 3) 시트 기록(판독대기) → 5) 폰에는 썸네일만 남김
   - 각 단계가 성공해야 다음으로 감. 실패하면 그 자리에서 멈추고, 앱을 다시 열거나 온라인이 되면 이어서 함
   - 같은 영수증 ID로 재시도하므로 Drive 파일·시트 줄이 두 번 생기지 않음(올리기 전에 먼저 찾아봄)
   - 앱이 열려 있을 때만 돌아감(백그라운드 동기화에 의존하지 않음) */
(function () {
  'use strict';

  var DB = 'rs-receipts', STORE = 'items', VER = 1;
  var dbp = null, running = false, again = false, listeners = [];

  function db() {
    if (dbp) return dbp;
    dbp = new Promise(function (resolve, reject) {
      var r = indexedDB.open(DB, VER);
      r.onupgradeneeded = function () {
        var s = r.result.createObjectStore(STORE, { keyPath: 'id' });
        s.createIndex('email', 'email');
      };
      r.onsuccess = function () { resolve(r.result); };
      r.onerror = function () { dbp = null; reject(r.error); };
    });
    return dbp;
  }

  function tx(mode, fn) {
    return db().then(function (d) {
      return new Promise(function (resolve, reject) {
        var t = d.transaction(STORE, mode), s = t.objectStore(STORE), out;
        Promise.resolve(fn(s)).then(function (v) { out = v; });
        t.oncomplete = function () { resolve(out); };
        t.onerror = function () { reject(t.error); };
        t.onabort = function () { reject(t.error || new Error('abort')); };
      });
    });
  }

  function req(r) { return new Promise(function (res, rej) { r.onsuccess = function () { res(r.result); }; r.onerror = function () { rej(r.error); }; }); }

  function put(item) { return tx('readwrite', function (s) { s.put(item); }); }

  function all(email) {
    return tx('readonly', function (s) { return req(s.index('email').getAll(email)); }).then(function (list) {
      return (list || []).sort(function (a, b) { return a.createdAt < b.createdAt ? -1 : 1; });
    });
  }

  // 한국 시간 그대로 적은 ISO 8601(시트의 촬영일시와 같은 형식)
  function localIso(d) {
    var p = function (n) { return String(n).padStart(2, '0'); };
    var off = -d.getTimezoneOffset(), sign = off >= 0 ? '+' : '-';
    off = Math.abs(off);
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) +
      sign + p(Math.floor(off / 60)) + ':' + p(off % 60);
  }

  function emit() { listeners.forEach(function (f) { try { f(); } catch (e) { /* 무시 */ } }); }

  // 저장: stage = 'upload'(Drive 업로드 전) → 'sheet'(시트 기록 전) → 'done'
  async function add(item) {
    item.stage = 'upload';
    item.tries = 0;
    item.error = '';
    item.createdAt = item.createdAt || new Date().toISOString();
    await put(item);
    emit();
  }

  async function pending(email) {
    var list = await all(email);
    return list.filter(function (x) { return x.stage !== 'done'; });
  }

  // 대기열 처리. 동시에 두 번 돌지 않음
  async function process(ws, email) {
    if (running) { again = true; return; }
    running = true;
    emit();                 // 화면에 "올리는 중" 표시
    var changed = 0;
    try {
      do {
        again = false;
        var list = await pending(email);
        for (var i = 0; i < list.length; i++) {
          var it = list[i];
          try {
            if (it.stage === 'upload') {
              var fid = await RSStore.findUpload(it.id);
              if (!fid) {
                var folder = await RSStore.monthFolder(ws, it.meta.month, email);
                fid = await RSStore.uploadJpeg(folder, it.id, it.blob);
              }
              it.fileId = fid; it.stage = 'sheet'; it.error = '';
              await put(it); emit();
            }
            if (it.stage === 'sheet') {
              if (!(await RSStore.hasReceiptRow(ws, it.id))) {
                await RSStore.appendReceipt(ws, Object.assign({ id: it.id, fileId: it.fileId, updatedAt: localIso(new Date()) }, it.meta));
              }
              it.stage = 'done'; it.error = ''; // 사진은 AI 판독이 끝날 때까지 폰에 둠(release에서 지움)
              it.doneAt = new Date().toISOString();
              await put(it); changed++; emit();
            }
          } catch (e) {
            it.tries = (it.tries || 0) + 1;
            it.error = e && e.message ? e.message : String(e);
            await put(it).catch(function () {});
            emit();
            // 로그인·승인 문제나 네트워크 문제면 뒤의 것도 실패하므로 여기서 멈춤
            if (e && (e.needLogin || e.notApproved || e instanceof TypeError || !navigator.onLine)) throw e;
          }
        }
      } while (again);
    } finally {
      running = false;
      emit();
    }
    return changed;
  }

  // AI 판독이 끝난(또는 7일 지난) 영수증의 사진을 폰에서 지움(썸네일만 남김)
  async function release(id) {
    var it = await tx('readonly', function (s) { return req(s.get(id)); });
    if (it && it.blob && it.stage === 'done') { it.blob = null; await put(it); }
  }
  async function cleanup(email) {
    var old = Date.now() - 7 * 86400000, list = await all(email);
    for (var i = 0; i < list.length; i++) {
      var it = list[i];
      if (it.stage === 'done' && it.blob && Date.parse(it.doneAt || it.createdAt) < old) { it.blob = null; await put(it); }
    }
  }

  window.RSQueue = {
    release: release,
    get: function (id) { return tx('readonly', function (s) { return req(s.get(id)); }); },
    cleanup: cleanup,
    localIso: localIso,
    add: add,
    all: all,
    pending: pending,
    process: process,
    onChange: function (f) { listeners.push(f); },
    busy: function () { return running; }
  };
})();
