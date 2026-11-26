import type { FastifyInstance, FastifyReply } from 'fastify';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import {
  SESSION_COOKIE,
  bindFeishuToUser,
  createSession,
  countUsers,
  destroySession,
  getUser,
  listTeam,
  registerUser,
  resolveFeishuLoginUser,
  resolveSession,
  setUserRole,
  unbindFeishuFromUser,
  updatePassword,
  verifyCredentials,
  type Role,
} from '../auth.ts';
import { requireAdmin, requireUser } from './guard.ts';
import { badRequest, forbidden } from '../lib/errors.ts';
import {
  buildFeishuAuthorizeUrl,
  exchangeFeishuOAuthCode,
  loginCapability,
  resolveFeishuPublicOrigin,
} from '../integrations/feishu.ts';
import { audit } from '../services/audit.ts';

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

const FEISHU_STATE_COOKIE = 'hl_feishu_oauth_state';
const FEISHU_STATE_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING_OAUTH_STATES = 500;

interface FeishuOAuthStateEntry {
  mode: 'login' | 'bind';
  bindUserId: string | null;
  expiresAt: number;
}

const feishuOAuthStates = new Map<string, FeishuOAuthStateEntry>();

function useSecureCookie(): boolean {
  // 生产默认要求 Secure（浏览器把 127.0.0.1 / localhost 也当可信来源，本地生产预览仍然可用）。
  // 如果要把服务发布到内网 http:// 上试用，启动时设 HIRELOOP_INSECURE_COOKIE=1。
  return process.env.NODE_ENV === 'production' && process.env.HIRELOOP_INSECURE_COOKIE !== '1';
}

function setSessionCookie(reply: FastifyReply, token: string) {
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: useSecureCookie(),
    maxAge: 30 * 24 * 60 * 60,
  });
}

function setFeishuStateCookie(reply: FastifyReply, state: string) {
  reply.setCookie(FEISHU_STATE_COOKIE, state, {
    path: '/api/auth/feishu',
    httpOnly: true,
    sameSite: 'lax',
    secure: useSecureCookie(),
    maxAge: Math.floor(FEISHU_STATE_TTL_MS / 1000),
  });
}

function purgeExpiredOAuthStates(): void {
  const nowMs = Date.now();
  for (const [key, entry] of feishuOAuthStates) {
    if (entry.expiresAt <= nowMs) feishuOAuthStates.delete(key);
  }
  while (feishuOAuthStates.size > MAX_PENDING_OAUTH_STATES) {
    const oldestKey = feishuOAuthStates.keys().next().value;
    if (!oldestKey) break;
    feishuOAuthStates.delete(oldestKey);
  }
}

function safeTokenEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

function clearFeishuStateCookie(reply: FastifyReply) {
  reply.clearCookie(FEISHU_STATE_COOKIE, {
    path: '/api/auth/feishu',
    httpOnly: true,
    sameSite: 'lax',
    secure: useSecureCookie(),
  });
}

