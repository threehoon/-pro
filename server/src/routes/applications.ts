import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRecruiter, requireUser } from './guard.ts';
import { badRequest } from '../lib/errors.ts';
import {
  addNote,
  applicationDetail,
  createApplication,
  decideScreening,
  rejectApplication,
  reopenApplication,
} from '../services/applications.ts';
import { decideOffer, offerDetail, updateOffer } from '../services/offers.ts';
import { queueScreening } from '../services/recruitment-ai.ts';

const dateField = z.string().date();
const offerTerms = z.object({
  expected_salary: z.number().int().nonnegative().safe().nullable().optional(),
  final_salary: z.number().int().positive().safe().nullable().optional(),
  start_date: dateField.nullable().optional(),
  reply_deadline: dateField.nullable().optional(),
  offer_letter: z.string().trim().max(10000).nullable().optional(),
}).strict();

export async function applicationRoutes(app: FastifyInstance) {
  app.post('/api/applications', async (request, reply) => {
    const user = requireRecruiter(request);
    const schema = z.object({
      jobId: z.string().min(1, '请选择职位'),
      candidateId: z.string().min(1, '请选择候选人'),
      source: z.string().optional(),
      ownerId: z.string().nullish(),
    });
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? '参数不正确');
    const application = createApplication({ ...parsed.data, actorId: user.id });
    queueScreening(application.id, user.id);
    reply.code(201);
    return { application };
  });

  app.get('/api/applications/:applicationId', async (request) => {
    requireUser(request);
    const { applicationId } = request.params as { applicationId: string };
    return applicationDetail(applicationId);
  });

  app.post('/api/applications/:applicationId/screening', async (request) => {
    const user = requireRecruiter(request);
    const { applicationId } = request.params as { applicationId: string };
    const parsed = z.object({ decision: z.enum(['advance', 'reject']), reason: z.string().max(1000).optional() }).safeParse(request.body);
    if (!parsed.success) throw badRequest('请选择筛选去向');
    return { application: decideScreening({ applicationId, actorId: user.id, ...parsed.data }) };
  });

  app.post('/api/applications/:applicationId/reject', async (request) => {
    const user = requireRecruiter(request);
    const { applicationId } = request.params as { applicationId: string };
    const schema = z.object({
      reason: z.string().trim().min(1, '请选择拒绝原因'),
      note: z.string().max(2000).optional(),
    });
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? '请选择拒绝原因');
    return { application: rejectApplication({ applicationId, ...parsed.data, actorId: user.id }) };
  });

  app.post('/api/applications/:applicationId/reopen', async (request) => {
    const user = requireRecruiter(request);
    const { applicationId } = request.params as { applicationId: string };
    const schema = z.object({ note: z.string().max(2000).optional() });
    const parsed = schema.safeParse(request.body ?? {});
    if (!parsed.success) throw badRequest('参数不正确');
    const application = reopenApplication({ applicationId, ...parsed.data, actorId: user.id });
    if (application.stage === 'screening') queueScreening(application.id, user.id);
    return { application };
  });

  app.post('/api/applications/:applicationId/notes', async (request) => {
    const user = requireRecruiter(request);
    const { applicationId } = request.params as { applicationId: string };
    const schema = z.object({ note: z.string().trim().min(1, '请填写备注').max(4000) });
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? '请填写备注');
    addNote({ applicationId, note: parsed.data.note, actorId: user.id });
    return { ok: true };
  });

  app.get('/api/applications/:applicationId/offer', async (request) => {
    requireUser(request);
    const { applicationId } = request.params as { applicationId: string };
    return offerDetail(applicationId);
  });

  app.put('/api/applications/:applicationId/offer', async (request) => {
    const user = requireRecruiter(request);
    const { applicationId } = request.params as { applicationId: string };
    const parsed = offerTerms.safeParse(request.body);
    if (!parsed.success) throw badRequest('请检查薪资和日期格式');
    return updateOffer(applicationId, user.id, parsed.data);
  });

  for (const action of ['send', 'accept', 'decline', 'hire'] as const) {
    app.post(`/api/applications/:applicationId/offer/${action}`, async (request) => {
      const user = requireRecruiter(request);
      const { applicationId } = request.params as { applicationId: string };
      const parsed = z.object({ reason: z.string().trim().max(1000).optional(), start_date: dateField.optional() }).safeParse(request.body ?? {});
      if (!parsed.success) throw badRequest('请检查备注和到岗日期');
      return decideOffer({ applicationId, actorId: user.id, action, ...parsed.data });
    });
  }
}
