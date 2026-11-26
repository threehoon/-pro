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
} = await import('../src/integrations/feishu.ts');
const { enqueueNotification, waitForFeishuDispatches } = await import('../src/services/notifications.ts');

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
