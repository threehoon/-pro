// 用 Chrome DevTools Protocol 截图，不依赖 Playwright。
// 用法：node scripts/shot.mjs [--width 1440] [--dark] [--base http://127.0.0.1:8787]
import { spawn } from 'node:child_process';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const args = process.argv.slice(2);
const readFlag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
};
const width = Number(readFlag('width', '1440'));
const dark = args.includes('--dark');
const base = readFlag('base', 'http://127.0.0.1:8787');
const outDir = fileURLToPath(new URL('../screenshots/', import.meta.url));
const suffix = `${width}${dark ? '-dark' : ''}`;
const only = readFlag('only', '');
const jobOverride = readFlag('job', '');
const candidateOverride = readFlag('candidate', '');
const namePrefix = readFlag('name', '');

const PORT = 9333;
const profile = join(tmpdir(), `hireloop-shot-${Date.now()}`);
await mkdir(outDir, { recursive: true });

const chrome = spawn(
  CHROME,
  [
    '--headless',
    '--disable-gpu',
    '--no-sandbox',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--hide-scrollbars',
    '--force-color-profile=srgb',
    '--font-render-hinting=none',
    `${base}/`,
  ],
  { stdio: 'ignore' },
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForDevtools() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (response.ok) return (await response.json()).webSocketDebuggerUrl;
    } catch {
      /* not ready */
    }
    await sleep(250);
  }
  throw new Error('Chrome DevTools 未就绪');
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(`${message.error.message} (${message.error.code})`));
        else resolve(message.result);
      }
    });
  }
  send(method, params = {}) {
    this.id += 1;
    const id = this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
}

async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error(`无法连接 ${url}`)), { once: true });
  });
  return new Cdp(ws);
}

const routes = [
  { name: 'dashboard', path: '/', wait: '.kpi' },
  { name: 'jobs', path: '/jobs', wait: '.job-card' },
  { name: 'job-detail', path: null, wait: '.track-card' },
  { name: 'board', path: null, wait: '.board-col' },
  { name: 'candidates', path: '/candidates', wait: '.data-table' },
  { name: 'candidate-detail', path: null, wait: '.profile-head' },
  { name: 'interviews', path: '/interviews', wait: '.week-strip' },
  { name: 'settings', path: '/settings', wait: '.settings-section' },
];

let browser;
try {
  const wsUrl = await waitForDevtools();
  // 连接到已经打开的页面 target，避免 session 转发
  let pageWs = null;
  for (let i = 0; i < 40 && !pageWs; i += 1) {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = list.find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
    if (page) pageWs = page.webSocketDebuggerUrl;
    else await sleep(200);
  }
  if (!pageWs) throw new Error('找不到页面 target');
  browser = await connect(pageWs);

  await browser.send('Page.enable');
  await browser.send('Runtime.enable');
  await browser.send('Emulation.setDeviceMetricsOverride', {
    width,
    height: 900,
    deviceScaleFactor: 2,
    mobile: width < 700,
  });

  if (dark) {
    await browser.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: 'dark' }],
    });
  }

  const evaluate = async (expression) => {
    const result = await browser.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  };

  await sleep(1200);
  const login = await evaluate(`(async () => {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'hr@hireloop.cn', password: '123' }),
      credentials: 'same-origin',
    });
    return res.status;
  })()`);
  if (login !== 200) throw new Error(`登录失败：${login}`);
  if (dark) await evaluate(`localStorage.setItem('hl-theme','dark')`);

  const jobId =
    jobOverride ||
    (await evaluate(`(async () => {
    const res = await fetch('/api/jobs?status=open', { credentials: 'same-origin' });
    const data = await res.json();
    return data.items[0] && data.items[0].id;
  })()`));
  const candidateId = candidateOverride || (await evaluate(`(async () => {
    const res = await fetch('/api/candidates?pageSize=1', { credentials: 'same-origin' });
    const data = await res.json();
    return data.items[0] && data.items[0].id;
  })()`));
  console.log('jobId:', jobId, 'candidateId:', candidateId);

  const resolved = routes.map((route) => {
    if (route.name === 'job-detail') return { ...route, path: `/jobs/${jobId}` };
    if (route.name === 'board') return { ...route, path: `/jobs/${jobId}/board` };
    if (route.name === 'candidate-detail') return { ...route, path: `/candidates/${candidateId}` };
    return route;
  });

  for (const route of resolved) {
    if (only && route.name !== only) continue;
    await browser.send('Page.navigate', { url: `${base}${route.path}` });
    let ready = false;
    for (let i = 0; i < 40; i += 1) {
      await sleep(150);
      const found = await evaluate(`!!document.querySelector(${JSON.stringify(route.wait)})`);
      if (found) {
        ready = true;
        break;
      }
    }
    if (!ready) console.warn(`⚠ ${route.name} 未等到 ${route.wait}`);
    await sleep(700);
    const { data } = await browser.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
    });
    const file = join(outDir, `${namePrefix || route.name}-${suffix}.png`);
    await writeFile(file, Buffer.from(data, 'base64'));
    console.log(`✓ ${route.name} → ${file}`);
  }
} finally {
  try {
    await browser?.send('Browser.close');
  } catch {
    /* ignore */
  }
  chrome.kill('SIGTERM');
  await sleep(300);
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}
