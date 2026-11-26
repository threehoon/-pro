import { afterCommit, all, getRow, isDbOpen, run, transaction } from '../db/index.ts';
import { id, now } from '../lib/util.ts';
import { badRequest, notFound } from '../lib/errors.ts';
import { INTERVIEW_MODE_LABELS, type InterviewMode } from '../constants.ts';
import { isFeishuCalendarConfigured, syncFeishuCalendarEvent } from '../integrations/feishu.ts';
import { audit } from './audit.ts';
import {
  notifyInterviewCancelled,
  notifyInterviewScheduled,
  scheduleFeishuAutoDispatchIds,
} from './notifications.ts';
import { applicationContext, getApplication, recordArchive, recordStage, workflowArchiveReason } from './applications.ts';
import { offerDetail, startNegotiation } from './offers.ts';

export type CalendarSyncStatus = 'none' | 'pending' | 'synced' | 'failed';

export interface InterviewRow {
  id: string;
  application_id: string;
  round: number;
  title: string;
  mode: InterviewMode;
  scheduled_at: string;
  duration_minutes: number;
  location: string | null;
  meeting_url: string | null;
  interviewer_id: string | null;
  status: 'scheduled' | 'completed' | 'cancelled' | 'no_show';
  summary_status: string;
  is_draft: number;
  decision: string | null;
  external_calendar_event_id: string | null;
  calendar_sync_status: CalendarSyncStatus;
  calendar_sync_error: string | null;
  calendar_synced_at: string | null;
  /** 已成功写入飞书日程的参与人 open_id 列表，用于后续改期换人时移除旧面试官 */
  calendar_attendees_json: string;
  /** 远端日程存在飞书 PATCH 清不掉的旧字段（旧会议室），下次同步必须先删旧建新 */
  calendar_recreate_required: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export const INTERVIEW_FIELDS = `i.id, i.application_id, i.round, i.title, i.mode, i.scheduled_at,
  i.duration_minutes, i.location, i.meeting_url, i.interviewer_id, i.status, i.summary_status,
  i.is_draft, i.decision, i.external_calendar_event_id, i.calendar_sync_status, i.calendar_sync_error,
  i.calendar_synced_at, i.calendar_attendees_json, i.calendar_recreate_required, i.created_by,
  i.created_at, i.updated_at, i.completed_at`;

const pendingCalendarSyncs = new Set<Promise<void>>();
const interviewSyncChains = new Map<string, Promise<void>>();

/** 测试辅助：等待所有异步飞书面试日历同步任务 settle。 */
export async function waitForCalendarSyncs(): Promise<void> {
  await Promise.resolve();
  while (pendingCalendarSyncs.size > 0) {
    const batch = Array.from(pendingCalendarSyncs);
    await Promise.allSettled(batch);
    await Promise.resolve();
  }
}

interface CalendarSyncOutcome {
  ok: boolean;
  skipped?: boolean;
  error?: string | null;
  meetingUrl?: string | null;
}

function lookupUserFeishuOpenId(userId: string | null | undefined): string | null {
  if (!userId) return null;
  const row = getRow<{ feishu_open_id: string | null }>('SELECT feishu_open_id FROM users WHERE id = ?', [userId]);
  return row?.feishu_open_id?.trim() || null;
}

async function runInterviewCalendarSync(
  interviewId: string,
  options: { previousInterviewerOpenId?: string | null } = {},
): Promise<CalendarSyncOutcome> {
  if (!isDbOpen()) {
    return { ok: false, skipped: true, error: '数据库未就绪' };
  }
  const row = getRow<
    InterviewRow & {
      candidate_name: string;
      job_title: string;
      interviewer_name: string | null;
      interviewer_feishu_open_id: string | null;
    }
  >(
    `SELECT ${INTERVIEW_FIELDS},
            c.name AS candidate_name,
            j.title AS job_title,
            u.name AS interviewer_name,
            u.feishu_open_id AS interviewer_feishu_open_id
       FROM interviews i
       JOIN applications a ON a.id = i.application_id
       JOIN candidates c ON c.id = a.candidate_id
       JOIN jobs j ON j.id = a.job_id
       LEFT JOIN users u ON u.id = i.interviewer_id
      WHERE i.id = ?`,
    [interviewId],
  );
  if (!row || row.is_draft) {
    return { ok: false, skipped: true, error: '该面试记录尚未安排时间' };
  }
  if (!isFeishuCalendarConfigured()) {
    return { ok: false, skipped: true, error: '未配置飞书自建应用凭证或共享日历 ID' };
  }

  const storedAttendees = parseAttendeeIds(row.calendar_attendees_json);
  const isDelete = row.status === 'cancelled';
  if (isDelete && !row.external_calendar_event_id) {
    // 远端从未成功创建过日程：无论是「待同步」还是「同步失败」，取消后都不应继续挂失败态
    if (row.calendar_sync_status !== 'none' || row.calendar_sync_error) {
      run(
        `UPDATE interviews
            SET calendar_sync_status = 'none', calendar_sync_error = NULL, calendar_attendees_json = '[]'
          WHERE id = ?`,
        [interviewId],
      );
    }
    return { ok: true, skipped: true };
  }

  const modeLabel = INTERVIEW_MODE_LABELS[row.mode] ?? row.mode;
  const descriptionLines = [
    `候选人：${row.candidate_name}`,
    `职位：${row.job_title}`,
    `轮次：第 ${row.round} 轮（${row.title}）`,
    `形式：${modeLabel}`,
    `面试官：${row.interviewer_name ?? '待指派'}`,
  ];
  if (row.location?.trim()) descriptionLines.push(`地点：${row.location.trim()}`);
  if (row.meeting_url?.trim()) descriptionLines.push(`会议链接：${row.meeting_url.trim()}`);
  descriptionLines.push('由 Hireloop 招聘工作台自动同步');

  const attendeeOpenIds = row.interviewer_feishu_open_id?.trim() ? [row.interviewer_feishu_open_id.trim()] : [];
  // 已成功邀请过、这次不该再收到日程的旧面试官：结合持久化记录与本次调用传入的旧面试官
  const previousAttendeeOpenIds = Array.from(
    new Set(
      [...storedAttendees, ...(options.previousInterviewerOpenId ? [options.previousInterviewerOpenId] : [])].filter(
        (openId) => openId && !attendeeOpenIds.includes(openId),
      ),
    ),
  );

  const eventPayload = {
    summary: `【第 ${row.round} 轮面试】${row.candidate_name} · ${row.job_title}`,
    description: descriptionLines.join('\n'),
    startAt: row.scheduled_at,
    durationMinutes: row.duration_minutes,
    mode: row.mode,
    location: row.location,
    meetingUrl: row.meeting_url,
    attendeeOpenIds,
    previousAttendeeOpenIds,
  };

  let existingEventId = row.external_calendar_event_id;
  // 飞书 PATCH 没有「清空地点」语义（不传即不更新），现场改视频/电话、或现场面试清空地点之后，
  // 只能先删旧日程再重建，否则面试官仍会看到已作废的会议室。
  // 标记持久化在 calendar_recreate_required，保证失败后点「重试同步」仍会走重建而不是只 PATCH。
  const needsRecreate = !isDelete && row.calendar_recreate_required === 1;
  let recreateHandled = false;
  if (needsRecreate && existingEventId) {
    const removed = await syncFeishuCalendarEvent({ action: 'delete', existingEventId, ...eventPayload });
    if (!removed.ok && !removed.skipped) {
      const message = removed.reason ?? '删除旧飞书日程失败';
      if (!isDbOpen()) return { ok: false, skipped: true, error: message };
      run(
        "UPDATE interviews SET calendar_sync_status = 'failed', calendar_sync_error = ?, updated_at = ? WHERE id = ?",
        [message, now(), interviewId],
      );
      return { ok: false, error: message, meetingUrl: row.meeting_url };
    }
    existingEventId = null;
    recreateHandled = true;
  }
  // 标记为待重建但远端已经没有事件可删：这次新建成功即可清掉标记
  const clearRecreateFlag = needsRecreate && (recreateHandled || !row.external_calendar_event_id);

  const result = await syncFeishuCalendarEvent({
    action: isDelete ? 'delete' : 'upsert',
    existingEventId,
    ...eventPayload,
  });

  if (!isDbOpen()) {
    return { ok: false, skipped: true, error: '数据库已关闭' };
  }

  if (result.skipped) {
    if (row.calendar_sync_status === 'pending') {
      run("UPDATE interviews SET calendar_sync_status = 'none' WHERE id = ?", [interviewId]);
    }
    return { ok: Boolean(result.ok), skipped: true, error: result.reason ?? null };
  }

  const syncedAt = now();
  // 删除失败时必须保留事件 ID，否则远端日程失去引用、再也无法更新或删除
  const nextEventId = isDelete ? (result.ok ? null : existingEventId) : (result.eventId ?? existingEventId);
  // 仅当用户还没手填会议链接时才回写自动生成的飞书会议链接
  const writebackMeetingUrl =
    !isDelete && row.mode === 'video' && !row.meeting_url?.trim() && result.meetingUrl ? result.meetingUrl : null;
  const nextAttendeesJson = result.ok ? JSON.stringify(isDelete ? [] : attendeeOpenIds) : null;

  const writeCalendarState = (status: CalendarSyncStatus, error: string | null) =>
    run(
      `UPDATE interviews
          SET external_calendar_event_id = ?,
              meeting_url = CASE
                WHEN ? IS NULL THEN meeting_url
                WHEN meeting_url IS NULL OR TRIM(meeting_url) = '' THEN ?
                ELSE meeting_url
              END,
              calendar_sync_status = ?,
              calendar_sync_error = ?,
              calendar_synced_at = CASE
                WHEN ? = 'synced' THEN ?
                WHEN ? = 'none' THEN NULL
                ELSE calendar_synced_at
              END,
              calendar_attendees_json = COALESCE(?, calendar_attendees_json),
              calendar_recreate_required = CASE WHEN ? THEN 0 ELSE calendar_recreate_required END,
              updated_at = ?
        WHERE id = ?`,
      [nextEventId, writebackMeetingUrl, writebackMeetingUrl, status, error, status, syncedAt, status, nextAttendeesJson, clearRecreateFlag ? 1 : 0, syncedAt, interviewId],
    );

  if (result.ok) {
    // 删除成功后不再有任何飞书日程，状态回落 none，避免列表继续显示「已同步飞书日历」
    writeCalendarState(isDelete ? 'none' : 'synced', null);
    return { ok: true, meetingUrl: writebackMeetingUrl ?? row.meeting_url };
  }

  const errorMessage = result.reason ?? '飞书日历同步失败';
  writeCalendarState('failed', errorMessage);
  return { ok: false, error: errorMessage, meetingUrl: writebackMeetingUrl ?? row.meeting_url };
}

function parseAttendeeIds(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim());
  } catch {
    return [];
  }
}

