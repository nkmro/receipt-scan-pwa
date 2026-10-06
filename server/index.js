// 영수증 스캔 중계 서버 (Cloud Run 함수, 진입점 relay)
// 하는 일
//   1) Google 로그인: code → 토큰 교환, refresh token으로 새 토큰 받기
//   2) 앱 사용 승인: 관리자가 승인한 계정만 토큰을 받음(Firestore users 컬렉션)
//   3) 관리자 화면용: 사용자 목록·승인·거절·사용 중지
//   4) 이름: Google 이름을 받아 두고, 직원이 직접 고친 이름(예: 홍길동 대리)을 표시 이름으로 씀
//   5) 법인카드 목록: 관리자가 앱에서 고치고(POST /v1/admin/cards), 모든 직원은 로그인·토큰 갱신 때 함께 받음
//   7) 백업: GET /v1/admin/backup (관리자만) — 사용자 승인 목록·법인카드 목록을 JSON으로 돌려줌
//   6) AI 판독: POST /v1/ocr (승인된 계정만, 계정별 하루 상한). 사진은 DeepSeek에 보내기만 하고 저장하지 않음
//
// 환경변수
//   GOOGLE_CLIENT_ID      OAuth 클라이언트 ID (공개값)
//   GOOGLE_CLIENT_SECRET  OAuth 클라이언트 보안 비밀 (Secret Manager에서 주입)
//   ADMIN_EMAILS          관리자 Gmail(쉼표 구분). 관리자는 자동 승인
//   ALLOWED_ORIGINS       쉼표 구분. 기본값 https://nkmro.github.io
//   DEEPSEEK_API_KEY      DeepSeek API 키 (Secret Manager에서 주입)
//   DEEPSEEK_MODEL        기본값 deepseek-flash
//   OCR_DAILY_LIMIT       계정별 하루 판독 상한. 기본값 300
//
// 서버는 토큰을 저장하지 않습니다. refresh token은 사용자 기기에만 있고,
// 새 access token이 필요할 때 앱이 이 서버에 보내 교환합니다(교환에 client_secret이 필요하기 때문).
// 승인되지 않은 계정은 refresh token만 받고 access token은 받지 못합니다.
// 나중에 승인되면 앱이 [다시 확인]으로 refresh를 불러 바로 들어갑니다(로그인 창을 다시 띄우지 않음).

'use strict';

const http = require('http');
const { OAuth2Client } = require('google-auth-library');
const { Firestore, FieldValue } = require('@google-cloud/firestore');

const PORT = Number(process.env.PORT || 8080);
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://nkmro.github.io')
  .split(',').map(s => s.trim()).filter(Boolean);
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
const MAX_BODY = 64 * 1024;
const OCR_MAX_BODY = 4 * 1024 * 1024;   // 영수증 사진(약 1300px JPEG, base64) 1장
const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY || '';
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-flash';
const OCR_DAILY_LIMIT = Number(process.env.OCR_DAILY_LIMIT || 300);   // 계정별 하루 판독 상한
const STATUSES = ['pending', 'approved', 'rejected', 'disabled'];
const NAME_MAX = 30;

const verifier = new OAuth2Client(CLIENT_ID);
let db = null;
function firestore() { if (!db) db = new Firestore(); return db; }
const users = () => firestore().collection('users');
const configDoc = () => firestore().collection('config').doc('corpCards');

// 법인카드 목록(관리자가 앱에서 바꿈). 문서가 없으면 처음 받은 5장을 기본으로 씀
const DEFAULT_CARDS = ['NK하나9798', 'NK하나6781', 'NK하나0846', 'NK하나0047', 'NK하나5285'];
const CARD_MAX = 30, CARD_LEN = 30;
let cardCache = null, cardAt = 0;
async function getCards() {
  if (cardCache && Date.now() - cardAt < 60000) return cardCache;
  try {
    const snap = await configDoc().get();
    cardCache = snap.exists && Array.isArray(snap.data().cards) ? snap.data().cards : DEFAULT_CARDS.slice();
    cardAt = Date.now();
  } catch (e) { console.warn('cards read failed', e && e.message); return cardCache || DEFAULT_CARDS.slice(); }
  return cardCache;
}

function isAdmin(email) { return ADMIN_EMAILS.includes(email); }

