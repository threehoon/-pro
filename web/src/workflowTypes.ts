export type WorkflowDecision = "advance" | "negotiate" | "reject";
export type AiStatus = "none" | "generating" | "ready" | "failed" | "manual";
export type Tier = "E" | "D" | "C" | "B" | "A";
export type ScreenTier = Tier | "unknown";
export type Verdict = "match" | "overqualified" | "mismatch";
export type OfferStatus = "negotiating" | "sent" | "accepted" | "declined";

export interface WorkflowFields {
  offer_status?: OfferStatus | null;
  screening_score?: number | null;
  screening_verdict?: Verdict | null;
  screening_unknown_weight?: number;
  screening_top_reason?: string | null;
  screening_has_summary?: boolean;
  screening_missing_gates?: string[];
  screening_status?: AiStatus | 'stale';
  summary_status?: AiStatus;
  interview_round?: number | null;
  composite_status?: AiStatus;
  next_interview_at?: string | null;
  hired_at?: string | null;
  expected_salary?: number | null;
  final_salary?: number | null;
  start_date?: string | null;
  reply_deadline?: string | null;
}

export interface AiResult<T> {
  ok: boolean;
  data?: T;
  dropped?: number;
  reason?: string;
}

export type DepartmentCode = "XS" | "YF" | "SC" | "CG" | "CW" | "RS" | "XZ" | "PZ" | "CC" | "GL";
export type JobLevelCode = "L1" | "L2" | "L3" | "L4" | "L5" | "L6";
export type CareerTraitCode = "A" | "B" | "C" | "D" | "E" | "F" | "G" | "H";

export interface ProfileMeta {
  code?: string;
  industry?: string;
  department_code?: DepartmentCode;
  department?: string;
  level?: JobLevelCode;
  level_name?: string;
  level_tagline?: string;
  location?: string;
}

export interface ProfileTraitMatch {
  code: CareerTraitCode;
  name?: string;
  combo?: string;
  reason: string;
}

export interface ProfileLabel {
  name: string;
  weight: number;
  tiers: Record<Tier, string>;
}
export interface ProfileContent {
  meta?: ProfileMeta;
  positioning: string;
  responsibilities?: string[];
  hard_gates: { condition: string; how: string }[];
  indicators: { name: string; weight: number; labels: ProfileLabel[] }[];
  trait_match?: ProfileTraitMatch;
  redlines: string[];
  bonus: string[];
  not_wanted: string[];
  compliance_rewritten?: boolean;
  weights_adjusted?: boolean;
}
export interface JobProfile {
  id: string;
  version: number;
  status: "draft" | "approved" | "failed";
  generatedBy: "ai" | "manual" | "fallback";
  approvedAt: string | null;
  content: ProfileContent;
}
export interface ProfileVersion {
  id: string;
  version: number;
}

export interface ProfileData {
  approvedProfile: ProfileVersion | null;
  profile: JobProfile | null;
  history: JobProfile[];
  status: AiStatus;
}

export interface ScreeningReview {
  id: string;
  profileId: string | null;
  profileVersion: number | null;
  score: number | null;
  verdict: Verdict | null;
  unknownWeight: number;
  missingGates: string[];
  redlineHit: string[];
  decision: "advance" | "reject" | null;
  reason: string | null;
  createdAt: string;
  detail: {
    source?: "ai" | "rules";
    resume_excerpts?: string[];
    skills_matched?: number | string[];
    skills_total?: number;
    years?: number | null;
    education?: string | null;
    top_reason?: string;
    reject_reason?: string;
    gates?: { condition: string; result: "pass" | "fail" | "unknown"; quote: string | null }[];
    labels?: { indicator: string; label: string; level: ScreenTier; quote: string | null }[];
    concerns?: { point: string; quote: string | null }[];
  };
}
export interface ScreeningData {
  approvedProfile: ProfileVersion | null;
  hasResumeText: boolean;
  review: ScreeningReview | null;
  history: ScreeningReview[];
  status: AiStatus;
}

export interface InterviewSummary {
  headline?: string;
  conclusion?: string;
  highlights?: { point: string; quote: string | null; at?: string | null }[];
  concerns?: { point: string; quote: string | null; at?: string | null }[];
  unanswered?: string[];
  indicators_checked?: { indicator: string; label: string; evidence: "strong" | "weak" | "none" }[];
  suggested?: WorkflowDecision;
  reason?: string;
}
export interface SummaryData {
  status: AiStatus;
  planStatus?: "generating" | "ready" | "none";
  summary: InterviewSummary | null;
  transcript?: string;
  plan?: { questions?: { question: string; listen_for: string; follow_up: string }[] } | null;
  model?: string | null;
  summarizedAt?: string | null;
}
export interface ComparativePoint {
  point: string;
  from: number[];
  evidence?: { round: number; quote: string }[];
}

export interface CompositeData {
  status: AiStatus;
  composite: {
    headline?: string;
    rounds?: { round: number; headline: string }[];
    confirmed?: ComparativePoint[];
    conflicts?: ComparativePoint[];
    uncovered?: { indicator: string; label: string; why: string }[];
    recommendation?: "proceed" | "reject";
    reason?: string;
  } | null;
}

export interface OfferInput {
  expected_salary?: number | null;
  final_salary?: number | null;
  start_date?: string | null;
  reply_deadline?: string | null;
  offer_letter?: string | null;
}
export interface OfferData {
  offer: (OfferInput & { id: string; status: OfferStatus; sent_at?: string | null; hired_at?: string | null }) | null;
  budget: { min: number | null; max: number | null };
  difference: number | null;
  openingSalary: number | null;
  script: string | null;
  template?: string | null;
}
export interface TodayItem {
  id: string;
  section: "offer" | "screening" | "interviews";
  title: string;
  reason: string;
  applicationId?: string;
  interviewId?: string | null;
  jobId?: string;
  candidateId?: string;
}
export interface AsrConfig {
  baseUrl: string;
  model: string;
  /** 固定语种能明显减少转写乱码，auto 表示交给服务商判断。 */
  language: string;
  keyTail: string | null;
  configured: boolean;
}

/** 录音转写的中间结果：只回文字，等人工核对后才会保存成逐字稿。 */
export interface TranscriptDraft {
  text: string;
  model: string;
  chars: number;
  truncated: boolean;
  durationSeconds: number | null;
}

export interface LlmConfig {
  baseUrl: string;
  model: string;
  keyTail: string | null;
  configured: boolean;
  /** 是否允许模型深入思考：更慢更贵，默认关闭。 */
  thinking: "off" | "on";
  tokensIn: number;
  tokensOut: number;
  /** 本月花在隐藏推理上的输出 token，与正文分开记账。 */
  reasoningTokens: number;
  /** 本月命中服务商前缀缓存的输入 token。 */
  cachedTokens: number;
}
