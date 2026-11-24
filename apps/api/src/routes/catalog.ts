import type { FastifyInstance } from 'fastify';
import { and, eq, sql, ne, notInArray } from 'drizzle-orm';
import { categoryCreateSchema, categoryUpdateSchema, folderCreateSchema, folderUpdateSchema } from '@nopaper/shared';
import { db, schema } from '../db/client.js';
import { parse } from '../lib/validate.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { requirePerm } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { getPayrollSettings } from '../services/payroll.js';
import { canSeeCategory, hiddenCategoryIds } from '../services/bills.js';

/** É a categoria em que a folha lança os salários? (só espaço Empresa tem folha) */
const isPayrollCategory = async (org: { id: string; kind: string }, categoryId: string) => org.kind === 'company' && (await getPayrollSettings(org.id)).categoryId === categoryId;

const anyView = requirePerm('payable.view', 'receivable.view', 'cards.view', 'reports.view');

export default async function catalogRoutes(app: FastifyInstance) {
  // ------------------------------------------------------------ categorias
  app.get('/api/categories', { preHandler: anyView }, async (req) => {
    const hidden = await hiddenCategoryIds(req);
    const rows = await db.select({
      id: schema.categories.id, label: schema.categories.label, color: schema.categories.color,
      kind: schema.categories.kind, isRestricted: schema.categories.isRestricted, isSystem: schema.categories.isSystem,
      usage: sql<number>`(select count(*)::int from bills b where b.category_id = categories.id)`,
    }).from(schema.categories)
      .where(and(eq(schema.categories.orgId, req.org!.id), hidden.length ? notInArray(schema.categories.id, hidden) : undefined))
      .orderBy(schema.categories.label);
    // ordem alfabética em português (acentos e maiúsculas não mudam a posição)
    return { items: rows.sort((a, b) => a.label.localeCompare(b.label, 'pt-BR', { sensitivity: 'base' })) };
  });

  app.post('/api/categories', { preHandler: requirePerm('bills.categories') }, async (req) => {
    const body = parse(categoryCreateSchema, req.body);
    if (body.isRestricted && !req.org!.can('bills.view_restricted')) throw forbidden('Sem permissão para criar categorias restritas');
    const [dup] = await db.select().from(schema.categories)
      .where(and(eq(schema.categories.orgId, req.org!.id), sql`lower(${schema.categories.label}) = lower(${body.label})`));
    if (dup) throw badRequest(!(await canSeeCategory(req, dup)) ? 'Este nome já está em uso neste espaço. Escolha outro.' : `Já existe a categoria "${dup.label}"`);
    const [c] = await db.insert(schema.categories).values({ ...body, orgId: req.org!.id, createdBy: req.user?.id ?? null }).returning();
    await audit(req, { action: 'category.create', entityType: 'category', entityId: c.id, description: `Criou categoria ${c.label}`, details: { ...body, restricted: c.isRestricted } });
    return c;
  });

  app.put<{ Params: { id: string } }>('/api/categories/:id', { preHandler: requirePerm('bills.categories') }, async (req) => {
    const body = parse(categoryUpdateSchema, req.body);
    const [c] = await db.select().from(schema.categories).where(and(eq(schema.categories.id, req.params.id), eq(schema.categories.orgId, req.org!.id)));
    if (!c || !(await canSeeCategory(req, c))) throw notFound('Categoria não encontrada');
    if (body.isRestricted !== undefined && body.isRestricted !== c.isRestricted) {
      if (!req.org!.can('bills.view_restricted')) throw forbidden('Sem permissão para alterar restrição');
      const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.bills).where(eq(schema.bills.categoryId, c.id));
      // regra herdada do sistema anterior: nunca tornar restrita uma categoria que já tem contas (evita vazamento retroativo)
      if (body.isRestricted && n > 0) throw badRequest(`Categoria em uso por ${n} conta(s). Crie uma nova categoria restrita em vez de converter esta.`);
      // a categoria dos salários é sempre restrita (regra da folha): tirar a marca aqui mostraria os salários a quem vê contas a pagar
      if (!body.isRestricted && await isPayrollCategory(req.org!, c.id)) throw badRequest('Esta é a categoria das contas de salário da folha: ela precisa continuar restrita. Para usar outra, troque em Folha → Configurar.');
    }
    if (body.label && body.label.toLowerCase() !== c.label.toLowerCase()) {
      const [dup] = await db.select().from(schema.categories)
        .where(and(eq(schema.categories.orgId, req.org!.id), sql`lower(${schema.categories.label}) = lower(${body.label})`, ne(schema.categories.id, c.id)));
      if (dup) throw badRequest(!(await canSeeCategory(req, dup)) ? 'Este nome já está em uso neste espaço. Escolha outro.' : `Já existe a categoria "${dup.label}"`);
    }
    const [u] = await db.transaction(async (tx) => {
      // sem a restrição, a liberação por grupo deixa de fazer sentido (e não volta sozinha se restringir de novo)
      if (c.isRestricted && body.isRestricted === false) await tx.delete(schema.groupCategories).where(eq(schema.groupCategories.categoryId, c.id));
      return tx.update(schema.categories).set(body).where(eq(schema.categories.id, c.id)).returning();
    });
    await audit(req, { action: 'category.update', entityType: 'category', entityId: c.id, details: { ...body, restricted: u.isRestricted } });
    return u;
  });

  app.delete<{ Params: { id: string } }>('/api/categories/:id', { preHandler: requirePerm('bills.categories') }, async (req) => {
    const [c] = await db.select().from(schema.categories).where(and(eq(schema.categories.id, req.params.id), eq(schema.categories.orgId, req.org!.id)));
    if (!c || !(await canSeeCategory(req, c))) throw notFound('Categoria não encontrada');
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.bills).where(eq(schema.bills.categoryId, c.id));
    if (n > 0) throw badRequest(`Categoria em uso por ${n} conta(s). Mova ou apague essas contas antes.`);
    const [{ cards }] = await db.select({ cards: sql<number>`count(*)::int` }).from(schema.cards).where(eq(schema.cards.billCategoryId, c.id));
    if (cards > 0) throw badRequest(`Categoria usada pela fatura de ${cards} cartão(ões). Troque a categoria no cadastro do cartão antes.`);
    if (await isPayrollCategory(req.org!, c.id)) throw badRequest('Esta é a categoria das contas de salário da folha. Troque em Folha → Configurar antes de apagar.');
    await db.delete(schema.categories).where(eq(schema.categories.id, c.id));
    await audit(req, { action: 'category.delete', entityType: 'category', entityId: c.id, description: `Apagou categoria ${c.label}`, details: { restricted: c.isRestricted } });
    return { ok: true };
  });

  // ------------------------------------------------------------ pastas
  app.get('/api/folders', { preHandler: anyView }, async (req) => {
    const hidden = await hiddenCategoryIds(req);
    const rows = await db.select({
      id: schema.folders.id, name: schema.folders.name, label: schema.folders.label, color: schema.folders.color,
      // a contagem não inclui contas de categoria restrita para quem não as vê
      usage: hidden.length
        ? sql<number>`(select count(*)::int from bills b where b.folder_id = folders.id and b.category_id not in (${sql.join(hidden.map((h) => sql`${h}::uuid`), sql`, `)}))`
        : sql<number>`(select count(*)::int from bills b where b.folder_id = folders.id)`,
    }).from(schema.folders).where(eq(schema.folders.orgId, req.org!.id)).orderBy(schema.folders.label);
    return { items: rows.sort((a, b) => a.label.localeCompare(b.label, 'pt-BR', { sensitivity: 'base' })) };
  });

  app.post('/api/folders', { preHandler: requirePerm('bills.folders') }, async (req) => {
    const body = parse(folderCreateSchema, req.body);
    const [dup] = await db.select().from(schema.folders).where(and(eq(schema.folders.orgId, req.org!.id), sql`lower(${schema.folders.name}) = lower(${body.name})`));
    if (dup) throw badRequest(`Já existe pasta com nome "${body.name}"`);
    const [f] = await db.insert(schema.folders).values({ ...body, orgId: req.org!.id, createdBy: req.user?.id ?? null }).returning();
    await audit(req, { action: 'folder.create', entityType: 'folder', entityId: f.id, description: `Criou pasta ${f.label}`, details: body });
    return f;
  });

  app.put<{ Params: { id: string } }>('/api/folders/:id', { preHandler: requirePerm('bills.folders') }, async (req) => {
    const body = parse(folderUpdateSchema, req.body);
    if (body.name) {
      const [dup] = await db.select().from(schema.folders).where(and(eq(schema.folders.orgId, req.org!.id), sql`lower(${schema.folders.name}) = lower(${body.name})`, ne(schema.folders.id, req.params.id)));
      if (dup) throw badRequest(`Já existe pasta com nome "${body.name}"`);
    }
    const [f] = await db.update(schema.folders).set(body).where(and(eq(schema.folders.id, req.params.id), eq(schema.folders.orgId, req.org!.id))).returning();
    if (!f) throw notFound('Pasta não encontrada');
    await audit(req, { action: 'folder.update', entityType: 'folder', entityId: f.id, details: body });
    return f;
  });

  app.delete<{ Params: { id: string } }>('/api/folders/:id', { preHandler: requirePerm('bills.folders') }, async (req) => {
    const [f] = await db.delete(schema.folders).where(and(eq(schema.folders.id, req.params.id), eq(schema.folders.orgId, req.org!.id))).returning();
    if (!f) throw notFound('Pasta não encontrada');
    await audit(req, { action: 'folder.delete', entityType: 'folder', entityId: f.id, description: `Apagou pasta ${f.label}` });
    return { ok: true };
  });
}
