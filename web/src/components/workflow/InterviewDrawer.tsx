import { useCallback, useEffect, useState } from "react";
import { Badge, Button, ErrorState, Field, Input, ListSkeleton, Modal, Select, Textarea, useConfirm } from "../ui";
import { api } from "../../lib/api";
import { fmtDateTime, interviewTitle } from "../../lib/format";
import { apiMessage, calendarSyncBadge, safeMeetingUrl } from "../../lib/workflow";
import type { Interview } from "../../types";
import type { AiStatus, ComparativePoint, WorkflowDecision } from "../../workflowTypes";
import { requireAiResult, useWorkflowResource } from "./resource";
import { ArchiveReasonField, defaultArchiveReason } from "./ArchiveReasonField";

const summaryLabels: Record<AiStatus, string> = { none: "待总结", generating: "总结生成中", ready: "总结已就绪", failed: "总结失败", manual: "人工结论" };
const decisions = { advance: "进入复试", negotiate: "进入谈薪", reject: "归档投递" } as const;
const finished = (status: AiStatus | undefined) => status === "ready" || status === "manual";

export function InterviewDrawer({ interview, canWrite, rejectionReasons, onClose, onChange }: { interview: Interview; canWrite: boolean; rejectionReasons: string[]; onClose: () => void; onChange: () => void }) {
  const [poll, setPoll] = useState(false);
  const [pollPlan, setPollPlan] = useState(false);
  const [pollComposite, setPollComposite] = useState(false);
  const [transcript, setTranscript] = useState<string | null>(null);
  const [conclusion, setConclusion] = useState("");
  const [showManual, setShowManual] = useState(false);
  const [decision, setDecision] = useState<WorkflowDecision>(interview.round === 1 ? "advance" : "negotiate");
  const [archiveReason, setArchiveReason] = useState(() => defaultArchiveReason(rejectionReasons));
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [liveInterview, setLiveInterview] = useState<Interview>(interview);
  // 父级刷新后传入新行时同步本地快照，避免日历徽标与会议链接停留在旧状态
  useEffect(() => {
    setLiveInterview(interview);
  }, [interview]);
  const confirm = useConfirm();
  const fetchSummary = useCallback(async () => {
    const result = await api.interviewSummary(interview.id);
    setPoll(result.data?.status === "generating");
    setPollPlan(result.data?.planStatus === "generating");
    return result;
  }, [interview.id]);
  const fetchComposite = useCallback(async () => {
    const result = interview.round > 1 ? await api.composite(interview.application_id) : null;
    setPollComposite(result?.data?.status === "generating");
    return result;
  }, [interview.application_id, interview.round]);
  const resource = useWorkflowResource(fetchSummary, poll || pollPlan, "本轮记录加载失败");
  const compositeResource = useWorkflowResource(fetchComposite, pollComposite || (interview.round > 1 && poll), "综合评估加载失败");
  const data = resource.data?.data;
  const compositeData = compositeResource.data?.data;
  const status = data?.status ?? interview.summary_status ?? "none";
  const cancelled = interview.status === "cancelled" || interview.status === "no_show";
  const canSummarize = canWrite && !interview.is_draft && !cancelled;
  const canDecide = canSummarize && !interview.decision;
  const source = transcript ?? data?.transcript ?? interview.transcript ?? "";
  const summary = data?.summary;
  const composite = compositeData?.composite;
  const needsComposite = interview.round > 1 && decision === "negotiate";
  const needsOverride = needsComposite && (compositeData?.status === "none" || compositeData?.status === "failed");
  const waiting = decision !== "reject" && (!finished(status) || (needsComposite && !finished(compositeData?.status) && !needsOverride));

  async function run(action: string, task: () => Promise<void>) {
    setBusy(action);
    setError("");
    setNotice("");
    try {
      await task();
      resource.reload();
      compositeResource.reload();
    } catch (err) {
      setError(apiMessage(err, "面试操作失败"));
      resource.reload();
    } finally {
      setBusy("");
    }
  }

  async function decide() {
    const title = decision === "reject" ? "归档这条投递？" : needsOverride ? "在评估未就绪时推进？" : "确认本轮决定？";
    const description = decision === "reject" ? "投递将从招聘流程移至已归档。" : needsOverride ? "当前评估未完成。确认后将记录这次人工决定。" : decision === "advance" ? "系统将建立待安排的复试草稿。" : "系统将建立谈薪记录。";
    if (!(await confirm({ title, description, confirmLabel: decisions[decision], tone: decision === "reject" ? "danger" : undefined }))) return;
    void run("decision", async () => {
      await api.decideInterview(interview.id, decision, { reason: decision === "reject" ? archiveReason : undefined, allowWithoutSummary: needsOverride });
      onClose();
      onChange();
    });
  }

  const calBadge = calendarSyncBadge(liveInterview.calendar_sync_status);
  const meetingUrl = liveInterview.status === "cancelled" ? null : safeMeetingUrl(liveInterview.meeting_url);

  async function syncCalendar() {
    setBusy("calendar");
    setError("");
    setNotice("");
    const previousMeetingUrl = liveInterview.meeting_url?.trim() || null;
    try {
      const res = await api.syncInterviewCalendar(liveInterview.id);
      setLiveInterview(res.interview);
      if (res.sync.ok) {
        const nextMeetingUrl = res.interview.meeting_url?.trim() || null;
        // 只有此前没有链接、这次才拿到飞书自动生成的链接时，才说「回填」
        const backfilled = Boolean(nextMeetingUrl) && nextMeetingUrl !== previousMeetingUrl;
        setNotice(backfilled ? "已同步飞书日历并回填飞书视频会议链接。" : "已同步到飞书日历。");
      } else {
        setError(res.sync.error || "飞书日历同步失败");
      }
      onChange();
    } catch (err) {
      setError(apiMessage(err, "飞书日历同步失败"));
    } finally {
      setBusy("");
    }
  }

  return <Modal open onClose={onClose} variant="drawer" width={640} title={interviewTitle(liveInterview.title, liveInterview.round)}
    description={[liveInterview.candidate_name, liveInterview.job_title, liveInterview.is_draft ? "复试待安排" : fmtDateTime(liveInterview.scheduled_at)].filter(Boolean).join(" · ")}>
    <div className="workflow-stack interview-drawer">
      {!liveInterview.is_draft && (meetingUrl || calBadge) && (
        <section className="interview-sync-bar">
          <div className="interview-sync-main">
            {calBadge && <Badge tone={calBadge.tone}>{calBadge.label}</Badge>}
            {meetingUrl && (
              <a className="interview-sync-link" href={meetingUrl} target="_blank" rel="noreferrer">
                打开会议链接
              </a>
            )}
            {liveInterview.calendar_synced_at && liveInterview.calendar_sync_status === "synced" && (
              <span className="muted">同步于 {fmtDateTime(liveInterview.calendar_synced_at)}</span>
            )}
          </div>
          {canWrite && calBadge && (
            <Button size="sm" loading={busy === "calendar"} disabled={!!busy} onClick={() => void syncCalendar()}>
              {liveInterview.calendar_sync_status === "failed" ? "重试同步日历" : "重新同步日历"}
            </Button>
          )}
          {liveInterview.calendar_sync_status === "failed" && liveInterview.calendar_sync_error && (
            <p className="form-error interview-sync-error" role="alert">
              日历同步失败：{liveInterview.calendar_sync_error}
            </p>
          )}
        </section>
      )}
      {!resource.data && !resource.error && <ListSkeleton rows={2} />}
      {resource.error && <ErrorState message={resource.error} onRetry={resource.reload} />}
      {pollPlan && <p className="muted" role="status">正在准备本轮提问提纲…</p>}
      {data?.plan?.questions?.length ? <details className="workflow-disclosure"><summary>本轮提问提纲</summary><ol className="workflow-evidence">
        {data.plan.questions.map((item, i) => <li key={i}><strong>{item.question}</strong><p className="muted">关注：{item.listen_for}</p><p>追问：{item.follow_up}</p></li>)}
      </ol></details> : null}
      {!interview.is_draft && <section className="workflow-stack">
        <div className="workflow-section-head"><h3>本轮总结</h3><Badge tone={status === "failed" ? "danger" : finished(status) ? "brand" : "neutral"}>{summaryLabels[status]}</Badge></div>
        {status === "generating" && <p className="muted" role="status">正在从逐字稿提取证据…</p>}
        {status === "failed" && <p className="form-error" role="alert">{resource.data?.reason || "总结生成失败，可以重试或写一句结论。"}</p>}
        {summary && <div className="workflow-stack">
          {(summary.headline || summary.conclusion) && <p className="workflow-lead">{summary.headline || summary.conclusion}</p>}
          <Evidence title="亮点" items={summary.highlights} />
          <Evidence title="顾虑" items={summary.concerns} />
          {!!summary.unanswered?.length && <div><h4>下轮追问</h4><ul>{summary.unanswered.map((item, i) => <li key={i}>{item}</li>)}</ul></div>}
          {summary.suggested && <p><strong>建议：{decisions[summary.suggested]}</strong>{summary.reason && ` · ${summary.reason}`}</p>}
        </div>}
        {(canSummarize || source) && <details className="workflow-disclosure" open={canSummarize && status === "none" ? true : undefined}><summary>面试逐字稿</summary>
          <Field label="逐字稿" hint={canSummarize ? `当前 ${source.trim().length} 字 · 至少 200 字，超出 12,000 字部分会截断用于生成。` : undefined}>{(id) => <Textarea id={id} rows={8} value={source} readOnly={!canSummarize} onChange={(e) => setTranscript(e.target.value)} />}</Field>
          {canSummarize && <Button loading={busy === "transcript"} disabled={!!busy || !data || source.trim().length < 200 || poll} onClick={() => void run("transcript", async () => {
            const { data: result, reason: hint } = await api.saveTranscript(interview.id, source);
            if (!result) throw new Error(hint || "逐字稿保存失败");
            setTranscript(null);
            setPoll(result.summaryStatus === "generating");
            const saved = result.truncated ? "逐字稿已保存，生成时使用前 12,000 字。" : "逐字稿已保存。";
            setNotice(hint ? `${saved} ${hint}` : saved);
          })}>保存逐字稿并生成</Button>}
        </details>}
        {canSummarize && !poll && data && <div className="workflow-actions">
          {status === "failed" && source.trim().length >= 200 && <Button loading={busy === "retry"} disabled={!!busy} onClick={() => void run("retry", async () => {
            const result = requireAiResult(await api.retrySummary(interview.id), "重试失败");
            setPoll(result.status === "generating");
          })}>重试生成</Button>}
          {(status === "failed" || status === "none" || status === "manual") && <Button disabled={!!busy} onClick={() => setShowManual((value) => !value)}>{showManual ? "收起人工结论" : "写一句结论"}</Button>}
        </div>}
        {canSummarize && showManual && <div className="workflow-stack">
          <Field label="本轮结论">{(id) => <Input id={id} maxLength={500} value={conclusion} onChange={(e) => setConclusion(e.target.value)} />}</Field>
          <Button loading={busy === "manual"} disabled={!!busy || !conclusion.trim()} onClick={() => void run("manual", async () => {
            requireAiResult(await api.manualSummary(interview.id, conclusion.trim()), "人工结论保存失败");
            setShowManual(false);
          })}>保存人工结论</Button>
        </div>}
      </section>}
      {!interview.is_draft && interview.round > 1 && <section className="workflow-stack">
        <div className="workflow-section-head"><h3>两轮综合评估</h3>{compositeData && <Badge>{summaryLabels[compositeData.status]}</Badge>}</div>
        {!compositeResource.data && !compositeResource.error && <ListSkeleton rows={1} />}
        {compositeResource.error && <ErrorState message={compositeResource.error} onRetry={compositeResource.reload} />}
        {compositeData?.status === "none" && <p className="muted">本轮总结就绪后自动生成综合评估。</p>}
        {pollComposite && <p className="muted" role="status">正在综合两轮面试记录…</p>}
        {compositeData?.status === "failed" && <p className="form-error" role="alert">{compositeResource.data?.reason || "综合评估生成失败。"}</p>}
        {composite?.headline && <p className="workflow-lead">{composite.headline}</p>}
        {composite?.rounds?.map((round) => <p key={round.round}>第 {round.round} 轮 · {round.headline}</p>)}
        <ComparativeEvidence title="两轮确认" items={composite?.confirmed} />
        <ComparativeEvidence title="两轮分歧" items={composite?.conflicts} />
        <Evidence title="仍待核实" items={composite?.uncovered?.map((item) => ({ point: `${item.indicator} · ${item.label}`, quote: item.why }))} />
        {composite?.recommendation && <p><strong>建议：{composite.recommendation === "proceed" ? "进入谈薪" : "归档投递"}</strong>{composite.reason && ` · ${composite.reason}`}</p>}
        {canSummarize && compositeData?.status === "failed" && <Button loading={busy === "composite"} disabled={!!busy} onClick={() => void run("composite", async () => {
          const result = requireAiResult(await api.retryComposite(interview.application_id), "综合评估重试失败");
          setPollComposite(result.status === "generating");
        })}>重试综合评估</Button>}
      </section>}
      {interview.decision && <p className="muted">本轮已决定：{decisions[interview.decision]}</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {canDecide && data && <section className="workflow-stack">
        <h3>本轮决定</h3>
        <div className="form-grid">
          <Field label="下一步">{(id) => <Select id={id} value={decision} onChange={(e) => {
            const next = e.target.value;
            if (next === "advance" || next === "negotiate" || next === "reject") setDecision(next);
          }}>{interview.round === 1 && <option value="advance">进入复试</option>}<option value="negotiate">{interview.round === 1 ? "跳过复试，进入谈薪" : "进入谈薪"}</option><option value="reject">归档投递</option></Select>}</Field>
          {decision === "reject" && <ArchiveReasonField reasons={rejectionReasons} value={archiveReason} onChange={setArchiveReason} />}
        </div>
        {waiting && <p className="muted">{!finished(status) ? "先生成本轮总结或填写人工结论，再确认推进。" : "综合评估就绪后可确认推进。"}</p>}
        <div className="workflow-actions"><Button variant="primary" loading={busy === "decision"} disabled={!!busy || waiting} onClick={() => void decide()}>{decisions[decision]}</Button></div>
      </section>}
    </div>
  </Modal>;
}

function Evidence({ title, items }: { title: string; items?: { point: string; quote: string | null; at?: string | null }[] }) {
  if (!items?.length) return null;
  return <div><h4>{title}</h4><ul className="workflow-evidence">{items.map((item, i) => <li key={i}><strong>{item.point}</strong>{item.at && <span>{item.at}</span>}{item.quote && <p className="muted">{item.quote}</p>}</li>)}</ul></div>;
}

function ComparativeEvidence({ title, items }: { title: string; items?: ComparativePoint[] }) {
  if (!items?.length) return null;
  return <div><h4>{title}</h4><ul className="workflow-evidence">{items.map((item, index) => <li key={index}>
    <strong>{item.point}</strong>
    {item.evidence?.length ? item.evidence.map(({ round, quote }, i) => <p className="muted" key={i}>第 {round} 轮 · {quote}</p>) : <p className="muted">{item.from.map((round) => `第 ${round} 轮`).join("、")}</p>}
  </li>)}</ul></div>;
}
