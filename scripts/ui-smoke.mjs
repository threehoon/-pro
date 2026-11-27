import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';

// 默认自带一套隔离数据（临时目录 + 自有端口），跑完即删，不污染演示库。
// 想在已有服务上跑：SMOKE_BASE=http://127.0.0.1:8787 npm run smoke
const EXTERNAL = Boolean(process.env.SMOKE_BASE);
const screenshotDir = process.env.HIRELOOP_SMOKE_SHOTS;
let dataDir = null;
let server = null;
let proc;
let profile;
let ws;
let BASE = process.env.SMOKE_BASE ?? '';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
if (!EXTERNAL) {
  // 端口交给系统分配，避免和本机其它进程抢端口
  const APP_PORT = await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(String(port)));
    });
  });
  BASE = `http://127.0.0.1:${APP_PORT}`;
  dataDir = await mkdtemp(join(tmpdir(), 'hireloop-smoke-'));
  const env = { ...process.env, HIRELOOP_DATA_DIR: dataDir, HIRELOOP_DB_PATH: join(dataDir, 'app.db'), LLM_API_KEY: '', PORT: APP_PORT, NODE_ENV: 'production' };
  const seed = spawnSync('node', ['server/src/db/seed.ts'], { env, stdio: 'inherit' });
  if (seed.status !== 0) throw new Error('隔离数据初始化失败');
  const fixtureDb = new DatabaseSync(env.HIRELOOP_DB_PATH);
  try {
    const insert = fixtureDb.prepare(`INSERT INTO notifications
      (id, event_key, type, channel, status, title, payload, created_at)
      VALUES (?, ?, 'interview.scheduled', 'feishu', 'pending', ?, ?, '2090-01-01T00:00:00.000Z')`);
    for (let i = 0; i < 10; i++) {
      const key = `smoke-outbox-${i}`;
      insert.run(key, key, `筛选样本 ${i}`, JSON.stringify({ interviewerName: i === 0 ? '早期记录面试官' : '样本面试官' }));
    }
  } finally {
    fixtureDb.close();
  }
  server = spawn('node', ['server/src/index.ts'], { env, stdio: 'ignore' });
  let up = false;
  for (let i = 0; i < 80; i += 1) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) { up = true; break; }
    } catch {}
    await sleep(250);
  }
  if (!up) throw new Error(`隔离的冒烟服务没能在 ${BASE} 启动`);
  console.log(`使用隔离数据目录运行冒烟：${dataDir}`);
}

const CHROME = process.env.HIRELOOP_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
profile = await mkdtemp(join(tmpdir(), 'hireloop-ui-profile-'));
const PORT = await new Promise((resolve, reject) => {
  const probe = createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});
