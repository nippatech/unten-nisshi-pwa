/**
 * 運転日誌 Service Worker
 *
 * 役割:
 *   1. アプリシェル（HTML/CSS/JS）を初回アクセス時にキャッシュ
 *   2. 2回目以降はキャッシュから即座に表示（オフラインでも起動可能）
 *   3. GAS API リクエストはキャッシュしない（常に最新を取得）
 *
 * バージョンを上げると古いキャッシュを破棄して新しい資産を取得する。
 * フロント変更時は必ず CACHE_VERSION を上げること。
 */

const CACHE_VERSION = 'v25-2026-06-08';
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
    caches.open(CACHE_VERSION).then(cache => cache.addAll(SHELL))
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
    return; // ブラウザのデフォルト動作
  }
  // それ以外は cache-first → network fallback
  event.respondWith(
    caches.match(event.request).then(hit => {
      if (hit) return hit;
      return fetch(event.request).then(resp => {
        // 新しいリソースもキャッシュに追加（GETのみ）
        if (event.request.method === 'GET' && resp.ok && resp.type !== 'opaque') {
          const copy = resp.clone();
          caches.open(CACHE_VERSION).then(c => c.put(event.request, copy));
        }
        return resp;
      }).catch(() => {
        // ネットワークもダメな時は index.html を返す（SPAの基本動作）
        if (event.request.mode === 'navigate') {
          return caches.match('./index.html');
        }
      });
    })
  );
});
