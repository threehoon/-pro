import { afterCommit, all, getRow, run } from '../db/index.ts';
import {
  bitableStatus,
  cacheFields,
  createBitableRecords,
  listBitableFields,
  listBitableRecords,
  markReconciled,
  storedBitableConfig,
  subscribeBitableFile,
  updateBitableRecords,
} from '../integrations/bitable.ts';
import { badRequest } from '../lib/errors.ts';
import { id, now } from '../lib/util.ts';
import { audit } from './audit.ts';
import { addNote, getApplication, recordStage } from './applications.ts';
import {
  ADVANCE_LABELS,
  APPLICATION_COLUMNS,
  APPLICATION_WRITABLE,
  DECISION_LABELS,
  INTERVIEW_COLUMNS,
  INTERVIEW_WRITABLE,
  STAGE_ORDER,
  buildApplicationRecord,
  buildInterviewRecord,
  matchLabel,
  matchStage,
  readCellDate,
  readCellNumber,
  readCellText,
  type BuiltRecord,
  type EntityType,
} from './bitable-mapping.ts';
import { decideInterview } from './interviews.ts';
import { RECOMMENDATION_LABELS, STAGE_LABELS, type Stage } from '../constants.ts';

const MAX_ATTEMPTS = 5;
const RETRY_DELAY_MS = 60_000;

export function tableFor(entityType: EntityType): string | null {
  const config = storedBitableConfig();
  return entityType === 'interview' ? config.interviewsTableId : config.applicationsTableId;
}

export function entityTypeForTable(tableId: string): EntityType | null {
  const config = storedBitableConfig();
  if (config.interviewsTableId && config.interviewsTableId === tableId) return 'interview';
  if (config.applicationsTableId && config.applicationsTableId === tableId) return 'application';
  return null;
}

/**
 * 同一个库可能同时被两个进程服务（例如本机开发 + 局域网实例）。
 * 长连接只能有一个持有者，否则同一事件会被处理两遍；用 `HIRELOOP_BITABLE=off` 让副实例只读不参与。
 */
export function bitableSyncDisabled(): boolean {
  return process.env.HIRELOOP_BITABLE === 'off';
}

export function bitableSyncOpen(): boolean {
  if (bitableSyncDisabled()) return false;
  const config = storedBitableConfig();
  return Boolean(config.enabled && config.appToken);
}

/* ------------------------------ 出站队列 ------------------------------ */

export function queueEntity(entityType: EntityType, entityId: string): void {
  if (!bitableSyncOpen() || !tableFor(entityType)) return;
  const timestamp = now();
  run(`DELETE FROM bitable_sync_queue WHERE entity_type = ? AND entity_id = ? AND state = 'pending'`, [entityType, entityId]);
  run(
    `INSERT INTO bitable_sync_queue (id, entity_type, entity_id, op, state, attempts, created_at, updated_at)
     VALUES (?, ?, ?, 'upsert', 'pending', 0, ?, ?)`,
    [id('bsq'), entityType, entityId, timestamp, timestamp],
  );
  afterCommit(() => {
    void flushBitableQueue().catch(() => undefined);
  });
}

/** 面试/投递改动后调用，把这一行排进推送队列。 */
export function hookBitableSync(entityType: EntityType, entityId: string): void {
  queueEntity(entityType, entityId);
}

let flushing = false;

export async function flushBitableQueue(limit = 20): Promise<{ pushed: number; failed: number }> {
  if (flushing || !bitableSyncOpen()) return { pushed: 0, failed: 0 };
  flushing = true;
  let pushed = 0;
  let failed = 0;
  try {
    const rows = all<{ id: string; entity_type: EntityType; entity_id: string; attempts: number }>(
      `SELECT id, entity_type, entity_id, attempts FROM bitable_sync_queue
       WHERE state = 'pending' AND attempts < ?
         AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
       ORDER BY created_at ASC LIMIT ?`,
      [MAX_ATTEMPTS, now(), limit],
    );
    for (const row of rows) {
      const record = row.entity_type === 'interview' ? buildInterviewRecord(row.entity_id) : buildApplicationRecord(row.entity_id);
      if (!record) {
        run(`UPDATE bitable_sync_queue SET state = 'skipped', error = ?, updated_at = ? WHERE id = ?`, ['记录已不存在', now(), row.id]);
        continue;
      }
      const result = await pushRecord(record);
      if (result.ok) {
        pushed += 1;
        run(`UPDATE bitable_sync_queue SET state = 'done', error = NULL, updated_at = ? WHERE id = ?`, [now(), row.id]);
      } else {
        failed += 1;
        const attempts = row.attempts + 1;
        const state = attempts >= MAX_ATTEMPTS ? 'failed' : 'pending';
        run(`UPDATE bitable_sync_queue SET attempts = ?, state = ?, error = ?, next_attempt_at = ?, updated_at = ? WHERE id = ?`, [
          attempts,
          state,
          result.error,
          new Date(Date.now() + RETRY_DELAY_MS * attempts).toISOString(),
          now(),
          row.id,
        ]);
      }
    }
  } finally {
    flushing = false;
  }
  return { pushed, failed };
}

