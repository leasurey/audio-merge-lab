/**
 * boot-guard.js — 启动守卫（ES5 专用，切勿使用箭头函数/let/const/模板字符串）
 *
 * 存在的意义：主应用（app.js）使用 async/await（ES2017），在 Chromium < 55
 * 的旧内核里会整块解析失败——连 app.js 里的错误处理都不会执行，用户只看到
 * 白屏。本文件必须用纯 ES5 语法，确保任何能渲染 HTML 的内核都能执行，
 * 从而在"解析失败/初始化异常/超时未就绪"三种情况下给出可读提示与自检入口。
 */
(function () {
  'use strict';

  var booted = false;
  var shown = false;

  /** 主应用初始化成功后调用（同时撤掉可能已显示的提示） */
  window.__AML_BOOTED = function () {
    booted = true;
    try {
      var box = document.getElementById('amlBootError');
      if (box && box.parentNode) box.parentNode.removeChild(box);
    } catch (e) { /* 忽略 */ }
  };

  /** 主应用初始化异常时主动调用 */
  window.__AML_FAIL = function (msg) { show(msg); };

  function buildBanner(msg) {
    var box = document.createElement('div');
    box.id = 'amlBootError';
    box.setAttribute('style',
      'position:relative;z-index:99999;background:#2b1d1d;color:#ffd9d4;' +
      'border-bottom:1px solid #7a3a35;padding:12px 14px;' +
      'font:14px/1.55 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;');

    var p1 = document.createElement('div');
    var b = document.createElement('b');
    b.textContent = '应用没能正常启动';
    p1.appendChild(b);
    p1.appendChild(document.createTextNode('（' + msg + '）。可能是浏览器内核版本过旧。'));
    box.appendChild(p1);

    var p2 = document.createElement('div');
    p2.setAttribute('style', 'margin-top:8px;font-size:13px;');

    var a = document.createElement('a');
    a.href = 'compat.html';
    a.setAttribute('style', 'color:#8ab4ff;margin-right:16px;text-decoration:underline;');
    a.textContent = '① 运行兼容性自检';
    p2.appendChild(a);

    var btn = document.createElement('a');
    btn.href = '#';
    btn.setAttribute('style',
      'color:#8ab4ff;margin-right:16px;text-decoration:underline;cursor:pointer;');
    btn.textContent = '② 重试加载';
    btn.onclick = function (e) {
      if (e && e.preventDefault) e.preventDefault();
      location.reload();
      return false;
    };
    p2.appendChild(btn);

    var tip = document.createElement('span');
    tip.setAttribute('style', 'color:#c9a7a2;font-size:12px;');
    tip.textContent = '仍不行：请用 Chrome / Edge / 夸克等较新浏览器打开';
    p2.appendChild(tip);

    box.appendChild(p2);
    return box;
  }

  function show(msg) {
    if (shown) return;
    shown = true;

    function append() {
      try {
        if (!document.body) { setTimeout(append, 100); return; }
        var old = document.getElementById('amlBootError');
        if (old && old.parentNode) old.parentNode.removeChild(old);
        document.body.insertBefore(buildBanner(msg), document.body.firstChild);
      } catch (e) { /* 尽最大努力，失败就放弃 */ }
    }
    append();
  }

  // 1) 运行时异常（含后续 script 块的解析错误）
  window.onerror = function (message) {
    show(String(message || '脚本执行出错').slice(0, 120));
    return false; // 不吞掉错误，控制台仍可见
  };

  // 2) 超时未就绪：DOM 可用后检查，主应用应在此之前替换为「就绪」状态
  function check() {
    if (booted || shown) return;
    var s = document.getElementById('status');
    if (s && s.textContent && s.textContent.indexOf('就绪') !== -1) { booted = true; return; }
    show('初始化超时或语法不被当前内核支持');
  }

  function schedule() {
    setTimeout(check, 5000);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', schedule);
  } else {
    schedule();
  }
})();
