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

/* ---------- 目标采样率选择 ---------- */
test('pickTargetRate: 空输入回落 44100', () => {
  assert.strictEqual(Core.pickTargetRate([]), 44100);
});

test('pickTargetRate: 单一标准采样率直接沿用（免重采样）', () => {
  assert.strictEqual(Core.pickTargetRate([48000]), 48000);
  assert.strictEqual(Core.pickTargetRate([44100]), 44100);
  assert.strictEqual(Core.pickTargetRate([32000]), 32000);
  assert.strictEqual(Core.pickTargetRate([48000, 48000, 48000]), 48000);
});

test('pickTargetRate: 混合采样率回落 44100', () => {
  assert.strictEqual(Core.pickTargetRate([48000, 44100]), 44100);
  assert.strictEqual(Core.pickTargetRate([44100, 48000]), 44100);
});

test('pickTargetRate: 非标准采样率重采样到 44100', () => {
  assert.strictEqual(Core.pickTargetRate([22050]), 44100);
  assert.strictEqual(Core.pickTargetRate([8000, 8000]), 44100);
  assert.strictEqual(Core.pickTargetRate([96000]), 44100);
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

/* ---------- V0.3.0 流式合并基础件 ---------- */

function sine(rate, freq, amp, len) {
  const ch = new Float32Array(len);
  for (let i = 0; i < len; i++) ch[i] = amp * Math.sin(2 * Math.PI * freq * i / rate);
  return ch;
}

test('buildWavHeader: 与 encodeWav 头部逐字节一致', () => {
  const pcm = { sampleRate: 48000, channels: [new Float32Array(100), new Float32Array(100)] };
  const wav = Core.encodeWav(pcm, 16);
  const header = Core.buildWavHeader(100, 48000, 2, 16);
  assert.strictEqual(header.length, 44);
  assert.deepStrictEqual(Array.from(header), Array.from(wav.subarray(0, 44)));
  const view = new DataView(header.buffer);
  assert.strictEqual(view.getUint32(4, true), 36 + 400); // 文件大小 - 8
  assert.strictEqual(view.getUint32(24, true), 48000);
  assert.strictEqual(view.getUint32(28, true), 48000 * 4); // 字节率
  assert.strictEqual(view.getUint16(32, true), 4);        // 块对齐
});

test('buildWavHeader: 不支持的位深抛错', () => {
  assert.throws(() => Core.buildWavHeader(10, 44100, 2, 12));
});

test('conformedFrameCount: 与 conformPcm+resampleChannel 长度一致', () => {
  const cases = [[100, 8000, 44100], [44100, 44100, 44100], [48000, 48000, 44100], [1, 48000, 44100], [0, 44100, 44100]];
  for (const [len, from, to] of cases) {
    const pcm = { sampleRate: from, channels: [new Float32Array(len)] };
    const expected = Core.conformPcm(pcm, to, 1).channels[0].length;
    assert.strictEqual(Core.conformedFrameCount(pcm, to), expected, `len=${len} ${from}->${to}`);
  }
});

test('createSegmentConverter: 分块（非对齐边界）与一次性 concatSegments 一致', () => {
  const rate = 48000;
  const a = { sampleRate: rate, channels: [sine(rate, 440, 0.5, rate)] };                 // 1s 单声道
  const b = { sampleRate: rate, channels: [sine(rate, 880, 0.3, rate / 2), sine(rate, 220, 0.2, rate / 2)] }; // 0.5s 立体声
  const opts = { targetSampleRate: rate, targetChannels: 2, gapSec: 0.25, fadeMs: 8, normalize: true };
  const segs = [{ name: 'a', pcm: a }, { name: 'b', pcm: b }];
  const merged = Core.concatSegments(segs, opts);
  const plan = Core.planMerge(segs, opts);
  // 复算全局增益（与 concatSegments 同语义）
  let peak = 0;
  for (const p of plan.parts) {
    peak = Math.max(peak, Core.segmentPeakAfterFade(segs[p.index].pcm, rate, 2, 8));
  }
  const gain = Math.min(0.89 / peak, 8);
  let offset = 0;
  for (const p of plan.parts) {
    const conv = Core.createSegmentConverter(segs[p.index].pcm, {
      targetRate: rate, targetChannels: 2, gain: gain, fadeMs: 8, int16: false
    });
    assert.strictEqual(conv.outFrames, p.outFrames);
    const outChs = [new Float32Array(conv.outFrames), new Float32Array(conv.outFrames)];
    let done = 0;
    while (done < conv.outFrames) { // 997 帧非对齐块，验证块边界无接缝
      const end = Math.min(done + 997, conv.outFrames);
      conv.convert(done, end, [outChs[0].subarray(done, end), outChs[1].subarray(done, end)]);
      done = end;
    }
    for (let c = 0; c < 2; c++) {
      for (let i = 0; i < conv.outFrames; i++) {
        assert.ok(Math.abs(outChs[c][i] - merged.channels[c][offset + i]) <= 1e-6,
          `段${p.index} 声道${c} 帧${i}: ${outChs[c][i]} vs ${merged.channels[c][offset + i]}`);
      }
    }
    offset += p.outFrames + plan.gapFrames;
  }
});

test('createSegmentConverter: int16 模式与 floatToInt16 参考一致（±1 LSB）', () => {
  const rate = 48000;
  const pcm = { sampleRate: rate, channels: [sine(rate, 440, 0.6, rate)] };
  // 参考路径：conformPcm → 手动淡变（同 applyFadeInOut 公式）→ ×gain → floatToInt16
  const conf = Core.conformPcm(pcm, rate, 2);
  const fadeLen = Math.min(Math.floor(8 / 1000 * rate), Math.floor(rate / 2));
  for (const ch of conf.channels) {
    for (let i = 0; i < fadeLen; i++) {
      const g = i / fadeLen;
      ch[i] *= g;
      ch[ch.length - 1 - i] *= g;
    }
  }
  const gain = 0.7;
  const ref = conf.channels.map((ch) => {
    const d = new Float32Array(ch.length);
    for (let i = 0; i < ch.length; i++) d[i] = ch[i] * gain;
    return Core.floatToInt16(d);
  });
  const conv = Core.createSegmentConverter(pcm, {
    targetRate: rate, targetChannels: 2, gain: gain, fadeMs: 8, int16: true
  });
  const outChs = [new Int16Array(conv.outFrames), new Int16Array(conv.outFrames)];
  let done = 0;
  while (done < conv.outFrames) {
    const end = Math.min(done + 4099, conv.outFrames);
    conv.convert(done, end, [outChs[0].subarray(done, end), outChs[1].subarray(done, end)]);
    done = end;
  }
  for (let c = 0; c < 2; c++) {
    for (let i = 0; i < conv.outFrames; i++) {
      assert.ok(Math.abs(outChs[c][i] - ref[c][i]) <= 1, `声道${c} 帧${i}: ${outChs[c][i]} vs ${ref[c][i]}`);
    }
  }
});

test('createSegmentConverter: 重采样 48k→44.1k 与 resampleChannel 一致', () => {
  const pcm = { sampleRate: 48000, channels: [sine(48000, 440, 0.5, 48000)] };
  const conv = Core.createSegmentConverter(pcm, { targetRate: 44100, targetChannels: 2, fadeMs: 0, int16: false });
  assert.strictEqual(conv.outFrames, Math.round(48000 * 44100 / 48000));
  const ref = Core.resampleChannel(pcm.channels[0], 48000, 44100);
  const out = new Float32Array(conv.outFrames);
  conv.convert(0, conv.outFrames, [out, new Float32Array(conv.outFrames)]);
  for (let i = 0; i < conv.outFrames; i++) {
    assert.ok(Math.abs(out[i] - ref[i]) <= 1e-6, `帧${i}: ${out[i]} vs ${ref[i]}`);
  }
});

test('createSegmentConverter: 空片段 outFrames=0 且 convert 安全返回', () => {
  const pcm = { sampleRate: 44100, channels: [new Float32Array(0)] };
  const conv = Core.createSegmentConverter(pcm, { targetRate: 48000, targetChannels: 2, int16: false });
  assert.strictEqual(conv.outFrames, 0);
  assert.strictEqual(conv.convert(0, 0, [new Float32Array(0), new Float32Array(0)]), 0);
});

test('segmentPeakAfterFade: 等于转换器输出的峰值', () => {
  const rate = 48000;
  const pcm = { sampleRate: rate, channels: [sine(rate, 440, 0.6, rate)] };
  const conv = Core.createSegmentConverter(pcm, { targetRate: rate, targetChannels: 2, fadeMs: 8, int16: false });
  const out = new Float32Array(conv.outFrames);
  conv.convert(0, conv.outFrames, [out, new Float32Array(conv.outFrames)]);
  let peak = 0;
  for (let i = 0; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]));
  const scanPeak = Core.segmentPeakAfterFade(pcm, rate, 2, 8);
  assert.ok(Math.abs(scanPeak - peak) <= 1e-6, `${scanPeak} vs ${peak}`);
});

