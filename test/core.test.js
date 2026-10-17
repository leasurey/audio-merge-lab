'use strict';
/**
 * core.test.js — audio-core.js 单元测试（Node 运行，无浏览器依赖）
 * 用法：node test/core.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Core = require('../src/audio-core.js');

const OUT_DIR = path.join(__dirname, 'output');
fs.mkdirSync(OUT_DIR, { recursive: true });

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log('  ok - ' + name);
}

console.log('[audio-core] 单元测试开始');

/* ---------- 重采样 ---------- */
test('resampleChannel: 8k→44.1k 输出长度按比例取整', () => {
  const out = Core.resampleChannel(new Float32Array(100), 8000, 44100);
  assert.strictEqual(out.length, Math.round(100 * 44100 / 8000));
});

test('resampleChannel: 同速率原样拷贝', () => {
  const src = new Float32Array([0, 0.5, 1, 0.5]);
  const out = Core.resampleChannel(src, 8000, 8000);
  assert.deepStrictEqual(Array.from(out), Array.from(src));
});

test('resampleChannel: 线性插值中间值正确', () => {
  const src = new Float32Array([0, 1]); // 2Hz→4Hz：应在中点补 0.5
  const out = Core.resampleChannel(src, 2, 4);
  assert.strictEqual(out.length, 4);
  assert.ok(Math.abs(out[0] - 0) < 1e-6);
  assert.ok(Math.abs(out[1] - 0.5) < 1e-6);
  assert.ok(Math.abs(out[2] - 1) < 1e-6);
  assert.ok(Math.abs(out[3] - 1) < 1e-6);
});

/* ---------- 声道/采样率归一 ---------- */
test('conformPcm: 单声道转立体声为复制', () => {
  const pcm = { sampleRate: 8000, channels: [new Float32Array([0.1, 0.2, 0.3])] };
  const out = Core.conformPcm(pcm, 44100, 2);
  assert.strictEqual(out.channels.length, 2);
  assert.strictEqual(out.sampleRate, 44100);
  for (let i = 0; i < out.channels[0].length; i++) {
    assert.strictEqual(out.channels[0][i], out.channels[1][i]);
  }
});

test('conformPcm: 立体声转单声道取平均', () => {
  const pcm = {
    sampleRate: 8000,
    channels: [new Float32Array([0.2, 0.4]), new Float32Array([0.6, 0.8])]
  };
  const out = Core.conformPcm(pcm, 8000, 1);
  assert.strictEqual(out.channels.length, 1);
  // Float32 累加存在 rounding，用误差范围比较
  assert.ok(Math.abs(out.channels[0][0] - 0.4) < 1e-6);
  assert.ok(Math.abs(out.channels[0][1] - 0.6) < 1e-6);
});

/* ---------- 拼接 ---------- */
test('concatSegments: 总长度 = 各段之和 + 间隔', () => {
  const a = { sampleRate: 8000, channels: [new Float32Array(8000).fill(0.1)] };
  const b = { sampleRate: 16000, channels: [new Float32Array(16000).fill(0.2)] };
  const out = Core.concatSegments(
    [{ name: 'a', pcm: a }, { name: 'b', pcm: b }],
    { targetSampleRate: 44100, targetChannels: 1, gapSec: 0.5, fadeMs: 0 }
  );
  const expect = Math.round(44100) + Math.round(44100) + Math.round(0.5 * 44100);
  assert.strictEqual(out.channels[0].length, expect);
  assert.strictEqual(out.channels.length, 1);
  assert.strictEqual(out.channels[0].length / out.sampleRate, 2.5);
});

test('concatSegments: 片段内容按顺序落位', () => {
  const a = { sampleRate: 44100, channels: [new Float32Array(100).fill(0.5)] };
  const b = { sampleRate: 44100, channels: [new Float32Array(100).fill(0.9)] };
  const out = Core.concatSegments([{ name: 'a', pcm: a }, { name: 'b', pcm: b }], { fadeMs: 0 });
  assert.strictEqual(out.channels.length, 2); // 默认目标立体声，单声道复制
  // Float32Array 中的 0.5/0.9 是 Float32 精度，与 JS 字面量有微小差异，用误差比较
  const f = (v) => new Float32Array([v])[0];
  assert.ok(Math.abs(out.channels[0][0] - f(0.5)) < 1e-6);
  assert.ok(Math.abs(out.channels[0][99] - f(0.5)) < 1e-6);
  assert.ok(Math.abs(out.channels[0][100] - f(0.9)) < 1e-6);
  assert.ok(Math.abs(out.channels[0][199] - f(0.9)) < 1e-6);
  assert.ok(Math.abs(out.channels[1][0] - f(0.5)) < 1e-6);
  assert.ok(Math.abs(out.channels[1][199] - f(0.9)) < 1e-6);
});

