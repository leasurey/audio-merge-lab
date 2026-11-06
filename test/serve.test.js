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
    s.setTimeout(5000, () => { s.destroy(); resolve(buf + '\n[TIMEOUT]'); });
  });
}

/** 原始 HTTP 报文（用于构造 chunked 等 fetch 不便发出的请求） */
function rawHttp(text) {
  return new Promise((resolve, reject) => {
    const net = require('net');
    const s = net.connect(PORT, '127.0.0.1', () => { s.write(text); });
    let buf = '';
    s.on('data', (d) => { buf += d.toString(); });
    s.on('end', () => resolve(buf));
    s.on('error', reject);
    s.setTimeout(5000, () => { s.destroy(); resolve(buf + '\n[TIMEOUT]'); });
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

/** 重启索引回归：文件名含 "__" 时，重建索引不能改变 id 或让原链接失效 */
async function runRestartCheck() {
  console.log('\n== 重启索引（文件名含 __）==');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aml-restart-'));
  let port = 9000 + Math.floor(Math.random() * 800);
  let base = `http://127.0.0.1:${port}`;
  const spawnSrv = () => {
    const ch = spawn(process.execPath, [path.join(root, 'tools', 'serve.js'),
      '--port', String(port), '--uploads', dir], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    ch.conflict = false;
    ch.stderr.on('data', (d) => { if (/EADDRINUSE/.test(String(d))) ch.conflict = true; });
    return ch;
  };
  const killSrv = async (ch) => {
    if (!ch || ch.exitCode !== null || ch.signalCode !== null) return;
    const done = new Promise(r => ch.once('exit', r));
    ch.kill();
    await Promise.race([done, new Promise(r => setTimeout(r, 3000))]);
  };
  // X6：随机端口段仍可能撞上本机其它服务；识别 EADDRINUSE 后换端口重试，
  // 而不是把「服务没起来」误判成断言失败。
  const startWithRetry = async () => {
    for (let attempt = 0; attempt < 6; attempt++) {
      const ch = spawnSrv();
      for (let i = 0; i < 50; i++) {
        if (ch.conflict || ch.exitCode !== null) break;
        try { if ((await fetch(base + '/api/health')).ok) return ch; } catch (e) { /* 未就绪 */ }
        await new Promise(r => setTimeout(r, 100));
      }
      await killSrv(ch);
      port = 9000 + Math.floor(Math.random() * 800);
      base = `http://127.0.0.1:${port}`;
    }
    throw new Error('重启检查：端口连续被占用，服务无法启动');
  };
  let srv = null;
  try {
    srv = await startWithRetry();
    const up = await fetch(`${base}/api/upload?name=a__b.wav&mime=audio/wav`,
      { method: 'POST', body: Buffer.from('0123456789') });
    const uploaded = await up.json();
    check('重启前上传成功', up.status === 200 && !!uploaded.id, 'HTTP ' + up.status);
    // X3 回归：非 12 字符 id 的历史文件也应被索引（否则既不进索引、也不被 sweep 清理）
    fs.writeFileSync(path.join(dir, 'short__old.wav'), 'legacy');
    // 过期孤儿文件（符合本服务命名规则、已超过 6 小时）应被 sweep 的磁盘兜底清理
    const orphan = path.join(dir, 'deadbeef__orphan.wav');
    fs.writeFileSync(orphan, 'orphan');
    const oldSec = (Date.now() - 7 * 60 * 60 * 1000) / 1000;
    fs.utimesSync(orphan, oldSec, oldSec);
    // 同目录里使用者自己放的旧文件：既不能进索引，也不能被 sweep 误删
    const foreign = path.join(dir, 'notes__todo.md');
    fs.writeFileSync(foreign, 'not ours');
    fs.utimesSync(foreign, oldSec, oldSec);
    await killSrv(srv);
    srv = await startWithRetry();
    const list = await (await fetch(base + '/api/files')).json();
    check('重启后索引 id 未变化', list.files.some(f => f.id === uploaded.id),
      JSON.stringify(list.files.map(f => ({ id: f.id, name: f.name }))));
    check('重启后原下载链接可用', (await fetch(base + uploaded.url)).status === 200);
    check('重启后短 id 历史文件被索引',
      list.files.some(f => f.id === 'short' && f.name === 'old.wav'),
      JSON.stringify(list.files.map(f => ({ id: f.id, name: f.name }))));
    check('非上传类文件不进索引',
      !list.files.some(f => f.name === 'todo.md'),
      JSON.stringify(list.files.map(f => f.name)));
    check('过期上传孤儿文件已被 sweep 清理', !fs.existsSync(orphan), fs.readdirSync(dir).join(','));
    check('同目录外来旧文件未被误删', fs.existsSync(foreign), fs.readdirSync(dir).join(','));
  } finally {
    await killSrv(srv);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

(async function main() {
  const child = spawn(process.execPath, [path.join(root, 'tools', 'serve.js'),
    '--port', String(PORT), '--uploads', UPLOADS], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = [];
  child.stdout.on('data', (d) => log.push(d.toString()));
  child.stderr.on('data', (d) => log.push(d.toString()));
  // 关键：服务进程意外退出时，旧版测试会因 child.kill() 而毫无察觉
  let stopping = false;
  let crashed = false;
  child.on('exit', () => { if (!stopping) crashed = true; });

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

    const sfx = await fetch(`${BASE}${upJson.url}`, { headers: { Range: 'bytes=-100' } });
    const sfxCr = sfx.headers.get('content-range') || '';
    check('suffix Range 返回末尾 100 字节（RFC 7233）',
      sfx.status === 206 && sfxCr === `bytes ${body.length - 100}-${body.length - 1}/${body.length}`,
      sfxCr);
    const sfxBuf = Buffer.from(await sfx.arrayBuffer());
    check('suffix Range 内容与源文件末尾逐字节一致',
      sfxBuf.length === 100 && sfxBuf.equals(body.subarray(body.length - 100)),
      sfxBuf.length + ' 字节');
    const neg0 = await fetch(`${BASE}${upJson.url}`, { headers: { Range: 'bytes=-0' } });
    check('bytes=-0 返回 416', neg0.status === 416, 'HTTP ' + neg0.status);

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

    console.log('\n== 回归：畸形请求 / 头注入 / chunked ==');
    const badUrl = await rawGet('/%');
    check('GET /% 返回 400 而非进程崩溃', badUrl.startsWith('HTTP/1.1 400'), badUrl.split('\r\n')[0]);
    const badUrl2 = await rawGet('/%E0%A4%A');
    check('截断的百分号编码返回 400', badUrl2.startsWith('HTTP/1.1 400'), badUrl2.split('\r\n')[0]);

    const injResp = await rawHttp(
      'POST /api/upload?name=inject.wav&mime=audio%2Fwav%0d%0aX-Injected%3A%20yes HTTP/1.1\r\n' +
      `Host: 127.0.0.1:${PORT}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
    const injJson = JSON.parse(injResp.split('\r\n\r\n').slice(1).join('\r\n\r\n'));
    check('CRLF 注入的 mime 被清洗为保守类型', injJson.mime === 'application/octet-stream', String(injJson.mime));
    const injDl = await fetch(`${BASE}${injJson.url}`);
    check('注入后下载响应正常', injDl.status === 200, 'HTTP ' + injDl.status);
    check('注入后 Content-Type 合法', injDl.headers.get('content-type') === 'application/octet-stream',
      String(injDl.headers.get('content-type')));
    await fetch(`${BASE}${injJson.url}`, { method: 'DELETE' });

    const chunkResp = await rawHttp(
      'POST /api/upload?name=chunk.wav&mime=audio/wav HTTP/1.1\r\n' +
      `Host: 127.0.0.1:${PORT}\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n` +
      '4\r\nRIFF\r\n' + 'a\r\nabcdefghij\r\n' + '0\r\n\r\n');
    const chunkJson = JSON.parse(chunkResp.split('\r\n\r\n').slice(1).join('\r\n\r\n'));
    check('chunked 上传成功且字节数正确',
      chunkResp.startsWith('HTTP/1.1 200') && chunkJson.size === 14,
      chunkResp.split('\r\n')[0] + ' size=' + chunkJson.size);
    await fetch(`${BASE}${chunkJson.url}`, { method: 'DELETE' });

    // X1/X2 回归：合法带参数/带引号的音频 MIME 必须原样通过，可渲染类型必须被拒
    const mimeCases = [
      ['audio/wav', 'audio%2Fwav', 'audio/wav'],
      ['audio/mpeg', 'audio%2Fmpeg', 'audio/mpeg'],
      ['audio/webm;codecs=opus', 'audio%2Fwebm%3Bcodecs%3Dopus', 'audio/webm;codecs=opus'],
      ['audio/mp4;codecs="mp4a.40.2"', 'audio%2Fmp4%3Bcodecs%3D%22mp4a.40.2%22', 'audio/mp4;codecs="mp4a.40.2"'],
      ['audio/wav; charset=utf-8', 'audio%2Fwav%3B%20charset%3Dutf-8', 'audio/wav; charset=utf-8'],
      ['text/html', 'text%2Fhtml', 'application/octet-stream'],
      ['image/svg+xml', 'image%2Fsvg%2Bxml', 'application/octet-stream'],
      ['application/octet-stream', 'application%2Foctet-stream', 'application/octet-stream']
    ];
    for (const [label, enc, expected] of mimeCases) {
      const up = await fetch(`${BASE}/api/upload?name=m.wav&mime=${enc}`,
        { method: 'POST', body: Buffer.alloc(0) });
      const j = await up.json();
      check('mime 白名单: ' + label, j.mime === expected, String(j.mime));
      if (j.url) await fetch(`${BASE}${j.url}`, { method: 'DELETE' });
    }

    // 省略 mime 时按扩展名回退，也必须经过同一白名单（.html/.svg/.js 不能变可渲染类型）
    for (const ext of ['html', 'svg', 'js', 'wav']) {
      const up = await fetch(`${BASE}/api/upload?name=fallback.${ext}`,
        { method: 'POST', body: Buffer.alloc(0) });
      const j = await up.json();
      const expected = ext === 'wav' ? 'audio/wav' : 'application/octet-stream';
      check('省略 mime 的扩展名回退: .' + ext, j.mime === expected, String(j.mime));
      if (j.url) await fetch(`${BASE}${j.url}`, { method: 'DELETE' });
    }
    // Unicode 行/段分隔符会让 Node 的 writeHead 抛 ERR_INVALID_CHAR，必须被清洗
    const uni = await fetch(`${BASE}/api/upload?name=u.wav&mime=` +
      encodeURIComponent('audio/wav;p="a\u2028b"'),
      { method: 'POST', body: Buffer.alloc(0) });
    const uniJson = await uni.json();
    check('Unicode 行分隔符被清洗', uniJson.mime === 'application/octet-stream', String(uniJson.mime));
    if (uniJson.url) await fetch(`${BASE}${uniJson.url}`, { method: 'DELETE' });

    check('畸形请求后服务进程未意外退出', !crashed, crashed ? '服务曾意外退出' : '');
    const hasCrashLog = log.join('').includes('[serve] 请求处理异常');
    check('服务 stderr 无未捕获异常', !hasCrashLog, hasCrashLog ? '发现异常日志' : '(无异常)');
    check('uploads 目录已清空', fs.readdirSync(UPLOADS).length === 0,
      fs.readdirSync(UPLOADS).join(','));
  } catch (e) {
    console.log('测试异常:', e && e.message ? e.message : e);
    failures++;
  } finally {
    stopping = true;
    child.kill();
    try { fs.rmSync(UPLOADS, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
  }

  try {
    await runRestartCheck();
  } catch (e) {
    console.log('重启索引检查异常:', e && e.message ? e.message : e);
    failures++;
  }

  console.log(`\n结果: ${failures === 0 ? '全部通过' : failures + ' 项失败'}`);
  process.exit(failures === 0 ? 0 : 1);
})();
