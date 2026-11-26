import { all, getRow, run } from '../db/index.ts';
import { id, now, jsonParse, toJson } from '../lib/util.ts';
import { badRequest, notFound } from '../lib/errors.ts';
import { audit } from './audit.ts';

export interface JobRow {
  id: string;
  title: string;
  department: string | null;
  location: string | null;
  work_mode: string;
  employment_type: string;
  level: string | null;
  headcount: number;
  salary_min: number | null;
  salary_max: number | null;
  currency: string;
  description: string | null;
  requirements: string | null;
  skills: string;
  status: 'open' | 'paused' | 'closed';
  owner_id: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

export interface JobInput {
  title: string;
  department?: string | null;
  location?: string | null;
  work_mode?: 'onsite' | 'hybrid' | 'remote';
  employment_type?: 'full_time' | 'part_time' | 'intern' | 'contract';
  level?: string | null;
  headcount?: number;
  salary_min?: number | null;
  salary_max?: number | null;
  description?: string | null;
  requirements?: string | null;
  skills?: string[];
  owner_id?: string | null;
  status?: 'open' | 'paused' | 'closed';
}

function serializeJob(row: JobRow & Record<string, unknown>) {
  return { ...row, skills: jsonParse<string[]>(row.skills, []) };
}

export function listJobs(options: { status?: string; q?: string; ownerId?: string } = {}) {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (options.status && options.status !== 'all') {
    conditions.push('j.status = ?');
    params.push(options.status);
  }
  if (options.ownerId) {
    conditions.push('j.owner_id = ?');
    params.push(options.ownerId);
  }
  if (options.q?.trim()) {
    conditions.push('(j.title LIKE ? OR j.department LIKE ? OR j.location LIKE ?)');
    const like = `%${options.q.trim()}%`;
    params.push(like, like, like);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const rows = all<Record<string, unknown>>(
    `SELECT j.*, u.name AS owner_name,
            (SELECT COUNT(*) FROM applications a WHERE a.job_id = j.id AND a.status = 'active') AS active_count,
            (SELECT COUNT(*) FROM applications a WHERE a.job_id = j.id AND a.stage = 'new' AND a.status = 'active') AS new_count,
            (SELECT COUNT(*) FROM applications a WHERE a.job_id = j.id AND a.stage = 'hired' AND a.status = 'active') AS hired_count,
            (SELECT COUNT(*) FROM applications a WHERE a.job_id = j.id AND a.status = 'rejected') AS rejected_count,
            (SELECT COUNT(*) FROM interviews i JOIN applications a ON a.id = i.application_id
              WHERE a.job_id = j.id AND i.status = 'scheduled' AND i.scheduled_at >= ?) AS upcoming_interviews
     FROM jobs j LEFT JOIN users u ON u.id = j.owner_id
     ${where}
     ORDER BY CASE j.status WHEN 'open' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END, j.created_at DESC`,
    [now(), ...params],
  );

  // 一次查出所有职位的阶段分布，避免每张卡片再发请求
  const stageRows = all<{ job_id: string; stage: string; n: number }>(
    `SELECT job_id, stage, COUNT(*) AS n FROM applications WHERE status = 'active' GROUP BY job_id, stage`,
  );
  const stageCounts = new Map<string, Record<string, number>>();
  for (const row of stageRows) {
    const bucket = stageCounts.get(row.job_id) ?? {};
    bucket[row.stage] = Number(row.n);
    stageCounts.set(row.job_id, bucket);
  }

  const items = rows.map((row) => {
    const stages = { new: 0, screening: 0, interview: 0, offer: 0, hired: 0, ...(stageCounts.get(String(row.id)) ?? {}) };
    return {
      ...serializeJob(row as JobRow & Record<string, unknown>),
      active_count: Number(row.active_count ?? 0),
      new_count: Number(row.new_count ?? 0),
      hired_count: Number(row.hired_count ?? 0),
      rejected_count: Number(row.rejected_count ?? 0),
      upcoming_interviews: Number(row.upcoming_interviews ?? 0),
      stages,
    };
  });

  return {
    items,
    totals: {
      open: items.filter((job) => job.status === 'open').length,
      closed: items.filter((job) => job.status === 'closed').length,
      headcount: items
        .filter((job) => job.status === 'open')
        .reduce((sum, job) => sum + Number(job.headcount ?? 0), 0),
    },
  };
}

export function getJob(jobId: string) {
  const row = getRow<JobRow & Record<string, unknown>>(
    `SELECT j.*, u.name AS owner_name FROM jobs j LEFT JOIN users u ON u.id = j.owner_id WHERE j.id = ?`,
    [jobId],
  );
  if (!row) throw notFound('职位不存在');

  const stageRows = all<{ stage: string; status: string; n: number }>(
    'SELECT stage, status, COUNT(*) AS n FROM applications WHERE job_id = ? GROUP BY stage, status',
    [jobId],
  );
  const counts: Record<string, number> = {};
  for (const item of stageRows) {
    if (item.status === 'rejected') continue;
    counts[item.stage] = item.n;
  }
  const rejected = stageRows
    .filter((item) => item.status === 'rejected')
    .reduce((sum, item) => sum + item.n, 0);

  const applicants = all<Record<string, unknown>>(
    `SELECT a.id, a.stage, a.status, a.applied_at, a.updated_at,
            c.id AS candidate_id, c.name AS candidate_name, c.current_title, c.current_company,
            c.years_experience, c.skills
     FROM applications a JOIN candidates c ON c.id = a.candidate_id
     WHERE a.job_id = ? ORDER BY a.updated_at DESC LIMIT 12`,
    [jobId],
  );

  return {
    job: serializeJob(row),
    stats: {
      stages: counts,
      active: Object.values(counts).reduce((sum, n) => sum + n, 0),
      rejected,
      hired: getRow<{ n: number }>(
        "SELECT COUNT(*) AS n FROM applications WHERE job_id = ? AND stage = 'hired' AND status = 'active'",
        [jobId],
      )?.n ?? 0,
      upcoming_interviews:
        getRow<{ n: number }>(
          `SELECT COUNT(*) AS n FROM interviews i JOIN applications a ON a.id = i.application_id
           WHERE a.job_id = ? AND a.status = 'active' AND i.is_draft = 0 AND i.status = 'scheduled' AND i.scheduled_at >= ?`,
          [jobId, now()],
        )?.n ?? 0,
    },
    applicants: applicants.map((row) => ({ ...row, skills: jsonParse<string[]>(row.skills, []) })),
  };
}

export function createJob(input: JobInput, actorId: string): JobRow {
  if (!input.title?.trim()) throw badRequest('职位名称不能为空');
  if (input.salary_min != null && input.salary_max != null && input.salary_min > input.salary_max) {
    throw badRequest('薪资下限不能高于上限');
  }
  const jobId = id('job');
  const timestamp = now();
  run(
    `INSERT INTO jobs
       (id, title, department, location, work_mode, employment_type, level, headcount,
        salary_min, salary_max, currency, description, requirements, skills, status, owner_id,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      jobId,
      input.title.trim(),
      input.department ?? null,
      input.location ?? null,
      input.work_mode ?? 'onsite',
      input.employment_type ?? 'full_time',
      input.level ?? null,
      input.headcount ?? 1,
      input.salary_min ?? null,
      input.salary_max ?? null,
      'CNY',
      input.description ?? null,
      input.requirements ?? null,
      toJson(input.skills ?? []),
      input.status ?? 'open',
      input.owner_id ?? actorId,
      timestamp,
      timestamp,
    ],
  );
  audit({ actorId, action: 'job.create', entityType: 'job', entityId: jobId, detail: { title: input.title } });
  return getRow<JobRow>('SELECT * FROM jobs WHERE id = ?', [jobId])!;
}

export function updateJob(jobId: string, patch: Partial<JobInput>, actorId: string): JobRow {
  const existing = getRow<JobRow>('SELECT * FROM jobs WHERE id = ?', [jobId]);
  if (!existing) throw notFound('职位不存在');
  const merged = {
    title: patch.title ?? existing.title,
    department: patch.department === undefined ? existing.department : patch.department,
    location: patch.location === undefined ? existing.location : patch.location,
    work_mode: patch.work_mode ?? existing.work_mode,
    employment_type: patch.employment_type ?? existing.employment_type,
    level: patch.level === undefined ? existing.level : patch.level,
    headcount: patch.headcount ?? existing.headcount,
    salary_min: patch.salary_min === undefined ? existing.salary_min : patch.salary_min,
    salary_max: patch.salary_max === undefined ? existing.salary_max : patch.salary_max,
    description: patch.description === undefined ? existing.description : patch.description,
    requirements: patch.requirements === undefined ? existing.requirements : patch.requirements,
    skills: patch.skills === undefined ? jsonParse<string[]>(existing.skills, []) : patch.skills,
    owner_id: patch.owner_id === undefined ? existing.owner_id : patch.owner_id,
    status: patch.status ?? existing.status,
  };

  // 单边修改也要和库里另一侧比较，否则会留下 min > max 的区间
  if (merged.salary_min != null && merged.salary_max != null && merged.salary_min > merged.salary_max) {
    throw badRequest('薪资下限不能高于上限');
  }

  const closedAt =
    merged.status === 'closed' ? (existing.closed_at ?? now()) : null;

  run(
    `UPDATE jobs SET title = ?, department = ?, location = ?, work_mode = ?, employment_type = ?,
       level = ?, headcount = ?, salary_min = ?, salary_max = ?, description = ?, requirements = ?,
       skills = ?, owner_id = ?, status = ?, closed_at = ?, updated_at = ?
     WHERE id = ?`,
    [
      merged.title.trim(),
      merged.department,
      merged.location,
      merged.work_mode,
      merged.employment_type,
      merged.level,
      merged.headcount,
      merged.salary_min,
      merged.salary_max,
      merged.description,
      merged.requirements,
      toJson(merged.skills),
      merged.owner_id,
      merged.status,
      closedAt,
      now(),
      jobId,
    ],
  );

  audit({
    actorId,
    action: 'job.update',
    entityType: 'job',
    entityId: jobId,
    detail: { status: merged.status },
  });
  return getRow<JobRow>('SELECT * FROM jobs WHERE id = ?', [jobId])!;
}

export function deleteJob(jobId: string, actorId: string): void {
  const job = getRow<{ id: string }>('SELECT id FROM jobs WHERE id = ?', [jobId]);
  if (!job) throw notFound('职位不存在');
  const applications = getRow<{ n: number }>(
    'SELECT COUNT(*) AS n FROM applications WHERE job_id = ?',
    [jobId],
  );
  if ((applications?.n ?? 0) > 0) throw badRequest('该职位下已有投递，请先关闭职位而不是删除');
  run('DELETE FROM jobs WHERE id = ?', [jobId]);
  audit({ actorId, action: 'job.delete', entityType: 'job', entityId: jobId });
}

export function jobOptions() {
  return all<{ id: string; title: string; status: string; department: string | null }>(
    `SELECT id, title, status, department FROM jobs
     ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END, created_at DESC`,
  );
}