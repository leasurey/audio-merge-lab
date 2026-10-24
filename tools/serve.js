#!/usr/bin/env node
/**
 * serve.js — 可选的局域网自托管服务（Node 零依赖）
 *
 * 存在意义：iOS 上没有可靠的"前端直接保存文件"通道。
 *   - `a[download]` + blob URL 在 iOS Safari 上行为不稳定（各版本反复）；
 *   - `window.open(blobURL)` 会交给系统播放器打开，而系统播放器没有保存入口；
 *   - `navigator.share({files})` 虽好，但大文件要把整包读进内存，容易触发页面重载。
 * 于是借用「服务端直链 + Content-Disposition: attachment」这条最稳的路：
 * 浏览器把结果 POST 到本机服务，服务返回一个普通链接，用户点链接时
 * 由 Safari/浏览器的下载管理器接管 → 存到「文件」App（iOS 13+）。
 *
 * 提供能力：
 *   1. 静态托管 dist/（构建产物），手机连同一 Wi-Fi 即可打开整站；
 *   2. GET  /api/health          服务探测（前端据此决定是否显示保存入口）
 *   3. POST /api/upload?name=&mime=   保存上传的音频，返回 {id,url,name,size}
 *   4. GET  /api/file/:id        以 attachment 方式下载（RFC 5987 中文名 + Range 支持）
 *   5. DELETE /api/file/:id      删除单个文件
 *   6. GET  /api/files           列出当前保存的文件
 *
 * 安全边界（仅在受信任的局域网使用，请勿直接暴露到公网）：
 *   - 只在 uploads/ 目录内落盘，文件名做白名单清洗，拒绝路径穿越；
 *   - 静态文件限制在 dist/ 目录内；
 *   - 上传大小上限默认 2 GB；文件默认 6 小时后自动清理。
 *
 * 用法：node tools/serve.js [--port 8010] [--dir dist]
 */
'use strict';

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const PORT = parseInt(process.env.PORT || argOf('--port', '8010'), 10);
const WEB_DIR = path.resolve(root, argOf('--dir', 'dist'));
const UPLOAD_DIR = path.resolve(root, argOf('--uploads', 'uploads'));
const MAX_UPLOAD = 2 * 1024 * 1024 * 1024; // 2 GB
const KEEP_MS = 6 * 60 * 60 * 1000;        // 文件保留 6 小时

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.webm': 'audio/webm'
};

/* ---------------- 工具 ---------------- */

/** 文件名清洗：去目录分隔符与控制字符，限制长度，保留常见字符 */
function safeName(name) {
  let s = String(name || 'download');
  s = s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim();
  if (!s || s === '.' || s === '..') s = 'download';
  if (s.length > 120) {
    const dot = s.lastIndexOf('.');
    const ext = dot > 0 ? s.slice(dot) : '';
    s = s.slice(0, 120 - ext.length) + ext;
  }
  return s;
}

/** id 只允许安全字符，杜绝穿越 */
function isSafeId(id) {
  return /^[A-Za-z0-9_-]{1,64}$/.test(String(id || ''));
}

/** RFC 5987：中文文件名在 iOS Safari 上必须这样编码，否则存下来是乱码 */
function contentDisposition(name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return 'attachment; filename="' + ascii + '"; filename*=UTF-8\'\'' + encodeURIComponent(name);
}