interface PushResult {
  ok: boolean;
  error: string | null;
}

async function pushRecord(record: BuiltRecord): Promise<PushResult> {
  const config = storedBitableConfig();
  const tableId = tableFor(record.entityType);
  if (!config.appToken || !tableId) return { ok: false, error: '还没有配置多维表格' };

  const existing = getRow<{ record_id: string; pushed_hash: string | null }>(
    `SELECT record_id, pushed_hash FROM bitable_records WHERE entity_type = ? AND entity_id = ?`,
    [record.entityType, record.entityId],
  );
  if (existing && existing.pushed_hash === record.fingerprint) return { ok: true, error: null };

  if (existing?.record_id) {
    const updated = await updateBitableRecords(config.appToken, tableId, [{ record_id: existing.record_id, fields: record.fields }]);
    if (!updated.ok) {
      if (updated.code === 1254043) {
        run(`DELETE FROM bitable_records WHERE entity_type = ? AND entity_id = ?`, [record.entityType, record.entityId]);
        return pushRecord(record);
      }
      markRecordError(record, updated.msg);
      return { ok: false, error: updated.msg };
    }
    savePushed(record, tableId, existing.record_id);
    return { ok: true, error: null };
  }

  const created = await createBitableRecords(config.appToken, tableId, [{ fields: record.fields }]);
  if (!created.ok) {
    markRecordError(record, created.msg);
    return { ok: false, error: created.msg };
  }
  const recordId = created.data?.[0]?.recordId;
  if (!recordId) {
    markRecordError(record, '飞书没有返回 record_id');
    return { ok: false, error: '飞书没有返回 record_id' };
  }
  savePushed(record, tableId, recordId);
  return { ok: true, error: null };
}

function savePushed(record: BuiltRecord, tableId: string, recordId: string): void {
  const timestamp = now();
  run(
    `INSERT INTO bitable_records (entity_type, entity_id, table_id, record_id, pushed_hash, pushed_at, state)
     VALUES (?, ?, ?, ?, ?, ?, 'synced')
     ON CONFLICT(entity_type, entity_id) DO UPDATE SET
       table_id = excluded.table_id,
       record_id = excluded.record_id,
       pushed_hash = excluded.pushed_hash,
       pushed_at = excluded.pushed_at,
       state = 'synced',
       last_error = NULL`,
    [record.entityType, record.entityId, tableId, recordId, record.fingerprint, timestamp],
  );
}

function markRecordError(record: BuiltRecord, message: string): void {
  run(
    `INSERT INTO bitable_records (entity_type, entity_id, table_id, record_id, state, last_error)
     VALUES (?, ?, '', '', 'error', ?)
     ON CONFLICT(entity_type, entity_id) DO UPDATE SET state = 'error', last_error = excluded.last_error`,
    [record.entityType, record.entityId, message],
  );
}

/* ------------------------------ 入站：事件与回写 ------------------------------ */

export interface NormalizedAction {
  recordId: string;
  action: 'add' | 'edit' | 'delete';
  fields: Record<string, unknown>;
  operatorOpenId: string | null;
}

export interface NormalizedEvent {
  eventId: string;
  tableId: string;
  actions: NormalizedAction[];
  operatorOpenId: string | null;
}

