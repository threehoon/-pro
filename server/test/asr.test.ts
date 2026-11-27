import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dataDir = mkdtempSync(path.join(tmpdir(), 'hireloop-asr-'));
process.env.HIRELOOP_DATA_DIR = dataDir;
process.env.HIRELOOP_DB_PATH = path.join(dataDir, 'test.db');
delete process.env.LLM_API_KEY;
process.env.NODE_ENV = 'test';

const { buildApp } = await import('../src/app.ts');
const { closeDb, run, getRow, all } = await import('../src/db/index.ts');
const { asrTransport, AsrFailure } = await import('../src/integrations/asr.ts');
const { now } = await import('../src/lib/util.ts');

let app: Awaited<ReturnType<typeof buildApp>>;
let adminCookie = '';
let recruiterCookie = '';
let interviewId = '';

const boundary = '----hireloop-asrtest';

function multipart(filename: string, content: Buffer): { payload: Buffer; headers: Record<string, string> } {
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: audio/mpeg\r\n\r\n`,
    'utf8',
  );
  return {
    payload: Buffer.concat([head, content, Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

function upload(url: string, cookie: string, filename = 'round-1.mp3', content = Buffer.from('fake-mp3-bytes')) {
  const { payload, headers } = multipart(filename, content);
  return app.inject({ method: 'POST', url, headers: { ...headers, cookie }, payload });
}

before(async () => {
  app = await buildApp();
  await app.ready();
  const registered = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { name: '语音测试管理员', email: 'asr-admin@hireloop.cn', password: 'password123' },
  });
  assert.equal(registered.statusCode, 200);
  adminCookie = String(registered.headers['set-cookie']).split(';')[0]!;

  const created = await app.inject({
    method: 'POST',
    url: '/api/team',
    headers: { cookie: adminCookie },
    payload: { name: '语音测试招聘官', email: 'asr-recruiter@hireloop.cn', password: 'password123', role: 'recruiter' },
  });
  assert.equal(created.statusCode, 201);
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: 'asr-recruiter@hireloop.cn', password: 'password123' },
  });
  assert.equal(login.statusCode, 200);
  recruiterCookie = String(login.headers['set-cookie']).split(';')[0]!;

  // 直接建最小岗位/候选人/投递/面试：这里测的是转写接口，不重复走业务流。
  const user = getRow<{ id: string }>('SELECT id FROM users WHERE email = ?', ['asr-admin@hireloop.cn'])!;
  const stamp = now();
  run(`INSERT INTO jobs (id, title, owner_id, created_at, updated_at) VALUES ('job_asr', '语音转写测试岗', ?, ?, ?)`,
    [user.id, stamp, stamp]);
  run(`INSERT INTO candidates (id, name, email, created_at, updated_at) VALUES ('cand_asr', '语音候选人', 'asr-cand@hireloop.cn', ?, ?)`,
    [stamp, stamp]);
  run(`INSERT INTO applications (id, job_id, candidate_id, stage, applied_at, updated_at)
    VALUES ('app_asr', 'job_asr', 'cand_asr', 'interview', ?, ?)`, [stamp, stamp]);
  run(`INSERT INTO interviews (id, application_id, scheduled_at, status, created_at, updated_at)
    VALUES ('itv_asr', 'app_asr', '2026-12-01T02:00:00.000Z', 'scheduled', ?, ?)`, [stamp, stamp]);
  interviewId = 'itv_asr';
});

after(async () => {
  await app.close();
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

test('语音转写默认未配置，只接受回环或公网地址且仅管理员可保存', async () => {
  const initial = await app.inject({ method: 'GET', url: '/api/settings/asr', headers: { cookie: adminCookie } });
  assert.equal(initial.statusCode, 200);
  assert.equal(initial.json().data.configured, false);
  assert.equal(initial.json().data.language, 'zh');

  const post = (payload: Record<string, unknown>, cookie = adminCookie) =>
    app.inject({ method: 'POST', url: '/api/settings/asr', headers: { cookie }, payload });
  // 内网明文、内网域名都不接受：这个配置由管理员填，别变成打内网的入口
  assert.equal((await post({ baseUrl: 'http://192.168.1.9:8000/v1', model: 'whisper-1' })).statusCode, 400);
  assert.equal((await post({ baseUrl: 'https://asr.corp.lan/v1', model: 'whisper-1' })).statusCode, 400);
  assert.equal((await post({ baseUrl: 'http://127.0.0.1:8000/v1', model: '中文模型' })).statusCode, 400);
  assert.equal((await post({ baseUrl: 'http://127.0.0.1:8000/v1', model: 'whisper-1' }, recruiterCookie)).statusCode, 403);

  // 本机自建不校验密钥，只填地址就算配置完成
  const saved = await post({ baseUrl: 'http://127.0.0.1:8000/v1', model: 'whisper-1', language: 'zh' });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal(saved.json().data.configured, true);
  assert.equal(saved.json().data.keyTail, null);

  const badLanguage = await post({ baseUrl: 'https://api.openai.com/v1', model: 'whisper-1', language: '中文' });
  assert.equal(badLanguage.statusCode, 400);
});

test('录音转写返回文字但不落库，失败按原因给出状态码', async () => {
  const long = '这'.repeat(12_500);
  const calls: Array<{ fileName: string }> = [];
  asrTransport.transcribe = async (_config, audio) => {
    calls.push({ fileName: audio.filename });
    return { text: long, model: 'whisper-1', durationSeconds: 95 };
  };

  const filesBefore = getRow<{ count: number }>('SELECT COUNT(*) AS count FROM files')!.count;
  const ok = await upload(`/api/interviews/${interviewId}/transcribe`, adminCookie);
  assert.equal(ok.statusCode, 200, ok.body);
  const data = ok.json().data;
  assert.equal(data.chars, 12_500);
  assert.equal(data.truncated, true);
  assert.equal(data.text.length, 12_000);
  assert.equal(data.durationSeconds, 95);
  assert.equal(calls[0]!.fileName, 'round-1.mp3');
  // 录音只是中转：既不进 files 表，也不进 interviews.transcript
  assert.equal(getRow<{ count: number }>('SELECT COUNT(*) AS count FROM files')!.count, filesBefore);
  assert.equal(getRow<{ transcript: string | null }>('SELECT transcript FROM interviews WHERE id = ?', [interviewId])!.transcript, null);
  const audit = all<{ action: string }>("SELECT action FROM audit_log WHERE action = 'interview.transcribe'");
  assert.equal(audit.length, 1);

  // 招聘官也能转写，权限只到招聘角色
  assert.equal((await upload(`/api/interviews/${interviewId}/transcribe`, recruiterCookie)).statusCode, 200);
  assert.equal((await upload(`/api/interviews/itv_nope/transcribe`, adminCookie)).statusCode, 404);
  assert.equal((await upload(`/api/interviews/${interviewId}/transcribe`, adminCookie, 'note.txt')).statusCode, 400);

  asrTransport.transcribe = async () => { throw new AsrFailure('empty_response', '没有识别出人声，请确认录音音量或换一段'); };
  const silent = await upload(`/api/interviews/${interviewId}/transcribe`, adminCookie);
  assert.equal(silent.statusCode, 400);
  assert.equal(silent.json().error.code, 'empty_response');

  asrTransport.transcribe = async () => { throw new AsrFailure('timeout', '语音转写超时'); };
  assert.equal((await upload(`/api/interviews/${interviewId}/transcribe`, adminCookie)).statusCode, 504);

  asrTransport.transcribe = async () => { throw new AsrFailure('provider_error', '语音转写服务返回 401：invalid api key'); };
  const rejected = await upload(`/api/interviews/${interviewId}/transcribe`, adminCookie);
  assert.equal(rejected.statusCode, 502);
  assert.match(rejected.json().error.message, /401/);
});