function enqueueInterviewSyncChain<T>(interviewId: string, fn: () => Promise<T>): Promise<T> {
  const previous = interviewSyncChains.get(interviewId) ?? Promise.resolve();
  const nextResult = previous.catch(() => undefined).then(fn);
  const tracker = nextResult.then(() => undefined, () => undefined);
  interviewSyncChains.set(interviewId, tracker);
  pendingCalendarSyncs.add(tracker);
  void tracker.finally(() => {
    pendingCalendarSyncs.delete(tracker);
    if (interviewSyncChains.get(interviewId) === tracker) {
      interviewSyncChains.delete(interviewId);
    }
  });
  return nextResult;
}

/**
 * 跑一次同步，并在「同步期间这场面试被取消」时补一次删除。
 * 创建日程与取消面试存在竞态：取消时还没有事件 ID，所以没排删除，创建成功后才写回；
 * 即使本次返回失败也要检查——新建成功但添加面试官失败时同样会拿到事件 ID，更不能留下孤儿日程。
 * 自动路径（创建/改期）与手动重试都必须走这里，否则手动重试会漏掉补删。
 */
async function runInterviewSyncWithCompensation(
  interviewId: string,
  options: { previousInterviewerOpenId?: string | null } = {},
) {
  let outcome = await runInterviewCalendarSync(interviewId, {
    previousInterviewerOpenId: options.previousInterviewerOpenId,
  });
  const fresh = getRow<InterviewRow>(`SELECT ${INTERVIEW_FIELDS} FROM interviews i WHERE i.id = ?`, [interviewId]);
  if (fresh?.status === 'cancelled' && fresh.external_calendar_event_id) {
    const cleanup = await runInterviewCalendarSync(interviewId, {});
    outcome = { ...cleanup, meetingUrl: cleanup.meetingUrl ?? outcome.meetingUrl };
  }
  return outcome;
}

