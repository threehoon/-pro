import type { AiResult, AsrConfig, CompositeData, LlmConfig, TranscriptDraft, OfferData, OfferInput, ProfileContent, ProfileData, ScreeningData, ScreenTier, SummaryData, TodayItem, WorkflowDecision } from "../workflowTypes";
import type {
  ApplicationDetail,
  BoardData,
  CandidateDetail,
  CandidateList,
  DashboardData,
  FeishuOutboxDelivery,
  FeishuOutboxPage,
  FeishuOutboxStatus,
  FeishuStatus,
  Interview,
  JobDetail,
  Meta,
  SessionUser,
} from "../types";

export class ApiError extends Error {
  code: string;
  details: unknown;
  status: number;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

type Query = Record<string, string | number | undefined | null>;

function qs(params?: Query): string {
  if (!params) return "";
  const pairs: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return pairs.length ? `?${pairs.join("&")}` : "";
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  opts: { form?: FormData; signal?: AbortSignal } = {},
): Promise<T> {
  const init: RequestInit = {
    method,
    credentials: "same-origin",
    headers: {},
    signal: opts.signal,
  };
  if (opts.form) {
    init.body = opts.form;
  } else if (body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }

  let response: Response;
  try {
    response = await fetch(`/api${path}`, init);
  } catch {
    throw new ApiError(0, "network_error", "无法连接服务器，请确认后端已启动");
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    const err = (payload as { error?: { code?: string; message?: string; details?: unknown } })?.error;
    throw new ApiError(
      response.status,
      err?.code ?? "request_failed",
      err?.message ?? `请求失败（${response.status}）`,
      err?.details,
    );
  }

  return payload as T;
}

function list<T>(value: { items?: T[] } | T[]): T[] {
  if (Array.isArray(value)) return value;
  return value.items ?? [];
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

export interface JobInput {
  title: string;
  department?: string | null;
  location?: string | null;
  work_mode?: string;
  employment_type?: string;
  level?: string | null;
  headcount?: number;
  salary_min?: number | null;
  salary_max?: number | null;
  description?: string | null;
  requirements?: string | null;
  skills?: string[];
  owner_id?: string | null;
  status?: string;
}

export interface InterviewInput {
  applicationId: string;
  scheduledAt: string;
  title?: string;
  mode?: string;
  durationMinutes?: number;
  location?: string;
  meetingUrl?: string;
  interviewerId?: string | null;
  round?: number;
}

export const api = {
  bootstrap: () =>
    request<{
      hasUsers: boolean;
      user: SessionUser | null;
      sessionCookie: string;
      feishuLoginEnabled: boolean;
    }>("GET", "/bootstrap"),
  login: (email: string, password: string) =>
    request<{ user: SessionUser }>("POST", "/auth/login", { email, password }),
  register: (input: { name: string; email: string; password: string }) =>
    request<{ user: SessionUser }>("POST", "/auth/register", input),
  logout: () => request<{ ok: true }>("POST", "/auth/logout"),
  me: () => request<{ user: SessionUser }>("GET", "/auth/me"),
  unbindFeishu: (userId?: string) =>
    request<{ ok: true; user: SessionUser; unbound: boolean; items: SessionUser[] }>(
      "POST",
      "/auth/feishu/unbind",
      userId ? { userId } : {},
    ),
  changePassword: (currentPassword: string, nextPassword: string) =>
    request<{ ok: true }>("POST", "/auth/password", { currentPassword, nextPassword }),

  meta: () => request<Meta>("GET", "/meta"),
  today: (params?: { jobId?: string }) => {
    const query = params?.jobId ? `?jobId=${encodeURIComponent(params.jobId)}` : "";
    return request<{ items: TodayItem[] }>("GET", `/workspace/today${query}`);
  },
  dashboard: () => request<DashboardData>("GET", "/dashboard"),
  skills: () => request<{ items: Array<{ skill: string; n: number }> }>("GET", "/insights/skills"),

  jobs: (params?: Query) =>
    request<{ items: import("../types").Job[]; totals: { open: number; closed: number; headcount: number } }>(
      "GET",
      `/jobs${qs(params)}`,
    ),
  job: (id: string) => request<JobDetail>("GET", `/jobs/${id}`),
  jobOptions: () => request<{ items: Array<{ id: string; title: string; status: string; department: string | null }> }>("GET", "/job-options"),
  createJob: (input: JobInput) => request<{ job: import("../types").Job }>("POST", "/jobs", input),
  updateJob: (id: string, patch: Partial<JobInput>) =>
    request<{ job: import("../types").Job }>("PATCH", `/jobs/${id}`, patch),
  deleteJob: (id: string) => request<{ ok: true }>("DELETE", `/jobs/${id}`),
  profile: (id: string) => request<AiResult<ProfileData>>("GET", `/jobs/${id}/profile`),
  saveProfile: (id: string, content: ProfileContent) => request<AiResult<ProfileData>>("PUT", `/jobs/${id}/profile`, { content }),
  generateProfile: (id: string) => request<AiResult<ProfileData>>("POST", `/jobs/${id}/profile/generate`),
  approveProfile: (id: string, profileId: string) => request<AiResult<ProfileData>>("POST", `/jobs/${id}/profile/approve`, { profileId }),
  board: (id: string) => request<BoardData>("GET", `/jobs/${id}/board`),
  importResume: (jobId: string, file: File) => {
    const form = new FormData();
    form.append("file", file);
    return request<{ candidateId: string; applicationId: string }>("POST", `/jobs/${jobId}/resume-import`, undefined, { form });
  },

  candidates: (params?: Query) =>
    request<CandidateList>("GET", `/candidates${qs(params)}`),
  candidate: (id: string) => request<CandidateDetail>("GET", `/candidates/${id}`),
  createCandidate: (input: CandidateInput) =>
    request<{ candidate: import("../types").Candidate }>("POST", "/candidates", input),
  updateCandidate: (id: string, patch: Partial<CandidateInput>) =>
    request<{ candidate: import("../types").Candidate }>("PATCH", `/candidates/${id}`, patch),
  deleteCandidate: (id: string) => request<{ ok: true }>("DELETE", `/candidates/${id}`),
  apply: (candidateId: string, jobId: string) =>
    request<{ application: import("../types").Application }>("POST", `/candidates/${candidateId}/apply`, { jobId }),

  application: (id: string) => request<ApplicationDetail>("GET", `/applications/${id}`),
  screening: (id: string) => request<AiResult<ScreeningData>>("GET", `/applications/${id}/screening`),
  screen: (id: string) => request<AiResult<ScreeningData>>("POST", `/applications/${id}/screen`),
  overrideScreening: (id: string, indicator: string, label: string, level: ScreenTier) =>
    request<AiResult<ScreeningData>>("PATCH", `/screening/${id}/label`, { indicator, label, level }),
  decideScreening: (id: string, decision: "advance" | "reject", reason?: string) =>
    request<{ application: ApplicationDetail["application"] }>("POST", `/applications/${id}/screening`, { decision, reason }),
  composite: (id: string) => request<AiResult<CompositeData>>("GET", `/applications/${id}/composite`),
  retryComposite: (id: string) => request<AiResult<CompositeData>>("POST", `/applications/${id}/composite/retry`),
  offer: (id: string) => request<OfferData>("GET", `/applications/${id}/offer`),
  updateOffer: (id: string, patch: OfferInput) => request<OfferData>("PUT", `/applications/${id}/offer`, patch),
  offerAction: (id: string, action: "send" | "accept" | "decline" | "hire", patch?: { start_date?: string }) =>
    request<OfferData>("POST", `/applications/${id}/offer/${action}`, patch),
  reopen: (id: string) =>
    request<{ application: import("../types").Application }>("POST", `/applications/${id}/reopen`),
  addNote: (id: string, note: string) =>
    request<{ ok: true }>("POST", `/applications/${id}/notes`, { note }),

  interviews: (params?: Query) => request<{ items: Interview[] }>("GET", `/interviews${qs(params)}`),
  createInterview: (input: InterviewInput) => request<{ interview: Interview }>("POST", "/interviews", input),
  updateInterview: (id: string, patch: Record<string, unknown>) =>
    request<{ interview: Interview }>("PATCH", `/interviews/${id}`, patch),
  saveTranscript: (id: string, transcript: string) =>
    request<AiResult<{ summaryStatus: SummaryData["status"]; truncated: boolean }>>("PUT", `/interviews/${id}/transcript`, { transcript }),
  interviewSummary: (id: string) => request<AiResult<SummaryData>>("GET", `/interviews/${id}/summary`),
  retrySummary: (id: string) => request<AiResult<SummaryData>>("POST", `/interviews/${id}/summary/retry`),
  manualSummary: (id: string, conclusion: string) =>
    request<AiResult<SummaryData>>("POST", `/interviews/${id}/summary/manual`, { conclusion }),
  decideInterview: (id: string, decision: WorkflowDecision, options?: { reason?: string; allowWithoutSummary?: boolean }) =>
    request<{ interview: Interview; application: ApplicationDetail["application"]; offer: OfferData["offer"] }>("POST", `/interviews/${id}/decide`, { decision, ...options }),
  cancelInterview: (id: string) => request<{ interview: Interview }>("POST", `/interviews/${id}/cancel`),
  noShow: (id: string) => request<{ interview: Interview }>("POST", `/interviews/${id}/no-show`),
  syncInterviewCalendar: (id: string) =>
    request<import("../types").InterviewCalendarSyncResult>("POST", `/interviews/${id}/sync-calendar`, {}),
  /** 打开面试详情时自动补同步：服务端判断该不该同步，重复调用不会重建日程。 */
  ensureInterviewCalendar: (id: string) =>
    request<import("../types").InterviewCalendarSyncResult>("POST", `/interviews/${id}/ensure-calendar`, {}),

  notifications: (options: { channel?: string; limit?: number } = {}) =>
    request<{ items: import("../types").NotificationItem[]; stats: Record<string, number> }>(
      "GET",
      `/notifications${qs({ channel: options.channel, limit: options.limit })}`,
    ),
  feishuOutbox: (
    filters: { limit: number; page: number; status?: FeishuOutboxStatus; delivery?: FeishuOutboxDelivery; q?: string },
    signal?: AbortSignal,
  ) => request<FeishuOutboxPage>("GET", `/notifications${qs({ channel: "feishu", ...filters })}`, undefined, { signal }),
  llmConfig: () => request<AiResult<LlmConfig>>("GET", "/settings/llm"),
  saveLlmConfig: (input: { baseUrl: string; model: string; apiKey?: string; thinking?: "off" | "on" }) =>
    request<AiResult<LlmConfig>>("POST", "/settings/llm", input),
  testLlm: () => request<AiResult<{ latencyMs: number; model: string }>>("POST", "/settings/llm/test"),
  bitableConfig: () => request<AiResult<import("../workflowTypes").BitableConfig>>("GET", "/settings/bitable"),
  saveBitableConfig: (input: {
    appToken?: string | null;
    interviewsTableId?: string | null;
    applicationsTableId?: string | null;
    enabled?: boolean;
    fallbackMinutes?: number;
  }) => request<AiResult<import("../workflowTypes").BitableConfig>>("POST", "/settings/bitable", input),
  testBitable: () =>
    request<AiResult<import("../workflowTypes").BitableTestResult>>("POST", "/settings/bitable/test", {}),
  reconcileBitable: () =>
    request<AiResult<import("../workflowTypes").BitableReconcileResult>>("POST", "/settings/bitable/reconcile", {}),
  backfillBitable: () =>
    request<AiResult<import("../workflowTypes").BitableBackfillResult>>("POST", "/settings/bitable/backfill", {}),
  seedBitableDemo: () =>
    request<AiResult<import("../workflowTypes").BitableSeedResult>>("POST", "/settings/bitable/seed-demo", {}),
  clearBitableDemo: () =>
    request<AiResult<import("../workflowTypes").BitableClearResult>>("POST", "/settings/bitable/clear-demo", {}),
  asrConfig: () => request<AiResult<AsrConfig>>("GET", "/settings/asr"),
  saveAsrConfig: (input: { baseUrl: string; model: string; apiKey?: string; language?: string }) =>
    request<AiResult<AsrConfig>>("POST", "/settings/asr", input),
  transcribeInterview: (id: string, file: File) => {
    const form = new FormData();
    form.append("file", file);
    return request<AiResult<TranscriptDraft>>("POST", `/interviews/${id}/transcribe`, undefined, { form });
  },
  feishu: () => request<FeishuStatus>("GET", "/settings/feishu"),
  saveFeishu: (patch: Record<string, string>) => request<FeishuStatus>("PUT", "/settings/feishu", patch),
  testFeishuApp: () => request<import("../types").FeishuAppTestResult>("POST", "/settings/feishu/test-app", {}),
  testFeishuWebhook: () =>
    request<import("../types").FeishuWebhookTestResult>("POST", "/settings/feishu/test-webhook", {}),
  createFeishuCalendar: (input?: { summary?: string; description?: string }) =>
    request<import("../types").FeishuCalendarCreateResult>("POST", "/settings/feishu/create-calendar", input ?? {}),
  testFeishuCalendar: () =>
    request<import("../types").FeishuCalendarTestResult>("POST", "/settings/feishu/test-calendar", {}),
  dispatchFeishuNotifications: (input?: { notificationId?: string; limit?: number; includeFailed?: boolean }) =>
    request<import("../types").FeishuDispatchResult>("POST", "/notifications/feishu/dispatch", input ?? {}),
  skipPendingFeishuNotifications: (input?: { notificationId?: string }) =>
    request<import("../types").FeishuSkipResult>("POST", "/notifications/feishu/skip-pending", input ?? {}),

  team: () => request<{ items: SessionUser[] }>("GET", "/team"),
  setRole: (userId: string, role: string) =>
    request<{ ok: true; items: SessionUser[] }>("PATCH", `/team/${userId}/role`, { role }),
  createMember: (input: { name: string; email: string; password: string; role: string }) =>
    request<{ user: SessionUser; items: SessionUser[] }>("POST", "/team", input),

  uploadResume: (file: File) => {
    const form = new FormData();
    form.append("file", file);
    return request<{
      file: { id: string; filename: string; mime: string; size: number; uploadedAt: string };
      parsed: import("../types").ParsedResume | null;
      parseError: string | null;
    }>("POST", "/uploads/resume", undefined, { form });
  },
  attachResume: (candidateId: string, fileId: string, parsed: unknown) =>
    request<{ candidate: import("../types").Candidate }>("POST", `/candidates/${candidateId}/resume`, {
      fileId,
      parsed,
    }),

  fileUrl: (fileId: string) => `/api/files/${fileId}`,
};

export { list };
