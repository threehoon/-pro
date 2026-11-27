import { useState } from "react";
import { api } from "../../lib/api";
import { apiMessage } from "../../lib/workflow";
import type { LlmConfig } from "../../workflowTypes";
import { IconArrowUpRight } from "../icons";
import { Badge, Button, Card, ErrorState, Field, Input, ListSkeleton } from "../ui";
import { requireAiResult, useWorkflowResource } from "./resource";

export function LlmSettings() {
  const resource = useWorkflowResource(api.llmConfig, false, "AI 配置加载失败");
  const config = resource.data?.data;
  return <Card className="settings-section workflow-panel">
    <header className="card-head">
      <div><h2>AI 模型</h2><p className="card-sub">为用人画像、简历筛选和面试总结配置 OpenAI 兼容模型。</p></div>
      {config && <Badge tone={config.configured ? "brand" : "neutral"}>{config.configured ? "已配置" : "未配置"}</Badge>}
    </header>
    <div className="chip-row">
      <a className="text-link" href="https://api-docs.deepseek.com/zh-cn/" target="_blank" rel="noreferrer">DeepSeek API 文档 <IconArrowUpRight size={14} /></a>
      <a className="text-link" href="https://platform.deepseek.com/api_keys" target="_blank" rel="noreferrer">申请 API 密钥 <IconArrowUpRight size={14} /></a>
    </div>
    {resource.error ? <ErrorState message={resource.error} onRetry={resource.reload} /> : config ? <ConfigForm config={config} onSave={resource.reload} /> : resource.data ? <ErrorState message={resource.data.reason ?? "AI 配置加载失败"} onRetry={resource.reload} /> : <ListSkeleton rows={3} />}
  </Card>;
}

function ConfigForm({ config, onSave }: { config: LlmConfig; onSave: () => void }) {
  const [baseUrl, setBaseUrl] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [thinking, setThinking] = useState<"off" | "on" | null>(null);
  const [busy, setBusy] = useState<"save" | "test" | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const endpoint = baseUrl ?? config.baseUrl;
  const modelName = model ?? config.model;
  const deepThinking = thinking ?? config.thinking;
  const dirty = endpoint !== config.baseUrl || modelName !== config.model || deepThinking !== config.thinking || Boolean(apiKey.trim());

  async function run(action: "save" | "test") {
    setBusy(action);
    setError("");
    setNotice("");
    try {
      if (action === "save") {
        requireAiResult(await api.saveLlmConfig({ baseUrl: endpoint.trim(), model: modelName.trim(),
          apiKey: apiKey.trim() || undefined, thinking: deepThinking }), "AI 配置保存失败");
        setApiKey("");
        onSave();
        setNotice("AI 配置已保存。");
      } else {
        const result = requireAiResult(await api.testLlm(), "模型连通测试失败");
        setNotice(`测试通过 · ${result.model} · ${result.latencyMs} 毫秒`);
        onSave();
      }
    } catch (err) {
      setError(apiMessage(err, "AI 配置操作失败"));
    } finally {
      setBusy(null);
    }
  }

  return <form className="workflow-stack" onSubmit={(event) => { event.preventDefault(); if (!busy && dirty) void run("save"); }}>
    <div className="form-grid">
      <Field label="API 基础地址">{(id) => <Input id={id} type="url" required value={endpoint} onChange={(e) => setBaseUrl(e.target.value)} />}</Field>
      <Field label="模型 ID" hint="DeepSeek 官方 API 的 deepseek-flash 对应 DeepSeek-V4.1-Flash-1017。">
        {(id) => <Input id={id} required value={modelName} onChange={(e) => setModel(e.target.value)} />}
      </Field>
      <Field span label="API 密钥" hint={config.keyTail ? `当前密钥末尾 ${config.keyTail}，留空保留。` : "输入服务商提供的 API 密钥。"}>
        {(id) => <Input id={id} type="password" autoComplete="new-password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />}
      </Field>
    </div>
    <label className="queue-check">
      <input type="checkbox" checked={deepThinking === "on"} disabled={!!busy}
        onChange={(event) => setThinking(event.target.checked ? "on" : "off")} />
      允许模型深入思考
    </label>
    <p className="muted">默认关闭。开启后回答更细，但同期生成的耗时与费用约为关闭时的 4–8 倍，只在需要极高细节时打开。</p>
    <dl className="workflow-metrics">
      <div><dt>本月输入 Token</dt><dd>{config.tokensIn.toLocaleString("zh-CN")}</dd></div>
      <div><dt>本月输出 Token</dt><dd>{config.tokensOut.toLocaleString("zh-CN")}</dd></div>
      <div><dt>其中思考 Token</dt><dd>{config.reasoningTokens.toLocaleString("zh-CN")}</dd></div>
      <div><dt>其中缓存命中</dt><dd>{config.cachedTokens.toLocaleString("zh-CN")}</dd></div>
    </dl>
    {error && <p role="alert" className="form-error">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    <div className="workflow-actions">
      <Button type="button" variant={dirty ? undefined : "primary"} loading={busy === "test"} disabled={!!busy || dirty || !config.configured} onClick={() => void run("test")}>测试连通性</Button>
      {dirty && <Button type="submit" variant="primary" loading={busy === "save"} disabled={!!busy || !endpoint.trim() || !modelName.trim()}>保存 AI 配置</Button>}
    </div>
  </form>;
}
