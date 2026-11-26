import { useEffect, useState } from "react";
import { api, ApiError } from "../lib/api";
import { fmtDateTime, fmtTime, initials, pct, stageColor, timeAgo } from "../lib/format";
import { Link } from "../lib/router";
import type { DashboardData, Meta, SessionUser } from "../types";
import { Avatar, Badge, Card, EmptyState, ErrorState, ListSkeleton, PageHeader, StageBadge } from "../components/ui";
import { IconArrowUpRight, IconChevronDown } from "../components/icons";

import { useWorkflowResource } from "../components/workflow/resource";
import { candidateLink } from "../lib/workflow";

export function DashboardPage({ meta, user }: { meta: Meta; user: SessionUser }) {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  function load() {
    setLoading(true);
    setError("");
    api
      .dashboard()
      .then(setData)
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : "工作台加载失败"))
      .finally(() => setLoading(false));
  }

  useEffect(load, []);

  const hour = new Date().getHours();
  const greeting =
    hour < 6 ? "夜深了" : hour < 9 ? "早上好" : hour < 11 ? "上午好" : hour < 13 ? "中午好" : hour < 18 ? "下午好" : "晚上好";
  const funnelMax = Math.max(1, ...(data?.funnel.map((item) => item.count) ?? [1]));

  return (
    <div className="page">
      <PageHeader
        eyebrow={new Date().toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "long" })}
        title={`${greeting}，${user.name}`}
        description="今天要推进的面试、卡住的简历，以及每个职位走到了哪一段。"
      />

      <TodayQueue />

      {loading && <ListSkeleton rows={4} />}
      {error && <ErrorState message={error} onRetry={load} />}

      {data && (
        <>
          <section className="kpi-row" aria-label="关键数字">
            <Kpi label="在招职位" value={data.kpis.openJobs} hint="正在开放" />
            <Kpi label="流程中候选人" value={data.kpis.activeCandidates} hint={`${data.funnel[0]?.count ?? 0} 位等待初筛`} />
            <Kpi label="今日面试" value={data.kpis.interviewsToday} hint={`还有 ${data.kpis.interviewsUpcoming} 场待进行`} />
            <Kpi label="近 30 天入职" value={data.kpis.hires30d} hint={`累计 ${data.funnel[data.funnel.length - 1]?.count ?? 0} 人在职`} />
          </section>

          <div className="dash-grid">
            <Card className="funnel-card">
              <header className="card-head">
                <h2>招聘漏斗</h2>
                <span className="muted">当前流程中的人数</span>
              </header>
              <ol className="funnel">
                {data.funnel.map((item) => (
                  <li key={item.stage}>
                    <div className="funnel-label">
                      <StageBadge label={item.label} color={stageColor(item.stage)} />
                      <strong>{item.count}</strong>
                    </div>
                    <div className="flow-track" aria-hidden>
                      <span
                        className="flow-fill"
                        style={{
                          width: `${pct(item.count, funnelMax)}%`,
                          background: stageColor(item.stage),
                        }}
                      />
                    </div>
                    <span className="funnel-hint">{meta.stageHints[item.stage]}</span>
                  </li>
                ))}
              </ol>
            </Card>

            <div className="stack">
              <Card>
                <header className="card-head">
                  <h2>今日面试</h2>
                  <Link to="/interviews" className="text-link">
                    全部日程 <IconArrowUpRight size={14} />
                  </Link>
                </header>
                {data.todayInterviews.length === 0 ? (
                  <EmptyState title="今天没有面试" description="安排一场后，会按时间出现在这里。" />
                ) : (
                  <ul className="agenda">
                    {data.todayInterviews.map((item) => (
                      <li key={item.id}>
                        <span className="agenda-time">{fmtTime(item.scheduled_at)}</span>
                        <span className="agenda-band" style={{ background: stageColor("interview") }} aria-hidden />
                        <div>
                          <strong>{item.candidate_name}</strong>
                          <p>
                            {item.job_title} · 第 {item.round} 轮 · {meta.interviewModeLabels[item.mode] ?? item.mode}
                          </p>
                        </div>
                        <span className="muted">{item.interviewer_name ?? "待定面试官"}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>

              <Card>
                <header className="card-head">
                  <h2>需要跟进</h2>
                  <span className="muted">超过 5 天没动作</span>
                </header>
                {data.stale.length === 0 ? (
                  <EmptyState compact title="没有积压" description="新简历和筛选中的候选人都在 5 天内有过更新。" />
                ) : (
                  <ul className="stale-list">
                    {data.stale.map((item) => (
                      <li key={item.application_id}>
                        <Avatar name={item.candidate_name} />
                        <div>
                          <Link to={`/candidates/${item.candidate_id}`}>{item.candidate_name}</Link>
                          <p>
                            {item.job_title} · {meta.stageLabels[item.stage]}
                          </p>
                        </div>
                        <Badge tone="warning">{item.days_waiting} 天</Badge>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </div>
          </div>

          <div className="dash-grid">
            <Card>
              <header className="card-head">
                <h2>职位进度</h2>
                <Link to="/jobs" className="text-link">
                  职位列表
                </Link>
              </header>
              {data.jobBreakdown.length === 0 ? (
                <EmptyState title="还没有在招职位" description="先创建一个职位，候选人才能进入流程。" />
              ) : (
                <ul className="job-progress">
                  {data.jobBreakdown.map((job) => (
                    <li key={job.id}>
                        <div className="job-progress-head">
                          <Link to={`/jobs/${job.id}`}>{job.title}</Link>
                          <span>
                            {job.hired_count}/{job.headcount} 已入职
                          </span>
                        </div>
                        <div className="flow-track thin" aria-label={`已入职 ${job.hired_count} 人，目标 ${job.headcount} 人`}>
                          <span
                            className="flow-fill brand"
                            style={{ width: `${pct(job.hired_count, Math.max(1, job.headcount))}%` }}
                          />
                        </div>
                        <p className="muted">
                          {job.department ?? "未分部门"} · {job.active_count} 人进行中
                          {job.new_count ? ` · ${job.new_count} 份新简历` : ""}
                        </p>
                      </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card>
              <header className="card-head">
                <h2>最近动作</h2>
              </header>
              {data.activity.length === 0 ? (
                <EmptyState title="还没有操作记录" />
              ) : (
                <ul className="activity">
                  {data.activity.slice(0, 5).map((item) => (
                    <li key={item.id}>
                      <span className="activity-mark" aria-hidden>
                        {initials(item.actor_name).slice(0, 1)}
                      </span>
                      <p>
                        <strong>{item.actor_name ?? "系统"}</strong> {actionText(item.action)}
                      </p>
                      <time className="muted">{timeAgo(item.created_at)}</time>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>

          {data.sources.length > 0 && (
            <Card className="source-row">
              <div className="source-head">
                <h2>候选人来源</h2>
                <p className="muted">最近更新 {fmtDateTime(data.activity[0]?.created_at)}</p>
              </div>
              <ul className="source-chips">
                {data.sources.map((item) => (
                  <li key={item.source}>
                    <strong>{item.n}</strong>
                    <span>{item.source}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

function Kpi({ label, value, hint }: { label: string; value: number; hint: string }) {
  return (
    <article className="kpi">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{hint}</small>
    </article>
  );
}

function actionText(action: string): string {
  const map: Record<string, string> = {
    "job.create": "创建了职位",
    "job.update": "更新了职位",
    "job.delete": "删除了职位",
    "candidate.create": "添加了候选人",
    "candidate.update": "更新了候选人",
    "candidate.delete": "删除了候选人",
    "candidate.parse_apply": "上传并解析了简历",
    "candidate.resume_attach": "替换了简历",
    "application.create": "创建了投递",
    "application.move": "推进了阶段",
    "application.reject": "拒绝了候选人",
    "application.reopen": "恢复了投递",
    "application.note": "写了备注",
    "application.rate": "更新了评分",
    "interview.create": "安排了面试",
    "interview.update": "改了面试",
    "interview.complete": "完成了面试反馈",
    "interview.cancel": "取消了面试",
    "interview.no_show": "标记了未到场",
  };
  // 未知动作不把内部键直接暴露给用户
  return map[action] ?? "更新了记录";
}

function TodayQueue() {
  const { data, error, reload } = useWorkflowResource(api.today, false, "今日行动加载失败");
  const items = data?.items.slice(0, 5);

  return (
    <details className="card today-queue">
      <summary className="today-queue-summary">
        <h2>今日行动</h2>
        <span className="today-queue-indicator muted">
          {error ? "加载失败" : items ? `${items.length} 项` : "加载中…"}
          <IconChevronDown size={16} />
        </span>
      </summary>
      <div className="today-queue-body">
        {error ? <ErrorState message={error} onRetry={reload} /> : !items ? <ListSkeleton rows={2} /> : !items.length ? <EmptyState compact title="暂无待处理行动" /> : (
          <ul>
            {items.map((item) => {
              const section = item.section === "interviews" && item.interviewId ? `interview-${item.interviewId}` : item.section;
              const to = item.candidateId ? candidateLink(item.candidateId, item.applicationId, section) : item.jobId ? `/jobs/${item.jobId}/overview` : "/interviews";
              return (
                <li key={item.id}>
                  <div><strong>{item.title}</strong><p>{item.reason}</p></div>
                  <Link className="text-link" to={to} aria-label={`查看${item.title}`}>查看 <IconArrowUpRight size={14} /></Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </details>
  );
}
