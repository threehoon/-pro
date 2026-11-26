import { getRow, run } from '../db/index.ts';
import { now, jsonParse } from '../lib/util.ts';

export interface FeishuConfig {
  app_id?: string;
  app_secret?: string;
  verification_token?: string;
  encrypt_key?: string;
  bot_webhook?: string;
  calendar_id?: string;
}

export interface FeishuStatus {
  provider: 'feishu';
  status: 'disabled' | 'configured';
  configured: boolean;
  /** 已登记配置项（不回传 secret 明文） */
  fields: {
    app_id: boolean;
    app_secret: boolean;
    verification_token: boolean;
    bot_webhook: boolean;
    calendar_id: boolean;
  };
  ready: {
    login: boolean;
    notifications: boolean;
    calendar: boolean;
  };
  pendingNotifications: number;
  updatedAt: string | null;
  /** 接入步骤，前端设置页直接展示 */
  checklist: Array<{ key: string; label: string; description: string; done: boolean }>;
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

export function feishuStatus(): FeishuStatus {
  const raw = readRaw();
  const config = raw.config;
  const fields = {
    app_id: Boolean(config.app_id),
    app_secret: Boolean(config.app_secret),
    verification_token: Boolean(config.verification_token),
    bot_webhook: Boolean(config.bot_webhook),
    calendar_id: Boolean(config.calendar_id),
  };
  const pending = getRow<{ n: number }>(
    "SELECT COUNT(*) AS n FROM notifications WHERE channel = 'feishu' AND status = 'pending'",
  );

  const loginReady = fields.app_id && fields.app_secret;
  const notificationsReady = Boolean(config.bot_webhook) || loginReady;
  const calendarReady = loginReady && fields.calendar_id;

  return {
    provider: 'feishu',
    status: raw.status,
    configured: raw.status === 'configured',
    fields,
    ready: { login: loginReady, notifications: notificationsReady, calendar: calendarReady },
    pendingNotifications: pending?.n ?? 0,
    updatedAt: raw.updatedAt,
    checklist: [
      {
        key: 'login',
        label: '飞书扫码登录',
        description: '在飞书开放平台创建自建应用，回填 App ID / App Secret，开启网页应用登录。',
        done: Boolean(loginReady),
      },
      {
        key: 'identity',
        label: '成员身份映射',
        description: '成员首次扫码登录后回填 open_id，工作台按邮箱匹配到招聘成员。',
        done: fields.app_id && fields.app_secret,
      },
      {
        key: 'notify',
        label: '招聘消息通知',
        description: '配置机器人 Webhook 后，阶段变化与面试安排以消息卡片推送。',
        done: Boolean(config.bot_webhook),
      },
      {
        key: 'calendar',
        label: '面试日历同步',
        description: '配置共享日历 ID，创建面试时写入飞书日程，改期取消同步更新。',
        done: Boolean(calendarReady),
      },
      {
        key: 'webhook',
        label: '事件回调',
        description: '接收飞书侧日程变更与审批结果，用于回写面试和录用状态。',
        done: Boolean(config.verification_token),
      },
    ],
  };
}

export function saveFeishuConfig(input: Partial<FeishuConfig>, actorId: string): FeishuStatus {
  const raw = readRaw();
  const next = { ...raw.config };
  for (const [key, value] of Object.entries(input)) {
    if (typeof value !== 'string') continue;
    if (value.trim() === '') delete (next as Record<string, unknown>)[key];
    else (next as Record<string, unknown>)[key] = value.trim();
  }
  if (next.app_secret === '••••••••') next.app_secret = raw.config.app_secret;

  const configured = Boolean(next.app_id && next.app_secret);
  run(
    `UPDATE integrations SET status = ?, config_json = ?, updated_by = ?, updated_at = ? WHERE provider = 'feishu'`,
    [configured ? 'configured' : 'disabled', JSON.stringify(next), actorId, now()],
  );
  return feishuStatus();
}

/**
 * 飞书消息卡片（面试安排）。提前固化卡片结构，接入时只需替换投递地址，
 * 不需要重写业务侧的通知内容。
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
  workbenchUrl: string;
}) {
  const when = new Date(input.scheduledAt);
  const dateText = Number.isNaN(when.getTime())
    ? input.scheduledAt
    : when.toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        month: '2-digit',
        day: '2-digit',
        weekday: 'short',
        hour: '2-digit',
        minute: '2-digit',
      });

  return {
    config: { wide_screen_mode: true },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: `面试安排 · ${input.candidateName}` },
    },
    elements: [
      {
        tag: 'div',
        fields: [
          { is_short: true, text: { tag: 'lark_md', content: `**职位**\n${input.jobTitle}` } },
          { is_short: true, text: { tag: 'lark_md', content: `**轮次**\n第 ${input.round} 轮` } },
          { is_short: true, text: { tag: 'lark_md', content: `**时间**\n${dateText}（${input.durationMinutes} 分钟）` } },
          { is_short: true, text: { tag: 'lark_md', content: `**形式**\n${input.modeLabel}` } },
          { is_short: true, text: { tag: 'lark_md', content: `**面试官**\n${input.interviewerName ?? '待指派'}` } },
        ],
      },
      ...(input.meetingUrl
        ? [
            {
              tag: 'action',
              actions: [
                {
                  tag: 'button',
                  type: 'primary',
                  text: { tag: 'plain_text', content: '进入会议' },
                  url: input.meetingUrl,
                },
              ],
            },
          ]
        : []),
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            type: 'default',
            text: { tag: 'plain_text', content: '打开招聘工作台' },
            url: input.workbenchUrl,
          },
        ],
      },
      { tag: 'note', elements: [{ tag: 'plain_text', content: '由 Hireloop 招聘工作台发送' }] },
    ],
  };
}

/**
 * 飞书消息发送。未配置时返回 skipped 并记录原因，绝不伪造发送成功。
 * 接入实现：获取 tenant_access_token 后 POST /open-apis/im/v1/messages。
 */
export async function sendFeishuMessage(card: unknown, receiveId: string | null): Promise<{
  ok: boolean;
  skipped?: boolean;
  reason?: string;
}> {
  const { config, status } = readRaw();
  if (status !== 'configured') return { ok: false, skipped: true, reason: '飞书接入未启用' };
  if (!receiveId) return { ok: false, skipped: true, reason: '缺少接收人 open_id' };
  if (!config.bot_webhook) return { ok: false, skipped: true, reason: '未配置机器人 Webhook' };

  // 真实投递在接入阶段实现；当前保留为显式未实现，避免误报发送成功。
  void card;
  return { ok: false, skipped: true, reason: '消息投递适配器待接入（Webhook 已登记）' };
}

export function loginCapability(): { enabled: boolean; appId: string | null } {
  const { config, status } = readRaw();
  return { enabled: status === 'configured' && Boolean(config.app_id), appId: config.app_id ?? null };
}