import { z } from 'zod';
import { all } from '../db/index.ts';
import { bitableStatus, saveBitableSettings } from '../integrations/bitable.ts';
import { bitableEventState, restartBitableEvents } from '../integrations/bitable-events.ts';
import { isFeishuAppConfigured } from '../integrations/feishu.ts';
import { badRequest } from '../lib/errors.ts';
import { clearDemoRecords, seedDemoRecords } from '../services/bitable-demo.ts';
import {
  APPLICATION_WRITABLE,
  APPLICATION_COLUMNS,
  INTERVIEW_COLUMNS,
  INTERVIEW_WRITABLE,
} from '../services/bitable-mapping.ts';
import {
  bitableSyncStats,
  flushBitableQueue,
  queueEntity,
  reconcileBitable,
  recentBitableEvents,
  testBitable,
} from '../services/bitable-sync.ts';
import { requireAdmin, requireUser } from './guard.ts';

const configInput = z.object({
  appToken: z.string().trim().max(120).nullable().optional(),
  interviewsTableId: z.string().trim().max(120).nullable().optional(),
  applicationsTableId: z.string().trim().max(120).nullable().optional(),
  enabled: z.boolean().optional(),
  fallbackMinutes: z.number().int().min(0).max(1440).optional(),
});

function configBody(body: unknown) {
  const parsed = configInput.safeParse(body ?? {});
  if (!parsed.success) throw badRequest('多维表格配置格式不正确');
  return parsed.data;
}

export async function bitableRoutes(app: import('fastify').FastifyInstance) {
  app.get('/api/settings/bitable', async (request) => {
    requireUser(request);
    return {
      ok: true,
      data: {
        ...bitableStatus(),
        stats: bitableSyncStats(),
        events: recentBitableEvents(10),
        connection: bitableEventState(),
        feishuApp: isFeishuAppConfigured(),
        columns: {
          interview: Object.values(INTERVIEW_COLUMNS),
          application: Object.values(APPLICATION_COLUMNS),
          interviewWritable: [...INTERVIEW_WRITABLE],
          applicationWritable: [...APPLICATION_WRITABLE],
        },
      },
    };
  });

  app.post('/api/settings/bitable', async (request) => {
    const actor = requireAdmin(request);
    const status = saveBitableSettings(configBody(request.body), actor.id);
    const connection = restartBitableEvents();
    return {
      ok: true,
      data: {
        ...status,
        stats: bitableSyncStats(),
        events: recentBitableEvents(10),
        connection: bitableEventState(),
        feishuApp: isFeishuAppConfigured(),
        columns: {
          interview: Object.values(INTERVIEW_COLUMNS),
          application: Object.values(APPLICATION_COLUMNS),
          interviewWritable: [...INTERVIEW_WRITABLE],
          applicationWritable: [...APPLICATION_WRITABLE],
        },
        message: connection.started ? '已保存，长连接已重启' : `已保存；${connection.reason}`,
      },
    };
  });

  app.post('/api/settings/bitable/test', async (request) => {
    requireAdmin(request);
    const result = await testBitable();
    return { ok: true, data: result };
  });

  app.post('/api/settings/bitable/reconcile', async (request) => {
    requireAdmin(request);
    const result = await reconcileBitable();
    return { ok: true, data: result };
  });

  /** 首次接入时把已有面试与投递整体推一遍（分批入队，不阻塞请求）。 */
  app.post('/api/settings/bitable/backfill', async (request) => {
    requireAdmin(request);
    const status = bitableStatus();
    if (!status.enabled || !status.appToken) throw badRequest('请先保存并开启多维表格同步');
    const interviews = all<{ id: string }>('SELECT id FROM interviews ORDER BY updated_at DESC LIMIT 500');
    const applications = all<{ id: string }>('SELECT id FROM applications ORDER BY updated_at DESC LIMIT 500');
    for (const row of interviews) queueEntity('interview', row.id);
    for (const row of applications) queueEntity('application', row.id);
    const flushed = await flushBitableQueue(200);
    return {
      ok: true,
      data: {
        queued: interviews.length + applications.length,
        pushed: flushed.pushed,
        failed: flushed.failed,
      },
    };
  });

  /** 灌一批演示投递与面试，用来直观看同步效果；行 id 都带 seed_ 前缀，可一键清掉。 */
  app.post('/api/settings/bitable/seed-demo', async (request) => {
    const actor = requireAdmin(request);
    const result = await seedDemoRecords(actor.id);
    return { ok: true, data: result };
  });

  app.post('/api/settings/bitable/clear-demo', async (request) => {
    const actor = requireAdmin(request);
    const result = await clearDemoRecords(actor.id);
    return { ok: true, data: result };
  });
}
