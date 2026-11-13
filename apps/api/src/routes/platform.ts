import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { platformResetPasswordSchema, platformUserCreateSchema, platformUserUpdateSchema, usernameFromEmail } from '@nopaper/shared';
import { db, schema } from '../db/client.js';
import { parse } from '../lib/validate.js';
import { HttpError, badRequest, conflict, notFound } from '../lib/errors.js';
import { hashPassword, requireAuth, requireSuperadmin } from '../lib/auth.js';
import { audit, auditUsers, queryAudit, type AuditQuery } from '../lib/audit.js';
import { assertEmailFree, assertUsernameFree } from './auth.js';
import { env } from '../env.js';
import { storageUsage } from '../services/storageQuota.js';
import { PRIVATE_SPACE_LABEL, assertOrgOpenToPlatform, inLockedSpace, privacyFor } from '../services/privacy.js';

/**
 * Plataforma (só superadmin): contas de usuário de todos os espaços e auditoria da plataforma.
 * Contas não pertencem a um espaço — um espaço só tem "membros" que apontam para contas.
 */
export default async function platformRoutes(app: FastifyInstance) {
  const guard = { preHandler: [requireAuth, requireSuperadmin] };

  /** `actorId` = quem está olhando: espaços privados de que ele não participa saem sem nome e sem grupos. */
  const userView = async (actorId: string, id?: string) => {
    const view = await privacyFor(actorId);
    const u = schema.users;
    const rows = await db.select({
      id: u.id, name: u.name, email: u.email, username: u.username, active: u.active, isSuperadmin: u.isSuperadmin,
      canCreateOrgs: u.canCreateOrgs, mustChangePassword: u.mustChangePassword, lastLoginAt: u.lastLoginAt, createdAt: u.createdAt,
      orgs: sql<Array<{ id: string; name: string; isOwner: boolean; active: boolean; groupIds: string[] }>>`coalesce((
        select json_agg(json_build_object('id', o.id, 'name', o.name, 'isOwner', m.is_owner, 'active', m.active,
          'groupIds', coalesce((select json_agg(mg.group_id) from membership_groups mg where mg.membership_id = m.id), '[]'::json)) order by o.name)
        from memberships m join organizations o on o.id = m.org_id where m.user_id = "users"."id"), '[]'::json)`,
      sessions: sql<number>`(select count(*)::int from sessions s where s.user_id = "users"."id" and s.revoked_at is null and s.expires_at > now())`,
    }).from(u).where(and(isNull(u.deletedAt), id ? eq(u.id, id) : undefined)).orderBy(u.name);
    return rows.map((r) => {
      const orgs = r.orgs.map((o) => ({
        ...o, locked: view.locked.has(o.id),
        ...(view.hidden.has(o.id) ? { name: PRIVATE_SPACE_LABEL, groupIds: [] as string[] } : {}),
      }));
      // senha provisória daria acesso ao espaço privado de outra pessoa
      return { ...r, orgs, passwordLocked: r.id !== actorId && orgs.some((o) => o.locked) };
    });
  };

  app.get('/api/system/users', guard, async (req) => ({ items: await userView(req.user!.id) }));

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
    return (await userView(req.user!.id, u.id))[0];
  });

  app.put<{ Params: { id: string } }>('/api/system/users/:id', guard, async (req) => {
    const body = parse(platformUserUpdateSchema, req.body);
    const [cur] = await db.select().from(schema.users).where(and(eq(schema.users.id, req.params.id), isNull(schema.users.deletedAt)));
    if (!cur) throw notFound('Conta não encontrada');
    const self = cur.id === req.user!.id;
    if (self && body.isSuperadmin === false) throw badRequest('Você não pode tirar o seu próprio acesso de administrador da plataforma');
    if (self && body.active === false) throw badRequest('Você não pode desativar a sua própria conta');
    if (cur.isSuperadmin && (body.isSuperadmin === false || body.active === false)) {
      const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.users)
        .where(and(eq(schema.users.isSuperadmin, true), eq(schema.users.active, true), isNull(schema.users.deletedAt), ne(schema.users.id, cur.id)));
      if (!n) throw badRequest('Precisa haver pelo menos um administrador da plataforma ativo');
    }
    if (body.email && body.email !== cur.email.toLowerCase()) await assertEmailFree(body.email, cur.id);
    if (body.username && body.username !== cur.username) await assertUsernameFree(body.username, cur.id);
    const patch = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined));
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const [k, v] of Object.entries(patch)) if ((cur as Record<string, unknown>)[k] !== v) changes[k] = { from: (cur as Record<string, unknown>)[k], to: v };
    if (!Object.keys(changes).length) return (await userView(req.user!.id, cur.id))[0];
    await db.update(schema.users).set(patch).where(eq(schema.users.id, cur.id));
    // conta desativada: derruba as sessões abertas
    if (body.active === false) await db.update(schema.sessions).set({ revokedAt: new Date() }).where(and(eq(schema.sessions.userId, cur.id), isNull(schema.sessions.revokedAt)));
    await audit(req, { action: 'platform.user_update', entityType: 'user', entityId: cur.id, description: `Alterou a conta de ${cur.name}`, details: { changes } });
    return (await userView(req.user!.id, cur.id))[0];
  });

  /** Define uma senha provisória (a pessoa cria a própria no próximo acesso) e encerra as sessões. */
  app.post<{ Params: { id: string } }>('/api/system/users/:id/reset-password', guard, async (req) => {
    const body = parse(platformResetPasswordSchema, req.body);
    const [cur] = await db.select().from(schema.users).where(and(eq(schema.users.id, req.params.id), isNull(schema.users.deletedAt)));
    if (!cur) throw notFound('Conta não encontrada');
    if (cur.id === req.user!.id) throw badRequest('Para a sua própria senha, use Meu perfil');
    if (await inLockedSpace(await privacyFor(req.user!.id), cur.id)) {
      throw new HttpError(403, `${cur.name} participa de um espaço privado: a senha desta conta não pode ser definida pela plataforma. Só a própria pessoa troca a senha (ou, se ela esqueceu, quem tem acesso ao servidor).`, 'private_space');
    }
    await db.update(schema.users).set({ passwordHash: await hashPassword(body.password), mustChangePassword: true }).where(eq(schema.users.id, cur.id));
    await db.update(schema.sessions).set({ revokedAt: new Date() }).where(and(eq(schema.sessions.userId, cur.id), isNull(schema.sessions.revokedAt)));
    await audit(req, { action: 'platform.user_password', entityType: 'user', entityId: cur.id, description: `Definiu uma senha provisória para ${cur.name}` });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/system/users/:id/logout', guard, async (req) => {
    const [cur] = await db.select().from(schema.users).where(and(eq(schema.users.id, req.params.id), isNull(schema.users.deletedAt)));
    if (!cur) throw notFound('Conta não encontrada');
    const r = await db.update(schema.sessions).set({ revokedAt: new Date() })
      .where(and(eq(schema.sessions.userId, cur.id), isNull(schema.sessions.revokedAt), cur.id === req.user!.id ? ne(schema.sessions.id, req.user!.sessionId) : undefined))
      .returning({ id: schema.sessions.id });
    await audit(req, { action: 'platform.user_logout', entityType: 'user', entityId: cur.id, description: `Encerrou ${r.length} sessão(ões) de ${cur.name}` });
    return { revoked: r.length };
  });

  // ---------------------------------------------------------------- espaços de uma conta
  /** Todos os espaços, com os grupos de cada um (para associar uma conta a um espaço). */
  app.get('/api/system/orgs', guard, async (req) => {
    const view = await privacyFor(req.user!.id);
    // espaço privado que quem olha não administra não entra na lista: não dá para associar ninguém a ele
    const orgs = (await db.select({ id: schema.organizations.id, name: schema.organizations.name, kind: schema.organizations.kind }).from(schema.organizations).orderBy(schema.organizations.name))
      .filter((o) => !view.locked.has(o.id));
    const groups = await db.select({ id: schema.groups.id, orgId: schema.groups.orgId, name: schema.groups.name, isAdmin: schema.groups.isAdmin }).from(schema.groups).orderBy(schema.groups.name);
    return { items: orgs.map((o) => ({ ...o, groups: groups.filter((g) => g.orgId === o.id).map(({ orgId: _o, ...g }) => g) })) };
  });

  /** Armazenamento: quanto cada espaço usa e a cota dele (null = a padrão da instalação). */
  app.get('/api/system/storage', guard, async (req) => {
    const view = await privacyFor(req.user!.id);
    const orgs = await db.select({ id: schema.organizations.id, name: schema.organizations.name, quotaMb: schema.organizations.storageQuotaMb }).from(schema.organizations).orderBy(schema.organizations.name);
    const items = [];
    for (const o of orgs) items.push({ ...o, ...(view.hidden.has(o.id) ? { name: PRIVATE_SPACE_LABEL, private: true } : {}), usedBytes: await storageUsage(o.id) });
    return { defaultQuotaMb: env.STORAGE_QUOTA_MB, items };
  });
  app.put<{ Params: { orgId: string } }>('/api/system/orgs/:orgId/storage', guard, async (req) => {
    const body = parse(z.object({ quotaMb: z.number().int().min(100, 'Mínimo de 100 MB').max(10_000_000).nullable() }), req.body);
    const [o] = await db.update(schema.organizations).set({ storageQuotaMb: body.quotaMb }).where(eq(schema.organizations.id, req.params.orgId)).returning({ id: schema.organizations.id, name: schema.organizations.name });
    if (!o) throw notFound('Espaço não encontrado');
    // a auditoria da plataforma é lida pelos outros administradores: não leva o nome de um espaço privado
    const label = (await privacyFor(req.user!.id)).hidden.has(o.id) ? 'um espaço privado' : o.name;
    await audit(req, { action: 'platform.storage_quota', entityType: 'organization', entityId: o.id, description: `Definiu a cota de armazenamento de ${label}: ${body.quotaMb ? `${body.quotaMb} MB` : 'padrão'}`, details: { quotaMb: body.quotaMb } });
    return { ok: true };
  });

  /** Põe a conta num espaço (ou troca os grupos dela lá). */
  app.put<{ Params: { id: string; orgId: string } }>('/api/system/users/:id/orgs/:orgId', guard, async (req) => {
    const body = parse(z.object({ groupIds: z.array(z.string().uuid()).max(50) }), req.body);
    const [cur] = await db.select().from(schema.users).where(and(eq(schema.users.id, req.params.id), isNull(schema.users.deletedAt)));
    if (!cur) throw notFound('Conta não encontrada');
    const [org] = await db.select().from(schema.organizations).where(eq(schema.organizations.id, req.params.orgId));
    if (!org) throw notFound('Espaço não encontrado');
    assertOrgOpenToPlatform(await privacyFor(req.user!.id), org.id);
    const groups = body.groupIds.length ? await db.select().from(schema.groups).where(and(eq(schema.groups.orgId, org.id), inArray(schema.groups.id, body.groupIds))) : [];
    if (groups.length !== new Set(body.groupIds).size) throw badRequest('Grupo inválido para este espaço');
    const out = await db.transaction(async (tx) => {
      let [m] = await tx.select().from(schema.memberships).where(and(eq(schema.memberships.orgId, org.id), eq(schema.memberships.userId, cur.id)));
      const added = !m;
      if (!m) [m] = await tx.insert(schema.memberships).values({ orgId: org.id, userId: cur.id }).returning();
      const before = (await tx.select({ name: schema.groups.name }).from(schema.membershipGroups).innerJoin(schema.groups, eq(schema.groups.id, schema.membershipGroups.groupId))
        .where(eq(schema.membershipGroups.membershipId, m!.id))).map((g) => g.name).sort();
      await tx.delete(schema.membershipGroups).where(eq(schema.membershipGroups.membershipId, m!.id));
      if (groups.length) await tx.insert(schema.membershipGroups).values(groups.map((g) => ({ membershipId: m!.id, groupId: g.id })));
      return { added, before, membershipId: m!.id };
    });
    const after = groups.map((g) => g.name).sort();
    // fica na auditoria do espaço (quem cuida dele vê que a plataforma mexeu nos membros)
    await audit(req, {
      orgId: org.id, action: out.added ? 'member.add' : 'member.update', entityType: 'membership', entityId: out.membershipId,
      description: out.added ? `Adicionou ${cur.name} (${cur.email}) pela plataforma` : `Alterou o acesso de ${cur.name} pela plataforma`,
      details: out.added ? { groups: after, byPlatform: true } : { changes: { groups: { from: out.before, to: after } }, byPlatform: true },
    });
    return (await userView(req.user!.id, cur.id))[0];
  });

  app.delete<{ Params: { id: string; orgId: string } }>('/api/system/users/:id/orgs/:orgId', guard, async (req) => {
    const [cur] = await db.select().from(schema.users).where(and(eq(schema.users.id, req.params.id), isNull(schema.users.deletedAt)));
    if (!cur) throw notFound('Conta não encontrada');
    const [m] = await db.select().from(schema.memberships).where(and(eq(schema.memberships.orgId, req.params.orgId), eq(schema.memberships.userId, cur.id)));
    if (!m) throw notFound('A conta não é deste espaço');
    assertOrgOpenToPlatform(await privacyFor(req.user!.id), m.orgId);
    if (m.isOwner) throw badRequest('O dono do espaço não pode ser removido dele');
    await db.delete(schema.memberships).where(eq(schema.memberships.id, m.id));
    await audit(req, { orgId: m.orgId, action: 'member.remove', entityType: 'membership', entityId: m.id, description: `Removeu ${cur.name} do espaço pela plataforma`, details: { email: cur.email, byPlatform: true } });
    return (await userView(req.user!.id, cur.id))[0];
  });

  /**
   * Remove a conta: perde o acesso e sai de todos os espaços e das listas. Nada do que ela fez é
   * apagado — contas lançadas, anexos, documentos e a auditoria continuam, com o nome dela. O e-mail e
   * o usuário ficam livres para uma conta nova. Dono de espaço precisa passar o espaço adiante antes.
   */
  app.delete<{ Params: { id: string } }>('/api/system/users/:id', guard, async (req) => {
    const [cur] = await db.select().from(schema.users).where(and(eq(schema.users.id, req.params.id), isNull(schema.users.deletedAt)));
    if (!cur) throw notFound('Conta não encontrada');
    if (cur.id === req.user!.id) throw badRequest('Você não pode remover a sua própria conta');
    if (cur.isSuperadmin && cur.active) {
      const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.users)
        .where(and(eq(schema.users.isSuperadmin, true), eq(schema.users.active, true), isNull(schema.users.deletedAt), ne(schema.users.id, cur.id)));
      if (!n) throw badRequest('Precisa haver pelo menos um administrador da plataforma ativo');
    }
    const view = await privacyFor(req.user!.id);
    const orgs = (await db.select({ id: schema.organizations.id, name: schema.organizations.name, isOwner: schema.memberships.isOwner }).from(schema.memberships)
      .innerJoin(schema.organizations, eq(schema.organizations.id, schema.memberships.orgId)).where(eq(schema.memberships.userId, cur.id)))
      .map((o) => ({ ...o, name: view.hidden.has(o.id) ? PRIVATE_SPACE_LABEL : o.name }));
    // remover a conta tiraria a pessoa de um espaço privado que a plataforma não administra
    if (orgs.some((o) => view.locked.has(o.id))) throw new HttpError(403, `${cur.name} participa de um espaço privado: a plataforma não pode tirá-la de lá. Desative a conta em vez de remover.`, 'private_space');
    const owned = orgs.filter((o) => o.isOwner).map((o) => o.name);
    if (owned.length) throw conflict(`${cur.name} é dono(a) do espaço ${owned.map((n) => `“${n}”`).join(', ')}. Um espaço não pode ficar sem dono: desative a conta em vez de remover.`);
    const tag = randomBytes(5).toString('hex');
    await db.transaction(async (tx) => {
      await tx.update(schema.sessions).set({ revokedAt: new Date() }).where(and(eq(schema.sessions.userId, cur.id), isNull(schema.sessions.revokedAt)));
      await tx.delete(schema.memberships).where(eq(schema.memberships.userId, cur.id));
      await tx.update(schema.users).set({
        active: false, deletedAt: new Date(), isSuperadmin: false, canCreateOrgs: false, telegramChatId: null,
        email: `${tag}@removido.invalid`, username: `removido-${tag}`, passwordHash: `removed:${randomBytes(24).toString('hex')}`,
      }).where(eq(schema.users.id, cur.id));
    });
    await audit(req, {
      action: 'platform.user_delete', entityType: 'user', entityId: cur.id, description: `Removeu a conta de ${cur.name} (${cur.email})`,
      details: { email: cur.email, username: cur.username, spaces: orgs.map((o) => o.name), isSuperadmin: cur.isSuperadmin },
    });
    return { ok: true };
  });

  // ---------------------------------------------------------------- auditoria da plataforma
  /** scope=platform (padrão): logins e configurações da plataforma; scope=all: tudo, de todos os espaços. */
  app.get<{ Querystring: AuditQuery & { scope?: string } }>('/api/system/audit', guard, async (req) => {
    const all = req.query.scope === 'all';
    return queryAudit(all ? 'all' : 'platform', req.query, false, 100, null, all ? [...(await privacyFor(req.user!.id)).hidden] : []);
  });
  app.get<{ Querystring: { scope?: string } }>('/api/system/audit/users', guard, async (req) => {
    const all = req.query.scope === 'all';
    return { items: await auditUsers(all ? 'all' : 'platform', all ? [...(await privacyFor(req.user!.id)).hidden] : []) };
  });
}
