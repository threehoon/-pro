import { useCallback, useEffect, useState, type ReactNode } from "react";
import { AppShell } from "./components/AppShell";
import { Button, ConfirmProvider, ErrorState, Field, Input, ToastProvider, useToast } from "./components/ui";
import { api, ApiError } from "./lib/api";
import { matchRoute, navigate, usePathname } from "./lib/router";
import type { Meta, SessionUser } from "./types";
import { CandidateDetailPage, CandidatesPage } from "./pages/CandidatesPage";
import { InterviewsPage } from "./pages/InterviewsPage";
import { JobsPage } from "./pages/JobsPage";
import { JobWorkspacePage, jobTabKey } from "./pages/JobWorkspacePage";
import { SettingsPage } from "./pages/SettingsPage";
import { DashboardPage } from "./pages/DashboardPage";

export function App() {
  return (
    <ToastProvider>
      <ConfirmProvider>
        <Gate />
      </ConfirmProvider>
    </ToastProvider>
  );
}

const FEISHU_OAUTH_ERRORS: Record<string, string> = {
  not_configured: "管理员尚未完成飞书自建应用配置，暂不可使用飞书登录。",
  bind_auth_required: "请先登录工作台账号，再到设置页绑定飞书。",
  cancelled: "已取消飞书授权，可重新扫码或使用账号密码登录。",
  invalid_state: "飞书登录状态已失效或重复提交，请重新发起。",
  missing_code: "飞书未返回授权码，请重试。",
  oauth_failed: "飞书身份校验失败，请检查飞书后台的重定向 URL 与应用凭证后重试。",
  account_not_found: "未找到对应的工作台账号，请联系管理员先在设置页添加成员后再使用飞书登录。",
  email_bound_other: "该邮箱对应的工作台账号已绑定其他飞书身份，请联系管理员核对。",
  feishu_conflict: "该飞书账号的身份信息存在冲突，请联系管理员处理。",
  already_bound_other: "该飞书账号已绑定其他工作台成员，请先解绑后再试。",
  bind_failed: "飞书账号绑定失败，请稍后重试。",
};

const FEISHU_OAUTH_NOTICES: Record<string, string> = {
  logged_in: "已通过飞书登录",
  bound: "飞书账号绑定成功，下次可直接扫码登录",
};

function readFeishuOAuthFlash(): { error: string; notice: string } {
  const url = new URL(window.location.href);
  const errorCode = url.searchParams.get("feishu_error");
  const noticeCode = url.searchParams.get("feishu_notice");
  if (!errorCode && !noticeCode) return { error: "", notice: "" };
  return {
    error: errorCode ? (FEISHU_OAUTH_ERRORS[errorCode] ?? "飞书登录或绑定失败，请重试。") : "",
    notice: noticeCode ? (FEISHU_OAUTH_NOTICES[noticeCode] ?? "") : "",
  };
}

function Gate() {
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [user, setUser] = useState<SessionUser | null>(null);
  const [hasUsers, setHasUsers] = useState(true);
  const [feishuLoginEnabled, setFeishuLoginEnabled] = useState(false);
  const [feishuFlash, setFeishuFlash] = useState<{ error: string; notice: string }>(() => readFeishuOAuthFlash());
  const [meta, setMeta] = useState<Meta | null>(null);
  const [unread, setUnread] = useState(0);
  const [error, setError] = useState("");
  const toast = useToast();

  useEffect(() => {
    const url = new URL(window.location.href);
    if (!url.searchParams.has("feishu_error") && !url.searchParams.has("feishu_notice")) return;
    url.searchParams.delete("feishu_error");
    url.searchParams.delete("feishu_notice");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }, []);

  const boot = useCallback(async () => {
    setState("loading");
    try {
      const [bootstrap, metaData] = await Promise.all([api.bootstrap(), api.meta()]);
      setUser(bootstrap.user);
      setHasUsers(bootstrap.hasUsers);
      setFeishuLoginEnabled(Boolean(bootstrap.feishuLoginEnabled));
      setMeta(metaData);
      setState("ready");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "无法连接服务器");
      setState("error");
    }
  }, []);

  useEffect(() => {
    void boot();
  }, [boot]);

  useEffect(() => {
    if (state !== "ready") return;
    if (feishuFlash.notice) {
      toast.push(feishuFlash.notice, "success");
      setFeishuFlash((prev) => ({ ...prev, notice: "" }));
    }
    if (user && feishuFlash.error) {
      toast.push(feishuFlash.error, "error");
      setFeishuFlash((prev) => ({ ...prev, error: "" }));
    }
  }, [state, user, feishuFlash, toast]);

  const refreshUnread = useCallback(async () => {
    if (!user) return;
    try {
      const data = await api.notifications();
      setUnread(data.stats.pending ?? 0);
    } catch {
      /* 通知失败不打断主流程 */
    }
  }, [user]);

  useEffect(() => {
    void refreshUnread();
  }, [refreshUnread]);

  if (state === "loading") {
    return (
      <div className="boot">
        <span className="brand-mark large" aria-hidden>
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
            <path d="M4 6.5c4.5 0 4.5 11 9.5 11S20 6.5 20 6.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            <circle cx="4" cy="6.5" r="1.8" fill="currentColor" />
            <circle cx="20" cy="6.5" r="1.8" fill="currentColor" />
          </svg>
        </span>
        <p>正在打开工作台…</p>
      </div>
    );
  }

  if (state === "error" || !meta) {
    return (
      <div className="boot">
        <ErrorState message={error || "工作台暂时无法打开"} onRetry={() => void boot()} />
      </div>
    );
  }

  if (!user) {
    return (
      <AuthScreen
        hasUsers={hasUsers}
        feishuLoginEnabled={feishuLoginEnabled}
        initialError={feishuFlash.error}
        onAuthed={(next) => {
          setUser(next);
          setHasUsers(true);
          setFeishuFlash({ error: "", notice: "" });
        }}
      />
    );
  }

  return (
    <AppShell user={user} unread={unread}>
      <Routes
        user={user}
        meta={meta}
        onUserUpdated={setUser}
        onFeishuConfigChanged={(enabled) => setFeishuLoginEnabled(enabled)}
        onLogout={async () => {
          await api.logout();
          setUser(null);
          try {
            const refreshed = await api.bootstrap();
            setFeishuLoginEnabled(Boolean(refreshed.feishuLoginEnabled));
          } catch {
            /* 保持当前飞书登录开关状态 */
          }
        }}
        onNotify={() => void refreshUnread()}
      />
    </AppShell>
  );
}