test('segmentPeakAfterFade: 立体声→单声道目标取平均后的峰值', () => {
  const rate = 48000;
  const pcm = { sampleRate: rate, channels: [sine(rate, 440, 0.6, rate), sine(rate, 440, 0.2, rate)] };
  const conv = Core.createSegmentConverter(pcm, { targetRate: rate, targetChannels: 1, fadeMs: 0, int16: false });
  const out = new Float32Array(conv.outFrames);
  conv.convert(0, conv.outFrames, [out]);
  let peak = 0;
  for (let i = 0; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]));
  const scanPeak = Core.segmentPeakAfterFade(pcm, rate, 1, 0);
  assert.ok(Math.abs(scanPeak - peak) <= 1e-6, `${scanPeak} vs ${peak}`);
  assert.ok(Math.abs(peak - 0.4) <= 1e-5); // 同相同幅值正弦平均 = 幅值和的一半
});

test('planMerge: 总帧数与 concatSegments 输出一致（含间隔与空片段）', () => {
  const rate = 48000;
  const segs = [
    { name: 'a', pcm: { sampleRate: rate, channels: [sine(rate, 440, 0.5, rate)] } },
    { name: 'e', pcm: { sampleRate: rate, channels: [new Float32Array(0)] } },
    { name: 'b', pcm: { sampleRate: rate, channels: [sine(rate, 880, 0.3, rate / 2)] } }
  ];
  const opts = { targetSampleRate: rate, targetChannels: 2, gapSec: 0.25, fadeMs: 8 };
  const plan = Core.planMerge(segs, opts);
  assert.strictEqual(plan.parts.length, 2); // 空片段被跳过
  assert.strictEqual(plan.gapFrames, Math.round(0.25 * rate));
  const merged = Core.concatSegments(segs, opts);
  assert.strictEqual(merged.channels[0].length, plan.totalFrames);
  // 间隔区绝对静音（零初始化）
  const gapStart = plan.parts[0].outFrames;
  for (let i = gapStart; i < gapStart + plan.gapFrames; i++) {
    assert.strictEqual(merged.channels[0][i], 0);
    assert.strictEqual(merged.channels[1][i], 0);
  }
});

