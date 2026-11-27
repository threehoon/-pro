import { useState } from "react";
import { api } from "../../lib/api";
import { fmtDateTime } from "../../lib/format";
import { apiMessage } from "../../lib/workflow";
import type { BitableConfig, BitableEventRow, BitableTestResult } from "../../workflowTypes";
import { IconArrowUpRight } from "../icons";
import { Badge, Button, Card, EmptyState, ErrorState, Field, Input, ListSkeleton } from "../ui";
import { requireAiResult, useWorkflowResource } from "./resource";

const EVENT_STATE: Record<string, { label: string; tone: "neutral" | "brand" | "warning" | "danger" }> = {
  pending: { label: "待处理", tone: "warning" },
  applied: { label: "已回写", tone: "brand" },
  ignored: { label: "已忽略", tone: "neutral" },
  conflict: { label: "有冲突", tone: "danger" },
};

const CONNECTION_LABEL: Record<string, string> = {
  idle: "未连接",
  connecting: "连接中",
  connected: "已连接",
  reconnecting: "重连中",
  failed: "连接失败",
};

/**
 * 多维表格双向同步：系统把面试与投递推过去，飞书里的改动通过长连接事件回写。
 * 这里只做配置与状态，不展示具体表格内容——表格本身在飞书里看。
 */
export function BitableSettings() {
  const resource = useWorkflowResource(api.bitableConfig, false, "多维表格同步状态加载失败");
  const config = resource.data?.data;
  return <Card className="settings-section workflow-panel">
    <header className="card-head">
      <div>
        <h2>飞书多维表格</h2>
        <p className="card-sub">面试与投递双向同步：系统把记录推进 Base，你在表格里改「结论、评分、阶段、下一步」等列会回写到系统。</p>
      </div>
      {config && <Badge tone={config.enabled ? "brand" : "neutral"}>{config.enabled ? "已开启" : "未开启"}</Badge>}
    </header>
    <div className="chip-row">
      <a className="text-link" href="https://open.feishu.cn/document/server-docs/docs/bitable-v1/bitable-overview" target="_blank" rel="noreferrer">多维表格接口 <IconArrowUpRight size={14} /></a>
      <a className="text-link" href="https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/request-url-configuration-case" target="_blank" rel="noreferrer">长连接事件 <IconArrowUpRight size={14} /></a>
    </div>
    {resource.error
      ? <ErrorState message={resource.error} onRetry={resource.reload} />
      : config
        ? <SyncPanel config={config} onReload={resource.reload} />
        : <ListSkeleton rows={4} />}
  </Card>;
}

