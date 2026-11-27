import { INTERVIEW_FIELDS } from './interviews.ts';
import { all, getRow, run, transaction } from '../db/index.ts';
import { id, now, jsonParse } from '../lib/util.ts';
import { badRequest, conflict, notFound } from '../lib/errors.ts';
import type { Stage } from '../constants.ts';
import { REJECTION_REASONS, STAGES, STAGE_LABELS } from '../constants.ts';
import { audit } from './audit.ts';
import { hookBitableSync } from './bitable-sync.ts';
import { getApprovedProfileVersion, screeningActivity } from './recruitment-ai.ts';
import { notifyStageChange } from './notifications.ts';

export interface ApplicationRow {
  id: string;
  job_id: string;
  candidate_id: string;
  stage: Stage;
  status: 'active' | 'rejected';
  owner_id: string | null;
  source: string | null;
  rejection_reason: string | null;
  rejected_at: string | null;
  applied_at: string;
  hired_at: string | null;
  composite_status: string;
  updated_at: string;
}

export const APPLICATION_FIELDS = `a.id, a.job_id, a.candidate_id, a.stage, a.status, a.owner_id,
  a.source, a.rejection_reason, a.rejected_at, a.applied_at, a.hired_at, a.composite_status, a.updated_at`;

type ApplicationInput = {
  jobId: string;
  actorId: string;
  source?: string;
  ownerId?: string | null;
} & ({ candidateId: string } | { prepareCandidate: () => string });

export function createApplication(input: ApplicationInput): ApplicationRow {
  const job = getRow<{ id: string; title: string; status: string; owner_id: string | null }>(
    'SELECT id, title, status, owner_id FROM jobs WHERE id = ?',
    [input.jobId],
  );
  if (!job) throw notFound('职位不存在');
  if (job.status === 'closed') throw badRequest('该职位已关闭，无法新增投递');

  const applicationId = id('app');
  const timestamp = now();
  const recipientId = input.ownerId ?? job.owner_id;
  const created = transaction(() => {
    const candidateId = 'candidateId' in input ? input.candidateId : input.prepareCandidate();
    const candidate = getRow<{ name: string }>('SELECT name FROM candidates WHERE id = ?', [candidateId]);
    if (!candidate) throw notFound('候选人不存在');
    const existing = getRow<{ id: string }>(
      'SELECT id FROM applications WHERE job_id = ? AND candidate_id = ?', [input.jobId, candidateId],
    );
    if (existing) throw conflict('该候选人已投递此职位', { applicationId: existing.id });

    run(
      `INSERT INTO applications
         (id, job_id, candidate_id, stage, status, owner_id, source, applied_at, updated_at)
       VALUES (?, ?, ?, 'screening', 'active', ?, ?, ?, ?)`,
      [applicationId, input.jobId, candidateId, recipientId, input.source ?? '手动添加', timestamp, timestamp],
    );
    run(
      `INSERT INTO application_events (id, application_id, from_stage, to_stage, type, actor_id, created_at)
       VALUES (?, ?, NULL, 'screening', 'created', ?, ?)`,
      [id('evt'), applicationId, input.actorId, timestamp],
    );
    audit({ actorId: input.actorId, action: 'application.create', entityType: 'application', entityId: applicationId,
      detail: { jobId: input.jobId, candidateId } });
    notifyStageChange({
      applicationId,
      candidateName: candidate.name,
      jobTitle: job.title,
      fromStage: null,
      toStage: 'screening',
      actorId: input.actorId,
      recipientId,
    });
    return getApplication(applicationId);
  });
  hookBitableSync('application', created.id);
  return created;
}

export function getApplication(applicationId: string): ApplicationRow {
  const application = getRow<ApplicationRow>(`SELECT ${APPLICATION_FIELDS} FROM applications a WHERE a.id = ?`, [applicationId]);
  if (!application) throw notFound('投递记录不存在');
  return application;
}