/** 把飞书的原始事件体拍平成「表 + 行 + 字段名 → 值」，兼容 v1/v2 两种字段结构。 */
export function normalizeBitableEvent(raw: unknown, fieldNames: Record<string, string>): NormalizedEvent | null {
  const body = asRecord(raw);
  const header = asRecord(body.header);
  const inner = asRecord(body.event);
  const event = Object.keys(inner).length ? inner : body;
  const tableId = readCellText(event.table_id) || readCellText(body.table_id);
  if (!tableId) return null;
  // v2 事件把 event_id 放在 header 里，v1 直接放顶层，两种都要认。
  const eventId =
    readCellText(body.event_id) ||
    readCellText(header.event_id) ||
    readCellText(event.event_id) ||
    readCellText(event.token) ||
    id('bevt');
  const operatorOpenId = readOperator(body, event);
  const rawActions = Array.isArray(event.action_list) ? event.action_list : [];

  const actions: NormalizedAction[] = rawActions
    .map((item) => {
      const entry = asRecord(item);
      const recordId = readCellText(entry.record_id);
      if (!recordId) return null;
      const actionText = readCellText(entry.action).toLowerCase();
      const action = actionText === 'delete' || actionText === 'remove' ? 'delete' : actionText === 'add' || actionText === 'create' ? 'add' : 'edit';
      const fields: Record<string, unknown> = {};
      const after = entry.after_value;
      if (Array.isArray(after)) {
        for (const item2 of after) {
          const cell = asRecord(item2);
          const name = readCellText(cell.field_key) || fieldNames[readCellText(cell.field_id)] || '';
          if (name) fields[name] = cell.field_value;
        }
      } else if (after && typeof after === 'object') {
        for (const [key, value] of Object.entries(asRecord(after))) {
          fields[fieldNames[key] ?? key] = value;
        }
      }
      return { recordId, action, fields, operatorOpenId } as NormalizedAction;
    })
    .filter((item): item is NormalizedAction => Boolean(item));

  if (!actions.length) {
    const recordId = readCellText(event.record_id);
    if (!recordId) return null;
    const fields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(asRecord(event.after_value))) fields[fieldNames[key] ?? key] = value;
    actions.push({ recordId, action: 'edit', fields, operatorOpenId });
  }

  return { eventId, tableId, actions, operatorOpenId };
}

