import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  SESSION_COOKIE,
  createSession,
  countUsers,
  destroySession,
  getUser,
  listTeam,
  registerUser,
  resolveSession,
  setUserRole,
  updatePassword,
  verifyCredentials,
  type Role,
} from '../auth.ts';
import { requireAdmin, requireUser } from './guard.ts';
import { badRequest } from '../lib/errors.ts';

const registerSchema = z.object({
  name: z.string().trim().min(1, '请填写姓名').max(40),
  email: z.string().trim().email('邮箱格式不正确'),
  password: z.string().min(8, '密码至少 8 位').max(72),
});

// 字段名沿用 email 以兼容既有调用方；值可以是邮箱，也可以是账号名（如 123）
const loginSchema = z.object({
  email: z.string().trim().min(1, '请填写账号').max(120, '账号太长'),
  password: z.string().min(1, '请填写密码'),
});

function setSessionCookie(reply: import('fastify').FastifyReply, token: string) {
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    // 生产默认要求 Secure（浏览器把 127.0.0.1 / localhost 也当可信来源，本地生产预览仍然可用）。
    // 如果要把服务发布到内网 http:// 上试用，启动时设 HIRELOOP_INSECURE_COOKIE=1。
    secure: process.env.NODE_ENV === 'production' && process.env.HIRELOOP_INSECURE_COOKIE !== '1',
    maxAge: 30 * 24 * 60 * 60,
  });
}

export async function authRoutes(app: FastifyInstance) {
  app.get('/api/bootstrap', async (request) => {
    const user = request.user ? getUser(request.user.id) : null;
    return {
      hasUsers: countUsers() > 0,
      user,
      sessionCookie: SESSION_COOKIE,
    };
  });

  // 只有「系统还没有任何用户」时允许自助注册首位管理员；
  // 之后新增成员必须由已登录的管理员创建，避免外部人员注册后读到全部候选人。
  app.post('/api/auth/register', async (request, reply) => {
    const bootstrap = countUsers() === 0;
    if (!bootstrap) requireAdmin(request);
    const parsed = registerSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? '参数不正确');

    const user = await registerUser(parsed.data);
    if (bootstrap) {
      const { token } = createSession(user.id);
      setSessionCookie(reply, token);
    }
    return { user };
  });

  // 管理员在设置页添加团队成员（不切换当前登录态）
  app.post('/api/team', async (request, reply) => {
    requireAdmin(request);
    const schema = registerSchema.extend({
      role: z.enum(['admin', 'recruiter', 'hiring_manager']).optional(),
    });
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? '参数不正确');
    const user = await registerUser(parsed.data);
    reply.code(201);
    return { user, items: listTeam() };
  });

  app.post('/api/auth/login', async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? '参数不正确');

    const user = await verifyCredentials(parsed.data.email, parsed.data.password);
    const { token } = createSession(user.id);
    setSessionCookie(reply, token);
    return { user };
  });

  app.post('/api/auth/logout', async (request, reply) => {
    destroySession(request.cookies[SESSION_COOKIE]);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', async (request) => {
    const user = resolveSession(request.cookies[SESSION_COOKIE]);
    if (!user) return { user: null };
    return { user: getUser(user.id) };
  });

  app.post('/api/auth/password', async (request) => {
    const user = requireUser(request);
    const schema = z.object({
      currentPassword: z.string().min(1, '请填写当前密码'),
      nextPassword: z.string().min(8, '新密码至少 8 位').max(72),
    });
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? '参数不正确');
    await updatePassword(user.id, parsed.data.currentPassword, parsed.data.nextPassword);
    return { ok: true };
  });

  app.get('/api/team', async (request) => {
    requireUser(request);
    return { items: listTeam() };
  });

  app.patch('/api/team/:userId/role', async (request) => {
    requireAdmin(request);
    const { userId } = request.params as { userId: string };
    const schema = z.object({ role: z.enum(['admin', 'recruiter', 'hiring_manager']) });
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) throw badRequest('角色不正确');
    setUserRole(userId, parsed.data.role as Role);
    return { ok: true, items: listTeam() };
  });
}