test('concatSegments: 首尾淡变生效（fadeMs）', () => {
  const a = { sampleRate: 1000, channels: [new Float32Array(1000).fill(0.5)] };
  const out = Core.concatSegments([{ name: 'a', pcm: a }],
    { targetSampleRate: 1000, targetChannels: 1, fadeMs: 100 });
  const ch = out.channels[0];
  assert.strictEqual(ch[0], 0);
  assert.ok(Math.abs(ch[500] - 0.5) < 1e-6);
  assert.strictEqual(ch[999], 0);
});

test('concatSegments: 跳过零长度片段且不产生多余间隔', () => {
  const a = { sampleRate: 44100, channels: [new Float32Array(44100).fill(0.3)] };
  const empty = { sampleRate: 44100, channels: [new Float32Array(0)] };
  const b = { sampleRate: 44100, channels: [new Float32Array(44100).fill(0.6)] };
  const out = Core.concatSegments(
    [{ name: 'a', pcm: a }, { name: 'e', pcm: empty }, { name: 'b', pcm: b }],
    { gapSec: 1, fadeMs: 0 }
  );
  assert.strictEqual(out.channels[0].length, 44100 * 3); // 1s + 1s 间隔 + 1s
  assert.strictEqual(out.channels[0][44100], 0);   // 间隔区
  assert.ok(Math.abs(out.channels[0][88200] - new Float32Array([0.6])[0]) < 1e-6); // B 段起点
});

test('concatSegments: 空列表抛错', () => {
  assert.throws(() => Core.concatSegments([]), /片段列表为空/);
});

test('concatSegments: 不修改输入 PCM', () => {
  const a = { sampleRate: 44100, channels: [new Float32Array(100).fill(0.5)] };
  Core.concatSegments([{ name: 'a', pcm: a }], { fadeMs: 50 });
  assert.strictEqual(a.channels[0][0], 0.5);
  assert.strictEqual(a.channels[0][99], 0.5);
});

/* ---------- 归一化 ---------- */
test('peakNormalize: 峰值拉到目标值', () => {
  // 峰值 0.45 → 目标 0.9，增益 2 倍（低于默认上限 8，不被截断）
  const pcm = { sampleRate: 44100, channels: [new Float32Array([0.2, -0.45, 0.1])] };
  const out = Core.peakNormalize(pcm, 0.9);
  assert.ok(Math.abs(out.channels[0][1] + 0.9) < 1e-6); // Float32 乘法有 rounding
  assert.ok(Math.abs(Core.pcmPeak(out) - 0.9) < 1e-6);
});

test('peakNormalize: 增益超过上限时被截断（默认 8 倍）', () => {
  // 峰值 0.05 → 理论增益 18 倍，超过默认上限 8，应按 8 倍处理
  const pcm = { sampleRate: 44100, channels: [new Float32Array([0.05, -0.02])] };
  const out = Core.peakNormalize(pcm, 0.9);
  assert.ok(Math.abs(Core.pcmPeak(out) - 0.4) < 1e-6); // 0.05 * 8 = 0.4
});

test('peakNormalize: 增益受上限保护', () => {
  const pcm = { sampleRate: 44100, channels: [new Float32Array([0.001])] };
  const out = Core.peakNormalize(pcm, 0.89, 8);
  assert.ok(Math.abs(Core.pcmPeak(out) - 0.008) < 1e-6);
});

test('peakNormalize: 全静音不产生 NaN', () => {
  const pcm = { sampleRate: 44100, channels: [new Float32Array(10)] };
  const out = Core.peakNormalize(pcm, 0.89);
  for (let i = 0; i < out.channels[0].length; i++) {
    assert.strictEqual(out.channels[0][i], 0);
  }
});