function SyncPanel({ config, onReload }: { config: BitableConfig; onReload: () => void }) {
  const [appToken, setAppToken] = useState<string | null>(null);
  const [interviewTable, setInterviewTable] = useState<string | null>(null);
  const [applicationTable, setApplicationTable] = useState<string | null>(null);
  const [fallback, setFallback] = useState<string | null>(null);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [test, setTest] = useState<BitableTestResult | null>(null);

  const token = appToken ?? config.appToken ?? "";
  const interviewId = interviewTable ?? config.interviewsTableId ?? "";
  const applicationId = applicationTable ?? config.applicationsTableId ?? "";
  const minutes = fallback ?? String(config.fallbackMinutes);
  const isOn = enabled ?? config.enabled;
  const dirty =
    token !== (config.appToken ?? "") ||
    interviewId !== (config.interviewsTableId ?? "") ||
    applicationId !== (config.applicationsTableId ?? "") ||
    minutes !== String(config.fallbackMinutes) ||
    isOn !== config.enabled;

  async function run(label: string, task: () => Promise<string>) {
    setBusy(label);
    setError("");
    setNotice("");
    try {
      setNotice(await task());
    } catch (err) {
      setError(apiMessage(err, `${label}失败`));
    } finally {
      setBusy("");
    }
  }

  const save = () => run("保存", async () => {
    const parsedMinutes = Number(minutes);
    if (!Number.isInteger(parsedMinutes) || parsedMinutes < 0) throw new Error("对账间隔请填 0 到 1440 之间的整数分钟");
    const result = requireAiResult(await api.saveBitableConfig({
      appToken: token.trim() || null,
      interviewsTableId: interviewId.trim() || null,
      applicationsTableId: applicationId.trim() || null,
      enabled: isOn,
      fallbackMinutes: parsedMinutes,
    }), "多维表格配置保存失败");
    onReload();
    return result.enabled ? "已保存并开启同步。" : "已保存；同步还没开启。";
  });

  const check = () => run("检查", async () => {
    const result = requireAiResult(await api.testBitable(), "配置检查失败");
    setTest(result);
    const failed = result.checks.filter((item) => !item.ok);
    onReload();
    return failed.length ? `有 ${failed.length} 项没通过，见下方明细。` : "配置检查全部通过，事件订阅已建立。";
  });

  const reconcile = () => run("对账", async () => {
    const result = requireAiResult(await api.reconcileBitable(), "对账失败");
    onReload();
    const extra = result.errors.length ? `（${result.errors.slice(0, 2).join("；")}）` : "";
    return `检查 ${result.checked} 行，回写 ${result.applied} 行，冲突 ${result.conflicts} 行，补推 ${result.pushed} 行${extra}`;
  });

  const backfill = () => run("推送", async () => {
    const result = requireAiResult(await api.backfillBitable(), "首次推送失败");
    onReload();
    return `已排队 ${result.queued} 条，成功 ${result.pushed} 条，失败 ${result.failed} 条。`;
  });

  const seedDemo = () => run("演示", async () => {
    const result = requireAiResult(await api.seedBitableDemo(), "灌演示数据失败");
    onReload();
    return `已写入 ${result.applications} 条投递、${result.interviews} 条面试，推到表格 ${result.pushed} 行${result.failed ? `，失败 ${result.failed} 行` : ""}。`;
  });

  const clearDemo = () => {
    if (!window.confirm("只删除带 seed_ 前缀的演示数据，真实数据不受影响。继续？")) return;
    void run("清理", async () => {
      const result = requireAiResult(await api.clearBitableDemo(), "清理演示数据失败");
      onReload();
      return `已删除库里 ${result.deleted} 行、表格里 ${result.remoteDeleted} 行${result.failed ? `，${result.failed} 行没删掉` : ""}。`;
    });
  };

  return <div className="workflow-stack">
    <div className="form-grid">
      <Field
        label="Base app_token"
        hint="多维表格链接里 /base/ 后面那一串；也可以直接粘整条链接，我们只取这一段。"
      >
        {(id) => <Input id={id} value={token} onChange={(e) => setAppToken(e.target.value)} placeholder="bascnxxxxxxxx" />}
      </Field>
      <Field label="面试表 table_id" hint="表链接里 table= 后面那一串，形如 tblxxxxxxxx。">
        {(id) => <Input id={id} value={interviewId} onChange={(e) => setInterviewTable(e.target.value)} placeholder="tblxxxxxxxx" />}
      </Field>
      <Field label="投递表 table_id" hint="另一张表的 table_id，两张表要分别建好列。">
        {(id) => <Input id={id} value={applicationId} onChange={(e) => setApplicationTable(e.target.value)} placeholder="tblxxxxxxxx" />}
      </Field>
      <Field label="兜底对账间隔（分钟）" hint="默认 10 分钟。只有长连接漏事件时才靠它对一次全量；填 0 关闭。">
        {(id) => <Input id={id} inputMode="numeric" value={minutes} onChange={(e) => setFallback(e.target.value)} />}
      </Field>
    </div>
    <label className="queue-check">
      <input type="checkbox" checked={isOn} disabled={Boolean(busy)} onChange={(e) => setEnabled(e.target.checked)} />
      开启双向同步（关闭后不再推送，也不再接收表格改动）
    </label>
    <p className="muted">
      需要在飞书开放平台给应用 <strong>应用身份与用户身份</strong> 都加上 <code>bitable:app</code> 权限，并把应用加成这张 Base 的协作者；第一次保存后我们会调用「订阅云文档事件」，之后变更才会推送过来。
    </p>

    <dl className="workflow-metrics">
      <div><dt>长连接</dt><dd>{CONNECTION_LABEL[config.connection.connection] ?? config.connection.connection}</dd></div>
      <div><dt>待推送</dt><dd>{config.stats.queue.pending.toLocaleString("zh-CN")}</dd></div>
      <div><dt>推送失败</dt><dd>{config.stats.queue.failed.toLocaleString("zh-CN")}</dd></div>
      <div><dt>已关联行</dt><dd>{config.stats.records.linked.toLocaleString("zh-CN")}</dd></div>
      <div><dt>收到事件</dt><dd>{config.stats.events.applied.toLocaleString("zh-CN")}</dd></div>
      <div><dt>上次对账</dt><dd>{config.lastReconcileAt ? fmtDateTime(config.lastReconcileAt) : "还没跑过"}</dd></div>
    </dl>

    {config.connection.lastError && <p role="alert" className="form-error">长连接：{config.connection.lastError}</p>}
    {!config.feishuApp && <p role="status">还没有配置飞书应用凭证，长连接无法建立，请先在「飞书接入」里保存 App ID 与 Secret。</p>}
    {error && <p role="alert" className="form-error">{error}</p>}
    {notice && <p role="status">{notice}</p>}

    <div className="workflow-actions">
      <Button variant="primary" loading={busy === "保存"} disabled={!dirty || Boolean(busy)} onClick={() => void save()}>保存配置</Button>
      <Button loading={busy === "检查"} disabled={!token.trim() || Boolean(busy)} onClick={() => void check()}>检查表结构</Button>
      <Button loading={busy === "对账"} disabled={!isOn || Boolean(busy)} onClick={() => void reconcile()}>立即对账</Button>
      <Button loading={busy === "推送"} disabled={!isOn || Boolean(busy)} onClick={() => void backfill()}>首次全量推送</Button>
      <Button loading={busy === "演示"} disabled={!isOn || Boolean(busy)} onClick={() => void seedDemo()}>灌演示数据</Button>
      <Button loading={busy === "清理"} disabled={Boolean(busy)} onClick={clearDemo}>清掉演示数据</Button>
    </div>

    {test && <ul className="bitable-checks">
      {test.checks.map((item) => <li key={item.name}>
        <Badge tone={item.ok ? "brand" : "danger"}>{item.ok ? "通过" : "未通过"}</Badge>
        <strong>{item.name}</strong>
        <span className="muted">{item.message}</span>
      </li>)}
    </ul>}

    <details className="bitable-columns">
      <summary>需要的列（列名要完全一致）</summary>
      <div className="bitable-column-grid">
        <div>
          <h3>面试表</h3>
          <p>{config.columns.interview.join("、")}</p>
          <p className="muted">可在表格里改：{config.columns.interviewWritable.join("、")}</p>
        </div>
        <div>
          <h3>投递表</h3>
          <p>{config.columns.application.join("、")}</p>
          <p className="muted">可在表格里改：{config.columns.applicationWritable.join("、")}</p>
        </div>
      </div>
    </details>

    <section className="bitable-events">
      <h3>最近收到的改动</h3>
      {config.events.length === 0
        ? <EmptyState compact title="还没有收到表格改动" description="在飞书表格里改一格试试，几秒内会出现在这里。" />
        : <ul>
          {config.events.map((event) => <EventRow key={event.event_id} event={event} />)}
        </ul>}
    </section>
  </div>;
}

function EventRow({ event }: { event: BitableEventRow }) {
  const state = EVENT_STATE[event.state] ?? { label: event.state, tone: "neutral" as const };
  return <li>
    <Badge tone={state.tone}>{state.label}</Badge>
    <span className="bitable-event-when">{fmtDateTime(event.received_at)}</span>
    <span className="bitable-event-note">{event.note ?? event.action ?? "—"}</span>
  </li>;
}
