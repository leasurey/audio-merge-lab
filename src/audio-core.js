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
  var APP_VERSION = '0.5.2';

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

  /** 合并选项归一化（DEFAULTS + 用户覆盖），并拒绝会产生静默损坏的数值 */
  function mergeOptions(options) {
    var opts = {};
    var k;
    for (k in DEFAULTS) opts[k] = DEFAULTS[k];
    for (k in (options || {})) {
      if (Object.prototype.hasOwnProperty.call(options || {}, k)) opts[k] = options[k];
    }
    // NaN / 负值 / 非法声道数会让帧数计算产出 NaN 或越界写入，最终生成损坏文件；
    // 公共 API 必须显式拒绝，而不是让错误一路流到 WAV 头。
    function num(name, min, max) {
      var v = opts[name];
      if (typeof v !== 'number' || !isFinite(v) || v < min || (max != null && v > max)) {
        throw new Error('mergeOptions: ' + name + ' 必须是 ' + min + '~' +
          (max == null ? '∞' : max) + ' 之间的有限数，收到 ' + v);
      }
    }
    num('targetSampleRate', 1, 384000);
    num('gapSec', 0);
    num('fadeMs', 0);
    num('normalizeTarget', 0, 1);
    num('maxNormalizeGain', 1);
    if (opts.targetChannels !== 1 && opts.targetChannels !== 2) {
      throw new Error('mergeOptions: targetChannels 只支持 1 或 2，收到 ' + opts.targetChannels);
    }
    return opts;
  }

  /**
   * 一段源 PCM 在目标采样率下的输出帧数，支持只取源区间 [srcStart, srcEnd)。
   * 与 conformPcm + resampleChannel 的长度计算保持一致；
   * 空片段（或区间为空）返回 0（调用方按"跳过空片段"处理）。
   *
   * @param {number} [srcStart] 源起始帧（默认 0）
   * @param {number} [srcEnd]   源结束帧（默认全长）；越界自动裁剪
   */
  function conformedFrameCount(srcPcm, targetRate, srcStart, srcEnd) {
    var srcLen = srcPcm.channels[0].length;
    var start = (typeof srcStart === 'number' && srcStart > 0)
      ? Math.min(Math.floor(srcStart), srcLen) : 0;
    var end = (typeof srcEnd === 'number' && srcEnd < srcLen)
      ? Math.max(Math.floor(srcEnd), start) : srcLen;
    var len = end - start;
    if (len <= 0) return 0;
    if (srcPcm.sampleRate === targetRate) return len;
    return Math.max(1, Math.round(len * (targetRate / srcPcm.sampleRate)));
  }

  /**
   * 创建单段转换器：把源 PCM 的任意输出帧区间 [o0, o1) 转换为
   * 目标采样率 / 声道数 / 增益 / 淡变后的采样值。
   *
   * 无状态设计：输出帧 n 的源位置 = (n + srcStart) / ratio（ratio = targetRate/srcRate），
   * 与一次性重采样逐位一致，因此分块调用不产生接缝。
   *
   * @param {Object} srcPcm 源 PCM（只读，绝不修改）
   * @param {Object} opts
   *   - targetRate     目标采样率
   *   - targetChannels 目标声道数
   *   - gain           统一增益（归一化用，默认 1）
   *   - fadeMs         首尾淡变毫秒数（默认 0）
   *   - srcStart       只转换源区间 [srcStart, srcEnd)（默认 0）——片段剪切用，零拷贝
   *   - srcEnd         源区间结束帧（默认全长）
   *   - int16          true 时输出 Int16（钳位+缩放公式同 floatToInt16）；
   *                    false 时输出 Float32（默认）
   * @returns {{srcRate:number, outFrames:number, convert:Function}}
   *   convert(o0, o1, outChs) → 实际转换帧数；outChs[c] 为长度 ≥ (o1-o0) 的TypedArray
   */
  function createSegmentConverter(srcPcm, opts) {
    if (!srcPcm || !srcPcm.channels || !srcPcm.channels.length) {
      throw new Error('createSegmentConverter: 源 PCM 为空');
    }
    if (opts.targetChannels !== 1 && opts.targetChannels !== 2) {
      throw new Error('createSegmentConverter: 目标声道数只支持 1 或 2，收到 ' + opts.targetChannels);
    }
    var src = srcPcm.channels;
    var srcLen = src[0].length;
    var srcRate = srcPcm.sampleRate;
    var targetRate = opts.targetRate;
    var targetChannels = opts.targetChannels;
    var gain = typeof opts.gain === 'number' ? opts.gain : 1;
    var int16 = !!opts.int16;
    var ratio = targetRate / srcRate;
    // 源区间裁剪（剪切范围）：越界/倒置一律回退为整段
    var srcStart = (typeof opts.srcStart === 'number' && opts.srcStart > 0)
      ? Math.min(Math.floor(opts.srcStart), srcLen) : 0;
    var srcEnd = (typeof opts.srcEnd === 'number' && opts.srcEnd < srcLen)
      ? Math.max(Math.floor(opts.srcEnd), srcStart) : srcLen;
    var outFrames = conformedFrameCount(srcPcm, targetRate, srcStart, srcEnd);
    var fadeLen = Math.min(
      Math.floor((opts.fadeMs / 1000) * targetRate),
      Math.floor(outFrames / 2)
    );
    var scratch = new Float32Array(src.length); // 每帧各源声道插值

    function emit(v, out, n) {
      /* NaN / ±Infinity 消毒。
       * 安卓平台解码器（MediaCodec 一族）在部分 AAC/MP3 上会吐出 NaN 或越界样本，
       * 而且不报错。旧实现里 NaN 会一路穿过 clamp（NaN 的比较恒为 false），
       * 最终写进 Int16Array 时被静默变成 0——听感是波形上突然跳到零又跳回来，
       * 也就是用户描述的「电流声 / 噼啪杂音」。这里显式归零，宁可留一个静音样本，
       * 也不要把 NaN 扩散到整段。 */
      if (v !== v) v = 0;
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
        // 源位置 = 剪切起点 + 输出帧按比例映射。注意顺序：先按比例再平移。
        // 若写成 (abs + srcStart) / ratio，等于把剪切起点也缩放，跨采样率时会错位。
        pos = srcStart + abs / ratio;
        i0 = Math.floor(pos);
        var hold = i0 >= srcEnd - 1;
        if (hold) i0 = srcEnd - 1;
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
          // 源声道多于目标时取前 N 个；少于目标时用最后一个声道补齐，
          // 不写出 undefined（NaN 会一路污染成品）。
          for (c = 0; c < targetChannels; c++) {
            emit(scratch[Math.min(c, src.length - 1)] * g * gain, outChs[c], n);
          }
        }
      }
      return frames;
    }

    return { srcRate: srcRate, outFrames: outFrames, convert: convert };
  }

  /**
   * 单段在淡变后的峰值（不含归一化增益），支持只统计源区间 [srcStart, srcEnd)。
   *
   * 流式合并时用于预先计算全局增益：旧实现是"先拼接再 peakNormalize"，
   * 而拼接后的全局峰值 = 各段淡变后峰值的最大者（静音间隔不贡献峰值），
   * 因此两路径等值——这里用只读扫描完成，不分配任何大数组。
   */
  function segmentPeakAfterFade(srcPcm, targetRate, targetChannels, fadeMs, srcStart, srcEnd) {
    var src = srcPcm.channels;
    var srcLen = src[0].length;
    if (srcLen === 0) return 0;
    var s0 = (typeof srcStart === 'number' && srcStart > 0) ? Math.min(Math.floor(srcStart), srcLen) : 0;
    var s1 = (typeof srcEnd === 'number' && srcEnd < srcLen) ? Math.max(Math.floor(srcEnd), s0) : srcLen;
    var ratio = targetRate / srcPcm.sampleRate;
    var outFrames = conformedFrameCount(srcPcm, targetRate, s0, s1);
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
      // 同 createSegmentConverter：先按比例映射，再加剪切起点平移
      pos = s0 + n / ratio;
      i0 = Math.floor(pos);
      var hold = i0 >= s1 - 1;
      if (hold) i0 = s1 - 1;
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
   * 每个片段可带 trimStart / trimEnd（源帧）实现剪切——零拷贝，
   * 由转换器按源区间读取，不生成裁剪副本。
   * @returns {{targetSampleRate, targetChannels, gapFrames,
   *            parts:Array<{index:number, outFrames:number, trimStart:number, trimEnd:number}>, totalFrames}}
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
      var srcLen = seg.pcm.channels[0].length;
      var trimStart = (typeof seg.trimStart === 'number' && seg.trimStart > 0)
        ? Math.min(Math.floor(seg.trimStart), srcLen) : 0;
      var trimEnd = (typeof seg.trimEnd === 'number' && seg.trimEnd < srcLen)
        ? Math.max(Math.floor(seg.trimEnd), trimStart) : srcLen;
      var frames = conformedFrameCount(seg.pcm, opts.targetSampleRate, trimStart, trimEnd);
      if (frames === 0) continue; // 跳过空片段（与 concatSegments 一致）
      parts.push({
        index: i, outFrames: frames,
        trimStart: trimStart, trimEnd: trimEnd
      });
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
          plan.targetSampleRate, plan.targetChannels, opts.fadeMs,
          plan.parts[i].trimStart, plan.parts[i].trimEnd
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
        srcStart: part.trimStart,
        srcEnd: part.trimEnd,
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

    // RIFF 的 chunk size 是 32 位无符号：dataSize 与 36+dataSize 都必须能容纳。
    // setUint32 对超限值会静默截断，产出的文件头与实际数据长度不符（播放器按头截断，
    // 极端情况被当成 44 字节空文件），而流式落盘确实能写出 >4GB 的 WAV。
    // 因此在写头之前明确拒绝，而不是等结果文件已经损坏才发现。
    if (!isFinite(dataSize) || dataSize < 0 || dataSize > 0xffffffff - 36) {
      throw new Error('WAV 输出超过 RIFF 格式上限（约 4 GB）：请改用 MP3 或分段合并');
    }

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
   * 把多声道 Int16 采样交织成 WAV 数据块，返回**独立拷贝**。
   *
   * 为什么必须返回拷贝而不是视图：流式合并时调用方会复用同一块 scratch 缓冲，
   * 若返回 subarray 视图，所有已排队的数据块都会指向同一块内存，最终文件里
   * 每一块都是"最后一次写入的内容"——表现为整段音频反复重复同一小段
   * （V0.4.2 修的正是这个问题；MP3 路径因为编码器每次返回新数组而没有该问题）。
   *
   * @param {Int16Array[]} channels 各声道采样（长度需 >= frames）
   * @param {number} numChannels 声道数
   * @param {number} frames 本次写出的帧数
   * @param {Uint8Array} [scratch] 可复用的临时缓冲（长度需 >= frames*numChannels*2）
   * @returns {Uint8Array} 长度为 frames*numChannels*2 的新数组
   */
  function interleaveInt16WavChunk(channels, numChannels, frames, scratch) {
    var need = frames * numChannels * 2;
    var bytes = (scratch && scratch.byteLength >= need) ? scratch : new Uint8Array(need);
    var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var off = 0;
    for (var n = 0; n < frames; n++) {
      for (var c = 0; c < numChannels; c++) {
        view.setInt16(off, channels[c][n], true);
        off += 2;
      }
    }
    return bytes.slice(0, need);
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
    // lamejs 的 Mp3Encoder 只接受 1/2 声道；>2 时旧实现只编码前两声道却把
    // numChannels 原样传进去，得到的是声道数声明与实际数据不符的坏文件。
    if (numChannels !== 1 && numChannels !== 2) {
      throw new Error('encodeMP3: 只支持单声道或立体声，收到 ' + numChannels + ' 声道');
    }
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

  /* ------------------------------------------------------------------ *
   * 格式嗅探与兜底解码（V0.3.2）
   *
   * 平台 decodeAudioData 失败时（Android 各厂商内核、桌面 Chrome 的 AAC 等），
   * 先用魔数判断"实际是什么格式"，再决定：
   *   - 能用内置解析器的（WAV / MP3）直接解；
   *   - 不能的，给出精确原因与可操作建议，而不是笼统的“解码失败”。
   * ------------------------------------------------------------------ */

  /**
   * 魔数嗅探：识别容器 / 编码。
   * @param {Uint8Array} bytes
   * @returns {{container:string, codec:string, label:string, advice:string}}
   */
  function sniffFormat(bytes) {
    function ascii(off, len) {
      var s = '';
      for (var i = 0; i < len && off + i < bytes.length; i++) {
        s += String.fromCharCode(bytes[off + i]);
      }
      return s;
    }
    if (!bytes || bytes.length === 0) {
      return {
        container: 'empty', codec: '',
        label: '空文件（0 字节）',
        advice: '可能是云盘文件未下载完成，或读取被系统拦截；请先把文件保存到本机再导入'
      };
    }
    var unknown = { container: 'unknown', codec: '', label: '未知格式', advice: '' };
    if (bytes.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WAVE') {
      return { container: 'wav', codec: 'pcm', label: 'WAV（PCM 音频）', advice: '' };
    }
    if (bytes.length >= 3 && ascii(0, 3) === 'ID3') {
      return { container: 'mp3', codec: 'mpeg-layer3', label: 'MP3（MPEG Layer III，含 ID3 标签）', advice: '' };
    }
    // AAC 裸流（ADTS）同步字 0xFFF + 层位 00（F0/F1/F8/F9 等），必须先于通用 MPEG 判断。
    // 旧写法只认 F1/F9，会漏掉 F0/F8 一类变体，让它们落到"未知格式"拿不到转换建议
    if (bytes.length >= 2 && bytes[0] === 0xFF && (bytes[1] & 0xF6) === 0xF0) {
      return {
        container: 'aac-adts', codec: 'aac',
        label: 'AAC 裸流（ADTS）',
        advice: '浏览器对裸 AAC 流支持有限，建议转为 M4A 或 MP3'
      };
    }
    if (bytes.length >= 2 && bytes[0] === 0xFF && (bytes[1] & 0xE0) === 0xE0) {
      var layer = (bytes[1] >> 1) & 3;
      if (layer !== 0) { // layer=0 为保留值，不是合法 MPEG 音频帧
        var layerName = layer === 1 ? 'Layer III' : (layer === 2 ? 'Layer II' : 'Layer I');
        return { container: 'mp3', codec: 'mpeg-' + layerName.toLowerCase(), label: 'MPEG 音频（' + layerName + '）', advice: '' };
      }
    }
    if (bytes.length >= 8 && ascii(4, 4) === 'ftyp') {
      var brand = ascii(8, 4).replace(/[^\x20-\x7e]/g, '');
      return {
        container: 'mp4', codec: 'aac',
        label: 'M4A/MP4 容器（' + (brand || '未知品牌') + '，音频通常为 AAC）',
        advice: '桌面版 Chrome/Edge 不解码 AAC；手机上如仍失败，请转为 MP3 或 WAV'
      };
    }
    if (bytes.length >= 4 && ascii(0, 4) === 'OggS') {
      return { container: 'ogg', codec: 'opus-or-vorbis', label: 'OGG（Opus / Vorbis）', advice: '' };
    }
    if (bytes.length >= 4 && ascii(0, 4) === 'fLaC') {
      return { container: 'flac', codec: 'flac', label: 'FLAC（无损）', advice: '' };
    }
    if (bytes.length >= 5 && ascii(0, 5) === '#!AMR') {
      return {
        container: 'amr', codec: 'amr',
        label: 'AMR（手机通话录音常见格式）',
        advice: '浏览器普遍不支持 AMR，请在手机上用「录音机」或格式转换工具转为 MP3 / WAV'
      };
    }
    if (bytes.length >= 4 && bytes[0] === 0x1A && bytes[1] === 0x45 && bytes[2] === 0xDF && bytes[3] === 0xA3) {
      return { container: 'webm', codec: 'opus-or-vorbis', label: 'WebM（Opus / Vorbis）', advice: '' };
    }
    if (bytes.length >= 16 && bytes[0] === 0x30 && bytes[1] === 0x26 && bytes[2] === 0xB2 && bytes[3] === 0x75) {
      return { container: 'asf', codec: 'wma', label: 'WMA（Windows Media Audio）', advice: '浏览器不支持 WMA，请转为 MP3 / WAV' };
    }
    if (bytes.length >= 4 && ascii(0, 4) === 'MAC ') {
      return { container: 'ape', codec: 'ape', label: 'APE（Monkey\'s Audio 无损）', advice: '浏览器不支持 APE，请转为 FLAC / MP3' };
    }
    if (bytes.length >= 12 && ascii(0, 4) === 'FORM' && (ascii(8, 4) === 'AIFF' || ascii(8, 4) === 'AIFC')) {
      return { container: 'aiff', codec: 'pcm', label: 'AIFF（PCM 音频）', advice: '浏览器支持有限，建议转为 WAV' };
    }
    if (bytes.length >= 4 && ascii(0, 4) === 'caff') {
      return { container: 'caf', codec: 'alac-or-pcm', label: 'CAF（Apple 音频容器）', advice: '浏览器不支持 CAF，建议转为 WAV / MP3' };
    }
    // SILK（微信语音）：真实文件常形如 \x02#!SILK_V3，也有直接从 #!SILK_V3 开始的，
    // magic 起始偏移不固定 —— 因此在头部 16 字节里搜索，而不是只看固定偏移。
    if (ascii(0, 16).indexOf('SILK') !== -1) {
      return { container: 'silk', codec: 'silk', label: 'SILK（微信语音格式）', advice: '微信语音为 SILK 编码，需先导出为 MP3 / WAV' };
    }
    return unknown;
  }

  /** WAVE 格式代码 → 可读名称（用于拒绝不支持的压缩格式时给出准确原因） */
  var WAVE_FORMAT_NAMES = {
    2: 'Microsoft ADPCM', 6: 'A-law', 7: 'μ-law', 17: 'IMA ADPCM',
    49: 'GSM 6.10', 80: 'MPEG', 85: 'MPEG Layer III', 353: 'WMA',
    65534: 'WAVE_FORMAT_EXTENSIBLE（子格式信息不完整）'
  };
  function waveFormatLabel(code) {
    if (WAVE_FORMAT_NAMES[code]) return WAVE_FORMAT_NAMES[code] + '(0x' + code.toString(16) + ')';
    return '未知格式代码 0x' + code.toString(16);
  }

  /**
   * 手动解析 WAV（RIFF/WAVE）——平台解码器失败时的兜底。
   * 支持 PCM 8/16/24/32bit 与 IEEE float 32/64bit，容忍未知块、乱序块与奇数长度块。
   * @param {Uint8Array} bytes
   * @returns {{sampleRate:number, channels:Float32Array[]}}
   */
  function decodeWav(bytes) {
    if (!bytes || bytes.length < 44) throw new Error('WAV 文件过短');
    function u16(off) { return bytes[off] | (bytes[off + 1] << 8); }
    function u32(off) {
      return (bytes[off] | (bytes[off + 1] << 8) | (bytes[off + 2] << 16) | (bytes[off + 3] << 24)) >>> 0;
    }
    function str(off, len) {
      var s = '';
      for (var i = 0; i < len; i++) s += String.fromCharCode(bytes[off + i]);
      return s;
    }
    if (str(0, 4) !== 'RIFF' || str(8, 4) !== 'WAVE') throw new Error('不是 RIFF/WAVE 文件');

    var pos = 12, fmt = null, dataOff = -1, dataLen = 0;
    while (pos + 8 <= bytes.length) {
      var id = str(pos, 4);
      var size = u32(pos + 4);
      var body = pos + 8;
      if (id === 'fmt ' && size >= 16) {
        var audioFormat = u16(body);
        var numChannels = u16(body + 2);
        var sampleRate = u32(body + 4);
        var bitsPerSample = u16(body + 14);
        // WAVE_FORMAT_EXTENSIBLE：真实格式在子格式 GUID 的前 2 字节
        if (audioFormat === 0xFFFE && size >= 40) audioFormat = u16(body + 24);
        fmt = {
          audioFormat: audioFormat,
          numChannels: numChannels,
          sampleRate: sampleRate,
          bitsPerSample: bitsPerSample
        };
      } else if (id === 'data') {
        dataOff = body;
        dataLen = Math.min(size, bytes.length - body);
        if (fmt) break; // fmt 与 data 都拿到即可收工（不依赖块顺序）
      }
      pos = body + size + (size & 1); // RIFF 块按偶数字节对齐
    }
    if (!fmt) throw new Error('WAV 缺少 fmt 块');
    if (dataOff < 0) throw new Error('WAV 缺少 data 块');
    if (!fmt.numChannels || fmt.numChannels > 8) throw new Error('WAV 声道数异常: ' + fmt.numChannels);
    if (!fmt.sampleRate) throw new Error('WAV 采样率异常');
    // 白名单：只接受未压缩 PCM(1) 与 IEEE float(3)。
    // 其余编码（A-law 6 / μ-law 7 / ADPCM 2,17 / GSM 0x31 / MPEG-in-WAV 0x55 …）
    // 的存储布局与 PCM 完全不同，若继续按 PCM 逐字节解析，产出的是满幅噪声而不是
    // 错误——这种"看起来成功、实际是噪音"的结果会直接混进用户成品，必须显式拒绝。
    if (fmt.audioFormat !== 1 && fmt.audioFormat !== 3) {
      throw new Error('WAV 内置解析器不支持该压缩格式：' +
        waveFormatLabel(fmt.audioFormat) + '（仅支持未压缩 PCM / IEEE float）。' +
        '请用格式转换工具转为普通 WAV 或 MP3 后再导入');
    }
    var bytesPerSample = fmt.bitsPerSample / 8;
    if ([1, 2, 3, 4, 8].indexOf(bytesPerSample) === -1) {
      throw new Error('WAV 位深不支持: ' + fmt.bitsPerSample);
    }
    // IEEE float WAV 只定义 32/64 位；若遇到 float 头但位深为 8/16/24，
    // 旧实现的 isFloat 分支对 1/2/3 字节一律写 0，会静默产出整段静音。
    if (fmt.audioFormat === 3 && bytesPerSample !== 4 && bytesPerSample !== 8) {
      throw new Error('IEEE float WAV 位深不支持: ' + fmt.bitsPerSample +
        '（仅支持 32 / 64 位浮点）');
    }
    var blockAlign = fmt.numChannels * bytesPerSample;
    var frames = Math.floor(dataLen / blockAlign);
    if (frames <= 0) throw new Error('WAV 无可解析的采样数据');

    var channels = [];
    for (var c = 0; c < fmt.numChannels; c++) channels.push(new Float32Array(frames));
    var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var isFloat = fmt.audioFormat === 3;
    var i, off, v, s;
    for (i = 0; i < frames; i++) {
      for (c = 0; c < fmt.numChannels; c++) {
        off = dataOff + i * blockAlign + c * bytesPerSample;
        if (isFloat) {
          v = bytesPerSample === 4 ? dv.getFloat32(off, true)
            : (bytesPerSample === 8 ? dv.getFloat64(off, true) : 0);
        } else if (bytesPerSample === 1) {
          // 8bit WAV 为无符号 [0,255]；用 127.5 作中点才能让 0→-1、255→+1
          // 对称满幅（旧的 /128 会让正半轴少 1 LSB，且 0 映射到 -1、255 只到 0.992）
          v = (bytes[off] - 127.5) / 127.5;
        } else if (bytesPerSample === 2) {
          v = dv.getInt16(off, true) / 32768;
        } else if (bytesPerSample === 3) {
          s = bytes[off] | (bytes[off + 1] << 8) | (bytes[off + 2] << 16);
          if (s & 0x800000) s |= 0xff000000;
          v = s / 8388608;
        } else {
          v = dv.getInt32(off, true) / 2147483648;
        }
        channels[c][i] = v;
      }
    }
    return { sampleRate: fmt.sampleRate, channels: channels };
  }

  /**
   * 计算片段剪切后的有效时长（秒）。
   *
   * 必须与 app.js 的 segTrimFrames 对「无效范围」的处理保持一致：起止倒置、相等、
   * 终点为 0、起点超过时长，一律回退整段。旧实现返回 0（起点>时长时甚至返回负值），
   * 而 planMerge 按整段输出，造成界面显示 0 秒却合并出整段音频，并绕过体积保护。
   *
   * @param {number} duration 片段总时长（秒）
   * @param {number} [trimStart] 起点（秒）
   * @param {number} [trimEnd] 终点（秒）
   * @returns {number} 有效时长（秒，恒 >= 0）
   */
  function effectiveDurationSec(duration, trimStart, trimEnd) {
    var dur = Number(duration);
    if (!isFinite(dur) || dur <= 0) return 0;
    var s = (typeof trimStart === 'number' && isFinite(trimStart)) ? trimStart : 0;
    var e = (typeof trimEnd === 'number' && isFinite(trimEnd)) ? trimEnd : dur;
    s = Math.max(0, Math.min(s, dur));
    e = Math.max(0, Math.min(e, dur));
    if (e <= s) return dur;
    return e - s;
  }

  /**
   * 短音频判定（「警告但保留」策略）。
   *
   * 只有 0 帧 / 非数 / 负时长才是真正的无效解码，必须交给降级链或报错；
   * 0 < duration < threshold 的极短结果既可能是合法提示音/音效，也可能是损坏
   * 文件解出的噪声，单凭时长无法区分。因此保留结果并返回警示文案，由用户试听决定，
   * 不再静默丢弃或误报「解码失败」。
   *
   * @param {number} durationSec 解码结果时长（秒）
   * @param {number} thresholdSec 警示阈值（app.js 传 MIN_VALID_SEC）
   * @returns {{valid: boolean, warning: (string|null)}}
   */
  function assessShortAudio(durationSec, thresholdSec) {
    var d = Number(durationSec);
    if (!isFinite(d) || d <= 0) return { valid: false, warning: null };
    var t = Number(thresholdSec);
    if (!isFinite(t) || t <= 0 || d >= t) return { valid: true, warning: null };
    return {
      valid: true,
      warning: '解码时长仅 ' + (d * 1000).toFixed(0) +
        ' 毫秒：可能是极短音效，也可能是损坏文件，请试听确认后再合并'
    };
  }

  /**
   * 选择整次合并的目标声道数：全部片段均为单声道时输出单声道（编码量约减半），
   * 否则统一输出立体声。
   *
   * 关键约束：一次合并**只能有一个**目标声道数。WAV 头（numChannels / blockAlign /
   * byteRate / dataSize）、MP3 编码器状态、Int16 缓冲与交织缓冲都在合并开始时按它
   * 初始化；若逐段变化，会产出头部与实际数据不符的损坏文件。
   * 因此混合输入必须上混为立体声，不能让各段保留自己的声道数。
   * 数据未就绪或异常时保守回退立体声，避免估算与合并结果不一致。
   *
   * @param {Array<{pcm?:{channels:Array}}>} segments
   * @returns {number} 1 或 2
   */
  function pickTargetChannels(segments) {
    if (!segments || !segments.length) return 2;
    for (var i = 0; i < segments.length; i++) {
      var seg = segments[i];
      var n = 0;
      if (seg && seg.pcm && seg.pcm.channels && seg.pcm.channels.length) {
        n = seg.pcm.channels.length;
      } else if (seg && typeof seg.channels === 'number' && seg.channels > 0) {
        // 流式合并会逐段释放 pcm；解码时保存的 channels 仍在，用它保持判定稳定，
        // 否则合并后 UI 会从「单声道」翻转成「立体声」，与实际产物不符。
        n = seg.channels;
      }
      if (n !== 1) return 2;
    }
    return 1;
  }

  /**
   * MP4/M4A 解封装：提取 AAC 帧序列与 AudioSpecificConfig。
   *
   * 用途：部分安卓内核的 decodeAudioData 解 AAC 会随机丢帧（实测 54.36s 只解出
   * 50.15s，且不报错）。WASM 解码器（faad2）需要裸 AAC 帧 + ASC，本函数从
   * MP4/M4A 的 moov 样本表（stsd/stsz/stsc/stco/co64）中取出这些数据。
   *
   * 纯函数，只读输入字节；单音频轨（hdlr 'soun'）；stsd 条目须为 'mp4a'。
   * @param {Uint8Array} bytes 完整文件字节
   * @returns {{asc:Uint8Array, frames:Uint8Array[], sampleRate:number,
   *            channels:number, samplesPerFrame:number}|null} null = 结构不支持
   */
  function mp4ExtractAac(bytes) {
    if (!bytes || bytes.length < 32) return null;

    function u32(off) {
      return ((bytes[off] << 24) | (bytes[off + 1] << 16) |
        (bytes[off + 2] << 8) | bytes[off + 3]) >>> 0;
    }
    function u16(off) { return (bytes[off] << 8) | bytes[off + 1]; }
    function u64(off) { return u32(off) * 4294967296 + u32(off + 4); }
    function tag(off, len) {
      var s = '';
      for (var i = 0; i < len && off + i < bytes.length; i++) {
        s += String.fromCharCode(bytes[off + i]);
      }
      return s;
    }

    // 递归展开容器 box（只展开已知容器，避免把 mdat 也遍历进来）
    var CONTAINERS = { moov: 1, trak: 1, mdia: 1, minf: 1, stbl: 1 };
    var all = [];
    (function walk(start, end, depth) {
      if (depth > 6) return;
      var p = start;
      while (p + 8 <= end) {
        var size = u32(p);
        var type = tag(p + 4, 4);
        var hdr = 8;
        if (size === 1) { size = u64(p + 8); hdr = 16; }
        else if (size === 0) { size = end - p; }
        if (size < hdr || p + size > end) break;
        all.push({ type: type, start: p, end: p + size, hdr: hdr });
        if (CONTAINERS[type]) walk(p + hdr, p + size, depth + 1);
        p += size;
      }
    })(0, bytes.length, 0);

    // 找音频轨（其 trak 子树内有 hdlr 'soun'），并取它的 stbl
    function inRange(box, start, end) {
      return box.start >= start && box.end <= end;
    }
    var stbl = null;
    for (var t = 0; t < all.length && !stbl; t++) {
      var tk = all[t];
      if (tk.type !== 'trak') continue;
      var hasSound = false;
      for (var h = 0; h < all.length; h++) {
        var hb = all[h];
        if (hb.type === 'hdlr' && inRange(hb, tk.start, tk.end)) {
          // hdlr body: fullbox(4) + preDefined(4) + handlerType(4)
          if (tag(hb.start + hb.hdr + 8, 4) === 'soun') hasSound = true;
          break;
        }
      }
      if (!hasSound) continue;
      for (var s = 0; s < all.length; s++) {
        var sb = all[s];
        if (sb.type === 'stbl' && inRange(sb, tk.start, tk.end)) { stbl = sb; break; }
      }
    }
    if (!stbl) return null;

    function childrenOf(box) {
      var list = [];
      var p = box.start + box.hdr;
      var end = box.end;
      while (p + 8 <= end) {
        var size = u32(p);
        var type = tag(p + 4, 4);
        var hdr = 8;
        if (size === 1) { size = u64(p + 8); hdr = 16; }
        else if (size === 0) { size = end - p; }
        if (size < hdr || p + size > end) break;
        list.push({ type: type, start: p, end: p + size, hdr: hdr });
        p += size;
      }
      return list;
    }

    var stblChildren = childrenOf(stbl);
    function findIn(list, type) {
      for (var i = 0; i < list.length; i++) if (list[i].type === type) return list[i];
      return null;
    }

    var stsd = findIn(stblChildren, 'stsd');
    var stsz = findIn(stblChildren, 'stsz');
    var stsc = findIn(stblChildren, 'stsc');
    var stco = findIn(stblChildren, 'stco');
    var co64 = findIn(stblChildren, 'co64');
    if (!stsd || !stsz || !stsc || (!stco && !co64)) return null;

    // stsd → mp4a 条目 → 采样率/声道 + esds → AudioSpecificConfig
    var stsdBody = stsd.start + stsd.hdr;
    var entryCount = u32(stsdBody + 4);
    if (entryCount < 1) return null;
    var e = stsdBody + 8; // 第一个 entry：size(4) + format(4)
    var eSize = u32(e);
    if (tag(e + 4, 4) !== 'mp4a') return null; // 只支持 AAC（mp4a）
    var channels = u16(e + 24);
    var sampleRate = (u32(e + 32) >>> 16); // 16.16 定点，先取后用无符号右移

    // esds → ES_Descriptor → DecoderConfigDescriptor → AudioSpecificConfig（tag 5）
    var asc = null;
    var esds = null;
    var childStart = e + 36;
    for (var k = childStart; k < e + eSize - 8; k++) {
      if (tag(k, 4) === 'esds') { esds = { start: k }; break; }
    }
    if (esds) {
      // esds.start 存的是 type 字段命中位置；描述符从
      // size(4)+type(4)+fullbox(4) 之后开始，即 type + 8
      var p2 = esds.start + 8; // ES_DescrTag 位置
      function descLen(pos) {
        var v = 0, n = 0;
        while (n < 4 && pos < bytes.length) {
          var b = bytes[pos];
          v = (v << 7) | (b & 0x7f);
          n++;
          if (!(b & 0x80)) break;
        }
        return { len: v, next: pos + n };
      }
      if (bytes[p2] === 3) { // ES_DescrTag
        var l1 = descLen(p2 + 1);
        var q = l1.next;
        q += 3; // ES_ID(2) + flags(1)
        if (bytes[q - 1] & 0x80) q += 2;          // dependsOn_ES_ID
        if (bytes[q - 1] & 0x40) q += 1 + bytes[q]; // URL
        if (bytes[q - 1] & 0x20) q += 2;          // OCR_ES_Id
        if (bytes[q] === 4) { // DecoderConfigDescrTag
          var l2 = descLen(q + 1);
          var r = l2.next + 13; // objType(1)+bufSize(3)+maxBR(4)+avgBR(4)
          if (bytes[r] === 5) { // DecSpecificInfoTag
            var l3 = descLen(r + 1);
            if (l3.len > 0 && r + 2 + l3.len <= bytes.length) {
              asc = bytes.slice(r + 2, r + 2 + l3.len);
            }
          }
        }
      }
    }
    if (!asc || asc.length < 2) return null;

    // stsz → 每帧大小
    var szBody = stsz.start + stsz.hdr;
    var fixedSize = u32(szBody + 4);
    var frameCount = u32(szBody + 8);
    if (!frameCount) return null;

    // stsc → 每块帧数；stco/co64 → 块偏移
    function fullEntries(box, itemSize) {
      var body = box.start + box.hdr;
      var cnt = u32(body + 4);
      var list = [];
      for (var i = 0; i < cnt; i++) {
        if (itemSize === 12) list.push(u32(body + 8 + i * 12));
        else list.push(u64(body + 8 + i * 8));
      }
      return list;
    }
    var stscBody = stsc.start + stsc.hdr;
    var scCount = u32(stscBody + 4);
    var scFirst = [], scPer = [];
    for (var m = 0; m < scCount; m++) {
      scFirst.push(u32(stscBody + 8 + m * 12));       // 1-based 起始块号
      scPer.push(u32(stscBody + 12 + m * 12));        // 每块帧数
    }
    var chunkOffsets = fullEntries(stco || co64, stco ? 4 : 8);
    if (!chunkOffsets.length) return null;

    function chunkOffset(zeroBased) {
      return stco ? u32(stco.start + stco.hdr + 8 + zeroBased * 4)
        : u64(co64.start + co64.hdr + 8 + zeroBased * 8);
    }

    // 逐帧映射绝对偏移
    var frames = [];
    var sampleIdx = 0;
    var scIdx = 0;
    var chunkIdx = scFirst[0] - 1; // 0-based
    var left = scPer[0];
    var pos = chunkOffset(chunkIdx);
    for (var fi = 0; fi < frameCount; fi++) {
      var fsize = fixedSize > 0 ? fixedSize : u32(szBody + 12 + fi * 4);
      if (pos + fsize > bytes.length) return null;
      frames.push(bytes.subarray(pos, pos + fsize));
      pos += fsize;
      sampleIdx += 1;
      left--;
      if (left === 0 && fi < frameCount - 1) {
        chunkIdx++;
        if (scIdx + 1 < scCount && chunkIdx + 1 >= scFirst[scIdx + 1] - 1) scIdx++;
        pos = chunkOffset(chunkIdx);
        left = scPer[scIdx];
      }
    }

    return {
      asc: asc,
      frames: frames,
      sampleRate: sampleRate,
      channels: channels,
      // AAC-LC 每帧 1024 个样本；其他 profile 少见，按 ASC 粗略给出
      samplesPerFrame: 1024,
      sampleCount: sampleIdx
    };
  }

  return {
    APP_VERSION: APP_VERSION,
    DEFAULTS: DEFAULTS,
    mergeOptions: mergeOptions,
    effectiveDurationSec: effectiveDurationSec,
    assessShortAudio: assessShortAudio,
    pickTargetChannels: pickTargetChannels,
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
    interleaveInt16WavChunk: interleaveInt16WavChunk,
    conformedFrameCount: conformedFrameCount,
    createSegmentConverter: createSegmentConverter,
    segmentPeakAfterFade: segmentPeakAfterFade,
    planMerge: planMerge,
    sniffFormat: sniffFormat,
    mp4ExtractAac: mp4ExtractAac,
    decodeWav: decodeWav,
    floatToInt16: floatToInt16,
    pcmToInt16Channels: pcmToInt16Channels,
    encodeMP3: encodeMP3
  };
});
