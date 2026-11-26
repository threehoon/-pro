// 候选人详情头部「状态区」的端到端检查：在隔离数据库里走一遍
// 未投递 → 投递 → 安排面试 → 取消，核对头部四个状态的文案与按钮，并补一张零投递截图。
// 用法：node scripts/heading-state.mjs
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const outDir = fileURLToPath(new URL('../screenshots/', import.meta.url));

const APP_PORT = await new Promise((resolve, reject) => {
  const probe = createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(String(port)));
  });
});
const BASE = `http://127.0.0.1:${APP_PORT}`;
const dataDir = await mkdtemp(join(tmpdir(), 'hl-heading-'));
const env = { ...process.env, HIRELOOP_DATA_DIR: dataDir, HIRELOOP_DB_PATH: join(dataDir, 'app.db'), LLM_API_KEY: '', PORT: APP_PORT, NODE_ENV: 'production' };
spawnSync('node', ['server/src/db/seed.ts'], { env, stdio: 'ignore' });
const server = spawn('node', ['server/src/index.ts'], { env, stdio: 'ignore' });
let up = false;
for (let i = 0; i < 80; i += 1) {
  try {
    if ((await fetch(`${BASE}/api/health`)).ok) {
      up = true;
      break;
    }
  } catch {
    /* not ready */
  }
  await sleep(200);
}
if (!up) throw new Error(`隔离服务没能在 ${BASE} 启动`);
console.log(`使用隔离数据目录运行头部状态检查：${dataDir}`);

const PORT = 9498;
const profile = join(tmpdir(), `hl-heading-profile-${Date.now()}`);
const chrome = spawn(
  CHROME,
  [
    '--headless',
    '--disable-gpu',
    '--no-sandbox',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    `${BASE}/`,
  ],
  { stdio: 'ignore' },
);

let ws = null;
for (let i = 0; i < 80 && !ws; i += 1) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = list.find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
    if (page) ws = new WebSocket(page.webSocketDebuggerUrl);
  } catch {
    /* not ready */
  }
  if (!ws) await sleep(200);
}
if (!ws) throw new Error('Chrome DevTools 未就绪');
await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }));

let seq = 0;
const pending = new Map();
ws.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message.result ?? message.error);
    pending.delete(message.id);
  }
});
const send = (method, params = {}) =>
  new Promise((resolve) => {
    seq += 1;
    pending.set(seq, resolve);
    ws.send(JSON.stringify({ id: seq, method, params }));
  });
const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result?.value;
};
const waitFor = async (expression, label, tries = 80) => {
  for (let i = 0; i < tries; i += 1) {
    if (await evaluate(expression)) return true;
    await sleep(150);
  }
  throw new Error(`timeout waiting for ${label}`);
};
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
};
const headState = () =>
  evaluate(`(() => {
    const actions = document.querySelector('.profile-actions');
    const chips = [...actions.querySelectorAll('.status-chip')];
    return {
      chips: chips.length,
      jobChip: chips.some((c) => c.textContent.includes('职位')),
      interviewChip: chips.some((c) => c.textContent.includes('已安排面试')),
      interviewText: chips.find((c) => c.textContent.includes('已安排面试'))?.textContent.replace(/\\s+/g, ' ').trim(),
      scheduleBtn: [...actions.querySelectorAll('button')].some((b) => b.textContent.trim() === '安排初试'),
      applyLabel: [...actions.querySelectorAll('button')].map((b) => b.textContent.trim()).find((t) => t.includes('投递')),
      reround: [...document.querySelectorAll('#interviews button')].some((b) => b.textContent.includes('再安排一轮')),
    };
  })()`);

const verifyMobileAnchor = async (id) => {
  const hash = `#${id}`;
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await evaluate(`document.querySelector('.profile-actions a[href="${hash}"]').click()`);
  await waitFor(`location.hash === ${JSON.stringify(hash)}`, `anchor ${hash}`);
  await sleep(400);
  const anchor = await evaluate(`(() => {
    const card = document.querySelector('${hash}');
    const bar = document.querySelector('.topbar').getBoundingClientRect();
    const h2 = card.querySelector('h2').getBoundingClientRect();
    const hit = document.elementFromPoint(h2.left + 8, h2.top + 4);
    return {
      margin: parseFloat(getComputedStyle(card).scrollMarginTop),
      barBottom: Math.round(bar.bottom),
      cardTop: Math.round(card.getBoundingClientRect().top),
      h2Top: Math.round(h2.top),
      hit: hit?.tagName,
    };
  })()`);
  check(`${hash}：390px 下标题未被顶栏遮挡`, anchor.margin >= anchor.barBottom + 8 && anchor.hit === 'H2', JSON.stringify(anchor));
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
};

