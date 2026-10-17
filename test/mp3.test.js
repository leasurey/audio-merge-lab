'use strict';
/**
 * mp3.test.js — MP3 编码功能测试
 *
 * 使用官方 zhuker/lamejs（src/vendor/lame.min.js）真实编码，
 * 通过解析 MP3 帧头验证输出合法性（不只是"有字节"）。
 *
 * 前置：src/vendor/lame.min.js 存在（由 GitHub 连接器从官方仓库获取，
 *       完整性以 git blob SHA-1 校验：8dc6b0726388ff75bec69ac55ac5a6cc49e61093）
 * 用法：node test/mp3.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Core = require('../src/audio-core.js');

// lamejs 在浏览器里是全局脚本（function lamejs(){...}lamejs();），
// Node 里用函数作用域求值后取出该对象
const lameSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'vendor', 'lame.min.js'), 'utf8');
const lamejs = new Function(lameSrc + '\n;return lamejs;')();

let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log('  ok - ' + name);
}

/** 解析 MP3 帧序列，返回帧数与消耗字节数 */
function parseFrames(buf) {
  const BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0]; // MPEG1 Layer3
  const SRATES = [44100, 48000, 32000]; // MPEG1
  let pos = 0;
  let frames = 0;
  while (pos + 4 <= buf.length) {
    if (buf[pos] !== 0xFF || (buf[pos + 1] & 0xE0) !== 0xE0) break; // 同步字
    const ver = (buf[pos + 1] >> 3) & 3;   // 3 = MPEG1
    const layer = (buf[pos + 1] >> 1) & 3; // 1 = Layer III
    if (ver !== 3 || layer !== 1) break;
    const brIdx = (buf[pos + 2] >> 4) & 0xF;
    const srIdx = (buf[pos + 2] >> 2) & 3;
    const pad = (buf[pos + 2] >> 1) & 1;
    const bitrate = BITRATES[brIdx] * 1000;
    const srate = SRATES[srIdx];
    if (!bitrate || !srate) break;
    const frameLen = Math.floor((144 * bitrate) / srate) + pad;
    if (frameLen <= 0) break;
    pos += frameLen;
    frames++;
  }
  return { frames: frames, consumed: pos };
}

function sineStereo(freq, amp, sec) {
  const rate = 44100;
  const len = Math.round(rate * sec);
  const ch = new Float32Array(len);
  for (let i = 0; i < len; i++) ch[i] = amp * Math.sin(2 * Math.PI * freq * i / rate);
  return { sampleRate: rate, channels: [ch, ch.slice()] };
}

async function main() {
  console.log('[mp3] 功能测试开始');

  await test('lamejs 加载成功且 API 可用', () => {
    assert.strictEqual(typeof lamejs.Mp3Encoder, 'function');
  });

  await test('floatToInt16: 钳位与量化正确', () => {
    const out = Core.floatToInt16(new Float32Array([0, 0.5, -0.5, 1, -1, 1.5, -1.5]));
    assert.strictEqual(out[0], 0);
    assert.strictEqual(out[1], 16383);  // 0.5 * 32767 截断
    assert.strictEqual(out[2], -16384); // -0.5 * 32768
    assert.strictEqual(out[3], 32767);
    assert.strictEqual(out[4], -32768);
    assert.strictEqual(out[5], 32767);  // 1.5 钳位到 1
    assert.strictEqual(out[6], -32768); // -1.5 钳位到 -1
  });

  await test('encodeMP3: 立体声 128kbps 帧头合法', async () => {
    const pcm = sineStereo(440, 0.5, 1.0);
    const mp3 = await Core.encodeMP3(pcm, { lamejs: lamejs, kbps: 128 });
    assert.ok(mp3 instanceof Uint8Array, '应返回 Uint8Array');
    // 128kbps * 1s ≈ 16KB，留出帧开销余量
    assert.ok(mp3.length > 12000 && mp3.length < 24000, '体积异常: ' + mp3.length);
    assert.strictEqual(mp3[0], 0xFF, '帧同步字第一字节');
    assert.ok(mp3[1] === 0xFB || mp3[1] === 0xFA, 'MPEG1 Layer3 头第二字节: 0x' + mp3[1].toString(16));
    assert.strictEqual(mp3[2] >> 4, 9, '位率索引应为 9（128kbps）');
    assert.strictEqual((mp3[2] >> 2) & 3, 0, '采样率索引应为 0（44100Hz）');
    const info = parseFrames(mp3);
    assert.ok(info.frames >= 35 && info.frames <= 45, '帧数异常: ' + info.frames);
    assert.ok(info.consumed >= mp3.length - 418, '帧序列未覆盖整个文件');
  });

  await test('encodeMP3: 单声道 128kbps', async () => {
    const rate = 44100;
    const len = rate;
    const ch = new Float32Array(len);
    for (let i = 0; i < len; i++) ch[i] = 0.4 * Math.sin(2 * Math.PI * 440 * i / rate);
    const mp3 = await Core.encodeMP3({ sampleRate: rate, channels: [ch] }, { lamejs: lamejs, kbps: 128 });
    assert.strictEqual(mp3[0], 0xFF);
    assert.strictEqual(mp3[2] >> 4, 9);
    assert.ok(mp3.length > 10000 && mp3.length < 22000, '体积异常: ' + mp3.length);
  });

  await test('encodeMP3: 192kbps 位率字段正确', async () => {
    const pcm = sineStereo(440, 0.5, 0.5);
    const mp3 = await Core.encodeMP3(pcm, { lamejs: lamejs, kbps: 192 });
    assert.strictEqual(mp3[2] >> 4, 11, '位率索引应为 11（192kbps）');
  });

  await test('encodeMP3: onProgress 单调递增至 1', async () => {
    const pcm = sineStereo(440, 0.5, 3.0);
    const seen = [];
    await Core.encodeMP3(pcm, {
      lamejs: lamejs, kbps: 128, blockFrames: 1152 * 20,
      onProgress: (p) => seen.push(p)
    });
    assert.ok(seen.length >= 3, '应有多个进度点: ' + seen.length);
    for (let i = 1; i < seen.length; i++) {
      assert.ok(seen[i] > seen[i - 1], '进度应单调递增');
    }
    assert.strictEqual(seen[seen.length - 1], 1, '最终进度应为 1');
  });

  await test('encodeMP3: 取消时抛出 CANCELED', async () => {
    const pcm = sineStereo(440, 0.5, 5.0);
    let calls = 0;
    await assert.rejects(
      () => Core.encodeMP3(pcm, {
        lamejs: lamejs, kbps: 128, blockFrames: 1152 * 10,
        isCanceled: () => (++calls > 2)
      }),
      (err) => err.code === 'CANCELED'
    );
  });

  await test('encodeMP3: 缺少编码器时报错清晰', async () => {
    await assert.rejects(
      () => Core.encodeMP3(sineStereo(440, 0.3, 0.1), {}),
      /缺少 lamejs/
    );
  });

  await test('encodeMP3: 空 PCM 报错', async () => {
    const pcm = { sampleRate: 44100, channels: [new Float32Array(0)] };
    await assert.rejects(() => Core.encodeMP3(pcm, { lamejs: lamejs }), /PCM 为空/);
  });

  console.log('[mp3] 全部通过：' + passed + ' 项测试');
}

main().catch((err) => {
  console.error('[mp3] 测试失败:', err);
  process.exit(1);
});
