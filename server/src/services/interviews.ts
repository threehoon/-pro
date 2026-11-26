import { all, getRow, run, transaction } from '../db/index.ts';
import { id, now } from '../lib/util.ts';
import { badRequest, notFound } from '../lib/errors.ts';
import type { InterviewMode } from '../constants.ts';
import { audit } from './audit.ts';
import { notifyInterviewScheduled } from './notifications.ts';
import { applicationContext, getApplication, recordArchive, recordStage, workflowArchiveReason } from './applications.ts';
import { offerDetail, startNegotiation } from './offers.ts';

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
  created_by: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export const INTERVIEW_FIELDS = `i.id, i.application_id, i.round, i.title, i.mode, i.scheduled_at,
  i.duration_minutes, i.location, i.meeting_url, i.interviewer_id, i.status, i.summary_status,
  i.is_draft, i.decision, i.external_calendar_event_id, i.created_by, i.created_at, i.updated_at, i.completed_at`;

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

  run(
      `INSERT INTO interviews
         (id, application_id, round, title, mode, scheduled_at, duration_minutes, location, meeting_url,
          interviewer_id, status, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?, ?)`,
      [
        interviewId,
        input.applicationId,
        round,
        input.title?.trim() || `第 ${round} 轮面试`,
        input.mode ?? 'video',
        scheduledAt.toISOString(),
        input.durationMinutes ?? 45,
        input.location ?? null,
        input.meetingUrl ?? null,
        input.interviewerId ?? null,
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
  notifyInterviewScheduled({
    interviewId,
    applicationId: input.applicationId,
    candidateName: context.candidateName,
    jobTitle: context.jobTitle,
    scheduledAt: scheduledAt.toISOString(),
    interviewerId: input.interviewerId ?? null,
    actorId: input.actorId,
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

  run(
    `UPDATE interviews SET
       scheduled_at = ?, duration_minutes = ?, mode = ?, location = ?, meeting_url = ?,
       interviewer_id = ?, title = ?, is_draft = 0, updated_at = ?
     WHERE id = ?`,
    [
      nextSchedule.toISOString(),
      input.durationMinutes ?? interview.duration_minutes,
      input.mode ?? interview.mode,
      input.location === undefined ? interview.location : input.location,
      input.meetingUrl === undefined ? interview.meeting_url : input.meetingUrl,
      input.interviewerId === undefined ? interview.interviewer_id : input.interviewerId,
      input.title?.trim() || interview.title,
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

  if (input.scheduledAt) {
    const context = applicationContext(interview.application_id);
    notifyInterviewScheduled({
      interviewId: input.interviewId,
      applicationId: interview.application_id,
      candidateName: context.candidateName,
      jobTitle: context.jobTitle,
      scheduledAt: nextSchedule.toISOString(),
      interviewerId: input.interviewerId ?? interview.interviewer_id,
      actorId: input.actorId,
      rescheduled: true,
    });
  }

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

  run(`UPDATE interviews SET status = 'cancelled', updated_at = ? WHERE id = ?`, [now(), input.interviewId]);
  audit({
    actorId: input.actorId,
    action: 'interview.cancel',
    entityType: 'interview',
    entityId: input.interviewId,
    detail: { note: input.note?.trim() || '面试已取消' },
  });
  return getRow<InterviewRow>(`SELECT ${INTERVIEW_FIELDS} FROM interviews i WHERE i.id = ?`, [input.interviewId])!;
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
