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
    segments: [],     // {id, name, source, blob, url, pcm, duration, sampleRate, channels, decoding, failed, errorMsg}
    audioCtx: null,
    mediaRecorder: null,
    recordChunks: [],
    recordTimer: null,
    recordStart: 0,
    seq: 0,
    playingId: null,  // 正在试听的片段 id
    format: 'wav',    // 输出格式：wav / mp3 / m4a
    bitrate: 128,     // MP3 位率（kbps）
    m4aSupported: false,
    m4aRecorder: null,
    busy: false,
    mergeToken: 0,    // 取消令牌：每次合并自增，回调里比对
    mergedBlob: null,
    mergedUrl: null,
    mergedExt: 'wav',
    mergedOpfsName: null // 当前结果对应的 OPFS 文件名（清理时保留）
  };

  var decodeQueue = [];    // 待解码片段队列（顺序执行，控制内存峰值）
  var decodeRunning = false;
  var warmStarted = false; // 音频管线预热只做一次

  // 预热燃料：0.1 秒 128kbps MPEG-1 Layer III（FF FB 头，与真实文件同解码路径）。
  // 由 tools 生成脚本用官方 lamejs 编码后内联，仅用于预热，解码后即丢弃。
  var TINY_MP3_B64 =
    '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' +
    '==';

  var FORMAT_LABELS = { wav: 'WAV', mp3: 'MP3', m4a: 'M4A' };

  /* ---------------- DOM 助手 ---------------- */
  function $(id) { return document.getElementById(id); }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function nextFrame() {
    return new Promise(function (r) {
      if (window.requestAnimationFrame) requestAnimationFrame(function () { r(); });
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
    setProgress(p, label);
  }

  function setProgress(p, label) {
    $('progressFill').style.width = Math.round(p * 100) + '%';
    $('progressLabel').textContent = (label ? label + ' · ' : '') + Math.round(p * 100) + '%';
  }

  function hideProgress() {
    $('progressWrap').hidden = true;
    $('progressFill').style.width = '0%';
  }

  function setBusy(busy) {
    state.busy = busy;
    $('btnImport').classList.toggle('disabled', busy);
    $('btnRecord').disabled = busy;
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
  function totalDuration() {
    var sum = 0;
    state.segments.forEach(function (s) { sum += s.duration || 0; });
    return sum;
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
  function enqueueFiles(files) {
    var added = [];
    Array.prototype.forEach.call(files || [], function (file) {
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
        channels: 0
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
    });
  }

  async function decodeSegment(seg) {
    try {
      var buf = await readAsArrayBuffer(seg.blob);
      await getCtx();
      var audioBuf = await decodeAudioData(buf);
      // 解码期间该片段可能已被移除
      if (!state.segments.some(function (s) { return s.id === seg.id; })) return;
      seg.pcm = audioBufferToPcm(audioBuf);
      seg.audioBuffer = audioBuf; // 保留引用：M4A 调度可直接复用，且与 pcm 视图共享同一块内存
      seg.duration = audioBuf.duration;
      seg.sampleRate = audioBuf.sampleRate;
      seg.channels = audioBuf.numberOfChannels;
      seg.decoding = false;
      renderList();
      var rest = decodeQueue.length;
      setStatus('已解码「' + seg.name + '」（' + fmtTime(seg.duration) + '）' +
        (rest > 0 ? '，队列还剩 ' + rest + ' 个' : '') +
        '。当前共 ' + state.segments.length + ' 段，合计 ' + fmtTime(totalDuration()));
    } catch (err) {
      if (!state.segments.some(function (s) { return s.id === seg.id; })) return;
      seg.decoding = false;
      seg.failed = true;
      seg.errorMsg = err && err.message ? err.message : String(err);
      renderList();
      setStatus('「' + seg.name + '」解码失败：' + seg.errorMsg +
        '（' + decodeFailHint(seg.name) + '）', true);
    }
  }

  function removeSegment(id) {
    var seg = state.segments.find(function (s) { return s.id === id; });
    if (seg && state.playingId === id) stopSegPlayback();
    if (seg && seg.url) { URL.revokeObjectURL(seg.url); seg.url = null; }
    state.segments = state.segments.filter(function (s) { return s.id !== id; });
    renderList();
  }

  function moveSegment(id, dir) {
    var idx = state.segments.findIndex(function (s) { return s.id === id; });
    if (idx < 0) return;
    var target = idx + dir;
    if (target < 0 || target >= state.segments.length) return;
    var tmp = state.segments[idx];
    state.segments[idx] = state.segments[target];
    state.segments[target] = tmp;
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

  function updateFormatHint() {
    var hint;
    if (state.format === 'wav') {
      hint = 'WAV 无损：约 ' + fmtSize(estimateTargetRate() * 4) + '/秒，兼容性最好，适合存档。';
    } else if (state.format === 'mp3') {
      hint = 'MP3 有损压缩：体积约为 WAV 的 1/10，编码在本地完成，长文件需要几十秒。';
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
    var bytes;
    if (state.format === 'wav') bytes = dur * rate * 2 * 2;          // 立体声 16bit
    else if (state.format === 'mp3') bytes = dur * state.bitrate * 1000 / 8;
    else bytes = dur * 128000 / 8;                                    // M4A 按 128kbps 估
    $('sizeEst').textContent = '预计约 ' + fmtSize(bytes) +
      '（' + Math.round(rate / 1000) + 'kHz · 当前 ' + state.segments.length +
      ' 段合计 ' + fmtTime(dur) + '）';
  }

  /* ---------------- 列表渲染 ---------------- */
  /** 清理已生成的合并结果（列表变动后结果即过期） */
  function hideResult() {
    var a = $('resultAudio');
    try { a.pause(); } catch (e) { /* 忽略 */ }
    a.removeAttribute('src');
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
    if (!keepResult) hideResult();
    updateActionBar();
    updateSizeEstimate();
    updateMergeButton();

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

      li.appendChild(el('span', 'seg-idx', String(i + 1)));

      var play = el('button', 'icon-btn play', state.playingId === seg.id ? '⏸' : '▶');
      play.type = 'button';
      play.title = '试听';
      play.dataset.act = 'play';
      if (seg.decoding || seg.failed) play.disabled = true;
      li.appendChild(play);

      var info = el('div', 'seg-info');
      info.appendChild(el('div', 'seg-name', seg.name));
      var meta;
      if (seg.decoding) {
        meta = '解码中…';
      } else if (seg.failed) {
        meta = '解码失败：' + (seg.errorMsg || '格式不支持');
      } else {
        meta = seg.source + ' · ' + fmtTime(seg.duration) +
          ' · ' + Math.round(seg.sampleRate / 1000) + 'kHz · ' +
          (seg.channels === 1 ? '单声道' : seg.channels + ' 声道');
      }
      info.appendChild(el('div', 'seg-meta', meta));
      li.appendChild(info);

      var actions = el('div', 'seg-actions');
      var up = el('button', 'icon-btn', '↑');
      up.type = 'button';
      up.title = '上移';
      up.dataset.act = 'up';
      if (i === 0) up.disabled = true;
      var down = el('button', 'icon-btn', '↓');
      down.type = 'button';
      down.title = '下移';
      down.dataset.act = 'down';
      if (i === state.segments.length - 1) down.disabled = true;
      var del = el('button', 'icon-btn danger', '✕');
      del.type = 'button';
      del.title = '移除';
      del.dataset.act = 'del';
      actions.appendChild(up);
      actions.appendChild(down);
      actions.appendChild(del);
      li.appendChild(actions);

      ul.appendChild(li);
    });
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
   * 解码失败的兼容性提示：只列已知且已核实的平台缺口，不做猜测性断言。
   * 桌面版 Chrome 因 AAC 专利授权问题不解码 m4a/aac 是确证事实；
   * 其余情况给通用建议。
   */
  function decodeFailHint(name) {
    var lower = (name || '').toLowerCase();
    var ua = navigator.userAgent;
    var isDesktopChrome = /Chrome|Chromium/.test(ua) &&
      !/Mobile|Android|iPhone|iPad|iPod/.test(ua);
    if (/\.(m4a|aac|mp4)(\?|#|$)/.test(lower) && isDesktopChrome) {
      return '桌面版 Chrome 不解码 AAC：请改用手机浏览器 / Safari 打开，或先将该文件转为 MP3 / WAV';
    }
    return '该格式可能不被当前浏览器支持，可移除该片段';
  }

  function pickMimeType() {
    if (typeof MediaRecorder === 'undefined') return null;
    var candidates = [
      'audio/mp4;codecs=mp4a.40.2', // iOS Safari
      'audio/mp4',
      'audio/webm;codecs=opus',     // Android Chrome
      'audio/webm',
      'audio/ogg;codecs=opus'
    ];
    for (var i = 0; i < candidates.length; i++) {
      if (MediaRecorder.isTypeSupported(candidates[i])) return candidates[i];
    }
    return '';
  }

  async function toggleRecord() {
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
    try {
      setStatus('正在请求麦克风权限…');
      var stream = await navigator.mediaDevices.getUserMedia({ audio: true });
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
      console.error(err);
      var msg = err && err.name === 'NotAllowedError'
        ? '麦克风权限被拒绝，请在浏览器设置中允许后重试' +
          (isWeChat() ? '；或点右上角 ⋯ 用默认浏览器打开' : '')
        : '无法启动录音：' + (err && err.message ? err.message : err);
      setStatus(msg, true);
    }
  }

  async function onRecordStop() {
    clearInterval(state.recordTimer);
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
    setStatus('录音结束（' + fmtSize(blob.size) + '），加入列表并解码…');
    enqueueFiles([new File([blob], '录音 ' + nowStamp() + '.' + guessExt(blob.type), { type: blob.type })]);
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
          abort: function () { try { access.close(); } catch (e) { /* 忽略 */ } }
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
          abort: async function () { try { await writable.abort(); } catch (e) { /* 忽略 */ } }
        };
      }
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
  async function ensureAllDecoded() {
    var pending = state.segments.filter(function (s) { return s.released && !s.failed; });
    for (var i = 0; i < pending.length; i++) {
      var seg = pending[i];
      seg.released = false;
      seg.decoding = true;
      renderList();
      setStatus('重新解码「' + seg.name + '」…');
      await decodeSegment(seg);
    }
    renderList();
  }

  /** 合并内存估算（字节）：输入解码数据 + 输出文件 */
  function estimateMergeBytes() {
    var inputs = 0, dur = 0;
    state.segments.forEach(function (s) {
      dur += s.duration || 0;
      if (s.pcm) {
        inputs += s.pcm.channels[0].length * s.pcm.channels.length * 4;
      } else {
        inputs += (s.duration || 0) * (s.sampleRate || 44100) * (s.channels || 1) * 4;
      }
    });
    var out = 0;
    if (state.format === 'wav') out = dur * estimateTargetRate() * 2 * 2;
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
    var plan = AudioCore.planMerge(
      segs.map(function (s) { return { name: s.name, pcm: s.pcm }; }),
      { targetSampleRate: targetRate, targetChannels: 2, gapSec: gapSec, fadeMs: 8 }
    );

    // 归一化全局增益（与"先拼接再归一化"等价：拼接后峰值 = 各段淡变后峰值的最大者）
    var gain = 1;
    if ($('normalizeChk').checked) {
      var peak = 0;
      plan.parts.forEach(function (p) {
        peak = Math.max(peak, AudioCore.segmentPeakAfterFade(
          segs[p.index].pcm, plan.targetSampleRate, plan.targetChannels, 8
        ));
      });
      if (peak > 0 && isFinite(peak)) gain = Math.min(0.89 / peak, 8);
    }

    var parts = []; // 回落模式的内存块
    function write(bytes) {
      if (sink) return sink.write(bytes);
      parts.push(bytes);
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

      // 复用缓冲：Int16 每声道一块；WAV 还需一块交织字节缓冲
      var int16Chs = [];
      for (var c = 0; c < plan.targetChannels; c++) int16Chs.push(new Int16Array(MERGE_CHUNK_FRAMES));
      var wavBytes = null, wavView = null;
      if (state.format === 'wav') {
        wavBytes = new Uint8Array(MERGE_CHUNK_FRAMES * plan.targetChannels * 2);
        wavView = new DataView(wavBytes.buffer);
      }

      function writeWindow(frames) {
        if (state.format === 'wav') {
          var off = 0;
          for (var n = 0; n < frames; n++) {
            for (var ch = 0; ch < plan.targetChannels; ch++) {
              wavView.setInt16(off, int16Chs[ch][n], true);
              off += 2;
            }
          }
          return write(wavBytes.subarray(0, frames * plan.targetChannels * 2));
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
        state.mergedOpfsName = sink.name;
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
        // 采样率一致：直接用解码缓冲（零拷贝）；否则仅对本段重采样
        if (seg.audioBuffer && seg.audioBuffer.sampleRate === targetRate) return seg.audioBuffer;
        var src = seg.pcm;
        var conv = AudioCore.createSegmentConverter(src, {
          targetRate: targetRate,
          targetChannels: src.channels.length, // 声道不变，单声道由 WebAudio 上混
          fadeMs: 0,
          int16: false
        });
        var buf = ctx.createBuffer(src.channels.length, conv.outFrames, targetRate);
        var views = [];
        for (var c = 0; c < src.channels.length; c++) views.push(buf.getChannelData(c));
        conv.convert(0, conv.outFrames, views);
        return buf;
      }

      segs.forEach(function (seg) {
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
        t += dur + gapSec;
      });
      var endTime = t;

      rec.start(1000);
      var timer = setInterval(function () {
        var p = Math.min(1, Math.max(0, (ctx.currentTime - t0) / Math.max(0.001, endTime - t0)));
        onProgress(p);
        if (p >= 1) {
          clearInterval(timer);
          if (rec.state !== 'inactive') rec.stop();
        }
      }, 250);

      rec.onstop = function () {
        clearInterval(timer);
        state.m4aRecorder = null;
        sources.forEach(function (s) { try { s.stop(); } catch (e) { /* 忽略 */ } });
        if (token !== state.mergeToken) {
          reject(canceledError());
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
        await ensureAllDecoded();
        if (token !== state.mergeToken) throw canceledError();
        if (decodingCount() > 0 || segs.some(function (s) { return s.failed; })) {
          throw new Error('请先等待所有片段解码完成（或移除失败的片段）');
        }
      }

      if (state.format === 'm4a') {
        // M4A：AudioBuffer 顺序调度 + MediaRecorder 实时捕获
        setStatus('M4A 实时编码中：耗时与音频等长，请保持页面在前台…');
        await getCtx();
        await nextFrame();
        var mTarget = AudioCore.pickTargetRate(segs.map(function (s) { return s.pcm.sampleRate; }));
        var mGap = parseFloat($('gapRange').value) || 0;
        var mGain = 1;
        if ($('normalizeChk').checked) {
          var mPeak = 0;
          segs.forEach(function (s) {
            mPeak = Math.max(mPeak, AudioCore.segmentPeakAfterFade(s.pcm, mTarget, 2, 8));
          });
          if (mPeak > 0 && isFinite(mPeak)) mGain = Math.min(0.89 / mPeak, 8);
        }
        var r = await encodeM4AScheduled(segs, mTarget, mGap, mGain, 0.008, token, function (p) {
          setProgress(p, 'M4A 实时编码中');
        });
        if (token !== state.mergeToken) throw canceledError();
        var mDur = segs.reduce(function (a, s) { return a + (s.duration || 0); }, 0) +
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
      if (!sink && est.total > 1200 * 1024 * 1024) {
        // 无流式落盘且估算内存危险：明确警告，让用户选择，而不是 silent crash
        var proceed = window.confirm(
          '本次合并预计需要约 ' + fmtSize(est.total) + ' 内存，且当前浏览器不支持流式落盘（OPFS）。' +
          '继续可能因内存不足导致页面重载。\n\n建议：分段合并、改用 MP3 输出，或换用支持 OPFS 的浏览器（Chrome/Edge）。\n\n仍要继续吗？'
        );
        if (!proceed) {
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

  function finishResult(blob, ext, mime, meta) {
    if (state.mergedUrl) URL.revokeObjectURL(state.mergedUrl);
    state.mergedBlob = blob;
    state.mergedUrl = URL.createObjectURL(blob);
    state.mergedExt = ext;
    $('resultAudio').src = state.mergedUrl;
    $('resultMeta').textContent = ext.toUpperCase() +
      (meta.bitrate ? ' · ' + meta.bitrate + ' kbps' : '') +
      ' · ' + Math.round(meta.sampleRate / 1000) + 'kHz' +
      ' · 时长 ' + fmtTime(meta.durationSec) +
      ' · 大小 ' + fmtSize(blob.size);
    $('resultBox').hidden = false;
    setStatus('合并完成，可试听、分享或下载');
  }

  async function shareOrDownload() {
    if (!state.mergedUrl) return;
    var ext = state.mergedExt || 'wav';
    var mime = (state.mergedBlob && state.mergedBlob.type) || 'audio/wav';
    var filename = 'merged-' + nowStamp() + '.' + ext;

    // 优先走系统分享（Android Chrome / iOS 15+ Safari 支持分享文件）
    try {
      var resp = await fetch(state.mergedUrl);
      var blob = await resp.blob();
      var file = new File([blob], filename, { type: mime });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: '合并录音' });
        return;
      }
    } catch (e) {
      if (e && e.name === 'AbortError') return; // 用户取消分享
      // 分享不可用则继续走下载/打开
    }

    // iOS Safari 对 blob URL 的 download 属性支持不可靠，改为新窗口打开，
    // 由系统播放器接管（用户可用其分享/存储功能）
    var isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (isIOS) {
      window.open(state.mergedUrl, '_blank');
      setStatus('已在新窗口打开，可通过系统播放器分享或存储');
      return;
    }

    var a = document.createElement('a');
    a.href = state.mergedUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setStatus('已触发下载：' + filename);
  }

  /* ---------------- 事件绑定 ---------------- */
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
    $('btnCancel').addEventListener('click', cancelMerge);

    $('btnMerge').addEventListener('click', function () {
      if (state.busy) {
        cancelMerge();
        return;
      }
      doMerge();
    });

    $('btnClear').addEventListener('click', function () {
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
      else if (act === 'up') moveSegment(id, -1);
      else if (act === 'down') moveSegment(id, 1);
      else if (act === 'del') removeSegment(id);
    });

    $('formatGroup').addEventListener('click', function (e) {
      var btn = e.target.closest('.seg-btn');
      if (btn && !btn.disabled) setFormat(btn.dataset.fmt);
    });

    $('bitrateSel').addEventListener('change', function () {
      state.bitrate = parseInt(this.value, 10) || 128;
      updateSizeEstimate();
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
      setFormat('wav');
      renderList();
      setStatus('就绪：导入 mp3 / m4a / wav 等音频，或直接录音，然后点击底部「合并」');

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
