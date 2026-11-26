import { useCallback, useState } from "react";
import { Badge, Button, Card, ErrorState, Field, Input, ListSkeleton, Select, Textarea, useConfirm } from "../ui";
import { api } from "../../lib/api";
import { apiMessage } from "../../lib/workflow";
import type {
  CareerTraitCode,
  DepartmentCode,
  JobLevelCode,
  ProfileContent,
  ProfileLabel,
  ProfileMeta,
  ProfileTraitMatch,
  Tier,
} from "../../workflowTypes";
import { requireAiResult, useWorkflowResource } from "./resource";

const TIERS: { key: Tier; label: string; pct: string; standard?: boolean }[] = [
  { key: "E", label: "E 档", pct: "0%" },
  { key: "D", label: "D 档", pct: "50%" },
  { key: "C", label: "C 档", pct: "100% 达标", standard: true },
  { key: "B", label: "B 档", pct: "150%" },
  { key: "A", label: "A 档", pct: "200%" },
];

const DEPARTMENT_OPTIONS: { code: DepartmentCode; name: string }[] = [
  { code: "XS", name: "销售营销岗" },
  { code: "YF", name: "研发技术岗" },
  { code: "SC", name: "生产制造岗" },
  { code: "CG", name: "采购岗" },
  { code: "CW", name: "财务岗" },
  { code: "RS", name: "人事岗" },
  { code: "XZ", name: "行政岗" },
  { code: "PZ", name: "品质管理岗" },
  { code: "CC", name: "仓储计划岗" },
  { code: "GL", name: "管理高管岗" },
];

const LEVEL_OPTIONS: { code: JobLevelCode; name: string; tagline: string }[] = [
  { code: "L1", name: "操作岗", tagline: "初级听令做小事" },
  { code: "L2", name: "执行岗", tagline: "熟练按规做常事" },
  { code: "L3", name: "实施岗", tagline: "实战经验管难事" },
  { code: "L4", name: "策略岗", tagline: "精通领域管繁事" },
  { code: "L5", name: "经营岗", tagline: "系统创造扛公事" },
  { code: "L6", name: "决策岗", tagline: "方向决策扛险事" },
];

const TRAIT_OPTIONS: { code: CareerTraitCode; name: string; combo: string; focus: string }[] = [
  { code: "A", name: "前进者", combo: "主力量型 · 辅完美型", focus: "拿到未来结果，目标与战略导向" },
  { code: "B", name: "现实者", combo: "主力量型 · 辅稳健型", focus: "拿到当下结果，高效执行与攻坚" },
  { code: "C", name: "交际者", combo: "主交流型 · 辅稳健型", focus: "建立一对一信任，协调沟通与客户维系" },
  { code: "D", name: "宣扬者", combo: "主交流型 · 辅完美型", focus: "影响一对多群体，宣讲推广与开拓" },
  { code: "E", name: "感知者", combo: "主稳健型 · 辅交流型", focus: "体察人的需求，服务支持与情绪稳定" },
  { code: "F", name: "事实者", combo: "主稳健型 · 辅力量型", focus: "核查客观事实，数据台账与流程落细" },
  { code: "G", name: "分析者", combo: "主完美型 · 辅交流型", focus: "拆解系统问题，架构策划与严谨分析" },
  { code: "H", name: "人性者", combo: "主完美型 · 辅力量型", focus: "洞察团队潜力，组织赋能与人才发展" },
];

const GUARDRAIL_LISTS = [
  { key: "redlines", label: "红线（一票否决）", tone: "danger", hint: "命中即判定不符，每行一条，最多 8 条。" },
  { key: "not_wanted", label: "黑线 / 谨慎项", tone: "warning", hint: "面试重点核查的减分风险点，每行一条，最多 8 条。" },
  { key: "bonus", label: "加分项（不占基础分）", tone: "brand", hint: "有则加分、无则不扣分，每行一条，最多 8 条。" },
] as const;

const emptyLabel = (): ProfileLabel => ({ name: "", weight: 0, tiers: { E: "", D: "", C: "", B: "", A: "" } });

function levelDisplay(level?: JobLevelCode, levelName?: string, tagline?: string): string {
  if (!level) return "";
  const found = LEVEL_OPTIONS.find((item) => item.code === level);
  const name = levelName || found?.name;
  const desc = tagline || found?.tagline;
  if (name && desc) return `${level} · ${name}（${desc}）`;
  return name ? `${level} · ${name}` : level;
}