export function recordBitableEvent(event: NormalizedEvent, payload: unknown): boolean {
  const existing = getRow<{ event_id: string }>('SELECT event_id FROM bitable_events WHERE event_id = ?', [event.eventId]);
  if (existing) return false;
  const first = event.actions[0];
  run(
    `INSERT INTO bitable_events (event_id, table_id, record_id, action, operator_open_id, payload_json, state, received_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
    [event.eventId, event.tableId, first?.recordId ?? null, first?.action ?? null, event.operatorOpenId, JSON.stringify(payload), now()],
  );
  return true;
}

export interface ApplyOutcome {
  state: 'applied' | 'ignored' | 'conflict' | 'error';
  note: string;
}

export async function applyBitableEvent(event: NormalizedEvent): Promise<{ applied: number; ignored: number; conflicts: number }> {
  let applied = 0;
  let ignored = 0;
  let conflicts = 0;
  for (const action of event.actions) {
    const outcome = await applyAction(event.tableId, action);
    if (outcome === 'applied') applied += 1;
    else if (outcome === 'conflict') conflicts += 1;
    else ignored += 1;
  }
  markEventApplied(event.eventId, applied + conflicts > 0 ? 'applied' : 'ignored', `写入 ${applied} 条，冲突 ${conflicts} 条`);
  return { applied, ignored, conflicts };
}

/**
 * 单选列的事件回传的是选项 id（optXXXX），这里按缓存的选项表翻成文案；
 * 文本列拍平成纯文本。返回空串表示这一格没有值。
 */
const OPTION_ID = /^opt[A-Za-z0-9]{4,}$/;

let lastOptionSync = 0;

/**
 * 单选列的事件只带 option id。缓存缺失时（例如刚配好表、还没点过「检查表结构」）
 * 现场拉一次字段列表补上，一分钟内最多补一次，避免每来一条事件都打飞书。
 */
async function ensureOptionCache(tableId: string): Promise<Record<string, Record<string, string>>> {
  const config = storedBitableConfig();
  if (!config.appToken) return config.options;
  if (Object.keys(config.options).length) return config.options;
  if (Date.now() - lastOptionSync < 60_000) return config.options;
  lastOptionSync = Date.now();
  const listed = await listBitableFields(config.appToken, tableId);
  if (!listed.ok || !listed.data) return {};
  const names: Record<string, string> = {};
  const options: Record<string, Record<string, string>> = {};
  for (const field of listed.data) {
    names[field.fieldId] = field.fieldName;
    if (Object.keys(field.options).length) options[field.fieldName] = field.options;
  }
  cacheFields(names, options);
  return options;
}

function normalizeIncomingCell(config: { options: Record<string, Record<string, string>> }, column: string, value: unknown): string {
  const text = readCellText(value);
  if (!text) return '';
  const optionName = config.options[column]?.[text];
  return optionName ?? text;
}

async function applyAction(tableId: string, action: NormalizedAction): Promise<'applied' | 'ignored' | 'conflict'> {
  const entityType = entityTypeForTable(tableId);
  if (!entityType) return 'ignored';
  const link = getRow<{ entity_type: EntityType; entity_id: string }>(
    'SELECT entity_type, entity_id FROM bitable_records WHERE table_id = ? AND record_id = ?',
    [tableId, action.recordId],
  );
  if (!link) return 'ignored';
  if (action.action !== 'edit') return 'ignored';

  const record = link.entity_type === 'interview' ? buildInterviewRecord(link.entity_id) : buildApplicationRecord(link.entity_id);
  if (!record) return 'ignored';
  const config = storedBitableConfig();

  // 飞书会把我们自己推上去的改动也回推成事件：逐列比当前值，没变化的列直接跳过，
  // 既防住了自回声，也让重复事件变成无副作用。
  // 只在真的遇到选项 id 时才去补缓存，普通文本事件不额外发请求。
  const needsOptions = writableColumns(link.entity_type).some(
    (column) => column in action.fields && OPTION_ID.test(readCellText(action.fields[column])),
  );
  const options = needsOptions ? await ensureOptionCache(tableId) : config.options;

  const incoming = new Map<string, string>();
  for (const column of writableColumns(link.entity_type)) {
    if (!(column in action.fields)) continue;
    const text = normalizeIncomingCell({ options }, column, action.fields[column]);
    // 空单元格视为「没改动」：新增行的事件会把所有列都带上（值为空），
    // 若把它当清空处理，会把系统里的值抹掉；自回声也会在这里被挡下。
    if (!text) continue;
    incoming.set(column, text);
  }
  const dirty = [...incoming.keys()].filter((column) => !sameCell(incoming.get(column), record.fields[column]));
  if (!dirty.length) return 'ignored';

  const operatorId = resolveOperatorId(action.operatorOpenId, link.entity_type, link.entity_id);
  let changed = false;
  let conflicted = false;
  for (const column of dirty) {
    // 单个列写库失败（约束、并发）只记冲突，不能让整条事件抛出去打断长连接。
    let outcome: 'applied' | 'noop' | 'conflict' = 'conflict';
    try {
      outcome = applyColumn(link.entity_type, link.entity_id, column, incoming.get(column), operatorId);
    } catch {
      outcome = 'conflict';
    }
    if (outcome === 'applied') changed = true;
    if (outcome === 'conflict') conflicted = true;
  }
  if (changed || conflicted) {
    queueEntity(link.entity_type, link.entity_id);
    run(`UPDATE bitable_records SET pulled_hash = ?, pulled_at = ? WHERE entity_type = ? AND entity_id = ?`, [
      record.fingerprint,
      now(),
      link.entity_type,
      link.entity_id,
    ]);
  }
  if (conflicted) return 'conflict';
  return changed ? 'applied' : 'ignored';
}

/** 单元格比较统一按文本比，兼容数字、富文本数组和字符串三种写法。 */
function sameCell(incoming: unknown, current: unknown): boolean {
  return readCellText(incoming) === readCellText(current);
}

function writableColumns(entityType: EntityType): readonly string[] {
  return entityType === 'interview' ? INTERVIEW_WRITABLE : APPLICATION_WRITABLE;
}

function applyColumn(entityType: EntityType, entityId: string, column: string, value: unknown, actorId: string | null): 'applied' | 'noop' | 'conflict' {
  if (entityType === 'interview') return applyInterviewColumn(entityId, column, value, actorId);
  return applyApplicationColumn(entityId, column, value, actorId);
}

function applyInterviewColumn(interviewId: string, column: string, value: unknown, actorId: string | null): 'applied' | 'noop' | 'conflict' {
  const row = getRow<{ recommendation: string | null; score: number | null; feedback: string | null; advance_recommended: string | null }>(
    'SELECT recommendation, score, feedback, advance_recommended FROM interviews WHERE id = ?',
    [interviewId],
  );
  if (!row) return 'noop';
  const timestamp = now();

  if (column === INTERVIEW_COLUMNS.recommendation) {
    const key = matchLabel(RECOMMENDATION_LABELS, readCellText(value));
    if (!key) return 'conflict';
    if (key === row.recommendation) return 'noop';
    run('UPDATE interviews SET recommendation = ?, updated_at = ? WHERE id = ?', [key, timestamp, interviewId]);
    audit({ actorId, action: 'bitable.writeback', entityType: 'interview', entityId: interviewId, detail: { field: 'recommendation', value: key } });
    return 'applied';
  }

  if (column === INTERVIEW_COLUMNS.score) {
    // interviews.score 的 CHECK 是 1–5（星星评分），超出范围直接算冲突，不能塞进库里。
    const score = readCellNumber(value);
    if (score === null || !Number.isInteger(score) || score < 1 || score > 5) return 'conflict';
    if (score === row.score) return 'noop';
    run('UPDATE interviews SET score = ?, updated_at = ? WHERE id = ?', [score, timestamp, interviewId]);
    audit({ actorId, action: 'bitable.writeback', entityType: 'interview', entityId: interviewId, detail: { field: 'score', value: score } });
    return 'applied';
  }

  if (column === INTERVIEW_COLUMNS.feedback) {
    const text = readCellText(value);
    if (text === (row.feedback ?? '')) return 'noop';
    run('UPDATE interviews SET feedback = ?, updated_at = ? WHERE id = ?', [text || null, timestamp, interviewId]);
    audit({ actorId, action: 'bitable.writeback', entityType: 'interview', entityId: interviewId, detail: { field: 'feedback', length: text.length } });
    return 'applied';
  }

  if (column === INTERVIEW_COLUMNS.advance) {
    const key = matchLabel(ADVANCE_LABELS, readCellText(value));
    if (!key) return 'conflict';
    if (key === row.advance_recommended) return 'noop';
    run('UPDATE interviews SET advance_recommended = ?, updated_at = ? WHERE id = ?', [key, timestamp, interviewId]);
    audit({ actorId, action: 'bitable.writeback', entityType: 'interview', entityId: interviewId, detail: { field: 'advance', value: key } });
    return 'applied';
  }

  if (column === INTERVIEW_COLUMNS.decision) {
    const decision = matchLabel(DECISION_LABELS, readCellText(value));
    if (!decision) return 'conflict';
    if (!actorId) return 'conflict';
    try {
      decideInterview({
        interviewId,
        actorId,
        decision: decision as 'advance' | 'negotiate' | 'reject',
        reason: '来自多维表格',
      });
      return 'applied';
    } catch {
      return 'conflict';
    }
  }

  return 'noop';
}

function applyApplicationColumn(applicationId: string, column: string, value: unknown, actorId: string | null): 'applied' | 'noop' | 'conflict' {
  const application = getApplication(applicationId);
  if (!application) return 'noop';
  const timestamp = now();

  if (column === APPLICATION_COLUMNS.stage) {
    const target = matchStage(readCellText(value));
    if (!target || !actorId) return 'conflict';
    if (target === application.stage) return 'noop';
    if ((STAGE_ORDER[target] ?? 0) < (STAGE_ORDER[application.stage] ?? 0)) return 'conflict';
    recordStage(application, target as Stage, actorId, '来自多维表格');
    audit({ actorId, action: 'bitable.writeback', entityType: 'application', entityId: applicationId, detail: { field: 'stage', value: target } });
    return 'applied';
  }

  if (column === APPLICATION_COLUMNS.nextStep) {
    const text = readCellText(value);
    const current = getRow<{ next_step: string | null }>('SELECT next_step FROM applications WHERE id = ?', [applicationId]);
    if (text === (current?.next_step ?? '')) return 'noop';
    run('UPDATE applications SET next_step = ?, updated_at = ? WHERE id = ?', [text || null, timestamp, applicationId]);
    audit({ actorId, action: 'bitable.writeback', entityType: 'application', entityId: applicationId, detail: { field: 'next_step' } });
    return 'applied';
  }

  if (column === APPLICATION_COLUMNS.nextFollowUp) {
    const date = readCellDate(value);
    if (!date) return 'noop';
    const current = getRow<{ next_follow_up_at: string | null }>('SELECT next_follow_up_at FROM applications WHERE id = ?', [applicationId]);
    if (date === current?.next_follow_up_at) return 'noop';
    run('UPDATE applications SET next_follow_up_at = ?, updated_at = ? WHERE id = ?', [date, timestamp, applicationId]);
    audit({ actorId, action: 'bitable.writeback', entityType: 'application', entityId: applicationId, detail: { field: 'next_follow_up_at', value: date } });
    return 'applied';
  }

  if (column === APPLICATION_COLUMNS.note) {
    const text = readCellText(value);
    if (!text) return 'noop';
    if (!actorId) return 'conflict';
    addNote({ applicationId, note: text, actorId });
    return 'applied';
  }

  return 'noop';
}

function resolveOperatorId(openId: string | null, entityType: EntityType, entityId: string): string | null {
  if (openId) {
    const user = getRow<{ id: string }>('SELECT id FROM users WHERE feishu_open_id = ?', [openId]);
    if (user) return user.id;
  }
  if (entityType === 'application') {
    const owner = getRow<{ owner_id: string | null }>('SELECT owner_id FROM applications WHERE id = ?', [entityId]);
    if (owner?.owner_id) return owner.owner_id;
  } else {
    const interviewer = getRow<{ interviewer_id: string | null }>('SELECT interviewer_id FROM interviews WHERE id = ?', [entityId]);
    if (interviewer?.interviewer_id) return interviewer.interviewer_id;
  }
  const admin = getRow<{ id: string }>("SELECT id FROM users WHERE role = 'admin' ORDER BY created_at ASC LIMIT 1");
  return admin?.id ?? null;
}

function markEventApplied(eventId: string, state: string, note: string): void {
  run(`UPDATE bitable_events SET state = ?, note = ?, applied_at = ? WHERE event_id = ?`, [state, note, now(), eventId]);
}

/* ------------------------------ 兜底对账 ------------------------------ */

export interface ReconcileResult {
  checked: number;
  applied: number;
  conflicts: number;
  pushed: number;
  errors: string[];
}

export async function reconcileBitable(): Promise<ReconcileResult> {
  const config = storedBitableConfig();
  const result: ReconcileResult = { checked: 0, applied: 0, conflicts: 0, pushed: 0, errors: [] };
  if (!config.enabled || !config.appToken) return result;

  for (const entityType of ['interview', 'application'] as const) {
    const tableId = tableFor(entityType);
    if (!tableId) continue;
    let pageToken: string | null = null;
    for (let page = 0; page < 10; page += 1) {
      const listed = await listBitableRecords(config.appToken, tableId, pageToken ?? undefined);
      if (!listed.ok || !listed.data) {
        result.errors.push(`${entityType}: ${listed.msg}`);
        break;
      }
      for (const record of listed.data.items) {
        result.checked += 1;
        const outcome = await applyAction(tableId, { recordId: record.recordId, action: 'edit', fields: record.fields, operatorOpenId: null });
        if (outcome === 'applied') result.applied += 1;
        if (outcome === 'conflict') result.conflicts += 1;
      }
      if (!listed.data.hasMore || !listed.data.pageToken) break;
      pageToken = listed.data.pageToken;
    }
  }

  const pending = getRow<{ n: number }>("SELECT COUNT(*) AS n FROM bitable_sync_queue WHERE state = 'pending'")?.n ?? 0;
  if (pending > 0) {
    const flushed = await flushBitableQueue(200);
    result.pushed = flushed.pushed;
  }
  markReconciled();
  audit({
    actorId: null,
    action: 'bitable.reconcile',
    entityType: 'bitable',
    detail: { checked: result.checked, applied: result.applied, conflicts: result.conflicts, pushed: result.pushed },
  });
  return result;
}

/* ------------------------------ 自检与统计 ------------------------------ */

export interface BitableCheck {
  name: string;
  ok: boolean;
  message: string;
}

export interface BitableTestResult {
  ok: boolean;
  checks: BitableCheck[];
}

export async function testBitable(): Promise<BitableTestResult> {
  const config = storedBitableConfig();
  const checks: BitableCheck[] = [];
  if (!config.appToken) {
    return { ok: false, checks: [{ name: 'Base', ok: false, message: '还没有填写 Base 的 app_token' }] };
  }

  const fieldCache: Record<string, string> = {};
  const optionCache: Record<string, Record<string, string>> = {};
  for (const entityType of ['interview', 'application'] as const) {
    const tableId = tableFor(entityType);
    const label = entityType === 'interview' ? '面试表' : '投递表';
    if (!tableId) {
      checks.push({ name: label, ok: false, message: '还没有填写 table_id' });
      continue;
    }
    const listed = await listBitableFields(config.appToken, tableId);
    if (!listed.ok || !listed.data) {
      checks.push({ name: `${label}结构`, ok: false, message: listed.msg });
      continue;
    }
    for (const field of listed.data) {
      fieldCache[field.fieldId] = field.fieldName;
      if (Object.keys(field.options).length) optionCache[field.fieldName] = field.options;
    }
    const names = new Set(listed.data.map((field) => field.fieldName));
    const expected = Object.values(entityType === 'interview' ? INTERVIEW_COLUMNS : APPLICATION_COLUMNS);
    const missing = expected.filter((name) => !names.has(name));
    checks.push({
      name: `${label}结构`,
      ok: missing.length === 0,
      message: missing.length === 0 ? `${expected.length} 列齐全` : `缺少列：${missing.join('、')}`,
    });
  }
  if (Object.keys(fieldCache).length) cacheFields(fieldCache, optionCache);

  const subscribed = await subscribeBitableFile(config.appToken);
  checks.push({
    name: '事件订阅',
    ok: subscribed.ok,
    message: subscribed.ok ? '已订阅这张多维表格的变更事件' : subscribed.msg,
  });

  return { ok: checks.every((check) => check.ok), checks };
}

export interface BitableSyncStats {
  queue: { pending: number; failed: number; done: number };
  records: { linked: number; errors: number };
  events: { pending: number; applied: number; ignored: number };
  reminders: { deleted: number };
}

export function bitableSyncStats(): BitableSyncStats {
  const count = (sql: string): number => getRow<{ n: number }>(sql)?.n ?? 0;
  return {
    queue: {
      pending: count("SELECT COUNT(*) AS n FROM bitable_sync_queue WHERE state = 'pending'"),
      failed: count("SELECT COUNT(*) AS n FROM bitable_sync_queue WHERE state = 'failed'"),
      done: count("SELECT COUNT(*) AS n FROM bitable_sync_queue WHERE state = 'done'"),
    },
    records: {
      linked: count("SELECT COUNT(*) AS n FROM bitable_records WHERE record_id <> ''"),
      errors: count("SELECT COUNT(*) AS n FROM bitable_records WHERE state = 'error'"),
    },
    events: {
      pending: count("SELECT COUNT(*) AS n FROM bitable_events WHERE state = 'pending'"),
      applied: count("SELECT COUNT(*) AS n FROM bitable_events WHERE state = 'applied'"),
      ignored: count("SELECT COUNT(*) AS n FROM bitable_events WHERE state = 'ignored'"),
    },
    reminders: { deleted: 0 },
  };
}

export interface RecentEventRow {
  event_id: string;
  table_id: string | null;
  record_id: string | null;
  action: string | null;
  state: string;
  note: string | null;
  operator_open_id: string | null;
  received_at: string;
  applied_at: string | null;
}

export function recentBitableEvents(limit = 20): RecentEventRow[] {
  return all<RecentEventRow>(
    `SELECT event_id, table_id, record_id, action, state, note, operator_open_id, received_at, applied_at
     FROM bitable_events ORDER BY received_at DESC LIMIT ?`,
    [limit],
  );
}

/** 测试与脚本用：把「系统里的这一行」重新推一遍（忽略指纹）。 */
export async function forcePush(entityType: EntityType, entityId: string): Promise<PushResult> {
  const record = entityType === 'interview' ? buildInterviewRecord(entityId) : buildApplicationRecord(entityId);
  if (!record) throw badRequest('记录不存在');
  return pushRecord(record);
}

export function stageOptions(): Array<{ value: Stage; label: string }> {
  return (Object.keys(STAGE_ORDER) as Stage[]).map((stage) => ({ value: stage, label: STAGE_LABELS[stage] }));
}

export function bitableSnapshot() {
  return { status: bitableStatus(), stats: bitableSyncStats(), events: recentBitableEvents(10), stageOptions: stageOptions() };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function readOperator(body: Record<string, unknown>, event: Record<string, unknown>): string | null {
  const candidates = [event.operator_id, body.operator_id, event.user_id, body.user_id];
  for (const candidate of candidates) {
    const record = asRecord(candidate);
    const openId = readCellText(record.open_id) || (typeof candidate === 'string' ? candidate : '');
    if (openId) return openId;
  }
  return null;
}
