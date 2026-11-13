import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { loginSchema, changePasswordSchema, preferencesSchema, profileSchema } from '@nopaper/shared';
import { db, schema } from '../db/client.js';
import { env, isProd } from '../env.js';
import { parse } from '../lib/validate.js';
import { HttpError, badRequest, conflict, forbidden, unauthorized } from '../lib/errors.js';
import {
  hashPassword, verifyPassword, signAccessToken, newRefreshToken, hashToken, REFRESH_TTL_DAYS, dummyPasswordHash,
  requireAuth, membershipsOf, ACCESS_TTL_SECONDS,
} from '../lib/auth.js';
import { createInitialOrg, needsInitialOrg } from '../services/bootstrap.js';
import { audit } from '../lib/audit.js';
import { APP_VERSION } from '../lib/version.js';
import { clearLoginFailures, isSessionIdle, loginLockedFor, registerLoginFailure, securitySettings } from '../lib/security.js';

const COOKIE = 'np_refresh';
const cookieOpts = {
  httpOnly: true, secure: isProd, sameSite: 'strict' as const, path: '/api/auth',
  maxAge: REFRESH_TTL_DAYS * 86400,
};

async function startSession(req: FastifyRequest, reply: FastifyReply, userId: string) {
  const refresh = newRefreshToken();
  const [s] = await db.insert(schema.sessions).values({
    userId, refreshHash: hashToken(refresh),
    userAgent: req.headers['user-agent']?.slice(0, 255), ip: req.ip,
    expiresAt: new Date(Date.now() + REFRESH_TTL_DAYS * 86400_000),
  }).returning();
  reply.setCookie(COOKIE, `${s.id}.${refresh}`, cookieOpts);
  return { accessToken: await signAccessToken(userId, s.id, s.rotation), expiresIn: ACCESS_TTL_SECONDS };
}

/**
 * Confere a senha atual em ações da conta logada (trocar e-mail, trocar senha), com os mesmos
 * contadores do login: um token de acesso roubado não vira tentativa ilimitada de senha.
 */
async function assertCurrentPassword(req: FastifyRequest, u: { id: string; passwordHash: string }, password: string | null | undefined, message: string, code?: string) {
  const locked = loginLockedFor(u.id, req.ip);
  if (locked) throw new HttpError(429, `Muitas tentativas. Tente de novo em ${Math.ceil(locked / 60)} min.`, 'login_locked');
  if (password && (await verifyPassword(u.passwordHash, password))) { clearLoginFailures(u.id, req.ip); return; }
  if (password) registerLoginFailure(u.id, req.ip);
  throw badRequest(message, code);
}

export async function assertUsernameFree(username: string, exceptUserId?: string) {
  const [taken] = await db.select({ id: schema.users.id }).from(schema.users).where(sql`lower(${schema.users.username}) = ${username.toLowerCase()}`);
  if (taken && taken.id !== exceptUserId) throw conflict('Este nome de usuário já está em uso. Escolha outro.');
}

export async function assertEmailFree(email: string, exceptUserId?: string) {
  const [taken] = await db.select({ id: schema.users.id }).from(schema.users).where(sql`lower(${schema.users.email}) = ${email.toLowerCase()}`);
  if (taken && taken.id !== exceptUserId) throw conflict('Este e-mail já é usado por outra conta.');
}

async function mePayload(userId: string) {
  const [u] = await db.select().from(schema.users).where(eq(schema.users.id, userId));
  return {
    user: {
      id: u.id, email: u.email, username: u.username, name: u.name, isSuperadmin: u.isSuperadmin, mustChangePassword: u.mustChangePassword,
      canCreateOrgs: u.isSuperadmin || u.canCreateOrgs, ...((await needsInitialOrg(db, u)) ? { needsInitialOrg: true, initialOrgName: env.ADMIN_ORG_NAME } : { needsInitialOrg: false }),
      telegramChatId: u.telegramChatId, preferences: u.preferences,
    },
    orgs: await membershipsOf(userId),
    /** O front compara com a própria versão para avisar quando há atualização (cache/PWA). */
    // `embed`: esta instalação aceita ser exibida dentro de outro sistema (EMBED_ALLOWED_ORIGINS)
    app: { version: APP_VERSION, embed: env.EMBED_ALLOWED_ORIGINS.length > 0 },
    security: { idleTimeoutMinutes: (await securitySettings()).idleTimeoutMinutes },
  };
}