proc = spawn(CHROME, ['--headless', '--disable-gpu', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', `${BASE}/`], { stdio: ['ignore', 'ignore', 'pipe'] });
let chromeError;
let chromeStderr = '';
proc.on('error', (error) => { chromeError = error; });
proc.stderr.on('data', (chunk) => { chromeStderr = (chromeStderr + chunk).slice(-1600); });
let list = [];
for (let i = 0; i < 60; i++) {
  if (chromeError || proc.exitCode !== null || proc.signalCode !== null) break;
  try { const r = await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(500) }); if (r.ok) { list = await r.json(); if (list.some((t) => t.type === 'page' && t.url.includes(new URL(BASE).host))) break; } } catch {}
  await sleep(250);
}
const page = list.find((t) => t.type === 'page' && t.url.includes(new URL(BASE).host));
if (!page) throw new Error('Chrome 没有打开测试工作台：' + (chromeError?.message ?? (chromeStderr || `exit=${proc.exitCode}, signal=${proc.signalCode}`)));
console.log('Chrome 调试目标已连接到隔离网址');
ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
const logs = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Runtime.exceptionThrown') logs.push('EXC ' + JSON.stringify(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text).slice(0, 300));
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') logs.push('CONSOLE ' + m.params.args.map((a) => a.value ?? a.description).join(' ').slice(0, 300));
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const i = ++id;
  const deadline = setTimeout(() => {
    pending.delete(i);
    reject(new Error(`Chrome DevTools 超时：${method}`));
  }, 5000);
  pending.set(i, ({ result, error }) => {
    clearTimeout(deadline);
    if (error) reject(new Error(`${method}：${error.message}`));
    else resolve(result);
  });
  ws.send(JSON.stringify({ id: i, method, params }));
});
await Promise.race([
  new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('Chrome DevTools 连接失败')), { once: true });
  }),
  sleep(5000).then(() => { throw new Error('Chrome DevTools 连接超时'); }),
]);
await send('Runtime.enable');
await send('DOM.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

const ev = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result?.value;
};
const waitFor = async (expr, label, tries = 60) => {
  for (let i = 0; i < tries; i++) { if (await ev(expr)) return true; await sleep(150); }
  const detail = await ev(`([...document.querySelectorAll('[role=dialog] h2, [role=alert], .modal .form-error')].map(el => el.textContent.trim()).filter(Boolean).join(' · '))`);
  throw new Error(`timeout waiting for ${label}${detail ? ` (${detail})` : ''}`);
};
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`); };
const capture = async (label, width, selector) => {
  await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
  await waitFor(`innerWidth === ${width} && Boolean(document.querySelector(${JSON.stringify(selector)}))`, label);
  const fits = await ev(`document.documentElement.scrollWidth <= innerWidth`);
  check(`${label} ${width}px 页面无横向溢出`, fits);
  if (screenshotDir) {
    if (selector === '#screening') await ev(`document.getElementById('screening').scrollIntoView({ block: 'start' })`);
    await sleep(250);
    await mkdir(screenshotDir, { recursive: true });
    const fullPage = label.startsWith('job-profile');
    const { data } = await send('Page.captureScreenshot', fullPage ? { format: 'png', captureBeyondViewport: true } : { format: 'png' });
    await writeFile(join(screenshotDir, `${label}-${width}.png`), Buffer.from(data, 'base64'));
  }
};

await send('Page.navigate', { url: `${BASE}/` });
await sleep(800);
await waitFor(`document.readyState === 'complete' && location.origin === ${JSON.stringify(new URL(BASE).origin)}`, 'origin ready');
await ev(`fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'hr@hireloop.cn',password:'123'}),credentials:'same-origin'})`);

// 工作台今日行动默认折叠，按需打开，收起后跳过隐藏链接。
await send('Page.navigate', { url: `${BASE}/` });
const today = `document.querySelector('.today-queue')`;
const todaySummary = `${today}.querySelector('summary')`;
const todayCollapsed = `!${today}.open && ${today}.offsetHeight <= ${todaySummary}.offsetHeight + 2`;
await waitFor(`${today}?.querySelector('.today-queue-indicator')?.textContent.includes('项')`, '今日行动数量');
check('今日行动默认折叠且数量可见', await ev(`${todayCollapsed} && ${todaySummary}.offsetHeight >= 48`));
await capture('today-collapsed', 1440, '.today-queue');
await ev(`${todaySummary}.focus()`);
await send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'Space', key: ' ', windowsVirtualKeyCode: 32 });
await send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'Space', key: ' ', windowsVirtualKeyCode: 32 });
await waitFor(`${today}.open`, '空格展开今日行动');
check('键盘展开后显示原待办链接', await ev(`Array.from(${today}.querySelectorAll('li a')).some(link => link.offsetHeight > 0 && link.pathname.startsWith('/candidates/'))`));
await capture('today-expanded', 390, '.today-queue');
const todayTitlePoint = await ev(`(() => {
  ${todaySummary}.scrollIntoView({ block: 'center' });
  const { x, y, width, height } = ${todaySummary}.querySelector('h2').getBoundingClientRect();
  return { x: Math.round(x + Math.min(40, width / 2)), y: Math.round(y + height / 2) };
})()`);
await sleep(200);
check('今日行动标题在可点击范围内', todayTitlePoint.y > 0 && todayTitlePoint.y < 860, JSON.stringify(todayTitlePoint));
await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...todayTitlePoint });
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...todayTitlePoint });
await waitFor(`Boolean(${today}) && !${today}.open`, '点击标题收起今日行动');
check('点击标题可再次收起今日行动', await ev(todayCollapsed));
await capture('today-collapsed', 390, '.today-queue');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

// 1. 新建职位（UI 表单）
await send('Page.navigate', { url: `${BASE}/jobs` });
await waitFor(`!!document.querySelector('.job-card')`, 'jobs list');
await ev(`[...document.querySelectorAll('button')].find((b) => b.textContent.includes('新建职位')).click()`);
await waitFor(`!!document.querySelector('.modal input')`, 'job modal');
const jobTitle = '冒烟测试职位 ' + Date.now().toString().slice(-5);
await ev(`(() => {
  const set = (label, value) => {
    const field = [...document.querySelectorAll('.modal .field')].find((f) => (f.querySelector('label')?.textContent ?? '').includes(label));
    const input = field?.querySelector('input, textarea, select');
    if (!input) throw new Error('field not found: ' + label);
    const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
      : input instanceof HTMLSelectElement ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };
  set('职位名称', ${JSON.stringify(jobTitle)});
  set('部门', '质量保障');
  set('工作城市', '上海');
  set('招聘人数', '1');
  set('职位描述', '负责招聘平台的质量保障与端到端回归。');
  return true;
})()`);
await sleep(200);
await ev(`[...document.querySelectorAll('.modal button')].find((b) => b.textContent.trim() === '创建职位' || b.textContent.includes('创建')).click()`);
await waitFor(`document.body.textContent.includes(${JSON.stringify(jobTitle)})`, 'new job card');
check('新建职位（UI 表单）', true, jobTitle);

// 2. 检查看板并通过候选人详情投递
const jobId = await ev(`fetch('/api/jobs?q=' + encodeURIComponent(${JSON.stringify(jobTitle)}), { credentials: 'same-origin' }).then(r => r.json()).then(d => d.items[0]?.id)`);
check('职位可被搜索到', Boolean(jobId), jobId ?? '');
const screeningEntry = `a[href="/jobs/${jobId}/screening"]`;
await send('Page.navigate', { url: `${BASE}/jobs/${jobId}` });
await waitFor(`location.pathname === '/jobs/${jobId}/overview'`, '职位旧地址进入概览');
check('职位入口默认落在概览', await ev(`Boolean(document.querySelector('.overview-next'))`));
const jobTabs = await ev(`[...document.querySelectorAll('.subtabs .subtab')].map((a) => a.getAttribute('href'))`);
check('职位内六个子模块可切换', jobTabs.length === 6 && jobTabs.every((href) => href && href.startsWith(`/jobs/${jobId}/`)), JSON.stringify(jobTabs));
await waitFor(`Boolean(document.querySelector('.subtabs a[href="/jobs/${jobId}/screening"]'))`, '职位内简历筛选入口');
for (const width of [390, 768, 1440]) await capture('job-overview', width, '.overview-next');
await ev(`document.querySelector(${JSON.stringify(screeningEntry)}).focus()`);
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
await waitFor(`location.pathname === '/jobs/${jobId}/screening' && Boolean(document.querySelector('.subtab.active[href="/jobs/${jobId}/screening"]'))`, '键盘切到简历筛选');
check('键盘可从概览切到简历筛选', await ev(`document.querySelector('.subtab.active')?.getAttribute('href') === '/jobs/${jobId}/screening'`));
check('画像未确认时提示去确认', await ev(`Boolean(document.querySelector('.resume-import a[href="/jobs/${jobId}/profile"]')) && !document.querySelector('#resume-import-file')`));

const activeTab = 'document.querySelector(\'[role=tab][aria-selected=true]\')';
const activePanel = 'document.querySelector(\'[role=tabpanel]:not([hidden])\')';
const tabCounts = 'document.querySelectorAll(\'.group-tabs .tab-count\')';
const countNote = 'document.querySelector(\'.toolbar .list-note\')';
const press = async (key, windowsVirtualKeyCode) => {
  const event = { key, code: key, windowsVirtualKeyCode };
  await send('Input.dispatchKeyEvent', { type: 'keyDown', ...event, ...(key === 'Enter' ? { text: '\r' } : {}) });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...event });
};
const checkResultTabs = async (label, count) => {
  const tablist = `document.querySelector('[role=tablist][aria-label="${label}"]')`;
  await waitFor(`${tablist}?.querySelectorAll('[role=tab]').length === ${count}`, label);
  const initialId = await ev(`${activeTab}.id`);
  await ev(`${activeTab}.focus()`);
  await press('ArrowRight', 39);
  await waitFor(`${activeTab}.id !== ${JSON.stringify(initialId)} && document.activeElement === ${activeTab}`, `${label}方向键切换`);
  check(`${label}的每个标签都关联到对应结果区，只有当前面板可见`, await ev(`(() => {
    const tabs = [...${tablist}.querySelectorAll('[role=tab]')];
    const panelIds = tabs.map(tab => tab.getAttribute('aria-controls'));
    return new Set(panelIds).size === tabs.length && new Set(tabs.map(tab => tab.id)).size === tabs.length
      && tabs.every((tab, index) => {
        const panel = document.getElementById(panelIds[index]);
        const selected = tab === ${activeTab};
        return panel?.getAttribute('role') === 'tabpanel' && panel.getAttribute('aria-labelledby') === tab.id
          && panel.checkVisibility() === selected && tab.tabIndex === (selected ? 0 : -1)
          && panel.tabIndex === (selected ? 0 : -1);
      });
  })()`));
  for (let step = 0; step < 5 && !(await ev(`document.activeElement === ${activePanel}`)); step += 1) {
    await press('Tab', 9);
  }
  check(`${label}可用方向键切换，并用 Tab 进入结果区`, await ev(`document.activeElement === ${activePanel}`));
};

const candidateJobFilter = `document.querySelector('select[aria-label="按投递职位筛选"]')`;
const setCandidateJob = (value) => ev(`(() => {
  const select = ${candidateJobFilter};
  select.value = ${JSON.stringify(value)};
  select.dispatchEvent(new Event('change', { bubbles: true }));
})()`);
const candidateSearch = `document.querySelector('.toolbar .search-input input')`;
const setCandidateQuery = (query) => ev(`(() => {
  const input = ${candidateSearch};
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(query)});
  input.dispatchEvent(new Event('input', { bubbles: true }));
})()`);
const clearCandidateFilters = `([...document.querySelectorAll('.toolbar button')].find(button => button.textContent.trim() === '清空筛选'))`;

// 从候选人页投递到新职位
const failJobOptions = !EXTERNAL && await send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
  const fetch = window.fetch;
  window.fetch = (input, options) => {
    if (typeof input === 'string' && new URL(input, location.origin).pathname === '/api/job-options') {
      window.fetch = fetch;
      return Promise.resolve(Response.json({ error: { message: '职位选项测试失败' } }, { status: 503 }));
    }
    return fetch(input, options);
  };
})()` });
await send('Page.navigate', { url: `${BASE}/candidates` });
await waitFor(`!!document.querySelector('.data-table tbody tr')`, 'candidate rows');
if (failJobOptions) {
  await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: failJobOptions.identifier });
  const retryJobOptions = `([...document.querySelectorAll('.toolbar button')].find(button => button.textContent.includes('职位加载失败')))`;
  await waitFor(`Boolean(${retryJobOptions})`, '职位筛选选项失败');
  const listRemainsUsable = await ev(`${candidateJobFilter}.disabled && Boolean(document.querySelector('.data-table'))`);
  await ev(`${retryJobOptions}.focus()`);
  await press('Enter', 13);
  await waitFor(`!${candidateJobFilter}.disabled`, '职位筛选选项重试成功');
  check('职位选项失败时仍可查看候选人，键盘重试后焦点回到搜索框', listRemainsUsable && await ev(`document.activeElement === ${candidateSearch}`));
}
await waitFor(`!!${candidateJobFilter}?.querySelector('option[value="${jobId}"]')`, '真实招聘职位选项');
check('候选人默认显示全部职位，并可选择实际招聘职位', await ev(`
  ${candidateJobFilter}.selectedOptions[0].textContent === '全部职位'
  && ${candidateJobFilter}.querySelector('option[value="${jobId}"]').textContent.includes(${JSON.stringify(jobTitle)})
  && !document.querySelector('select[aria-label="按技能筛选"]')
`));
await checkResultTabs('按流程阶段分类', 8);
await waitFor(`${activePanel}.getAttribute('aria-busy') === 'false'`, '分类结果返回');
await capture('candidate-groups', 390, '.group-tabs');
check('窄屏候选人分类完整可见', await ev(`(() => {
  const list = document.querySelector('.group-tabs .tabs');
  return [...list.querySelectorAll('[role=tab]')].every(tab => tab.getBoundingClientRect().right <= list.getBoundingClientRect().right);
})()`));
await capture('candidate-groups', 1440, '.group-tabs');
await ev(`document.querySelector('.group-tabs [role=tab]').click()`);
await waitFor(`${tabCounts}.length === 8 && !!document.querySelector('.data-table tbody tr')`, '候选人恢复全部');

