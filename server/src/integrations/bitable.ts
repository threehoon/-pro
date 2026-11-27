import { getRow, run } from '../db/index.ts';
import { badRequest } from '../lib/errors.ts';
import { jsonParse, now, toJson } from '../lib/util.ts';
import { audit } from '../services/audit.ts';
import { callFeishuTenantApi } from './feishu.ts';

/** 多维表格有两个 ID：Base（app_token）与表（table_id），都在表格链接里，管理员填一次即可。 */
export const BASE_TOKEN_PATTERN = /^[A-Za-z0-9]{6,64}$/;
export const TABLE_ID_PATTERN = /^tbl[A-Za-z0-9]{4,64}$/;

export interface BitableStoredConfig {
  appToken: string | null;
  interviewsTableId: string | null;
  applicationsTableId: string | null;
  /** field_id → 列名，用来把事件里的 field_id 翻译成列名。 */
  fields: Record<string, string>;
  /** 列名 → { 选项 id → 选项名 }，单选列的事件回传的是 option id，不是文案。 */
  options: Record<string, Record<string, string>>;
  enabled: boolean;
  fallbackMinutes: number;
}

export interface BitableStatus extends BitableStoredConfig {
  configured: boolean;
  subscribedAt: string | null;
  lastEventAt: string | null;
  lastReconcileAt: string | null;
  updatedAt: string | null;
}

const EMPTY: BitableStoredConfig = {
  appToken: null,
  interviewsTableId: null,
  applicationsTableId: null,
  fields: {},
  options: {},
  enabled: false,
  fallbackMinutes: 0,
};

interface ConfigRow {
  app_token: string | null;
  interviews_table_id: string | null;
  applications_table_id: string | null;
  fields_json: string;
  enabled: number;
  fallback_minutes: number;
  subscribed_at: string | null;
  last_event_at: string | null;
  last_reconcile_at: string | null;
  updated_at: string;
}

function readRow(): ConfigRow | undefined {
  return getRow<ConfigRow>(
    `SELECT app_token, interviews_table_id, applications_table_id, fields_json, enabled, fallback_minutes,
            subscribed_at, last_event_at, last_reconcile_at, updated_at
     FROM bitable_config WHERE id = 'default'`,
  );
}

function readCachedFields(raw: string): Record<string, string> {
  const parsed = jsonParse<Record<string, unknown>>(raw, {});
  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (key !== '__options' && typeof value === 'string') fields[key] = value;
  }
  return fields;
}

function readCachedOptions(raw: string): Record<string, Record<string, string>> {
  const parsed = jsonParse<Record<string, unknown>>(raw, {});
  const stored = parsed.__options;
  if (!stored || typeof stored !== 'object') return {};
  const options: Record<string, Record<string, string>> = {};
  for (const [column, map] of Object.entries(stored as Record<string, unknown>)) {
    if (!map || typeof map !== 'object') continue;
    const entries = Object.entries(map as Record<string, unknown>).filter(([, name]) => typeof name === 'string');
    options[column] = Object.fromEntries(entries) as Record<string, string>;
  }
  return options;
}

function readFieldOptions(item: Record<string, unknown>): Record<string, string> {
  const property = asRecord(item.property);
  const options: Record<string, string> = {};
  for (const option of asArray(property.options)) {
    const optionId = String(option.id ?? '');
    const name = String(option.name ?? '');
    if (optionId && name) options[optionId] = name;
  }
  return options;
}

export function storedBitableConfig(): BitableStoredConfig {
  const row = readRow();
  if (!row) return EMPTY;
  return {
    appToken: row.app_token,
    interviewsTableId: row.interviews_table_id,
    applicationsTableId: row.applications_table_id,
    fields: readCachedFields(row.fields_json),
    options: readCachedOptions(row.fields_json),
    enabled: row.enabled === 1,
    fallbackMinutes: row.fallback_minutes,
  };
}

export function bitableStatus(): BitableStatus {
  const row = readRow();
  const config = storedBitableConfig();
  return {
    ...config,
    configured: Boolean(config.appToken && config.appToken.trim()),
    subscribedAt: row?.subscribed_at ?? null,
    lastEventAt: row?.last_event_at ?? null,
    lastReconcileAt: row?.last_reconcile_at ?? null,
    updatedAt: row?.updated_at ?? null,
  };
}

