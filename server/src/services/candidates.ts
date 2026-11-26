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
  page?: number;
  pageSize?: number;
} = {}) {
  const conditions: string[] = [];
  const params: unknown[] = [];
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

  const total =
    getRow<{ n: number }>(`SELECT COUNT(*) AS n FROM candidates c ${where}`, params)?.n ?? 0;

  const items = all<Record<string, unknown>>(
    `SELECT c.*, u.name AS owner_name,
            (SELECT COUNT(*) FROM applications a WHERE a.candidate_id = c.id AND a.status = 'active') AS active_count,
            (SELECT COUNT(*) FROM applications a WHERE a.candidate_id = c.id AND a.status = 'rejected') AS rejected_count,
            (SELECT a.stage FROM applications a
              WHERE a.candidate_id = c.id AND a.status = 'active'
              ORDER BY CASE a.stage WHEN 'hired' THEN 5 WHEN 'offer' THEN 4 WHEN 'interview' THEN 3
                                    WHEN 'screening' THEN 2 ELSE 1 END DESC
              LIMIT 1) AS furthest_stage
     FROM candidates c LEFT JOIN users u ON u.id = c.owner_id
     ${where}
     ORDER BY c.updated_at DESC
     LIMIT ? OFFSET ?`,
    [...params, pageSize, (page - 1) * pageSize],
  ).map((row) => ({
    ...serializeCandidate(row as CandidateRow & Record<string, unknown>),
    active_count: Number(row.active_count ?? 0),
    rejected_count: Number(row.rejected_count ?? 0),
    furthest_stage: (row.furthest_stage as string | null) ?? null,
  }));

  return { items, total, page, pageSize, pages: Math.max(1, Math.ceil(total / pageSize)) };
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