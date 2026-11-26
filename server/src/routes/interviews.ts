import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRecruiter, requireUser } from './guard.ts';
import { badRequest } from '../lib/errors.ts';
import {
  cancelInterview,
  decideInterview,
  createInterview,
  interviewWithContext,
  listInterviews,
  markNoShow,
  updateInterview,
} from '../services/interviews.ts';
import { queueQuestions } from '../services/recruitment-ai.ts';

const createSchema = z.object({
  applicationId: z.string().min(1, '请选择投递记录'),
  scheduledAt: z.string().min(1, '请选择面试时间'),
  title: z.string().max(120).optional(),
  mode: z.enum(['onsite', 'video', 'phone']).optional(),
  durationMinutes: z.number().int().min(15).max(480).optional(),
  location: z.string().max(200).optional(),
  meetingUrl: z.string().max(500).optional(),
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
}