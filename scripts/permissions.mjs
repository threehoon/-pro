// 浏览器端权限冒烟：管理员添加成员 → 成员登录后看不到删除/飞书配置入口。
// 用法：node scripts/permissions.mjs [--base http://127.0.0.1:8787]
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const args = process.argv.slice(2);
const baseIndex = args.indexOf('--base');
const PORT = 9345;

// 默认自带隔离数据（临时目录 + 系统分配的端口），跑完即删，不会在演示库里留下测试成员。
const sleeps = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let appServer = null;
let appDataDir = null;
let base = baseIndex >= 0 ? args[baseIndex + 1] : '';
if (baseIndex < 0) {
  const appPort = await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(String(port)));
    });
  });
  base = `http://127.0.0.1:${appPort}`;
  appDataDir = await mkdtemp(join(tmpdir(), 'hireloop-perm-data-'));
  const env = { ...process.env, HIRELOOP_DATA_DIR: appDataDir, PORT: appPort, NODE_ENV: 'production' };
  spawnSync('node', ['server/src/db/seed.ts'], { env, stdio: 'ignore' });
  appServer = spawn('node', ['server/src/index.ts'], { env, stdio: 'ignore' });
  let up = false;
  for (let i = 0; i < 80; i += 1) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) { up = true; break; }
    } catch {}
    await sleeps(250);
  }
  if (!up) throw new Error(`隔离的权限冒烟服务没能在 ${base} 启动`);
  console.log(`使用隔离数据目录运行权限冒烟：${appDataDir}`);
}
const profile = await mkdtemp(join(tmpdir(), 'hireloop-perm-'));

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

const logs = [];
await send('Runtime.enable');
await send('Page.enable');
ws.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
    logs.push(message.params.args.map((arg) => arg.value ?? arg.description).join(' '));
  }
});

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  }
  return result.result.value;
}

async function waitFor(expression, label, timeout = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await evaluate(`Boolean(${expression})`)) return true;
    await sleep(120);
  }
  throw new Error(`等待超时：${label}`);
}

async function goto(path) {
  await send('Page.navigate', { url: `${base}${path}` });
  await waitFor(`document.readyState === 'complete'`, `加载 ${path}`);
  await sleep(400);
}

async function login(email, password) {
  await goto('/');
  const ok = await evaluate(`(async () => {
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: ${JSON.stringify(email)}, password: ${JSON.stringify(password)} }),
    });
    return response.ok;
  })()`);
  if (!ok) throw new Error(`登录失败：${email}`);
  await goto('/');
  await waitFor(`!document.querySelector('.auth-screen')`, '进入工作台');
}

const results = [];
function check(name, passed, detail = '') {
  results.push({ name, passed, detail });
  console.log(`${passed ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const memberEmail = `member.${Date.now()}@hireloop.cn`;
const memberPassword = 'memberpass123';

try {
  await login('hr@hireloop.cn', '123');

  // 1) 管理员能看到添加成员并成功创建
  await goto('/settings');
  await waitFor(`[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === '添加成员')`, '添加成员按钮');
  await evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '添加成员').click()`);
  await waitFor(`document.querySelectorAll('.team-add-form input').length >= 3`, '创建成员表单');

  await evaluate(`(() => {
    const inputs = document.querySelectorAll('.team-add-form input');
    const set = (el, value) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    set(inputs[0], '权限验证成员');
    set(inputs[1], ${JSON.stringify(memberEmail)});
    set(inputs[2], ${JSON.stringify(memberPassword)});
    const select = document.querySelector('.team-add-form select');
    if (select) {
      const option = [...select.options].find((item) => item.value === 'recruiter');
      if (option) {
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, option.value);
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
    return inputs.length;
  })()`);
  await evaluate(`[...document.querySelectorAll('.team-add-form button')].find((b) => b.textContent.trim() === '创建成员').click()`);
  await waitFor(`document.querySelectorAll('.team-list li').length >= 4`, '成员列表增加', 10000);
  const teamCount = await evaluate(`document.querySelectorAll('.team-list li').length`);
  check('管理员添加成员', teamCount >= 4, `成员 ${teamCount} 人`);

  // 2) 成员登录后：设置页没有添加成员/飞书表单
  await evaluate(`fetch('/api/auth/logout', { method: 'POST' })`);
  await login(memberEmail, memberPassword);
  await goto('/settings');
  await waitFor(`!document.querySelector('.settings-section') === false || document.body.textContent.includes('只有管理员')`, '设置页加载');
  const memberView = await evaluate(`(() => ({
    addButton: [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === '添加成员'),
    feishuInputs: document.querySelectorAll('.feishu-form input').length,
    note: document.body.textContent.includes('只有管理员可以添加成员或修改角色'),
    roleSelects: document.querySelectorAll('.role-select').length,
  }))()`);
  check('成员看不到添加成员', memberView.addButton === false);
  check('成员看不到飞书凭据表单', memberView.feishuInputs === 0, `输入框 ${memberView.feishuInputs}`);
  check('成员看到只读说明', memberView.note === true);
  check('成员不能改角色', memberView.roleSelects === 0, `下拉 ${memberView.roleSelects}`);

  // 3) 成员在候选人详情页没有删除按钮
  const candidateId = await evaluate(`(async () => {
    const response = await fetch('/api/candidates?pageSize=1');
    const data = await response.json();
    return data.items?.[0]?.id ?? '';
  })()`);
  if (candidateId) {
    await goto(`/candidates/${candidateId}`);
    await waitFor(`!!document.querySelector('.profile-head')`, '候选人详情');
    const hasDelete = await evaluate(
      `[...document.querySelectorAll('button')].some((b) => (b.getAttribute('aria-label') ?? '') === '删除候选人')`,
    );
    check('成员看不到删除候选人', hasDelete === false);
  } else {
    check('成员看不到删除候选人', true, '无候选数据，跳过');
  }

  // 4) 直接调接口也会被拦
  const apiGuard = await evaluate(`(async () => {
    const feishu = await fetch('/api/settings/feishu', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app_id: 'cli_hacked' }),
    });
    const jobList = await (await fetch('/api/jobs')).json();
    const jobId = jobList.items?.[0]?.id;
    const remove = await fetch('/api/jobs/' + jobId, { method: 'DELETE' });
    return { feishu: feishu.status, remove: remove.status };
  })()`);
  check('成员改飞书配置被拒', apiGuard.feishu === 403, `HTTP ${apiGuard.feishu}`);
  check('成员删除职位被拒', apiGuard.remove === 403, `HTTP ${apiGuard.remove}`);

  check('无控制台错误', logs.length === 0, logs.join(' | '));
} catch (error) {
  console.error('✗ 执行中断：', error instanceof Error ? error.message : error);
  results.push({ name: '执行中断', passed: false, detail: String(error) });
} finally {
  const failed = results.filter((item) => !item.passed);
  console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`);
  ws.close();
  chrome.kill();
  if (appServer) appServer.kill();
  if (appDataDir) await rm(appDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  // Chrome 退出时可能仍持有临时目录，清理失败不影响结论
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  if (failed.length) process.exitCode = 1;
}