function json(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function lanAddresses() {
  const out = [];
  const nets = os.networkInterfaces();
  Object.keys(nets).forEach((k) => {
    (nets[k] || []).forEach((n) => {
      if (n.family === 'IPv4' && !n.internal) out.push(n.address);
    });
  });
  return out;
}

/* ---------------- 上传目录 ---------------- */
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/**
 * 索引：id -> {file, name, mime, size, at}
 * 重启后从磁盘目录重建（文件名格式 <id>__<safeName>）。
 */
const index = new Map();

async function rebuildIndex() {
  try {
    const files = await fsp.readdir(UPLOAD_DIR);
    for (const f of files) {
      const m = /^([A-Za-z0-9_-]{1,64})__(.+)$/.exec(f);
      if (!m) continue;
      const full = path.join(UPLOAD_DIR, f);
      const st = await fsp.stat(full).catch(() => null);
      if (!st || !st.isFile()) continue;
      index.set(m[1], {
        file: full,
        name: m[2],
        mime: MIME[path.extname(m[2]).toLowerCase()] || 'application/octet-stream',
        size: st.size,
        at: st.mtimeMs
      });
    }
  } catch (e) {
    /* 目录不可读则忽略，索引为空 */
  }
}

async function sweep() {
  const now = Date.now();
  for (const [id, rec] of Array.from(index.entries())) {
    const st = await fsp.stat(rec.file).catch(() => null);
    if (!st) { index.delete(id); continue; }
    if (now - st.mtimeMs > KEEP_MS) {
      await fsp.unlink(rec.file).catch(() => {});
      index.delete(id);
    }
  }
}

/* ---------------- 请求处理 ---------------- */

async function handleUpload(req, res, url) {
  const rawName = url.searchParams.get('name') || 'download';
  const mime = url.searchParams.get('mime') || 'application/octet-stream';
  const declared = parseInt(req.headers['content-length'] || '0', 10);
  if (declared && declared > MAX_UPLOAD) {
    return json(res, 413, { error: '文件超过上限（2 GB）' });
  }
  const id = crypto.randomBytes(9).toString('base64url');
  const name = safeName(rawName);
  const target = path.join(UPLOAD_DIR, id + '__' + name);

  let written = 0;
  let aborted = false;
  const ws = fs.createWriteStream(target);
  req.on('data', (chunk) => { written += chunk.length; });
  req.on('aborted', () => { aborted = true; });

  try {
    await new Promise((resolve, reject) => {
      req.on('error', reject);
      ws.on('error', reject);
      ws.on('finish', resolve);
      req.pipe(ws);
    });
  } catch (e) {
    await fsp.unlink(target).catch(() => {});
    return json(res, 500, { error: '写入失败：' + e.message });
  }
  if (aborted) {
    await fsp.unlink(target).catch(() => {});
    return;
  }
  if (written > MAX_UPLOAD) {
    await fsp.unlink(target).catch(() => {});
    return json(res, 413, { error: '文件超过上限（2 GB）' });
  }

  index.set(id, { file: target, name: name, mime: mime, size: written, at: Date.now() });
  json(res, 200, {
    id: id,
    url: '/api/file/' + id,
    name: name,
    size: written,
    mime: mime,
    expiresInHours: KEEP_MS / 3600000
  });
}

async function handleDownload(req, res, id) {
  if (!isSafeId(id)) return json(res, 400, { error: '非法 id' });
  const rec = index.get(id);
  if (!rec) return json(res, 404, { error: '文件不存在或已过期（默认保留 6 小时）' });
  const st = await fsp.stat(rec.file).catch(() => null);
  if (!st) { index.delete(id); return json(res, 404, { error: '文件已被清理' }); }

  const headers = {
    'Content-Type': rec.mime || 'application/octet-stream',
    'Content-Disposition': contentDisposition(rec.name),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store'
  };

  const range = req.headers.range;
  // Range 支持：iOS Safari 在下载大文件/续传时会发 Range，缺了会拿不到完整文件
  const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
  if (m && (m[1] !== '' || m[2] !== '')) {
    let start = m[1] === '' ? 0 : parseInt(m[1], 10);
    let end = m[2] === '' ? st.size - 1 : parseInt(m[2], 10);
    if (isNaN(start) || start < 0) start = 0;
    if (isNaN(end) || end >= st.size) end = st.size - 1;
    if (start > end) {
      res.writeHead(416, Object.assign({}, headers, { 'Content-Range': 'bytes */' + st.size }));
      return res.end();
    }
    headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + st.size;
    headers['Content-Length'] = end - start + 1;
    res.writeHead(206, headers);
    fs.createReadStream(rec.file, { start: start, end: end })
      .on('error', () => res.end())
      .pipe(res);
    return;
  }

  headers['Content-Length'] = st.size;
  res.writeHead(200, headers);
  fs.createReadStream(rec.file).on('error', () => res.end()).pipe(res);
}

async function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const full = path.join(WEB_DIR, rel);
  // 目录穿越防护：解析后的真实路径必须仍在 WEB_DIR 内
  if (!full.startsWith(WEB_DIR + path.sep) && full !== path.join(WEB_DIR, 'index.html')) {
    return json(res, 403, { error: '拒绝访问' });
  }
  const st = await fsp.stat(full).catch(() => null);
  if (!st || !st.isFile()) {
    // 单页应用：未知路径回落首页（API 路径不在此列）
    const idx = path.join(WEB_DIR, 'index.html');
    const has = await fsp.stat(idx).catch(() => null);
    if (!has) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 Not Found');
    }
    return sendFile(res, idx);
  }
  return sendFile(res, full, st);
}

