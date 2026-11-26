import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dataDir = mkdtempSync(path.join(tmpdir(), 'hireloop-test-'));
process.env.HIRELOOP_DATA_DIR = dataDir;
process.env.HIRELOOP_DB_PATH = path.join(dataDir, 'test.db');
delete process.env.LLM_API_KEY;
process.env.NODE_ENV = 'test';

const { buildApp } = await import('../src/app.ts');
const { closeDb, run, getRow } = await import('../src/db/index.ts');

let app: Awaited<ReturnType<typeof buildApp>>;
let cookie = '';

function authHeaders() {
  return { cookie };
}

before(async () => {
  app = await buildApp();
  await app.ready();
});

after(async () => {
  await app.close();
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

test('注册首个用户成为管理员并自动登录', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { name: '测试招聘官', email: 'qa@hireloop.cn', password: 'password123' },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.user.role, 'admin');
  const setCookie = res.headers['set-cookie'];
  assert.ok(setCookie);
  cookie = String(setCookie).split(';')[0]!;
});

test('设置了账号名之后可以用账号名登录，邮箱也仍然可用', async () => {
  const row = getRow<{ id: string }>('SELECT id FROM users WHERE email = ?', ['qa@hireloop.cn']);
  assert.ok(row);
  run('UPDATE users SET username = ? WHERE id = ?', ['123', row.id]);

  const byName = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: '123', password: 'password123' },
  });
  assert.equal(byName.statusCode, 200);
  assert.equal(byName.json().user.email, 'qa@hireloop.cn');

  const byEmail = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: 'qa@hireloop.cn', password: 'password123' },
  });
  assert.equal(byEmail.statusCode, 200);

  const wrong = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: '123', password: 'nope' },
  });
  assert.equal(wrong.statusCode, 401);
  assert.equal(wrong.json().error.message, '账号或密码不正确');
});

test('未登录访问受保护接口返回 401', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/jobs' });
  assert.equal(res.statusCode, 401);
});

test('创建职位并出现在列表中', async () => {
  const create = await app.inject({
    method: 'POST',
    url: '/api/jobs',
    headers: authHeaders(),
    payload: { title: '前端工程师', department: '研发', headcount: 2, skills: ['React', 'TypeScript'] },
  });
  assert.equal(create.statusCode, 201);
  const listed = await app.inject({ method: 'GET', url: '/api/jobs', headers: authHeaders() });
  const body = listed.json();
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0].title, '前端工程师');
  assert.deepEqual(body.items[0].skills, ['React', 'TypeScript']);
});

test('重复邮箱创建候选人返回 409', async () => {
  const payload = { name: '王五', email: 'wang@example.com' };
  const first = await app.inject({ method: 'POST', url: '/api/candidates', headers: authHeaders(), payload });
  assert.equal(first.statusCode, 201);
  const second = await app.inject({ method: 'POST', url: '/api/candidates', headers: authHeaders(), payload });
  assert.equal(second.statusCode, 409);
});

test('新投递直接待筛选，归档后可恢复原阶段', async () => {
  const jobs = (await app.inject({ method: 'GET', url: '/api/jobs', headers: authHeaders() })).json();
  const jobId = jobs.items[0].id;
  const candidates = (await app.inject({ method: 'GET', url: '/api/candidates', headers: authHeaders() })).json();
  const candidateId = candidates.items[0].id;

  const applied = await app.inject({
    method: 'POST',
    url: '/api/applications',
    headers: authHeaders(),
    payload: { jobId, candidateId },
  });
  assert.equal(applied.statusCode, 201);
  const applicationId = applied.json().application.id;

  const dup = await app.inject({
    method: 'POST',
    url: '/api/applications',
    headers: authHeaders(),
    payload: { jobId, candidateId },
  });
  assert.equal(dup.statusCode, 409);

  assert.equal(applied.json().application.stage, 'screening');

  const rejected = await app.inject({
    method: 'POST',
    url: `/api/applications/${applicationId}/reject`,
    headers: authHeaders(),
    payload: { reason: '技能不匹配' },
  });
  assert.equal(rejected.statusCode, 200);
  assert.equal(rejected.json().application.status, 'rejected');

  const blocked = await app.inject({
    method: 'POST', url: `/api/applications/${applicationId}/screening`, headers: authHeaders(),
    payload: { decision: 'advance' },
  });
  assert.equal(blocked.statusCode, 400);

  const reopened = await app.inject({
    method: 'POST',
    url: `/api/applications/${applicationId}/reopen`,
    headers: authHeaders(),
    payload: {},
  });
  assert.equal(reopened.statusCode, 200);
  assert.equal(reopened.json().application.status, 'active');

  const board = (await app.inject({ method: 'GET', url: `/api/jobs/${jobId}/board`, headers: authHeaders() })).json();
  const screening = board.columns.find((column: { stage: string }) => column.stage === 'screening');
  assert.equal(screening.count, 1);
});

