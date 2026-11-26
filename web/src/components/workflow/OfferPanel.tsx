import { useCallback, useState } from "react";
import { Badge, Button, Card, ErrorState, Field, Input, ListSkeleton, Textarea, useConfirm } from "../ui";
import { api } from "../../lib/api";
import { apiMessage } from "../../lib/workflow";
import type { Application } from "../../types";
import type { OfferData, OfferInput, OfferStatus } from "../../workflowTypes";
import { useWorkflowResource } from "./resource";

const labels: Record<OfferStatus, string> = { negotiating: "谈薪中", sent: "待回复", accepted: "已接受", declined: "已拒绝" };
const money = (amount: number | null | undefined) => amount == null ? "—" : `¥${amount.toLocaleString("zh-CN")}`;

export function OfferPanel({ application, canWrite, onChange }: { application: Application; canWrite: boolean; onChange: () => void }) {
  const fetchOffer = useCallback(() => api.offer(application.id), [application.id]);
  const resource = useWorkflowResource(fetchOffer, false, "Offer 加载失败");
  return <Card id="offer" className="workflow-panel">
    <header className="card-head"><h2>谈薪与 Offer</h2>{resource.data?.offer && <Badge tone={resource.data.offer.status === "accepted" ? "success" : "neutral"}>{application.stage === "hired" ? "已入职" : labels[resource.data.offer.status]}</Badge>}</header>
    {resource.error ? <ErrorState message={resource.error} onRetry={resource.reload} /> : !resource.data ? <ListSkeleton rows={2} /> : <OfferForm data={resource.data} applicationId={application.id} canWrite={canWrite && application.status === "active" && application.stage === "offer"} onChange={() => { resource.reload(); onChange(); }} />}
  </Card>;
}

function OfferForm({ data, applicationId, canWrite, onChange }: { data: OfferData; applicationId: string; canWrite: boolean; onChange: () => void }) {
  const [edits, setEdits] = useState<OfferInput>({});
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const confirm = useConfirm();
  const status = data.offer?.status ?? "negotiating";
  const values = { ...data.offer, ...edits };
  const dirty = Object.keys(edits).length > 0;
  const isDraft = status === "negotiating";
  const dateFields = [{ key: "start_date", label: "到岗日期" }, { key: "reply_deadline", label: "答复期限" }] as const;

  async function run(action: "save" | "send" | "accept" | "decline" | "hire") {
    if (action === "send" || action === "decline" || action === "hire") {
      const text = action === "send" ? { title: "记录 Offer 已发出？", description: "系统会生成可复制的文本并记录操作。请通过你自己的渠道发送给候选人。", confirmLabel: "记录已发出" }
        : action === "decline" ? { title: "记录候选人拒绝 Offer？", description: "这个投递将移至已归档。", confirmLabel: "记录拒绝" }
        : { title: "确认候选人已入职？", description: "确认后，该候选人将计入已入职人数。", confirmLabel: "确认入职" };
      if (!(await confirm(text))) return;
    }
    setBusy(action);
    setError("");
    setNotice("");
    try {
      if (action === "save") await api.updateOffer(applicationId, edits);
      else await api.offerAction(applicationId, action, action === "hire" && values.start_date ? { start_date: values.start_date } : undefined);
      setEdits({});
      if (action === "send") setNotice("已记录发出。复制下方 Offer 文本后，可自行发送给候选人。");
      onChange();
    } catch (err) {
      setError(apiMessage(err, "Offer 操作失败"));
    } finally {
      setBusy("");
    }
  }

  const action = isDraft ? dirty ? "save" : "send" : status === "sent" ? "accept" : status === "accepted" ? "hire" : null;
  const actionLabel = { save: "保存谈薪草稿", send: "记录已发出", accept: "记录已接受", hire: "确认入职" } as const;
  const budget = data.budget.min == null && data.budget.max == null ? "未填写" : `${money(data.budget.min)} – ${money(data.budget.max)}`;

  return <div className="workflow-stack">
    <dl className="workflow-metrics">
      <div><dt>职位预算</dt><dd>{budget}</dd></div>
      <div><dt>候选人期望</dt><dd>{money(data.offer?.expected_salary)}</dd></div>
      <div><dt>与预算上限差额</dt><dd>{data.difference == null ? "—" : `${data.difference > 0 ? "+" : ""}${money(data.difference)}`}</dd></div>
      <div><dt>建议开价</dt><dd>{money(data.openingSalary)}</dd></div>
    </dl>
    {data.script && <details className="workflow-disclosure"><summary>谈薪开场话术</summary><p className="prose-text">{data.script}</p></details>}
    {(data.offer || canWrite) && <div className="form-grid">
      {([{ key: "expected_salary", label: "期望月薪（元）" }, { key: "final_salary", label: "最终月薪（元）" }] as const).map(({ key, label }) => <Field key={key} label={label}>{(id) => <Input id={id} type="number" min={0} value={values[key] ?? ""} readOnly={!canWrite || !isDraft} onChange={(e) => setEdits({ ...edits, [key]: e.target.value === "" ? null : e.target.valueAsNumber })} />}</Field>)}
      {dateFields.map(({ key, label }) => <Field key={key} label={label}>{(id) => <Input id={id} type="date" value={values[key]?.slice(0, 10) ?? ""} readOnly={!canWrite || (!isDraft && !(status === "accepted" && key === "start_date"))} onChange={(e) => setEdits({ ...edits, [key]: e.target.value || null })} />}</Field>)}
      {(isDraft && canWrite) || values.offer_letter ? <Field span label="Offer 文本" hint={isDraft ? "留空时，记录已发出将自动生成文本。" : undefined}>{(id) => <Textarea id={id} rows={5} value={values.offer_letter ?? ""} placeholder={data.template ?? undefined} readOnly={!canWrite || !isDraft} onChange={(e) => setEdits({ ...edits, offer_letter: e.target.value || null })} />}</Field> : null}
    </div>}
    {error && <p className="form-error" role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    <div className="workflow-actions">
      {values.offer_letter && <Button disabled={!!busy} onClick={() => {
        const text = values.offer_letter;
        if (!text) return;
        navigator.clipboard.writeText(text).then(() => setNotice("Offer 文本已复制。"), () => setError("复制失败，请选择文本后手动复制。"));
      }}>复制 Offer 文本</Button>}
      {canWrite && (status === "sent" || status === "accepted") && <Button loading={busy === "decline"} disabled={!!busy} onClick={() => void run("decline")}>记录拒绝</Button>}
      {canWrite && action && <Button variant="primary" loading={busy === action} disabled={!!busy || (action === "send" && (!values.final_salary || !values.start_date || !values.reply_deadline))} onClick={() => void run(action)}>{actionLabel[action]}</Button>}
    </div>
    {canWrite && action === "send" && (!values.final_salary || !values.start_date || !values.reply_deadline) && <p className="muted">填写并保存最终月薪、到岗日期和答复期限后，即可记录 Offer 发出。</p>}
  </div>;
}