test('planMerge: 全空片段抛错', () => {
  assert.throws(() => Core.planMerge(
    [{ name: 'e', pcm: { sampleRate: 44100, channels: [new Float32Array(0)] } }],
    {}
  ));
});

/* ---------- V0.3.2 格式嗅探与 WAV 兜底解析 ---------- */

function asciiBytes(s) {
  const a = [];
  for (let i = 0; i < s.length; i++) a.push(s.charCodeAt(i));
  return a;
}

test('sniffFormat: 识别常见容器/编码', () => {
  const wav = Core.encodeWav({ sampleRate: 8000, channels: [new Float32Array(10)] }, 16);
  assert.strictEqual(Core.sniffFormat(wav).container, 'wav');
  assert.strictEqual(Core.sniffFormat(new Uint8Array(asciiBytes('ID3').concat([4, 0, 0, 0, 0, 0, 0x10]))).container, 'mp3');
  assert.strictEqual(Core.sniffFormat(new Uint8Array([0xFF, 0xFB, 0x90, 0x00])).container, 'mp3');
  assert.strictEqual(Core.sniffFormat(new Uint8Array([0, 0, 0, 0x20].concat(asciiBytes('ftyp'), asciiBytes('M4A ')))).container, 'mp4');
  assert.strictEqual(Core.sniffFormat(new Uint8Array(asciiBytes('OggS'))).container, 'ogg');
  assert.strictEqual(Core.sniffFormat(new Uint8Array(asciiBytes('fLaC'))).container, 'flac');
  assert.strictEqual(Core.sniffFormat(new Uint8Array(asciiBytes('#!AMR'))).container, 'amr');
  assert.strictEqual(Core.sniffFormat(new Uint8Array([0x30, 0x26, 0xB2, 0x75, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])).container, 'asf');
  assert.strictEqual(Core.sniffFormat(new Uint8Array([0xFF, 0xF1, 0x50, 0x80])).container, 'aac-adts');
  // ADTS 变体：F0/F8 层位同为 00，也曾被漏判成"未知格式"
  assert.strictEqual(Core.sniffFormat(new Uint8Array([0xFF, 0xF8, 0x50, 0x80])).container, 'aac-adts');
  assert.strictEqual(Core.sniffFormat(new Uint8Array([0xFF, 0xF0, 0x50, 0x80])).container, 'aac-adts');
  // MPEG 帧不得被误判为 ADTS
  assert.strictEqual(Core.sniffFormat(new Uint8Array([0xFF, 0xFA, 0x90, 0x00])).container, 'mp3');
  assert.strictEqual(Core.sniffFormat(new Uint8Array([0xFF, 0xFB, 0x90, 0x00])).container, 'mp3');
  assert.strictEqual(Core.sniffFormat(new Uint8Array([0x1A, 0x45, 0xDF, 0xA3])).container, 'webm');
  // SILK：真实微信语音是 \x02#!SILK_V3，magic 起始偏移不固定（曾因只查偏移 0/1 而漏判）
  assert.strictEqual(Core.sniffFormat(new Uint8Array([0x02].concat(asciiBytes('#!SILK_V3')))).container, 'silk');
  assert.strictEqual(Core.sniffFormat(new Uint8Array(asciiBytes('#!SILK_V3'))).container, 'silk');
  assert.strictEqual(Core.sniffFormat(new Uint8Array(asciiBytes('caff'))).container, 'caf');
  assert.strictEqual(Core.sniffFormat(new Uint8Array(0)).container, 'empty');
  assert.strictEqual(Core.sniffFormat(new Uint8Array([1, 2, 3, 4])).container, 'unknown');
});

