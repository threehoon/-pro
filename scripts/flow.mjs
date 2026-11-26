import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const noLlm = process.argv.includes('--no-llm');
const externalBase = process.env.FLOW_BASE;
const apiKey = process.env.LLM_API_KEY;
if (!noLlm && !externalBase && !apiKey) {
  throw new Error('实测需要 FLOW_BASE（网页已配置模型）或 LLM_API_KEY。离线回归请用 npm run flow -- --no-llm。');
}
if (noLlm && externalBase) throw new Error('离线模式使用隔离数据库，请移除 FLOW_BASE。');
const started = performance.now();
let app;
let closeDb;
let scratch;
let cookie;

async function request(method, pathname, payload, { multipart, data = false } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (multipart) headers['content-type'] = multipart;
  else if (payload !== undefined) headers['content-type'] = 'application/json';
  const body = multipart || payload === undefined ? payload : JSON.stringify(payload);
  let status;
  let json;
  if (app) {
    const response = await app.inject({ method, url: pathname, headers, payload: body });
    status = response.statusCode;
    const session = response.headers['set-cookie'];
    if (typeof session === 'string') cookie = session.split(';')[0];
    json = response.json();
  } else {
    const response = await fetch(new URL(pathname, externalBase), { method, headers, body });
    status = response.status;
    const session = response.headers.get('set-cookie');
    if (session) cookie = session.split(';')[0];
    json = await response.json();
  }
  assert.ok(status >= 200 && status < 300 && json.ok !== false, `${method} ${pathname}: HTTP ${status}`);
  return data ? json.data : json;
}

async function until(pathname, predicate) {
  const deadline = Date.now() + 65_000;
  while (Date.now() < deadline) {
    const result = await request('GET', pathname, undefined, { data: true });
    if (predicate(result)) return result;
    assert.notEqual(result.status, 'failed', `${pathname} 生成失败`);
    await delay(400);
  }
  throw new Error(`${pathname} 等待结果超时`);
}

async function step(label, action) {
  const before = performance.now();
  const result = await action();
  console.log(`✓ ${label} ${Math.round(performance.now() - before)} ms`);
  return result;
}

const resume = '张晨\n前端工程师\n2021-2025 任职于产品研发团队，负责 React、TypeScript 前端开发。曾将列表虚拟化，渲染时间从 650 毫秒降到 240 毫秒。带领两人重构组件库。\n技能：React、TypeScript、前端性能优化。';
const transcript1 = '面试官：可否介绍一项前端性能优化？\n候选人：我负责一个 React 列表，数据规模从几百到了几万条。我用浏览器性能面板确认卡顿来自渲染，改为窗口化渲染，渲染时间从 650 毫秒降到 240 毫秒。上线先选内部用户，记录性能指标和异常，再逐步扩量。\n面试官：怎样保证改动不会破坏原有交互？\n候选人：我补了键盘导航、选中状态、滚动恢复这三类回归。我把回归用例分配给自己和另一位同事，向产品确认可接受的取舍，最后对照上线前的样本验证。团队每周一起复查指标，发现差异会先核对采样定义。';
const transcript2 = '面试官：一面提到逐步扩量，能否补充低端设备上的验收标准？\n候选人：我们分别观察桌面和低端手机，后者从 820 毫秒降到 360 毫秒。我预先和产品确认不能影响键盘导航和滚动恢复，低端机的试运行样本来自内部反馈。\n面试官：如果数据不达标，谁推进回滚？\n候选人：我和另外两位同事先复现，然后开关切回旧实现。我负责提供日志和趋势表，值班同事负责执行回滚。每次发布都要先确认开关可用，恢复后还会验证页面行为和告警。候选方案写进文档，下一次重试前会增加一轮无障碍验收。';

async function schedule(applicationId, round, draftId) {
  const payload = { applicationId, round, scheduledAt: new Date(Date.now() - 3600_000).toISOString(), mode: 'video' };
  const scheduled = await request(draftId ? 'PATCH' : 'POST', draftId ? `/api/interviews/${draftId}` : '/api/interviews', payload);
  assert.equal(scheduled.interview.round, round);
  return `/api/interviews/${scheduled.interview.id}`;
}

async function summarize(interview, transcript) {
  await request('PUT', `${interview}/transcript`, { transcript }, { data: true });
  if (noLlm) {
    await request('POST', `${interview}/summary/manual`, { conclusion: '流程验证用结论' }, { data: true });
    return;
  }
  const result = await until(`${interview}/summary`, (value) => value.status === 'ready');
  assert.ok(result.summary?.headline);
  const quotes = [...(result.summary.highlights ?? []), ...(result.summary.concerns ?? [])].map((item) => item.quote).filter(Boolean);
  assert.ok(quotes.length > 0, '面试总结缺少可核对的原话');
  assert.ok(quotes.every((quote) => transcript.includes(quote)), '面试总结引用与原文不一致');
}

