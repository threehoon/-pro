import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRecruiter, requireUser } from './guard.ts';
import { AppError, badRequest, notFound } from '../lib/errors.ts';
import {
  cancelInterview,
  decideInterview,
  createInterview,
  ensureInterviewCalendarSync,
  interviewWithContext,
  listInterviews,
  markNoShow,
  syncInterviewCalendarNow,
  updateInterview,
} from '../services/interviews.ts';
import { queueQuestions } from '../services/recruitment-ai.ts';
import { AsrFailure, transcribeInterviewAudio } from '../integrations/asr.ts';
import { AUDIO_EXTENSIONS, AUDIO_MIME } from '../constants.ts';
import { audit } from '../services/audit.ts';
import { getRow } from '../db/index.ts';
import path from 'node:path';

function isHttpMeetingUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

const meetingUrlSchema = z
  .string()
  .max(500)
  .refine((value) => value.trim() === '' || isHttpMeetingUrl(value.trim()), '会议链接必须以 http:// 或 https:// 开头');

const createSchema = z.object({
  applicationId: z.string().min(1, '请选择投递记录'),
  scheduledAt: z.string().min(1, '请选择面试时间'),
  title: z.string().max(120).optional(),
  mode: z.enum(['onsite', 'video', 'phone']).optional(),
  durationMinutes: z.number().int().min(15).max(480).optional(),
  location: z.string().max(200).optional(),
  meetingUrl: meetingUrlSchema.optional(),
  interviewerId: z.string().nullish(),
  round: z.number().int().min(1).max(2).optional(),
});

export async function interviewRoutes(app: FastifyInstance) {
  app.get('/api/interviews', async (request) => {
    requireUser(request);
    const query = request.query as {
      from?: string;
      to?: string;
      status?: string;
      jobId?: string;
      applicationId?: string;
    };
    return { items: listInterviews(query) };
  });

  app.post('/api/interviews', async (request, reply) => {
    const user = requireRecruiter(request);
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? '面试信息不完整');
    const interview = createInterview({ ...parsed.data, actorId: user.id });
    queueQuestions(interview.id, user.id);
    reply.code(201);
    return { interview };
  });

  app.get('/api/interviews/:interviewId', async (request) => {
    requireUser(request);
    const { interviewId } = request.params as { interviewId: string };
    return { interview: interviewWithContext(interviewId) };
  });

  app.patch('/api/interviews/:interviewId', async (request) => {
    const user = requireRecruiter(request);
    const { interviewId } = request.params as { interviewId: string };
    const parsed = createSchema.partial().safeParse(request.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? '面试信息不正确');
    const { applicationId: _ignored, ...patch } = parsed.data;
    void _ignored;
    const interview = updateInterview({ interviewId, ...patch, actorId: user.id });
    if (patch.scheduledAt) queueQuestions(interview.id, user.id);
    return { interview };
  });

  app.post('/api/interviews/:interviewId/decide', async (request) => {
    const user = requireRecruiter(request);
    const { interviewId } = request.params as { interviewId: string };
    const parsed = z.object({
      decision: z.enum(['advance', 'negotiate', 'reject']),
      reason: z.string().max(1000).optional(),
      allowWithoutSummary: z.boolean().optional(),
    }).safeParse(request.body);
    if (!parsed.success) throw badRequest('请选择面试去向');
    return decideInterview({ interviewId, ...parsed.data, actorId: user.id });
  });

  app.post('/api/interviews/:interviewId/cancel', async (request) => {
    const user = requireRecruiter(request);
    const { interviewId } = request.params as { interviewId: string };
    const schema = z.object({ note: z.string().max(500).optional() });
    const parsed = schema.safeParse(request.body ?? {});
    return { interview: cancelInterview({ interviewId, note: parsed.success ? parsed.data.note : undefined, actorId: user.id }) };
  });

  app.post('/api/interviews/:interviewId/no-show', async (request) => {
    const user = requireRecruiter(request);
    const { interviewId } = request.params as { interviewId: string };
    return { interview: markNoShow(interviewId, user.id) };
  });

  app.post('/api/interviews/:interviewId/sync-calendar', async (request) => {
    const user = requireRecruiter(request);
    const { interviewId } = request.params as { interviewId: string };
    return syncInterviewCalendarNow(interviewId, user.id);
  });

  // 打开面试详情时自动补同步：幂等，未配置/草稿/已结束都只回原因，不报错
  app.post('/api/interviews/:interviewId/ensure-calendar', async (request) => {
    const user = requireRecruiter(request);
    const { interviewId } = request.params as { interviewId: string };
    return ensureInterviewCalendarSync(interviewId, user.id);
  });

  /**
   * 录音转写：只返回文字，不写库。转写结果要先让人核对、改错别字，
   * 再由「保存逐字稿并生成」落到面试记录上——识别错的声音不该直接进总结。
   */
  app.post('/api/interviews/:interviewId/transcribe', async (request) => {
    const user = requireRecruiter(request);
    const { interviewId } = request.params as { interviewId: string };
    const interview = getRow<{ id: string }>('SELECT id FROM interviews WHERE id = ?', [interviewId]);
    if (!interview) throw notFound('面试不存在');
    const file = await request.file();
    if (!file) throw badRequest('请选择要转写的录音文件');
    const ext = path.extname(file.filename || '').toLowerCase();
    if (!AUDIO_EXTENSIONS.includes(ext)) throw badRequest('只支持 mp3、m4a、wav、webm 等常见录音格式');
    const buffer = await file.toBuffer();
    let result;
    try {
      result = await transcribeInterviewAudio({
        buffer,
        filename: file.filename || `interview${ext}`,
        mime: AUDIO_MIME[ext] ?? 'application/octet-stream',
      });
    } catch (error) {
      // 识别服务的问题不该显示成 500「服务器开小差」：超时与对端报错要分开告诉用户能不能重试。
      if (error instanceof AsrFailure) {
        const status = error.code === 'timeout' ? 504 : error.code === 'provider_error' || error.code === 'invalid_response' ? 502 : 400;
        throw new AppError(status, error.code, error.message);
      }
      throw error;
    }
    audit({
      actorId: user.id, action: 'interview.transcribe', entityType: 'interview', entityId: interviewId,
      detail: { bytes: buffer.length, model: result.model, chars: result.chars, durationSeconds: result.durationSeconds },
    });
    return { ok: true, data: result };
  });
}