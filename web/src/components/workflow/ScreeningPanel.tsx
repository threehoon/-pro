import { useCallback, useState } from "react";
import { Button, Card, ErrorState, Field, ListSkeleton, Select, useConfirm } from "../ui";
import { api } from "../../lib/api";
import { fmtDateTime } from "../../lib/format";
import { Link } from "../../lib/router";
import { apiMessage, verdictLabels } from "../../lib/workflow";
import type { Application } from "../../types";
import type { ScreenTier, ScreeningReview } from "../../workflowTypes";
import { requireAiResult, useWorkflowResource } from "./resource";
import { ArchiveReasonField, defaultArchiveReason } from "./ArchiveReasonField";

const levels: ScreenTier[] = ["unknown", "E", "D", "C", "B", "A"];

export function ScreeningPanel({ application, canWrite, rejectionReasons, onChange, resumeHref = "#resume" }: { application: Application; canWrite: boolean; rejectionReasons: string[]; onChange: () => void; resumeHref?: string }) {
  const [poll, setPoll] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [decision, setDecision] = useState<"advance" | "reject">("advance");
  const [reason, setReason] = useState("");
  const [archiveReason, setArchiveReason] = useState<string | null>(null);
  const confirm = useConfirm();
  const fetchScreening = useCallback(async () => {
    const result = await api.screening(application.id);
    setPoll(result.data?.status === "generating");
    return result;
  }, [application.id]);
  const resource = useWorkflowResource(fetchScreening, poll, "筛选详情加载失败");
  const data = resource.data?.data;
  const review = data?.review;
  const approved = data?.approvedProfile;
  const isOlderResult = !!review && !!approved && review.profileId !== approved.id;
  const isCurrentResult = data?.status === "ready" && !isOlderResult;
  const summary = isCurrentResult ? review?.detail.resume_excerpts : undefined;
  const selectedArchiveReason = archiveReason ?? defaultArchiveReason(rejectionReasons);
  const canDecide = canWrite && application.status === "active" && (application.stage === "screening" || application.stage === "new");

  async function run(key: string, action: () => Promise<unknown>, refreshCandidate = false) {
    setBusy(key);
    setError("");
    try {
      await action();
      resource.reload();
      if (refreshCandidate) onChange();
    } catch (err) {
      setError(apiMessage(err, "筛选操作失败"));
    } finally {
      setBusy("");
    }
  }

  async function decide() {
    if (decision === "reject" && !(await confirm({ title: "归档这条投递？", description: "投递将从流程移至已归档，之后可以在职位的「已归档」里恢复。", confirmLabel: "归档投递", tone: "danger" }))) return;
    void run("decide", () => api.decideScreening(application.id, decision, decision === "reject" ? selectedArchiveReason : reason.trim() || undefined), true);
  }

  return <Card id="screening" className="workflow-panel">
    <header className="card-head"><h2>简历筛选</h2></header>
    {!resource.data && !resource.error && <ListSkeleton rows={2} />}
    {resource.error && <ErrorState message={resource.error} onRetry={resource.reload} />}
    {data && <section className="resume-summary" aria-label="AI 简历总结">
      <h3>AI 简历总结</h3>
      {data.status === "generating" ? <p className="muted" role="status">正在阅读简历并生成总结…</p>
        : data.status === "failed" ? <p className="form-error" role="alert">{resource.data?.reason || "总结生成失败，可重新筛选。"}</p>
        : !data.hasResumeText ? <p className="muted">上传可解析的简历后可生成总结。</p>
        : !approved ? <p className="muted">确认岗位画像后，系统会自动筛选并生成总结。</p>
        : isOlderResult ? <p className="muted">岗位画像已更新，可重新筛选以生成当前结果。</p>
        : summary?.length ? <>
          <p className="muted workflow-context">AI 从简历中摘选的原句</p>
          <ul className="resume-summary-points">{summary.map((excerpt) => <li key={excerpt}>{excerpt}</li>)}</ul>
        </> : <p className="muted">{review?.detail.source === "rules" ? "当前只有规则核对，可查看原简历后作出决定。" : "暂无可核实的 AI 总结，可重新筛选或查看原简历。"}</p>}
      <a className="text-link" href={resumeHref}>查看原简历</a>
    </section>}
    {data && <details className="workflow-disclosure portrait-reference" key={review?.id ?? application.id}>
      <summary>岗位画像评分（参考）</summary>
      <p className="workflow-context">
        {application.job_title && <>{application.job_title} · </>}
        {approved ? `当前依据：已确认的第 ${approved.version} 版` : "岗位画像待确认"}
        {" · "}<Link className="text-link" to={`/jobs/${application.job_id}/profile`}>查看岗位画像</Link>
      </p>
      {review ? <>
        <p className="workflow-context">{reviewBasis(review)}{!isCurrentResult && " · 上次结果"}</p>
        <ReviewEvidence review={review} busy={busy !== ""} editable={canDecide && review.detail.source === "ai" && isCurrentResult} onOverride={(indicator, label, level) => {
          void run("label", async () => requireAiResult(await api.overrideScreening(review.id, indicator, label, level), "标签更新失败"));
        }} />
      </> : <p className="muted">暂无画像评分。</p>}
    </details>}
    {review?.decision && <p className="muted">已决定{review.decision === "advance" ? "推进初试" : "归档投递"}{review.reason ? ` · ${review.reason}` : ""}</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
    {canDecide && resource.data && <>
      <div className="form-grid workflow-form-row">
        <Field label="筛选决定">{(id) => <Select id={id} value={decision} onChange={(e) => setDecision(e.target.value === "reject" ? "reject" : "advance")}><option value="advance">推进初试</option><option value="reject">归档投递</option></Select>}</Field>
        {decision === "reject"
          ? <ArchiveReasonField reasons={rejectionReasons} value={selectedArchiveReason} onChange={setArchiveReason} />
          : <Field label="决定备注">{(id) => <input id={id} className="input" value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>}
      </div>
      <div className="workflow-actions">
        <Button loading={busy === "screen"} disabled={!!busy || data?.status === "generating"} onClick={() => void run("screen", async () => {
          requireAiResult(await api.screen(application.id), "筛选启动失败");
          setPoll(true);
        })}>{review ? "重新筛选" : "运行筛选"}</Button>
        <Button variant="primary" loading={busy === "decide"} disabled={!!busy} onClick={() => void decide()}>{decision === "advance" ? "推进初试" : "归档投递"}</Button>
      </div>
    </>}
    {!!data?.history.length && <details className="workflow-disclosure"><summary>筛选历史</summary><ul>{data.history.map((item) => <li key={item.id}>
      {fmtDateTime(item.createdAt)} · {reviewBasis(item)}{item.score != null && item.detail.source !== "rules" ? ` · ${item.score} 分` : ""}{item.verdict ? ` · ${verdictLabels[item.verdict]}` : ""}
    </li>)}</ul></details>}
  </Card>;
}

function reviewBasis(review: ScreeningReview): string {
  if (review.detail.source === "ai") return review.profileVersion != null ? `AI 评分 · 画像第 ${review.profileVersion} 版` : "AI 评分 · 画像版本未知";
  if (review.detail.source === "rules") return review.profileVersion != null ? `规则核对 · 参考第 ${review.profileVersion} 版` : "规则核对 · 职位要求";
  return "人工决定";
}

function ReviewEvidence({ review, editable, busy, onOverride }: { review: ScreeningReview; editable: boolean; busy: boolean; onOverride: (indicator: string, label: string, level: ScreenTier) => void }) {
  return <div className="workflow-stack">
    {review.detail.source !== "rules" && review.score != null && <div className="workflow-result">
      <strong>{review.score}<small> 分</small></strong>
      <span>基准 100 分{review.verdict && ` · ${verdictLabels[review.verdict]}`}{review.unknownWeight > 0 && ` · ${review.unknownWeight}% 权重待核实，不计入评分`}</span>
    </div>}
    {review.detail.source !== "rules" && review.score == null && review.unknownWeight > 0 && <p className="muted">暂无可评分证据 · {review.unknownWeight}% 权重待核实</p>}
    {review.detail.source === "rules" && <p className="muted">按岗位要求与简历字段核对，可展开查看依据。</p>}
    {review.detail.top_reason && <p>{review.detail.top_reason}</p>}
    {review.detail.reject_reason && <p className="form-error">{review.detail.reject_reason}</p>}
    {!!review.missingGates.length && <p className="form-error">硬性条件未通过 · {review.missingGates.join("、")}</p>}
    {!!review.redlineHit.length && <p className="form-error">触及红线 · {review.redlineHit.join("、")}</p>}
    {!!review.detail.gates?.length && <div><h3>硬性条件</h3><ul className="workflow-evidence">
      {review.detail.gates.map((gate, i) => <li key={i}>
        <strong>{gate.condition}</strong><span>{gate.result === "pass" ? "通过" : gate.result === "fail" ? "未通过" : "待核实"}</span>
        <p className="muted">{gate.quote || "简历中未找到明确依据"}</p>
      </li>)}
    </ul></div>}
    {!!review.detail.labels?.length && <details className="workflow-disclosure" open>
      <summary>指标分档与简历证据</summary>
      <ul className="workflow-evidence">{review.detail.labels.map((entry) => <li key={`${entry.indicator}-${entry.label}`}>
        <strong>{entry.indicator} · {entry.label}</strong>
        {editable ? <Select aria-label={`${entry.label}分档`} value={entry.level} disabled={busy} onChange={(e) => {
          const level = levels.find((item) => item === e.target.value);
          if (level) onOverride(entry.indicator, entry.label, level);
        }}>{levels.map((level) => <option key={level} value={level}>{level === "unknown" ? "待核实" : `${level} 档`}</option>)}</Select> : <span>{entry.level === "unknown" ? "待核实" : `${entry.level} 档`}</span>}
        <p className="muted">{entry.quote || "简历中未找到明确依据"}</p>
      </li>)}</ul>
    </details>}
    {!!review.detail.concerns?.length && <div><h3>待核实事项</h3><ul>{review.detail.concerns.map((item, i) => <li key={i}>{item.point}{item.quote ? ` · ${item.quote}` : ""}</li>)}</ul></div>}
  </div>;
}
