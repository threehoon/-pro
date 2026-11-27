#!/usr/bin/env node
// AI 调用基准：给「连接速度」和「生成长度」一个可复现的数字，改动前后各跑一次。
//
//   npm run bench                     # 5 次最小请求，量传输与握手开销（花费极小）
//   npm run bench -- --runs 10        # 多跑几次，p95 更稳
//   npm run bench -- --job <jobId>    # 用真实职位跑一次完整画像生成（会消耗较多 token）
//   npm run bench -- --json           # 输出 JSON，方便整段贴进 PR
//
// 复用应用真实的模型配置、地址校验与请求封装，因此量到的就是线上那条路径。
// 只读，不写 ai_runs、不改任何业务数据。

import { performance } from 'node:perf_hooks';
import { activeLlmConfig, llmTransport, LlmFailure } from '../server/src/integrations/llm.ts';
import { POLICY, testInstruction } from '../server/src/services/ai/prompts.ts';
import { profileRequest } from '../server/src/services/recruitment-ai.ts';

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const runs = Math.max(1, Number(option('runs') ?? 5));
const jobId = option('job');
const asJson = args.includes('--json');

const config = activeLlmConfig();
if (!config) {
  console.error('尚未配置 AI：先在设置页保存模型地址与 API Key，或设置 LLM_API_KEY 环境变量。');
  process.exit(1);
}

const percentile = (sorted, ratio) => {
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1);
  return sorted[Math.max(0, index)];
};

// 失败请求同样记录耗时：传输层已经跑完，只是内容不合校验，握手与往返开销仍然有效。
const stats = (samples) => {
  const times = samples.map((sample) => sample.ms).filter((ms) => typeof ms === 'number').sort((a, b) => a - b);
  const failed = samples.filter((sample) => sample.error).length;
  return {
    runs: samples.length,
    failed,
    minMs: times[0] ?? null,
    p50Ms: percentile(times, 0.5),
    p95Ms: percentile(times, 0.95),
    maxMs: times.at(-1) ?? null,
    tokensIn: samples.reduce((sum, sample) => sum + (sample.tokensIn ?? 0), 0),
    tokensOut: samples.reduce((sum, sample) => sum + (sample.tokensOut ?? 0), 0),
    errors: [...new Set(samples.map((sample) => sample.error).filter(Boolean))],
  };
};

async function probe(instruction, input, options) {
  const started = performance.now();
  try {
    const answer = await llmTransport.requestJson(config, `${POLICY}\n${instruction}`, input, options);
    return { ms: Math.round(performance.now() - started), tokensIn: answer.tokensIn, tokensOut: answer.tokensOut };
  } catch (error) {
    return { ms: Math.round(performance.now() - started), error: error instanceof LlmFailure ? error.code : String(error) };
  }
}

const report = { model: config.model, baseUrl: config.baseUrl, at: new Date().toISOString() };

// 最小请求：把 DNS、TLS 握手与网关往返摊到最清楚，是「连接速度」的主要观测量。
const ping = [];
for (let index = 0; index < runs; index++) {
  ping.push(await probe(testInstruction, '{}', { maxTokens: 256 }));
}
report.ping = stats(ping);

if (jobId) {
  const request = profileRequest(jobId);
  const started = performance.now();
  const result = await probe(request.instruction, JSON.stringify(request.input), { maxTokens: 5200, deepSeekThinking: 'disabled' });
  report.profile = { jobId, instructionChars: request.instruction.length, inputChars: JSON.stringify(request.input).length,
    ...result, wallMs: Math.round(performance.now() - started) };
}

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`模型 ${report.model}  ${report.baseUrl}`);
  const line = (label, value) => console.log(`  ${label.padEnd(10)} ${value}`);
  const ms = (value) => (value === null ? '—' : `${value}ms`);
  line('ping', `${report.ping.runs} 次  最小 ${ms(report.ping.minMs)}  p50 ${ms(report.ping.p50Ms)}  p95 ${ms(report.ping.p95Ms)}  最慢 ${ms(report.ping.maxMs)}`);
  line('失败', `${report.ping.failed} 次${report.ping.errors.length ? `（${report.ping.errors.join(', ')}）` : ''}`);
  line('token', `输入 ${report.ping.tokensIn}  输出 ${report.ping.tokensOut}`);
  if (report.profile) {
    line('画像', `${ms(report.profile.ms)}  输出 ${report.profile.tokensOut ?? '—'} token${report.profile.error ? `  失败 ${report.profile.error}` : ''}`);
    line('画像输入', `${report.profile.instructionChars} 字符提示词 + ${report.profile.inputChars} 字符输入`);
  }
  console.log('\n改动前后各跑一次，把这两行数字贴进 PR。');
}