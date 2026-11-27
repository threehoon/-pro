import { isIP } from 'node:net';
import { z } from 'zod';
import { getRow, run, transaction } from '../db/index.ts';
import { badRequest } from '../lib/errors.ts';
import { jsonParse, now, toJson } from '../lib/util.ts';
import { audit } from '../services/audit.ts';
import { AUDIO_MAX_BYTES } from '../constants.ts';

/**
 * 面试录音转写：走 OpenAI 兼容的 `POST /audio/transcriptions`。
 * 这不是随便挑的协议——whisper-1、Groq、硅基流动 SenseVoice、自建 faster-whisper 都认它，
 * 换成哪家只改地址和模型名，不必改代码。
 */
export const DEFAULT_ASR_URL = 'https://api.openai.com/v1';
export const DEFAULT_ASR_MODEL = 'whisper-1';
export const ASR_TIMEOUT_MS = 120_000;

export type AsrFailureCode = 'unsafe_endpoint' | 'timeout' | 'provider_error' | 'invalid_response' | 'empty_response';

export class AsrFailure extends Error {
  readonly code: AsrFailureCode;
  readonly status: number | undefined;
  constructor(code: AsrFailureCode, message: string, status?: number) {
    super(message);
    this.name = 'AsrFailure';
    this.code = code;
    this.status = status;
  }
}

export interface AsrConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
  /** 用 two-letter 代码固定语种能显著减少转写乱码；auto 表示让服务自己判断。 */
  language: string;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * 转写地址允许回环，是因为自建 faster-whisper 跑在本机最省事也最保护隐私；
 * 但内网段、HTTP 公网地址一律拒绝，免得这个管理员配置变成打内网的口子。
 */
export function asrBaseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw badRequest('请输入语音转写服务地址，例如 https://api.openai.com/v1');
  }
  const host = url.hostname.toLowerCase();
  const loopback = LOOPBACK.has(host);
  if (
    (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:'))
    || url.username || url.password || url.search || url.hash
    || (!loopback && (isIP(host) !== 0 || !host.includes('.') || host.endsWith('.')
      || /(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid|example|onion|arpa)$/i.test(host)))
    || !/^[a-z0-9.:-]+$/i.test(host) || !/^\/[a-z0-9/_-]*$/.test(url.pathname)
  ) throw badRequest('请输入语音转写服务地址，例如 https://api.openai.com/v1');
  return url;
}

const savedSettings = z.object({
  base_url: z.string(),
  model: z.string(),
  api_key: z.string(),
  language: z.string().nullish().catch(null),
});
const configModel = z.string().trim().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/, '模型名称格式不正确');
const configKey = z.string().max(1024).regex(/^[\x21-\x7e]*$/, 'API Key 格式不正确');
const configLanguage = z.string().trim().regex(/^[a-z]{2,3}$/i, '语种代码格式不正确');

function storedConfig(): AsrConfig {
  const row = getRow<{ config_json: string }>("SELECT config_json FROM integrations WHERE provider = 'asr'");
  const parsed = savedSettings.safeParse(jsonParse(row?.config_json, {}));
  return {
    baseUrl: parsed.data?.base_url || DEFAULT_ASR_URL,
    model: parsed.data?.model || DEFAULT_ASR_MODEL,
    apiKey: parsed.data?.api_key || '',
    language: parsed.data?.language || 'zh',
  };
}

export function activeAsrConfig(): AsrConfig | undefined {
  const config = storedConfig();
  // 自建 faster-whisper 通常不校验密钥，本地回环允许只配地址不配 key。
  const needsKey = !LOOPBACK.has(new URL(config.baseUrl).hostname.toLowerCase());
  if (!config.apiKey && needsKey) return undefined;
  return config;
}

export function asrSettings() {
  const config = storedConfig();
  return {
    baseUrl: config.baseUrl,
    model: config.model,
    language: config.language,
    keyTail: config.apiKey.length > 4 ? config.apiKey.slice(-4) : null,
    configured: Boolean(activeAsrConfig()),
  };
}

export function parseAsrSettings(value: { baseUrl?: string; model?: string; apiKey?: string; language?: string }): AsrConfig {
  const previous = storedConfig();
  const previousUrl = asrBaseUrl(previous.baseUrl);
  const destination = asrBaseUrl(value.baseUrl ?? previousUrl.href);
  const baseUrl = destination.href.replace(/\/+$/, '');
  const model = configModel.safeParse(value.model ?? previous.model);
  const apiKey = configKey.safeParse(value.apiKey ?? (previousUrl.origin === destination.origin ? previous.apiKey : ''));
  const language = configLanguage.safeParse(value.language ?? previous.language);
  if (!model.success || !apiKey.success) throw badRequest('模型名称或 API Key 格式不正确');
  if (!language.success) throw badRequest('语种代码格式不正确，例如 zh 或 auto');
  if (apiKey.data && (baseUrl.includes(apiKey.data) || model.data.includes(apiKey.data))) {
    throw badRequest('请勿将 API Key 写入服务地址或模型名称');
  }
  return { baseUrl, model: model.data, apiKey: apiKey.data, language: language.data.toLowerCase() };
}

