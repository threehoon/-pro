import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dataDir = mkdtempSync(path.join(tmpdir(), 'hireloop-feishu-test-'));
process.env.HIRELOOP_DATA_DIR = dataDir;
process.env.HIRELOOP_DB_PATH = path.join(dataDir, 'feishu-test.db');
delete process.env.LLM_API_KEY;
process.env.NODE_ENV = 'test';

const { buildApp } = await import('../src/app.ts');
const { closeDb, getRow, transaction } = await import('../src/db/index.ts');
const {
  clearTenantTokenCache,
  getTenantAccessToken,
  setFeishuFetchForTest,
  signFeishuWebhook,
  syncFeishuCalendarEvent,
} = await import('../src/integrations/feishu.ts');
const { enqueueNotification, waitForFeishuDispatches } = await import('../src/services/notifications.ts');
const { waitForCalendarSyncs } = await import('../src/services/interviews.ts');

let app: Awaited<ReturnType<typeof buildApp>>;
let adminCookie = '';
let recruiterCookie = '';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

before(async () => {
  app = await buildApp();
  await app.ready();

  const register = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { name: '飞书管理员', email: 'admin@feishu.test', password: 'password123' },
  });
  assert.equal(register.statusCode, 200);
  adminCookie = String(register.headers['set-cookie']).split(';')[0]!;

  const member = await app.inject({
    method: 'POST',
    url: '/api/team',
    headers: { cookie: adminCookie },
    payload: { name: '普通招聘官', email: 'recruiter@feishu.test', password: 'password123', role: 'recruiter' },
  });
  assert.equal(member.statusCode, 201);

  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: 'recruiter@feishu.test', password: 'password123' },
  });
  assert.equal(login.statusCode, 200);
  recruiterCookie = String(login.headers['set-cookie']).split(';')[0]!;
});

async function resetFeishuRuntime() {
  await waitForCalendarSyncs();
  await waitForFeishuDispatches();
  setFeishuFetchForTest(null);
  clearTenantTokenCache();
}

function dispatchAsAdmin(payload: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: '/api/notifications/feishu/dispatch',
    headers: { cookie: adminCookie },
    payload,
  });
}

afterEach(resetFeishuRuntime);

after(async () => {
  await resetFeishuRuntime();
  await app.close();
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

test('Webhook 域名校验拒绝非官方地址与非 HTTPS，且错误信息不回显原始 URL', async () => {
  const invalidUrls = [
    'http://open.feishu.cn/open-apis/bot/v2/hook/abc123',
    'https://evil.example.com/open-apis/bot/v2/hook/abc123',
    'https://127.0.0.1/open-apis/bot/v2/hook/abc123',
    'https://open.feishu.cn:8443/open-apis/bot/v2/hook/abc123',
    'https://open.feishu.cn/not-a-bot-hook/abc123',
    'https://open.feishu.cn/open-apis/bot/v2/hook/abc123?foo=bar',
    'https://open.feishu.cn/open-apis/bot/v2/hook/abc123#frag',
    'not-a-url',
  ];

  for (const url of invalidUrls) {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/settings/feishu',
      headers: { cookie: adminCookie },
      payload: { bot_webhook: url },
    });
    assert.equal(res.statusCode, 400, `应拒绝非法 Webhook: ${url}`);
    assert.ok(!res.body.includes(url), '错误响应不能泄露原始 Webhook URL');
  }
});

test('保存官方 Webhook 与签名密钥后不泄露敏感明文，且签名算法符合飞书规范', async () => {
  const webhookUrl = 'https://open.feishu.cn/open-apis/bot/v2/hook/demo-hook-token-001';
  const botSecret = 'super-bot-secret-value';
  const appSecret = 'super-app-secret-value';

  const saved = await app.inject({
    method: 'PUT',
    url: '/api/settings/feishu',
    headers: { cookie: adminCookie },
    payload: {
      app_id: 'cli_demo_stage1',
      app_secret: appSecret,
      bot_webhook: webhookUrl,
      bot_secret: botSecret,
    },
  });
  assert.equal(saved.statusCode, 200);
  const body = saved.json();
  assert.equal(body.configured, true);
  assert.equal(body.fields.app_id, true);
  assert.equal(body.fields.app_secret, true);
  assert.equal(body.fields.bot_webhook, true);
  assert.equal(body.fields.bot_secret, true);
  assert.equal(body.ready.login, true);
  assert.equal(body.ready.notifications, true);
  assert.ok(!saved.body.includes(webhookUrl));
  assert.ok(!saved.body.includes(botSecret));
  assert.ok(!saved.body.includes(appSecret));

  const ts = '1732590000';
  const expected = createHmac('sha256', `${ts}\n${botSecret}`).update('').digest('base64');
  assert.equal(signFeishuWebhook(ts, botSecret), expected);
});

