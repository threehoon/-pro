import type { Stage } from "../types";

const stageVar: Record<Stage, string> = {
  new: "var(--stage-new)",
  screening: "var(--stage-screening)",
  interview: "var(--stage-interview)",
  offer: "var(--stage-offer)",
  hired: "var(--stage-hired)",
};

export function stageColor(stage: Stage | string): string {
  if (stage === "rejected") return "var(--stage-rejected)";
  return stageVar[stage as Stage] ?? "var(--ink-3)";
}

export function fmtDate(value?: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function fmtDateTime(value?: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return `${fmtDate(value)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fmtTime(value?: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fmtMonthDay(value?: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

export function weekday(value?: string | null): string {
  if (!value) return "";
  const names = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  const d = new Date(value);
  return names[d.getDay()] ?? "";
}

export function timeAgo(value?: string | null): string {
  if (!value) return "—";
  const diff = Date.now() - new Date(value).getTime();
  if (Number.isNaN(diff)) return "—";
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "刚刚";
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return fmtDate(value);
}

export function toLocalInput(value?: string | null): string {
  const d = value ? new Date(value) : new Date();
  const pad2 = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function isoFromLocal(value: string): string {
  return new Date(value).toISOString();
}

export function salaryText(min?: number | null, max?: number | null): string {
  if (min == null && max == null) return "薪资面议";
  const k = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}K` : `${n}`);
  if (min != null && max != null) return `${k(min)}–${k(max)}`;
  return min != null ? `${k(min)} 起` : `最高 ${k(max as number)}`;
}

export function initials(name?: string | null): string {
  if (!name) return "?";
  const trimmed = name.trim();
  if (!trimmed) return "?";
  if (/[\u4e00-\u9fa5]/.test(trimmed)) return trimmed.slice(-2);
  return trimmed
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

export function pct(part: number, total: number): number {
  if (!total) return 0;
  return Math.round((part / total) * 100);
}

export function bytesText(bytes?: number | null): string {
  if (!bytes) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** 面试标题：避免「第 1 轮 · 第 1 轮面试」重复 */
export function interviewTitle(title: string | null | undefined, round: number): string {
  const text = (title ?? "").trim();
  if (!text) return `第 ${round} 轮面试`;
  const match = text.match(/^第\s*\d+\s*轮/);
  if (match) return text;
  return `第 ${round} 轮 · ${text}`;
}