export async function authRoutes(app: FastifyInstance) {
  app.get('/api/bootstrap', async (request) => {
    const user = request.user ? getUser(request.user.id) : null;
    return {
      hasUsers: countUsers() > 0,
      user,
      sessionCookie: SESSION_COOKIE,
      feishuLoginEnabled: loginCapability().enabled,
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

  app.get('/api/auth/feishu/start', async (request, reply) => {
    const querySchema = z.object({
      mode: z.enum(['login', 'bind']).default('login'),
    });
    const parsed = querySchema.safeParse(request.query ?? {});
    const mode = parsed.success ? parsed.data.mode : 'login';
    const fallbackPath = mode === 'bind' ? '/settings' : '/';

    if (!loginCapability().enabled) {
      return reply.redirect(`${fallbackPath}?feishu_error=not_configured`);
    }
    if (mode === 'bind' && !request.user) {
      return reply.redirect('/?feishu_error=bind_auth_required');
    }

    purgeExpiredOAuthStates();
    const state = randomBytes(24).toString('base64url');
    feishuOAuthStates.set(state, {
      mode,
      bindUserId: mode === 'bind' ? request.user!.id : null,
      expiresAt: Date.now() + FEISHU_STATE_TTL_MS,
    });
    setFeishuStateCookie(reply, state);

    const redirectUri = `${resolveFeishuPublicOrigin(request)}/api/auth/feishu/callback`;
    const authorizeUrl = buildFeishuAuthorizeUrl({ redirectUri, state });
    return reply.redirect(authorizeUrl);
  });

  app.get('/api/auth/feishu/callback', async (request, reply) => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    const code = typeof query.code === 'string' ? query.code.trim() : '';
    const state = typeof query.state === 'string' ? query.state.trim() : '';
    const oauthError = typeof query.error === 'string' ? query.error.trim() : '';
    const cookieState = request.cookies[FEISHU_STATE_COOKIE] ?? '';

    purgeExpiredOAuthStates();

    const entry = state ? feishuOAuthStates.get(state) : undefined;
    if (!state || !cookieState || !entry || !safeTokenEqual(state, cookieState)) {
      // 仅当客户端带上了已失效/不存在的旧 state Cookie 时清理，避免跨站子资源请求误清进行中的有效 Cookie
      if (cookieState && !feishuOAuthStates.has(cookieState)) {
        clearFeishuStateCookie(reply);
      }
      return reply.redirect('/?feishu_error=invalid_state');
    }

    feishuOAuthStates.delete(state);
    clearFeishuStateCookie(reply);
    const targetPath = entry.mode === 'bind' ? '/settings' : '/';

    if (oauthError) {
      return reply.redirect(`${targetPath}?feishu_error=cancelled`);
    }
    if (!code) {
      return reply.redirect(`${targetPath}?feishu_error=missing_code`);
    }
    if (entry.mode === 'bind' && (!request.user || request.user.id !== entry.bindUserId)) {
      return reply.redirect('/?feishu_error=bind_auth_required');
    }

    let identity: Awaited<ReturnType<typeof exchangeFeishuOAuthCode>>;
    try {
      identity = await exchangeFeishuOAuthCode(code);
    } catch {
      return reply.redirect(`${targetPath}?feishu_error=oauth_failed`);
    }

    if (entry.mode === 'bind') {
      const result = bindFeishuToUser(entry.bindUserId!, identity);
      if (!result.ok) {
        const errCode = result.code === 'already_bound_other' ? 'already_bound_other' : 'bind_failed';
        return reply.redirect(`/settings?feishu_error=${errCode}`);
      }
      audit({
        actorId: result.user.id,
        action: 'feishu.account.bind',
        entityType: 'user',
        entityId: result.user.id,
        detail: { alreadyBound: result.alreadyBound },
      });
      return reply.redirect('/settings?feishu_notice=bound');
    }

    const matched = resolveFeishuLoginUser(identity);
    if (!matched.ok) {
      audit({
        actorId: null,
        action: 'feishu.login.rejected',
        entityType: 'auth',
        entityId: 'feishu',
        detail: { reason: matched.code },
      });
      return reply.redirect(`/?feishu_error=${matched.code}`);
    }

    const { token } = createSession(matched.user.id);
    setSessionCookie(reply, token);
    audit({
      actorId: matched.user.id,
      action: 'feishu.login.success',
      entityType: 'user',
      entityId: matched.user.id,
      detail: { matchedBy: matched.matchedBy, linkedNow: matched.linkedNow },
    });
    return reply.redirect('/?feishu_notice=logged_in');
  });

  app.post('/api/auth/feishu/unbind', async (request) => {
    const actor = requireUser(request);
    const schema = z
      .object({
        userId: z.string().min(1).optional(),
      })
      .optional();
    const parsed = schema.safeParse(request.body ?? {});
    if (!parsed.success) throw badRequest('参数不正确');

    const targetUserId = parsed.data?.userId ?? actor.id;
    if (targetUserId !== actor.id && actor.role !== 'admin') {
      throw forbidden('只有管理员可以解绑其他成员的飞书账号');
    }

    const result = unbindFeishuFromUser(targetUserId);
    audit({
      actorId: actor.id,
      action: 'feishu.account.unbind',
      entityType: 'user',
      entityId: targetUserId,
      detail: { unbound: result.unbound, byAdmin: targetUserId !== actor.id },
    });
    return {
      ok: true,
      user: result.user,
      unbound: result.unbound,
      items: listTeam(),
    };
  });
}