function sendFile(res, file, st) {
  const ext = path.extname(file).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  const size = st ? st.size : fs.statSync(file).size;
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': size,
    // 开发用服务：禁用缓存，避免改了前端手机还拿旧文件
    'Cache-Control': 'no-cache'
  });
  fs.createReadStream(file).on('error', () => res.end()).pipe(res);
}

/* ---------------- 服务器 ---------------- */

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const p = url.pathname;

  if (req.method === 'GET' && p === '/api/health') {
    return json(res, 200, {
      ok: true,
      name: 'audio-merge-lab-serve',
      upload: true,
      maxUploadBytes: MAX_UPLOAD,
      keepHours: KEEP_MS / 3600000,
      files: index.size
    });
  }

  if (req.method === 'GET' && p === '/api/files') {
    const list = Array.from(index.entries()).map(([id, r]) => ({
      id: id, name: r.name, size: r.size, mime: r.mime, at: new Date(r.at).toISOString()
    }));
    return json(res, 200, { files: list });
  }

  if (req.method === 'POST' && p === '/api/upload') {
    return handleUpload(req, res, url);
  }

  if (req.method === 'GET' && p.indexOf('/api/file/') === 0) {
    return handleDownload(req, res, p.slice('/api/file/'.length));
  }

  if (req.method === 'DELETE' && p.indexOf('/api/file/') === 0) {
    const id = p.slice('/api/file/'.length);
    if (!isSafeId(id)) return json(res, 400, { error: '非法 id' });
    const rec = index.get(id);
    if (!rec) return json(res, 404, { error: '文件不存在' });
    return fsp.unlink(rec.file).then(() => {
      index.delete(id);
      json(res, 200, { ok: true });
    }).catch(() => json(res, 500, { error: '删除失败' }));
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    return serveStatic(req, res, p);
  }

  json(res, 405, { error: '不支持的方法' });
});

/* ---------------- 启动 ---------------- */

(async function main() {
  await rebuildIndex();
  await sweep();
  const timer = setInterval(sweep, 30 * 60 * 1000);
  timer.unref();

  if (!fs.existsSync(path.join(WEB_DIR, 'index.html'))) {
    console.log('[提示] 未找到 ' + path.join(WEB_DIR, 'index.html') + '，请先执行：node tools/build.js');
  }

  server.listen(PORT, '0.0.0.0', () => {
    const addrs = lanAddresses();
    console.log('============================================================');
    console.log('  Audio Merge Lab · 局域网自托管服务');
    console.log('============================================================');
    console.log('  网页目录   : ' + WEB_DIR);
    console.log('  保存目录   : ' + UPLOAD_DIR + '（' + (KEEP_MS / 3600000) + ' 小时后自动清理）');
    console.log('  本机访问   : http://127.0.0.1:' + PORT);
    if (addrs.length) {
      console.log('  手机访问   : 手机与电脑连同一个 Wi-Fi，浏览器打开：');
      addrs.forEach((a) => console.log('      http://' + a + ':' + PORT));
    } else {
      console.log('  手机访问   : 未探测到局域网 IP');
    }
    console.log('  说明       : iOS 在 Safari 里点「保存为文件」生成的链接，');
    console.log('               即可存到「文件」App（不再交给系统播放器）。');
    console.log('  停止服务   : Ctrl+C');
    console.log('============================================================');
  });

  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
      console.error('[错误] 端口 ' + PORT + ' 已被占用，换一个：node tools/serve.js --port 8020');
      process.exit(1);
    }
    throw err;
  });
})();
