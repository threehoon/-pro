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

test('飞书出站箱按状态、渠道和人员过滤完整历史后分页，统计仍按全箱计算', async () => {
  const user = getRow<{ id: string }>('SELECT id FROM users WHERE email = ?', ['qa@hireloop.cn']);
  assert.ok(user);
  function insert(key: string, status: string, payload: string, title: string, createdAt: string, channel = 'feishu', type = 'interview.scheduled') {
    run(`INSERT INTO notifications (id, event_key, type, channel, status, target_user_id, title, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [key, `outbox-test:${key}`, type, channel, status, user!.id, title, payload, createdAt]);
  }
  async function query(params = '') {
    const res = await app.inject({ url: `/api/notifications?channel=feishu${params}`, headers: authHeaders() });
    assert.equal(res.statusCode, 200);
    return res.json();
  }
  const archived = '2025-01-01T00:00:00.000Z';
  const recent = '2026-01-01T00:00:00.000Z';
  try {
    insert('p-old', 'pending', JSON.stringify({ candidateName: '赵旧记录', jobTitle: 'C++ 工程师' }), '旧面试', archived);
    insert('s-old', 'sent', '{bad', '旧记录含 100% 匹配', archived);
    insert('s-notliteral', 'sent', '{}', '旧记录含 100 分匹配', archived);
    insert('s-dm', 'sent', JSON.stringify({ delivery: 'dm', recipientName: '苏面试官' }), '改期通知', recent);
    insert('s-group', 'sent', JSON.stringify({ delivery: 'webhook', interviewerName: '苏面试官' }), '取消通知', recent, 'feishu', 'interview.cancelled');
    insert('stage', 'skipped', '{}', '阶段通知', recent, 'feishu', 'stage.changed');
    insert('other', 'sent', JSON.stringify({ delivery: 'dm', recipientName: '苏面试官' }), '邮件通知', recent, 'email');
    for (let i = 0; i < 60; i++) insert(`p-${i}`, 'pending', '{}', `当前面试 ${i}`, recent);

    const first = await query('&limit=8');
    assert.equal(first.total, 66);
    assert.deepEqual(first.items.slice(0, 2).map((row: { id: string }) => row.id), ['p-59', 'p-58']);
    const second = await query('&limit=8&page=2');
    assert.equal(second.page, 2);
    assert.equal(second.items[0].id, 'p-51');
    const pastEnd = await query('&limit=8&page=999');
    assert.equal(pastEnd.page, 9);
    assert.equal(pastEnd.items.length, 2);

    const dm = await query(`&status=sent&delivery=dm&q=${encodeURIComponent(' 苏面试官 ')}`);
    assert.equal(dm.total, 1);
    assert.equal(dm.items[0].id, 's-dm');
    assert.equal(dm.items[0].interviewer_name, '苏面试官');
    assert.deepEqual(dm.stats, first.stats);
    const webhook = await query(`&status=sent&delivery=webhook&q=${encodeURIComponent('苏面试官')}`);
    assert.deepEqual(webhook.items.map((row: { id: string }) => row.id), ['s-group']);
    const older = await query(`&limit=1&status=pending&delivery=webhook&q=${encodeURIComponent('赵旧记录')}`);
    assert.equal(older.items[0].id, 'p-old');
    assert.equal(older.items[0].interviewer_name, '测试招聘官');
    assert.equal((await query(`&q=${encodeURIComponent('c++')}`)).total, 1);
    assert.equal((await query(`&q=${encodeURIComponent('100%')}`)).items[0].id, 's-old');
    assert.equal((await query(`&q=${encodeURIComponent('100%')}`)).total, 1);
    assert.equal((await query(`&status=skipped&q=${encodeURIComponent('测试招聘官')}`)).total, 0);
    assert.equal((await query('&status=failed')).total, 0);

    const unscoped = await app.inject({ url: '/api/notifications?limit=1', headers: authHeaders() });
    assert.deepEqual(Object.keys(unscoped.json()).sort(), ['items', 'stats']);
    for (const query of ['page=0', 'status=nope', 'delivery=nope', `q=${'a'.repeat(101)}`]) {
      assert.equal((await app.inject({ url: `/api/notifications?channel=feishu&${query}`, headers: authHeaders() })).statusCode, 400);
    }
    assert.equal((await app.inject({ url: '/api/notifications?channel=feishu' })).statusCode, 401);
  } finally {
    run("DELETE FROM notifications WHERE event_key LIKE 'outbox-test:%'");
  }
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

test('候选人按流程阶段分组，计数与筛选结果一致', async (t) => {
  const baseline = (
    await app.inject({ method: 'GET', url: '/api/candidates?pageSize=100', headers: authHeaders() })
  ).json();
  const groups = ['screening', 'interview', 'negotiation', 'pending', 'hired', 'rejected', 'none'] as const;

  const job = await app.inject({
    method: 'POST',
    url: '/api/jobs',
    headers: authHeaders(),
    payload: { title: '分组测试职位', headcount: 1 },
  });
  assert.equal(job.statusCode, 201);
  const jobId = job.json().job.id;

  const create = async (label: string, key: string, extra: Record<string, unknown> = {}) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/candidates',
      headers: authHeaders(),
      payload: { name: `分组样本-${label}`, email: `group-${key}@example.com`, ...extra },
    });
    assert.equal(res.statusCode, 201, res.body);
    return res.json().candidate.id as string;
  };
  const apply = async (candidateId: string, targetJobId = jobId) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/applications',
      headers: authHeaders(),
      payload: { jobId: targetJobId, candidateId },
    });
    assert.equal(res.statusCode, 201, res.body);
    return res.json().application.id as string;
  };

  // 七个分类各造样本：待入职用 sent 与 accepted 两位，避免状态分支写错也能蒙混过关
  const ids: Record<(typeof groups)[number] | 'pendingAccepted', string> = {
    screening: await create('待筛选', 'screening', { skills: ['Go'] }),
    interview: await create('面试中', 'interview'),
    negotiation: await create('谈薪', 'negotiation'),
    pending: await create('待入职已发', 'pending-sent'),
    pendingAccepted: await create('待入职已接受', 'pending-accepted'),
    hired: await create('已入职', 'hired'),
    rejected: await create('已拒绝', 'rejected'),
    none: await create('未投递', 'none', { skills: ['Go'] }),
  };
  const noneNoSkill = await create('未投递二号', 'none-python', { skills: ['Python'] });

  const screeningApp = await apply(ids.screening);
  const interviewApp = await apply(ids.interview);
  const negotiationApp = await apply(ids.negotiation);
  const pendingApp = await apply(ids.pending);
  const pendingAcceptedApp = await apply(ids.pendingAccepted);
  const hiredApp = await apply(ids.hired);
  const rejectedApp = await apply(ids.rejected);

  const now = new Date().toISOString();
  // 待筛选样本压回 new：覆盖「new 也归待筛选」，否则只测到 screening 分支
  run("UPDATE applications SET stage = 'new' WHERE id = ?", [screeningApp]);
  run("UPDATE applications SET stage = 'interview' WHERE id = ?", [interviewApp]);
  run("UPDATE applications SET stage = 'offer' WHERE id = ?", [negotiationApp]);
  run("UPDATE applications SET stage = 'offer' WHERE id = ?", [pendingApp]);
  run("UPDATE applications SET stage = 'offer' WHERE id = ?", [pendingAcceptedApp]);
  run("UPDATE applications SET stage = 'hired' WHERE id = ?", [hiredApp]);
  run("UPDATE applications SET status = 'rejected', rejection_reason = '其他', rejected_at = ? WHERE id = ?", [
    now,
    rejectedApp,
  ]);
  const offer = (applicationId: string, status: string) =>
    run(
      'INSERT INTO offers (id, application_id, status, created_at, updated_at, sent_at) VALUES (?, ?, ?, ?, ?, ?)',
      [`offer_${applicationId}`, applicationId, status, now, now, status === 'negotiating' ? null : now],
    );
  offer(negotiationApp, 'negotiating');
  offer(pendingApp, 'sent');
  offer(pendingAcceptedApp, 'accepted');
  const screeningRow = getRow<{ stage: string }>('SELECT stage FROM applications WHERE id = ?', [screeningApp]);
  assert.equal(screeningRow?.stage, 'new');

  const all = (
    await app.inject({ method: 'GET', url: '/api/candidates?pageSize=100', headers: authHeaders() })
  ).json();

  // 独立口径：分类总数必须等于候选人表实际行数，而不是由同一份推导自证
  const stored = getRow<{ n: number }>('SELECT COUNT(*) AS n FROM candidates');
  assert.equal(all.groupCounts.all, Number(stored?.n ?? 0));

  const deltas: Record<(typeof groups)[number], number> = {
    screening: 1,
    interview: 1,
    negotiation: 1,
    pending: 2,
    hired: 1,
    rejected: 1,
    none: 2,
  };
  for (const key of groups) {
    assert.equal(
      all.groupCounts[key],
      Number(baseline.groupCounts[key] ?? 0) + deltas[key],
      `${key} 计数偏了：期望在原有基础上 +${deltas[key]}`,
    );
  }

  const expected: Record<(typeof groups)[number], string[]> = {
    screening: [ids.screening],
    interview: [ids.interview],
    negotiation: [ids.negotiation],
    pending: [ids.pending, ids.pendingAccepted],
    hired: [ids.hired],
    rejected: [ids.rejected],
    none: [ids.none, noneNoSkill],
  };

  for (const key of groups) {
    const res = (
      await app.inject({ method: 'GET', url: `/api/candidates?group=${key}&pageSize=100`, headers: authHeaders() })
    ).json();
    assert.equal(res.group, key);
    assert.equal(res.total, all.groupCounts[key], `${key} 的 total 与计数不一致`);
    const got = res.items.map((item: { id: string }) => item.id);
    for (const id of expected[key]) assert.ok(got.includes(id), `${key} 分类里缺少 ${id}`);
    // 只在「自己的分类里出现」：某个分支写错会把样本串到别的分类，这条断言会失败
    for (const other of groups) {
      if (other === key) continue;
      for (const id of expected[other]) {
        assert.equal(got.includes(id), false, `${key} 分类不该包含 ${other} 分类的 ${id}`);
      }
    }
  }

  // 待入职：只有 sent / accepted 算，negotiating 必须留在谈薪
  const pending = (
    await app.inject({ method: 'GET', url: '/api/candidates?group=pending&pageSize=100', headers: authHeaders() })
  ).json();
  assert.ok(
    pending.items.every((item: { furthest_stage: string; furthest_offer_status: string }) =>
      item.furthest_stage === 'offer' && ['sent', 'accepted'].includes(item.furthest_offer_status),
    ),
  );
  const negotiation = (
    await app.inject({ method: 'GET', url: '/api/candidates?group=negotiation&pageSize=100', headers: authHeaders() })
  ).json();
  assert.ok(
    negotiation.items.every((item: { furthest_stage: string; furthest_offer_status: string }) =>
      item.furthest_stage === 'offer' && item.furthest_offer_status === 'negotiating',
    ),
  );

  // 分页与分类叠加：pages 由分类内的 total 决定，不能拿全库总数算
  const paged = (
    await app.inject({ method: 'GET', url: '/api/candidates?group=pending&pageSize=1', headers: authHeaders() })
  ).json();
  assert.ok(paged.total >= 2);
  assert.equal(paged.items.length, 1);
  assert.equal(paged.pages, paged.total);
  const paged2 = (
    await app.inject({
      method: 'GET',
      url: '/api/candidates?group=pending&pageSize=1&page=2',
      headers: authHeaders(),
    })
  ).json();
  assert.equal(paged2.items.length, 1);
  assert.notEqual(paged2.items[0].id, paged.items[0].id);

  // 搜索 + 技能 + 分类三者叠加：关键词只命中两位，加上技能才收敛到一位，
  // 因此「skill 被忽略」或「分类栏人数不跟筛选走」都会让下面的断言失败
  const q = encodeURIComponent('分组样本-未投递');
  const keywordOnly = (
    await app.inject({
      method: 'GET',
      url: `/api/candidates?group=none&q=${q}&pageSize=100`,
      headers: authHeaders(),
    })
  ).json();
  assert.equal(keywordOnly.total, 2);
  assert.equal(keywordOnly.groupCounts.none, 2);
  assert.equal(keywordOnly.groupCounts.all, 2);

  const filtered = (
    await app.inject({
      method: 'GET',
      url: `/api/candidates?group=none&q=${q}&skill=Go`,
      headers: authHeaders(),
    })
  ).json();
  assert.equal(filtered.group, 'none');
  assert.equal(filtered.total, 1);
  assert.equal(filtered.items.length, 1);
  assert.equal(filtered.items[0].id, ids.none);
  assert.equal(filtered.groupCounts.none, 1);
  assert.equal(filtered.groupCounts.all, 1);

  // 同一候选人多条投递：取最靠后的那条（已入职优先于后加的新投递）
  const secondJob = await app.inject({
    method: 'POST',
    url: '/api/jobs',
    headers: authHeaders(),
    payload: { title: '分组测试职位二', headcount: 1 },
  });
  assert.equal(secondJob.statusCode, 201);
  await apply(ids.hired, secondJob.json().job.id);
  const afterSecond = (
    await app.inject({ method: 'GET', url: '/api/candidates?pageSize=100', headers: authHeaders() })
  ).json();
  assert.equal(afterSecond.groupCounts.hired, all.groupCounts.hired);
  assert.equal(afterSecond.groupCounts.screening, all.groupCounts.screening);
  const hiredItems = (
    await app.inject({ method: 'GET', url: '/api/candidates?group=hired&pageSize=100', headers: authHeaders() })
  ).json();
  assert.ok(hiredItems.items.some((item: { id: string }) => item.id === ids.hired));
  const screeningItems = (
    await app.inject({ method: 'GET', url: '/api/candidates?group=screening&pageSize=100', headers: authHeaders() })
  ).json();
  assert.equal(
    screeningItems.items.some((item: { id: string }) => item.id === ids.hired),
    false,
    '已入职候选人不该因为后加的新投递落回待筛选',
  );

  // 未知分组退化成「全部」，不报错
  const bogus = (
    await app.inject({ method: 'GET', url: '/api/candidates?group=bogus&pageSize=100', headers: authHeaders() })
  ).json();
  assert.equal(bogus.group, '');
  assert.equal(bogus.total, all.total);
  assert.equal(bogus.groupCounts.all, all.groupCounts.all);

  const secondJobId: string = secondJob.json().job.id;
  const secondRejectedApp = await apply(ids.rejected, secondJobId);
  run("UPDATE applications SET stage = 'interview' WHERE id = ?", [secondRejectedApp]);
  const secondNegotiationApp = await apply(ids.negotiation, secondJobId);
  run("UPDATE applications SET stage = 'offer' WHERE id = ?", [secondNegotiationApp]);
  offer(secondNegotiationApp, 'sent');
  const secondOnly = await create('待入职其他职位', 'other-job-pending', { skills: ['Go'] });
  const secondOnlyApp = await apply(secondOnly, secondJobId);
  run("UPDATE applications SET stage = 'offer' WHERE id = ?", [secondOnlyApp]);
  offer(secondOnlyApp, 'sent');

  const list = async (params: Record<string, string>) => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/candidates?${new URLSearchParams(params)}`,
      headers: authHeaders(),
    });
    assert.equal(res.statusCode, 200, res.body);
    return res.json<{
      items: {
        id: string;
        active_count: number;
        rejected_count: number;
        furthest_stage: string | null;
        furthest_offer_status: string | null;
      }[];
      total: number;
      page: number;
      pages: number;
      group: string;
      groupCounts: Record<(typeof groups)[number] | 'all', number>;
    }>();
  };

  await t.test('按实际投递职位返回候选人，以及该职位专属流程状态和计数', async () => {
    const selected = await list({ jobId });
    assert.equal(selected.total, 7);
    assert.deepEqual(selected.groupCounts, { all: 7, ...deltas, none: 0 });
    assert.deepEqual(
      selected.items.map(({ id }) => id).sort(),
      [ids.screening, ids.interview, ids.negotiation, ids.pending, ids.pendingAccepted, ids.hired, ids.rejected].sort(),
    );

    const rejected = await list({ jobId, group: 'rejected' });
    assert.equal(rejected.total, 1);
    assert.deepEqual(rejected.items.map((item) => item.id), [ids.rejected]);
    assert.equal(rejected.items[0]?.active_count, 0);
    assert.equal(rejected.items[0]?.rejected_count, 1);
    assert.equal(rejected.items[0]?.furthest_stage, null);
    assert.equal(rejected.items[0]?.furthest_offer_status, null);

    const other = await list({ jobId: secondJobId });
    assert.deepEqual(other.groupCounts, {
      all: 4, screening: 1, interview: 1, negotiation: 0, pending: 2, hired: 0, rejected: 0, none: 0,
    });
    const otherItems = new Map(other.items.map((item) => [item.id, item]));
    assert.equal(otherItems.get(ids.hired)?.furthest_stage, 'screening');
    assert.equal(otherItems.get(ids.rejected)?.furthest_stage, 'interview');
    assert.equal(otherItems.get(ids.rejected)?.rejected_count, 0);
    assert.equal(otherItems.get(ids.negotiation)?.furthest_offer_status, 'sent');
    assert.equal(otherItems.get(ids.negotiation)?.active_count, 1);
    assert.equal(selected.items.find((item) => item.id === ids.negotiation)?.furthest_offer_status, 'negotiating');
  });

  await t.test('职位、关键词、分类和分页叠加，切回全部职位恢复全局口径', async () => {
    const query = { jobId, q: '分组样本-待', group: 'pending', pageSize: '1' };
    const first = await list(query);
    const second = await list({ ...query, page: '2' });
    for (const page of [first, second]) {
      assert.equal(page.group, 'pending');
      assert.equal(page.total, 2);
      assert.equal(page.pages, 2);
      assert.deepEqual(page.groupCounts, {
        all: 3, screening: 1, interview: 0, negotiation: 0, pending: 2, hired: 0, rejected: 0, none: 0,
      });
      assert.equal(page.items.length, 1);
    }
    assert.equal(first.page, 1);
    assert.equal(second.page, 2);
    assert.deepEqual(
      [...first.items, ...second.items].map(({ id }) => id).sort(),
      [ids.pending, ids.pendingAccepted].sort(),
    );

    const globalPending = await list({ q: query.q, group: 'pending' });
    assert.equal(globalPending.total, 3);
    assert.equal(globalPending.groupCounts.all, 4);
    assert.ok(globalPending.items.some((item) => item.id === secondOnly));
    const global = await list({ q: '分组样本-' });
    assert.equal(global.groupCounts.hired, 1);
    assert.equal(global.groupCounts.rejected, 0);
    assert.equal(global.items.find((item) => item.id === ids.hired)?.active_count, 2);
    assert.equal(global.items.find((item) => item.id === ids.rejected)?.rejected_count, 1);
    assert.equal(global.items.find((item) => item.id === ids.rejected)?.furthest_stage, 'interview');
  });

  await t.test('无投递或不存在的职位返回空列表，重复 jobId 返回 400', async () => {
    const emptyJob = await app.inject({
      method: 'POST',
      url: '/api/jobs',
      headers: authHeaders(),
      payload: { title: '分组测试空职位', headcount: 1 },
    });
    assert.equal(emptyJob.statusCode, 201, emptyJob.body);
    const emptyJobId: string = emptyJob.json().job.id;
    for (const unknownOrEmptyId of [emptyJobId, 'job_missing_for_candidate_filter']) {
      const selection = await list({ jobId: unknownOrEmptyId, group: 'screening' });
      assert.deepEqual(selection.items, []);
      assert.equal(selection.total, 0);
      assert.equal(selection.pages, 1);
      assert.deepEqual(selection.groupCounts, {
        all: 0, screening: 0, interview: 0, negotiation: 0, pending: 0, hired: 0, rejected: 0, none: 0,
      });
    }
    assert.deepEqual(await list({ jobId: ' ', q: '分组样本-' }), await list({ q: '分组样本-' }));
    const duplicated = await app.inject({
      method: 'GET',
      url: `/api/candidates?jobId=${jobId}&jobId=${secondJobId}`,
      headers: authHeaders(),
    });
    assert.equal(duplicated.statusCode, 400, duplicated.body);
  });
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