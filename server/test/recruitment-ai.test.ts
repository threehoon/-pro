import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

const dataDir = mkdtempSync(join(tmpdir(), 'hireloop-ai-test-'));
process.env.HIRELOOP_DATA_DIR = dataDir;
process.env.HIRELOOP_DB_PATH = join(dataDir, 'app.db');
process.env.NODE_ENV = 'test';
delete process.env.LLM_API_KEY;

const { buildApp } = await import('../src/app.ts');
const { closeDb, getRow, run, uploadDir } = await import('../src/db/index.ts');
const { decodeLlmResponse, isPublicAddress, llmTransport, LlmFailure, publicLlmBaseUrl, selectLlmAddress } = await import('../src/integrations/llm.ts');
const { PROMPT_VERSIONS } = await import('../src/services/ai/prompts.ts');
const { fallbackProfile, normalizeGeneratedProfile, normalizeProfile, scoreScreening, validateScreening } = await import('../src/services/recruitment-evidence.ts');
const { now } = await import('../src/lib/util.ts');

let app: Awaited<ReturnType<typeof buildApp>>;
let adminCookie: string;
let managerCookie: string;
const originalTransport = llmTransport.requestJson;
const profile = fallbackProfile('客户成功经理', '大专以上，男优先，25–35 岁', ['续约']);
const knownQuote = '负责企业客户的续约和交接';
const fakeQuote = '主动将续约率提升了很多';
const interviewOne = `${knownQuote}。${'这个案例涉及几个团队持续反馈实际工单。'.repeat(14)}`;
const interviewTwo = `有跨部门协调和风险上报的真实案例。${'详细说明会议纪要和后续改进措施。'.repeat(17)}`;
const jobPath = '/api/jobs/ai-job/profile';
const appPath = '/api/applications/ai-application';
const firstPath = '/api/interviews/ai-first';
const secondPath = '/api/interviews/ai-second';

async function inject(method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: object, cookie = adminCookie) {
  return app.inject({ method, url, headers: { cookie }, payload });
}

async function waitFor(url: string, status: string) {
  for (let attempt = 0; attempt < 80; attempt++) {
    const response = await inject('GET', url);
    assert.equal(response.statusCode, 200);
    const value = response.json();
    if (value.data.status === status) return value;
    await sleep(10);
  }
  assert.fail(`Timed out waiting for ${status} at ${url}`);
}

before(async () => {
  app = await buildApp();
  await app.ready();
  const registration = await app.inject({ method: 'POST', url: '/api/auth/register', payload: {
    name: 'AI 管理员', email: 'ai-admin@hireloop.cn', password: 'password123',
  } });
  assert.equal(registration.statusCode, 200);
  adminCookie = String(registration.headers['set-cookie']).split(';')[0]!;
  const manager = await inject('POST', '/api/auth/register', {
    name: '招聘经理', email: 'ai-manager@hireloop.cn', password: 'password123',
  });
  assert.equal(manager.statusCode, 200);
  run("UPDATE users SET role = 'hiring_manager' WHERE id = ?", [manager.json().user.id]);
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: {
    email: 'ai-manager@hireloop.cn', password: 'password123',
  } });
  assert.equal(login.statusCode, 200);
  managerCookie = String(login.headers['set-cookie']).split(';')[0]!;
  const timestamp = now();
  run(`INSERT INTO jobs(id,title,description,skills,created_at,updated_at) VALUES ('ai-job','客户成功经理','大专以上，25–35 岁','["续约"]',?,?)`, [timestamp, timestamp]);
  run(`INSERT INTO candidates(id,name,education,resume_text,created_at,updated_at) VALUES ('ai-candidate','测试候选人','本科',?,?,?)`, [knownQuote, timestamp, timestamp]);
  run(`INSERT INTO applications(id,job_id,candidate_id,stage,applied_at,updated_at) VALUES ('ai-application','ai-job','ai-candidate','screening',?,?)`, [timestamp, timestamp]);
  for (const [id, round] of [['ai-first', 1], ['ai-second', 2]] as const) {
    run(`INSERT INTO interviews(id,application_id,round,title,scheduled_at,created_at,updated_at) VALUES (?,'ai-application',?,'面试',?,?,?)`,
      [id, round, timestamp, timestamp, timestamp]);
  }
});

after(async () => {
  llmTransport.requestJson = originalTransport;
  await app.close();
  closeDb();
  if (dataDir.startsWith(join(tmpdir(), 'hireloop-ai-test-'))) rmSync(dataDir, { recursive: true, force: true });
});

test('public HTTPS rejects credentials, literals and non-public addresses', () => {
  for (const address of ['127.0.0.1', '10.0.0.2', '169.254.169.254', '100.64.0.1', '::ffff:127.0.0.1', 'fd00::1', '2001:db8::1']) {
    assert.equal(isPublicAddress(address), false, address);
  }
  assert.equal(isPublicAddress('8.8.8.8'), true);
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
  for (const url of ['http://api.deepseek.com', 'https://user:pass@api.deepseek.com', 'https://localhost/v1',
    'https://[::1]', 'https://127.0.0.1', 'https://api.deepseek.com/v1?secret=x', 'https://foo.internal/v1']) {
    assert.throws(() => publicLlmBaseUrl(url), /HTTPS/);
  }
});

test('only the official DeepSeek HTTPS endpoint accepts a reserved DNS proxy address', () => {
  const proxyAddress = { address: '198.18.8.1', family: 4 };
  const publicV4 = { address: '8.8.8.8', family: 4 };
  const publicV6 = { address: '2606:4700:4700::1111', family: 6 };
  const privateV4 = { address: '10.0.0.1', family: 4 };
  const official = new URL('https://api.deepseek.com/v1');
  assert.equal(isPublicAddress(proxyAddress.address), false);
  assert.equal(selectLlmAddress(official, [proxyAddress]), proxyAddress);
  assert.equal(selectLlmAddress(new URL('https://api.deepseek.com'), [proxyAddress]), proxyAddress);
  assert.equal(selectLlmAddress(official, [proxyAddress, publicV6]), publicV6);
  assert.equal(selectLlmAddress(official, [proxyAddress, publicV6, publicV4]), publicV4);
  assert.equal(selectLlmAddress(official, [proxyAddress, privateV4]), undefined);
  assert.equal(selectLlmAddress(official, []), undefined);
  for (const unrelated of ['https://api.example.org/v1', 'https://api.deepseek.com:8443/v1', 'https://api.deepseek.com/other',
    'https://api.deepseek.com.example.org/v1']) {
    assert.equal(selectLlmAddress(new URL(unrelated), [publicV4, proxyAddress]), undefined, unrelated);
  }
  assert.equal(selectLlmAddress(new URL('https://api.example.org/v1'), [publicV4]), publicV4);
});

