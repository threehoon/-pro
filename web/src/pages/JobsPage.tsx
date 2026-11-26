import { useCallback, useEffect, useState } from "react";
import { api, ApiError, type JobInput } from "../lib/api";
import { salaryText, timeAgo } from "../lib/format";
import { Link } from "../lib/router";
import type { Job, Meta, Stage } from "../types";
import {
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
  Tabs,
  Textarea,
  useToast,
} from "../components/ui";
import { IconChevronRight, IconEdit, IconPlus, IconTrash } from "../components/icons";
import { StageTrack } from "../components/StageTrack";

const STAGES: Stage[] = ["new", "screening", "interview", "offer", "hired"];

export function JobsPage({ meta, user }: { meta: Meta; user: { id: string; role: string } }) {
  const [items, setItems] = useState<Job[]>([]);
  const [totals, setTotals] = useState({ open: 0, closed: 0, headcount: 0 });
  const [status, setStatus] = useState("open");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<Job | "new" | null>(null);
  const toast = useToast();

  const load = useCallback(() => {
    setLoading(true);
    setError("");
    api
      .jobs({ status, q: query.trim() || undefined })
      .then((data) => {
        setItems(data.items);
        setTotals(data.totals);
      })
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : "职位加载失败"))
      .finally(() => setLoading(false));
  }, [status, query]);

  useEffect(() => {
    const timer = window.setTimeout(load, query ? 220 : 0);
    return () => window.clearTimeout(timer);
  }, [load, query]);

  async function remove(job: Job) {
    if (!window.confirm(`删除职位「${job.title}」？如果已有投递，请改为关闭职位。`)) return;
    try {
      await api.deleteJob(job.id);
      toast.push("职位已删除", "success");
      load();
    } catch (err) {
      toast.push(err instanceof ApiError ? err.message : "删除失败", "error");
    }
  }

  const headcountOpen = items
    .filter((job) => job.status === "open")
    .reduce((sum, job) => sum + job.headcount, 0);

  return (
    <div className="page">
      <PageHeader
        title="职位"
        description="用一张卡片看清每个职位招几人、走到哪、卡在哪。"
        actions={
          <Button variant="primary" icon={<IconPlus size={16} />} onClick={() => setEditing("new")}>
            新建职位
          </Button>
        }
      />

      <div className="toolbar">
        <Tabs
          value={status}
          onChange={setStatus}
          tabs={[
            { value: "open", label: "在招", count: totals.open },
            { value: "paused", label: "已暂停" },
            { value: "closed", label: "已关闭", count: totals.closed },
            { value: "all", label: "全部" },
          ]}
        />
        <div className="toolbar-right">
          <SearchInput value={query} onChange={setQuery} placeholder="搜索职位、部门或城市" />
        </div>
      </div>

      {loading && <ListSkeleton rows={4} />}
      {error && <ErrorState message={error} onRetry={load} />}

      {!loading && !error && items.length === 0 && (
        <EmptyState
          title={query ? "没有匹配的职位" : "还没有职位"}
          description={query ? "换个关键词，或清空搜索。" : "先建一个职位，候选人才能进入招聘流程。"}
          action={
            !query ? (
              <Button variant="primary" onClick={() => setEditing("new")}>
                新建职位
              </Button>
            ) : undefined
          }
        />
      )}

      {!loading && !error && items.length > 0 && (
        <>
          <p className="list-note">
            共 {items.length} 个职位 · 在招编制 {headcountOpen} 人
          </p>
          <div className="job-grid">
            {items.map((job, index) => (
              <JobCard
                key={job.id}
                job={job}
                meta={meta}
                index={index}
                canEdit={user.role !== "hiring_manager"}
                canDelete={user.role === "admin"}
                onEdit={() => setEditing(job)}
                onDelete={() => void remove(job)}
              />
            ))}
          </div>
        </>
      )}

      <JobFormModal
        open={Boolean(editing)}
        job={editing === "new" ? null : editing}
        meta={meta}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          load();
        }}
      />
    </div>
  );
}