if (!EXTERNAL) {
  // 只拦截两次指定搜索，由测试控制响应顺序，其他请求继续使用隔离服务。
  const lateQuery = 'smoke-late-' + Date.now();
  const emptyQuery = 'smoke-empty-' + Date.now();
  await ev(`(() => {
    const originalFetch = window.fetch;
    let pauseEmpty = true;
    window.candidateRequests = { restore: () => { window.fetch = originalFetch; } };
    window.fetch = (input, options) => {
      if (typeof input !== 'string') return originalFetch(input, options);
      const url = new URL(input, location.origin);
      if (url.pathname !== '/api/candidates') return originalFetch(input, options);
      const q = url.searchParams.get('q');
      if (q === ${JSON.stringify(lateQuery)}) return new Promise(resolve => {
        window.candidateRequests.releaseLate = resolve;
      });
      if (q === ${JSON.stringify(emptyQuery)} && pauseEmpty) {
        pauseEmpty = false;
        return new Promise(resolve => { window.candidateRequests.releaseEmpty = resolve; });
      }
      return originalFetch(input, options);
    };
  })()`);
  const noStaleCounts = `${tabCounts}.length === 0 && !/\\d/.test(${countNote}.textContent)`;
  const seededList = await ev(`fetch('/api/candidates?pageSize=1').then(response => response.json())`);
  await setCandidateQuery(lateQuery);
  check('关键词变化即隐藏旧分类人数、总数和结果', await ev(`
    ${noStaleCounts} && ${activePanel}.getAttribute('aria-busy') === 'true'
    && Boolean(${activePanel}.querySelector('.list-skeleton')) && !${activePanel}.querySelector('.data-table')
  `));
  await waitFor(`typeof window.candidateRequests.releaseLate === 'function'`, '旧候选人请求等待响应');
  await setCandidateQuery(emptyQuery);
  await waitFor(`typeof window.candidateRequests.releaseEmpty === 'function'`, '新候选人请求等待响应');
  await ev(`window.candidateRequests.releaseEmpty(Response.json({ error: { message: '候选人加载测试失败' } }, { status: 503 }))`);
  await waitFor(`${activePanel}.querySelector('[role=alert]')?.textContent.includes('候选人加载测试失败')`, '候选人失败态');
  check('候选人请求失败后不显示旧人数，仍可切换分类和重试', await ev(`
    ${noStaleCounts} && ${activePanel}.getAttribute('aria-busy') === 'false'
    && ${activePanel}.querySelector('[role=alert] button').textContent.trim() === '重试'
    && document.querySelectorAll('.group-tabs [role=tab]:enabled').length === 8
  `));
  await ev(`${activePanel}.querySelector('[role=alert] button').focus()`);
  await press('Enter', 13);
  await waitFor(`${activePanel}.querySelector('.empty-state')?.textContent.includes('没有匹配的候选人')`, '候选人重试返回空结果');
  const allCountsZero = `${tabCounts}.length === 8 && [...${tabCounts}].every(count => count.textContent === '0') && ${countNote}.textContent.trim() === '筛出 0 位'`;
  check('候选人重试成功显示真实的零人数，并保留键盘焦点', await ev(`${allCountsZero} && document.activeElement === ${activePanel}`));
  await ev(`new Promise(resolve => {
    window.candidateRequests.releaseLate(Response.json(${JSON.stringify(seededList)}));
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  })`);
  check('较早的候选人响应不能覆盖重试结果', await ev(allCountsZero));
  await ev(`window.candidateRequests.restore()`);
  await setCandidateQuery('');
  await waitFor(`${tabCounts}.length === 8 && !!document.querySelector('.data-table tbody tr')`, '候选人清空关键词');
}

await setCandidateJob(jobId);
await waitFor(`${activePanel}.querySelector('.empty-state')?.textContent.includes('没有匹配的候选人')`, '新职位没有投递');
check('没有投递的职位返回空结果与零人数', await ev(`${tabCounts}.length === 8 && [...${tabCounts}].every(count => count.textContent === '0')`));
await ev(`${clearCandidateFilters}.click()`);
await waitFor(`${candidateJobFilter}.value === '' && Boolean(document.querySelector('.data-table tbody tr a'))`, '清空职位筛选');
const candidateLink = await ev(`document.querySelector('.data-table tbody tr a').getAttribute('href')`);
await ev(`document.querySelector('.data-table tbody tr a').click()`);
await waitFor(`!!document.querySelector('.profile-head')`, 'candidate detail');
const headState = await ev(`(() => {
  const actions = document.querySelector('.profile-actions');
  const chips = [...actions.querySelectorAll('.status-chip')];
  const labels = [...actions.querySelectorAll('button')].map((b) => (b.textContent ?? '').trim());
  return {
    jobChip: chips.some((c) => c.textContent.includes('职位')),
    interviewChip: chips.some((c) => c.textContent.includes('已安排面试')),
    scheduleBtn: labels.includes('安排初试'),
    applyBtn: labels.some((l) => l === '投递职位' || l === '投递其他职位'),
  };
})()`);
check('详情头部显示已投递职位', headState.jobChip, JSON.stringify(headState));
// 通用冒烟随数据选择候选人，实际排期后的互斥由 smoke:heading 固定覆盖
check(
  '已安排面试时头部不再重复安排入口',
  !headState.interviewChip || !headState.scheduleBtn,
  JSON.stringify(headState),
);
// 头部「+N」的期望值取决于这位候选人已有多少条投递，不能写死
const priorApplicationCount = await ev(`(async () => {
  const id = location.pathname.split('/').pop();
  const res = await fetch('/api/candidates/' + id, { credentials: 'same-origin' });
  const detail = await res.json();
  return detail.applications.length;
})()`);
await ev(`(() => {
  const btn = [...document.querySelectorAll('.profile-actions button')].find((b) =>
    ['投递职位', '投递其他职位'].includes((b.textContent ?? '').trim()),
  );
  if (!btn) throw new Error('头部没有投递入口');
  btn.click();
  return true;
})()`);
await waitFor(`!!document.querySelector('.modal select')`, 'apply modal');
// 选项是异步拉取的，必须等到目标职位真的出现，否则会读到占位选项
await waitFor(
  `[...document.querySelectorAll('.modal select option')].some((o) => o.textContent.includes(${JSON.stringify(jobTitle)}))`,
  'apply options',
);
await ev(`(() => {
  const select = document.querySelector('.modal select');
  const option = [...select.options].find((o) => o.textContent.includes(${JSON.stringify(jobTitle)}));
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, option.value);
  select.dispatchEvent(new Event('change', { bubbles: true }));
  return option.value;
})()`);
await sleep(150);
await ev(`[...document.querySelectorAll('.modal button')].find((b) => b.textContent.includes('投递')).click()`);
await waitFor(`!document.querySelector('.overlay')`, 'apply modal closed');
check('候选人投递到职位（UI）', true);
// 已有投递时，头部只显示主投递，其余用 +N 指向投递记录
if (priorApplicationCount === 0) {
  const stillBare = await ev(`!document.querySelector('.profile-actions .status-chip-more')`);
  check('只有一条投递时不显示 +N', stillBare, `priorApplicationCount=${priorApplicationCount}`);
} else {
  await waitFor(`!!document.querySelector('.profile-actions .status-chip-more')`, 'application count badge');
  const moreBadge = await ev(`document.querySelector('.profile-actions .status-chip-more').textContent.trim()`);
  check('多条投递在头部显示 +N', moreBadge === `+${priorApplicationCount}`, `${moreBadge} (priorApplicationCount=${priorApplicationCount})`);
}