test('自建应用 tenant_access_token 支持内存缓存、配置更新后失效，且测试接口不泄露令牌', async () => {
  let tokenFetches = 0;
  setFeishuFetchForTest(async (url, init) => {
    assert.equal(url, 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal');
    const req = JSON.parse(String(init.body));
    assert.equal(req.app_id, 'cli_demo_stage1');
    tokenFetches += 1;
    return jsonResponse({ code: 0, msg: 'ok', tenant_access_token: `t-secret-token-${tokenFetches}`, expire: 7200 });
  });

  const first = await getTenantAccessToken();
  assert.equal(first.cached, false);
  assert.equal(tokenFetches, 1);

  const second = await getTenantAccessToken();
  assert.equal(second.cached, true);
  assert.equal(second.token, first.token);
  assert.equal(tokenFetches, 1);

  // 更新配置必须令缓存失效
  const updated = await app.inject({
    method: 'PUT',
    url: '/api/settings/feishu',
    headers: { cookie: adminCookie },
    payload: { app_secret: 'updated-app-secret-value' },
  });
  assert.equal(updated.statusCode, 200);

  const third = await getTenantAccessToken();
  assert.equal(third.cached, false);
  assert.equal(tokenFetches, 2);

  // 测试接口强制刷新且绝不回传 token 或 secret
  const tested = await app.inject({
    method: 'POST',
    url: '/api/settings/feishu/test-app',
    headers: { cookie: adminCookie },
  });
  assert.equal(tested.statusCode, 200);
  const testedBody = tested.json();
  assert.equal(testedBody.ok, true);
  assert.equal(testedBody.endpoint, 'open.feishu.cn');
  assert.equal(testedBody.expiresIn, 7200);
  assert.ok(!tested.body.includes('t-secret-token'));
  assert.ok(!tested.body.includes('updated-app-secret-value'));
  assert.equal(tokenFetches, 3);
});

test('自建应用凭证错误时返回明确诊断且不泄露密钥', async () => {
  setFeishuFetchForTest(async () => jsonResponse({ code: 10003, msg: 'invalid app_secret' }));
  const res = await app.inject({
    method: 'POST',
    url: '/api/settings/feishu/test-app',
    headers: { cookie: adminCookie },
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error.message, /10003/);
  assert.ok(!res.body.includes('updated-app-secret-value'));
});

test('发送测试卡片带上签名校验并返回成功，群机器人拒绝时返回 400', async () => {
  let capturedBody: Record<string, unknown> | null = null;
  setFeishuFetchForTest(async (url, init) => {
    assert.equal(url, 'https://open.feishu.cn/open-apis/bot/v2/hook/demo-hook-token-001');
    capturedBody = JSON.parse(String(init.body)) as Record<string, unknown>;
    return jsonResponse({ StatusCode: 0, StatusMessage: 'success' });
  });

  const okRes = await app.inject({
    method: 'POST',
    url: '/api/settings/feishu/test-webhook',
    headers: { cookie: adminCookie },
  });
  assert.equal(okRes.statusCode, 200);
  assert.equal(okRes.json().ok, true);
  assert.equal(okRes.json().signed, true);
  assert.ok(capturedBody);
  assert.equal(capturedBody['msg_type'], 'interactive');
  const ts = String(capturedBody['timestamp']);
  assert.equal(capturedBody['sign'], signFeishuWebhook(ts, 'super-bot-secret-value'));

  setFeishuFetchForTest(async () => jsonResponse({ code: 19021, msg: 'sign match fail' }));
  const failRes = await app.inject({
    method: 'POST',
    url: '/api/settings/feishu/test-webhook',
    headers: { cookie: adminCookie },
  });
  assert.equal(failRes.statusCode, 400);
  assert.match(failRes.json().error.message, /19021/);
});

test('业务操作触发异步飞书投递；失败不阻塞业务流转，且支持单条重试、防重发与跳过历史待发', async () => {
  const sentCards: Array<Record<string, unknown>> = [];
  let shouldFail = false;

  setFeishuFetchForTest(async (_url, init) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    if (shouldFail) {
      return jsonResponse({ code: 9499, msg: 'mock webhook outage' }, 502);
    }
    sentCards.push(body);
    return jsonResponse({ code: 0, msg: 'success' });
  });

  const job = (
    await app.inject({
      method: 'POST',
      url: '/api/jobs',
      headers: { cookie: adminCookie },
      payload: { title: '后端架构师', department: '技术部' },
    })
  ).json().job;

  const candidate = (
    await app.inject({
      method: 'POST',
      url: '/api/candidates',
      headers: { cookie: adminCookie },
      payload: { name: '林小满', email: 'lin@feishu.test' },
    })
  ).json().candidate;

  // 1) 正常创建投递 -> 事务提交后自动异步发送卡片
  const applied = await app.inject({
    method: 'POST',
    url: '/api/applications',
    headers: { cookie: adminCookie },
    payload: { jobId: job.id, candidateId: candidate.id },
  });
  assert.equal(applied.statusCode, 201);
  const applicationId = applied.json().application.id;
  await waitForFeishuDispatches();

  assert.equal(sentCards.length, 1);
  const firstNotif = getRow<{ id: string; status: string; attempts: number; sent_at: string | null }>(
    "SELECT id, status, attempts, sent_at FROM notifications WHERE channel = 'feishu' ORDER BY rowid DESC LIMIT 1",
  )!;
  assert.equal(firstNotif.status, 'sent');
  assert.equal(firstNotif.attempts, 1);
  assert.ok(firstNotif.sent_at);

  // 对已发送记录再次 dispatch 不会重复推送
  const redisp = await dispatchAsAdmin({ notificationId: firstNotif.id });
  assert.equal(redisp.statusCode, 200);
  assert.equal(redisp.json().skipped, 1);
  assert.equal(sentCards.length, 1);

  // 2) Webhook 异常时推进筛选 + 安排面试仍返回 200/201，出站箱记录 failed + attempts + last_error
  shouldFail = true;
  const advance = await app.inject({
    method: 'POST',
    url: `/api/applications/${applicationId}/screening`,
    headers: { cookie: adminCookie },
    payload: { decision: 'advance' },
  });
  assert.equal(advance.statusCode, 200);

  const interview = await app.inject({
    method: 'POST',
    url: '/api/interviews',
    headers: { cookie: adminCookie },
    payload: {
      applicationId,
      scheduledAt: '2026-12-01T10:00:00.000Z',
      mode: 'video',
      meetingUrl: 'https://vc.feishu.cn/j/123456789',
    },
  });
  assert.equal(interview.statusCode, 201);
  await waitForFeishuDispatches();

  const failedInterviewNotif = getRow<{ id: string; status: string; attempts: number; last_error: string | null }>(
    "SELECT id, status, attempts, last_error FROM notifications WHERE channel = 'feishu' AND type = 'interview.scheduled' ORDER BY rowid DESC LIMIT 1",
  )!;
  assert.equal(failedInterviewNotif.status, 'failed');
  assert.equal(failedInterviewNotif.attempts, 1);
  assert.match(failedInterviewNotif.last_error ?? '', /9499/);

  // 3) 恢复后手动单条重试 -> 成功并带会议按钮
  shouldFail = false;
  const retry = await dispatchAsAdmin({ notificationId: failedInterviewNotif.id });
  assert.equal(retry.statusCode, 200);
  assert.equal(retry.json().sent, 1);
  const retriedRow = getRow<{ status: string; attempts: number; last_error: string | null }>(
    'SELECT status, attempts, last_error FROM notifications WHERE id = ?',
    [failedInterviewNotif.id],
  )!;
  assert.equal(retriedRow.status, 'sent');
  assert.equal(retriedRow.attempts, 2);
  assert.equal(retriedRow.last_error, null);
  assert.ok(JSON.stringify(sentCards[sentCards.length - 1]).includes('https://vc.feishu.cn/j/123456789'));

  // 4) 事务回滚不会触发异步推送
  const countBeforeRollback = sentCards.length;
  assert.throws(() => {
    transaction(() => {
      enqueueNotification({
        eventKey: 'rollback:test',
        type: 'application.stage_changed',
        title: '不应发送的回滚消息',
        channel: 'feishu',
      });
      throw new Error('force rollback');
    });
  }, /force rollback/);
  await waitForFeishuDispatches();
  assert.equal(sentCards.length, countBeforeRollback);

  // 5) 未配置 Webhook 时积压为 pending；支持按 limit 批量补发与 skip-pending 批量跳过
  await app.inject({
    method: 'PUT',
    url: '/api/settings/feishu',
    headers: { cookie: adminCookie },
    payload: { bot_webhook: '' },
  });
  enqueueNotification({
    eventKey: 'pending:1',
    type: 'application.stage_changed',
    title: '历史待发 1',
    channel: 'feishu',
  });
  enqueueNotification({
    eventKey: 'pending:2',
    type: 'application.stage_changed',
    title: '历史待发 2',
    channel: 'feishu',
  });
  enqueueNotification({
    eventKey: 'pending:3',
    type: 'application.stage_changed',
    title: '历史待发 3',
    channel: 'feishu',
  });
  await waitForFeishuDispatches();

  // 重新配置 Webhook 后按 limit=1 仅补发最早 1 条，剩余 2 条通过 skip-pending 跳过
  await app.inject({
    method: 'PUT',
    url: '/api/settings/feishu',
    headers: { cookie: adminCookie },
    payload: { bot_webhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/demo-hook-token-001' },
  });
  const batchRes = await dispatchAsAdmin({ limit: 1 });
  assert.equal(batchRes.statusCode, 200);
  assert.equal(batchRes.json().sent, 1);
  assert.equal(batchRes.json().remainingPending, 2);

  const skipRes = await app.inject({
    method: 'POST',
    url: '/api/notifications/feishu/skip-pending',
    headers: { cookie: adminCookie },
  });
  assert.equal(skipRes.statusCode, 200);
  assert.equal(skipRes.json().skipped, 2);
  assert.equal(skipRes.json().remainingPending, 0);
});

test('非管理员调用飞书配置、测试、补发和跳过接口全部返回 403', async () => {
  const endpoints: Array<{ method: 'PUT' | 'POST'; url: string; payload?: Record<string, unknown> }> = [
    { method: 'PUT', url: '/api/settings/feishu', payload: { app_id: 'cli_nope' } },
    { method: 'POST', url: '/api/settings/feishu/test-app' },
    { method: 'POST', url: '/api/settings/feishu/test-webhook' },
    { method: 'POST', url: '/api/notifications/feishu/dispatch', payload: {} },
    { method: 'POST', url: '/api/notifications/feishu/skip-pending', payload: {} },
  ];

  for (const endpoint of endpoints) {
    const res = await app.inject({
      method: endpoint.method,
      url: endpoint.url,
      headers: { cookie: recruiterCookie },
      payload: endpoint.payload,
    });
    assert.equal(res.statusCode, 403, `非管理员访问 ${endpoint.method} ${endpoint.url} 应返回 403`);
  }
});

test('阶段一加固：外发请求禁用重定向、诊断脱敏遮蔽密钥，且单条/批量跳过保护失败与在途消息', async () => {
  let capturedRedirect: RequestInit['redirect'];
  const inFlightGate: { release: (() => void) | null } = { release: null };
  let inFlightStartedResolve: (() => void) | null = null;
  const inFlightStarted = new Promise<void>((resolve) => {
    inFlightStartedResolve = resolve;
  });

  // 1) 错误诊断脱敏显式遮蔽已保存的密钥明文，且 fetch 带 redirect: error
  setFeishuFetchForTest(async (_url, init) => {
    capturedRedirect = init.redirect;
    return jsonResponse({ code: 10003, msg: 'echo updated-app-secret-value and super-bot-secret-value' });
  });
  const errRes = await app.inject({
    method: 'POST',
    url: '/api/settings/feishu/test-app',
    headers: { cookie: adminCookie },
  });
  assert.equal(errRes.statusCode, 400);
  assert.equal(capturedRedirect, 'error');
  assert.ok(!errRes.body.includes('updated-app-secret-value'));
  assert.ok(!errRes.body.includes('super-bot-secret-value'));

  // 2) 单条跳过对 failed 返回 400 不覆盖失败原因，对 skipped 幂等不改写原因
  setFeishuFetchForTest(async () => jsonResponse({ code: 9499, msg: 'keep-this-error' }, 502));
  const failedRow = enqueueNotification({
    eventKey: 'skip-guard:failed',
    type: 'application.stage_changed',
    title: '失败保护测试',
    channel: 'feishu',
  });
  await waitForFeishuDispatches();

  const skipFailed = await app.inject({
    method: 'POST',
    url: '/api/notifications/feishu/skip-pending',
    headers: { cookie: adminCookie },
    payload: { notificationId: failedRow.id },
  });
  assert.equal(skipFailed.statusCode, 400);
  const failedAfter = getRow<{ status: string; last_error: string | null }>(
    'SELECT status, last_error FROM notifications WHERE id = ?',
    [failedRow.id],
  )!;
  assert.equal(failedAfter.status, 'failed');
  assert.match(failedAfter.last_error ?? '', /keep-this-error/);

  // 临时清空 Webhook 制造两条待发，测试单条幂等跳过
  await app.inject({
    method: 'PUT',
    url: '/api/settings/feishu',
    headers: { cookie: adminCookie },
    payload: { bot_webhook: '' },
  });
  const pendingRow = enqueueNotification({
    eventKey: 'skip-guard:pending',
    type: 'application.stage_changed',
    title: '单条幂等跳过测试',
    channel: 'feishu',
  });
  const firstSkip = await app.inject({
    method: 'POST',
    url: '/api/notifications/feishu/skip-pending',
    headers: { cookie: adminCookie },
    payload: { notificationId: pendingRow.id },
  });
  assert.equal(firstSkip.statusCode, 200);
  assert.equal(firstSkip.json().skipped, 1);

  const secondSkip = await app.inject({
    method: 'POST',
    url: '/api/notifications/feishu/skip-pending',
    headers: { cookie: adminCookie },
    payload: { notificationId: pendingRow.id },
  });
  assert.equal(secondSkip.statusCode, 200);
  assert.equal(secondSkip.json().skipped, 0);

  // 3) 恢复 Webhook 后，批量跳过会避开正在发送中的消息
  await app.inject({
    method: 'PUT',
    url: '/api/settings/feishu',
    headers: { cookie: adminCookie },
    payload: { bot_webhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/demo-hook-token-001' },
  });
  setFeishuFetchForTest(async () => {
    inFlightStartedResolve?.();
    await new Promise<void>((resolve) => {
      inFlightGate.release = resolve;
    });
    return jsonResponse({ code: 0, msg: 'success' });
  });

  const inFlightRow = enqueueNotification({
    eventKey: 'skip-guard:inflight',
    type: 'application.stage_changed',
    title: '在途发送消息',
    channel: 'feishu',
  });
  await inFlightStarted;

  const skipSingleInFlight = await app.inject({
    method: 'POST',
    url: '/api/notifications/feishu/skip-pending',
    headers: { cookie: adminCookie },
    payload: { notificationId: inFlightRow.id },
  });
  assert.equal(skipSingleInFlight.statusCode, 400);

  const skipBatchDuringInFlight = await app.inject({
    method: 'POST',
    url: '/api/notifications/feishu/skip-pending',
    headers: { cookie: adminCookie },
  });
  assert.equal(skipBatchDuringInFlight.statusCode, 200);
  assert.equal(skipBatchDuringInFlight.json().skipped, 0);

  inFlightGate.release?.();
  await waitForFeishuDispatches();

  const inFlightAfter = getRow<{ status: string }>('SELECT status FROM notifications WHERE id = ?', [inFlightRow.id])!;
  assert.equal(inFlightAfter.status, 'sent');
});

function extractCookie(setCookieHeader: string | string[] | undefined, name: string): string {
  const list = Array.isArray(setCookieHeader) ? setCookieHeader : setCookieHeader ? [setCookieHeader] : [];
  const matched = list.find((item) => item.startsWith(`${name}=`));
  return matched ? matched.split(';')[0]! : '';
}

function mockFeishuOAuth(identity: {
  open_id: string;
  union_id?: string;
  name?: string;
  email?: string;
  enterprise_email?: string;
}) {
  setFeishuFetchForTest(async (url, init) => {
    assert.equal(init.redirect, 'error');
    if (url.endsWith('/open-apis/auth/v3/app_access_token/internal')) {
      return jsonResponse({ code: 0, msg: 'ok', app_access_token: 'a-mock-app-token', expire: 7200 });
    }
    if (url.endsWith('/open-apis/authen/v1/oidc/access_token')) {
      const headers = new Headers(init.headers);
      assert.equal(headers.get('authorization'), 'Bearer a-mock-app-token');
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      assert.equal(body.grant_type, 'authorization_code');
      assert.ok(typeof body.code === 'string' && body.code.length > 0);
      return jsonResponse({
        code: 0,
        msg: 'success',
        data: { access_token: 'u-mock-user-token', token_type: 'Bearer', expires_in: 7200 },
      });
    }
    if (url.endsWith('/open-apis/authen/v1/user_info')) {
      const headers = new Headers(init.headers);
      assert.equal(headers.get('authorization'), 'Bearer u-mock-user-token');
      return jsonResponse({ code: 0, msg: 'success', data: identity });
    }
    throw new Error(`Unexpected Feishu URL: ${url}`);
  });
}

test('阶段二：飞书 OAuth 防 CSRF/重放、成员绑定与冲突拦截、扫码登录（含邮箱匹配与选项 A 拦截）及解绑权限', async () => {
  // 1) bootstrap 反映飞书登录就绪
  const boot = await app.inject({ method: 'GET', url: '/api/bootstrap' });
  assert.equal(boot.statusCode, 200);
  assert.equal(boot.json().feishuLoginEnabled, true);

  // 2) 未登录发起 bind 跳转错误提示
  const unauthBind = await app.inject({
    method: 'GET',
    url: '/api/auth/feishu/start?mode=bind',
    headers: { host: 'localhost:5173' },
  });
  assert.equal(unauthBind.statusCode, 302);
  assert.equal(unauthBind.headers.location, '/?feishu_error=bind_auth_required');

  // 3) 发起登录跳转飞书官方授权页并签发 state Cookie
  const startLogin = await app.inject({
    method: 'GET',
    url: '/api/auth/feishu/start?mode=login',
    headers: { host: 'localhost:5173' },
  });
  assert.equal(startLogin.statusCode, 302);
  const authUrl = new URL(String(startLogin.headers.location));
  assert.equal(authUrl.origin, 'https://open.feishu.cn');
  assert.equal(authUrl.pathname, '/open-apis/authen/v1/authorize');
  assert.equal(authUrl.searchParams.get('app_id'), 'cli_demo_stage1');
  assert.equal(authUrl.searchParams.get('redirect_uri'), 'http://localhost:5173/api/auth/feishu/callback');
  const loginState = authUrl.searchParams.get('state')!;
  assert.ok(loginState.length >= 20);
  const stateCookie = extractCookie(startLogin.headers['set-cookie'], 'hl_feishu_oauth_state');
  assert.ok(stateCookie.startsWith('hl_feishu_oauth_state='));

  // 3a) state 不匹配被拒绝（防 CSRF）
  const badStateCb = await app.inject({
    method: 'GET',
    url: `/api/auth/feishu/callback?code=code-bad&state=wrong-state`,
    headers: { cookie: stateCookie },
  });
  assert.equal(badStateCb.statusCode, 302);
  assert.equal(badStateCb.headers.location, '/?feishu_error=invalid_state');

  // 3b) 用户取消授权
  const cancelStart = await app.inject({ method: 'GET', url: '/api/auth/feishu/start?mode=login' });
  const cancelState = new URL(String(cancelStart.headers.location)).searchParams.get('state')!;
  const cancelCookie = extractCookie(cancelStart.headers['set-cookie'], 'hl_feishu_oauth_state');
  const cancelCb = await app.inject({
    method: 'GET',
    url: `/api/auth/feishu/callback?error=access_denied&state=${encodeURIComponent(cancelState)}`,
    headers: { cookie: cancelCookie },
  });
  assert.equal(cancelCb.statusCode, 302);
  assert.equal(cancelCb.headers.location, '/?feishu_error=cancelled');

  // 3c) 选项 A：未在工作台团队里的陌生飞书账号登录被拦截且不创建用户
  const userCountBefore = getRow<{ n: number }>('SELECT COUNT(*) AS n FROM users')!.n;
  mockFeishuOAuth({
    open_id: 'ou_stranger_001',
    union_id: 'on_stranger_001',
    name: '外部访客',
    enterprise_email: 'stranger@outside.example',
  });
  const unknownCb = await app.inject({
    method: 'GET',
    url: `/api/auth/feishu/callback?code=code-stranger&state=${encodeURIComponent(loginState)}`,
    headers: { cookie: stateCookie },
  });
  assert.equal(unknownCb.statusCode, 302);
  assert.equal(unknownCb.headers.location, '/?feishu_error=account_not_found');
  assert.equal(extractCookie(unknownCb.headers['set-cookie'], 'hl_session'), '');
  assert.equal(getRow<{ n: number }>('SELECT COUNT(*) AS n FROM users')!.n, userCountBefore);

  // 3d) 重放同一 state 被拒绝
  const replayCb = await app.inject({
    method: 'GET',
    url: `/api/auth/feishu/callback?code=code-stranger&state=${encodeURIComponent(loginState)}`,
    headers: { cookie: stateCookie },
  });
  assert.equal(replayCb.statusCode, 302);
  assert.equal(replayCb.headers.location, '/?feishu_error=invalid_state');

  // 4) 已登录普通招聘官绑定飞书账号
  const bindStart = await app.inject({
    method: 'GET',
    url: '/api/auth/feishu/start?mode=bind',
    headers: { cookie: recruiterCookie },
  });
  assert.equal(bindStart.statusCode, 302);
  const bindState = new URL(String(bindStart.headers.location)).searchParams.get('state')!;
  const bindStateCookie = extractCookie(bindStart.headers['set-cookie'], 'hl_feishu_oauth_state');

  mockFeishuOAuth({
    open_id: 'ou_recruiter_001',
    union_id: 'on_recruiter_001',
    name: '普通招聘官',
  });
  const bindCb = await app.inject({
    method: 'GET',
    url: `/api/auth/feishu/callback?code=code-bind-recruiter&state=${encodeURIComponent(bindState)}`,
    headers: { cookie: `${recruiterCookie}; ${bindStateCookie}` },
  });
  assert.equal(bindCb.statusCode, 302);
  assert.equal(bindCb.headers.location, '/settings?feishu_notice=bound');

  const recruiterMe = await app.inject({
    method: 'GET',
    url: '/api/auth/me',
    headers: { cookie: recruiterCookie },
  });
  assert.equal(recruiterMe.json().user.feishu_open_id, 'ou_recruiter_001');

  // 5) 管理员尝试绑定同一个飞书 open_id -> 冲突拦截，不抢占他人绑定
  const conflictStart = await app.inject({
    method: 'GET',
    url: '/api/auth/feishu/start?mode=bind',
    headers: { cookie: adminCookie },
  });
  const conflictState = new URL(String(conflictStart.headers.location)).searchParams.get('state')!;
  const conflictCookie = extractCookie(conflictStart.headers['set-cookie'], 'hl_feishu_oauth_state');
  const conflictCb = await app.inject({
    method: 'GET',
    url: `/api/auth/feishu/callback?code=code-conflict&state=${encodeURIComponent(conflictState)}`,
    headers: { cookie: `${adminCookie}; ${conflictCookie}` },
  });
  assert.equal(conflictCb.statusCode, 302);
  assert.equal(conflictCb.headers.location, '/settings?feishu_error=already_bound_other');

  // 6) 已绑定招聘官通过飞书直接扫码登录，拿到有效 hl_session
  const okLoginStart = await app.inject({ method: 'GET', url: '/api/auth/feishu/start?mode=login' });
  const okLoginState = new URL(String(okLoginStart.headers.location)).searchParams.get('state')!;
  const okLoginCookie = extractCookie(okLoginStart.headers['set-cookie'], 'hl_feishu_oauth_state');
  const okLoginCb = await app.inject({
    method: 'GET',
    url: `/api/auth/feishu/callback?code=code-login-recruiter&state=${encodeURIComponent(okLoginState)}`,
    headers: { cookie: okLoginCookie },
  });
  assert.equal(okLoginCb.statusCode, 302);
  assert.equal(okLoginCb.headers.location, '/?feishu_notice=logged_in');
  const feishuSessionCookie = extractCookie(okLoginCb.headers['set-cookie'], 'hl_session');
  assert.ok(feishuSessionCookie.startsWith('hl_session='));

  const feishuMe = await app.inject({
    method: 'GET',
    url: '/api/auth/me',
    headers: { cookie: feishuSessionCookie },
  });
  assert.equal(feishuMe.statusCode, 200);
  assert.equal(feishuMe.json().user.feishu_open_id, 'ou_recruiter_001');

  // 7) 管理员未主动绑定但企业邮箱命中 -> 扫码登录自动关联 open_id 并签发会话
  const adminMe = (await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: adminCookie } })).json().user;
  const emailLoginStart = await app.inject({ method: 'GET', url: '/api/auth/feishu/start?mode=login' });
  const emailLoginState = new URL(String(emailLoginStart.headers.location)).searchParams.get('state')!;
  const emailLoginCookie = extractCookie(emailLoginStart.headers['set-cookie'], 'hl_feishu_oauth_state');
  mockFeishuOAuth({
    open_id: 'ou_admin_001',
    union_id: 'on_admin_001',
    name: '飞书管理员',
    enterprise_email: adminMe.email,
  });
  const emailLoginCb = await app.inject({
    method: 'GET',
    url: `/api/auth/feishu/callback?code=code-login-admin&state=${encodeURIComponent(emailLoginState)}`,
    headers: { cookie: emailLoginCookie },
  });
  assert.equal(emailLoginCb.statusCode, 302);
  assert.equal(emailLoginCb.headers.location, '/?feishu_notice=logged_in');
  const adminAfterEmailLogin = (
    await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: adminCookie } })
  ).json().user;
  assert.equal(adminAfterEmailLogin.feishu_open_id, 'ou_admin_001');

  // 8) 另一飞书账号冒用已绑定邮箱 -> 拒绝覆盖
  const hijackStart = await app.inject({ method: 'GET', url: '/api/auth/feishu/start?mode=login' });
  const hijackState = new URL(String(hijackStart.headers.location)).searchParams.get('state')!;
  const hijackCookie = extractCookie(hijackStart.headers['set-cookie'], 'hl_feishu_oauth_state');
  mockFeishuOAuth({
    open_id: 'ou_other_person_999',
    union_id: 'on_other_person_999',
    enterprise_email: adminMe.email,
  });
  const hijackCb = await app.inject({
    method: 'GET',
    url: `/api/auth/feishu/callback?code=code-hijack&state=${encodeURIComponent(hijackState)}`,
    headers: { cookie: hijackCookie },
  });
  assert.equal(hijackCb.statusCode, 302);
  assert.equal(hijackCb.headers.location, '/?feishu_error=email_bound_other');

  // 9) 解绑权限：普通成员不能解绑管理员，本人可自解绑，管理员可解绑他人
  const recruiterUser = recruiterMe.json().user;
  const forbiddenUnbind = await app.inject({
    method: 'POST',
    url: '/api/auth/feishu/unbind',
    headers: { cookie: recruiterCookie },
    payload: { userId: adminMe.id },
  });
  assert.equal(forbiddenUnbind.statusCode, 403);

  const adminUnbindOther = await app.inject({
    method: 'POST',
    url: '/api/auth/feishu/unbind',
    headers: { cookie: adminCookie },
    payload: { userId: recruiterUser.id },
  });
  assert.equal(adminUnbindOther.statusCode, 200);
  assert.equal(adminUnbindOther.json().unbound, true);
  assert.equal(adminUnbindOther.json().user.id, recruiterUser.id);
  assert.equal(adminUnbindOther.json().user.feishu_open_id, null);

  const selfUnbind = await app.inject({
    method: 'POST',
    url: '/api/auth/feishu/unbind',
    headers: { cookie: adminCookie },
    payload: {},
  });
  assert.equal(selfUnbind.statusCode, 200);
  assert.equal(selfUnbind.json().unbound, true);
  assert.equal(selfUnbind.json().user.feishu_open_id, null);

  // 10) 清空 app_secret 后 bootstrap 返回 feishuLoginEnabled: false
  const cleared = await app.inject({
    method: 'PUT',
    url: '/api/settings/feishu',
    headers: { cookie: adminCookie },
    payload: { app_secret: '' },
  });
  assert.equal(cleared.statusCode, 200);
  assert.equal(cleared.json().ready.login, false);
  const bootOff = await app.inject({ method: 'GET', url: '/api/bootstrap' });
  assert.equal(bootOff.json().feishuLoginEnabled, false);
});