function traitDisplay(trait: ProfileTraitMatch) {
  const preset = TRAIT_OPTIONS.find((item) => item.code === trait.code);
  return {
    code: trait.code,
    name: trait.name || preset?.name || "",
    combo: trait.combo || preset?.combo || "",
    reason: trait.reason,
  };
}

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
  const labelMismatches = draft
    ? draft.indicators.filter((item) => item.labels.reduce((sum, label) => sum + label.weight, 0) !== item.weight)
    : [];
  const missingTraitReason = Boolean(draft?.trait_match && !draft.trait_match.reason.trim());

  async function run(action: "generate" | "save" | "approve") {
    if (action === "generate" && profile && !(await confirm({
      title: "重新生成岗位画像？",
      description: "系统会基于当前职位说明生成新版本，历史版本仍可查看。",
      confirmLabel: "重新生成",
    }))) return;
    if (action === "save" && missingTraitReason) {
      setError("请填写职业特质的岗位适配理由，或将最匹配职业特质改为「暂不指定」。");
      return;
    }
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
        {profile && (
          <Badge tone={profile.status === "approved" ? "brand" : "neutral"}>
            第 {profile.version} 版 · {profile.status === "approved" ? "已确认" : profile.status === "failed" ? "生成失败" : "草稿"}
          </Badge>
        )}
      </header>
      {!resource.data && !resource.error && <ListSkeleton rows={2} />}
      {resource.error && <ErrorState message={resource.error} onRetry={resource.reload} />}
      {status === "generating" && <p className="muted" role="status">正在根据职位说明生成岗位画像…</p>}
      {status === "failed" && <p className="form-error" role="alert">{resource.data?.reason || "生成失败，可以重新生成或编辑现有画像。"}</p>}
      {status === "none" && !content && <p className="muted">还没有岗位画像。生成后可编辑岗位要求并确认。</p>}
      {resource.data?.data && (
        <p className="workflow-context">
          {approved
            ? `简历筛选依据 · 已确认的第 ${approved.version} 版${draft || approved.id !== profile?.id ? "（新版本确认前继续使用）" : ""}`
            : "确认画像后，AI 会按这份标准筛选已投递到该职位的简历。"}
        </p>
      )}
      {content && (draft ? <ProfileEditor content={draft} setContent={setDraft} /> : <ProfileReadout content={content} />)}
      {profile?.generatedBy === "fallback" && <p className="muted">当前为基于岗位信息生成的规则草稿，确认前可按实际需求微调指标标签与五档标准。</p>}
      {content?.compliance_rewritten && <p className="muted">画像中涉及个人属性的要求已改写为客观岗位条件。</p>}
      {content?.weights_adjusted && <p className="muted">该版本的权重已由系统自动归一为 100%。</p>}
      {draft && total !== 100 && <p className="form-error" role="alert">四个指标目前合计 {total}%，保存时系统会将四指标重置为各 25% 并均分标签权重。</p>}
      {draft && total === 100 && labelMismatches.length > 0 && (
        <p className="form-error" role="alert">
          {labelMismatches.map((item) => `${item.name}（标签合计 ${item.labels.reduce((sum, label) => sum + label.weight, 0)}% ≠ 指标 ${item.weight}%）`).join("、")}，保存时系统将按指标权重自动均分对应标签。
        </p>
      )}
      {draft && missingTraitReason && <p className="form-error" role="alert">已选择最匹配职业特质，请填写岗位适配理由，或将特质改为「暂不指定」。</p>}
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
      {!!resource.data?.data?.history.length && (
        <details className="workflow-disclosure">
          <summary>版本历史（{resource.data.data.history.length}）</summary>
          <ul>
            {resource.data.data.history.map((item) => (
              <li key={item.id}>
                第 {item.version} 版 · {item.status === "approved" ? "已确认" : item.status === "failed" ? "生成失败" : "草稿"}
                {item.content?.meta?.code ? ` · ${item.content.meta.code}` : ""}
                {item.content?.positioning ? ` · ${item.content.positioning}` : ""}
              </li>
            ))}
          </ul>
        </details>
      )}
    </Card>
  );
}

