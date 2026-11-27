import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../lib/api";
import { fmtDateTime } from "../lib/format";
import type { FeishuOutboxDelivery, FeishuOutboxPage, FeishuOutboxStatus, FeishuStatus, Meta, NotificationItem, SessionUser } from "../types";
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
  useConfirm,
  useToast,
} from "../components/ui";
import { IconArrowUpRight, IconCheck, IconSearch } from "../components/icons";

import { AsrSettings } from "../components/workflow/AsrSettings";
import { BitableSettings } from "../components/workflow/BitableSettings";
import { LlmSettings } from "../components/workflow/LlmSettings";

const NOTIFY_STATUS: Record<FeishuOutboxStatus, { label: string; tone: "neutral" | "brand" | "warning" | "danger" }> = {
  pending: { label: "待发送", tone: "warning" },
  sent: { label: "已发送", tone: "brand" },
  failed: { label: "失败", tone: "danger" },
  skipped: { label: "已跳过", tone: "neutral" },
};

const OUTBOX_PAGE_SIZE = 8;
const OUTBOX_STATUSES = ["all", "pending", "sent", "failed", "skipped"] as const;
type OutboxStatusFilter = (typeof OUTBOX_STATUSES)[number];
type OutboxResult = { key: string } & ({ data: FeishuOutboxPage } | { error: string });