function Routes({
  user,
  meta,
  onUserUpdated,
  onFeishuConfigChanged,
  onLogout,
  onNotify,
}: {
  user: SessionUser;
  meta: Meta;
  onUserUpdated: (user: SessionUser) => void;
  onFeishuConfigChanged: (enabled: boolean) => void;
  onLogout: () => Promise<void>;
  onNotify: () => void;
}) {
  const path = usePathname();
  const jobSub = matchRoute("/jobs/:jobId/:tab", path);
  const jobDetail = matchRoute("/jobs/:jobId", path);
  const candidate = matchRoute("/candidates/:candidateId", path);
  const jobTab = jobSub ? jobTabKey(jobSub.tab ?? "") : null;

  // 旧地址（/jobs/:id 与 /jobs/:id/board）先照常显示内容，再把地址改成新子模块，
  // 这样书签和分享出来的链接仍然能打开。
  useEffect(() => {
    if (jobSub && jobSub.tab === "board") navigate(`/jobs/${jobSub.jobId}/screening`, { replace: true });
    else if (jobSub && !jobTab) navigate(`/jobs/${jobSub.jobId}/overview`, { replace: true });
    else if (jobDetail) navigate(`/jobs/${jobDetail.jobId}/overview`, { replace: true });
  }, [jobSub, jobDetail, jobTab]);

  const canWrite = user.role === "admin" || user.role === "recruiter";
  let page: ReactNode;
  if (jobSub) {
    const jobId = jobSub.jobId ?? "";
    const tab = jobTab ?? "overview";
    page = (
      <JobWorkspacePage
        key={`${jobId}:${tab}`}
        jobId={jobId}
        tab={tab}
        meta={meta}
        canWrite={canWrite}
        onNotify={onNotify}
      />
    );
  } else if (jobDetail) {
    const jobId = jobDetail.jobId ?? "";
    page = (
      <JobWorkspacePage
        key={`${jobId}:overview`}
        jobId={jobId}
        tab="overview"
        meta={meta}
        canWrite={canWrite}
        onNotify={onNotify}
      />
    );
  } else if (path === "/jobs") page = <JobsPage meta={meta} user={user} />;
  else if (candidate)
    page = <CandidateDetailPage key={candidate.candidateId} candidateId={candidate.candidateId ?? ""} meta={meta} user={user} onNotify={onNotify} />;
  else if (path === "/candidates") page = <CandidatesPage meta={meta} canWrite={canWrite} />;
  else if (path === "/interviews") page = <InterviewsPage meta={meta} canWrite={canWrite} />;
  else if (path === "/settings")
    page = (
      <SettingsPage
        user={user}
        meta={meta}
        onUserUpdated={onUserUpdated}
        onFeishuConfigChanged={onFeishuConfigChanged}
        onLogout={() => void onLogout()}
      />
    );
  else page = <DashboardPage meta={meta} user={user} />;

  return page;
}


