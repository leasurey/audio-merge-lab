'use strict';
/**
 * ui.test.js — 主页契约 / 样式 / 构建产物 / 维护者工具 的静态回归
 *
 * 依赖 `node tools/build.js` 先产出 dist/（npm test 已包含构建步骤）。
 * 覆盖历史上被 UI 重写、深色模式、构建链与部署清单改动破坏过的契约，
 * 目的是让「改了样式却丢功能」「产物缺许可文本」「推送清单过时」这类问题
 * 在 npm test 阶段就失败，而不是等到真机或发布后才发现。
 *
 * 用法：node test/ui.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(root, p));

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log('  ok - ' + name);
}

const html = read('index.template.html');
const app = read('src/app.js');
const css = read('src/styles.css');
const guard = read('src/boot-guard.js');
const sw = read('src/sw.js');
const serve = read('tools/serve.js');
const push = read('tools/github-push.js');
const pkg = JSON.parse(read('package.json'));

console.log('[ui/build] 静态契约检查开始');

/* ---------- 1. 构建占位符与 DOM 契约 ---------- */
test('模板 6 个构建占位符存在且唯一', () => {
  ['/*GUARD*/', '/*VENDOR*/', '/*MP3DEC*/', '/*STYLES*/', '/*CORE*/', '/*APP*/'].forEach((t) => {
    assert.strictEqual(html.split(t).length - 1, 1, t + ' 应恰好出现一次');
  });
});

