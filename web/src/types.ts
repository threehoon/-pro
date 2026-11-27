import type { WorkflowFields, WorkflowDecision, AiStatus, OfferStatus } from "./workflowTypes";

export type Stage = "new" | "screening" | "interview" | "offer" | "hired";
export type ApplicationStatus = "active" | "rejected";
export type JobStatus = "open" | "paused" | "closed";
export type InterviewStatus = "scheduled" | "completed" | "cancelled" | "no_show";
export type InterviewMode = "onsite" | "video" | "phone";
export type Role = "admin" | "recruiter" | "hiring_manager";

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  /** 登录账号名（可与邮箱二选一登录）；未设置时为空 */
  username?: string | null;
  role: Role;
  feishu_open_id?: string | null;
}

export interface Meta {
  stages: Stage[];
  stageLabels: Record<Stage, string>;
  stageHints: Record<Stage, string>;
  rejectionReasons: string[];
  interviewModeLabels: Record<string, string>;
  recommendationLabels: Record<string, string>;
  workModeLabels: Record<string, string>;
  employmentTypeLabels: Record<string, string>;
  roleLabels: Record<string, string>;
  resumeMaxBytes: number;
  resumeAccept: string;
}

export interface Job {
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
  skills: string[];
  status: JobStatus;
  owner_id: string | null;
  owner_name?: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  active_count?: number;
  new_count?: number;
  hired_count?: number;
  rejected_count?: number;
  upcoming_interviews?: number;
  stages?: Record<string, number>;
}

export interface JobDetail {
  job: Job;
  stats: {
    stages: Partial<Record<Stage, number>>;
    active: number;
    rejected: number;
    hired: number;
    upcoming_interviews: number;
  };
  applicants: Array<{
    id: string;
    stage: Stage;
    status: ApplicationStatus;
    rating: number | null;
    applied_at: string;
    updated_at: string;
    candidate_id: string;
    candidate_name: string;
    current_title: string | null;
    current_company: string | null;
    years_experience: number | null;
    skills: string[];
  }>;
}

export interface Candidate {
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
  skills: string[];
  tags: string[];
  source: string | null;
  linkedin: string | null;
  portfolio: string | null;
  summary: string | null;
  resume_file_id: string | null;
  parsed: ParsedResume | null;
  owner_id: string | null;
  owner_name?: string | null;
  active_count?: number;
  rejected_count?: number;
  furthest_stage?: Stage | null;
  /** 最近一条在流程投递的 offer 状态，用于把「谈薪」和「待入职」区分开。 */
  furthest_offer_status?: OfferStatus | null;
  created_at: string;
  updated_at: string;
}

/** 候选人库的分组维度，与列表接口的 group 参数、计数键保持一致。 */
export type CandidateGroup = "screening" | "interview" | "negotiation" | "pending" | "hired" | "rejected" | "none";

export interface CandidateList {
  items: Candidate[];
  total: number;
  page: number;
  pageSize: number;
  pages: number;
  group?: CandidateGroup | "";
  groupCounts?: { all: number } & Record<CandidateGroup, number>;
}

export interface ParsedFields {
  name?: string;
  email?: string;
  phone?: string;
  location?: string;
  current_company?: string;
  current_title?: string;
  years_experience?: number;
  education?: string;
  school?: string;
  major?: string;
  skills?: string[];
  links?: string[];
  summary?: string;
}

export interface ParsedResume {
  kind?: string;
  text?: string;
  chars?: number;
  pages?: number;
  fields?: ParsedFields;
  warnings?: string[];
  confidence?: number;
}

export interface ResumeFile {
  id: string;
  filename: string;
  size: number;
  mime: string;
  uploadedAt: string;
}

export interface CandidateDetail {
  candidate: Candidate;
  applications: Application[];
  interviews: Interview[];
  resumeFile: ResumeFile | null;
}

export interface Application extends WorkflowFields {
  id: string;
  job_id: string;
  candidate_id: string;
  stage: Stage;
  status: ApplicationStatus;
  rating: number | null;
  rejection_reason: string | null;
  source: string | null;
  owner_id: string | null;
  owner_name?: string | null;
  applied_at: string;
  updated_at: string;
  job_title?: string;
  job_department?: string | null;
  job_status?: JobStatus;
  candidate_name?: string;
  candidate_email?: string | null;
  department?: string | null;
}

export interface ApplicationEvent {
  id: string;
  application_id: string;
  type: string;
  from_stage: string | null;
  to_stage: string | null;
  note: string | null;
  actor_id: string | null;
  actor_name: string | null;
  created_at: string;
}

export interface ApplicationDetail {
  application: Application;
  events: ApplicationEvent[];
  interviews: Interview[];
}

export type CalendarSyncStatus = "none" | "pending" | "synced" | "failed";

