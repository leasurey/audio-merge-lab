'use strict';
/**
 * github-create-repo.js — 维护者工具：用本机 Edge 中已登录的 GitHub 会话，
 * 通过网页 UI 创建仓库（网页表单走同源会话，不涉及 API cookie 问题）。
 *
 * 选择器依据 2026-10 实际页面结构（github.com/new）：
 *   仓库名  #repository-name-input
 *   描述    input[name="Description"]
 *   可见性  #visibility-anchor-button（按钮文字即当前值，默认 Public）
 *   提交    button[type="submit"]:has-text("Create repository")
 *
 * 内置诊断：监听 /repositories 请求的响应与失败事件，提交失败时 dump
 * 页面错误提示，并用 JS 级 requestSubmit 兜底（绕过遮罩层拦截）。
 *
 * 前置：profile 目录中已登录 GitHub（GH_PUSH_PROFILE 指定）。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright-core');

const REPO_NAME = 'audio-merge-lab';
const REPO_DESC = '跨平台录音合并工具（iOS / Android / Web）：导入或录音频，本地合并为 WAV / MP3 / M4A。纯前端实现，数据不离开设备。';

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function launchEdge(userDataDir) {
  const opts = {
    headless: false,
    viewport: { width: 1280, height: 900 },
    args: ['--no-first-run', '--no-default-browser-check', '--disable-sync']
  };
  try {
    return await chromium.launchPersistentContext(userDataDir, Object.assign({}, opts, { channel: 'msedge' }));
  } catch (e) {
    console.log('channel 启动失败，改用 executablePath: ' + String(e.message).slice(0, 150));
    return await chromium.launchPersistentContext(userDataDir, Object.assign({}, opts, {
      executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
    }));
  }
}

async function dumpDiagnostics(page, tag) {
  const url = page.url();
  const alerts = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('[role="alert"], .flash, .flash-error, .flash-warn, .error, [class*="error"]').forEach((el) => {
      const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
      if (t && t.length < 300) out.push(t.slice(0, 200));
    });
    return out.slice(0, 10);
  });
  const nameVal = await page.evaluate(() => {
    const el = document.querySelector('#repository-name-input');
    return el ? el.value : '(输入框已不在)';
  });
  console.log('DIAG[' + tag + '] url=' + url);
  console.log('DIAG[' + tag + '] nameValue=' + JSON.stringify(nameVal));
  if (alerts.length) console.log('DIAG[' + tag + '] alerts=' + JSON.stringify(alerts));
  else console.log('DIAG[' + tag + '] alerts=(无)');
}

async function main() {
  const userDataDir = process.env.GH_PUSH_PROFILE
    ? path.resolve(process.env.GH_PUSH_PROFILE)
    : path.join(os.tmpdir(), 'audio-merge-lab-gh-profile');
  fs.mkdirSync(userDataDir, { recursive: true });
  console.log('PROFILE:' + userDataDir);

  const context = await launchEdge(userDataDir);
  const page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();

  // 网络诊断：抓表单 POST 的响应与失败
  page.on('response', async (res) => {
    const u = res.url();
    if (u.indexOf('/repositories') !== -1 && res.request().method() === 'POST') {
      let snippet = '';
      try { snippet = (await res.text()).replace(/\s+/g, ' ').slice(0, 300); } catch (e) { /* 忽略 */ }
      console.log('NET POST ' + u + ' -> ' + res.status() + ' | ' + snippet);
    }
  });
  page.on('requestfailed', (req) => {
    if (req.url().indexOf('/repositories') !== -1) {
      console.log('NET FAILED ' + req.method() + ' ' + req.url() + ' | ' + (req.failure() || {}).errorText);
    }
  });

  await page.goto('https://github.com/new', { waitUntil: 'domcontentloaded' });
  await sleep(3000);

  const login = await page.evaluate(() => {
    const m = document.querySelector('meta[name="user-login"]');
    return m && m.content ? m.content : '';
  });
  console.log('LOGGED_IN:' + (login || '(未登录)'));
  if (!login) {
    console.error('ABORT: 未登录，请先在 Edge 中登录 GitHub');
    await context.close();
    process.exit(1);
  }

  await page.waitForSelector('#repository-name-input', { timeout: 20000 });
  await page.fill('#repository-name-input', REPO_NAME);
  await sleep(300);

  const desc = page.locator('input[name="Description"]');
  if (await desc.count()) {
    await desc.fill(REPO_DESC);
    console.log('FILLED: name + description');
  } else {
    console.log('FILLED: name（描述框未找到，跳过）');
  }

  const visBtn = page.locator('#visibility-anchor-button');
  if (await visBtn.count()) {
    const visText = (await visBtn.innerText()).trim();
    console.log('VISIBILITY_CURRENT:' + visText);
  }

  const target = new RegExp('github.com/' + login + '/' + REPO_NAME + '(/|\\?|$)');

  // 方式一：普通点击
  const submit = page.locator('button[type="submit"]:has-text("Create repository")').first();
  if (!(await submit.count())) {
    console.error('ABORT: 未找到创建按钮');
    await context.close();
    process.exit(1);
  }
  await submit.click();
  console.log('CLICKED: Create repository');
  try {
    await page.waitForURL(target, { timeout: 8000 });
    console.log('REPO_URL:' + page.url());
    console.log('DONE');
    await context.close();
    return;
  } catch (e) { /* 继续诊断 */ }

  await sleep(1500);
  await dumpDiagnostics(page, 'after-click');

  // 方式二：JS 级提交（绕过遮罩层/命中测试问题）
  console.log('RETRY: JS requestSubmit');
  const jsResult = await page.evaluate(() => {
    const btn = document.querySelector('button[type="submit"]');
    if (!btn) return 'no-button';
    const form = btn.closest('form');
    if (!form) return 'no-form';
    if (typeof form.requestSubmit === 'function') { form.requestSubmit(); return 'requestSubmit'; }
    form.submit();
    return 'submit';
  });
  console.log('JS_SUBMIT:' + jsResult);
  try {
    await page.waitForURL(target, { timeout: 10000 });
    console.log('REPO_URL:' + page.url());
    console.log('DONE');
    await context.close();
    return;
  } catch (e) { /* 继续诊断 */ }

  await sleep(1500);
  await dumpDiagnostics(page, 'after-js-submit');

  // 方式三：按钮 DOM 级 click
  console.log('RETRY: DOM click');
  await page.evaluate(() => {
    const btns = document.querySelectorAll('button[type="submit"]');
    for (const b of btns) {
      if ((b.innerText || '').indexOf('Create repository') !== -1) { b.click(); return; }
    }
  });
  try {
    await page.waitForURL(target, { timeout: 10000 });
    console.log('REPO_URL:' + page.url());
    console.log('DONE');
    await context.close();
    return;
  } catch (e) { /* 放弃 */ }

  await dumpDiagnostics(page, 'after-dom-click');
  console.error('ABORT: 三种提交方式均未创建仓库');
  await context.close();
  process.exit(1);
}

main().catch((e) => {
  console.error('FATAL: ' + (e && e.message ? e.message : e));
  process.exit(1);
});