test('sniffFormat: 每种结果都带非空 label（错误提示依赖它）', () => {
  const samples = [
    Core.encodeWav({ sampleRate: 8000, channels: [new Float32Array(10)] }, 16),
    new Uint8Array(asciiBytes('ID3')),
    new Uint8Array([0xFF, 0xFB]),
    new Uint8Array([0, 0, 0, 0x20].concat(asciiBytes('ftyp'), asciiBytes('M4A '))),
    new Uint8Array(asciiBytes('#!AMR')),
    new Uint8Array(0),
    new Uint8Array([9, 9, 9])
  ];
  for (const b of samples) {
    const r = Core.sniffFormat(b);
    assert.ok(typeof r.label === 'string' && r.label.length > 0, JSON.stringify(r));
    assert.ok(typeof r.advice === 'string');
  }
});

test('decodeWav: 16bit 立体声与 encodeWav 互逆（量化误差内）', () => {
  const src = {
    sampleRate: 48000,
    channels: [
      new Float32Array([0, 0.5, -0.5, 1, -1]),
      new Float32Array([0.25, -0.25, 0.75, -0.75, 0])
    ]
  };
  const out = Core.decodeWav(Core.encodeWav(src, 16));
  assert.strictEqual(out.sampleRate, 48000);
  assert.strictEqual(out.channels.length, 2);
  for (let c = 0; c < 2; c++) {
    for (let i = 0; i < 5; i++) {
      assert.ok(Math.abs(out.channels[c][i] - src.channels[c][i]) <= 1 / 32768,
        `c${c} i${i}: ${out.channels[c][i]} vs ${src.channels[c][i]}`);
    }
  }
});