test('DeepSeek settings use the official model ID and preserve saved keys and custom providers', async () => {
  const defaults = (await inject('GET', '/api/settings/llm')).json().data;
  assert.equal(defaults.baseUrl, 'https://api.deepseek.com');
  assert.equal(defaults.model, 'deepseek-flash');
  assert.equal(defaults.configured, false);

  const apiKey = ['opaque', 'test', 'flash'].join('-');
  try {
    const legacy = await inject('POST', '/api/settings/llm', { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey });
    assert.equal(legacy.statusCode, 200);
    assert.equal(legacy.json().data.model, 'deepseek-flash');
    assert.equal(legacy.json().data.configured, true);
    assert.equal(legacy.json().data.keyTail, 'lash');
    assert.equal(legacy.body.includes(apiKey), false);
    run("UPDATE integrations SET config_json = json_set(config_json, '$.model', 'deepseek-chat') WHERE provider = 'llm'");
    const restored = (await inject('GET', '/api/settings/llm')).json().data;
    assert.equal(restored.model, 'deepseek-flash');
    assert.equal(restored.keyTail, 'lash');

    llmTransport.requestJson = async (config) => {
      assert.equal(config.model, 'deepseek-flash');
      assert.equal(config.apiKey, apiKey);
      return { value: { ok: true }, tokensIn: null, tokensOut: null };
    };
    const probe = await inject('POST', '/api/settings/llm/test', { model: 'deepseek-chat' });
    assert.equal(probe.json().ok, true);
    assert.equal(probe.json().data.model, 'deepseek-flash');

    const custom = await inject('POST', '/api/settings/llm', { baseUrl: 'https://api.openai.com/v1', model: 'deepseek-chat' });
    assert.equal(custom.statusCode, 200);
    assert.equal(custom.json().data.model, 'deepseek-chat');
    assert.equal(custom.json().data.configured, false);
  } finally {
    llmTransport.requestJson = originalTransport;
    run("DELETE FROM integrations WHERE provider = 'llm'");
  }
});

test('model decoding keeps usage for blank and truncated completions and rejects invalid or secret-bearing output', () => {
  const usage = { prompt_tokens: 12, completion_tokens: 8 };
  const tokens = { tokensIn: 12, tokensOut: 8 };
  const reply = (content: string | null, finish_reason = 'stop') => JSON.stringify({
    choices: [{ message: { content }, finish_reason }], usage,
  });
  assert.deepEqual(decodeLlmResponse(reply('{"ready":true}'), ''), { value: { ready: true }, ...tokens });
  assert.deepEqual(decodeLlmResponse('{"choices":[{"message":{"content":"{}"}}],"usage":{"prompt_tokens":"unknown"}}', ''), {
    value: {}, tokensIn: null, tokensOut: null,
  });
  for (const [body, code] of [
    [reply('   '), 'empty_response'],
    [reply(null), 'empty_response'],
    [reply('{"ready":', 'length'), 'truncated_response'],
    [reply('{}', 'content_filter'), 'invalid_response'],
    [reply('[]'), 'invalid_response'],
    [reply('not JSON'), 'malformed_json'],
    [reply('{"indicators":[{"name":"背景度"},"bonus":[]}'), 'malformed_json'],
  ]) {
    assert.throws(() => decodeLlmResponse(body!, ''), (error) => {
      assert.ok(error instanceof LlmFailure);
      assert.equal(error.code, code);
      assert.deepEqual(error.usage, tokens);
      return true;
    });
  }
  assert.deepEqual(decodeLlmResponse(reply('{"ready":true}', 'eos'), ''), { value: { ready: true }, ...tokens });
  assert.throws(() => decodeLlmResponse(JSON.stringify({ choices: [{ finish_reason: 'length' }], usage }), ''), {
    message: 'truncated_response', usage: tokens,
  });
  assert.throws(() => decodeLlmResponse(JSON.stringify({ choices: [{ message: 42 }], usage }), ''), { message: 'invalid_response' });
  assert.throws(() => decodeLlmResponse('{"choices":[]}', ''), { message: 'invalid_response' });
  assert.throws(() => decodeLlmResponse(reply('{"echo":"private-fixture"}'), 'private-fixture'), { message: 'invalid_response' });
  const escapedSecret = '{"choices":[{"message":{"content":"{\\"echo\\":\\"private-\\\\u0066ixture\\"}"}}]}';
  assert.throws(() => decodeLlmResponse(escapedSecret, 'private-fixture'), { message: 'invalid_response' });
});

