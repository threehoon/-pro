import { all, getRow } from '../db/index.ts';
import { now } from '../lib/util.ts';
import { STAGES, STAGE_LABELS, type Stage } from '../constants.ts';
import { recentActivity } from './audit.ts';

function startOfToday(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

function endOfToday(): string {
  const d = new Date();
  d.setHours(23, 59, 59, 999);
  return d.toISOString();
}

function daysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

export function dashboard() {
  const openJobs = getRow<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE status = 'open'")?.n ?? 0;
  const activeCandidates =
    getRow<{ n: number }>("SELECT COUNT(DISTINCT candidate_id) AS n FROM applications WHERE status = 'active'")
      ?.n ?? 0;
  const activeApplications =
    getRow<{ n: number }>("SELECT COUNT(*) AS n FROM applications WHERE status = 'active'")?.n ?? 0;
  const hiredThisMonth =
    getRow<{ n: number }>(
      "SELECT COUNT(*) AS n FROM applications WHERE stage = 'hired' AND status = 'active' AND hired_at >= ?",
      [daysAgo(30)],
    )?.n ?? 0;
  const interviewsToday =
    getRow<{ n: number }>(
      "SELECT COUNT(*) AS n FROM interviews i JOIN applications a ON a.id = i.application_id WHERE a.stage = 'interview' AND a.status = 'active' AND i.is_draft = 0 AND i.status = 'scheduled' AND i.scheduled_at BETWEEN ? AND ?",
      [startOfToday(), endOfToday()],
    )?.n ?? 0;
  const interviewsUpcoming =
    getRow<{ n: number }>(
      "SELECT COUNT(*) AS n FROM interviews i JOIN applications a ON a.id = i.application_id WHERE a.stage = 'interview' AND a.status = 'active' AND i.is_draft = 0 AND i.status = 'scheduled' AND i.scheduled_at >= ?",
      [now()],
    )?.n ?? 0;

  const stageRows = all<{ stage: Stage; n: number }>(
    "SELECT stage, COUNT(*) AS n FROM applications WHERE status = 'active' GROUP BY stage",
  );
  const stageCounts = Object.fromEntries(stageRows.map((row) => [row.stage, row.n])) as Record<Stage, number>;
  const funnel = STAGES.map((stage) => ({
    stage,
    label: STAGE_LABELS[stage],
    count: stageCounts[stage] ?? 0,
  }));
  const rejected =
    getRow<{ n: number }>("SELECT COUNT(*) AS n FROM applications WHERE status = 'rejected'")?.n ?? 0;

  const todayInterviews = all<Record<string, unknown>>(
    `SELECT i.id, i.scheduled_at, i.duration_minutes, i.mode, i.round, i.status,
            c.name AS candidate_name, c.id AS candidate_id,
            j.title AS job_title, j.id AS job_id,
            u.name AS interviewer_name
     FROM interviews i
     JOIN applications a ON a.id = i.application_id
     JOIN candidates c ON c.id = a.candidate_id
     JOIN jobs j ON j.id = a.job_id
     LEFT JOIN users u ON u.id = i.interviewer_id
     WHERE a.stage = 'interview' AND a.status = 'active' AND i.is_draft = 0 AND i.status = 'scheduled' AND i.scheduled_at BETWEEN ? AND ?
     ORDER BY i.scheduled_at ASC`,
    [startOfToday(), endOfToday()],
  );

  const jobBreakdown = all<Record<string, unknown>>(
    `SELECT j.id, j.title, j.department, j.headcount, j.status,
            (SELECT COUNT(*) FROM applications a WHERE a.job_id = j.id AND a.status = 'active') AS active_count,
            (SELECT COUNT(*) FROM applications a WHERE a.job_id = j.id AND a.stage = 'hired' AND a.status = 'active') AS hired_count,
            (SELECT COUNT(*) FROM applications a WHERE a.job_id = j.id AND a.stage = 'screening' AND a.status = 'active') AS new_count
     FROM jobs j
     WHERE j.status IN ('open', 'paused')
     ORDER BY active_count DESC, j.created_at DESC
     LIMIT 6`,
  );

  // 需要跟进的候选人：新简历/筛选中且超过 5 天没有动作
  const stale = all<Record<string, unknown>>(
    `SELECT a.id AS application_id, a.stage, a.updated_at,
            c.id AS candidate_id, c.name AS candidate_name, c.current_title,
            j.id AS job_id, j.title AS job_title
     FROM applications a
     JOIN candidates c ON c.id = a.candidate_id
     JOIN jobs j ON j.id = a.job_id
     WHERE a.status = 'active' AND a.stage IN ('new', 'screening') AND a.updated_at < ?
     ORDER BY a.updated_at ASC
     LIMIT 6`,
    [daysAgo(5)],
  ).map((row) => ({
    ...row,
    days_waiting: Math.floor((Date.now() - new Date(String(row.updated_at)).getTime()) / 86_400_000),
  }));

  const sources = all<{ source: string | null; n: number }>(
    `SELECT COALESCE(source, '其他') AS source, COUNT(*) AS n FROM candidates GROUP BY source ORDER BY n DESC LIMIT 5`,
  );

  return {
    kpis: {
      openJobs,
      activeCandidates,
      activeApplications,
      hires30d: hiredThisMonth,
      interviewsToday,
      interviewsUpcoming,
    },
    funnel,
    rejected,
    todayInterviews,
    jobBreakdown,
    stale,
    sources,
    activity: recentActivity(8),
  };
}

export function todayTasks(jobId?: string) {
  return all<{
    id: string;
    title: string;
    reason: string;
    applicationId: string;
    candidateId: string;
    jobId: string;
    interviewId: string | null;
    section: 'offer' | 'screening' | 'interviews';
  }>(`WITH pending AS (
    SELECT a.id, a.candidate_id, a.job_id, c.name, a.stage, a.updated_at,
           o.status AS offer_status, o.reply_deadline, i.id AS interview_id, i.round, i.is_draft,
           i.scheduled_at, i.summary_status
    FROM applications a
    JOIN candidates c ON c.id = a.candidate_id
    JOIN jobs j ON j.id = a.job_id
    LEFT JOIN offers o ON o.application_id = a.id
    LEFT JOIN interviews i ON i.id = (
      SELECT id FROM interviews WHERE application_id = a.id AND status = 'scheduled'
      ORDER BY round DESC, created_at DESC, id DESC LIMIT 1
    )
    WHERE a.status = 'active' AND a.stage <> 'hired' AND j.status <> 'closed'
      AND (?1 IS NULL OR a.job_id = ?1)
  ), tasks AS (
    SELECT *, CASE
      WHEN offer_status = 'sent' AND reply_deadline <= date(?, 'localtime') THEN 1
      WHEN stage = 'interview' AND is_draft = 0 AND scheduled_at <= ? AND summary_status IN ('ready', 'manual') THEN 2
      WHEN stage = 'interview' AND is_draft = 0 AND scheduled_at <= ? AND summary_status IN ('none', 'failed') THEN 3
      WHEN stage = 'interview' AND (interview_id IS NULL OR is_draft = 1) THEN 4
      WHEN stage = 'offer' AND offer_status = 'negotiating' THEN 5
      WHEN stage = 'screening' THEN 6
    END AS priority
    FROM pending
  )
  SELECT id, id AS applicationId, candidate_id AS candidateId, job_id AS jobId,
         CASE WHEN priority IN (2, 3) THEN interview_id END AS interviewId,
         CASE WHEN priority IN (1, 5) THEN 'offer' WHEN priority = 6 THEN 'screening' ELSE 'interviews' END AS section,
         name || ' · ' || CASE priority
           WHEN 1 THEN '跟进 Offer' WHEN 2 THEN '确认面试去向' WHEN 3 THEN '补充面试材料'
           WHEN 4 THEN CASE WHEN is_draft = 1 THEN '安排复试' ELSE '安排面试' END
           WHEN 5 THEN '推进谈薪' WHEN 6 THEN '确认筛选'
         END AS title,
         CASE priority
           WHEN 1 THEN '已到答复期限，等待候选人回复' WHEN 2 THEN '本轮分析已生成，等待确认'
           WHEN 3 THEN '面试时间已过，等待转写稿或分析'
           WHEN 4 THEN '已确认推进，等待安排时间' WHEN 5 THEN '面试已确认，等待敲定薪资与到岗时间'
           WHEN 6 THEN '候选人已投递，等待筛选确认'
         END AS reason
  FROM tasks WHERE priority IS NOT NULL ORDER BY priority, updated_at, id LIMIT 5`, [jobId ?? null, now(), now(), now()]);
}

export function candidatePoolSummary() {
  const rows = all<{ skill: string; n: number }>(
    `SELECT value AS skill, COUNT(*) AS n FROM candidates, json_each(candidates.skills) GROUP BY value ORDER BY n DESC LIMIT 12`,
  );
  return rows;
}
