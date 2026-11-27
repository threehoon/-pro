import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { activeLlmConfig, llmSettings, parseLlmSettings, saveLlmSettings, THINKING_POLICIES } from '../integrations/llm.ts';
import { badRequest } from '../lib/errors.ts';
import {
  approveProfile, editProfile, getComposite, getProfile, getScreening, getSummary, manualSummary, putTranscript,
  queueProfile, queueScreening, retryComposite, retrySummary, testLlm, updateLabel,
} from '../services/recruitment-ai.ts';
import { levels, suggestedDecision } from '../services/recruitment-evidence.ts';
import { requireAdmin, requireRecruiter, requireUser } from './guard.ts';

const settingsInput = z.object({
  baseUrl: z.string().trim().max(500).optional(), base_url: z.string().trim().max(500).optional(),
  model: z.string().trim().max(128).optional(), apiKey: z.string().max(1024).optional(), api_key: z.string().max(1024).optional(),
  thinking: z.enum(THINKING_POLICIES).optional(),
});
const profileInput = z.object({ content: z.unknown() });
const approvalInput = z.object({ profileId: z.string().min(1).max(150).optional() });
const labelInput = z.object({ indicator: z.string().min(1).max(100), label: z.string().min(1).max(800), level: levels });
const transcriptInput = z.object({ transcript: z.string().max(250_000), transcript_source: z.literal('paste').optional() });
const manualInput = z.object({
  headline: z.string().trim().min(1).max(800).optional(), conclusion: z.string().trim().min(1).max(800).optional(),
  suggested: suggestedDecision.optional(),
});

function body<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw badRequest('请检查提交的内容');
  return parsed.data;
}

function settingsBody(input: unknown) {
  const data = body(settingsInput, input);
  return { baseUrl: data.baseUrl ?? data.base_url, model: data.model, apiKey: data.apiKey ?? data.api_key, thinking: data.thinking };
}

function result<T extends { status?: string; reason?: string; dropped?: number }>(value: T) {
  const { reason, dropped, ...data } = value;
  return { ok: value.status !== 'failed' && !reason, data, ...(reason ? { reason } : {}), ...(dropped ? { dropped } : {}) };
}

type WithId = { Params: { id: string } };

export async function recruitmentAiRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/settings/llm', async (request) => {
    requireUser(request);
    return { ok: true, data: llmSettings() };
  });
  app.post('/api/settings/llm', async (request) => {
    const actor = requireAdmin(request);
    return { ok: true, data: saveLlmSettings(settingsBody(request.body), actor.id) };
  });
  app.post('/api/settings/llm/test', async (request) => {
    const actor = requireAdmin(request);
    const config = request.body === undefined ? activeLlmConfig() : parseLlmSettings(settingsBody(request.body));
    return testLlm(actor.id, config?.apiKey ? config : undefined);
  });

  app.get<WithId>('/api/jobs/:id/profile', async (request) => {
    requireUser(request);
    return result(getProfile(request.params.id));
  });
  app.put<WithId>('/api/jobs/:id/profile', async (request) => {
    const actor = requireRecruiter(request);
    const { content } = body(profileInput, request.body);
    return result(editProfile(request.params.id, actor.id, content));
  });
  app.post<WithId>('/api/jobs/:id/profile/generate', async (request) => {
    const actor = requireRecruiter(request);
    const { id } = request.params;
    getProfile(id);
    queueProfile(id, actor.id);
    return result(getProfile(id));
  });
  app.post<WithId>('/api/jobs/:id/profile/approve', async (request) => {
    const actor = requireRecruiter(request);
    const { profileId } = body(approvalInput, request.body ?? {});
    return result(approveProfile(request.params.id, actor.id, profileId));
  });

  app.get<WithId>('/api/applications/:id/screening', async (request) => {
    requireUser(request);
    return result(getScreening(request.params.id));
  });
  app.post<WithId>('/api/applications/:id/screen', async (request) => {
    const actor = requireRecruiter(request);
    const { id } = request.params;
    getScreening(id);
    queueScreening(id, actor.id);
    return result(getScreening(id));
  });
  app.patch<WithId>('/api/screening/:id/label', async (request) => {
    const actor = requireRecruiter(request);
    return result(updateLabel(request.params.id, actor.id, body(labelInput, request.body)));
  });

  app.put<WithId>('/api/interviews/:id/transcript', async (request) => {
    const actor = requireRecruiter(request);
    const { transcript, transcript_source } = body(transcriptInput, request.body);
    const { reason, ...data } = putTranscript(request.params.id, actor.id, transcript, transcript_source);
    return { ok: true, data, ...(reason ? { reason } : {}) };
  });
  app.get<WithId>('/api/interviews/:id/summary', async (request) => {
    requireUser(request);
    return result(getSummary(request.params.id));
  });
  app.post<WithId>('/api/interviews/:id/summary/retry', async (request) => {
    const actor = requireRecruiter(request);
    return result(retrySummary(request.params.id, actor.id));
  });
  app.post<WithId>('/api/interviews/:id/summary/manual', async (request) => {
    const actor = requireRecruiter(request);
    const { headline, conclusion, suggested } = body(manualInput, request.body);
    const text = headline ?? conclusion;
    if (!text) throw badRequest('请填写一句话结论');
    return result(manualSummary(request.params.id, actor.id, text, suggested ?? null));
  });

  app.get<WithId>('/api/applications/:id/composite', async (request) => {
    requireUser(request);
    return result(getComposite(request.params.id));
  });
  app.post<WithId>('/api/applications/:id/composite/retry', async (request) => {
    const actor = requireRecruiter(request);
    return result(retryComposite(request.params.id, actor.id));
  });
}
