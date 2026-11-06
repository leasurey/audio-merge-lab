'use strict';
/**
 * github-push.js — 维护者工具：用本机 Edge 中已登录的 GitHub 会话，
 * 创建仓库并把本项目全部入库文件推送上去（Git Data API，单次提交）。
 *
 * 工作原理：
 *   1. 启动本机 Edge（Chromium 内核，playwright-core 驱动，持久化上下文）；
 *      profile 目录默认固定（可用 GH_PUSH_PROFILE 覆盖），登录态跨运行复用；
 *   2. 用页面检测 github.com 登录态（meta[name=user-login]）；
 *      未登录则等待用户在窗口中手动登录（最多 10 分钟）；
 *   3. API 调用走 context.request（与浏览器上下文共享 cookie，
 *      不受页面 CSP / CORS 限制，cookie 不离开本机）；
 *   4. 建库 → 逐文件建 blob → tree → commit → 建 main 分支 → 验证。
 *
 * 用法（项目根目录）：
 *   npm i -D playwright-core       # 仅维护者需要，不随前端产物分发
 *   node tools/github-push.js
 * 可选环境变量：
 *   GH_PUSH_PROFILE   Edge 持久化 profile 目录
 *   EDGE_PATH         Edge 可执行文件绝对路径
 *   GH_PUSH_PUBLIC=1  显式创建公开仓库（默认创建私有仓库，避免误公开）
 *   GH_PUSH_FILES     逗号分隔的手工文件清单（不读取 git）
 *
 * 注意：本脚本为本地维护工具，不随仓库分发。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

/** playwright-core 是可选维护者依赖：缺失时给可操作提示，而不是 MODULE_NOT_FOUND 堆栈 */
function loadPlaywright() {
  try {
    return require('playwright-core');
  } catch (e) {
    console.error('缺少 playwright-core。请先执行：npm i -D playwright-core');
    console.error('（该依赖只供本维护者工具使用，不随前端产物分发）');
    throw e;
  }
}

const ROOT = path.resolve(__dirname, '..');
const REPO_NAME = 'audio-merge-lab';
const REPO_DESC = '跨平台录音合并工具（iOS / Android / Web）：导入或录音频，本地合并为 WAV / MP3 / M4A。纯前端实现，数据不离开设备。';

/** 版本从核心层单一权威值读取，提交说明不再写死会过时的测试数量 */
function appVersion() {
  const src = fs.readFileSync(path.join(ROOT, 'src/audio-core.js'), 'utf8');
  const m = /APP_VERSION\s*=\s*'([^']+)'/.exec(src);
  if (!m) throw new Error('无法从 src/audio-core.js 解析 APP_VERSION');
  return m[1];
}
const COMMIT_MSG = '录音合并器 V' + appVersion() + '\n\n' +
  '纯前端录音合并工具：导入/录制、剪切、排序、流式合并，输出 WAV / MP3 / M4A。\n' +
  '数据全程留在设备，构建产物为单文件 HTML + PWA 离线资源。\n\n' +
  '- src/audio-core.js：重采样/拼接/归一化/WAV/MP3 编码（APP_VERSION 权威值）\n' +
  '- src/app.js：导入、录音、试听、剪切、导出与局域网下载服务直链\n' +
  '- src/vendor/：lamejs(LGPL-3.0) 与 mpg123-decoder(MIT)，许可见 THIRD-PARTY-NOTICES.md\n' +
  '- tools/：单文件构建、PWA 资源、纯 Node 图标生成、局域网服务\n' +
  '- test/：核心/MP3/服务端自动回归 + Python WAV 交叉校验';

/**
 * 入库文件清单与本地 git 跟踪集保持一致，避免清单停在旧版本导致远端仓库不可构建。
 * 优先 `git ls-files`；无 git 环境时回退到内置清单（覆盖当前全部受控文件）。
 */
const FALLBACK_FILES = [
  '.gitattributes', '.gitignore', 'CHANGELOG.md', 'LICENSE', 'README.md',
  'THIRD-PARTY-NOTICES.md', 'capacitor.config.json', 'compat.html', 'convert.html',
  'docs/maintainer-notes.md', 'guide.html', 'index.template.html', 'package.json',
  'src/app.js', 'src/audio-core.js', 'src/boot-guard.js', 'src/manifest.webmanifest',
  'src/styles.css', 'src/sw.js', 'src/vendor/lame.min.js',
  'src/vendor/mpg123-decoder.min.js', 'test/core.test.js', 'test/mp3.test.js',
  'test/serve.test.js', 'test/verify_wav.py', 'tools/allow_lan.bat', 'tools/build.js',
  'tools/github-create-repo.js', 'tools/github-debug-page.js', 'tools/github-push.js',
  'tools/serve.js', '使用说明.md'
];
function trackedFiles() {
  if (process.env.GH_PUSH_FILES) {
    return process.env.GH_PUSH_FILES.split(',').map((s) => s.trim()).filter(Boolean);
  }
  try {
    const out = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'buffer' });
    const list = out.toString('utf8').split('\0').filter(Boolean)
      .filter((f) => !/(^|\/)\.git(\/|$)/.test(f));
    if (list.length) return list;
  } catch (e) {
    console.log('WARN: 无法读取 git 清单，改用内置清单');
  }
  return FALLBACK_FILES.slice();
}
const FILES = trackedFiles();