function JobCard({
  job,
  meta,
  index,
  canEdit,
  canDelete,
  onEdit,
  onDelete,
}: {
  job: Job;
  meta: Meta;
  index: number;
  canEdit: boolean;
  canDelete: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <Card className={`job-card ${job.status !== "open" ? "is-muted" : ""}`} style={{ animationDelay: `${Math.min(index, 6) * 30}ms` }}>
      <div className="job-card-top">
        <div className="job-card-title">
          <Link to={`/jobs/${job.id}`}>{job.title}</Link>
          <span className="job-meta">
            {Array.from(
              new Set(
                [
                  job.department,
                  job.location,
                  meta.employmentTypeLabels[job.employment_type],
                  meta.workModeLabels[job.work_mode],
                ].filter((part): part is string => Boolean(part)),
              ),
            ).join(" · ")}
          </span>
        </div>
        <Badge tone={job.status === "open" ? "brand" : job.status === "paused" ? "warning" : "neutral"}>
          {job.status === "open" ? "在招" : job.status === "paused" ? "暂停" : "已关闭"}
        </Badge>
      </div>

      <StageTrack
        values={STAGES.map((stage) => ({ stage, count: job.stages?.[stage] ?? 0 }))}
        total={Math.max(1, job.active_count ?? 0)}
        label={`${job.active_count ?? 0} 人在流程中`}
      />

      <dl className="job-stats">
        <div>
          <dt>在流程</dt>
          <dd>{job.active_count ?? 0}</dd>
        </div>
        <div>
          <dt>新简历</dt>
          <dd>{job.new_count ?? 0}</dd>
        </div>
        <div>
          <dt>已入职</dt>
          <dd>
            {job.hired_count ?? 0}
            <span className="denom">/{job.headcount}</span>
          </dd>
        </div>
        <div>
          <dt>待面试</dt>
          <dd>{job.upcoming_interviews ?? 0}</dd>
        </div>
      </dl>

      <div className="job-card-foot">
        <span className="salary">{salaryText(job.salary_min, job.salary_max)}</span>
        <div className="job-actions">
          {canEdit && (
            <>
              <IconButton label="编辑职位" onClick={onEdit}>
                <IconEdit size={16} />
              </IconButton>
              {canDelete && (
                <IconButton label="删除职位" onClick={onDelete}>
                  <IconTrash size={16} />
                </IconButton>
              )}
            </>
          )}
          <Link to={`/jobs/${job.id}/screening`} className="btn btn-secondary btn-sm">
            筛选
            <IconChevronRight size={14} />
          </Link>
        </div>
      </div>
      <span className="job-updated">更新于 {timeAgo(job.updated_at)}</span>
    </Card>
  );
}

