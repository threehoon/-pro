import { useCallback, useState } from "react";
import { Badge, Button, Card, ErrorState, Field, Input, ListSkeleton, Textarea, useConfirm } from "../ui";
import { api } from "../../lib/api";
import { apiMessage } from "../../lib/workflow";
import type { ProfileContent, ProfileLabel, Tier } from "../../workflowTypes";
import { requireAiResult, useWorkflowResource } from "./resource";

const tiers: Tier[] = ["E", "D", "C", "B", "A"];
const emptyLabel = (): ProfileLabel => ({ name: "", weight: 0, tiers: { E: "", D: "", C: "", B: "", A: "" } });
const lists = [{ key: "redlines", label: "红线" }, { key: "bonus", label: "加分项" }, { key: "not_wanted", label: "不需要" }] as const;

export function JobProfilePanel({ jobId, canWrite }: { jobId: string; canWrite: boolean }) {
  const [draft, setDraft] = useState<ProfileContent | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [poll, setPoll] = useState(true);
  const confirm = useConfirm();
  const fetchProfile = useCallback(async () => {
    const result = await api.profile(jobId);
    setPoll(result.data?.status === "generating");
    return result;
  }, [jobId]);
  const resource = useWorkflowResource(fetchProfile, poll, "画像加载失败");
  const profile = resource.data?.data?.profile;
  const approved = resource.data?.data?.approvedProfile;
  const status = resource.data?.data?.status;
  const wait = status === "generating" || busy !== "";
  const content = draft ?? profile?.content;
  const total = content?.indicators.reduce((sum, item) => sum + item.weight, 0);

  async function run(action: "generate" | "save" | "approve") {
    if (action === "generate" && profile && !(await confirm({
      title: "重新生成岗位画像？",
      description: "系统会基于当前职位说明生成新版本，历史版本仍可查看。",
      confirmLabel: "重新生成",
    }))) return;
    setBusy(action);
    setError("");
    setNotice("");
    try {
      if (action === "generate") {
        requireAiResult(await api.generateProfile(jobId), "画像生成失败");
        setPoll(true);
      } else if (action === "save" && draft) {
        const next = requireAiResult(await api.saveProfile(jobId, draft), "画像保存失败");
        setNotice(next.profile?.content.weights_adjusted ? "权重不平衡，系统已归一调整。请复核后确认。" : "草稿已保存，可以确认画像。");
      } else if (action === "approve" && profile) {
        requireAiResult(await api.approveProfile(jobId, profile.id), "画像确认失败");
        setNotice("画像已确认，待筛选的简历将按新版自动重算。");
      }
      setDraft(null);
      resource.reload();
    } catch (err) {
      setError(apiMessage(err, "画像更新失败"));
      if (action === "approve") resource.reload();
    } finally {
      setBusy("");
    }
  }

  return (
    <Card id="profile" className="workflow-panel" tabIndex={-1} aria-labelledby="profile-title">
      <header className="card-head">
        <h2 id="profile-title">岗位画像</h2>
        {profile && <Badge tone={profile.status === "approved" ? "brand" : "neutral"}>第 {profile.version} 版 · {profile.status === "approved" ? "已确认" : profile.status === "failed" ? "生成失败" : "草稿"}</Badge>}
      </header>
      {!resource.data && !resource.error && <ListSkeleton rows={2} />}
      {resource.error && <ErrorState message={resource.error} onRetry={resource.reload} />}
      {status === "generating" && <p className="muted" role="status">正在根据职位说明生成画像…</p>}
      {status === "failed" && <p className="form-error" role="alert">{resource.data?.reason || "生成失败，可以重新生成或编辑现有画像。"}</p>}
      {status === "none" && !content && <p className="muted">还没有岗位画像。生成后可编辑岗位要求并确认。</p>}
      {resource.data?.data && <p className="workflow-context">{approved
        ? `简历筛选依据 · 已确认的第 ${approved.version} 版${draft || approved.id !== profile?.id ? "（新版本确认前继续使用）" : ""}`
        : "确认画像后，AI 会按这份标准筛选已投递到该职位的简历。"}</p>}
      {content && (draft ? <ProfileEditor content={draft} setContent={setDraft} /> : <ProfileReadout content={content} />)}
      {profile?.generatedBy === "fallback" && <p className="muted">根据职位要求生成的规则草稿，确认前可补充标签及分档。</p>}
      {content?.compliance_rewritten && <p className="muted">画像中涉及个人属性的要求已改写为客观岗位条件。</p>}
      {content?.weights_adjusted && <p className="muted">该版本的权重已由系统调整。</p>}
      {draft && total !== 100 && <p className="form-error">四个指标目前合计 {total}%，保存时系统会按规则调整为 100%。</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      {notice && <p className="muted" role="status">{notice}</p>}
      {canWrite && resource.data && (
        <div className="workflow-actions">
          {draft ? <>
            <Button disabled={wait} onClick={() => setDraft(null)}>取消编辑</Button>
            <Button variant="primary" disabled={wait} loading={busy === "save"} onClick={() => void run("save")}>保存草稿</Button>
          </> : <>
            <Button disabled={wait} loading={busy === "generate"} onClick={() => void run("generate")}>{profile ? "AI 重新生成" : "生成画像"}</Button>
            {content && <Button disabled={wait} onClick={() => setDraft(content)}>编辑画像</Button>}
            {profile?.status === "draft" && <Button variant="primary" disabled={wait} loading={busy === "approve"} onClick={() => void run("approve")}>确认画像</Button>}
          </>}
        </div>
      )}
      {!!resource.data?.data?.history.length && <details className="workflow-disclosure"><summary>版本历史</summary>
        <ul>{resource.data.data.history.map((item) => <li key={item.id}>第 {item.version} 版 · {item.status === "approved" ? "已确认" : item.status === "failed" ? "生成失败" : "草稿"}{item.content?.positioning ? ` · ${item.content.positioning}` : ""}</li>)}</ul>
      </details>}
    </Card>
  );
}

function ProfileReadout({ content }: { content: ProfileContent }) {
  return <div className="workflow-stack">
    {content.positioning && <p className="workflow-lead">{content.positioning}</p>}
    {!!content.hard_gates?.length && <div><h3>硬性条件</h3><ul>{content.hard_gates.map((item, i) => <li key={i}>{item.condition}{item.how && <span className="muted"> · {item.how}</span>}</li>)}</ul></div>}
    <div className="profile-weight-band" aria-label="四项指标权重">
      {content.indicators?.map((item) => <div key={item.name}>
        <strong>{item.weight}%</strong><span>{item.name}</span>
        <div className="flow-track thin" aria-hidden><span className="flow-fill brand" style={{ width: `${item.weight}%` }} /></div>
      </div>)}
    </div>
    {content.indicators?.filter((item) => item.labels.length > 0).map((item) => <details className="workflow-disclosure" key={item.name}>
      <summary>{item.name} · {item.labels.length} 个标签</summary>
      <ul>{item.labels.map((label, i) => <li key={i}><strong>{label.name} · {label.weight}%</strong><p className="muted">{tiers.map((tier) => `${tier} 档 ${label.tiers[tier] || "—"}`).join(" · ")}</p></li>)}</ul>
    </details>)}
    {lists.map(({ key, label }) => !!content[key]?.length && <p key={key}><strong>{label}</strong> · {content[key].join("、")}</p>)}
  </div>;
}

function ProfileEditor({ content, setContent }: { content: ProfileContent; setContent: (next: ProfileContent) => void }) {
  const editIndicator = (index: number, next: ProfileContent["indicators"][number]) => {
    setContent({ ...content, indicators: content.indicators.map((item, i) => i === index ? next : item) });
  };
  return <div className="workflow-stack">
    <Field label="岗位定位">{(id) => <Input id={id} value={content.positioning} onChange={(e) => setContent({ ...content, positioning: e.target.value })} />}</Field>
    <div>
      <h3>硬性条件</h3>
      {content.hard_gates.map((gate, i) => {
        const edit = (change: Partial<typeof gate>) => setContent({ ...content, hard_gates: content.hard_gates.map((item, index) => index === i ? { ...item, ...change } : item) });
        return <div className="form-grid workflow-form-row" key={i}>
          <Field label={`条件 ${i + 1}`}>{(id) => <Input id={id} value={gate.condition} onChange={(e) => edit({ condition: e.target.value })} />}</Field>
          <Field label="核对依据">{(id) => <Input id={id} value={gate.how} onChange={(e) => edit({ how: e.target.value })} />}</Field>
          <Button size="sm" variant="ghost" aria-label={`移除条件 ${i + 1}`} onClick={() => setContent({ ...content, hard_gates: content.hard_gates.filter((_, index) => i !== index) })}>移除条件</Button>
        </div>;
      })}
      <Button size="sm" disabled={content.hard_gates.length >= 6} onClick={() => setContent({ ...content, hard_gates: [...content.hard_gates, { condition: "", how: "" }] })}>添加硬性条件</Button>
    </div>
    {content.indicators.map((item, i) => {
      const labelsWeight = item.labels.reduce((sum, label) => sum + label.weight, 0);
      return <details className="workflow-disclosure" key={item.name}>
        <summary>{item.name} · {item.weight}% · {item.labels.length} 个标签</summary>
        <Field label={`${item.name}权重`} hint={`标签权重合计 ${labelsWeight}%，应与指标权重相同。`}>{(id) => <Input id={id} type="number" min={0} max={100} value={item.weight} onChange={(e) => editIndicator(i, { ...item, weight: Number(e.target.value) })} />}</Field>
        {item.labels.map((label, labelIndex) => {
          const edit = (next: ProfileLabel) => editIndicator(i, { ...item, labels: item.labels.map((entry, index) => index === labelIndex ? next : entry) });
          return <fieldset className="form-grid workflow-label-fields" key={labelIndex}>
            <legend>{label.name || `标签 ${labelIndex + 1}`}</legend>
            <Field label="标签名称">{(id) => <Input id={id} value={label.name} onChange={(e) => edit({ ...label, name: e.target.value })} />}</Field>
            <Field label="标签权重">{(id) => <Input id={id} type="number" min={0} max={100} value={label.weight} onChange={(e) => edit({ ...label, weight: Number(e.target.value) })} />}</Field>
            {tiers.map((tier) => <Field key={tier} label={`${tier} 档${tier === "C" ? " · 达标" : ""}`}>{(id) => <Input id={id} value={label.tiers[tier]} onChange={(e) => edit({ ...label, tiers: { ...label.tiers, [tier]: e.target.value } })} />}</Field>)}
            <Button size="sm" variant="ghost" onClick={() => editIndicator(i, { ...item, labels: item.labels.filter((_, index) => labelIndex !== index) })}>移除标签</Button>
          </fieldset>;
        })}
        <Button size="sm" disabled={item.labels.length >= 6} onClick={() => editIndicator(i, { ...item, labels: [...item.labels, emptyLabel()] })}>添加标签</Button>
      </details>;
    })}
    <div className="form-grid">{lists.map(({ key, label }) => <ProfileListField key={key} label={label} value={content[key]} onChange={(next) => setContent({ ...content, [key]: next })} />)}</div>
  </div>;
}

function ProfileListField({ label, value, onChange }: { label: string; value: string[]; onChange: (next: string[]) => void }) {
  const [text, setText] = useState(() => value.join("\n"));
  return <Field label={label} hint="每行一条，最多三条。">{(id) => <Textarea id={id} rows={3} value={text} onChange={(e) => {
    const next = e.target.value.split(/\r?\n/).slice(0, 3);
    setText(next.join("\n"));
    onChange(next.map((line) => line.trim()).filter(Boolean));
  }} />}</Field>;
}