export function SettingsPage({
  user,
  meta,
  onUserUpdated,
  onFeishuConfigChanged,
  onLogout,
}: {
  user: SessionUser;
  meta: Meta;
  onUserUpdated?: (user: SessionUser) => void;
  onFeishuConfigChanged?: (enabled: boolean) => void;
  onLogout: () => void;
}) {
  const [team, setTeam] = useState<SessionUser[] | null>(null);
  const [teamError, setTeamError] = useState("");
  const [unbindingId, setUnbindingId] = useState<string | null>(null);
  const [copiedCallback, setCopiedCallback] = useState(false);
  const [feishu, setFeishu] = useState<FeishuStatus | null>(null);
  const [feishuError, setFeishuError] = useState("");
  const [notifyStatus, setNotifyStatus] = useState<OutboxStatusFilter>("all");
  const [notifyDelivery, setNotifyDelivery] = useState<FeishuOutboxDelivery | "all">("all");
  const [notifySearch, setNotifySearch] = useState("");
  const [notifyPage, setNotifyPage] = useState(1);
  const [notifyVersion, setNotifyVersion] = useState(0);
  const [notifyResult, setNotifyResult] = useState<OutboxResult | null>(null);
  const [lastOutboxPage, setLastOutboxPage] = useState<FeishuOutboxPage | null>(null);
  const notifyResultsRef = useRef<HTMLDivElement>(null);
  const [outboxBusy, setOutboxBusy] = useState<"dispatch" | "skip" | null>(null);
  const [sendingId, setSendingId] = useState<string | null>(null);
  const [outboxNotice, setOutboxNotice] = useState("");
  const [outboxError, setOutboxError] = useState("");
  const toast = useToast();
  const confirm = useConfirm();
  const isAdmin = user.role === "admin";
  const feishuCallbackUrl = feishu?.callbackUrl || `${window.location.origin}/api/auth/feishu/callback`;

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

  const notifyQuery = notifySearch.trim();
  const notifyKey = JSON.stringify([notifyStatus, notifyDelivery, notifyQuery, notifyPage, notifyVersion]);
  const loadNotifications = useCallback(() => setNotifyVersion((value) => value + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      api.feishuOutbox({
        limit: OUTBOX_PAGE_SIZE,
        page: notifyPage,
        status: notifyStatus === "all" ? undefined : notifyStatus,
        delivery: notifyDelivery === "all" ? undefined : notifyDelivery,
        q: notifyQuery,
      }, controller.signal).then((data) => {
        if (controller.signal.aborted) return;
        setLastOutboxPage(data);
        setNotifyResult({ key: notifyKey, data });
      }).catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setNotifyResult({ key: notifyKey, error: err instanceof ApiError ? err.message : "请稍后重试" });
      });
    }, notifyQuery ? 250 : 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [notifyStatus, notifyDelivery, notifyQuery, notifyPage, notifyKey]);

  useEffect(() => {
    loadTeam();
    loadFeishu();
  }, [loadTeam, loadFeishu]);

  function clearOutboxFilters() {
    setNotifyStatus("all");
    setNotifyDelivery("all");
    setNotifySearch("");
    setNotifyPage(1);
  }

  async function changeRole(member: SessionUser, role: string) {
    try {
      const data = await api.setRole(member.id, role);
      setTeam(data.items);
      toast.push("成员权限已更新", "success");
    } catch (err) {
      toast.push(err instanceof ApiError ? err.message : "更新失败", "error");
    }
  }

  async function unbindFeishu(member: SessionUser) {
    const isSelf = member.id === user.id;
    const ok = await confirm({
      title: isSelf ? "解绑当前账号的飞书？" : `解绑 ${member.name} 的飞书账号？`,
      description: isSelf
        ? "解绑后将无法用飞书扫码直接登录当前账号，可随时再次绑定或使用账号密码登录。"
        : "解绑后该成员无法再通过原飞书账号扫码登录，需重新绑定。",
      confirmLabel: "确认解绑",
      tone: "danger",
    });
    if (!ok) return;
    setUnbindingId(member.id);
    try {
      const data = await api.unbindFeishu(isSelf ? undefined : member.id);
      setTeam(data.items);
      if (isSelf) onUserUpdated?.(data.user);
      toast.push(isSelf ? "已解绑飞书账号" : `已解绑 ${member.name} 的飞书账号`, "success");
    } catch (err) {
      toast.push(err instanceof ApiError ? err.message : "解绑失败", "error");
    } finally {
      setUnbindingId(null);
    }
  }

  async function copyCallbackUrl() {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(feishuCallbackUrl);
      } else {
        throw new Error("clipboard unavailable");
      }
      setCopiedCallback(true);
      toast.push("回调地址已复制", "success");
      window.setTimeout(() => setCopiedCallback(false), 2000);
    } catch {
      toast.push("请手动选中上方回调地址复制", "error");
    }
  }

  function refreshOutbox() {
    loadNotifications();
    loadFeishu();
  }

  async function runOutboxAction(
    setBusy: (active: boolean) => void,
    fallbackError: string,
    action: () => Promise<{ message: string; isError?: boolean }>,
  ) {
    setBusy(true);
    setOutboxError("");
    setOutboxNotice("");
    try {
      const outcome = await action();
      if (outcome.isError) {
        setOutboxError(outcome.message);
        toast.push(outcome.message, "error");
      } else {
        setOutboxNotice(outcome.message);
        toast.push(outcome.message, "success");
      }
      loadNotifications();
      loadFeishu();
    } catch (err) {
      const message = err instanceof ApiError ? err.message : fallbackError;
      setOutboxError(message);
      toast.push(message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function dispatchBatch(includeFailed: boolean) {
    await runOutboxAction(
      (active) => setOutboxBusy(active ? "dispatch" : null),
      "批量补发失败",
      async () => {
        const result = await api.dispatchFeishuNotifications({ limit: 10, includeFailed });
        const message =
          result.attempted === 0
            ? "当前没有需要补发的消息"
            : `本次尝试 ${result.attempted} 条：成功 ${result.sent} 条${result.failed > 0 ? `，失败 ${result.failed} 条` : ""}${result.remainingPending > 0 ? `（仍有 ${result.remainingPending} 条待发）` : ""}`;
        return { message, isError: result.failed > 0 };
      },
    );
  }

  async function dispatchSingle(item: NotificationItem) {
    await runOutboxAction(
      (active) => setSendingId(active ? item.id : null),
      "发送失败",
      async () => {
        const result = await api.dispatchFeishuNotifications({ notificationId: item.id });
        const first = result.items[0];
        if (first?.ok) return { message: `已发送「${item.title}」` };
        return { message: first?.error || "飞书推送失败", isError: true };
      },
    );
  }

  async function skipAllPending() {
    const ok = await confirm({
      title: `跳过全部 ${pendingCount} 条历史待发消息？`,
      description: "此操作不受搜索和筛选影响。待发记录将标记为「已跳过」并保留，避免接通机器人时一次发送旧消息；后续仍可按条手动重发。",
      confirmLabel: "跳过历史待发",
    });
    if (!ok) return;
    await runOutboxAction(
      (active) => setOutboxBusy(active ? "skip" : null),
      "操作失败",
      async () => {
        const result = await api.skipPendingFeishuNotifications();
        return { message: `已跳过 ${result.skipped} 条历史待发消息` };
      },
    );
  }

  const currentResult = notifyResult?.key === notifyKey ? notifyResult : null;
  const outboxPage = currentResult && "data" in currentResult ? currentResult.data : null;
  const notifyLoadError = currentResult && "error" in currentResult ? currentResult.error : null;
  const notifyStats = lastOutboxPage?.stats;
  const pendingCount = notifyStats?.pending ?? feishu?.pendingNotifications ?? 0;
  const failedCount = notifyStats?.failed ?? 0;
  const sendablePending = notifyStats?.sendablePending ?? 0;
  const sendableFailed = notifyStats?.sendableFailed ?? 0;
  const totalCount = notifyStats ? notifyStats.pending + notifyStats.sent + notifyStats.failed + notifyStats.skipped : null;
  const hasOutboxFilters = notifyStatus !== "all" || notifyDelivery !== "all" || Boolean(notifySearch);
  const pageCount = Math.max(1, Math.ceil((lastOutboxPage?.total ?? 0) / OUTBOX_PAGE_SIZE));
  const resultSummary = outboxPage?.items.length
    ? `第 ${(outboxPage.page - 1) * OUTBOX_PAGE_SIZE + 1}–${(outboxPage.page - 1) * OUTBOX_PAGE_SIZE + outboxPage.items.length} 条，共 ${outboxPage.total} 条`
    : outboxPage ? "共 0 条" : "";

  return (
    <div className="page page-narrow">
      <PageHeader title="设置" description="管理 AI 模型、飞书接入、团队权限与账号安全。" />

      {isAdmin && <LlmSettings />}
      {isAdmin && <AsrSettings />}
      {isAdmin && <BitableSettings />}

      <Card className="settings-section">
        <header className="card-head">
          <div>
            <h2>飞书接入</h2>
            <p className="card-sub">
              支持群机器人卡片推送、扫码登录、面试日历同步与面试官应用私信；配置对应凭证后即可按需启用。
            </p>
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
                  <Badge tone={feishu.ready.notifications ? "brand" : "neutral"}>
                    {feishu.ready.notifications ? "机器人推送已就绪" : "机器人推送待接入"}
                  </Badge>
                  <Badge tone={feishu.ready.login ? "brand" : "neutral"}>
                    {feishu.ready.login ? "扫码登录与私信已就绪" : "扫码登录与私信待接入"}
                  </Badge>
                  <Badge tone={feishu.ready.calendar ? "brand" : "neutral"}>
                    {feishu.ready.calendar ? "日历同步已就绪" : "日历同步待接入"}
                  </Badge>
                </div>
              </div>
              <div className="feishu-counters">
                <div>
                  <span className="muted">待发送</span>
                  <strong className="big-number">{pendingCount}</strong>
                </div>
                {failedCount > 0 && (
                  <div>
                    <span className="muted">失败</span>
                    <strong className="big-number feishu-count-danger">{failedCount}</strong>
                  </div>
                )}
              </div>
            </div>

            <div className="feishu-callback-box">
              <div className="feishu-callback-info">
                <span className="feishu-callback-label">飞书登录回调地址（Redirect URL）</span>
                <code className="feishu-callback-url">{feishuCallbackUrl}</code>
                <span className="muted">
                  复制到飞书开放平台「安全设置 → 重定向 URL」即可启用扫码登录与账号绑定。
                </span>
              </div>
              <Button size="sm" type="button" onClick={() => void copyCallbackUrl()}>
                {copiedCallback ? "已复制" : "复制回调地址"}
              </Button>
            </div>

            {isAdmin ? (
              <FeishuForm
                status={feishu}
                onSaved={(next, message) => {
                  setFeishu(next);
                  onFeishuConfigChanged?.(next.ready.login);
                  loadNotifications();
                  if (message !== null) {
                    toast.push(message ?? "飞书配置已保存", "success");
                  }
                }}
              />
            ) : (
              <p className="muted">
                只有管理员可以修改飞书凭据或触发测试；当前已保存 {Object.values(feishu.fields).filter(Boolean).length} 项。
              </p>
            )}
            <p className="muted feishu-note">
              Webhook 仅接受飞书官方 HTTPS 域名，App Secret 与签名密钥仅在服务端保存、不回传前端。
              <a href="https://open.feishu.cn/document" target="_blank" rel="noreferrer">
                飞书开放平台文档 <IconArrowUpRight size={12} />
              </a>
            </p>
          </>
        )}
      </Card>

      <Card className="settings-section feishu-outbox" role="region" aria-labelledby="feishu-outbox-title">
        <header className="card-head">
          <div>
            <h2 id="feishu-outbox-title">飞书出站箱</h2>
            <p className="card-sub">查看阶段流转和面试变更发出的群通知与面试官私信。不影响招聘操作。</p>
          </div>
          <div className="notify-head-actions">
            {isAdmin && (sendablePending > 0 || sendableFailed > 0) && (
              <Button
                size="sm"
                variant="primary"
                loading={outboxBusy === "dispatch"}
                disabled={!(feishu?.ready.notifications || feishu?.ready.login) || outboxBusy !== null || sendingId !== null}
                onClick={() => void dispatchBatch(sendablePending === 0)}
              >
                {sendablePending > 0 ? "补发待发（最多 10 条）" : "重试失败（最多 10 条）"}
              </Button>
            )}
            {isAdmin && pendingCount > 0 && (
              <Button
                size="sm"
                loading={outboxBusy === "skip"}
                disabled={outboxBusy !== null || sendingId !== null}
                onClick={() => void skipAllPending()}
              >
                跳过历史待发
              </Button>
            )}
            <Button size="sm" onClick={refreshOutbox} disabled={outboxBusy !== null}>
              刷新
            </Button>
          </div>
        </header>

        {isAdmin && (pendingCount > 0 || sendableFailed > 0) && (
          <p className="muted notify-scope">批量补发和跳过处理的是整个出站箱，不受下方筛选影响。</p>
        )}

        <div className="notify-stats" role="group" aria-label="发送状态（数字为全箱记录数）">
          {OUTBOX_STATUSES.map((value) => (
            <button
              key={value}
              type="button"
              className="notify-status-filter"
              aria-pressed={notifyStatus === value}
              onClick={() => { setNotifyStatus(value); setNotifyPage(1); }}
            >
              {value === "all" ? "全部" : NOTIFY_STATUS[value].label}
              <span className="notify-status-count">{(value === "all" ? totalCount : notifyStats?.[value]) ?? "—"}</span>
            </button>
          ))}
        </div>

        <div className="notify-tools">
          <Field label="搜索通知">
            {(id) => (
              <div className="search-input notify-search">
                <IconSearch size={16} aria-hidden="true" />
                <Input
                  id={id}
                  type="search"
                  maxLength={100}
                  value={notifySearch}
                  placeholder="候选人、面试官或职位"
                  onChange={(event) => { setNotifySearch(event.target.value); setNotifyPage(1); }}
                />
              </div>
            )}
          </Field>
          <Field label="发送渠道">
            {(id) => (
              <Select id={id} value={notifyDelivery} onChange={(event) => {
                const delivery = event.target.value;
                setNotifyDelivery(delivery === "dm" || delivery === "webhook" ? delivery : "all");
                setNotifyPage(1);
              }}>
                <option value="all">全部渠道</option>
                <option value="webhook">群机器人</option>
                <option value="dm">面试官私信</option>
              </Select>
            )}
          </Field>
          <Button size="sm" aria-disabled={!hasOutboxFilters} onClick={() => {
            if (hasOutboxFilters) clearOutboxFilters();
          }}>清空筛选</Button>
        </div>

        {outboxError && (
          <p className="form-error notify-banner" role="alert">
            {outboxError}
          </p>
        )}
        {outboxNotice && (
          <p className="notify-notice" role="status">
            {outboxNotice}
          </p>
        )}

        <div ref={notifyResultsRef} className="notify-results" role="group" aria-label="出站记录结果" aria-busy={!currentResult} tabIndex={-1}>
          {!currentResult && <ListSkeleton rows={3} />}
          {notifyLoadError && (
            <ErrorState message={`出站记录加载失败：${notifyLoadError}`} onRetry={() => {
              notifyResultsRef.current?.focus({ preventScroll: true });
              loadNotifications();
            }} />
          )}
          {outboxPage?.items.length === 0 && (totalCount === 0 ? (
            <EmptyState compact title="还没有飞书出站记录" description="推进候选人阶段或安排面试后，这里会出现发送记录。" />
          ) : (
            <EmptyState compact title="没有符合条件的记录" description="试试缩短姓名关键词，或清空筛选查看全部记录。" />
          ))}
          {outboxPage && outboxPage.items.length > 0 && (
            <ul className="notify-list" aria-label="飞书发送记录">
              {outboxPage.items.map((item) => {
                const status = NOTIFY_STATUS[item.status];
                const isDm = item.delivery === "dm";
                const deliveryReady = isDm ? Boolean(feishu?.ready.login) : Boolean(feishu?.ready.notifications);
                const canSend = isAdmin && item.status !== "sent";
                const actionLabel = item.status === "failed" ? "重试" : item.status === "skipped" ? "重发" : "发送";
                const interviewer = item.interviewer_name ? `面试官：${item.interviewer_name}` : "";
                const detail = [item.body, interviewer && !item.body?.includes(interviewer) ? interviewer : null].filter(Boolean).join(" · ");
                return (
                  <li key={item.id}>
                    <div className="notify-message">
                      <strong>{item.title}</strong>
                      {detail && <span className="muted">{detail}</span>}
                      {item.last_error && (
                        <span className={item.status === "failed" ? "notify-error" : "notify-skip-note"}>
                          {item.status === "failed" ? `失败原因：${item.last_error}` : item.last_error}
                        </span>
                      )}
                    </div>
                    <div className="notify-meta">
                      <div className="notify-row-labels">
                        <Badge tone={status.tone}>{status.label}</Badge>
                        <Badge tone="neutral">{isDm ? "面试官私信" : "群机器人"}</Badge>
                      </div>
                      <span className="notify-time muted">
                        {item.sent_at ? "发送于" : "创建于"} {fmtDateTime(item.sent_at ?? item.created_at)}
                        {item.status === "failed" && item.attempts > 0 && ` · 已尝试 ${item.attempts} 次`}
                      </span>
                    </div>
                    {canSend && (
                      <Button
                        size="sm"
                        loading={sendingId === item.id}
                        disabled={!deliveryReady || outboxBusy !== null || sendingId !== null}
                        onClick={() => void dispatchSingle(item)}
                      >
                        {actionLabel}
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <footer className="notify-footer">
          <span className="muted" role="status">{resultSummary || (!currentResult ? "正在加载记录…" : "")}</span>
          {pageCount > 1 && (
            <nav className="notify-pages" aria-label="出站记录分页">
              <Button size="sm" aria-disabled={!outboxPage || outboxPage.page <= 1} onClick={() => {
                if (outboxPage && outboxPage.page > 1) setNotifyPage(outboxPage.page - 1);
              }}>上一页</Button>
              <span className="muted">{outboxPage?.page ?? Math.min(notifyPage, pageCount)} / {pageCount}</span>
              <Button size="sm" aria-disabled={!outboxPage || outboxPage.page >= pageCount} onClick={() => {
                if (outboxPage && outboxPage.page < pageCount) setNotifyPage(outboxPage.page + 1);
              }}>下一页</Button>
            </nav>
          )}
        </footer>
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
            {team.map((member) => {
              const isSelf = member.id === user.id;
              const isBound = Boolean(member.feishu_open_id);
              const canUnbind = isBound && (isSelf || isAdmin);
              return (
                <li key={member.id}>
                  <div className="team-person">
                    <strong>
                      {member.name}
                      {isSelf && <span className="you">你</span>}
                    </strong>
                    <span className="muted">
                      {member.username ? `账号 ${member.username} · ${member.email}` : member.email}
                    </span>
                  </div>
                  <div className="team-controls">
                    <Badge tone={isBound ? "brand" : "neutral"} dot>
                      {isBound ? "已绑飞书" : "未绑飞书"}
                    </Badge>
                    {isSelf && !isBound &&
                      (feishu?.ready.login ? (
                        <a className="btn btn-sm btn-secondary" href="/api/auth/feishu/start?mode=bind">
                          绑定飞书
                        </a>
                      ) : (
                        <Button size="sm" type="button" disabled title="请先由管理员配置飞书 App ID 与 App Secret">
                          绑定飞书
                        </Button>
                      ))}
                    {canUnbind && (
                      <Button
                        size="sm"
                        variant="ghost"
                        loading={unbindingId === member.id}
                        disabled={unbindingId !== null && unbindingId !== member.id}
                        onClick={() => void unbindFeishu(member)}
                      >
                        解绑飞书
                      </Button>
                    )}
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
                  </div>
                </li>
              );
            })}
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

function FeishuForm({
  status,
  onSaved,
}: {
  status: FeishuStatus;
  onSaved: (next: FeishuStatus, message?: string | null) => void;
}) {
  const [form, setForm] = useState({
    app_id: "",
    app_secret: "",
    bot_webhook: "",
    bot_secret: "",
    verification_token: "",
    calendar_id: "",
  });
  const [clearedKeys, setClearedKeys] = useState<Set<keyof typeof form>>(() => new Set());
  const [busy, setBusy] = useState<"save" | "test-app" | "test-webhook" | "create-calendar" | "test-calendar" | null>(
    null,
  );
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const toast = useToast();

  function toggleClear(key: keyof typeof form) {
    setClearedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    setForm((prev) => ({ ...prev, [key]: "" }));
  }

  async function submit() {
    const patch: Record<string, string> = {};
    for (const [key, value] of Object.entries(form) as Array<[keyof typeof form, string]>) {
      if (clearedKeys.has(key)) {
        patch[key] = "";
      } else if (value.trim()) {
        patch[key] = value.trim();
      }
    }
    if (Object.keys(patch).length === 0) {
      setError("请填写要修改的配置项，或选择要清空的已保存项");
      return;
    }
    setBusy("save");
    setError("");
    setNotice("");
    try {
      const next = await api.saveFeishu(patch);
      onSaved(next);
      setForm({
        app_id: "",
        app_secret: "",
        bot_webhook: "",
        bot_secret: "",
        verification_token: "",
        calendar_id: "",
      });
      setClearedKeys(new Set());
      setNotice("飞书配置已保存，可直接点击下方按钮测试连通性。");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "保存失败");
    } finally {
      setBusy(null);
    }
  }

  async function runTest(kind: "test-app" | "test-webhook" | "create-calendar" | "test-calendar") {
    setBusy(kind);
    setError("");
    setNotice("");
    try {
      if (kind === "test-app") {
        const res = await api.testFeishuApp();
        const msg = `自建应用凭证连通成功 · ${res.latencyMs} 毫秒（${res.endpoint}，令牌有效约 ${Math.round(res.expiresIn / 60)} 分钟）`;
        setNotice(msg);
        toast.push("飞书自建应用凭证校验通过", "success");
      } else if (kind === "test-webhook") {
        const res = await api.testFeishuWebhook();
        const msg = `测试卡片已发送到飞书群 · ${res.latencyMs} 毫秒${res.signed ? "（已启用签名校验）" : ""}`;
        setNotice(msg);
        toast.push("测试卡片已发送到飞书群", "success");
      } else if (kind === "create-calendar") {
        const res = await api.createFeishuCalendar();
        onSaved(res.status, null);
        setClearedKeys((prev) => {
          if (!prev.has("calendar_id")) return prev;
          const next = new Set(prev);
          next.delete("calendar_id");
          return next;
        });
        const msg = `已创建共享日历「${res.summary}」并自动保存日历 ID（${res.calendarId} · ${res.latencyMs} 毫秒）`;
        setNotice(msg);
        toast.push("已创建飞书招聘日历并自动保存", "success");
      } else {
        const res = await api.testFeishuCalendar();
        const msg = `共享日历连通成功 · ${res.latencyMs} 毫秒（${res.summary}）`;
        setNotice(msg);
        toast.push("飞书共享日历校验通过", "success");
      }
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "操作失败";
      setError(message);
      toast.push(message, "error");
    } finally {
      setBusy(null);
    }
  }

  const items: Array<{
    key: keyof typeof form;
    label: string;
    placeholder: string;
    filled: boolean;
    secret?: boolean;
    span?: boolean;
    hint?: string;
  }> = [
    { key: "app_id", label: "App ID", placeholder: "cli_xxxxxxxx", filled: status.fields.app_id },
    { key: "app_secret", label: "App Secret", placeholder: "留空表示不修改", filled: status.fields.app_secret, secret: true },
    {
      key: "bot_webhook",
      label: "机器人 Webhook",
      placeholder: "https://open.feishu.cn/open-apis/bot/v2/hook/...",
      filled: status.fields.bot_webhook,
      span: true,
    },
    {
      key: "bot_secret",
      label: "机器人签名密钥（可选）",
      placeholder: "未开启签名校验可留空",
      filled: status.fields.bot_secret,
      secret: true,
      hint: status.fields.bot_secret ? "已保存签名密钥，留空保持不变" : "仅当群机器人开启「签名校验」时填写",
    },
    {
      key: "verification_token",
      label: "Verification Token",
      placeholder: "事件订阅校验用（后续阶段）",
      filled: status.fields.verification_token,
    },
    {
      key: "calendar_id",
      label: "共享日历 ID",
      placeholder: "可手填已有日历 ID，或保存 App 凭证后点击「一键创建招聘日历」",
      filled: status.fields.calendar_id,
      span: true,
      hint: status.fields.calendar_id
        ? "已保存共享日历 ID，面试安排/改期/取消将自动同步，未填会议链接时自动生成飞书视频会议"
        : "配置后将自动同步面试日程、邀请已绑定飞书的面试官，并自动生成飞书视频会议链接",
    },
  ];

  return (
    <div className="feishu-form">
      <div className="form-grid">
        {items.map((item) => {
          const markedClear = clearedKeys.has(item.key);
          return (
            <Field
              key={item.key}
              label={item.label}
              hint={
                markedClear
                  ? "保存后将清空此项"
                  : item.hint ?? (item.filled ? "已保存，可填写新值覆盖" : undefined)
              }
              span={item.span}
            >
              {(id) => (
                <div className="feishu-input-row">
                  <Input
                    id={id}
                    type={item.secret ? "password" : "text"}
                    value={form[item.key]}
                    placeholder={markedClear ? "保存后将清空此项" : item.placeholder}
                    disabled={markedClear || busy !== null}
                    autoComplete="off"
                    onChange={(event) => {
                      const val = event.target.value;
                      setForm((prev) => ({ ...prev, [item.key]: val }));
                      if (clearedKeys.has(item.key)) {
                        setClearedKeys((prev) => {
                          const next = new Set(prev);
                          next.delete(item.key);
                          return next;
                        });
                      }
                    }}
                  />
                  {item.filled && (
                    <button
                      type="button"
                      className={`feishu-clear-btn ${markedClear ? "active" : ""}`}
                      aria-label={`${markedClear ? "撤销清空" : "清空"}${item.label}`}
                      aria-pressed={markedClear}
                      disabled={busy !== null}
                      onClick={() => toggleClear(item.key)}
                    >
                      {markedClear ? "撤销" : "清空"}
                    </button>
                  )}
                </div>
              )}
            </Field>
          );
        })}
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="notify-notice" role="status">
          {notice}
        </p>
      )}
      <div className="form-actions feishu-actions">
        <Button variant="primary" loading={busy === "save"} disabled={busy !== null} onClick={() => void submit()}>
          保存飞书配置
        </Button>
        <Button
          type="button"
          loading={busy === "test-app"}
          disabled={!status.ready.login || busy !== null}
          onClick={() => void runTest("test-app")}
        >
          测试应用连接
        </Button>
        <Button
          type="button"
          loading={busy === "test-webhook"}
          disabled={!status.ready.notifications || busy !== null}
          onClick={() => void runTest("test-webhook")}
        >
          发送测试消息
        </Button>
        <Button
          type="button"
          loading={busy === "create-calendar"}
          disabled={!status.ready.login || busy !== null}
          onClick={() => void runTest("create-calendar")}
        >
          一键创建招聘日历
        </Button>
        <Button
          type="button"
          loading={busy === "test-calendar"}
          disabled={!status.ready.calendar || busy !== null}
          onClick={() => void runTest("test-calendar")}
        >
          测试日历连接
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
