/* 사진 처리: 열기(방향 보정 포함) · 원근 보정(모서리 4점) · 대비 보정(흑백/컬러) · 회전 · JPEG 만들기
   - OpenCV 없이 직접 계산(실기기에서 OpenCV.js가 1분 넘게 멈춰서 쓰지 않기로 함)
   - iPhone은 캔버스 크기 제한(약 1,670만 픽셀)이 있어 작업용 사진은 긴 변 3000px로 줄여서 씀 */
(function () {
  'use strict';

  var WORK_MAX = 3000;      // 작업용 사진 긴 변
  var OUT_MAX = 3000;       // 보정 결과 긴 변
  var OUT_PIXELS = 6e6;     // 보정 결과 최대 픽셀 수

  function canvas(w, h) {
    var c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h));
    return c;
  }

  // 파일 → 작업용 캔버스. createImageBitmap이 안 되면 <img>로 한 번 더 시도(HEIC 등)
  async function open(file) {
    var src = null, w, h, closeFn = null;
    try {
      src = await createImageBitmap(file);
      w = src.width; h = src.height; closeFn = function () { src.close && src.close(); };
    } catch (e) {
      src = await new Promise(function (resolve, reject) {
        var url = URL.createObjectURL(file), img = new Image();
        img.onload = function () { resolve(img); };
        img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('decode')); };
        img.src = url;
        closeFn = function () { URL.revokeObjectURL(url); };
      });
      w = src.naturalWidth; h = src.naturalHeight;
    }
    if (!w || !h) throw new Error('decode');
    var s = Math.min(1, WORK_MAX / Math.max(w, h));
    var c = canvas(w * s, h * s);
    var g = c.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(src, 0, 0, c.width, c.height);
    closeFn && closeFn();
    return c;
  }

  // 모서리 4점을 왼쪽 위 → 오른쪽 위 → 오른쪽 아래 → 왼쪽 아래 순서로 정리
  function order(pts) {
    var cx = 0, cy = 0;
    pts.forEach(function (p) { cx += p.x / 4; cy += p.y / 4; });
    var s = pts.slice().sort(function (a, b) { return Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx); });
    // atan2 기준 정렬(-π부터): 대략 왼쪽 위가 먼저 오도록 x+y가 가장 작은 점에서 시작
    var k = 0, best = Infinity;
    s.forEach(function (p, i) { if (p.x + p.y < best) { best = p.x + p.y; k = i; } });
    return s.slice(k).concat(s.slice(0, k));
  }

  // 8×8 연립방정식(가우스 소거)
  function solve(A, b) {
    var n = b.length, i, j, k;
    for (i = 0; i < n; i++) {
      var max = i;
      for (k = i + 1; k < n; k++) if (Math.abs(A[k][i]) > Math.abs(A[max][i])) max = k;
      var t = A[i]; A[i] = A[max]; A[max] = t; var tb = b[i]; b[i] = b[max]; b[max] = tb;
      if (Math.abs(A[i][i]) < 1e-12) throw new Error('singular');
      for (k = i + 1; k < n; k++) {
        var f = A[k][i] / A[i][i];
        for (j = i; j < n; j++) A[k][j] -= f * A[i][j];
        b[k] -= f * b[i];
      }
    }
    var x = new Array(n);
    for (i = n - 1; i >= 0; i--) {
      var sum = b[i];
      for (j = i + 1; j < n; j++) sum -= A[i][j] * x[j];
      x[i] = sum / A[i][i];
    }
    return x;
  }

  // 결과 사각형(0,0)-(W,H)의 점 → 원본 사진의 점 으로 가는 변환(호모그래피)
  function homography(W, H, q) {
    var d = [[0, 0], [W, 0], [W, H], [0, H]], A = [], b = [];
    for (var i = 0; i < 4; i++) {
      var u = d[i][0], v = d[i][1], x = q[i].x, y = q[i].y;
      A.push([u, v, 1, 0, 0, 0, -u * x, -v * x]); b.push(x);
      A.push([0, 0, 0, u, v, 1, -u * y, -v * y]); b.push(y);
    }
    var h = solve(A, b);
    return h.concat([1]);
  }

  function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

  // 원근 보정: 작업용 캔버스 + 모서리 4점(작업용 캔버스 좌표) → 곧게 편 캔버스
  function warp(src, corners) {
    var q = order(corners);
    var W = Math.max(dist(q[0], q[1]), dist(q[3], q[2]));
    var H = Math.max(dist(q[0], q[3]), dist(q[1], q[2]));
    if (W < 20 || H < 20) throw new Error('too small');
    var s = Math.min(1, OUT_MAX / Math.max(W, H), Math.sqrt(OUT_PIXELS / (W * H)));
    W = Math.round(W * s); H = Math.round(H * s);
    var h = homography(W, H, q);
    var sw = src.width, sh = src.height;
    var sd = src.getContext('2d').getImageData(0, 0, sw, sh).data;
    var out = canvas(W, H), og = out.getContext('2d');
    var img = og.createImageData(W, H), od = img.data;
    var o = 0;
    for (var v = 0; v < H; v++) {
      for (var u = 0; u < W; u++) {
        var den = h[6] * u + h[7] * v + 1;
        var x = (h[0] * u + h[1] * v + h[2]) / den;
        var y = (h[3] * u + h[4] * v + h[5]) / den;
        if (x < 0) x = 0; else if (x > sw - 1.001) x = sw - 1.001;
        if (y < 0) y = 0; else if (y > sh - 1.001) y = sh - 1.001;
        var x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0;
        var i00 = (y0 * sw + x0) * 4, i10 = i00 + 4, i01 = i00 + sw * 4, i11 = i01 + 4;
        var w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
        od[o] = sd[i00] * w00 + sd[i10] * w10 + sd[i01] * w01 + sd[i11] * w11;
        od[o + 1] = sd[i00 + 1] * w00 + sd[i10 + 1] * w10 + sd[i01 + 1] * w01 + sd[i11 + 1] * w11;
        od[o + 2] = sd[i00 + 2] * w00 + sd[i10 + 2] * w10 + sd[i01 + 2] * w01 + sd[i11 + 2] * w11;
        od[o + 3] = 255;
        o += 4;
      }
    }
    og.putImageData(img, 0, 0);
    return out;
  }

  // 대비 보정: 밝기 분포의 아래 1%·위 1%를 검정·흰색으로 늘림
  // 흑백: 회색조로 바꾼 뒤 적용. 컬러: 빨강·초록·파랑을 따로 늘려 종이가 흰색이 되게 함(누런 색 빠짐)
  function stretchLut(hist, n) {
    var lo = 0, hi = 255, acc = 0, i;
    for (i = 0; i < 256; i++) { acc += hist[i]; if (acc > n * 0.01) { lo = i; break; } }
    acc = 0;
    for (i = 255; i >= 0; i--) { acc += hist[i]; if (acc > n * 0.01) { hi = i; break; } }
    if (hi - lo < 30) { lo = Math.max(0, lo - 15); hi = Math.min(255, hi + 15); }
    var lut = new Uint8ClampedArray(256), range = hi - lo;
    for (i = 0; i < 256; i++) lut[i] = ((i - lo) * 255) / range;
    return lut;
  }

  function enhance(src, mode) {
    var w = src.width, h = src.height;
    var c = canvas(w, h), g = c.getContext('2d');
    g.drawImage(src, 0, 0);
    var img = g.getImageData(0, 0, w, h), d = img.data, n = w * h, i, L;
    if (mode === 'color') {
      var hr = new Uint32Array(256), hg = new Uint32Array(256), hb = new Uint32Array(256);
      for (i = 0; i < d.length; i += 4) { hr[d[i]]++; hg[d[i + 1]]++; hb[d[i + 2]]++; }
      var lr = stretchLut(hr, n), lg = stretchLut(hg, n), lb = stretchLut(hb, n);
      for (i = 0; i < d.length; i += 4) { d[i] = lr[d[i]]; d[i + 1] = lg[d[i + 1]]; d[i + 2] = lb[d[i + 2]]; }
    } else {
      var hist = new Uint32Array(256);
      for (i = 0; i < d.length; i += 4) { hist[(d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8]++; }
      var lut = stretchLut(hist, n);
      for (i = 0; i < d.length; i += 4) {
        L = lut[(d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8];
        d[i] = d[i + 1] = d[i + 2] = L;
      }
    }
    g.putImageData(img, 0, 0);
    return c;
  }

  // 스캔처럼 보정: 종이의 밝기를 부분마다 구해(배경) 나눠 줌 → 그림자·조명 얼룩·구김 음영이 빠지고 종이는 고르게 흰색
  // 1) 작게 줄인 사진에서 "주변에서 가장 밝은 값"을 구하면 글자가 지워진 종이 밝기가 됨(최댓값 필터)
  // 2) 부드럽게 펴서 원래 크기로 늘림 3) 원래 사진 ÷ 종이 밝기 4) 글자를 조금 더 진하게
  function boxMax(src, w, h, r) {
    var tmp = new Float32Array(w * h), out = new Float32Array(w * h), x, y, k, m;
    for (y = 0; y < h; y++) for (x = 0; x < w; x++) {
      m = 0;
      for (k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) if (src[y * w + k] > m) m = src[y * w + k];
      tmp[y * w + x] = m;
    }
    for (y = 0; y < h; y++) for (x = 0; x < w; x++) {
      m = 0;
      for (k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) if (tmp[k * w + x] > m) m = tmp[k * w + x];
      out[y * w + x] = m;
    }
    return out;
  }
  function boxBlur(src, w, h, r) {
    var tmp = new Float32Array(w * h), out = new Float32Array(w * h), x, y, k, s, c;
    for (y = 0; y < h; y++) for (x = 0; x < w; x++) {
      s = 0; c = 0;
      for (k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) { s += src[y * w + k]; c++; }
      tmp[y * w + x] = s / c;
    }
    for (y = 0; y < h; y++) for (x = 0; x < w; x++) {
      s = 0; c = 0;
      for (k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) { s += tmp[k * w + x]; c++; }
      out[y * w + x] = s / c;
    }
    return out;
  }
  // 한 채널(또는 밝기)의 종이 밝기 지도를 원래 크기로 만들어 돌려줌
  function paperMap(chan, w, h) {
    var s = Math.min(1, 160 / Math.max(w, h)) , sw = Math.max(8, Math.round(w * s)), sh = Math.max(8, Math.round(h * s));
    var small = new Float32Array(sw * sh), x, y;
    for (y = 0; y < sh; y++) for (x = 0; x < sw; x++) {
      // 칸 안의 가장 밝은 값(작게 줄이면서 글자를 먼저 지움)
      var x0 = Math.floor(x * w / sw), x1 = Math.max(x0 + 1, Math.floor((x + 1) * w / sw));
      var y0 = Math.floor(y * h / sh), y1 = Math.max(y0 + 1, Math.floor((y + 1) * h / sh));
      var m = 0, stepX = Math.max(1, (x1 - x0) >> 3), stepY = Math.max(1, (y1 - y0) >> 3);
      for (var yy = y0; yy < y1; yy += stepY) for (var xx = x0; xx < x1; xx += stepX) { var v = chan[yy * w + xx]; if (v > m) m = v; }
      small[y * sw + x] = m;
    }
    var bg = boxBlur(boxMax(small, sw, sh, 2), sw, sh, 3);
    // 원래 크기로 늘림(양선형)
    var out = new Float32Array(w * h);
    for (y = 0; y < h; y++) {
      var fy = Math.min(sh - 1.001, Math.max(0, (y + 0.5) * sh / h - 0.5)), y0i = fy | 0, ty = fy - y0i;
      for (x = 0; x < w; x++) {
        var fx = Math.min(sw - 1.001, Math.max(0, (x + 0.5) * sw / w - 0.5)), x0i = fx | 0, tx = fx - x0i;
        var i = y0i * sw + x0i;
        out[y * w + x] = (bg[i] * (1 - tx) + bg[i + 1] * tx) * (1 - ty) + (bg[i + sw] * (1 - tx) + bg[i + sw + 1] * tx) * ty;
      }
    }
    return out;
  }

  function scan(src, mode) {
    var w = src.width, h = src.height;
    var c = canvas(w, h), g = c.getContext('2d');
    g.drawImage(src, 0, 0);
    var img = g.getImageData(0, 0, w, h), d = img.data, n = w * h, i, p;
    // 글자를 진하게, 종이는 하얗게: 0.0~1.0 비율에 곡선 적용
    var curve = new Uint8ClampedArray(1025);
    for (i = 0; i <= 1024; i++) {
      var t = i / 1024;                       // 종이 밝기 대비 비율(1 = 종이)
      var v = (t - 0.18) / (0.86 - 0.18);     // 0.86 이상은 흰색, 0.18 이하는 검정
      v = v <= 0 ? 0 : v >= 1 ? 1 : Math.pow(v, 1.35);
      curve[i] = v * 255;
    }
    if (mode === 'color') {
      for (var ch = 0; ch < 3; ch++) {
        var chan = new Float32Array(n);
        for (p = 0; p < n; p++) chan[p] = d[p * 4 + ch];
        var bg = paperMap(chan, w, h);
        for (p = 0; p < n; p++) {
          var r = chan[p] / Math.max(24, bg[p]);
          d[p * 4 + ch] = curve[Math.min(1024, (r * 1024) | 0)];
        }
      }
    } else {
      var lum = new Float32Array(n);
      for (p = 0; p < n; p++) lum[p] = (d[p * 4] * 77 + d[p * 4 + 1] * 150 + d[p * 4 + 2] * 29) / 256;
      var bgL = paperMap(lum, w, h);
      for (p = 0; p < n; p++) {
        var v2 = curve[Math.min(1024, ((lum[p] / Math.max(24, bgL[p])) * 1024) | 0)];
        d[p * 4] = d[p * 4 + 1] = d[p * 4 + 2] = v2;
      }
    }
    g.putImageData(img, 0, 0);
    return c;
  }

  // ── 영수증 테두리 자동 찾기 ──
  // 1) 작게 줄여 밝기로 종이(밝은 부분)와 바탕을 나눔(오츠 방법: 두 무리가 가장 잘 갈리는 밝기)
  //    바탕도 밝으면(흰 책상) 테두리 색과 다른 부분을 종이로 봄
  // 2) 가장 큰 종이 덩어리의 바깥 점들로 볼록 껍질을 만들고 3) 꼭짓점을 줄여 사각형 4점으로 만듦
  // 못 찾거나 모양이 이상하면 null → 화면에서 기본 사각형을 씀
  function otsu(hist, n) {
    var sum = 0, i; for (i = 0; i < 256; i++) sum += i * hist[i];
    var sB = 0, wB = 0, best = 0, t = 128;
    for (i = 0; i < 256; i++) {
      wB += hist[i]; if (!wB) continue;
      var wF = n - wB; if (!wF) break;
      sB += i * hist[i];
      var mB = sB / wB, mF = (sum - sB) / wF, v = wB * wF * (mB - mF) * (mB - mF);
      if (v > best) { best = v; t = i; }
    }
    return t;
  }
  function largestBlob(mask, w, h) {
    var lab = new Int32Array(w * h), stack = new Int32Array(w * h), best = 0, bestId = 0, id = 0;
    for (var s0 = 0; s0 < w * h; s0++) {
      if (!mask[s0] || lab[s0]) continue;
      id++; var top = 0, size = 0; stack[top++] = s0; lab[s0] = id;
      while (top) {
        var q = stack[--top]; size++;
        var x = q % w, y = (q / w) | 0;
        if (x > 0 && mask[q - 1] && !lab[q - 1]) { lab[q - 1] = id; stack[top++] = q - 1; }
        if (x < w - 1 && mask[q + 1] && !lab[q + 1]) { lab[q + 1] = id; stack[top++] = q + 1; }
        if (y > 0 && mask[q - w] && !lab[q - w]) { lab[q - w] = id; stack[top++] = q - w; }
        if (y < h - 1 && mask[q + w] && !lab[q + w]) { lab[q + w] = id; stack[top++] = q + w; }
      }
      if (size > best) { best = size; bestId = id; }
    }
    return { lab: lab, id: bestId, size: best };
  }
  function hull(pts) {
    pts.sort(function (a, b) { return a.x - b.x || a.y - b.y; });
    var cr = function (o, a, b) { return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x); };
    var lo = [], up = [], i;
    for (i = 0; i < pts.length; i++) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], pts[i]) <= 0) lo.pop(); lo.push(pts[i]); }
    for (i = pts.length - 1; i >= 0; i--) { while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], pts[i]) <= 0) up.pop(); up.push(pts[i]); }
    up.pop(); lo.pop();
    return lo.concat(up);
  }
  function triArea(a, b, c) { return Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)) / 2; }
  // 볼록 다각형의 꼭짓점을 하나씩 빼서(빼도 넓이가 가장 적게 줄어드는 점부터) 4개로 만듦
  function toQuad(poly) {
    var p = poly.slice();
    while (p.length > 4) {
      var mi = 0, ma = Infinity;
      for (var i = 0; i < p.length; i++) {
        var a = triArea(p[(i - 1 + p.length) % p.length], p[i], p[(i + 1) % p.length]);
        if (a < ma) { ma = a; mi = i; }
      }
      p.splice(mi, 1);
    }
    return p.length === 4 ? p : null;
  }
  function polyArea(p) { var s = 0; for (var i = 0; i < p.length; i++) { var a = p[i], b = p[(i + 1) % p.length]; s += a.x * b.y - b.x * a.y; } return Math.abs(s) / 2; }

  function detectQuad(src) {
    var sm = scaled(src, 360), w = sm.width, h = sm.height, n = w * h;
    var d = sm.getContext('2d').getImageData(0, 0, w, h).data;
    var L = new Uint8Array(n), hist = new Uint32Array(256), p;
    for (p = 0; p < n; p++) { L[p] = (d[p * 4] * 77 + d[p * 4 + 1] * 150 + d[p * 4 + 2] * 29) >> 8; hist[L[p]]++; }
    // 방법 A: 밝은 쪽 = 종이
    var t = otsu(hist, n), mask = new Uint8Array(n);
    for (p = 0; p < n; p++) mask[p] = L[p] > t ? 1 : 0;
    var cand = [mask];
    // 방법 B: 사진 가장자리(바탕) 색과 많이 다른 부분 = 종이(바탕이 밝을 때 대비)
    var br = [], bg = [], bb = [], x, y;
    for (x = 0; x < w; x++) { [0, h - 1].forEach(function (yy) { var q = (yy * w + x) * 4; br.push(d[q]); bg.push(d[q + 1]); bb.push(d[q + 2]); }); }
    for (y = 0; y < h; y++) { [0, w - 1].forEach(function (xx) { var q = (y * w + xx) * 4; br.push(d[q]); bg.push(d[q + 1]); bb.push(d[q + 2]); }); }
    var med = function (a) { a.sort(function (u, v) { return u - v; }); return a[a.length >> 1]; };
    var mr = med(br), mg = med(bg), mb = med(bb), mask2 = new Uint8Array(n), dist = new Uint8Array(n), dh = new Uint32Array(256);
    for (p = 0; p < n; p++) {
      var dr = d[p * 4] - mr, dg = d[p * 4 + 1] - mg, db = d[p * 4 + 2] - mb;
      dist[p] = Math.min(255, Math.sqrt(dr * dr + dg * dg + db * db) | 0); dh[dist[p]]++;
    }
    // 바탕과의 색 차이 기준을 사진마다 정함(Otsu). 아이보리 책상처럼 차이가 작아도 잡히게, 단 너무 작은 차이(잡음)는 무시
    var t2 = Math.max(14, otsu(dh, n));
    for (p = 0; p < n; p++) mask2[p] = dist[p] > t2 ? 1 : 0;
    cand.push(mask2);
    // 방법 C: 색이 옅은(무채색에 가까운) 밝은 부분 = 종이. 나무·주황빛 책상처럼 바탕에 색이 있을 때, 밝기가 비슷해도 구분됨
    var sat = new Uint8Array(n), sh = new Uint32Array(256), mask3 = new Uint8Array(n);
    for (p = 0; p < n; p++) {
      var r0 = d[p * 4], g0 = d[p * 4 + 1], b0 = d[p * 4 + 2];
      var mx = Math.max(r0, g0, b0), mn = Math.min(r0, g0, b0);
      sat[p] = mx ? Math.min(255, ((mx - mn) * 255 / mx) | 0) : 0; sh[sat[p]]++;
    }
    // 종이(감열지)는 채도가 아주 낮음(0~20). 바탕의 빛 반사 부분도 채도가 조금 낮아지므로 기준은 Otsu 값과 35 중 작은 쪽
    var t3 = Math.min(35, otsu(sh, n));
    if (t3 > 8) { for (p = 0; p < n; p++) mask3[p] = sat[p] <= t3 && L[p] > 90 ? 1 : 0; cand.push(mask3); }
    // 가는 선·작은 점이 종이에 붙어 테두리를 끌어당기지 않도록 한 번 깎았다가 다시 불림(열기 연산)
    function open2(m) {
      var r = 2, e = new Uint8Array(n), o = new Uint8Array(n), x2, y2, i2, j2, ok;
      for (y2 = 0; y2 < h; y2++) for (x2 = 0; x2 < w; x2++) {
        ok = 1;
        for (j2 = -r; j2 <= r && ok; j2++) for (i2 = -r; i2 <= r; i2++) {
          var xx = x2 + i2, yy = y2 + j2;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h || !m[yy * w + xx]) { ok = 0; break; }
        }
        e[y2 * w + x2] = ok;
      }
      for (y2 = 0; y2 < h; y2++) for (x2 = 0; x2 < w; x2++) {
        if (!e[y2 * w + x2]) continue;
        for (j2 = -r; j2 <= r; j2++) for (i2 = -r; i2 <= r; i2++) {
          var x3 = x2 + i2, y3 = y2 + j2;
          if (x3 >= 0 && y3 >= 0 && x3 < w && y3 < h) o[y3 * w + x3] = 1;
        }
      }
      return o;
    }
    var best = null;
    // 세 방식으로 모두 찾아 보고, 사각형에 가장 꽉 차고(채움 비율) 사진 끝에 붙지 않은 것을 고름
    cand.forEach(function (m0, ci) {
      var m = open2(m0);
      var blob = largestBlob(m, w, h);
      if (blob.size < n * 0.08) return;
      // 덩어리의 줄마다 가장 왼쪽·오른쪽 점만 모아 볼록 껍질
      var pts = [], touch = 0;
      for (y = 0; y < h; y++) {
        var l = -1, r = -1;
        for (x = 0; x < w; x++) if (blob.lab[y * w + x] === blob.id) { if (l < 0) l = x; r = x; }
        if (l >= 0) { pts.push({ x: l, y: y }, { x: r + 1, y: y }); if (l === 0 || r === w - 1) touch++; }
      }
      if (y === 0 && touch) touch++;
      var hl = hull(pts), q = hl.length >= 4 ? toQuad(hl) : null;
      if (!q) return;
      var area = polyArea(q), fill = blob.size / area;
      // 사진 거의 전체(바탕이 안 보임)거나, 사각형과 모양이 너무 다르면 버림
      if (area > n * 0.97 || area < n * 0.08 || fill < 0.8) return;
      if (touch > h * 0.5) return;                 // 사진 양옆에 절반 넘게 붙어 있으면 바탕일 가능성이 큼
      var edge = q.filter(function (pt) { return pt.x <= 1 || pt.y <= 1 || pt.x >= w - 1 || pt.y >= h - 1; }).length;
      if (edge >= 2) return;                       // 꼭짓점 2개 이상이 사진 끝 = 종이 일부나 바탕을 잘못 잡은 것
      var score = fill - 0.08 * edge - 0.3 * touch / h;   // 모서리가 사진 끝에 닿으면 책상이 섞였을 가능성이 큼
      if (!best || score > best.score + 0.01) best = { q: q, score: score, m: ci };
    });
    if (!best) return null;
    var k = src.width / w;
    return order(best.q.map(function (pt) {
      return { x: Math.max(0, Math.min(src.width, pt.x * k)), y: Math.max(0, Math.min(src.height, pt.y * k)) };
    }));
  }

  // 시계 방향 90° × turns
  function rotate(src, turns) {
    turns = ((turns % 4) + 4) % 4;
    if (!turns) return src;
    var sw = src.width, sh = src.height, odd = turns % 2 === 1;
    var c = canvas(odd ? sh : sw, odd ? sw : sh), g = c.getContext('2d');
    g.translate(c.width / 2, c.height / 2);
    g.rotate(turns * Math.PI / 2);
    g.drawImage(src, -sw / 2, -sh / 2);
    return c;
  }

  function scaled(src, maxSide) {
    var s = Math.min(1, maxSide / Math.max(src.width, src.height));
    if (s === 1) return src;
    var c = canvas(src.width * s, src.height * s), g = c.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(src, 0, 0, c.width, c.height);
    return c;
  }

  function jpeg(src, quality) {
    return new Promise(function (resolve, reject) {
      src.toBlob(function (b) { b ? resolve(b) : reject(new Error('encode')); }, 'image/jpeg', quality || 0.88);
    });
  }

  // 글자 줄이 세로로 서 있는지(= 영수증이 옆으로 누운 채 찍혔는지) 판단
  // 방법: 작게 줄여 어두운 점(글자)을 찾은 뒤, 가로줄·세로줄마다 글자 점 수를 셈.
  //   글자 줄이 가로로 놓여 있으면 줄 사이 여백 때문에 "빈 가로줄"이 많고, 옆으로 누워 있으면 "빈 세로줄"이 많음.
  //   차이가 뚜렷하지 않으면 모양(가로가 길면 돌림)으로 판단
  function textSideways(src) {
    var sm = scaled(src, 600), w = sm.width, h = sm.height;
    var d = sm.getContext('2d').getImageData(0, 0, w, h).data;
    var x0 = Math.round(w * 0.06), x1 = Math.round(w * 0.94), y0 = Math.round(h * 0.06), y1 = Math.round(h * 0.94);
    var hist = new Uint32Array(256), n = 0, x, y, L;
    for (y = y0; y < y1; y++) for (x = x0; x < x1; x++) { var i = (y * w + x) * 4; hist[(d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8]++; n++; }
    // 밝은 쪽(종이) 기준에서 충분히 어두운 점을 글자로 봄
    var acc = 0, paper = 255;
    for (L = 255; L >= 0; L--) { acc += hist[L]; if (acc > n * 0.5) { paper = L; break; } }
    var thr = paper * 0.62;
    var rows = new Float64Array(y1 - y0), cols = new Float64Array(x1 - x0), dark = 0;
    for (y = y0; y < y1; y++) for (x = x0; x < x1; x++) {
      var j = (y * w + x) * 4;
      if (((d[j] * 77 + d[j + 1] * 150 + d[j + 2] * 29) >> 8) < thr) { rows[y - y0]++; cols[x - x0]++; dark++; }
    }
    if (dark < n * 0.003 || dark > n * 0.35) return w > h;   // 글자가 거의 없거나, 종이가 아닌 부분이 많음
    // 글자 영역 안에서 "빈 줄"(글자 점이 거의 없는 줄)의 비율. 글자 줄 방향으로는 줄 사이 여백 때문에 빈 줄이 많음
    function gaps(a) {
      var max = 0, k, first = -1, last = -1;
      for (k = 0; k < a.length; k++) if (a[k] > max) max = a[k];
      var lim = max * 0.04;
      for (k = 0; k < a.length; k++) if (a[k] > lim) { if (first < 0) first = k; last = k; }
      if (last - first < 8) return 0;
      var empty = 0;
      for (k = first; k <= last; k++) if (a[k] <= lim) empty++;
      return empty / (last - first + 1);
    }
    var rg = gaps(rows), cg = gaps(cols);
    if (cg > rg + 0.08) return true;
    if (rg > cg + 0.08) return false;
    return w > h;
  }

  window.RSImaging = {
    textSideways: textSideways,
    scan: scan,
    detectQuad: detectQuad,
    open: open, warp: warp, enhance: enhance, rotate: rotate, scaled: scaled, jpeg: jpeg, order: order, canvas: canvas
  };
})();