test('阶段二安全与边界回归：反代头防伪造、回调先验 state 再消费、换绑清旧 union_id 与 callbackUrl 一致', async () => {
  const { exchangeFeishuOAuthCode } = await import('../src/integrations/feishu.ts');
  const { run } = await import('../src/db/index.ts');

  const recruiterUser = (
    await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: recruiterCookie } })
  ).json().user;

  await app.inject({
    method: 'PUT',
    url: '/api/settings/feishu',
    headers: { cookie: adminCookie },
    payload: { app_id: 'cli_reg_app_001', app_secret: 'secret_reg_app_001' },
  });

  const prevTrustProxy = process.env.HIRELOOP_TRUST_PROXY;
  const prevPublicOrigin = process.env.HIRELOOP_PUBLIC_ORIGIN;
  delete process.env.HIRELOOP_TRUST_PROXY;
  delete process.env.HIRELOOP_PUBLIC_ORIGIN;

  try {
    // 1) 未开启 HIRELOOP_TRUST_PROXY 时忽略伪造的 X-Forwarded-Host / X-Forwarded-Proto
    const spoofed = await app.inject({
      method: 'GET',
      url: '/api/auth/feishu/start?mode=login',
      headers: {
        host: 'localhost:5173',
        'x-forwarded-host': 'evil.attacker.test',
        'x-forwarded-proto': 'https',
      },
    });
    assert.equal(spoofed.statusCode, 302);
    const spoofedRedirectUri = new URL(String(spoofed.headers.location)).searchParams.get('redirect_uri');
    assert.equal(spoofedRedirectUri, 'http://localhost:5173/api/auth/feishu/callback');

    // 2) 非法 Host 回退到 http://localhost:8787
    const invalidHost = await app.inject({
      method: 'GET',
      url: '/api/auth/feishu/start?mode=login',
      headers: { host: 'evil.com:99999' },
    });
    assert.equal(
      new URL(String(invalidHost.headers.location)).searchParams.get('redirect_uri'),
      'http://localhost:8787/api/auth/feishu/callback',
    );

    // 3) 开启 HIRELOOP_TRUST_PROXY=1 时允许反向代理头；HIRELOOP_PUBLIC_ORIGIN 优先级最高且同步到设置页 callbackUrl
    process.env.HIRELOOP_TRUST_PROXY = '1';
    const proxied = await app.inject({
      method: 'GET',
      url: '/api/auth/feishu/start?mode=login',
      headers: {
        host: '127.0.0.1:8787',
        'x-forwarded-host': 'hr.company.example',
        'x-forwarded-proto': 'https',
      },
    });
    assert.equal(
      new URL(String(proxied.headers.location)).searchParams.get('redirect_uri'),
      'https://hr.company.example/api/auth/feishu/callback',
    );

    process.env.HIRELOOP_PUBLIC_ORIGIN = 'https://hire.official.example';
    const settingsRes = await app.inject({
      method: 'GET',
      url: '/api/settings/feishu',
      headers: { cookie: adminCookie, host: '127.0.0.1:8787' },
    });
    assert.equal(settingsRes.statusCode, 200);
    assert.equal(settingsRes.json().callbackUrl, 'https://hire.official.example/api/auth/feishu/callback');
  } finally {
    if (prevTrustProxy === undefined) delete process.env.HIRELOOP_TRUST_PROXY;
    else process.env.HIRELOOP_TRUST_PROXY = prevTrustProxy;
    if (prevPublicOrigin === undefined) delete process.env.HIRELOOP_PUBLIC_ORIGIN;
    else process.env.HIRELOOP_PUBLIC_ORIGIN = prevPublicOrigin;
  }

  // 4) 跨站伪造回调（缺少 state Cookie，即使带有效 state 和 error=access_denied）不能消费 state、不能泄露 bind 路径、不能清有效 Cookie
  const bindStart = await app.inject({
    method: 'GET',
    url: '/api/auth/feishu/start?mode=bind',
    headers: { cookie: recruiterCookie },
  });
  const bindState = new URL(String(bindStart.headers.location)).searchParams.get('state')!;
  const bindStateCookie = extractCookie(bindStart.headers['set-cookie'], 'hl_feishu_oauth_state');

  const forgedErrorCb = await app.inject({
    method: 'GET',
    url: `/api/auth/feishu/callback?error=access_denied&state=${encodeURIComponent(bindState)}`,
  });
  assert.equal(forgedErrorCb.statusCode, 302);
  assert.equal(forgedErrorCb.headers.location, '/?feishu_error=invalid_state');

  const subresourceCb = await app.inject({
    method: 'GET',
    url: '/api/auth/feishu/callback',
    headers: { cookie: bindStateCookie },
  });
  assert.equal(subresourceCb.statusCode, 302);
  assert.equal(subresourceCb.headers.location, '/?feishu_error=invalid_state');
  assert.equal(subresourceCb.headers['set-cookie'], undefined);

  const mockOAuth = (userInfo: { open_id: string; union_id?: string | null; enterprise_email?: string }) => {
    setFeishuFetchForTest(async (input) => {
      const url = String(input);
      if (url.endsWith('/open-apis/auth/v3/app_access_token/internal')) {
        return jsonResponse({ code: 0, msg: 'ok', app_access_token: 'a-reg-app-token-123456', expire: 7200 });
      }
      if (url.endsWith('/open-apis/authen/v1/oidc/access_token')) {
        return jsonResponse({ code: 0, msg: 'ok', data: { access_token: 'u-reg-user-token-123456' } });
      }
      if (url.endsWith('/open-apis/authen/v1/user_info')) {
        return jsonResponse({ code: 0, msg: 'ok', data: userInfo });
      }
      throw new Error(`unexpected url: ${url}`);
    });
  };

  // 原用户携带合法 Cookie + state 的回调仍可正常完成绑定
  mockOAuth({ open_id: 'ou_person_A', union_id: 'on_person_A' });
  const legitBindA = await app.inject({
    method: 'GET',
    url: `/api/auth/feishu/callback?code=code-A&state=${encodeURIComponent(bindState)}`,
    headers: { cookie: `${recruiterCookie}; ${bindStateCookie}` },
  });
  assert.equal(legitBindA.statusCode, 302);
  assert.equal(legitBindA.headers.location, '/settings?feishu_notice=bound');

  // 5) 同一成员换绑到另一个飞书身份（且新身份 union_id 为空）时，必须清除旧 feishu_union_id，释放旧身份给其他成员绑定
  const rebindStart = await app.inject({
    method: 'GET',
    url: '/api/auth/feishu/start?mode=bind',
    headers: { cookie: recruiterCookie },
  });
  const rebindState = new URL(String(rebindStart.headers.location)).searchParams.get('state')!;
  const rebindCookie = extractCookie(rebindStart.headers['set-cookie'], 'hl_feishu_oauth_state');
  mockOAuth({ open_id: 'ou_person_B', union_id: null });
  const rebindCb = await app.inject({
    method: 'GET',
    url: `/api/auth/feishu/callback?code=code-B&state=${encodeURIComponent(rebindState)}`,
    headers: { cookie: `${recruiterCookie}; ${rebindCookie}` },
  });
  assert.equal(rebindCb.statusCode, 302);
  assert.equal(rebindCb.headers.location, '/settings?feishu_notice=bound');

  const recruiterRow = getRow<{ feishu_open_id: string | null; feishu_union_id: string | null }>(
    'SELECT feishu_open_id, feishu_union_id FROM users WHERE id = ?',
    [recruiterUser.id],
  );
  assert.equal(recruiterRow?.feishu_open_id, 'ou_person_B');
  assert.equal(recruiterRow?.feishu_union_id, null);

  // 旧身份 A 现在可以被管理员正常绑定（不再被残留的 on_person_A 冲突）
  const adminBindStart = await app.inject({
    method: 'GET',
    url: '/api/auth/feishu/start?mode=bind',
    headers: { cookie: adminCookie },
  });
  const adminBindState = new URL(String(adminBindStart.headers.location)).searchParams.get('state')!;
  const adminBindCookie = extractCookie(adminBindStart.headers['set-cookie'], 'hl_feishu_oauth_state');
  mockOAuth({ open_id: 'ou_person_A', union_id: 'on_person_A' });
  const adminBindCb = await app.inject({
    method: 'GET',
    url: `/api/auth/feishu/callback?code=code-admin-A&state=${encodeURIComponent(adminBindState)}`,
    headers: { cookie: `${adminCookie}; ${adminBindCookie}` },
  });
  assert.equal(adminBindCb.statusCode, 302);
  assert.equal(adminBindCb.headers.location, '/settings?feishu_notice=bound');

  // 6) 历史仅留 union_id 的账号，邮箱登录但新飞书身份无 union_id -> 拒绝覆盖
  run('UPDATE users SET feishu_open_id = NULL, feishu_union_id = ? WHERE id = ?', ['on_legacy_only', recruiterUser.id]);
  const legacyLoginStart = await app.inject({ method: 'GET', url: '/api/auth/feishu/start?mode=login' });
  const legacyLoginState = new URL(String(legacyLoginStart.headers.location)).searchParams.get('state')!;
  const legacyLoginCookie = extractCookie(legacyLoginStart.headers['set-cookie'], 'hl_feishu_oauth_state');
  mockOAuth({ open_id: 'ou_unknown_no_union', union_id: null, enterprise_email: recruiterUser.email });
  const legacyLoginCb = await app.inject({
    method: 'GET',
    url: `/api/auth/feishu/callback?code=code-legacy&state=${encodeURIComponent(legacyLoginState)}`,
    headers: { cookie: legacyLoginCookie },
  });
  assert.equal(legacyLoginCb.statusCode, 302);
  assert.equal(legacyLoginCb.headers.location, '/?feishu_error=email_bound_other');

  // 7) 诊断脱敏遮蔽 a- app_access_token 与一次性 OAuth code
  setFeishuFetchForTest(async (input) => {
    const url = String(input);
    if (url.endsWith('/open-apis/auth/v3/app_access_token/internal')) {
      return jsonResponse({ code: 0, msg: 'ok', app_access_token: 'a-secretAppToken999', expire: 7200 });
    }
    return jsonResponse({
      code: 20003,
      msg: 'invalid code oauth_secret_code_777 with token a-anotherToken8888',
    });
  });
  await assert.rejects(
    () => exchangeFeishuOAuthCode('oauth_secret_code_777'),
    (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      assert.ok(!msg.includes('oauth_secret_code_777'), msg);
      assert.ok(!msg.includes('a-anotherToken8888'), msg);
      assert.ok(!msg.includes('a-secretAppToken999'), msg);
      return true;
    },
  );
});