const API = 'https://api.github.com';
const H = { 'Accept': 'application/vnd.github+json' };

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function launchEdge(chromium, userDataDir) {
  const opts = {
    headless: false,
    viewport: { width: 1280, height: 900 },
    args: ['--no-first-run', '--no-default-browser-check', '--disable-sync']
  };
  try {
    return await chromium.launchPersistentContext(userDataDir, Object.assign({}, opts, { channel: 'msedge' }));
  } catch (e) {
    console.log('channel 启动失败，改用 executablePath: ' + String(e.message).slice(0, 150));
  }
  // 不再硬编码单一开发者本机绝对路径：环境变量优先，其次探测常见安装位置
  const candidates = [process.env.EDGE_PATH,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].filter(Boolean);
  for (const exe of candidates) {
    if (!fs.existsSync(exe)) continue;
    return await chromium.launchPersistentContext(userDataDir,
      Object.assign({}, opts, { executablePath: exe }));
  }
  throw new Error('找不到 Edge：请设置 EDGE_PATH 指向 msedge.exe 的绝对路径');
}

/** 统一的 API 请求辅助：返回 {status, ok, json|text} */
async function apiCall(req, method, url, data) {
  const opts = { method: method, headers: H };
  if (data !== undefined) opts.data = data;
  const r = await req.fetch(url, opts);
  const ct = r.headers()['content-type'] || '';
  const body = ct.indexOf('application/json') !== -1 ? await r.json() : (await r.text()).slice(0, 500);
  return { status: r.status(), ok: r.ok(), body: body };
}