function AuthScreen({
  hasUsers,
  feishuLoginEnabled,
  initialError,
  onAuthed,
}: {
  hasUsers: boolean;
  feishuLoginEnabled: boolean;
  initialError?: string;
  onAuthed: (user: SessionUser) => void;
}) {
  // 只有系统里还没有用户时才开放自助注册，之后成员由管理员在设置页添加
  const mode: "login" | "register" = hasUsers ? "login" : "register";
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(initialError ?? "");
  const toast = useToast();

  useEffect(() => {
    if (initialError) setError(initialError);
  }, [initialError]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result =
        mode === "register"
          ? await api.register({ name, email, password })
          : await api.login(email, password);
      toast.push(mode === "register" ? "工作台已创建" : "已登录", "success");
      onAuthed(result.user);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "登录失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-screen">
      <section className="auth-panel">
        <div className="auth-brand">
          <span className="brand-mark large" aria-hidden>
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
              <path d="M4 6.5c4.5 0 4.5 11 9.5 11S20 6.5 20 6.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              <circle cx="4" cy="6.5" r="1.8" fill="currentColor" />
              <circle cx="20" cy="6.5" r="1.8" fill="currentColor" />
            </svg>
          </span>
          <div>
            <strong>Hireloop</strong>
            <span>招聘工作台</span>
          </div>
        </div>
        <h1>{mode === "register" ? "创建第一个管理员" : "登录工作台"}</h1>
        <p className="auth-lead">
          {hasUsers
            ? "职位、候选人、面试和流程看板都在这里推进。新成员请让管理员在设置页添加。"
            : "第一个注册的人会成为管理员，之后可以在设置页添加成员并分配角色。"}
        </p>
        <form className="stack" onSubmit={(event) => void submit(event)}>
          {mode === "register" && (
            <Field label="姓名" required>
              {(id) => <Input id={id} value={name} onChange={(event) => setName(event.target.value)} required autoFocus />}
            </Field>
          )}
          <Field label={mode === "register" ? "邮箱" : "账号"} required>
            {(id) => (
              <Input
                id={id}
                type={mode === "register" ? "email" : "text"}
                autoComplete="username"
                placeholder={mode === "login" ? "邮箱或账号名" : undefined}
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
                autoFocus={mode === "login"}
              />
            )}
          </Field>
          <Field label="密码" required hint={mode === "register" ? "至少 8 位" : undefined}>
            {(id) => (
              <Input
                id={id}
                type="password"
                autoComplete={mode === "login" ? "current-password" : "new-password"}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
                minLength={mode === "register" ? 8 : 1}
              />
            )}
          </Field>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <Button variant="primary" type="submit" loading={busy}>
            {mode === "register" ? "创建并进入" : "登录"}
          </Button>
        </form>
        {mode === "login" && feishuLoginEnabled && (
          <div className="auth-feishu">
            <div className="auth-divider" aria-hidden>
              <span>或</span>
            </div>
            <a className="btn btn-md btn-secondary auth-feishu-btn" href="/api/auth/feishu/start?mode=login">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
                <rect x="3.5" y="3.5" width="7" height="7" rx="1.2" stroke="currentColor" strokeWidth="1.5" />
                <rect x="13.5" y="3.5" width="7" height="7" rx="1.2" stroke="currentColor" strokeWidth="1.5" />
                <rect x="3.5" y="13.5" width="7" height="7" rx="1.2" stroke="currentColor" strokeWidth="1.5" />
                <path d="M14 14h2.5v2.5H14V14Zm4 0h2.5v2.5H18V14Zm-4 4h2.5v2.5H14V18Zm4 0h2.5v2.5H18V18Z" fill="currentColor" />
              </svg>
              使用飞书登录
            </a>
          </div>
        )}
        {!hasUsers && (
          <p className="auth-hint">系统还没有账号，先创建第一位管理员。</p>
        )}
        {hasUsers && (
          <p className="auth-hint">忘记密码请联系管理员重置，或让管理员在设置页为你开通账号。</p>
        )}
      </section>
      <aside className="auth-aside">
        <p className="aside-kicker">一条完整的招聘流</p>
        <ol>
          <li>
            <strong>职位</strong>
            <span>写清楚要招谁、招几人、在哪。</span>
          </li>
          <li>
            <strong>简历</strong>
            <span>上传 PDF 或 DOCX，先抽出姓名、联系方式和技能。</span>
          </li>
          <li>
            <strong>看板</strong>
            <span>从新简历推到筛选、面试、待录用和入职。</span>
          </li>
          <li>
            <strong>面试</strong>
            <span>安排时间，记录评分和结论。</span>
          </li>
        </ol>
        <p className="aside-note">飞书扫码登录与群机器人推送已支持接入，面试日历同步将按阶段开启。</p>
      </aside>
    </div>
  );
}