test('两轮面试、综合评估与 Offer 按人确认顺序推进', async () => {
  const jobs = (await app.inject({ method: 'GET', url: '/api/jobs', headers: authHeaders() })).json();
  const jobId = jobs.items[0].id;
  const boardUrl = `/api/jobs/${jobId}/board`;
  const board = (await app.inject({ url: boardUrl, headers: authHeaders() })).json();
  const card = board.columns.flatMap((column: { cards: Array<{ id: string }> }) => column.cards)[0]!;
  const applicationUrl = `/api/applications/${card.id}`;
  const send = (method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: Record<string, unknown>) =>
    app.inject({ method, url, headers: authHeaders(), payload });
  const interviewInput = { applicationId: card.id, scheduledAt: '2026-12-01T02:00:00.000Z', mode: 'video' };
  assert.equal((await send('POST', '/api/interviews', interviewInput)).statusCode, 400);
  assert.equal((await send('PATCH', `${applicationUrl}/stage`, { stage: 'hired' })).statusCode, 404);
  assert.equal((await send('POST', `${applicationUrl}/screening`, { decision: 'advance' })).json().application.stage, 'interview');
  assert.equal((await send('POST', '/api/interviews', { ...interviewInput, round: 2 })).statusCode, 400);
  const first = await send('POST', '/api/interviews', interviewInput);
  assert.equal(first.statusCode, 201, first.body);
  const firstId = first.json().interview.id;
  assert.equal((await send('POST', '/api/interviews', interviewInput)).statusCode, 400);
  assert.equal((await send('POST', `/api/interviews/${firstId}/complete`, { score: 5, feedback: 'legacy' })).statusCode, 404);
  assert.equal((await send('POST', `/api/interviews/${firstId}/decide`, { decision: 'advance' })).statusCode, 400);
  assert.equal((await send('POST', `/api/interviews/${firstId}/decide`, { decision: 'advance', allowWithoutSummary: true })).statusCode, 400);
  const manual = await send('POST', `/api/interviews/${firstId}/summary/manual`, { conclusion: '按本轮沟通结果进入复试' });
  assert.equal(manual.statusCode, 200, manual.body);
  const advanced = await send('POST', `/api/interviews/${firstId}/decide`, { decision: 'advance' });
  assert.equal(advanced.statusCode, 200, advanced.body);
  assert.equal('score' in advanced.json().interview, false);
  const draft = getRow<{ id: string; is_draft: number }>('SELECT id, is_draft FROM interviews WHERE application_id = ? AND round = 2', [card.id]);
  assert.equal(draft?.is_draft, 1);
  const agenda = (await send('GET', `/api/interviews?applicationId=${card.id}`)).json();
  assert.equal(agenda.items.some((item: { id: string }) => item.id === draft?.id), false);
  const today = (await send('GET', '/api/workspace/today')).json();
  assert.ok(today.items.length <= 5);
  assert.ok(today.items.some((item: { title: string; applicationId: string }) => item.applicationId === card.id && item.title.includes('安排复试')));
  // 按职位取待办时先过滤再限条数，概览不会因为别的职位占满 5 条而误报「今天没事」。
  const jobToday = (await send('GET', `/api/workspace/today?jobId=${jobId}`)).json();
  assert.ok(jobToday.items.length > 0);
  assert.ok(jobToday.items.every((item: { jobId: string }) => item.jobId === jobId));
  const emptyToday = (await send('GET', '/api/workspace/today?jobId=job_missing')).json();
  assert.deepEqual(emptyToday.items, []);
  assert.equal((await send('GET', '/api/workspace/today?jobId=')).statusCode, 400);
  const secondUrl = `/api/interviews/${draft?.id}`;
  const scheduled = await send('PATCH', secondUrl, { scheduledAt: '2026-12-02T02:00:00.000Z' });
  assert.equal(scheduled.json().interview.is_draft, 0);
  assert.equal((await send('POST', `${secondUrl}/decide`, { decision: 'advance', allowWithoutSummary: true })).statusCode, 400);
  run("UPDATE interviews SET summary_status = 'ready' WHERE id = ?", [draft?.id]);
  run("UPDATE applications SET composite_status = 'generating' WHERE id = ?", [card.id]);
  assert.equal((await send('POST', `${secondUrl}/decide`, { decision: 'negotiate', allowWithoutSummary: true })).statusCode, 400);
  run("UPDATE applications SET composite_status = 'ready' WHERE id = ?", [card.id]);
  const negotiated = await send('POST', `${secondUrl}/decide`, { decision: 'negotiate' });
  assert.equal(negotiated.statusCode, 200, negotiated.body);
  assert.equal(negotiated.json().offer.status, 'negotiating');

  const offerUrl = `${applicationUrl}/offer`;
  assert.equal((await send('POST', `${offerUrl}/send`, {})).statusCode, 400);
  assert.equal((await send('POST', `${offerUrl}/hire`, {})).statusCode, 400);
  const terms = { expected_salary: 20000, final_salary: 19000, start_date: '2026-12-14', reply_deadline: '2026-12-09' };
  assert.equal((await send('PUT', offerUrl, { ...terms, reply_deadline: '2026-12-15' })).statusCode, 400);
  assert.match((await send('PUT', offerUrl, terms)).json().template, /19,000/);
  assert.equal((await send('POST', `${offerUrl}/send`, {})).json().offer.status, 'sent');
  assert.equal((await send('POST', `${offerUrl}/hire`, {})).statusCode, 400);
  assert.equal((await send('POST', `${offerUrl}/decline`, {})).json().offer.status, 'declined');
  assert.equal((await send('GET', applicationUrl)).json().application.status, 'rejected');
  assert.equal((await send('POST', `${applicationUrl}/reopen`, {})).json().application.stage, 'offer');
  assert.equal((await send('GET', offerUrl)).json().offer.status, 'negotiating');
  assert.equal((await send('POST', `${offerUrl}/send`, {})).json().offer.status, 'sent');
  assert.equal((await send('POST', `${offerUrl}/accept`, {})).json().offer.status, 'accepted');
  assert.equal((await send('POST', `${offerUrl}/hire`, {})).statusCode, 200);
  const hired = (await send('GET', applicationUrl)).json().application;
  assert.equal(hired.stage, 'hired');
  assert.ok(hired.hired_at);
  assert.equal((await send('POST', `${applicationUrl}/reject`, { reason: '其他' })).statusCode, 400);
  assert.equal((await send('POST', '/api/interviews', interviewInput)).statusCode, 400);
  assert.equal((await send('GET', `/api/jobs/${jobs.items[0].id}`)).json().stats.hired, 1);
});

