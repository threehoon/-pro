import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdmin, requireUser } from './guard.ts';
import { badRequest } from '../lib/errors.ts';
import {
  STAGES,
  STAGE_LABELS,
  STAGE_HINTS,
  REJECTION_REASONS,
  INTERVIEW_MODE_LABELS,
  RECOMMENDATION_LABELS,
  WORK_MODE_LABELS,
  EMPLOYMENT_TYPE_LABELS,
  ROLE_LABELS,
  RESUME_MAX_BYTES,
  RESUME_ACCEPT,
} from '../constants.ts';
import { dashboard, candidatePoolSummary, todayTasks } from '../services/dashboard.ts';
import {
  createFeishuSharedCalendar,
  feishuStatus,
  resolveFeishuPublicOrigin,
  saveFeishuConfig,
  testFeishuAppConnection,
  testFeishuCalendarConnection,
  testFeishuWebhook,
} from '../integrations/feishu.ts';
import {
  dispatchFeishuOutbox,
  listFeishuOutbox,
  listNotifications,
  notificationStats,
  skipPendingFeishuNotifications,
} from '../services/notifications.ts';
import { audit } from '../services/audit.ts';

export async function workspaceRoutes(app: FastifyInstance) {
  app.get('/api/meta', async () => ({
    stages: STAGES,
    stageLabels: STAGE_LABELS,
    stageHints: STAGE_HINTS,
    rejectionReasons: REJECTION_REASONS,
    interviewModeLabels: INTERVIEW_MODE_LABELS,
    recommendationLabels: RECOMMENDATION_LABELS,
    workModeLabels: WORK_MODE_LABELS,
    employmentTypeLabels: EMPLOYMENT_TYPE_LABELS,
    roleLabels: ROLE_LABELS,
    resumeMaxBytes: RESUME_MAX_BYTES,
    resumeAccept: RESUME_ACCEPT,
  }));

  app.get('/api/dashboard', async (request) => {
    requireUser(request);
    return dashboard();
  });

  app.get('/api/workspace/today', async (request) => {
    requireUser(request);
    const parsed = z.object({ jobId: z.string().min(1).optional() }).safeParse(request.query);
    if (!parsed.success) throw badRequest('查询参数不合法', parsed.error.flatten());
    return { items: todayTasks(parsed.data.jobId) };
  });

  app.get('/api/insights/skills', async (request) => {
    requireUser(request);
    return { items: candidatePoolSummary() };
  });

  app.get('/api/notifications', async (request) => {
    requireUser(request);
    const query = z.object({
      channel: z.enum(['inapp', 'feishu', 'email']).optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
      page: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
      status: z.enum(['pending', 'sent', 'failed', 'skipped']).optional(),
      delivery: z.enum(['webhook', 'dm']).optional(),
      q: z.string().trim().max(100).optional(),
    });
    const parsed = query.safeParse(request.query);
    if (!parsed.success) throw badRequest('查询参数不合法', parsed.error.flatten());
    const { channel, limit, ...filters } = parsed.data;
    if (channel === 'feishu') {
      return { ...listFeishuOutbox({ ...filters, limit }), stats: notificationStats(channel) };
    }
    return { items: listNotifications(limit ?? 30, channel), stats: notificationStats(channel) };
  });

  app.get('/api/settings/feishu', async (request) => {
    requireUser(request);
    return {
      ...feishuStatus(),
      callbackUrl: `${resolveFeishuPublicOrigin(request)}/api/auth/feishu/callback`,
    };
  });

  function auditFeishuIntegration(actorId: string, action: string, detail: Record<string, unknown>) {
    audit({ actorId, action, entityType: 'integration', entityId: 'feishu', detail });
  }

  // 飞书配置包含凭证，只有管理员能改
  app.put('/api/settings/feishu', async (request) => {
    const user = requireAdmin(request);
    const schema = z.object({
      app_id: z.string().optional(),
      app_secret: z.string().optional(),
      verification_token: z.string().optional(),
      encrypt_key: z.string().optional(),
      bot_webhook: z.string().optional(),
      bot_secret: z.string().optional(),
      calendar_id: z.string().optional(),
    });
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) throw badRequest('飞书配置格式不正确');
    const next = saveFeishuConfig(parsed.data, user.id);
    auditFeishuIntegration(user.id, 'feishu.config.update', { updatedFields: Object.keys(parsed.data) });
    return {
      ...next,
      callbackUrl: `${resolveFeishuPublicOrigin(request)}/api/auth/feishu/callback`,
    };
  });

  app.post('/api/settings/feishu/test-app', async (request) => {
    const user = requireAdmin(request);
    const result = await testFeishuAppConnection();
    auditFeishuIntegration(user.id, 'feishu.test_app', { endpoint: result.endpoint, latencyMs: result.latencyMs });
    return result;
  });

  app.post('/api/settings/feishu/test-webhook', async (request) => {
    const user = requireAdmin(request);
    const result = await testFeishuWebhook(user.name);
    auditFeishuIntegration(user.id, 'feishu.test_webhook', { signed: result.signed, latencyMs: result.latencyMs });
    return result;
  });

  app.post('/api/settings/feishu/create-calendar', async (request) => {
    const user = requireAdmin(request);
    const schema = z
      .object({
        summary: z.string().max(120).optional(),
        description: z.string().max(400).optional(),
      })
      .optional();
    const parsed = schema.safeParse(request.body ?? {});
    if (!parsed.success) throw badRequest('日历参数格式不正确');
    const result = await createFeishuSharedCalendar(user.id, parsed.data ?? {});
    auditFeishuIntegration(user.id, 'feishu.create_calendar', {
      calendarId: result.calendarId,
      summary: result.summary,
      latencyMs: result.latencyMs,
    });
    return {
      ...result,
      status: {
        ...result.status,
        callbackUrl: `${resolveFeishuPublicOrigin(request)}/api/auth/feishu/callback`,
      },
    };
  });

  app.post('/api/settings/feishu/test-calendar', async (request) => {
    const user = requireAdmin(request);
    const result = await testFeishuCalendarConnection();
    auditFeishuIntegration(user.id, 'feishu.test_calendar', {
      calendarId: result.calendarId,
      summary: result.summary,
      latencyMs: result.latencyMs,
    });
    return result;
  });

  app.post('/api/notifications/feishu/dispatch', async (request) => {
    const user = requireAdmin(request);
    const schema = z
      .object({
        notificationId: z.string().min(1).optional(),
        limit: z.coerce.number().int().min(1).max(20).optional(),
        includeFailed: z.boolean().optional(),
      })
      .optional();
    const parsed = schema.safeParse(request.body ?? {});
    if (!parsed.success) throw badRequest('补发参数不合法', parsed.error.flatten());
    const result = await dispatchFeishuOutbox(parsed.data ?? {});
    audit({
      actorId: user.id,
      action: 'feishu.notifications.dispatch',
      entityType: 'notification',
      entityId: parsed.data?.notificationId ?? 'batch',
      detail: {
        attempted: result.attempted,
        sent: result.sent,
        failed: result.failed,
        skipped: result.skipped,
      },
    });
    return result;
  });

  app.post('/api/notifications/feishu/skip-pending', async (request) => {
    const user = requireAdmin(request);
    const schema = z
      .object({
        notificationId: z.string().min(1).optional(),
      })
      .optional();
    const parsed = schema.safeParse(request.body ?? {});
    if (!parsed.success) throw badRequest('参数不合法', parsed.error.flatten());
    const result = skipPendingFeishuNotifications(parsed.data ?? {});
    audit({
      actorId: user.id,
      action: 'feishu.notifications.skip',
      entityType: 'notification',
      entityId: parsed.data?.notificationId ?? 'pending_all',
      detail: { skipped: result.skipped },
    });
    return result;
  });
}
