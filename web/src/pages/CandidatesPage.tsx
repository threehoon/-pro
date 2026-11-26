import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { api, ApiError, type CandidateInput } from "../lib/api";
import { bytesText, fmtDate, fmtDateTime, interviewTitle, stageColor, timeAgo } from "../lib/format";
import { Link, useLocation, useNavigate } from "../lib/router";
import type {
  Application,
  Candidate,
  CandidateDetail,
  CandidateGroup,
  CandidateList,
  Interview,
  Meta,
  ParsedFields,
  ParsedResume,
} from "../types";
import {
  Avatar,
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  IconButton,
  Input,
  ListSkeleton,
  Modal,
  PageHeader,
  SearchInput,
  Select,
  StageBadge,
  TabPanels,
  Tabs,
  Textarea,
  useConfirm,
  useToast,
} from "../components/ui";
import {
  IconArrowUpRight,
  IconCalendar,
  IconDownload,
  IconEdit,
  IconFile,
  IconMail,
  IconMapPin,
  IconPhone,
  IconPlus,
  IconSpark,
  IconTrash,
  IconUpload,
} from "../components/icons";

import { applicationTarget, boardStages, candidateLink, compareRounds, workflowStage } from "../lib/workflow";
import { ScreeningPanel } from "../components/workflow/ScreeningPanel";
import { OfferPanel } from "../components/workflow/OfferPanel";
import { InterviewDrawer } from "../components/workflow/InterviewDrawer";
import { ScheduleInterviewModal } from "../components/workflow/ScheduleInterviewModal";

// 分类维度和表格的「流程」列一一对应：boardStages 的五个阶段，外加未进入流程的两种状态。
const candidateGroups: Array<{ value: CandidateGroup | ""; label: string }> = [
  { value: "", label: "全部" },
  ...boardStages.map((stage) => ({ value: stage.key as CandidateGroup, label: stage.label })),
  { value: "rejected", label: "已拒绝" },
  { value: "none", label: "未投递" },
];

// 列表徽标和上面的分类用同一套判定，避免「待入职」在行内被显示成「谈薪」。
function candidateStageBadge(candidate: Candidate) {
  if (candidate.active_count && candidate.furthest_stage) {
    const stage = workflowStage({ stage: candidate.furthest_stage, offer_status: candidate.furthest_offer_status });
    return <StageBadge label={stage.label} color={stageColor(stage.color)} />;
  }
  if (candidate.rejected_count) return <Badge tone="danger">已拒绝</Badge>;
  return <span className="muted">未投递</span>;
}

type JobOptions = Awaited<ReturnType<typeof api.jobOptions>>["items"];

