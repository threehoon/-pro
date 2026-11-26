import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../lib/api";
import { fmtDate, salaryText, stageColor, timeAgo } from "../lib/format";
import { Link } from "../lib/router";
import { applicationTarget, candidateLink, workflowStage } from "../lib/workflow";
import type { Application, BoardCard, BoardData, Interview, JobDetail, Meta } from "../types";
import type { TodayItem } from "../workflowTypes";
import { Badge, Button, Card, EmptyState, ErrorState, ListSkeleton, PageHeader, SearchInput } from "../components/ui";
import { IconArrowUpRight, IconClock, IconEdit } from "../components/icons";
import { JobProfilePanel } from "../components/workflow/JobProfilePanel";
import { ResumeImport } from "../components/workflow/ResumeImport";
import { ApplicationDrawer } from "../components/workflow/ApplicationDrawer";
import { InterviewDrawer } from "../components/workflow/InterviewDrawer";
import { ScheduleInterviewModal } from "../components/workflow/ScheduleInterviewModal";
import { ArchiveReasonField } from "../components/workflow/ArchiveReasonField";
import { JobFormModal } from "./JobsPage";

export const JOB_TABS = [
  { key: "overview", label: "概览", hint: "这个职位进展到哪一步" },
  { key: "profile", label: "岗位画像", hint: "招什么人的标准" },
  { key: "screening", label: "简历筛选", hint: "谁该进面试" },
  { key: "interviews", label: "面试", hint: "每轮聊完的结论" },
  { key: "negotiation", label: "谈薪", hint: "钱谈没谈拢" },
  { key: "onboarding", label: "入职", hint: "人有没有来" },
] as const;

export type JobTabKey = (typeof JOB_TABS)[number]["key"];

// 旧书签 /jobs/:id/board 直接对应新的「简历筛选」，地址栏随后由 App 替换成规范路径。
const JOB_TAB_ALIASES: Partial<Record<string, JobTabKey>> = { board: "screening" };

export function jobTabKey(value: string): JobTabKey | null {
  const key = JOB_TAB_ALIASES[value] ?? value;
  const found = JOB_TABS.find((item) => item.key === key);
  return found ? found.key : null;
}