export function JobFormModal({
  open,
  job,
  meta,
  onClose,
  onSaved,
}: {
  open: boolean;
  job: Job | null;
  meta: Meta;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState({
    title: "",
    department: "",
    location: "",
    work_mode: "onsite",
    employment_type: "full_time",
    level: "",
    headcount: 1,
    salary_min: "",
    salary_max: "",
    description: "",
    requirements: "",
    skills: "",
    status: "open",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const toast = useToast();

  useEffect(() => {
    if (!open) return;
    setError("");
    setForm({
      title: job?.title ?? "",
      department: job?.department ?? "",
      location: job?.location ?? "",
      work_mode: job?.work_mode ?? "onsite",
      employment_type: job?.employment_type ?? "full_time",
      level: job?.level ?? "",
      headcount: job?.headcount ?? 1,
      salary_min: job?.salary_min != null ? String(job.salary_min) : "",
      salary_max: job?.salary_max != null ? String(job.salary_max) : "",
      description: job?.description ?? "",
      requirements: job?.requirements ?? "",
      skills: (job?.skills ?? []).join("、"),
      status: job?.status ?? "open",
    });
  }, [open, job]);

  async function submit() {
    if (!form.title.trim()) {
      setError("请填写职位名称");
      return;
    }
    setBusy(true);
    setError("");
    const payload: JobInput = {
      title: form.title.trim(),
      department: form.department.trim() || null,
      location: form.location.trim() || null,
      work_mode: form.work_mode,
      employment_type: form.employment_type,
      level: form.level.trim() || null,
      headcount: Number(form.headcount) || 1,
      salary_min: form.salary_min ? Number(form.salary_min) : null,
      salary_max: form.salary_max ? Number(form.salary_max) : null,
      description: form.description.trim() || null,
      requirements: form.requirements.trim() || null,
      skills: form.skills
        .split(/[、,，\s]+/)
        .map((item) => item.trim())
        .filter(Boolean),
      status: form.status,
    };
    try {
      if (job) await api.updateJob(job.id, payload);
      else await api.createJob(payload);
      toast.push(job ? "职位已更新" : "职位已创建", "success");
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
      title={job ? "编辑职位" : "新建职位"}
      description="只需要填清楚要招谁、招几人；描述和技能要求之后可以补。"
      width={640}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" loading={busy} onClick={() => void submit()}>
            {job ? "保存" : "创建职位"}
          </Button>
        </>
      }
    >
      <div className="form-grid">
        <Field label="职位名称" required>
          {(id) => <Input id={id} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="如：高级前端工程师" />}
        </Field>
        <Field label="招聘人数">
          {(id) => (
            <Input
              id={id}
              type="number"
              min={1}
              value={form.headcount}
              onChange={(e) => setForm({ ...form, headcount: Number(e.target.value) })}
            />
          )}
        </Field>
        <Field label="部门">
          {(id) => <Input id={id} value={form.department} onChange={(e) => setForm({ ...form, department: e.target.value })} placeholder="如：研发中心" />}
        </Field>
        <Field label="工作城市">
          {(id) => <Input id={id} value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} placeholder="如：上海" />}
        </Field>
        <Field label="工作方式">
          {(id) => (
            <Select id={id} value={form.work_mode} onChange={(e) => setForm({ ...form, work_mode: e.target.value })}>
              {Object.entries(meta.workModeLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="雇佣类型">
          {(id) => (
            <Select id={id} value={form.employment_type} onChange={(e) => setForm({ ...form, employment_type: e.target.value })}>
              {Object.entries(meta.employmentTypeLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="月薪下限（元）">
          {(id) => (
            <Input id={id} type="number" min={0} step={1000} value={form.salary_min} onChange={(e) => setForm({ ...form, salary_min: e.target.value })} placeholder="25000" />
          )}
        </Field>
        <Field label="月薪上限（元）">
          {(id) => (
            <Input id={id} type="number" min={0} step={1000} value={form.salary_max} onChange={(e) => setForm({ ...form, salary_max: e.target.value })} placeholder="40000" />
          )}
        </Field>
        <Field label="技能关键词" hint="用顿号或逗号分隔，用于匹配候选人" span>
          {(id) => <Input id={id} value={form.skills} onChange={(e) => setForm({ ...form, skills: e.target.value })} placeholder="React、TypeScript、性能优化" />}
        </Field>
        <Field label="职位描述" span>
          {(id) => (
            <Textarea id={id} rows={4} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="这个岗位每天在做什么。" />
          )}
        </Field>
        <Field label="任职要求" span>
          {(id) => (
            <Textarea id={id} rows={4} value={form.requirements} onChange={(e) => setForm({ ...form, requirements: e.target.value })} placeholder="必须具备的经验、技能和加分项。" />
          )}
        </Field>
        <Field label="状态">
          {(id) => (
            <Select id={id} value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
              <option value="open">在招</option>
              <option value="paused">暂停</option>
              <option value="closed">关闭</option>
            </Select>
          )}
        </Field>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </Modal>
  );
}