test('app.js 引用的 DOM id 全部在模板中定义', () => {
  const ids = Array.from(new Set(
    Array.from(app.matchAll(/\$\('([^']+)'\)/g), (m) => m[1])
  )).sort();
  const defined = new Set(Array.from(html.matchAll(/\bid="([^"]+)"/g), (m) => m[1]));
  const missing = ids.filter((id) => !defined.has(id));
  assert.ok(ids.length >= 30, '应确实扫描到 DOM 引用，实际 ' + ids.length);
  assert.deepStrictEqual(missing, [], '缺失 id: ' + missing.join(', '));
});

test('模板内 id 无重复', () => {
  const all = Array.from(html.matchAll(/\bid="([^"]+)"/g), (m) => m[1]);
  assert.strictEqual(new Set(all).size, all.length, '存在重复 id');
});

test('关键交互结构契约（label[for] / 格式按钮 / 结果区）', () => {
  assert.match(html, /<label[^>]*id="btnImport"[^>]*for="fileInput"/,
    'iOS WKWebView 需要 label[for] 激活 file input');
  assert.match(html, /data-fmt="mp3"/);
  assert.match(html, /id="bitrateSel"/);
  ['fileInputAny', 'progressWrap', 'status', 'resultBox', 'actionBar', 'btnMerge', 'saveLink']
    .forEach((id) => assert.ok(html.includes('id="' + id + '"'), '缺少 #' + id));
});

/* ---------- 2. 深浅色与布局（含用户反馈的码率下拉同色问题） ---------- */
test('CSS 提供 light / dark 两套 color-scheme', () => {
  assert.match(css, /:root\s*\{[^}]*color-scheme:\s*light/s, '浅色模式需声明 color-scheme: light');
  assert.match(css, /prefers-color-scheme:\s*dark[\s\S]*?:root\s*\{[^}]*color-scheme:\s*dark/s,
    '深色模式需声明 color-scheme: dark，否则 UA 会用浅色画原生 option 列表');
});

test('select 与 option 使用不透明卡片底色 + 显式文字色（明暗各一套）', () => {
  assert.match(css, /select\s*\{[^}]*background-color:\s*var\(--card\)/s);
  assert.match(css, /select option,\s*select optgroup\s*\{[^}]*background-color:\s*var\(--card\)[^}]*color:\s*var\(--label\)/s,
    'option 必须显式配色，否则深色下白字会落在 UA 绘制的浅底上');
  assert.strictEqual((css.match(/--select-chevron:/g) || []).length, 2,
    '明暗两套下拉箭头都要定义');
  assert.match(css, /select:disabled/);
});

test('[hidden] 全局兜底与关键动态类样式仍存在', () => {
  assert.match(css, /\[hidden\][^{]*\{[^}]*display:\s*none/);
  ['.seg-warn', '.trim-num', '.trim-range', '.seg-actions', '.seg-drag']
    .forEach((c) => assert.ok(css.includes(c), '缺少样式 ' + c));
});

test('窄屏：剪切面板列不再被挤压，位率行单列、操作按钮换行', () => {
  assert.match(css, /@media \(max-width:\s*480px\)[\s\S]*?\.opt-row-select\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  assert.match(css, /@media \(max-width:\s*480px\)[\s\S]*?\.seg-actions\s*\{[^}]*grid-column:\s*1 \/ -1/);
  assert.match(css, /@media \(max-width:\s*400px\)[\s\S]*?\.opt-row-select\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  assert.match(html, /class="opt-row opt-row-select" id="bitrateRow"/);
});

test('CSS 花括号配对且不含会提前闭合标签的序列', () => {
  assert.strictEqual((css.match(/\{/g) || []).length, (css.match(/\}/g) || []).length);
  ['</script', '</style', '<script'].forEach((s) => {
    assert.ok(!css.toLowerCase().includes(s), '内联 CSS 不能含 ' + s);
  });
});

/* ---------- 3. 构建产物（需先 npm run build） ---------- */
test('dist 产物存在且无残留占位符', () => {
  assert.ok(exists('dist/index.html'), '缺少 dist/index.html，请先运行 node tools/build.js');
  const out = read('dist/index.html');
  ['/*GUARD*/', '/*VENDOR*/', '/*MP3DEC*/', '/*STYLES*/', '/*CORE*/', '/*APP*/', '__CACHE_VERSION__']
    .forEach((t) => assert.ok(!out.includes(t), '产物残留 ' + t));
  assert.ok(!out.includes('\u0000'), '产物含 NUL');
});

test('第三方许可文本随单文件产物分发，且独立副本存在', () => {
  const out = read('dist/index.html');
  assert.ok(out.includes('THIRD-PARTY-NOTICES'), '单文件产物必须内联许可声明');
  assert.ok(out.includes('LGPL-3.0') && out.includes('MIT'), '产物需含组件许可标识');
  assert.ok(exists('dist/THIRD-PARTY-NOTICES.md'));
  assert.ok(exists('dist/LICENSE'));
});

test('PWA 缓存清单含 maskable 图标，sw.js 缓存名已注入版本', () => {
  assert.ok(sw.includes('icon-maskable-512.png'));
  assert.ok(exists('dist/icons/icon-maskable-512.png'));
  const distSw = read('dist/sw.js');
  assert.ok(!distSw.includes('__CACHE_VERSION__'));
  assert.match(distSw, /audio-merge-lab-v\d+\.\d+\.\d+/);
});

/* ---------- 4. 维护者工具与部署链 ---------- */
test('github-push 文件清单跟随 git、不做 force push、Edge 路径可配置', () => {
  assert.ok(push.includes('git ls-files'), '清单必须由 git 跟踪集生成，避免停在旧版本');
  assert.ok(push.includes('force: false'), '默认不得强推');
  assert.ok(push.includes('EDGE_PATH') && push.includes('GH_PUSH_PUBLIC'),
    'Edge 路径与公开开关应可配置');
  assert.ok(!push.includes('NODE_PATH=C:\\Users\\k'), '不得残留开发者本机 NODE_PATH 提示');
  assert.ok(push.includes('loadPlaywright'), 'playwright-core 缺失时应给可操作提示');
});

test('package.json：test 自包含构建与全部测试，verify 串联测试', () => {
  assert.ok(pkg.scripts.test.includes('tools/build.js'));
  ['core.test.js', 'mp3.test.js', 'serve.test.js', 'ui.test.js'].forEach((f) => {
    assert.ok(pkg.scripts.test.includes(f), 'test 未包含 ' + f);
  });
  assert.ok(pkg.scripts.verify.includes('npm test') && pkg.scripts.verify.includes('verify_wav.py'));
  assert.ok(pkg.scripts['cap:add:android'].includes('npm run build'));
  assert.ok(pkg.devDependencies['playwright-core'], '维护者工具依赖需声明');
});

test('boot-guard 监听 unhandledrejection 且保持 ES5', () => {
  assert.ok(guard.includes('unhandledrejection'));
  [/=>/, /\bconst\s/, /\blet\s/, /`/].forEach((bad) => {
    assert.ok(!bad.test(guard), '启动守卫不能含 ES6+ 语法 ' + bad);
  });
});

test('serve.js：上传异常路径可 settle、文件流有错误兜底、孤儿清理限定命名规则', () => {
  assert.ok(serve.includes("req.on('aborted'"));
  assert.ok(serve.includes('__ABORTED__'), 'aborted 必须让上传 Promise settle');
  assert.ok(serve.includes('function pipeFile'), '流式阶段错误需要独立兜底');
  assert.ok(serve.includes('uploadNameParts'), '索引与清理需限定本服务生成的文件');
});

test('app.js：导出通道可复位、上传有锁与超时、状态机关键防护在位', () => {
  ['setServerReady', 'uploadState.busy', 'xhr.timeout', 'recordPending',
    'pendingRender', 'removeFile', 'reportDecodeStatus', 'probeDownloadServer']
    .forEach((s) => assert.ok(app.includes(s), '缺少 ' + s));
  assert.ok(!app.includes('mergedOpfsName'), '不应残留未使用的 OPFS 状态');
});

test('.gitattributes 覆盖 .webmanifest / .svg，guide 不再声称随时可切格式', () => {
  const attr = read('.gitattributes');
  assert.ok(attr.includes('*.webmanifest'));
  assert.ok(attr.includes('*.svg'));
  assert.ok(!read('guide.html').includes('格式可随时切换'));
});

test('compat.html 区分 CSP 受限与内核不支持', () => {
  const compat = read('compat.html');
  assert.ok(compat.includes('evalAllowed'));
  assert.ok(compat.includes('unknownCount'));
  assert.ok(compat.includes("ok === null"), '受限项不得被判成缺失');
});

test('录音容器按平台排序：非 iOS 优先 opus，iOS 才优先 mp4', () => {
  assert.ok(app.includes('function mimeCandidates'), '录音容器候选需集中一处，便于按平台排序');
  assert.ok(app.includes('var candidates = mimeCandidates()'), 'pickMimeType 必须消费 mimeCandidates');

  // 定位「非 iOS」那一支的候选数组（mimeCandidates 内、isIOSDevice 之后的第一处 return [）
  const fnAt = app.indexOf('function mimeCandidates');
  assert.ok(fnAt > 0);
  const body = app.slice(fnAt, app.indexOf('function pickMimeType'));
  const iosEnd = body.indexOf('}\n    return [');
  assert.ok(iosEnd > 0, '应能在 iOS 分支之后找到非 iOS 候选列表');
  const list = body.slice(iosEnd, body.indexOf('];', iosEnd));
  const webmAt = list.indexOf("'audio/webm;codecs=opus'");
  const mp4At = list.indexOf("'audio/mp4;codecs=mp4a.40.2'");
  assert.ok(webmAt > 0 && mp4At > 0, '非 iOS 候选需同时包含 webm/opus 与 mp4');
  assert.ok(webmAt < mp4At, '非 iOS 必须优先 webm/opus，mp4 只能作为后备');
});

test('录音完整性校验：录制时长与解码时长偏差过大要给出警示', () => {
  assert.ok(app.includes('expectDuration'), '缺少预期时长字段');
  assert.ok(app.includes('[recordedSec]'), '录音入队需传入实际录制时长');
  assert.ok(app.includes('实际只解出'), '缺少时长偏差提示文案');
});

test('OPFS 同步写入必须处理部分写入（否则安卓上数据整体错位）', () => {
  // write() 允许只写一部分并返回字节数；丢弃返回值会让后续数据前移，
  // WAV 采样错位、成品短于头部声明。必须按偏移循环写完。
  assert.ok(app.includes('while (off < bytes.byteLength)'), '缺少部分写入的重试循环');
  assert.ok(app.includes('access.write(chunk, { at: writePos + off })'), '需用显式偏移写入');
  assert.ok(app.includes("if (!n || n <= 0)"), '写入 0 字节必须报错，不能静默丢数据');
});

console.log('[ui/build] 全部通过：' + passed + ' 项检查');
