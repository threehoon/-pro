import type { LookupAddress } from 'node:dns';
import { lookup } from 'node:dns/promises';
import { Agent, request } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { z } from 'zod';
import { getRow, run, transaction } from '../db/index.ts';
import { badRequest } from '../lib/errors.ts';
import { jsonParse, now, toJson } from '../lib/util.ts';
import { audit } from '../services/audit.ts';

export const DEFAULT_LLM_URL = 'https://api.deepseek.com';
export const DEFAULT_LLM_MODEL = 'deepseek-flash';
const OFFICIAL_DEEPSEEK_URL = /^https:\/\/api\.deepseek\.com(?:\/v1)?\/?$/;
const MAX_RESPONSE_BYTES = 1024 * 1024;
export const LLM_TIMEOUT_MS = 45_000;
/** A vetted DNS answer is reused briefly: every request still revalidates the address itself. */
const DNS_CACHE_MS = 60_000;
/**
 * Keep-alive pools the TCP+TLS session, which is the whole fixed cost of a short call.
 * The pinned lookup still runs whenever a new socket is opened.
 */
const keepAliveAgent = new Agent({ keepAlive: true, maxSockets: 8, keepAliveMsecs: 5_000 });
// An idle pooled socket must never keep a one-shot process (bench, tests) alive.
keepAliveAgent.on('free', (socket) => socket.unref());

const blockedV4 = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3],
] as const) blockedV4.addSubnet(address, prefix);
const proxyV4 = new BlockList();
proxyV4.addSubnet('198.18.0.0', 15);
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
const blockedV6 = new BlockList();
for (const [address, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]] as const) {
  blockedV6.addSubnet(address, prefix, 'ipv6');
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blockedV4.check(address);
  return family === 6 && !address.includes('%') && globalV6.check(address, 'ipv6') && !blockedV6.check(address, 'ipv6');
}

export function selectLlmAddress(target: URL, addresses: readonly LookupAddress[]): LookupAddress | undefined {
  // A local DNS proxy can use this reserved range to route the exact official HTTPS endpoint.
  const isOfficial = OFFICIAL_DEEPSEEK_URL.test(target.href);
  const publicAddresses: LookupAddress[] = [];
  for (const entry of addresses) {
    if (isPublicAddress(entry.address)) publicAddresses.push(entry);
    else if (!(isOfficial && entry.family === 4 && proxyV4.check(entry.address))) return undefined;
  }
  const eligible = publicAddresses.length ? publicAddresses : addresses;
  return eligible.find((entry) => entry.family === 4) ?? eligible[0];
}

export function publicLlmBaseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw badRequest('请输入公开的 HTTPS 模型地址');
  }
  const host = url.hostname;
  if (
    url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
    || !host.includes('.') || isIP(host) || host.endsWith('.')
    || /(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid|example|onion|arpa)$/i.test(host)
    || !/^[a-z0-9.-]+$/i.test(host) || !/^\/[a-z0-9/_-]*$/i.test(url.pathname)
  ) throw badRequest('请输入公开的 HTTPS 模型地址');
  return url;
}

export interface LlmConfig { baseUrl: string; model: string; apiKey: string }
const savedSettings = z.object({ base_url: z.string(), model: z.string(), api_key: z.string() });
const configModel = z.string().trim().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/, '模型名称格式不正确');
const configKey = z.string().max(1024).regex(/^[\x21-\x7e]*$/, 'API Key 格式不正确');

function resolveModel(baseUrl: string, model: string): string {
  return model === 'deepseek-chat' && OFFICIAL_DEEPSEEK_URL.test(baseUrl) ? DEFAULT_LLM_MODEL : model;
}

function storedConfig(): LlmConfig {
  const row = getRow<{ config_json: string }>("SELECT config_json FROM integrations WHERE provider = 'llm'");
  const parsed = savedSettings.safeParse(jsonParse(row?.config_json, {}));
  const baseUrl = parsed.data?.base_url || DEFAULT_LLM_URL;
  return {
    baseUrl,
    model: resolveModel(baseUrl, parsed.data?.model || DEFAULT_LLM_MODEL),
    apiKey: parsed.data?.api_key || '',
  };
}

export function activeLlmConfig(): LlmConfig | undefined {
  const config = storedConfig();
  const environmentKey = OFFICIAL_DEEPSEEK_URL.test(config.baseUrl) ? process.env.LLM_API_KEY?.trim() : undefined;
  const apiKey = config.apiKey || environmentKey || '';
  return apiKey ? { ...config, apiKey } : undefined;
}

export function llmSettings() {
  const config = storedConfig();
  const monthStart = `${now().slice(0, 7)}-01T00:00:00.000Z`;
  const tokens = getRow<{ tokensIn: number; tokensOut: number }>(
    'SELECT COALESCE(SUM(tokens_in), 0) AS tokensIn, COALESCE(SUM(tokens_out), 0) AS tokensOut FROM ai_runs WHERE created_at >= ?',
    [monthStart],
  );
  return {
    baseUrl: config.baseUrl,
    model: config.model,
    keyTail: config.apiKey.length > 4 ? config.apiKey.slice(-4) : null,
    configured: Boolean(activeLlmConfig()),
    tokensIn: tokens?.tokensIn ?? 0,
    tokensOut: tokens?.tokensOut ?? 0,
  };
}

