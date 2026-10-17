/**
 * audio-core.js — 音频合并核心逻辑（纯函数，无 DOM 依赖）
 *
 * 同时支持两种运行环境：
 *   - 浏览器：挂载为 window.AudioCore
 *   - Node.js：module.exports（用于单元测试）
 *
 * PCM 数据格式（本模块内部约定）：
 *   { sampleRate: number, channels: Float32Array[] }
 *   - 去交织（每条声道一个 Float32Array）
 *   - 采样值范围 [-1, 1]
 *
 * 设计要点：
 *   1. 合并 = 解码 → 统一采样率/声道数 → 拼接（可插入静音间隔）→ 编码。
 *      无论输入是 mp3 还是 m4a，都先解码为 PCM 再拼接，避免
 *      "直接拼接压缩音频字节流" 在异构编码参数下产生噪音/无法播放的问题。
 *   2. 所有函数不修改入参（返回新对象），便于测试与复用。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.AudioCore = api;
  }
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  /** 版本唯一权威值（README / 界面页脚 / package.json 均以此为源） */
  var APP_VERSION = '0.2.1';

  var DEFAULTS = {
    targetSampleRate: 44100, // 统一输出采样率（Hz）
    targetChannels: 2,       // 统一输出声道数（1=单声道，2=立体声）
    gapSec: 0,               // 片段之间的静音间隔（秒）
    fadeMs: 8,               // 每段首尾淡入淡出时长（毫秒），抑制拼接爆音
    normalize: false,        // 是否做峰值归一化
    normalizeTarget: 0.89,   // 归一化目标峰值（<1.0 留出余量防削波）
    maxNormalizeGain: 8      // 归一化最大增益倍数（避免把静音噪声放大到刺耳）
  };

  /* ------------------------------------------------------------------ *
   * 基础工具
   * ------------------------------------------------------------------ */

  /** 生成指定时长的静音 PCM */
  function createSilence(sampleRate, channels, seconds) {
    var len = Math.max(0, Math.round(seconds * sampleRate));
    var chs = [];
    for (var c = 0; c < channels; c++) chs.push(new Float32Array(len));
    return { sampleRate: sampleRate, channels: chs };
  }

  /** 线性插值重采样（单声道）。质量够用，且无外部依赖、可测试。 */
  function resampleChannel(channel, fromRate, toRate) {
    if (fromRate === toRate || channel.length === 0) {
      return channel.slice();
    }
    var ratio = toRate / fromRate;
    var outLen = Math.max(1, Math.round(channel.length * ratio));
    var out = new Float32Array(outLen);
    for (var i = 0; i < outLen; i++) {
      var pos = i / ratio;
      var i0 = Math.floor(pos);
      if (i0 >= channel.length - 1) {
        out[i] = channel[channel.length - 1];
      } else {
        var t = pos - i0;
        out[i] = channel[i0] * (1 - t) + channel[i0 + 1] * t;
      }
    }
    return out;
  }

  /**
   * 把一段 PCM 统一到目标采样率与声道数（返回新对象，不修改入参）。
   * 声道策略：
   *   - 目标单声道：对所有声道取平均
   *   - 目标立体声：单声道复制一份；多声道取前两条
   */
  function conformPcm(pcm, targetRate, targetChannels) {
    var src = pcm.channels;
    var outChannels = [];
    var c, i;

    if (targetChannels === 1) {
      var mono = new Float32Array(src[0].length);
      for (c = 0; c < src.length; c++) {
        var ch = src[c];
        for (i = 0; i < ch.length; i++) mono[i] += ch[i] / src.length;
      }
      outChannels = [mono];
    } else if (src.length === targetChannels) {
      for (c = 0; c < src.length; c++) outChannels.push(src[c].slice());
    } else if (src.length === 1) {
      outChannels = [src[0].slice(), src[0].slice()];
    } else {
      for (c = 0; c < targetChannels; c++) outChannels.push(src[c].slice());
    }

    if (pcm.sampleRate !== targetRate) {
      for (c = 0; c < outChannels.length; c++) {
        outChannels[c] = resampleChannel(outChannels[c], pcm.sampleRate, targetRate);
      }
    }
    return { sampleRate: targetRate, channels: outChannels };
  }

  /** 对单条声道首尾做等功率淡入淡出（原地修改） */
  function applyFadeInOut(channel, sampleRate, fadeMs) {
    var fadeLen = Math.min(
      Math.floor((fadeMs / 1000) * sampleRate),
      Math.floor(channel.length / 2)
    );
    if (fadeLen <= 0) return;
    for (var i = 0; i < fadeLen; i++) {
      var g = i / fadeLen;
      channel[i] *= g;
      channel[channel.length - 1 - i] *= g;
    }
  }

  /** 峰值（绝对值最大采样） */
  function pcmPeak(pcm) {
    var peak = 0;
    for (var c = 0; c < pcm.channels.length; c++) {
      var ch = pcm.channels[c];
      for (var i = 0; i < ch.length; i++) {
        var v = Math.abs(ch[i]);
        if (v > peak) peak = v;
      }
    }
    return peak;
  }

  /** 时长（秒） */
  function pcmDurationSec(pcm) {
    if (!pcm || !pcm.channels || pcm.channels.length === 0) return 0;
    return pcm.channels[0].length / pcm.sampleRate;
  }

  /**
   * 选择合并目标采样率：
   *   - 所有输入一致且为标准 MP3 采样率（32k/44.1k/48k）时直接沿用
   *     ——免去重采样（更快），且避免线性插值带来的音质损失；
   *   - 其余情况（混合采样率、非标准率）统一到 44100。
   */
  function pickTargetRate(sampleRates) {
    if (!sampleRates || sampleRates.length === 0) return DEFAULTS.targetSampleRate;
    var first = sampleRates[0];
    var allSame = sampleRates.every(function (r) { return r === first; });
    if (allSame && [32000, 44100, 48000].indexOf(first) !== -1) return first;
    return DEFAULTS.targetSampleRate;
  }

  /**
   * 峰值归一化：把整体峰值拉到 target，返回新 PCM。
   * 全静音或峰值异常时原样返回；增益受 maxNormalizeGain 限制。
   */
  function peakNormalize(pcm, target, maxGain) {
    target = typeof target === 'number' ? target : DEFAULTS.normalizeTarget;
    maxGain = typeof maxGain === 'number' ? maxGain : DEFAULTS.maxNormalizeGain;
    var peak = pcmPeak(pcm);
    if (peak <= 0 || !isFinite(peak)) return pcm;
    var gain = Math.min(target / peak, maxGain);
    var out = [];
    for (var c = 0; c < pcm.channels.length; c++) {
      var src = pcm.channels[c];
      var dst = new Float32Array(src.length);
      for (var i = 0; i < src.length; i++) dst[i] = src[i] * gain;
      out.push(dst);
    }
    return { sampleRate: pcm.sampleRate, channels: out };
  }

  /* ------------------------------------------------------------------ *
   * 合并主流程
   * ------------------------------------------------------------------ */

  /**
   * 合并多段 PCM。
   * @param {Array<{name:string, pcm:Object}>} segments 按顺序排列的片段
   * @param {Object} [options] 覆盖 DEFAULTS
   * @returns {{sampleRate:number, channels:Float32Array[]}} 合并后的 PCM
   */
  function concatSegments(segments, options) {
    var opts = {};
    var k;
    for (k in DEFAULTS) opts[k] = DEFAULTS[k];
    for (k in (options || {})) {
      if (Object.prototype.hasOwnProperty.call(options || {}, k)) opts[k] = options[k];
    }

    if (!segments || segments.length === 0) {
      throw new Error('concatSegments: 片段列表为空');
    }

    var conformed = [];
    var i, c;
    for (i = 0; i < segments.length; i++) {
      var seg = segments[i];
      if (!seg || !seg.pcm || !seg.pcm.channels || seg.pcm.channels.length === 0) {
        throw new Error('concatSegments: 第 ' + (i + 1) + ' 个片段数据无效');
      }
      var pcm = conformPcm(seg.pcm, opts.targetSampleRate, opts.targetChannels);
      if (pcm.channels[0].length === 0) continue; // 跳过空片段
      if (opts.fadeMs > 0) {
        for (c = 0; c < pcm.channels.length; c++) {
          applyFadeInOut(pcm.channels[c], pcm.sampleRate, opts.fadeMs);
        }
      }
      conformed.push(pcm);
    }

    if (conformed.length === 0) {
      throw new Error('concatSegments: 所有片段均为空');
    }

    var gapLen = Math.round(opts.gapSec * opts.targetSampleRate);
    var totalLen = 0;
    for (i = 0; i < conformed.length; i++) totalLen += conformed[i].channels[0].length;
    totalLen += gapLen * (conformed.length - 1);

    var out = [];
    for (c = 0; c < opts.targetChannels; c++) out.push(new Float32Array(totalLen));

    var offset = 0;
    for (i = 0; i < conformed.length; i++) {
      var p = conformed[i];
      for (c = 0; c < opts.targetChannels; c++) out[c].set(p.channels[c], offset);
      offset += p.channels[0].length + gapLen;
    }

    var result = { sampleRate: opts.targetSampleRate, channels: out };
    if (opts.normalize) {
      result = peakNormalize(result, opts.normalizeTarget, opts.maxNormalizeGain);
    }
    return result;
  }

  /* ------------------------------------------------------------------ *
   * WAV 编码（RIFF/WAVE，PCM）
   * ------------------------------------------------------------------ */

  /**
   * 将 PCM 编码为 WAV 字节流。
   * @param {Object} pcm
   * @param {number} [bitDepth=16] 8 / 16 / 24 / 32
   * @returns {Uint8Array}
   */
  function encodeWav(pcm, bitDepth) {
    bitDepth = bitDepth || 16;
    if ([8, 16, 24, 32].indexOf(bitDepth) === -1) {
      throw new Error('encodeWav: 不支持的位深 ' + bitDepth);
    }
    var numChannels = pcm.channels.length;
    var sampleRate = pcm.sampleRate;
    var numFrames = pcm.channels[0].length;
    var bytesPerSample = bitDepth / 8;
    var blockAlign = numChannels * bytesPerSample;
    var dataSize = numFrames * blockAlign;

    var buffer = new ArrayBuffer(44 + dataSize);
    var view = new DataView(buffer);

    function writeStr(off, s) {
      for (var i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
    }
    function clamp(v) {
      return v < -1 ? -1 : (v > 1 ? 1 : v);
    }

    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true); // 文件总大小 - 8
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);                    // fmt 块大小
    view.setUint16(20, 1, true);                     // 格式：PCM
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * blockAlign, true); // 字节率
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitDepth, true);
    writeStr(36, 'data');
    view.setUint32(40, dataSize, true);

    var off = 44;
    var c, i, v;
    if (bitDepth === 16) {
      for (i = 0; i < numFrames; i++) {
        for (c = 0; c < numChannels; c++) {
          v = clamp(pcm.channels[c][i]);
          view.setInt16(off, v < 0 ? v * 0x8000 : v * 0x7fff, true);
          off += 2;
        }
      }
    } else if (bitDepth === 8) {
      // 8-bit WAV 为无号数，128 表示静音
      for (i = 0; i < numFrames; i++) {
        for (c = 0; c < numChannels; c++) {
          v = clamp(pcm.channels[c][i]);
          view.setUint8(off, Math.round(v * 127) + 128);
          off += 1;
        }
      }
    } else if (bitDepth === 24) {
      for (i = 0; i < numFrames; i++) {
        for (c = 0; c < numChannels; c++) {
          v = clamp(pcm.channels[c][i]);
          var s = v < 0 ? v * 0x800000 : v * 0x7fffff;
          s = Math.round(s);
          view.setUint8(off, s & 0xff);
          view.setUint8(off + 1, (s >> 8) & 0xff);
          view.setUint8(off + 2, (s >> 16) & 0xff);
          off += 3;
        }
      }
    } else {
      for (i = 0; i < numFrames; i++) {
        for (c = 0; c < numChannels; c++) {
          v = clamp(pcm.channels[c][i]);
          view.setInt32(off, v < 0 ? v * 0x80000000 : v * 0x7fffffff, true);
          off += 4;
        }
      }
    }
    return new Uint8Array(buffer);
  }

  /* ------------------------------------------------------------------ *
   * MP3 编码（lamejs 由外部注入，核心库不硬依赖）
   * ------------------------------------------------------------------ */

  /** 单条 Float32 声道 → Int16（lamejs 输入格式，带钳位） */
  function floatToInt16(channel) {
    var out = new Int16Array(channel.length);
    for (var i = 0; i < channel.length; i++) {
      var v = channel[i];
      v = v < -1 ? -1 : (v > 1 ? 1 : v);
      out[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
    }
    return out;
  }

  /** PCM → 每条声道一个 Int16Array */
  function pcmToInt16Channels(pcm) {
    return pcm.channels.map(function (ch) { return floatToInt16(ch); });
  }

  /**
   * MP3 编码（异步、分块、可取消）。
   *
   * @param {Object} pcm {sampleRate, channels: Float32Array[]}
   * @param {Object} opts
   *   - lamejs    必填，lamejs 库对象（浏览器里是 window.lamejs）
   *   - kbps      位率，默认 128（LAME 支持 8–320）
   *   - blockFrames 每块采样数，默认 1152*50（44.1kHz 约 1.3 秒/块）
   *   - yieldFn   每块之间让出主线程的函数，用于刷新进度条（默认微任务）
   *   - onProgress (0..1) 进度回调
   *   - isCanceled 返回 true 则中止，抛出 code 为 'CANCELED' 的错误
   * @returns {Promise<Uint8Array>} MP3 字节流
   */
  async function encodeMP3(pcm, opts) {
    opts = opts || {};
    if (!opts.lamejs || typeof opts.lamejs.Mp3Encoder !== 'function') {
      throw new Error('MP3 编码器未加载（缺少 lamejs）');
    }
    var kbps = opts.kbps || 128;
    var blockFrames = opts.blockFrames || 1152 * 50;
    var yieldFn = opts.yieldFn || function () { return Promise.resolve(); };
    var isCanceled = opts.isCanceled || function () { return false; };

    var numChannels = pcm.channels.length;
    var sampleRate = pcm.sampleRate;
    var int16 = pcmToInt16Channels(pcm);
    var total = int16[0].length;
    if (total === 0) throw new Error('encodeMP3: PCM 为空');

    var enc = new opts.lamejs.Mp3Encoder(numChannels, sampleRate, kbps);
    var chunks = [];
    var totalBytes = 0;
    var lastReported = -1; // 保证进度严格单调递增（末块与 flush 都可能到 1）

    for (var i = 0; i < total; i += blockFrames) {
      if (isCanceled()) {
        var cancelErr = new Error('已取消');
        cancelErr.code = 'CANCELED';
        throw cancelErr;
      }
      var end = Math.min(i + blockFrames, total);
      var left = int16[0].subarray(i, end);
      var right = numChannels > 1 ? int16[1].subarray(i, end) : null;
      var buf = numChannels > 1 ? enc.encodeBuffer(left, right) : enc.encodeBuffer(left);
      if (buf && buf.length > 0) {
        // lamejs 返回 Int8Array 视图；按字节原样转 Uint8Array（不能按值转换）
        var chunk = new Uint8Array(buf.buffer, buf.byteOffset, buf.length);
        chunks.push(chunk);
        totalBytes += chunk.length;
      }
      if (opts.onProgress && end / total > lastReported) {
        lastReported = end / total;
        opts.onProgress(lastReported);
      }
      if (end < total) await yieldFn();
    }

    var flushBuf = enc.flush();
    if (flushBuf && flushBuf.length > 0) {
      var fchunk = new Uint8Array(flushBuf.buffer, flushBuf.byteOffset, flushBuf.length);
      chunks.push(fchunk);
      totalBytes += fchunk.length;
    }
    if (opts.onProgress && lastReported < 1) opts.onProgress(1);

    var out = new Uint8Array(totalBytes);
    var off = 0;
    for (var c = 0; c < chunks.length; c++) {
      out.set(chunks[c], off);
      off += chunks[c].length;
    }
    return out;
  }

  return {
    APP_VERSION: APP_VERSION,
    DEFAULTS: DEFAULTS,
    createSilence: createSilence,
    resampleChannel: resampleChannel,
    conformPcm: conformPcm,
    concatSegments: concatSegments,
    peakNormalize: peakNormalize,
    pcmPeak: pcmPeak,
    pcmDurationSec: pcmDurationSec,
    pickTargetRate: pickTargetRate,
    encodeWav: encodeWav,
    floatToInt16: floatToInt16,
    pcmToInt16Channels: pcmToInt16Channels,
    encodeMP3: encodeMP3
  };
});