/** 只改配置，不动字段缓存与订阅状态；调用方负责补审计。 */
export function saveBitableConfig(input: {
  appToken?: string | null;
  interviewsTableId?: string | null;
  applicationsTableId?: string | null;
  enabled?: boolean;
  fallbackMinutes?: number;
}): BitableStatus {
  const current = storedBitableConfig();
  const appToken = input.appToken === undefined ? current.appToken : cleanId(input.appToken, BASE_TOKEN_PATTERN, 'Base 链接里的 app_token');
  const interviewsTableId =
    input.interviewsTableId === undefined ? current.interviewsTableId : cleanId(input.interviewsTableId, TABLE_ID_PATTERN, '面试表 table_id');
  const applicationsTableId =
    input.applicationsTableId === undefined ? current.applicationsTableId : cleanId(input.applicationsTableId, TABLE_ID_PATTERN, '投递表 table_id');
  const fallbackMinutes = input.fallbackMinutes === undefined ? current.fallbackMinutes : input.fallbackMinutes;
  if (!Number.isInteger(fallbackMinutes) || fallbackMinutes < 0 || fallbackMinutes > 24 * 60) {
    throw badRequest('对账间隔请填 0 到 1440 之间的整数分钟（0 表示关闭）');
  }
  const enabled = input.enabled === undefined ? current.enabled : input.enabled;
  const timestamp = now();
  run(
    `INSERT INTO bitable_config (id, app_token, interviews_table_id, applications_table_id, fields_json, enabled,
                                 fallback_minutes, updated_at)
     VALUES ('default', ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       app_token = excluded.app_token,
       interviews_table_id = excluded.interviews_table_id,
       applications_table_id = excluded.applications_table_id,
       enabled = excluded.enabled,
       fallback_minutes = excluded.fallback_minutes,
       updated_at = excluded.updated_at`,
    [appToken, interviewsTableId, applicationsTableId, toJson(current.fields), enabled ? 1 : 0, fallbackMinutes, timestamp],
  );
  return bitableStatus();
}

export function saveBitableSettings(
  input: {
    appToken?: string | null;
    interviewsTableId?: string | null;
    applicationsTableId?: string | null;
    enabled?: boolean;
    fallbackMinutes?: number;
  },
  actorId: string,
): BitableStatus {
  const status = saveBitableConfig(input);
  run(
    `INSERT INTO bitable_config (id, updated_by, updated_at) VALUES ('default', ?, ?)
     ON CONFLICT(id) DO UPDATE SET updated_by = excluded.updated_by`,
    [actorId, now()],
  );
  audit({
    actorId,
    action: 'bitable.config',
    entityType: 'bitable',
    detail: {
      appTokenTail: status.appToken ? status.appToken.slice(-4) : null,
      interviewsTableId: status.interviewsTableId,
      applicationsTableId: status.applicationsTableId,
      enabled: status.enabled,
      fallbackMinutes: status.fallbackMinutes,
    },
  });
  return status;
}

function cleanId(value: string | null, pattern: RegExp, label: string): string | null {
  const text = value?.trim() ?? '';
  if (!text) return null;
  if (!pattern.test(text)) throw badRequest(`${label} 格式不正确`);
  return text;
}

export function markSubscribed(): void {
  run(`UPDATE bitable_config SET subscribed_at = ? WHERE id = 'default'`, [now()]);
}

export function markEventReceived(): void {
  run(`UPDATE bitable_config SET last_event_at = ? WHERE id = 'default'`, [now()]);
}

export function markReconciled(): void {
  run(`UPDATE bitable_config SET last_reconcile_at = ? WHERE id = 'default'`, [now()]);
}

/**
 * 缓存 field_id→列名与列名→选项表。单选列的事件回调只给 option id（optXXXX），
 * 没有这张表就无法判断用户在表格里选的是「推荐」还是「淘汰」。
 */
export function cacheFields(fields: Record<string, string>, options?: Record<string, Record<string, string>>): void {
  const current = storedBitableConfig();
  const mergedOptions: Record<string, Record<string, string>> = { ...current.options };
  for (const [column, map] of Object.entries(options ?? {})) mergedOptions[column] = { ...(mergedOptions[column] ?? {}), ...map };
  run(`UPDATE bitable_config SET fields_json = ? WHERE id = 'default'`, [
    toJson({ ...current.fields, ...fields, __options: mergedOptions }),
  ]);
}

/* ------------------------------ 多维表格 REST ------------------------------ */

export interface BitableField {
  fieldId: string;
  fieldName: string;
  type: number;
  options: Record<string, string>;
}

export interface BitableRecord {
  recordId: string;
  fields: Record<string, unknown>;
}

export interface BitableCallResult<T> {
  ok: boolean;
  status: number;
  code: number | null;
  msg: string;
  data: T | null;
}

function tablePath(appToken: string, tableId: string, suffix = ''): string {
  return `/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}${suffix}`;
}

/** 列出字段，用来核对表结构并把 field_id 缓存下来（事件回传的是 field_id）。 */
export async function listBitableFields(appToken: string, tableId: string): Promise<BitableCallResult<BitableField[]>> {
  const result = await callFeishuTenantApi(tablePath(appToken, tableId, '/fields?page_size=100'), { method: 'GET' });
  const items = asArray(result.data?.items);
  return {
    ok: result.ok,
    status: result.status,
    code: result.code,
    msg: result.msg || feishuReason(result.code, result.status),
    data: result.ok
      ? items.map((item) => ({
          fieldId: String(item.field_id ?? ''),
          fieldName: String(item.field_name ?? ''),
          type: Number(item.type ?? 0),
          options: readFieldOptions(item),
        }))
      : null,
  };
}