export function parseLlmSettings(value: { baseUrl?: string; model?: string; apiKey?: string }): LlmConfig {
  const previous = storedConfig();
  const previousUrl = publicLlmBaseUrl(previous.baseUrl);
  const destination = publicLlmBaseUrl(value.baseUrl ?? previousUrl.href);
  const baseUrl = destination.href.replace(/\/+$/, '');
  const model = configModel.safeParse(value.model ?? previous.model);
  const apiKey = configKey.safeParse(value.apiKey ?? (previousUrl.origin === destination.origin ? previous.apiKey : ''));
  if (!model.success || !apiKey.success) throw badRequest('模型名称或 API Key 格式不正确');
  const effectiveModel = resolveModel(baseUrl, model.data);
  if (apiKey.data && (baseUrl.includes(apiKey.data) || model.data.includes(apiKey.data) || effectiveModel.includes(apiKey.data))) {
    throw badRequest('请勿将 API Key 写入模型地址或名称');
  }
  return { baseUrl, model: effectiveModel, apiKey: apiKey.data };
}

export function saveLlmSettings(value: Parameters<typeof parseLlmSettings>[0], actorId: string) {
  const config = parseLlmSettings(value);
  transaction(() => {
    run(`INSERT INTO integrations (provider, status, config_json, updated_by, updated_at) VALUES ('llm', ?, ?, ?, ?)
      ON CONFLICT(provider) DO UPDATE SET status = excluded.status, config_json = excluded.config_json,
      updated_by = excluded.updated_by, updated_at = excluded.updated_at`, [
      config.apiKey ? 'configured' : 'disabled', toJson({ base_url: config.baseUrl, model: config.model, api_key: config.apiKey }), actorId, now(),
    ]);
    audit({ actorId, action: 'settings.llm.update', entityType: 'integration', entityId: 'llm' });
  });
  return llmSettings();
}

export interface LlmResult {
  value: unknown;
  tokensIn: number | null;
  tokensOut: number | null;
}

type LlmFailureCode = 'unsafe_endpoint' | 'timeout' | 'provider_error' | 'invalid_response'
  | 'empty_response' | 'truncated_response' | 'malformed_json' | 'invalid_profile_structure';
type LlmUsage = Pick<LlmResult, 'tokensIn' | 'tokensOut'>;

export class LlmFailure extends Error {
  readonly code: LlmFailureCode;
  readonly usage?: LlmUsage;

  constructor(code: LlmFailureCode, usage?: LlmUsage) {
    super(code);
    this.code = code;
    this.usage = usage;
  }
}

type RequestOptions = { maxTokens: number; deepSeekThinking?: 'disabled' | 'enabled'; timeoutMs?: number };

function waitForDns(hostname: string, signal: AbortSignal) {
  return new Promise<LookupAddress[]>((resolve, reject) => {
    const abort = () => reject(new LlmFailure('timeout'));
    signal.addEventListener('abort', abort, { once: true });
    lookup(hostname, { all: true, verbatim: true }).then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', abort);
    });
  });
}

const dnsCache = new Map<string, { addresses: LookupAddress[]; at: number }>();

async function selectVettedAddress(target: URL, signal: AbortSignal): Promise<LookupAddress> {
  const cached = dnsCache.get(target.hostname);
  const fresh = cached && Date.now() - cached.at < DNS_CACHE_MS ? cached.addresses : undefined;
  const addresses = fresh ?? await waitForDns(target.hostname, signal).catch(() => {
    throw new LlmFailure(signal.aborted ? 'timeout' : 'unsafe_endpoint');
  });
  // The cached answer is revalidated, so a poisoned or stale entry still fails closed.
  const selected = selectLlmAddress(target, addresses);
  if (!selected) {
    dnsCache.delete(target.hostname);
    throw new LlmFailure('unsafe_endpoint');
  }
  if (!fresh) dnsCache.set(target.hostname, { addresses, at: Date.now() });
  return selected;
}

type Attempt = { kind: 'text'; text: string } | { kind: 'failure'; code: LlmFailureCode } | { kind: 'stale' };

/** A pooled socket can be closed by the peer while it idles. Only that case is safe to replay. */
export function isStaleSocketFailure(reusedSocket: boolean, responded: boolean, code: string | undefined): boolean {
  return reusedSocket && !responded && (code === 'ECONNRESET' || code === 'EPIPE' || code === 'ECONNABORTED');
}

