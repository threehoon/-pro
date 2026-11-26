import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdmin, requireRecruiter, requireUser } from './guard.ts';
import { badRequest } from '../lib/errors.ts';
import { jsonParse } from '../lib/util.ts';
import { board } from '../services/applications.ts';
import { queueProfile } from '../services/recruitment-ai.ts';
import {
  createJob,
  deleteJob,
  getJob,
  jobOptions,
  listJobs,
  updateJob,
  type JobInput,
} from '../services/jobs.ts';

const jobSchema = z.object({
  title: z.string().trim().min(1, '请填写职位名称').max(120),
  department: z.string().trim().max(60).nullish(),
  location: z.string().trim().max(80).nullish(),
  work_mode: z.enum(['onsite', 'hybrid', 'remote']).optional(),
  employment_type: z.enum(['full_time', 'part_time', 'intern', 'contract']).optional(),
  level: z.string().trim().max(40).nullish(),
  headcount: z.number().int().min(1).max(999).optional(),
  salary_min: z.number().int().min(0).nullish(),
  salary_max: z.number().int().min(0).nullish(),
  description: z.string().max(20000).nullish(),
  requirements: z.string().max(20000).nullish(),
  skills: z.array(z.string()).optional(),
  owner_id: z.string().nullish(),
  status: z.enum(['open', 'paused', 'closed']).optional(),
});

export async function jobRoutes(app: FastifyInstance) {
  app.get('/api/jobs', async (request) => {
    requireUser(request);
    const query = request.query as { status?: string; q?: string; ownerId?: string };
    return listJobs({ status: query.status, q: query.q, ownerId: query.ownerId });
  });

  app.get('/api/job-options', async (request) => {
    requireUser(request);
    return { items: jobOptions() };
  });

  app.post('/api/jobs', async (request, reply) => {
    const user = requireRecruiter(request);
    const parsed = jobSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? '职位信息不完整');
    const job = createJob(parsed.data as JobInput, user.id);
    queueProfile(job.id, user.id);
    reply.code(201);
    return { job };
  });

  app.get('/api/jobs/:jobId', async (request) => {
    requireUser(request);
    const { jobId } = request.params as { jobId: string };
    return getJob(jobId);
  });

  app.patch('/api/jobs/:jobId', async (request) => {
    const user = requireRecruiter(request);
    const { jobId } = request.params as { jobId: string };
    const parsed = jobSchema.partial().safeParse(request.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? '职位信息不正确');
    const keys = ['title', 'description', 'requirements', 'skills', 'level'] as const;
    const previous = keys.some((key) => key in parsed.data) ? getJob(jobId).job : null;
    const job = updateJob(jobId, parsed.data as Partial<JobInput>, user.id);
    if (previous && keys.some((key) => key in parsed.data &&
      JSON.stringify(previous[key]) !== JSON.stringify(key === 'skills' ? jsonParse(job.skills, []) : job[key]))) {
      queueProfile(job.id, user.id);
    }
    return { job };
  });

  // 删除职位会连带清理其下的投递与面试，只允许管理员执行
  app.delete('/api/jobs/:jobId', async (request) => {
    const user = requireAdmin(request);
    const { jobId } = request.params as { jobId: string };
    deleteJob(jobId, user.id);
    return { ok: true };
  });

  app.get('/api/jobs/:jobId/board', async (request) => {
    requireUser(request);
    const { jobId } = request.params as { jobId: string };
    return board(jobId);
  });
}