test('飞书阶段三：管理员一键创建招聘日历、测试日历连通与权限控制', async () => {
  // 清空飞书凭证，校验缺凭证时拒绝建日历和测日历
  await app.inject({
    method: 'PUT',
    url: '/api/settings/feishu',
    headers: { cookie: adminCookie },
    payload: { app_id: '', app_secret: '', calendar_id: '', bot_webhook: '', bot_secret: '' },
  });

  const noCredsCreate = await app.inject({
    method: 'POST',
    url: '/api/settings/feishu/create-calendar',
    headers: { cookie: adminCookie },
    payload: {},
  });
  assert.equal(noCredsCreate.statusCode, 400);

  // 非管理员无权创建或测试飞书日历
  const recruiterCreate = await app.inject({
    method: 'POST',
    url: '/api/settings/feishu/create-calendar',
    headers: { cookie: recruiterCookie },
    payload: {},
  });
  assert.equal(recruiterCreate.statusCode, 403);

  const recruiterTest = await app.inject({
    method: 'POST',
    url: '/api/settings/feishu/test-calendar',
    headers: { cookie: recruiterCookie },
    payload: {},
  });
  assert.equal(recruiterTest.statusCode, 403);

  // 保存自建应用凭证
  const saveApp = await app.inject({
    method: 'PUT',
    url: '/api/settings/feishu',
    headers: { cookie: adminCookie },
    payload: { app_id: 'cli_stage3_cal', app_secret: 'sec_stage3_cal' },
  });
  assert.equal(saveApp.statusCode, 200);
  assert.equal(saveApp.json().ready.calendar, false);

  // 未填日历 ID 时测试日历连接报错
  const noCalTest = await app.inject({
    method: 'POST',
    url: '/api/settings/feishu/test-calendar',
    headers: { cookie: adminCookie },
    payload: {},
  });
  assert.equal(noCalTest.statusCode, 400);

  const calls: Array<{ method: string; url: string; body?: unknown }> = [];
  setFeishuFetchForTest(async (input, init) => {
    const url = String(input);
    const method = String(init?.method ?? 'GET');
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, url, body });
    if (url.endsWith('/open-apis/auth/v3/tenant_access_token/internal')) {
      return jsonResponse({ code: 0, msg: 'ok', tenant_access_token: 't-stage3-cal-token', expire: 7200 });
    }
    if (method === 'POST' && url.endsWith('/open-apis/calendar/v4/calendars')) {
      assert.equal((body as { summary?: string })?.summary, 'Hireloop 招聘面试');
      return jsonResponse({
        code: 0,
        msg: 'ok',
        data: {
          calendar: {
            calendar_id: 'feishu.cn_stage3_shared@group.calendar.feishu.cn',
            summary: 'Hireloop 招聘面试',
          },
        },
      });
    }
    if (method === 'GET' && url.includes('/open-apis/calendar/v4/calendars/')) {
      return jsonResponse({
        code: 0,
        msg: 'ok',
        data: {
          calendar: {
            calendar_id: 'feishu.cn_stage3_shared@group.calendar.feishu.cn',
            summary: 'Hireloop 招聘面试',
          },
        },
      });
    }
    throw new Error(`unexpected feishu call: ${method} ${url}`);
  });

  // 管理员一键创建共享日历 -> 自动回填 calendar_id 并置 ready.calendar = true
  const created = await app.inject({
    method: 'POST',
    url: '/api/settings/feishu/create-calendar',
    headers: { cookie: adminCookie },
    payload: {},
  });
  assert.equal(created.statusCode, 200);
  const createdBody = created.json();
  assert.equal(createdBody.ok, true);
  assert.equal(createdBody.calendarId, 'feishu.cn_stage3_shared@group.calendar.feishu.cn');
  assert.equal(createdBody.summary, 'Hireloop 招聘面试');
  assert.equal(createdBody.status.fields.calendar_id, true);
  assert.equal(createdBody.status.ready.calendar, true);
  assert.match(createdBody.status.callbackUrl, /\/api\/auth\/feishu\/callback$/);

  // 测试共享日历连通性
  const tested = await app.inject({
    method: 'POST',
    url: '/api/settings/feishu/test-calendar',
    headers: { cookie: adminCookie },
    payload: {},
  });
  assert.equal(tested.statusCode, 200);
  assert.equal(tested.json().ok, true);
  assert.equal(tested.json().calendarId, 'feishu.cn_stage3_shared@group.calendar.feishu.cn');
  assert.equal(tested.json().summary, 'Hireloop 招聘面试');
  assert.ok(calls.some((c) => c.method === 'POST' && c.url.endsWith('/open-apis/calendar/v4/calendars')));
  assert.ok(calls.some((c) => c.method === 'GET' && c.url.includes(encodeURIComponent('feishu.cn_stage3_shared@group.calendar.feishu.cn'))));
});

async function getUserIdByCookie(cookie: string): Promise<string> {
  const res = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
  assert.equal(res.statusCode, 200);
  return res.json().user.id as string;
}

async function setupInterviewApplication(title: string, candidateName: string, candidateEmail: string): Promise<string> {
  const jobRes = await app.inject({
    method: 'POST',
    url: '/api/jobs',
    headers: { cookie: adminCookie },
    payload: { title, department: '研发' },
  });
  assert.equal(jobRes.statusCode, 201);
  const jobId = jobRes.json().job.id as string;

  const candRes = await app.inject({
    method: 'POST',
    url: '/api/candidates',
    headers: { cookie: adminCookie },
    payload: { name: candidateName, email: candidateEmail },
  });
  assert.equal(candRes.statusCode, 201);
  const candId = candRes.json().candidate.id as string;

  const applyRes = await app.inject({
    method: 'POST',
    url: `/api/candidates/${candId}/apply`,
    headers: { cookie: adminCookie },
    payload: { jobId },
  });
  assert.equal(applyRes.statusCode, 201);
  const applicationId = applyRes.json().application.id as string;

  const advanceRes = await app.inject({
    method: 'POST',
    url: `/api/applications/${applicationId}/screening`,
    headers: { cookie: adminCookie },
    payload: { decision: 'advance' },
  });
  assert.equal(advanceRes.statusCode, 200);
  return applicationId;
}

test('飞书阶段三：安排/改期/取消面试自动同步飞书日历、自动生成视频会议链接回写并发送面试官私信', async () => {
  const { run } = await import('../src/db/index.ts');

  // 准备两名已绑定飞书 open_id 的团队成员（面试官 A、面试官 B）
  const adminUserId = await getUserIdByCookie(adminCookie);
  const recruiterUserId = await getUserIdByCookie(recruiterCookie);
  run('UPDATE users SET feishu_open_id = ?, feishu_union_id = ? WHERE id = ?', ['ou_interviewer_A', 'on_interviewer_A', adminUserId]);
  run('UPDATE users SET feishu_open_id = ?, feishu_union_id = ? WHERE id = ?', ['ou_interviewer_B', 'on_interviewer_B', recruiterUserId]);

  // 配置飞书自建应用 + 群机器人 Webhook + 共享日历
  const calendarId = 'feishu.cn_stage3_sync@group.calendar.feishu.cn';
  const webhookUrl = 'https://open.feishu.cn/open-apis/bot/v2/hook/stage3-sync-hook';
  const saveRes = await app.inject({
    method: 'PUT',
    url: '/api/settings/feishu',
    headers: { cookie: adminCookie },
    payload: {
      app_id: 'cli_stage3_sync',
      app_secret: 'sec_stage3_sync',
      bot_webhook: webhookUrl,
      bot_secret: '',
      calendar_id: calendarId,
    },
  });
  assert.equal(saveRes.statusCode, 200);

  // 先跳过历史待发
  await app.inject({
    method: 'POST',
    url: '/api/notifications/feishu/skip-pending',
    headers: { cookie: adminCookie },
    payload: {},
  });

  const applicationId = await setupInterviewApplication('全栈工程师（阶段三测试）', '周阶段三', 'zhou-stage3@example.com');

  // 记录所有飞书 HTTP 请求
  const feishuCalls: Array<{ method: string; url: string; body?: Record<string, unknown> }> = [];
  const generatedVcUrl = 'https://vc.feishu.cn/j/987654321';

  setFeishuFetchForTest(async (input, init) => {
    const url = String(input);
    const method = String(init?.method ?? 'GET');
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    feishuCalls.push({ method, url, body });

    if (url.endsWith('/open-apis/auth/v3/tenant_access_token/internal')) {
      return jsonResponse({ code: 0, msg: 'ok', tenant_access_token: 't-stage3-sync-token', expire: 7200 });
    }
    if (url === webhookUrl) {
      return jsonResponse({ code: 0, msg: 'success' });
    }
    if (method === 'POST' && url.includes('/open-apis/im/v1/messages?receive_id_type=open_id')) {
      return jsonResponse({ code: 0, msg: 'ok', data: { message_id: `om_dm_${feishuCalls.length}` } });
    }
    if (
      (method === 'POST' && url.endsWith(`/open-apis/calendar/v4/calendars/${encodeURIComponent(calendarId)}/events`)) ||
      (method === 'PATCH' && url.includes('/events/evt_stage3_001'))
    ) {
      return jsonResponse({
        code: 0,
        msg: 'ok',
        data: { event: { event_id: 'evt_stage3_001', vchat: { vc_type: 'vc', meeting_url: generatedVcUrl } } },
      });
    }
    if (method === 'POST' && url.includes('/events/evt_stage3_001/attendees/batch_delete')) {
      return jsonResponse({ code: 0, msg: 'ok', data: {} });
    }
    if (method === 'POST' && url.includes('/events/evt_stage3_001/attendees?user_id_type=open_id')) {
      return jsonResponse({ code: 0, msg: 'ok', data: { attendees: [] } });
    }
    if (method === 'DELETE' && url.includes('/events/evt_stage3_001')) {
      return jsonResponse({ code: 0, msg: 'ok', data: {} });
    }
    throw new Error(`unexpected feishu call: ${method} ${url}`);
  });

  // 1) 安排视频面试且不手填 meetingUrl -> 自动生成飞书会议链接、邀请面试官 A、并在同步完成后发群卡片 + 面试官 A 私信卡片
  const createItv = await app.inject({
    method: 'POST',
    url: '/api/interviews',
    headers: { cookie: adminCookie },
    payload: {
      applicationId,
      scheduledAt: '2026-12-01T06:00:00.000Z',
      durationMinutes: 45,
      mode: 'video',
      interviewerId: adminUserId,
    },
  });
  assert.equal(createItv.statusCode, 201);
  const interviewId = createItv.json().interview.id as string;
  assert.equal(createItv.json().interview.calendar_sync_status, 'pending');

  await waitForCalendarSyncs();
  await waitForFeishuDispatches();

  // 校验数据库中已回写 external_calendar_event_id、meeting_url 和 calendar_sync_status
  const syncedRow = getRow<{
    external_calendar_event_id: string | null;
    meeting_url: string | null;
    calendar_sync_status: string;
    calendar_sync_error: string | null;
    calendar_synced_at: string | null;
  }>(
    `SELECT external_calendar_event_id, meeting_url, calendar_sync_status, calendar_sync_error, calendar_synced_at
       FROM interviews WHERE id = ?`,
    [interviewId],
  );
  assert.equal(syncedRow?.external_calendar_event_id, 'evt_stage3_001');
  assert.equal(syncedRow?.meeting_url, generatedVcUrl);
  assert.equal(syncedRow?.calendar_sync_status, 'synced');
  assert.equal(syncedRow?.calendar_sync_error, null);
  assert.ok(syncedRow?.calendar_synced_at);

  // 校验日程创建请求带 vchat.vc_type = 'vc' 与参与人 ou_interviewer_A
  const createEventCall = feishuCalls.find(
    (c) => c.method === 'POST' && c.url.endsWith(`/open-apis/calendar/v4/calendars/${encodeURIComponent(calendarId)}/events`),
  );
  assert.ok(createEventCall);
  assert.deepEqual(createEventCall.body?.vchat, { vc_type: 'vc' });
  const addAttendeeA = feishuCalls.find(
    (c) => c.method === 'POST' && c.url.includes('/events/evt_stage3_001/attendees?user_id_type=open_id'),
  );
  assert.ok(addAttendeeA);
  assert.deepEqual(addAttendeeA.body?.attendees, [{ type: 'user', user_id: 'ou_interviewer_A' }]);

  // 校验发给面试官 A 的私信卡片 & 群机器人卡片都携带了自动回写的飞书视频会议链接
  const dmCall1 = feishuCalls.find((c) => c.url.includes('/open-apis/im/v1/messages?receive_id_type=open_id'));
  assert.ok(dmCall1);
  assert.equal(dmCall1.body?.receive_id, 'ou_interviewer_A');
  assert.equal(dmCall1.body?.msg_type, 'interactive');
  assert.ok(String(dmCall1.body?.content).includes(generatedVcUrl), 'DM card should include generated VC link');

  const hookCall1 = feishuCalls.find((c) => c.url === webhookUrl);
  assert.ok(hookCall1);
  assert.ok(JSON.stringify(hookCall1.body).includes(generatedVcUrl), 'Webhook card should include generated VC link');

  // 2) 改期并更换面试官为 B -> PATCH 日程、添加参与人 B、移除旧参与人 A、并向新面试官 B 发私信
  feishuCalls.length = 0;
  const updateItv = await app.inject({
    method: 'PATCH',
    url: `/api/interviews/${interviewId}`,
    headers: { cookie: adminCookie },
    payload: {
      scheduledAt: '2026-12-02T07:00:00.000Z',
      interviewerId: recruiterUserId,
    },
  });
  assert.equal(updateItv.statusCode, 200);
  await waitForCalendarSyncs();
  await waitForFeishuDispatches();

  assert.ok(feishuCalls.some((c) => c.method === 'PATCH' && c.url.includes('/events/evt_stage3_001')));
  const addAttendeeB = feishuCalls.find(
    (c) => c.method === 'POST' && c.url.includes('/events/evt_stage3_001/attendees?user_id_type=open_id'),
  );
  assert.deepEqual(addAttendeeB?.body?.attendees, [{ type: 'user', user_id: 'ou_interviewer_B' }]);
  const removeAttendeeA = feishuCalls.find(
    (c) => c.method === 'POST' && c.url.includes('/events/evt_stage3_001/attendees/batch_delete'),
  );
  assert.deepEqual(removeAttendeeA?.body?.delete_ids, [{ type: 'user', user_id: 'ou_interviewer_A' }]);

  const dmCall2 = feishuCalls.find((c) => c.url.includes('/open-apis/im/v1/messages?receive_id_type=open_id'));
  assert.equal(dmCall2?.body?.receive_id, 'ou_interviewer_B');
  assert.ok(String(dmCall2?.body?.content).includes('面试改期提醒'));

  // 3) 取消面试 -> DELETE 日程、清空 external_calendar_event_id、发送取消通知（站内 + 群机器人 + 面试官 B 私信）
  feishuCalls.length = 0;
  const cancelItv = await app.inject({
    method: 'POST',
    url: `/api/interviews/${interviewId}/cancel`,
    headers: { cookie: adminCookie },
    payload: { note: '候选人临时有事改约' },
  });
  assert.equal(cancelItv.statusCode, 200);
  await waitForCalendarSyncs();
  await waitForFeishuDispatches();

  assert.ok(feishuCalls.some((c) => c.method === 'DELETE' && c.url.includes('/events/evt_stage3_001')));
  const cancelledRow = getRow<{ external_calendar_event_id: string | null; calendar_sync_status: string }>(
    'SELECT external_calendar_event_id, calendar_sync_status FROM interviews WHERE id = ?',
    [interviewId],
  );
  assert.equal(cancelledRow?.external_calendar_event_id, null);
  // 删除成功后不再有任何远端日程，状态回落 none 而不是继续显示「已同步」
  assert.equal(cancelledRow?.calendar_sync_status, 'none');

  const cancelDm = feishuCalls.find((c) => c.url.includes('/open-apis/im/v1/messages?receive_id_type=open_id'));
  assert.equal(cancelDm?.body?.receive_id, 'ou_interviewer_B');
  assert.ok(String(cancelDm?.body?.content).includes('面试取消'));
  assert.ok(String(cancelDm?.body?.content).includes('候选人临时有事改约'));
  assert.ok(feishuCalls.some((c) => c.url === webhookUrl && JSON.stringify(c.body).includes('面试取消')));
});