try {
  if (!externalBase) {
    scratch = await mkdtemp(path.join(tmpdir(), 'hireloop-flow-'));
    process.env.HIRELOOP_DATA_DIR = scratch;
    process.env.HIRELOOP_DB_PATH = path.join(scratch, 'flow.db');
    process.env.NODE_ENV = 'test';
    if (noLlm) delete process.env.LLM_API_KEY;
    ({ closeDb } = await import('../server/src/db/index.ts'));
    const { buildApp } = await import('../server/src/app.ts');
    app = await buildApp();
    await app.ready();
    await request('POST', '/api/auth/register', {
      name: '流程测试', email: 'flow@example.test', password: randomUUID(),
    });
  } else {
    assert.ok(process.env.FLOW_EMAIL && process.env.FLOW_PASSWORD, '请提供测试账号 FLOW_EMAIL 和 FLOW_PASSWORD');
    await request('POST', '/api/auth/login', { email: process.env.FLOW_EMAIL, password: process.env.FLOW_PASSWORD });
  }
  if (!noLlm) {
    if (apiKey) {
      assert.ok(app, '已有服务请在网页完成模型配置');
      await request('POST', '/api/settings/llm', { apiKey, baseUrl: process.env.LLM_BASE_URL, model: process.env.LLM_MODEL }, { data: true });
    }
    await step('验证模型连接', () => request('POST', '/api/settings/llm/test', {}, { data: true }));
  }

  const job = await step(noLlm ? '建岗' : '建岗并确认画像', async () => {
    const tag = randomUUID().slice(0, 8);
    const { job } = await request('POST', '/api/jobs', {
      title: `[流程验证 ${tag}] 前端工程师`, requirements: '熟悉 React 和 TypeScript，能独立定位前端性能问题，并与产品共同验收。',
      skills: ['React', 'TypeScript'], salary_min: 16000, salary_max: 24000,
    });
    if (!noLlm) {
      const { profile } = await until(`/api/jobs/${job.id}/profile`, (value) => value.status === 'ready' && Boolean(value.profile));
      const { indicators } = profile.content;
      assert.equal(indicators.length, 4);
      assert.equal(indicators.reduce((sum, item) => sum + item.weight, 0), 100);
      assert.ok(indicators.every((item) => item.labels.every((label) => Object.keys(label.tiers).length === 5)));
      await request('POST', `/api/jobs/${job.id}/profile/approve`, {}, { data: true });
    }
    return job;
  });

  const applicationId = await step('上传简历并确认约面', async () => {
    const { candidate } = await request('POST', '/api/candidates', { name: '张晨（流程验证）', email: `flow-${randomUUID()}@example.test` });
    const boundary = `hireloop-${randomUUID()}`;
    const multipart = `multipart/form-data; boundary=${boundary}`;
    const body = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="resume.txt"\r\nContent-Type: text/plain\r\n\r\n${resume}\r\n--${boundary}--\r\n`;
    const { file } = await request('POST', '/api/uploads/resume', body, { multipart });
    await request('POST', `/api/candidates/${candidate.id}/resume`, { fileId: file.id });
    const { application } = await request('POST', '/api/applications', { jobId: job.id, candidateId: candidate.id });
    const endpoint = `/api/applications/${application.id}/screening`;
    const { review } = await until(endpoint, (value) => value.status === 'ready' && Boolean(value.review));
    if (!noLlm) {
      assert.equal(review.detail.source, 'ai');
      assert.ok(Number.isFinite(review.score));
      assert.ok(review.unknownWeight > 0);
      const quotes = (review.detail.labels ?? []).map((item) => item.quote).filter(Boolean);
      assert.ok(quotes.length > 0 && quotes.every((quote) => resume.includes(quote)), '简历筛选引用与原文不一致');
    }
    const result = await request('POST', endpoint, { decision: 'advance' });
    assert.equal(result.application.stage, 'interview');
    return application.id;
  });

  const application = `/api/applications/${applicationId}`;
  await step(noLlm ? '初试结论及复试草稿' : '初试提纲、总结与复试草稿', async () => {
    const first = await schedule(applicationId, 1);
    if (!noLlm) await until(`${first}/summary`, (value) => value.plan?.questions?.length === 5);
    await summarize(first, transcript1);
    await request('POST', `${first}/decide`, { decision: 'advance', allowWithoutSummary: noLlm });
  });
  await step(noLlm ? '复试结论及人工确认' : '复试总结和综合评估', async () => {
    const detail = await request('GET', application);
    const draft = detail.interviews.find((item) => item.round === 2 && item.is_draft === 1);
    assert.ok(draft);
    const second = await schedule(applicationId, 2, draft.id);
    await summarize(second, transcript2);
    if (!noLlm) await until(`${application}/composite`, (value) => value.status === 'ready' && Boolean(value.composite));
    await request('POST', `${second}/decide`, { decision: 'negotiate', allowWithoutSummary: noLlm });
  });
  await step('谈薪、记录发出 Offer、接受并入职', async () => {
    const offer = `${application}/offer`;
    const startDate = new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10);
    const deadline = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
    const terms = await request('PUT', offer, { expected_salary: 25000, final_salary: 23500, start_date: startDate, reply_deadline: deadline });
    assert.equal(terms.difference, 1000);
    assert.equal((await request('POST', `${offer}/send`, {})).offer.status, 'sent');
    assert.equal((await request('POST', `${offer}/accept`, {})).offer.status, 'accepted');
    await request('POST', `${offer}/hire`, {});
    const detail = await request('GET', application);
    assert.equal(detail.application.stage, 'hired');
    assert.ok(detail.application.hired_at);
  });
  if (!noLlm) {
    const stats = await request('GET', '/api/settings/llm', undefined, { data: true });
    console.log(`模型用量（当前工作台累计） ${stats.tokensIn} 入 / ${stats.tokensOut} 出`);
  }
  console.log(`招聘流程通过，共 ${Math.round(performance.now() - started)} ms`);
} finally {
  await app?.close();
  closeDb?.();
  if (scratch && path.dirname(scratch) === tmpdir() && path.basename(scratch).startsWith('hireloop-flow-')) {
    await rm(scratch, { recursive: true, force: true });
  }
}
