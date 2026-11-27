import { RECOMMENDATION_LABELS, STAGE_LABELS, STAGES, type Stage } from '../constants.ts';
import { getRow } from '../db/index.ts';
import { jsonParse, now } from '../lib/util.ts';

/**
 * 多维表格列名与系统字段的映射。
 * 约定：业务字段写死在代码里，管理员在飞书侧把列名改成一致的名字即可，不需要在系统里配映射。
 */
export const INTERVIEW_COLUMNS = {
  externalId: '外部 ID',
  candidate: '候选人',
  job: '职位',
  round: '轮次',
  interviewer: '面试官',
  scheduledAt: '面试时间',
  status: '面试状态',
  headline: '本轮总结',
  highlights: '亮点',
  concerns: '疑点',
  unanswered: '未答问题',
  recommendation: '结论',
  score: '评分（1-5）',
  feedback: '补充反馈',
  decision: '本轮决定',
  advance: '是否推荐进复试',
  syncedAt: '最后同步',
} as const;

export const APPLICATION_COLUMNS = {
  externalId: '外部 ID',
  candidate: '候选人',
  job: '职位',
  owner: '负责人',
  source: '来源',
  appliedAt: '投递时间',
  stage: '阶段',
  rejected: '是否淘汰',
  rejectionReason: '淘汰原因',
  composite: '综合结论',
  nextStep: '下一步',
  nextFollowUp: '下次跟进',
  note: '备注',
  syncedAt: '最后同步',
} as const;

export const INTERVIEW_STATUS_LABELS: Record<string, string> = {
  scheduled: '待进行',
  completed: '已完成',
  cancelled: '已取消',
  no_show: '未到场',
};

export const DECISION_LABELS: Record<string, string> = {
  advance: '进下一轮',
  negotiate: '谈薪',
  reject: '淘汰',
};

export const ADVANCE_LABELS: Record<string, string> = {
  yes: '推荐',
  hold: '待定',
  no: '不推荐',
};

/** 双向回写的白名单：只有这些列可以在飞书里改，其余列只读（系统会推回去，避免有人改候选人姓名）。 */
/** 表格里允许人手改、且系统会回写的列。一律从列名常量取，改列名时只改一处。 */
export const INTERVIEW_WRITABLE = [
  INTERVIEW_COLUMNS.recommendation,
  INTERVIEW_COLUMNS.score,
  INTERVIEW_COLUMNS.feedback,
  INTERVIEW_COLUMNS.decision,
  INTERVIEW_COLUMNS.advance,
] as const;
export const APPLICATION_WRITABLE = [
  APPLICATION_COLUMNS.stage,
  APPLICATION_COLUMNS.nextStep,
  APPLICATION_COLUMNS.nextFollowUp,
  APPLICATION_COLUMNS.note,
] as const;

export type EntityType = 'interview' | 'application';

export interface BuiltRecord {
  entityType: EntityType;
  entityId: string;
  /** 直接交给多维表格接口的字段对象 */
  fields: Record<string, unknown>;
  /** 用于判断「是否与上次推送一致」的规范化文本 */
  fingerprint: string;
}

interface InterviewRow {
  id: string;
  application_id: string;
  round: number;
  scheduled_at: string | null;
  interviewer_id: string | null;
  status: string;
  score: number | null;
  feedback: string | null;
  recommendation: string | null;
  decision: string | null;
  advance_recommended: string | null;
  summary_status: string | null;
  summary_json: string | null;
  candidate_name: string;
  job_title: string;
  interviewer_name: string | null;
}

interface ApplicationRow {
  id: string;
  stage: string;
  status: string;
  source: string | null;
  applied_at: string;
  rejection_reason: string | null;
  composite_json: string | null;
  next_step: string | null;
  next_follow_up_at: string | null;
  bitable_note: string | null;
  candidate_name: string;
  job_title: string;
  owner_name: string | null;
}

export function buildInterviewRecord(interviewId: string): BuiltRecord | null {
  const row = getRow<InterviewRow>(
    `SELECT i.id, i.application_id, i.round, i.scheduled_at, i.interviewer_id, i.status, i.score, i.feedback,
            i.recommendation, i.decision, i.advance_recommended, i.summary_status, i.summary_json,
            c.name AS candidate_name, j.title AS job_title, u.name AS interviewer_name
     FROM interviews i
     JOIN applications a ON a.id = i.application_id
     JOIN candidates c ON c.id = a.candidate_id
     JOIN jobs j ON j.id = a.job_id
     LEFT JOIN users u ON u.id = i.interviewer_id
     WHERE i.id = ?`,
    [interviewId],
  );
  if (!row) return null;

  const summary = jsonParse<Record<string, unknown> | null>(row.summary_json, null);
  const headline = summary ? readString(summary.headline) : '';
  const highlights = summary ? readPoints(summary.highlights) : [];
  const concerns = summary ? readPoints(summary.concerns) : [];
  const unanswered = summary ? readTextList(summary.unanswered) : [];

  const fields: Record<string, unknown> = {
    [INTERVIEW_COLUMNS.externalId]: row.id,
    [INTERVIEW_COLUMNS.candidate]: row.candidate_name,
    [INTERVIEW_COLUMNS.job]: row.job_title,
    [INTERVIEW_COLUMNS.round]: `第 ${row.round} 轮`,
    [INTERVIEW_COLUMNS.interviewer]: row.interviewer_name ?? '',
    [INTERVIEW_COLUMNS.status]: INTERVIEW_STATUS_LABELS[row.status] ?? row.status,
  };
  putDate(fields, INTERVIEW_COLUMNS.scheduledAt, row.scheduled_at);
  putText(fields, INTERVIEW_COLUMNS.headline, headline);
  putText(fields, INTERVIEW_COLUMNS.highlights, highlights.join('；'));
  putText(fields, INTERVIEW_COLUMNS.concerns, concerns.join('；'));
  putText(fields, INTERVIEW_COLUMNS.unanswered, unanswered.join('；'));
  if (row.recommendation) putText(fields, INTERVIEW_COLUMNS.recommendation, RECOMMENDATION_LABELS[row.recommendation] ?? row.recommendation);
  if (typeof row.score === 'number') fields[INTERVIEW_COLUMNS.score] = row.score;
  putText(fields, INTERVIEW_COLUMNS.feedback, row.feedback ?? '');
  if (row.decision) putText(fields, INTERVIEW_COLUMNS.decision, DECISION_LABELS[row.decision] ?? row.decision);
  if (row.advance_recommended) putText(fields, INTERVIEW_COLUMNS.advance, ADVANCE_LABELS[row.advance_recommended] ?? row.advance_recommended);
  fields[INTERVIEW_COLUMNS.syncedAt] = Date.parse(now());

  return { entityType: 'interview', entityId: row.id, fields, fingerprint: fingerprintOf(fields) };
}