test('decodeWav: 8bit 与 24bit 在量化误差内', () => {
  const src = { sampleRate: 8000, channels: [new Float32Array([0, 0.5, -0.5, 0.25])] };
  const w8 = Core.decodeWav(Core.encodeWav(src, 8));
  for (let i = 0; i < 4; i++) assert.ok(Math.abs(w8.channels[0][i] - src.channels[0][i]) <= 1 / 64);
  const w24 = Core.decodeWav(Core.encodeWav(src, 24));
  for (let i = 0; i < 4; i++) assert.ok(Math.abs(w24.channels[0][i] - src.channels[0][i]) <= 1 / 8388608);
});

test('decodeWav: 32bit float WAV 精确解析', () => {
  const frames = 4, ch = 1, rate = 16000;
  const dataSize = frames * ch * 4;
  const buf = new ArrayBuffer(44 + dataSize);
  const dv = new DataView(buf);
  const wr = (off, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); };
  wr(0, 'RIFF'); dv.setUint32(4, 36 + dataSize, true); wr(8, 'WAVE'); wr(12, 'fmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 3, true); dv.setUint16(22, ch, true);
  dv.setUint32(24, rate, true); dv.setUint32(28, rate * ch * 4, true);
  dv.setUint16(32, ch * 4, true); dv.setUint16(34, 32, true); wr(36, 'data');
  dv.setUint32(40, dataSize, true);
  [0.5, -0.25, 1, 0].forEach((v, i) => dv.setFloat32(44 + i * 4, v, true));
  const out = Core.decodeWav(new Uint8Array(buf));
  assert.strictEqual(out.sampleRate, 16000);
  assert.deepStrictEqual(Array.from(out.channels[0]), [0.5, -0.25, 1, 0]);
});

test('decodeWav: 容忍未知块（LIST）与乱序块', () => {
  // 在 fmt 前插入一个 LIST 块，验证块遍历
  const base = Core.encodeWav({ sampleRate: 8000, channels: [new Float32Array([0.5, -0.5])] }, 16);
  const listSize = 6;
  const extra = 8 + listSize + (listSize & 1);
  const merged = new Uint8Array(base.length + extra);
  merged.set(base.subarray(0, 12), 0);
  // LIST 块
  const dv = new DataView(merged.buffer);
  merged.set(asciiBytes('LIST'), 12);
  dv.setUint32(16, listSize, true);
  for (let i = 0; i < listSize; i++) merged[20 + i] = 0x41;
  merged.set(base.subarray(12), 12 + extra);
  // 修正 RIFF 总长度
  dv.setUint32(4, merged.length - 8, true);
  const out = Core.decodeWav(merged);
  assert.strictEqual(out.channels[0].length, 2);
  assert.ok(Math.abs(out.channels[0][0] - 0.5) <= 1 / 32768);
});

