import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { isNull, and, eq, inArray, sql } from 'drizzle-orm';
import { ORG_DETAIL_FIELDS, ORG_LOGO_MAX_BYTES, orgCreateSchema, orgDetailsSchema, orgLogoSchema, pdfPasswordsSchema, orgUpdateSchema, memberAddSchema, memberUpdateSchema, groupSchema, usernameFromEmail, PERMISSIONS, type Permission } from '@nopaper/shared';
import { assertUsernameFree } from './auth.js';
import { db, schema } from '../db/client.js';
import { sniffMime } from '../lib/storage.js';
import { listPdfRules, savePdfRules } from '../services/pdfPasswords.js';
import { parse } from '../lib/validate.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { requireAuth, requirePerm, requireOrg, hashPassword, membershipsOf } from '../lib/auth.js';
import { createOrganization } from '../services/orgs.js';
import { audit, auditAreasFor, auditUsers, queryAudit, type AuditQuery } from '../lib/audit.js';

/** Primeiro nome de usuário livre: base, base2, base3… */
async function freeUsername(base: string) {
  const rows = await db.select({ u: schema.users.username }).from(schema.users).where(sql`lower(${schema.users.username}) like ${base + '%'}`);
  const taken = new Set(rows.map((r) => r.u.toLowerCase()));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}${i}`)) return `${base}${i}`;
}

export default async function orgRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------- organizações
  app.post('/api/orgs', { preHandler: requireAuth }, async (req) => {
    const [me] = await db.select({ canCreateOrgs: schema.users.canCreateOrgs, isSuperadmin: schema.users.isSuperadmin }).from(schema.users).where(eq(schema.users.id, req.user!.id));
    if (!me?.isSuperadmin && !me?.canCreateOrgs) throw forbidden('Sua conta não pode criar espaços. Peça a um administrador da plataforma.');
    const body = parse(orgCreateSchema, req.body);
    const org = await db.transaction((tx) => createOrganization(tx, { ...body, ownerId: req.user!.id }));
    await audit(req, { orgId: org.id, action: 'org.create', entityType: 'organization', entityId: org.id, description: `Criou organização ${org.name}` });
    return { org, orgs: await membershipsOf(req.user!.id) };
  });

  app.get('/api/org', { preHandler: requireOrg }, async (req) => {
    const [org] = await db.select().from(schema.organizations).where(eq(schema.organizations.id, req.org!.id));
    return { org, me: { isOwner: req.org!.isOwner, isAdmin: req.org!.isAdmin, permissions: [...req.org!.permissions] } };
  });

  app.put('/api/org', { preHandler: requirePerm('org.settings') }, async (req) => {
    const body = parse(orgUpdateSchema.merge(orgDetailsSchema), req.body);
    const [before] = await db.select().from(schema.organizations).where(eq(schema.organizations.id, req.org!.id));
    const [org] = await db.update(schema.organizations).set(body).where(eq(schema.organizations.id, req.org!.id)).returning();
    await audit(req, { action: 'org.update', entityType: 'organization', entityId: org.id, description: `Editou os dados do espaço ${org.name}`, details: { changes: diff(before, org, ['name', 'legalName', 'kind', 'document', 'timezone', ...ORG_DETAIL_FIELDS]) } });
    return { org };
  });

  /** Logo do espaço (ou null para tirar). O conteúdo é conferido pelos bytes, não pelo tipo declarado. */
  app.put('/api/org/logo', { preHandler: requirePerm('org.settings') }, async (req) => {
    const { logo } = parse(orgLogoSchema, req.body);
    if (logo) {
      const [head, b64] = logo.split(',') as [string, string];
      const buf = Buffer.from(b64, 'base64');
      if (!buf.length || buf.length > ORG_LOGO_MAX_BYTES) throw badRequest('A imagem ficou grande demais. Use uma logo menor ou mais simples.');
      if (sniffMime(buf) !== head.slice(5, head.indexOf(';'))) throw badRequest('O arquivo não é uma imagem PNG, JPG ou WebP válida.');
    }
    const [org] = await db.update(schema.organizations).set({ logo }).where(eq(schema.organizations.id, req.org!.id)).returning();
    await audit(req, { action: 'org.logo', entityType: 'organization', entityId: org.id, description: logo ? `Trocou a logo do espaço ${org.name}` : `Removeu a logo do espaço ${org.name}` });
    return { logo: org.logo };
  });

  /** Este espaço aparece quando o NoPaper é aberto dentro de outro sistema (modo embutido)? */
  app.put('/api/org/embed', { preHandler: requirePerm('org.settings') }, async (req) => {
    const { visible } = parse(z.object({ visible: z.boolean() }), req.body);
    const [org] = await db.update(schema.organizations).set({ embedVisible: visible }).where(eq(schema.organizations.id, req.org!.id)).returning();
    await audit(req, {
      action: 'org.embed', entityType: 'organization', entityId: org.id,
      description: visible ? `Liberou o espaço ${org.name} para aparecer dentro de outros sistemas` : `Tirou o espaço ${org.name} de dentro de outros sistemas`,
      details: { changes: { embedVisible: { from: !visible, to: visible } } },
    });
    return { embedVisible: org.embedVisible };
  });

  // ---------------------------------------------------------- senhas de PDF
  app.get('/api/org/pdf-passwords', { preHandler: requirePerm('org.settings') }, async (req) => listPdfRules(req.org!.id));

  app.put('/api/org/pdf-passwords', { preHandler: requirePerm('org.settings') }, async (req) => {
    const { rules } = parse(pdfPasswordsSchema, req.body);
    for (const r of rules) if (r.source !== 'org_document' && !r.id && !r.value?.trim()) throw badRequest(`Informe ${r.source === 'fixed' ? 'a senha' : 'o CPF/CNPJ'} da regra "${r.name}".`);
    const saved = await savePdfRules(req.org!.id, rules);
    await audit(req, { action: 'org.pdf_passwords', entityType: 'organization', entityId: req.org!.id, description: `Atualizou as regras de senha de PDF (${saved.length})`, details: { rules: saved.map((r) => r.name) } });
    return listPdfRules(req.org!.id);
  });

  // ---------------------------------------------------------- membros
  app.get('/api/members', { preHandler: requirePerm('members.manage', 'groups.manage') }, async (req) => {
    const rows = await db.select({
      id: schema.memberships.id, userId: schema.users.id, name: schema.users.name, email: schema.users.email, username: schema.users.username,
      isOwner: schema.memberships.isOwner, active: schema.memberships.active, userActive: schema.users.active,
      lastLoginAt: schema.users.lastLoginAt, createdAt: schema.memberships.createdAt,
    }).from(schema.memberships)
      .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
      .where(eq(schema.memberships.orgId, req.org!.id))
      .orderBy(schema.users.name);
    const links = rows.length ? await db.select().from(schema.membershipGroups)
      .where(inArray(schema.membershipGroups.membershipId, rows.map((r) => r.id))) : [];
    return { items: rows.map((r) => ({ ...r, groupIds: links.filter((l) => l.membershipId === r.id).map((l) => l.groupId) })) };
  });

  /**
   * Contas que já existem e ainda não são deste espaço, para escolher ao adicionar um membro.
   * Administrador da plataforma vê todas; os demais, só as pessoas com quem já dividem algum espaço
   * (não dá para listar as contas de espaços alheios).
   */
  app.get('/api/members/candidates', { preHandler: requirePerm('members.manage') }, async (req) => {
    const u = schema.users;
    const rows = await db.select({ id: u.id, name: u.name, email: u.email, username: u.username }).from(u)
      .where(and(
        eq(u.active, true), isNull(u.deletedAt),
        sql`not exists (select 1 from memberships m where m.user_id = ${u.id} and m.org_id = ${req.org!.id})`,
        req.user!.isSuperadmin ? undefined
          : sql`exists (select 1 from memberships m join memberships mine on mine.org_id = m.org_id and mine.user_id = ${req.user!.id} and mine.active where m.user_id = ${u.id})`,
      )).orderBy(u.name).limit(500);
    return { items: rows };
  });

  app.post('/api/members', { preHandler: requirePerm('members.manage') }, async (req) => {
    const body = parse(memberAddSchema, req.body);
    const orgId = req.org!.id;
    await assertGroupsInOrg(orgId, body.groupIds);
    await assertCanAssignGroups(req, body.groupIds, []);
    const result = await db.transaction(async (tx) => {
      let [u] = await tx.select().from(schema.users).where(and(sql`lower(${schema.users.email}) = ${body.email}`, isNull(schema.users.deletedAt)));
      const created = !u;
      // conta que já existe: só entra por aqui se quem adiciona já divide algum espaço com ela (a mesma
      // regra da lista "Conta que já existe"); senão qualquer um poria contas alheias no próprio espaço
      if (u && !req.user!.isSuperadmin) {
        const shared = await tx.execute(sql`select 1 from memberships m join memberships mine on mine.org_id = m.org_id and mine.user_id = ${req.user!.id} and mine.active where m.user_id = ${u.id} limit 1`);
        if (!shared.rows.length) throw badRequest('Já existe uma conta com este e-mail na plataforma. Peça ao administrador da plataforma para associá-la a este espaço.', 'account_exists');
      }
      if (!u) {
        if (!body.password || !body.name) throw badRequest('Usuário novo: informe nome e senha inicial');
        const username = body.username ?? (await freeUsername(usernameFromEmail(body.email)));
        if (body.username) await assertUsernameFree(body.username);
        // senha inicial definida pelo administrador é provisória
        [u] = await tx.insert(schema.users).values({ email: body.email, username, name: body.name, passwordHash: await hashPassword(body.password), mustChangePassword: true }).returning();
      }
      const [exists] = await tx.select().from(schema.memberships).where(and(eq(schema.memberships.orgId, orgId), eq(schema.memberships.userId, u.id)));
      if (exists) throw badRequest('Este usuário já é membro da organização');
      const [m] = await tx.insert(schema.memberships).values({ orgId, userId: u.id }).returning();
      if (body.groupIds.length) await tx.insert(schema.membershipGroups).values(body.groupIds.map((groupId) => ({ membershipId: m.id, groupId })));
      return { membership: m, user: u, created };
    });
    await audit(req, { action: 'member.add', entityType: 'membership', entityId: result.membership.id, description: `Adicionou ${result.user.name} (${body.email})`, details: { groups: await groupNames(body.groupIds), newAccount: result.created } });
    return { id: result.membership.id };
  });

  app.put<{ Params: { id: string } }>('/api/members/:id', { preHandler: requirePerm('members.manage') }, async (req) => {
    const body = parse(memberUpdateSchema, req.body);
    const orgId = req.org!.id;
    const [m] = await db.select().from(schema.memberships).where(and(eq(schema.memberships.id, req.params.id), eq(schema.memberships.orgId, orgId)));
    if (!m) throw notFound('Membro não encontrado');
    if (m.isOwner && body.active === false) throw badRequest('O dono da organização não pode ser desativado');
    const current = (await db.select({ g: schema.membershipGroups.groupId }).from(schema.membershipGroups).where(eq(schema.membershipGroups.membershipId, m.id))).map((r) => r.g);
    await assertCanManageMember(req, m, current);
    if (body.groupIds) await assertCanAssignGroups(req, body.groupIds, current);
    await db.transaction(async (tx) => {
      if (body.active !== undefined) await tx.update(schema.memberships).set({ active: body.active }).where(eq(schema.memberships.id, m.id));
      if (body.groupIds) {
        await assertGroupsInOrg(orgId, body.groupIds);
        await tx.delete(schema.membershipGroups).where(eq(schema.membershipGroups.membershipId, m.id));
        if (body.groupIds.length) await tx.insert(schema.membershipGroups).values(body.groupIds.map((groupId) => ({ membershipId: m.id, groupId })));
      }
    });
    const [who] = await db.select({ name: schema.users.name }).from(schema.users).where(eq(schema.users.id, m.userId));
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    if (body.active !== undefined && body.active !== m.active) changes.active = { from: m.active, to: body.active };
    if (body.groupIds && [...body.groupIds].sort().join() !== [...current].sort().join()) changes.groups = { from: await groupNames(current), to: await groupNames(body.groupIds) };
    await audit(req, { action: 'member.update', entityType: 'membership', entityId: m.id, description: `Alterou o acesso de ${who?.name ?? 'membro'}`, details: { changes } });
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>('/api/members/:id', { preHandler: requirePerm('members.manage') }, async (req) => {
    const [m] = await db.select().from(schema.memberships).where(and(eq(schema.memberships.id, req.params.id), eq(schema.memberships.orgId, req.org!.id)));
    if (!m) throw notFound('Membro não encontrado');
    if (m.isOwner) throw badRequest('O dono da organização não pode ser removido');
    const current = (await db.select({ g: schema.membershipGroups.groupId }).from(schema.membershipGroups).where(eq(schema.membershipGroups.membershipId, m.id))).map((r) => r.g);
    await assertCanManageMember(req, m, current);
    const [who] = await db.select({ name: schema.users.name, email: schema.users.email }).from(schema.users).where(eq(schema.users.id, m.userId));
    await db.delete(schema.memberships).where(eq(schema.memberships.id, m.id));
    await audit(req, { action: 'member.remove', entityType: 'membership', entityId: m.id, description: `Removeu ${who?.name ?? 'membro'} do espaço`, details: { email: who?.email, groups: await groupNames(current) } });
    return { ok: true };
  });

  // ---------------------------------------------------------- grupos
  app.get('/api/groups', { preHandler: requirePerm('groups.manage', 'members.manage') }, async (req) => {
    const rows = await db.select({
      id: schema.groups.id, name: schema.groups.name, description: schema.groups.description,
      isAdmin: schema.groups.isAdmin, permissions: schema.groups.permissions,
      members: sql<number>`(select count(*)::int from ${schema.membershipGroups} mg where mg.group_id = ${schema.groups.id})`,
    }).from(schema.groups).where(eq(schema.groups.orgId, req.org!.id)).orderBy(schema.groups.name);
    return { items: rows };
  });

  app.post('/api/groups', { preHandler: requirePerm('groups.manage') }, async (req) => {
    const body = parse(groupSchema, req.body);
    assertCanGrant(req, body, null);
    const [dup] = await db.select().from(schema.groups).where(and(eq(schema.groups.orgId, req.org!.id), eq(schema.groups.name, body.name)));
    if (dup) throw badRequest('Já existe um grupo com este nome');
    const [g] = await db.insert(schema.groups).values({ ...body, orgId: req.org!.id }).returning();
    await audit(req, { action: 'group.create', entityType: 'group', entityId: g.id, description: `Criou grupo ${g.name}`, details: body });
    return g;
  });

  app.put<{ Params: { id: string } }>('/api/groups/:id', { preHandler: requirePerm('groups.manage') }, async (req) => {
    const body = parse(groupSchema, req.body);
    const [before] = await db.select().from(schema.groups).where(and(eq(schema.groups.id, req.params.id), eq(schema.groups.orgId, req.org!.id)));
    if (!before) throw notFound('Grupo não encontrado');
    assertCanGrant(req, body, before);
    const [g] = await db.update(schema.groups).set(body).where(eq(schema.groups.id, before.id)).returning();
    const added = body.permissions.filter((p) => !before.permissions.includes(p));
    const removed = before.permissions.filter((p) => !(body.permissions as string[]).includes(p));
    await audit(req, {
      action: 'group.update', entityType: 'group', entityId: g.id, description: `Editou o grupo ${g.name}`,
      details: { changes: diff(before, g, ['name', 'description', 'isAdmin']), permissionsAdded: added, permissionsRemoved: removed },
    });
    return g;
  });

  app.delete<{ Params: { id: string } }>('/api/groups/:id', { preHandler: requirePerm('groups.manage') }, async (req) => {
    const [before] = await db.select().from(schema.groups).where(and(eq(schema.groups.id, req.params.id), eq(schema.groups.orgId, req.org!.id)));
    if (!before) throw notFound('Grupo não encontrado');
    if (!req.org!.isAdmin && (before.isAdmin || before.permissions.some((p) => !req.org!.can(p as Permission)))) throw forbidden('Só um administrador do espaço pode apagar um grupo com permissões que você não tem');
    const [g] = await db.delete(schema.groups).where(eq(schema.groups.id, before.id)).returning();
    await audit(req, { action: 'group.delete', entityType: 'group', entityId: g.id, description: `Apagou grupo ${g.name}`, details: { isAdmin: g.isAdmin, permissions: g.permissions } });
    return { ok: true };
  });

  // ---------------------------------------------------------- auditoria
  app.get<{ Querystring: AuditQuery }>('/api/audit', { preHandler: requirePerm('audit.view') }, async (req) => {
    return queryAudit(req.org!.id, { ...req.query, tz: req.org!.timezone }, !req.org!.can('bills.view_restricted'), 100, auditAreasFor(req.org!));
  });
  app.get('/api/audit/users', { preHandler: requirePerm('audit.view') }, async (req) => ({ items: await auditUsers(req.org!.id) }));
}

/** Campos que mudaram: { campo: { from, to } }. */
function diff<T extends Record<string, unknown>>(a: T, b: T, keys: Array<keyof T & string>) {
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of keys) if (JSON.stringify(a[k] ?? null) !== JSON.stringify(b[k] ?? null)) out[k] = { from: a[k] ?? null, to: b[k] ?? null };
  return out;
}

async function groupNames(ids: string[]) {
  if (!ids.length) return [];
  const rows = await db.select({ name: schema.groups.name }).from(schema.groups).where(inArray(schema.groups.id, ids));
  return rows.map((r) => r.name).sort();
}

/*
 * Anti-escalada: quem não é administrador do espaço só concede o que já tem.
 * - grupo: não pode marcar "Administrador" nem incluir permissões que não tem (as que o grupo já tinha podem ficar);
 *   não mexe em grupo de administradores.
 * - membro: só coloca a pessoa em grupos cujas permissões já tem; não mexe em administradores.
 */
function assertCanGrant(req: FastifyRequest, body: { isAdmin: boolean; permissions: string[] }, before: { isAdmin: boolean; permissions: string[] } | null) {
  if (req.org!.isAdmin) return;
  if (body.isAdmin || before?.isAdmin) throw forbidden('Só um administrador do espaço pode criar ou alterar grupos de administradores');
  // grupo que já dá o que você não tem: nem para tirar permissões (seria rebaixar quem está acima)
  if (before?.permissions.some((p) => !req.org!.can(p as Permission))) throw forbidden('Só um administrador do espaço pode alterar um grupo com permissões que você não tem');
  const extra = body.permissions.filter((p) => !req.org!.can(p as Permission));
  if (extra.length) throw forbidden(`Você não pode conceder permissões que não tem: ${extra.map((p) => PERMISSIONS[p as Permission]?.label ?? p).join('; ')}`);
}

async function assertCanAssignGroups(req: FastifyRequest, next: string[], current: string[]) {
  if (req.org!.isAdmin) return;
  const changed = [...next.filter((g) => !current.includes(g)), ...current.filter((g) => !next.includes(g))];
  if (!changed.length) return;
  const rows = await db.select().from(schema.groups).where(inArray(schema.groups.id, changed));
  for (const g of rows) {
    if (g.isAdmin || g.permissions.some((p) => !req.org!.can(p as Permission))) {
      throw forbidden(`Só um administrador do espaço pode colocar ou tirar alguém do grupo "${g.name}" (ele dá permissões que você não tem)`);
    }
  }
}

async function assertCanManageMember(req: FastifyRequest, m: { isOwner: boolean }, groupIds: string[]) {
  if (req.org!.isAdmin) return;
  if (m.isOwner) throw forbidden('Só um administrador do espaço pode alterar o dono');
  if (!groupIds.length) return;
  const rows = await db.select({ isAdmin: schema.groups.isAdmin, permissions: schema.groups.permissions }).from(schema.groups).where(inArray(schema.groups.id, groupIds));
  if (rows.some((g) => g.isAdmin)) throw forbidden('Só um administrador do espaço pode alterar outro administrador');
  // quem tem mais permissões que você não pode ser desativado, removido nem rebaixado por você
  if (rows.some((g) => g.permissions.some((p) => !req.org!.can(p as Permission)))) throw forbidden('Só um administrador do espaço pode alterar um membro que tem permissões que você não tem');
}

async function assertGroupsInOrg(orgId: string, ids: string[]) {
  if (!ids.length) return;
  const rows = await db.select({ id: schema.groups.id }).from(schema.groups).where(and(eq(schema.groups.orgId, orgId), inArray(schema.groups.id, ids)));
  if (rows.length !== new Set(ids).size) throw badRequest('Grupo inválido');
}