test('工作台返回漏斗与 KPI', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/dashboard', headers: authHeaders() });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.funnel.length, 5);
  assert.equal(typeof body.kpis.openJobs, 'number');
});

test('飞书配置默认关闭，保存后 ready 状态联动', async () => {
  const initial = (await app.inject({ method: 'GET', url: '/api/settings/feishu', headers: authHeaders() })).json();
  assert.equal(initial.configured, false);
  assert.equal(initial.ready.login, false);

  const saved = (
    await app.inject({
      method: 'PUT',
      url: '/api/settings/feishu',
      headers: authHeaders(),
      payload: { app_id: 'cli_demo', app_secret: 'secret' },
    })
  ).json();
  assert.equal(saved.configured, true);
  assert.equal(saved.ready.login, true);
});

test('单边修改薪资也会校验区间', async () => {
  const jobs = (await app.inject({ method: 'GET', url: '/api/jobs', headers: authHeaders() })).json();
  const jobId = jobs.items[0].id;
  await app.inject({
    method: 'PATCH',
    url: `/api/jobs/${jobId}`,
    headers: authHeaders(),
    payload: { salary_min: 30000, salary_max: 40000 },
  });
  const res = await app.inject({
    method: 'PATCH',
    url: `/api/jobs/${jobId}`,
    headers: authHeaders(),
    payload: { salary_max: 10000 },
  });
  assert.equal(res.statusCode, 400);
});

test('面试官不存在时更新面试返回 400 而不是 500', async () => {
  const job = (
    await app.inject({ method: 'POST', url: '/api/jobs', headers: authHeaders(), payload: { title: '面试官校验岗' } })
  ).json().job;
  const candidate = (
    await app.inject({
      method: 'POST',
      url: '/api/candidates',
      headers: authHeaders(),
      payload: { name: '面试官校验候选人', email: 'interviewer-check@example.com' },
    })
  ).json().candidate;
  const application = (
    await app.inject({
      method: 'POST',
      url: '/api/applications',
      headers: authHeaders(),
      payload: { jobId: job.id, candidateId: candidate.id },
    })
  ).json().application;

  const screened = await app.inject({
    method: 'POST', url: `/api/applications/${application.id}/screening`, headers: authHeaders(), payload: { decision: 'advance' },
  });
  assert.equal(screened.statusCode, 200);

  const scheduled = (
    await app.inject({
      method: 'POST',
      url: '/api/interviews',
      headers: authHeaders(),
      payload: { applicationId: application.id, scheduledAt: '2026-12-03T02:00:00.000Z' },
    })
  ).json().interview;

  const res = await app.inject({
    method: 'PATCH',
    url: `/api/interviews/${scheduled.id}`,
    headers: authHeaders(),
    payload: { interviewerId: 'usr_nope' },
  });
  assert.equal(res.statusCode, 400);
  const detail = (await app.inject({ method: 'GET', url: `/api/interviews/${scheduled.id}`, headers: authHeaders() })).json();
  assert.equal(detail.interview.interviewer_id, null);
});