await send('Page.navigate', { url: `${BASE}/candidates` });
await waitFor(`!!${candidateJobFilter}?.querySelector('option[value="${jobId}"]')`, '候选人页加载职位');
await setCandidateJob(jobId);
await waitFor(`${countNote}?.textContent.trim() === '筛出 1 位'`, '仅显示该职位的投递');
check('职位筛选显示刚投递的候选人及该职位的流程阶段', await ev(`(() => {
  const rows = [...document.querySelectorAll('.data-table tbody tr')];
  return rows.length === 1 && rows[0].querySelector('a').getAttribute('href') === ${JSON.stringify(candidateLink)}
    && rows[0].textContent.includes('待筛选') && ${tabCounts}[1].textContent === '1';
})()`));
await ev(`${activeTab}.focus()`);
await press('ArrowRight', 39);
await waitFor(`${countNote}?.textContent.trim() === '「待筛选」1 位'`, '职位与流程分类叠加');
const filteredRow = await ev(`document.querySelector('.data-table tbody tr a').textContent`);
await setCandidateQuery(filteredRow);
await waitFor(`${countNote}?.textContent.trim() === '「待筛选」1 位'`, '职位、搜索与流程分类叠加');
check('职位可与流程阶段和候选人关键词叠加', await ev(`${candidateJobFilter}.value === ${JSON.stringify(jobId)} && document.querySelector('.data-table tbody tr a').getAttribute('href') === ${JSON.stringify(candidateLink)}`));
await capture('candidate-job-filter', 390, '.candidate-job-filter');
await capture('candidate-job-filter', 1440, '.candidate-job-filter');
await ev(`${clearCandidateFilters}.focus()`);
await press('Enter', 13);
await waitFor(`${countNote}?.textContent.startsWith('共 ')`, '清空组合筛选后恢复全部');
check('键盘清空重置职位、流程阶段和关键词，焦点回到搜索框', await ev(`
  ${candidateJobFilter}.value === '' && ${activeTab} === document.querySelector('.group-tabs [role=tab]')
    && ${candidateSearch}.value === '' && document.activeElement === ${candidateSearch}
`));

// 3. 从看板进入指定投递，并确认筛选
const button = (label, scope = 'body') => `([...document.querySelectorAll(${JSON.stringify(scope + ' button')})].find(b => b.textContent.trim() === ${JSON.stringify(label)} && !b.disabled) ?? null)`;
const click = async (label, scope) => {
  const expression = button(label, scope);
  await waitFor(`Boolean(${expression})`, label);
  await ev(`${expression}.click()`);
};
const field = async (label, value, scope = 'body') => ev(`(() => {
  const selector = ${JSON.stringify(scope + ' .field')};
  const wrapper = [...document.querySelectorAll(selector)].find(f => f.querySelector('label')?.textContent.includes(${JSON.stringify(label)}));
  const input = wrapper?.querySelector('input,select,textarea');
  if (!input) throw new Error('找不到表单项 ' + ${JSON.stringify(label)});
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value').set.call(input, ${JSON.stringify(value)});
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
})()`);
const confirm = async (label, title) => {
  const target = `([...document.querySelectorAll('[role="dialog"]')].at(-1)?.querySelectorAll('button') ?? [])`;
  const expression = `[...${target}].find(button => button.textContent.trim() === ${JSON.stringify(label)} && !button.disabled)`;
  const matchingTitle = title ? ` || [...document.querySelectorAll('[role="dialog"] h2')].some(heading => heading.textContent === ${JSON.stringify(title)})` : '';
  await waitFor(`document.querySelectorAll('[role="dialog"]').length > 1 || document.querySelector('[role="alertdialog"]') !== null || [...document.querySelectorAll('[role="dialog"] h2')].some(heading => heading.textContent.includes('确认') || heading.textContent.includes('记录 Offer'))${matchingTitle}`, `${label}确认框`);
  await waitFor(`Boolean(${expression})`, `${label}确认`);
  await ev(`${expression}.click()`);
};
await send('Page.navigate', { url: `${BASE}/jobs/${jobId}/profile` });
await waitFor(`Boolean(document.querySelector('#profile .profile-sheet'))`, '岗位画像标准页加载');
check('岗位画像展示基本档案、职责、四维权重、五档矩阵、职业特质与判定口径', await ev(`(() => {
  const sheet = document.querySelector('#profile .profile-sheet');
  if (!sheet) return false;
  const metaItems = sheet.querySelectorAll('.profile-meta-grid .profile-meta-item').length;
  const resps = sheet.querySelectorAll('.profile-resp-list li').length;
  const weights = sheet.querySelectorAll('.profile-weight-band .profile-weight-cell').length;
  const cTiers = sheet.querySelectorAll('.profile-tier-matrix .profile-tier-cell.is-standard').length;
  const trait = Boolean(sheet.querySelector('.profile-trait-card'));
  const rule = Boolean(sheet.querySelector('.profile-scoring-rule'));
  return metaItems >= 3 && resps >= 5 && weights === 4 && cTiers >= 12 && trait && rule;
})()`));
for (const width of [390, 768, 1440]) await capture('job-profile', width, '#profile .profile-sheet');
await click('确认画像', '#profile');
await waitFor(`document.querySelector('#profile .workflow-context')?.textContent.includes('已确认的第 1 版')`, '职位显示当前已确认版本');
await click('编辑画像', '#profile');
await waitFor(`Boolean(document.querySelector('#profile .profile-editor-section'))`, '打开岗位画像编辑器');
await field('所属行业', '智能制造与SaaS', '#profile');
await click('保存草稿', '#profile');
await waitFor(`document.querySelector('#profile .profile-meta-grid')?.textContent.includes('智能制造与SaaS')`, '画像编辑保存后即时更新');
check('岗位画像可在线编辑行业并保存为新草稿', await ev(`Boolean(document.querySelector('#profile .card-head')?.textContent.includes('第 2 版')) && Boolean(document.querySelector('#profile .workflow-context')?.textContent.includes('新版本确认前继续使用'))`));
await click('确认画像', '#profile');
await waitFor(`document.querySelector('#profile .workflow-context')?.textContent.includes('已确认的第 2 版')`, '确认编辑后的第 2 版画像');
// Simulate one delayed screening response in the browser, then resume using the isolated server.
await ev(`(() => {
  const realFetch = window.fetch.bind(window);
  let firstBoardRead = true;
  window.fetch = async (url, ...args) => {
    const response = await realFetch(url, ...args);
    if (url !== '/api/jobs/${jobId}/board' || !firstBoardRead || !response.ok) return response;
    firstBoardRead = false;
    const board = await response.json();
    const card = board.columns.find(({ stage }) => stage === 'screening')?.cards[0];
    if (card) Object.assign(card, { screening_status: 'generating', screening_score: null, screening_verdict: null });
    return Response.json(board);
  };
})()`);
await ev(`document.querySelector(${JSON.stringify(screeningEntry)}).click()`);
await waitFor(`location.pathname === '/jobs/${jobId}/screening'`, '进入简历筛选');
await waitFor(`document.querySelector('.queue-row')?.textContent.includes('正在筛选')`, '筛选列表显示正在筛选');
await waitFor(`document.querySelector('.queue-row') && !document.querySelector('.queue-row').textContent.includes('正在筛选')`, '筛选列表自动更新结果');
check('筛选中列表自动刷新至最新状态', true);
await waitFor(`!!document.querySelector('.queue-row .queue-action')`, '待筛选人员');
const importName = '直传浏览器测试';
const importText = `姓名：${importName}\n邮箱：direct-browser@example.test\n负责招聘平台质量保障，编写接口和端到端回归测试。`;
const dropResumes = (files) => ev(`(() => {
  const zone = document.querySelector('.resume-import');
  const dataTransfer = new DataTransfer();
  for (const file of ${JSON.stringify(files)}) dataTransfer.items.add(new File([file.text], file.name, { type: 'text/plain' }));
  zone.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer }));
  return new Promise(resolve => requestAnimationFrame(() => {
    const highlighted = zone.classList.contains('is-dragging');
    const drop = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer });
    zone.dispatchEvent(drop);
    resolve(highlighted && drop.defaultPrevented);
  }));
})()`);
for (const width of [390, 768, 1440]) await capture('resume-import', width, '.resume-import');
const secondResume = { name: '第二份.txt', text: '姓名：批量测试\n邮箱：batch-browser@example.test\n负责渠道投放数据整理并跟进供应商对账。' };
check('拖入多份简历时高亮接收区并拦截浏览器默认动作',
  await dropResumes([{ name: '直传测试.txt', text: importText }, secondResume]));