export function JobWorkspacePage({
  jobId,
  tab,
  meta,
  canWrite,
  onNotify,
}: {
  jobId: string;
  tab: JobTabKey;
  meta: Meta;
  canWrite: boolean;
  onNotify: () => void;
}) {
  const [job, setJob] = useState<JobDetail | null>(null);
  const [board, setBoard] = useState<BoardData | null>(null);
  const [today, setToday] = useState<TodayItem[]>([]);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  // 就地面板：筛选/谈薪共用一个投递抽屉，面试单独用面试抽屉。
  // 三个弹窗共用一份状态：慢网下先点的异步请求晚到，也不会再叠开第二个弹窗。
  const [modal, setModal] = useState<
    | { kind: "application"; id: string; focus: "screening" | "negotiation" | "onboarding" }
    | { kind: "interview"; interview: Interview }
    | { kind: "schedule"; application: Application; round: 1 | 2; draft?: Interview }
    | { kind: "edit" }
    | null
  >(null);
  const [actionError, setActionError] = useState("");

  const load = useCallback(() => {
    let active = true;
    Promise.all([api.job(jobId), api.board(jobId), api.today({ jobId })])
      .then(([jobData, boardData, todayData]) => {
        if (!active) return;
        setJob(jobData);
        setBoard(boardData);
        setToday(todayData.items);
        setError("");
      })
      .catch((err: unknown) => {
        if (active) setError(err instanceof ApiError ? err.message : "职位加载失败");
      });
    return () => {
      active = false;
    };
  }, [jobId]);

  useEffect(load, [load, revision]);

  const cards = useMemo(() => board?.columns.flatMap((column) => column.cards) ?? [], [board]);
  const byStep = useCallback(
    (step: string) => cards.filter((card) => workflowStage(card).key === step),
    [cards],
  );
  const screening = byStep("screening");
  const interviewing = byStep("interview");
  const negotiating = byStep("negotiation");
  const waitingEntry = byStep("pending");
  const hired = byStep("hired");

  // 正在筛选的候选人由服务端排队生成，页面按 1.8 秒轮询直到结果落地。
  const generating = cards.some((card) => card.screening_status === "generating");
  // 从候选人页点「岗位画像」进来时，把焦点放到画像面板，读屏用户不会丢失位置。
  const ready = Boolean(job && board);
  useEffect(() => {
    if (tab !== "profile" || !ready) return;
    document.getElementById("profile")?.focus();
  }, [tab, ready]);

  // 只在简历筛选子模块轮询：结果就在这一页出现，别在别的页面白刷请求。
  useEffect(() => {
    if (!generating || tab !== "screening") return;
    const timer = setInterval(() => setRevision((value) => value + 1), 1800);
    return () => clearInterval(timer);
  }, [generating, tab]);

  const counts: Record<JobTabKey, number | undefined> = {
    overview: undefined,
    profile: undefined,
    screening: screening.length,
    interviews: interviewing.length,
    negotiation: negotiating.length,
    onboarding: waitingEntry.length,
  };

  if (error) {
    return (
      <div className="page">
        <ErrorState message={error} onRetry={() => setRevision((value) => value + 1)} />
      </div>
    );
  }
  if (!job || !board) {
    return (
      <div className="page">
        <ListSkeleton rows={4} />
      </div>
    );
  }

  const refresh = () => {
    setRevision((value) => value + 1);
    onNotify();
  };

  // 职位关闭后只读：导入、批量、就地面板与安排面试都要一起收掉。
  const writable = canWrite && job.job.status !== "closed";

  // 安排复试需要先拿到该投递的草稿轮次；顺带把真实 Application 交给安排弹窗。
  async function openSchedule(card: BoardCard, round: 1 | 2) {
    setActionError("");
    try {
      const detail = await api.application(card.id);
      const draft = detail.interviews.find((item) => item.is_draft && item.round === round);
      // 请求期间用户可能已经打开别的弹窗，晚到的结果不再抢焦点。
      setModal((current) => (current ? current : { kind: "schedule", application: detail.application, round, draft }));
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "面试安排加载失败");
    }
  }

  return (
    <div className="page job-workspace">
      <nav className="breadcrumb" aria-label="当前位置">
        <Link to="/jobs">职位</Link>
        <span>/</span>
        <span>{job.job.title}</span>
      </nav>

      <PageHeader
        eyebrow={
          <span className="inline-tags">
            <Badge tone={job.job.status === "open" ? "brand" : job.job.status === "paused" ? "warning" : "neutral"}>
              {job.job.status === "open" ? "在招" : job.job.status === "paused" ? "暂停" : "已关闭"}
            </Badge>
            {job.job.department && <span className="muted">{job.job.department}</span>}
            {job.job.location && <span className="muted">{job.job.location}</span>}
          </span>
        }
        title={job.job.title}
        description={`${salaryText(job.job.salary_min, job.job.salary_max)} · 招 ${job.job.headcount} 人 · ${Math.max(0, job.stats.active - job.stats.hired)} 人在流程中 · ${job.stats.hired} 人已入职`}
        actions={
          canWrite ? (
            <Button onClick={() => setModal({ kind: "edit" })} icon={<IconEdit size={16} />}>
              编辑职位
            </Button>
          ) : null
        }
      />

      <nav className="subtabs" aria-label="职位流程">
        {JOB_TABS.map((item, index) => {
          const active = item.key === tab;
          const count = counts[item.key];
          return (
            <Link
              key={item.key}
              to={`/jobs/${encodeURIComponent(jobId)}/${item.key}`}
              className={`subtab ${active ? "active" : ""}`}
              aria-current={active ? "page" : undefined}
              title={item.hint}
            >
              <span className="subtab-step" aria-hidden>
                {index + 1}
              </span>
              <span className="subtab-label">{item.label}</span>
              {count != null && count > 0 && <span className="subtab-count">{count}</span>}
            </Link>
          );
        })}
      </nav>

      {actionError && (
        <p className="form-error" role="alert">
          {actionError}
        </p>
      )}

      {tab === "overview" && (
        <OverviewTab
          job={job}
          today={today}
          counts={{ screening: screening.length, interviewing: interviewing.length, negotiating: negotiating.length, waitingEntry: waitingEntry.length, hired: hired.length }}
          jobId={jobId}
          meta={meta}
        />
      )}

      {tab === "profile" && <JobProfilePanel jobId={jobId} canWrite={canWrite} />}

      {tab === "screening" && (
        <ScreeningTab
          jobId={jobId}
          cards={screening}
          rejected={board.rejected}
          approvedProfile={board.approvedProfile}
          canWrite={writable}
          rejectionReasons={meta.rejectionReasons}
          onOpen={(card) => setModal({ kind: "application", id: card.id, focus: "screening" })}
          onChanged={refresh}
        />
      )}

      {tab === "interviews" && (
        <InterviewsTab
          jobId={jobId}
          revision={revision}
          cards={interviewing}
          canWrite={writable}
          onOpenInterview={(interview) => setModal({ kind: "interview", interview })}
          onSchedule={(card, round) => void openSchedule(card, round)}
        />
      )}

      {tab === "negotiation" && (
        <QueueTab
          title="谈薪"
          description="定薪、生成 Offer、记录回复都在这里完成，不用切换页面。"
          empty="还没有人进入谈薪。面试结论为“进入谈薪”后会自动出现在这里。"
          cards={negotiating}
          actionLabel="谈薪"
          onOpen={(card) => setModal({ kind: "application", id: card.id, focus: "negotiation" })}
        />
      )}

      {tab === "onboarding" && (
        <OnboardingTab
          waitingEntry={waitingEntry}
          hired={hired}
          headcount={job.job.headcount}
          onOpen={(card) => setModal({ kind: "application", id: card.id, focus: "onboarding" })}
        />
      )}

      {modal?.kind === "application" && (
        <ApplicationDrawer
          applicationId={modal.id}
          focus={modal.focus}
          canWrite={writable}
          rejectionReasons={meta.rejectionReasons}
          onClose={() => setModal((current) => (current?.kind === "application" && current.id === modal.id ? null : current))}
          onChange={refresh}
        />
      )}

      {modal?.kind === "interview" && (
        <InterviewDrawer
          interview={modal.interview}
          canWrite={writable}
          rejectionReasons={meta.rejectionReasons}
          onClose={() => setModal((current) => (current?.kind === "interview" && current.interview.id === modal.interview.id ? null : current))}
          onChange={refresh}
        />
      )}

      {modal?.kind === "schedule" && (
        <ScheduleInterviewModal
          open
          applications={[modal.application]}
          round={modal.round}
          draft={modal.draft}
          candidateName={modal.application.candidate_name ?? "候选人"}
          meta={meta}
          onClose={() => setModal(null)}
          onDone={() => {
            setModal(null);
            refresh();
          }}
        />
      )}

      <JobFormModal
        open={modal?.kind === "edit"}
        job={job.job}
        meta={meta}
        onClose={() => setModal(null)}
        onSaved={() => {
          setModal(null);
          refresh();
        }}
      />
    </div>
  );
}