test('把简历挂到不存在的候选人返回 404', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/candidates/cand_nope/resume',
    headers: authHeaders(),
    payload: { fileId: 'file_nope' },
  });
  assert.equal(res.statusCode, 404);
});

test('注册在初始化后仅限管理员，且成员不能改飞书或删除资源', async () => {
  const self = (await app.inject({ method: 'GET', url: '/api/auth/me', headers: authHeaders() })).json().user;

  const added = await app.inject({
    method: 'POST',
    url: '/api/team',
    headers: authHeaders(),
    payload: { name: '招聘专员', email: 'member@hireloop.cn', password: 'password123', role: 'recruiter' },
  });
  assert.equal(added.statusCode, 201);

  const memberLogin = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: 'member@hireloop.cn', password: 'password123' },
  });
  assert.equal(memberLogin.statusCode, 200);
  const memberCookie = String(memberLogin.headers['set-cookie']).split(';')[0]!;

  // 匿名注册：系统已有用户，直接 401（未登录）
  const selfRegister = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { name: '外部人员', email: 'outsider@hireloop.cn', password: 'password123' },
  });
  assert.equal(selfRegister.statusCode, 401);

  // 已登录的普通成员也不能替别人开账号
  const memberRegister = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: { cookie: memberCookie },
    payload: { name: '外部人员', email: 'outsider@hireloop.cn', password: 'password123' },
  });
  assert.equal(memberRegister.statusCode, 403);

  const feishu = await app.inject({
    method: 'PUT',
    url: '/api/settings/feishu',
    headers: { cookie: memberCookie },
    payload: { app_id: 'cli_hacked' },
  });
  assert.equal(feishu.statusCode, 403);

  const jobs = (await app.inject({ method: 'GET', url: '/api/jobs', headers: authHeaders() })).json();
  const jobId = jobs.items[0].id;
  const deleteJob = await app.inject({
    method: 'DELETE',
    url: `/api/jobs/${jobId}`,
    headers: { cookie: memberCookie },
  });
  assert.equal(deleteJob.statusCode, 403);

  // 最后一名管理员不能自降级，未知成员返回 404
  const demote = await app.inject({
    method: 'PATCH',
    url: `/api/team/${self.id}/role`,
    headers: authHeaders(),
    payload: { role: 'recruiter' },
  });
  assert.equal(demote.statusCode, 400);

  const unknown = await app.inject({
    method: 'PATCH',
    url: '/api/team/usr_nope/role',
    headers: authHeaders(),
    payload: { role: 'recruiter' },
  });
  assert.equal(unknown.statusCode, 404);
});

test('简历下载强制附件，不按客户端声明回放 HTML', async () => {
  const boundary = '----hireloop-test';
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\n`),
    Buffer.from('Content-Disposition: form-data; name="file"; filename="evil.txt"\r\n'),
    Buffer.from('Content-Type: text/html\r\n\r\n'),
    Buffer.from('<script>alert(1)</script>'),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const upload = await app.inject({
    method: 'POST',
    url: '/api/uploads/resume',
    headers: { ...authHeaders(), 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: body,
  });
  assert.equal(upload.statusCode, 201);
  const fileId = upload.json().file.id;

  const download = await app.inject({ method: 'GET', url: `/api/files/${fileId}`, headers: authHeaders() });
  assert.equal(download.statusCode, 200);
  assert.match(String(download.headers['content-type']), /^text\/plain/);
  assert.equal(download.headers['x-content-type-options'], 'nosniff');
  assert.match(String(download.headers['content-disposition']), /^attachment;/);
});

test('登出后会话失效', async () => {
  const out = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: authHeaders() });
  assert.equal(out.statusCode, 200);
  const res = await app.inject({ method: 'GET', url: '/api/jobs', headers: authHeaders() });
  assert.equal(res.statusCode, 401);
});