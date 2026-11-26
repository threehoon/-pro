import { all, getRow, run } from '../db/index.ts';
import { id, now, toJson, jsonParse } from '../lib/util.ts';
import { STAGE_LABELS, type Stage } from '../constants.ts';

export type NotificationChannel = 'inapp' | 'feishu' | 'email';
export type NotificationStatus = 'pending' | 'sent' | 'failed' | 'skipped';

export interface NotificationRow {
  id: string;
  event_key: string;
  type: string;
  channel: NotificationChannel;
  status: NotificationStatus;
  target_user_id: string | null;
  title: string;
  body: string | null;
  payload: string;
  attempts: number;
  last_error: string | null;
  created_at: string;
  sent_at: string | null;
}

/**
 * 通知出站箱：业务只负责登记「发生了什么」，
 * 渠道投递（站内 / 飞书机器人 / 邮件）由 dispatch 驱动。飞书未配置时保留为 pending，
 * 接入后按 event_key 幂等重放，不需要改动业务代码。
 */
export function enqueueNotification(input: {
  eventKey: string;
  type: string;
  title: string;
  body?: string;
  payload?: Record<string, unknown>;
  targetUserId?: string | null;
  channel?: NotificationChannel;
}): NotificationRow {
  const notificationId = id('ntf');
  run(
    `INSERT INTO notifications
       (id, event_key, type, channel, status, target_user_id, title, body, payload, created_at)
     VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
    [
      notificationId,
      input.eventKey,
      input.type,
      input.channel ?? 'inapp',
      input.targetUserId ?? null,
      input.title,
      input.body ?? null,
      toJson(input.payload ?? {}),
      now(),
    ],
  );
  return getRow<NotificationRow>('SELECT * FROM notifications WHERE id = ?', [notificationId])!;
}

export function notifyStageChange(input: {
  applicationId: string;
  candidateName: string;
  jobTitle: string;
  fromStage: Stage | null;
  toStage: Stage | null;
  actorId: string;
  recipientId: string | null;
  rejected?: boolean;
}): void {
  const eventKey = `application:${input.applicationId}:${input.toStage ?? 'rejected'}:${Date.now()}`;
  const title = input.rejected
    ? `${input.candidateName} 已进入拒绝状态`
    : `${input.candidateName} 进入「${input.toStage ? STAGE_LABELS[input.toStage] : '未知'}」`;
  const body = input.rejected
    ? `职位：${input.jobTitle}`
    : `职位：${input.jobTitle}${input.fromStage ? `，来自「${STAGE_LABELS[input.fromStage]}」` : ''}`;

  enqueueNotification({
    eventKey,
    type: input.rejected ? 'application.rejected' : 'application.stage_changed',
    title,
    body,
    targetUserId: input.recipientId,
    payload: {
      applicationId: input.applicationId,
      jobTitle: input.jobTitle,
      candidateName: input.candidateName,
      fromStage: input.fromStage,
      toStage: input.toStage,
      rejected: input.rejected ?? false,
      actorId: input.actorId,
    },
  });

  // 飞书渠道先登记为 pending，等待接入后由 dispatcher 重放
  enqueueNotification({
    eventKey,
    type: input.rejected ? 'application.rejected' : 'application.stage_changed',
    title,
    body,
    targetUserId: input.recipientId,
    channel: 'feishu',
    payload: {
      applicationId: input.applicationId,
      jobTitle: input.jobTitle,
      candidateName: input.candidateName,
      fromStage: input.fromStage,
      toStage: input.toStage,
      rejected: input.rejected ?? false,
    },
  });
}

export function notifyInterviewScheduled(input: {
  interviewId: string;
  applicationId: string;
  candidateName: string;
  jobTitle: string;
  scheduledAt: string;
  interviewerId: string | null;
  actorId: string;
  rescheduled?: boolean;
}): void {
  const eventKey = `interview:${input.interviewId}:scheduled:${Date.now()}`;
  const title = input.rescheduled
    ? `面试改期：${input.candidateName} · ${input.jobTitle}`
    : `面试安排：${input.candidateName} · ${input.jobTitle}`;
  const when = new Date(input.scheduledAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });

  enqueueNotification({
    eventKey,
    type: 'interview.scheduled',
    title,
    body: `时间：${when}`,
    targetUserId: input.interviewerId,
    payload: { interviewId: input.interviewId, applicationId: input.applicationId, scheduledAt: input.scheduledAt },
  });
  enqueueNotification({
    eventKey,
    type: 'interview.scheduled',
    title,
    body: `时间：${when}`,
    targetUserId: input.interviewerId,
    channel: 'feishu',
    payload: {
      interviewId: input.interviewId,
      applicationId: input.applicationId,
      scheduledAt: input.scheduledAt,
      actorId: input.actorId,
    },
  });
}

export function listNotifications(limit = 30, channel?: string): NotificationRow[] {
  if (channel) {
    return all<NotificationRow>(
      'SELECT * FROM notifications WHERE channel = ? ORDER BY created_at DESC LIMIT ?',
      [channel, limit],
    );
  }
  return all<NotificationRow>('SELECT * FROM notifications ORDER BY created_at DESC LIMIT ?', [limit]);
}

export function notificationStats(): Record<NotificationStatus, number> {
  const rows = all<{ status: NotificationStatus; n: number }>(
    'SELECT status, COUNT(*) AS n FROM notifications GROUP BY status',
  );
  const stats: Record<NotificationStatus, number> = { pending: 0, sent: 0, failed: 0, skipped: 0 };
  for (const row of rows) stats[row.status] = row.n;
  return stats;
}

export function notificationPayload(row: NotificationRow): Record<string, unknown> {
  return jsonParse<Record<string, unknown>>(row.payload, {});
}