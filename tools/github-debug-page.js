'use strict';
/**
 * github-debug-page.js — 诊断工具：打开指定页面，dump URL/标题/正文片段/表单元素清单。
 * 用法：node tools/github-debug-page.js https://github.com/new
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright-core');

const URL_ARG = process.argv[2] || 'https://github.com/new';

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  const userDataDir = process.env.GH_PUSH_PROFILE
    ? path.resolve(process.env.GH_PUSH_PROFILE)
    : path.join(os.tmpdir(), 'audio-merge-lab-gh-profile');
  fs.mkdirSync(userDataDir, { recursive: true });
  console.log('PROFILE:' + userDataDir);

  let context;
  try {
    context = await chromium.launchPersistentContext(userDataDir, {
      channel: 'msedge', headless: false,
      viewport: { width: 1280, height: 900 },
      args: ['--no-first-run', '--no-default-browser-check', '--disable-sync']
    });
  } catch (e) {
    context = await chromium.launchPersistentContext(userDataDir, {
      executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      headless: false, viewport: { width: 1280, height: 900 },
      args: ['--no-first-run', '--no-default-browser-check', '--disable-sync']
    });
  }
  const page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();
  await page.goto(URL_ARG, { waitUntil: 'domcontentloaded' });
  await sleep(4000);

  console.log('URL:' + page.url());
  console.log('TITLE:' + await page.title());

  const login = await page.evaluate(() => {
    const m = document.querySelector('meta[name="user-login"]');
    return m && m.content ? m.content : '';
  });
  console.log('LOGGED_IN:' + (login || '(未登录)'));

  const bodyText = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 400));
  console.log('BODY:' + bodyText);

  const inputs = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('input, select, textarea, button').forEach((el) => {
      if (el.offsetParent === null && el.type !== 'hidden') return; // 只看可见的
      out.push({
        tag: el.tagName.toLowerCase(),
        id: el.id || '',
        name: el.name || '',
        type: el.type || '',
        text: (el.innerText || el.value || '').replace(/\s+/g, ' ').slice(0, 40)
      });
    });
    return out.slice(0, 40);
  });
  console.log('ELEMENTS(' + inputs.length + '):');
  inputs.forEach((e) => {
    console.log('  ' + e.tag + ' id=' + (e.id || '-') + ' name=' + (e.name || '-') +
      ' type=' + (e.type || '-') + ' text=' + (e.text || '-'));
  });

  await context.close();
}

main().catch((e) => {
  console.error('FATAL: ' + (e && e.message ? e.message : e));
  process.exit(1);
});
