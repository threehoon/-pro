import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AppError } from './lib/errors.ts';
import { SESSION_COOKIE, resolveSession } from './auth.ts';
import { AUDIO_MAX_BYTES } from './constants.ts';
import { authRoutes } from './routes/auth.ts';
import { jobRoutes } from './routes/jobs.ts';
import { candidateRoutes } from './routes/candidates.ts';
import { applicationRoutes } from './routes/applications.ts';
import { interviewRoutes } from './routes/interviews.ts';
import { workspaceRoutes } from './routes/workspace.ts';
import { uploadRoutes } from './routes/uploads.ts';
import { bitableRoutes } from './routes/bitable.ts';
import { recruitmentAiRoutes } from './routes/recruitment-ai.ts';

interface ClientError {
  statusCode: number;
  code: string;
  message: string;
}

const CLIENT_ERROR_MESSAGES: Record<string, string> = {
  FST_ERR_CTP_INVALID_MEDIA_TYPE: '不支持的请求格式',
  FST_ERR_CTP_BODY_TOO_LARGE: '请求内容过大',
  FST_ERR_CTP_EMPTY_JSON_BODY: '请求体不能为空',
  FST_ERR_CTP_INVALID_JSON_BODY: '请求体不是合法的 JSON',
  FST_REQ_FILE_TOO_LARGE: '文件超过 8MB 上限',
  FST_INVALID_MULTIPART_CONTENT_TYPE: '请用 multipart/form-data 上传文件',
  FST_FILES_LIMIT: '一次只能上传一个文件',
};

function clientErrorOf(error: unknown): ClientError | null {
  if (!error || typeof error !== 'object') return null;
  const { statusCode, code } = error as { statusCode?: number; code?: string };
  if (typeof statusCode !== 'number' || statusCode < 400 || statusCode >= 500) return null;
  const known = code ? CLIENT_ERROR_MESSAGES[code] : undefined;
  const message = known ?? (error instanceof Error ? error.message : '请求不正确');
  return { statusCode, code: code ?? 'bad_request', message };
}

const here = path.dirname(fileURLToPath(import.meta.url));
const webDist = path.resolve(here, '../../web/dist');

export async function buildApp(options: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger
      ? { transport: undefined, level: 'info' }
      : false,
    bodyLimit: 2 * 1024 * 1024,
  });

  await app.register(cookie);
  await app.register(multipart, {
    // 面试录音比简历大，上限按录音定；简历的 8 MB 限制由上传接口自己再卡一次。
    limits: { fileSize: AUDIO_MAX_BYTES, files: 1 },
  });

  app.decorateRequest('user', null);

  app.addHook('onRequest', async (request) => {
    request.user = resolveSession(request.cookies[SESSION_COOKIE]) ?? null;
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      reply.code(error.statusCode).send({
        error: { code: error.code, message: error.message, details: error.details ?? null },
      });
      return;
    }

    // Fastify 自身的请求错误（请求体过大、JSON 语法错、Content-Type 不匹配等）是客户端问题，
    // 不要一律回 500，否则排查时会把 4xx 误判成服务故障。
    const clientError = clientErrorOf(error);
    if (clientError) {
      reply.code(clientError.statusCode).send({
        error: { code: clientError.code, message: clientError.message, details: null },
      });
      return;
    }

    request.log.error(error);
    reply.code(500).send({
      error: { code: 'internal_error', message: '服务器开小差了，请稍后重试', details: null },
    });
  });

  await app.register(authRoutes);
  await app.register(jobRoutes);
  await app.register(candidateRoutes);
  await app.register(applicationRoutes);
  await app.register(interviewRoutes);
  await app.register(workspaceRoutes);
  await app.register(uploadRoutes);
  await app.register(recruitmentAiRoutes);
  await app.register(bitableRoutes);

  app.get('/api/health', async () => ({ ok: true, time: new Date().toISOString() }));

  if (existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist });
    app.setNotFoundHandler((request, reply) => {
      if (request.method === 'GET' && !request.url.startsWith('/api/')) {
        return reply.type('text/html').sendFile('index.html');
      }
      reply.code(404).send({ error: { code: 'not_found', message: '接口不存在' } });
    });
  }

  return app;
}