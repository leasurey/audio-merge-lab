#!/usr/bin/env node
/**
 * build.js — 构建脚本
 *
 * 1. 将 src/ 下的 CSS/JS（含 vendor/lame.min.js）内联进 index.template.html，
 *    产出单文件 dist/index.html
 * 2. 复制 PWA 资源（manifest）到 dist/，sw.js 注入版本化缓存名
 * 3. 用纯 Node（zlib）生成应用图标 PNG 到 dist/icons/
 *
 * 用法：node tools/build.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const dist = (p) => path.join(root, 'dist', p);

/* ---------------- 1. 单文件 HTML ---------------- */
let html = read('index.template.html');

/* mpg123-decoder 的 wasm 载荷是 String.raw 模板串，其中含裸 NUL(U+0000) 字节。
 * HTML 解析器规范要求把脚本数据中的 U+0000 替换为 U+FFFD —— 直接内联会导致
 * 载荷损坏（运行时 "Decode failed crc32 validation"）。
 * 因此改为 base64 包装：NUL 变成 ASCII 的 'AA=='，HTML 解析器不会再改写；
 * 运行时由 app.js 惰性 atob + TextDecoder + eval 还原（仅兜底解码时执行）。 */
const mp3decSrc = read('src/vendor/mpg123-decoder.min.js');
const mp3decB64 = Buffer.from(mp3decSrc, 'utf8').toString('base64');

/* AAC WASM 解码器（faad2）：安卓平台 AAC 解码器（MediaCodec）会随机丢帧
 * （实测 54.36s 只解出 50.15s 且不报错），WASM 解码全平台一致。 */
const aacdecSrc = read('src/vendor/aac-decoder.min.js');
const aacdecB64 = Buffer.from(aacdecSrc, 'utf8').toString('base64');

const inject = [
  ['/*GUARD*/', read('src/boot-guard.js')],
  ['/*HINT*/', read('src/browser-hint.js')],
  ['/*VENDOR*/', read('src/vendor/lame.min.js')],
  ['/*MP3DEC*/', 'window.__MP3DEC_B64 = "' + mp3decB64 + '";'],
  ['/*AACDEC*/', 'window.__AACDEC_B64 = "' + aacdecB64 + '";'],
  ['/*STYLES*/', read('src/styles.css')],
  ['/*CORE*/', read('src/audio-core.js')],
  ['/*APP*/', read('src/app.js')]
];

for (const [token, content] of inject) {
  if (!html.includes(token)) {
    throw new Error('模板中未找到占位符 ' + token);
  }
  // 函数形式替换，避免内容里的 $ 序列被误解析
  html = html.replace(token, () => content);
}

const leftover = inject.map(([t]) => t).filter((t) => html.includes(t));
if (leftover.length > 0) {
  throw new Error('占位符替换不完整: ' + leftover.join(', '));
}
/* 内联安全检查：真正会让 HTML 解析器提前闭合的是「闭合序列」，
 * 旧检查用 /<script/i 对 '</script>' 返回 false，等于完全没查；
 * 且只检查两个 vendor，自有源码与 CSS 原文也会被内联，必须一并覆盖。 */
const inlinedSources = [
  'src/boot-guard.js',
  'src/browser-hint.js',
  'src/vendor/lame.min.js',
  'src/vendor/mpg123-decoder.min.js',
  'src/vendor/aac-decoder.min.js',
  'src/audio-core.js',
  'src/app.js',
  'src/styles.css'
];
for (const file of inlinedSources) {
  const src = read(file);
  if (/<\/script/i.test(src) || /<\/style/i.test(src)) {
    throw new Error(file + ' 含 </script 或 </style 序列，内联会提前闭合标签');
  }
  if (/<script/i.test(src)) {
    throw new Error(file + ' 含 <script 序列，内联不安全');
  }
}
// 终局校验：产物不得含 NUL（HTML 解析器会把它替换成 U+FFFD）
if (html.indexOf('\u0000') !== -1) {
  throw new Error('产物含 NUL 字符：内联的脚本会被 HTML 解析器破坏');
}

