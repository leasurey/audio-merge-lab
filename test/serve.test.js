#!/usr/bin/env node
/**
 * serve.test.js — 局域网下载服务（tools/serve.js）端到端测试
 *
 * 自启服务 → 走真实的 HTTP 上传/下载 → 断言响应头 → 关闭服务。
 * 用随机端口与临时上传目录，不污染仓库，也不影响正在运行的服务。
 *
 * 用法：node test/serve.test.js
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const root = path.resolve(__dirname, '..');
let failures = 0;

function check(label, cond, extra) {
  console.log(`  ${cond ? '✓' : '✗'} ${label}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
}

const PORT = 8100 + Math.floor(Math.random() * 800);
const BASE = `http://127.0.0.1:${PORT}`;
const UPLOADS = fs.mkdtempSync(path.join(os.tmpdir(), 'aml-uploads-'));

/** 原始 HTTP 请求：保留路径里的 ../ 不被客户端规范化 */
function rawGet(rawPath) {
  return new Promise((resolve, reject) => {
    const net = require('net');
    const s = net.connect(PORT, '127.0.0.1', () => {
      s.write(`GET ${rawPath} HTTP/1.1\r\nHost: 127.0.0.1:${PORT}\r\nConnection: close\r\n\r\n`);
    });
    let buf = '';
    s.on('data', (d) => { buf += d.toString(); });
    s.on('end', () => resolve(buf));
    s.on('error', reject);
  });
}

async function waitHealth(timeoutMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return await r.json();
    } catch (e) { /* 服务还没起来 */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('服务在超时时间内未就绪');
}

(async function main() {
  const child = spawn(process.execPath, [path.join(root, 'tools', 'serve.js'),
    '--port', String(PORT), '--uploads', UPLOADS], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = [];
  child.stdout.on('data', (d) => log.push(d.toString()));
  child.stderr.on('data', (d) => log.push(d.toString()));

  try {
    console.log('== 启动与探测 ==');
    const health = await waitHealth();
    check('GET /api/health 返回 ok', health.ok === true && health.upload === true, JSON.stringify(health));
    check('启动横幅打印端口', log.join('').includes(String(PORT)));

    console.log('\n== 静态托管 ==');
    const idx = await fetch(`${BASE}/`);
    const html = await idx.text();
    check('GET / 返回首页', idx.ok && html.includes('<title>'), `${html.length} 字节`);
    check('首页含保存区元素', html.includes('saveLink') && html.includes('btnSaveFile'));

    console.log('\n== 上传 ==');
    // 造一段带 RIFF 头的假 WAV，便于验证 Content-Type 与文件完整落盘
    const payload = crypto.randomBytes(200 * 1024);
    const body = Buffer.concat([Buffer.from('RIFF____WAVEfmt '), payload]);
    const name = '合并结果 测试 2026.wav';
    const upUrl = `${BASE}/api/upload?name=${encodeURIComponent(name)}&mime=${encodeURIComponent('audio/wav')}`;
    const up = await fetch(upUrl, { method: 'POST', body, headers: { 'Content-Type': 'audio/wav' } });
    const upJson = await up.json();
    check('POST /api/upload 返回 200', up.status === 200, `HTTP ${up.status}`);
    check('返回 id / url / name', !!upJson.id && !!upJson.url && upJson.name === name, JSON.stringify(upJson));
    check('大小一致', upJson.size === body.length, `${upJson.size} / ${body.length}`);
    check('落盘文件名保留中文', fs.readdirSync(UPLOADS).some((f) => f.includes('合并结果')),
      fs.readdirSync(UPLOADS).join(','));

    console.log('\n== 下载响应头 ==');
    const dl = await fetch(`${BASE}${upJson.url}`);
    const cd = dl.headers.get('content-disposition') || '';
    check('下载返回 200', dl.status === 200, `HTTP ${dl.status}`);
    check('Content-Disposition 为 attachment', cd.startsWith('attachment'), cd.slice(0, 40));
    check('含 RFC 5987 中文名', cd.includes("filename*=UTF-8''%") && cd.includes('%E5%90%88'), cd.slice(0, 90));
    check('Content-Type 正确', dl.headers.get('content-type') === 'audio/wav', dl.headers.get('content-type'));
    check('支持断点续传（Accept-Ranges）', dl.headers.get('accept-ranges') === 'bytes');
    const got = Buffer.from(await dl.arrayBuffer());
    check('内容完整', got.length === body.length && got.equals(body), `${got.length} 字节`);

    console.log('\n== Range 请求 ==');
    const rng = await fetch(`${BASE}${upJson.url}`, { headers: { Range: 'bytes=0-99' } });
    const cr = rng.headers.get('content-range') || '';
    check('Range 返回 206', rng.status === 206, `HTTP ${rng.status}`);
    check('Content-Range 正确', cr === `bytes 0-99/${body.length}`, cr);
    const part = Buffer.from(await rng.arrayBuffer());
    check('分片内容一致', part.length === 100 && part.equals(body.subarray(0, 100)));

    console.log('\n== 安全边界 ==');
    const bad1 = await fetch(`${BASE}/api/file/..%2F..%2Fpackage.json`);
    check('非法 id 被拒（路径穿越）', bad1.status === 400 || bad1.status === 404, `HTTP ${bad1.status}`);
    const bad2 = await fetch(`${BASE}/api/file/nonexistent-id`);
    check('不存在的 id 返回 404', bad2.status === 404, `HTTP ${bad2.status}`);
    // HTTP 客户端会把 "/../x" 规范化成 "/x"，测不出真实防护；这里用原始 socket 发未规范化的路径
    // 说明：WHATWG URL 会先把 "/../x" 规范化成 "/x"，服务端收到的已是 /package.json，
    // dist 下没有该文件 → 回落首页（200）。关键是内容不含仓库文件。
    const raw = await rawGet('/../package.json');
    check('未规范化路径不泄露仓库文件', !raw.includes('"name": "audio-merge-lab"'),
      raw.split('\r\n')[0] + '（SPA 回落首页）');
    const raw2 = await rawGet('/%2e%2e%2f%2e%2e%2fpackage.json');
    check('URL 编码的穿越同样被拒', !raw2.includes('"name": "audio-merge-lab"'),
      raw2.split('\r\n')[0]);

    console.log('\n== 列表与删除 ==');
    const list = await (await fetch(`${BASE}/api/files`)).json();
    check('GET /api/files 列出已上传文件', list.files.length === 1, JSON.stringify(list.files.map((f) => f.name)));
    const del = await fetch(`${BASE}${upJson.url}`, { method: 'DELETE' });
    check('DELETE 返回 ok', del.ok && (await del.json()).ok === true);
    check('删除后文件不在磁盘', fs.readdirSync(UPLOADS).length === 0);
  } catch (e) {
    console.log('测试异常:', e && e.message ? e.message : e);
    failures++;
  } finally {
    child.kill();
    try { fs.rmSync(UPLOADS, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
  }

  console.log(`\n结果: ${failures === 0 ? '全部通过' : failures + ' 项失败'}`);
  process.exit(failures === 0 ? 0 : 1);
})();
