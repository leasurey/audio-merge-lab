/**
 * app.js — 录音合并器 UI 层（依赖 window.AudioCore 与 window.lamejs）
 *
 * 职责：文件导入 / 录音 / 片段试听与排序 / 合并（WAV·MP3·M4A）/ 导出与分享。
 * 所有音频处理均在本地完成，不上传任何数据。
 *
 * 导入性能设计（2026-10-17 实测驱动）：
 *   - 选中文件立即入列显示「解码中」，队列顺序解码，逐条汇报——不等；
 *   - 点「导入」（文件选择器打开前）/「开始录音」（权限弹窗前）预热音频管线，
 *     移动端选择器/权限框要数秒，预热完全藏在这段等待里；
 *   - PCM 零拷贝存储（持有 AudioBuffer 声道视图，合并管线从不原地改输入）；
 *   - 合并目标采样率自适应：输入同为 48kHz 时沿用，免重采样。
 */
(function () {
  'use strict';

  /* ---------------- 状态 ---------------- */
  var state = {
    segments: [],     // {id, name, source, blob, url, pcm, duration, sampleRate, channels, decoding, failed, errorMsg,
    //                   trimStart, trimEnd（剪切范围，秒；null = 不剪切）, trimOpen（面板展开）}
    audioCtx: null,
    mediaRecorder: null,
    recordChunks: [],
    recordTimer: null,
    recordStart: 0,
    seq: 0,
    playingId: null,  // 正在试听的片段 id
    format: 'mp3',    // 输出格式：wav / mp3 / m4a（默认 MP3：体积小、通用性最好）
    bitrate: 128,     // MP3 位率（kbps）
    m4aSupported: false,
    m4aRecorder: null,
    busy: false,
    mergeToken: 0,    // 取消令牌：每次合并自增，回调里比对
    mergedBlob: null,
    mergedUrl: null,
    mergedExt: 'mp3',
    recordPending: false, // 录音权限请求进行中（防止连点产生多个 MediaRecorder/流）
    serverReady: false    // 是否检测到局域网下载服务（tools/serve.js）
  };

  // 拖拽排序状态（pointer events，一套代码兼容鼠标与触摸）
  var segDrag = null; // {id, li, pointerId}
  var pendingRender = false; // 拖拽期间被推迟的列表重建

  var decodeQueue = [];    // 待解码片段队列（顺序执行，控制内存峰值）
  var decodeRunning = false;
  var warmStarted = false; // 音频管线预热只做一次

  // 上传通道：双入口（分享按钮 / 保存链接按钮）共用一把锁，且必须可超时、可取消
  var uploadState = { xhr: null, busy: false };

  // 预热燃料：0.1 秒 128kbps MPEG-1 Layer III（FF FB 头，与真实文件同解码路径）。
  // 由 tools 生成脚本用官方 lamejs 编码后内联，仅用于预热，解码后即丢弃。
  var TINY_MP3_B64 =
    '//uQBAAIglsnQJsaGNBLZOgTY0MaCfDfFayYaQE+G+K1kw0gCjjQAARwCEBDAKzIgTENjiMgMkRQU3ceJuW/8bjcvpw' +
    'AAABCIiI7u7u7+n8RM93d3hf/6Fu7n/v/AA5kIfPyjgTHAgMOLP//+D/ygUcaAACOAQgIYBWZECYhscRkBkiKCm7' +
    'jxNy3/jcbl9OAAAAIRERHd3d3f0/iJnu7u8L//Qt3c/9/4AHMhD5+UcCY4EBhxZ///wf+UCUbl2tZFaGnaa8nsaf' +
    'waazl3Y0FAx1USJEpmZIkSMrGZmZmZVC0lJaxsbRg3lSq2LEo7Mez9Vg7kucYuo17mV0Fhjae5EoQ1EYGpV/ln/t' +
    'CUbl2tZFaGnaa8nsafwaazl3Y0FAx1USJEpmZIkSMrGZmZmZVC0lJaxsbRg3lSq2LEo7Mez9Vg7kucYuo17mV0Fhj' +
    'ae5EoQ1EYGpV/ln/tTEFNRQMACQgABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
    'AAAAAAAAAAAAAAAAAAAA//uSBAAIgrQ4QcuCKuBWhwg5cEVcDH2bAs4Iq4GPs2BZwRVwAAAJ+pApaaGXCEAJMowM' +
    'ycCWDUuVLDQEXv/uHRfV5go5XOM5XM86DKOt0yuLiD+lai4Nt1ZyDDdHY24K3dkxo3aWvbq05hLmItF36NeK2mKR' +
    'zAh96aaAAACfqQKWmhlwhACTKMDMnAlg1LlSw0BF7/7h0X1eYKOVzjOVzPOgyjrdMri4g/pWouDbdWcgw3R2NuCt' +
    '3ZMaN2lr26tOYS5iLRd+jXitpikcwIfemmgK0oBnYjbDAKDTRUhNDg0vQ19/4YdMDrt+mEMt9VdSDswMktGYxxj' +
    'McQOQiKKRQJJ1slYIitzs8Yzas5aDxdPdMiv+yXrvpfx3jzTLSzashH6519T+WyWOm6Ijiq3t7jL3Dz0eFaUAzs' +
    'RthgFBpoqQmhwaXoa+/8MOmB12/TCGW+qupB2YGSWjMY4xmOIHIRFFIoEk62SsERW52eMZtWctB4unumRX/ZL13' +
    '0v47x5plpZtWQj9c6+p/LZLHTdERxVb29xl7h56PTEFNRQMACQgAP/7kgQACIK0T0JTZhGQVonoSmzCMgt04QdN' +
    'gKxBbpwg6bAViAAALckaQAypZU6IjBDQOQz8CZalJIFE+33RoVVZG+CHFQptkctQSyOo2DIQWYQ1lZmQGgNWtg+' +
    '7M1bvIcCVbMU2HBP0W+7p//9Fu/+0F1MTfuV1s+AugAAC3JGkAMqWVOiIwQ0DkM/AmWpSSBRPt90aFVWRvghxUK' +
    'bZHLUEsjqNgyEFmENZWZkBoDVrYPuzNW7yHAlWzFNhwT9Fvu6f//Rbv/tBdTE37ldbPgLoQqNpIgDDOUOWFAI2f' +
    'ONiAlL3cjErfSk35yq0WqzvVWUYLpIZnVTNQY91S6DVYcNbrZVU4MR+VXnEVuqmciocMranEBjlJGTTUejDRFl+' +
    'XdYhtT7dGOIPYmkfdLoVG0kQBhnKHLCgEbPnGxASl7uRiVvpSb85VaLVZ3qrKMF0kMzqpmoMe6pdBqsOGt1sqq' +
    'cGI/KrziK3VTORUOGVtTiAxykjJpqPRhoiy/LusQ2p9ujHEHsTSPul0xBTUUDAAkIAAQAAAAAAAAAAAAAAAAAA' +
    'AAD/+5IEAAiCiThCU2YpkFEnCEpsxTILkOEHTYirgXIcIOmxFXAAAB1I2kAKtaUukIgUz3rM6BWvEaIgwt7/rj' +
    'hjN1d2CUpggYk/Ywx2Uhn1dR4W/ZmSdwJX5rK/ZHV0FhP3q8a7mNRs7q8dcjSvl9W21Phj5/UAAA6kbSAFWtKX' +
    'SEQKZ71mdArXiNEQYW9/1xwxm6u7BKUwQMSfsYY7KQz6uo8LfszJO4Er81lfsjq6Cwn71eNdzGo2d1eOuRpXy+' +
    'rbanwx8/qAqJtsgDtJK3IBoCbRimzgKajvxuUQGBp/92FPZspTIGIzBlRnY71GPIZSNUWcVYfuhXOw0gRGr7C0' +
    '5B7noWZUFxb2Rcg2um96bctjZ9qKR77VHKu9gExrHUaqaKQKibbIA7SStyAaAm0Yps4Cmo78blEBgaf/dhT2b' +
    'KUyBiMwZUZ2O9RjyGUjVFnFWH7oVzsNIERq+wtOQe56FmVBcW9kXINrpvem3LY2faike+1RyrvYBMax1Gqmil' +
    'MQU1FAwAJCAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//uSBAAMwr44QxtPMaBXxwhjaeY0C1xa7AzhKIFri' +
    '12BnCUQLjjhAV4jeqYIAAkiY/oNsy2hfSkNORNK9qUTMSQPqLrLnYfYfYbE49tNntF1llbD/M3/dpth+0/amAp' +
    'tb47b+db/vPx/Y1cPuPPo1Fjw43b/kr/V0f//pLjjhAV4jeqYIAAkiY/oNsy2hfSkNORNK9qUTMSQPqLrLnYfY' +
    'fYbE49tNntF1llbD/M3/dpth+0/amAptb47b+db/vPx/Y1cPuPPo1Fjw43b/kr/V0f//pM3IJPPSE09gTecxR5' +
    'gHNKYeAEWJ/G4aMy11ctKftroKiQGgqUFxSk9Em5Eqw0qliK3SvJKg6HQkDoUAqWgUkFQESCmMR/oFiQVT/pFw' +
    'E0f0D2D/jCT0CqVJFkGbkEnnpCaewJvOYo8wDmlMPACLE/jcNGZa6uWlP210FRIDQVKC4pSeiTciVYaVSxFbpX' +
    'klQdDoSB0KAVLQKSCoCJBTGI/0CxIKp/0i4CaP6B7B/xhJ6BVKkiyExBTUUDAAkIAAQAAAAAAAAAAAAAAAAAAAA' +
    '==';

  var FORMAT_LABELS = { wav: 'WAV', mp3: 'MP3', m4a: 'M4A' };

  /**
   * 嗅探用头部字节数：魔数识别只需要文件开头几十字节，但为兼容"信息块很长、
   * 载体 magic 稍靠后"的情况留足余量。必须是**副本**，不能是与解码共享的视图。
   */
  var SNIFF_HEAD_BYTES = 65536;

  /**
   * 解码结果的最短有效时长（秒）。
   *
   * 实测依据（Edge/Chrome）：对"魔数合法但内容损坏"的文件，平台解码器既**不报错**，
   * 又只解出极短的一小段——例如伪造 MPEG 头 + 垃圾数据会给出 1253 帧 / 0.026 秒。
   * 这种结果完全不可用，但走的是成功分支（连承promise 都 resolve），
   * 于是用户看到「已解码 0:00」，合并时又被 planMerge 静默跳过：那一段无声无息消失。
   *
   * 0.05 秒（约 2400 帧 @48kHz）是「警示阈值」而不是拒绝阈值：
   * 极短但非零的结果统一「警告但保留」——合法短音效不该被误杀，损坏文件解出的
   * 噪声则通过列表里的黄色警示行交用户试听判断。只有 0 帧 / 非数时长才转降级链
   * 或报错（见 AudioCore.assessShortAudio）。
   */
  var MIN_VALID_SEC = 0.05;

  /* ---------------- DOM 助手 ---------------- */
  function $(id) { return document.getElementById(id); }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function isAndroid() {
    return /Android/i.test(navigator.userAgent || '');
  }

  function nextFrame() {
    return new Promise(function (r) {
      /* 后台标签页里 rAF 完全停摆——切后台/锁屏时合并会卡住不动，直到回到前台。
       * setTimeout 在后台虽被节流（约 1 秒/次）但仍能推进；长音频里每 8 块让出一次，
       * 累积起来可能是数分钟纯等待。
       * 安卓优先优化：MessageChannel 的 task 不依赖 timer 节流，能大幅减少后台等待；
       * 仅安卓启用，iOS 保持原路径，且创建失败时自动回退到 setTimeout。 */
      if (typeof document !== 'undefined' && document.hidden) {
        if (isAndroid() && typeof MessageChannel === 'function') {
          var ch = null, fallback = null;
          try {
            ch = new MessageChannel();
            /* 必须有超时兜底：后台 task 队列可能被冻结/BFCache，消息永不派发时
               若只靠 onmessage，Promise 永不 settle → 合并永久卡死、结果丢失。
               timer 与 onmessage 谁先到谁生效（Promise resolve 幂等）。 */
            fallback = setTimeout(function () {
              try { ch.port1.close(); ch.port2.close(); } catch (e) { /* 忽略 */ }
              r();
            }, 1000);
            ch.port1.onmessage = function () {
              clearTimeout(fallback);
              try { ch.port1.close(); ch.port2.close(); } catch (e) { /* 忽略 */ }
              r();
            };
            ch.port2.postMessage(0);
            return;
          } catch (e) {
            if (fallback) clearTimeout(fallback);
            /* 回退到 setTimeout */
          }
        }
        setTimeout(r, 0);
      } else if (window.requestAnimationFrame) requestAnimationFrame(function () { r(); });
      else setTimeout(r, 16);
    });
  }

  function fmtTime(sec) {
    sec = Math.max(0, Math.round(sec || 0));
    var m = Math.floor(sec / 60);
    var s = sec % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  function fmtSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1024 / 1024).toFixed(2) + ' MB';
  }

  function nowStamp() {
    var d = new Date();
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) +
      '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }

  function base64ToArrayBuffer(b64) {
    var bin = atob(b64);
    var buf = new ArrayBuffer(bin.length);
    var view = new Uint8Array(buf);
    for (var i = 0; i < bin.length; i++) view[i] = bin.charCodeAt(i);
    return buf;
  }

  /* ---------------- 音频管线预热 ---------------- */
  /**
   * 预热：创建 AudioContext 并解码一个微型 MP3。
   * 调用时机刻意选在「文件选择器打开前」和「权限弹窗前」——
   * 这两步在手机上都要数秒，预热完全藏在这段等待里，
   * 用户无感知。实测首个文件解码约 1.6s → 0.9s（桌面 Edge）。
   */
  function warmAudioPipeline() {
    if (warmStarted) return;
    warmStarted = true;
    getCtx().then(function () {
      return decodeAudioData(base64ToArrayBuffer(TINY_MP3_B64));
    }).catch(function () { /* 预热失败不影响主流程 */ });
  }

  /* ---------------- 状态栏 / 进度 / 忙碌态 ---------------- */
  function setStatus(msg, isError) {
    var s = $('status');
    s.textContent = msg || '';
    s.classList.toggle('error', !!isError);
  }

  function showProgress(p, label) {
    $('progressWrap').hidden = false;
    // 新一轮进度开始：清空节流窗口与上一轮的标签，保证第一条中间进度一定可见
    lastProgressPaint = 0;
    lastProgressLabel = '';
    setProgress(p, label);
  }

  var lastProgressPaint = 0;
  var lastProgressLabel = '';
  function setProgress(p, label) {
    // 低端安卓上每块一次 DOM 写入有明显布局成本；按时间节流，
    // 起始(0)、完成(1)、阶段(label)变化与首次显示强制刷新，避免进度条卡在旧值。
    var now = Date.now();
    var stageChanged = (label || '') !== lastProgressLabel;
    if (p > 0 && p < 1 && !stageChanged && now - lastProgressPaint < 80) return;
    lastProgressPaint = now;
    lastProgressLabel = label || '';
    $('progressFill').style.width = Math.round(p * 100) + '%';
    $('progressLabel').textContent = (label ? label + ' · ' : '') + Math.round(p * 100) + '%';
  }

  function hideProgress() {
    lastProgressPaint = 0;
    $('progressWrap').hidden = true;
    $('progressFill').style.width = '0%';
  }

  function setBusy(busy) {
    state.busy = busy;
    $('btnImport').classList.toggle('disabled', busy);
    $('btnRecord').disabled = busy;
    // 合并中禁止改动输出格式/位率：streamMerge 的头部与编码器按进入时格式
    // 初始化一次，中途切换会崩在 enc=null 或产出头部与数据不符的损坏文件。
    $('bitrateSel').disabled = busy;
    var fmtBtns = document.querySelectorAll('#formatGroup .seg-btn');
    for (var i = 0; i < fmtBtns.length; i++) fmtBtns[i].disabled = busy;
    updateMergeButton();
  }

  function decodingCount() {
    return state.segments.filter(function (s) { return s.decoding; }).length;
  }

  function updateMergeButton() {
    var btn = $('btnMerge');
    if (state.busy) {
      btn.textContent = '取消';
      btn.disabled = false;
      btn.classList.remove('primary');
      btn.classList.add('danger');
      return;
    }
    btn.classList.remove('danger');
    btn.classList.add('primary');
    if (decodingCount() > 0) {
      btn.textContent = '解码中…';
      btn.disabled = true;
      return;
    }
    btn.textContent = '合并为 ' + (FORMAT_LABELS[state.format] || state.format.toUpperCase());
    btn.disabled = state.segments.length === 0;
  }

  function cancelMerge() {
    if (!state.busy) return;
    state.mergeToken++;
    if (state.m4aRecorder) {
      try { state.m4aRecorder.stop(); } catch (e) { /* 忽略 */ }
    }
    setStatus('正在取消…');
  }

  /* ---------------- 音频上下文与解码 ---------------- */
  function getCtx() {
    if (!state.audioCtx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) throw new Error('当前浏览器不支持 Web Audio API');
      state.audioCtx = new AC();
    }
    if (state.audioCtx.state === 'suspended') {
      return state.audioCtx.resume().then(function () { return state.audioCtx; });
    }
    return Promise.resolve(state.audioCtx);
  }

  function decodeAudioData(arrayBuffer) {
    // 同时兼容新版（Promise）与旧版（回调）API
    return new Promise(function (resolve, reject) {
      var p = state.audioCtx.decodeAudioData(arrayBuffer, resolve, reject);
      if (p && typeof p.then === 'function') p.then(resolve, reject);
    });
  }

  /**
   * AudioBuffer → 内部 PCM 格式（零拷贝：直接持有声道视图）。
   * 安全性：合并管线从不原地修改输入——conformPcm 先 slice 再处理，
   * 编码路径只读。省掉一次全量拷贝（11 分钟立体声约省 120 MB 内存峰值）。
   */
  function audioBufferToPcm(buf) {
    var channels = [];
    for (var c = 0; c < buf.numberOfChannels; c++) channels.push(buf.getChannelData(c));
    return { sampleRate: buf.sampleRate, channels: channels };
  }

  function readAsArrayBuffer(blob) {
    if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(fr.result); };
      fr.onerror = function () { reject(new Error('文件读取失败')); };
      fr.readAsArrayBuffer(blob);
    });
  }

  /* ---------------- 片段管理 ---------------- */
  /**
   * 片段的有效时长（秒）：应用剪切范围后的长度。
   * 列表元信息、底部合计、体积估算、合并计划全部以此为准，
   * 保证"看到多少就是合并出多少"。
   */
  function segEffectiveDuration(seg) {
    if (!seg || !seg.duration) return 0;
    // 统一到核心层纯函数：无效剪切范围回退整段（与 segTrimFrames 一致）。
    // 旧实现返回 0 / 负值，界面承诺与实际 planMerge 输出相反。
    return AudioCore.effectiveDurationSec(seg.duration, seg.trimStart, seg.trimEnd);
  }

  function totalDuration() {
    var sum = 0;
    state.segments.forEach(function (s) { sum += segEffectiveDuration(s); });
    return sum;
  }

  /** 片段剪切范围 → 源 PCM 帧区间（无效范围回退整段） */
  function segTrimFrames(seg) {
    var len = seg.pcm ? seg.pcm.channels[0].length : 0;
    if (!len) return { start: 0, end: 0 };
    var start = typeof seg.trimStart === 'number'
      ? Math.max(0, Math.min(Math.round(seg.trimStart * seg.pcm.sampleRate), len)) : 0;
    var end = typeof seg.trimEnd === 'number'
      ? Math.max(0, Math.min(Math.round(seg.trimEnd * seg.pcm.sampleRate), len)) : len;
    if (end <= start) return { start: 0, end: len };
    return { start: start, end: end };
  }

  /** 复制片段：共享同一 blob 与 PCM 引用（零拷贝、零重新解码） */
  function copySegment(id) {
    if (state.busy) {
      setStatus('合并进行中：请先取消合并，再复制片段', true);
      return;
    }
    var seg = state.segments.find(function (s) { return s.id === id; });
    if (!seg) return;
    state.seq++;
    var copy = {
      id: 'seg' + state.seq,
      name: seg.name + ' 副本',
      source: seg.source,
      blob: seg.blob,
      url: null,
      pcm: seg.pcm,             // 共享引用：合并管线只读输入，释放仅断开各自引用
      audioBuffer: seg.audioBuffer,
      duration: seg.duration,
      sampleRate: seg.sampleRate,
      channels: seg.channels,
      decoding: false,
      failed: false,
      warn: seg.warn || null,    // 短音频/内置解码的试听警示必须随副本保留
      released: !seg.pcm,       // 原片段还没解码完 → 副本入队自己解
      trimStart: seg.trimStart != null ? seg.trimStart : null,
      trimEnd: seg.trimEnd != null ? seg.trimEnd : null,
      trimOpen: false
    };
    state.segments.push(copy);
    if (copy.released) {
      copy.decoding = true;
      decodeQueue.push(copy);
    }
    renderList();
    if (copy.released) pumpQueue();
    setStatus('已复制「' + seg.name + '」（与原片段共享数据，不额外占内存）');
  }

  /** 重置某片段的剪切范围为整段 */
  function resetTrim(seg) {
    seg.trimStart = null;
    seg.trimEnd = null;
  }

  function estimateTargetRate() {
    var rates = [];
    state.segments.forEach(function (s) { if (s.pcm) rates.push(s.pcm.sampleRate); });
    return AudioCore.pickTargetRate(rates);
  }

  /**
   * 文件入队：立即生成「解码中」占位片段并渲染（用户瞬间看到反馈），
   * 然后按队列顺序解码，控制内存峰值。
   */
  function enqueueFiles(files, expectDurations) {
    var added = [];
    Array.prototype.forEach.call(files || [], function (file, i) {
      if (!file) return;
      state.seq++;
      var seg = {
        id: 'seg' + state.seq,
        name: file.name || '未命名音频',
        source: '导入',
        blob: file,
        decoding: true,
        failed: false,
        pcm: null,
        audioBuffer: null, // 解码时的 AudioBuffer（M4A 调度零拷贝复用）
        released: false,   // PCM 是否已在合并中被释放（重试时自动重新解码）
        duration: 0,
        sampleRate: 0,
        channels: 0,
        // 预期时长（秒）：仅应用内录音时提供，用于识别"解得出但与录制长度不符"的坏文件
        expectDuration: (expectDurations && expectDurations[i]) || 0,
        trimStart: null,   // 剪切范围（秒）；null = 不剪切
        trimEnd: null,
        trimOpen: false    // 剪切面板是否展开
      };
      state.segments.push(seg);
      added.push(seg);
    });
    if (!added.length) return;
    renderList();
    setStatus('已加入 ' + added.length + ' 个文件，正在解码（' + added[0].name + '）…');
    added.forEach(function (seg) { decodeQueue.push(seg); });
    pumpQueue();
  }

  function pumpQueue() {
    if (decodeRunning) return;
    var seg = decodeQueue.shift();
    if (!seg) return;
    decodeRunning = true;
    decodeSegment(seg).then(function () {
      decodeRunning = false;
      pumpQueue();
    }).catch(function (err) {
      // decodeSegment 内部已尽力处理常见失败；这里兜住意外 rejection，
      // 否则 decodeRunning 永远为 true，后续导入的片段再也不会解码。
      decodeRunning = false;
      if (!seg.removed) {
        seg.decoding = false;
        seg.failed = true;
        seg.errorMsg = '解码异常：' + (err && err.message ? err.message : err);
        setStatus(seg.errorMsg, true);
      }
      renderList(true);
      pumpQueue();
    });
  }

  /* ---------------- 解码降级链（V0.3.2） ----------------
   * 平台 decodeAudioData 在部分环境会失败（Android 厂商内核、桌面 Chrome 的
   * AAC、含异常标签的 MP3 等）。失败后按魔数嗅探实际格式，能用内置解析器的
   * 直接解：WAV → 自研 RIFF 解析器；MP3 → mp3 解码器（lamejs 只编码，
   * 因此内置 wasm 版 mpg123）。仍不支持的格式给出精确原因与建议。
   * ------------------------------------------------------ */
  var mp3DecoderLib = null;
  var mp3DecoderPromise = null;

  /** 从内联 base64 还原并执行 mpg123-decoder（NUL 安全，原因见 build.js 注释） */
  function loadMp3DecoderModule() {
    if (window['mpg123-decoder']) return;
    var b64 = window.__MP3DEC_B64;
    if (!b64) throw new Error('内置解码器未随页面加载');
    if (typeof TextDecoder !== 'function') {
      throw new Error('浏览器缺少 TextDecoder，无法启用内置解码器');
    }
    var bin = atob(b64);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    var src = new TextDecoder('utf-8').decode(bytes);
    (0, eval)(src); // 间接 eval：在全局作用域执行 UMD，挂载 window['mpg123-decoder']
  }

  /** 惰性初始化内置 MP3 解码器（仅在平台解码失败时加载，不增加正常路径成本） */
  function getMp3Decoder() {
    if (mp3DecoderPromise) return mp3DecoderPromise;
    try {
      loadMp3DecoderModule();
    } catch (e) {
      mp3DecoderPromise = Promise.reject(e);
      return mp3DecoderPromise;
    }
    var lib = window['mpg123-decoder'];
    if (!lib || typeof lib.MPEGDecoder !== 'function') {
      mp3DecoderPromise = Promise.reject(new Error('内置 MP3 解码器未加载'));
      return mp3DecoderPromise;
    }
    mp3DecoderLib = new lib.MPEGDecoder();
    mp3DecoderPromise = mp3DecoderLib.ready.then(function () { return mp3DecoderLib; });
    return mp3DecoderPromise;
  }

  /**
   * 兜底解码：按嗅探到的实际格式选择内置解析器。
   * @param {Uint8Array} bytes 文件字节
   * @param {Object} info sniffFormat 结果
   * @returns {Promise<{pcm:Object, decoder:string}|null>} null = 该格式无内置解析器
   */
  async function fallbackDecode(bytes, info) {
    if (info.container === 'wav') {
      return { pcm: AudioCore.decodeWav(bytes), decoder: 'wav' };
    }
    if (info.container === 'mp3') {
      var dec = await getMp3Decoder();
      var out = await dec.decode(bytes);
      if (!out || !out.samplesDecoded || !out.channelData || !out.channelData.length) {
        throw new Error('内置 MP3 解码器未产出音频数据');
      }
      // mpg123 会把单声道上混为双声道；channelData 是每次 decode 新分配的
      // Float32Array（非 wasm 堆视图），可直接作为 PCM 声道持有
      return {
        pcm: { sampleRate: out.sampleRate, channels: out.channelData },
        decoder: 'mpg123'
      };
    }
    return null;
  }

  async function decodeSegment(seg) {
    try {
      var buf = await readAsArrayBuffer(seg.blob);
      await getCtx();

      /* ⚠️ 关键约定：decodeAudioData 会接管（detach）传入的 ArrayBuffer，
       * 而且**失败时也 detach**（Chrome/WebKit 实测：成功/失败两种路径事后
       * byteLength 均为 0）。因此任何"解码之后还要用的字节"都必须是独立副本，
       * 不能直接持有同一个 buffer 的视图——否则降级链拿到的永远是 0 字节，
       * 会被误判成"空文件（0 字节）"。
       *
       * 做法：解码前先用 slice 复制一份头部（≤64KB）用于嗅探；只有当嗅探结果
       * 表明有对应内置解析器时，才在失败后重新读一次全文交给兜底解析器。
       * 这样成功路径零额外开销，失败路径也只有一次按需重读。 */
      var headLen = Math.min(buf.byteLength, SNIFF_HEAD_BYTES);
      var headBytes = new Uint8Array(buf.slice(0, headLen)); // slice = 独立副本

      var audioBuf = null;
      var primaryErr = null;
      try {
        audioBuf = await decodeAudioData(buf);
      } catch (e) {
        primaryErr = e; // 平台解码器失败 → 走降级链
      }
      // 解码期间该片段可能已被移除
      if (!state.segments.some(function (s) { return s.id === seg.id; })) return;

      /* 部分损坏/不被支持的文件，平台解码器会"成功"返回一个 0 帧的 AudioBuffer
       * （Chrome/Edge 实测：魔数合法但内容无效的 MP3 → duration 0、不报错）。
       * 若按成功处理，合并时该段会被 planMerge 静默跳过——用户那一段无声无息消失，
       * 全是这类文件时还会抛出内部的 "planMerge: 所有片段均为空"。因此必须当失败，
       * 并继续走降级链让内置解析器再试一次。 */
      var platformSuspicious = false;
      var shortWarning = null;
      if (audioBuf && audioBuf.length === 0) {
        primaryErr = new Error('平台解码器返回了 0 帧音频（文件很可能损坏或不完整）');
        audioBuf = null;
        platformSuspicious = true;
      } else if (audioBuf) {
        // 「警告但保留」：极短但非零的结果保留并挂警示；只有无效时长才转降级链
        var primaryAssessment = AudioCore.assessShortAudio(audioBuf.duration, MIN_VALID_SEC);
        if (!primaryAssessment.valid) {
          primaryErr = new Error('平台解码器返回了无效时长（文件很可能损坏或不完整）');
          audioBuf = null;
          platformSuspicious = true;
        } else {
          shortWarning = primaryAssessment.warning;
        }
      }

      if (audioBuf) {
        // 应用内录音：把"录制时长"和"解出的时长"对一遍。偏差过大意味着容器/编码器
        // 产出的文件不完整（AAC 录制链路尤其容易出现"能解但内容不对"），必须显式
        // 告知用户，而不是让它以杂音形式出现在成品里。
        if (!shortWarning && seg.expectDuration > 0) {
          var dev = Math.abs(audioBuf.duration - seg.expectDuration) / seg.expectDuration;
          if (dev > 0.2) {
            shortWarning = '录制约 ' + seg.expectDuration.toFixed(1) + ' 秒，实际只解出 ' +
              audioBuf.duration.toFixed(1) + ' 秒（偏差 ' + Math.round(dev * 100) +
              '%）——录音文件可能不完整，请试听后决定是否使用';
          }
        }
        seg.pcm = audioBufferToPcm(audioBuf);
        seg.audioBuffer = audioBuf; // 保留引用：M4A 调度可直接复用
        seg.released = false;      // 复制片段自己解完后必须清标记，否则下次合并又全量重解一遍
        seg.warn = shortWarning; // 极短音频保留但给出试听警示；正常结果为 null
        seg.duration = audioBuf.duration;
        seg.sampleRate = audioBuf.sampleRate;
        seg.channels = audioBuf.numberOfChannels;
        seg.decoding = false;
        if (seg.removed) return; // 解码期间被删除：不再渲染/汇报幽灵片段
        renderList();
        var rest = decodeQueue.length;
        reportDecodeStatus(seg, '已解码「' + seg.name + '」（' + fmtTime(seg.duration) + '）' +
          (rest > 0 ? '，队列还剩 ' + rest + ' 个' : '') +
          '。当前共 ' + state.segments.length + ' 段，合计 ' + fmtTime(totalDuration()));
        return;
      }

      // ---- 降级链 ----
      // 注意：此处只能用 headBytes（独立副本）。传给平台解码器的那份 buf 已在上一步
      // 被 detach，任何基于它的视图长度都会变成 0。
      var info = AudioCore.sniffFormat(headBytes);
      seg.sniff = info;
      var fb = null, fbErr = null;
      try {
        if (info.container === 'wav' || info.container === 'mp3') {
          // 内置解析器需要完整文件；平台那一份已被 detach，这里按需重读
          var fullBuf = await readAsArrayBuffer(seg.blob);
          fb = await fallbackDecode(new Uint8Array(fullBuf), info);
        }
      } catch (e2) {
        fbErr = e2;
      }
      if (!state.segments.some(function (s) { return s.id === seg.id; })) return;
      // 兜底解析器产出 0 帧仍按失败处理（绝不允许片段静默消失）；
      // 极短但有效的结果按「警告但保留」进入列表并显示黄色警示行。
      var fbSec = fb ? AudioCore.pcmDurationSec(fb.pcm) : 0;
      var fbAssessment = AudioCore.assessShortAudio(fbSec, MIN_VALID_SEC);
      var fbShortWarn = null;
      if (fb && !fbAssessment.valid) {
        fb = null;
        fbErr = new Error('内置解析器未解出有效音频，文件很可能损坏');
      } else if (fb) {
        fbShortWarn = fbAssessment.warning;
      }
      if (fb) {
        seg.pcm = fb.pcm;
        seg.audioBuffer = null; // 无 AudioBuffer，M4A 路径会按 PCM 重建
        seg.released = false;   // 同平台解码路径：解完即清，避免重复解码
        seg.duration = AudioCore.pcmDurationSec(fb.pcm);
        seg.sampleRate = fb.pcm.sampleRate;
        seg.channels = fb.pcm.channels.length;
        seg.decoding = false;
        seg.usedFallback = true;
        // 平台只解出一小段（典型：损坏 MP3 被解成几十毫秒噪声）时，内置解析器的结果
        // 未必可信——它可能是把垃圾数据硬解出来的。此时仍采用其输出（否则那段会静默消失），
        // 但必须显式标注，让用户试听确认后再决定是否留下。
        seg.warn = fbShortWarn || (platformSuspicious
          ? '平台解码结果为 0 帧，内容由内置解码器还原，请试听确认后再合并'
          : null);
        var label = (fb.decoder === 'mpg123' ? 'MP3/MPEG' : 'WAV');
        if (seg.removed) return;
        renderList();
        if (platformSuspicious) {
          reportDecodeStatus(seg, '「' + seg.name + '」平台解码结果异常，已改用内置解码器（' + label +
            '）解出 ' + fmtTime(seg.duration) +
            '，请试听确认内容是否完整，若不满意可删除该片段');
        } else {
          reportDecodeStatus(seg, '「' + seg.name + '」平台解码器不支持，已用内置解码器（' + label +
            '）解码完成：' + fmtTime(seg.duration) + '，合计 ' + fmtTime(totalDuration()));
        }
        return;
      }
      // 无内置解析器：抛出带格式信息与建议的错误
      throw decorateDecodeError(seg, info, primaryErr, fbErr);
    } catch (err) {
      if (seg.removed || !state.segments.some(function (s) { return s.id === seg.id; })) return;
      seg.decoding = false;
      seg.failed = true;
      seg.errorMsg = err && err.message ? err.message : String(err);
      renderList();
      reportDecodeStatus(seg, seg.errorMsg, true);
    }
  }

  /** 解码状态汇报：合并/取消进行中不覆盖进度与取消提示；已删除片段不产生幽灵提示 */
  function reportDecodeStatus(seg, msg, isError) {
    if (!seg || seg.removed || state.busy) return;
    setStatus(msg, isError);
  }

  /** 组装可操作的解码失败信息（含文件大小、检测格式、建议） */
  function decorateDecodeError(seg, info, primaryErr, fbErr) {
    var sizeTxt = seg.blob && typeof seg.blob.size === 'number' ? fmtSize(seg.blob.size) : '大小未知';
    var reason = primaryErr && primaryErr.message ? primaryErr.message : '平台解码器拒绝该文件';
    var parts = [
      '「' + seg.name + '」解码失败：' + reason,
      '（文件 ' + sizeTxt + ' · 检测为 ' + (info.label || '未知格式') + '）'
    ];
    if (info.advice) parts.push('。建议：' + info.advice + '（转换方法见页脚「格式转换」）');
    else if (fbErr) parts.push('。内置解析器也失败：' + (fbErr.message || fbErr));
    else parts.push('。可能是文件损坏或不完整，可尝试重新导出该文件，或点下方「兼容模式」重新选择');
    return new Error(parts.join(''));
  }

  function removeSegment(id) {
    // 合并进行中禁止增删：streamMerge 持有的是开始时捕获的片段数组，
    // 此时删除只会从界面上消失，结果里仍然包含——必须先取消合并
    if (state.busy) {
      setStatus('合并进行中：请先取消合并，再调整片段列表', true);
      return;
    }
    var seg = state.segments.find(function (s) { return s.id === id; });
    if (seg && state.playingId === id) stopSegPlayback();
    if (seg && seg.url) { URL.revokeObjectURL(seg.url); seg.url = null; }
    // 仍在排队、或正在解码的片段一并标记：否则解码完成后仍会写状态栏/重渲染，
    // 让用户看到"已解码「已删除的片段」"这种幽灵提示。
    if (seg) seg.removed = true;
    decodeQueue = decodeQueue.filter(function (q) { return q.id !== id; });
    state.segments = state.segments.filter(function (s) { return s.id !== id; });
    renderList();
  }

  /* ---------------- 片段试听 ---------------- */
  function stopSegPlayback() {
    var player = $('segPlayer');
    try { player.pause(); } catch (e) { /* 忽略 */ }
    player.removeAttribute('src');
    state.playingId = null;
  }

  function toggleSegPlayback(id) {
    var player = $('segPlayer');
    if (state.playingId === id) {
      stopSegPlayback();
      renderList(true);
      setStatus('已停止试听');
      return;
    }
    var seg = state.segments.find(function (s) { return s.id === id; });
    if (!seg) return;
    if (!seg.blob || seg.decoding || seg.failed) {
      setStatus('该片段暂不可试听', true);
      return;
    }
    stopSegPlayback();
    if (!seg.url) seg.url = URL.createObjectURL(seg.blob);
    player.src = seg.url;
    state.playingId = id;
    renderList(true);
    player.play().then(function () {
      setStatus('正在试听「' + seg.name + '」，再次点击 ▶ 停止');
    }).catch(function (err) {
      setStatus('播放失败：' + (err && err.message ? err.message : err), true);
      stopSegPlayback();
      renderList(true);
    });
  }

  /* ---------------- 输出格式 ---------------- */
  function detectFormats() {
    // M4A 依赖 MediaRecorder 的 mp4 录制能力（iOS Safari / 较新 Chrome/Edge）
    if (typeof MediaRecorder !== 'undefined' &&
        (MediaRecorder.isTypeSupported('audio/mp4') ||
         MediaRecorder.isTypeSupported('audio/mp4;codecs=mp4a.40.2'))) {
      state.m4aSupported = true;
      $('fmtM4a').hidden = false;
    }
    // MP3 依赖内联的 lamejs
    if (!(window.lamejs && typeof window.lamejs.Mp3Encoder === 'function')) {
      var mp3Btn = document.querySelector('#formatGroup .seg-btn[data-fmt="mp3"]');
      if (mp3Btn) {
        mp3Btn.disabled = true;
        mp3Btn.title = '编码器未加载';
      }
    }
  }

  function setFormat(fmt) {
    if (state.busy) return; // 合并期间格式已由 plan/编码器固定，禁止切换
    if (fmt === 'm4a' && !state.m4aSupported) return;
    state.format = fmt;
    var btns = document.querySelectorAll('#formatGroup .seg-btn');
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('active', btns[i].dataset.fmt === fmt);
    }
    $('bitrateRow').hidden = fmt !== 'mp3';
    updateFormatHint();
    updateSizeEstimate();
    updateMergeButton();
  }

  /**
   * 整次合并的目标声道数（单一决策点）。
   * WAV/MP3：全部片段单声道 → 1，否则 → 2；M4A 走独立调度路径，恒为立体声。
   * 头部、编码器、交织缓冲全部从同一个 plan.targetChannels 派生，禁止逐段变化。
   */
  function mergeTargetChannels() {
    return state.format === 'm4a' ? 2 : AudioCore.pickTargetChannels(state.segments);
  }

  function updateFormatHint() {
    var hint;
    if (state.format === 'wav') {
      // 与 updateSizeEstimate 一致：按实际目标声道数计算每秒字节，不能写死立体声
      hint = 'WAV 无损：约 ' + fmtSize(estimateTargetRate() * mergeTargetChannels() * 2) +
        '/秒（' + (mergeTargetChannels() === 1 ? '单声道' : '立体声') + '），兼容性最好，适合存档。';
      if (isIOSDevice()) {
        hint += 'iOS 上超大 WAV 可能因内存限制被浏览器重载，长音频建议选 MP3 或分段合并。';
      }
    } else if (state.format === 'mp3') {
      hint = 'MP3 有损压缩：体积约为 WAV 的 1/10，编码在本地完成，长文件需要几十秒。';
      /* 实测：本项目的 lamejs 在 64/96 kbps 反而比 128 kbps 慢约 2.9 倍，
         选低位率既不会更快也不会明显更省时间，必须明示避免用户误选。 */
      if (state.bitrate < 128) {
        hint += ' 注意：' + state.bitrate + ' kbps 在本编码器上反而比 128 kbps 慢约 2–3 倍，追求速度请选 128 kbps。';
      }
      if (mergeTargetChannels() === 1) {
        hint += ' 已检测到全部片段为单声道，将按单声道编码（更快、体积更小）。';
      }
    } else {
      hint = 'M4A(AAC) 实时编码：按播放速度录制合并结果，耗时与音频等长，期间请保持页面在前台。';
    }
    $('formatHint').textContent = hint;
  }

  function updateSizeEstimate() {
    var dur = totalDuration();
    if (dur <= 0) {
      $('sizeEst').textContent = '';
      return;
    }
    var rate = estimateTargetRate();
    var channels = mergeTargetChannels();
    var bytes;
    if (state.format === 'wav') bytes = dur * rate * channels * 2;  // 16bit × 实际声道数
    else if (state.format === 'mp3') bytes = dur * state.bitrate * 1000 / 8;
    else bytes = dur * 128000 / 8;                                    // M4A 按 128kbps 估
    $('sizeEst').textContent = '预计约 ' + fmtSize(bytes) +
      '（' + Math.round(rate / 1000) + 'kHz · ' + (channels === 1 ? '单声道' : '立体声') +
      ' · 当前 ' + state.segments.length + ' 段合计 ' + fmtTime(dur) + '）';
  }

  /* ---------------- 列表渲染 ---------------- */
  /** 清理已生成的合并结果（列表变动后结果即过期） */
  function hideResult() {
    // 结果被丢弃时若上传仍在进行，立即中断，避免回调把旧链接写回新界面
    if (uploadState.busy && uploadState.xhr) {
      try { uploadState.xhr.abort(); } catch (e) { /* 忽略 */ }
    }
    var a = $('resultAudio');
    try { a.pause(); } catch (e) { /* 忽略 */ }
    a.removeAttribute('src');
    a.hidden = true;
    if (state.mergedUrl) {
      URL.revokeObjectURL(state.mergedUrl);
      state.mergedUrl = null;
    }
    state.mergedBlob = null;
    $('resultBox').hidden = true;
  }

  function updateActionBar() {
    var bar = $('actionBar');
    if (state.segments.length === 0) {
      bar.hidden = true;
      return;
    }
    bar.hidden = false;
    var decoding = decodingCount();
    var text = state.segments.length + ' 段 · 合计 ' + fmtTime(totalDuration());
    if (decoding > 0) text = '解码中 ' + decoding + ' 个…（' + text + '）';
    $('actionSummary').textContent = text;
  }

  /**
   * 渲染片段列表。
   * @param {boolean} [keepResult] 为 true 时不清理已生成的合并结果（试听场景用）
   */
  function renderList(keepResult) {
    // 拖拽把手按下后，DOM 里的 li 正在被 insertBefore 移动。此时若因解码完成等
    // 异步回调重建列表，segDrag.li 会指向游离节点，出现重复行或拖拽失效。
    // 推迟到 endDrag 之后补渲染；副作用（估算/按钮状态）仍然立即执行。
    if (segDrag) { pendingRender = true; return; }
    if (!keepResult) hideResult();
    updateActionBar();
    updateSizeEstimate();
    updateFormatHint(); // 片段变化会改变目标声道数/低位率提示，需同步刷新
    updateMergeButton();
    pendingRender = false;

    var ul = $('segmentList');
    ul.textContent = '';

    if (state.segments.length === 0) {
      ul.appendChild(el('li', 'empty', '还没有片段。导入音频文件，或点击上方按钮开始录音。'));
      $('listCount').textContent = '0 段';
      return;
    }

    $('listCount').textContent =
      state.segments.length + ' 段 · 合计 ' + fmtTime(totalDuration());

    state.segments.forEach(function (seg, i) {
      var cls = 'seg';
      if (seg.decoding) cls += ' decoding';
      if (seg.failed) cls += ' failed';
      var li = el('li', cls);
      li.dataset.id = seg.id;
      if (state.playingId === seg.id) li.classList.add('playing');

      // 拖动把手（pointer events 排序，兼容鼠标与触摸）
      var drag = el('span', 'seg-drag', '⠿');
      drag.title = '按住拖动调整顺序';
      li.appendChild(drag);

      var play = el('button', 'icon-btn play', state.playingId === seg.id ? '⏸' : '▶');
      play.type = 'button';
      play.title = '试听';
      play.dataset.act = 'play';
      if (seg.decoding || seg.failed) play.disabled = true;
      li.appendChild(play);

      var info = el('div', 'seg-info');
      info.appendChild(el('div', 'seg-name', (i + 1) + '. ' + seg.name));
      info.appendChild(el('div', 'seg-meta', segMetaText(seg)));
      if (seg.warn) info.appendChild(el('div', 'seg-warn', '⚠ ' + seg.warn));
      if (seg.trimOpen && !seg.decoding && !seg.failed) info.appendChild(buildTrimPanel(seg));
      li.appendChild(info);

      var actions = el('div', 'seg-actions');
      var trimBtn = el('button', 'icon-btn', '✂');
      trimBtn.type = 'button';
      trimBtn.title = '剪切片段';
      trimBtn.dataset.act = 'trim';
      if (seg.decoding || seg.failed) trimBtn.disabled = true;
      var copyBtn = el('button', 'icon-btn', '⧉');
      copyBtn.type = 'button';
      copyBtn.title = '复制片段';
      copyBtn.dataset.act = 'copy';
      if (state.busy) copyBtn.disabled = true;
      var del = el('button', 'icon-btn danger', '✕');
      del.type = 'button';
      del.title = '移除';
      del.dataset.act = 'del';
      actions.appendChild(trimBtn);
      actions.appendChild(copyBtn);
      actions.appendChild(del);
      li.appendChild(actions);

      ul.appendChild(li);
    });
  }

  /** 片段元信息文本（含剪切范围提示） */
  function segMetaText(seg) {
    if (seg.decoding) return '解码中…';
    if (seg.failed) return '解码失败：' + (seg.errorMsg || '格式不支持');
    var text = seg.source + (seg.usedFallback ? '（内置解码）' : '') + ' · ' +
      fmtTime(segEffectiveDuration(seg)) +
      ' · ' + Math.round(seg.sampleRate / 1000) + 'kHz · ' +
      (seg.channels === 1 ? '单声道' : seg.channels + ' 声道');
    if (typeof seg.trimStart === 'number' || typeof seg.trimEnd === 'number') {
      text += ' · 已剪切 ' + fmtSec(seg.trimStart || 0) + '–' +
        fmtSec(seg.trimEnd != null ? seg.trimEnd : seg.duration);
    }
    return text;
  }

  function fmtSec(sec) {
    var s = Math.max(0, sec || 0);
    var m = Math.floor(s / 60);
    var r = s - m * 60;
    // 「警告但保留」会放行 50ms 级片段，1 位小数会全部显示成 0.0
    var digits = (s > 0 && s < 1) ? 3 : 1;
    return m + ':' + (r < 10 ? '0' : '') + r.toFixed(digits);
  }

  /** 构建片段剪切面板（起止时间滑杆 + 数字输入） */
  function buildTrimPanel(seg) {
    var dur = seg.duration || 0;
    var start = typeof seg.trimStart === 'number' ? seg.trimStart : 0;
    var end = typeof seg.trimEnd === 'number' ? seg.trimEnd : dur;
    var panel = el('div', 'trim-panel');
    panel.dataset.role = 'trim';
    // 「警告但保留」放行 50ms 级片段：0.1s 步长会大于片段总长，滑杆与数字框都不可用
    var shortClip = dur > 0 && dur < 1;
    var step = shortClip ? String(Math.max(0.0001, dur / 100)) : '0.1';
    var digits = shortClip ? 3 : 1;

    function row(label, which, value, max) {
      var r = el('div', 'trim-row');
      r.appendChild(el('span', 'trim-label', label));
      var range = document.createElement('input');
      range.type = 'range';
      range.className = 'trim-range';
      range.min = '0';
      range.max = String(max);
      range.step = step;
      range.value = String(value);
      range.dataset.trim = which;
      r.appendChild(range);
      var num = document.createElement('input');
      num.type = 'number';
      num.className = 'trim-num';
      num.min = '0';
      num.max = String(max);
      num.step = step;
      num.value = value.toFixed(digits);
      num.dataset.trim = which;
      r.appendChild(num);
      return r;
    }

    panel.appendChild(row('起点', 'start', start, dur));
    panel.appendChild(row('终点', 'end', end, dur));

    var times = el('div', 'trim-times');
    times.dataset.role = 'trim-times';
    times.textContent = fmtSec(start) + ' → ' + fmtSec(end) +
      '（保留 ' + fmtSec(Math.max(0, end - start)) + '）';
    panel.appendChild(times);

    var ops = el('div', 'trim-ops');
    var reset = el('button', 'btn ghost tiny', '恢复整段');
    reset.type = 'button';
    reset.dataset.act = 'trim-reset';
    var done = el('button', 'btn ghost tiny', '完成');
    done.type = 'button';
    done.dataset.act = 'trim-done';
    ops.appendChild(reset);
    ops.appendChild(done);
    panel.appendChild(ops);
    return panel;
  }

  /** 就地更新某片段的元信息与剪切面板时间显示（不重渲列表，避免打断滑杆拖动） */
  function refreshSegRow(seg) {
    var li = $('segmentList').querySelector('.seg[data-id="' + seg.id + '"]');
    if (!li) return;
    var meta = li.querySelector('.seg-meta');
    if (meta) meta.textContent = segMetaText(seg);
    var times = li.querySelector('[data-role="trim-times"]');
    if (times) {
      var start = typeof seg.trimStart === 'number' ? seg.trimStart : 0;
      var end = typeof seg.trimEnd === 'number' ? seg.trimEnd : seg.duration;
      times.textContent = fmtSec(start) + ' → ' + fmtSec(end) +
        '（保留 ' + fmtSec(Math.max(0, end - start)) + '）';
    }
    updateActionBar();
    updateSizeEstimate();
  }

  /** 从 DOM 事件目标解析出 trim 输入对应的片段与方向 */
  function trimTargetFrom(input) {
    var li = input.closest('.seg');
    if (!li) return null;
    var seg = state.segments.find(function (s) { return s.id === li.dataset.id; });
    if (!seg) return null;
    return { seg: seg, which: input.dataset.trim };
  }

  /* ---------------- 录音 ---------------- */
  /** 微信内置浏览器检测（UA 含 MicroMessenger） */
  function isWeChat() {
    return /MicroMessenger/i.test(navigator.userAgent);
  }

  /** 微信内的操作引导（内置浏览器对麦克风/文件选择限制较多） */
  function weChatTip() {
    return isWeChat()
      ? '。微信内置浏览器限制较多，请点右上角 ⋯ 选择「用默认浏览器打开」'
      : '';
  }

  /**
   * 录音容器候选顺序（按平台）。
   *
   * 为什么要分平台：Chromium 130 前后开始支持 `audio/mp4` 录制，于是"mp4 排第一"
   * 的旧顺序会让**安卓/桌面 Chromium 静默地改用 AAC 容器录音**，而这批设备过去
   * 一直录的是 webm/opus。AAC 录制链路较新、边缘情况多，出现"合并后杂音/段落缺失"
   * 的风险明显高于久经使用的 opus 路径。因此：
   *   - 非 iOS：webm/opus 优先（opus 也是本项目降级链与测试覆盖最好的路径）
   *   - iOS：只能 mp4（Safari 不支持 webm 录制），保持原顺序
   */
  function mimeCandidates() {
    if (isIOSDevice()) {
      return [
        'audio/mp4;codecs=mp4a.40.2',
        'audio/mp4',
        'audio/webm;codecs=opus',
        'audio/webm'
      ];
    }
    return [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/mp4;codecs=mp4a.40.2',
      'audio/mp4',
      'audio/ogg;codecs=opus'
    ];
  }

  function pickMimeType() {
    if (typeof MediaRecorder === 'undefined') return null;
    var candidates = mimeCandidates();
    for (var i = 0; i < candidates.length; i++) {
      if (MediaRecorder.isTypeSupported(candidates[i])) return candidates[i];
    }
    return '';
  }

  async function toggleRecord() {
    if (state.recordPending) return; // 权限弹窗等待期连点不再产生并发 MediaRecorder / 流
    if (state.mediaRecorder && state.mediaRecorder.state === 'recording') {
      state.mediaRecorder.stop();
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setStatus('当前浏览器不支持录音（需要 HTTPS 或 localhost 环境）' + weChatTip(), true);
      return;
    }
    if (typeof MediaRecorder === 'undefined') {
      setStatus('当前浏览器不支持 MediaRecorder', true);
      return;
    }
    // 权限弹窗前预热（弹窗在手机上要好几秒）
    warmAudioPipeline();
    state.recordPending = true;
    var stream = null;
    try {
      setStatus('正在请求麦克风权限…');
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // 权限等待期间用户可能已清空/离开：仍继续正常启动，但先把 pending 复位
      state.recordPending = false;
      var mimeType = pickMimeType();
      state.recordChunks = [];
      state.mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType: mimeType } : undefined);
      state.mediaRecorder.ondataavailable = function (e) {
        if (e.data && e.data.size > 0) state.recordChunks.push(e.data);
      };
      state.mediaRecorder.onstop = onRecordStop;
      state.mediaRecorder.start(1000);
      state.recordStart = Date.now();
      $('btnRecord').textContent = '停止录音';
      $('btnRecord').classList.add('recording');
      $('recordDot').hidden = false;
      $('recordTime').textContent = '0:00';
      state.recordTimer = setInterval(function () {
        $('recordTime').textContent = fmtTime((Date.now() - state.recordStart) / 1000);
      }, 250);
      setStatus('录音中…（格式：' + (mimeType || '浏览器默认') + '）');
    } catch (err) {
      // 权限已授予但后续步骤失败时必须关掉麦克风，否则轨道一直占用（指示灯常亮）
      if (stream && stream.getTracks) {
        stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) { /* 忽略 */ } });
      }
      console.error(err);
      var msg = err && err.name === 'NotAllowedError'
        ? '麦克风权限被拒绝，请在浏览器设置中允许后重试' +
          (isWeChat() ? '；或点右上角 ⋯ 用默认浏览器打开' : '')
        : '无法启动录音：' + (err && err.message ? err.message : err);
      setStatus(msg, true);
    } finally {
      state.recordPending = false;
    }
  }

  async function onRecordStop() {
    clearInterval(state.recordTimer);
    state.recordPending = false;
    $('btnRecord').textContent = '开始录音';
    $('btnRecord').classList.remove('recording');
    $('recordDot').hidden = true;
    var mr = state.mediaRecorder;
    state.mediaRecorder = null;
    if (mr && mr.stream) {
      mr.stream.getTracks().forEach(function (t) { t.stop(); });
    }
    if (!state.recordChunks.length) {
      setStatus('录音为空，已取消');
      return;
    }
    var blob = new Blob(state.recordChunks, { type: state.recordChunks[0].type || 'audio/webm' });
    // 录制实际时长（秒）：用于和"解码出来的时长"比对，识别坏容器/坏编码器产出的残文件
    var recordedSec = state.recordStart ? (Date.now() - state.recordStart) / 1000 : 0;
    state.recordStart = 0;
    setStatus('录音结束（' + fmtSize(blob.size) + '），加入列表并解码…');
    enqueueFiles(
      [new File([blob], '录音 ' + nowStamp() + '.' + guessExt(blob.type), { type: blob.type })],
      [recordedSec]
    );
  }

  function guessExt(mime) {
    if (/mp4|m4a|aac/i.test(mime)) return 'm4a';
    if (/ogg/i.test(mime)) return 'ogg';
    if (/webm/i.test(mime)) return 'webm';
    return 'audio';
  }

  /* ---------------- 合并与导出 ---------------- */
  function canceledError() {
    var e = new Error('已取消');
    e.code = 'CANCELED';
    return e;
  }

  /* ---------------- 流式合并（V0.3.0） ----------------
   * 长音频合并的内存瓶颈是"整体物化"：旧流程先为每段建全量 conform 拷贝，
   * 再建全量输出 PCM，最后整体编码——两个 40 分钟立体声文件峰值可超 4GB
   * （用户实测），iOS 直接杀页面重载。新流程：
   *   1. 分块转换（AudioCore.createSegmentConverter，块边界无接缝）；
   *   2. 输出直接写文件——优先 OPFS（Origin Private File System）落盘，
   *      不可用时回落内存块拼接；
   *   3. 每段消费完立即释放其解码数据（保留 blob，重试时自动重新解码）；
   *   4. M4A 改用 AudioBuffer 顺序调度进 MediaRecorder，不再整体拷贝。
   * ----------------------------------------------------------- */

  var OPFS_PREFIX = 'audio-merge-';
  var MERGE_CHUNK_FRAMES = 32768; // 输出帧/块（48kHz 约 0.68s）

  /**
   * 打开 OPFS 写通道（流式输出的落盘位置）。
   * 优先 createSyncAccessHandle（Chrome/Edge 108+），回落 createWritable；
   * 均不可用（旧 Safari 等）返回 null，调用方回落内存拼接。
   */
  async function openMergeSink(ext) {
    if (!navigator.storage || typeof navigator.storage.getDirectory !== 'function') return null;
    var name = OPFS_PREFIX + nowStamp() + '.' + ext;
    try {
      var dir = await navigator.storage.getDirectory();
      var handle = await dir.getFileHandle(name, { create: true });
      // 取消/失败时除了关闭写句柄，还必须删掉这个半成品文件：OPFS 没有 GC，
      // 旧实现只 close/abort，长音频取消一次就会在磁盘上永久留下几十至几百 MB。
      var removeFile = async function () {
        try { await dir.removeEntry(name); } catch (e) { /* 可能已被清理 */ }
      };
      if (typeof handle.createSyncAccessHandle === 'function') {
        var access = await handle.createSyncAccessHandle();
        access.truncate(0);
        return {
          opfs: true,
          name: name,
          write: function (bytes) { access.write(bytes); return Promise.resolve(); },
          finish: async function () {
            try { access.flush(); } catch (e) { /* 忽略 */ }
            access.close();
            return await handle.getFile(); // OPFS File：磁盘支撑的 Blob，不占内存
          },
          abort: async function () {
            try { access.close(); } catch (e) { /* 忽略 */ }
            await removeFile();
          }
        };
      }
      if (typeof handle.createWritable === 'function') {
        var writable = await handle.createWritable();
        return {
          opfs: true,
          name: name,
          write: async function (bytes) { await writable.write(bytes); },
          finish: async function () {
            await writable.close();
            return await handle.getFile();
          },
          abort: async function () {
            try { await writable.abort(); } catch (e) { /* 忽略 */ }
            await removeFile();
          }
        };
      }
      await removeFile(); // 句柄能力都不可用：清掉刚创建的空文件
      return null;
    } catch (e) {
      return null;
    }
  }

  /** 清理历史合并留下的 OPFS 文件（保留当前结果文件，防止无限增长） */
  async function cleanOldOpfsFiles(keepName) {
    if (!navigator.storage || typeof navigator.storage.getDirectory !== 'function') return;
    try {
      var dir = await navigator.storage.getDirectory();
      if (typeof dir.entries !== 'function') return;
      // 手动迭代（不用 for-await）：把语法基线压在 ES2017，
      // 兼容 Chromium 55–62 一类旧内核的厂商浏览器
      var names = [];
      var it = dir.entries();
      var step = await it.next();
      while (!step.done) {
        var name = String(step.value[0]);
        if (name.indexOf(OPFS_PREFIX) === 0 && name !== keepName) names.push(name);
        step = await it.next();
      }
      for (var i = 0; i < names.length; i++) {
        try { await dir.removeEntry(names[i]); } catch (e) { /* 忽略 */ }
      }
    } catch (e) { /* 迭代不可用（旧浏览器）则跳过清理 */ }
  }

  /** 释放已消费片段的解码数据（保留 blob 与元数据；重试时自动重新解码） */
  function releaseSegmentPcm(seg) {
    seg.pcm = null;
    seg.audioBuffer = null;
    seg.released = true;
  }

  /** 合并前确保所有片段都有解码数据（被释放过的重新解码） */
  async function ensureAllDecoded(token) {
    var pending = state.segments.filter(function (s) { return s.released && !s.failed; });
    for (var i = 0; i < pending.length; i++) {
      // 取消发生在重解码队列中时立即停止，不再把剩余片段全量解一遍（大文件尤其明显）
      if (token !== state.mergeToken) throw canceledError();
      var seg = pending[i];
      seg.released = false;
      seg.decoding = true;
      renderList(true);
      setStatus('正在准备合并：重新解码「' + seg.name + '」…');
      await decodeSegment(seg);
    }
    renderList(true);
  }

  /** 合并内存估算（字节）：输入解码数据 + 输出文件（时长按剪切后有效时长） */
  function estimateMergeBytes() {
    var inputs = 0, dur = 0;
    state.segments.forEach(function (s) {
      var eff = segEffectiveDuration(s);
      dur += eff;
      if (s.pcm) {
        inputs += s.pcm.channels[0].length * s.pcm.channels.length * 4;
      } else {
        inputs += eff * (s.sampleRate || 44100) * (s.channels || 1) * 4;
      }
    });
    var out = 0;
    if (state.format === 'wav') out = dur * estimateTargetRate() * mergeTargetChannels() * 2;
    else if (state.format === 'mp3') out = dur * state.bitrate * 1000 / 8;
    else out = dur * 128000 / 8; // M4A 按 128kbps 估
    return { inputs: inputs, out: out, total: inputs + out };
  }

  /**
   * 流式合并（WAV/MP3）：逐段分块转换并写出。
   * @param {number} token 取消令牌
   * @param {Object|null} sink openMergeSink 的返回值（null = 内存拼接回落）
   */
  async function streamMerge(token, sink) {
    var segs = state.segments;
    var gapSec = parseFloat($('gapRange').value) || 0;
    var targetRate = AudioCore.pickTargetRate(segs.map(function (s) { return s.pcm.sampleRate; }));
    // 剪切范围（秒 → 源帧）随片段传入：核心层按源区间零拷贝读取，不生成裁剪副本
    var plan = AudioCore.planMerge(
      segs.map(function (s) {
        var t = segTrimFrames(s);
        return { name: s.name, pcm: s.pcm, trimStart: t.start, trimEnd: t.end };
      }),
      { targetSampleRate: targetRate, targetChannels: mergeTargetChannels(), gapSec: gapSec, fadeMs: 8 }
    );

    // 归一化全局增益（与"先拼接再归一化"等价：拼接后峰值 = 各段淡变后峰值的最大者）
    var gain = 1;
    if ($('normalizeChk').checked) {
      var peak = 0;
      plan.parts.forEach(function (p) {
        peak = Math.max(peak, AudioCore.segmentPeakAfterFade(
          segs[p.index].pcm, plan.targetSampleRate, plan.targetChannels, 8,
          p.trimStart, p.trimEnd
        ));
      });
      if (peak > 0 && isFinite(peak)) gain = Math.min(0.89 / peak, 8);
    }

    var parts = []; // 回落模式的内存块
    function write(bytes) {
      if (sink) return sink.write(bytes);
      parts.push(bytes);
      // 每 32 块折叠成一个子 Blob：让浏览器把数据挪出 JS 堆（iOS 内存更友好），
      // 否则长 WAV 会在 JS 堆里堆到最后一次性成 Blob
      if (parts.length >= 32) parts = [new Blob(parts)];
      return Promise.resolve();
    }

    try {
      // WAV：头部先行（总帧数已由 planMerge 算出，无需回头补写）
      if (state.format === 'wav') {
        await write(AudioCore.buildWavHeader(
          plan.totalFrames, plan.targetSampleRate, plan.targetChannels, 16
        ));
      }
      var enc = null;
      if (state.format === 'mp3') {
        enc = new window.lamejs.Mp3Encoder(plan.targetChannels, plan.targetSampleRate, state.bitrate);
      }

      // 复用缓冲：Int16 每声道一块；WAV 另有一块交织字节缓冲（仅作 scratch，不直接写出）
      var int16Chs = [];
      for (var c = 0; c < plan.targetChannels; c++) int16Chs.push(new Int16Array(MERGE_CHUNK_FRAMES));
      var wavScratch = null;
      if (state.format === 'wav') {
        wavScratch = new Uint8Array(MERGE_CHUNK_FRAMES * plan.targetChannels * 2);
      }

      function writeWindow(frames) {
        if (state.format === 'wav') {
          // 核心层负责交织并返回独立拷贝；直接 write(scratch.subarray()) 会让所有
          // 数据块指向同一块内存，最终整段音频反复重复同一小段
          return write(AudioCore.interleaveInt16WavChunk(
            int16Chs, plan.targetChannels, frames, wavScratch
          ));
        }
        var left = int16Chs[0].subarray(0, frames);
        var right = plan.targetChannels > 1 ? int16Chs[1].subarray(0, frames) : null;
        var buf = right ? enc.encodeBuffer(left, right) : enc.encodeBuffer(left);
        if (buf && buf.length > 0) {
          return write(new Uint8Array(buf.buffer, buf.byteOffset, buf.length));
        }
        return Promise.resolve();
      }

      function writeSilence(frames) {
        var done = 0;
        function step() {
          if (done >= frames) return Promise.resolve();
          var n = Math.min(MERGE_CHUNK_FRAMES, frames - done);
          if (state.format === 'wav') {
            var p = write(new Uint8Array(n * plan.targetChannels * 2));
            done += n;
            return p.then(step);
          }
          for (var c = 0; c < plan.targetChannels; c++) int16Chs[c].fill(0, 0, n);
          var q = writeWindow(n);
          done += n;
          return q.then(step);
        }
        return step();
      }

      var writtenFrames = 0;
      var yieldCount = 0;
      for (var pi = 0; pi < plan.parts.length; pi++) {
        var part = plan.parts[pi];
        var seg = segs[part.index];
        var conv = AudioCore.createSegmentConverter(seg.pcm, {
          targetRate: plan.targetSampleRate,
          targetChannels: plan.targetChannels,
          gain: gain,
          fadeMs: 8,
          srcStart: part.trimStart,
          srcEnd: part.trimEnd,
          int16: true
        });
        var done = 0;
        while (done < part.outFrames) {
          if (token !== state.mergeToken) throw canceledError();
          var end = Math.min(done + MERGE_CHUNK_FRAMES, part.outFrames);
          conv.convert(done, end, int16Chs);
          await writeWindow(end - done);
          writtenFrames += end - done;
          done = end;
          setProgress(writtenFrames / plan.totalFrames,
            state.format === 'mp3' ? 'MP3 编码中' : '写出中');
          // 每 8 块让出一次主线程（约 5 秒音频/次）：进度足够流畅，
          // 又不会为长文件积累出几十秒的纯等待
          if ((++yieldCount & 7) === 0) await nextFrame();
        }
        if (plan.gapFrames > 0 && pi < plan.parts.length - 1) {
          await writeSilence(plan.gapFrames);
          writtenFrames += plan.gapFrames;
        }
        // 该段已消费：释放解码数据（保留 blob；重试时 ensureAllDecoded 重建）
        releaseSegmentPcm(seg);
        setStatus('已处理 ' + (pi + 1) + '/' + plan.parts.length +
          ' 段（' + seg.name + '），输入内存已释放');
      }

      if (state.format === 'mp3') {
        var flushBuf = enc.flush();
        if (flushBuf && flushBuf.length > 0) {
          await write(new Uint8Array(flushBuf.buffer, flushBuf.byteOffset, flushBuf.length));
        }
      }
      setProgress(1);

      var blob;
      if (sink) {
        blob = await sink.finish();
      } else {
        blob = new Blob(parts, { type: state.format === 'mp3' ? 'audio/mpeg' : 'audio/wav' });
      }
      return {
        blob: blob,
        sampleRate: plan.targetSampleRate,
        durationSec: plan.totalFrames / plan.targetSampleRate
      };
    } catch (e) {
      if (sink) sink.abort();
      throw e;
    }
  }

  /**
   * M4A(AAC) 实时编码：把各段 AudioBuffer 顺序调度进 MediaRecorder，
   * 不生成合并后的整体 PCM（旧实现整体拷贝一遍，长音频内存翻倍）。
   * 归一化/淡变经 GainNode 自动化实现；采样率不一致时仅对该段做一次
   * 瞬时重采样拷贝（声道交由 WebAudio 上混规则处理）。
   */
  function encodeM4AScheduled(segs, targetRate, gapSec, gain, fadeSec, token, onProgress) {
    return new Promise(function (resolve, reject) {
      var ctx = state.audioCtx;
      var dest = ctx.createMediaStreamDestination();
      var mime = pickMimeType() || '';
      var rec;
      try {
        rec = new MediaRecorder(dest.stream, mime ? { mimeType: mime } : undefined);
      } catch (e) { reject(e); return; }
      state.m4aRecorder = rec;
      var chunks = [];
      rec.ondataavailable = function (e) {
        if (e.data && e.data.size > 0) chunks.push(e.data);
      };
      var sources = [];
      var t = ctx.currentTime + 0.2;
      var t0 = t;

      function segmentBuffer(seg) {
        // 剪切范围：优先用浏览器原生 slice（AudioBuffer 路径，零 WASM 依赖）
        var trim = segTrimFrames(seg);
        if (seg.audioBuffer && seg.audioBuffer.sampleRate === targetRate) {
          if (trim.start === 0 && trim.end === seg.audioBuffer.length) return seg.audioBuffer;
          return seg.audioBuffer.slice(
            trim.start / seg.audioBuffer.sampleRate,
            trim.end / seg.audioBuffer.sampleRate
          );
        }
        var src = seg.pcm;
        var conv = AudioCore.createSegmentConverter(src, {
          targetRate: targetRate,
          targetChannels: src.channels.length, // 声道不变，单声道由 WebAudio 上混
          fadeMs: 0,
          srcStart: trim.start,
          srcEnd: trim.end,
          int16: false
        });
        var buf = ctx.createBuffer(src.channels.length, conv.outFrames, targetRate);
        var views = [];
        for (var c = 0; c < src.channels.length; c++) views.push(buf.getChannelData(c));
        conv.convert(0, conv.outFrames, views);
        return buf;
      }

      segs.forEach(function (seg, segIndex) {
        if (!seg.pcm) return;
        var buf = segmentBuffer(seg);
        var dur = buf.duration;
        var src = ctx.createBufferSource();
        src.buffer = buf;
        var g = ctx.createGain();
        if (dur > fadeSec * 2) {
          g.gain.setValueAtTime(0, t);
          g.gain.linearRampToValueAtTime(gain, t + fadeSec);
          g.gain.setValueAtTime(gain, t + dur - fadeSec);
          g.gain.linearRampToValueAtTime(0, t + dur);
        } else {
          g.gain.value = gain;
        }
        src.connect(g);
        g.connect(dest);
        src.start(t);
        src.stop(t + dur);
        sources.push(src);
        // 只在段间插间隔：WAV/MP3 的 planMerge 也是 gapFrames*(parts-1)，
        // 旧实现对最后一段也加 gapSec，导致成品多录一段静音、显示时长少报。
        t += dur + (segIndex < segs.length - 1 ? gapSec : 0);
      });
      var endTime = t;

      var stopped = false;
      function stopNow() {
        if (stopped) return;
        stopped = true;
        clearInterval(timer);
        try { if (rec.state !== 'inactive') rec.stop(); } catch (e) { /* 忽略 */ }
      }
      rec.onerror = function (e) {
        stopNow();
        state.m4aRecorder = null;
        var err = (e && e.error && e.error.message) || '录制编码失败';
        reject(new Error('M4A ' + err + '，请改用 WAV 或 MP3'));
      };
      rec.start(1000);
      var timer = setInterval(function () {
        // 实时编码与音频等长，取消必须立刻生效，不能等 endTime 到了才检查
        if (token !== state.mergeToken) { stopNow(); return; }
        var p = Math.min(1, Math.max(0, (ctx.currentTime - t0) / Math.max(0.001, endTime - t0)));
        onProgress(p);
        if (p >= 1) stopNow();
      }, 250);

      rec.onstop = function () {
        clearInterval(timer);
        state.m4aRecorder = null;
        sources.forEach(function (s) { try { s.stop(); } catch (e) { /* 忽略 */ } });
        if (token !== state.mergeToken) {
          reject(canceledError());
          return;
        }
        // 空 chunks 也必须判失败：旧实现会 resolve 一个 0 字节 Blob 并报「合并完成」
        if (!chunks.length) {
          reject(new Error('M4A 编码未产出数据（可能是媒体权限或编码器异常），请改用 WAV 或 MP3'));
          return;
        }
        var type = (chunks[0] && chunks[0].type) || mime || 'audio/mp4';
        resolve({
          blob: new Blob(chunks, { type: type }),
          ext: /webm|ogg/i.test(type) ? 'webm' : 'm4a',
          mime: type
        });
      };
    });
  }

  async function doMerge() {
    var segs = state.segments;
    if (!segs.length) {
      setStatus('请先导入或录制至少一段音频', true);
      return;
    }
    if (decodingCount() > 0 || segs.some(function (s) { return s.failed; })) {
      setStatus('请先等待所有片段解码完成（或移除失败的片段）', true);
      return;
    }
    if (state.format === 'mp3' && !(window.lamejs && window.lamejs.Mp3Encoder)) {
      setStatus('MP3 编码器未加载，请刷新页面重试', true);
      return;
    }
    if (state.format === 'm4a' && !state.m4aSupported) {
      setStatus('当前浏览器不支持 M4A 输出，请选择 WAV 或 MP3', true);
      return;
    }

    var token = ++state.mergeToken;
    hideResult(); // 旧结果与新合并无关，先清掉（同时释放其 blob URL）
    setBusy(true);
    setStatus('正在准备合并…');
    showProgress(0);

    try {
      // 被释放过的片段重新解码（流式合并会逐段释放输入控制内存峰值）
      if (segs.some(function (s) { return s.released; })) {
        await ensureAllDecoded(token);
        if (token !== state.mergeToken) throw canceledError();
        if (decodingCount() > 0 || segs.some(function (s) { return s.failed; })) {
          throw new Error('请先等待所有片段解码完成（或移除失败的片段）');
        }
      }

      if (state.format === 'm4a') {
        // M4A 不产生 OPFS 文件：顺手清掉上次 WAV/MP3 合并留下的孤儿（hideResult 已丢弃该结果）
        await cleanOldOpfsFiles(null);
        // M4A：AudioBuffer 顺序调度 + MediaRecorder 实时捕获
        setStatus('M4A 实时编码中：耗时与音频等长，请保持页面在前台…');
        await getCtx();
        if (token !== state.mergeToken) throw canceledError();
        await nextFrame();
        if (token !== state.mergeToken) throw canceledError();
        var mTarget = AudioCore.pickTargetRate(segs.map(function (s) { return s.pcm.sampleRate; }));
        var mGap = parseFloat($('gapRange').value) || 0;
        var mGain = 1;
        if ($('normalizeChk').checked) {
          var mPeak = 0;
          for (var mi = 0; mi < segs.length; mi++) {
            // 峰值扫描是同步长任务；每 4 段让出一次，让「取消」在准备阶段就能生效
            if (token !== state.mergeToken) throw canceledError();
            if (mi > 0 && mi % 4 === 0) await nextFrame();
            var ms = segs[mi];
            // 与 WAV/MP3 路径一致：只统计剪切后区间，否则被剪掉的响段会压低增益
            var t = segTrimFrames(ms);
            mPeak = Math.max(mPeak, AudioCore.segmentPeakAfterFade(
              ms.pcm, mTarget, 2, 8, t.start, t.end
            ));
          }
          if (mPeak > 0 && isFinite(mPeak)) mGain = Math.min(0.89 / mPeak, 8);
        }
        var r = await encodeM4AScheduled(segs, mTarget, mGap, mGain, 0.008, token, function (p) {
          setProgress(p, 'M4A 实时编码中');
        });
        if (token !== state.mergeToken) throw canceledError();
        var mDur = segs.reduce(function (a, s) { return a + segEffectiveDuration(s); }, 0) +
          mGap * (segs.length - 1);
        finishResult(r.blob, r.ext, r.mime, {
          sampleRate: mTarget, durationSec: mDur, bitrate: 0
        });
        return;
      }

      // WAV/MP3：流式合并（分块转换 + 落盘/内存回落 + 逐段释放输入）
      var sink = await openMergeSink(state.format);
      if (sink) await cleanOldOpfsFiles(sink.name);
      var est = estimateMergeBytes();
      // iOS 专项保护：输出文件过大时提前劝阻（重载发生在合并成功瞬间，事后无法挽回）
      if (isIOSDevice() && est.out > 200 * 1024 * 1024) {
        var iosOk = window.confirm(
          'iOS 浏览器内存有限：本次将生成约 ' + fmtSize(est.out) + ' 的 ' +
          state.format.toUpperCase() + ' 文件，\n继续可能触发页面重载（表现为"自动刷新"、结果丢失）。\n\n' +
          '建议改用 MP3（体积约为 1/10），或分段合并。\n\n仍要继续吗？'
        );
        if (!iosOk) {
          // 弹窗被拒：必须关闭已打开的 OPFS 写句柄，否则留下未关闭的 writable
          // 和孤儿文件（同名文件下次可能因句柄未释放而打不开，被迫退回内存模式）
          if (sink) await sink.abort();
          setStatus('已取消合并（iOS 内存保护）');
          return;
        }
      }
      if (!sink && est.total > 1200 * 1024 * 1024) {
        // 无流式落盘且估算内存危险：明确警告，让用户选择，而不是 silent crash
        var proceed = window.confirm(
          '本次合并预计需要约 ' + fmtSize(est.total) + ' 内存，且当前浏览器不支持流式落盘（OPFS）。' +
          '继续可能因内存不足导致页面重载。\n\n建议：分段合并、改用 MP3 输出，或换用支持 OPFS 的浏览器（Chrome/Edge）。\n\n仍要继续吗？'
        );
        if (!proceed) {
          if (sink) await sink.abort(); // 同上：关闭写句柄，避免孤儿文件与句柄滞留
          setStatus('已取消合并（内存估算超限）');
          return;
        }
        if (token !== state.mergeToken) throw canceledError();
      } else if (sink && est.inputs > 2000 * 1024 * 1024) {
        setStatus('输入音频很大（约 ' + fmtSize(est.inputs) +
          '），结果将直接写入本地存储，内存压力已尽量降低…');
      }
      var result = await streamMerge(token, sink);
      if (token !== state.mergeToken) throw canceledError();
      finishResult(result.blob, state.format,
        state.format === 'mp3' ? 'audio/mpeg' : 'audio/wav', {
          sampleRate: result.sampleRate,
          durationSec: result.durationSec,
          bitrate: state.format === 'mp3' ? state.bitrate : 0
        });
    } catch (err) {
      if (err && err.code === 'CANCELED') {
        setStatus('已取消合并');
      } else {
        console.error(err);
        setStatus('合并失败：' + (err && err.message ? err.message : err), true);
      }
    } finally {
      hideProgress();
      setBusy(false);
    }
  }

  /** 是否 iOS / iPadOS（含桌面模式） */
  function isIOSDevice() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }

  /**
   * 结果的 object URL 按需创建（V0.3.4）。
   * iOS 上在"合并成功"瞬间创建大 Blob 的 URL 并让 audio 加载，会叠加内存峰值，
   * 触发 WKWebView 内存上限 → 页面被系统重载（表现为"自动刷新"、分享按钮不出现）。
   */
  function ensureResultUrl() {
    if (!state.mergedBlob) return null;
    if (!state.mergedUrl) state.mergedUrl = URL.createObjectURL(state.mergedBlob);
    return state.mergedUrl;
  }

  function playResult() {
    var player = $('resultAudio');
    var url = ensureResultUrl();
    if (!url) return;
    if (player.getAttribute('src') !== url) player.src = url;
    player.hidden = false;
    var p = player.play();
    if (p && typeof p.catch === 'function') {
      p.catch(function (err) {
        setStatus('播放失败：' + (err && err.message ? err.message : err), true);
      });
    }
  }

  function finishResult(blob, ext, mime, meta) {
    if (state.mergedUrl) URL.revokeObjectURL(state.mergedUrl);
    state.mergedBlob = blob;
    state.mergedUrl = null; // 延迟创建：只在用户点「试听」/「分享」时生成
    state.mergedExt = ext;
    var player = $('resultAudio');
    try { player.pause(); } catch (e) { /* 忽略 */ }
    player.removeAttribute('src');
    player.hidden = true;
    $('resultMeta').textContent = ext.toUpperCase() +
      (meta.bitrate ? ' · ' + meta.bitrate + ' kbps' : '') +
      ' · ' + Math.round(meta.sampleRate / 1000) + 'kHz' +
      ' · 时长 ' + fmtTime(meta.durationSec) +
      ' · 大小 ' + fmtSize(blob.size);
    $('resultBox').hidden = false;
    // 新结果生成后，上一轮的保存链接已失效（服务端文件仍是旧的，blob URL 指向旧结果）
    $('saveLink').hidden = true;
    $('saveHint').textContent = '';
    $('btnSaveFile').hidden = false;   // 复位：iOS 兜底时可能被临时隐藏过
    $('saveBox').hidden = !state.serverReady;
    var big = blob.size > 60 * 1024 * 1024;
    setStatus('合并完成，可试听、分享或下载' +
      (big ? '（文件较大，点「试听」时才加载，避免 iOS 因内存不足重载页面）' : ''));
  }

  /**
   * 保存到「文件」App：借用服务端直链 + Content-Disposition（iOS 唯一稳定通道）。
   *
   * iOS 上的三条前端路径都不理想：
   *   - `a[download]` + blob URL：iOS 各版本行为反复，时好时坏；
   *   - `window.open(blobURL)`：交给系统播放器打开，而播放器没有保存入口；
   *   - `navigator.share({files})`：可用，但要把整包读进内存，大文件容易触发页面重载。
   * 所以在电脑上跑 `node tools/serve.js`（局域网）后，把结果 POST 上去换一个
   * 普通链接：用户点链接 → 浏览器下载管理器接管 → 存到「文件」App。
   *
   * 接口一律用相对路径（'api/...'），以适配子目录部署（如 GitHub Pages 的 /audio-merge-lab/）。
   */
  /**
   * 服务可用状态统一管理：探测失败、服务关闭、上传失败都要复位，
   * 否则「分享/下载」会被永久锁死在上传通道上，用户刷新才可能恢复（F2）。
   */
  function setServerReady(ok) {
    state.serverReady = !!ok;
    if ($('resultBox').hidden || !state.mergedBlob) {
      $('saveBox').hidden = true;
    } else {
      $('saveBox').hidden = !state.serverReady;
    }
  }

  /** 探测局域网下载服务，返回 Promise<boolean>；带 3 秒超时，老内核自动退化 */
  function probeDownloadServer() {
    if (typeof fetch !== 'function') { setServerReady(false); return Promise.resolve(false); }
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = null;
    var opts = { cache: 'no-store' };
    if (ctrl) {
      opts.signal = ctrl.signal;
      timer = setTimeout(function () { try { ctrl.abort(); } catch (e) { /* 忽略 */ } }, 3000);
    }
    return fetch('api/health', opts)
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (info) {
        // 线上静态托管没有该接口（404 或返回 HTML），解析失败即视为不可用
        setServerReady(!!(info && info.ok && info.upload));
        return state.serverReady;
      })
      .catch(function () { setServerReady(false); return false; })
      .then(function (ok) {
        if (timer) clearTimeout(timer);
        return ok;
      });
  }

  /**
   * 上传到局域网下载服务。返回 Promise<boolean>：false 表示应走本机降级通道。
   * 双入口（「分享/下载」与「生成保存链接」）共用一把锁，XHR 有超时与取消能力。
   */
  function uploadForDownload() {
    if (uploadState.busy) return Promise.resolve(false);
    var blob = state.mergedBlob; // 快照：await 期间结果被替换也不会展示旧链接
    if (!blob) { setStatus('还没有可保存的结果', true); return Promise.resolve(false); }
    var ext = state.mergedExt || 'wav';
    var mime = blob.type || 'audio/wav';
    var filename = 'merged-' + nowStamp() + '.' + ext;
    var btn = $('btnSaveFile');
    btn.disabled = true;
    uploadState.busy = true;
    showProgress(0, '上传');
    setStatus('正在上传到本机下载服务…');

    return new Promise(function (resolve) {
      var settled = false;
      function finish(ok, msg) {
        if (settled) return;
        settled = true;
        if (uploadState.xhr) { try { uploadState.xhr.ontimeout = uploadState.xhr.onabort = null; } catch (e) { /* 忽略 */ } }
        uploadState.xhr = null;
        uploadState.busy = false;
        btn.disabled = false;
        hideProgress();
        if (msg && state.mergedBlob === blob) setStatus(msg, !ok);
        resolve(ok);
      }
      // 用 XHR 而非 fetch：只有 XHR 能拿到上传进度（大文件需要反馈）
      var xhr = new XMLHttpRequest();
      uploadState.xhr = xhr;
      xhr.open('POST', 'api/upload?name=' + encodeURIComponent(filename) + '&mime=' + encodeURIComponent(mime));
      // 大文件按体积放宽，但绝不允许无限等待（旧实现无 timeout，服务假死后永远卡住）
      xhr.timeout = Math.max(60000, Math.ceil(blob.size / (256 * 1024)) * 1000);
      xhr.upload.onprogress = function (e) {
        if (e.lengthComputable) setProgress(e.loaded / e.total, '上传');
      };
      xhr.onload = function () {
        var data = null;
        try { data = JSON.parse(xhr.responseText); } catch (e) { data = null; }
        if (xhr.status >= 200 && xhr.status < 300 && data && data.url) {
          if (state.mergedBlob === blob) showSaveLink(data.url, data.name || filename, data.size || blob.size);
          finish(true);
        } else {
          setServerReady(false);
          finish(false, '生成下载链接失败：' + ((data && data.error) || ('HTTP ' + xhr.status)) +
            '。已切回本机保存，请再点一次「分享 / 下载」');
        }
      };
      function networkFail(msg) {
        setServerReady(false);
        finish(false, msg);
      }
      xhr.onerror = function () {
        networkFail('连不上下载服务：请确认电脑上运行着 node tools/serve.js，且手机与电脑在同一 Wi-Fi。' +
          '已切回本机保存，请再点一次「分享 / 下载」');
      };
      xhr.ontimeout = function () {
        networkFail('上传超时（下载服务无响应），已切回本机保存');
        try { xhr.abort(); } catch (e) { /* 忽略 */ }
      };
      xhr.onabort = function () { networkFail('上传已中断，已切回本机保存'); };
      try { xhr.send(blob); } catch (e) { networkFail('无法发起上传：' + (e && e.message ? e.message : e)); }
    });
  }

  function showSaveLink(url, name, size) {
    var link = $('saveLink');
    link.href = url;
    // 同源链接：非 iOS 平台由此拿到文件名；iOS 主要靠服务端的 Content-Disposition
    link.setAttribute('download', name);
    link.hidden = false;
    /* 没有本地下载服务时，这里的 url 是内存 blob URL（iOS 可靠长按「下载链接文件」，
     * 也可能被直接下载）。此时「生成保存链接」按钮无意义（点了必然失败），隐藏掉。 */
    $('btnSaveFile').hidden = !state.serverReady;
    $('saveBox').hidden = false;
    $('saveHint').textContent = '点上方链接保存：' + name + '（' + fmtSize(size) + '）。' +
      'iOS 下载完成后去「文件」App 查看；若点了没反应，长按链接选择「下载链接文件」。';
    setStatus('下载链接已生成：' + name);
  }

  /** 用 <a download> 触发下载；返回值只代表"已挂接"，不保证浏览器真的下载 */
  function downloadViaAnchor(url, filename) {
    try {
      var a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      return true;
    } catch (e) {
      return false;
    }
  }

  async function shareOrDownload() {
    // 全程用快照：分享面板/上传可能挂起数秒，期间若结果被新合并覆盖或 hideResult()
    // 撤销了 object URL，旧实现会拿已失效的 URL 继续下载并报「成功」（F4）。
    var src = state.mergedBlob;
    if (!src) return;
    var url = ensureResultUrl();
    if (!url) return;
    var ext = state.mergedExt || 'wav';
    var mime = src.type || 'audio/wav';
    var filename = 'merged-' + nowStamp() + '.' + ext;
    var size = src.size || 0;
    var isIOS = isIOSDevice();

    // 1) 本地下载服务可用时优先：直链下载在 iOS 上最稳，且不必把整包读进内存。
    //    每次导出前重新探测（服务可能已关闭），失败则复位并继续走本机降级链。
    if (state.serverReady) {
      var alive = await probeDownloadServer();
      if (state.mergedBlob !== src) return;
      if (alive) {
        var uploaded = await uploadForDownload();
        if (state.mergedBlob !== src) return;
        if (uploaded) return;
        setStatus('下载服务不可用，已切换为本机保存方式…');
      }
    }

    /* 2) 系统分享优先 —— 这是 iOS 上不依赖电脑的唯一保存通道
     *    （分享面板 → 存储到文件）。
     *
     *    V0.4.1 及之前这里有个"体积 > 80MB 就直接 window.open 交给播放器"的分支，
     *    结果是 40 分钟左右的 WAV（约 400MB）根本进不了分享面板，用户只能看到
     *    全屏播放器（而播放器没有保存入口）。现已移除该分支：无论大小先试分享。
     *
     *    另外不要用 navigator.canShare 作为门槛：部分 Safari 版本对 audio/* 文件
     *    返回 false，但实际 share 可正常工作，用 try/catch 实测更准。
     */
    if (navigator.share) {
      try {
        /* 直接用已有的 blob 构造 File，不再 fetch(blobURL)：
         * 那条路会把整个结果在内存里再物化一份。OPFS 落盘的 File 没有 MIME type，
         * 必须包一层补上，否则部分系统的 share 会拒绝。 */
        var file = (src instanceof File && src.type)
          ? src
          : new File([src], filename, { type: mime });
        // 大文件时原生面板要先把数据交出去，可能等几秒；没有提示容易被当成卡死
        setStatus('正在打开系统分享面板…' + (size > 60 * 1024 * 1024 ? '（文件较大，需等待几秒）' : ''));
        await navigator.share({ files: [file], title: '合并录音', text: filename });
        if (state.mergedBlob !== src) return; // 分享期间结果已被替换：不覆盖新结果的状态
        setStatus('已打开系统分享面板：选「存储到文件」即可保存到「文件」App');
        return;
      } catch (e) {
        if (state.mergedBlob !== src) return;
        if (e && e.name === 'AbortError') { setStatus('已取消分享'); return; }
        // 不支持 / 文件过大 / 权限被拒 → 继续降级，但不把错误直接抛给用户
      }
    }

    // 3) <a download>：iOS 13+ 对同源 blob URL 有效，失败时通常静默无反应
    if (state.mergedBlob !== src) return; // URL 可能已被 hideResult() revoke
    var anchorOk = downloadViaAnchor(url, filename);
    if (anchorOk && !isIOS) {
      setStatus('已触发下载：' + filename);
      return;
    }

    // 4) iOS 兜底：给出可操作路径，不再自动跳播放器
    if (isIOS) {
      showSaveLink(url, filename, size);
      $('saveHint').textContent = 'iOS 未能直接保存「' + filename + '」（' + fmtSize(size) + '）。' +
        '请按顺序试：① 长按上面的链接 →「下载链接文件」；' +
        '② 回到结果页用「分享」→ 系统分享面板里选「存储到文件」；' +
        (size > 120 * 1024 * 1024
          ? '③ 文件偏大（' + fmtSize(size) + '），改选 MP3 输出体积约为 1/10，分享成功率更高；'
          : '③ ') +
        '④ 或在电脑上运行 node tools/serve.js，用「生成保存链接」走直链下载。';
      setStatus('iOS 无法直接保存，已列出手动保存步骤，请看下方提示', true);
      return;
    }

    if (anchorOk) { setStatus('已触发下载：' + filename); return; }
    setStatus('当前浏览器不支持自动下载，请改用 Chrome / Edge，或右键播放器另存', true);
  }

  /* ---------------- 事件绑定 ---------------- */
  /**
   * 拖拽排序：用 Pointer Events 实现（一套代码同时兼容鼠标与触摸，
   * 不依赖 HTML5 drag&drop——后者在移动端浏览器支持不完整）。
   * 按下把手即进入拖拽，实时把行插到目标位置，松手后按 DOM 顺序
   * 重排 state.segments 并重渲。合并进行中禁用。
   */
  function bindSegDrag() {
    var ul = $('segmentList');

    ul.addEventListener('pointerdown', function (e) {
      if (state.busy) return;
      var handle = e.target.closest ? e.target.closest('.seg-drag') : null;
      if (!handle) return;
      var li = handle.closest('.seg');
      if (!li) return;
      segDrag = { id: li.dataset.id, li: li, pointerId: e.pointerId };
      li.classList.add('dragging');
      try { handle.setPointerCapture(e.pointerId); } catch (err) { /* 旧内核忽略 */ }
      e.preventDefault(); // 阻止触摸滚动与文本选择
    });

    document.addEventListener('pointermove', function (e) {
      if (!segDrag || e.pointerId !== segDrag.pointerId) return;
      var over = document.elementFromPoint(e.clientX, e.clientY);
      var target = over && over.closest ? over.closest('.seg') : null;
      var list = $('segmentList');
      if (!target || target === segDrag.li || target.parentNode !== list) return;
      var rect = target.getBoundingClientRect();
      var after = e.clientY > rect.top + rect.height / 2;
      list.insertBefore(segDrag.li, after ? target.nextSibling : target);
    });

    function endDrag(e) {
      if (!segDrag || (e && e.pointerId !== segDrag.pointerId)) return;
      var li = segDrag.li;
      li.classList.remove('dragging');
      segDrag = null;
      // 先取当前 DOM 顺序；与数据层一致说明没有实际拖动（仅误触把手），
      // 此时绝不能 renderList()——它会 hideResult() 清掉刚合并的结果。
      var ids = [];
      Array.prototype.forEach.call($('segmentList').children, function (node) {
        if (node.dataset && node.dataset.id) ids.push(node.dataset.id);
      });
      var unchanged = ids.length === state.segments.length &&
        state.segments.every(function (s, i) { return s.id === ids[i]; });
      if (unchanged) {
        // 期间若有被推迟的列表重建（解码完成等），这里补上；不误触 hideResult()
        if (pendingRender) renderList(true);
        return;
      }
      var order = {};
      ids.forEach(function (id, i) { order[id] = i; });
      state.segments.sort(function (a, b) { return order[a.id] - order[b.id]; });
      renderList();
      setStatus('顺序已调整');
    }
    document.addEventListener('pointerup', endDrag);
    document.addEventListener('pointercancel', endDrag);
  }

  /** 文件选择回调（主入口与兼容模式入口共用） */
  function handleFilePick(e) {
    var files = Array.prototype.slice.call(e.target.files || []);
    e.target.value = ''; // 允许重复选择同一文件
    enqueueFiles(files);
  }

  function bind() {
    // 导入按钮是 <label for="fileInput">：点击由浏览器原生激活 file input，
    // 不需要（也不能）用 JS 调 fileInput.click()——iOS WKWebView 会静默忽略
    // 对视觉隐藏 input 的程序化点击。这里只做管线预热。
    $('btnImport').addEventListener('click', function () {
      warmAudioPipeline(); // 文件选择器打开前预热（移动端选择器要数秒）
    });

    $('fileInput').addEventListener('change', handleFilePick);
    // 兼容模式入口：部分国产内核（X5/夸克/UC/厂商自带）对 accept 过滤有 bug，
    // 无 accept 的 input 仍能正常弹选择器；选中后同样走解码与格式校验
    $('fileInputAny').addEventListener('change', handleFilePick);

    $('btnRecord').addEventListener('click', toggleRecord);
    $('btnShare').addEventListener('click', shareOrDownload);
    $('btnSaveFile').addEventListener('click', uploadForDownload);
    $('btnPlayResult').addEventListener('click', playResult);
    $('btnCancel').addEventListener('click', cancelMerge);

    $('btnMerge').addEventListener('click', function () {
      if (state.busy) {
        cancelMerge();
        return;
      }
      doMerge();
    });

    $('btnClear').addEventListener('click', function () {
      if (state.busy) { // 合并中清空列表同样不影响进行中的合并，只会造成困惑
        setStatus('合并进行中：请先取消合并，再清空片段列表', true);
        return;
      }
      stopSegPlayback();
      decodeQueue = [];
      state.segments.forEach(function (s) {
        if (s.url) URL.revokeObjectURL(s.url);
      });
      state.segments = [];
      hideResult();
      renderList();
      setStatus('已清空片段列表');
    });

    $('segmentList').addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-act]');
      if (!btn) return;
      var li = btn.closest('.seg');
      if (!li) return;
      var id = li.dataset.id;
      var act = btn.dataset.act;
      if (act === 'play') toggleSegPlayback(id);
      else if (act === 'del') removeSegment(id);
      else if (act === 'copy') copySegment(id);
      else if (act === 'trim') {
        var seg = state.segments.find(function (s) { return s.id === id; });
        if (seg) { seg.trimOpen = !seg.trimOpen; renderList(true); }
      } else if (act === 'trim-reset') {
        var seg2 = state.segments.find(function (s) { return s.id === id; });
        if (seg2) { resetTrim(seg2); renderList(true); setStatus('已恢复「' + seg2.name + '」为整段'); }
      } else if (act === 'trim-done') {
        var seg3 = state.segments.find(function (s) { return s.id === id; });
        if (seg3) {
          seg3.trimOpen = false;
          renderList(true);
          if (typeof seg3.trimStart === 'number' || typeof seg3.trimEnd === 'number') {
            setStatus('「' + seg3.name + '」将只合并 ' +
              fmtSec(seg3.trimStart || 0) + '–' +
              fmtSec(seg3.trimEnd != null ? seg3.trimEnd : seg3.duration) + ' 的部分');
          }
        }
      }
    });

    // 剪切范围输入（滑杆 / 数字框）：实时写回片段状态并就地刷新显示
    $('segmentList').addEventListener('input', function (e) {
      if (state.busy) return; // 合并中 plan 已快照，改动只会让估算与结果不一致
      var input = e.target;
      if (!input.classList) return;
      var isRange = input.classList.contains('trim-range');
      var isNum = input.classList.contains('trim-num');
      if (!isRange && !isNum) return;
      var t = trimTargetFrom(input);
      if (!t) return;
      var parsed = parseFloat(input.value);
      if (!isFinite(parsed) || parsed < 0) return;
      // 数字框的 max 不会阻止 input 事件取到超大值，必须显式 clamp 到片段时长
      var max = (typeof t.seg.duration === 'number' && t.seg.duration > 0) ? t.seg.duration : parsed;
      var v = Math.min(parsed, max);
      if (t.which === 'start') t.seg.trimStart = v;
      else t.seg.trimEnd = v;
      var shortClip = t.seg.duration > 0 && t.seg.duration < 1;
      if (isNum && v !== parsed) input.value = v.toFixed(shortClip ? 3 : 1);
      refreshSegRow(t.seg);
    });

    bindSegDrag();

    $('formatGroup').addEventListener('click', function (e) {
      if (state.busy) return; // 事件层兜底，防止禁用状态被绕过
      var btn = e.target.closest('.seg-btn');
      if (btn && !btn.disabled) setFormat(btn.dataset.fmt);
    });

    $('bitrateSel').addEventListener('change', function () {
      if (state.busy) { this.value = String(state.bitrate); return; }
      state.bitrate = parseInt(this.value, 10) || 128;
      updateSizeEstimate();
      updateFormatHint(); // 低位率的「反而更慢」提示需随选择实时刷新
    });

    $('segPlayer').addEventListener('ended', function () {
      if (state.playingId) {
        stopSegPlayback();
        renderList(true);
      }
    });

    $('gapRange').addEventListener('input', function () {
      $('gapValue').textContent = parseFloat(this.value).toFixed(1) + ' 秒';
    });
  }

  /* ---------------- 启动 ---------------- */
  document.addEventListener('DOMContentLoaded', function () {
    try {
      bind();
      detectFormats();
      setFormat('mp3');
      renderList();
      setStatus('就绪：导入 mp3 / m4a / wav 等音频，或直接录音，然后点击底部「合并为 MP3」');

      // 探测局域网下载服务（tools/serve.js）：可用才显示「生成保存链接」
      probeDownloadServer();

      // 页脚版本号：取核心层的单一权威值（作者与链接在模板中静态声明）
      $('appVersion').textContent = 'v' + AudioCore.APP_VERSION;

      // 通知启动守卫：应用已就绪（守卫会撤掉可能已显示的失败提示）
      if (typeof window.__AML_BOOTED === 'function') window.__AML_BOOTED();

      // PWA 离线缓存：仅在真实 http(s) 部署时注册（跳过 localhost 与 Capacitor 壳，
      // 避免 Capacitor 本地资源服务器被缓存导致更新后拿到旧文件）
      var isLocal = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
      if ('serviceWorker' in navigator && location.protocol.indexOf('http') === 0 && !isLocal) {
        navigator.serviceWorker.register('sw.js').catch(function () {
          /* 注册失败不影响使用 */
        });
      }
    } catch (err) {
      // 初始化异常：交给启动守卫显示可读提示（否则用户只看到白屏）
      if (typeof window.__AML_FAIL === 'function') {
        window.__AML_FAIL('初始化异常：' + (err && err.message ? err.message : err));
      }
      throw err;
    }
  });
})();
