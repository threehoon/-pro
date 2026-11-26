import { all, getRow, run } from '../db/index.ts';
import { id, now, toJson } from '../lib/util.ts';

/** Append-only audit trail. Feishu compliance review can read this table directly. */
export function audit(input: {
  actorId: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  detail?: Record<string, unknown>;
}): void {
  run(
    `INSERT INTO audit_log (id, actor_id, action, entity_type, entity_id, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id('aud'), input.actorId, input.action, input.entityType, input.entityId ?? null, toJson(input.detail ?? {}), now()],
  );
}

export interface ActivityRow {
  id: string;
  action: string;
  entity_type: string;
  entity_id: string | null;
  detail: string;
  created_at: string;
  actor_name: string | null;
}

export function recentActivity(limit = 12): ActivityRow[] {
  return all<ActivityRow>(
    `SELECT a.id, a.action, a.entity_type, a.entity_id, a.detail, a.created_at,
            u.name AS actor_name
     FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
     ORDER BY a.created_at DESC LIMIT ?`,
    [limit],
  );
}

export function countAudit(): number {
  return getRow<{ n: number }>('SELECT COUNT(*) AS n FROM audit_log')?.n ?? 0;
}