test('飞书阶段三：日历同步失败不阻塞业务流转、手动重试成功回写，且仅配应用凭证时私信可独立投递', async () => {
  const { run } = await import('../src/db/index.ts');
  const adminUserId = await getUserIdByCookie(adminCookie);
  const recruiterUserId = await getUserIdByCookie(recruiterCookie);
  run('UPDATE users SET feishu_open_id = ? WHERE id = ?', ['ou_interviewer_retry', adminUserId]);
  run('UPDATE users SET feishu_open_id = NULL, feishu_union_id = NULL WHERE id = ?', [recruiterUserId]);

  const calendarId = 'feishu.cn_stage3_retry@group.calendar.feishu.cn';
  // 只配自建应用 + 日历，不配群机器人 Webhook（验证私信可独立投递、Webhook 不阻塞）
  await app.inject({
    method: 'PUT',
    url: '/api/settings/feishu',
    headers: { cookie: adminCookie },
    payload: {
      app_id: 'cli_stage3_retry',
      app_secret: 'sec_stage3_retry',
      bot_webhook: '',
      bot_secret: '',
      calendar_id: calendarId,
    },
  });

  const applicationId = await setupInterviewApplication('产品经理（阶段三重试测试）', '吴重试', 'wu-retry@example.com');

  // 第一次日程创建失败（模拟飞书权限不足），但私信仍应照常发出、业务完全不被阻塞
  let calendarShouldFail = true;
  let dmCount = 0;
  setFeishuFetchForTest(async (input, init) => {
    const url = String(input);
    const method = String(init?.method ?? 'GET');
    if (url.endsWith('/open-apis/auth/v3/tenant_access_token/internal')) {
      return jsonResponse({ code: 0, msg: 'ok', tenant_access_token: 't-stage3-retry-token', expire: 7200 });
    }
    if (method === 'POST' && url.includes('/open-apis/im/v1/messages?receive_id_type=open_id')) {
      dmCount += 1;
      return jsonResponse({ code: 0, msg: 'ok', data: { message_id: `om_retry_${dmCount}` } });
    }
    if (method === 'POST' && url.endsWith(`/open-apis/calendar/v4/calendars/${encodeURIComponent(calendarId)}/events`)) {
      if (calendarShouldFail) {
        return jsonResponse({ code: 190005, msg: 'no calendar write permission' });
      }
      return jsonResponse({
        code: 0,
        msg: 'ok',
        data: {
          event: {
            event_id: 'evt_stage3_recovered',
            vchat: { vc_type: 'vc', meeting_url: 'https://vc.feishu.cn/j/recovered999' },
          },
        },
      });
    }
    if (method === 'POST' && url.includes('/events/evt_stage3_recovered/attendees')) {
      return jsonResponse({ code: 0, msg: 'ok', data: { attendees: [] } });
    }
    throw new Error(`unexpected feishu call: ${method} ${url}`);
  });

  const createRes = await app.inject({
    method: 'POST',
    url: '/api/interviews',
    headers: { cookie: adminCookie },
    payload: {
      applicationId,
      scheduledAt: '2026-12-05T03:00:00.000Z',
      durationMinutes: 60,
      mode: 'video',
      interviewerId: adminUserId,
    },
  });
  assert.equal(createRes.statusCode, 201);
  const interviewId = createRes.json().interview.id as string;

  await waitForCalendarSyncs();
  await waitForFeishuDispatches();

  const failedRow = getRow<{ calendar_sync_status: string; calendar_sync_error: string | null }>(
    'SELECT calendar_sync_status, calendar_sync_error FROM interviews WHERE id = ?',
    [interviewId],
  );
  assert.equal(failedRow?.calendar_sync_status, 'failed');
  assert.match(failedRow?.calendar_sync_error ?? '', /190005/);
  assert.equal(dmCount, 1, 'Interviewer DM should still dispatch even if calendar sync fails and webhook is unset');

  // 恢复飞书日历权限并手动点击重试同步
  calendarShouldFail = false;
  const retryRes = await app.inject({
    method: 'POST',
    url: `/api/interviews/${interviewId}/sync-calendar`,
    headers: { cookie: recruiterCookie },
    payload: {},
  });
  assert.equal(retryRes.statusCode, 200);
  const retryBody = retryRes.json();
  assert.equal(retryBody.sync.ok, true);
  assert.equal(retryBody.sync.meetingUrl, 'https://vc.feishu.cn/j/recovered999');
  assert.equal(retryBody.interview.calendar_sync_status, 'synced');
  assert.equal(retryBody.interview.meeting_url, 'https://vc.feishu.cn/j/recovered999');
  assert.equal(retryBody.interview.calendar_sync_error, null);

  // 未配置共享日历 + 面试官未绑定飞书时：安排面试仍正常，日历状态为 none，且不产生私信通知
  await app.inject({
    method: 'PUT',
    url: '/api/settings/feishu',
    headers: { cookie: adminCookie },
    payload: { calendar_id: '' },
  });
  await app.inject({
    method: 'POST',
    url: `/api/interviews/${interviewId}/cancel`,
    headers: { cookie: adminCookie },
    payload: {},
  });
  await waitForCalendarSyncs();
  await waitForFeishuDispatches();

  let unexpectedCalls = 0;
  setFeishuFetchForTest(async () => {
    unexpectedCalls += 1;
    return jsonResponse({ code: 0, msg: 'ok' });
  });

  const plainRes = await app.inject({
    method: 'POST',
    url: '/api/interviews',
    headers: { cookie: adminCookie },
    payload: {
      applicationId,
      scheduledAt: '2026-12-06T03:00:00.000Z',
      durationMinutes: 45,
      mode: 'video',
      meetingUrl: 'https://meeting.tencent.com/dm/manual-link',
      interviewerId: recruiterUserId,
    },
  });
  assert.equal(plainRes.statusCode, 201);
  assert.equal(plainRes.json().interview.calendar_sync_status, 'none');
  assert.equal(plainRes.json().interview.meeting_url, 'https://meeting.tencent.com/dm/manual-link');
  await waitForCalendarSyncs();
  await waitForFeishuDispatches();
  assert.equal(unexpectedCalls, 0);
});

