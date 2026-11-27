import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dataDir = mkdtempSync(path.join(tmpdir(), 'hireloop-bitable-test-'));
process.env.HIRELOOP_DATA_DIR = dataDir;
process.env.HIRELOOP_DB_PATH = path.join(dataDir, 'bitable-test.db');
delete process.env.LLM_API_KEY;
process.env.NODE_ENV = 'test';

const { buildApp } = await import('../src/app.ts');
const { closeDb, getRow } = await import('../src/db/index.ts');
const { clearTenantTokenCache, setFeishuFetchForTest } = await import('../src/integrations/feishu.ts');
const { handleBitableEventForTest } = await import('../src/integrations/bitable-events.ts');
const { flushBitableQueue } = await import('../src/services/bitable-sync.ts');

let app: Awaited<ReturnType<typeof buildApp>>;
let adminCookie = '';
let recruiterCookie = '';

interface FeishuCall {
  method: string;
  url: string;
  body: unknown;
}

const calls: FeishuCall[] = [];
const remoteRecords = new Map<string, Record<string, unknown>>();
let nextRecord = 1;

const INTERVIEW_COLUMNS = [
  '外部 ID', '候选人', '职位', '轮次', '面试官', '面试时间', '面试状态', '本轮总结', '亮点', '疑点',
  '未答问题', '结论', '评分（1-5）', '补充反馈', '本轮决定', '是否推荐进复试', '最后同步',
];
const APPLICATION_COLUMNS = [
  '外部 ID', '候选人', '职位', '负责人', '来源', '投递时间', '阶段', '是否淘汰', '淘汰原因',
  '综合结论', '下一步', '下次跟进', '备注', '最后同步',
];

/** 单选列在事件里回传的是选项 id，这里给每列造一组固定选项，用来验证 id→文案 的翻译。 */
const SELECT_OPTIONS: Record<string, Array<{ id: string; name: string }>> = {
  结论: [{ id: 'opt_rec_yes', name: '推荐' }, { id: 'opt_rec_no', name: '不推荐' }],
  是否推荐进复试: [{ id: 'opt_adv_yes', name: '推荐' }, { id: 'opt_adv_hold', name: '待定' }],
  本轮决定: [{ id: 'opt_dec_advance', name: '进下一轮' }],
  面试状态: [{ id: 'opt_status_scheduled', name: '待进行' }],
  阶段: [{ id: 'opt_stage_screening', name: '筛选中' }, { id: 'opt_stage_interview', name: '面试中' }],
  是否淘汰: [{ id: 'opt_rej_yes', name: '是' }, { id: 'opt_rej_no', name: '否' }],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

/** 假的飞书开放平台：只实现多维表格用到的几个接口，用来核对发出的报文。 */
function feishuStub(input: string | URL, init?: { method?: string; body?: string }): Promise<Response> {
  const url = String(input);
  const method = (init?.method ?? 'GET').toUpperCase();
  const body = init?.body ? JSON.parse(String(init.body)) : null;
  calls.push({ method, url, body });

  if (url.includes('/tenant_access_token/internal')) {
    return Promise.resolve(jsonResponse({ code: 0, msg: 'ok', tenant_access_token: 'tok', expire: 7200 }));
  }
  if (url.includes('/subscribe')) {
    return Promise.resolve(jsonResponse({ code: 0, msg: 'ok', data: {} }));
  }
  if (url.includes('/fields')) {
    const tableId = url.includes('/tblapplication') ? 'tblapplication' : 'tblinterview';
    const names = tableId === 'tblapplication' ? APPLICATION_COLUMNS : INTERVIEW_COLUMNS;
    return Promise.resolve(jsonResponse({
      code: 0,
      msg: 'ok',
      data: {
        items: names.map((name, index) => ({
          field_id: `fld${index}`,
          field_name: name,
          type: SELECT_OPTIONS[name] ? 3 : 1,
          property: SELECT_OPTIONS[name] ? { options: SELECT_OPTIONS[name] } : undefined,
        })),
      },
    }));
  }
  if (url.includes('/records/batch_create')) {
    const records = (body as { records: Array<{ fields: Record<string, unknown> }> }).records;
    const created = records.map((record) => {
      const recordId = `rec_${nextRecord++}`;
      remoteRecords.set(recordId, record.fields);
      return { record_id: recordId, fields: record.fields };
    });
    return Promise.resolve(jsonResponse({ code: 0, msg: 'ok', data: { records: created } }));
  }
  if (url.includes('/records/batch_update')) {
    const records = (body as { records: Array<{ record_id: string; fields: Record<string, unknown> }> }).records;
    for (const record of records) remoteRecords.set(record.record_id, record.fields);
    return Promise.resolve(jsonResponse({ code: 0, msg: 'ok', data: { records } }));
  }
  if (url.includes('/records/batch_delete')) {
    const ids = (body as { records: string[] }).records;
    for (const id of ids) remoteRecords.delete(id);
    return Promise.resolve(jsonResponse({ code: 0, msg: 'ok', data: { records: ids.map((id) => ({ record_id: id, deleted: true })) } }));
  }
  if (url.includes('/records')) {
    return Promise.resolve(jsonResponse({
      code: 0,
      msg: 'ok',
      data: {
        items: [...remoteRecords.entries()].map(([recordId, fields]) => ({ record_id: recordId, fields })),
        has_more: false,
      },
    }));
  }
  return Promise.resolve(jsonResponse({ code: 1254003, msg: 'unexpected' }, 404));
}

before(async () => {
  app = await buildApp();
  await app.ready();

  const register = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { name: '表格管理员', email: 'admin@bitable.test', password: 'password123' },
  });
  assert.equal(register.statusCode, 200);
  adminCookie = String(register.headers['set-cookie']).split(';')[0]!;

  const member = await app.inject({
    method: 'POST',
    url: '/api/team',
    headers: { cookie: adminCookie },
    payload: { name: '普通招聘官', email: 'recruiter@bitable.test', password: 'password123', role: 'recruiter' },
  });
  assert.equal(member.statusCode, 201);

  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: 'recruiter@bitable.test', password: 'password123' },
  });
  recruiterCookie = String(login.headers['set-cookie']).split(';')[0]!;

  // 飞书应用凭证：长连接与租户接口都靠它，这里只是占位字符串，请求被上面的假实现接管。
  const feishuSettings = await app.inject({
    method: 'PUT',
    url: '/api/settings/feishu',
    headers: { cookie: adminCookie },
    payload: { app_id: 'cli_bitable_test', app_secret: 'secret_bitable_test' },
  });
  assert.equal(feishuSettings.statusCode, 200);
  setFeishuFetchForTest(feishuStub as unknown as typeof fetch);
});