function cors(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    res.setHeader('Access-Control-Max-Age', '3600');
  }
}

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function fail(res, status, code, message, extra) {
  send(res, status, { error: Object.assign({ code, message }, extra || {}) });
}

function readJson(req, limit) {
  limit = limit || MAX_BODY;
  // Cloud Run 함수(functions-framework)는 JSON 본문을 미리 읽어 req.body에 넣어 줌
  if (req.body !== undefined && !Buffer.isBuffer(req.body)) {
    return Promise.resolve(req.body && typeof req.body === 'object' ? req.body : {});
  }
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch (e) { reject(Object.assign(new Error('bad json'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

async function googleToken(params) {
  const body = new URLSearchParams(Object.assign({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET }, params));
  const r = await fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
}

// id token 검증 → { email, name }
async function identityFromIdToken(idToken) {
  const ticket = await verifier.verifyIdToken({ idToken, audience: CLIENT_ID });
  const p = ticket.getPayload();
  if (!p || !p.email || p.email_verified !== true) throw new Error('email not verified');
  return { email: p.email.toLowerCase(), name: p.name || '' };
}

// id token이 없을 때 access token으로 이메일 확인
async function identityFromAccessToken(accessToken) {
  const r = await fetch(USERINFO_URL, { headers: { Authorization: 'Bearer ' + accessToken } });
  if (!r.ok) throw new Error('userinfo failed');
  const p = await r.json();
  if (!p.email || p.email_verified !== true) throw new Error('email not verified');
  return { email: p.email.toLowerCase(), name: p.name || '' };
}

// 승인 상태 확인. 처음 보는 계정이면 "승인 대기"로 등록. 관리자는 자동 승인
// 돌려주는 값: { status, name(표시 이름), googleName }
async function approvalOf(ident) {
  const ref = users().doc(ident.email);
  const snap = await ref.get();
  if (!snap.exists) {
    const status = isAdmin(ident.email) ? 'approved' : 'pending';
    await ref.set({ email: ident.email, name: ident.name, googleName: ident.name, status,
      requestedAt: FieldValue.serverTimestamp(), lastSeenAt: FieldValue.serverTimestamp(),
      decidedAt: status === 'approved' ? FieldValue.serverTimestamp() : null, decidedBy: status === 'approved' ? 'auto(admin)' : null });
    return { status, name: ident.name, googleName: ident.name };
  }
  const d = snap.data();
  const patch = { lastSeenAt: FieldValue.serverTimestamp() };
  // Google 이름은 받을 때마다 갱신. 표시 이름이 비어 있을 때만 Google 이름으로 채움(직원이 고친 이름은 유지)
  if (ident.name) patch.googleName = ident.name;
  const name = d.name || ident.name || '';
  if (!d.name && ident.name) patch.name = ident.name;
  let status = d.status || 'pending';
  if (isAdmin(ident.email) && status !== 'approved') {
    status = 'approved';
    Object.assign(patch, { status, decidedAt: FieldValue.serverTimestamp(), decidedBy: 'auto(admin)' });
  }
  await ref.update(patch).catch(e => console.warn('user update failed', e && e.message));
  return { status, name, googleName: ident.name || d.googleName || '' };
}

const STATUS_MESSAGE = {
  pending: '관리자 승인을 기다리고 있습니다',
  rejected: '관리자가 사용을 승인하지 않았습니다',
  disabled: '관리자가 사용을 중지했습니다'
};

function tokenReply(data, ident, ap, cards) {
  const out = {
    accessToken: data.access_token,
    expiresIn: data.expires_in,
    scope: data.scope,
    idToken: data.id_token || null,
    email: ident.email,
    status: ap.status,
    name: ap.name,
    googleName: ap.googleName,
    isAdmin: isAdmin(ident.email),
    corpCards: cards || []
  };
  if (data.refresh_token) out.refreshToken = data.refresh_token;
  return out;
}

function notApproved(res, ident, ap, refreshToken) {
  const status = ap.status;
  const extra = { email: ident.email, status, name: ap.name, googleName: ap.googleName };
  if (refreshToken) extra.refreshToken = refreshToken; // 승인 후 [다시 확인]용. 이것만으로는 Drive를 쓸 수 없음
  return fail(res, 403, 'NOT_APPROVED', STATUS_MESSAGE[status] || '사용 승인이 필요합니다', extra);
}

// POST /v1/auth/exchange  {code}
async function exchange(req, res) {
  const { code } = await readJson(req);
  if (typeof code !== 'string' || !code) return fail(res, 400, 'BAD_REQUEST', 'code가 없습니다');
  // GIS 코드 모델(팝업)은 redirect_uri로 'postmessage'를 씁니다
  const t = await googleToken({ code, grant_type: 'authorization_code', redirect_uri: 'postmessage' });
  if (!t.ok) {
    console.warn('exchange failed', t.status, t.data && t.data.error);
    return fail(res, 401, 'INVALID_GRANT', '로그인 코드를 교환하지 못했습니다');
  }
  if (!t.data.id_token) return fail(res, 401, 'NO_ID_TOKEN', 'openid 권한이 없습니다');
  const ident = await identityFromIdToken(t.data.id_token);
  const ap = await approvalOf(ident);
  if (ap.status !== 'approved') return notApproved(res, ident, ap, t.data.refresh_token);
  send(res, 200, tokenReply(t.data, ident, ap, await getCards()));
}

// POST /v1/auth/refresh  {refreshToken}
async function refresh(req, res) {
  const { refreshToken } = await readJson(req);
  if (typeof refreshToken !== 'string' || !refreshToken) return fail(res, 400, 'BAD_REQUEST', 'refreshToken이 없습니다');
  const t = await googleToken({ refresh_token: refreshToken, grant_type: 'refresh_token' });
  if (!t.ok) {
    // invalid_grant = 사용자가 권한을 철회했거나 토큰이 만료됨 → 앱이 다시 로그인
    return fail(res, 401, 'REAUTH_REQUIRED', '다시 로그인해 주세요');
  }
  let ident;
  try {
    ident = t.data.id_token ? await identityFromIdToken(t.data.id_token) : await identityFromAccessToken(t.data.access_token);
  } catch (e) {
    return fail(res, 401, 'REAUTH_REQUIRED', '다시 로그인해 주세요');
  }
  const ap = await approvalOf(ident);
  if (ap.status !== 'approved') return notApproved(res, ident, ap);
  send(res, 200, tokenReply(t.data, ident, ap, await getCards()));
}

// refresh token으로 본인 확인(승인 대기 중인 사람도 가능). 실패하면 null
async function identityFromRefresh(refreshToken) {
  if (typeof refreshToken !== 'string' || !refreshToken) return null;
  const t = await googleToken({ refresh_token: refreshToken, grant_type: 'refresh_token' });
  if (!t.ok) return null;
  try {
    return t.data.id_token ? await identityFromIdToken(t.data.id_token) : await identityFromAccessToken(t.data.access_token);
  } catch (e) { return null; }
}

function cleanName(v) {
  return String(v == null ? '' : v).replace(/[\u0000-\u001f<>]/g, '').replace(/\s+/g, ' ').trim();
}

// POST /v1/profile/name  {refreshToken, name}  (본인 표시 이름 저장. 승인 대기 중에도 가능)
async function setMyName(req, res) {
  const { refreshToken, name } = await readJson(req);
  const n = cleanName(name);
  if (!n || n.length > NAME_MAX) return fail(res, 400, 'BAD_NAME', '이름은 1~' + NAME_MAX + '자로 적어 주세요');
  const ident = await identityFromRefresh(refreshToken);
  if (!ident) return fail(res, 401, 'REAUTH_REQUIRED', '다시 로그인해 주세요');
  await approvalOf(ident); // 문서가 없으면 만들어 둠
  await users().doc(ident.email).update({ name: n, nameUpdatedAt: FieldValue.serverTimestamp() });
  send(res, 200, { ok: true, email: ident.email, name: n });
}

// POST /v1/auth/revoke  {token}  (로그아웃)
async function revoke(req, res) {
  const { token } = await readJson(req);
  if (typeof token !== 'string' || !token) return fail(res, 400, 'BAD_REQUEST', 'token이 없습니다');
  await fetch(REVOKE_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token }) }).catch(() => {});
  send(res, 200, { ok: true });
}

// 관리자 확인: Authorization: Bearer <id token>
async function requireAdmin(req, res) {
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) { fail(res, 401, 'INVALID_TOKEN', '다시 로그인해 주세요'); return null; }
  let ident;
  try { ident = await identityFromIdToken(m[1]); } catch (e) { fail(res, 401, 'INVALID_TOKEN', '다시 로그인해 주세요'); return null; }
  if (!isAdmin(ident.email)) { fail(res, 403, 'NOT_ADMIN', '관리자만 쓸 수 있습니다'); return null; }
  return ident;
}

function ts(v) { return v && typeof v.toDate === 'function' ? v.toDate().toISOString() : null; }

// GET /v1/admin/users
async function adminList(req, res) {
  if (!(await requireAdmin(req, res))) return;
  const snap = await users().get();
  const list = snap.docs.map(d => {
    const x = d.data();
    return { email: x.email || d.id, name: x.name || '', googleName: x.googleName || '', status: x.status || 'pending',
      requestedAt: ts(x.requestedAt), decidedAt: ts(x.decidedAt), lastSeenAt: ts(x.lastSeenAt), isAdmin: isAdmin(x.email || d.id) };
  });
  const order = { pending: 0, approved: 1, disabled: 2, rejected: 3 };
  list.sort((a, b) => (order[a.status] - order[b.status]) || String(b.requestedAt).localeCompare(String(a.requestedAt)));
  send(res, 200, { users: list });
}

// POST /v1/admin/users/status  {email, status}
async function adminSetStatus(req, res) {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { email, status } = await readJson(req);
  const target = String(email || '').trim().toLowerCase();
  if (!target || !STATUSES.includes(status) || status === 'pending') return fail(res, 400, 'BAD_REQUEST', '요청 형식 오류');
  if (isAdmin(target)) return fail(res, 400, 'BAD_REQUEST', '관리자 계정은 바꿀 수 없습니다');
  const ref = users().doc(target);
  const snap = await ref.get();
  if (!snap.exists) return fail(res, 404, 'NOT_FOUND', '없는 사용자입니다');
  await ref.update({ status, decidedAt: FieldValue.serverTimestamp(), decidedBy: admin.email });
  send(res, 200, { ok: true, email: target, status });
}

// POST /v1/admin/cards  {cards: ['NK하나9798', …]}  (법인카드 목록 바꾸기)
async function adminSetCards(req, res) {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { cards } = await readJson(req);
  if (!Array.isArray(cards)) return fail(res, 400, 'BAD_REQUEST', '요청 형식 오류');
  const seen = {}, list = [];
  cards.forEach(c => { const n = cleanName(c); if (n && n.length <= CARD_LEN && !seen[n]) { seen[n] = 1; list.push(n); } });
  if (list.length > CARD_MAX) return fail(res, 400, 'TOO_MANY', '법인카드는 ' + CARD_MAX + '장까지 등록할 수 있습니다');
  await configDoc().set({ cards: list, updatedAt: FieldValue.serverTimestamp(), updatedBy: admin.email });
  cardCache = list; cardAt = Date.now();
  send(res, 200, { ok: true, cards: list });
}


// ── AI 판독(DeepSeek) ──
// 사진은 DeepSeek에 보내기만 하고 서버에는 저장하지 않음. 결과(JSON)만 앱에 돌려줌
const OCR_PROMPT = `이 이미지는 한국 영수증(카드 매출전표 포함)입니다. 아래 형식의 json으로만 답하세요.
- 이미지가 90도, 180도, 270도 회전되어 있을 수 있습니다. 먼저 글자 방향을 판단하고, 올바른 방향으로 읽으세요.
- tx_date·tx_time: 영수증에 인쇄된 결제(승인) 일시. 없거나 읽을 수 없으면 null.
- amount: 최종 결제 금액(합계). 원 단위 정수, 쉼표 없이. 취소 영수증이면 note에 "취소"라고 적으세요.
- merchant: 가맹점(상호)명. address: 가맹점 주소.
- pay_method: "card"(카드 결제) / "cash"(현금·현금영수증) / null(알 수 없음).
- card_company: 카드사 이름(예: 신한카드, KB국민카드, 하나카드). 인쇄된 그대로. 없으면 null.
- card_number: 인쇄된 카드 번호를 * 포함 그대로(예: "5310-12**-****-9798"). 없으면 null.
- 승인번호, 전화번호, 사업자번호는 출력하지 마세요.
- 확실하지 않은 값은 추측하지 말고 null로 두고, 해당 항목의 confidence를 "low"로 하세요.
예시:
{"is_receipt": true, "tx_date": "2026-09-28", "tx_time": "19:40", "amount": 32000,
 "merchant": "○○식당", "address": "서울 중구 ○○로 12", "pay_method": "card",
 "card_company": "신한카드", "card_number": "4518-44**-****-1234",
 "confidence": {"tx_date": "high", "amount": "high", "merchant": "high", "address": "low"},
 "note": null}`;

function str(v, max) { if (v == null) return null; const s = String(v).replace(/[\u0000-\u001f]/g, ' ').trim(); return s ? s.slice(0, max || 100) : null; }
function cleanOcr(o) {
  o = o && typeof o === 'object' ? o : {};
  let amount = o.amount;
  if (typeof amount === 'string') amount = Number(amount.replace(/[^\d.-]/g, ''));
  amount = Number.isFinite(amount) && amount > 0 ? Math.round(amount) : null;
  const dm = /^(\d{2}|\d{4})[-./](\d{1,2})[-./](\d{1,2})$/.exec(String(o.tx_date || '').trim());   // 2026-10-05, 2026.10.05, 26/10/05
  const date = dm ? (dm[1].length === 2 ? '20' + dm[1] : dm[1]) + '-' + dm[2].padStart(2, '0') + '-' + dm[3].padStart(2, '0') : null;
  const time = /^\d{1,2}:\d{2}/.test(String(o.tx_time || '')) ? String(o.tx_time).slice(0, 5).padStart(5, '0') : null;
  const conf = {};
  ['tx_date', 'amount', 'merchant', 'address'].forEach(k => { conf[k] = o.confidence && o.confidence[k] === 'high' ? 'high' : 'low'; });
  const num = str(o.card_number, 30);
  return {
    isReceipt: o.is_receipt !== false,
    txDate: date, txTime: time, amount,
    merchant: str(o.merchant, 60), address: str(o.address, 100),
    payMethod: o.pay_method === 'card' || o.pay_method === 'cash' ? o.pay_method : null,
    cardCompany: str(o.card_company, 20),
    cardNumber: num && /^[\d*\-\s]+$/.test(num) ? num.replace(/\s/g, '') : null,   // 숫자·* 외의 글자는 버림
    confidence: conf,
    note: str(o.note, 100)
  };
}

// 계정별 하루 판독 횟수(한국 날짜 기준). 넘으면 false
async function countOcr(email) {
  const day = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  const ref = users().doc(email);
  return firestore().runTransaction(async t => {
    const snap = await t.get(ref);
    const d = snap.exists ? snap.data() : {};
    const n = d.ocrDay === day ? Number(d.ocrCount || 0) : 0;
    if (n >= OCR_DAILY_LIMIT) return false;
    t.set(ref, { ocrDay: day, ocrCount: n + 1, ocrTotal: FieldValue.increment(1) }, { merge: true });
    return true;
  });
}

// POST /v1/ocr  {image: base64 JPEG}   Authorization: Bearer <id token>
async function ocr(req, res) {
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return fail(res, 401, 'INVALID_TOKEN', '다시 로그인해 주세요');
  let ident;
  try { ident = await identityFromIdToken(m[1]); } catch (e) { return fail(res, 401, 'INVALID_TOKEN', '다시 로그인해 주세요'); }
  const snap = await users().doc(ident.email).get();
  if (!isAdmin(ident.email) && !(snap.exists && snap.data().status === 'approved')) return fail(res, 403, 'NOT_APPROVED', '사용 승인이 필요합니다');
  if (!DEEPSEEK_KEY) return fail(res, 503, 'NO_KEY', 'AI 판독이 아직 설정되지 않았습니다');
  const { image } = await readJson(req, OCR_MAX_BODY);
  if (typeof image !== 'string' || image.length < 100 || !/^[A-Za-z0-9+/=]+$/.test(image)) return fail(res, 400, 'BAD_IMAGE', '사진 형식 오류');
  if (image.length > OCR_MAX_BODY) return fail(res, 413, 'TOO_LARGE', '사진이 너무 큽니다');   // Cloud Run 함수는 본문을 미리 읽으므로 여기서 다시 확인
  if (!(await countOcr(ident.email))) return fail(res, 429, 'DAILY_LIMIT', '오늘 판독 횟수(' + OCR_DAILY_LIMIT + '장)를 다 썼습니다. 직접 입력해 주세요');
  const body = {
    model: DEEPSEEK_MODEL,
    messages: [{ role: 'user', content: [
      { type: 'text', text: OCR_PROMPT },
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + image, detail: 'auto' } }
    ] }],
    response_format: { type: 'json_object' },
    max_tokens: 800,
    temperature: 0
  };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 90000);
  let r, data;
  try {
    r = await fetch(DEEPSEEK_URL, { method: 'POST', signal: ctl.signal,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + DEEPSEEK_KEY }, body: JSON.stringify(body) });
    data = await r.json().catch(() => ({}));
  } catch (e) {
    console.warn('deepseek fetch failed', e && e.name);
    return fail(res, 504, 'AI_TIMEOUT', 'AI 응답이 늦습니다. 잠시 후 다시 시도해 주세요');
  } finally { clearTimeout(timer); }
  if (!r.ok) {
    console.warn('deepseek error', r.status, data && data.error && data.error.message);
    return fail(res, 502, 'AI_ERROR', 'AI 판독 오류(' + r.status + ')');
  }
  const raw = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || '';
  let parsed;
  try { parsed = JSON.parse(raw); } catch (e) { return fail(res, 502, 'AI_BAD_JSON', 'AI 답을 읽지 못했습니다'); }
  send(res, 200, { result: cleanOcr(parsed) });
}

