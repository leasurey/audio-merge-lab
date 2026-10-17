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

const inject = [
  ['/*GUARD*/', read('src/boot-guard.js')],
  ['/*VENDOR*/', read('src/vendor/lame.min.js')],
  ['/*MP3DEC*/', 'window.__MP3DEC_B64 = "' + mp3decB64 + '";'],
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
for (const vendorFile of ['src/vendor/lame.min.js', 'src/vendor/mpg123-decoder.min.js']) {
  if (/<script/i.test(read(vendorFile))) {
    throw new Error(vendorFile + ' 含 <script，内联不安全');
  }
}
// 终局校验：产物不得含 NUL（HTML 解析器会把它替换成 U+FFFD）
if (html.indexOf('\u0000') !== -1) {
  throw new Error('产物含 NUL 字符：内联的脚本会被 HTML 解析器破坏');
}
// 启动守卫必须保持纯 ES5：它要在旧内核里执行（旧内核解析不了 app.js 的 ES2017 语法）
const guardSrc = read('src/boot-guard.js');
for (const bad of [/=>/, /\bconst\s/, /\blet\s/, /`/]) {
  if (bad.test(guardSrc)) {
    throw new Error('boot-guard.js 含 ES6+ 语法 ' + bad + '（必须保持 ES5）');
  }
}

fs.mkdirSync(dist('.'), { recursive: true });
fs.writeFileSync(dist('index.html'), html);

/* ---------------- 2. PWA 资源 ---------------- */
fs.copyFileSync(path.join(root, 'src/manifest.webmanifest'), dist('manifest.webmanifest'));
fs.copyFileSync(path.join(root, 'compat.html'), dist('compat.html'));
fs.copyFileSync(path.join(root, 'guide.html'), dist('guide.html'));
fs.copyFileSync(path.join(root, 'convert.html'), dist('convert.html'));

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

/* ---------------- 汇总 ---------------- */
const kb = (n) => (n / 1024).toFixed(1) + ' KB';
console.log('构建完成 (v' + appVersion + '):');
console.log('  dist/index.html            ' + kb(Buffer.byteLength(html)));
console.log('  dist/manifest.webmanifest  ' + kb(fs.statSync(dist('manifest.webmanifest')).size));
console.log('  dist/sw.js                 ' + kb(fs.statSync(dist('sw.js')).size));
for (const [name, bytes] of iconSizes) {
  console.log('  dist/icons/' + name.padEnd(22) + kb(bytes));
}