function postCompletion(target: URL, selected: LookupAddress, config: LlmConfig, body: string, signal: AbortSignal): Promise<Attempt> {
  return new Promise<Attempt>((resolve) => {
    let responded = false;
    const req = request(target, {
      method: 'POST', signal, agent: keepAliveAgent, family: selected.family, rejectUnauthorized: true,
      // Pin the vetted DNS result for the actual connection. URL hostname remains the TLS identity.
      lookup: (_hostname, _options, callback) => callback(null, selected.address, selected.family),
      headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    }, (res) => {
      responded = true;
      if (res.statusCode !== 200) {
        res.destroy();
        resolve({ kind: 'failure', code: 'provider_error' });
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) {
          resolve({ kind: 'failure', code: 'invalid_response' });
          res.destroy();
        } else {
          chunks.push(chunk);
        }
      });
      res.on('error', () => resolve({ kind: 'failure', code: signal.aborted ? 'timeout' : 'provider_error' }));
      res.on('end', () => resolve({ kind: 'text', text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', (error: NodeJS.ErrnoException) => {
      if (isStaleSocketFailure(req.reusedSocket === true, responded, error.code)) resolve({ kind: 'stale' });
      else resolve({ kind: 'failure', code: signal.aborted ? 'timeout' : 'provider_error' });
    });
    req.end(body);
  });
}

async function requestJson(config: LlmConfig, instruction: string, input: string, options?: RequestOptions): Promise<LlmResult> {
  let target: URL;
  try {
    target = publicLlmBaseUrl(config.baseUrl);
  } catch {
    throw new LlmFailure('unsafe_endpoint');
  }
  const signal = AbortSignal.timeout(options?.timeoutMs ?? LLM_TIMEOUT_MS);
  const selected = await selectVettedAddress(target, signal);
  const useDeepSeekThinking = OFFICIAL_DEEPSEEK_URL.test(target.href) && options?.deepSeekThinking;
  target.pathname = `${target.pathname.replace(/\/+$/, '')}/chat/completions`;
  const body = JSON.stringify({
    model: config.model,
    messages: [{ role: 'system', content: instruction }, { role: 'user', content: input }],
    response_format: { type: 'json_object' },
    ...(options ? { max_tokens: options.maxTokens } : {}),
    ...(useDeepSeekThinking ? { thinking: { type: useDeepSeekThinking } } : {}),
  });
  let attempt = await postCompletion(target, selected, config, body, signal);
  if (attempt.kind === 'stale') {
    attempt = signal.aborted ? { kind: 'failure', code: 'timeout' } : await postCompletion(target, selected, config, body, signal);
  }
  if (attempt.kind !== 'text') throw new LlmFailure(attempt.kind === 'stale' ? 'provider_error' : attempt.code);
  return decodeLlmResponse(attempt.text, config.apiKey);
}

const usageValue = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullish().catch(null);
const responseEnvelope = z.object({
  choices: z.array(z.object({
    message: z.unknown(),
    finish_reason: z.string().nullish(),
  })).min(1),
  usage: z.object({ prompt_tokens: usageValue, completion_tokens: usageValue }).nullish().catch(null),
});
const responseMessage = z.object({ content: z.string().nullish() });
const incompleteReasons = new Set(['content_filter', 'tool_calls', 'function_call', 'insufficient_system_resource', 'aborted']);

export function decodeLlmResponse(response: string, secret: string): LlmResult {
  // An upstream can echo credentials it received in its Authorization header.
  if (secret && response.includes(secret)) throw new LlmFailure('invalid_response');
  const envelope = responseEnvelope.safeParse(jsonParse(response, null));
  if (!envelope.success) throw new LlmFailure('invalid_response');
  const { usage, choices: [choice] } = envelope.data;
  const tokens = { tokensIn: usage?.prompt_tokens ?? null, tokensOut: usage?.completion_tokens ?? null };
  const finishReason = choice!.finish_reason;
  if (finishReason === 'length') throw new LlmFailure('truncated_response', tokens);
  if (finishReason && incompleteReasons.has(finishReason)) throw new LlmFailure('invalid_response', tokens);
  const message = responseMessage.safeParse(choice!.message);
  if (!message.success) throw new LlmFailure('invalid_response', tokens);
  const content = message.data.content;
  if (!content?.trim()) throw new LlmFailure('empty_response', tokens);
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new LlmFailure('malformed_json', tokens);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value) || containsSecret(value, secret)) {
    throw new LlmFailure('invalid_response', tokens);
  }
  return { value, ...tokens };
}

function containsSecret(value: unknown, secret: string): boolean {
  if (!secret) return false;
  const pending = [value];
  while (pending.length) {
    const next = pending.pop();
    if (typeof next === 'string' && next.includes(secret)) return true;
    if (next && typeof next === 'object') {
      for (const [key, item] of Object.entries(next)) {
        if (key.includes(secret)) return true;
        pending.push(item);
      }
    }
  }
  return false;
}

/** Keeps transport replaceable in the automated tests without touching live providers. */
export const llmTransport = { requestJson };

export function cleanupAiRuns(): void {
  const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  run('DELETE FROM ai_runs WHERE created_at < ?', [cutoff]);
}