export default async function authRoutes(app: FastifyInstance) {
  const strict = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

  /** A tela de login usa para avisar quando a instalação ainda não tem administrador. */
  app.get('/api/auth/bootstrap', async () => {
    const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(schema.users);
    return { needsSetup: count === 0 };
  });

  // Não há cadastro público: contas novas são criadas por um administrador (Membros)
  // e o primeiro administrador vem do .env (ver services/bootstrap.ts).

  app.post('/api/auth/login', strict, async (req, reply) => {
    const body = parse(loginSchema, req.body);
    // e-mail ou nome de usuário
    const byEmail = body.login.includes('@');
    const [u] = await db.select().from(schema.users)
      .where(byEmail ? sql`lower(${schema.users.email}) = ${body.login}` : sql`lower(${schema.users.username}) = ${body.login}`);
    // contadores pela conta (não pelo texto digitado: e-mail e usuário somam) e pelo IP
    const account = u?.id ?? `login:${body.login.slice(0, 120)}`;
    const locked = loginLockedFor(account, req.ip);
    if (locked) throw new HttpError(429, `Muitas tentativas. Tente de novo em ${Math.ceil(locked / 60)} min.`, 'login_locked');
    // sempre confere uma senha (contra um hash válido) para não revelar pelo tempo se o usuário existe
    const ok = await verifyPassword(u?.passwordHash ?? (await dummyPasswordHash()), body.password);
    if (!u || !ok) {
      const nowLocked = registerLoginFailure(account, req.ip);
      // só registra na auditoria o que interessa (conta real ou bloqueio): tentativas com logins
      // inventados não podem encher a tabela
      if (u || nowLocked) await audit(req, { action: 'auth.login_failed', entityType: 'user', entityId: u?.id, description: `Falha de login: ${body.login.slice(0, 80)}${nowLocked ? ' (bloqueado por 15 min)' : ''}` });
      throw unauthorized('Usuário/e-mail ou senha incorretos');
    }
    clearLoginFailures(account, req.ip);
    if (!u.active) throw forbidden('Usuário desativado');
    await db.update(schema.users).set({ lastLoginAt: new Date() }).where(eq(schema.users.id, u.id));
    req.user = { id: u.id, email: u.email, name: u.name, isSuperadmin: u.isSuperadmin, sessionId: '' };
    await audit(req, { action: 'auth.login', entityType: 'user', entityId: u.id, description: `Login de ${u.email}` });
    const tokens = await startSession(req, reply, u.id);
    return { ...tokens, ...(await mePayload(u.id)) };
  });

  /** Janela para o token de duas rotações atrás (duas abas renovando ao mesmo tempo). */
  const REFRESH_GRACE_MS = 120_000;

  app.post('/api/auth/refresh', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    const raw = req.cookies[COOKIE];
    if (!raw) throw unauthorized('Sessão expirada');
    const [sid, token] = raw.split('.');
    if (!sid || !token || !/^[0-9a-f-]{36}$/.test(sid)) throw unauthorized('Sessão inválida');
    const [s] = await db.select().from(schema.sessions)
      .where(and(eq(schema.sessions.id, sid), isNull(schema.sessions.revokedAt), gt(schema.sessions.expiresAt, new Date())));
    const h = hashToken(token);
    // Token anterior dentro da janela de tolerância: duas abas renovando juntas, ou a resposta
    // da renovação se perdeu (navegação no meio). Não é reuso malicioso — renova de novo.
    // Tolerância (não é roubo):
    //  - token anterior: aceito até o novo ser usado (o token de acesso emitido na renovação chega
    //    à API e marca `rotationAcked`) ou por 2 min — a resposta da renovação pode ter se perdido.
    //    Sem esse limite, um token roubado e o legítimo se alternariam para sempre sem alarme;
    //  - token de duas rotações atrás: aceito por 2 min — duas abas renovando juntas.
    // Qualquer token mais velho que isso é reuso suspeito e derruba a sessão.
    const recent = !!s?.rotatedAt && Date.now() - s.rotatedAt.getTime() < REFRESH_GRACE_MS;
    const inGrace = !!s && s.refreshHash !== h && ((s.prevRefreshHash === h && (!s.rotationAcked || recent)) || (recent && s.prev2RefreshHash === h));
    if (!s || (s.refreshHash !== h && !inGrace)) {
      // token reutilizado fora da janela -> possível roubo: revoga a sessão
      if (s) await db.update(schema.sessions).set({ revokedAt: new Date() }).where(eq(schema.sessions.id, s.id));
      reply.clearCookie(COOKIE, { path: '/api/auth' });
      throw unauthorized('Sessão inválida');
    }
    const [u] = await db.select({ active: schema.users.active }).from(schema.users).where(eq(schema.users.id, s.userId));
    if (!u?.active) throw unauthorized('Usuário desativado');
    if (await isSessionIdle(s.lastActivityAt)) {
      await db.update(schema.sessions).set({ revokedAt: new Date() }).where(eq(schema.sessions.id, s.id));
      reply.clearCookie(COOKIE, { path: '/api/auth' });
      throw new HttpError(401, 'Sessão encerrada por inatividade. Entre de novo.', 'idle_timeout');
    }
    const refresh = newRefreshToken();
    await db.update(schema.sessions).set({
      refreshHash: hashToken(refresh), prevRefreshHash: s.refreshHash, prev2RefreshHash: s.prevRefreshHash, rotatedAt: new Date(), lastUsedAt: new Date(),
      rotation: s.rotation + 1, rotationAcked: false,
      expiresAt: new Date(Date.now() + REFRESH_TTL_DAYS * 86400_000),
    }).where(eq(schema.sessions.id, s.id));
    reply.setCookie(COOKIE, `${s.id}.${refresh}`, cookieOpts);
    return { accessToken: await signAccessToken(s.userId, s.id, s.rotation + 1), expiresIn: ACCESS_TTL_SECONDS, ...(await mePayload(s.userId)) };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const raw = req.cookies[COOKIE];
    const sid = raw?.split('.')[0];
    if (sid && /^[0-9a-f-]{36}$/.test(sid)) await db.update(schema.sessions).set({ revokedAt: new Date() }).where(eq(schema.sessions.id, sid));
    reply.clearCookie(COOKIE, { path: '/api/auth' });
    return { ok: true };
  });

  /** Heartbeat do front enquanto a pessoa interage (mouse, teclado, toque): adia o logoff por inatividade. */
  app.post('/api/auth/activity', { preHandler: requireAuth, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    await db.update(schema.sessions).set({ lastActivityAt: new Date() }).where(eq(schema.sessions.id, req.user!.sessionId));
    return { ok: true };
  });

  app.get('/api/auth/me', { preHandler: requireAuth }, async (req) => mePayload(req.user!.id));

  app.put('/api/auth/profile', { preHandler: requireAuth, ...strict }, async (req) => {
    const body = parse(profileSchema, req.body);
    const [cur] = await db.select().from(schema.users).where(eq(schema.users.id, req.user!.id));
    const usernameChanged = !!body.username && body.username !== cur.username;
    if (usernameChanged) await assertUsernameFree(body.username!, req.user!.id);
    const emailChanged = !!body.email && body.email !== cur.email.toLowerCase();
    if (emailChanged) {
      // o e-mail também serve para entrar: trocar exige a senha atual
      await assertCurrentPassword(req, cur, body.currentPassword, 'Para trocar o e-mail, confirme com a sua senha atual', 'password_required');
      await assertEmailFree(body.email!, req.user!.id);
    }
    await db.update(schema.users).set({
      name: body.name, telegramChatId: body.telegramChatId, ...(usernameChanged ? { username: body.username } : {}), ...(emailChanged ? { email: body.email } : {}),
      preferences: body.preferences ? { ...cur.preferences, ...body.preferences } : cur.preferences,
    }).where(eq(schema.users.id, req.user!.id));
    if (usernameChanged) await audit(req, { action: 'auth.username', entityType: 'user', entityId: req.user!.id, description: `Trocou o usuário de "${cur.username}" para "${body.username}"` });
    if (emailChanged) await audit(req, { action: 'auth.email', entityType: 'user', entityId: req.user!.id, description: `Trocou o e-mail de ${cur.email} para ${body.email}`, details: { changes: { email: { from: cur.email, to: body.email } } } });
    if (body.name !== cur.name) await audit(req, { action: 'auth.profile', entityType: 'user', entityId: req.user!.id, description: `Trocou o nome de "${cur.name}" para "${body.name}"`, details: { changes: { name: { from: cur.name, to: body.name } } } });
    return mePayload(req.user!.id);
  });

  /** Preferências de tela da própria pessoa (ex.: cores das categorias só para ela). Junta com as que já existem. */
  app.put('/api/auth/preferences', { preHandler: requireAuth }, async (req) => {
    const { preferences } = parse(preferencesSchema, req.body);
    const [cur] = await db.select({ preferences: schema.users.preferences }).from(schema.users).where(eq(schema.users.id, req.user!.id));
    const next = { ...cur.preferences, ...preferences };
    await db.update(schema.users).set({ preferences: next }).where(eq(schema.users.id, req.user!.id));
    return { preferences: next };
  });

  app.post('/api/auth/password', { preHandler: requireAuth, ...strict }, async (req) => {
    const body = parse(changePasswordSchema, req.body);
    const [u] = await db.select().from(schema.users).where(eq(schema.users.id, req.user!.id));
    await assertCurrentPassword(req, u, body.currentPassword, 'Senha atual incorreta');
    if (body.newPassword === body.currentPassword) throw badRequest('A nova senha precisa ser diferente da atual');
    const passwordHash = await hashPassword(body.newPassword);
    const org = await db.transaction(async (tx) => {
      let created = null;
      if (await needsInitialOrg(tx, u)) {
        if (!body.initialOrgKind) throw badRequest('Escolha o perfil do espaço: Pessoal ou Empresa', 'org_kind_required');
        created = await createInitialOrg(tx, u.id, body.initialOrgKind, body.initialOrgName);
      }
      await tx.update(schema.users).set({ passwordHash, mustChangePassword: false }).where(eq(schema.users.id, u.id));
      return created;
    });
    if (org) await audit(req, { action: 'org.create', entityType: 'organization', entityId: org.id, orgId: org.id, description: `Criou organização ${org.name} (${org.kind === 'personal' ? 'Pessoal' : 'Empresa'})`, details: { kind: org.kind } });
    // encerra as outras sessões
    await db.update(schema.sessions).set({ revokedAt: new Date() })
      .where(and(eq(schema.sessions.userId, u.id), isNull(schema.sessions.revokedAt), sql`${schema.sessions.id} <> ${req.user!.sessionId}`));
    await audit(req, { action: 'auth.password_change', entityType: 'user', entityId: u.id });
    return { ok: true };
  });

  app.get('/api/auth/sessions', { preHandler: requireAuth }, async (req) => {
    const rows = await db.select({
      id: schema.sessions.id, userAgent: schema.sessions.userAgent, ip: schema.sessions.ip,
      createdAt: schema.sessions.createdAt, lastUsedAt: schema.sessions.lastUsedAt,
    }).from(schema.sessions).where(and(eq(schema.sessions.userId, req.user!.id), isNull(schema.sessions.revokedAt), gt(schema.sessions.expiresAt, new Date())))
      .orderBy(sql`${schema.sessions.lastUsedAt} desc`);
    return { items: rows.map((r) => ({ ...r, current: r.id === req.user!.sessionId })) };
  });

  app.delete<{ Params: { id: string } }>('/api/auth/sessions/:id', { preHandler: requireAuth }, async (req) => {
    await db.update(schema.sessions).set({ revokedAt: new Date() })
      .where(and(eq(schema.sessions.id, req.params.id), eq(schema.sessions.userId, req.user!.id)));
    return { ok: true };
  });
}