test('飞书阶段三回归：失败后取消恢复、删除失败保留日程引用、旧面试官移除可重试、切换现场关闭视频会议、仅换面试官也通知', async () => {
  const { run } = await import('../src/db/index.ts');
  const adminUserId = await getUserIdByCookie(adminCookie);
  const recruiterUserId = await getUserIdByCookie(recruiterCookie);
  run('UPDATE users SET feishu_open_id = ? WHERE id = ?', ['ou_reg_A', adminUserId]);
  run('UPDATE users SET feishu_open_id = ? WHERE id = ?', ['ou_reg_B', recruiterUserId]);

  const calendarId = 'feishu.cn_stage3_reg@group.calendar.feishu.cn';
  await app.inject({
    method: 'PUT',
    url: '/api/settings/feishu',
    headers: { cookie: adminCookie },
    payload: {
      app_id: 'cli_stage3_reg',
      app_secret: 'sec_stage3_reg',
      bot_webhook: '',
      bot_secret: '',
      calendar_id: calendarId,
    },
  });
  await app.inject({
    method: 'POST',
    url: '/api/notifications/feishu/skip-pending',
    headers: { cookie: adminCookie },
    payload: {},
  });

  const applicationId = await setupInterviewApplication('后端工程师（阶段三回归）', '郑回归', 'zheng-reg@example.com');

  const calls: Array<{ method: string; url: string; body?: Record<string, unknown> }> = [];
  const dmTargets: string[] = [];
  let createShouldFail = false;
  let removeShouldFail = false;
  let deleteShouldFail = false;
  const regeneratedVcUrl = 'https://vc.feishu.cn/j/regenerated555';

  setFeishuFetchForTest(async (input, init) => {
    const url = String(input);
    const method = String(init?.method ?? 'GET');
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    calls.push({ method, url, body });

    if (url.endsWith('/open-apis/auth/v3/tenant_access_token/internal')) {
      return jsonResponse({ code: 0, msg: 'ok', tenant_access_token: 't-stage3-reg-token', expire: 7200 });
    }
    if (method === 'POST' && url.includes('/open-apis/im/v1/messages?receive_id_type=open_id')) {
      dmTargets.push(String(body?.receive_id ?? ''));
      return jsonResponse({ code: 0, msg: 'ok', data: { message_id: `om_reg_${dmTargets.length}` } });
    }
    if (method === 'POST' && url.endsWith(`/open-apis/calendar/v4/calendars/${encodeURIComponent(calendarId)}/events`)) {
      if (createShouldFail) return jsonResponse({ code: 190005, msg: 'no calendar write permission' });
      return jsonResponse({
        code: 0,
        msg: 'ok',
        data: { event: { event_id: 'evt_stage3_reg', vchat: { vc_type: 'vc', meeting_url: 'https://vc.feishu.cn/j/reg000' } } },
      });
    }
    if (method === 'PATCH' && url.includes('/events/evt_stage3_reg')) {
      return jsonResponse({
        code: 0,
        msg: 'ok',
        data: { event: { event_id: 'evt_stage3_reg', vchat: { vc_type: 'vc', meeting_url: regeneratedVcUrl } } },
      });
    }
    if (method === 'DELETE' && url.includes('/events/evt_stage3_reg')) {
      if (deleteShouldFail) return jsonResponse({ code: 190006, msg: 'calendar event delete forbidden' });
      return jsonResponse({ code: 0, msg: 'ok', data: {} });
    }
    if (method === 'POST' && url.includes('/events/evt_stage3_reg/attendees/batch_delete')) {
      if (removeShouldFail) return jsonResponse({ code: 190007, msg: 'attendee delete forbidden' });
      return jsonResponse({ code: 0, msg: 'ok', data: {} });
    }
    if (method === 'POST' && url.includes('/events/evt_stage3_reg/attendees?user_id_type=open_id')) {
      return jsonResponse({ code: 0, msg: 'ok', data: { attendees: [] } });
    }
    throw new Error(`unexpected feishu call: ${method} ${url}`);
  });

  const readInterview = (interviewId: string) =>
    getRow<{
      external_calendar_event_id: string | null;
      meeting_url: string | null;
      location: string | null;
      calendar_sync_status: string;
      calendar_sync_error: string | null;
      calendar_attendees_json: string;
    }>(
      `SELECT external_calendar_event_id, meeting_url, location, calendar_sync_status, calendar_sync_error, calendar_attendees_json
         FROM interviews WHERE id = ?`,
      [interviewId],
    );

  // 1) 首次安排视频面试：日程同步成功并记录已邀请面试官 A
  const created = await app.inject({
    method: 'POST',
    url: '/api/interviews',
    headers: { cookie: adminCookie },
    payload: {
      applicationId,
      scheduledAt: '2026-12-08T02:00:00.000Z',
      durationMinutes: 60,
      mode: 'video',
      interviewerId: adminUserId,
    },
  });
  assert.equal(created.statusCode, 201);
  const interviewId = created.json().interview.id as string;
  await waitForCalendarSyncs();
  await waitForFeishuDispatches();

  const afterCreate = readInterview(interviewId);
  assert.equal(afterCreate?.calendar_sync_status, 'synced');
  assert.equal(afterCreate?.external_calendar_event_id, 'evt_stage3_reg');
  assert.equal(afterCreate?.calendar_attendees_json, JSON.stringify(['ou_reg_A']));

  // 2) 只更换面试官（不传新时间）：也应通知新面试官；移除旧面试官失败时保留已邀请记录与日程引用
  calls.length = 0;
  dmTargets.length = 0;
  removeShouldFail = true;
  const changeInterviewer = await app.inject({
    method: 'PATCH',
    url: `/api/interviews/${interviewId}`,
    headers: { cookie: adminCookie },
    payload: { interviewerId: recruiterUserId },
  });
  assert.equal(changeInterviewer.statusCode, 200);
  await waitForCalendarSyncs();
  await waitForFeishuDispatches();

  assert.deepEqual(dmTargets, ['ou_reg_B'], '仅更换面试官也应通知新面试官');
  const afterFailedRemove = readInterview(interviewId);
  assert.equal(afterFailedRemove?.external_calendar_event_id, 'evt_stage3_reg');
  assert.equal(afterFailedRemove?.calendar_sync_status, 'failed');
  assert.match(afterFailedRemove?.calendar_sync_error ?? '', /移除原面试官失败/);
  assert.equal(afterFailedRemove?.calendar_attendees_json, JSON.stringify(['ou_reg_A']), '移除失败时保留旧参与人以便重试');

  // 3) 手动重试：旧面试官 A 依靠持久化记录被移除，本次请求不再携带旧面试官参数
  calls.length = 0;
  removeShouldFail = false;
  const retryRemove = await app.inject({
    method: 'POST',
    url: `/api/interviews/${interviewId}/sync-calendar`,
    headers: { cookie: recruiterCookie },
    payload: {},
  });
  assert.equal(retryRemove.statusCode, 200);
  assert.equal(retryRemove.json().sync.ok, true);
  const retriedRemoveCall = calls.find((c) => c.method === 'POST' && c.url.includes('/attendees/batch_delete'));
  assert.deepEqual(retriedRemoveCall?.body?.delete_ids, [{ type: 'user', user_id: 'ou_reg_A' }]);
  const afterRetryRemove = readInterview(interviewId);
  assert.equal(afterRetryRemove?.calendar_sync_status, 'synced');
  assert.equal(afterRetryRemove?.calendar_attendees_json, JSON.stringify(['ou_reg_B']));

  // 4) 由视频切换为现场：清空失效的视频链接，并要求飞书关闭视频会议
  calls.length = 0;
  const switchOnsite = await app.inject({
    method: 'PATCH',
    url: `/api/interviews/${interviewId}`,
    headers: { cookie: adminCookie },
    payload: { mode: 'onsite', location: '3 号会议室' },
  });
  assert.equal(switchOnsite.statusCode, 200);
  await waitForCalendarSyncs();
  await waitForFeishuDispatches();

  const onsitePatch = calls.find((c) => c.method === 'PATCH' && c.url.includes('/events/evt_stage3_reg'));
  assert.deepEqual(onsitePatch?.body?.vchat, { vc_type: 'no_meeting' });
  assert.deepEqual(onsitePatch?.body?.location, { name: '3 号会议室' });
  const afterOnsite = readInterview(interviewId);
  assert.equal(afterOnsite?.meeting_url, null, '切换现场后面试不再保留视频会议链接');
  assert.equal(afterOnsite?.calendar_sync_status, 'synced');

  // 4b) 再由现场切回视频：飞书 PATCH 没有「清空地点」语义，只能删旧建新，并重新生成会议链接
  calls.length = 0;
  const switchVideo = await app.inject({
    method: 'PATCH',
    url: `/api/interviews/${interviewId}`,
    headers: { cookie: adminCookie },
    payload: { mode: 'video' },
  });
  assert.equal(switchVideo.statusCode, 200);
  await waitForCalendarSyncs();
  await waitForFeishuDispatches();

  const deleteIndex = calls.findIndex((c) => c.method === 'DELETE' && c.url.includes('/events/evt_stage3_reg'));
  const createEventUrl = `/open-apis/calendar/v4/calendars/${encodeURIComponent(calendarId)}/events`;
  const recreateIndex = calls.findIndex((c) => c.method === 'POST' && c.url.endsWith(createEventUrl));
  assert.ok(deleteIndex >= 0, '现场改视频时必须先删掉带旧会议室的日程');
  assert.ok(recreateIndex > deleteIndex, '删掉旧日程后必须重建');
  assert.equal(calls.filter((c) => c.method === 'DELETE').length, 1, '旧日程只删除一次');
  const recreateBody = calls[recreateIndex]?.body ?? {};
  assert.equal('location' in recreateBody, false, '重建日程时不能传空地点（飞书要求 location.name 1-512 字符）');
  assert.deepEqual(recreateBody.vchat, { vc_type: 'vc' });
  assert.equal(readInterview(interviewId)?.meeting_url, 'https://vc.feishu.cn/j/reg000');
  assert.equal(readInterview(interviewId)?.calendar_sync_status, 'synced');

  // 4c) 现场面试把地点清空（形式不变）：同样删旧建新，远端不留旧会议室
  calls.length = 0;
  const backOnsite = await app.inject({
    method: 'PATCH',
    url: `/api/interviews/${interviewId}`,
    headers: { cookie: adminCookie },
    payload: { mode: 'onsite', location: '5 号会议室' },
  });
  assert.equal(backOnsite.statusCode, 200);
  await waitForCalendarSyncs();
  await waitForFeishuDispatches();
  assert.equal(readInterview(interviewId)?.calendar_sync_status, 'synced');

  calls.length = 0;
  const clearLocation = await app.inject({
    method: 'PATCH',
    url: `/api/interviews/${interviewId}`,
    headers: { cookie: adminCookie },
    payload: { location: '' },
  });
  assert.equal(clearLocation.statusCode, 200);
  await waitForCalendarSyncs();
  await waitForFeishuDispatches();
  const clearDeleteIndex = calls.findIndex((c) => c.method === 'DELETE' && c.url.includes('/events/evt_stage3_reg'));
  const clearCreateIndex = calls.findIndex((c) => c.method === 'POST' && c.url.endsWith(createEventUrl));
  assert.ok(clearDeleteIndex >= 0, '现场面试清空地点时必须删掉带旧会议室的日程');
  assert.ok(clearCreateIndex > clearDeleteIndex, '删掉旧日程后必须重建');
  assert.equal('location' in (calls[clearCreateIndex]?.body ?? {}), false, '重建日程不能传空地点');
  assert.deepEqual(calls[clearCreateIndex]?.body?.vchat, { vc_type: 'no_meeting' });
  assert.equal(readInterview(interviewId)?.location, null);

  // 4d) 重建前的删除失败：状态 failed 且保留引用；手动重试仍会删旧建新，而不是只 PATCH 旧日程
  deleteShouldFail = true;
  calls.length = 0;
  const videoAgain = await app.inject({
    method: 'PATCH',
    url: `/api/interviews/${interviewId}`,
    headers: { cookie: adminCookie },
    payload: { mode: 'video' },
  });
  assert.equal(videoAgain.statusCode, 200);
  await waitForCalendarSyncs();
  await waitForFeishuDispatches();
  const afterRecreateDeleteFailure = readInterview(interviewId);
  assert.equal(afterRecreateDeleteFailure?.calendar_sync_status, 'failed');
  assert.equal(afterRecreateDeleteFailure?.external_calendar_event_id, 'evt_stage3_reg', '删除失败必须保留日程引用');

  deleteShouldFail = false;
  calls.length = 0;
  const retryRecreate = await app.inject({
    method: 'POST',
    url: `/api/interviews/${interviewId}/sync-calendar`,
    headers: { cookie: adminCookie },
    payload: {},
  });
  assert.equal(retryRecreate.statusCode, 200);
  assert.equal(retryRecreate.json().sync.ok, true);
  const retryDeleteIndex = calls.findIndex((c) => c.method === 'DELETE' && c.url.includes('/events/evt_stage3_reg'));
  const retryCreateIndex = calls.findIndex((c) => c.method === 'POST' && c.url.endsWith(createEventUrl));
  assert.ok(retryDeleteIndex >= 0, '重试时仍必须先删除带旧地点的日程');
  assert.ok(retryCreateIndex > retryDeleteIndex, '重试时删旧后必须重建');
  assert.equal('location' in (calls[retryCreateIndex]?.body ?? {}), false);
  assert.equal(readInterview(interviewId)?.calendar_sync_status, 'synced');

  // 4e) 重建完成后标记已清除：普通改期只 PATCH，不再反复删建
  calls.length = 0;
  const rescheduleAfterRecreate = await app.inject({
    method: 'PATCH',
    url: `/api/interviews/${interviewId}`,
    headers: { cookie: adminCookie },
    payload: { scheduledAt: '2026-12-12T02:00:00.000Z' },
  });
  assert.equal(rescheduleAfterRecreate.statusCode, 200);
  await waitForCalendarSyncs();
  await waitForFeishuDispatches();
  assert.equal(calls.filter((c) => c.method === 'DELETE').length, 0, '重建完成后不应再删日程');
  assert.equal(calls.filter((c) => c.method === 'PATCH' && c.url.includes('/events/evt_stage3_reg')).length, 1);

  // 5) 取消时删除日程失败：保留日程引用，恢复后重试可清空
  deleteShouldFail = true;
  const cancelFailed = await app.inject({
    method: 'POST',
    url: `/api/interviews/${interviewId}/cancel`,
    headers: { cookie: adminCookie },
    payload: {},
  });
  assert.equal(cancelFailed.statusCode, 200);
  await waitForCalendarSyncs();
  await waitForFeishuDispatches();

  const afterFailedDelete = readInterview(interviewId);
  assert.equal(afterFailedDelete?.external_calendar_event_id, 'evt_stage3_reg', '删除失败必须保留日程引用');
  assert.equal(afterFailedDelete?.calendar_sync_status, 'failed');

  deleteShouldFail = false;
  const retryDelete = await app.inject({
    method: 'POST',
    url: `/api/interviews/${interviewId}/sync-calendar`,
    headers: { cookie: adminCookie },
    payload: {},
  });
  assert.equal(retryDelete.statusCode, 200);
  assert.equal(retryDelete.json().sync.ok, true);
  const afterRetryDelete = readInterview(interviewId);
  assert.equal(afterRetryDelete?.external_calendar_event_id, null);
  assert.equal(afterRetryDelete?.calendar_sync_status, 'none');
  assert.equal(afterRetryDelete?.calendar_attendees_json, '[]');

  // 6) 首次同步就失败、随后取消：状态回落为 none，重试也不会复活失败态
  createShouldFail = true;
  const failedCreate = await app.inject({
    method: 'POST',
    url: '/api/interviews',
    headers: { cookie: adminCookie },
    payload: {
      applicationId,
      scheduledAt: '2026-12-09T02:00:00.000Z',
      durationMinutes: 30,
      mode: 'video',
      interviewerId: adminUserId,
    },
  });
  assert.equal(failedCreate.statusCode, 201);
  const failedInterviewId = failedCreate.json().interview.id as string;
  await waitForCalendarSyncs();
  await waitForFeishuDispatches();
  assert.equal(readInterview(failedInterviewId)?.calendar_sync_status, 'failed');

  const cancelNeverSynced = await app.inject({
    method: 'POST',
    url: `/api/interviews/${failedInterviewId}/cancel`,
    headers: { cookie: adminCookie },
    payload: {},
  });
  assert.equal(cancelNeverSynced.statusCode, 200);
  await waitForCalendarSyncs();
  await waitForFeishuDispatches();

  const afterNeverSyncedCancel = readInterview(failedInterviewId);
  assert.equal(afterNeverSyncedCancel?.calendar_sync_status, 'none');
  assert.equal(afterNeverSyncedCancel?.calendar_sync_error, null);
  assert.equal(afterNeverSyncedCancel?.external_calendar_event_id, null);
  assert.equal(afterNeverSyncedCancel?.calendar_attendees_json, '[]');

  calls.length = 0;
  const retryCancelled = await app.inject({
    method: 'POST',
    url: `/api/interviews/${failedInterviewId}/sync-calendar`,
    headers: { cookie: adminCookie },
    payload: {},
  });
  assert.equal(retryCancelled.statusCode, 200);
  assert.equal(retryCancelled.json().sync.skipped, true);
  assert.equal(readInterview(failedInterviewId)?.calendar_sync_status, 'none');
  assert.equal(
    calls.filter((c) => c.url.includes('/open-apis/calendar/v4/')).length,
    0,
    '从未创建成功的面试取消后不应再请求飞书日历',
  );
});

test('飞书阶段三：更新日程返回 190002 参数错误时，不当作「日程不存在」去重建日程', async () => {
  const { run } = await import('../src/db/index.ts');
  const adminUserId = await getUserIdByCookie(adminCookie);
  run('UPDATE users SET feishu_open_id = ? WHERE id = ?', ['ou_patch_err', adminUserId]);

  const calendarId = 'feishu.cn_stage3_patch_error@group.calendar.feishu.cn';
  await app.inject({
    method: 'PUT',
    url: '/api/settings/feishu',
    headers: { cookie: adminCookie },
    payload: {
      app_id: 'cli_stage3_patch_error',
      app_secret: 'sec_stage3_patch_error',
      bot_webhook: '',
      bot_secret: '',
      calendar_id: calendarId,
    },
  });
  await app.inject({
    method: 'POST',
    url: '/api/notifications/feishu/skip-pending',
    headers: { cookie: adminCookie },
    payload: {},
  });

  const applicationId = await setupInterviewApplication('测试工程师（190002 回归）', '钱参数', 'qian-param@example.com');
  const createEventUrl = `/open-apis/calendar/v4/calendars/${encodeURIComponent(calendarId)}/events`;
  const calls: Array<{ method: string; url: string }> = [];
  let patchFailure: { code: number; msg: string; status?: number } | null = null;

  setFeishuFetchForTest(async (input, init) => {
    const url = String(input);
    const method = String(init?.method ?? 'GET');
    calls.push({ method, url });
    if (url.endsWith('/open-apis/auth/v3/tenant_access_token/internal')) {
      return jsonResponse({ code: 0, msg: 'ok', tenant_access_token: 't-stage3-patch-error', expire: 7200 });
    }
    if (method === 'POST' && url.includes('/open-apis/im/v1/messages?receive_id_type=open_id')) {
      return jsonResponse({ code: 0, msg: 'ok', data: { message_id: 'om_patch_error' } });
    }
    if (method === 'POST' && url.endsWith(createEventUrl)) {
      return jsonResponse({
        code: 0,
        msg: 'ok',
        data: {
          event: { event_id: 'evt_patch_error', vchat: { vc_type: 'vc', meeting_url: 'https://vc.feishu.cn/j/patch-error' } },
        },
      });
    }
    if (method === 'PATCH' && url.includes('/events/evt_patch_error')) {
      if (patchFailure) return jsonResponse({ code: patchFailure.code, msg: patchFailure.msg }, patchFailure.status ?? 200);
      return jsonResponse({ code: 0, msg: 'ok', data: { event: { event_id: 'evt_patch_error' } } });
    }
    if (method === 'POST' && url.includes('/events/evt_patch_error/attendees?user_id_type=open_id')) {
      return jsonResponse({ code: 0, msg: 'ok', data: { attendees: [] } });
    }
    throw new Error(`unexpected feishu call: ${method} ${url}`);
  });

  const created = await app.inject({
    method: 'POST',
    url: '/api/interviews',
    headers: { cookie: adminCookie },
    payload: {
      applicationId,
      scheduledAt: '2026-12-10T02:00:00.000Z',
      durationMinutes: 45,
      mode: 'video',
      interviewerId: adminUserId,
    },
  });
  assert.equal(created.statusCode, 201);
  const interviewId = created.json().interview.id as string;
  await waitForCalendarSyncs();
  await waitForFeishuDispatches();

  patchFailure = { code: 190002, msg: 'invalid parameters in request' };
  calls.length = 0;
  const rescheduled = await app.inject({
    method: 'PATCH',
    url: `/api/interviews/${interviewId}`,
    headers: { cookie: adminCookie },
    payload: { scheduledAt: '2026-12-11T02:00:00.000Z' },
  });
  assert.equal(rescheduled.statusCode, 200);
  await waitForCalendarSyncs();
  await waitForFeishuDispatches();

  assert.equal(
    calls.filter((c) => c.method === 'POST' && c.url.endsWith(createEventUrl)).length,
    0,
    '190002 是参数错误，不能被当成「日程不存在」而重建日程',
  );
  const row = getRow<{ external_calendar_event_id: string | null; calendar_sync_status: string; calendar_sync_error: string | null }>(
    'SELECT external_calendar_event_id, calendar_sync_status, calendar_sync_error FROM interviews WHERE id = ?',
    [interviewId],
  );
  assert.equal(row?.external_calendar_event_id, 'evt_patch_error', '更新失败时必须保留日程引用');
  assert.equal(row?.calendar_sync_status, 'failed');
  assert.match(row?.calendar_sync_error ?? '', /190002/);

  // 191000 是「共享日历不存在」，属于配置错误：同样不能当作事件已删而去重建
  patchFailure = { code: 191000, msg: 'calendar not found', status: 404 };
  calls.length = 0;
  const retryWithBrokenCalendar = await app.inject({
    method: 'POST',
    url: `/api/interviews/${interviewId}/sync-calendar`,
    headers: { cookie: adminCookie },
    payload: {},
  });
  assert.equal(retryWithBrokenCalendar.statusCode, 200);
  assert.equal(retryWithBrokenCalendar.json().sync.ok, false);
  assert.equal(
    calls.filter((c) => c.method === 'POST' && c.url.endsWith(createEventUrl)).length,
    0,
    '191000 是日历配置问题，不能重建日程',
  );
  const brokenRow = getRow<{ external_calendar_event_id: string | null; calendar_sync_status: string; calendar_sync_error: string | null }>(
    'SELECT external_calendar_event_id, calendar_sync_status, calendar_sync_error FROM interviews WHERE id = ?',
    [interviewId],
  );
  assert.equal(brokenRow?.external_calendar_event_id, 'evt_patch_error');
  assert.equal(brokenRow?.calendar_sync_status, 'failed');
  assert.match(brokenRow?.calendar_sync_error ?? '', /191000/);
});