// These write helpers share the caller's transaction with the related review, interview or Offer.
export function recordStage(application: ApplicationRow, stage: Stage, actorId: string, note: string): void {
  const timestamp = now();
  run(`UPDATE applications SET stage = ?, updated_at = ?, hired_at = CASE WHEN ? = 'hired' THEN ? ELSE hired_at END WHERE id = ?`,
    [stage, timestamp, stage, timestamp, application.id]);
  run(`INSERT INTO application_events (id, application_id, from_stage, to_stage, type, note, actor_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id('evt'), application.id, application.stage, stage, stage === 'hired' ? 'hired' : 'stage_change', note, actorId, timestamp]);
  audit({ actorId, action: 'application.move', entityType: 'application', entityId: application.id, detail: { from: application.stage, to: stage } });
  const context = applicationContext(application.id);
  notifyStageChange({ applicationId: application.id, candidateName: context.candidateName, jobTitle: context.jobTitle,
    fromStage: application.stage, toStage: stage, actorId, recipientId: context.ownerId });
  hookBitableSync('application', application.id);
}

export function decideScreening(input: {
  applicationId: string;
  decision: 'advance' | 'reject';
  actorId: string;
  reason?: string;
}): ApplicationRow {
  const application = getApplication(input.applicationId);
  if (application.status !== 'active' || application.stage !== 'screening') {
    throw badRequest('只有待筛选的投递可确认筛选结果');
  }
  const reason = input.decision === 'reject' ? workflowArchiveReason(input.reason) : null;
  return transaction(() => {
    const latest = getRow<{ id: string }>(`SELECT id FROM screening_reviews WHERE application_id = ?
      ORDER BY created_at DESC, rowid DESC LIMIT 1`, [application.id]);
    const timestamp = now();
    if (latest) {
      run('UPDATE screening_reviews SET decision = ?, reason = ?, decided_by = ?, decided_at = ? WHERE id = ?',
        [input.decision, reason, input.actorId, timestamp, latest.id]);
    } else {
      run(`INSERT INTO screening_reviews (id, application_id, decision, reason, decided_by, decided_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`, [id('scr'), application.id, input.decision, reason, input.actorId, timestamp, timestamp]);
    }
    audit({ actorId: input.actorId, action: 'screening.decide', entityType: 'application', entityId: application.id,
      detail: { decision: input.decision, reason } });
    if (reason !== null) recordArchive(application, input.actorId, reason);
    else recordStage(application, 'interview', input.actorId, '确认筛选通过，准备约面');
    return getApplication(application.id);
  });
}

export function workflowArchiveReason(reason?: string): string {
  const text = reason?.trim() || '其他';
  if (!REJECTION_REASONS.some((value) => value === text)) throw badRequest('请选择有效的归档原因');
  return text;
}

export function recordArchive(application: ApplicationRow, actorId: string, reason: string, note?: string): void {
  if (application.stage === 'hired') throw badRequest('已入职的候选人不能归档');
  if (application.status === 'rejected') throw badRequest('该候选人已归档');
  if (!reason.trim()) throw badRequest('请选择或填写归档原因');
  const timestamp = now();
  run(`UPDATE applications SET status = 'rejected', rejection_reason = ?, rejected_at = ?, updated_at = ? WHERE id = ?`,
    [reason.trim(), timestamp, timestamp, application.id]);
  run(`INSERT INTO application_events (id, application_id, from_stage, to_stage, type, note, actor_id, created_at)
       VALUES (?, ?, ?, ?, 'rejected', ?, ?, ?)`,
    [id('evt'), application.id, application.stage, application.stage, note ?? reason.trim(), actorId, timestamp]);
  audit({ actorId, action: 'application.reject', entityType: 'application', entityId: application.id, detail: { stage: application.stage } });
  const context = applicationContext(application.id);
  notifyStageChange({ applicationId: application.id, candidateName: context.candidateName, jobTitle: context.jobTitle,
    fromStage: application.stage, toStage: null, actorId, recipientId: context.ownerId, rejected: true });
  hookBitableSync('application', application.id);
}

export function rejectApplication(input: {
  applicationId: string;
  reason: string;
  actorId: string;
  note?: string;
}): ApplicationRow {
  const application = getApplication(input.applicationId);
  transaction(() => recordArchive(application, input.actorId, input.reason, input.note));
  return getApplication(application.id);
}

export function reopenApplication(input: {
  applicationId: string;
  actorId: string;
  note?: string;
}): ApplicationRow {
  const application = getApplication(input.applicationId);
  if (application.status !== 'rejected') throw badRequest('该候选人不在拒绝状态');

  const timestamp = now();
  transaction(() => {
    run(`UPDATE offers SET status = 'negotiating', decline_reason = NULL, sent_at = NULL, decided_at = NULL, updated_at = ?
         WHERE application_id = ? AND status = 'declined'`, [timestamp, input.applicationId]);
    run(
      `UPDATE applications
       SET status = 'active', rejection_reason = NULL, rejected_at = NULL, updated_at = ?
       WHERE id = ?`,
      [timestamp, input.applicationId],
    );
    run(
      `INSERT INTO application_events (id, application_id, from_stage, to_stage, type, note, actor_id, created_at)
       VALUES (?, ?, ?, ?, 'reopened', ?, ?, ?)`,
      [id('evt'), input.applicationId, application.stage, application.stage, input.note ?? null, input.actorId, timestamp],
    );
  });
  audit({
    actorId: input.actorId,
    action: 'application.reopen',
    entityType: 'application',
    entityId: input.applicationId,
  });
  hookBitableSync('application', input.applicationId);
  return getApplication(input.applicationId);
}

export function addNote(input: { applicationId: string; note: string; actorId: string }): void {
  if (!input.note.trim()) throw badRequest('备注不能为空');
  const application = getApplication(input.applicationId);
  run(
    `INSERT INTO application_events (id, application_id, from_stage, to_stage, type, note, actor_id, created_at)
     VALUES (?, ?, ?, ?, 'note', ?, ?, ?)`,
    [id('evt'), input.applicationId, application.stage, application.stage, input.note.trim(), input.actorId, now()],
  );
  hookBitableSync('application', input.applicationId);
}

export function applicationContext(applicationId: string): {
  candidateName: string;
  jobTitle: string;
  ownerId: string | null;
} {
  const row = getRow<{ candidate_name: string; job_title: string; owner_id: string | null }>(
    `SELECT c.name AS candidate_name, j.title AS job_title, a.owner_id
     FROM applications a
     JOIN candidates c ON c.id = a.candidate_id
     JOIN jobs j ON j.id = a.job_id
     WHERE a.id = ?`,
    [applicationId],
  );
  if (!row) throw notFound('投递记录不存在');
  return { candidateName: row.candidate_name, jobTitle: row.job_title, ownerId: row.owner_id };
}

export interface BoardCard {
  id: string;
  stage: Stage;
  status: 'active' | 'rejected';
  applied_at: string;
  updated_at: string;
  source: string | null;
  owner_name: string | null;
  candidate_id: string;
  candidate_name: string;
  current_title: string | null;
  current_company: string | null;
  skills: string[];
  years_experience: number | null;
  tags: string[];
  next_interview_at: string | null;
  interviews_count: number;
  offer_status: string | null;
  screening_status: 'none' | 'generating' | 'ready' | 'failed' | 'stale';
  screening_top_reason: string | null;
  screening_has_summary: boolean;
  screening_missing_gates: string[];
  screening_score: number | null;
  screening_verdict: string | null;
  screening_unknown_weight: number | null;
  summary_status: string | null;
  interview_round: number | null;
  composite_status: string;
  hired_at: string | null;
  expected_salary: number | null;
  final_salary: number | null;
  start_date: string | null;
  reply_deadline: string | null;
}

export function board(jobId: string): {
  job: Record<string, unknown>;
  approvedProfile: ReturnType<typeof getApprovedProfileVersion>;
  columns: Array<{ stage: Stage; label: string; count: number; cards: BoardCard[] }>;
  rejected: BoardCard[];
  totals: { active: number; rejected: number; hired: number };
} {
  const job = getRow(
    `SELECT j.*, u.name AS owner_name,
            (SELECT COUNT(*) FROM applications a WHERE a.job_id = j.id AND a.status = 'active') AS active_count
     FROM jobs j LEFT JOIN users u ON u.id = j.owner_id WHERE j.id = ?`,
    [jobId],
  );
  if (!job) throw notFound('职位不存在');

  const approved = getApprovedProfileVersion(jobId);
  const rows = all<Record<string, unknown>>(
    `SELECT a.id, a.stage, a.status, a.applied_at, a.updated_at, a.source,
            u.name AS owner_name,
            c.id AS candidate_id, c.name AS candidate_name, c.current_title, c.current_company,
            c.skills, c.tags, c.years_experience,
            (SELECT MIN(i.scheduled_at) FROM interviews i
              WHERE i.application_id = a.id AND i.status = 'scheduled' AND i.is_draft = 0) AS next_interview_at,
            (SELECT COUNT(*) FROM interviews i WHERE i.application_id = a.id) AS interviews_count,
             o.status AS offer_status, o.expected_salary, o.final_salary, o.start_date, o.reply_deadline,
             s.score AS screening_score, s.verdict AS screening_verdict, s.unknown_weight AS screening_unknown_weight,
             s.missing_gates AS screening_missing_gates,
             CASE WHEN json_valid(s.detail_json) THEN json_extract(s.detail_json, '$.top_reason') END AS screening_top_reason,
             CASE WHEN json_valid(s.detail_json) THEN json_array_length(s.detail_json, '$.resume_excerpts') END AS screening_summary_count,
             s.id AS screening_review_id, s.profile_id AS screening_profile_id,
             (SELECT status FROM ai_runs WHERE kind = 'screening' AND subject_id = a.id AND error IS NOT 'superseded'
               ORDER BY created_at DESC, rowid DESC LIMIT 1) AS screening_run_status,
             last.summary_status, last.round AS interview_round, a.composite_status, a.hired_at
     FROM applications a
     LEFT JOIN offers o ON o.application_id = a.id
     LEFT JOIN screening_reviews s ON s.id = (SELECT id FROM screening_reviews WHERE application_id = a.id
       ORDER BY created_at DESC, rowid DESC LIMIT 1)
     LEFT JOIN interviews last ON last.id = (SELECT id FROM interviews WHERE application_id = a.id
       AND status IN ('scheduled','completed') ORDER BY round DESC, created_at DESC, rowid DESC LIMIT 1)
     JOIN candidates c ON c.id = a.candidate_id
     LEFT JOIN users u ON u.id = a.owner_id
     WHERE a.job_id = ?
     ORDER BY a.updated_at DESC`,
    [jobId],
  );

  const cards: BoardCard[] = rows.map((row) => {
    const activity = screeningActivity(String(row.id), row.screening_run_status as string | null);
    const reviewStatus = !row.screening_review_id ? 'none' : row.screening_profile_id === (approved?.id ?? null) ? 'ready' : 'stale';
    const screeningStatus = activity ?? reviewStatus;
    const currentScreening = screeningStatus === 'ready';
    return {
      id: String(row.id),
      stage: row.stage as Stage,
      status: row.status as 'active' | 'rejected',
      applied_at: String(row.applied_at),
      updated_at: String(row.updated_at),
      source: (row.source as string | null) ?? null,
      owner_name: (row.owner_name as string | null) ?? null,
      candidate_id: String(row.candidate_id),
      candidate_name: String(row.candidate_name),
      current_title: (row.current_title as string | null) ?? null,
      current_company: (row.current_company as string | null) ?? null,
      skills: jsonParse<string[]>(row.skills, []),
      tags: jsonParse<string[]>(row.tags, []),
      years_experience: (row.years_experience as number | null) ?? null,
      next_interview_at: (row.next_interview_at as string | null) ?? null,
      interviews_count: Number(row.interviews_count ?? 0),
      offer_status: (row.offer_status as string | null) ?? null,
      screening_status: screeningStatus,
      screening_has_summary: currentScreening && Number(row.screening_summary_count) > 0,
      screening_top_reason: currentScreening && typeof row.screening_top_reason === 'string' ? row.screening_top_reason : null,
      screening_missing_gates: currentScreening ? jsonParse<string[]>(row.screening_missing_gates, []) : [],
      screening_score: currentScreening ? (row.screening_score as number | null) : null,
      screening_verdict: currentScreening ? (row.screening_verdict as string | null) : null,
      screening_unknown_weight: currentScreening ? (row.screening_unknown_weight as number | null) : null,
      summary_status: (row.summary_status as string | null) ?? null,
      interview_round: (row.interview_round as number | null) ?? null,
      composite_status: String(row.composite_status),
      hired_at: (row.hired_at as string | null) ?? null,
      expected_salary: (row.expected_salary as number | null) ?? null,
      final_salary: (row.final_salary as number | null) ?? null,
      start_date: (row.start_date as string | null) ?? null,
      reply_deadline: (row.reply_deadline as string | null) ?? null,
    };
  });

  const active = cards.filter((card) => card.status === 'active');
  const columns = STAGES.map((stage) => {
    const stageCards = active.filter((card) => card.stage === stage);
    return { stage, label: STAGE_LABELS[stage], count: stageCards.length, cards: stageCards };
  });

  return {
    job,
    approvedProfile: approved,
    columns,
    rejected: cards.filter((card) => card.status === 'rejected'),
    totals: {
      active: active.length,
      rejected: cards.filter((card) => card.status === 'rejected').length,
      hired: active.filter((card) => card.stage === 'hired').length,
    },
  };
}

export function applicationDetail(applicationId: string) {
  const application = getRow<Record<string, unknown>>(
    `SELECT ${APPLICATION_FIELDS}, j.title AS job_title, j.department, j.status AS job_status,
            c.name AS candidate_name, c.email AS candidate_email, u.name AS owner_name,
            o.status AS offer_status, o.expected_salary, o.final_salary, o.start_date, o.reply_deadline
     FROM applications a
     JOIN jobs j ON j.id = a.job_id
     JOIN candidates c ON c.id = a.candidate_id
     LEFT JOIN users u ON u.id = a.owner_id
     LEFT JOIN offers o ON o.application_id = a.id
     WHERE a.id = ?`,
    [applicationId],
  );
  if (!application) throw notFound('投递记录不存在');

  const events = all(
    `SELECT e.*, u.name AS actor_name FROM application_events e
     LEFT JOIN users u ON u.id = e.actor_id
     WHERE e.application_id = ? ORDER BY e.created_at DESC`,
    [applicationId],
  );
  const interviews = all(
    `SELECT ${INTERVIEW_FIELDS}, u.name AS interviewer_name FROM interviews i
     LEFT JOIN users u ON u.id = i.interviewer_id
     WHERE i.application_id = ? ORDER BY i.scheduled_at DESC`,
    [applicationId],
  );
  return { application, events, interviews };
}

