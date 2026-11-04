import type { FastifyInstance } from 'fastify';
import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import { platformResetPasswordSchema, platformUserCreateSchema, platformUserUpdateSchema, usernameFromEmail } from '@nopaper/shared';
import { db, schema } from '../db/client.js';
import { parse } from '../lib/validate.js';
import { badRequest, notFound } from '../lib/errors.js';
import { hashPassword, requireAuth, requireSuperadmin } from '../lib/auth.js';
import { audit, auditUsers, queryAudit, type AuditQuery } from '../lib/audit.js';
import { assertEmailFree, assertUsernameFree } from './auth.js';

/**
 * Plataforma (só superadmin): contas de usuário de todos os espaços e auditoria da plataforma.
 * Contas não pertencem a um espaço — um espaço só tem "membros" que apontam para contas.
 */
export default async function platformRoutes(app: FastifyInstance) {
  const guard = { preHandler: [requireAuth, requireSuperadmin] };

  const userView = async (id?: string) => {
    const u = schema.users;
    const rows = await db.select({
      id: u.id, name: u.name, email: u.email, username: u.username, active: u.active, isSuperadmin: u.isSuperadmin,
      canCreateOrgs: u.canCreateOrgs, mustChangePassword: u.mustChangePassword, lastLoginAt: u.lastLoginAt, createdAt: u.createdAt,
      orgs: sql<Array<{ id: string; name: string; isOwner: boolean; active: boolean }>>`coalesce((
        select json_agg(json_build_object('id', o.id, 'name', o.name, 'isOwner', m.is_owner, 'active', m.active) order by o.name)
        from memberships m join organizations o on o.id = m.org_id where m.user_id = "users"."id"), '[]'::json)`,
      sessions: sql<number>`(select count(*)::int from sessions s where s.user_id = "users"."id" and s.revoked_at is null and s.expires_at > now())`,
    }).from(u).where(id ? eq(u.id, id) : undefined).orderBy(u.name);
    return rows;
  };

  app.get('/api/system/users', guard, async () => ({ items: await userView() }));

  app.post('/api/system/users', guard, async (req) => {
    const body = parse(platformUserCreateSchema, req.body);
    await assertEmailFree(body.email);
    let username = body.username;
    if (username) await assertUsernameFree(username);
    else {
      const base = usernameFromEmail(body.email);
      const taken = new Set((await db.select({ u: schema.users.username }).from(schema.users).where(sql`lower(${schema.users.username}) like ${base + '%'}`)).map((r) => r.u.toLowerCase()));
      username = base; for (let i = 2; taken.has(username); i++) username = `${base}${i}`;
    }
    const [u] = await db.insert(schema.users).values({
      name: body.name, email: body.email, username, passwordHash: await hashPassword(body.password), mustChangePassword: true,
      isSuperadmin: body.isSuperadmin, canCreateOrgs: body.canCreateOrgs,
    }).returning();
    await audit(req, { action: 'platform.user_create', entityType: 'user', entityId: u.id, description: `Criou a conta de ${u.name} (${u.email})`, details: { username, isSuperadmin: body.isSuperadmin, canCreateOrgs: body.canCreateOrgs } });
    return (await userView(u.id))[0];
  });

  app.put<{ Params: { id: string } }>('/api/system/users/:id', guard, async (req) => {
    const body = parse(platformUserUpdateSchema, req.body);
    const [cur] = await db.select().from(schema.users).where(eq(schema.users.id, req.params.id));
    if (!cur) throw notFound('Conta não encontrada');
    const self = cur.id === req.user!.id;
    if (self && body.isSuperadmin === false) throw badRequest('Você não pode tirar o seu próprio acesso de administrador da plataforma');
    if (self && body.active === false) throw badRequest('Você não pode desativar a sua própria conta');
    if (cur.isSuperadmin && (body.isSuperadmin === false || body.active === false)) {
      const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.users)
        .where(and(eq(schema.users.isSuperadmin, true), eq(schema.users.active, true), ne(schema.users.id, cur.id)));
      if (!n) throw badRequest('Precisa haver pelo menos um administrador da plataforma ativo');
    }
    if (body.email && body.email !== cur.email.toLowerCase()) await assertEmailFree(body.email, cur.id);
    if (body.username && body.username !== cur.username) await assertUsernameFree(body.username, cur.id);
    const patch = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined));
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const [k, v] of Object.entries(patch)) if ((cur as Record<string, unknown>)[k] !== v) changes[k] = { from: (cur as Record<string, unknown>)[k], to: v };
    if (!Object.keys(changes).length) return (await userView(cur.id))[0];
    await db.update(schema.users).set(patch).where(eq(schema.users.id, cur.id));
    // conta desativada: derruba as sessões abertas
    if (body.active === false) await db.update(schema.sessions).set({ revokedAt: new Date() }).where(and(eq(schema.sessions.userId, cur.id), isNull(schema.sessions.revokedAt)));
    await audit(req, { action: 'platform.user_update', entityType: 'user', entityId: cur.id, description: `Alterou a conta de ${cur.name}`, details: { changes } });
    return (await userView(cur.id))[0];
  });

  /** Define uma senha provisória (a pessoa cria a própria no próximo acesso) e encerra as sessões. */
  app.post<{ Params: { id: string } }>('/api/system/users/:id/reset-password', guard, async (req) => {
    const body = parse(platformResetPasswordSchema, req.body);
    const [cur] = await db.select().from(schema.users).where(eq(schema.users.id, req.params.id));
    if (!cur) throw notFound('Conta não encontrada');
    if (cur.id === req.user!.id) throw badRequest('Para a sua própria senha, use Meu perfil');
    await db.update(schema.users).set({ passwordHash: await hashPassword(body.password), mustChangePassword: true }).where(eq(schema.users.id, cur.id));
    await db.update(schema.sessions).set({ revokedAt: new Date() }).where(and(eq(schema.sessions.userId, cur.id), isNull(schema.sessions.revokedAt)));
    await audit(req, { action: 'platform.user_password', entityType: 'user', entityId: cur.id, description: `Definiu uma senha provisória para ${cur.name}` });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/system/users/:id/logout', guard, async (req) => {
    const [cur] = await db.select().from(schema.users).where(eq(schema.users.id, req.params.id));
    if (!cur) throw notFound('Conta não encontrada');
    const r = await db.update(schema.sessions).set({ revokedAt: new Date() })
      .where(and(eq(schema.sessions.userId, cur.id), isNull(schema.sessions.revokedAt), cur.id === req.user!.id ? ne(schema.sessions.id, req.user!.sessionId) : undefined))
      .returning({ id: schema.sessions.id });
    await audit(req, { action: 'platform.user_logout', entityType: 'user', entityId: cur.id, description: `Encerrou ${r.length} sessão(ões) de ${cur.name}` });
    return { revoked: r.length };
  });

  // ---------------------------------------------------------------- auditoria da plataforma
  /** scope=platform (padrão): logins e configurações da plataforma; scope=all: tudo, de todos os espaços. */
  app.get<{ Querystring: AuditQuery & { scope?: string } }>('/api/system/audit', guard, async (req) => {
    return queryAudit(req.query.scope === 'all' ? 'all' : 'platform', req.query, false);
  });
  app.get<{ Querystring: { scope?: string } }>('/api/system/audit/users', guard, async (req) => ({ items: await auditUsers(req.query.scope === 'all' ? 'all' : 'platform') }));
}