test('creating a title-only job queues an AI portrait and clearly reports a blank completion before retry', async () => {
  const title = '软件开发工程师';
  const draft = { ...fallbackProfile(title, title, ['代码评审']), positioning: '负责软件功能交付、代码质量与故障排查' };
  const competencies = draft.indicators.map(({ labels }) => labels.slice(0, 3).map(({ name, weight, tiers }) =>
    [name, weight, tiers.E, tiers.D, tiers.C, tiers.B, tiers.A]));
  const compactDraft = {
    positioning: draft.positioning,
    hard_gates: [{ condition: '本科及以上', how: '核对学历' }],
    redlines: ['缺少指定证书'],
    bonus: [], not_wanted: [],
    weights: draft.indicators.map(({ weight }) => weight),
    background: competencies[0], attitude: competencies[1], technical: competencies[2], collaboration: competencies[3],
  };
  let calls = 0;
  await inject('POST', '/api/settings/llm', { apiKey: 'opaque-profile-fixture' });
  try {
    llmTransport.requestJson = async (_config, instruction, input, options) => {
      calls++;
      assert.deepEqual(JSON.parse(input), { jd: title });
      assert.match(instruction, /只有岗位名称/);
      const example = instruction.split('\n').find((line) => line.startsWith('{'));
      assert.ok(example);
      const parsedExample = JSON.parse(example);
      assert.equal(parsedExample.meta.department_code, 'SC');
      assert.equal(parsedExample.trait_match.code, 'B');
      assert.match(parsedExample.technical[0][4], /能独立处理常见故障/);
      assert.equal(options?.maxTokens, 5200);
      assert.equal(options?.deepSeekThinking, calls % 2 ? 'disabled' : 'enabled');
      assert.ok(options && options.timeoutMs! > 0 && options.timeoutMs! <= 45_000);
      if (calls <= 2) throw new LlmFailure('empty_response', { tokensIn: 22, tokensOut: 5 });
      if (calls === 3) return { value: { ...compactDraft, background: undefined }, tokensIn: 22, tokensOut: 1200 };
      if (calls === 4) return { value: { ...compactDraft, technical: competencies[2]?.map(row => row.slice(0, 6)) }, tokensIn: 22, tokensOut: 1200 };
      if (calls === 5) throw new LlmFailure('malformed_json', { tokensIn: 22, tokensOut: 1160 });
      return { value: compactDraft, tokensIn: 22, tokensOut: 1200 };
    };
    const created = await inject('POST', '/api/jobs', { title });
    assert.equal(created.statusCode, 201);
    const { id } = created.json().job;
    const url = `/api/jobs/${id}/profile`;
    const failed = await waitFor(url, 'failed');
    assert.match(failed.reason, /返回了空内容/);
    assert.equal(failed.data.profile.status, 'failed');
    const failedRun = getRow<{ error: string; tokens_in: number; tokens_out: number; prompt_version: string }>(
      'SELECT error, tokens_in, tokens_out, prompt_version FROM ai_runs WHERE subject_id = ?', [id],
    );
    assert.deepEqual(
      { error: failedRun?.error, tokens_in: failedRun?.tokens_in, tokens_out: failedRun?.tokens_out },
      { error: 'empty_response', tokens_in: 44, tokens_out: 10 },
    );
    // 每次调用都写下提示词版本，才能按版本对比耗时与质量。
    assert.equal(failedRun?.prompt_version, PROMPT_VERSIONS.profile);
    assert.equal((await inject('POST', `${url}/generate`)).statusCode, 200);
    const invalid = await waitFor(url, 'failed');
    assert.equal(invalid.data.profile.version, 2);
    assert.match(invalid.reason, /指标或分档格式有误/);
    assert.equal((await inject('POST', `${url}/generate`)).statusCode, 200);
    const ready = await waitFor(url, 'ready');
    assert.equal(ready.data.profile.generatedBy, 'ai');
    assert.equal(ready.data.profile.status, 'draft');
    assert.equal(ready.data.profile.content.positioning, draft.positioning);
    assert.deepEqual(ready.data.profile.content.hard_gates, []);
    assert.deepEqual(ready.data.profile.content.redlines, []);
    assert.deepEqual(ready.data.profile.content.indicators.map(({ name }: { name: string }) => name), ['背景度', '心态度', '专业度', '组织度']);
    assert.deepEqual(ready.data.profile.content.indicators[2].labels[0].tiers, draft.indicators[2]!.labels[0]!.tiers);
    assert.equal(calls, 6);
    const readyRun = getRow<{ tokens_in: number; tokens_out: number }>(
      'SELECT tokens_in, tokens_out FROM ai_runs WHERE subject_id = ? AND status = ?', [id, 'ok'],
    );
    assert.deepEqual({ ...readyRun }, { tokens_in: 44, tokens_out: 2360 });
  } finally {
    llmTransport.requestJson = originalTransport;
    run("DELETE FROM integrations WHERE provider = 'llm'");
  }
});

test('settings are masked, credentials stay tied to the origin, and managers are read-only', async () => {
  const fixture = ['opaque', 'test', 'abcd'].join('-');
  const saved = await inject('POST', '/api/settings/llm', { baseUrl: 'https://api.deepseek.com/v1', model: 'test-model', apiKey: fixture });
  assert.equal(saved.json().data.keyTail, 'abcd');
  assert.equal(saved.body.includes(fixture), false);
  assert.equal((await inject('GET', '/api/settings/llm', undefined, managerCookie)).statusCode, 200);
  const writes = [
    ['POST', '/api/settings/llm', { model: 'test-model' }], ['POST', '/api/settings/llm/test'],
    ['PUT', jobPath, { content: profile }], ['POST', `${jobPath}/generate`], ['POST', `${jobPath}/approve`],
    ['POST', `${appPath}/screen`], ['PATCH', '/api/screening/unused/label', { indicator: '背景度', label: '标签', level: 'B' }],
    ['PUT', `${firstPath}/transcript`, { transcript: interviewOne }], ['POST', `${firstPath}/summary/retry`],
    ['POST', `${firstPath}/summary/manual`, { conclusion: '某结论' }], ['POST', `${appPath}/composite/retry`],
  ] as const;
  for (const [method, url, payload] of writes) assert.equal((await inject(method, url, payload, managerCookie)).statusCode, 403, url);
  const moved = await inject('POST', '/api/settings/llm', { baseUrl: 'https://api.openai.com/v1' });
  assert.equal(moved.json().data.configured, false);
  assert.equal(moved.json().data.keyTail, null);
});

test('profile normalizes weights, flags protected wording and screening excludes unknown', () => {
  const adjusted = normalizeProfile({ ...profile, indicators: profile.indicators.map((dimension) => ({ ...dimension, weight: 10 })) });
  assert.ok(adjusted);
  assert.ok(adjusted.weights_adjusted);
  assert.equal(adjusted.compliance_rewritten, true);
  assert.deepEqual(adjusted.indicators.map(({ weight }) => weight), [25, 25, 25, 25]);
  const item = adjusted.indicators[0]!.labels[0]!;
  const result = validateScreening({ labels: [{ indicator: '背景度', label: item.name, level: 'B', quote: knownQuote }],
    concerns: [{ point: '缺少经验', quote: null }, { point: fakeQuote, quote: fakeQuote }],
    reject_reason: '薪资期望不符' }, adjusted, knownQuote, true);
  assert.ok(result);
  assert.equal(result.dropped, 2);
  assert.equal(result.reject_reason, null);
  assert.deepEqual(scoreScreening(result, adjusted), { score: 150, verdict: 'mismatch', unknownWeight: 100 - item.weight,
    missingGates: ['大专以上'], redlineHit: [] });
});

test('resume excerpts reject contact details and ambiguous selections', () => {
  const options = ['联系电话：138-0000-0000', '138. 0000. 0000', '企业客户迁移', '独立整理续约报告。'];
  const resume = ['负责企业客户迁移。', '协助企业客户迁移。', ...options.filter((_, i) => i !== 2)].join('\n');
  const detail = validateScreening({ resume_excerpts: options.map((quote) => ({ quote })) }, profile, resume, true);
  assert.deepEqual(detail?.resume_excerpts, ['独立整理续约报告。']);
  assert.equal(detail?.dropped, 3);
});

