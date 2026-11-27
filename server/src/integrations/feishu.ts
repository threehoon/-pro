import { createHmac } from 'node:crypto';
import { getRow, run } from '../db/index.ts';
import { now, jsonParse } from '../lib/util.ts';
import { badRequest } from '../lib/errors.ts';
import { STAGE_LABELS, type Stage } from '../constants.ts';

const ALLOWED_FEISHU_HOSTS = new Set(['open.feishu.cn', 'open.larksuite.com']);
const WEBHOOK_PATH_PREFIX = '/open-apis/bot/v2/hook/';
const FEISHU_REQUEST_TIMEOUT_MS = 10_000;
const MASK_PLACEHOLDER = '••••••••';

export interface FeishuConfig {
  app_id?: string;
  app_secret?: string;
  verification_token?: string;
  encrypt_key?: string;
  bot_webhook?: string;
  bot_secret?: string;
  calendar_id?: string;
}

export interface FeishuStatus {
  provider: 'feishu';
  status: 'disabled' | 'configured';
  configured: boolean;
  /** 已登记配置项（不回传 secret / webhook 明文） */
  fields: {
    app_id: boolean;
    app_secret: boolean;
    verification_token: boolean;
    bot_webhook: boolean;
    bot_secret: boolean;
    calendar_id: boolean;
  };
  ready: {
    login: boolean;
    notifications: boolean;
    calendar: boolean;
  };
  pendingNotifications: number;
  failedNotifications: number;
  sentNotifications: number;
  updatedAt: string | null;
  /** 接入步骤，前端设置页直接展示 */
  checklist: Array<{ key: string; label: string; description: string; done: boolean }>;
}

export type FeishuFetch = (url: string, init: RequestInit) => Promise<Response>;

let customFetchForTest: FeishuFetch | null = null;

interface TenantTokenCacheEntry {
  token: string;
  expiresAt: number;
  cacheKey: string;
  endpoint: string;
}

let tenantTokenCache: TenantTokenCacheEntry | null = null;

let appTokenCache: TenantTokenCacheEntry | null = null;

export function setFeishuFetchForTest(fn: FeishuFetch | null): void {
  customFetchForTest = fn;
}

export function clearTenantTokenCache(): void {
  tenantTokenCache = null;
  appTokenCache = null;
}

function getFetchImpl(): FeishuFetch {
  return customFetchForTest ?? ((url, init) => fetch(url, init));
}

function readRaw(): { status: 'disabled' | 'configured'; config: FeishuConfig; updatedAt: string | null } {
  const row = getRow<{ status: 'disabled' | 'configured'; config_json: string; updated_at: string }>(
    'SELECT status, config_json, updated_at FROM integrations WHERE provider = ?',
    ['feishu'],
  );
  return {
    status: row?.status ?? 'disabled',
    config: row ? jsonParse<FeishuConfig>(row.config_json, {}) : {},
    updatedAt: row?.updated_at ?? null,
  };
}

/**
 * 严格校验群机器人 Webhook：仅允许飞书/Lark 官方 HTTPS 域名与标准 hook 路径，
 * 避免 SSRF 或误填内网地址；错误信息中不回显原始 URL。
 */
export function validateFeishuWebhookUrl(rawUrl: string): URL {
  const trimmed = rawUrl.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw badRequest('机器人 Webhook 格式不正确，请粘贴飞书官方 HTTPS Webhook 地址');
  }
  if (parsed.protocol !== 'https:') {
    throw badRequest('机器人 Webhook 必须使用 HTTPS 协议');
  }
  if (!ALLOWED_FEISHU_HOSTS.has(parsed.hostname)) {
    throw badRequest('机器人 Webhook 仅允许飞书官方域名（open.feishu.cn 或 open.larksuite.com）');
  }
  if (parsed.port !== '' || parsed.username || parsed.password) {
    throw badRequest('机器人 Webhook 不允许包含自定义端口或认证信息');
  }
  if (!parsed.pathname.startsWith(WEBHOOK_PATH_PREFIX) || parsed.pathname.length <= WEBHOOK_PATH_PREFIX.length) {
    throw badRequest('机器人 Webhook 路径必须以 /open-apis/bot/v2/hook/ 开头');
  }
  if (parsed.search !== '' || parsed.hash !== '') {
    throw badRequest('机器人 Webhook 不允许包含查询参数或锚点');
  }
  return parsed;
}

/**
 * 飞书自定义机器人签名算法：
 * 以 `${timestamp}\n${secret}` 作为 HMAC-SHA256 密钥对空字节串签名，再做 Base64 编码。
 */
export function signFeishuWebhook(timestamp: string, secret: string): string {
  return createHmac('sha256', `${timestamp}\n${secret}`).update('').digest('base64');
}

function resolveOpenApiOrigin(config: FeishuConfig): { origin: string; host: string } {
  if (config.bot_webhook) {
    try {
      const url = new URL(config.bot_webhook);
      if (url.hostname === 'open.larksuite.com') {
        return { origin: 'https://open.larksuite.com', host: 'open.larksuite.com' };
      }
    } catch {
      // 忽略解析失败，回退默认飞书国内域名
    }
  }
  return { origin: 'https://open.feishu.cn', host: 'open.feishu.cn' };
}

function buildTokenCacheKey(origin: string, appId: string, appSecret: string): string {
  const digest = createHmac('sha256', 'hireloop-feishu-token-cache').update(appSecret).digest('hex');
  return `${origin}|${appId}|${digest}`;
}

function sanitizeDiagnostic(text: string, extraSecrets: Array<string | null | undefined> = []): string {
  let output = text;
  const secrets = new Set<string>();
  for (const item of extraSecrets) {
    if (typeof item === 'string' && item.trim().length >= 4) secrets.add(item.trim());
  }
  try {
    const { config } = readRaw();
    for (const raw of [
      config.app_secret,
      config.bot_secret,
      config.verification_token,
      config.encrypt_key,
      config.bot_webhook,
    ]) {
      if (typeof raw === 'string' && raw.trim().length >= 4) secrets.add(raw.trim());
    }
  } catch {
    // 数据库尚未打开或已关闭时跳过读取已保存配置
  }
  for (const secret of secrets) {
    output = output.split(secret).join('[redacted]');
  }
  return output
    .replace(/https?:\/\/\S+/gi, '[url]')
    .replace(/\b(?:cli|a|t|u)-[A-Za-z0-9_-]{8,}\b/g, '[redacted]')
    .slice(0, 240);
}