export async function listBitableRecords(
  appToken: string,
  tableId: string,
  pageToken?: string,
): Promise<BitableCallResult<{ items: BitableRecord[]; pageToken: string | null; hasMore: boolean }>> {
  const query = `?page_size=500${pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : ''}`;
  const result = await callFeishuTenantApi(tablePath(appToken, tableId, `/records${query}`), { method: 'GET' });
  const raw = result.data ?? {};
  const items = asArray(raw.items).map((item) => ({
    recordId: String(item.record_id ?? ''),
    fields: asRecord(item.fields),
  }));
  return {
    ok: result.ok,
    status: result.status,
    code: result.code,
    msg: result.msg || feishuReason(result.code, result.status),
    data: result.ok
      ? { items, pageToken: typeof raw.page_token === 'string' ? raw.page_token : null, hasMore: raw.has_more === true }
      : null,
  };
}

export async function createBitableRecords(
  appToken: string,
  tableId: string,
  records: Array<{ fields: Record<string, unknown> }>,
): Promise<BitableCallResult<BitableRecord[]>> {
  return writeRecords(appToken, tableId, records, 'batch_create');
}

export async function updateBitableRecords(
  appToken: string,
  tableId: string,
  records: Array<{ record_id: string; fields: Record<string, unknown> }>,
): Promise<BitableCallResult<BitableRecord[]>> {
  const result = await callFeishuTenantApi(tablePath(appToken, tableId, '/records/batch_update'), {
    method: 'POST',
    payload: { records },
  });
  const items = asArray(result.data?.records).map((item) => ({
    recordId: String(item.record_id ?? ''),
    fields: asRecord(item.fields),
  }));
  return {
    ok: result.ok,
    status: result.status,
    code: result.code,
    msg: result.msg || feishuReason(result.code, result.status),
    data: result.ok ? items : null,
  };
}

export async function deleteBitableRecords(
  appToken: string,
  tableId: string,
  recordIds: string[],
): Promise<BitableCallResult<{ deleted: number }>> {
  if (!recordIds.length) {
    return { ok: true, status: 200, code: 0, msg: '没有要删除的行', data: { deleted: 0 } };
  }
  const result = await callFeishuTenantApi(tablePath(appToken, tableId, '/records/batch_delete'), {
    method: 'POST',
    payload: { records: recordIds },
  });
  return {
    ok: result.ok,
    status: result.status,
    code: result.code,
    msg: result.msg || feishuReason(result.code, result.status),
    data: result.ok ? { deleted: recordIds.length } : null,
  };
}

async function writeRecords(
  appToken: string,
  tableId: string,
  records: Array<{ fields: Record<string, unknown> }>,
  action: 'batch_create',
): Promise<BitableCallResult<BitableRecord[]>> {
  const result = await callFeishuTenantApi(tablePath(appToken, tableId, `/records/${action}`), {
    method: 'POST',
    payload: { records },
  });
  const items = asArray(result.data?.records).map((item) => ({
    recordId: String(item.record_id ?? ''),
    fields: asRecord(item.fields),
  }));
  return {
    ok: result.ok,
    status: result.status,
    code: result.code,
    msg: result.msg || feishuReason(result.code, result.status),
    data: result.ok ? items : null,
  };
}

/** 「多维表格记录变更」事件要求先订阅具体云文档，否则不会推送。 */
export async function subscribeBitableFile(appToken: string): Promise<BitableCallResult<null>> {
  const result = await callFeishuTenantApi(
    `/open-apis/drive/v1/files/${encodeURIComponent(appToken)}/subscribe?file_type=bitable`,
    { method: 'POST', payload: {} },
  );
  return {
    ok: result.ok,
    status: result.status,
    code: result.code,
    msg: result.msg || feishuReason(result.code, result.status),
    data: null,
  };
}

function feishuReason(code: number | null, status: number): string {
  if (code === 1254302) return '应用没有这张多维表格的读写权限，请把应用加成 Base 协作者（开了高级权限时还要把应用所在群设为可编辑）';
  if (code === 1254003) return 'Base 的 app_token 不正确，请重新从表格链接里复制';
  if (code === 1254004) return 'table_id 不正确，请重新从表格链接里复制';
  if (code === 1254290) return '调用过于频繁，稍后会自动重试';
  if (code === 1254291) return '同一个数据表不支持并发写入，等这一批同步完再试';
  if (code === 1254104) return '单次写入超过 500 条，请稍后分批重试';
  if (code === 1254103) return '这张表记录数已达 20 000 行上限，请归档后重试';
  if (code === 99991663 || code === 99991664) return '应用凭证无效或已过期，请重新保存 App ID / Secret';
  return `飞书接口返回 ${code ?? status}`;
}

function asArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object') : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
