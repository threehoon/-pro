import { APPLICATION_FIELDS } from './applications.ts';
import { INTERVIEW_FIELDS } from './interviews.ts';
import { all, getRow, run } from '../db/index.ts';
import { id, now, jsonParse, toJson } from '../lib/util.ts';
import { badRequest, conflict, notFound } from '../lib/errors.ts';
import { audit } from './audit.ts';

export interface CandidateRow {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  location: string | null;
  current_company: string | null;
  current_title: string | null;
  years_experience: number | null;
  education: string | null;
  school: string | null;
  major: string | null;
  skills: string;
  tags: string;
  source: string | null;
  linkedin: string | null;
  portfolio: string | null;
  summary: string | null;
  resume_file_id: string | null;
  parsed: string | null;
  owner_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface CandidateInput {
  name: string;
  email?: string | null;
  phone?: string | null;
  location?: string | null;
  current_company?: string | null;
  current_title?: string | null;
  years_experience?: number | null;
  education?: string | null;
  school?: string | null;
  major?: string | null;
  skills?: string[];
  tags?: string[];
  source?: string | null;
  linkedin?: string | null;
  portfolio?: string | null;
  summary?: string | null;
  resume_file_id?: string | null;
  owner_id?: string | null;
}

/** 候选人库的分组维度：与前端 workflowStage() 的「流程」列一一对应。 */
export const CANDIDATE_GROUPS = [
  'screening',
  'interview',
  'negotiation',
  'pending',
  'hired',
  'rejected',
  'none',
] as const;
export type CandidateGroup = (typeof CANDIDATE_GROUPS)[number];

export function isCandidateGroup(value: unknown): value is CandidateGroup {
  return typeof value === 'string' && (CANDIDATE_GROUPS as readonly string[]).includes(value);
}

// 同一候选人可能有多条投递：取「最靠后的活跃投递」决定他落在哪一组。
// 权重与前端 STAGE_WEIGHT 一致；同阶段再用 updated_at 取最近一条，最后用 id 兜底，
// 保证 stage 与 offer_status 两个子查询在 updated_at 相同时仍指向同一条投递。
const FURTHEST_STAGE_ORDER = `CASE a.stage
      WHEN 'hired' THEN 5 WHEN 'offer' THEN 4 WHEN 'interview' THEN 3
      WHEN 'screening' THEN 2 ELSE 1 END DESC, a.updated_at DESC, a.id DESC`;

// new 与 screening 都显示为「待筛选」；offer 已发出/已接受归「待入职」，其余 offer 归「谈薪」。
const GROUP_KEY_SQL = `CASE
      WHEN t.active_count = 0 AND t.rejected_count > 0 THEN 'rejected'
      WHEN t.active_count = 0 THEN 'none'
      WHEN t.furthest_stage IN ('new', 'screening') THEN 'screening'
      WHEN t.furthest_stage = 'interview' THEN 'interview'
      WHEN t.furthest_stage = 'offer' AND t.furthest_offer_status IN ('sent', 'accepted') THEN 'pending'
      WHEN t.furthest_stage = 'offer' THEN 'negotiation'
      WHEN t.furthest_stage = 'hired' THEN 'hired'
      ELSE 'none'
    END`;

export function serializeCandidate(row: CandidateRow & Record<string, unknown>) {
  const { resume_text: _resumeText, ...display } = row;
  const parsed = jsonParse<Record<string, unknown> | null>(row.parsed, null);
  const { text: _parsedText, ...parsedDisplay } = parsed ?? {};
  return {
    ...display,
    skills: jsonParse<string[]>(row.skills, []),
    tags: jsonParse<string[]>(row.tags, []),
    parsed: parsed ? parsedDisplay : null,
  };
}

export function listCandidates(options: {
  q?: string;
  skill?: string;
  tag?: string;
  jobId?: string;
  group?: string;
  page?: number;
  pageSize?: number;
} = {}) {
  const conditions: string[] = [];
  const params: unknown[] = [];
  const jobId = options.jobId;
  const applicationSource = jobId ? 'job_applications' : 'applications';
  const scope = jobId
    ? 'WITH job_applications AS NOT MATERIALIZED (SELECT * FROM applications WHERE job_id = ?)'
    : '';
  if (jobId) params.push(jobId);
  if (options.q?.trim()) {
    const like = `%${options.q.trim()}%`;
    conditions.push(
      '(c.name LIKE ? OR c.email LIKE ? OR c.current_title LIKE ? OR c.current_company LIKE ? OR c.skills LIKE ?)',
    );
    params.push(like, like, like, like, like);
  }
  if (options.skill) {
    conditions.push('c.skills LIKE ?');
    params.push(`%${options.skill}%`);
  }
  if (options.tag) {
    conditions.push('c.tags LIKE ?');
    params.push(`%${options.tag}%`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const page = Math.max(1, options.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, options.pageSize ?? 20));

  // 选定职位后，候选人必须有该职位的投递，流程也只由该职位的投递决定。
  // 不加职位时，仍取候选人的全局最远阶段。
  const jobJoin = jobId ? 'JOIN job_applications selected ON selected.candidate_id = c.id' : '';
  const base = `SELECT c.*, u.name AS owner_name,
            (SELECT COUNT(*) FROM ${applicationSource} a WHERE a.candidate_id = c.id AND a.status = 'active') AS active_count,
            (SELECT COUNT(*) FROM ${applicationSource} a WHERE a.candidate_id = c.id AND a.status = 'rejected') AS rejected_count,
            (SELECT a.stage FROM ${applicationSource} a
              WHERE a.candidate_id = c.id AND a.status = 'active'
              ORDER BY ${FURTHEST_STAGE_ORDER}
              LIMIT 1) AS furthest_stage,
            (SELECT o.status FROM ${applicationSource} a LEFT JOIN offers o ON o.application_id = a.id
              WHERE a.candidate_id = c.id AND a.status = 'active'
              ORDER BY ${FURTHEST_STAGE_ORDER}
              LIMIT 1) AS furthest_offer_status
     FROM candidates c ${jobJoin} LEFT JOIN users u ON u.id = c.owner_id
     ${where}`;

  const counts = all<{ g: string; n: number }>(
    `${scope} SELECT ${GROUP_KEY_SQL} AS g, COUNT(*) AS n FROM (${base}) t GROUP BY g`,
    params,
  );
  const groupCounts = Object.fromEntries(CANDIDATE_GROUPS.map((key) => [key, 0])) as Record<CandidateGroup, number>;
  for (const row of counts) {
    if (isCandidateGroup(row.g)) groupCounts[row.g] = Number(row.n);
  }
  const allTotal = CANDIDATE_GROUPS.reduce((sum, key) => sum + groupCounts[key], 0);

  const group = isCandidateGroup(options.group) ? options.group : null;
  const total = group ? groupCounts[group] : allTotal;

  const items = all<Record<string, unknown>>(
    `${scope} SELECT t.* FROM (${base}) t
     ${group ? `WHERE ${GROUP_KEY_SQL} = ?` : ''}
     ORDER BY t.updated_at DESC, t.id DESC
     LIMIT ? OFFSET ?`,
    group ? [...params, group, pageSize, (page - 1) * pageSize] : [...params, pageSize, (page - 1) * pageSize],
  ).map((row) => ({
    ...serializeCandidate(row as CandidateRow & Record<string, unknown>),
    active_count: Number(row.active_count ?? 0),
    rejected_count: Number(row.rejected_count ?? 0),
    furthest_stage: (row.furthest_stage as string | null) ?? null,
    furthest_offer_status: (row.furthest_offer_status as string | null) ?? null,
  }));

  return {
    items,
    total,
    page,
    pageSize,
    pages: Math.max(1, Math.ceil(total / pageSize)),
    group: group ?? '',
    groupCounts: { all: allTotal, ...groupCounts },
  };
}

export function getCandidate(candidateId: string) {
  const row = getRow<CandidateRow & Record<string, unknown>>(
    `SELECT c.*, u.name AS owner_name FROM candidates c LEFT JOIN users u ON u.id = c.owner_id WHERE c.id = ?`,
    [candidateId],
  );
  if (!row) throw notFound('候选人不存在');

  const applications = all<Record<string, unknown>>(
    `SELECT ${APPLICATION_FIELDS}, j.title AS job_title, j.department AS job_department, j.status AS job_status, o.status AS offer_status
     FROM applications a JOIN jobs j ON j.id = a.job_id
     LEFT JOIN offers o ON o.application_id = a.id
     WHERE a.candidate_id = ? ORDER BY a.updated_at DESC`,
    [candidateId],
  );

  const interviews = all<Record<string, unknown>>(
    `SELECT ${INTERVIEW_FIELDS}, j.title AS job_title, u.name AS interviewer_name
     FROM interviews i
     JOIN applications a ON a.id = i.application_id
     JOIN jobs j ON j.id = a.job_id
     LEFT JOIN users u ON u.id = i.interviewer_id
     WHERE a.candidate_id = ? ORDER BY i.scheduled_at DESC`,
    [candidateId],
  );

  const file = row.resume_file_id
    ? getRow<Record<string, unknown>>('SELECT * FROM files WHERE id = ?', [row.resume_file_id])
    : null;

  return {
    candidate: serializeCandidate(row),
    applications,
    interviews,
    resumeFile: file
      ? { id: file.id, filename: file.filename, size: file.size, mime: file.mime, uploadedAt: file.created_at }
      : null,
  };
}

export function createCandidate(input: CandidateInput, actorId: string): CandidateRow {
  if (!input.name?.trim()) throw badRequest('候选人姓名不能为空');
  if (input.email) {
    const duplicate = getRow<{ id: string }>('SELECT id FROM candidates WHERE email = ?', [
      input.email.trim().toLowerCase(),
    ]);
    if (duplicate) throw conflict('该邮箱的候选人已存在', { candidateId: duplicate.id });
  }
  const candidateId = id('cand');
  const timestamp = now();
  run(
    `INSERT INTO candidates
       (id, name, email, phone, location, current_company, current_title, years_experience,
        education, school, major, skills, tags, source, linkedin, portfolio, summary,
        resume_file_id, parsed, owner_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?)`,
    [
      candidateId,
      input.name.trim(),
      input.email?.trim().toLowerCase() ?? null,
      input.phone?.trim() ?? null,
      input.location ?? null,
      input.current_company ?? null,
      input.current_title ?? null,
      input.years_experience ?? null,
      input.education ?? null,
      input.school ?? null,
      input.major ?? null,
      toJson(input.skills ?? []),
      toJson(input.tags ?? []),
      input.source ?? 'manual',
      input.linkedin ?? null,
      input.portfolio ?? null,
      input.summary ?? null,
      input.resume_file_id ?? null,
      input.owner_id ?? actorId,
      timestamp,
      timestamp,
    ],
  );
  audit({ actorId, action: 'candidate.create', entityType: 'candidate', entityId: candidateId });
  return getRow<CandidateRow>('SELECT * FROM candidates WHERE id = ?', [candidateId])!;
}

export function updateCandidate(
  candidateId: string,
  patch: Partial<CandidateInput>,
  actorId: string,
): CandidateRow {
  const existing = getRow<CandidateRow>('SELECT * FROM candidates WHERE id = ?', [candidateId]);
  if (!existing) throw notFound('候选人不存在');

  if (patch.email && patch.email.trim().toLowerCase() !== existing.email) {
    const duplicate = getRow<{ id: string }>(
      'SELECT id FROM candidates WHERE email = ? AND id != ?',
      [patch.email.trim().toLowerCase(), candidateId],
    );
    if (duplicate) throw conflict('该邮箱已被其他候选人使用');
  }

  const pick = <K extends keyof CandidateInput>(key: K, current: unknown) =>
    patch[key] === undefined ? current : patch[key];

  run(
    `UPDATE candidates SET name = ?, email = ?, phone = ?, location = ?, current_company = ?,
       current_title = ?, years_experience = ?, education = ?, school = ?, major = ?, skills = ?,
       tags = ?, source = ?, linkedin = ?, portfolio = ?, summary = ?, resume_file_id = ?, owner_id = ?,
       updated_at = ?
     WHERE id = ?`,
    [
      (pick('name', existing.name) as string).trim(),
      patch.email === undefined ? existing.email : patch.email?.trim().toLowerCase() ?? null,
      pick('phone', existing.phone),
      pick('location', existing.location),
      pick('current_company', existing.current_company),
      pick('current_title', existing.current_title),
      pick('years_experience', existing.years_experience),
      pick('education', existing.education),
      pick('school', existing.school),
      pick('major', existing.major),
      patch.skills === undefined ? existing.skills : toJson(patch.skills),
      patch.tags === undefined ? existing.tags : toJson(patch.tags),
      pick('source', existing.source),
      pick('linkedin', existing.linkedin),
      pick('portfolio', existing.portfolio),
      pick('summary', existing.summary),
      pick('resume_file_id', existing.resume_file_id),
      pick('owner_id', existing.owner_id),
      now(),
      candidateId,
    ],
  );
  audit({ actorId, action: 'candidate.update', entityType: 'candidate', entityId: candidateId });
  return getRow<CandidateRow>('SELECT * FROM candidates WHERE id = ?', [candidateId])!;
}

export function deleteCandidate(candidateId: string, actorId: string): void {
  const candidate = getRow<{ id: string }>('SELECT id FROM candidates WHERE id = ?', [candidateId]);
  if (!candidate) throw notFound('候选人不存在');
  const applications = getRow<{ n: number }>(
    'SELECT COUNT(*) AS n FROM applications WHERE candidate_id = ?',
    [candidateId],
  );
  if ((applications?.n ?? 0) > 0) {
    throw badRequest('该候选人已有投递记录，无法删除');
  }
  run('DELETE FROM candidates WHERE id = ?', [candidateId]);
  audit({ actorId, action: 'candidate.delete', entityType: 'candidate', entityId: candidateId });
}

export function applyParsedFields(
  candidateId: string,
  fileId: string,
  parsed: Record<string, unknown>,
  actorId: string,
): void {
  const fields = (parsed.fields ?? {}) as Record<string, unknown>;
  const existing = getRow<CandidateRow>('SELECT * FROM candidates WHERE id = ?', [candidateId]);
  if (!existing) throw notFound('候选人不存在');

  const str = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : null);
  const skills = Array.isArray(fields.skills) ? (fields.skills as string[]) : [];
  const mergedSkills = Array.from(new Set([...jsonParse<string[]>(existing.skills, []), ...skills]));

  run(
    `UPDATE candidates SET
       email = COALESCE(email, ?), phone = COALESCE(phone, ?), location = COALESCE(location, ?),
       current_company = COALESCE(current_company, ?), current_title = COALESCE(current_title, ?),
       years_experience = COALESCE(years_experience, ?), education = COALESCE(education, ?),
       school = COALESCE(school, ?), major = COALESCE(major, ?), summary = COALESCE(summary, ?),
       skills = ?, parsed = ?, resume_file_id = COALESCE(resume_file_id, ?), updated_at = ?
     WHERE id = ?`,
    [
      str(fields.email),
      str(fields.phone),
      str(fields.location),
      str(fields.current_company),
      str(fields.current_title),
      typeof fields.years_experience === 'number' ? fields.years_experience : null,
      str(fields.education),
      str(fields.school),
      str(fields.major),
      str(fields.summary),
      toJson(mergedSkills),
      toJson(parsed),
      fileId,
      now(),
      candidateId,
    ],
  );
  audit({ actorId, action: 'candidate.parse_apply', entityType: 'candidate', entityId: candidateId });
}