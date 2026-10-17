/* V0.3.1 构建校验：结构 + 语法基线（acorn AST）（临时脚本，不入仓） */
const fs = require('fs');
const acorn = require('acorn');

const html = fs.readFileSync('dist/index.html', 'utf8');
const sw = fs.readFileSync('dist/sw.js', 'utf8');
const compat = fs.readFileSync('dist/compat.html', 'utf8');

let fail = 0;
const check = (name, ok, extra) => {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  [' + extra + ']' : ''));
  if (!ok) fail++;
};

/* ---------- 1. 结构 ---------- */
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
check('script 块数量 = 4（守卫/vendor/core/app）', scripts.length === 4, String(scripts.length));
check('版本号 0.3.1', html.includes("APP_VERSION = '0.3.1'"));
check('启动守卫已内联', html.includes('__AML_BOOTED') && html.includes('amlBootError'));
check('兼容模式 input 存在', html.includes('id="fileInputAny"') && !/id="fileInputAny"[^>]*accept/.test(html));
check('兼容模式 label 存在', /<label[^>]*for="fileInputAny"/.test(html));
check('页脚自检链接', html.includes('href="compat.html"'));
check('主 input 仍带 accept', /id="fileInput" class="file-input-hidden" accept=/.test(html));
check('label[for=fileInput] 仍在', /<label[^>]*for="fileInput"/.test(html));
check('dist/compat.html 已复制', fs.existsSync('dist/compat.html'));
check('SW 缓存名含 0.3.1', sw.includes("var CACHE = 'audio-merge-lab-v0.3.1'"));
check('SW 清单含 compat.html', sw.includes("./compat.html"));
check('SW 无未替换占位符', !sw.includes('__CACHE_VERSION__'));
check('无内联 onclick 属性（模板层）', !/onclick="/.test(html));
check('CSS 花括号配平', (() => {
  const css = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map(m => m[1]).join('');
  return (css.match(/{/g) || []).length === (css.match(/}/g) || []).length;
})());

/* ---------- 2. 语法基线：acorn AST ---------- */
function parse(name, code, version) {
  try {
    acorn.parse(code, { ecmaVersion: version, sourceType: 'script' });
    return true;
  } catch (e) {
    console.log('     ' + name + ' @ES' + version + ' 解析失败: ' + e.message);
    return false;
  }
}
// 守卫必须 ES5
check('守卫 script#1 可按 ES5 解析', parse('guard', scripts[0], 5));
// vendor / core / app 需 ES2017
check('vendor script#2 可按 ES2017 解析', parse('vendor', scripts[1], 2017));
check('core   script#3 可按 ES2017 解析', parse('core', scripts[2], 2017));
check('app    script#4 可按 ES2017 解析', parse('app', scripts[3], 2017));
// 反证：app 不应还能通过 ES2016（确认基线确实是 2017 而非更低——若通过说明可进一步降级）
let appIsEs2016 = true;
try { acorn.parse(scripts[3], { ecmaVersion: 2016 }); } catch (e) { appIsEs2016 = false; }
console.log('     参考：app 是否可用 ES2016 解析 = ' + appIsEs2016 + '（false 表示 async/await 是唯一超线项）');
// for-await 不应再出现（ES2018）
check('产物无 for await（ES2018 语法）', !/for\s+await/.test(scripts[3]));

// compat.html 内联脚本必须 ES5
const compatScript = (compat.match(/<script>([\s\S]*?)<\/script>/) || [])[1] || '';
check('compat.html 脚本可按 ES5 解析', compatScript.length > 500 && parse('compat', compatScript, 5));

/* ---------- 3. 测试与体积 ---------- */
console.log('HTML ' + (Buffer.byteLength(html) / 1024).toFixed(1) + ' KB，compat ' + (Buffer.byteLength(compat) / 1024).toFixed(1) + ' KB');
process.exit(fail ? 1 : 0);
