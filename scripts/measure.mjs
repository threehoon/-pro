// 量测脚本：在指定宽度下检查横向溢出、关键元素尺寸。
// 用法：node scripts/measure.mjs --width 390 [--width 768 ...]
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const args = process.argv.slice(2);
const baseIndex = args.indexOf('--base');
const base = baseIndex >= 0 ? args[baseIndex + 1] : 'http://127.0.0.1:8787';
const widths = [];
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--width') widths.push(Number(args[i + 1]));
}
if (widths.length === 0) widths.push(390, 768);
const PORT = 9351;
const profile = await mkdtemp(join(tmpdir(), 'hireloop-measure-'));

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
    `${base}/`,
  ],
  { stdio: 'ignore' },
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function pageTarget() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const targets = await response.json();
      const page = targets.find((item) => item.type === 'page');
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      /* not ready */
    }
    await sleep(250);
  }
  throw new Error('Chrome DevTools 未就绪');
}

const ws = new WebSocket(await pageTarget());
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = () => reject(new Error('CDP 连接失败'));
});
const pending = new Map();
let nextId = 1;
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  const entry = pending.get(message.id);
  if (!entry) return;
  pending.delete(message.id);
  if (message.error) entry.reject(new Error(message.error.message));
  else entry.resolve(message.result);
};
function send(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  }
  return result.result.value;
}

await send('Runtime.enable');
await send('Page.enable');
await send('Page.navigate', { url: `${base}/` });
await sleep(900);
await evaluate(`(async () => {
  await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'hr@hireloop.cn', password: '123' }),
  });
  return true;
})()`);

const routes = ['/', '/jobs', '/candidates', '/interviews', '/settings'];
const ids = await evaluate(`(async () => {
  const jobs = await (await fetch('/api/jobs')).json();
  const candidates = await (await fetch('/api/candidates?pageSize=1')).json();
  return {
    job: jobs.items?.find((item) => item.title === '高级前端工程师')?.id ?? jobs.items?.[0]?.id,
    candidate: candidates.items?.[0]?.id,
  };
})()`);

let failures = 0;
for (const width of widths) {
  await send('Emulation.setDeviceMetricsOverride', {
    width,
    height: 900,
    deviceScaleFactor: 1,
    mobile: width < 720,
  });
  for (const route of [...routes, `/jobs/${ids.job}/board`, `/jobs/${ids.job}`, `/candidates/${ids.candidate}`]) {
    await send('Page.navigate', { url: `${base}${route}` });
    await sleep(1100);
    const metrics = await evaluate(`(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      pageTitle: document.querySelector('h1')?.textContent ?? '',
      hasMenu: !!document.querySelector('.menu-btn'),
      sidebarVisible: (() => {
        const el = document.querySelector('.sidebar');
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        return rect.left >= 0 && rect.width > 1;
      })(),
    }))()`);
    const overflow = metrics.scrollWidth - metrics.clientWidth;
    const ok = overflow <= 1 && metrics.pageTitle !== '';
    if (!ok) failures += 1;
    console.log(
      `${ok ? '✓' : '✗'} ${width}px ${route} — scrollWidth ${metrics.scrollWidth}/${metrics.clientWidth}` +
        `, 侧栏${metrics.sidebarVisible ? '可见' : '收起'}, 菜单按钮${metrics.hasMenu ? '有' : '无'}`,
    );
  }
}

console.log(failures === 0 ? '\n全部宽度无横向溢出' : `\n${failures} 个页面存在横向溢出`);
ws.close();
chrome.kill();
await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
if (failures > 0) process.exitCode = 1;
