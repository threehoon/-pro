import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdmin, requireRecruiter, requireUser } from './guard.ts';
import { badRequest } from '../lib/errors.ts';
import {
  createCandidate,
  deleteCandidate,
  getCandidate,
  listCandidates,
  updateCandidate,
  type CandidateInput,
} from '../services/candidates.ts';
import { createApplication } from '../services/applications.ts';
import { queueScreening } from '../services/recruitment-ai.ts';

const candidateSchema = z.object({
  name: z.string().trim().min(1, '请填写候选人姓名').max(60),
  email: z.string().trim().email('邮箱格式不正确').nullish().or(z.literal('')),
  phone: z.string().trim().max(40).nullish(),
  location: z.string().trim().max(60).nullish(),
  current_company: z.string().trim().max(120).nullish(),
  current_title: z.string().trim().max(120).nullish(),
  years_experience: z.number().min(0).max(60).nullish(),
  education: z.string().trim().max(40).nullish(),
  school: z.string().trim().max(120).nullish(),
  major: z.string().trim().max(120).nullish(),
  skills: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  source: z.string().trim().max(40).nullish(),
  linkedin: z.string().trim().max(300).nullish(),
  portfolio: z.string().trim().max(300).nullish(),
  summary: z.string().max(4000).nullish(),
  resume_file_id: z.string().nullish(),
  owner_id: z.string().nullish(),
});

export async function candidateRoutes(app: FastifyInstance) {
  app.get('/api/candidates', async (request) => {
    requireUser(request);
    const query = request.query as {
      q?: string;
      skill?: string;
      tag?: string;
      jobId?: unknown;
      group?: string;
      page?: string;
      pageSize?: string;
    };
    if (query.jobId !== undefined && typeof query.jobId !== 'string') throw badRequest('请选择一个职位');
    return listCandidates({
      q: query.q,
      skill: query.skill,
      tag: query.tag,
      jobId: query.jobId?.trim(),
      group: query.group,
      page: query.page ? Number(query.page) : undefined,
      pageSize: query.pageSize ? Number(query.pageSize) : undefined,
    });
  });

  app.post('/api/candidates', async (request, reply) => {
    const user = requireRecruiter(request);
    const parsed = candidateSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? '候选人信息不完整');
    const data = { ...parsed.data } as CandidateInput;
    if (data.email === '') data.email = null;
    const candidate = createCandidate(data, user.id);
    reply.code(201);
    return { candidate };
  });

  app.get('/api/candidates/:candidateId', async (request) => {
    requireUser(request);
    const { candidateId } = request.params as { candidateId: string };
    return getCandidate(candidateId);
  });

  app.patch('/api/candidates/:candidateId', async (request) => {
    const user = requireRecruiter(request);
    const { candidateId } = request.params as { candidateId: string };
    const parsed = candidateSchema.partial().safeParse(request.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? '候选人信息不正确');
    const data = { ...parsed.data } as Partial<CandidateInput>;
    if (data.email === '') data.email = null;
    return { candidate: updateCandidate(candidateId, data, user.id) };
  });

  // 删除候选人档案不可恢复，只允许管理员执行
  app.delete('/api/candidates/:candidateId', async (request) => {
    const user = requireAdmin(request);
    const { candidateId } = request.params as { candidateId: string };
    deleteCandidate(candidateId, user.id);
    return { ok: true };
  });

  app.post('/api/candidates/:candidateId/apply', async (request, reply) => {
    const user = requireRecruiter(request);
    const { candidateId } = request.params as { candidateId: string };
    const schema = z.object({ jobId: z.string().min(1, '请选择职位'), source: z.string().optional() });
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? '请选择职位');
    const application = createApplication({
      jobId: parsed.data.jobId,
      candidateId,
      actorId: user.id,
      source: parsed.data.source,
    });
    queueScreening(application.id, user.id);
    reply.code(201);
    return { application };
  });
}