try {
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `${BASE}/` });
  await sleep(800);
  await evaluate(
    `fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'hr@hireloop.cn',password:'123'}),credentials:'same-origin'}).then(r=>r.status)`,
  );

  const createCandidate = (name, email) =>
    evaluate(`fetch('/api/candidates',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:${JSON.stringify(name)},email:${JSON.stringify(email)}}),credentials:'same-origin'}).then(r=>r.json()).then(d=>d.candidate?.id ?? d.id)`);
  const open = async (candidateId) => {
    await send('Page.navigate', { url: `${BASE}/candidates/${candidateId}` });
    await waitFor(`!!document.querySelector('.profile-head')`, 'candidate detail');
    await sleep(300);
  };

  // 1. 未投递
  const blankId = await createCandidate('未投递候选人', 'heading.blank@example.com');
  await open(blankId);
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  await writeFile(join(outDir, 'candidate-detail-no-application-1440.png'), Buffer.from(shot.data, 'base64'));
  let state = await headState();
  check('零投递：无状态 chip、保留「投递职位」', state.chips === 0 && state.applyLabel === '投递职位', JSON.stringify(state));

  // 2. 投递后
  await evaluate(
    `[...document.querySelectorAll('.profile-actions button')].find((b) => b.textContent.trim() === '投递职位').click()`,
  );
  await waitFor(`Boolean(document.querySelector('.modal select')?.value)`, 'apply options and default');
  await evaluate(`[...document.querySelectorAll('.modal button')].find((b) => b.textContent.includes('确认投递')).click()`);
  await waitFor(`!document.querySelector('.overlay')`, 'apply modal closed');
  await waitFor(`!!document.querySelector('.profile-actions .status-chip')`, 'job chip');
  state = await headState();
  check(
    '投递后：显示职位，筛选确认前隐藏排期入口',
    state.jobChip && !state.scheduleBtn && state.applyLabel === '投递其他职位',
    JSON.stringify(state),
  );

  // 3. 筛选推进后可安排初试
  await waitFor(`[...document.querySelectorAll('#screening button')].some(b => b.textContent.trim() === '推进初试' && !b.disabled)`, 'screening action');
  await evaluate(`[...document.querySelectorAll('#screening button')].find(b => b.textContent.trim() === '推进初试').click()`);
  await waitFor(`[...document.querySelectorAll('.profile-actions button')].some(b => b.textContent.trim() === '安排初试')`, 'schedule after screening');
  await evaluate(`[...document.querySelectorAll('.profile-actions button')].find((b) => b.textContent.trim() === '安排初试').click()`);
  await waitFor(`!!document.querySelector('.overlay .modal')`, 'schedule modal');
  await sleep(400);
  await evaluate(`[...document.querySelectorAll('.overlay .modal button')].find((b) => ['安排', '安排面试'].includes(b.textContent.trim())).click()`);
  await waitFor(`!document.querySelector('.overlay')`, 'schedule modal closed');
  await waitFor(`[...document.querySelectorAll('.profile-actions .status-chip')].some((c) => c.textContent.includes('已安排面试'))`, 'interview chip');
  state = await headState();
  check(
    '安排后：头部显示「已安排面试」与时间，不再有「安排面试」',
    state.interviewChip && !state.scheduleBtn,
    JSON.stringify(state),
  );
  check('初试去向尚未确认时，不能直接安排下一轮', !state.reround, String(state.reround));

  await verifyMobileAnchor('interviews');

  // 4. 取消后回到可排期
  const interviewId = await evaluate(
    `fetch('/api/candidates/${blankId}',{credentials:'same-origin'}).then(r=>r.json()).then(d=>d.interviews[0]?.id)`,
  );
  await evaluate(
    `fetch('/api/interviews/${interviewId}/cancel',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({note:'头部状态检查'}),credentials:'same-origin'}).then(r=>r.status)`,
  );
  await open(blankId);
  state = await headState();
  // 没有待进行场次时头部已经有「安排面试」，卡片不再重复同一个入口
  check(
    '取消后：头部回到「安排面试」，卡片不再重复入口',
    !state.interviewChip && state.scheduleBtn && !state.reround,
    JSON.stringify(state),
  );

  // 5. 先核对已入职投递，再从投递记录选中另一条投递并排期。
  const openJobs = await evaluate(
    `fetch('/api/jobs',{credentials:'same-origin'}).then(r=>r.json()).then(d=>d.items.filter(j=>j.status==='open').map(j=>({id:j.id,title:j.title})))`,
  );
  const candidateDetail = () => evaluate(`fetch('/api/candidates/${blankId}').then(r => r.json())`);
  const { applications: [firstApplication] } = await candidateDetail();
  const hiredTarget = openJobs.find((job) => job.id !== firstApplication.job_id);
  if (!hiredTarget) throw new Error('隔离库里可投递的职位不足，无法验证已入职分支');
  const extraId = await evaluate(
    `fetch('/api/applications',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jobId:${JSON.stringify(hiredTarget.id)},candidateId:${JSON.stringify(blankId)}}),credentials:'same-origin'}).then(r=>r.json()).then(d=>d.application?.id ?? d.id)`,
  );
  const hireStatus = await evaluate(`(async () => {
    const app = '/api/applications/${extraId}';
    async function mutate(url, body, method = 'POST') {
      const response = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (!response.ok) throw new Error(url + ': ' + response.status);
      return response.json();
    }
    await mutate(app + '/screening', { decision: 'advance' });
    const { interview } = await mutate('/api/interviews', { applicationId: '${extraId}', scheduledAt: new Date(Date.now() - 3600000).toISOString(), mode: 'video' });
    const record = '/api/interviews/' + interview.id;
    await mutate(record + '/summary/manual', { conclusion: '岗位相关经历已核实' });
    await mutate(record + '/decide', { decision: 'negotiate' });
    const offer = app + '/offer';
    await mutate(offer, { final_salary: 20000, start_date: '2030-04-10', reply_deadline: '2030-04-03' }, 'PUT');
    await mutate(offer + '/send', {});
    await mutate(offer + '/accept', {});
    await mutate(offer + '/hire', {});
    return (await fetch(app).then(r => r.json())).application.stage;
  })()`);
  await open(blankId);
  state = await headState();
  const hiredJobVisible = await evaluate(`document.querySelector('.profile-actions .status-chip')?.textContent.includes('已入职')`);
  check('默认查看已入职投递时隐藏排期入口', hireStatus === 'hired' && !state.scheduleBtn && hiredJobVisible, JSON.stringify(state));
  await verifyMobileAnchor('applications');

  await evaluate(`[...document.querySelectorAll('.profile-actions button')].find(b => b.textContent.trim() === '投递其他职位').click()`);
  await waitFor(`document.querySelector('.modal select')?.options.length > 1`, 'remaining application options');
  const optionIds = await evaluate(`[...document.querySelectorAll('.modal select option')].map(option => option.value).filter(Boolean)`);
  const appliedIds = [firstApplication.job_id, hiredTarget.id];
  check('投递其他职位不会显示已投过的岗位', optionIds.every((id) => !appliedIds.includes(id)), JSON.stringify(optionIds));
  await evaluate(`[...document.querySelectorAll('.modal button')].find(b => b.textContent.trim() === '取消').click()`);
  await waitFor(`!document.querySelector('.overlay')`, 'apply modal closed');
  const selectWorkflow = `[...document.querySelectorAll('#applications a')].find(a => a.textContent.trim() === '查看流程' && new URL(a.href).searchParams.get('application') === ${JSON.stringify(firstApplication.id)})`;
  await waitFor(`Boolean(${selectWorkflow})`, 'other application workflow link');
  await evaluate(`${selectWorkflow}.click()`);
  await waitFor(`[...document.querySelectorAll('.profile-actions button')].some(b => b.textContent.trim() === '安排初试')`, 'schedule on selected application');
  await evaluate(
    `[...document.querySelectorAll('.profile-actions button')].find((b) => b.textContent.trim() === '安排初试').click()`,
  );
  await waitFor(`Boolean(document.querySelector('.modal input[type=datetime-local]')?.value)`, 'schedule modal initialized');
  const showsApplicationSelect = await evaluate(`[...document.querySelectorAll('.modal .field-label')].some(el => el.textContent.includes('投递职位'))`);
  check('只剩一个可安排职位时不用再选择', !showsApplicationSelect);
  await evaluate(`[...document.querySelectorAll('.modal button')].find(b => b.textContent.trim() === '安排').click()`);
  await waitFor(`!document.querySelector('.overlay')`, 'schedule modal closed');
  const { interviews: persistedInterviews } = await candidateDetail();
  const pending = persistedInterviews.filter((item) => item.status === 'scheduled');
  check('直接提交排入正确的投递记录', pending.length === 1 && pending[0].application_id === firstApplication.id, `${pending.length} 场待进行`);
} finally {
  console.log(`\n结果：${results.filter((item) => item.ok).length}/${results.length} 通过`);
  try {
    await send('Browser.close');
  } catch {
    /* ignore */
  }
  chrome.kill('SIGTERM');
  server.kill('SIGTERM');
  // 等 Chrome 真正退出再删 profile，否则它会在删除后又写回目录
  if (chrome.exitCode === null) await Promise.race([once(chrome, 'exit'), sleep(5000)]).catch(() => {});
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
}

process.exit(results.every((item) => item.ok) ? 0 : 1);