test('screening follows the approved profile version, preserves history and audits edits', async () => {
  await inject('POST', '/api/settings/llm', { apiKey: ['unit', 'fixture', 'ijkl'].join('-') });
  const usedProfiles: string[] = [];
  const label = profile.indicators[0]!.labels[0]!.name;
  llmTransport.requestJson = async (_config, _instruction, input) => {
    usedProfiles.push(JSON.parse(input).profile);
    return { value: { labels: [{ indicator: '背景度', label, level: 'B', quote: knownQuote },
      { indicator: '背景度', label: profile.indicators[0]!.labels[1]!.name, level: 'A', quote: fakeQuote }],
      resume_excerpts: [{ quote: knownQuote }],
    }, tokensIn: 20, tokensOut: 5 };
  };
  assert.equal((await inject('PUT', jobPath, { content: profile })).json().data.profile.status, 'draft');
  await inject('POST', `${appPath}/screen`);
  const rules = await waitFor(`${appPath}/screening`, 'ready');
  assert.equal(rules.data.review.score, null);
  assert.equal(rules.data.review.detail.skills_matched, 1);
  assert.equal(rules.data.review.detail.source, 'rules');
  assert.equal(rules.data.review.profileId, null);
  assert.equal(rules.data.review.profileVersion, null);
  assert.equal(rules.data.approvedProfile, null);
  assert.equal(rules.data.hasResumeText, true);
  assert.equal(usedProfiles.length, 0);
  const firstApproval = (await inject('POST', `${jobPath}/approve`)).json().data;
  assert.equal(firstApproval.profile.status, 'approved');
  assert.deepEqual(firstApproval.approvedProfile, { id: firstApproval.profile.id, version: firstApproval.profile.version });
  const screened = await waitFor(`${appPath}/screening`, 'ready');
  assert.equal(screened.dropped, 1);
  assert.equal(screened.data.review.score, 150);
  assert.deepEqual(screened.data.approvedProfile, firstApproval.approvedProfile);
  assert.equal(screened.data.review.profileVersion, firstApproval.profile.version);
  const edited = await inject('PATCH', `/api/screening/${screened.data.review.id}/label`, { indicator: '背景度', label, level: 'C' });
  assert.equal(edited.json().data.review.score, 100);
  await inject('POST', `${appPath}/screen`);
  assert.equal((await waitFor(`${appPath}/screening`, 'ready')).data.review.score, 100);
  assert.equal(usedProfiles.length, 1);
  assert.equal(getRow<{ n: number }>("SELECT count(*) AS n FROM audit_log WHERE action = 'screening.score'")?.n, 2);
  const change = getRow<{ detail: string }>("SELECT detail FROM audit_log WHERE action = 'screening.label_override'");
  assert.equal(JSON.parse(change?.detail ?? '{}').previousScore, 150);
  const request = getRow<{ detail: string }>(`SELECT detail FROM audit_log
    WHERE action = 'ai.invoke' AND json_extract(detail, '$.subjectId') = 'ai-application'`);
  assert.equal(JSON.parse(request?.detail ?? '{}').tokensIn, 20);

  const positioning = '新版：有可核实的客户续约记录';
  const draft = (await inject('PUT', jobPath, { content: { ...profile, positioning } })).json().data;
  assert.equal(draft.profile.status, 'draft');
  assert.deepEqual(draft.approvedProfile, firstApproval.approvedProfile);
  await inject('POST', `${appPath}/screen`);
  const prior = (await waitFor(`${appPath}/screening`, 'ready')).data;
  assert.equal(prior.review.profileVersion, firstApproval.profile.version);
  assert.equal(prior.review.score, 100);
  assert.equal(usedProfiles.length, 1);

  async function screeningCard() {
    const response = await inject('GET', '/api/jobs/ai-job/board');
    assert.equal(response.statusCode, 200);
    const result = response.json();
    return result.columns.find(({ stage }: { stage: string }) => stage === 'screening').cards[0] ?? result.rejected[0];
  }
  assert.equal((await screeningCard()).screening_score, 100);
  assert.equal((await screeningCard()).screening_has_summary, true);
  const currentDetail = getRow<{ detail_json: string }>('SELECT detail_json FROM screening_reviews WHERE id = ?', [prior.review.id])!.detail_json;
  try {
    run(`UPDATE screening_reviews SET detail_json = json_set(json_remove(detail_json, '$.resume_excerpts'), '$.resume_summary', json(?)) WHERE id = ?`,
      [JSON.stringify([{ point: '已丢弃的旧版自由改写', quote: knownQuote }]), prior.review.id]);
    const legacy = (await inject('GET', `${appPath}/screening`)).json().data.review;
    assert.equal(legacy.detail.resume_summary, undefined);
    assert.equal(legacy.detail.resume_excerpts, undefined);
    assert.equal(legacy.score, 100);
    assert.equal((await screeningCard()).screening_has_summary, false);
  } finally {
    run('UPDATE screening_reviews SET detail_json = ? WHERE id = ?', [currentDetail, prior.review.id]);
  }
  const successfulTransport = llmTransport.requestJson;
  let releaseSecond: () => void;
  const heldSecond = new Promise<void>((resolve) => { releaseSecond = resolve; });
  llmTransport.requestJson = async () => {
    await heldSecond;
    throw new LlmFailure('timeout');
  };
  try {
    const secondApproval = (await inject('POST', `${jobPath}/approve`, { profileId: draft.profile.id })).json().data;
    assert.equal(secondApproval.approvedProfile.version, draft.profile.version);
    const generating = await screeningCard();
    assert.equal(generating.screening_status, 'generating');
    assert.equal(generating.screening_score, null);
    assert.equal(generating.screening_verdict, null);
    assert.equal(generating.screening_has_summary, false);
    assert.equal(generating.screening_top_reason, null);
    assert.deepEqual(generating.screening_missing_gates, []);
  } finally {
    releaseSecond!();
  }
  assert.equal((await waitFor(`${appPath}/screening`, 'failed')).data.review.profileVersion, firstApproval.profile.version);
  const failed = await screeningCard();
  assert.equal(failed.screening_status, 'failed');
  assert.equal(failed.screening_score, null);
  assert.equal(failed.screening_has_summary, false);
  llmTransport.requestJson = successfulTransport;
  await inject('POST', `${appPath}/screen`);
  const next = (await waitFor(`${appPath}/screening`, 'ready')).data;
  assert.equal(next.review.profileVersion, draft.profile.version);
  assert.equal(next.review.score, 150);
  assert.equal(next.history[0].profileVersion, firstApproval.profile.version);
  assert.equal(next.history[0].score, 100);
  assert.equal(usedProfiles.length, 2);
  assert.ok(usedProfiles[1]!.includes(positioning));
  const staleEdit = await inject('PATCH', `/api/screening/${prior.review.id}/label`, { indicator: '背景度', label, level: 'A' });
  assert.equal(staleEdit.statusCode, 409);
  assert.equal((await screeningCard()).screening_score, 150);

  let signalStarted: () => void;
  let releaseObsolete: () => void;
  const started = new Promise<void>((resolve) => { signalStarted = resolve; });
  const obsolete = new Promise<void>((resolve) => { releaseObsolete = resolve; });
  llmTransport.requestJson = async () => {
    signalStarted!();
    await obsolete;
    throw new LlmFailure('timeout', { tokensIn: 10, tokensOut: null });
  };
  const third = (await inject('PUT', jobPath, { content: { ...profile, positioning: '第三版' } })).json().data.profile;
  try {
    assert.equal((await inject('POST', `${jobPath}/approve`, { profileId: third.id })).statusCode, 200);
    await started;
    llmTransport.requestJson = successfulTransport;
    const fourth = (await inject('PUT', jobPath, { content: { ...profile, positioning: '第四版' } })).json().data.profile;
    assert.equal((await inject('POST', `${jobPath}/approve`, { profileId: fourth.id })).statusCode, 200);
    assert.equal((await waitFor(`${appPath}/screening`, 'ready')).data.review.profileVersion, fourth.version);
  } finally {
    releaseObsolete!();
  }
  for (let attempt = 0; attempt < 40 && !getRow("SELECT id FROM ai_runs WHERE error = 'superseded'"); attempt++) await sleep(10);
  const superseded = getRow<{ status: string; tokens_in: number }>("SELECT status, tokens_in FROM ai_runs WHERE error = 'superseded'");
  assert.equal(superseded?.status, 'skipped');
  assert.equal(superseded?.tokens_in, 10);
  const current = await screeningCard();
  assert.equal(current.screening_status, 'ready');
  assert.equal(current.screening_score, 150);
  assert.equal((await inject('GET', `${appPath}/screening`)).json().data.status, 'ready');

  assert.equal((await inject('POST', `${appPath}/reject`, { reason: '其他' })).statusCode, 200);
  const fifth = (await inject('PUT', jobPath, { content: { ...profile, positioning: '第五版' } })).json().data.profile;
  assert.equal((await inject('POST', `${jobPath}/approve`, { profileId: fifth.id })).statusCode, 200);
  const archived = await screeningCard();
  assert.equal(archived.screening_status, 'stale');
  assert.equal(archived.screening_score, null);
  assert.equal((await inject('POST', `${appPath}/reopen`)).statusCode, 200);
  assert.equal((await waitFor(`${appPath}/screening`, 'ready')).data.review.profileVersion, fifth.version);
  assert.equal((await screeningCard()).screening_score, 150);
});