test('decodeWav: 非 RIFF / 截断输入抛错', () => {
  assert.throws(() => Core.decodeWav(new Uint8Array([1, 2, 3])));
  assert.throws(() => Core.decodeWav(new Uint8Array(100)));
});

/* ---------- WAV 格式白名单（防止压缩格式被当 PCM 解析成噪声） ---------- */

/** 构造指定 WAVE 格式代码的 WAV（用于验证白名单拒绝行为） */
function makeWavWithFormat(audioFormat, opts) {
  opts = opts || {};
  const rate = opts.rate || 8000, ch = opts.ch || 1;
  const bits = opts.bits || 16, frames = opts.frames || 200;
  const fmtSize = opts.fmtSize || 16;
  const blockAlign = ch * (bits / 8);
  const dataSize = frames * blockAlign;
  const buf = new ArrayBuffer(44 + (fmtSize - 16) + dataSize);
  const dv = new DataView(buf);
  const wr = (off, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); };
  wr(0, 'RIFF'); dv.setUint32(4, buf.byteLength - 8, true); wr(8, 'WAVE');
  wr(12, 'fmt '); dv.setUint32(16, fmtSize, true); dv.setUint16(20, audioFormat, true);
  dv.setUint16(22, ch, true); dv.setUint32(24, rate, true);
  dv.setUint32(28, rate * blockAlign, true); dv.setUint16(32, blockAlign, true);
  dv.setUint16(34, bits, true);
  // WAVE_FORMAT_EXTENSIBLE：真实格式写在子格式 GUID 的前 2 字节（body+24）
  if (typeof opts.subFormat === 'number' && fmtSize >= 40) {
    dv.setUint16(20 + 24, opts.subFormat, true);
  }
  const dataOff = 20 + fmtSize;
  wr(dataOff, 'data'); dv.setUint32(dataOff + 4, dataSize, true);
  for (let i = 0; i < dataSize; i++) dv.setUint8(dataOff + 8 + i, (i * 13) & 0xFF);
  return new Uint8Array(buf);
}

test('decodeWav: 压缩格式必须报错，不得按 PCM 静默产出噪声', () => {
  const bad = [
    [6, 'A-law'], [7, 'μ-law'], [17, 'IMA ADPCM'], [2, 'ADPCM'],
    [49, 'GSM 6.10'], [85, 'MPEG Layer III'], [65534, 'WAVE_FORMAT_EXTENSIBLE 但不完整']
  ];
  for (const [code] of bad) {
    assert.throws(() => Core.decodeWav(makeWavWithFormat(code)), /不支持该压缩格式/,
      '格式代码 0x' + code.toString(16) + ' 应当被拒绝');
  }
  // 错误信息里要带可读格式名，方便用户判断该怎么转
  assert.throws(() => Core.decodeWav(makeWavWithFormat(6)), /A-law/);
  assert.throws(() => Core.decodeWav(makeWavWithFormat(85)), /MPEG Layer III/);
});

test('decodeWav: PCM(1) / IEEE float(3) / 可扩展格式的 PCM 子格式仍可解析', () => {
  const pcm = Core.decodeWav(makeWavWithFormat(1));
  assert.strictEqual(pcm.channels[0].length, 200);
  const flt = Core.decodeWav(makeWavWithFormat(3, { bits: 32 }));
  assert.strictEqual(flt.channels[0].length, 200);
  // WAVE_FORMAT_EXTENSIBLE：真实格式在子格式 GUID 前 2 字节，此处为 PCM(1)
  const ext = Core.decodeWav(makeWavWithFormat(65534, { fmtSize: 40, subFormat: 1 }));
  assert.strictEqual(ext.channels[0].length, 200);
  // EXTENSIBLE 但若子格式是 A-law(6)，同样要被拒绝
  assert.throws(() => Core.decodeWav(makeWavWithFormat(65534, { fmtSize: 40, subFormat: 6 })),
    /不支持该压缩格式/);
});

console.log('[audio-core] 全部通过：' + passed + ' 项测试');
