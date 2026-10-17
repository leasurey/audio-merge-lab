/**
 * app.js — 录音合并器 UI 层（依赖 window.AudioCore 与 window.lamejs）
 *
 * 职责：文件导入 / 录音 / 片段试听与排序 / 合并（WAV·MP3·M4A）/ 导出与分享。
 * 所有音频处理均在本地完成，不上传任何数据。
 */
(function () {
  'use strict';

  /* ---------------- 状态 ---------------- */
  var state = {
    segments: [],     // {id, name, source, blob, url, pcm, duration, sampleRate, channels}
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
    mergedExt: 'wav'
  };

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

  /** AudioBuffer → 内部 PCM 格式（拷贝，避免被 AudioBuffer 回收） */
  function audioBufferToPcm(buf) {
    var channels = [];
    for (var c = 0; c < buf.numberOfChannels; c++) {
      channels.push(new Float32Array(buf.getChannelData(c)));
    }
    return { sampleRate: buf.sampleRate, channels: channels };
  }

  /* ---------------- 片段管理 ---------------- */
  function totalDuration() {
    var sum = 0;
    state.segments.forEach(function (s) { sum += s.duration || 0; });
    return sum;
  }

  function addSegment(seg) {
    state.segments.push(seg);
    renderList();
    setStatus('已添加「' + seg.name + '」（' + fmtTime(seg.duration) + '），当前共 ' +
      state.segments.length + ' 段，合计 ' + fmtTime(totalDuration()));
  }

  async function addFile(file) {
    if (!file) return;
    setStatus('正在读取「' + file.name + '」…');
    try {
      var buf;
      if (typeof file.arrayBuffer === 'function') {
        buf = await file.arrayBuffer();
      } else {
        buf = await new Promise(function (resolve, reject) {
          var fr = new FileReader();
          fr.onload = function () { resolve(fr.result); };
          fr.onerror = function () { reject(new Error('文件读取失败')); };
          fr.readAsArrayBuffer(file);
        });
      }
      await getCtx();
      var audioBuf = await decodeAudioData(buf);
      var pcm = audioBufferToPcm(audioBuf);
      state.seq++;
      addSegment({
        id: 'seg' + state.seq,
        name: file.name,
        source: '导入',
        blob: file, // 保留原始 Blob 供试听
        pcm: pcm,
        duration: audioBuf.duration,
        sampleRate: audioBuf.sampleRate,
        channels: audioBuf.numberOfChannels
      });
    } catch (err) {
      console.error(err);
      setStatus('「' + file.name + '」解码失败：该格式可能不被当前浏览器支持（' +
        (err && err.message ? err.message : err) + '）', true);
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
    if (!seg.blob) {
      setStatus('该片段没有可播放的源数据', true);
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
    // M4A 依赖 MediaRecorder 的 mp4 录制能力（iOS Safari / 较新 Chrome）
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
      hint = 'WAV 无损：约 172 KB/秒（10 MB/分钟），兼容性最好，适合存档。';
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
    var bytes;
    if (state.format === 'wav') bytes = dur * 44100 * 2 * 2;       // 44.1kHz 立体声 16bit
    else if (state.format === 'mp3') bytes = dur * state.bitrate * 1000 / 8;
    else bytes = dur * 128000 / 8;                                  // M4A 按 128kbps 估
    $('sizeEst').textContent = '预计约 ' + fmtSize(bytes) +
      '（当前 ' + state.segments.length + ' 段合计 ' + fmtTime(dur) + '）';
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
    $('actionSummary').textContent =
      state.segments.length + ' 段 · 合计 ' + fmtTime(totalDuration());
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
      var li = el('li', 'seg');
      li.dataset.id = seg.id;
      if (state.playingId === seg.id) li.classList.add('playing');

      li.appendChild(el('span', 'seg-idx', String(i + 1)));

      var play = el('button', 'icon-btn play', state.playingId === seg.id ? '⏸' : '▶');
      play.type = 'button';
      play.title = '试听';
      play.dataset.act = 'play';
      li.appendChild(play);

      var info = el('div', 'seg-info');
      info.appendChild(el('div', 'seg-name', seg.name));
      var meta = seg.source + ' · ' + fmtTime(seg.duration) +
        ' · ' + Math.round(seg.sampleRate / 1000) + 'kHz · ' +
        (seg.channels === 1 ? '单声道' : seg.channels + ' 声道');
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
      setStatus('当前浏览器不支持录音（需要 HTTPS 或 localhost 环境）', true);
      return;
    }
    if (typeof MediaRecorder === 'undefined') {
      setStatus('当前浏览器不支持 MediaRecorder', true);
      return;
    }
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
        ? '麦克风权限被拒绝，请在浏览器设置中允许后重试'
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
    setStatus('录音结束（' + fmtSize(blob.size) + '），正在解码…');
    await addFile(new File([blob], '录音 ' + nowStamp() + '.' + guessExt(blob.type), { type: blob.type }));
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

  async function doMerge() {
    var segs = state.segments;
    if (!segs.length) {
      setStatus('请先导入或录制至少一段音频', true);
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
    setBusy(true);
    setStatus('正在合并 ' + segs.length + ' 段音频（解码已在导入时完成，此处执行拼接与编码）…');
    showProgress(0);

    try {
      await getCtx();
      await nextFrame();
      var pcm = AudioCore.concatSegments(
        segs.map(function (s) { return { name: s.name, pcm: s.pcm }; }),
        {
          targetSampleRate: 44100,
          targetChannels: 2,
          gapSec: parseFloat($('gapRange').value) || 0,
          fadeMs: 8,
          normalize: $('normalizeChk').checked,
          normalizeTarget: 0.89
        }
      );
      if (token !== state.mergeToken) throw canceledError();

      var blob, ext, mime;
      if (state.format === 'wav') {
        setStatus('正在编码 WAV…');
        showProgress(0.1);
        await nextFrame();
        var wav = AudioCore.encodeWav(pcm, 16);
        blob = new Blob([wav], { type: 'audio/wav' });
        ext = 'wav';
        mime = 'audio/wav';
        setProgress(1);
      } else if (state.format === 'mp3') {
        setStatus('正在编码 MP3（' + state.bitrate + ' kbps），可随时取消…');
        var mp3 = await AudioCore.encodeMP3(pcm, {
          lamejs: window.lamejs,
          kbps: state.bitrate,
          blockFrames: 1152 * 50,
          yieldFn: nextFrame,
          onProgress: function (p) { setProgress(p, 'MP3 编码中'); },
          isCanceled: function () { return token !== state.mergeToken; }
        });
        if (token !== state.mergeToken) throw canceledError();
        blob = new Blob([mp3], { type: 'audio/mpeg' });
        ext = 'mp3';
        mime = 'audio/mpeg';
      } else {
        setStatus('M4A 实时编码中：耗时与音频等长，请保持页面在前台…');
        var r = await encodeM4A(pcm, token, function (p) {
          setProgress(p, 'M4A 实时编码中');
        });
        blob = r.blob;
        ext = r.ext;
        mime = r.mime;
      }

      finishResult(blob, ext, mime, pcm);
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

  /**
   * M4A(AAC) 实时编码：把合并后的 PCM 实时播放进 MediaStreamDestination，
   * 由 MediaRecorder 同步录制。耗时与音频时长相等（录制时长 = 播放时长）。
   */
  function encodeM4A(pcm, token, onProgress) {
    return new Promise(function (resolve, reject) {
      var ctx = state.audioCtx;
      var numChannels = pcm.channels.length;
      var len = pcm.channels[0].length;
      var buf = ctx.createBuffer(numChannels, len, pcm.sampleRate);
      for (var c = 0; c < numChannels; c++) buf.copyToChannel(pcm.channels[c], c);

      var src = ctx.createBufferSource();
      src.buffer = buf;
      var dest = ctx.createMediaStreamDestination();
      src.connect(dest); // 只连录制目标，不外放声音

      var mime = pickMimeType() || '';
      var rec;
      try {
        rec = new MediaRecorder(dest.stream, mime ? { mimeType: mime } : undefined);
      } catch (e) {
        reject(e);
        return;
      }
      state.m4aRecorder = rec;
      var chunks = [];
      var timer = null;

      rec.ondataavailable = function (e) {
        if (e.data && e.data.size > 0) chunks.push(e.data);
      };
      rec.onstop = function () {
        if (timer) clearInterval(timer);
        state.m4aRecorder = null;
        try { src.stop(); } catch (e) { /* 忽略 */ }
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

      rec.start(1000);
      var startTime = ctx.currentTime;
      var duration = buf.duration;
      timer = setInterval(function () {
        var p = Math.min(1, (ctx.currentTime - startTime) / duration);
        onProgress(p);
        if (p >= 1) clearInterval(timer);
      }, 250);

      src.onended = function () {
        if (timer) clearInterval(timer);
        onProgress(1);
        if (rec.state !== 'inactive') rec.stop();
      };
      src.start();
    });
  }

  function finishResult(blob, ext, mime, pcm) {
    if (state.mergedUrl) URL.revokeObjectURL(state.mergedUrl);
    state.mergedBlob = blob;
    state.mergedUrl = URL.createObjectURL(blob);
    state.mergedExt = ext;
    $('resultAudio').src = state.mergedUrl;
    var extra = state.format === 'mp3' ? ' · ' + state.bitrate + ' kbps' : '';
    $('resultMeta').textContent = ext.toUpperCase() + extra +
      ' · 时长 ' + fmtTime(AudioCore.pcmDurationSec(pcm)) +
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
  function bind() {
    $('btnImport').addEventListener('click', function () {
      $('fileInput').click();
    });

    $('fileInput').addEventListener('change', function (e) {
      var files = Array.prototype.slice.call(e.target.files || []);
      e.target.value = ''; // 允许重复选择同一文件
      files.forEach(function (f) { addFile(f); });
    });

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
    bind();
    detectFormats();
    setFormat('wav');
    renderList();
    setStatus('就绪：导入 mp3 / m4a / wav 等音频，或直接录音，然后点击底部「合并」');

    // 页脚版本号：取核心层的单一权威值
    $('appFooter').textContent = 'Audio Merge Lab v' + AudioCore.APP_VERSION +
      ' · 纯前端实现 · 数据不离开你的设备';

    // PWA 离线缓存：仅在真实 http(s) 部署时注册（跳过 localhost 与 Capacitor 壳，
    // 避免 Capacitor 本地资源服务器被缓存导致更新后拿到旧文件）
    var isLocal = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
    if ('serviceWorker' in navigator && location.protocol.indexOf('http') === 0 && !isLocal) {
      navigator.serviceWorker.register('sw.js').catch(function () {
        /* 注册失败不影响使用 */
      });
    }
  });
})();