/* --------------------------------- 概览 ---------------------------------- */

function OverviewTab({
  job,
  today,
  counts,
  jobId,
  meta,
}: {
  job: JobDetail;
  today: TodayItem[];
  counts: { screening: number; interviewing: number; negotiating: number; waitingEntry: number; hired: number };
  jobId: string;
  meta: Meta;
}) {
  const active = Math.max(0, job.stats.active - job.stats.hired);
  const next = nextAction(counts, jobId, job.job.headcount);
  const progress = Math.min(100, Math.round((counts.hired / Math.max(1, job.job.headcount)) * 100));

  return (
    <>
      <Card className="overview-next">
        <div>
          <p className="overview-kicker">下一步</p>
          <h2>{next.title}</h2>
          <p className="muted">{next.description}</p>
        </div>
        <Link className={`btn btn-primary btn-md`} to={next.to}>
          {next.action}
          <IconArrowUpRight size={15} />
        </Link>
      </Card>

      <div className="overview-kpis">
        {[
          { label: "在流程中", value: active, to: `/jobs/${jobId}/screening`, tone: "" },
          { label: "待筛选", value: counts.screening, to: `/jobs/${jobId}/screening`, tone: "screening" },
          { label: "面试中", value: counts.interviewing, to: `/jobs/${jobId}/interviews`, tone: "interview" },
          { label: "已入职", value: `${counts.hired}/${job.job.headcount}`, to: `/jobs/${jobId}/onboarding`, tone: "hired" },
        ].map((kpi) => (
          <Link key={kpi.label} to={kpi.to} className="overview-kpi">
            <span className="overview-kpi-label">{kpi.label}</span>
            <strong>{kpi.value}</strong>
            <span className="overview-kpi-band" style={{ background: kpi.tone ? stageColor(kpi.tone) : "var(--line-strong)" }} aria-hidden />
          </Link>
        ))}
      </div>

      <Card>
        <header className="card-head">
          <h2>今日待办</h2>
          <span className="muted">{today.length ? `${today.length} 件` : "今天没有到期的动作"}</span>
        </header>
        {today.length === 0 ? (
          <p className="muted">有面试、待确认的总结或待回复的 Offer 时会出现在这里。</p>
        ) : (
          <ul className="overview-todo">
            {today.map((item) => (
              <li key={item.id}>
                <div>
                  <Link to={todayLink(item, jobId)}>{item.title}</Link>
                  <p className="muted">{item.reason}</p>
                </div>
                <Link className="text-link" to={todayLink(item, jobId)}>
                  去处理
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <div className="detail-grid">
        <Card>
          <header className="card-head">
            <h2>最近进入流程</h2>
            <Link to={`/jobs/${jobId}/screening`} className="text-link">
              看全部
            </Link>
          </header>
          {job.applicants.length === 0 ? (
            <EmptyState title="还没有候选人" description="到简历筛选上传第一份简历。" />
          ) : (
            <ul className="applicant-list">
              {job.applicants.slice(0, 5).map((item) => (
                <li key={item.id}>
                  <div>
                    <Link to={`/candidates/${item.candidate_id}`}>{item.candidate_name}</Link>
                    <p>{[item.current_title, item.current_company].filter(Boolean).join(" · ") || "资料待补充"}</p>
                  </div>
                  <Badge tone={item.status === "rejected" ? "danger" : "neutral"} dot>
                    {item.status === "rejected" ? "已归档" : meta.stageLabels[item.stage]}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <header className="card-head">
            <h2>招聘进度</h2>
            <span className="muted">
              {counts.hired}/{job.job.headcount} 已入职
            </span>
          </header>
          <div className="progress" role="img" aria-label={`招聘进度 ${progress}%`}>
            <span style={{ width: `${progress}%` }} />
          </div>
          <ul className="overview-flow">
            {[
              { label: "待筛选", value: counts.screening, key: "screening" },
              { label: "面试中", value: counts.interviewing, key: "interview" },
              { label: "谈薪", value: counts.negotiating, key: "offer" },
              { label: "待入职", value: counts.waitingEntry, key: "new" },
              { label: "已入职", value: counts.hired, key: "hired" },
            ].map((step) => (
              <li key={step.label}>
                <span className="legend-band" style={{ background: stageColor(step.key) }} aria-hidden />
                <strong>{step.value}</strong>
                <span>{step.label}</span>
              </li>
            ))}
          </ul>
          <details className="overview-jd">
            <summary>职位说明</summary>
            <div className="prose">
              <h3>职位描述</h3>
              <p>{job.job.description || "还没有填写职位描述。"}</p>
              <h3>任职要求</h3>
              <p>{job.job.requirements || "还没有填写任职要求。"}</p>
            </div>
          </details>
        </Card>
      </div>
    </>
  );
}

function nextAction(
  counts: { screening: number; interviewing: number; negotiating: number; waitingEntry: number; hired: number },
  jobId: string,
  headcount: number,
) {
  if (counts.screening > 0) {
    return {
      title: `有 ${counts.screening} 份简历等你决定`,
      description: "AI 已经给出总结和建议，你只需要选“进面试”或“归档”。",
      action: "去筛选",
      to: `/jobs/${jobId}/screening`,
    };
  }
  if (counts.interviewing > 0) {
    return {
      title: `${counts.interviewing} 人在面试中`,
      description: "安排下一轮，或者在聊完后贴入逐字稿让 AI 出总结。",
      action: "去面试",
      to: `/jobs/${jobId}/interviews`,
    };
  }
  if (counts.negotiating > 0) {
    return {
      title: `${counts.negotiating} 人在谈薪`,
      description: "确认期望薪资、定薪并发出 Offer。",
      action: "去谈薪",
      to: `/jobs/${jobId}/negotiation`,
    };
  }
  if (counts.waitingEntry > 0) {
    return {
      title: `${counts.waitingEntry} 人等入职`,
      description: "跟进回复和到岗时间，到岗后确认入职。",
      action: "去入职",
      to: `/jobs/${jobId}/onboarding`,
    };
  }
  if (counts.hired >= headcount) {
    return {
      title: "这个职位已经招满",
      description: `${counts.hired}/${headcount} 人已入职，可以关闭职位。`,
      action: "查看入职",
      to: `/jobs/${jobId}/onboarding`,
    };
  }
  return {
    title: "先上传第一份简历",
    description: "这个职位还没有候选人。上传简历后，AI 会按已确认的岗位画像给出总结。",
    action: "去筛选",
    to: `/jobs/${jobId}/screening`,
  };
}

function todayLink(item: TodayItem, jobId: string): string {
  const section = item.section === "screening" ? "screening" : item.section === "offer" ? "offer" : "interviews";
  if (!item.candidateId) return `/jobs/${encodeURIComponent(jobId)}/${section === "screening" ? "screening" : section === "offer" ? "negotiation" : "interviews"}`;
  return candidateLink(item.candidateId, item.applicationId, section);
}

/* -------------------------------- 简历筛选 -------------------------------- */

const BATCH_LIMIT = 3;

function ScreeningTab({
  jobId,
  cards,
  rejected,
  approvedProfile,
  canWrite,
  rejectionReasons,
  onOpen,
  onChanged,
}: {
  jobId: string;
  cards: BoardCard[];
  rejected: BoardCard[];
  approvedProfile: BoardData["approvedProfile"];
  canWrite: boolean;
  rejectionReasons: string[];
  onOpen: (card: BoardCard) => void;
  onChanged: () => void;
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [archiveReason, setArchiveReason] = useState("");
  const [busy, setBusy] = useState("");
  const [report, setReport] = useState<{ done: number; failed: Array<{ name: string; reason: string }> } | null>(null);

  // 名字带「还没生成总结」的排在后面：需要人立刻处理的是「等你看」和「筛选失败」。
  const visible = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    const filtered = keyword
      ? cards.filter((card) =>
          [card.candidate_name, card.current_title, card.current_company]
            .filter(Boolean)
            .some((value) => String(value).toLowerCase().includes(keyword)),
        )
      : cards;
    const rank = (card: BoardCard) => (card.screening_status === "failed" || card.screening_status === "stale" ? 0 : card.screening_has_summary ? 1 : 2);
    return [...filtered].sort((a, b) => rank(a) - rank(b) || new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
  }, [cards, query]);

  const picked = visible.filter((card) => selected.includes(card.id));
  const generatingCount = picked.filter((card) => card.screening_status === "generating").length;

  async function runBatch(decision: "advance" | "reject") {
    if (!picked.length) return;
    if (decision === "reject" && !archiveReason) return;
    setBusy(decision);
    setReport(null);
    const failures: Array<{ name: string; reason: string }> = [];
    let done = 0;
    const queue = [...picked];
    // 并发 3：几十份简历时比逐条快，又不至于把服务端事务压在一起。
    async function worker() {
      for (;;) {
        const card = queue.shift();
        if (!card) return;
        try {
          await api.decideScreening(card.id, decision, decision === "reject" ? archiveReason : undefined);
          done += 1;
        } catch (err) {
          failures.push({ name: card.candidate_name, reason: err instanceof ApiError ? err.message : "操作失败" });
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(BATCH_LIMIT, queue.length) }, worker));
    setBusy("");
    setReport({ done, failed: failures });
    setSelected([]);
    onChanged();
  }

  const allVisibleSelected = visible.length > 0 && visible.every((card) => selected.includes(card.id));
  const toggle = (cardId: string) =>
    setSelected((current) => (current.includes(cardId) ? current.filter((id) => id !== cardId) : [...current, cardId]));

  return (
    <>
      {canWrite && <ResumeImport key={jobId} jobId={jobId} approvedProfile={approvedProfile} onImported={onChanged} />}
      <Card>
        <header className="card-head">
          <h2>待筛选</h2>
          <span className="muted">{cards.length ? `${cards.length} 人` : "空"}</span>
        </header>
        {cards.length > 0 && (
          <div className="queue-tools">
            <SearchInput value={query} onChange={setQuery} placeholder="搜姓名、当前职位或公司" />
            {canWrite && (
              <div className="queue-batch">
                <label className="queue-check">
                  <input
                    type="checkbox"
                    checked={allVisibleSelected}
                    onChange={() => setSelected(allVisibleSelected ? [] : visible.map((card) => card.id))}
                  />
                  全选
                </label>
                <span className="muted">已选 {picked.length} 人</span>
                <Button size="sm" variant="primary" disabled={!picked.length || Boolean(busy)} loading={busy === "advance"} onClick={() => void runBatch("advance")}>
                  批量推进初试
                </Button>
                <Button size="sm" variant="danger" disabled={!picked.length || !archiveReason || Boolean(busy)} loading={busy === "reject"} onClick={() => void runBatch("reject")}>
                  批量归档
                </Button>
              </div>
            )}
          </div>
        )}
        {canWrite && picked.length > 0 && (
          <div className="queue-batch-reason">
            <ArchiveReasonField reasons={rejectionReasons} value={archiveReason} onChange={setArchiveReason} allowEmpty />
            <p className="muted">{archiveReason ? "批量归档时统一用这个原因。" : "选一个归档原因，才能批量归档。"}</p>
          </div>
        )}
        {generatingCount > 0 && (
          <p className="muted" role="status">
            选中的人里有 {generatingCount} 人 AI 总结还在生成，你可以先按自己的判断推进。
          </p>
        )}
        {report && (
          <p className={report.failed.length ? "queue-report queue-report-warn" : "queue-report"} role="status">
            已处理 {report.done} 人{report.failed.length ? `，失败 ${report.failed.length} 人：${report.failed.map((item) => `${item.name}（${item.reason}）`).join("、")}` : ""}
          </p>
        )}
        {visible.length === 0 ? (
          <EmptyState
            title={cards.length ? "没有匹配的人" : "没有待筛选的简历"}
            description={cards.length ? "换个关键词，或清空搜索。" : "上传简历，或者等待新投递。"}
            compact
          />
        ) : (
          <ul className="queue-list">
            {visible.map((card) => (
              <QueueRow
                key={card.id}
                card={card}
                canWrite={canWrite}
                checked={selected.includes(card.id)}
                onToggle={() => toggle(card.id)}
                onOpen={() => onOpen(card)}
                openLabel="看筛选"
              />
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <details className="rejected-block">
          <summary>
            <strong>已归档</strong>
            <span className="col-count">{rejected.length}</span>
          </summary>
          {rejected.length ? (
            <ul className="queue-list">
              {rejected.map((card) => (
                <QueueRow key={card.id} card={card} archived />
              ))}
            </ul>
          ) : (
            <p className="muted">暂无归档记录</p>
          )}
        </details>
      </Card>
    </>
  );
}

/* --------------------------------- 面试 ---------------------------------- */

function InterviewsTab({
  jobId,
  revision,
  cards,
  canWrite,
  onOpenInterview,
  onSchedule,
}: {
  jobId: string;
  revision: number;
  cards: BoardCard[];
  canWrite: boolean;
  onOpenInterview: (interview: Interview) => void;
  onSchedule: (card: BoardCard, round: 1 | 2) => void;
}) {
  const [items, setItems] = useState<Interview[] | null>(null);
  useEffect(() => {
    let active = true;
    api
      .interviews({ jobId })
      .then((data) => {
        if (active) setItems(data.items);
      })
      .catch(() => {
        if (active) setItems([]);
      });
    return () => {
      active = false;
    };
  }, [jobId, revision]);

  const roundOf = (card: BoardCard): 1 | 2 => ((card.interview_round ?? 0) >= 1 ? 2 : 1);

  return (
    <>
      <Card>
        <header className="card-head">
          <h2>面试安排</h2>
          <span className="muted">{items ? `${items.length} 场` : "加载中"}</span>
        </header>
        {!items ? (
          <ListSkeleton rows={2} />
        ) : items.length === 0 ? (
          <EmptyState title="还没有安排面试" description="在下面的人员里点「安排初试」，约好后会出现在这里。" compact />
        ) : (
          <ul className="interview-rows">
            {items.map((item) => (
              <li key={item.id}>
                <div className="interview-when">
                  <strong>{fmtDate(item.scheduled_at)}</strong>
                  <span className="muted">
                    第 {item.round} 轮 · {interviewModeText(item.mode)}
                  </span>
                </div>
                <div>
                  <button type="button" className="text-link queue-name-button" onClick={() => onOpenInterview(item)}>
                    {item.candidate_name ?? "候选人"}
                  </button>
                  <p className="muted">{item.interviewer_name ? `面试官 ${item.interviewer_name}` : "未指定面试官"}</p>
                </div>
                <Badge tone={item.status === "completed" ? "brand" : item.status === "scheduled" ? "neutral" : "danger"}>
                  {interviewStatusText(item.status)}
                </Badge>
                <Button size="sm" onClick={() => onOpenInterview(item)} disabled={!canWrite}>
                  贴逐字稿
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <header className="card-head">
          <h2>面试中</h2>
          <span className="muted">{cards.length ? `${cards.length} 人` : "空"}</span>
        </header>
        {cards.length === 0 ? (
          <EmptyState title="没有人在面试中" description="简历筛选通过后会出现在这里。" compact />
        ) : (
          <ul className="queue-list">
            {cards.map((card) => {
              const scheduled = (items ?? []).find(
                (item) => item.application_id === card.id && item.status === "scheduled" && !item.is_draft,
              );
              return (
                <QueueRow
                  key={card.id}
                  card={card}
                  canWrite={canWrite}
                  action={
                    canWrite ? (
                      <Button
                        size="sm"
                        variant="primary"
                        disabled={!items}
                        onClick={() => (scheduled ? onOpenInterview(scheduled) : onSchedule(card, roundOf(card)))}
                      >
                        {!items ? "读取中" : scheduled ? "贴逐字稿" : roundOf(card) === 2 ? "安排复试" : "安排初试"}
                      </Button>
                    ) : undefined
                  }
                />
              );
            })}
          </ul>
        )}
      </Card>
      <p className="muted workspace-hint">贴逐字稿、看 AI 总结、定去留都在本页完成。</p>
    </>
  );
}

function interviewModeText(mode: string) {
  if (mode === "phone") return "电话";
  if (mode === "video") return "视频";
  return "现场";
}

function interviewStatusText(status: string) {
  if (status === "scheduled") return "待进行";
  if (status === "completed") return "已完成";
  if (status === "no_show") return "未到";
  return "已取消";
}

/* ------------------------------ 谈薪 / 入职 ------------------------------- */

function QueueTab({
  title,
  description,
  empty,
  cards,
  actionLabel,
  onOpen,
}: {
  title: string;
  description: string;
  empty: string;
  cards: BoardCard[];
  actionLabel: string;
  onOpen: (card: BoardCard) => void;
}) {
  return (
    <Card>
      <header className="card-head">
        <h2>{title}</h2>
        <span className="muted">{cards.length ? `${cards.length} 人` : "空"}</span>
      </header>
      <p className="muted">{description}</p>
      {cards.length === 0 ? (
        <EmptyState title={empty} compact />
      ) : (
        <ul className="queue-list">
          {cards.map((card) => (
            <QueueRow key={card.id} card={card} onOpen={() => onOpen(card)} openLabel={actionLabel} />
          ))}
        </ul>
      )}
    </Card>
  );
}

function OnboardingTab({
  waitingEntry,
  hired,
  headcount,
  onOpen,
}: {
  waitingEntry: BoardCard[];
  hired: BoardCard[];
  headcount: number;
  onOpen: (card: BoardCard) => void;
}) {
  return (
    <>
      <QueueTab
        title="待入职"
        description="Offer 已发出或已接受，等对方到岗。到岗后在这里点「确认入职」。"
        empty="还没有待入职的人。"
        cards={waitingEntry}
        actionLabel="跟进入职"
        onOpen={onOpen}
      />
      <Card>
        <header className="card-head">
          <h2>已入职</h2>
          <span className="muted">
            {hired.length}/{headcount}
          </span>
        </header>
        {hired.length === 0 ? (
          <EmptyState title="还没有人入职" compact />
        ) : (
          <ul className="queue-list">
            {hired.map((card) => (
              <QueueRow key={card.id} card={card} />
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

/* --------------------------------- 队列行 --------------------------------- */

const screeningStatusText: Record<string, string> = {
  generating: "正在筛选",
  failed: "筛选失败，打开详情重试",
  stale: "画像已更新，打开详情重新筛选",
};

function QueueRow({
  card,
  archived,
  canWrite,
  checked,
  onToggle,
  onOpen,
  openLabel,
  action,
}: {
  card: BoardCard;
  archived?: boolean;
  canWrite?: boolean;
  checked?: boolean;
  onToggle?: () => void;
  onOpen?: () => void;
  openLabel?: string;
  action?: React.ReactNode;
}) {
  const step = workflowStage(card).key;
  const target = applicationTarget(card);
  const status = card.screening_status;
  const screeningHint = (status && screeningStatusText[status]) || (card.screening_has_summary ? "AI 简历总结可查看" : "待查看简历");
  return (
    <li className={`queue-row ${checked ? "queue-row-checked" : ""}`.trim()}>
      <div className="queue-main">
        {onToggle && canWrite !== false && (
          <label className="queue-check">
            <input type="checkbox" checked={Boolean(checked)} onChange={onToggle} />
            <span className="sr-only">选择 {card.candidate_name}</span>
          </label>
        )}
        <div className="queue-main-text">
          <Link to={candidateLink(card.candidate_id, card.id)} className="queue-name">
            {card.candidate_name}
          </Link>
          <p className="queue-sub">{[card.current_title, card.current_company].filter(Boolean).join(" · ") || "资料待补充"}</p>
        </div>
      </div>
      <div className="queue-meta">
        {archived ? (
          <span className="muted">{timeAgo(card.updated_at)} 归档</span>
        ) : step === "screening" ? (
          <span>{screeningHint}</span>
        ) : step === "interview" ? (
          <>
            <span>{card.interview_round ? `第 ${card.interview_round} 轮` : "待安排初试"}</span>
            {card.next_interview_at && (
              <span className="inline-icon">
                <IconClock size={13} /> {fmtDate(card.next_interview_at)}
              </span>
            )}
          </>
        ) : step === "hired" ? (
          <span>入职于 {fmtDate(card.start_date ?? card.hired_at ?? card.updated_at)}</span>
        ) : (
          <>
            {card.offer_status === "accepted" ? <Badge tone="brand">已接受</Badge> : card.offer_status === "sent" ? <Badge tone="warning">待回复</Badge> : null}
            {card.final_salary != null && <span>定薪 {card.final_salary.toLocaleString("zh-CN")}</span>}
            {card.start_date && <span>到岗 {fmtDate(card.start_date)}</span>}
          </>
        )}
      </div>
      {archived ? null : action ?? (onOpen ? (
        <Button size="sm" className="queue-action" onClick={onOpen}>
          {openLabel ?? target.label}
        </Button>
      ) : (
        <Link className="text-link queue-action" to={candidateLink(card.candidate_id, card.id, target.section)}>
          {target.label}
        </Link>
      ))}
    </li>
  );
}