await waitFor(`document.querySelectorAll('.resume-import-results .import-row').length === 2`, '两份简历逐份出结果');
check('多份简历逐份出结果且留在筛选页', await ev(`(() => {
  const rows = [...document.querySelectorAll('.resume-import-results .import-row')];
  return rows.length === 2 && rows.every((row) => row.classList.contains('import-ok'))
    && location.pathname === '/jobs/${jobId}/screening';
})()`));
await waitFor(`[...document.querySelectorAll('.queue-row .queue-name')].some((el) => el.textContent.includes(${JSON.stringify(importName)}))`, '导入的人进入筛选队列');
check('导入后不再跳走，候选人直接进入当前筛选队列', await ev(`location.pathname === '/jobs/${jobId}/screening'
  && document.querySelectorAll('.queue-row').length >= 2`));
const duplicateFixture = join(profile, 'resume-import-fixture.txt');
await writeFile(duplicateFixture, importText);
await ev(`(() => {
  window.__uploadClicks = [];
  const zone = document.querySelector('.resume-import');
  zone.addEventListener('click', (event) => {
    const control = event.target.closest('button, input');
    if (control) window.__uploadClicks.push([control.tagName, event.isTrusted]);
  }, true);
  zone.querySelector('button').focus();
})()`);
await waitFor(`document.activeElement.matches('.resume-import button')`, '文件选择按钮获得焦点');
await send('Page.setInterceptFileChooserDialog', { enabled: true });
let openedChooser;
const onChooser = (event) => {
  const value = JSON.parse(event.data);
  if (value.method === 'Page.fileChooserOpened') openedChooser = value.params;
};
ws.addEventListener('message', onChooser);
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', text: ' ', windowsVirtualKeyCode: 32 });
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', text: ' ', windowsVirtualKeyCode: 32 });
const clicks = await ev(`window.__uploadClicks`);
check('空格键激活选择简历并打开文件输入', clicks.some(([tag, trusted]) => tag === 'BUTTON' && trusted) && clicks.some(([tag]) => tag === 'INPUT'), JSON.stringify(clicks));
if (openedChooser?.backendNodeId) {
  await send('DOM.setFileInputFiles', { files: [duplicateFixture], backendNodeId: openedChooser.backendNodeId });
} else {
  const { root: uploadDocument } = await send('DOM.getDocument');
  const { nodeId: uploadControl } = await send('DOM.querySelector', { nodeId: uploadDocument.nodeId, selector: '#resume-import-file' });
  await send('DOM.setFileInputFiles', { files: [duplicateFixture], nodeId: uploadControl });
}
ws.removeEventListener('message', onChooser);
await send('Page.setInterceptFileChooserDialog', { enabled: false });
await waitFor(`Boolean(document.querySelector('.import-duplicate a[href$="#screening"]'))`, '重复简历提示已有记录');
check('键盘选择和重复简历提示已有记录', true);
await ev(`document.querySelector('.import-duplicate a').click()`);
await waitFor(`document.querySelector('#screening select') !== null`, '重复简历回到原待筛选详情');
await field('筛选决定', 'reject', '#screening');
await click('归档投递', '#screening');
await confirm('归档投递', '归档这条投递？');
await waitFor(`!document.querySelector('#screening select')`, '人工归档后筛选只读');
await send('Page.navigate', { url: `${BASE}/jobs/${jobId}/screening` });
await waitFor(`document.querySelector('.rejected-block')?.textContent.includes(${JSON.stringify(importName)})`, '直传候选人归档后留在筛选');
check('直传候选人可由人归档并在筛选里找回', true);

// 4. 就地筛选：抽屉里看总结、人工决定，不离开职位页
await waitFor(`Boolean(document.querySelector('.queue-row .queue-action'))`, '待筛选人员');
const firstApplication = await ev(`fetch('/api/jobs/${jobId}/board').then(r => r.json()).then(d => d.columns.find(c => c.stage === 'screening')?.cards[0]?.id ?? null)`);
check('筛选队列给出可操作投递', typeof firstApplication === 'string', String(firstApplication));
// Model responses are simulated only for this browser's exact screening GET.
const excerpt = '协助企业客户续约和交接材料的整理。';
await ev(`(() => {
  const target = '/api/applications/' + ${JSON.stringify(firstApplication)} + '/screening';
  const realFetch = window.fetch.bind(window);
  let reads = 0;
  const release = new Promise(resolve => { window.__releaseResumeSummary = resolve; });
  window.fetch = async (url, ...args) => {
    const response = await realFetch(url, ...args);
    if (url !== target || !response.ok) return response;
    const result = await response.json();
    if (!result.data?.review) return Response.json(result);
    const ready = reads++ > 0;
    if (ready) await release;
    result.data.status = ready ? 'ready' : 'generating';
    if (ready) Object.assign(result.data.review, {
      score: 100, verdict: 'match',
      detail: { ...result.data.review.detail, source: 'ai', resume_excerpts: [${JSON.stringify(excerpt)}] },
    });
    return Response.json(result);
  };
})()`);
await ev(`document.querySelector('.queue-row .queue-action').click()`);
await waitFor(`document.querySelector('.resume-summary [role=status]')?.textContent.includes('正在阅读简历')`, '抽屉里显示总结生成中');
check('就地打开筛选不离开职位筛选页', await ev(`location.pathname === '/jobs/${jobId}/screening' && Boolean(document.querySelector('[role="dialog"] #screening'))`));
check('生成中仍然可以人工推进', await ev(`Boolean(${button('推进初试', '[role="dialog"]')})`));
await ev(`window.__releaseResumeSummary()`);
await waitFor(`document.querySelector('.resume-summary-points')?.textContent.includes(${JSON.stringify(excerpt)})`, '总结轮询后呈现');
check('总结先于岗位画像评分和人工决定', await ev(`(() => {
  const summary = document.querySelector('.resume-summary');
  const portrait = document.querySelector('[role="dialog"] #screening .portrait-reference');
  return !portrait.open && Boolean(summary.compareDocumentPosition(portrait) & Node.DOCUMENT_POSITION_FOLLOWING)
    && Boolean(summary.compareDocumentPosition(${button('推进初试', '[role="dialog"]')}) & Node.DOCUMENT_POSITION_FOLLOWING);
})()`));
for (const width of [390, 768, 1440]) await capture('candidate-screening', width, '[role="dialog"] #screening');
check('总结显示简历原句并可查看原简历', await ev(`document.querySelector('.resume-summary-points li')?.textContent === ${JSON.stringify(excerpt)}
  && (() => { const link = [...document.querySelectorAll('.resume-summary a')].find(a => a.textContent === '查看原简历'); return Boolean(link) && /^\\/candidates\\/[^/]+#resume$/.test(link.getAttribute('href')); })()`));