test('飞书阶段三错误码：190007/195100 不当成成功或事件不存在，193003 幂等，191003 提示日历配置', async () => {
  const calendarId = 'feishu.cn_stage3_error_codes@group.calendar.feishu.cn';
  await app.inject({
    method: 'PUT',
    url: '/api/settings/feishu',
    headers: { cookie: adminCookie },
    payload: {
      app_id: 'cli_stage3_error_codes',
      app_secret: 'sec_stage3_error_codes',
      bot_webhook: '',
      bot_secret: '',
      calendar_id: calendarId,
    },
  });
  await app.inject({
    method: 'POST',
    url: '/api/notifications/feishu/skip-pending',
    headers: { cookie: adminCookie },
    payload: {},
  });
  clearTenantTokenCache();

  const createEventUrl = `/open-apis/calendar/v4/calendars/${encodeURIComponent(calendarId)}/events`;
  const calls: Array<{ method: string; url: string }> = [];
  let deleteReply: { status: number; code: number; msg: string } = {
    status: 404,
    code: 190007,
    msg: 'app bot_id not found',
  };
  let patchReply: { status: number; code: number; msg: string } = { status: 404, code: 195100, msg: 'user dismissed' };

  setFeishuFetchForTest(async (input, init) => {
    const url = String(input);
    const method = String(init?.method ?? 'GET');
    calls.push({ method, url });
    if (url.endsWith('/open-apis/auth/v3/tenant_access_token/internal')) {
      return jsonResponse({ code: 0, msg: 'ok', tenant_access_token: 't-stage3-error-codes', expire: 7200 });
    }
    if (method === 'DELETE' && url.includes('/events/evt_error_code')) {
      return jsonResponse({ code: deleteReply.code, msg: deleteReply.msg }, deleteReply.status);
    }
    if (method === 'PATCH' && url.includes('/events/evt_error_code')) {
      return jsonResponse({ code: patchReply.code, msg: patchReply.msg }, patchReply.status);
    }
    if (method === 'POST' && url.endsWith(createEventUrl)) {
      return jsonResponse({ code: 0, msg: 'ok', data: { event: { event_id: 'evt_recreated' } } });
    }
    throw new Error(`unexpected feishu call: ${method} ${url}`);
  });

  const baseInput = {
    summary: '【第 1 轮面试】错误码回归',
    description: '错误码回归',
    startAt: '2026-12-10T02:00:00.000Z',
    durationMinutes: 45,
    mode: 'video' as const,
    location: null,
    meetingUrl: null,
    attendeeOpenIds: [],
    previousAttendeeOpenIds: [],
  };

  const deleteNotAllowed = await syncFeishuCalendarEvent({
    action: 'delete',
    existingEventId: 'evt_error_code',
    ...baseInput,
  });
  assert.equal(deleteNotAllowed.ok, false, '190007 不代表日程不存在，删除失败必须保留引用');
  assert.equal(deleteNotAllowed.eventId, 'evt_error_code');
  assert.match(deleteNotAllowed.reason ?? '', /190007/);

  deleteReply = { status: 403, code: 193003, msg: 'event is deleted' };
  const deleteIdempotent = await syncFeishuCalendarEvent({
    action: 'delete',
    existingEventId: 'evt_error_code',
    ...baseInput,
  });
  assert.equal(deleteIdempotent.ok, true, '193003 表示远端已删除，删除应按幂等成功处理');
  assert.equal(deleteIdempotent.eventId, null);

  calls.length = 0;
  const patchDismissed = await syncFeishuCalendarEvent({
    action: 'upsert',
    existingEventId: 'evt_error_code',
    ...baseInput,
  });
  assert.equal(patchDismissed.ok, false);
  assert.equal(patchDismissed.eventId, 'evt_error_code');
  assert.match(patchDismissed.reason ?? '', /195100/);
  assert.equal(
    calls.filter((c) => c.method === 'POST' && c.url.endsWith(createEventUrl)).length,
    0,
    '195100 不是事件不存在，不能触发重建',
  );

  patchReply = { status: 403, code: 193003, msg: 'event is deleted' };
  calls.length = 0;
  const rebuilt = await syncFeishuCalendarEvent({ action: 'upsert', existingEventId: 'evt_error_code', ...baseInput });
  assert.equal(rebuilt.ok, true);
  assert.equal(rebuilt.eventId, 'evt_recreated');
  assert.equal(
    calls.filter((c) => c.method === 'POST' && c.url.endsWith(createEventUrl)).length,
    1,
    '远端日程已被删除时，更新应改走新建而不是反复失败',
  );

  deleteReply = { status: 403, code: 191003, msg: 'calendar is deleted' };
  const calendarGone = await syncFeishuCalendarEvent({
    action: 'delete',
    existingEventId: 'evt_error_code',
    ...baseInput,
  });
  assert.equal(calendarGone.ok, false);
  assert.equal(calendarGone.eventId, 'evt_error_code');
  assert.match(calendarGone.reason ?? '', /日历不可用/);

  // 191003 出现在更新路径时同样提示日历配置，而不是让人以为重试就能好
  patchReply = { status: 403, code: 191003, msg: 'calendar is deleted' };
  const patchCalendarGone = await syncFeishuCalendarEvent({
    action: 'upsert',
    existingEventId: 'evt_error_code',
    ...baseInput,
  });
  assert.equal(patchCalendarGone.ok, false);
  assert.equal(patchCalendarGone.eventId, 'evt_error_code');
  assert.match(patchCalendarGone.reason ?? '', /日历不可用/);

  // 193001 是唯一「事件确实不存在」的正向路径：删除视为成功，更新回退新建
  deleteReply = { status: 404, code: 193001, msg: 'event not found' };
  const deleteMissing = await syncFeishuCalendarEvent({
    action: 'delete',
    existingEventId: 'evt_error_code',
    ...baseInput,
  });
  assert.equal(deleteMissing.ok, true, '193001 表示事件已不存在，删除应按成功处理');
  assert.equal(deleteMissing.eventId, null);

  patchReply = { status: 404, code: 193001, msg: 'event not found' };
  calls.length = 0;
  const rebuiltFromMissing = await syncFeishuCalendarEvent({
    action: 'upsert',
    existingEventId: 'evt_error_code',
    ...baseInput,
  });
  assert.equal(rebuiltFromMissing.ok, true);
  assert.equal(rebuiltFromMissing.eventId, 'evt_recreated');
  assert.equal(
    calls.filter((c) => c.method === 'POST' && c.url.endsWith(createEventUrl)).length,
    1,
    '193001 时更新必须且只能重建一次日程',
  );
});

test('飞书阶段三回归：清空地点后重建失败，现场编辑不丢重建意图，重试仍删旧建新', async () => {
  const { run } = await import('../src/db/index.ts');
  const adminUserId = await getUserIdByCookie(adminCookie);
  run('UPDATE users SET feishu_open_id = ? WHERE id = ?', ['ou_recreate_intent', adminUserId]);

  const calendarId = 'feishu.cn_stage3_recreate_intent@group.calendar.feishu.cn';
  await app.inject({
    method: 'PUT',
    url: '/api/settings/feishu',
    headers: { cookie: adminCookie },
    payload: {
      app_id: 'cli_stage3_recreate_intent',
      app_secret: 'sec_stage3_recreate_intent',
      bot_webhook: '',
      bot_secret: '',
      calendar_id: calendarId,
    },
  });
  await app.inject({
    method: 'POST',
    url: '/api/notifications/feishu/skip-pending',
    headers: { cookie: adminCookie },
    payload: {},
  });

  const applicationId = await setupInterviewApplication('测试工程师（重建意图）', '周重建', 'zhou-recreate@example.com');
  const createEventUrl = `/open-apis/calendar/v4/calendars/${encodeURIComponent(calendarId)}/events`;
  const calls: Array<{ method: string; url: string }> = [];
  let deleteFails = false;
  let createdCount = 0;

  setFeishuFetchForTest(async (input, init) => {
    const url = String(input);
    const method = String(init?.method ?? 'GET');
    calls.push({ method, url });
    if (url.endsWith('/open-apis/auth/v3/tenant_access_token/internal')) {
      return jsonResponse({ code: 0, msg: 'ok', tenant_access_token: 't-stage3-recreate-intent', expire: 7200 });
    }
    if (method === 'POST' && url.includes('/open-apis/im/v1/messages?receive_id_type=open_id')) {
      return jsonResponse({ code: 0, msg: 'ok', data: { message_id: 'om_recreate_intent' } });
    }
    if (method === 'POST' && url.endsWith(createEventUrl)) {
      createdCount += 1;
      return jsonResponse({ code: 0, msg: 'ok', data: { event: { event_id: `evt_intent_${createdCount}` } } });
    }
    if (method === 'PATCH' && url.includes('/events/evt_intent_')) {
      return jsonResponse({ code: 0, msg: 'ok', data: { event: { event_id: url.split('/events/')[1] } } });
    }
    if (method === 'DELETE' && url.includes('/events/evt_intent_')) {
      if (deleteFails) return jsonResponse({ code: 99991400, msg: 'rate limited' }, 500);
      return jsonResponse({ code: 0, msg: 'ok', data: {} });
    }
    if (method === 'POST' && url.includes('/attendees?user_id_type=open_id')) {
      return jsonResponse({ code: 0, msg: 'ok', data: { attendees: [] } });
    }
    if (method === 'POST' && url.includes('/attendees/batch_delete?user_id_type=open_id')) {
      return jsonResponse({ code: 0, msg: 'ok', data: {} });
    }
    throw new Error(`unexpected feishu call: ${method} ${url}`);
  });

  const created = await app.inject({
    method: 'POST',
    url: '/api/interviews',
    headers: { cookie: adminCookie },
    payload: {
      applicationId,
      scheduledAt: '2026-12-14T02:00:00.000Z',
      durationMinutes: 45,
      mode: 'onsite',
      location: 'A 座 3 层会议室',
      interviewerId: adminUserId,
    },
  });
  assert.equal(created.statusCode, 201);
  const interviewId = created.json().interview.id as string;
  await waitForCalendarSyncs();
  await waitForFeishuDispatches();
  assert.equal(readCalendarRow(interviewId)?.calendar_sync_status, 'synced');

  // 清空地点需要删旧建新，但删除失败 → 失败并保留事件引用与重建意图
  deleteFails = true;
  const cleared = await app.inject({
    method: 'PATCH',
    url: `/api/interviews/${interviewId}`,
    headers: { cookie: adminCookie },
    payload: { location: '' },
  });
  assert.equal(cleared.statusCode, 200);
  await waitForCalendarSyncs();
  await waitForFeishuDispatches();
  const afterClear = readCalendarRow(interviewId);
  assert.equal(afterClear?.calendar_sync_status, 'failed');
  assert.equal(afterClear?.external_calendar_event_id, 'evt_intent_1');
  assert.equal(afterClear?.calendar_recreate_required, 1);

  // 删除仍失败时，现场形式下改时长不能把重建意图清掉（否则重试只会 PATCH，旧会议室永久留在远端）
  calls.length = 0;
  const edited = await app.inject({
    method: 'PATCH',
    url: `/api/interviews/${interviewId}`,
    headers: { cookie: adminCookie },
    payload: { durationMinutes: 60 },
  });
  assert.equal(edited.statusCode, 200);
  await waitForCalendarSyncs();
  await waitForFeishuDispatches();
  const afterEdit = readCalendarRow(interviewId);
  assert.equal(afterEdit?.calendar_recreate_required, 1, '重建意图不能被无关的现场编辑清掉');
  assert.equal(afterEdit?.calendar_sync_status, 'failed', '删除旧日程失败时必须保持失败态');
  assert.equal(afterEdit?.external_calendar_event_id, 'evt_intent_1');
  assert.ok(
    calls.some((c) => c.method === 'DELETE' && c.url.includes('/events/evt_intent_1')),
    '只要重建意图还在，每次同步都应先尝试删旧日程',
  );
  assert.equal(
    calls.filter((c) => c.method === 'POST' && c.url.endsWith(createEventUrl)).length,
    0,
    '删除失败时不能继续新建，否则远端会多出日程',
  );

  // 恢复后重试：仍然先删旧再建新，而不是只 PATCH
  deleteFails = false;
  calls.length = 0;
  const retried = await app.inject({
    method: 'POST',
    url: `/api/interviews/${interviewId}/sync-calendar`,
    headers: { cookie: adminCookie },
    payload: {},
  });
  assert.equal(retried.statusCode, 200);
  assert.equal(retried.json().sync.ok, true);
  const deleteIndex = calls.findIndex((c) => c.method === 'DELETE' && c.url.includes('/events/evt_intent_1'));
  const createIndex = calls.findIndex((c) => c.method === 'POST' && c.url.endsWith(createEventUrl));
  assert.ok(deleteIndex >= 0 && createIndex > deleteIndex, '重试必须先删除旧日程再重建');
  const afterRetry = readCalendarRow(interviewId);
  assert.equal(afterRetry?.external_calendar_event_id, 'evt_intent_2');
  assert.equal(afterRetry?.calendar_sync_status, 'synced');
  assert.equal(afterRetry?.calendar_recreate_required, 0);

  // 先填一个地点，再在删除失败的情况下清空，才真正制造出「待重建」状态
  const setLocation = await app.inject({
    method: 'PATCH',
    url: `/api/interviews/${interviewId}`,
    headers: { cookie: adminCookie },
    payload: { location: 'C 座 1 层会议室' },
  });
  assert.equal(setLocation.statusCode, 200);
  await waitForCalendarSyncs();
  await waitForFeishuDispatches();
  assert.equal(readCalendarRow(interviewId)?.calendar_recreate_required, 0);

  deleteFails = true;
  const clearedAgain = await app.inject({
    method: 'PATCH',
    url: `/api/interviews/${interviewId}`,
    headers: { cookie: adminCookie },
    payload: { location: '' },
  });
  assert.equal(clearedAgain.statusCode, 200);
  await waitForCalendarSyncs();
  await waitForFeishuDispatches();
  const beforeRestore = readCalendarRow(interviewId);
  assert.equal(beforeRestore?.calendar_recreate_required, 1, '清空地点且删除失败后应保留重建意图');
  assert.equal(beforeRestore?.calendar_sync_status, 'failed');

  // 重新填回地点时不需要删旧建新：PATCH 就能把地点写进远端日程，标记应清 0
  const patchBodies: Array<Record<string, unknown>> = [];
  setFeishuFetchForTest(async (input, init) => {
    const url = String(input);
    const method = String(init?.method ?? 'GET');
    calls.push({ method, url });
    if (url.endsWith('/open-apis/auth/v3/tenant_access_token/internal')) {
      return jsonResponse({ code: 0, msg: 'ok', tenant_access_token: 't-stage3-recreate-intent', expire: 7200 });
    }
    if (method === 'POST' && url.includes('/open-apis/im/v1/messages?receive_id_type=open_id')) {
      return jsonResponse({ code: 0, msg: 'ok', data: { message_id: 'om_recreate_intent' } });
    }
    if (method === 'PATCH' && url.includes('/events/evt_intent_2')) {
      patchBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      return jsonResponse({ code: 0, msg: 'ok', data: { event: { event_id: 'evt_intent_2' } } });
    }
    if (method === 'POST' && url.includes('/attendees?user_id_type=open_id')) {
      return jsonResponse({ code: 0, msg: 'ok', data: { attendees: [] } });
    }
    if (method === 'DELETE' && url.includes('/events/evt_intent_2')) {
      // 这里保留可用返回：如果实现错误地选择删旧建新，会命中该分支并被断言抓到
      return jsonResponse({ code: 0, msg: 'ok', data: {} });
    }
    throw new Error(`unexpected feishu call: ${method} ${url}`);
  });

  calls.length = 0;
  const restored = await app.inject({
    method: 'PATCH',
    url: `/api/interviews/${interviewId}`,
    headers: { cookie: adminCookie },
    payload: { location: 'B 座 5 层会议室' },
  });
  assert.equal(restored.statusCode, 200);
  await waitForCalendarSyncs();
  await waitForFeishuDispatches();

  const afterRestore = readCalendarRow(interviewId);
  assert.equal(afterRestore?.calendar_recreate_required, 0, '重新填回地点后应清掉重建标记');
  assert.equal(afterRestore?.calendar_sync_status, 'synced');
  assert.equal(afterRestore?.external_calendar_event_id, 'evt_intent_2');
  assert.equal(
    calls.filter((c) => c.method === 'DELETE').length,
    0,
    '只是填回地点时只需 PATCH，不应删旧建新',
  );
  assert.equal(
    calls.filter((c) => c.method === 'POST' && c.url.endsWith(createEventUrl)).length,
    0,
    '只填回地点时不应新建日程',
  );
  const lastPatch = patchBodies.at(-1);
  assert.deepEqual(lastPatch?.location, { name: 'B 座 5 层会议室' });
});