export function saveAsrSettings(value: Parameters<typeof parseAsrSettings>[0], actorId: string) {
  const config = parseAsrSettings(value);
  transaction(() => {
    run(`INSERT INTO integrations (provider, status, config_json, updated_by, updated_at) VALUES ('asr', ?, ?, ?, ?)
      ON CONFLICT(provider) DO UPDATE SET status = excluded.status, config_json = excluded.config_json,
      updated_by = excluded.updated_by, updated_at = excluded.updated_at`, [
      config.apiKey || LOOPBACK.has(new URL(config.baseUrl).hostname.toLowerCase()) ? 'configured' : 'disabled',
      toJson({ base_url: config.baseUrl, model: config.model, api_key: config.apiKey, language: config.language }),
      actorId, now(),
    ]);
    audit({ actorId, action: 'settings.asr.update', entityType: 'integration', entityId: 'asr' });
  });
  return asrSettings();
}

export interface AsrAudio {
  buffer: Buffer;
  filename: string;
  mime: string;
}

export interface AsrResult {
  text: string;
  model: string;
  /** 服务商自报的音频时长（秒），没报就是 null。 */
  durationSeconds: number | null;
}

const transcriptResponse = z.object({
  text: z.string(),
  duration: z.number().nonnegative().nullish(),
});

function endpoint(baseUrl: string): string {
  return /\/audio\/transcriptions$/.test(baseUrl) ? baseUrl : `${baseUrl}/audio/transcriptions`;
}

/**
 * 只把 text 交回业务层：服务商的其它字段（分段、词级时间戳）没有消费方，
 * 而把整段响应写进日志等于把面试内容复制一份。
 */
async function requestTranscription(config: AsrConfig, audio: AsrAudio): Promise<AsrResult> {
  const target = endpoint(config.baseUrl);
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(audio.buffer)], { type: audio.mime }), audio.filename);
  form.append('model', config.model);
  form.append('response_format', 'json');
  if (config.language && config.language !== 'auto') form.append('language', config.language);

  let response: Response;
  try {
    response = await fetch(target, {
      method: 'POST',
      headers: config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {},
      body: form,
      signal: AbortSignal.timeout(ASR_TIMEOUT_MS),
    });
  } catch (error) {
    const name = (error as { name?: string })?.name;
    if (name === 'TimeoutError' || name === 'AbortError') throw new AsrFailure('timeout', '语音转写超时');
    throw new AsrFailure('provider_error', '语音转写服务连接失败');
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    const hint = detail.slice(0, 200).replace(/\s+/g, ' ').trim();
    throw new AsrFailure('provider_error', hint ? `语音转写服务返回 ${response.status}：${hint}` : `语音转写服务返回 ${response.status}`, response.status);
  }

  const parsed = transcriptResponse.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new AsrFailure('invalid_response', '语音转写服务返回了无法识别的结果');
  const text = parsed.data.text.trim();
  if (!text) throw new AsrFailure('empty_response', '没有识别出人声，请确认录音音量或换一段');
  return { text, model: config.model, durationSeconds: parsed.data.duration ?? null };
}

/** 测试替换点：真实实现打网络，用例里换成内存替身。 */
export const asrTransport = { transcribe: requestTranscription };

export interface TranscriptionOutcome extends AsrResult {
  chars: number;
  /** 超过上限的转写会被截断成生成可用的长度，超出部分在界面上提示。 */
  truncated: boolean;
}

const TRANSCRIPT_LIMIT = 12_000;

export function validateAudio(audio: AsrAudio): void {
  if (!audio.buffer.length) throw badRequest('录音文件为空');
  if (audio.buffer.length > AUDIO_MAX_BYTES) throw badRequest(`录音超过 ${Math.round(AUDIO_MAX_BYTES / 1024 / 1024)} MB，请剪短或降低码率后重试`);
}

export async function transcribeInterviewAudio(audio: AsrAudio): Promise<TranscriptionOutcome> {
  const config = activeAsrConfig();
  if (!config) throw badRequest('还没有配置语音转写服务，请让管理员在设置页填写服务地址与密钥');
  validateAudio(audio);
  const result = await asrTransport.transcribe(config, audio);
  const chars = result.text.length;
  const text = chars > TRANSCRIPT_LIMIT ? result.text.slice(0, TRANSCRIPT_LIMIT) : result.text;
  return { ...result, text, chars, truncated: chars > TRANSCRIPT_LIMIT };
}
