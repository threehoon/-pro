import { afterCommit, all, getRow, isDbOpen, run } from '../db/index.ts';
import { id, now, toJson, jsonParse } from '../lib/util.ts';
import { badRequest, notFound } from '../lib/errors.ts';
import { INTERVIEW_MODE_LABELS, STAGE_LABELS, type InterviewMode, type Stage } from '../constants.ts';
import {
  buildGenericNotificationCard,
  buildInterviewCard,
  buildStageChangeCard,
  isFeishuWebhookConfigured,
  sendFeishuWebhookCard,
} from '../integrations/feishu.ts';

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

export interface FeishuDispatchItemResult {
  id: string;
  status: NotificationStatus;
  ok: boolean;
  skipped?: boolean;
  error?: string | null;
}

export interface FeishuDispatchSummary {
  attempted: number;
  sent: number;
  failed: number;
  skipped: number;
  remainingPending: number;
  items: FeishuDispatchItemResult[];
}

const inFlightNotificationIds = new Set<string>();
const pendingAutoDispatches = new Set<Promise<void>>();

/** 测试辅助：等待由业务操作触发的异步飞书投递全部 settle。 */
export async function waitForFeishuDispatches(): Promise<void> {
  await Promise.resolve();
  while (pendingAutoDispatches.size > 0) {
    const batch = Array.from(pendingAutoDispatches);
    await Promise.allSettled(batch);
    await Promise.resolve();
  }
}

function scheduleFeishuAutoDispatch(notificationId: string): void {
  if (!isDbOpen()) return;
  if (!isFeishuWebhookConfigured()) return;
  const task = dispatchFeishuNotification(notificationId, {
    allowRetryFailed: false,
    allowSkipped: false,
  })
    .then(() => undefined)
    .catch(() => undefined);
  pendingAutoDispatches.add(task);
  void task.finally(() => {
    pendingAutoDispatches.delete(task);
  });
}