function scheduleInterviewCalendarSync(
  interviewId: string,
  options: { previousInterviewerOpenId?: string | null; deferredNotificationIds?: string[] } = {},
): void {
  void enqueueInterviewSyncChain(interviewId, async () => {
    try {
      await runInterviewSyncWithCompensation(interviewId, {
        previousInterviewerOpenId: options.previousInterviewerOpenId,
      });
    } finally {
      if (options.deferredNotificationIds?.length) {
        scheduleFeishuAutoDispatchIds(options.deferredNotificationIds);
      }
    }
  });
}

export interface InterviewListItem extends Record<string, unknown> {
  id: string;
  application_id: string;
  round: number;
  title: string;
  mode: InterviewMode;
  scheduled_at: string;
  duration_minutes: number;
  status: InterviewRow['status'];
  interviewer_id: string | null;
  interviewer_name: string | null;
  candidate_id: string;
  candidate_name: string;
  job_id: string;
  job_title: string;
}

export function listInterviews(options: {
  from?: string;
  to?: string;
  status?: string;
  jobId?: string;
  applicationId?: string;
  limit?: number;
}): InterviewListItem[] {
  const conditions: string[] = ['i.is_draft = 0', "a.status = 'active'"];
  const params: unknown[] = [];
  if (options.from) {
    conditions.push('i.scheduled_at >= ?');
    params.push(options.from);
  }
  if (options.to) {
    conditions.push('i.scheduled_at <= ?');
    params.push(options.to);
  }
  if (options.status) {
    conditions.push('i.status = ?');
    params.push(options.status);
  }
  if (options.jobId) {
    conditions.push('a.job_id = ?');
    params.push(options.jobId);
  }
  if (options.applicationId) {
    conditions.push('i.application_id = ?');
    params.push(options.applicationId);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  params.push(options.limit ?? 200);

  return all<InterviewListItem>(
    `SELECT i.id, i.application_id, i.round, i.title, i.mode, i.scheduled_at, i.duration_minutes,
            i.status, i.summary_status, i.location, i.meeting_url, i.interviewer_id, u.name AS interviewer_name,
            i.external_calendar_event_id, i.calendar_sync_status, i.calendar_sync_error, i.calendar_synced_at,
            c.id AS candidate_id, c.name AS candidate_name,
            j.id AS job_id, j.title AS job_title
     FROM interviews i
     JOIN applications a ON a.id = i.application_id
     JOIN candidates c ON c.id = a.candidate_id
     JOIN jobs j ON j.id = a.job_id
     LEFT JOIN users u ON u.id = i.interviewer_id
     ${where}
     ORDER BY i.scheduled_at ASC
     LIMIT ?`,
    params,
  );
}

export function createInterview(input: {
  applicationId: string;
  scheduledAt: string;
  actorId: string;
  title?: string;
  mode?: InterviewMode;
  durationMinutes?: number;
  location?: string | null;
  meetingUrl?: string | null;
  interviewerId?: string | null;
  round?: number;
}): InterviewRow {
  const application = getApplication(input.applicationId);
  if (application.status !== 'active' || application.stage !== 'interview') {
    throw badRequest('请先确认筛选通过，再安排面试');
  }

  const scheduledAt = new Date(input.scheduledAt);
  if (Number.isNaN(scheduledAt.getTime())) throw badRequest('面试时间格式不正确');

  if (input.interviewerId) {
    const interviewer = getRow('SELECT id FROM users WHERE id = ?', [input.interviewerId]);
    if (!interviewer) throw badRequest('面试官不存在');
  }

  const prior = all<Pick<InterviewRow, 'round' | 'status' | 'decision' | 'is_draft'>>(
    'SELECT round, status, decision, is_draft FROM interviews WHERE application_id = ?', [application.id]);
  const round = prior.some((row) => row.round === 1 && row.status === 'completed' && row.decision === 'advance') ? 2 : 1;
  if (input.round !== undefined && input.round !== round) throw badRequest('不能跳过面试轮次');
  if (prior.some((row) => row.round === round &&
    (row.status === 'scheduled' || (row.status === 'completed' && row.decision !== null && row.decision !== 'reject')))) {
    throw badRequest('该轮面试已存在，请在原面试记录中安排或查看');
  }
  const interviewId = id('itv');
  const timestamp = now();
  const context = applicationContext(input.applicationId);
  const shouldSyncCalendar = isFeishuCalendarConfigured();
  const normalizedMeetingUrl = input.meetingUrl?.trim() || null;
  const normalizedLocation = input.location?.trim() || null;

  transaction(() => {
    run(
      `INSERT INTO interviews
         (id, application_id, round, title, mode, scheduled_at, duration_minutes, location, meeting_url,
          interviewer_id, status, calendar_sync_status, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?, ?, ?)`,
      [
        interviewId,
        input.applicationId,
        round,
        input.title?.trim() || `第 ${round} 轮面试`,
        input.mode ?? 'video',
        scheduledAt.toISOString(),
        input.durationMinutes ?? 45,
        normalizedLocation,
        normalizedMeetingUrl,
        input.interviewerId ?? null,
        shouldSyncCalendar ? 'pending' : 'none',
        input.actorId,
        timestamp,
        timestamp,
      ],
    );

    audit({
      actorId: input.actorId,
      action: 'interview.create',
      entityType: 'interview',
      entityId: interviewId,
      detail: { applicationId: input.applicationId, scheduledAt: scheduledAt.toISOString() },
    });
    const feishuIds = notifyInterviewScheduled({
      interviewId,
      applicationId: input.applicationId,
      candidateName: context.candidateName,
      jobTitle: context.jobTitle,
      scheduledAt: scheduledAt.toISOString(),
      interviewerId: input.interviewerId ?? null,
      actorId: input.actorId,
      autoDispatch: !shouldSyncCalendar,
    });
    if (shouldSyncCalendar) {
      afterCommit(() =>
        scheduleInterviewCalendarSync(interviewId, {
          deferredNotificationIds: feishuIds,
        }),
      );
    }
  });
  return getRow<InterviewRow>(`SELECT ${INTERVIEW_FIELDS} FROM interviews i WHERE i.id = ?`, [interviewId])!;
}

export function updateInterview(input: {
  interviewId: string;
  actorId: string;
  scheduledAt?: string;
  durationMinutes?: number;
  mode?: InterviewMode;
  location?: string | null;
  meetingUrl?: string | null;
  interviewerId?: string | null;
  title?: string;
}): InterviewRow {
  const interview = getRow<InterviewRow>(`SELECT ${INTERVIEW_FIELDS} FROM interviews i WHERE i.id = ?`, [input.interviewId]);
  if (!interview) throw notFound('面试不存在');
  const application = getApplication(interview.application_id);
  if (application.stage !== 'interview' || application.status !== 'active') throw badRequest('当前投递不能修改面试');
  if (interview.is_draft && !input.scheduledAt) throw badRequest('请填写复试时间');
  if (interview.status !== 'scheduled') throw badRequest('只有待进行的面试可以修改');
  if (input.interviewerId) {
    const interviewer = getRow('SELECT id FROM users WHERE id = ?', [input.interviewerId]);
    if (!interviewer) throw badRequest('面试官不存在');
  }

  const timestamp = now();
  const nextSchedule = input.scheduledAt ? new Date(input.scheduledAt) : new Date(interview.scheduled_at);
  if (Number.isNaN(nextSchedule.getTime())) throw badRequest('面试时间格式不正确');

  const nextInterviewerId = input.interviewerId === undefined ? interview.interviewer_id : input.interviewerId;
  const previousInterviewerOpenId =
    nextInterviewerId !== interview.interviewer_id ? lookupUserFeishuOpenId(interview.interviewer_id) : null;
  const nextMode = input.mode ?? interview.mode;
  const modeChanged = nextMode !== interview.mode;
  const droppedOnsite = modeChanged && interview.mode === 'onsite' && nextMode !== 'onsite';
  let nextLocation = input.location === undefined ? interview.location : (input.location?.trim() || null);
  let nextMeetingUrl = input.meetingUrl === undefined ? interview.meeting_url : (input.meetingUrl?.trim() || null);
  if (modeChanged) {
    // 切换面试形式时清掉另一种形式才有的字段，避免现场面试仍挂着失效的视频会议入口
    if (nextMode !== 'onsite') nextLocation = input.location?.trim() || null;
    if (nextMode !== 'video') {
      nextMeetingUrl = input.meetingUrl?.trim() || null;
    } else if (input.meetingUrl === undefined) {
      nextMeetingUrl = null;
    }
  }
  // 现场面试把地点清空（形式不变）时，远端旧会议室同样只能靠「删旧建新」清除
  const clearedOnsiteLocation =
    !modeChanged &&
    interview.mode === 'onsite' &&
    input.location !== undefined &&
    !nextLocation &&
    Boolean(interview.location?.trim());
  const needsEventRecreate = droppedOnsite || clearedOnsiteLocation;
  const wasDraft = Boolean(interview.is_draft);
  const hasCalendarChange =
    wasDraft ||
    input.scheduledAt !== undefined ||
    input.durationMinutes !== undefined ||
    input.mode !== undefined ||
    input.location !== undefined ||
    input.meetingUrl !== undefined ||
    input.interviewerId !== undefined ||
    input.title !== undefined;
  const shouldSyncCalendar = isFeishuCalendarConfigured() && hasCalendarChange;
  // 重建标记只有在「下次 PATCH 一定会把具体地点写进远端日程」时才能清掉：
  // 否则清空地点后删除失败、用户又在现场形式下改时长/标题，标记被误清，重试只 PATCH，
  // 而飞书「不传 location 即不更新」，旧会议室就永远留在面试官的日程里了。
  const canClearRecreateFlag = shouldSyncCalendar && nextMode === 'onsite' && Boolean(nextLocation?.trim());

  transaction(() => {
    run(
      `UPDATE interviews SET
         scheduled_at = ?, duration_minutes = ?, mode = ?, location = ?, meeting_url = ?,
         interviewer_id = ?, title = ?, is_draft = 0,
         calendar_sync_status = CASE WHEN ? THEN 'pending' ELSE calendar_sync_status END,
         calendar_sync_error = CASE WHEN ? THEN NULL ELSE calendar_sync_error END,
         calendar_recreate_required = CASE
           WHEN ? THEN 1
           WHEN ? THEN 0
           ELSE calendar_recreate_required
         END,
         updated_at = ?
       WHERE id = ?`,
      [
        nextSchedule.toISOString(),
        input.durationMinutes ?? interview.duration_minutes,
        nextMode,
        nextLocation,
        nextMeetingUrl,
        nextInterviewerId,
        input.title?.trim() || interview.title,
        shouldSyncCalendar ? 1 : 0,
        shouldSyncCalendar ? 1 : 0,
        needsEventRecreate ? 1 : 0,
        canClearRecreateFlag ? 1 : 0,
        timestamp,
        input.interviewId,
      ],
    );

    audit({
      actorId: input.actorId,
      action: 'interview.update',
      entityType: 'interview',
      entityId: input.interviewId,
    });

    let deferredNotificationIds: string[] = [];
    const interviewerChanged = nextInterviewerId !== interview.interviewer_id;
    if (input.scheduledAt || interviewerChanged) {
      const context = applicationContext(interview.application_id);
      deferredNotificationIds = notifyInterviewScheduled({
        interviewId: input.interviewId,
        applicationId: interview.application_id,
        candidateName: context.candidateName,
        jobTitle: context.jobTitle,
        scheduledAt: nextSchedule.toISOString(),
        interviewerId: nextInterviewerId,
        actorId: input.actorId,
        rescheduled: Boolean(input.scheduledAt) && !wasDraft,
        autoDispatch: !shouldSyncCalendar,
      });
    }

    if (shouldSyncCalendar) {
      afterCommit(() =>
        scheduleInterviewCalendarSync(input.interviewId, {
          previousInterviewerOpenId,
          deferredNotificationIds,
        }),
      );
    }
  });

  return getRow<InterviewRow>(`SELECT ${INTERVIEW_FIELDS} FROM interviews i WHERE i.id = ?`, [input.interviewId])!;
}

export function decideInterview(input: {
  interviewId: string;
  actorId: string;
  decision: 'advance' | 'negotiate' | 'reject';
  reason?: string;
  allowWithoutSummary?: boolean;
}) {
  const interview = getRow<InterviewRow>(`SELECT ${INTERVIEW_FIELDS} FROM interviews i WHERE i.id = ?`, [input.interviewId]);
  if (!interview) throw notFound('面试不存在');
  const application = getApplication(interview.application_id);
  if (application.status !== 'active' || application.stage !== 'interview' || interview.is_draft || interview.status !== 'scheduled') {
    throw badRequest('当前面试不能确认去向');
  }
  if (![1, 2].includes(interview.round) || (interview.round === 2 && input.decision === 'advance')) {
    throw badRequest('请为当前面试选择有效去向');
  }
  if (input.decision !== 'reject') {
    if (!['ready', 'manual'].includes(interview.summary_status)) {
      throw badRequest(interview.summary_status === 'generating' ? '正在生成面试总结，请稍后确认' : '请先查看面试总结，或留一句结论');
    }
    if (interview.round === 2 && !['ready', 'manual'].includes(application.composite_status)) {
      if (application.composite_status === 'generating') throw badRequest('正在生成综合评估，请稍后确认');
      if (!input.allowWithoutSummary) throw badRequest('请先查看综合评估，或确认无评估继续');
    }
  }
  const timestamp = now();
  transaction(() => {
    run(`UPDATE interviews SET status = 'completed', decision = ?, completed_at = ?, updated_at = ? WHERE id = ?`,
      [input.decision, timestamp, timestamp, interview.id]);
    if (input.decision === 'advance') {
      run(`INSERT INTO interviews (id, application_id, round, title, scheduled_at, is_draft, created_by, created_at, updated_at)
           VALUES (?, ?, 2, '复试', ?, 1, ?, ?, ?)`, [id('itv'), application.id, timestamp, input.actorId, timestamp, timestamp]);
      run(`INSERT INTO application_events (id, application_id, from_stage, to_stage, type, note, actor_id, created_at)
           VALUES (?, ?, 'interview', 'interview', 'note', '一面通过，生成复试草稿', ?, ?)`,
        [id('evt'), application.id, input.actorId, timestamp]);
    } else if (input.decision === 'negotiate') {
      startNegotiation(application.id, input.actorId);
      recordStage(application, 'offer', input.actorId, interview.round === 2 ? '复试确认，进入谈薪' : '一面确认，直接进入谈薪');
    } else {
      recordArchive(application, input.actorId, workflowArchiveReason(input.reason));
    }
    audit({ actorId: input.actorId, action: 'interview.decide', entityType: 'interview', entityId: interview.id,
      detail: { decision: input.decision, round: interview.round, allowWithoutSummary: input.allowWithoutSummary === true } });
  });
  return { interview: getRow<InterviewRow>(`SELECT ${INTERVIEW_FIELDS} FROM interviews i WHERE i.id = ?`, [interview.id]),
    application: getApplication(application.id), offer: input.decision === 'negotiate' ? offerDetail(application.id).offer : null };
}

export function cancelInterview(input: {
  interviewId: string;
  actorId: string;
  note?: string;
}): InterviewRow {
  const interview = getRow<InterviewRow>(`SELECT ${INTERVIEW_FIELDS} FROM interviews i WHERE i.id = ?`, [input.interviewId]);
  if (!interview) throw notFound('面试不存在');
  const application = getApplication(interview.application_id);
  if (application.status !== 'active' || application.stage !== 'interview') throw badRequest('当前投递不能修改面试');
  if (interview.status !== 'scheduled') throw badRequest('只有待进行的面试可以取消');

  const timestamp = now();
  const shouldSyncCalendar =
    !interview.is_draft && isFeishuCalendarConfigured() && Boolean(interview.external_calendar_event_id);

  transaction(() => {
    run(
      `UPDATE interviews
          SET status = 'cancelled',
              calendar_sync_status = CASE
                WHEN ? THEN 'pending'
                WHEN calendar_sync_status IN ('pending', 'failed') THEN 'none'
                ELSE calendar_sync_status
              END,
              calendar_sync_error = CASE WHEN ? OR calendar_sync_status IN ('pending', 'failed') THEN NULL ELSE calendar_sync_error END,
              updated_at = ?
        WHERE id = ?`,
      [shouldSyncCalendar ? 1 : 0, shouldSyncCalendar ? 1 : 0, timestamp, input.interviewId],
    );
    audit({
      actorId: input.actorId,
      action: 'interview.cancel',
      entityType: 'interview',
      entityId: input.interviewId,
      detail: { note: input.note?.trim() || '面试已取消' },
    });
    if (!interview.is_draft) {
      const context = applicationContext(interview.application_id);
      notifyInterviewCancelled({
        interviewId: input.interviewId,
        applicationId: interview.application_id,
        candidateName: context.candidateName,
        jobTitle: context.jobTitle,
        scheduledAt: interview.scheduled_at,
        interviewerId: interview.interviewer_id,
        actorId: input.actorId,
        note: input.note?.trim() || null,
      });
    }
    if (shouldSyncCalendar) {
      afterCommit(() => scheduleInterviewCalendarSync(input.interviewId));
    }
  });
  return getRow<InterviewRow>(`SELECT ${INTERVIEW_FIELDS} FROM interviews i WHERE i.id = ?`, [input.interviewId])!;
}

/** 手动触发单场面试的飞书日历同步（用于重试失败同步或首次补同步）。 */
export async function syncInterviewCalendarNow(interviewId: string, actorId: string) {
  const interview = getRow<InterviewRow>(`SELECT ${INTERVIEW_FIELDS} FROM interviews i WHERE i.id = ?`, [interviewId]);
  if (!interview) throw notFound('面试不存在');
  if (interview.is_draft) throw badRequest('请先为该轮面试安排时间，再同步飞书日历');
  if (!isFeishuCalendarConfigured()) {
    throw badRequest('请先在设置页配置飞书自建应用凭证与共享日历 ID');
  }

  const outcome = await enqueueInterviewSyncChain(interviewId, () => runInterviewSyncWithCompensation(interviewId));
  audit({
    actorId,
    action: 'interview.calendar_sync',
    entityType: 'interview',
    entityId: interviewId,
    detail: { ok: outcome.ok, skipped: Boolean(outcome.skipped), error: outcome.error ?? null },
  });
  return {
    interview: interviewWithContext(interviewId),
    sync: {
      ok: outcome.ok,
      skipped: Boolean(outcome.skipped),
      error: outcome.error ?? null,
      meetingUrl: outcome.meetingUrl ?? null,
    },
  };
}

export function markNoShow(interviewId: string, actorId: string): InterviewRow {
  const interview = getRow<InterviewRow>(`SELECT ${INTERVIEW_FIELDS} FROM interviews i WHERE i.id = ?`, [interviewId]);
  if (!interview) throw notFound('面试不存在');
  const application = getApplication(interview.application_id);
  if (application.status !== 'active' || application.stage !== 'interview') throw badRequest('当前投递不能修改面试');
  if (interview.status !== 'scheduled' || interview.is_draft) throw badRequest('只有已安排的面试可以标记爽约');
  run(`UPDATE interviews SET status = 'no_show', updated_at = ? WHERE id = ?`, [now(), interviewId]);
  audit({ actorId, action: 'interview.no_show', entityType: 'interview', entityId: interviewId });
  return getRow<InterviewRow>(`SELECT ${INTERVIEW_FIELDS} FROM interviews i WHERE i.id = ?`, [interviewId])!;
}

export function interviewWithContext(interviewId: string) {
  const row = getRow<Record<string, unknown>>(
    `SELECT ${INTERVIEW_FIELDS}, u.name AS interviewer_name,
            c.id AS candidate_id, c.name AS candidate_name,
            j.id AS job_id, j.title AS job_title
     FROM interviews i
     JOIN applications a ON a.id = i.application_id
     JOIN candidates c ON c.id = a.candidate_id
     JOIN jobs j ON j.id = a.job_id
     LEFT JOIN users u ON u.id = i.interviewer_id
     WHERE i.id = ?`,
    [interviewId],
  );
  if (!row) throw notFound('面试不存在');
  return row;
}
