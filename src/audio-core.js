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
  var APP_VERSION = '0.3.0';

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
   * 流式合并基础件（V0.3.0）
   *
   * 背景：长音频合并的内存瓶颈不在算法而在"整体物化"——旧 concatSegments
   * 先为每段建全量 conform 拷贝，再建全量输出，两个 40 分钟立体声文件
   * 峰值可超 4GB（用户实测），iOS 直接杀页面。新方案：
   *   1. createSegmentConverter：无状态分帧转换器，按绝对输出帧号计算
   *      源位置——可分块调用且块边界不影响结果（与一次性转换逐位一致）；
   *   2. planMerge：先算总帧数（WAV 头部/进度都靠它）；
   *   3. concatSegments 本身也改为单遍直写输出（去掉 conform 中间层）。
   * ------------------------------------------------------------------ */

  /** 合并选项归一化（DEFAULTS + 用户覆盖） */
  function mergeOptions(options) {
    var opts = {};
    var k;
    for (k in DEFAULTS) opts[k] = DEFAULTS[k];
    for (k in (options || {})) {
      if (Object.prototype.hasOwnProperty.call(options || {}, k)) opts[k] = options[k];
    }
    return opts;
  }

  /**
   * 一段源 PCM 在目标采样率下的输出帧数。
   * 与 conformPcm + resampleChannel 的长度计算保持一致；
   * 空片段返回 0（调用方按"跳过空片段"处理）。
   */
  function conformedFrameCount(srcPcm, targetRate) {
    var srcLen = srcPcm.channels[0].length;
    if (srcLen === 0) return 0;
    if (srcPcm.sampleRate === targetRate) return srcLen;
    return Math.max(1, Math.round(srcLen * (targetRate / srcPcm.sampleRate)));
  }

  /**
   * 创建单段转换器：把源 PCM 的任意输出帧区间 [o0, o1) 转换为
   * 目标采样率 / 声道数 / 增益 / 淡变后的采样值。
   *
   * 无状态设计：输出帧 n 的源位置 = n / ratio（ratio = targetRate/srcRate），
   * 与一次性重采样逐位一致，因此分块调用不产生接缝。
   *
   * @param {Object} srcPcm 源 PCM（只读，绝不修改）
   * @param {Object} opts
   *   - targetRate     目标采样率
   *   - targetChannels 目标声道数
   *   - gain           统一增益（归一化用，默认 1）
   *   - fadeMs         首尾淡变毫秒数（默认 0）
   *   - int16          true 时输出 Int16（钳位+缩放公式同 floatToInt16）；
   *                    false 时输出 Float32（默认）
   * @returns {{srcRate:number, outFrames:number, convert:Function}}
   *   convert(o0, o1, outChs) → 实际转换帧数；outChs[c] 为长度 ≥ (o1-o0) 的TypedArray
   */
  function createSegmentConverter(srcPcm, opts) {
    var src = srcPcm.channels;
    var srcLen = src[0].length;
    var srcRate = srcPcm.sampleRate;
    var targetRate = opts.targetRate;
    var targetChannels = opts.targetChannels;
    var gain = typeof opts.gain === 'number' ? opts.gain : 1;
    var int16 = !!opts.int16;
    var ratio = targetRate / srcRate;
    var outFrames = conformedFrameCount(srcPcm, targetRate);
    var fadeLen = Math.min(
      Math.floor((opts.fadeMs / 1000) * targetRate),
      Math.floor(outFrames / 2)
    );
    var scratch = new Float32Array(src.length); // 每帧各源声道插值

    function emit(v, out, n) {
      if (!int16) { out[n] = v; return; }
      v = v < -1 ? -1 : (v > 1 ? 1 : v);
      out[n] = v < 0 ? v * 0x8000 : v * 0x7fff;
    }

    function convert(o0, o1, outChs) {
      var frames = o1 - o0;
      if (frames <= 0 || outFrames === 0) return 0;
      var n, c, abs, pos, i0, t, v, g, ch;
      for (n = 0; n < frames; n++) {
        abs = o0 + n;
        pos = abs / ratio;
        i0 = Math.floor(pos);
        var hold = i0 >= srcLen - 1;
        if (hold) i0 = srcLen - 1;
        t = hold ? 0 : pos - i0;
        for (c = 0; c < src.length; c++) {
          ch = src[c];
          scratch[c] = (hold || srcLen < 2) ? ch[i0] : ch[i0] * (1 - t) + ch[i0 + 1] * t;
        }
        // 淡变增益（与 applyFadeInOut 同一公式：首尾各 fadeLen 帧线性斜坡）
        g = 1;
        if (fadeLen > 0) {
          if (abs < fadeLen) g = abs / fadeLen;
          else if (abs >= outFrames - fadeLen) g = (outFrames - 1 - abs) / fadeLen;
        }
        if (targetChannels === 1) {
          var m = 0;
          for (c = 0; c < src.length; c++) m += scratch[c] / src.length;
          emit(m * g * gain, outChs[0], n);
        } else if (src.length === targetChannels) {
          for (c = 0; c < targetChannels; c++) emit(scratch[c] * g * gain, outChs[c], n);
        } else if (src.length === 1) {
          v = scratch[0] * g * gain;
          emit(v, outChs[0], n);
          emit(v, outChs[1], n);
        } else {
          for (c = 0; c < targetChannels; c++) emit(scratch[c] * g * gain, outChs[c], n);
        }
      }
      return frames;
    }

    return { srcRate: srcRate, outFrames: outFrames, convert: convert };
  }

  /**
   * 单段在淡变后的峰值（不含归一化增益）。
   *
   * 流式合并时用于预先计算全局增益：旧实现是"先拼接再 peakNormalize"，
   * 而拼接后的全局峰值 = 各段淡变后峰值的最大者（静音间隔不贡献峰值），
   * 因此两路径等值——这里用只读扫描完成，不分配任何大数组。
   */
  function segmentPeakAfterFade(srcPcm, targetRate, targetChannels, fadeMs) {
    var src = srcPcm.channels;
    var srcLen = src[0].length;
    if (srcLen === 0) return 0;
    var ratio = targetRate / srcPcm.sampleRate;
    var outFrames = conformedFrameCount(srcPcm, targetRate);
    var fadeLen = Math.min(
      Math.floor((fadeMs / 1000) * targetRate),
      Math.floor(outFrames / 2)
    );
    var peak = 0;
    var n, c, pos, i0, t, v, g, ch, m;
    for (n = 0; n < outFrames; n++) {
      g = 1;
      if (fadeLen > 0) {
        if (n < fadeLen) g = n / fadeLen;
        else if (n >= outFrames - fadeLen) g = (outFrames - 1 - n) / fadeLen;
      }
      pos = n / ratio;
      i0 = Math.floor(pos);
      var hold = i0 >= srcLen - 1;
      if (hold) i0 = srcLen - 1;
      t = hold ? 0 : pos - i0;
      for (c = 0; c < src.length; c++) {
        ch = src[c];
        v = (hold || srcLen < 2) ? ch[i0] : ch[i0] * (1 - t) + ch[i0 + 1] * t;
        if (targetChannels === 1) {
          if (c === 0) m = 0;
          m += v / src.length;
          if (c === src.length - 1) { v = m; } else { continue; }
        } else if (src.length > 1 && c >= targetChannels) {
          continue; // 多声道目标只取前 targetChannels 条
        }
        v = Math.abs(v * g);
        if (v > peak) peak = v;
      }
    }
    return peak;
  }

  /**
   * 合并计划：各非空片段的输出帧数、间隔帧数、总帧数。
   * 与 concatSegments 的长度语义一致（跳过空片段、段间插间隔）。
   * @returns {{targetSampleRate, targetChannels, gapFrames,
   *            parts:Array<{index:number, outFrames:number}>, totalFrames}}
   */
  function planMerge(segments, options) {
    var opts = mergeOptions(options);
    if (!segments || segments.length === 0) {
      throw new Error('planMerge: 片段列表为空');
    }
    var parts = [];
    var i;
    for (i = 0; i < segments.length; i++) {
      var seg = segments[i];
      if (!seg || !seg.pcm || !seg.pcm.channels || seg.pcm.channels.length === 0) {
        throw new Error('planMerge: 第 ' + (i + 1) + ' 个片段数据无效');
      }
      var frames = conformedFrameCount(seg.pcm, opts.targetSampleRate);
      if (frames === 0) continue; // 跳过空片段（与 concatSegments 一致）
      parts.push({ index: i, outFrames: frames });
    }
    if (parts.length === 0) {
      throw new Error('planMerge: 所有片段均为空');
    }
    var gapFrames = Math.round(opts.gapSec * opts.targetSampleRate);
    var totalFrames = 0;
    for (i = 0; i < parts.length; i++) totalFrames += parts[i].outFrames;
    totalFrames += gapFrames * (parts.length - 1);
    return {
      targetSampleRate: opts.targetSampleRate,
      targetChannels: opts.targetChannels,
      gapFrames: gapFrames,
      parts: parts,
      totalFrames: totalFrames
    };
  }

  /* ------------------------------------------------------------------ *
   * 合并主流程
   * ------------------------------------------------------------------ */

  /**
   * 合并多段 PCM（单遍直写：输出只分配一次，逐段转换填入，
   * 不再为每段建立全量 conform 中间拷贝）。
   *
   * @param {Array<{name:string, pcm:Object}>} segments 按顺序排列的片段
   * @param {Object} [options] 覆盖 DEFAULTS
   * @returns {{sampleRate:number, channels:Float32Array[]}} 合并后的 PCM
   */
  function concatSegments(segments, options) {
    var opts = mergeOptions(options);
    var plan = planMerge(segments, opts);

    var out = [];
    var c, i;
    for (c = 0; c < opts.targetChannels; c++) out.push(new Float32Array(plan.totalFrames));

    // 归一化全局增益：等价于旧实现"拼接后 peakNormalize"
    // （拼接后峰值 = 各段淡变后峰值的最大者）
    var gain = 1;
    if (opts.normalize) {
      var peak = 0;
      for (i = 0; i < plan.parts.length; i++) {
        var pk = segmentPeakAfterFade(
          segments[plan.parts[i].index].pcm,
          plan.targetSampleRate, plan.targetChannels, opts.fadeMs
        );
        if (pk > peak) peak = pk;
      }
      if (peak > 0 && isFinite(peak)) {
        gain = Math.min(opts.normalizeTarget / peak, opts.maxNormalizeGain);
      }
    }

    var CHUNK = 65536; // 转换块大小（仅影响速度，不影响结果）
    var offset = 0;
    for (i = 0; i < plan.parts.length; i++) {
      var part = plan.parts[i];
      var conv = createSegmentConverter(segments[part.index].pcm, {
        targetRate: plan.targetSampleRate,
        targetChannels: plan.targetChannels,
        gain: gain,
        fadeMs: opts.fadeMs,
        int16: false
      });
      var done = 0;
      while (done < part.outFrames) {
        var end = Math.min(done + CHUNK, part.outFrames);
        // convert 的 outChs 索引是窗口内局部索引——传输出数组对应区段的子视图
        var views = [];
        for (c = 0; c < opts.targetChannels; c++) {
          views.push(out[c].subarray(offset + done, offset + end));
        }
        conv.convert(done, end, views);
        done = end;
      }
      // 段间间隔：输出数组零初始化，天然就是静音，无需显式写
      offset += part.outFrames + plan.gapFrames;
    }
    return { sampleRate: plan.targetSampleRate, channels: out };
  }

  /* ------------------------------------------------------------------ *
   * WAV 编码（RIFF/WAVE，PCM）
   * ------------------------------------------------------------------ */

  /**
   * WAV 文件头（44 字节 RIFF/WAVE）。
   * 流式合并时先写头部再写数据——总帧数在合并前即可由 planMerge 算出。
   * @param {number} numFrames 每声道帧数
   * @param {number} sampleRate 采样率
   * @param {number} numChannels 声道数
   * @param {number} [bitDepth=16] 8 / 16 / 24 / 32
   * @returns {Uint8Array} 长度 44
   */
  function buildWavHeader(numFrames, sampleRate, numChannels, bitDepth) {
    bitDepth = bitDepth || 16;
    if ([8, 16, 24, 32].indexOf(bitDepth) === -1) {
      throw new Error('buildWavHeader: 不支持的位深 ' + bitDepth);
    }
    var bytesPerSample = bitDepth / 8;
    var blockAlign = numChannels * bytesPerSample;
    var dataSize = numFrames * blockAlign;

    var buffer = new ArrayBuffer(44);
    var view = new DataView(buffer);
    function writeStr(off, s) {
      for (var i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
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
    return new Uint8Array(buffer);
  }

  /**
   * 将 PCM 编码为 WAV 字节流。
   * @param {Object} pcm
   * @param {number} [bitDepth=16] 8 / 16 / 24 / 32
   * @returns {Uint8Array}
   */
  function encodeWav(pcm, bitDepth) {
    bitDepth = bitDepth || 16;
    var numChannels = pcm.channels.length;
    var sampleRate = pcm.sampleRate;
    var numFrames = pcm.channels[0].length;
    var header = buildWavHeader(numFrames, sampleRate, numChannels, bitDepth);
    var bytesPerSample = bitDepth / 8;
    var blockAlign = numChannels * bytesPerSample;
    var dataSize = numFrames * blockAlign;

    var buffer = new ArrayBuffer(44 + dataSize);
    new Uint8Array(buffer, 0, 44).set(header);
    var view = new DataView(buffer);

    function clamp(v) {
      return v < -1 ? -1 : (v > 1 ? 1 : v);
    }

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
    buildWavHeader: buildWavHeader,
    conformedFrameCount: conformedFrameCount,
    createSegmentConverter: createSegmentConverter,
    segmentPeakAfterFade: segmentPeakAfterFade,
    planMerge: planMerge,
    floatToInt16: floatToInt16,
    pcmToInt16Channels: pcmToInt16Channels,
    encodeMP3: encodeMP3
  };
});