/**
 * 通知出站箱：业务只负责登记「发生了什么」，
 * 飞书通道在已配置 Webhook 时于事务提交后异步投递；未配置或失败时留在出站箱，绝不阻塞业务流转。
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
  const channel = input.channel ?? 'inapp';
  run(
    `INSERT INTO notifications
       (id, event_key, type, channel, status, target_user_id, title, body, payload, created_at)
     VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
    [
      notificationId,
      input.eventKey,
      input.type,
      channel,
      input.targetUserId ?? null,
      input.title,
      input.body ?? null,
      toJson(input.payload ?? {}),
      now(),
    ],
  );
  const row = getRow<NotificationRow>('SELECT * FROM notifications WHERE id = ?', [notificationId])!;
  if (channel === 'feishu') {
    afterCommit(() => scheduleFeishuAutoDispatch(notificationId));
  }
  return row;
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
    payload: {
      interviewId: input.interviewId,
      applicationId: input.applicationId,
      scheduledAt: input.scheduledAt,
      candidateName: input.candidateName,
      jobTitle: input.jobTitle,
      rescheduled: Boolean(input.rescheduled),
    },
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
      candidateName: input.candidateName,
      jobTitle: input.jobTitle,
      rescheduled: Boolean(input.rescheduled),
      actorId: input.actorId,
    },
  });
}

function buildCardForNotification(row: NotificationRow): unknown {
  const payload = notificationPayload(row);

  if (row.type === 'interview.scheduled') {
    const interviewId = typeof payload.interviewId === 'string' ? payload.interviewId : null;
    const detail = interviewId
      ? getRow<{
          round: number;
          scheduled_at: string;
          duration_minutes: number;
          mode: InterviewMode;
          location: string | null;
          meeting_url: string | null;
          interviewer_name: string | null;
          candidate_name: string;
          job_title: string;
        }>(
          `SELECT i.round, i.scheduled_at, i.duration_minutes, i.mode, i.location, i.meeting_url,
                  u.name AS interviewer_name, c.name AS candidate_name, j.title AS job_title
             FROM interviews i
             JOIN applications a ON a.id = i.application_id
             JOIN candidates c ON c.id = a.candidate_id
             JOIN jobs j ON j.id = a.job_id
             LEFT JOIN users u ON u.id = i.interviewer_id
            WHERE i.id = ?`,
          [interviewId],
        )
      : undefined;

    const candidateName =
      detail?.candidate_name ?? (typeof payload.candidateName === 'string' ? payload.candidateName : row.title);
    const jobTitle = detail?.job_title ?? (typeof payload.jobTitle === 'string' ? payload.jobTitle : '招聘职位');
    const scheduledAt =
      detail?.scheduled_at ?? (typeof payload.scheduledAt === 'string' ? payload.scheduledAt : row.created_at);
    const modeLabel = detail?.mode ? (INTERVIEW_MODE_LABELS[detail.mode] ?? detail.mode) : '视频';

    return buildInterviewCard({
      candidateName,
      jobTitle,
      round: detail?.round ?? 1,
      scheduledAt,
      durationMinutes: detail?.duration_minutes ?? 45,
      modeLabel,
      interviewerName: detail?.interviewer_name ?? null,
      meetingUrl: detail?.meeting_url ?? null,
      location: detail?.location ?? null,
      rescheduled: Boolean(payload.rescheduled) || row.title.startsWith('面试改期'),
    });
  }

  if (row.type === 'application.stage_changed' || row.type === 'application.rejected') {
    const candidateName = typeof payload.candidateName === 'string' ? payload.candidateName : row.title;
    const jobTitle = typeof payload.jobTitle === 'string' ? payload.jobTitle : '招聘职位';
    const fromStage = typeof payload.fromStage === 'string' ? (payload.fromStage as Stage) : null;
    const toStage = typeof payload.toStage === 'string' ? (payload.toStage as Stage) : null;
    return buildStageChangeCard({
      candidateName,
      jobTitle,
      fromStage,
      toStage,
      rejected: Boolean(payload.rejected) || row.type === 'application.rejected',
      createdAt: row.created_at,
    });
  }

  return buildGenericNotificationCard({
    title: row.title,
    body: row.body,
    createdAt: row.created_at,
  });
}

export async function dispatchFeishuNotification(
  notificationId: string,
  options: { allowRetryFailed?: boolean; allowSkipped?: boolean } = {},
): Promise<FeishuDispatchItemResult> {
  if (!isDbOpen()) {
    return { id: notificationId, status: 'pending', ok: false, skipped: true, error: '数据库未就绪' };
  }
  if (inFlightNotificationIds.has(notificationId)) {
    return { id: notificationId, status: 'pending', ok: false, skipped: true, error: '该消息正在发送中' };
  }

  inFlightNotificationIds.add(notificationId);
  try {
    const row = getRow<NotificationRow>('SELECT * FROM notifications WHERE id = ?', [notificationId]);
    if (!row || row.channel !== 'feishu') {
      return { id: notificationId, status: 'skipped', ok: false, skipped: true, error: '通知不存在或非飞书通道' };
    }
    if (row.status === 'sent') {
      return { id: row.id, status: 'sent', ok: true, skipped: true };
    }
    if (row.status === 'failed' && !options.allowRetryFailed) {
      return { id: row.id, status: 'failed', ok: false, skipped: true, error: row.last_error };
    }
    if (row.status === 'skipped' && !options.allowSkipped) {
      return { id: row.id, status: 'skipped', ok: false, skipped: true, error: row.last_error };
    }
    if (!isFeishuWebhookConfigured()) {
      return { id: row.id, status: row.status, ok: false, skipped: true, error: '未配置机器人 Webhook' };
    }

    const card = buildCardForNotification(row);
    const result = await sendFeishuWebhookCard(card);

    if (!isDbOpen()) {
      return { id: row.id, status: row.status, ok: false, skipped: true, error: '数据库已关闭' };
    }

    if (result.ok) {
      run(
        `UPDATE notifications
            SET status = 'sent', attempts = attempts + 1, last_error = NULL, sent_at = ?
          WHERE id = ?`,
        [now(), row.id],
      );
      return { id: row.id, status: 'sent', ok: true };
    }

    if (result.skipped) {
      return { id: row.id, status: row.status, ok: false, skipped: true, error: result.reason ?? null };
    }

    const errorMessage = result.reason ?? '飞书推送失败';
    run(
      `UPDATE notifications
          SET status = 'failed', attempts = attempts + 1, last_error = ?
        WHERE id = ?`,
      [errorMessage, row.id],
    );
    return { id: row.id, status: 'failed', ok: false, error: errorMessage };
  } finally {
    inFlightNotificationIds.delete(notificationId);
  }
}

function countPendingFeishu(): number {
  const row = getRow<{ n: number }>(
    "SELECT COUNT(*) AS n FROM notifications WHERE channel = 'feishu' AND status = 'pending'",
  );
  return row?.n ?? 0;
}

/** 按需补发：支持单条发送/重试，或按时间先后顺序有界批量补发（最多 20 条） */
export async function dispatchFeishuOutbox(input: {
  notificationId?: string;
  limit?: number;
  includeFailed?: boolean;
} = {}): Promise<FeishuDispatchSummary> {
  if (!isFeishuWebhookConfigured()) {
    throw badRequest('请先填写并保存有效的飞书机器人 Webhook');
  }

  if (input.notificationId) {
    const existing = getRow<NotificationRow>('SELECT * FROM notifications WHERE id = ?', [input.notificationId]);
    if (!existing) throw notFound('通知记录不存在');
    if (existing.channel !== 'feishu') throw badRequest('仅支持发送飞书出站消息');
    const item = await dispatchFeishuNotification(existing.id, {
      allowRetryFailed: true,
      allowSkipped: true,
    });
    return {
      attempted: item.skipped ? 0 : 1,
      sent: !item.skipped && item.ok ? 1 : 0,
      failed: !item.skipped && !item.ok ? 1 : 0,
      skipped: item.skipped ? 1 : 0,
      remainingPending: countPendingFeishu(),
      items: [item],
    };
  }

  const limit = Math.min(Math.max(input.limit ?? 10, 1), 20);
  const statuses = input.includeFailed ? "('pending', 'failed')" : "('pending')";
  const rows = all<NotificationRow>(
    `SELECT * FROM notifications
      WHERE channel = 'feishu' AND status IN ${statuses}
      ORDER BY created_at ASC, rowid ASC
      LIMIT ?`,
    [limit],
  );

  const items: FeishuDispatchItemResult[] = [];
  let attempted = 0;
  let sent = 0;
  let failed = 0;
  let skipped = 0;

  for (const row of rows) {
    const res = await dispatchFeishuNotification(row.id, {
      allowRetryFailed: Boolean(input.includeFailed),
      allowSkipped: false,
    });
    items.push(res);
    if (res.skipped) {
      skipped += 1;
    } else {
      attempted += 1;
      if (res.ok) sent += 1;
      else failed += 1;
    }
  }

  return {
    attempted,
    sent,
    failed,
    skipped,
    remainingPending: countPendingFeishu(),
    items,
  };
}

