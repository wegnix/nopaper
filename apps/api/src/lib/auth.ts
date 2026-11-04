import { createHash, randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import { SignJWT, jwtVerify } from 'jose';
import { and, eq } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ALL_PERMISSIONS, type Permission } from '@nopaper/shared';
import { env } from '../env.js';
import { db, schema } from '../db/client.js';
import { forbidden, unauthorized, HttpError } from './errors.js';
import { isSessionIdle } from './security.js';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  isSuperadmin: boolean;
  sessionId: string;
  mustChangePassword?: boolean;
}

export interface OrgContext {
  id: string;
  name: string;
  kind: string;
  timezone: string;
  membershipId: string;
  isOwner: boolean;
  isAdmin: boolean;
  permissions: Set<Permission>;
  can(p: Permission): boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthUser;
    org?: OrgContext;
  }
}

const secret = new TextEncoder().encode(env.JWT_SECRET);
export const ACCESS_TTL_SECONDS = 15 * 60;
export const REFRESH_TTL_DAYS = 30;

export const hashPassword = (pw: string) => argon2.hash(pw, { type: argon2.argon2id });
export const verifyPassword = (hash: string, pw: string) => argon2.verify(hash, pw).catch(() => false);

export async function signAccessToken(userId: string, sessionId: string) {
  return new SignJWT({ sid: sessionId })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TTL_SECONDS}s`)
    .setIssuer('nopaper')
    .sign(secret);
}

export const newRefreshToken = () => randomBytes(48).toString('base64url');
export const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

/** Hook global: popula req.user a partir do Bearer token (sem exigir). */
export async function authenticate(req: FastifyRequest) {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) return;
  try {
    const { payload } = await jwtVerify(h.slice(7), secret, { issuer: 'nopaper' });
    const userId = payload.sub as string;
    const sid = payload.sid as string;
    const [u] = await db.select({
      id: schema.users.id, email: schema.users.email, name: schema.users.name,
      isSuperadmin: schema.users.isSuperadmin, active: schema.users.active, mustChangePassword: schema.users.mustChangePassword,
      revokedAt: schema.sessions.revokedAt, lastActivityAt: schema.sessions.lastActivityAt,
    }).from(schema.users)
      .innerJoin(schema.sessions, eq(schema.sessions.userId, schema.users.id))
      .where(and(eq(schema.users.id, userId), eq(schema.sessions.id, sid)))
      .limit(1);
    if (!u || !u.active || u.revokedAt) return;
    // inatividade: o token de acesso ainda é válido, mas a sessão expirou — encerra no servidor
    if (await isSessionIdle(u.lastActivityAt)) {
      await db.update(schema.sessions).set({ revokedAt: new Date() }).where(eq(schema.sessions.id, sid));
      return;
    }
    req.user = { id: u.id, email: u.email, name: u.name, isSuperadmin: u.isSuperadmin, sessionId: sid, mustChangePassword: u.mustChangePassword };
  } catch {
    /* token inválido/expirado -> segue anônimo */
  }
}

export async function loadOrgContext(userId: string, orgId: string): Promise<OrgContext | null> {
  const [m] = await db.select({
    membershipId: schema.memberships.id, isOwner: schema.memberships.isOwner, active: schema.memberships.active,
    orgId: schema.organizations.id, name: schema.organizations.name, kind: schema.organizations.kind,
    timezone: schema.organizations.timezone,
  }).from(schema.memberships)
    .innerJoin(schema.organizations, eq(schema.organizations.id, schema.memberships.orgId))
    .where(and(eq(schema.memberships.userId, userId), eq(schema.memberships.orgId, orgId)))
    .limit(1);
  if (!m || !m.active) return null;
  const gs = await db.select({ isAdmin: schema.groups.isAdmin, permissions: schema.groups.permissions })
    .from(schema.membershipGroups)
    .innerJoin(schema.groups, eq(schema.groups.id, schema.membershipGroups.groupId))
    .where(eq(schema.membershipGroups.membershipId, m.membershipId));
  const isAdmin = m.isOwner || gs.some((g) => g.isAdmin);
  const perms = new Set<Permission>(isAdmin ? ALL_PERMISSIONS : (gs.flatMap((g) => g.permissions) as Permission[]));
  return {
    id: m.orgId, name: m.name, kind: m.kind, timezone: m.timezone, membershipId: m.membershipId,
    isOwner: m.isOwner, isAdmin, permissions: perms, can: (p) => perms.has(p),
  };
}

/** Com senha provisória, só dá para ver o próprio perfil, trocar a senha e sair. */
const PASSWORD_CHANGE_ALLOWED = new Set(['/api/auth/me', '/api/auth/password', '/api/auth/logout']);
function assertPasswordOk(req: FastifyRequest) {
  if (req.user?.mustChangePassword && !PASSWORD_CHANGE_ALLOWED.has(req.routeOptions.url ?? '')) {
    throw new HttpError(403, 'Troque a senha provisória para continuar.', 'password_change_required');
  }
}

export async function requireAuth(req: FastifyRequest) {
  if (!req.user) throw unauthorized();
  assertPasswordOk(req);
}

/** Exige usuário autenticado + membro da organização do header `x-org-id`. */
export async function requireOrg(req: FastifyRequest) {
  if (!req.user) throw unauthorized();
  assertPasswordOk(req);
  const orgId = req.headers['x-org-id'];
  if (typeof orgId !== 'string' || !/^[0-9a-f-]{36}$/i.test(orgId)) throw new HttpError(400, 'Organização não informada', 'org_required');
  const ctx = await loadOrgContext(req.user.id, orgId);
  if (!ctx) throw forbidden('Você não pertence a esta organização');
  req.org = ctx;
}

export function requirePerm(...anyOf: Permission[]) {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    if (!req.org) await requireOrg(req);
    if (!anyOf.some((p) => req.org!.can(p))) throw forbidden();
  };
}

export async function requireSuperadmin(req: FastifyRequest) {
  if (!req.user) throw unauthorized();
  assertPasswordOk(req);
  if (!req.user.isSuperadmin) throw forbidden('Apenas administradores da plataforma');
}

export async function membershipsOf(userId: string) {
  const rows = await db.select({ orgId: schema.organizations.id, name: schema.organizations.name, kind: schema.organizations.kind })
    .from(schema.memberships)
    .innerJoin(schema.organizations, eq(schema.organizations.id, schema.memberships.orgId))
    .where(and(eq(schema.memberships.userId, userId), eq(schema.memberships.active, true)))
    .orderBy(schema.organizations.name);
  const out = [];
  for (const r of rows) {
    const ctx = await loadOrgContext(userId, r.orgId);
    if (ctx) out.push({ id: r.orgId, name: r.name, kind: r.kind, isOwner: ctx.isOwner, isAdmin: ctx.isAdmin, permissions: [...ctx.permissions] });
  }
  return out;
}

