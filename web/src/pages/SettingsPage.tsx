import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../lib/api";
import { fmtDateTime, timeAgo } from "../lib/format";
import type { FeishuStatus, Meta, NotificationItem, SessionUser } from "../types";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Input,
  ListSkeleton,
  PageHeader,
  Select,
  useToast,
} from "../components/ui";
import { IconArrowUpRight, IconCheck } from "../components/icons";

import { LlmSettings } from "../components/workflow/LlmSettings";

const NOTIFY_STATUS: Record<string, { label: string; tone: "neutral" | "brand" | "warning" | "danger" }> = {
  pending: { label: "待发送", tone: "warning" },
  sent: { label: "已发送", tone: "brand" },
  failed: { label: "失败", tone: "danger" },
  skipped: { label: "已跳过", tone: "neutral" },
};

export function SettingsPage({ user, meta, onLogout }: { user: SessionUser; meta: Meta; onLogout: () => void }) {
  const [team, setTeam] = useState<SessionUser[] | null>(null);
  const [teamError, setTeamError] = useState("");
  const [feishu, setFeishu] = useState<FeishuStatus | null>(null);
  const [feishuError, setFeishuError] = useState("");
  const [notifications, setNotifications] = useState<NotificationItem[] | null>(null);
  const [showAllNotifications, setShowAllNotifications] = useState(false);
  const toast = useToast();
  const isAdmin = user.role === "admin";

  const loadTeam = useCallback(() => {
    setTeamError("");
    api
      .team()
      .then((data) => setTeam(data.items))
      .catch((err: unknown) => setTeamError(err instanceof ApiError ? err.message : "团队加载失败"));
  }, []);

  const loadFeishu = useCallback(() => {
    setFeishuError("");
    api
      .feishu()
      .then(setFeishu)
      .catch((err: unknown) => setFeishuError(err instanceof ApiError ? err.message : "飞书配置加载失败"));
  }, []);

  const loadNotifications = useCallback(() => {
    api
      // 出站箱只看出站消息，不受站内提醒条数挤占
      .notifications({ channel: "feishu", limit: 50 })
      .then((data) => setNotifications(data.items))
      .catch(() => setNotifications([]));
  }, []);

  useEffect(() => {
    loadTeam();
    loadFeishu();
    loadNotifications();
  }, [loadTeam, loadFeishu, loadNotifications]);

  async function changeRole(member: SessionUser, role: string) {
    try {
      const data = await api.setRole(member.id, role);
      setTeam(data.items);
      toast.push("成员权限已更新", "success");
    } catch (err) {
      toast.push(err instanceof ApiError ? err.message : "更新失败", "error");
    }
  }

  return (
    <div className="page page-narrow">
      <PageHeader title="设置" description="管理 AI 模型、飞书接入、团队权限与账号安全。" />

      {isAdmin && <LlmSettings />}

      <Card className="settings-section">
        <header className="card-head">
          <div>
            <h2>飞书接入</h2>
            <p className="card-sub">先填好凭据，平台功能不受影响；消息会先留在出站箱，接通后统一补发。</p>
          </div>
          {feishu && (
            <Badge tone={feishu.configured ? "brand" : "neutral"} dot>
              {feishu.configured ? "已配置" : "未配置"}
            </Badge>
          )}
        </header>

        {feishuError && <ErrorState message={feishuError} onRetry={loadFeishu} />}
        {!feishu && !feishuError && <ListSkeleton rows={3} />}

        {feishu && (
          <>
            <div className="readiness-grid">
              {feishu.checklist.map((item, index) => (
                <div className={`readiness ${item.done ? "done" : ""}`} key={item.key}>
                  <span className="readiness-mark" aria-hidden>
                    {item.done ? <IconCheck size={12} /> : index + 1}
                  </span>
                  <div>
                    <strong>{item.label}</strong>
                    <p>{item.description}</p>
                  </div>
                </div>
              ))}
            </div>

            <div className="feishu-status-row">
              <div>
                <span className="muted">能力就绪度</span>
                <div className="chip-row">
                  <Badge tone={feishu.ready.login ? "brand" : "neutral"}>{feishu.ready.login ? "登录已就绪" : "登录待接入"}</Badge>
                  <Badge tone={feishu.ready.notifications ? "brand" : "neutral"}>
                    {feishu.ready.notifications ? "通知已就绪" : "通知待接入"}
                  </Badge>
                  <Badge tone={feishu.ready.calendar ? "brand" : "neutral"}>{feishu.ready.calendar ? "日历已就绪" : "日历待接入"}</Badge>
                </div>
              </div>
              <div>
                <span className="muted">待发送消息</span>
                <strong className="big-number">{feishu.pendingNotifications}</strong>
              </div>
            </div>

            {isAdmin ? (
              <FeishuForm
                status={feishu}
                onSaved={(next) => {
                  setFeishu(next);
                  toast.push("飞书配置已保存", "success");
                }}
              />
            ) : (
              <p className="muted">只有管理员可以修改飞书凭据；当前已保存 {Object.values(feishu.fields).filter(Boolean).length} 项。</p>
            )}
            <p className="muted feishu-note">
              目前只保存配置、不真正外发。接入飞书登录、机器人消息和日历同步时，出站箱里的消息会按原顺序补发。
              <a href="https://open.feishu.cn/document" target="_blank" rel="noreferrer">
                飞书开放平台文档 <IconArrowUpRight size={12} />
              </a>
            </p>
          </>
        )}
      </Card>

      <Card className="settings-section">
        <header className="card-head">
          <div>
            <h2>飞书出站箱</h2>
            <p className="card-sub">阶段流转与面试安排都会写一条待发消息；接上机器人后按原顺序补发。工作台内的提醒已实时显示在右上角铃铛。</p>
          </div>
          <Button size="sm" onClick={loadNotifications}>
            刷新
          </Button>
        </header>
        {!notifications && <ListSkeleton rows={3} />}
        {notifications && notifications.length === 0 && (
          <EmptyState title="还没有待发消息" description="推进候选人阶段后，这里会出现待飞书发送的消息。" />
        )}
        {notifications && notifications.length > 0 && (
          <ul className="notify-list">
            {(showAllNotifications ? notifications : notifications.slice(0, 5)).map((item) => {
              const status = NOTIFY_STATUS[item.status] ?? { label: item.status, tone: "neutral" as const };
              return (
                <li key={item.id}>
                  <div>
                    <strong>{item.title}</strong>
                    <span className="muted">
                      {item.body ? `${item.body} · ` : ""}
                      {timeAgo(item.created_at)}
                    </span>
                  </div>
                  <div className="notify-meta">
                    <Badge tone={status.tone}>{status.label}</Badge>
                    {item.sent_at && <span className="muted">{fmtDateTime(item.sent_at)}</span>}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {notifications && notifications.length > 5 && (
          <div className="notify-more">
            <Button size="sm" onClick={() => setShowAllNotifications((value) => !value)}>
              {showAllNotifications ? "只看最近 5 条" : `展开全部 ${notifications.length} 条`}
            </Button>
            <span className="muted">
              共 {notifications.length} 条待发消息，接入后按原顺序补发并保留完整记录。
            </span>
          </div>
        )}
      </Card>

      <Card className="settings-section">
        <header className="card-head">
          <div>
            <h2>团队与权限</h2>
            <p className="card-sub">管理员可以调整成员角色；招聘负责人只能看到招聘相关操作。</p>
          </div>
        </header>
        {isAdmin && (
          <AddMemberForm
            roleLabels={meta.roleLabels}
            onCreated={(items) => {
              setTeam(items);
              toast.push("成员已添加", "success");
            }}
          />
        )}
        {teamError && <ErrorState message={teamError} onRetry={loadTeam} />}
        {!team && !teamError && <ListSkeleton rows={3} />}
        {team && (
          <ul className="team-list">
            {team.map((member) => (
              <li key={member.id}>
                <div className="team-person">
                  <strong>
                    {member.name}
                    {member.id === user.id && <span className="you">你</span>}
                  </strong>
                  <span className="muted">
                    {member.username ? `账号 ${member.username} · ${member.email}` : member.email}
                  </span>
                </div>
                {isAdmin ? (
                  <Select
                    value={member.role}
                    aria-label={`${member.name} 的角色`}
                    onChange={(event) => void changeRole(member, event.target.value)}
                    className="role-select"
                  >
                    {Object.entries(meta.roleLabels).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <Badge>{meta.roleLabels[member.role] ?? member.role}</Badge>
                )}
              </li>
            ))}
          </ul>
        )}
        {!isAdmin && <p className="muted">只有管理员可以添加成员或修改角色。</p>}
      </Card>

      <PasswordSection onLogout={onLogout} />
    </div>
  );
}

function AddMemberForm({
  roleLabels,
  onCreated,
}: {
  roleLabels: Record<string, string>;
  onCreated: (items: SessionUser[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: "", email: "", password: "", role: "recruiter" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit() {
    setBusy(true);
    setError("");
    try {
      const data = await api.createMember(form);
      onCreated(data.items);
      setForm({ name: "", email: "", password: "", role: "recruiter" });
      setOpen(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "添加失败");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <div className="team-add">
        <Button size="sm" onClick={() => setOpen(true)}>
          添加成员
        </Button>
        <span className="muted">新成员用这里的邮箱和初始密码登录，登录后可自行修改密码。</span>
      </div>
    );
  }

  return (
    <div className="team-add-form">
      <div className="form-grid">
        <Field label="姓名" required>
          {(id) => <Input id={id} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />}
        </Field>
        <Field label="邮箱" required>
          {(id) => (
            <Input id={id} type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          )}
        </Field>
        <Field label="初始密码" required hint="至少 8 位，交给成员后请对方修改">
          {(id) => (
            <Input
              id={id}
              type="password"
              autoComplete="new-password"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
            />
          )}
        </Field>
        <Field label="角色">
          {(id) => (
            <Select id={id} value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
              {Object.entries(roleLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="form-actions">
        <Button variant="primary" size="sm" loading={busy} onClick={() => void submit()}>
          创建成员
        </Button>
        <Button size="sm" onClick={() => setOpen(false)}>
          取消
        </Button>
      </div>
    </div>
  );
}

function FeishuForm({ status, onSaved }: { status: FeishuStatus; onSaved: (next: FeishuStatus) => void }) {
  const [form, setForm] = useState({
    app_id: "",
    app_secret: "",
    verification_token: "",
    bot_webhook: "",
    calendar_id: "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit() {
    const patch: Record<string, string> = {};
    for (const [key, value] of Object.entries(form)) {
      if (value.trim()) patch[key] = value.trim();
    }
    if (Object.keys(patch).length === 0) {
      setError("至少填写一项后再保存");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const next = await api.saveFeishu(patch);
      onSaved(next);
      setForm({ app_id: "", app_secret: "", verification_token: "", bot_webhook: "", calendar_id: "" });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }

  const items: Array<{ key: keyof typeof form; label: string; placeholder: string; filled: boolean; secret?: boolean }> = [
    { key: "app_id", label: "App ID", placeholder: "cli_xxxxxxxx", filled: status.fields.app_id },
    { key: "app_secret", label: "App Secret", placeholder: "留空表示不修改", filled: status.fields.app_secret, secret: true },
    { key: "verification_token", label: "Verification Token", placeholder: "事件订阅校验用", filled: status.fields.verification_token },
    { key: "bot_webhook", label: "机器人 Webhook", placeholder: "https://open.feishu.cn/open-apis/bot/v2/hook/...", filled: status.fields.bot_webhook },
    { key: "calendar_id", label: "日历 ID", placeholder: "面试日程同步用，可留空", filled: status.fields.calendar_id },
  ];

  return (
    <div className="feishu-form">
      <div className="form-grid">
        {items.map((item) => (
          <Field
            key={item.key}
            label={item.label}
            hint={item.filled ? "已保存，可填写新值覆盖" : undefined}
            span={item.key === "bot_webhook"}
          >
            {(id) => (
              <Input
                id={id}
                type={item.secret ? "password" : "text"}
                value={form[item.key]}
                placeholder={item.placeholder}
                autoComplete="off"
                onChange={(event) => setForm({ ...form, [item.key]: event.target.value })}
              />
            )}
          </Field>
        ))}
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="form-actions">
        <Button variant="primary" loading={busy} onClick={() => void submit()}>
          保存飞书配置
        </Button>
        <span className="muted">{status.updatedAt ? `上次更新 ${fmtDateTime(status.updatedAt)}` : "尚未保存过配置"}</span>
      </div>
    </div>
  );
}

function PasswordSection({ onLogout }: { onLogout: () => void }) {
  const [currentPassword, setCurrent] = useState("");
  const [nextPassword, setNext] = useState("");
  const [confirmPassword, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const toast = useToast();

  async function submit() {
    if (!currentPassword || !nextPassword) {
      setError("请填写当前密码和新密码");
      return;
    }
    if (nextPassword.length < 8) {
      setError("新密码至少 8 位");
      return;
    }
    if (nextPassword !== confirmPassword) {
      setError("两次输入的新密码不一致");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api.changePassword(currentPassword, nextPassword);
      toast.push("密码已更新", "success");
      setCurrent("");
      setNext("");
      setConfirm("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "修改失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="settings-section">
      <header className="card-head">
        <div>
          <h2>账号安全</h2>
          <p className="card-sub">修改后当前会话仍然有效，其他设备需要重新登录。</p>
        </div>
      </header>
      <div className="form-grid">
        <Field label="当前密码" required span>
          {(id) => (
            <Input id={id} type="password" value={currentPassword} autoComplete="current-password" onChange={(event) => setCurrent(event.target.value)} />
          )}
        </Field>
        <Field label="新密码" required hint="至少 8 位">
          {(id) => (
            <Input id={id} type="password" value={nextPassword} autoComplete="new-password" onChange={(event) => setNext(event.target.value)} />
          )}
        </Field>
        <Field label="确认新密码" required>
          {(id) => (
            <Input id={id} type="password" value={confirmPassword} autoComplete="new-password" onChange={(event) => setConfirm(event.target.value)} />
          )}
        </Field>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="form-actions">
        <Button variant="primary" loading={busy} onClick={() => void submit()}>
          更新密码
        </Button>
        <Button variant="ghost" onClick={onLogout}>
          退出登录
        </Button>
      </div>
    </Card>
  );
}