test('transcript retry validates quotes and triggers verified composite, with manual fallback', async () => {
  let calls = 0;
  llmTransport.requestJson = async (_config, instruction, input) => {
    if (instruction.includes('比较一轮')) return { value: {
      headline: '两轮均讨论客户工作', confirmed: [{ point: '负责续约', from: [1], evidence: [{ round: 1, quote: knownQuote }] },
        { point: '未经验证', from: [2], evidence: [{ round: 2, quote: fakeQuote }] }],
    }, tokensIn: 1, tokensOut: 1 };
    calls++;
    if (calls === 1) throw new LlmFailure('timeout');
    const quote = JSON.parse(input).transcript.includes(knownQuote) ? knownQuote : '有跨部门协调和风险上报的真实案例';
    return { value: { headline: '已讨论日常工作', highlights: [{ point: '描述工作职责', quote },
      { point: '未经证实的业绩', quote: fakeQuote }], suggested: 'advance' }, tokensIn: 5, tokensOut: 1 };
  };
  assert.equal((await inject('PUT', `${firstPath}/transcript`, { transcript: '过短的转写' })).json().ok, true);
  assert.equal((await inject('GET', `${firstPath}/summary`)).json().data.status, 'none');
  assert.equal((await inject('PUT', `${firstPath}/transcript`, { transcript: interviewOne })).json().data.summaryStatus, 'generating');
  assert.equal((await waitFor(`${firstPath}/summary`, 'failed')).ok, false);
  await inject('POST', `${firstPath}/summary/retry`);
  const retried = await waitFor(`${firstPath}/summary`, 'ready');
  assert.equal(retried.dropped, 1);
  assert.equal(retried.data.summary.highlights[0].quote, knownQuote);
  await inject('PUT', `${firstPath}/transcript`, { transcript: interviewOne });
  assert.equal(calls, 2);
  await inject('PUT', `${secondPath}/transcript`, { transcript: interviewTwo });
  const compared = await waitFor(`${appPath}/composite`, 'ready');
  assert.equal(compared.dropped, 1);
  assert.equal(compared.data.composite.confirmed.length, 1);
  await inject('POST', '/api/settings/llm', { apiKey: '' });
  assert.equal((await inject('POST', `${firstPath}/summary/manual`, { conclusion: '一面手填' })).json().data.status, 'manual');
  assert.equal((await inject('POST', `${secondPath}/summary/manual`, { headline: '二面手填' })).json().data.status, 'manual');
  const manual = await waitFor(`${appPath}/composite`, 'manual');
  assert.deepEqual(manual.data.composite.rounds, [{ round: 1, headline: '一面手填' }, { round: 2, headline: '二面手填' }]);
});


test('a revised first-round summary invalidates an in-flight second-round result', async () => {
  await inject('POST', '/api/settings/llm', { apiKey: ['unit', 'fixture', 'mnop'].join('-') });
  let signalStarted: () => void;
  let releaseProvider: () => void;
  const started = new Promise<void>((resolve) => { signalStarted = resolve; });
  const held = new Promise<void>((resolve) => { releaseProvider = resolve; });
  const previousHeadlines: unknown[] = [];
  const quote = '有跨部门协调和风险上报的真实案例';
  llmTransport.requestJson = async (_config, _instruction, input) => {
    previousHeadlines.push(JSON.parse(JSON.parse(input).previous).headline);
    if (previousHeadlines.length === 1) {
      signalStarted();
      await held;
    }
    return { value: { headline: '已讨论跨部门协调', highlights: [{ point: '跨部门协调', quote }] }, tokensIn: 1, tokensOut: 1 };
  };
  const active = await inject('PUT', `${secondPath}/transcript`, { transcript: `${interviewTwo}补充说明。` });
  assert.equal(active.json().data.summaryStatus, 'generating');
  try {
    await started;
    const changed = await inject('POST', `${firstPath}/summary/manual`, { headline: '修订的一面记录' });
    assert.equal(changed.json().data.status, 'manual');
  } finally {
    releaseProvider!();
  }
  assert.equal((await waitFor(`${secondPath}/summary`, 'failed')).data.summary, null);
  await inject('POST', `${secondPath}/summary/retry`);
  assert.equal((await waitFor(`${secondPath}/summary`, 'ready')).data.summary.highlights[0].quote, quote);
  assert.deepEqual(previousHeadlines, ['一面手填', '修订的一面记录']);
  await waitFor(`${appPath}/composite`, 'manual');
});


