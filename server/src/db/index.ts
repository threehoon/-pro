import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.join(here, 'schema.sql');

export const dataDir = process.env.HIRELOOP_DATA_DIR
  ? path.resolve(process.env.HIRELOOP_DATA_DIR)
  : path.resolve(here, '../../data');

export const uploadDir = path.join(dataDir, 'uploads');
export const dbPath = process.env.HIRELOOP_DB_PATH
  ? path.resolve(process.env.HIRELOOP_DB_PATH)
  : path.join(dataDir, 'hireloop.db');

let db: DatabaseSync | null = null;

/** Single shared connection. Call closeDb() in tests when swapping databases. */
export function getDb(): DatabaseSync {
  if (db) return db;
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(uploadDir, { recursive: true });
  db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  applySchema(db);
  return db;
}

export function closeDb(): void {
  db?.close();
  db = null;
}

function applySchema(conn: DatabaseSync): void {
  const sql = readFileSync(schemaPath, 'utf8');
  conn.exec(sql);
  // 轻量列迁移：为已存在的旧库补充新增列（CREATE TABLE IF NOT EXISTS 不会改旧表）
  ensureColumn(conn, 'users', 'username', 'TEXT');
  ensureColumn(conn, 'candidates', 'linkedin', 'TEXT');
  ensureColumn(conn, 'candidates', 'portfolio', 'TEXT');
  // 账号名唯一（允许多行为空）；索引必须在补列之后建，旧库才不会有缺列问题
  conn.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username) WHERE username IS NOT NULL',
  );
  ensureRow(conn, 'integrations', 'feishu');
  ensureRow(conn, 'integrations', 'llm');
  ensureColumn(conn, 'candidates', 'resume_text', 'TEXT');
  ensureColumn(conn, 'files', 'resume_parse_json', 'TEXT');
  ensureColumn(conn, 'interviews', 'is_draft', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(conn, 'interviews', 'decision', 'TEXT');
  ensureColumn(conn, 'interviews', 'transcript', 'TEXT');
  ensureColumn(conn, 'interviews', 'transcript_source', 'TEXT');
  ensureColumn(conn, 'interviews', 'summary_json', "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn(conn, 'interviews', 'summary_status', "TEXT NOT NULL DEFAULT 'none'");
  ensureColumn(conn, 'interviews', 'summary_model', 'TEXT');
  ensureColumn(conn, 'interviews', 'summarized_at', 'TEXT');
  ensureColumn(conn, 'interviews', 'plan_json', "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn(conn, 'applications', 'composite_json', "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn(conn, 'applications', 'composite_status', "TEXT NOT NULL DEFAULT 'none'");
  ensureColumn(conn, 'applications', 'hired_at', 'TEXT');
  conn.exec(`
    BEGIN IMMEDIATE;
    INSERT INTO application_events (id, application_id, from_stage, to_stage, type, note, created_at)
      SELECT 'migration_screening_' || id, id, 'new', 'screening', 'stage_change', '合并阶段：新简历 → 待筛选', strftime('%Y-%m-%dT%H:%M:%fZ','now')
      FROM applications WHERE stage = 'new'
      ON CONFLICT(id) DO NOTHING;
    UPDATE applications SET stage = 'screening' WHERE stage = 'new';
    INSERT INTO offers (id, application_id, created_at, updated_at)
      SELECT 'migration_offer_' || id, id, updated_at, updated_at FROM applications WHERE stage = 'offer'
      ON CONFLICT(application_id) DO NOTHING;
    UPDATE applications SET hired_at = COALESCE(
      (SELECT MAX(created_at) FROM application_events WHERE application_id = applications.id AND type = 'hired'),
      updated_at
    ) WHERE stage = 'hired' AND hired_at IS NULL;
    COMMIT;
  `);
}

function ensureColumn(conn: DatabaseSync, table: string, column: string, type: string): void {
  const columns = conn.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((item) => item.name === column)) {
    conn.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

function ensureRow(conn: DatabaseSync, table: 'integrations', provider: string): void {
  const row = conn.prepare(`SELECT provider FROM ${table} WHERE provider = ?`).get(provider);
  if (!row) {
    conn
      .prepare(`INSERT INTO ${table} (provider, status, config_json, updated_at) VALUES (?, 'disabled', '{}', ?)`)
      .run(provider, new Date().toISOString());
  }
}

export function all<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T[] {
  const rows = getDb().prepare(sql).all(...(params as never[]));
  return rows.map((row) => ({ ...row })) as T[];
}

export function getRow<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T | undefined {
  const row = getDb().prepare(sql).get(...(params as never[]));
  return row ? ({ ...row } as T) : undefined;
}

export function run(sql: string, params: unknown[] = []) {
  return getDb().prepare(sql).run(...(params as never[]));
}

/** Simple BEGIN/COMMIT wrapper; nested calls are not supported. */
export function transaction<T>(fn: () => T): T {
  const conn = getDb();
  conn.exec('BEGIN');
  try {
    const result = fn();
    conn.exec('COMMIT');
    return result;
  } catch (error) {
    conn.exec('ROLLBACK');
    throw error;
  }
}

export function dbExists(): boolean {
  return existsSync(dbPath);
}