/** 跳过历史待发（全部或单条），避免首次接通 Webhook 时把历史积压消息刷屏到群里 */
export function skipPendingFeishuNotifications(input: {
  notificationId?: string;
  reason?: string;
} = {}): { skipped: number; remainingPending: number } {
  const reason = input.reason?.trim() || '管理员跳过历史待发消息';
  if (input.notificationId) {
    const existing = getRow<NotificationRow>('SELECT * FROM notifications WHERE id = ?', [input.notificationId]);
    if (!existing) throw notFound('通知记录不存在');
    if (existing.channel !== 'feishu') throw badRequest('仅支持操作飞书出站消息');
    if (existing.status === 'sent') throw badRequest('已发送的消息无需跳过');
    if (existing.status === 'failed') throw badRequest('失败消息不支持跳过，请查看失败原因或手动重试');
    if (existing.status === 'skipped') {
      return { skipped: 0, remainingPending: countPendingFeishu() };
    }
    if (inFlightNotificationIds.has(existing.id)) {
      throw badRequest('该消息正在发送中，请稍后刷新状态');
    }
    const result = run(
      "UPDATE notifications SET status = 'skipped', last_error = ? WHERE id = ? AND status = 'pending'",
      [reason, existing.id],
    );
    return { skipped: Number(result.changes), remainingPending: countPendingFeishu() };
  }

  const inFlight = Array.from(inFlightNotificationIds);
  const result =
    inFlight.length > 0
      ? run(
          `UPDATE notifications
              SET status = 'skipped', last_error = ?
            WHERE channel = 'feishu' AND status = 'pending' AND id NOT IN (${inFlight.map(() => '?').join(', ')})`,
          [reason, ...inFlight],
        )
      : run(
          "UPDATE notifications SET status = 'skipped', last_error = ? WHERE channel = 'feishu' AND status = 'pending'",
          [reason],
        );
  return { skipped: Number(result.changes), remainingPending: countPendingFeishu() };
}

export function listNotifications(limit = 30, channel?: string): NotificationRow[] {
  if (channel) {
    return all<NotificationRow>(
      'SELECT * FROM notifications WHERE channel = ? ORDER BY created_at DESC, rowid DESC LIMIT ?',
      [channel, limit],
    );
  }
  return all<NotificationRow>('SELECT * FROM notifications ORDER BY created_at DESC, rowid DESC LIMIT ?', [limit]);
}

export function notificationStats(channel?: string): Record<NotificationStatus, number> {
  const rows = channel
    ? all<{ status: NotificationStatus; n: number }>(
        'SELECT status, COUNT(*) AS n FROM notifications WHERE channel = ? GROUP BY status',
        [channel],
      )
    : all<{ status: NotificationStatus; n: number }>(
        'SELECT status, COUNT(*) AS n FROM notifications GROUP BY status',
      );
  const stats: Record<NotificationStatus, number> = { pending: 0, sent: 0, failed: 0, skipped: 0 };
  for (const row of rows) stats[row.status] = row.n;
  return stats;
}

export function notificationPayload(row: NotificationRow): Record<string, unknown> {
  return jsonParse<Record<string, unknown>>(row.payload, {});
}
