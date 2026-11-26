import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../lib/api";
import { fmtDateTime, fmtMonthDay, fmtTime, stageColor, weekday } from "../lib/format";
import { Link } from "../lib/router";
import type { Interview, Meta } from "../types";
import {
  Avatar,
  Badge,
  Button,
  EmptyState,
  ErrorState,
  Field,
  Input,
  ListSkeleton,
  Modal,
  PageHeader,
  Select,
  Tabs,
  useToast,
} from "../components/ui";
import { IconChevronLeft, IconChevronRight, IconClock, IconMapPin, IconLink } from "../components/icons";

import { InterviewDrawer } from "../components/workflow/InterviewDrawer";
import { calendarSyncBadge, candidateLink, safeMeetingUrl } from "../lib/workflow";

const STATUS_LABEL: Record<string, string> = {
  scheduled: "待进行",
  completed: "已完成",
  cancelled: "已取消",
  no_show: "未到场",
};


// 标题若只是「第 N 轮面试」这类默认值，就别和轮次重复展示
function interviewLabel(item: Interview) {
  const round = `第 ${item.round} 轮`;
  const title = (item.title ?? "").trim();
  if (!title) return round;
  if (/^第\s*\d+\s*轮/.test(title)) return round;
  return `${round} · ${title}`;
}
function awaitingSummary(item: Interview) {
  return (item.status === "scheduled" || item.status === "completed") && !item.decision && new Date(item.scheduled_at).getTime() <= Date.now() && item.summary_status !== "ready" && item.summary_status !== "manual";
}

function startOfWeek(date: Date): Date {
  const copy = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const shift = (copy.getDay() + 6) % 7;
  copy.setDate(copy.getDate() - shift);
  return copy;
}

function addDays(date: Date, days: number): Date {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + days);
  return copy;
}

