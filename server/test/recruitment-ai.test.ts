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
const { fallbackProfile, normalizeProfile, scoreScreening, validateScreening } = await import('../src/services/recruitment-evidence.ts');
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
      assert.equal(JSON.parse(example).technical[0][4], '能独立处理常见故障');
      assert.equal(options?.maxTokens, 4200);
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
    const failedRun = getRow<{ error: string; tokens_in: number; tokens_out: number }>(
      'SELECT error, tokens_in, tokens_out FROM ai_runs WHERE subject_id = ?', [id],
    );
    assert.deepEqual({ ...failedRun }, { error: 'empty_response', tokens_in: 44, tokens_out: 10 });
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