await click('推进初试', '[role="dialog"]');
await waitFor(`!document.querySelector('.overlay')`, '推进后抽屉自动关闭');
check('就地推进后抽屉自动关闭且不离开职位页', await ev(`!document.querySelector('[role="dialog"]') && location.pathname === '/jobs/${jobId}/screening'`));
await waitFor(`document.querySelectorAll('.queue-row').length >= 1`, '推进后队列仍在');

// 5. 批量推进与批量归档都留在筛选页
await waitFor(`document.querySelector('.queue-batch .queue-check input') !== null`, '筛选队列可多选');
await ev(`document.querySelector('.queue-batch .queue-check input').click()`);
await waitFor(`/已选 \\d+ 人/.test(document.querySelector('.queue-batch')?.textContent ?? '')`, '批量工具条显示已选人数');
const pickedCount = Number(await ev(`document.querySelector('.queue-batch')?.textContent.match(/已选 (\\d+) 人/)?.[1] ?? '0'`));
check('全选纳入当前待筛选队列', pickedCount >= 1, String(pickedCount));
await click('批量推进初试');
await waitFor(`document.querySelector('.queue-report')?.textContent.includes('已处理 ${pickedCount} 人')`, '批量推进逐条回报');
check('一次推进多份简历并留在筛选页', await ev(`location.pathname === '/jobs/${jobId}/screening'`));
const archiveResume = { name: '归档测试.txt', text: '姓名：归档测试\n邮箱：archive-browser@example.test\n负责数据看板建设。' };
await dropResumes([archiveResume]);
await waitFor(`[...document.querySelectorAll('.queue-row .queue-name')].some((el) => el.textContent.includes('归档测试'))`, '新简历进入筛选队列');
await ev(`(() => {
  const row = [...document.querySelectorAll('.queue-row')].find((item) => item.textContent.includes('归档测试'));
  row.querySelector('.queue-check input').click();
})()`);
await waitFor(`document.querySelector('.queue-batch')?.textContent.includes('已选 1 人')`, '选中待归档简历');
await waitFor(`Boolean(document.querySelector('.queue-batch-reason select'))`, '批量归档原因可选');
check('未选原因时批量归档不可点', await ev(`Boolean([...document.querySelectorAll('.queue-batch button')].find(b => b.textContent.trim() === '批量归档')?.disabled)`));
await field('归档原因', '经验不匹配', '.queue-batch-reason');
await waitFor(`!([...document.querySelectorAll('.queue-batch button')].find(b => b.textContent.trim() === '批量归档')?.disabled)`, '选好原因后可批量归档');
await click('批量归档');
await waitFor(`document.querySelector('.queue-report')?.textContent.includes('已处理 1 人')`, '批量归档回报');
await waitFor(`document.querySelector('.rejected-block')?.textContent.includes('归档测试')`, '批量归档进入已归档区');
check('批量归档带原因且留在筛选页', await ev(`location.pathname === '/jobs/${jobId}/screening'`));
// 归档错了要能撤回：已归档区里点「恢复」回到原阶段
await ev(`document.querySelector('.rejected-block summary').click()`);
await waitFor(`Boolean([...document.querySelectorAll('.rejected-block .queue-row')].find((row) => row.textContent.includes('归档测试')))`, '展开已归档区');
const restoreButton = `[...document.querySelectorAll('.rejected-block .queue-row')].find((row) => row.textContent.includes('归档测试'))?.querySelector('button')`;
check('已归档行提供恢复入口', await ev(`${restoreButton}?.textContent.trim() === '恢复'`));
await ev(`${restoreButton}.click()`);
// 待筛选卡片才有 .queue-tools；用它定位，避免把已归档列表里的同名行当成回来了
const inPendingQueue = `[...document.querySelectorAll('.card')].some((card) => card.querySelector('.queue-tools') && card.textContent.includes('归档测试'))`;
const inArchive = `[...document.querySelectorAll('.rejected-block .queue-row')].some((row) => row.textContent.includes('归档测试'))`;
await waitFor(`!${inArchive}`, '恢复后已归档区移除该人');
await waitFor(inPendingQueue, '恢复后回到待筛选队列');
check('恢复后回到待筛选队列且不在已归档区', await ev(`Boolean(${inPendingQueue}) && !Boolean(${inArchive})`));
check('恢复后仍留在筛选页', await ev(`location.pathname === '/jobs/${jobId}/screening'`));

