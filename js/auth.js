/* Google 로그인 (Authorization Code 흐름, 설계서 토큰 흐름 (c))
   1) 버튼을 누르면 Google 동의 팝업 → code
   2) 중계 서버가 code를 access token + id token + refresh token으로 교환
   3) refresh token은 이 기기에만 저장, access token은 메모리에만
   4) access token이 만료되면 refresh token을 중계 서버로 보내 새로 받음
   5) 관리자 승인이 안 된 계정은 서버가 403 NOT_APPROVED를 돌려줌 → 승인 대기 화면 */
(function () {
  'use strict';
  var CFG = window.RS_CONFIG;
  var KEY = 'rs.auth';
  var DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

  var access = null;      // { token, exp }
  var info = { idToken: null, isAdmin: false };  // 관리자 화면용(메모리에만)
  var inflight = null;    // 동시에 여러 번 갱신하지 않도록

  function load() {
    try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { return null; }
  }
  function save(v) {
    try { v ? localStorage.setItem(KEY, JSON.stringify(v)) : localStorage.removeItem(KEY); } catch (e) { /* 저장소 사용 불가 */ }
  }

  function NeedLogin(msg) { var e = new Error(msg || '로그인이 필요합니다'); e.needLogin = true; return e; }
  function NotApproved(d) {
    var e = new Error(d.message || '관리자 승인이 필요합니다');
    e.notApproved = true; e.approvalStatus = d.status || 'pending'; e.email = d.email;
    e.name = d.name || ''; e.googleName = d.googleName || '';
    return e;
  }

  async function relay(path, body, opt) {
    opt = opt || {};
    if (!CFG.relayUrl) throw new Error('중계 서버 주소가 설정되지 않았습니다');
    var headers = { 'Content-Type': 'application/json' };
    if (opt.idToken) headers.Authorization = 'Bearer ' + opt.idToken;
    var r = await fetch(CFG.relayUrl + path, {
      method: opt.method || 'POST',
      headers: headers,
      body: (opt.method || 'POST') === 'GET' ? undefined : JSON.stringify(body || {})
    });
    var data = await r.json().catch(function () { return {}; });
    if (!r.ok) {
      var e = data.error || {};
      var err = e.code === 'NOT_APPROVED' ? NotApproved(e) : new Error(e.message || ('서버 오류 ' + r.status));
      err.status = r.status;
      err.code = e.code;
      err.refreshToken = e.refreshToken;
      throw err;
    }
    return data;
  }

  function setAccess(d) {
    access = { token: d.accessToken, exp: Date.now() + (Number(d.expiresIn || 3600) - 60) * 1000 };
    info = { idToken: d.idToken || null, isAdmin: !!d.isAdmin };
    if (Array.isArray(d.corpCards)) { try { localStorage.setItem(CARDS_KEY, JSON.stringify(d.corpCards)); } catch (e) { /* 무시 */ } }
  }

  // 회사 법인카드 목록(관리자가 바꿈). 서버에서 받기 전에는 처음 받은 5장
  var CARDS_KEY = 'rs.corpCards';
  var DEFAULT_CARDS = ['NK하나9798', 'NK하나6781', 'NK하나0846', 'NK하나0047', 'NK하나5285'];
  function corpCards() {
    try { var v = JSON.parse(localStorage.getItem(CARDS_KEY) || 'null'); if (Array.isArray(v)) return v; } catch (e) { /* 무시 */ }
    return DEFAULT_CARDS.slice();
  }
  async function saveCards(list) {
    var d = await admin('/v1/admin/cards', { cards: list });
    try { localStorage.setItem(CARDS_KEY, JSON.stringify(d.cards)); } catch (e) { /* 무시 */ }
    return d.cards;
  }

  function waitForGis() {
    return new Promise(function (resolve, reject) {
      var n = 0;
      (function check() {
        if (window.google && google.accounts && google.accounts.oauth2) return resolve();
        if (++n > 100) return reject(new Error('Google 로그인 스크립트를 불러오지 못했습니다'));
        setTimeout(check, 100);
      })();
    });
  }

  // 반드시 버튼 클릭 안에서 호출 (팝업 차단 방지)
  function login() {
    return new Promise(function (resolve, reject) {
      if (!(window.google && google.accounts && google.accounts.oauth2)) {
        return reject(new Error('Google 로그인 준비 중입니다. 잠시 후 다시 눌러 주세요'));
      }
      var prev = load();
      var client = google.accounts.oauth2.initCodeClient({
        client_id: CFG.googleClientId,
        scope: CFG.scopes,
        ux_mode: 'popup',
        login_hint: prev && prev.email ? prev.email : undefined,
        callback: async function (resp) {
          if (resp.error) return reject(new Error('로그인이 취소되었습니다'));
          if (!google.accounts.oauth2.hasGrantedAllScopes(resp, DRIVE_SCOPE)) {
            return reject(new Error('Google Drive 권한에 체크해야 앱을 쓸 수 있습니다. 다시 로그인해 주세요'));
          }
          try {
            var d;
            try {
              d = await relay('/v1/auth/exchange', { code: resp.code });
            } catch (e) {
              if (e.notApproved) {
                // 승인 전: refresh token만 기기에 보관해 두었다가 [다시 확인] 때 씀
                var rt = e.refreshToken || (prev && prev.email === e.email ? prev.refreshToken : null);
                save({ email: e.email, refreshToken: rt, approved: false, name: e.name });
              }
              throw e;
            }
            var refreshToken = d.refreshToken || (prev && prev.email === d.email ? prev.refreshToken : null);
            if (!refreshToken) {
              // 예전에 동의한 적이 있어 refresh token이 다시 나오지 않은 경우: 권한을 비우고 다시 받게 함
              await relay('/v1/auth/revoke', { token: d.accessToken }).catch(function () {});
              return reject(new Error('로그인 정보를 새로 받아야 합니다. [Google로 로그인]을 한 번 더 눌러 주세요'));
            }
            save({ email: d.email, refreshToken: refreshToken, approved: true, name: d.name || '' });
            setAccess(d);
            resolve({ email: d.email });
          } catch (e) { reject(e); }
        },
        error_callback: function (e) {
          reject(new Error(e && e.type === 'popup_closed' ? '로그인 창이 닫혔습니다' : '로그인 창을 열지 못했습니다'));
        }
      });
      client.requestCode();
    });
  }

  async function getToken() {
    if (access && Date.now() < access.exp) return access.token;
    var s = load();
    if (!s || !s.refreshToken) throw NeedLogin();
    if (!inflight) {
      // 승인 대기 중이어도 서버에 다시 물어봄(그 사이 승인됐을 수 있음)
      inflight = relay('/v1/auth/refresh', { refreshToken: s.refreshToken })
        .then(function (d) { setAccess(d); s.approved = true; if (d.name !== undefined) s.name = d.name; save(s); return access.token; })
        .catch(function (e) {
          if (e.status === 401) { save(null); access = null; throw NeedLogin('로그인이 만료되었습니다. 다시 로그인해 주세요'); }
          if (e.notApproved) { access = null; s.approved = false; s.name = e.name; save(s); }
          throw e;
        })
        .finally(function () { inflight = null; });
    }
    return inflight;
  }

  async function logout() {
    var s = load();
    save(null);
    access = null;
    info = { idToken: null, isAdmin: false };
    if (s && s.refreshToken) await relay('/v1/auth/revoke', { token: s.refreshToken }).catch(function () {});
  }

  // 내 표시 이름 저장(승인 대기 중에도 가능: refresh token으로 본인 확인)
  async function setName(name) {
    var s = load();
    if (!s || !s.refreshToken) throw NeedLogin();
    var d = await relay('/v1/profile/name', { refreshToken: s.refreshToken, name: name });
    s.name = d.name; save(s);
    return d.name;
  }

  // 관리자 전용 서버 호출(본인 확인용 id token을 함께 보냄)
  async function admin(path, body) {
    await getToken();
    if (!info.idToken) { access = null; await getToken(); }
    return relay(path, body, { method: body === undefined ? 'GET' : 'POST', idToken: info.idToken });
  }

  // 승인된 사용자용 서버 호출(id token으로 본인 확인). 토큰이 만료됐으면 한 번 새로 받아 다시 보냄
  async function authed(path, body) {
    await getToken();
    if (!info.idToken) { access = null; await getToken(); }
    try { return await relay(path, body, { idToken: info.idToken }); }
    catch (e) {
      if (e.status !== 401) throw e;
      access = null; await getToken();
      return relay(path, body, { idToken: info.idToken });
    }
  }

  window.RSAuth = {
    authed: authed,
    ready: waitForGis,
    login: login,
    logout: logout,
    getToken: getToken,
    admin: admin,
    setName: setName,
    corpCards: corpCards,
    saveCards: saveCards,
    isAdmin: function () { return info.isAdmin; },
    user: function () { var s = load(); return s ? { email: s.email, approved: s.approved !== false, name: s.name || '' } : null; },
    invalidate: function () { access = null; }
  };
})();