// GET /v1/admin/backup  (관리자 앱이 하루 한 번 받아 관리자 Drive '백업' 폴더에 JSON으로 저장)
async function adminBackup(req, res) {
  if (!(await requireAdmin(req, res))) return;
  const snap = await users().get();
  const list = snap.docs.map(d => {
    const x = d.data(), o = { id: d.id };
    Object.keys(x).forEach(k => { o[k] = x[k] && typeof x[k].toDate === 'function' ? x[k].toDate().toISOString() : x[k]; });
    return o;
  });
  const cs = await configDoc().get();
  send(res, 200, { at: new Date().toISOString(), users: list, corpCards: cs.exists ? cs.data().cards || [] : DEFAULT_CARDS.slice() });
}

const routes = {
  'POST /v1/auth/exchange': exchange,
  'POST /v1/auth/refresh': refresh,
  'POST /v1/auth/revoke': revoke,
  'POST /v1/profile/name': setMyName,
  'GET /v1/admin/users': adminList,
  'POST /v1/admin/users/status': adminSetStatus,
  'POST /v1/admin/cards': adminSetCards,
  'POST /v1/ocr': ocr,
  'GET /v1/admin/backup': adminBackup,
  // Cloud Run은 /healthz 주소를 자체 용도로 예약해 쓰므로 다른 이름을 씀
  'GET /v1/health': (req, res) => send(res, 200, { ok: true })
};