/* ---------- WAV 编码 ---------- */
test('encodeWav: RIFF/WAVE 头字段与采样值正确（16bit 立体声）', () => {
  const pcm = {
    sampleRate: 44100,
    channels: [
      new Float32Array([0, 0.5, -0.5, 0.25]),
      new Float32Array([0.1, 0.2, 0.3, 0.4])
    ]
  };
  const wav = Core.encodeWav(pcm, 16);
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const str = (o, n) => {
    let s = '';
    for (let i = 0; i < n; i++) s += String.fromCharCode(view.getUint8(o + i));
    return s;
  };
  assert.strictEqual(str(0, 4), 'RIFF');
  assert.strictEqual(view.getUint32(4, true), 36 + 16);
  assert.strictEqual(str(8, 4), 'WAVE');
  assert.strictEqual(str(12, 4), 'fmt ');
  assert.strictEqual(view.getUint32(16, true), 16);
  assert.strictEqual(view.getUint16(20, true), 1);
  assert.strictEqual(view.getUint16(22, true), 2);
  assert.strictEqual(view.getUint32(24, true), 44100);
  assert.strictEqual(view.getUint32(28, true), 44100 * 4);
  assert.strictEqual(view.getUint16(32, true), 4);
  assert.strictEqual(view.getUint16(34, true), 16);
  assert.strictEqual(str(36, 4), 'data');
  assert.strictEqual(view.getUint32(40, true), 16);
  assert.strictEqual(wav.length, 44 + 16);
  // 交织顺序: frame0(ch0,ch1), frame1(ch0,ch1)...
  assert.strictEqual(view.getInt16(44, true), 0);       // 0
  assert.strictEqual(view.getInt16(46, true), 3276);    // 0.1 * 32767 截断
  assert.strictEqual(view.getInt16(48, true), 16383);   // 0.5 * 32767 截断
  assert.strictEqual(view.getInt16(50, true), 6553);    // 0.2 * 32767 截断
  assert.strictEqual(view.getInt16(52, true), -16384);  // -0.5 * 32768
  assert.strictEqual(view.getInt16(54, true), 9830);    // 0.3 * 32767 截断
});

test('encodeWav: 24bit 长度与块对齐正确', () => {
  const pcm = { sampleRate: 48000, channels: [new Float32Array(10), new Float32Array(10)] };
  const wav = Core.encodeWav(pcm, 24);
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  assert.strictEqual(wav.length, 44 + 10 * 2 * 3);
  assert.strictEqual(view.getUint32(28, true), 48000 * 6);
  assert.strictEqual(view.getUint16(32, true), 6);
  assert.strictEqual(view.getUint16(34, true), 24);
});

test('encodeWav: 不支持的位深抛错', () => {
  const pcm = { sampleRate: 44100, channels: [new Float32Array(1)] };
  assert.throws(() => Core.encodeWav(pcm, 12), /不支持的位深/);
});

/* ---------- 集成：产出文件供 Python 交叉校验 ---------- */
test('集成: 生成合并 WAV + 元数据（供 test/verify_wav.py 校验）', () => {
  const rate = 44100;
  function sine(freq, amp, sec) {
    const len = Math.round(rate * sec);
    const ch = new Float32Array(len);
    for (let i = 0; i < len; i++) ch[i] = amp * Math.sin(2 * Math.PI * freq * i / rate);
    return { sampleRate: rate, channels: [ch, ch.slice()] };
  }
  const a = sine(440, 0.5, 1.0);
  const b = sine(880, 0.2, 1.0);
  const out = Core.concatSegments(
    [{ name: 'a', pcm: a }, { name: 'b', pcm: b }],
    { targetSampleRate: rate, targetChannels: 2, gapSec: 0.5, fadeMs: 8, normalize: true }
  );
  const wav = Core.encodeWav(out, 16);
  const wavPath = path.join(OUT_DIR, 'merge-test.wav');
  fs.writeFileSync(wavPath, Buffer.from(wav.buffer, wav.byteOffset, wav.byteLength));
  const meta = {
    frames: out.channels[0].length,
    sampleRate: rate,
    channels: 2,
    bitDepth: 16,
    durationSec: out.channels[0].length / rate,
    bytes: wav.length,
    peakExpected: 0.89,
    gapStartFrame: Math.round(rate * 1.0),
    gapEndFrame: Math.round(rate * 1.5),
    segmentBStartFrame: Math.round(rate * 1.5)
  };
  fs.writeFileSync(path.join(OUT_DIR, 'merge-test.json'), JSON.stringify(meta, null, 2));
  console.log('     写出 ' + wavPath + ' (' + (wav.length / 1024).toFixed(0) + ' KB)');
});

console.log('[audio-core] 全部通过：' + passed + ' 项测试');
