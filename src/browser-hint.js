/**
 * browser-hint.js — 微信 / QQ 内置浏览器引导（纯 ES5，请勿使用 ES6+ 语法）
 *
 * 为什么需要：微信、企业微信与 QQ 的聊天窗口内打开网页时，用的是应用自带的
 * WebView。它会限制文件选取、录音与本地解码，部分安卓机型内核版本也很旧。
 * 网页无法从这类 WebView 里可靠地唤起系统浏览器（iOS 完全不允许，安卓的
 * intent 链接会被拦截），因此只做「说明原因 + 给出可操作步骤 + 复制链接」，
 * 不劫持页面、不阻断使用。
 *
 * 设计约束：
 *  - 与 boot-guard.js 一样必须是纯 ES5：越旧的内核越需要看到这条提示。
 *  - 由 tools/build.js 内联进四个页面，因此不能含会提前闭合标签的序列；
 *    样式也由本文件运行时注入，四个页面共用一份，不必各维护一套。
 *  - 样式使用页面已定义的语义变量（styles.css / doc.css）并提供字面值兜底，
 *    明暗两套都可读；不支持 var() 的旧内核仍能读到第一层字面值。
 *  - 非模态横幅，占文档流顶部，不遮挡内容；关闭状态记在 sessionStorage，
 *    本次会话不再打扰，重新打开链接仍会提示。
 *
 * 预览：在任意浏览器加 ?amlhint=1 可强制显示，便于核对排版。
 */