test('飞书阶段三回归：手动重试创建日程期间取消面试，同样会补删，不留孤儿日程', async () => {
  const { run } = await import('../src/db/index.ts');
  const adminUserId = await getUserIdByCookie(adminCookie);
  run('UPDATE users SET feishu_open_id = ? WHERE id = ?', ['ou_manual_retry_race', adminUserId]);

  const calendarId = 'feishu.cn_stage3_manual_retry_race@group.calendar.feishu.cn';
  await app.inject({
    method: 'PUT',
    url: '/api/settings/feishu',
    headers: { cookie: adminCookie },
    payload: {
      app_id: 'cli_stage3_manual_retry_race',
      app_secret: 'sec_stage3_manual_retry_race',
      bot_webhook: '',
      bot_secret: '',
      calendar_id: calendarId,
    },
  });
  await app.inject({
    method: 'POST',
    url: '/api/notifications/feishu/skip-pending',
    headers: { cookie: adminCookie },
    payload: {},
  });

  const applicationId = await setupInterviewApplication('产品经理（手动重试竞态）', '郑竞态', 'zheng-manual-race@example.com');
  const createEventUrl = `/open-apis/calendar/v4/calendars/${encodeURIComponent(calendarId)}/events`;
  const calls: Array<{ method: string; url: string }> = [];
  let releaseCreate: () => void = () => {};
  const createGate = new Promise<void>((resolve) => {
    releaseCreate = () => resolve();
  });
  let markCreateStarted: () => void = () => {};
  const createStarted = new Promise<void>((resolve) => {
    markCreateStarted = () => resolve();
  });
  let failCreate = true;

  setFeishuFetchForTest(async (input, init) => {
    const url = String(input);
    const method = String(init?.method ?? 'GET');
    calls.push({ method, url });
    if (url.endsWith('/open-apis/auth/v3/tenant_access_token/internal')) {
      return jsonResponse({ code: 0, msg: 'ok', tenant_access_token: 't-stage3-manual-retry-race', expire: 7200 });
    }
    if (method === 'POST' && url.includes('/open-apis/im/v1/messages?receive_id_type=open_id')) {
      return jsonResponse({ code: 0, msg: 'ok', data: { message_id: 'om_manual_retry_race' } });
    }
    if (method === 'POST' && url.endsWith(createEventUrl)) {
      if (failCreate) return jsonResponse({ code: 190005, msg: 'no permission' }, 500);
      markCreateStarted();
      await createGate;
      return jsonResponse({
        code: 0,
        msg: 'ok',
        data: { event: { event_id: 'evt_manual_race', vchat: { vc_type: 'vc', meeting_url: 'https://vc.feishu.cn/j/manual-race' } } },
      });
    }
    if (method === 'POST' && url.includes('/events/evt_manual_race/attendees?user_id_type=open_id')) {
      return jsonResponse({ code: 0, msg: 'ok', data: { attendees: [] } });
    }
    if (method === 'DELETE' && url.includes('/events/evt_manual_race')) {
      return jsonResponse({ code: 0, msg: 'ok', data: {} });
    }
    throw new Error(`unexpected feishu call: ${method} ${url}`);
  });

  const created = await app.inject({
    method: 'POST',
    url: '/api/interviews',
    headers: { cookie: adminCookie },
    payload: {
      applicationId,
      scheduledAt: '2026-12-15T02:00:00.000Z',
      durationMinutes: 45,
      mode: 'video',
      interviewerId: adminUserId,
    },
  });
  assert.equal(created.statusCode, 201);
  const interviewId = created.json().interview.id as string;
  await waitForCalendarSyncs();
  await waitForFeishuDispatches();
  const failedRow = readCalendarRow(interviewId);
  assert.equal(failedRow?.calendar_sync_status, 'failed');
  assert.equal(failedRow?.external_calendar_event_id, null);

  // 手动重试创建在途时取消面试：取消时还没有事件 ID，不会排删除，只能靠重试链自己补删
  failCreate = false;
  calls.length = 0;
  const retryPromise = app.inject({
    method: 'POST',
    url: `/api/interviews/${interviewId}/sync-calendar`,
    headers: { cookie: adminCookie },
    payload: {},
  });
  // 等到创建请求真的开始再取消，稳定复现「创建在途时取消」的竞态
  await Promise.race([
    createStarted,
    new Promise<void>((_, reject) => setTimeout(() => reject(new Error('重试创建请求未开始')), 3000)),
  ]);
  const cancelled = await app.inject({
    method: 'POST',
    url: `/api/interviews/${interviewId}/cancel`,
    headers: { cookie: adminCookie },
    payload: {},
  });
  assert.equal(cancelled.statusCode, 200);
  releaseCreate();
  const retried = await retryPromise;
  assert.equal(retried.statusCode, 200);
  await waitForCalendarSyncs();
  await waitForFeishuDispatches();

  const finalRow = readCalendarRow(interviewId);
  assert.equal(finalRow?.status, 'cancelled');
  assert.ok(
    calls.some((c) => c.method === 'DELETE' && c.url.includes('/events/evt_manual_race')),
    '手动重试期间取消面试必须补删，避免已取消的面试在飞书留下日程',
  );
  assert.equal(finalRow?.external_calendar_event_id, null);
  assert.equal(finalRow?.calendar_sync_status, 'none');
});

test('飞书阶段三竞态：创建日程尚未返回就取消面试，同步完成后自动补删，不留孤儿日程', async () => {
  const { run } = await import('../src/db/index.ts');
  const adminUserId = await getUserIdByCookie(adminCookie);
  run('UPDATE users SET feishu_open_id = ? WHERE id = ?', ['ou_race_A', adminUserId]);

  const calendarId = 'feishu.cn_stage3_race@group.calendar.feishu.cn';
  await app.inject({
    method: 'PUT',
    url: '/api/settings/feishu',
    headers: { cookie: adminCookie },
    payload: {
      app_id: 'cli_stage3_race',
      app_secret: 'sec_stage3_race',
      bot_webhook: '',
      bot_secret: '',
      calendar_id: calendarId,
    },
  });
  await app.inject({
    method: 'POST',
    url: '/api/notifications/feishu/skip-pending',
    headers: { cookie: adminCookie },
    payload: {},
  });

  const applicationId = await setupInterviewApplication('数据分析师（阶段三竞态）', '孙竞态', 'sun-race@example.com');

  let releaseCreate: () => void = () => {};
  const createGate = new Promise<void>((resolve) => {
    releaseCreate = () => resolve();
  });
  const calls: Array<{ method: string; url: string }> = [];

  setFeishuFetchForTest(async (input, init) => {
    const url = String(input);
    const method = String(init?.method ?? 'GET');
    calls.push({ method, url });
    if (url.endsWith('/open-apis/auth/v3/tenant_access_token/internal')) {
      return jsonResponse({ code: 0, msg: 'ok', tenant_access_token: 't-stage3-race-token', expire: 7200 });
    }
    if (method === 'POST' && url.includes('/open-apis/im/v1/messages?receive_id_type=open_id')) {
      return jsonResponse({ code: 0, msg: 'ok', data: { message_id: 'om_race' } });
    }
    if (method === 'POST' && url.endsWith(`/open-apis/calendar/v4/calendars/${encodeURIComponent(calendarId)}/events`)) {
      // 卡住创建响应，模拟「创建请求在途时用户取消面试」
      await createGate;
      return jsonResponse({
        code: 0,
        msg: 'ok',
        data: { event: { event_id: 'evt_stage3_race', vchat: { vc_type: 'vc', meeting_url: 'https://vc.feishu.cn/j/race001' } } },
      });
    }
    if (method === 'POST' && url.includes('/events/evt_stage3_race/attendees?user_id_type=open_id')) {
      return jsonResponse({ code: 0, msg: 'ok', data: { attendees: [] } });
    }
    if (method === 'DELETE' && url.includes('/events/evt_stage3_race')) {
      return jsonResponse({ code: 0, msg: 'ok', data: {} });
    }
    throw new Error(`unexpected feishu call: ${method} ${url}`);
  });

  const created = await app.inject({
    method: 'POST',
    url: '/api/interviews',
    headers: { cookie: adminCookie },
    payload: {
      applicationId,
      scheduledAt: '2026-12-11T02:00:00.000Z',
      durationMinutes: 45,
      mode: 'video',
      interviewerId: adminUserId,
    },
  });
  assert.equal(created.statusCode, 201);
  const interviewId = created.json().interview.id as string;

  // 创建日程的飞书响应还没回来就取消面试
  const cancelled = await app.inject({
    method: 'POST',
    url: `/api/interviews/${interviewId}/cancel`,
    headers: { cookie: adminCookie },
    payload: {},
  });
  assert.equal(cancelled.statusCode, 200);

  releaseCreate();
  await waitForCalendarSyncs();
  await waitForFeishuDispatches();

  const row = getRow<{
    status: string;
    external_calendar_event_id: string | null;
    calendar_sync_status: string;
    meeting_url: string | null;
  }>('SELECT status, external_calendar_event_id, calendar_sync_status, meeting_url FROM interviews WHERE id = ?', [interviewId]);
  assert.equal(row?.status, 'cancelled');
  assert.ok(
    calls.some((c) => c.method === 'DELETE' && c.url.includes('/events/evt_stage3_race')),
    '创建日程后才完成的取消必须补一次删除，避免远端留下孤儿日程',
  );
  assert.equal(row?.external_calendar_event_id, null);
  assert.equal(row?.calendar_sync_status, 'none');
});

function readCalendarRow(interviewId: string) {
  return getRow<{
    status: string;
    external_calendar_event_id: string | null;
    calendar_sync_status: string;
    calendar_sync_error: string | null;
    calendar_recreate_required: number;
  }>(
    `SELECT status, external_calendar_event_id, calendar_sync_status, calendar_sync_error, calendar_recreate_required
       FROM interviews WHERE id = ?`,
    [interviewId],
  );
}