export function buildApplicationRecord(applicationId: string): BuiltRecord | null {
  const row = getRow<ApplicationRow>(
    `SELECT a.id, a.stage, a.status, a.source, a.applied_at, a.rejection_reason, a.composite_json,
            a.next_step, a.next_follow_up_at, a.bitable_note,
            c.name AS candidate_name, j.title AS job_title, u.name AS owner_name
     FROM applications a
     JOIN candidates c ON c.id = a.candidate_id
     JOIN jobs j ON j.id = a.job_id
     LEFT JOIN users u ON u.id = a.owner_id
     WHERE a.id = ?`,
    [applicationId],
  );
  if (!row) return null;

  const composite = jsonParse<Record<string, unknown> | null>(row.composite_json, null);
  const fields: Record<string, unknown> = {
    [APPLICATION_COLUMNS.externalId]: row.id,
    [APPLICATION_COLUMNS.candidate]: row.candidate_name,
    [APPLICATION_COLUMNS.job]: row.job_title,
    [APPLICATION_COLUMNS.owner]: row.owner_name ?? '',
    [APPLICATION_COLUMNS.stage]: STAGE_LABELS[row.stage as Stage] ?? row.stage,
    [APPLICATION_COLUMNS.rejected]: row.status === 'rejected' ? '是' : '否',
  };
  putText(fields, APPLICATION_COLUMNS.source, row.source ?? '');
  putDate(fields, APPLICATION_COLUMNS.appliedAt, row.applied_at);
  putText(fields, APPLICATION_COLUMNS.rejectionReason, row.rejection_reason ?? '');
  if (composite) putText(fields, APPLICATION_COLUMNS.composite, readString(composite.headline));
  putText(fields, APPLICATION_COLUMNS.nextStep, row.next_step ?? '');
  putDate(fields, APPLICATION_COLUMNS.nextFollowUp, row.next_follow_up_at);
  putText(fields, APPLICATION_COLUMNS.note, row.bitable_note ?? '');
  fields[APPLICATION_COLUMNS.syncedAt] = Date.parse(now());

  return { entityType: 'application', entityId: row.id, fields, fingerprint: fingerprintOf(fields) };
}

function fingerprintOf(fields: Record<string, unknown>): string {
  const keys = Object.keys(fields)
    .filter((key) => key !== INTERVIEW_COLUMNS.syncedAt && key !== APPLICATION_COLUMNS.syncedAt)
    .sort();
  return keys.map((key) => `${key}=${String(fields[key] ?? '')}`).join('|');
}

function putText(fields: Record<string, unknown>, key: string, value: string): void {
  if (value.trim()) fields[key] = value;
}

function putDate(fields: Record<string, unknown>, key: string, value: string | null): void {
  if (!value) return;
  const parsed = Date.parse(value);
  if (Number.isFinite(parsed)) fields[key] = parsed;
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function readPoints(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (typeof item === 'string') return item;
      if (item && typeof item === 'object') {
        const point = (item as Record<string, unknown>).point;
        return typeof point === 'string' ? point : '';
      }
      return '';
    })
    .filter(Boolean);
}

function readTextList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => (typeof item === 'string' ? item : '')).filter(Boolean);
}

/* ------------------------------ 入站：读飞书单元格 ------------------------------ */

/** 飞书单元格可能返回字符串、数字、数组片段（富文本/多选）或对象，统一读成字符串。 */
export function readCellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) {
    return value
      .map((item) => readCellText(item))
      .filter(Boolean)
      .join('，');
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return readCellText(record.text ?? record.name ?? record.value ?? '');
  }
  return '';
}

export function readCellNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const text = readCellText(value);
  if (!text) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

/** 日期列：飞书返回毫秒时间戳；手填文本也接受，读不出来就当没改。 */
export function readCellDate(value: unknown): string | null {
  const numeric = readCellNumber(value);
  if (numeric !== null) {
    const date = new Date(numeric);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  const text = readCellText(value);
  if (!text) return null;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

export function matchLabel(labels: Record<string, string>, value: string): string | null {
  const text = value.trim();
  if (!text) return null;
  for (const [key, label] of Object.entries(labels)) {
    if (label === text) return key;
  }
  for (const key of Object.keys(labels)) {
    if (key === text) return key;
  }
  return null;
}

export function matchStage(value: string): Stage | null {
  const text = value.trim();
  if (!text) return null;
  if ((STAGES as readonly string[]).includes(text)) return text as Stage;
  for (const stage of STAGES) {
    if (STAGE_LABELS[stage] === text) return stage;
  }
  return null;
}

export const STAGE_ORDER: Record<string, number> = Object.fromEntries(STAGES.map((stage, index) => [stage, index]));