async function app(req, res) {
  cors(req, res);
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  const path = (req.url || '/').split('?')[0];
  const handler = routes[req.method + ' ' + path];
  if (!handler) return fail(res, 404, 'NOT_FOUND', '없는 주소입니다');
  if (path !== '/v1/health') {
    const origin = req.headers.origin;
    if (!origin || !ALLOWED_ORIGINS.includes(origin)) return fail(res, 403, 'BAD_ORIGIN', '허용되지 않은 출처입니다');
  }
  try {
    await handler(req, res);
  } catch (e) {
    if (e && e.status === 400) return fail(res, 400, 'BAD_REQUEST', '요청 형식 오류');
    if (e && e.status === 413) return fail(res, 413, 'TOO_LARGE', '요청이 너무 큽니다');
    console.error('handler error', e && e.message);
    fail(res, 500, 'INTERNAL', '서버 오류');
  }
}

if (!CLIENT_ID || !CLIENT_SECRET) console.warn('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET 환경변수가 없습니다');
if (!DEEPSEEK_KEY) console.warn('DEEPSEEK_API_KEY 환경변수가 없습니다(AI 판독 꺼짐)');
if (!ADMIN_EMAILS.length) console.warn('ADMIN_EMAILS 환경변수가 없습니다(관리자 없음)');
// Cloud Run 함수로 배포할 때: 진입점(함수 이름) = relay
exports.relay = app;
exports._test = { setDb: d => { db = d; }, isAdmin, cleanName, cleanOcr };
// 직접 실행할 때(node index.js): 일반 HTTP 서버
if (require.main === module) http.createServer(app).listen(PORT, () => console.log('listening on', PORT));
