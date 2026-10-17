/**
 * sw.js — 离线缓存（仅 PWA 场景；Capacitor 壳与本机 localhost 不注册）
 * 单文件应用，缓存清单极小。
 *
 * 缓存名由 tools/build.js 在构建时按 APP_VERSION 注入（源码中为占位符，
 * 构建后形如 audio-merge-lab-v0.3.5）——缓存名随版本变化，activate 时
 * 自动删除旧版本缓存，保证 PWA 用户能收到新构建（修复"发了新版却
 * 一直拿到旧文件"的问题）。
 */
var CACHE = 'audio-merge-lab-v0.3.5';
var ASSETS = [
  './',
  './index.html',
  './compat.html',
  './guide.html',
  './convert.html',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE)
      .then(function (c) { return c.addAll(ASSETS); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        return k === CACHE ? null : caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  // 导航请求（页面本身）网络优先：在线时永远拿最新构建，失败才回退缓存；
  // 静态资源缓存优先：图标等不常变，离线可用。音频文件由 Blob 处理，不入缓存。
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request).catch(function () {
        return caches.match(e.request).then(function (hit) {
          return hit || caches.match('./index.html');
        });
      })
    );
    return;
  }
  e.respondWith(
    caches.match(e.request).then(function (hit) {
      return hit || fetch(e.request);
    })
  );
});
