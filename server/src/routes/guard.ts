import type { FastifyRequest } from 'fastify';
import type { SessionUser } from '../auth.ts';
import { forbidden, unauthorized } from '../lib/errors.ts';

export function requireUser(request: FastifyRequest): SessionUser {
  if (!request.user) throw unauthorized();
  return request.user;
}

export function requireAdmin(request: FastifyRequest): SessionUser {
  const user = requireUser(request);
  if (user.role !== 'admin') throw forbidden('仅管理员可以执行该操作');
  return user;
}

export function requireRecruiter(request: FastifyRequest): SessionUser {
  const user = requireUser(request);
  if (user.role === 'hiring_manager') throw forbidden('当前账号仅可查看招聘流程');
  return user;
}

export function parseList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) return value.map((item) => String(item)).filter(Boolean);
  if (typeof value === 'string' && value.trim()) {
    return value
      .split(/[,，、]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return undefined;
}