export interface Interview {
  id: string;
  application_id: string;
  is_draft?: number | boolean;
  summary_status?: AiStatus;
  transcript?: string | null;
  decision?: WorkflowDecision | null;
  round: number;
  title: string;
  mode: InterviewMode;
  scheduled_at: string;
  duration_minutes: number;
  location: string | null;
  meeting_url: string | null;
  interviewer_id: string | null;
  interviewer_name: string | null;
  /** 面试官是否已绑定飞书：没绑定时日程只会写进招聘日历，不会给面试官发邀请 */
  interviewer_feishu_bound?: number | null;
  status: InterviewStatus;
  external_calendar_event_id?: string | null;
  calendar_sync_status?: CalendarSyncStatus;
  calendar_sync_error?: string | null;
  calendar_synced_at?: string | null;
  score: number | null;
  feedback: string | null;
  recommendation: string | null;
  /** 是否推荐进复试，飞书多维表格里可改并回写 */
  advance_recommended?: string | null;
  created_at: string;
  updated_at: string;
  candidate_id?: string;
  candidate_name?: string;
  job_id?: string;
  job_title?: string;
}

export interface BoardCard extends WorkflowFields {
  id: string;
  stage: Stage;
  status: ApplicationStatus;
  rating: number | null;
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
  interviews_count: number;
}

export interface BoardData {
  job: Job;
  approvedProfile: { id: string; version: number } | null;
  columns: Array<{ stage: Stage; label: string; count: number; cards: BoardCard[] }>;
  rejected: BoardCard[];
  totals: { active: number; rejected: number; hired: number };
}

export interface DashboardData {
  kpis: {
    openJobs: number;
    activeCandidates: number;
    activeApplications: number;
    hires30d: number;
    interviewsToday: number;
    interviewsUpcoming: number;
  };
  funnel: Array<{ stage: Stage; label: string; count: number }>;
  rejected: number;
  todayInterviews: Array<{
    id: string;
    scheduled_at: string;
    duration_minutes: number;
    mode: InterviewMode;
    round: number;
    status: InterviewStatus;
    candidate_name: string;
    candidate_id: string;
    job_title: string;
    job_id: string;
    interviewer_name: string | null;
  }>;
  jobBreakdown: Array<{
    id: string;
    title: string;
    department: string | null;
    headcount: number;
    status: JobStatus;
    active_count: number;
    hired_count: number;
    new_count: number;
  }>;
  stale: Array<{
    application_id: string;
    stage: Stage;
    updated_at: string;
    candidate_id: string;
    candidate_name: string;
    current_title: string | null;
    job_id: string;
    job_title: string;
    days_waiting: number;
  }>;
  sources: Array<{ source: string; n: number }>;
  activity: Array<{
    id: string;
    action: string;
    entity_type: string;
    entity_id: string;
    detail: string | null;
    actor_name: string | null;
    created_at: string;
  }>;
}

export interface FeishuStatus {
  provider: "feishu";
  status: "disabled" | "configured";
  configured: boolean;
  fields: {
    app_id: boolean;
    app_secret: boolean;
    verification_token: boolean;
    bot_webhook: boolean;
    bot_secret: boolean;
    calendar_id: boolean;
  };
  ready: { login: boolean; notifications: boolean; calendar: boolean };
  callbackUrl?: string;
  pendingNotifications: number;
  failedNotifications: number;
  sentNotifications: number;
  updatedAt: string | null;
  checklist: Array<{ key: string; label: string; description: string; done: boolean }>;
}

export interface FeishuAppTestResult {
  ok: true;
  latencyMs: number;
  expiresIn: number;
  endpoint: string;
}

export interface FeishuWebhookTestResult {
  ok: true;
  latencyMs: number;
  signed: boolean;
}

export interface FeishuCalendarCreateResult {
  ok: true;
  calendarId: string;
  summary: string;
  latencyMs: number;
  status: FeishuStatus;
}

export interface FeishuCalendarTestResult {
  ok: true;
  calendarId: string;
  summary: string;
  latencyMs: number;
}

export interface InterviewCalendarSyncResult {
  interview: Interview;
  sync: {
    ok: boolean;
    skipped?: boolean;
    error?: string | null;
    meetingUrl?: string | null;
    /** 自动补同步跳过时的原因，手动同步为空。 */
    reason?: "not_configured" | "draft" | "not_scheduled" | "in_flight" | "already_synced" | null;
  };
}

export interface FeishuDispatchResult {
  attempted: number;
  sent: number;
  failed: number;
  skipped: number;
  remainingPending: number;
  items: Array<{
    id: string;
    status: string;
    ok: boolean;
    skipped?: boolean;
    error?: string | null;
  }>;
}

export interface FeishuSkipResult {
  skipped: number;
  remainingPending: number;
}

export type FeishuOutboxStatus = "pending" | "sent" | "failed" | "skipped";
export type FeishuOutboxDelivery = "webhook" | "dm";

export interface FeishuOutboxPage {
  items: Array<NotificationItem & {
    status: FeishuOutboxStatus;
    delivery: FeishuOutboxDelivery;
    interviewer_name: string | null;
  }>;
  stats: Record<FeishuOutboxStatus, number> & { sendablePending: number; sendableFailed: number };
  total: number;
  page: number;
}

export interface NotificationItem {
  id: string;
  event_key: string;
  type: string;
  channel: string;
  status: string;
  title: string;
  body: string | null;
  payload: string | null;
  attempts: number;
  last_error: string | null;
  created_at: string;
  sent_at: string | null;
}
