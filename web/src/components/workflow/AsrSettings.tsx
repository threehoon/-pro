import { useState } from "react";
import { api } from "../../lib/api";
import { apiMessage } from "../../lib/workflow";
import type { AsrConfig } from "../../workflowTypes";
import { IconArrowUpRight } from "../icons";
import { Badge, Button, Card, ErrorState, Field, Input, ListSkeleton } from "../ui";
import { requireAiResult, useWorkflowResource } from "./resource";

/**
 * 录音转写走的是 OpenAI 兼容接口，所以这里要求的是「服务地址 + 模型名」而不是某家的专属参数。
 * 自建 faster-whisper 默认不校验密钥，只填地址也能用。
 */
export function AsrSettings() {
  const resource = useWorkflowResource(api.asrConfig, false, "语音转写配置加载失败");
  const config = resource.data?.data;
  return <Card className="settings-section workflow-panel">
    <header className="card-head">
      <div>
        <h2>面试录音转写</h2>
        <p className="card-sub">把面试录音直接转成逐字稿。支持任何 OpenAI 兼容的语音识别服务，也可以用本机自建的 faster-whisper。</p>
      </div>
      {config && <Badge tone={config.configured ? "brand" : "neutral"}>{config.configured ? "已配置" : "未配置"}</Badge>}
    </header>
    <div className="chip-row">
      <a className="text-link" href="https://platform.openai.com/docs/api-reference/audio/createTranscription" target="_blank" rel="noreferrer">接口文档 <IconArrowUpRight size={14} /></a>
      <a className="text-link" href="https://api.siliconflow.cn" target="_blank" rel="noreferrer">硅基流动（SenseVoice）<IconArrowUpRight size={14} /></a>
    </div>
    {resource.error
      ? <ErrorState message={resource.error} onRetry={resource.reload} />
      : config
        ? <ConfigForm config={config} onSave={resource.reload} />
        : <ListSkeleton rows={3} />}
  </Card>;
}

function ConfigForm({ config, onSave }: { config: AsrConfig; onSave: () => void }) {
  const [baseUrl, setBaseUrl] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [language, setLanguage] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const endpoint = baseUrl ?? config.baseUrl;
  const modelName = model ?? config.model;
  const lang = language ?? config.language;
  const dirty = endpoint !== config.baseUrl || modelName !== config.model || lang !== config.language || Boolean(apiKey.trim());

  async function save() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      requireAiResult(await api.saveAsrConfig({
        baseUrl: endpoint.trim(), model: modelName.trim(), language: lang.trim(),
        apiKey: apiKey.trim() || undefined,
      }), "语音转写配置保存失败");
      setApiKey("");
      onSave();
      setNotice("语音转写配置已保存，可以在面试详情里上传录音试试。");
    } catch (err) {
      setError(apiMessage(err, "语音转写配置保存失败"));
    } finally {
      setBusy(false);
    }
  }

  return <form className="workflow-stack" onSubmit={(event) => { event.preventDefault(); if (!busy && dirty) void save(); }}>
    <div className="form-grid">
      <Field label="服务地址" hint="到 /v1 为止，例如 https://api.openai.com/v1；本机自建可填 http://localhost:8000/v1。">
        {(id) => <Input id={id} required value={endpoint} onChange={(e) => setBaseUrl(e.target.value)} />}
      </Field>
      <Field label="模型 ID" hint="例如 whisper-1、whisper-large-v3、FunAudioLLM/SenseVoiceSmall。">
        {(id) => <Input id={id} required value={modelName} onChange={(e) => setModel(e.target.value)} />}
      </Field>
      <Field label="语种" hint="一般填 zh；填 auto 交给服务判断，多语种面试用 auto。">
        {(id) => <Input id={id} value={lang} onChange={(e) => setLanguage(e.target.value)} />}
      </Field>
      <Field span label="API 密钥" hint={config.keyTail ? `当前密钥末尾 ${config.keyTail}，留空保留。` : "自建服务通常不需要密钥。"}>
        {(id) => <Input id={id} type="password" autoComplete="new-password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />}
      </Field>
    </div>
    <p className="muted">录音只在转写时中转一次，不落盘也不进数据库；转写结果会先放进逐字稿输入框，核对后才会保存。</p>
    {error && <p role="alert" className="form-error">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {dirty && <div className="workflow-actions">
      <Button type="submit" variant="primary" loading={busy} disabled={!endpoint.trim() || !modelName.trim()}>保存语音转写配置</Button>
    </div>}
  </form>;
}