// 6. 面试子模块就地约面、贴稿、定去留
await send('Page.navigate', { url: `${BASE}/jobs/${jobId}/interviews` });
await waitFor(`Boolean(document.querySelector('.subtab.active[href$="/interviews"]')) && document.querySelector('.queue-row') !== null`, '进入面试子模块');
async function scheduleInPlace(label) {
  await click(label, '.job-workspace');
  await waitFor(`Boolean(document.querySelector('.modal input[type=datetime-local]')?.value)`, `${label}表单已初始化`);
  const time = new Date(Date.now() - 60 * 60 * 1000);
  const local = new Date(time.valueOf() - time.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  await field('面试时间', local, '.modal');
  await click('安排', '.modal');
  await waitFor(`!document.querySelector('.overlay')`, `${label}关闭`);
  // 队列行上的「贴逐字稿」永远指向刚排的这一场，避免点到上一轮的旧面试
  await waitFor(`Boolean(${button('贴逐字稿', '.queue-row')})`, `${label}后出现贴逐字稿入口`);
  await click('贴逐字稿', '.queue-row');
  await waitFor(`!!document.querySelector('.interview-drawer')`, `${label}打开面试抽屉`);
  check(`${label}在面试子模块内就地完成`, await ev(`location.pathname === '/jobs/${jobId}/interviews'`));
}
async function saveOfflineConclusion(action) {
  await click('写一句结论', '.interview-drawer');
  check(`${action}前必须有本轮结论`, !await ev(`Boolean(${button(action, '.interview-drawer')})`));
  await field('本轮结论', '验证用结论：候选人提供了岗位相关的例子。', '.interview-drawer');
  await click('保存人工结论', '.interview-drawer');
  await click(action, '.interview-drawer');
  await confirm(action);
  await waitFor(`!document.querySelector('.interview-drawer')`, `${action}成功`);
}
await scheduleInPlace('安排初试');
await saveOfflineConclusion('进入复试');
await scheduleInPlace('安排复试');
await saveOfflineConclusion('进入谈薪');
check('两轮面试在职位页面内走完', await ev(`location.pathname === '/jobs/${jobId}/interviews'`));

// 7. 谈薪子模块就地保存草稿到入职
await send('Page.navigate', { url: `${BASE}/jobs/${jobId}/negotiation` });
await waitFor(`document.querySelector('.subtab.active[href$="/negotiation"]') && Boolean(document.querySelector('.queue-row .queue-action'))`, '进入谈薪子模块');
await ev(`document.querySelector('.queue-row .queue-action').click()`);
await waitFor(`!!document.querySelector('#offer input[type=number]')`, '谈薪表单就地打开');
check('谈薪在职位子模块内就地进行', await ev(`location.pathname === '/jobs/${jobId}/negotiation' && Boolean(document.querySelector('[role="dialog"] #offer'))`));
await field('期望月薪', '22000', '[role="dialog"]');
await field('最终月薪', '21000', '[role="dialog"]');
await field('到岗日期', '2030-04-10', '[role="dialog"]');
await field('答复期限', '2030-04-03', '[role="dialog"]');
await click('保存谈薪草稿', '[role="dialog"]');
check('保存谈薪草稿后仍留在谈薪页', await ev(`location.pathname === '/jobs/${jobId}/negotiation'`));
await click('记录已发出', '[role="dialog"]');
await confirm('记录已发出');
await waitFor(`!document.querySelector('.overlay')`, '发出 Offer 后抽屉关闭');
check('发出 Offer 后进入待入职子模块', await ev(`location.pathname === '/jobs/${jobId}/negotiation'`));
await send('Page.navigate', { url: `${BASE}/jobs/${jobId}/onboarding` });
await waitFor(`Boolean(document.querySelector('.queue-row .queue-action'))`, '进入入职子模块');
await ev(`document.querySelector('.queue-row .queue-action').click()`);
await waitFor(`!!document.querySelector('[role="dialog"] #offer')`, '入职子模块就地打开 Offer');
await click('记录已接受', '[role="dialog"]');
await waitFor(`Boolean(${button('确认入职', '[role="dialog"]')})`, '接受后可确认入职');
await click('确认入职', '[role="dialog"]');
await confirm('确认入职');
await waitFor(`!document.querySelector('.overlay')`, '入职后抽屉关闭');
const archivedBoard = await ev(`fetch('/api/jobs/${jobId}/board').then(r => r.json()).then(d => d.columns.find(c => c.stage === 'hired').count)`);
check('已入职归到看板最后一列', archivedBoard === 1, String(archivedBoard));

// 8. 候选人详情页仍保留就地入口（不要求从职位页跳过去）
const hiredCandidate = await ev(`fetch('/api/jobs/${jobId}/board').then(r => r.json()).then(d => d.columns.find(c => c.stage === 'hired')?.cards[0]?.candidate_id ?? null)`);
await send('Page.navigate', { url: `${BASE}/candidates/${hiredCandidate}` });
await waitFor(`!!document.querySelector('.profile-actions')`, '候选人详情页');
check('候选人详情页仍可就地操作', await ev(`Boolean(document.querySelector('#offer'))`));
await click('替换简历');
await waitFor(`!!document.querySelector('.upload-zone input[type=file]')`, '上传输入框');
const { root } = await send('DOM.getDocument', { depth: -1 });
const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: '.upload-zone input[type=file]' });
await send('DOM.setFileInputFiles', { files: [resolve('test-fixtures/resume-zhang.docx')], nodeId });
await waitFor(`document.querySelector('.file-row a[download="resume-zhang.docx"]') && document.querySelector('.parse-result')?.textContent.includes('解析结果')`, '简历上传和解析结果');
check('上传并解析 DOCX 测试文件', true);
await capture('candidate-hired', 390, '#offer');
await capture('candidate-hired', 1440, '#offer');
await send('Page.navigate', { url: `${BASE}/settings` });
await waitFor(`document.querySelector('input[type=password][autocomplete=new-password]') !== null`, 'AI 模型设置');
check('AI 设置显示官方地址、模型 ID 和版本', await ev(`(() => {
  const panel = document.querySelector('input[type=password][autocomplete=new-password]')?.closest('.workflow-panel');
  const label = [...(panel?.querySelectorAll('label') ?? [])].find(item => item.textContent.trim() === '模型 ID');
  return panel?.querySelector('input[type=url]')?.value === 'https://api.deepseek.com'
    && label?.control?.value === 'deepseek-flash'
    && panel.textContent.includes('DeepSeek-V4.1-Flash-1017');
})()`));
check('DeepSeek 文档与密钥链接指向官方并在新标签打开', await ev(`(() => {
  const panel = document.querySelector('input[type=password][autocomplete=new-password]')?.closest('.workflow-panel');
  return ['https://api-docs.deepseek.com/zh-cn/', 'https://platform.deepseek.com/api_keys']
    .every(url => panel?.querySelector('a[target="_blank"][href="' + url + '"]')?.relList.contains('noreferrer'));
})()`));
check('未配置 AI 模型时禁用连通性测试', await ev(`Boolean([...document.querySelectorAll('button')].find(b => b.textContent.trim() === '测试连通性')?.disabled)`));
if (!EXTERNAL) {
  const outbox = `document.querySelector('.feishu-outbox')`;
  await waitFor(`${outbox}?.querySelectorAll('.notify-list li').length === 8`, '出站箱第一页');
  await click('下一页', '.feishu-outbox');
  await waitFor(`${outbox}.querySelector('.notify-footer [role=status]').textContent.includes('第 9')`, '出站箱下一页');
  check('翻页可看到首屏以外的历史记录', await ev(`${outbox}.querySelector('.notify-list').textContent.includes('筛选样本 0')`));
  await ev(`${outbox}.querySelectorAll('.notify-status-filter')[1].click()`);
  await field('发送渠道', 'webhook', '.feishu-outbox');
  await field('搜索通知', '早期记录面试官', '.feishu-outbox');
  await waitFor(`${outbox}.querySelector('.notify-list li')?.textContent.includes('早期记录面试官')`, '组合搜索找到历史面试官');
  check('出站箱可组合筛选状态、渠道与面试官', await ev(`
    ${outbox}.querySelectorAll('.notify-list li').length === 1
    && ${outbox}.querySelector('.notify-list li').textContent.includes('待发送')
    && ${outbox}.querySelector('.notify-status-filter[aria-pressed=true]').textContent.startsWith('待发送')
  `));
  await field('搜索通知', '没有对应的出站记录_abcdef', '.feishu-outbox');
  await waitFor(`${outbox}.querySelector('.empty-state h3')?.textContent === '没有符合条件的记录'`, '搜索没有结果');
  await click('清空筛选', '.feishu-outbox');
  await waitFor(`${outbox}.querySelectorAll('.notify-list li').length === 8`, '清空筛选后恢复出站箱列表');
  check('清空可恢复全部状态、渠道和第一页', await ev(`
    ${outbox}.querySelector('.notify-status-filter[aria-pressed=true]').textContent.startsWith('全部')
    && ${outbox}.querySelector('select').value === 'all'
    && ${outbox}.querySelector('input[type=search]').value === ''
    && ${outbox}.querySelector('.notify-footer [role=status]').textContent.startsWith('第 1–8 条')
  `));
}
await capture('settings', 390, '.settings-section');
await capture('settings', 1440, '.settings-section');
// 一级导航五项、旧地址书签
check('一级导航为工作台/职位/候选人/面试/设置', await ev(`[...document.querySelectorAll('.nav .nav-item span')].map((el) => el.textContent.trim()).join('/') === '工作台/职位/候选人/面试/设置'`));
check('已移除数据页入口', await ev(`!document.querySelector('.nav .nav-item[href="/analytics"]')`));
await send('Page.navigate', { url: `${BASE}/analytics` });
await waitFor(`Boolean(document.querySelector('.page .kpi-row'))`, '旧数据页地址落到工作台');
check('数据页地址回落到工作台', true);
await send('Page.navigate', { url: `${BASE}/jobs/${jobId}/board` });
await waitFor(`location.pathname === '/jobs/${jobId}/screening'`, '旧看板地址跳到简历筛选');
check('旧看板书签自动改到简历筛选', await ev(`Boolean(document.querySelector('.subtab.active[href$="/screening"]'))`));
await send('Page.navigate', { url: `${BASE}/jobs/${jobId}/unknown-tab` });
await waitFor(`location.pathname === '/jobs/${jobId}/overview'`, '未知子模块地址落到概览');
check('未知子模块地址落到概览', await ev(`Boolean(document.querySelector('.subtab.active[href$="/overview"]')) && Boolean(document.querySelector('.overview-kpis'))`));
await click('深色模式', '.sidebar');
await waitFor(`document.documentElement.dataset.theme === 'dark'`, '深色模式');
await send('Page.navigate', { url: `${BASE}/jobs/${jobId}/screening` });
await waitFor(`document.documentElement.dataset.theme === 'dark' && Boolean(document.querySelector('.queue-row'))`, '深色主题保留到职位工作台');
check('职位头部的流程中人数不含已入职候选人', await ev(`(async () => {
  const [job, board] = await Promise.all([
    fetch('/api/jobs/${jobId}').then(r => r.json()),
    fetch('/api/jobs/${jobId}/board').then(r => r.json()),
  ]);
  const live = board.columns.filter(c => c.stage !== 'hired').reduce((sum, c) => sum + c.cards.length, 0);
  const hired = board.columns.find(c => c.stage === 'hired')?.count ?? 0;
  const text = document.querySelector('.page-desc')?.textContent ?? '';
  return text.includes(live + ' 人在流程中') && text.includes(hired + ' 人已入职') && hired === 1;
})()`));
await capture('screening-dark', 1440, '.resume-import');
await send('Page.navigate', { url: `${BASE}/jobs/${jobId}/profile` });
await waitFor(`document.documentElement.dataset.theme === 'dark' && Boolean(document.querySelector('#profile .profile-sheet'))`, '深色主题岗位画像页');
await capture('job-profile-dark', 1440, '#profile .profile-sheet');
await send('Page.navigate', { url: `${BASE}/candidates` });
await waitFor(`${tabCounts}.length === 8`, '深色候选人分类');
await capture('candidate-groups-dark', 1440, '.group-tabs');

