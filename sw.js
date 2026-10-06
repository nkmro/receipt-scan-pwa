/* 오프라인 캐시. 파일을 고치면 CACHE 이름의 숫자를 올려야 폰에 새 버전이 반영됩니다. */
var CACHE = 'receipt-scan-v44';
var ASSETS = [
  './', 'index.html', 'privacy.html', 'camtest.html', 'css/app.css?v=44', 'js/config.js?v=44', 'js/auth.js?v=44', 'js/store.js?v=44', 'js/imaging.js?v=44', 'js/queue.js?v=44', 'js/ocr.js?v=44', 'js/capture.js?v=44', 'js/box.js?v=44', 'js/detail.js?v=44', 'js/layout.js?v=44', 'js/preview.js?v=44', 'js/pdf.js?v=44', 'js/gapji.js?v=44', 'js/attach.js?v=44', 'js/app.js?v=44', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(ASSETS); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k.startsWith('receipt-scan-') && k !== CACHE; })
      .map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== location.origin) return; // Google API·글꼴 등 외부 요청은 건드리지 않음

  if (req.mode === 'navigate') {
    // 화면(HTML)은 최신 우선, 오프라인이면 캐시
    e.respondWith(fetch(req).then(function (res) {
      var copy = res.clone();
      caches.open(CACHE).then(function (c) { c.put('index.html', copy); });
      return res;
    }).catch(function () { return caches.match('index.html'); }));
    return;
  }
  // 나머지 파일은 캐시 우선
  e.respondWith(caches.match(req).then(function (hit) { return hit || fetch(req); }));
});