/* 第三方许可文本随单文件产物分发（D11）：
 * dist/index.html 常常被单独转发/离线保存，接收方拿不到仓库里的
 * THIRD-PARTY-NOTICES.md 与 LICENSE。这里把两者以 HTML 注释内联，
 * 并同时复制成独立文件，满足 lamejs(LGPL-3.0) / mpg123-decoder(MIT)
 * 的署名与许可告知要求；转义注释定界符，避免提前闭合。 */
const noticesText = read('THIRD-PARTY-NOTICES.md');
const licenseText = read('LICENSE');
const noticeBlock = (noticesText + '\n\n' + licenseText)
  .replace(/<!--/g, '<! --').replace(/-->/g, '-- >');
if (!html.includes('</head>')) throw new Error('模板中未找到 </head>，无法内联许可声明');
html = html.replace('</head>', () =>
  '\n<!-- Audio Merge Lab · 第三方组件许可声明（随产物分发）\n' + noticeBlock + '\n-->\n</head>');
// 兜底脚本必须保持纯 ES5：它们要在旧内核里执行（旧内核解析不了 app.js 的 ES2017 语法），
// 而微信/QQ 内置浏览器恰好最可能使用旧内核，提示本身不能先倒下。
for (const file of ['src/boot-guard.js', 'src/browser-hint.js']) {
  const src = read(file);
  for (const bad of [/=>/, /\bconst\s/, /\blet\s/, /`/]) {
    if (bad.test(src)) {
      throw new Error(file + ' 含 ES6+ 语法 ' + bad + '（必须保持 ES5）');
    }
  }
}

fs.mkdirSync(dist('.'), { recursive: true });
fs.writeFileSync(dist('index.html'), html);

/* ---------------- 2. PWA 资源 ---------------- */
fs.copyFileSync(path.join(root, 'src/manifest.webmanifest'), dist('manifest.webmanifest'));

/* 子页面：注入共享文档样式（src/doc.css）后写出。
 * 三个页面共用一套语义色/字号/圆角，避免各自维护一份内联样式而逐渐跑偏。 */
const docCss = read('src/doc.css');
const hintSrc = read('src/browser-hint.js');
for (const page of ['compat.html', 'guide.html', 'convert.html']) {
  const src = read(page);
  for (const token of ['/*DOC*/', '/*HINT*/']) {
    if (!src.includes(token)) {
      throw new Error(page + ' 缺少 ' + token + ' 占位符');
    }
  }
  const out = src
    .replace('/*DOC*/', () => docCss)
    .replace('/*HINT*/', () => hintSrc);
  if (out.includes('/*DOC*/') || out.includes('/*HINT*/')) {
    throw new Error(page + ' 占位符替换不完整');
  }
  if (out.indexOf('\u0000') !== -1) throw new Error(page + ' 含 NUL 字节');
  fs.writeFileSync(dist(page), out);
}
// 独立许可文件：静态托管时可直接访问，不依赖单文件 HTML 的注释
fs.copyFileSync(path.join(root, 'THIRD-PARTY-NOTICES.md'), dist('THIRD-PARTY-NOTICES.md'));
fs.copyFileSync(path.join(root, 'LICENSE'), dist('LICENSE'));

// sw.js 缓存名注入 APP_VERSION：缓存名随版本变化，旧缓存自动清除
const coreSrc = read('src/audio-core.js');
const versionMatch = coreSrc.match(/APP_VERSION\s*=\s*'([^']+)'/);
if (!versionMatch) throw new Error('无法从 src/audio-core.js 解析 APP_VERSION');
const appVersion = versionMatch[1];
let swSrc = read('src/sw.js');
if (!swSrc.includes('__CACHE_VERSION__')) {
  throw new Error('sw.js 中未找到 __CACHE_VERSION__ 占位符');
}
swSrc = swSrc.replaceAll('__CACHE_VERSION__', 'audio-merge-lab-v' + appVersion);
if (swSrc.includes('__CACHE_VERSION__')) {
  throw new Error('sw.js 缓存名注入不完整');
}
fs.writeFileSync(dist('sw.js'), swSrc);

/* ---------------- 3. 图标生成（纯 Node PNG 编码器） ---------------- */
function crc32(buf) {
  if (!crc32.table) {
    crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crc32.table[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ crc32.table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function makePNG(size, pixelFn) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  let o = 0;
  for (let y = 0; y < size; y++) {
    raw[o++] = 0; // filter type: none
    for (let x = 0; x < size; x++) {
      const p = pixelFn(x, y);
      raw[o++] = p[0]; raw[o++] = p[1]; raw[o++] = p[2]; raw[o++] = p[3];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

/**
 * 图标像素函数：深色圆角底 + 蓝色圆 + 白色波形条。
 * opts.fullBleed: 背景铺满（maskable / apple-touch-icon）
 * opts.maskable:  内容缩放进 80% 安全区
 */
function iconPixel(size, opts) {
  return function (x, y) {
    const nx = (x + 0.5) / size;
    const ny = (y + 0.5) / size;
    if (!opts.fullBleed) {
      const r = 0.22;
      const dx = Math.max(r - nx, nx - (1 - r), 0);
      const dy = Math.max(r - ny, ny - (1 - r), 0);
      if (dx * dx + dy * dy > r * r) return [0, 0, 0, 0]; // 圆角外透明
    }
    const cx = 0.5;
    const cy = 0.5;
    const rad = opts.maskable ? 0.30 : 0.32;
    const d2 = (nx - cx) * (nx - cx) + (ny - cy) * (ny - cy);
    if (d2 > rad * rad) {
      return opts.maskable ? [15, 17, 21, 255] : [23, 27, 34, 255];
    }
    const scale = opts.maskable ? 0.72 : 1; // 换算进圆内的归一化坐标
    const X = (nx - cx) / (rad * scale);
    const Y = (ny - cy) / (rad * scale);
    const bars = [[-0.62, 0.30], [0, 0.52], [0.62, 0.22]];
    const bw = 0.15;
    for (let i = 0; i < bars.length; i++) {
      if (Math.abs(X - bars[i][0]) <= bw && Math.abs(Y) <= bars[i][1]) {
        return [232, 235, 240, 255]; // 白条
      }
    }
    return [79, 140, 255, 255]; // #4f8cff
  };
}

function writeIcon(name, size, opts) {
  const png = makePNG(size, iconPixel(size, opts));
  const outPath = path.join(dist('.'), 'icons', name);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, png);
  // 结构自检：签名 + IHDR 尺寸
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const head = png.subarray(0, 8);
  const w = png.readUInt32BE(16);
  const h = png.readUInt32BE(20);
  if (!head.equals(sig) || w !== size || h !== size) {
    throw new Error('图标自检失败: ' + name);
  }
  return png.length;
}

const iconSizes = [];
iconSizes.push(['icon-192.png', writeIcon('icon-192.png', 192, {})]);
iconSizes.push(['icon-512.png', writeIcon('icon-512.png', 512, {})]);
iconSizes.push(['icon-maskable-512.png', writeIcon('icon-maskable-512.png', 512, { fullBleed: true, maskable: true })]);
iconSizes.push(['apple-touch-icon.png', writeIcon('apple-touch-icon.png', 180, { fullBleed: true })]);

// 清掉本脚本过去生成、现已不在清单里的旧图标，避免 dist 里堆积过期资源；
// 只删 icons/ 下的 .png，绝不递归删除目录，也不碰使用者自己放的文件。
const wantedIcons = new Set(iconSizes.map((entry) => entry[0]));
for (const old of fs.readdirSync(dist('icons'))) {
  if (/\.png$/i.test(old) && !wantedIcons.has(old)) {
    fs.unlinkSync(path.join(dist('icons'), old));
  }
}

/* ---------------- 汇总 ---------------- */
const kb = (n) => (n / 1024).toFixed(1) + ' KB';
console.log('构建完成 (v' + appVersion + '):');
console.log('  dist/index.html            ' + kb(Buffer.byteLength(html)));
console.log('  dist/manifest.webmanifest  ' + kb(fs.statSync(dist('manifest.webmanifest')).size));
console.log('  dist/sw.js                 ' + kb(fs.statSync(dist('sw.js')).size));
for (const [name, bytes] of iconSizes) {
  console.log('  dist/icons/' + name.padEnd(22) + kb(bytes));
}
