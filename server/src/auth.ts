import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { all, getRow, run, transaction } from './db/index.ts';
import { sha256, id, now } from './lib/util.ts';
import { badRequest, notFound, unauthorized } from './lib/errors.ts';

export const SESSION_COOKIE = 'hl_session';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;
const BCRYPT_ROUNDS = 10;

export type Role = 'admin' | 'recruiter' | 'hiring_manager';

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  username: string | null;
  role: Role;
  title: string | null;
  feishu_open_id: string | null;
}

interface UserRow {
  id: string;
  name: string;
  email: string;
  username: string | null;
  password_hash: string;
  role: Role;
  title: string | null;
  feishu_open_id: string | null;
  feishu_union_id: string | null;
  created_at: string;
  last_login_at: string | null;
}

export function countUsers(): number {
  return getRow<{ n: number }>('SELECT COUNT(*) AS n FROM users')?.n ?? 0;
}

export function publicUser(row: UserRow): SessionUser {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    username: row.username,
    role: row.role,
    title: row.title,
    feishu_open_id: row.feishu_open_id,
  };
}

export async function registerUser(input: {
  name: string;
  email: string;
  password: string;
  role?: Role;
}): Promise<SessionUser> {
  const email = input.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw badRequest('邮箱格式不正确');
  if (input.password.length < 8) throw badRequest('密码至少 8 位');
  if (!input.name.trim()) throw badRequest('请填写姓名');
  const exists = getRow('SELECT id FROM users WHERE email = ?', [email]);
  if (exists) throw badRequest('该邮箱已注册');

  // 哈希是唯一异步步骤，放在事务之外；事务内重新判断是否为首位用户，
  // 避免两次并发注册都读到 count=0 而各建一个管理员。
  const hash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);
  const userId = id('usr');
  transaction(() => {
    const isFirst = countUsers() === 0;
    if (getRow('SELECT id FROM users WHERE email = ?', [email])) {
      throw badRequest('该邮箱已注册');
    }
    const role: Role = isFirst ? 'admin' : (input.role ?? 'recruiter');
    run(
      `INSERT INTO users (id, name, email, password_hash, role, title, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [userId, input.name.trim(), email, hash, role, isFirst ? '招聘负责人' : null, now()],
    );
  });
  const row = getRow<UserRow>('SELECT * FROM users WHERE id = ?', [userId])!;
  return publicUser(row);
}

/**
 * 登录标识既可以是邮箱，也可以是设置过的短账号名（演示账号就是 `123`）。
 * 两者都不区分大小写；账号名只做精确匹配，不做模糊查找。
 */
export async function verifyCredentials(identifierInput: string, password: string): Promise<SessionUser> {
  const identifier = identifierInput.trim().toLowerCase();
  if (!identifier) throw unauthorized('账号或密码不正确');
  const row = getRow<UserRow>('SELECT * FROM users WHERE email = ? OR (username IS NOT NULL AND username = ?)', [
    identifier,
    identifier,
  ]);
  if (!row) throw unauthorized('账号或密码不正确');
  const ok = await bcrypt.compare(password, row.password_hash);
  if (!ok) throw unauthorized('账号或密码不正确');
  run('UPDATE users SET last_login_at = ? WHERE id = ?', [now(), row.id]);
  return publicUser(row);
}

export function createSession(userId: string): { token: string; expiresAt: string } {
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  run('INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)', [
    id('ses'),
    userId,
    sha256(token),
    expiresAt,
    now(),
  ]);
  return { token, expiresAt };
}

export function resolveSession(token: string | undefined): SessionUser | null {
  if (!token) return null;
  const row = getRow<UserRow & { expires_at: string }>(
    `SELECT u.*, s.expires_at FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ?`,
    [sha256(token)],
  );
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    destroySession(token);
    return null;
  }
  return publicUser(row);
}

export function destroySession(token: string | undefined): void {
  if (!token) return;
  run('DELETE FROM sessions WHERE token_hash = ?', [sha256(token)]);
}

export function purgeExpiredSessions(): void {
  run('DELETE FROM sessions WHERE expires_at < ?', [now()]);
}

export function updatePassword(userId: string, currentPassword: string, nextPassword: string): Promise<void> {
  return (async () => {
    const row = getRow<UserRow>('SELECT * FROM users WHERE id = ?', [userId]);
    if (!row) throw unauthorized();
    const ok = await bcrypt.compare(currentPassword, row.password_hash);
    if (!ok) throw badRequest('当前密码不正确');
    if (nextPassword.length < 8) throw badRequest('新密码至少 8 位');
    const hash = await bcrypt.hash(nextPassword, BCRYPT_ROUNDS);
    run('UPDATE users SET password_hash = ? WHERE id = ?', [hash, userId]);
    run('DELETE FROM sessions WHERE user_id = ?', [userId]);
  })();
}

export function listTeam() {
  return all<UserRow>(
    `SELECT id, name, email, username, role, title, feishu_open_id, created_at, last_login_at
     FROM users ORDER BY created_at ASC`,
  );
}

export function setUserRole(userId: string, role: Role): void {
  const target = getRow<{ role: Role }>('SELECT role FROM users WHERE id = ?', [userId]);
  if (!target) throw notFound('成员不存在');
  if (target.role === 'admin' && role !== 'admin' && countAdmins() <= 1) {
    throw badRequest('至少要保留一名管理员');
  }
  run('UPDATE users SET role = ? WHERE id = ?', [role, userId]);
}

export function countAdmins(): number {
  return getRow<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'")?.n ?? 0;
}

export function getUser(userId: string): SessionUser | null {
  const row = getRow<UserRow>('SELECT * FROM users WHERE id = ?', [userId]);
  return row ? publicUser(row) : null;
}

export interface FeishuIdentity {
  openId: string;
  unionId?: string | null;
  name?: string | null;
  email?: string | null;
  enterpriseEmail?: string | null;
}

export type FeishuLoginMatchResult =
  | { ok: true; user: SessionUser; matchedBy: 'open_id' | 'union_id' | 'email'; linkedNow: boolean }
  | { ok: false; code: 'account_not_found' | 'email_bound_other' | 'feishu_conflict' };

export type FeishuBindResult =
  | { ok: true; user: SessionUser; alreadyBound: boolean }
  | { ok: false; code: 'user_not_found' | 'already_bound_other' };

function candidateFeishuEmails(identity: FeishuIdentity): string[] {
  const seen = new Set<string>();
  for (const raw of [identity.enterpriseEmail, identity.email]) {
    if (typeof raw !== 'string') continue;
    const normalized = raw.trim().toLowerCase();
    if (normalized) seen.add(normalized);
  }
  return Array.from(seen);
}

/**
 * 飞书扫码登录身份映射（选项 A：不自动建号）：
 * 依次按 feishu_open_id → feishu_union_id → 企业邮箱/个人邮箱 匹配既有工作台成员。
 */
export function resolveFeishuLoginUser(identity: FeishuIdentity): FeishuLoginMatchResult {
  const openId = identity.openId.trim();
  const unionId = identity.unionId?.trim() || null;
  if (!openId) return { ok: false, code: 'account_not_found' };

  return transaction<FeishuLoginMatchResult>(() => {
    const byOpenId = getRow<UserRow>('SELECT * FROM users WHERE feishu_open_id = ?', [openId]);
    if (byOpenId) {
      let nextUnionId = byOpenId.feishu_union_id;
      if (unionId && !nextUnionId) {
        const unionOwner = getRow<{ id: string }>('SELECT id FROM users WHERE feishu_union_id = ? AND id != ?', [
          unionId,
          byOpenId.id,
        ]);
        if (!unionOwner) nextUnionId = unionId;
      }
      run('UPDATE users SET feishu_union_id = ?, last_login_at = ? WHERE id = ?', [nextUnionId, now(), byOpenId.id]);
      const updated = getRow<UserRow>('SELECT * FROM users WHERE id = ?', [byOpenId.id])!;
      return { ok: true, user: publicUser(updated), matchedBy: 'open_id', linkedNow: false };
    }

    if (unionId) {
      const byUnionId = getRow<UserRow>('SELECT * FROM users WHERE feishu_union_id = ?', [unionId]);
      if (byUnionId) {
        if (byUnionId.feishu_open_id && byUnionId.feishu_open_id !== openId) {
          return { ok: false, code: 'feishu_conflict' };
        }
        const linkedNow = !byUnionId.feishu_open_id;
        run('UPDATE users SET feishu_open_id = ?, last_login_at = ? WHERE id = ?', [openId, now(), byUnionId.id]);
        const updated = getRow<UserRow>('SELECT * FROM users WHERE id = ?', [byUnionId.id])!;
        return { ok: true, user: publicUser(updated), matchedBy: 'union_id', linkedNow };
      }
    }

    for (const candidateEmail of candidateFeishuEmails(identity)) {
      const byEmail = getRow<UserRow>('SELECT * FROM users WHERE email = ?', [candidateEmail]);
      if (!byEmail) continue;
      if (byEmail.feishu_open_id && byEmail.feishu_open_id !== openId) {
        return { ok: false, code: 'email_bound_other' };
      }
      if (byEmail.feishu_union_id && (!unionId || byEmail.feishu_union_id !== unionId)) {
        return { ok: false, code: 'email_bound_other' };
      }
      run('UPDATE users SET feishu_open_id = ?, feishu_union_id = COALESCE(?, feishu_union_id), last_login_at = ? WHERE id = ?', [
        openId,
        unionId,
        now(),
        byEmail.id,
      ]);
      const updated = getRow<UserRow>('SELECT * FROM users WHERE id = ?', [byEmail.id])!;
      return { ok: true, user: publicUser(updated), matchedBy: 'email', linkedNow: true };
    }

    return { ok: false, code: 'account_not_found' };
  });
}

/** 将飞书身份绑定到已登录的工作台账号，校验同一飞书身份不能重复绑给其他成员 */
export function bindFeishuToUser(userId: string, identity: FeishuIdentity): FeishuBindResult {
  const openId = identity.openId.trim();
  const unionId = identity.unionId?.trim() || null;
  if (!openId) return { ok: false, code: 'user_not_found' };

  return transaction<FeishuBindResult>(() => {
    const target = getRow<UserRow>('SELECT * FROM users WHERE id = ?', [userId]);
    if (!target) return { ok: false, code: 'user_not_found' };

    const openOwner = getRow<{ id: string }>('SELECT id FROM users WHERE feishu_open_id = ? AND id != ?', [
      openId,
      userId,
    ]);
    if (openOwner) return { ok: false, code: 'already_bound_other' };

    if (unionId) {
      const unionOwner = getRow<{ id: string }>('SELECT id FROM users WHERE feishu_union_id = ? AND id != ?', [
        unionId,
        userId,
      ]);
      if (unionOwner) return { ok: false, code: 'already_bound_other' };
    }

    const nextUnionId = target.feishu_open_id === openId ? (unionId ?? target.feishu_union_id ?? null) : unionId;
    const alreadyBound = target.feishu_open_id === openId && target.feishu_union_id === nextUnionId;
    if (!alreadyBound) {
      run('UPDATE users SET feishu_open_id = ?, feishu_union_id = ? WHERE id = ?', [
        openId,
        nextUnionId,
        userId,
      ]);
    }
    const updated = getRow<UserRow>('SELECT * FROM users WHERE id = ?', [userId])!;
    return { ok: true, user: publicUser(updated), alreadyBound };
  });
}

/** 解除指定工作台账号的飞书绑定 */
export function unbindFeishuFromUser(userId: string): { user: SessionUser; unbound: boolean } {
  const target = getRow<UserRow>('SELECT * FROM users WHERE id = ?', [userId]);
  if (!target) throw notFound('成员不存在');
  if (!target.feishu_open_id && !target.feishu_union_id) {
    return { user: publicUser(target), unbound: false };
  }
  run('UPDATE users SET feishu_open_id = NULL, feishu_union_id = NULL WHERE id = ?', [userId]);
  const updated = getRow<UserRow>('SELECT * FROM users WHERE id = ?', [userId])!;
  return { user: publicUser(updated), unbound: true };
}