function ProfileReadout({ content }: { content: ProfileContent }) {
  const metaItems = [
    content.meta?.code ? { label: "岗位编号", value: content.meta.code } : null,
    content.meta?.department || content.meta?.department_code
      ? {
          label: "所属归类",
          value: content.meta.department_code && content.meta.department
            ? `${content.meta.department_code} · ${content.meta.department}`
            : content.meta.department || content.meta.department_code || "",
        }
      : null,
    content.meta?.level ? { label: "岗位能级", value: levelDisplay(content.meta.level, content.meta.level_name, content.meta.level_tagline) } : null,
    content.meta?.industry ? { label: "所属行业", value: content.meta.industry } : null,
    content.meta?.location ? { label: "工作地点", value: content.meta.location } : null,
  ].filter((item): item is { label: string; value: string } => Boolean(item));

  const trait = content.trait_match ? traitDisplay(content.trait_match) : null;
  const hasGuardrails = Boolean(content.redlines?.length || content.not_wanted?.length || content.bonus?.length);

  return (
    <div className="profile-sheet">
      <section className="profile-section" aria-label="岗位定位与基本信息">
        {!!metaItems.length && (
          <dl className="profile-meta-grid">
            {metaItems.map((item) => (
              <div key={item.label} className="profile-meta-item">
                <dt>{item.label}</dt>
                <dd>{item.value}</dd>
              </div>
            ))}
          </dl>
        )}
        {content.positioning && <p className="workflow-lead profile-positioning">{content.positioning}</p>}
      </section>

      {!!content.responsibilities?.length && (
        <section className="profile-section" aria-labelledby="profile-resp-heading">
          <div className="profile-section-head">
            <h3 id="profile-resp-heading">核心岗位职责</h3>
            <span className="muted">{content.responsibilities.length} 项职责</span>
          </div>
          <ol className="profile-resp-list">
            {content.responsibilities.map((item, idx) => <li key={idx}>{item}</li>)}
          </ol>
        </section>
      )}

      {!!content.hard_gates?.length && (
        <section className="profile-section" aria-labelledby="profile-gates-heading">
          <div className="profile-section-head">
            <h3 id="profile-gates-heading">硬性条件</h3>
            <span className="profile-rule-tag tone-danger">一票否决</span>
          </div>
          <ul className="profile-gates-list">
            {content.hard_gates.map((item, i) => (
              <li key={i}>
                <strong>{item.condition}</strong>
                {item.how && <span className="muted">核对依据：{item.how}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="profile-section" aria-labelledby="profile-indicators-heading">
        <div className="profile-section-head">
          <h3 id="profile-indicators-heading">四指标评估标准与五档标签</h3>
          <span className="muted">权重总和 100% · C 档为达标基准</span>
        </div>
        <div className="profile-weight-band" aria-label="四项指标权重">
          {content.indicators?.map((item) => (
            <div key={item.name} className="profile-weight-cell">
              <div className="profile-weight-top">
                <span className="profile-weight-name">{item.name}</span>
                <strong className="profile-weight-num">{item.weight}%</strong>
              </div>
              <div className="flow-track thin" aria-hidden>
                <span className="flow-fill brand" style={{ width: `${Math.min(100, item.weight)}%` }} />
              </div>
              <span className="profile-weight-sub muted">{item.labels.length} 个专属标签</span>
            </div>
          ))}
        </div>

        <div className="profile-indicators-stack">
          {content.indicators?.filter((item) => item.labels.length > 0).map((item) => (
            <details className="workflow-disclosure profile-indicator-block" key={item.name} open>
              <summary className="profile-indicator-summary">
                <span>{item.name}</span>
                <span className="profile-indicator-meta">{item.weight}% · {item.labels.length} 个标签</span>
              </summary>
              <div className="profile-tier-matrix" role="table" aria-label={`${item.name}五档分档标准`}>
                <div className="profile-tier-head" role="row">
                  <div className="profile-tier-col-label" role="columnheader">标签（权重）</div>
                  {TIERS.map((tier) => (
                    <div
                      key={tier.key}
                      role="columnheader"
                      className={`profile-tier-col${tier.standard ? " is-standard" : ""}`}
                    >
                      <span>{tier.label}</span>
                      <small>{tier.pct}</small>
                    </div>
                  ))}
                </div>
                {item.labels.map((label, idx) => (
                  <div className="profile-tier-row" role="row" key={`${label.name}-${idx}`}>
                    <div className="profile-tier-label-cell" role="rowheader">
                      <strong>{label.name}</strong>
                      <span className="profile-label-weight">{label.weight}%</span>
                    </div>
                    {TIERS.map((tier) => (
                      <div
                        key={tier.key}
                        role="cell"
                        className={`profile-tier-cell${tier.standard ? " is-standard" : ""}`}
                      >
                        <span className="profile-tier-mobile-tag">{tier.label} · {tier.pct}</span>
                        <p>{label.tiers[tier.key] || "—"}</p>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </details>
          ))}
        </div>
      </section>

      {trait && (
        <section className="profile-section" aria-labelledby="profile-trait-heading">
          <div className="profile-section-head">
            <h3 id="profile-trait-heading">职业特质匹配</h3>
            <span className="muted">八类职业特质模型</span>
          </div>
          <div className="profile-trait-card">
            <div className="profile-trait-badge">
              <strong>{trait.code}{trait.name ? ` · ${trait.name}` : ""}</strong>
              {trait.combo && <span>{trait.combo}</span>}
            </div>
            <p className="profile-trait-reason">{trait.reason}</p>
          </div>
        </section>
      )}

      {hasGuardrails && (
        <section className="profile-section" aria-labelledby="profile-guardrails-heading">
          <div className="profile-section-head">
            <h3 id="profile-guardrails-heading">红黑线与加分项</h3>
          </div>
          <div className="profile-guardrails">
            {GUARDRAIL_LISTS.map(({ key, label, tone }) => {
              const items = content[key];
              if (!items?.length) return null;
              return (
                <div key={key} className={`profile-guardrail-box tone-${tone}`}>
                  <h4>{label}</h4>
                  <ul>
                    {items.map((text, idx) => <li key={idx}>{text}</li>)}
                  </ul>
                </div>
              );
            })}
          </div>
        </section>
      )}

      <footer className="profile-scoring-rule" aria-label="合格判定口径">
        <span><strong>分档系数</strong> E 0% · D 50% · C 100%（达标）· B 150% · A 200%</span>
        <span><strong>合格口径</strong> &lt; 80 分不符 · 80–120 分符合 · &gt; 120 分超标</span>
        <span><strong>否决与缺失</strong> 硬性条件不符或命中红线一票否决；材料未提及标「待核实」不计分</span>
      </footer>
    </div>
  );
}

function ProfileSelectField({
  label,
  value,
  emptyLabel: emptyText,
  options,
  onChange,
}: {
  label: string;
  value: string;
  emptyLabel: string;
  options: { value: string; label: string }[];
  onChange: (next: string) => void;
}) {
  return (
    <Field label={label}>
      {(id) => (
        <Select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">{emptyText}</option>
          {options.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
        </Select>
      )}
    </Field>
  );
}

function WeightField({ label, hint, value, onChange }: { label: string; hint?: string; value: number; onChange: (next: number) => void }) {
  return (
    <Field label={label} hint={hint}>
      {(id) => (
        <Input
          id={id}
          type="number"
          min={0}
          max={100}
          step={1}
          value={value}
          onChange={(e) => {
            const raw = e.target.value === "" ? 0 : Math.min(100, Math.max(0, Math.trunc(Number(e.target.value))));
            if (!Number.isNaN(raw)) onChange(raw);
          }}
        />
      )}
    </Field>
  );
}

function ProfileEditor({ content, setContent }: { content: ProfileContent; setContent: (next: ProfileContent) => void }) {
  const editIndicator = (index: number, next: ProfileContent["indicators"][number]) => {
    setContent({ ...content, indicators: content.indicators.map((item, i) => (i === index ? next : item)) });
  };

  const editMeta = (change: Partial<ProfileMeta>) => {
    const merged: ProfileMeta = { ...content.meta, ...change };
    const cleaned = Object.fromEntries(Object.entries(merged).filter(([, v]) => typeof v === "string" && v.trim() !== "")) as ProfileMeta;
    setContent({ ...content, meta: Object.keys(cleaned).length ? cleaned : undefined });
  };

  const editTrait = (codeValue: string, reasonValue?: string) => {
    if (!codeValue) {
      setContent({ ...content, trait_match: undefined });
      return;
    }
    const preset = TRAIT_OPTIONS.find((item) => item.code === codeValue);
    if (!preset) return;
    const prevPreset = content.trait_match ? TRAIT_OPTIONS.find((item) => item.code === content.trait_match?.code) : undefined;
    const currentReason = content.trait_match?.reason ?? "";
    const resolvedReason = reasonValue !== undefined
      ? reasonValue
      : (!currentReason.trim() || currentReason === prevPreset?.focus ? preset.focus : currentReason);
    const next: ProfileTraitMatch = {
      code: preset.code,
      name: preset.name,
      combo: preset.combo,
      reason: resolvedReason,
    };
    setContent({ ...content, trait_match: next });
  };

  const deptSelectOptions = DEPARTMENT_OPTIONS.map((item) => ({ value: item.code, label: `${item.code} · ${item.name}` }));
  const levelSelectOptions = LEVEL_OPTIONS.map((item) => ({ value: item.code, label: `${item.code} · ${item.name}（${item.tagline}）` }));
  const traitSelectOptions = TRAIT_OPTIONS.map((item) => ({ value: item.code, label: `${item.code} · ${item.name}（${item.combo}）` }));

  const handleDepartmentChange = (val: string) => {
    const code = val as DepartmentCode | "";
    const dept = DEPARTMENT_OPTIONS.find((item) => item.code === code);
    editMeta({ department_code: code || undefined, department: dept?.name });
  };
  const handleLevelChange = (val: string) => {
    const code = val as JobLevelCode | "";
    const lvl = LEVEL_OPTIONS.find((item) => item.code === code);
    editMeta({ level: code || undefined, level_name: lvl?.name, level_tagline: lvl?.tagline });
  };

  return (
    <div className="workflow-stack">
      <div className="profile-editor-section">
        <h3>岗位基本信息与定位</h3>
        <div className="form-grid">
          <Field label="岗位编号" hint="例如 YF-L3、XS-L2">
            {(id) => <Input id={id} value={content.meta?.code ?? ""} onChange={(e) => editMeta({ code: e.target.value })} />}
          </Field>
          <ProfileSelectField label="部门归类" value={content.meta?.department_code ?? ""} emptyLabel="未指定" options={deptSelectOptions} onChange={handleDepartmentChange} />
          <ProfileSelectField label="岗位能级" value={content.meta?.level ?? ""} emptyLabel="未指定" options={levelSelectOptions} onChange={handleLevelChange} />
          <Field label="所属行业">
            {(id) => <Input id={id} value={content.meta?.industry ?? ""} onChange={(e) => editMeta({ industry: e.target.value })} />}
          </Field>
          <Field label="工作地点">
            {(id) => <Input id={id} value={content.meta?.location ?? ""} onChange={(e) => editMeta({ location: e.target.value })} />}
          </Field>
        </div>
        <Field label="岗位定位">
          {(id) => <Input id={id} value={content.positioning} onChange={(e) => setContent({ ...content, positioning: e.target.value })} />}
        </Field>
        <ProfileListField
          label="核心岗位职责"
          hint="每行一条，建议 5–8 条，最多 8 条。"
          max={8}
          rows={5}
          value={content.responsibilities ?? []}
          onChange={(next) => setContent({ ...content, responsibilities: next.length ? next : undefined })}
        />
      </div>

      <div className="profile-editor-section">
        <h3>硬性条件（一票否决）</h3>
        {content.hard_gates.map((gate, i) => {
          const edit = (change: Partial<typeof gate>) =>
            setContent({ ...content, hard_gates: content.hard_gates.map((item, index) => (index === i ? { ...item, ...change } : item)) });
          return (
            <div className="form-grid workflow-form-row" key={i}>
              <Field label={`条件 ${i + 1}`}>{(id) => <Input id={id} value={gate.condition} onChange={(e) => edit({ condition: e.target.value })} />}</Field>
              <Field label="核对依据">{(id) => <Input id={id} value={gate.how} onChange={(e) => edit({ how: e.target.value })} />}</Field>
              <Button size="sm" variant="ghost" aria-label={`移除条件 ${i + 1}`} onClick={() => setContent({ ...content, hard_gates: content.hard_gates.filter((_, index) => index !== i) })}>移除条件</Button>
            </div>
          );
        })}
        <Button size="sm" disabled={content.hard_gates.length >= 8} onClick={() => setContent({ ...content, hard_gates: [...content.hard_gates, { condition: "", how: "" }] })}>添加硬性条件</Button>
      </div>

      <div className="profile-editor-section">
        <h3>四指标权重与五档标签</h3>
        {content.indicators.map((item, i) => {
          const labelsWeight = item.labels.reduce((sum, label) => sum + label.weight, 0);
          return (
            <details className="workflow-disclosure" key={item.name}>
              <summary>{item.name} · {item.weight}% · {item.labels.length} 个标签</summary>
              <WeightField label={`${item.name}权重`} hint={`标签权重合计 ${labelsWeight}%，应与指标权重相同。`} value={item.weight} onChange={(weight) => editIndicator(i, { ...item, weight })} />
              {labelsWeight !== item.weight && (
                <p className="form-error" role="alert">当前标签权重合计 {labelsWeight}%，与{item.name}权重 {item.weight}% 不一致；保存时系统将按指标权重自动均分。</p>
              )}
              {item.labels.length < 3 && (
                <p className="muted">标准版建议每维度维护 3–6 个标签（当前 {item.labels.length} 个，仍可兼容保存）。</p>
              )}
              {item.labels.map((label, labelIndex) => {
                const edit = (next: ProfileLabel) =>
                  editIndicator(i, { ...item, labels: item.labels.map((entry, index) => (index === labelIndex ? next : entry)) });
                return (
                  <fieldset className="form-grid workflow-label-fields" key={labelIndex}>
                    <legend>{label.name || `标签 ${labelIndex + 1}`}</legend>
                    <Field label="标签名称">{(id) => <Input id={id} value={label.name} onChange={(e) => edit({ ...label, name: e.target.value })} />}</Field>
                    <WeightField label="标签权重" value={label.weight} onChange={(weight) => edit({ ...label, weight })} />
                    {TIERS.map((tier) => (
                      <Field key={tier.key} label={`${tier.label} · ${tier.pct}`}>
                        {(id) => <Input id={id} value={label.tiers[tier.key]} onChange={(e) => edit({ ...label, tiers: { ...label.tiers, [tier.key]: e.target.value } })} />}
                      </Field>
                    ))}
                    <Button size="sm" variant="ghost" disabled={item.labels.length <= 1} onClick={() => editIndicator(i, { ...item, labels: item.labels.filter((_, index) => labelIndex !== index) })}>移除标签</Button>
                  </fieldset>
                );
              })}
              <Button size="sm" disabled={item.labels.length >= 6} onClick={() => editIndicator(i, { ...item, labels: [...item.labels, emptyLabel()] })}>添加标签</Button>
            </details>
          );
        })}
      </div>

      <div className="profile-editor-section">
        <h3>职业特质匹配</h3>
        <div className="form-grid">
          <ProfileSelectField
            label="最匹配职业特质"
            value={content.trait_match?.code ?? ""}
            emptyLabel="暂不指定"
            options={traitSelectOptions}
            onChange={(val) => editTrait(val)}
          />
          {content.trait_match && (
            <Field label="岗位适配理由" hint="必填；切换特质会自动填入默认说明，也可按岗位实际改写。">
              {(id) => <Input id={id} required value={content.trait_match?.reason ?? ""} onChange={(e) => editTrait(content.trait_match!.code, e.target.value)} />}
            </Field>
          )}
        </div>
      </div>

      <div className="form-grid">
        {GUARDRAIL_LISTS.map(({ key, label, hint }) => (
          <ProfileListField
            key={key}
            label={label}
            hint={hint}
            max={8}
            rows={4}
            value={content[key]}
            onChange={(next) => setContent({ ...content, [key]: next })}
          />
        ))}
      </div>
    </div>
  );
}

function ProfileListField({
  label,
  hint,
  max = 8,
  rows = 4,
  value,
  onChange,
}: {
  label: string;
  hint: string;
  max?: number;
  rows?: number;
  value: string[];
  onChange: (next: string[]) => void;
}) {
  const [text, setText] = useState(() => value.join("\n"));
  return (
    <Field label={label} hint={hint}>
      {(id) => (
        <Textarea
          id={id}
          rows={rows}
          value={text}
          onChange={(e) => {
            const next = e.target.value.split(/\r?\n/).slice(0, max);
            setText(next.join("\n"));
            onChange(next.map((line) => line.trim()).filter(Boolean));
          }}
        />
      )}
    </Field>
  );
}
