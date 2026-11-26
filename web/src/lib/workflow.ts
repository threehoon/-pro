import type { Application, CalendarSyncStatus, Interview, Stage } from "../types";
import type { Verdict, WorkflowFields } from "../workflowTypes";

export const boardStages = [
  { key: "screening", label: "待筛选", hint: "核对简历和岗位要求", color: "screening" },
  { key: "interview", label: "面试中", hint: "安排面试和记录本轮结论", color: "interview" },
  { key: "negotiation", label: "谈薪", hint: "确认期望、定薪与 Offer", color: "offer" },
  { key: "pending", label: "待入职", hint: "跟进回复和到岗时间", color: "new" },
  { key: "hired", label: "已入职", hint: "已确认到岗", color: "hired" },
] as const;
type WorkflowStage = typeof boardStages[number];

export const verdictLabels: Record<Verdict, string> = {
  match: "符合",
  mismatch: "不符",
  overqualified: "超配",
};

export function workflowStage(row: WorkflowFields & { stage: Stage }): WorkflowStage {
  switch (row.stage) {
    case "new":
    case "screening": return boardStages[0];
    case "interview": return boardStages[1];
    case "offer": return row.offer_status === "sent" || row.offer_status === "accepted" ? boardStages[3] : boardStages[2];
    case "hired": return boardStages[4];
  }
}

export function candidateLink(candidateId: string, applicationId?: string, section?: string) {
  const query = applicationId ? `?application=${encodeURIComponent(applicationId)}` : "";
  return `/candidates/${encodeURIComponent(candidateId)}${query}${section ? `#${section}` : ""}`;
}

export function applicationTarget(application: Pick<Application, "stage" | "status"> & WorkflowFields) {
  switch (workflowStage(application).key) {
    case "screening": return { section: "screening", label: "查看筛选" };
    case "interview": return {
      section: "interviews",
      label: application.composite_status === "ready" || application.composite_status === "manual"
        ? "查看综合评估"
        : application.next_interview_at ? "查看面试" : "查看面试流程",
    };
    case "negotiation": return { section: "offer", label: "查看谈薪" };
    case "pending": return { section: "offer", label: "跟进入职" };
    case "hired": return { section: "applications", label: "查看记录" };
  }
}

export function compareRounds(a: Interview, b: Interview) {
  return a.round - b.round || a.scheduled_at.localeCompare(b.scheduled_at);
}

export function apiMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

/** 只有 http(s) 链接才可直接渲染为可点击会议入口，避免 javascript: 等协议注入。 */
export function safeMeetingUrl(url: string | null | undefined): string | null {
  const raw = url?.trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : null;
  } catch {
    return null;
  }
}

export function calendarSyncBadge(
  status: CalendarSyncStatus | undefined,
): { label: string; tone: "neutral" | "brand" | "warning" | "danger" } | null {
  if (!status || status === "none") return null;
  if (status === "synced") return { label: "已同步飞书日历", tone: "brand" };
  if (status === "pending") return { label: "日历同步中", tone: "neutral" };
  return { label: "日历同步失败", tone: "danger" };
}