export function CandidatesPage({ meta, canWrite }: { meta: Meta; canWrite: boolean }) {
  const tabIdBase = useId();
  const activePanelRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState("");
  const [jobId, setJobId] = useState("");
  const [group, setGroup] = useState<CandidateGroup | "">("");
  const [creating, setCreating] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [jobOptions, setJobOptions] = useState<JobOptions | null>(null);
  const [jobOptionsFailed, setJobOptionsFailed] = useState(false);
  const [jobOptionsAttempt, setJobOptionsAttempt] = useState(0);
  const requestSeq = useRef(0);
  const keyword = query.trim();

  // 保存后也生成新的查询标识。条件变化时，渲染阶段立即撤下旧结果和人数。
  const request = useMemo(() => ({
    params: { q: keyword || undefined, jobId: jobId || undefined, group: group || undefined, page, pageSize: 20 },
    reloadKey,
  }), [keyword, jobId, group, page, reloadKey]);
  const [result, setResult] = useState<({ request: typeof request } & (
    | { status: "success"; data: CandidateList }
    | { status: "error"; message: string }
  )) | null>(null);

  const load = useCallback(() => {
    const seq = ++requestSeq.current;
    setResult(null);
    api.candidates(request.params).then(
      (data) => {
        if (seq === requestSeq.current) setResult({ request, status: "success", data });
      },
      (err: unknown) => {
        if (seq !== requestSeq.current) return;
        const message = err instanceof ApiError ? err.message : "候选人加载失败";
        setResult({ request, status: "error", message });
      },
    );
  }, [request]);

  useEffect(() => {
    const timer = window.setTimeout(load, keyword ? 220 : 0);
    return () => {
      window.clearTimeout(timer);
      requestSeq.current += 1;
    };
  }, [load, keyword]);

  useEffect(() => {
    let ignore = false;
    api.jobOptions().then(
      ({ items }) => { if (!ignore) setJobOptions(items); },
      () => { if (!ignore) setJobOptionsFailed(true); },
    );
    return () => { ignore = true; };
  }, [jobOptionsAttempt]);

  const currentResult = result?.request === request ? result : null;
  const loading = currentResult === null;
  const data = currentResult?.status === "success" ? currentResult.data : null;
  const groupLabel = candidateGroups.find((tab) => tab.value === group)?.label ?? "";
  const groupCounts = data?.groupCounts;

  function changePage(next: number) {
    activePanelRef.current?.focus();
    setPage(next);
  }

  function retry() {
    activePanelRef.current?.focus();
    load();
  }

  return (
    <div className="page">
      <PageHeader
        title="候选人"
        description="简历上传后会自动抽出联系方式和技能，你再确认一次。" 
        actions={canWrite && (
          <Button variant="primary" icon={<IconPlus size={16} />} onClick={() => setCreating(true)}>
            添加候选人
          </Button>
        )}
      />

      <div className="group-tabs">
        <Tabs
          idBase={tabIdBase}
          label="按流程阶段分类"
          value={group}
          onChange={(value) => {
            if (value === group) return;
            setGroup(value as CandidateGroup | "");
            setPage(1);
          }}
          tabs={candidateGroups.map((tab) => ({
            ...tab,
            count: groupCounts?.[tab.value || "all"],
          }))}
        />
      </div>

      <div className="toolbar">
        <div className="toolbar-left">
          <SearchInput
            inputRef={searchInputRef}
            value={query}
            onChange={(value) => { setQuery(value); setPage(1); }}
            placeholder="搜索姓名、公司、职位或技能"
          />
          <Select
            className="candidate-job-filter"
            value={jobId}
            disabled={jobOptions === null || jobOptions.length === 0}
            onChange={(event) => {
              setJobId(event.target.value);
              setPage(1);
            }}
            aria-label="按投递职位筛选"
          >
            <option value="">{jobOptions || jobOptionsFailed ? "全部职位" : "职位加载中…"}</option>
            {jobOptions?.map((job) => (
              <option key={job.id} value={job.id}>
                {job.title}{job.department && ` · ${job.department}`}
                {job.status === "closed" ? "（已关闭）" : job.status === "paused" ? "（已暂停）" : ""}
              </option>
            ))}
          </Select>
          {jobOptionsFailed && (
            <Button variant="ghost" size="sm" onClick={(event) => {
              if (document.activeElement === event.currentTarget) searchInputRef.current?.focus();
              setJobOptionsFailed(false);
              setJobOptionsAttempt((value) => value + 1);
            }}>
              职位加载失败，重试
            </Button>
          )}
          {(keyword || jobId || group) && (
            <Button
              variant="ghost"
              size="sm"
              onClick={(event) => {
                if (document.activeElement === event.currentTarget) searchInputRef.current?.focus();
                setQuery("");
                setJobId("");
                setGroup("");
                setPage(1);
              }}
            >
              清空筛选
            </Button>
          )}
        </div>
        <div className="toolbar-right">
          <span className="list-note" role="status">
            {loading ? "正在加载…" : data && (group
              ? `「${groupLabel}」${data.total} 位`
              : keyword || jobId
                ? `筛出 ${data.total} 位`
                : `共 ${data.total} 位候选人`)}
          </span>
        </div>
      </div>

      <TabPanels idBase={tabIdBase} tabs={candidateGroups} value={group} busy={loading} activeRef={activePanelRef}>
        {loading && <ListSkeleton rows={6} />}
        {currentResult?.status === "error" && <ErrorState message={currentResult.message} onRetry={retry} />}

        {data && data.items.length === 0 && (
          <EmptyState
            title={
              keyword || jobId
                ? "没有匹配的候选人"
                : group
                  ? `「${groupLabel}」下还没有候选人`
                  : "还没有候选人"
            }
            description={
              jobId
                ? "换个职位、流程阶段或关键词，也可以清空筛选。"
                : keyword
                  ? "换个关键词或清空筛选看看。"
                  : group
                    ? "换个分类或清空筛选看看。"
                    : "上传一份简历，或手动录入候选人。"
            }
            action={canWrite && !group && !keyword && !jobId && (
              <Button variant="primary" onClick={() => setCreating(true)}>
                添加候选人
              </Button>
            )}
          />
        )}

        {data && data.items.length > 0 && (
          <>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>候选人</th>
                    <th>当前职位</th>
                    <th>经验</th>
                    <th>技能</th>
                    <th>流程</th>
                    <th>更新</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((candidate) => (
                    <tr key={candidate.id}>
                      <td>
                        <div className="cell-person">
                          <Avatar name={candidate.name} size={32} />
                          <div>
                            <Link to={`/candidates/${candidate.id}`}>{candidate.name}</Link>
                            <span className="muted">{candidate.email ?? candidate.phone ?? "无联系方式"}</span>
                          </div>
                        </div>
                      </td>
                      <td>
                        <span>{candidate.current_title ?? "—"}</span>
                        <span className="muted">{candidate.current_company ?? ""}</span>
                      </td>
                      <td>
                        {candidate.years_experience == null
                          ? "—"
                          : candidate.years_experience <= 0
                            ? "应届 / 1 年内"
                            : `${candidate.years_experience} 年`}
                      </td>
                      <td>
                        <div className="cell-skills">
                          {candidate.skills.slice(0, 3).map((item) => (
                            <span className="tag" key={item}>
                              {item}
                            </span>
                          ))}
                          {candidate.skills.length > 3 && <span className="tag more">+{candidate.skills.length - 3}</span>}
                          {candidate.skills.length === 0 && <span className="muted">—</span>}
                        </div>
                      </td>
                      <td>{candidateStageBadge(candidate)}</td>
                      <td className="muted">{timeAgo(candidate.updated_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {data.pages > 1 && (
              <nav className="pagination" aria-label="分页">
                <Button size="sm" disabled={page <= 1} onClick={() => changePage(page - 1)}>
                  上一页
                </Button>
                <span>
                  {page} / {data.pages}
                </span>
                <Button size="sm" disabled={page >= data.pages} onClick={() => changePage(page + 1)}>
                  下一页
                </Button>
              </nav>
            )}
            <p className="sr-only">{meta.stages.length} 个阶段可用</p>
          </>
        )}
      </TabPanels>

      <CandidateFormModal
        open={creating}
        meta={meta}
        onClose={() => setCreating(false)}
        onSaved={() => {
          setCreating(false);
          setReloadKey((value) => value + 1);
        }}
      />
    </div>
  );
}

export function CandidateFormModal({
  open,
  candidate,
  meta,
  onClose,
  onSaved,
}: {
  open: boolean;
  candidate?: Candidate | null;
  meta: Meta;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState({
    name: "",
    email: "",
    phone: "",
    location: "",
    current_company: "",
    current_title: "",
    years_experience: "",
    education: "",
    school: "",
    major: "",
    skills: "",
    source: "",
    summary: "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const toast = useToast();

  useEffect(() => {
    if (!open) return;
    setError("");
    setForm({
      name: candidate?.name ?? "",
      email: candidate?.email ?? "",
      phone: candidate?.phone ?? "",
      location: candidate?.location ?? "",
      current_company: candidate?.current_company ?? "",
      current_title: candidate?.current_title ?? "",
      years_experience: candidate?.years_experience != null ? String(candidate.years_experience) : "",
      education: candidate?.education ?? "",
      school: candidate?.school ?? "",
      major: candidate?.major ?? "",
      skills: (candidate?.skills ?? []).join("、"),
      source: candidate?.source ?? "",
      summary: candidate?.summary ?? "",
    });
  }, [open, candidate]);

  async function submit() {
    if (!form.name.trim()) {
      setError("请填写候选人姓名");
      return;
    }
    setBusy(true);
    setError("");
    const payload: CandidateInput = {
      name: form.name.trim(),
      email: form.email.trim() || null,
      phone: form.phone.trim() || null,
      location: form.location.trim() || null,
      current_company: form.current_company.trim() || null,
      current_title: form.current_title.trim() || null,
      years_experience: form.years_experience ? Number(form.years_experience) : null,
      education: form.education.trim() || null,
      school: form.school.trim() || null,
      major: form.major.trim() || null,
      skills: form.skills.split(/[、,，\s]+/).map((item) => item.trim()).filter(Boolean),
      source: form.source.trim() || null,
      summary: form.summary.trim() || null,
    };
    try {
      if (candidate) await api.updateCandidate(candidate.id, payload);
      else await api.createCandidate(payload);
      toast.push(candidate ? "候选人已更新" : "候选人已添加", "success");
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={candidate ? "编辑候选人" : "添加候选人"}
      description="只填姓名也能先建档案，简历和其他信息之后补。"
      width={640}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" loading={busy} onClick={() => void submit()}>
            {candidate ? "保存" : "添加"}
          </Button>
        </>
      }
    >
      <div className="form-grid">
        <Field label="姓名" required>
          {(id) => <Input id={id} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />}
        </Field>
        <Field label="手机">
          {(id) => <Input id={id} value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />}
        </Field>
        <Field label="邮箱">
          {(id) => <Input id={id} type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />}
        </Field>
        <Field label="所在城市">
          {(id) => <Input id={id} value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} />}
        </Field>
        <Field label="当前公司">
          {(id) => <Input id={id} value={form.current_company} onChange={(e) => setForm({ ...form, current_company: e.target.value })} />}
        </Field>
        <Field label="当前职位">
          {(id) => <Input id={id} value={form.current_title} onChange={(e) => setForm({ ...form, current_title: e.target.value })} />}
        </Field>
        <Field label="工作年限">
          {(id) => (
            <Input id={id} type="number" min={0} max={60} value={form.years_experience} onChange={(e) => setForm({ ...form, years_experience: e.target.value })} />
          )}
        </Field>
        <Field label="学历">
          {(id) => (
            <Select id={id} value={form.education} onChange={(e) => setForm({ ...form, education: e.target.value })}>
              <option value="">未填写</option>
              {["博士", "硕士", "本科", "大专", "高中"].map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="毕业院校">
          {(id) => <Input id={id} value={form.school} onChange={(e) => setForm({ ...form, school: e.target.value })} />}
        </Field>
        <Field label="专业">
          {(id) => <Input id={id} value={form.major} onChange={(e) => setForm({ ...form, major: e.target.value })} />}
        </Field>
        <Field label="技能" hint="用顿号或逗号分隔" span>
          {(id) => <Input id={id} value={form.skills} onChange={(e) => setForm({ ...form, skills: e.target.value })} placeholder="React、TypeScript、Node.js" />}
        </Field>
        <Field label="来源">
          {(id) => (
            <Select id={id} value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value })}>
              <option value="">未填写</option>
              {["猎头推荐", "员工内推", "官网投递", "招聘平台", "校园招聘", "主动寻访"].map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="备注简介" span>
          {(id) => <Textarea id={id} rows={3} value={form.summary} onChange={(e) => setForm({ ...form, summary: e.target.value })} />}
        </Field>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <p className="sr-only">{meta.roleLabels.admin}</p>
    </Modal>
  );
}

const PARSE_FIELDS: { label: string; key: keyof ParsedFields }[] = [
  { label: "姓名", key: "name" },
  { label: "邮箱", key: "email" },
  { label: "手机", key: "phone" },
  { label: "城市", key: "location" },
  { label: "当前公司", key: "current_company" },
  { label: "当前职位", key: "current_title" },
  { label: "工作年限", key: "years_experience" },
  { label: "学历", key: "education" },
  { label: "院校", key: "school" },
  { label: "专业", key: "major" },
];

function parsedValue(fields: ParsedFields, key: keyof ParsedFields): string | undefined {
  const raw = fields[key];
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw === "number") return key === "years_experience" ? `${raw} 年` : String(raw);
  return Array.isArray(raw) ? raw.join("、") : String(raw);
}

// 头部只展示一条「主投递」：在流程中的按阶段深浅取最靠后的一条，同阶段取最近更新；
// 全部已拒绝时退回最近一条，让头部仍能说明他最后一次投的是哪个职位。
const STAGE_WEIGHT: Record<Application["stage"], number> = {
  hired: 5,
  offer: 4,
  interview: 3,
  screening: 2,
  new: 1,
};

function pickPrimaryApplication(applications: Application[]): Application | null {
  const active = applications.filter((item) => item.status === "active");
  if (active.length > 0) {
    return (
      [...active].sort(
        // 与服务端 listCandidates 的 FURTHEST_STAGE_ORDER 对齐：阶段 → 更新时间 → id，
        // 这样列表徽标和详情头部不会各自挑到不同的投递。
        (a, b) =>
          STAGE_WEIGHT[b.stage] - STAGE_WEIGHT[a.stage] ||
          b.updated_at.localeCompare(a.updated_at) ||
          (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
      )[0] ?? null
    );
  }
  return applications[0] ?? null;
}

export function CandidateDetailPage({
  candidateId,
  meta,
  user,
  onNotify,
}: {
  candidateId: string;
  meta: Meta;
  user: { id: string; role: string };
  onNotify: () => void;
}) {
  const [data, setData] = useState<CandidateDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(false);
  const [applying, setApplying] = useState(false);
  const [schedule, setSchedule] = useState<{ application: Application; round: 1 | 2; draft?: Interview } | null>(null);
  const [drawerId, setDrawerId] = useState<string | null>(null);
  const location = useLocation();
  const targetUrl = new URL(location, window.location.origin);
  const applicationId = targetUrl.searchParams.get("application");
  const section = targetUrl.hash.slice(1);
  const canWrite = user.role === "admin" || user.role === "recruiter";
  const [uploading, setUploading] = useState(false);
  const [showUploader, setShowUploader] = useState(false);
  const [parsed, setParsed] = useState<ParsedResume | null>(null);
  const [parseError, setParseError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const toast = useToast();
  const confirm = useConfirm();
  const navigate = useNavigate();

  const load = useCallback((quiet = false) => {
    if (!quiet) setLoading(true);
    setError("");
    api
      .candidate(candidateId)
      .then(setData)
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : "候选人加载失败"))
      .finally(() => setLoading(false));
  }, [candidateId]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!section || loading || !data) return;
    const frame = window.requestAnimationFrame(() => {
      const target = document.getElementById(section.startsWith("interview-") ? "interviews" : section);
      target?.scrollIntoView({ block: "start" });
      if (section.startsWith("interview-")) {
        const id = section.slice("interview-".length);
        if (data.interviews.some((item) => item.id === id && !item.is_draft)) setDrawerId(id);
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [section, applicationId, loading, data?.candidate.id]);

  function refreshWorkflow() {
    load(true);
    onNotify();
  }

  async function upload(file: File) {
    setUploading(true);
    setParseError("");
    setParsed(null);
    try {
      const result = await api.uploadResume(file);
      setParsed(result.parsed);
      if (result.parseError) setParseError(result.parseError);
      await api.attachResume(candidateId, result.file.id, result.parsed);
      toast.push("简历已上传并解析", "success");
      setShowUploader(false);
      load();
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "上传失败";
      setParseError(message);
      toast.push(message, "error");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function remove() {
    if (!data) return;
    const ok = await confirm({
      title: `删除 ${data.candidate.name}？`,
      description: "候选人档案、投递记录和面试安排会一起删除，无法恢复。",
      confirmLabel: "删除",
      tone: "danger",
    });
    if (!ok) return;
    try {
      await api.deleteCandidate(candidateId);
      toast.push("候选人已删除", "success");
      navigate("/candidates");
    } catch (err) {
      toast.push(err instanceof ApiError ? err.message : "删除失败", "error");
    }
  }

  if (loading) return <div className="page"><ListSkeleton rows={4} /></div>;
  if (error) return <div className="page"><ErrorState message={error} onRetry={() => load()} /></div>;
  if (!data) return null;

  const { candidate, applications, interviews, resumeFile } = data;
  const primaryApplication = pickPrimaryApplication(applications);
  const otherApplicationCount = applications.length - 1;
  const selectedApplication = applications.find((item) => item.id === applicationId) ?? primaryApplication;
  const selectedInterviews = interviews.filter((item) => item.application_id === selectedApplication?.id).sort(compareRounds);
  const activeInterview = selectedApplication?.status === "active" && selectedApplication.stage === "interview";
  const nextRound = selectedInterviews.some((item) => item.round === 1 && item.status === "completed" && item.decision === "advance") ? 2 : 1;
  const existingRound = selectedInterviews.some((item) => item.round === nextRound && (
    item.status === "scheduled" || (item.status === "completed" && item.decision && item.decision !== "reject")
  ));
  const canScheduleRound = canWrite && activeInterview && !existingRound;
  const drawerInterview = drawerId ? interviews.find((item) => item.id === drawerId) : undefined;
  const archivedIds = new Set(applications.filter((item) => item.status === "rejected").map((item) => item.id));
  const scheduledInterviews = interviews
    .filter((item) => item.status === "scheduled" && !item.is_draft && !archivedIds.has(item.application_id))
    .sort((a, b) => new Date(a.scheduled_at).getTime() - new Date(b.scheduled_at).getTime());
  const nextInterview = scheduledInterviews[0] ?? null;
  const storedParsed = candidate.parsed ?? null;
  const parseView = parsed ?? storedParsed;
  const parsedFields = (candidate.parsed?.fields ?? parsed?.fields ?? {}) as ParsedFields;
  const missingFields = PARSE_FIELDS.filter(({ key }) => !parsedValue(parsedFields, key)).map(({ label }) => label);
  const nameMismatch =
    parsedFields.name && parsedFields.name !== candidate.name ? parsedFields.name : null;

  return (
    <div className="page">
      <nav className="breadcrumb">
        <Link to="/candidates">候选人</Link>
        <span>/</span>
        <span>{candidate.name}</span>
      </nav>

      <div className="profile-head">
        <Avatar name={candidate.name} size={56} />
        <div className="profile-title">
          <h1>{candidate.name}</h1>
          <p>
            {[candidate.current_title, candidate.current_company].filter(Boolean).join(" · ") || "资料待补充"}
          </p>
          <div className="profile-contact">
            {candidate.email && (
              <span className="inline-icon">
                <IconMail size={14} /> {candidate.email}
              </span>
            )}
            {candidate.phone && (
              <span className="inline-icon">
                <IconPhone size={14} /> {candidate.phone}
              </span>
            )}
            {candidate.location && (
              <span className="inline-icon">
                <IconMapPin size={14} /> {candidate.location}
              </span>
            )}
          </div>
        </div>
        <div className="profile-actions">
          {canWrite && <IconButton label="编辑候选人" onClick={() => setEditing(true)}>
            <IconEdit size={16} />
          </IconButton>}
          {user.role === "admin" && (
            <IconButton label="删除候选人" onClick={() => void remove()}>
              <IconTrash size={16} />
            </IconButton>
          )}
          {primaryApplication && (
            <span className="status-chip">
              <span className="status-chip-label">职位</span>
              <Link
                className="status-chip-link"
                to={`/jobs/${primaryApplication.job_id}/screening`}
                title={primaryApplication.job_title ?? undefined}
              >
                {primaryApplication.job_title ?? "未知职位"}
              </Link>
              {primaryApplication.status === "rejected" ? (
                <Badge tone="danger" dot>
                  已拒绝
                </Badge>
              ) : (
                <StageBadge
                  label={workflowStage(primaryApplication).label}
                  color={stageColor(workflowStage(primaryApplication).color)}
                />
              )}
              {otherApplicationCount > 0 && (
                <a
                  className="status-chip-more"
                  href="#applications"
                  aria-label={`+${otherApplicationCount}，查看另外 ${otherApplicationCount} 条投递记录`}
                >
                  +{otherApplicationCount}
                </a>
              )}
            </span>
          )}
          {nextInterview && (
            <a
              className="status-chip"
              href="#interviews"
              title={[
                interviewTitle(nextInterview.title, nextInterview.round),
                fmtDateTime(nextInterview.scheduled_at),
                meta.interviewModeLabels[nextInterview.mode] ?? nextInterview.mode,
                nextInterview.interviewer_name ?? "面试官待定",
                scheduledInterviews.length > 1 ? `共 ${scheduledInterviews.length} 场待进行` : "",
              ]
                .filter(Boolean)
                .join(" · ")}
              aria-label={[
                `已安排面试 ${fmtDateTime(nextInterview.scheduled_at)}`,
                scheduledInterviews.length > 1 ? `共 ${scheduledInterviews.length} 场待进行` : "",
                "查看面试记录",
              ]
                .filter(Boolean)
                .join("，")}
            >
              <IconCalendar size={15} />
              <span>已安排面试</span>
              <span className="status-chip-time">{fmtDateTime(nextInterview.scheduled_at)}</span>
              {scheduledInterviews.length > 1 && (
                <span className="status-chip-more">共 {scheduledInterviews.length} 场</span>
              )}
            </a>
          )}
          {canScheduleRound && selectedApplication ? <Button variant="primary" onClick={() => setSchedule({ application: selectedApplication, round: nextRound })}>{nextRound === 2 ? "安排复试" : "安排初试"}</Button>
            : selectedApplication?.status === "active" && selectedApplication.stage !== "hired" && <a className="btn btn-primary btn-md" href={`#${applicationTarget(selectedApplication).section}`}>{applicationTarget(selectedApplication).label}</a>}
          {canWrite && <Button
            variant={primaryApplication ? "ghost" : "secondary"}
            size={primaryApplication ? "sm" : "md"}
            icon={<IconPlus size={primaryApplication ? 15 : 16} />}
            onClick={() => setApplying(true)}
          >{primaryApplication ? "投递其他职位" : "投递职位"}</Button>}
        </div>
      </div>

      <div className="detail-grid">
        <div className="stack">
          {selectedApplication && <>
            {selectedApplication.stage !== "new" && selectedApplication.stage !== "screening" && <p className="workflow-context">当前投递 · {selectedApplication.job_title ?? "职位"}</p>}
            {(selectedApplication.stage === "offer" || selectedApplication.stage === "hired" || selectedApplication.offer_status) && <OfferPanel key={`offer-${selectedApplication.id}`} application={selectedApplication} canWrite={canWrite} onChange={refreshWorkflow} />}
            <ScreeningPanel key={`screening-${selectedApplication.id}`} application={selectedApplication} canWrite={canWrite} rejectionReasons={meta.rejectionReasons} onChange={refreshWorkflow} />
          </>}
          <Card id="resume" className="workflow-panel">
            <header className="card-head">
              <h2>简历</h2>
              {resumeFile ? (
                canWrite && !showUploader && (
                  <Button size="sm" variant="ghost" onClick={() => setShowUploader(true)}>
                    替换简历
                  </Button>
                )
              ) : (
                <Badge>未上传</Badge>
              )}
            </header>

            {canWrite && (!resumeFile || showUploader || uploading) && (
            <div
              className={`upload-zone ${uploading ? "busy" : ""}`}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                const file = event.dataTransfer.files?.[0];
                if (file) void upload(file);
              }}
            >
              <IconUpload size={20} />
              <div>
                <strong>{uploading ? "正在上传并解析…" : "拖入简历，或选择文件"}</strong>
                <p>支持 PDF、DOCX、TXT，单个不超过 {Math.round(meta.resumeMaxBytes / 1024 / 1024)} MB。旧版 .doc 请先另存为 PDF。</p>
              </div>
              <Button size="sm" loading={uploading} onClick={() => fileRef.current?.click()}>
                选择文件
              </Button>
              <input
                ref={fileRef}
                type="file"
                accept={meta.resumeAccept}
                hidden
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void upload(file);
                }}
              />
            </div>
            )}

            {parseError && (
              <p className="form-error" role="alert">
                {parseError}
              </p>
            )}

            {parseView && (
              <div className="parse-result">
                <header>
                  <span className="inline-icon">
                    <IconSpark size={14} /> 解析结果
                  </span>
                  <span className="muted">
                    识别 {parseView.chars ?? 0} 字 · 置信度 {Math.round((parseView.confidence ?? 0) * 100)}%
                    {!parsed && storedParsed ? " · 上次上传" : ""}
                  </span>
                </header>
                <dl className="field-grid">
                  {PARSE_FIELDS.filter(({ key }) => parsedValue(parsedFields, key)).map(({ label, key }) => (
                    <ParsedField key={key} label={label} value={parsedValue(parsedFields, key)} />
                  ))}
                </dl>
                {parsedFields.skills && parsedFields.skills.length > 0 && (
                  <div className="tag-row parse-skills">
                    {parsedFields.skills.map((skill) => (
                      <span className="tag" key={skill}>
                        {skill}
                      </span>
                    ))}
                  </div>
                )}
                {nameMismatch && (
                  <p className="parse-warning">
                    简历上的姓名是「{nameMismatch}」，与候选人档案不一致，请核对是不是同一个人。
                  </p>
                )}
                {missingFields.length > 0 && (
                  <p className="parse-missing">没识别到：{missingFields.join("、")}</p>
                )}
                {parseView.warnings && parseView.warnings.length > 0 && (
                  <ul className="warn-list">
                    {parseView.warnings.map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                )}
                <p className="muted">
                  {parsed
                    ? "已写入候选人的空白字段，已有内容不会被覆盖。需要修改请点编辑。"
                    : "这份结果来自上次上传；替换简历后会重新识别并再次补空缺。"}
                </p>
              </div>
            )}

            {resumeFile && (
              <div className="file-row">
                <IconFile size={16} />
                {/* 服务端强制附件下载，这里不再开新标签页，避免空白窗口 */}
                <a href={api.fileUrl(resumeFile.id)} download={resumeFile.filename}>
                  {resumeFile.filename}
                </a>
                <span className="muted">{bytesText(resumeFile.size)}</span>
                <a
                  className="icon-btn"
                  href={api.fileUrl(resumeFile.id)}
                  download={resumeFile.filename}
                  aria-label="下载简历"
                >
                  <IconDownload size={16} />
                </a>
              </div>
            )}
          </Card>

          <Card id="applications">
            <header className="card-head">
              <h2>投递记录</h2>
              <span className="muted">{applications.length} 条</span>
            </header>
            {applications.length === 0 ? (
              <EmptyState title="还没有投递" description="选择一个在招职位，把这个候选人放进流程。" action={canWrite ? <Button onClick={() => setApplying(true)}>投递职位</Button> : undefined} />
            ) : (
              <ul className="application-list">
                {applications.map((item) => (
                  <li key={item.id}>
                    <div className="app-main">
                      <Link to={`/jobs/${item.job_id}/screening`}>{item.job_title}</Link>
                      <span className="muted">
                        {item.job_department ?? ""} · 投递于 {fmtDate(item.applied_at)}
                      </span>
                    </div>
                    <div className="application-state">
                      {item.status === "rejected" ? (
                        <>
                          <Badge tone="danger">已拒绝</Badge>
                          {item.rejection_reason && <span className="muted">{item.rejection_reason}</span>}
                        </>
                      ) : (
                        <StageBadge label={workflowStage(item).label} color={stageColor(workflowStage(item).color)} />
                      )}
                      {item.id !== selectedApplication?.id ? <Link className="text-link" to={candidateLink(candidateId, item.id, item.status === "active" ? applicationTarget(item).section : "screening")}>查看流程</Link> : <span className="muted">当前投递</span>}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card id="interviews" className="workflow-panel">
            <header className="card-head"><h2>面试记录</h2>{selectedApplication && <span className="muted">{selectedApplication.job_title}</span>}</header>
            {selectedInterviews.length === 0 ? <EmptyState compact title="还没有面试" description={activeInterview ? "安排初试后，面试会出现在日历中。" : "筛选推进后可安排初试。"} /> :
              <ul className="interview-mini">
                {selectedInterviews.map((item) => <li key={item.id}>
                  <span className="legend-band" style={{ background: stageColor("interview") }} aria-hidden />
                  <div><strong>{interviewTitle(item.title, item.round)}</strong>
                    <p>{item.is_draft ? "复试待安排" : `${fmtDateTime(item.scheduled_at)} · ${meta.interviewModeLabels[item.mode] ?? item.mode} · ${item.interviewer_name ?? "面试官待定"}`}</p>
                  </div>
                  <div className="workflow-actions">
                    {item.is_draft ? canWrite && activeInterview && selectedApplication && <Button size="sm" variant="primary" onClick={() => setSchedule({ application: selectedApplication, round: 2, draft: item })}>安排复试</Button> :
                      <Button size="sm" onClick={() => setDrawerId(item.id)}>{item.status === "cancelled" ? "已取消 · 查看" : item.status === "no_show" ? "未到场 · 查看" : item.decision || item.status === "completed" ? "查看结论" : "打开面试记录"}</Button>}
                  </div>
                </li>)}
              </ul>}
          </Card>
        </div>

        <div className="stack">
          <Card>
            <header className="card-head">
              <h2>档案</h2>
            </header>
            <dl className="field-grid">
              <ParsedField label="工作年限" value={candidate.years_experience != null ? `${candidate.years_experience} 年` : undefined} />
              <ParsedField label="学历" value={candidate.education} />
              <ParsedField label="院校" value={candidate.school} />
              <ParsedField label="专业" value={candidate.major} />
              <ParsedField label="来源" value={candidate.source} />
              <ParsedField label="负责人" value={candidate.owner_name} />
              <ParsedField label="创建时间" value={fmtDate(candidate.created_at)} />
            </dl>
            {!candidate.education && !candidate.school && !candidate.major && (
              <p className="profile-hint">学历、院校和专业还没识别到，上传简历后会自动补上，也可以手动编辑。</p>
            )}
            {candidate.skills.length > 0 && (
              <>
                <h3 className="mini-title">技能</h3>
                <div className="tag-row">
                  {candidate.skills.map((skill) => (
                    <span className="tag" key={skill}>
                      {skill}
                    </span>
                  ))}
                </div>
              </>
            )}
            {candidate.summary && (
              <>
                <h3 className="mini-title">简介</h3>
                <p className="prose-text">{candidate.summary}</p>
              </>
            )}
            {candidate.tags.length > 0 && (
              <>
                <h3 className="mini-title">标签</h3>
                <div className="tag-row">
                  {candidate.tags.map((tag) => (
                    <span className="tag" key={tag}>
                      {tag}
                    </span>
                  ))}
                </div>
              </>
            )}
            {(candidate.linkedin || candidate.portfolio) && (
              <>
                <h3 className="mini-title">链接</h3>
                <ul className="link-list">
                  {candidate.linkedin && (
                    <li>
                      <a href={candidate.linkedin} target="_blank" rel="noreferrer">
                        LinkedIn <IconArrowUpRight size={13} />
                      </a>
                    </li>
                  )}
                  {candidate.portfolio && (
                    <li>
                      <a href={candidate.portfolio} target="_blank" rel="noreferrer">
                        作品集 <IconArrowUpRight size={13} />
                      </a>
                    </li>
                  )}
                </ul>
              </>
            )}
          </Card>
        </div>
      </div>

      <CandidateFormModal open={editing} candidate={candidate} meta={meta} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); load(); }} />
      <ApplyModal
        open={applying}
        candidateId={candidateId}
        applications={applications}
        onClose={() => setApplying(false)}
        onDone={() => {
          setApplying(false);
          load();
        }}
      />
      {schedule && <ScheduleInterviewModal
        open
        applications={[schedule.application]}
        round={schedule.round}
        draft={schedule.draft}
        candidateName={candidate.name}
        meta={meta}
        onClose={() => setSchedule(null)}
        onDone={() => { setSchedule(null); refreshWorkflow(); }}
      />}
      {drawerInterview && <InterviewDrawer key={drawerInterview.id} interview={drawerInterview} rejectionReasons={meta.rejectionReasons} canWrite={canWrite && applications.some((item) => item.id === drawerInterview.application_id && item.status === "active" && item.stage === "interview")} onClose={() => setDrawerId(null)} onChange={refreshWorkflow} />}
    </div>
  );
}

function ParsedField({ label, value }: { label: string; value?: string | null }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value || <span className="muted">未识别</span>}</dd>
    </div>
  );
}

export function ApplyModal({
  open,
  candidateId,
  applications,
  onClose,
  onDone,
}: {
  open: boolean;
  candidateId: string;
  applications: Application[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [jobs, setJobs] = useState<JobOptions | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const toast = useToast();

  useEffect(() => {
    if (!open) return;
    let ignore = false;
    setJobs(null);
    setSelectedJobId(null);
    setError("");
    api.jobOptions().then(({ items }) => {
      if (!ignore) setJobs(items);
    }).catch(() => {
      if (ignore) return;
      setJobs([]);
      setError("职位加载失败，请关闭后重试。");
    });
    return () => { ignore = true; };
  }, [open]);

  const appliedJobIds = new Set(applications.map((item) => item.job_id));
  const availableJobs = (jobs ?? []).filter((job) => job.status !== "closed" && !appliedJobIds.has(job.id));
  const jobId = selectedJobId ?? availableJobs.find((job) => job.status === "open")?.id ?? "";
  const canSubmit = availableJobs.some((job) => job.id === jobId);

  async function submit() {
    if (!canSubmit) {
      setError("请选择职位");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api.apply(candidateId, jobId);
      toast.push("已加入招聘流程", "success");
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "投递失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="投递到职位"
      description="投递后候选人会出现在该职位看板的「待筛选」列。"
      width={440}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" loading={busy} disabled={!canSubmit} onClick={() => void submit()}>
            确认投递
          </Button>
        </>
      }
    >
      <Field label="选择职位" required>
        {(id) => (
          <Select
            id={id}
            value={canSubmit ? jobId : ""}
            onChange={(event) => setSelectedJobId(event.target.value)}
            disabled={!availableJobs.length}
          >
            <option value="">{jobs === null ? "正在加载职位…" : "请选择"}</option>
            {availableJobs.map((job) => (
              <option key={job.id} value={job.id}>
                {job.title}
                {job.department ? ` · ${job.department}` : ""}
                {job.status === "paused" ? "（暂停）" : ""}
              </option>
            ))}
          </Select>
        )}
      </Field>
      {jobs !== null && !availableJobs.length && !error && <p className="muted">没有其他可投递的职位。</p>}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </Modal>
  );
}

