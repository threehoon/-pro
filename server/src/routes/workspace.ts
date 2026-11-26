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
import { feishuStatus, saveFeishuConfig } from '../integrations/feishu.ts';
import { listNotifications, notificationStats } from '../services/notifications.ts';

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
    });
    const parsed = query.safeParse(request.query);
    if (!parsed.success) throw badRequest('查询参数不合法', parsed.error.flatten());
    const { channel, limit } = parsed.data;
    return {
      items: listNotifications(limit ?? 30, channel),
      stats: notificationStats(),
    };
  });

  app.get('/api/settings/feishu', async (request) => {
    requireUser(request);
    return feishuStatus();
  });

  // 飞书配置包含凭证，只有管理员能改
  app.put('/api/settings/feishu', async (request) => {
    const user = requireAdmin(request);
    const schema = z.object({
      app_id: z.string().optional(),
      app_secret: z.string().optional(),
      verification_token: z.string().optional(),
      encrypt_key: z.string().optional(),
      bot_webhook: z.string().optional(),
      calendar_id: z.string().optional(),
    });
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) throw badRequest('飞书配置格式不正确');
    return saveFeishuConfig(parsed.data, user.id);
  });
}