async function main() {
  const { chromium } = loadPlaywright();
  // 0. 预检文件
  const missing = FILES.filter((f) => !fs.existsSync(path.join(ROOT, f)));
  if (missing.length) {
    console.error('FATAL: 缺少文件: ' + missing.join(', '));
    process.exit(1);
  }

  // 1. 启动 Edge（持久化上下文；固定 profile 目录复用登录态）
  const userDataDir = process.env.GH_PUSH_PROFILE
    ? path.resolve(process.env.GH_PUSH_PROFILE)
    : path.join(os.tmpdir(), 'audio-merge-lab-gh-profile');
  fs.mkdirSync(userDataDir, { recursive: true });
  console.log('PROFILE:' + userDataDir);
  const context = await launchEdge(chromium, userDataDir);
  const req = context.request; // 与浏览器上下文共享 cookie，不受页面 CSP 限制
  const page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();

  const loginOf = () => page.evaluate(() => {
    const m = document.querySelector('meta[name="user-login"]');
    return m && m.content ? m.content : '';
  });

  await page.goto('https://github.com/', { waitUntil: 'domcontentloaded' });
  await sleep(1500);

  // 2. 等待登录
  let login = await loginOf();
  if (!login) {
    console.log('WAIT_LOGIN');
    const deadline = Date.now() + 10 * 60 * 1000;
    while (Date.now() < deadline) {
      await sleep(3000);
      try {
        login = await loginOf();
      } catch (e) { /* 页面导航中，下一轮重试 */ }
      if (login) break;
    }
    if (!login) {
      console.error('ERROR: 登录等待超时（10 分钟）');
      await context.close();
      process.exit(1);
    }
  }
  console.log('LOGGED_IN:' + login);

  // 2.5 预检：API 是否认可会话
  const auth = await apiCall(req, 'GET', API + '/user');
  console.log('API_AUTH:' + auth.status);
  if (!auth.ok || !auth.body || !auth.body.login) {
    console.error('ABORT: api.github.com 不认可当前会话（status=' + auth.status + '）');
    await context.close();
    process.exit(1);
  }
  login = auth.body.login;
  console.log('API_LOGIN:' + login);

  // 3. 创建仓库（201 新建 / 422 已存在）
  const createRes = await apiCall(req, 'POST', API + '/user/repos', {
    name: REPO_NAME,
    description: REPO_DESC,
    // 默认私有：误把草稿/本地配置公开是不可逆的；需公开时显式设 GH_PUSH_PUBLIC=1
    private: process.env.GH_PUSH_PUBLIC !== '1',
    auto_init: false,
    has_issues: true,
    has_wiki: false
  });
  console.log('CREATE_REPO:' + createRes.status);

  // 4. 仓库必须为空才能安全覆盖（非空则中止，避免冲掉已有内容）
  const emptiness = await apiCall(req, 'GET', API + '/repos/' + login + '/' + REPO_NAME + '/commits?per_page=1');
  console.log('REPO_COMMITS_STATUS:' + emptiness.status); // 200=有提交 409=空仓库
  if (createRes.status !== 201 && emptiness.status === 200) {
    console.error('ABORT: 仓库已存在且包含提交，为避免覆盖已有内容，中止推送。请手动处理该仓库。');
    await context.close();
    process.exit(2);
  }
  if (createRes.status !== 201 && createRes.status !== 422) {
    console.error('ABORT: 建库失败 ' + createRes.status + ' ' + JSON.stringify(createRes.body).slice(0, 300));
    await context.close();
    process.exit(1);
  }

  // 5. 读取文件 → base64
  const payload = FILES.map((f) => ({
    path: f,
    content: fs.readFileSync(path.join(ROOT, f)).toString('base64')
  }));
  console.log('FILES:' + payload.length +
    ' TOTAL_B64_BYTES:' + payload.reduce((s, p) => s + p.content.length, 0));

  // 6. blobs → tree → commit → ref
  const base = API + '/repos/' + login + '/' + REPO_NAME;
  const tree = [];
  for (const f of payload) {
    const r = await apiCall(req, 'POST', base + '/git/blobs', {
      content: f.content,
      encoding: 'base64'
    });
    if (!r.ok || !r.body || !r.body.sha) {
      console.error('ABORT: blob 失败 ' + f.path + ' status=' + r.status + ' ' + JSON.stringify(r.body).slice(0, 200));
      await context.close();
      process.exit(1);
    }
    tree.push({ path: f.path, mode: '100644', type: 'blob', sha: r.body.sha });
  }
  console.log('BLOBS_OK:' + tree.length);

  const treeRes = await apiCall(req, 'POST', base + '/git/trees', { tree: tree });
  if (!treeRes.ok || !treeRes.body || !treeRes.body.sha) {
    console.error('ABORT: tree 失败 status=' + treeRes.status + ' ' + JSON.stringify(treeRes.body).slice(0, 200));
    await context.close();
    process.exit(1);
  }
  console.log('TREE:' + treeRes.body.sha.slice(0, 10));

  const commitRes = await apiCall(req, 'POST', base + '/git/commits', {
    message: COMMIT_MSG,
    tree: treeRes.body.sha
  });
  if (!commitRes.ok || !commitRes.body || !commitRes.body.sha) {
    console.error('ABORT: commit 失败 status=' + commitRes.status + ' ' + JSON.stringify(commitRes.body).slice(0, 200));
    await context.close();
    process.exit(1);
  }
  console.log('COMMIT:' + commitRes.body.sha.slice(0, 10));

  // 不做强推：前面的「仓库非空则中止」检查已保证不会覆盖他人提交。
  // 若 ref 已存在但仓库为空（少见），先尝试普通更新，失败则走建 ref 分支。
  let refRes = await apiCall(req, 'PATCH', base + '/git/refs/heads/main', {
    sha: commitRes.body.sha,
    force: false
  });
  if (refRes.status === 404 || refRes.status === 409 || refRes.status === 422) {
    refRes = await apiCall(req, 'POST', base + '/git/refs', {
      ref: 'refs/heads/main',
      sha: commitRes.body.sha
    });
  }
  if (!refRes.ok) {
    console.error('ABORT: ref 失败 status=' + refRes.status + ' ' + JSON.stringify(refRes.body).slice(0, 200));
    await context.close();
    process.exit(1);
  }
  console.log('REF:main OK');

  // 7. 验证
  const v1 = await apiCall(req, 'GET', base + '/contents/README.md');
  const v2 = await apiCall(req, 'GET', base + '/contents/src/vendor/lame.min.js');
  const v3 = await apiCall(req, 'GET', base + '/contents/' + encodeURIComponent('使用说明.md'));
  const v4 = await apiCall(req, 'GET', base + '/contents/tools/build.js');
  console.log('VERIFY: readme=' + v1.status + ' lame=' + v2.status +
    ' cnDoc=' + v3.status + ' build=' + v4.status);
  if (v1.status !== 200 || v2.status !== 200 || v3.status !== 200 || v4.status !== 200) {
    console.error('ABORT: 验证未全部通过');
    await context.close();
    process.exit(1);
  }

  await context.close();
  console.log('DONE https://github.com/' + login + '/' + REPO_NAME);
}

main().catch((e) => {
  console.error('FATAL: ' + (e && e.message ? e.message : e));
  process.exit(1);
});