function parseStrictOrigin(raw: string): string | null {
  try {
    const parsed = new URL(raw);
    if (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      parsed.username === '' &&
      parsed.password === '' &&
      parsed.pathname === '/' &&
      parsed.search === '' &&
      parsed.hash === ''
    ) {
      return parsed.origin;
    }
  } catch {
    // 忽略非法 URL
  }
  return null;
}

/**
 * 推导对外访问的 Origin（供飞书 OAuth redirect_uri 与设置页回调地址共用）。
 * 仅在显式设置 HIRELOOP_TRUST_PROXY=1 时信任 X-Forwarded-Proto / X-Forwarded-Host，
 * 避免未配置反向代理时被客户端伪造请求头劫持回调地址。
 */
export function resolveFeishuPublicOrigin(request: {
  protocol: string;
  headers: Record<string, string | string[] | undefined>;
}): string {
  const configured = process.env.HIRELOOP_PUBLIC_ORIGIN?.trim();
  if (configured) {
    const strictConfigured = parseStrictOrigin(configured);
    if (strictConfigured) return strictConfigured;
  }

  const trustProxy = process.env.HIRELOOP_TRUST_PROXY === '1';
  let proto: 'http' | 'https' = request.protocol === 'https' ? 'https' : 'http';
  let rawHost = Array.isArray(request.headers.host) ? request.headers.host[0] : request.headers.host;

  if (trustProxy) {
    const forwardedProtoRaw = request.headers['x-forwarded-proto'];
    const forwardedProto = (Array.isArray(forwardedProtoRaw) ? forwardedProtoRaw[0] : forwardedProtoRaw)
      ?.split(',')[0]
      ?.trim()
      .toLowerCase();
    if (forwardedProto === 'https' || forwardedProto === 'http') {
      proto = forwardedProto;
    }
    const forwardedHostRaw = request.headers['x-forwarded-host'];
    const forwardedHost = (Array.isArray(forwardedHostRaw) ? forwardedHostRaw[0] : forwardedHostRaw)
      ?.split(',')[0]
      ?.trim();
    if (forwardedHost) {
      rawHost = forwardedHost;
    }
  }

  const host = (rawHost?.split(',')[0] ?? '').trim();
  if (host && !/[\s/@\\?#]/.test(host)) {
    const strictDerived = parseStrictOrigin(`${proto}://${host}`);
    if (strictDerived) return strictDerived;
  }
  return 'http://localhost:8787';
}

function isHttpUrl(value: string | null | undefined): value is string {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

function formatShanghaiTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

async function requestFeishuJson(
  url: string,
  options: {
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
    payload?: Record<string, unknown>;
    headers?: Record<string, string>;
    extraSecrets?: Array<string | null | undefined>;
  },
): Promise<{ status: number; ok: boolean; data: Record<string, unknown> | null; latencyMs: number }> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FEISHU_REQUEST_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = { ...(options.headers ?? {}) };
    const init: RequestInit = {
      method: options.method,
      headers,
      redirect: 'error',
      signal: controller.signal,
    };
    if (options.payload !== undefined) {
      headers['content-type'] = 'application/json; charset=utf-8';
      init.body = JSON.stringify(options.payload);
    }
    const response = await getFetchImpl()(url, init);
    const text = await response.text();
    let parsed: Record<string, unknown> | null = null;
    if (text) {
      try {
        const raw = JSON.parse(text) as unknown;
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
          parsed = raw as Record<string, unknown>;
        }
      } catch {
        parsed = null;
      }
    }
    return {
      status: response.status,
      ok: response.ok,
      data: parsed,
      latencyMs: Math.max(1, Date.now() - startedAt),
    };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('飞书接口请求超时（超过 10 秒）');
    }
    throw new Error(
      `飞书网络请求失败：${sanitizeDiagnostic(error instanceof Error ? error.message : String(error), options.extraSecrets)}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJsonWithTimeout(
  url: string,
  payload: Record<string, unknown>,
  extraSecrets?: Array<string | null | undefined>,
): Promise<{ status: number; ok: boolean; data: Record<string, unknown> | null; latencyMs: number }> {
  return requestFeishuJson(url, { method: 'POST', payload, extraSecrets });
}

export function isFeishuWebhookConfigured(): boolean {
  const { config } = readRaw();
  if (!config.bot_webhook) return false;
  try {
    validateFeishuWebhookUrl(config.bot_webhook);
    return true;
  } catch {
    return false;
  }
}

export function isFeishuAppConfigured(): boolean {
  const { config } = readRaw();
  return Boolean(config.app_id && config.app_secret);
}

/** 长连接（WSClient）要自己拿应用凭证建连，这里只给内部调用方用，不对外暴露。 */
export function feishuAppCredentials(): { appId: string; appSecret: string } | null {
  const { config } = readRaw();
  if (!config.app_id || !config.app_secret) return null;
  return { appId: config.app_id, appSecret: config.app_secret };
}

export function isFeishuCalendarConfigured(): boolean {
  const { config } = readRaw();
  return Boolean(config.app_id && config.app_secret && config.calendar_id?.trim());
}

export function feishuStatus(): FeishuStatus {
  const raw = readRaw();
  const config = raw.config;
  const fields = {
    app_id: Boolean(config.app_id),
    app_secret: Boolean(config.app_secret),
    verification_token: Boolean(config.verification_token),
    bot_webhook: Boolean(config.bot_webhook),
    bot_secret: Boolean(config.bot_secret),
    calendar_id: Boolean(config.calendar_id),
  };
  const pending = getRow<{ n: number }>(
    "SELECT COUNT(*) AS n FROM notifications WHERE channel = 'feishu' AND status = 'pending'",
  );
  const failed = getRow<{ n: number }>(
    "SELECT COUNT(*) AS n FROM notifications WHERE channel = 'feishu' AND status = 'failed'",
  );
  const sent = getRow<{ n: number }>(
    "SELECT COUNT(*) AS n FROM notifications WHERE channel = 'feishu' AND status = 'sent'",
  );

  const loginReady = fields.app_id && fields.app_secret;
  const notificationsReady = isFeishuWebhookConfigured();
  const calendarReady = loginReady && fields.calendar_id;

  return {
    provider: 'feishu',
    status: raw.status,
    configured: raw.status === 'configured',
    fields,
    ready: { login: loginReady, notifications: notificationsReady, calendar: calendarReady },
    pendingNotifications: pending?.n ?? 0,
    failedNotifications: failed?.n ?? 0,
    sentNotifications: sent?.n ?? 0,
    updatedAt: raw.updatedAt,
    checklist: [
      {
        key: 'notify',
        label: '群机器人卡片推送（阶段一）',
        description: '配置机器人 Webhook（可选签名密钥）后，阶段流转与面试安排会自动异步推送卡片。',
        done: notificationsReady,
      },
      {
        key: 'app_auth',
        label: '自建应用凭证连通（阶段一）',
        description: '填写 App ID 与 App Secret 后，可获取应用令牌并为登录与日历打底。',
        done: loginReady,
      },
      {
        key: 'login',
        label: '飞书扫码登录与身份映射（阶段二）',
        description: '在飞书后台登记下方回调地址后，支持登录页飞书扫码登录与成员账号绑定/解绑。',
        done: loginReady,
      },
      {
        key: 'calendar',
        label: '面试日历同步与面试官私信（阶段三）',
        description: '配置或一键创建共享日历后，安排/改期/取消面试自动同步飞书日程与会议链接，并私信提醒已绑定飞书的面试官。',
        done: Boolean(calendarReady),
      },
      {
        key: 'webhook',
        label: '事件回调（后续）',
        description: '接收飞书侧日程变更与审批结果，用于回写面试和录用状态。',
        done: Boolean(config.verification_token),
      },
    ],
  };
}

export function saveFeishuConfig(input: Partial<FeishuConfig>, actorId: string): FeishuStatus {
  const raw = readRaw();
  const next: FeishuConfig = { ...raw.config };
  const secretKeys = new Set(['app_secret', 'bot_secret', 'verification_token', 'encrypt_key']);

  for (const [key, value] of Object.entries(input)) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed === MASK_PLACEHOLDER && secretKeys.has(key)) continue;
    if (trimmed === '') {
      delete (next as Record<string, unknown>)[key];
      continue;
    }
    if (key === 'bot_webhook') {
      const validated = validateFeishuWebhookUrl(trimmed);
      next.bot_webhook = validated.toString();
      continue;
    }
    (next as Record<string, unknown>)[key] = trimmed;
  }

  const configured = Boolean((next.app_id && next.app_secret) || next.bot_webhook);
  run(
    `UPDATE integrations SET status = ?, config_json = ?, updated_by = ?, updated_at = ? WHERE provider = 'feishu'`,
    [configured ? 'configured' : 'disabled', JSON.stringify(next), actorId, now()],
  );
  clearTenantTokenCache();
  return feishuStatus();
}

async function fetchCachedInternalToken(input: {
  path: '/open-apis/auth/v3/tenant_access_token/internal' | '/open-apis/auth/v3/app_access_token/internal';
  tokenField: 'tenant_access_token' | 'app_access_token';
  connectError: string;
  verifyErrorPrefix: string;
  getCache: () => TenantTokenCacheEntry | null;
  setCache: (entry: TenantTokenCacheEntry) => void;
  forceRefresh?: boolean;
}): Promise<{
  token: string;
  expiresIn: number;
  cached: boolean;
  latencyMs: number;
  endpoint: string;
  origin: string;
}> {
  const { config } = readRaw();
  if (!config.app_id || !config.app_secret) {
    throw badRequest('请先填写并保存飞书自建应用的 App ID 和 App Secret');
  }

  const { origin, host } = resolveOpenApiOrigin(config);
  const cacheKey = buildTokenCacheKey(origin, config.app_id, config.app_secret);
  const existing = input.getCache();

  if (!input.forceRefresh && existing && existing.cacheKey === cacheKey && existing.expiresAt > Date.now()) {
    return {
      token: existing.token,
      expiresIn: Math.max(1, Math.round((existing.expiresAt - Date.now()) / 1000)),
      cached: true,
      latencyMs: 0,
      endpoint: existing.endpoint,
      origin,
    };
  }

  let response: { status: number; ok: boolean; data: Record<string, unknown> | null; latencyMs: number };
  try {
    response = await fetchJsonWithTimeout(`${origin}${input.path}`, {
      app_id: config.app_id,
      app_secret: config.app_secret,
    });
  } catch (error) {
    throw badRequest(error instanceof Error ? error.message : input.connectError);
  }

  const code = typeof response.data?.code === 'number' ? response.data.code : null;
  const msg = typeof response.data?.msg === 'string' ? sanitizeDiagnostic(response.data.msg) : '';
  const rawToken = response.data?.[input.tokenField];
  const token = typeof rawToken === 'string' ? rawToken : '';
  const expireSec =
    typeof response.data?.expire === 'number' && Number.isFinite(response.data.expire) && response.data.expire > 0
      ? Math.round(response.data.expire)
      : 7200;

  if (!response.ok || code !== 0 || !token) {
    const detail = code !== null ? `code ${code}${msg ? `：${msg}` : ''}` : `HTTP ${response.status}`;
    throw badRequest(`${input.verifyErrorPrefix}（${detail}）`);
  }

  const ttlMs = Math.max(60, expireSec - 300) * 1000;
  input.setCache({
    token,
    expiresAt: Date.now() + ttlMs,
    cacheKey,
    endpoint: host,
  });

  return {
    token,
    expiresIn: expireSec,
    cached: false,
    latencyMs: response.latencyMs,
    endpoint: host,
    origin,
  };
}

/**
 * 获取自建应用 tenant_access_token，带内存缓存（提前 5 分钟刷新，配置修改时失效）。
 * 仅限服务端内部使用，严禁将 token 返回给前端或写入日志。
 */
export async function getTenantAccessToken(options?: { forceRefresh?: boolean }): Promise<{
  token: string;
  expiresIn: number;
  cached: boolean;
  latencyMs: number;
  endpoint: string;
}> {
  const result = await fetchCachedInternalToken({
    path: '/open-apis/auth/v3/tenant_access_token/internal',
    tokenField: 'tenant_access_token',
    connectError: '飞书自建应用连接失败',
    verifyErrorPrefix: '飞书自建应用凭证校验失败',
    getCache: () => tenantTokenCache,
    setCache: (entry) => {
      tenantTokenCache = entry;
    },
    forceRefresh: options?.forceRefresh,
  });
  return {
    token: result.token,
    expiresIn: result.expiresIn,
    cached: result.cached,
    latencyMs: result.latencyMs,
    endpoint: result.endpoint,
  };
}

/** 管理员主动测试自建应用凭证连通性（不返回 token 明文） */
export async function testFeishuAppConnection(): Promise<{
  ok: true;
  latencyMs: number;
  expiresIn: number;
  endpoint: string;
}> {
  const result = await getTenantAccessToken({ forceRefresh: true });
  return {
    ok: true,
    latencyMs: result.latencyMs,
    expiresIn: result.expiresIn,
    endpoint: result.endpoint,
  };
}

/**
 * 飞书消息卡片（面试安排 / 面试改期 / 面试取消）。
 */
export function buildInterviewCard(input: {
  candidateName: string;
  jobTitle: string;
  round: number;
  scheduledAt: string;
  durationMinutes: number;
  modeLabel: string;
  interviewerName: string | null;
  meetingUrl: string | null;
  location?: string | null;
  workbenchUrl?: string | null;
  rescheduled?: boolean;
  cancelled?: boolean;
  note?: string | null;
  directMessage?: boolean;
}) {
  const dateText = formatShanghaiTime(input.scheduledAt);
  const actions: Array<Record<string, unknown>> = [];
  if (!input.cancelled && isHttpUrl(input.meetingUrl)) {
    actions.push({
      tag: 'button',
      type: 'primary',
      text: { tag: 'plain_text', content: '进入会议' },
      url: input.meetingUrl,
    });
  }
  if (isHttpUrl(input.workbenchUrl)) {
    actions.push({
      tag: 'button',
      type: 'default',
      text: { tag: 'plain_text', content: '打开招聘工作台' },
      url: input.workbenchUrl,
    });
  }

  const fields: Array<Record<string, unknown>> = [
    { is_short: true, text: { tag: 'lark_md', content: `**职位**\n${input.jobTitle}` } },
    { is_short: true, text: { tag: 'lark_md', content: `**轮次**\n第 ${input.round} 轮` } },
    { is_short: true, text: { tag: 'lark_md', content: `**时间**\n${dateText}（${input.durationMinutes} 分钟）` } },
    { is_short: true, text: { tag: 'lark_md', content: `**形式**\n${input.modeLabel}` } },
    { is_short: true, text: { tag: 'lark_md', content: `**面试官**\n${input.interviewerName ?? '待指派'}` } },
  ];
  if (input.location) {
    fields.push({ is_short: true, text: { tag: 'lark_md', content: `**地点**\n${input.location}` } });
  }

  const template = input.cancelled ? 'red' : input.rescheduled ? 'orange' : 'blue';
  const actionLabel = input.cancelled ? '面试取消' : input.rescheduled ? '面试改期' : '面试安排';
  const titlePrefix = input.directMessage ? `${actionLabel}提醒` : actionLabel;
  const extraElements: Array<Record<string, unknown>> = [];
  if (input.note?.trim()) {
    extraElements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: `**说明**：${input.note.trim()}` },
    });
  }

  return {
    config: { wide_screen_mode: true },
    header: {
      template,
      title: {
        tag: 'plain_text',
        content: `${titlePrefix} · ${input.candidateName}`,
      },
    },
    elements: [
      { tag: 'div', fields },
      ...extraElements,
      ...(actions.length > 0 ? [{ tag: 'action', actions }] : []),
      {
        tag: 'note',
        elements: [
          {
            tag: 'plain_text',
            content: input.directMessage
              ? '由 Hireloop 招聘工作台私信提醒（仅发送给本场面试官）'
              : '由 Hireloop 招聘工作台发送',
          },
        ],
      },
    ],
  };
}

/** 飞书消息卡片（候选人阶段变化 / 归档） */
export function buildStageChangeCard(input: {
  candidateName: string;
  jobTitle: string;
  fromStage: Stage | null;
  toStage: Stage | null;
  rejected?: boolean;
  createdAt: string;
}) {
  const fromLabel = input.fromStage ? STAGE_LABELS[input.fromStage] ?? input.fromStage : '新建投递';
  const toLabel = input.rejected
    ? '已归档'
    : input.toStage
      ? STAGE_LABELS[input.toStage] ?? input.toStage
      : '阶段更新';
  const template = input.rejected ? 'red' : input.toStage === 'hired' ? 'green' : 'blue';
  const heading = input.rejected
    ? `候选人已归档 · ${input.candidateName}`
    : `阶段推进 · ${input.candidateName} → ${toLabel}`;

  return {
    config: { wide_screen_mode: true },
    header: {
      template,
      title: { tag: 'plain_text', content: heading },
    },
    elements: [
      {
        tag: 'div',
        fields: [
          { is_short: true, text: { tag: 'lark_md', content: `**候选人**\n${input.candidateName}` } },
          { is_short: true, text: { tag: 'lark_md', content: `**职位**\n${input.jobTitle}` } },
          { is_short: true, text: { tag: 'lark_md', content: `**状态变更**\n${fromLabel} → ${toLabel}` } },
          { is_short: true, text: { tag: 'lark_md', content: `**时间**\n${formatShanghaiTime(input.createdAt)}` } },
        ],
      },
      { tag: 'note', elements: [{ tag: 'plain_text', content: '由 Hireloop 招聘工作台发送' }] },
    ],
  };
}

/** 通用通知兜底卡片 */
export function buildGenericNotificationCard(input: {
  title: string;
  body: string | null;
  createdAt: string;
}) {
  return {
    config: { wide_screen_mode: true },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: input.title },
    },
    elements: [
      ...(input.body
        ? [{ tag: 'div', text: { tag: 'lark_md', content: input.body } }]
        : []),
      {
        tag: 'note',
        elements: [{ tag: 'plain_text', content: `Hireloop 招聘工作台 · ${formatShanghaiTime(input.createdAt)}` }],
      },
    ],
  };
}

/** 阶段一连通测试卡片 */
export function buildTestWebhookCard(input: { actorName: string; sentAt: string }) {
  return {
    config: { wide_screen_mode: true },
    header: {
      template: 'green',
      title: { tag: 'plain_text', content: 'Hireloop 飞书通知连通测试' },
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: '如果你在群里看到这条卡片，说明 **Hireloop 招聘工作台** 与飞书群机器人 Webhook 已打通，后续阶段推进与面试安排将自动推送到这里。',
        },
      },
      {
        tag: 'div',
        fields: [
          { is_short: true, text: { tag: 'lark_md', content: `**触发人**\n${input.actorName}` } },
          { is_short: true, text: { tag: 'lark_md', content: `**发送时间**\n${formatShanghaiTime(input.sentAt)}` } },
        ],
      },
      { tag: 'note', elements: [{ tag: 'plain_text', content: '由 Hireloop 招聘工作台阶段一连通测试发出' }] },
    ],
  };
}

export interface FeishuWebhookDeliveryResult {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  latencyMs?: number;
  signed?: boolean;
}

/**
 * 通过飞书群机器人 Webhook 发送交互卡片。
 * 未配置时返回 skipped，不伪造发送成功；支持可选 bot_secret 签名校验。
 */
export async function sendFeishuWebhookCard(card: unknown): Promise<FeishuWebhookDeliveryResult> {
  const { config } = readRaw();
  if (!config.bot_webhook) {
    return { ok: false, skipped: true, reason: '未配置机器人 Webhook' };
  }

  let webhookUrl: URL;
  try {
    webhookUrl = validateFeishuWebhookUrl(config.bot_webhook);
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : '机器人 Webhook 地址不合法',
    };
  }

  const payload: Record<string, unknown> = {
    msg_type: 'interactive',
    card,
  };
  const signed = Boolean(config.bot_secret);
  if (config.bot_secret) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    payload.timestamp = timestamp;
    payload.sign = signFeishuWebhook(timestamp, config.bot_secret);
  }

  let response: { status: number; ok: boolean; data: Record<string, unknown> | null; latencyMs: number };
  try {
    response = await fetchJsonWithTimeout(webhookUrl.toString(), payload);
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : '飞书 Webhook 发送失败',
      signed,
    };
  }

  const code =
    typeof response.data?.code === 'number'
      ? response.data.code
      : typeof response.data?.StatusCode === 'number'
        ? response.data.StatusCode
        : null;
  const msg =
    typeof response.data?.msg === 'string'
      ? sanitizeDiagnostic(response.data.msg)
      : typeof response.data?.StatusMessage === 'string'
        ? sanitizeDiagnostic(response.data.StatusMessage)
        : '';

  if (response.ok && code === 0) {
    return { ok: true, latencyMs: response.latencyMs, signed };
  }

  const detail = code !== null ? `code ${code}${msg ? `：${msg}` : ''}` : `HTTP ${response.status}`;
  return {
    ok: false,
    latencyMs: response.latencyMs,
    signed,
    reason: `飞书群机器人拒绝消息（${detail}）`,
  };
}

/** 管理员主动发送一条测试卡片到飞书群 */
export async function testFeishuWebhook(actorName: string): Promise<{
  ok: true;
  latencyMs: number;
  signed: boolean;
}> {
  if (!isFeishuWebhookConfigured()) {
    throw badRequest('请先填写并保存有效的飞书机器人 Webhook');
  }
  const card = buildTestWebhookCard({ actorName, sentAt: now() });
  const result = await sendFeishuWebhookCard(card);
  if (!result.ok) {
    throw badRequest(result.reason ?? '测试消息发送失败');
  }
  return {
    ok: true,
    latencyMs: result.latencyMs ?? 0,
    signed: Boolean(result.signed),
  };
}

/**
 * 兼容既有导出：传入 open_id 时发送应用私信卡片，否则走群机器人 Webhook。
 */
export async function sendFeishuMessage(card: unknown, receiveId: string | null): Promise<FeishuWebhookDeliveryResult> {
  if (receiveId?.trim()) {
    return sendFeishuDirectMessageCard(receiveId.trim(), card);
  }
  return sendFeishuWebhookCard(card);
}

export function loginCapability(): { enabled: boolean; appId: string | null } {
  const { config } = readRaw();
  return { enabled: Boolean(config.app_id && config.app_secret), appId: config.app_id ?? null };
}

export interface FeishuOAuthUserInfo {
  openId: string;
  unionId: string | null;
  name: string | null;
  email: string | null;
  enterpriseEmail: string | null;
  avatarUrl: string | null;
}

function readOptionalString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** 构造飞书网页 OIDC 授权地址（登录与账号绑定共用） */
export function buildFeishuAuthorizeUrl(input: { redirectUri: string; state: string }): string {
  const { config } = readRaw();
  if (!config.app_id || !config.app_secret) {
    throw badRequest('尚未配置飞书自建应用凭证，暂不可使用飞书登录');
  }
  const { origin } = resolveOpenApiOrigin(config);
  const url = new URL('/open-apis/authen/v1/authorize', origin);
  url.searchParams.set('app_id', config.app_id);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('state', input.state);
  return url.toString();
}

/**
 * 获取自建应用 app_access_token（用于 OIDC code 换取 user_access_token），带内存缓存。
 */
export async function getAppAccessToken(options?: { forceRefresh?: boolean }): Promise<{
  token: string;
  expiresIn: number;
  cached: boolean;
  latencyMs: number;
  endpoint: string;
  origin: string;
}> {
  return fetchCachedInternalToken({
    path: '/open-apis/auth/v3/app_access_token/internal',
    tokenField: 'app_access_token',
    connectError: '飞书应用令牌获取失败',
    verifyErrorPrefix: '飞书应用令牌获取失败',
    getCache: () => appTokenCache,
    setCache: (entry) => {
      appTokenCache = entry;
    },
    forceRefresh: options?.forceRefresh,
  });
}

/**
 * 使用回调带来的一次性 code 向飞书换取 user_access_token 并拉取用户基础身份信息。
 */
export async function exchangeFeishuOAuthCode(code: string): Promise<FeishuOAuthUserInfo> {
  const trimmedCode = code.trim();
  if (!trimmedCode) {
    throw badRequest('缺少飞书授权码');
  }

  const appToken = await getAppAccessToken();
  const origin = appToken.origin;

  let tokenResponse: { status: number; ok: boolean; data: Record<string, unknown> | null; latencyMs: number };
  try {
    tokenResponse = await requestFeishuJson(`${origin}/open-apis/authen/v1/oidc/access_token`, {
      method: 'POST',
      headers: { authorization: `Bearer ${appToken.token}` },
      payload: { grant_type: 'authorization_code', code: trimmedCode },
      extraSecrets: [appToken.token, trimmedCode],
    });
  } catch (error) {
    throw badRequest(error instanceof Error ? error.message : '飞书授权码换取失败');
  }

  const tokenCode = typeof tokenResponse.data?.code === 'number' ? tokenResponse.data.code : null;
  const tokenMsg =
    typeof tokenResponse.data?.msg === 'string'
      ? sanitizeDiagnostic(tokenResponse.data.msg, [appToken.token, trimmedCode])
      : '';
  const tokenData =
    tokenResponse.data?.data && typeof tokenResponse.data.data === 'object' && !Array.isArray(tokenResponse.data.data)
      ? (tokenResponse.data.data as Record<string, unknown>)
      : null;
  const userAccessToken = readOptionalString(tokenData?.access_token);

  if (!tokenResponse.ok || tokenCode !== 0 || !userAccessToken) {
    const detail = tokenCode !== null ? `code ${tokenCode}${tokenMsg ? `：${tokenMsg}` : ''}` : `HTTP ${tokenResponse.status}`;
    throw badRequest(`飞书授权码换取令牌失败（${detail}）`);
  }

  let userResponse: { status: number; ok: boolean; data: Record<string, unknown> | null; latencyMs: number };
  try {
    userResponse = await requestFeishuJson(`${origin}/open-apis/authen/v1/user_info`, {
      method: 'GET',
      headers: { authorization: `Bearer ${userAccessToken}` },
      extraSecrets: [userAccessToken],
    });
  } catch (error) {
    throw badRequest(error instanceof Error ? error.message : '拉取飞书用户信息失败');
  }

  const userCode = typeof userResponse.data?.code === 'number' ? userResponse.data.code : null;
  const userMsg =
    typeof userResponse.data?.msg === 'string' ? sanitizeDiagnostic(userResponse.data.msg, [userAccessToken]) : '';
  const userData =
    userResponse.data?.data && typeof userResponse.data.data === 'object' && !Array.isArray(userResponse.data.data)
      ? (userResponse.data.data as Record<string, unknown>)
      : null;
  const openId = readOptionalString(userData?.open_id);

  if (!userResponse.ok || userCode !== 0 || !openId) {
    const detail = userCode !== null ? `code ${userCode}${userMsg ? `：${userMsg}` : ''}` : `HTTP ${userResponse.status}`;
    throw badRequest(`拉取飞书用户信息失败（${detail}）`);
  }

  return {
    openId,
    unionId: readOptionalString(userData?.union_id),
    name: readOptionalString(userData?.name) ?? readOptionalString(userData?.en_name),
    email: readOptionalString(userData?.email),
    enterpriseEmail: readOptionalString(userData?.enterprise_email),
    avatarUrl: readOptionalString(userData?.avatar_url),
  };
}

export interface TenantApiCallResult {
  ok: boolean;
  status: number;
  code: number | null;
  msg: string;
  data: Record<string, unknown> | null;
  latencyMs: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export async function callFeishuTenantApi(
  path: string,
  options: {
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
    payload?: Record<string, unknown>;
    extraSecrets?: Array<string | null | undefined>;
  },
): Promise<TenantApiCallResult> {
  const { config } = readRaw();
  const { origin } = resolveOpenApiOrigin(config);
  const tokenResult = await getTenantAccessToken();
  const extraSecrets = [tokenResult.token, ...(options.extraSecrets ?? [])];
  const response = await requestFeishuJson(`${origin}${path}`, {
    method: options.method,
    headers: { authorization: `Bearer ${tokenResult.token}` },
    payload: options.payload,
    extraSecrets,
  });
  const code = typeof response.data?.code === 'number' ? response.data.code : null;
  const msg = typeof response.data?.msg === 'string' ? sanitizeDiagnostic(response.data.msg, extraSecrets) : '';
  const data = asRecord(response.data?.data);
  return {
    ok: response.ok && code === 0,
    status: response.status,
    code,
    msg,
    data,
    latencyMs: response.latencyMs,
  };
}

function formatFeishuErrorDetail(res: Pick<TenantApiCallResult, 'status' | 'code' | 'msg'>): string {
  return res.code !== null ? `code ${res.code}${res.msg ? `：${res.msg}` : ''}` : `HTTP ${res.status}`;
}

/**
 * 「这条日程不存在」：只认 193001（event not found）。
 * 飞书 404 集合里还有 190007（app bot_id not found）、191000（日历不存在）、195100（用户已退出/不在租户），
 * 它们都不代表事件已经不存在：当作成功会清掉事件引用，当作不存在会重复建日程。
 * 190002 是「请求参数非法」(400)，同样不能触发重建。
 */
function isCalendarEventNotFound(res: Pick<TenantApiCallResult, 'code'>): boolean {
  return res.code === 193001;
}

/** 远端日程已被别人删除（403 193003）：删除按幂等成功处理，更新则改走新建。 */
function isCalendarEventDeleted(res: Pick<TenantApiCallResult, 'code'>): boolean {
  return res.code === 193003;
}

/**
 * 日历级错误（日历不存在/ID 非法/无权限/日历已删除/类型不合法）：重试没用，需要人去设置页修日历配置。
 */
function isCalendarConfigError(res: Pick<TenantApiCallResult, 'code'>): boolean {
  return (
    res.code === 191000 || res.code === 191001 || res.code === 191002 || res.code === 191003 || res.code === 191004
  );
}

/**
 * 通过飞书自建应用向指定成员（open_id）发送交互卡片私信。
 * 用于面试官私信提醒，不刷大群；未配置应用凭证或无 open_id 时安全返回 skipped。
 */
export async function sendFeishuDirectMessageCard(
  openId: string,
  card: unknown,
): Promise<FeishuWebhookDeliveryResult> {
  const trimmedOpenId = openId.trim();
  if (!trimmedOpenId) {
    return { ok: false, skipped: true, reason: '面试官尚未绑定飞书账号' };
  }
  if (!isFeishuAppConfigured()) {
    return { ok: false, skipped: true, reason: '未配置飞书自建应用凭证' };
  }

  let res: TenantApiCallResult;
  try {
    res = await callFeishuTenantApi('/open-apis/im/v1/messages?receive_id_type=open_id', {
      method: 'POST',
      payload: {
        receive_id: trimmedOpenId,
        msg_type: 'interactive',
        content: JSON.stringify(card),
      },
    });
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : '飞书应用私信发送失败',
    };
  }

  if (res.ok) {
    return { ok: true, latencyMs: res.latencyMs };
  }
  return {
    ok: false,
    latencyMs: res.latencyMs,
    reason: `飞书应用私信发送失败（${formatFeishuErrorDetail(res)}）`,
  };
}

/** 管理员在设置页一键创建 Hireloop 专用共享日历，并自动回填 calendar_id。 */
export async function createFeishuSharedCalendar(
  actorId: string,
  input: { summary?: string; description?: string } = {},
): Promise<{
  ok: true;
  calendarId: string;
  summary: string;
  latencyMs: number;
  status: FeishuStatus;
}> {
  if (!isFeishuAppConfigured()) {
    throw badRequest('请先填写并保存飞书自建应用的 App ID 和 App Secret');
  }
  const summary = input.summary?.trim() || 'Hireloop 招聘面试';
  const description = input.description?.trim() || '由 Hireloop 招聘工作台自动同步的面试日程';

  let res: TenantApiCallResult;
  try {
    res = await callFeishuTenantApi('/open-apis/calendar/v4/calendars', {
      method: 'POST',
      payload: {
        summary,
        description,
        permissions: 'private',
        summary_alias: summary,
      },
    });
  } catch (error) {
    throw badRequest(error instanceof Error ? error.message : '创建飞书共享日历失败');
  }

  const calendarObj = asRecord(res.data?.calendar);
  const calendarId = readOptionalString(calendarObj?.calendar_id) ?? readOptionalString(res.data?.calendar_id);
  if (!res.ok || !calendarId) {
    throw badRequest(`创建飞书共享日历失败（${formatFeishuErrorDetail(res)}）`);
  }

  const savedSummary = readOptionalString(calendarObj?.summary) ?? summary;
  const status = saveFeishuConfig({ calendar_id: calendarId }, actorId);
  return {
    ok: true,
    calendarId,
    summary: savedSummary,
    latencyMs: res.latencyMs,
    status,
  };
}

/** 管理员主动测试已配置的飞书共享日历是否可访问。 */
export async function testFeishuCalendarConnection(): Promise<{
  ok: true;
  calendarId: string;
  summary: string;
  latencyMs: number;
}> {
  if (!isFeishuAppConfigured()) {
    throw badRequest('请先填写并保存飞书自建应用的 App ID 和 App Secret');
  }
  const { config } = readRaw();
  const calendarId = config.calendar_id?.trim();
  if (!calendarId) {
    throw badRequest('请先填写共享日历 ID，或点击「一键创建招聘日历」');
  }

  let res: TenantApiCallResult;
  try {
    res = await callFeishuTenantApi(`/open-apis/calendar/v4/calendars/${encodeURIComponent(calendarId)}`, {
      method: 'GET',
    });
  } catch (error) {
    throw badRequest(error instanceof Error ? error.message : '飞书日历连通测试失败');
  }

  if (!res.ok) {
    throw badRequest(`飞书日历访问失败（${formatFeishuErrorDetail(res)}）`);
  }
  const calendarObj = asRecord(res.data?.calendar);
  const summary =
    readOptionalString(calendarObj?.summary) ??
    readOptionalString(res.data?.summary) ??
    'Hireloop 招聘面试';
  return {
    ok: true,
    calendarId,
    summary,
    latencyMs: res.latencyMs,
  };
}

export interface FeishuCalendarSyncResult {
  ok: boolean;
  skipped?: boolean;
  eventId?: string | null;
  meetingUrl?: string | null;
  reason?: string;
}

/**
 * 将单场面试同步到飞书共享日历（创建 / 更新 / 删除），并同步已绑定飞书的面试官参与人；
 * 当形式为视频面试且未手填会议链接时，开启飞书自动生成视频会议链接并回传 meetingUrl。
 */
export async function syncFeishuCalendarEvent(input: {
  action: 'upsert' | 'delete';
  existingEventId: string | null;
  summary: string;
  description: string;
  startAt: string;
  durationMinutes: number;
  mode: 'onsite' | 'video' | 'phone';
  location: string | null;
  meetingUrl: string | null;
  attendeeOpenIds: string[];
  previousAttendeeOpenIds?: string[];
}): Promise<FeishuCalendarSyncResult> {
  if (!isFeishuCalendarConfigured()) {
    return { ok: false, skipped: true, reason: '未配置飞书自建应用凭证或共享日历 ID' };
  }
  const { config } = readRaw();
  const calendarId = config.calendar_id!.trim();
  const encodedCalendarId = encodeURIComponent(calendarId);

  if (input.action === 'delete') {
    if (!input.existingEventId) {
      return { ok: true, skipped: true, eventId: null };
    }
    try {
      const res = await callFeishuTenantApi(
        `/open-apis/calendar/v4/calendars/${encodedCalendarId}/events/${encodeURIComponent(input.existingEventId)}?need_notification=true`,
        { method: 'DELETE' },
      );
      // 远端已经不存在（193001）或已被删除（193003）都算删掉了
      if (res.ok || isCalendarEventNotFound(res) || isCalendarEventDeleted(res)) {
        return { ok: true, eventId: null };
      }
      if (isCalendarConfigError(res)) {
        return {
          ok: false,
          eventId: input.existingEventId,
          reason: `删除飞书日程失败：日历不可用（${formatFeishuErrorDetail(res)}），请在设置页检查或重新创建招聘日历`,
        };
      }
      return {
        ok: false,
        eventId: input.existingEventId,
        reason: `删除飞书日程失败（${formatFeishuErrorDetail(res)}）`,
      };
    } catch (error) {
      return {
        ok: false,
        eventId: input.existingEventId,
        reason: error instanceof Error ? error.message : '删除飞书日程失败',
      };
    }
  }

  const startMs = new Date(input.startAt).getTime();
  if (Number.isNaN(startMs)) {
    return { ok: false, reason: '面试时间无效，无法写入飞书日程' };
  }
  const durationMinutes = Math.max(15, Math.min(480, Math.round(input.durationMinutes || 45)));
  const startSec = String(Math.floor(startMs / 1000));
  const endSec = String(Math.floor((startMs + durationMinutes * 60_000) / 1000));

  const payload: Record<string, unknown> = {
    summary: input.summary,
    description: input.description,
    start_time: { timestamp: startSec, timezone: 'Asia/Shanghai' },
    end_time: { timestamp: endSec, timezone: 'Asia/Shanghai' },
    need_notification: true,
    attendee_ability: 'can_see_others',
  };
  if (input.mode === 'onsite') {
    if (input.location?.trim()) payload.location = { name: input.location.trim() };
    // 由视频改为现场/电话时必须显式关闭视频会议，否则飞书日程会保留旧会议入口
    payload.vchat = { vc_type: 'no_meeting' };
  } else if (input.mode === 'video') {
    if (isHttpUrl(input.meetingUrl)) {
      payload.vchat = {
        vc_type: 'third_party',
        meeting_url: input.meetingUrl,
        description: 'Hireloop 面试视频会议',
      };
    } else {
      payload.vchat = { vc_type: 'vc' };
    }
  } else {
    payload.vchat = { vc_type: 'no_meeting' };
  }

  let res: TenantApiCallResult;
  let updatedExisting = false;
  try {
    if (input.existingEventId) {
      res = await callFeishuTenantApi(
        `/open-apis/calendar/v4/calendars/${encodedCalendarId}/events/${encodeURIComponent(input.existingEventId)}`,
        { method: 'PATCH', payload },
      );
      if (res.ok) {
        updatedExisting = true;
      } else if (isCalendarEventNotFound(res) || isCalendarEventDeleted(res)) {
        res = await callFeishuTenantApi(`/open-apis/calendar/v4/calendars/${encodedCalendarId}/events`, {
          method: 'POST',
          payload,
        });
      }
    } else {
      res = await callFeishuTenantApi(`/open-apis/calendar/v4/calendars/${encodedCalendarId}/events`, {
        method: 'POST',
        payload,
      });
    }
  } catch (error) {
    return {
      ok: false,
      eventId: input.existingEventId,
      reason: error instanceof Error ? error.message : '同步飞书日程失败',
    };
  }

  const eventObj = asRecord(res.data?.event);
  const eventId = readOptionalString(eventObj?.event_id) ?? (updatedExisting ? input.existingEventId : null);
  if (!res.ok || !eventId) {
    const hint = isCalendarConfigError(res) ? '，日历不可用，请在设置页检查或重新创建招聘日历' : '';
    return {
      ok: false,
      eventId: input.existingEventId,
      reason: `同步飞书日程失败（${formatFeishuErrorDetail(res)}）${hint}`,
    };
  }

  const vchatObj = asRecord(eventObj?.vchat);
  const returnedUrl = readOptionalString(vchatObj?.meeting_url);
  const generatedMeetingUrl = isHttpUrl(returnedUrl) ? returnedUrl : null;

  const desiredOpenIds = Array.from(new Set(input.attendeeOpenIds.map((item) => item.trim()).filter(Boolean)));
  const removedOpenIds = Array.from(
    new Set(
      (input.previousAttendeeOpenIds ?? [])
        .map((item) => item.trim())
        .filter((item) => item.length > 0 && !desiredOpenIds.includes(item)),
    ),
  );

  if (desiredOpenIds.length > 0) {
    try {
      const addRes = await callFeishuTenantApi(
        `/open-apis/calendar/v4/calendars/${encodedCalendarId}/events/${encodeURIComponent(eventId)}/attendees?user_id_type=open_id`,
        {
          method: 'POST',
          payload: {
            attendees: desiredOpenIds.map((userId) => ({ type: 'user', user_id: userId })),
            need_notification: true,
          },
        },
      );
      if (!addRes.ok) {
        return {
          ok: false,
          eventId,
          meetingUrl: generatedMeetingUrl,
          reason: `日程已写入，但添加面试官参与人失败（${formatFeishuErrorDetail(addRes)}）`,
        };
      }
    } catch (error) {
      return {
        ok: false,
        eventId,
        meetingUrl: generatedMeetingUrl,
        reason: `日程已写入，但添加面试官参与人失败：${error instanceof Error ? error.message : '网络错误'}`,
      };
    }
  }

  if (updatedExisting && removedOpenIds.length > 0) {
    // 旧面试官没能移出日程时必须报失败，调用方会保留旧参与人记录以便下次重试移除
    try {
      const removeRes = await callFeishuTenantApi(
        `/open-apis/calendar/v4/calendars/${encodedCalendarId}/events/${encodeURIComponent(eventId)}/attendees/batch_delete?user_id_type=open_id`,
        {
          method: 'POST',
          payload: {
            delete_ids: removedOpenIds.map((userId) => ({ type: 'user', user_id: userId })),
            need_notification: true,
          },
        },
      );
      if (!removeRes.ok) {
        return {
          ok: false,
          eventId,
          meetingUrl: generatedMeetingUrl,
          reason: `日程已更新，但移除原面试官失败（${formatFeishuErrorDetail(removeRes)}）`,
        };
      }
    } catch (error) {
      return {
        ok: false,
        eventId,
        meetingUrl: generatedMeetingUrl,
        reason: `日程已更新，但移除原面试官失败：${error instanceof Error ? error.message : '网络错误'}`,
      };
    }
  }

  return {
    ok: true,
    eventId,
    meetingUrl: generatedMeetingUrl,
  };
}