(function () {
  'use strict';

  var STORE_KEY = 'amlBrowserHintDismissed';
  var ua = navigator.userAgent || '';
  var search = window.location.search || '';

  var force = /(?:^|[?&])amlhint=1(?:&|$)/.test(search);

  // 微信（含 Windows/Mac 客户端）、企业微信、QQ 聊天窗口内置 WebView。
  var inWeChat = /MicroMessenger/i.test(ua);
  var inWeCom = /wxwork/i.test(ua);
  var inQQ = /(?:^|\s)QQ\/[0-9.]+/i.test(ua) || /V1_AND_SQ_|V1_IPH_SQ_/i.test(ua);
  // QQ 浏览器、MQQBrowser 是独立浏览器，不在提示范围内。
  if (/MQQBrowser|QQBrowser/i.test(ua)) inQQ = false;

  if (!force && !(inWeChat || inWeCom || inQQ)) return;

  var dismissed = false;
  if (!force) {
    try {
      dismissed = window.sessionStorage && window.sessionStorage.getItem(STORE_KEY) === '1';
    } catch (e) { /* 隐私模式或 WebView 禁用存储时忽略 */ }
  }
  if (dismissed) return;

  var mobile = /Android|iPhone|iPad|iPod|Windows Phone|Mobile/i.test(ua);

  var lines = [
    '当前页面在微信或 QQ 的内置浏览器中打开。文件选取、录音与音频解码可能受限制，部分功能无法使用。',
    mobile
      ? '请使用手机自带浏览器打开本页：点按右上角菜单，选取「在浏览器中打开」，或复制本页链接后粘贴到地址栏。也可使用 Microsoft Edge 或 Google Chrome，如需安装请前往手机自带应用商店下载。'
      : '请使用系统浏览器打开本页：点按右上角菜单，选取「在浏览器中打开」，或复制本页链接后粘贴到地址栏。也可使用 Microsoft Edge 或 Google Chrome，如需安装请前往官方渠道下载。'
  ];

  function node(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== null && text !== undefined) n.appendChild(document.createTextNode(text));
    return n;
  }

  function injectStyle() {
    var head = document.getElementsByTagName('head')[0];
    if (!head) return;
    var css = [
      '.aml-hint{box-sizing:border-box;width:100%;padding:12px 16px 8px;',
      'background:#ffffff;background:var(--card,#ffffff);',
      'color:#000000;color:var(--label,#000000);',
      'border-bottom:1px solid rgba(60,60,67,.12);',
      'border-bottom:1px solid var(--separator,rgba(60,60,67,.12));',
      'font:14px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",Arial,sans-serif;',
      'font-family:var(--font,-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",Arial,sans-serif);}',
      '.aml-hint *{box-sizing:border-box;}',
      '.aml-hint-inner{max-width:688px;margin:0 auto;}',
      '.aml-hint-title{font-size:16px;font-weight:600;line-height:1.4;margin:0 0 6px;}',
      '.aml-hint p{margin:0 0 6px;font-size:14px;line-height:1.55;',
      'color:rgba(60,60,67,.72);color:var(--label-2,rgba(60,60,67,.72));}',
      '.aml-hint-actions{margin-top:6px;}',
      '.aml-hint-btn{display:inline-block;min-height:44px;line-height:44px;',
      'padding:0 16px;margin:0 8px 8px 0;border:0;',
      'border-radius:10px;border-radius:var(--r-control,10px);',
      'background:rgba(120,120,128,.12);background:var(--fill,rgba(120,120,128,.12));',
      'color:#007aff;color:var(--tint,#007aff);',
      'font-family:inherit;font-size:15px;font-weight:600;',
      'text-align:center;cursor:pointer;-webkit-appearance:none;}',
      '.aml-hint-btn:active{opacity:.65;}',
      '.aml-hint-btn-quiet{color:rgba(60,60,67,.72);color:var(--label-2,rgba(60,60,67,.72));}',
      '.aml-hint-url{display:block;width:100%;margin:0 0 8px;padding:9px 10px;',
      'border:1px solid rgba(60,60,67,.12);border:1px solid var(--separator,rgba(60,60,67,.12));',
      'border-radius:8px;background:#f2f2f7;background:var(--bg,#f2f2f7);',
      'color:#000000;color:var(--label,#000000);font-family:inherit;font-size:13px;line-height:1.4;}',
      '@media (prefers-color-scheme: dark){',
      '.aml-hint{background:#1c1c1e;background:var(--card,#1c1c1e);',
      'color:#ffffff;color:var(--label,#ffffff);',
      'border-bottom-color:rgba(84,84,88,.60);',
      'border-bottom-color:var(--separator,rgba(84,84,88,.60));}',
      '.aml-hint p,.aml-hint-btn-quiet{',
      'color:rgba(235,235,245,.70);color:var(--label-2,rgba(235,235,245,.70));}',
      '.aml-hint-btn{background:rgba(118,118,128,.24);',
      'background:var(--fill,rgba(118,118,128,.24));',
      'color:#0a84ff;color:var(--tint,#0a84ff);}',
      '.aml-hint-url{background:#000000;background:var(--bg,#000000);',
      'color:#ffffff;color:var(--label,#ffffff);',
      'border-color:rgba(84,84,88,.60);',
      'border-color:var(--separator,rgba(84,84,88,.60));}}',
      '@media (max-width:400px){.aml-hint{padding:10px 12px 6px;}',
      '.aml-hint p{font-size:13px;}',
      '.aml-hint-btn{font-size:14px;padding:0 12px;}}'
    ].join('');
    var style = document.createElement('style');
    if (style.styleSheet) {
      style.styleSheet.cssText = css;
    } else {
      style.appendChild(document.createTextNode(css));
    }
    head.appendChild(style);
  }

  /** 复制的链接要去掉预览参数，避免用户在系统浏览器里又看到同一条提示 */
  function pageUrl() {
    var parts = window.location.href.split('#')[0].split('?');
    if (parts.length < 2) return parts[0];
    var kept = [];
    var pairs = parts.slice(1).join('?').split('&');
    for (var i = 0; i < pairs.length; i++) {
      if (pairs[i] && !/^amlhint=1$/.test(pairs[i])) kept.push(pairs[i]);
    }
    return kept.length ? parts[0] + '?' + kept.join('&') : parts[0];
  }

  /** execCommand 兜底：微信内置浏览器里 Clipboard API 常不可用 */
  function legacyCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', 'readonly');
    ta.style.position = 'fixed';
    ta.style.top = '0';
    ta.style.left = '-9999px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    var ok = false;
    try {
      // iOS 需要可编辑元素才能选中；只读取值不会产生输入
      ta.contentEditable = 'true';
      ta.readOnly = false;
      ta.focus();
      ta.select();
      ta.setSelectionRange(0, text.length);
      ok = document.execCommand('copy');
    } catch (e) { ok = false; }
    try { document.body.removeChild(ta); } catch (e2) { /* 忽略 */ }
    return !!ok;
  }

  function showUrl(actions, url) {
    if (document.getElementById('amlHintUrl')) return;
    var input = document.createElement('input');
    input.id = 'amlHintUrl';
    input.className = 'aml-hint-url';
    input.type = 'text';
    input.setAttribute('readonly', 'readonly');
    input.value = url;
    actions.insertBefore(input, actions.firstChild);
    try { input.focus(); input.select(); } catch (e) { /* 忽略 */ }
  }

  function copy(btn, actions) {
    var url = pageUrl();
    var done = function (ok) {
      btn.textContent = ok ? '已复制链接' : '请长按上方地址复制';
      if (!ok) showUrl(actions, url);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      var p = null;
      try { p = navigator.clipboard.writeText(url); } catch (e) { p = null; }
      if (p && p.then) {
        p.then(function () { done(true); }, function () { done(legacyCopy(url)); });
        return;
      }
    }
    done(legacyCopy(url));
  }

  function build() {
    var box = node('div', 'aml-hint');
    box.id = 'amlBrowserHint';
    box.setAttribute('role', 'status');
    var inner = node('div', 'aml-hint-inner');
    inner.appendChild(node('div', 'aml-hint-title', '请在浏览器中打开'));
    for (var i = 0; i < lines.length; i++) inner.appendChild(node('p', '', lines[i]));
    var actions = node('div', 'aml-hint-actions');

    var copyBtn = node('button', 'aml-hint-btn', '复制页面链接');
    copyBtn.type = 'button';
    copyBtn.onclick = function () { copy(copyBtn, actions); };
    actions.appendChild(copyBtn);

    var closeBtn = node('button', 'aml-hint-btn aml-hint-btn-quiet', '仍在此页使用');
    closeBtn.type = 'button';
    closeBtn.onclick = function () {
      if (!force) {
        try { window.sessionStorage.setItem(STORE_KEY, '1'); } catch (e) { /* 忽略 */ }
      }
      if (box.parentNode) box.parentNode.removeChild(box);
    };
    actions.appendChild(closeBtn);

    inner.appendChild(actions);
    box.appendChild(inner);
    return box;
  }

  function mount() {
    if (!document.body) { setTimeout(mount, 30); return; }
    if (document.getElementById('amlBrowserHint')) return;
    injectStyle();
    document.body.insertBefore(build(), document.body.firstChild);
  }
  mount();
})();