if (!EXTERNAL) {
  await ev(`(async () => {
    const { total } = await fetch('/api/candidates?pageSize=1').then(response => response.json());
    for (let n = total; n < 21; n += 1) {
      const response = await fetch('/api/candidates', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '翻页测试候选人 ' + n }),
      });
      if (!response.ok) throw new Error('创建翻页测试候选人失败');
    }
  })()`);
  await send('Page.navigate', { url: `${BASE}/candidates` });
  await waitFor(`Boolean(document.querySelector('.pagination button:last-child:not(:disabled)'))`, '候选人可翻页');
  await ev(`document.querySelector('.pagination button:last-child').focus()`);
  await press('Enter', 13);
  await waitFor(`document.querySelector('.pagination > span')?.textContent.trim().startsWith('2 /')`, '候选人第二页');
  check('候选人键盘翻页后焦点留在结果区', await ev(`document.activeElement === ${activePanel}`));
}

await send('Page.navigate', { url: `${BASE}/jobs` });
await waitFor(`!!document.querySelector('.job-card')`, '职位列表结果');
await checkResultTabs('按职位状态筛选', 4);

if (!EXTERNAL) {
  const disposableJobId = await ev(`(async () => {
    const response = await fetch('/api/jobs', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: '延迟删除测试职位' }),
    });
    if (!response.ok) throw new Error('创建删除测试职位失败');
    return (await response.json()).job.id;
  })()`);
  const disposableCard = `document.querySelector('.job-card a[href="/jobs/${disposableJobId}"]')?.closest('.job-card')`;
  await ev(`document.querySelector('[role=tablist] [role=tab]').click()`);
  await waitFor(`Boolean(${disposableCard})`, '待删除职位卡片');
  await ev(`(() => {
    const originalFetch = window.fetch;
    let deletionReleased = false;
    window.jobsRefreshedAfterDeletion = [];
    window.fetch = (input, options) => {
      if (input === '/api/jobs/${disposableJobId}' && options?.method === 'DELETE') {
        return new Promise(resolve => {
          window.releaseJobDeletion = () => {
            deletionReleased = true;
            resolve(originalFetch(input, options));
          };
        });
      }
      if (deletionReleased && typeof input === 'string') {
        const url = new URL(input, location.origin);
        if (url.pathname === '/api/jobs') window.jobsRefreshedAfterDeletion.push(url.searchParams.get('status'));
      }
      return originalFetch(input, options);
    };
    const confirm = window.confirm;
    window.confirm = () => true;
    try { (${disposableCard}).querySelector('button[aria-label="删除职位"]').click(); }
    finally { window.confirm = confirm; }
  })()`);
  await waitFor(`typeof window.releaseJobDeletion === 'function'`, '删除等待响应');
  await ev(`${activeTab}.focus()`);
  await press('ArrowRight', 39);
  const pausedPanel = `${activeTab}.textContent.trim() === '已暂停' && ${activePanel}.getAttribute('aria-busy') === 'false'`;
  await waitFor(pausedPanel, '已暂停职位结果');
  const pausedTitles = await ev(`fetch('/api/jobs?status=paused').then(response => response.json()).then(data => data.items.map(job => job.title))`);
  await ev(`window.releaseJobDeletion()`);
  await waitFor(`window.jobsRefreshedAfterDeletion.length > 0 && document.body.textContent.includes('职位已删除') && (${pausedPanel})`, '删除后刷新已暂停结果');
  check('删除职位完成后刷新当前分类，不覆盖为旧分类', await ev(`
    window.jobsRefreshedAfterDeletion.every(status => status === 'paused')
    && ${pausedPanel} && JSON.stringify([...${activePanel}.querySelectorAll('.job-card-title > a')].map(link => link.textContent)) === ${JSON.stringify(JSON.stringify(pausedTitles))}
  `));
}

await send('Page.navigate', { url: `${BASE}/interviews` });
await checkResultTabs('按面试状态筛选', 5);
await waitFor(`${activePanel}.getAttribute('aria-busy') === 'false' && !!${activePanel}.querySelector('.agenda-week, .empty-state')`, '面试筛选结果');
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
check('减少动态效果时页面没有入场动画', await ev(`matchMedia('(prefers-reduced-motion: reduce)').matches && getComputedStyle(document.querySelector('.page')).animationName === 'none'`));

if (!EXTERNAL) {
  // 仅在隔离浏览器模拟「今日行动」的加载、失败和空列表。
  const { identifier } = await send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
    const fetchOriginal = window.fetch.bind(window);
    let attempts = 0;
    window.fetch = (input, options) => {
      if (input !== '/api/workspace/today') return fetchOriginal(input, options);
      if (attempts++ === 0) return new Promise(resolve => {
        window.failTodayRequest = () => resolve(Response.json({ message: '测试加载失败' }, { status: 503 }));
      });
      return Promise.resolve(Response.json({ items: [] }));
    };
  })()` });
  await send('Page.navigate', { url: `${BASE}/` });
  await waitFor(`typeof window.failTodayRequest === 'function' && !!${today}`, '今日行动等待响应');
  check('加载待办时保持折叠并显示加载状态', await ev(`${todayCollapsed} && ${todaySummary}.textContent.includes('加载中')`));
  await ev(`${todaySummary}.click()`);
  await waitFor(`${today}.querySelector('.list-skeleton')?.checkVisibility()`, '展开后显示加载占位');
  await ev(`window.failTodayRequest()`);
  await waitFor(`${todaySummary}.textContent.includes('加载失败')`, '今日行动加载失败');
  await click('重试', '.today-queue');
  await waitFor(`${todaySummary}.textContent.includes('0 项')`, '今日行动重试后无待办');
  check('重试成功后保持展开并显示空状态', await ev(`${today}.open && ${today}.querySelector('.today-queue-body').textContent.includes('暂无待处理行动')`));
  await send('Page.removeScriptToEvaluateOnNewDocument', { identifier });
}

console.log('\nLOG:', logs.length ? logs.join('\n') : '(无控制台错误)');
const failed = results.filter((r) => !r.ok);
console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`);
process.exitCode = failed.length || logs.some((entry) => entry.startsWith('EXC ')) ? 1 : 0;
} finally {
  ws?.close();
  for (const child of [proc, server]) {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit').catch(() => {});
      child.kill();
      await Promise.race([exited, sleep(1500)]);
      if (child.pid && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  }
  for (const [directory, prefix] of [[profile, 'hireloop-ui-profile-'], [dataDir, 'hireloop-smoke-']]) {
    if (directory?.startsWith(join(tmpdir(), prefix))) {
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }
}