after(() => {
  setFeishuFetchForTest(null);
  clearTenantTokenCache();
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

afterEach(() => {
  calls.length = 0;
});

async function waitFor(check: () => boolean | Promise<boolean>, label: string, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`等待超时：${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function setupInterview(title: string, candidateName: string, candidateEmail: string) {
  const jobRes = await app.inject({
    method: 'POST', url: '/api/jobs', headers: { cookie: adminCookie },
    payload: { title, department: '研发' },
  });
  assert.equal(jobRes.statusCode, 201);
  const jobId = jobRes.json().job.id as string;

  const candRes = await app.inject({
    method: 'POST', url: '/api/candidates', headers: { cookie: adminCookie },
    payload: { name: candidateName, email: candidateEmail },
  });
  assert.equal(candRes.statusCode, 201);
  const candidateId = candRes.json().candidate.id as string;

  const applyRes = await app.inject({
    method: 'POST', url: `/api/candidates/${candidateId}/apply`, headers: { cookie: adminCookie },
    payload: { jobId },
  });
  assert.equal(applyRes.statusCode, 201);
  const applicationId = applyRes.json().application.id as string;

  const advance = await app.inject({
    method: 'POST', url: `/api/applications/${applicationId}/screening`, headers: { cookie: adminCookie },
    payload: { decision: 'advance' },
  });
  assert.equal(advance.statusCode, 200);

  const interviewRes = await app.inject({
    method: 'POST', url: '/api/interviews', headers: { cookie: adminCookie },
    payload: { applicationId, scheduledAt: '2026-12-10T02:00:00.000Z', mode: 'video', round: 1 },
  });
  assert.equal(interviewRes.statusCode, 201);
  return {
    applicationId,
    interviewId: interviewRes.json().interview.id as string,
  };
}

test('多维表格配置：只有管理员能改，表结构检查会列出缺失的列', async () => {
  const anonymous = await app.inject({ method: 'GET', url: '/api/settings/bitable' });
  assert.equal(anonymous.statusCode, 401);

  const forbidden = await app.inject({
    method: 'POST', url: '/api/settings/bitable', headers: { cookie: recruiterCookie },
    payload: { appToken: 'bascncmk123456', enabled: true },
  });
  assert.equal(forbidden.statusCode, 403);

  const badToken = await app.inject({
    method: 'POST', url: '/api/settings/bitable', headers: { cookie: adminCookie },
    payload: { appToken: '不是合法 token' },
  });
  assert.equal(badToken.statusCode, 400);

  const badInterval = await app.inject({
    method: 'POST', url: '/api/settings/bitable', headers: { cookie: adminCookie },
    payload: { fallbackMinutes: 9999 },
  });
  assert.equal(badInterval.statusCode, 400);

  const saved = await app.inject({
    method: 'POST', url: '/api/settings/bitable', headers: { cookie: adminCookie },
    payload: {
      appToken: 'bascncmk123456',
      interviewsTableId: 'tblinterview',
      applicationsTableId: 'tblapplication',
      enabled: true,
      fallbackMinutes: 10,
    },
  });
  assert.equal(saved.statusCode, 200);
  const data = saved.json().data;
  assert.equal(data.enabled, true);
  assert.equal(data.configured, true);
  assert.equal(data.fallbackMinutes, 10);
  assert.equal(data.columns.interviewWritable.includes('是否推荐进复试'), true);

  const checked = await app.inject({
    method: 'POST', url: '/api/settings/bitable/test', headers: { cookie: adminCookie }, payload: {},
  });
  assert.equal(checked.statusCode, 200);
  const result = checked.json().data;
  assert.equal(result.ok, true);
  assert.deepEqual(result.checks.map((item: { name: string }) => item.name), ['面试表结构', '投递表结构', '事件订阅']);
  assert.ok(result.checks.every((item: { ok: boolean }) => item.ok));
});

test('多维表格出站：面试建好后自动推进表格，改期后用 batch_update 覆盖同一行', async () => {
  const { interviewId } = await setupInterview('表格同步岗', '表格候选人', 'bitable-out@example.test');

  const link = getRow<{ record_id: string; table_id: string }>(
    'SELECT record_id, table_id FROM bitable_records WHERE entity_type = ? AND entity_id = ?',
    ['interview', interviewId],
  );
  await waitFor(() => Boolean(link) || false, '等待面试推送');

  const created = calls
    .filter((call) => call.url.includes('/records/batch_create') && call.url.includes('/tblinterview/'))
    .at(-1);
  assert.ok(created, '应该调用 batch_create 建行');
  const fields = (created.body as { records: Array<{ fields: Record<string, unknown> }> }).records[0]!.fields;
  assert.equal(fields['外部 ID'], interviewId);
  assert.equal(fields['候选人'], '表格候选人');
  assert.equal(fields['职位'], '表格同步岗');
  assert.equal(fields['轮次'], '第 1 轮');
  assert.equal(fields['面试状态'], '待进行');

  const row = getRow<{ record_id: string }>(
    'SELECT record_id FROM bitable_records WHERE entity_type = ? AND entity_id = ?',
    ['interview', interviewId],
  );
  assert.ok(row?.record_id);

  calls.length = 0;
  const patched = await app.inject({
    method: 'PATCH', url: `/api/interviews/${interviewId}`, headers: { cookie: adminCookie },
    payload: { scheduledAt: '2026-12-11T02:00:00.000Z' },
  });
  assert.equal(patched.statusCode, 200);
  await waitFor(() => calls.some((call) => call.url.includes('/records/batch_update')), '等待改期推送');
  const updated = calls.filter((call) => call.url.includes('/records/batch_update')).at(-1);
  const updatedRecords = (updated!.body as { records: Array<{ record_id: string; fields: Record<string, unknown> }> }).records;
  assert.equal(updatedRecords[0]!.record_id, row!.record_id, '改期应该更新同一行而不是新建');
});

test('多维表格入站：表格里的结论、评分、进复试会回写，自己的改动会被忽略，回退阶段记为冲突', async () => {
  const { interviewId, applicationId } = await setupInterview('回写岗', '回写候选人', 'bitable-in@example.test');
  await waitFor(() => Boolean(getRow('SELECT record_id FROM bitable_records WHERE entity_id = ?', [interviewId])), '等待面试建行');
  await waitFor(() => Boolean(getRow('SELECT record_id FROM bitable_records WHERE entity_id = ?', [applicationId])), '等待投递建行');

  const interviewRow = getRow<{ record_id: string }>(
    'SELECT record_id FROM bitable_records WHERE entity_type = ? AND entity_id = ?',
    ['interview', interviewId],
  )!;
  const applicationRow = getRow<{ record_id: string }>(
    'SELECT record_id FROM bitable_records WHERE entity_type = ? AND entity_id = ?',
    ['application', applicationId],
  )!;

  const applied = await handleBitableEventForTest({
    header: { event_id: 'evt_writeback_1', event_type: 'drive.file.bitable_record_changed_v1' },
    event: {
      file_type: 'bitable',
      table_id: 'tblinterview',
      operator_id: { open_id: 'ou_unknown' },
      action_list: [{
        record_id: interviewRow.record_id,
        action: 'edit',
        after_value: [
          // 飞书真实回调给的是选项 id，不是文案；文本列给的是被序列化的富文本片段。
          { field_key: '结论', field_value: 'opt_rec_yes' },
          { field_key: '评分（1-5）', field_value: 5 },
          { field_key: '是否推荐进复试', field_value: 'opt_adv_yes' },
          { field_key: '补充反馈', field_value: '[{"text":"表格里写的补充反馈","type":"text"}]' },
        ],
      }],
    },
  });
  assert.equal(applied?.applied, 1);

  const written = getRow<{ recommendation: string; score: number; advance_recommended: string; feedback: string }>(
    'SELECT recommendation, score, advance_recommended, feedback FROM interviews WHERE id = ?',
    [interviewId],
  );
  assert.equal(written?.recommendation, 'yes');
  assert.equal(written?.score, 5);
  assert.equal(written?.advance_recommended, 'yes');
  // 富文本片段要被拍平成纯文本，不能把 [{"text":…}] 这串 JSON 写进库里。
  assert.equal(written?.feedback, '表格里写的补充反馈');
  assert.equal(
    getRow<{ n: number }>("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'bitable.writeback'")?.n,
    4,
  );

  // 空单元格不能当成「清空」：新增行的事件会把所有列带上来，值为空。
  const blank = await handleBitableEventForTest({
    header: { event_id: 'evt_writeback_blank' },
    event: {
      table_id: 'tblinterview',
      action_list: [{ record_id: interviewRow.record_id, action: 'edit', after_value: [{ field_key: '补充反馈', field_value: '' }] }],
    },
  });
  assert.equal(blank?.applied, 0);
  assert.equal(
    getRow<{ feedback: string }>('SELECT feedback FROM interviews WHERE id = ?', [interviewId])?.feedback,
    '表格里写的补充反馈',
  );

  // 同样的值再来一次：系统刚推回去，应该识别成自己的回声而不是再写一遍。
  const before = getRow<{ n: number }>("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'bitable.writeback'")?.n;
  const echo = await handleBitableEventForTest({
    header: { event_id: 'evt_writeback_2' },
    event: {
      table_id: 'tblinterview',
      action_list: [{ record_id: interviewRow.record_id, action: 'edit', after_value: [{ field_key: '评分（1-5）', field_value: 5 }] }],
    },
  });
  assert.equal(echo?.applied, 0);
  assert.equal(
    getRow<{ n: number }>("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'bitable.writeback'")?.n,
    before,
  );

  // 阶段只能往前走：把「面试中」改回「筛选中」要被记成冲突，不能悄悄退回去。
  const conflict = await handleBitableEventForTest({
    header: { event_id: 'evt_writeback_3' },
    event: {
      table_id: 'tblapplication',
      action_list: [{
        record_id: applicationRow.record_id,
        action: 'edit',
        after_value: [{ field_key: '阶段', field_value: '筛选中' }],
      }],
    },
  });
  assert.equal(conflict?.conflicts, 1);
  const application = getRow<{ stage: string }>('SELECT stage FROM applications WHERE id = ?', [applicationId]);
  assert.equal(application?.stage, 'interview');

  // 备注与下一步是纯数据列，直接写回。
  const note = await handleBitableEventForTest({
    header: { event_id: 'evt_writeback_4' },
    event: {
      table_id: 'tblapplication',
      action_list: [{
        record_id: applicationRow.record_id,
        action: 'edit',
        after_value: [
          { field_key: '下一步', field_value: '等候选人确认复试时间' },
          { field_key: '备注', field_value: '表格里补的备注' },
        ],
      }],
    },
  });
  assert.equal(note?.applied, 1);
  assert.equal(
    getRow<{ next_step: string }>('SELECT next_step FROM applications WHERE id = ?', [applicationId])?.next_step,
    '等候选人确认复试时间',
  );
  assert.equal(
    getRow<{ n: number }>("SELECT COUNT(*) AS n FROM application_events WHERE application_id = ? AND type = 'note'", [applicationId])?.n,
    1,
  );
  await flushBitableQueue(1);
});

test('富文本单元格按纯文本解析，嵌套的序列化片段不会一层层套下去', async () => {
  const { readCellText } = await import('../src/services/bitable-mapping.ts');
  assert.equal(readCellText('[{"text":"一句话反馈","type":"text"}]'), '一句话反馈');
  // 真实发生时是「片段里又装了一段被序列化的片段」，要一路剥到纯文本。
  const nested = JSON.stringify([{ text: JSON.stringify([{ text: '再套一层', type: 'text' }]), type: 'text' }]);
  assert.equal(readCellText(nested), '再套一层');
  assert.equal(readCellText([{ text: '第一段', type: 'text' }, { text: '第二段', type: 'text' }]), '第一段第二段');
  assert.equal(readCellText(''), '');
  assert.equal(readCellText('普通文本'), '普通文本');
});

test('演示数据：一键灌入可清空，清理时同时删掉表格里的行', async () => {
  const seeded = await app.inject({ method: 'POST', url: '/api/settings/bitable/seed-demo', headers: { cookie: adminCookie } });
  assert.equal(seeded.statusCode, 200);
  const result = seeded.json().data as { applications: number; interviews: number; pushed: number; failed: number };
  assert.equal(result.applications, 12);
  assert.equal(result.interviews, 6);
  assert.equal(result.pushed, 18);
  assert.equal(result.failed, 0);

  const counts = getRow<{ applications: number; interviews: number; linked: number }>(
    `SELECT (SELECT COUNT(*) FROM applications WHERE id LIKE 'seed_app_%') AS applications,
            (SELECT COUNT(*) FROM interviews WHERE id LIKE 'seed_itv_%') AS interviews,
            (SELECT COUNT(*) FROM bitable_records WHERE entity_id LIKE 'seed_%' AND record_id IS NOT NULL) AS linked`,
  );
  assert.equal(counts?.applications, 12);
  assert.equal(counts?.interviews, 6);
  assert.equal(counts?.linked, 18);
  // 演示面试要能直接看到总结与回写列，否则表格里是空壳。
  const sample = getRow<{ headline: string; advance_recommended: string; decision: string }>(
    `SELECT json_extract(summary_json, '$.headline') AS headline, advance_recommended, decision
     FROM interviews WHERE id = 'seed_itv_01'`,
  );
  assert.match(sample?.headline ?? '', /二面/);
  assert.equal(sample?.advance_recommended, 'yes');
  assert.equal(sample?.decision, 'advance');

  const cleared = await app.inject({ method: 'POST', url: '/api/settings/bitable/clear-demo', headers: { cookie: adminCookie } });
  assert.equal(cleared.statusCode, 200);
  const clearedResult = cleared.json().data as { deleted: number; remoteDeleted: number; failed: number };
  assert.ok(clearedResult.deleted >= 19);
  assert.equal(clearedResult.remoteDeleted, 18);
  assert.equal(clearedResult.failed, 0);

  const after = getRow<{ applications: number; interviews: number; linked: number }>(
    `SELECT (SELECT COUNT(*) FROM applications WHERE id LIKE 'seed_app_%') AS applications,
            (SELECT COUNT(*) FROM interviews WHERE id LIKE 'seed_itv_%') AS interviews,
            (SELECT COUNT(*) FROM bitable_records WHERE entity_id LIKE 'seed_%') AS linked`,
  );
  assert.equal(after?.applications, 0);
  assert.equal(after?.interviews, 0);
  assert.equal(after?.linked, 0);
  assert.ok(calls.some((call) => call.url.includes('/records/batch_delete')));
});
