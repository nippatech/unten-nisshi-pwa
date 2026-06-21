/**
 * 運転日誌 Service Worker
 *
 * 役割:
 *   1. アプリシェル（HTML/CSS/JS）は「ネット優先」で取得し、常に最新を表示
 *      （オンライン時は必ず最新、オフライン時のみキャッシュにフォールバック）
 *   2. 画像・manifest は「キャッシュ優先」で高速表示
 *   3. GAS API / APK / 更新マニフェストはキャッシュしない
 *
 * v32 (2026-06-09): cache-first だと中身の更新が反映されない問題を解消するため、
 *   アプリシェル（html/js/css・ナビゲーション）を network-first に変更。
 * v34 (2026-06-20): v0.14.0（管理者パスワード認証・前回車両の自動セット）。
 * v35 (2026-06-20): v0.14.1（前回車両を全データから取得＝直近100件の外の運転者も対応）。
 * v36 (2026-06-20): v0.14.2（起動時に自分の前回車両を先読み＋照会中の「確認中…」表示）。
 * v37 (2026-06-20): v0.14.3（行先入力を縦並び＋全幅リストに。長い行先名も折り返さず読みやすく）。
 * v38 (2026-06-20): v0.14.4（行先候補リストをスクロール可能に。blur依存をやめ外側タップで閉じる）。
 */

const CACHE_VERSION = 'v38-2026-06-20';
const SHELL = [
  './',
  './index.html',
  './app.css',
  './app.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then(cache => cache.addAll(SHELL)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k))
    ))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // GAS API は常にネットワーク（キャッシュしない）
  if (url.hostname === 'script.google.com' || url.hostname === 'script.googleusercontent.com') {
    return;
  }
  // APKファイルと更新マニフェストはキャッシュしない
  if (url.pathname.endsWith('.apk') || url.pathname.endsWith('apk-latest.json')) {
    return;
  }

  // アプリシェル（ナビゲーション or html/js/css）は network-first
  const isShell = event.request.mode === 'navigate'
    || /\.(?:html|js|css)$/.test(url.pathname)
    || url.pathname.endsWith('/');

  if (isShell) {
    event.respondWith(
      fetch(event.request).then(resp => {
        if (event.request.method === 'GET' && resp && resp.ok && resp.type !== 'opaque') {
          const copy = resp.clone();
          caches.open(CACHE_VERSION).then(c => c.put(event.request, copy));
        }
        return resp;
      }).catch(() =>
        caches.match(event.request).then(hit => hit || caches.match('./index.html'))
      )
    );
    return;
  }

  // それ以外（画像・manifest等）は cache-first → network fallback
  event.respondWith(
    caches.match(event.request).then(hit => {
      if (hit) return hit;
      return fetch(event.request).then(resp => {
        if (event.request.method === 'GET' && resp && resp.ok && resp.type !== 'opaque') {
          const copy = resp.clone();
          caches.open(CACHE_VERSION).then(c => c.put(event.request, copy));
        }
        return resp;
      });
    })
  );
});