function dayKey(value: string | Date): string {
  const date = typeof value === "string" ? new Date(value) : value;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function InterviewsPage({ meta, canWrite }: { meta: Meta; canWrite: boolean }) {
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()));
  const [status, setStatus] = useState("");
  const [items, setItems] = useState<Interview[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [openedId, setOpenedId] = useState<string | null>(null);
  const [rescheduling, setRescheduling] = useState<Interview | null>(null);
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const toast = useToast();

  const from = weekStart.toISOString();
  const to = addDays(weekStart, 7).toISOString();

  const load = useCallback(() => {
    setLoading(true);
    setError("");
    api
      .interviews({ from, to })
      .then((data) => setItems(data.items.filter((item) => !item.is_draft)))
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : "面试安排加载失败"))
      .finally(() => setLoading(false));
  }, [from, to]);

  useEffect(load, [load]);

  const days = useMemo(() => {
    const todayKey = dayKey(new Date());
    return Array.from({ length: 7 }, (_, index) => {
      const date = addDays(weekStart, index);
      const key = dayKey(date);
      return {
        key,
        date,
        isToday: key === todayKey,
        items: items
          .filter((item) => dayKey(item.scheduled_at) === key && (!status || (status === "summary" ? awaitingSummary(item) : item.status === status)))
          .sort((a, b) => a.scheduled_at.localeCompare(b.scheduled_at)),
      };
    });
  }, [weekStart, items, status]);

  // 抽屉始终读取最新列表行，避免同步/取消后仍显示旧状态
  const opened = useMemo(() => items.find((item) => item.id === openedId) ?? null, [items, openedId]);
  const scheduled = items.filter((item) => item.status === "scheduled");
  const awaiting = items.filter(awaitingSummary);
  const filledDays = days.filter((day) => day.items.length > 0);

  async function act(interview: Interview, action: "cancel" | "no_show") {
    try {
      if (action === "cancel") await api.cancelInterview(interview.id);
      else await api.noShow(interview.id);
      toast.push(action === "cancel" ? "面试已取消" : "已标记未到场", "success");
      load();
    } catch (err) {
      toast.push(err instanceof ApiError ? err.message : "操作失败", "error");
    }
  }

  async function syncCalendar(interview: Interview) {
    setSyncingId(interview.id);
    const previousMeetingUrl = interview.meeting_url?.trim() || null;
    try {
      const res = await api.syncInterviewCalendar(interview.id);
      if (res.sync.ok) {
        const nextMeetingUrl = res.interview.meeting_url?.trim() || null;
        const backfilled = Boolean(nextMeetingUrl) && nextMeetingUrl !== previousMeetingUrl;
        toast.push(backfilled ? "已同步飞书日历并回填会议链接" : "已同步飞书日历", "success");
      } else {
        toast.push(res.sync.error || "飞书日历同步失败", "error");
      }
      load();
    } catch (err) {
      toast.push(err instanceof ApiError ? err.message : "日历同步失败", "error");
    } finally {
      setSyncingId(null);
    }
  }

  return (
    <div className="page">
      <PageHeader
        title="面试"
        description="查看每周面试、提问提纲与逐字稿，确认本轮决定。"
        actions={
          <div className="week-nav">
            <Button size="sm" icon={<IconChevronLeft size={15} />} onClick={() => setWeekStart((value) => addDays(value, -7))} aria-label="上一周" />
            <Button size="sm" onClick={() => setWeekStart(startOfWeek(new Date()))}>
              本周
            </Button>
            <Button size="sm" icon={<IconChevronRight size={15} />} onClick={() => setWeekStart((value) => addDays(value, 7))} aria-label="下一周" />
          </div>
        }
      />

      <div className="week-strip">
        <div className="week-range">
          <strong>
            {fmtMonthDay(from)} – {fmtMonthDay(to)}
          </strong>
          <span className="muted">
            本周 {items.length} 场 · 待进行 {scheduled.length} · 待总结 {awaiting.length}
          </span>
        </div>
        <Tabs
          value={status}
          onChange={setStatus}
          tabs={[
            { value: "", label: "全部" },
            { value: "scheduled", label: "待进行" },
            { value: "summary", label: "待总结" },
            { value: "completed", label: "已完成" },
            { value: "cancelled", label: "已取消" },
          ]}
        />
      </div>

      {loading && <ListSkeleton rows={5} />}
      {error && <ErrorState message={error} onRetry={load} />}

      {!loading && !error && filledDays.length === 0 && (
        <EmptyState
          title={status === "summary" ? "本周没有待总结的面试" : "这一周没有符合条件的面试"}
          description="已安排时间的面试会显示在这里。"
        />
      )}

      {!loading && !error && filledDays.length > 0 && (
        <div className="agenda-week">
          {filledDays.map((day) => (
            <section className={`agenda-day ${day.isToday ? "today" : ""}`} key={day.key}>
              <header className="agenda-day-head">
                <div className="agenda-date">
                  <strong>{fmtMonthDay(day.key)}</strong>
                  <span>
                    {weekday(day.key)}
                    {day.isToday ? " · 今天" : ""}
                  </span>
                </div>
                <span className="agenda-count">{day.items.length} 场</span>
              </header>

              <div className="agenda-body">
                {day.items.map((item) => {
                  const accent =
                    item.status === "completed"
                      ? stageColor("hired")
                      : item.status === "cancelled" || item.status === "no_show"
                        ? "var(--ink-3)"
                        : stageColor("interview");
                  return (
                    <article className={`agenda-row status-${item.status}`} key={item.id}>
                      <div className="agenda-time">
                        <strong>{fmtTime(item.scheduled_at)}</strong>
                        <span>{item.duration_minutes} 分钟</span>
                      </div>
                      <div className="agenda-rail" aria-hidden>
                        <span className="rail-dot" style={{ background: accent }} />
                      </div>
                      <div className="agenda-card">
                        <div className="agenda-main">
                          <div className="agenda-who">
                            <Avatar name={item.candidate_name ?? "?"} size={28} />
                            <div>
                              {item.candidate_id ? <Link to={candidateLink(item.candidate_id, item.application_id, "interviews")}>{item.candidate_name ?? "候选人"}</Link> : <strong>{item.candidate_name ?? "候选人"}</strong>}
                              <span className="muted">{interviewLabel(item)}</span>
                            </div>
                          </div>
                          <div className="agenda-meta">
                            {item.job_id && (
                              <Link className="agenda-job" to={`/jobs/${item.job_id}/interviews`}>
                                {item.job_title ?? "职位"}
                              </Link>
                            )}
                            <span className="inline-icon">
                              <IconClock size={13} /> {meta.interviewModeLabels[item.mode] ?? item.mode}
                            </span>
                            {item.location && (
                              <span className="inline-icon">
                                <IconMapPin size={13} /> {item.location}
                              </span>
                            )}
                            {(() => {
                              const link = item.status === "cancelled" ? null : safeMeetingUrl(item.meeting_url);
                              return link ? (
                                <a className="inline-icon" href={link} target="_blank" rel="noreferrer">
                                  <IconLink size={13} /> 会议链接
                                </a>
                              ) : null;
                            })()}
                            <span className="muted">{item.interviewer_name ? `面试官 ${item.interviewer_name}` : "面试官待定"}</span>
                          </div>
                        </div>

                        <div className="agenda-side">
                          <div className="agenda-badges">
                            <Badge tone={awaitingSummary(item) ? "warning" : item.status === "completed" ? "brand" : "neutral"}>
                              {awaitingSummary(item) ? "待总结" : STATUS_LABEL[item.status]}
                            </Badge>
                            {(() => {
                              const cal = calendarSyncBadge(item.calendar_sync_status);
                              if (!cal) return null;
                              const tip =
                                item.calendar_sync_status === "failed" && item.calendar_sync_error
                                  ? `失败原因：${item.calendar_sync_error}`
                                  : item.calendar_synced_at
                                    ? `同步于 ${fmtDateTime(item.calendar_synced_at)}`
                                    : undefined;
                              return (
                                <span title={tip}>
                                  <Badge tone={cal.tone}>{cal.label}</Badge>
                                </span>
                              );
                            })()}
                          </div>
                          <div className="agenda-actions">
                            <Button size="sm" variant={awaitingSummary(item) ? "primary" : undefined} onClick={() => setOpenedId(item.id)}>
                              {awaitingSummary(item) && canWrite ? "整理面试" : "查看面试"}
                            </Button>
                            {canWrite && item.calendar_sync_status === "failed" && (
                              <Button
                                size="sm"
                                loading={syncingId === item.id}
                                disabled={syncingId !== null && syncingId !== item.id}
                                onClick={() => void syncCalendar(item)}
                              >
                                重试同步日历
                              </Button>
                            )}
                            {canWrite && item.status === "scheduled" && <>
                              <Button size="sm" onClick={() => setRescheduling(item)}>改期</Button>
                              <Button size="sm" onClick={() => void act(item, "no_show")}>未到场</Button>
                              <Button size="sm" variant="ghost" onClick={() => void act(item, "cancel")}>取消</Button>
                            </>}
                          </div>
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      )}

      {opened && <InterviewDrawer key={opened.id} interview={opened} rejectionReasons={meta.rejectionReasons} canWrite={canWrite && opened.status === "scheduled"} onClose={() => { setOpenedId(null); load(); }} onChange={load} />}
      <RescheduleModal
        interview={rescheduling}
        meta={meta}
        onClose={() => setRescheduling(null)}
        onDone={() => {
          setRescheduling(null);
          load();
        }}
      />
    </div>
  );
}

function toInputValue(iso: string): string {
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function RescheduleModal({
  interview,
  meta,
  onClose,
  onDone,
}: {
  interview: Interview | null;
  meta: Meta;
  onClose: () => void;
  onDone: () => void;
}) {
  const [scheduledAt, setScheduledAt] = useState("");
  const [duration, setDuration] = useState(45);
  const [mode, setMode] = useState("video");
  const [location, setLocation] = useState("");
  const [meetingUrl, setMeetingUrl] = useState("");
  const [interviewers, setInterviewers] = useState<Array<{ id: string; name: string }>>([]);
  const [interviewerId, setInterviewerId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const toast = useToast();

  useEffect(() => {
    if (!interview) return;
    setScheduledAt(toInputValue(interview.scheduled_at));
    setDuration(interview.duration_minutes);
    setMode(interview.mode);
    setLocation(interview.location ?? "");
    setMeetingUrl(interview.meeting_url ?? "");
    setInterviewerId(interview.interviewer_id ?? "");
    setError("");
    api.team().then((data) => setInterviewers(data.items)).catch(() => setInterviewers([]));
  }, [interview]);

  async function submit() {
    if (!interview) return;
    if (!scheduledAt) {
      setError("请选择新的时间");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api.updateInterview(interview.id, {
        scheduledAt: new Date(scheduledAt).toISOString(),
        durationMinutes: duration,
        mode,
        location: mode === "onsite" ? location.trim() : undefined,
        meetingUrl: mode === "video" ? meetingUrl.trim() : undefined,
        interviewerId: interviewerId || null,
      });
      toast.push("面试已改期", "success");
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "改期失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={Boolean(interview)}
      onClose={onClose}
      title="调整面试安排"
      description={interview ? `${interview.candidate_name ?? ""} · 第 ${interview.round} 轮` : ""}
      width={520}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" loading={busy} onClick={() => void submit()}>
            保存
          </Button>
        </>
      }
    >
      <div className="form-grid">
        <Field label="面试时间" required>
          {(id) => <Input id={id} type="datetime-local" value={scheduledAt} onChange={(event) => setScheduledAt(event.target.value)} />}
        </Field>
        <Field label="时长（分钟）">
          {(id) => (
            <Select id={id} value={duration} onChange={(event) => setDuration(Number(event.target.value))}>
              {[30, 45, 60, 90].map((value) => (
                <option key={value} value={value}>
                  {value} 分钟
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="形式">
          {(id) => (
            <Select id={id} value={mode} onChange={(event) => setMode(event.target.value as Interview["mode"])}>
              {Object.entries(meta.interviewModeLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="面试官">
          {(id) => (
            <Select id={id} value={interviewerId} onChange={(event) => setInterviewerId(event.target.value)}>
              <option value="">待定</option>
              {interviewers.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {mode === "onsite" ? (
          <Field label="面试地点" span>
            {(id) => <Input id={id} value={location} onChange={(event) => setLocation(event.target.value)} />}
          </Field>
        ) : (
          <Field label="会议链接" hint="留空时若已接通飞书日历，将自动生成飞书视频会议链接" span>
            {(id) => (
              <Input
                id={id}
                value={meetingUrl}
                placeholder="留空自动生成，或填写飞书/腾讯会议链接"
                onChange={(event) => setMeetingUrl(event.target.value)}
              />
            )}
          </Field>
        )}
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </Modal>
  );
}