test('job resume import requires a confirmed portrait, deduplicates atomically and queues real screening inputs', async () => {
  const jobId = 'resume-import-job';
  const profilePath = `/api/jobs/${jobId}/profile`;
  const url = `/api/jobs/${jobId}/resume-import`;
  const timestamp = now();
  run('INSERT INTO jobs(id,title,created_at,updated_at) VALUES (?,?,?,?)', [jobId, '客户成功经理', timestamp, timestamp]);
  const boundary = 'hireloop-resume-test';
  const file = (content: string | Buffer, name = 'fixture.txt') => Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: text/plain\r\n\r\n`),
    Buffer.from(content), Buffer.from('\r\n'),
  ]);
  const upload = (parts: Buffer, cookie = adminCookie) => app.inject({
    method: 'POST', url, headers: { cookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([parts, Buffer.from(`--${boundary}--\r\n`)]),
  });
  const lateQuote = '协助企业客户数据迁移，参与核对和交接流程。';
  const resume = `姓名：周测试\n邮箱：direct-upload@example.com\n${knownQuote}\n${'参与客户使用报告整理。'.repeat(650)}\n${lateQuote}`;
  const draft = await inject('PUT', profilePath, { content: profile });
  assert.equal(draft.json().data.profile.status, 'draft');
  assert.equal((await upload(file(resume), '')).statusCode, 401);
  assert.equal((await upload(file(resume), managerCookie)).statusCode, 403);
  assert.equal((await upload(file(resume))).statusCode, 409);
  const approved = (await inject('POST', `${profilePath}/approve`)).json().data.approvedProfile;
  await inject('PUT', profilePath, { content: { ...profile, positioning: '未确认的新草稿不参与本次筛选' } });
  assert.deepEqual((await inject('GET', `/api/jobs/${jobId}/board`)).json().approvedProfile, approved);

  const filesBefore = existsSync(uploadDir) ? readdirSync(uploadDir).length : 0;
  const rowCount = () => getRow<{ n: number }>('SELECT count(*) AS n FROM files')!.n;
  const before = rowCount();
  assert.equal((await upload(file('    '))).statusCode, 400);
  assert.equal((await upload(file('not a word file', 'broken.docx'))).statusCode, 400);
  assert.equal((await upload(file(Buffer.from([0xc0, 0xaf])))).statusCode, 400);
  assert.equal((await upload(file('plain-looking\0binary'))).statusCode, 400);
  assert.equal((await upload(file(resume, 'fixture.doc'))).statusCode, 415);
  assert.equal((await upload(Buffer.concat([file(resume), file(resume, 'fixture2.txt')]))).statusCode, 413);
  assert.equal(rowCount(), before);

  const label = profile.indicators[0]!.labels[0]!.name;
  await inject('POST', '/api/settings/llm', { baseUrl: 'https://api.deepseek.com', apiKey: 'unit-test-import-key' });
  const received: Array<{ resume: string; profile: string }> = [];
  const previousTransport = llmTransport.requestJson;
  llmTransport.requestJson = async (_config, _instruction, input) => {
    received.push(JSON.parse(input));
    return { value: { labels: [{ indicator: '背景度', label, level: 'B', quote: knownQuote },
      { indicator: '背景度', label: profile.indicators[0]!.labels[1]!.name, level: 'B', quote: fakeQuote }],
      resume_excerpts: [
         { point: '主导企业客户数据迁移。', quote: '企业客户数据迁移' },
         { quote: fakeQuote },
         { quote: 'direct-upload@example.com' },
         { quote: lateQuote },
       ] }, tokensIn: 20, tokensOut: 5 };
  };
  try {
    const responses = await Promise.all([upload(file(resume)), upload(file(resume))]);
    assert.deepEqual(responses.map((response) => response.statusCode).sort(), [201, 409]);
    const result: { candidateId: string; applicationId: string } = responses.find((response) => response.statusCode === 201)!.json();
    const duplicate = responses.find((response) => response.statusCode === 409)!.json();
    assert.deepEqual(duplicate.error.details, { ...result, section: 'screening' });
    assert.equal(rowCount(), before + 1);
    assert.equal(readdirSync(uploadDir).length, filesBefore + 1);
    assert.equal((await upload(file(`${resume}\n新增资历`))).statusCode, 409);
    assert.equal(rowCount(), before + 1);
    const screeningPath = `/api/applications/${result.applicationId}/screening`;
    const { data } = await waitFor(screeningPath, 'ready');
    assert.deepEqual(data.approvedProfile, approved);
    assert.equal(data.review.profileId, approved.id);
    assert.equal(data.review.detail.source, 'ai');
    assert.equal(data.review.score, 150);
    assert.equal(data.review.detail.labels[0].quote, knownQuote);
    assert.deepEqual(data.review.detail.resume_excerpts, [lateQuote]);
    assert.equal(data.review.detail.dropped, 4);
    assert.equal(received.length, 1);
    assert.ok(received[0]!.resume.includes(knownQuote));
    assert.ok(received[0]!.resume.indexOf(lateQuote) > 6000);
    assert.ok(!received[0]!.profile.includes('未确认的新草稿'));
    const applicationPath = `/api/applications/${result.applicationId}`;
    assert.equal((await inject('GET', applicationPath)).json().application.stage, 'screening');
    assert.equal((await inject('POST', screeningPath, { decision: 'advance' }, managerCookie)).statusCode, 403);
    assert.equal((await inject('POST', screeningPath, { decision: 'advance' })).json().application.stage, 'interview');
    const archived = await upload(file('姓名：林测试\n邮箱：archive-upload@example.com\n其他经历', '另一份.txt'));
    assert.equal(archived.statusCode, 201);
    const archivedPath = `/api/applications/${archived.json().applicationId}/screening`;
    const archivedReview = await waitFor(archivedPath, 'ready');
    assert.deepEqual(archivedReview.data.review.detail.resume_excerpts, []);
    assert.equal((await inject('POST', archivedPath, { decision: 'reject' })).json().application.status, 'rejected');
  } finally {
    llmTransport.requestJson = previousTransport;
  }
});

test('standard portrait fallback tailors department, level, weights, responsibilities, labels and trait by role', () => {
  const tech = fallbackProfile('高级前端架构师', '负责前端工程化与核心交易系统架构设计，要求本科及以上学历，熟练掌握 React/TypeScript', ['React', 'TypeScript'], {
    department: '前端研发部', location: '杭州', level: 'L4',
  });
  const sales = fallbackProfile('大客户销售顾问', '负责华东区B端大客户拓展、商务谈判与年度回款目标达成', ['大客户拓展', 'CRM'], {
    department: '华东销售部', location: '上海',
  });
  const salesManager = fallbackProfile('大客户销售经理', '负责华东区B端销售团队管理与年度业绩指标达成', ['团队管理', '大客户拓展'], {
    department: '华东销售部', location: '上海',
  });
  const finance = fallbackProfile('财务会计', '负责全盘账务核算、税务申报、月度合并报表及内控合规审查', ['合并报表', '税务筹划']);

  assert.equal(tech.meta?.department_code, 'YF');
  assert.equal(tech.meta?.level, 'L4');
  assert.equal(tech.meta?.level_name, '策略岗');
  assert.equal(tech.meta?.location, '杭州');
  assert.equal(tech.trait_match?.code, 'G');
  assert.equal(tech.trait_match?.name, '分析者');
  assert.ok((tech.responsibilities?.length ?? 0) >= 5);

  assert.equal(sales.meta?.department_code, 'XS');
  assert.equal(sales.trait_match?.code, 'C');
  assert.equal(salesManager.meta?.department_code, 'XS');
  assert.equal(salesManager.meta?.level, 'L4');
  assert.equal(salesManager.trait_match?.code, 'A');
  assert.notDeepEqual(
    tech.indicators.map(({ weight }) => weight),
    sales.indicators.map(({ weight }) => weight),
  );
  assert.notEqual(
    tech.indicators[2]!.labels[0]!.name,
    sales.indicators[2]!.labels[0]!.name,
  );

  assert.equal(finance.meta?.department_code, 'CW');
  assert.equal(finance.trait_match?.code, 'F');
  for (const item of [tech, sales, salesManager, finance]) {
    assert.equal(item.indicators.reduce((sum, ind) => sum + ind.weight, 0), 100);
    for (const ind of item.indicators) {
      assert.ok(ind.labels.length >= 3 && ind.labels.length <= 6);
      assert.equal(ind.labels.reduce((sum, label) => sum + label.weight, 0), ind.weight);
    }
  }
});

test('generated portrait supports 3-6 labels per dimension, meta/trait normalization, compliance rewrite and legacy compatibility', () => {
  const raw = {
    meta: { code: 'YF-L3', industry: '工业互联网', department_code: 'YF', level: 'L3', location: '苏州' },
    positioning: '负责工业物联网后端服务开发与稳定性保障',
    responsibilities: [
      '负责核心设备接入与高并发消息处理服务研发',
      '制定接口规范、完善单元测试与线上监控告警',
      '排查线上性能瓶颈与生产故障并沉淀复盘文档',
      '仅限男性参与夜间值班',
      '协同前端与嵌入式团队推进版本按期交付',
    ],
    hard_gates: [
      { condition: '本科及以上学历，计算机相关专业', how: '核验学历证书' },
      { condition: '35岁以下', how: '核验身份证' },
    ],
    trait_match: { code: 'G', reason: '需要系统性拆解并发问题与严谨的工程分析能力' },
    redlines: ['简历核心项目经历造假', '未婚优先'],
    not_wanted: ['抗拒代码评审与规范沉淀'],
    bonus: ['具备高并发 MQTT/Kafka 生产调优经验'],
    weights: [20, 20, 40, 20],
    background: [
      ['后端开发年限', 8, '无生产经验', '1年以内', '3年以上后端实操经验', '5年以上核心系统经验', '主导大型系统演进'],
      ['工业/物联网背景', 6, '无相关认知', '了解概念', '有相关业务落地经历', '熟悉多协议接入', '主导行业平台架构'],
      ['工程规范积累', 6, '无规范习惯', '被动遵守', '自觉编写单测与文档', '推动团队规范落地', '建立研发质量体系'],
    ],
    attitude: [
      ['责任闭环意识', 10, '遇故障推诿', '提醒后跟进', '主动闭环所负责问题', '提前识别隐患预警', '带动团队形成兜底文化'],
      ['技术自驱力', 5, '拒绝学习', '被动查资料', '持续复盘并补齐短板', '主动分享最佳实践', '引领团队技术升级'],
      ['抗压与交付稳健度', 5, '高压易失误', '需协助稳住', '版本节点稳定按期交付', '复杂变更零事故上线', '构建高韧性交付机制'],
    ],
    technical: [
      ['服务端架构设计', 12, '仅写单表接口', '可仿写模块', '独立完成核心模块设计', '主导多服务高可用设计', '操盘千万级架构治理'],
      ['数据库与缓存调优', 10, '不会排查慢查询', '能加基础索引', '独立定位并优化高频慢查询', '完成分库分表与缓存架构', '建立全链路性能基线'],
      ['故障定位与复盘', 10, '无法定位线上异常', '按日志排查', '独立定位常见线上故障', '快速定位跨服务复杂故障', '沉淀排障SOP与演练体系'],
      ['安全与稳定性实践', 8, '忽略权限校验', '基础参数校验', '落实鉴权、幂等与限流保护', '构建容灾降级方案', '主导全栈安全合规治理'],
    ],
    collaboration: [
      ['跨团队接口协同', 8, '沟通含糊反复返工', '按要求同步', '清晰定义接口契约并按期联调', '主动拉通上下游化解阻塞', '优化跨端协作流程'],
      ['代码评审与共建', 6, '抗拒评审意见', '按意见修改', '认真评审并给出建设性建议', '帮带新人提升代码质量', '建立高效评审机制'],
      ['需求澄清能力', 6, '照单全收不质疑', '发现明显漏洞', '能识别边界条件与技术风险', '协同产品优化业务方案', '从技术视角反哺业务规划'],
    ],
  };

  const normalized = normalizeGeneratedProfile(raw, '后端开发工程师 本科及以上学历', false);
  assert.ok(normalized);
  assert.equal(normalized.meta?.code, 'YF-L3');
  assert.equal(normalized.meta?.department, '研发技术岗');
  assert.equal(normalized.meta?.level_name, '实施岗');
  assert.equal(normalized.trait_match?.code, 'G');
  assert.equal(normalized.trait_match?.name, '分析者');
  assert.equal(normalized.trait_match?.combo, '主完美型 · 辅交流型');
  assert.equal(normalized.indicators[2]!.labels.length, 4);
  assert.equal(normalized.compliance_rewritten, true);
  assert.ok(!JSON.stringify(normalized).includes('仅限男性'));
  assert.ok(!JSON.stringify(normalized).includes('35岁以下'));
  assert.ok(!JSON.stringify(normalized).includes('未婚'));

  // Legacy portrait without meta/responsibilities/trait_match and with only 1-2 labels remains 100% valid
  const legacyIndicators = normalized.indicators.map((item, idx) => ({
    ...item,
    weight: 25,
    labels: idx === 0
      ? [{ ...item.labels[0]!, weight: 25 }]
      : [
          { ...item.labels[0]!, weight: 13 },
          { ...item.labels[1]!, weight: 12 },
        ],
  }));
  const legacy = normalizeProfile({
    positioning: '旧版岗位定位',
    hard_gates: [{ condition: '本科以上', how: '查验学历' }],
    indicators: legacyIndicators,
    redlines: ['履历造假'],
    bonus: [],
    not_wanted: [],
  });
  assert.ok(legacy);
  assert.equal(legacy.meta, undefined);
  assert.equal(legacy.responsibilities, undefined);
  assert.equal(legacy.trait_match, undefined);
  assert.equal(legacy.indicators[0]!.labels.length, 1);
  assert.equal(legacy.indicators[1]!.labels.length, 2);
});

test('legacy 2-label stored portrait can be read, edited, approved, and used for screening', async () => {
  run("DELETE FROM integrations WHERE provider = 'llm'");
  const created = await inject('POST', '/api/jobs', { title: '历史画像兼容岗位' });
  assert.equal(created.statusCode, 201);
  const jobId = created.json().job.id;
  await waitFor(`/api/jobs/${jobId}/profile`, 'ready');

  const base = fallbackProfile('历史画像兼容岗位', '', []);
  const legacyContent = {
    positioning: '旧版 2 标签岗位定位',
    hard_gates: [],
    indicators: base.indicators.map((ind) => ({
      name: ind.name,
      weight: 25,
      labels: [
        { ...ind.labels[0]!, weight: 13 },
        { ...ind.labels[1]!, weight: 12 },
      ],
    })),
    redlines: [],
    bonus: [],
    not_wanted: [],
  };
  run("UPDATE job_profiles SET content_json = ?, status = 'draft' WHERE job_id = ?", [JSON.stringify(legacyContent), jobId]);

  const readRes = await inject('GET', `/api/jobs/${jobId}/profile`);
  assert.equal(readRes.statusCode, 200);
  const fetched = readRes.json().data.profile;
  assert.ok(fetched?.content);
  assert.equal(fetched.content.indicators[0].labels.length, 2);

  const edited = { ...fetched.content, positioning: '旧版 2 标签岗位定位（已微调）' };
  const saveRes = await inject('PUT', `/api/jobs/${jobId}/profile`, { content: edited });
  assert.equal(saveRes.statusCode, 200);
  const savedProfileId = saveRes.json().data.profile.id;
  assert.equal(saveRes.json().data.profile.content.indicators[0].labels.length, 2);

  const approveRes = await inject('POST', `/api/jobs/${jobId}/profile/approve`, { profileId: savedProfileId });
  assert.equal(approveRes.statusCode, 200);
  assert.equal(approveRes.json().data.profile.status, 'approved');

  const candRes = await inject('POST', '/api/candidates', {
    name: '历史画像候选人',
    email: 'legacy-portrait-cand@example.com',
    resume_text: '拥有 4 年相关岗位经验，擅长跨团队协作并持续复盘改进流程。',
  });
  assert.equal(candRes.statusCode, 201);
  const appRes = await inject('POST', '/api/applications', {
    jobId,
    candidateId: candRes.json().candidate.id,
  });
  assert.equal(appRes.statusCode, 201);
  const screened = await waitFor(`/api/applications/${appRes.json().application.id}/screening`, 'ready');
  assert.equal(screened.data.review.profileVersion, 2);
});

test('rich job metadata flows into AI portrait generation input and round-trips through profile API', async () => {
  let receivedJd = '';
  const generated = fallbackProfile('产品经理', '负责B端工作台规划与需求交付', ['原型设计', '数据分析'], {
    department: '产品部', location: '北京', level: 'L3',
  });
  const compact = {
    meta: generated.meta,
    positioning: generated.positioning,
    responsibilities: generated.responsibilities,
    hard_gates: [{ condition: '3年以上B端产品经验', how: '核对简历项目周期' }],
    trait_match: { code: generated.trait_match!.code, reason: generated.trait_match!.reason },
    redlines: ['核心业务指标造假'],
    not_wanted: ['缺乏数据分析与复盘习惯'],
    bonus: ['有HR SaaS产品从0到1经验'],
    weights: generated.indicators.map(({ weight }) => weight),
    background: generated.indicators[0]!.labels.map((l) => [l.name, l.weight, l.tiers.E, l.tiers.D, l.tiers.C, l.tiers.B, l.tiers.A]),
    attitude: generated.indicators[1]!.labels.map((l) => [l.name, l.weight, l.tiers.E, l.tiers.D, l.tiers.C, l.tiers.B, l.tiers.A]),
    technical: generated.indicators[2]!.labels.map((l) => [l.name, l.weight, l.tiers.E, l.tiers.D, l.tiers.C, l.tiers.B, l.tiers.A]),
    collaboration: generated.indicators[3]!.labels.map((l) => [l.name, l.weight, l.tiers.E, l.tiers.D, l.tiers.C, l.tiers.B, l.tiers.A]),
  };
  await inject('POST', '/api/settings/llm', { apiKey: ['unit', 'meta', 'z9x8'].join('-') });
  try {
    llmTransport.requestJson = async (_config, _instruction, input) => {
      receivedJd = JSON.parse(input).jd;
      return { value: compact, tokensIn: 120, tokensOut: 980 };
    };
    const created = await inject('POST', '/api/jobs', {
      title: '产品经理',
      department: '产品部',
      location: '北京',
      level: 'L3',
      salary_min: 22000,
      salary_max: 32000,
      description: '负责B端工作台规划与核心流程迭代',
      requirements: '3年以上B端产品经验，具备较强数据分析能力',
      skills: ['原型设计', '数据分析'],
    });
    assert.equal(created.statusCode, 201);
    const jobId = created.json().job.id;
    const ready = await waitFor(`/api/jobs/${jobId}/profile`, 'ready');
    assert.match(receivedJd, /所属部门：产品部/);
    assert.match(receivedJd, /职级\/能级：L3/);
    assert.match(receivedJd, /工作地点：北京/);
    assert.match(receivedJd, /薪资预算：22000 - 32000 元\/月/);
    assert.equal(ready.data.profile.content.meta.level, 'L3');
    assert.equal(ready.data.profile.content.trait_match.code, generated.trait_match!.code);
    assert.equal(ready.data.profile.content.hard_gates.length, 1);
    assert.ok(ready.data.profile.content.responsibilities.length >= 5);
  } finally {
    llmTransport.requestJson = originalTransport;
    run("DELETE FROM integrations WHERE provider = 'llm'");
  }
});
