import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, eq, gte, lte, lt, notInArray, sql, desc } from 'drizzle-orm';
import { BILL_TYPES, fromCents } from '@nopaper/shared';
import { db, schema } from '../db/client.js';
import { ensureCardCategories } from '../services/cardCategories.js';
import { parse } from '../lib/validate.js';
import { forbidden } from '../lib/errors.js';
import { requirePerm } from '../lib/auth.js';
import { orgToday, restrictedCategoryIds, viewPerm, visibilityCond } from '../services/bills.js';

const querySchema = z.object({
  type: z.enum(BILL_TYPES),
  year: z.coerce.number().int().min(2000).max(2100),
});

const cents = sql<number>`coalesce(sum(round(${schema.bills.amount} * 100)), 0)::bigint`;
const paidCents = sql<number>`coalesce(sum(round(${schema.bills.amount} * 100)) filter (where ${schema.bills.status} = 'paid'), 0)::bigint`;
const m = (n: number | string) => fromCents(Number(n));

export default async function reportRoutes(app: FastifyInstance) {
  app.get('/api/reports/overview', { preHandler: requirePerm('reports.view') }, async (req) => {
    const q = parse(querySchema, req.query);
    if (!req.org!.can(viewPerm(q.type))) throw forbidden();
    const orgId = req.org!.id;
    const today = orgToday(req);
    const from = `${q.year}-01-01`, to = `${q.year}-12-31`;
    const vis = await visibilityCond(req);
    const base = (type: string, f = from, t = to) => and(eq(schema.bills.orgId, orgId), eq(schema.bills.type, type), gte(schema.bills.dueDate, f), lte(schema.bills.dueDate, t), vis);
    const where = base(q.type);
    const overdueCents = sql<number>`coalesce(sum(round(${schema.bills.amount} * 100)) filter (where ${schema.bills.status} = 'pending' and ${schema.bills.dueDate} < ${today}), 0)::bigint`;

    const monthExpr = sql<number>`extract(month from ${schema.bills.dueDate})::int`;
    const [months, byCategory, byFolder, top, prev, other] = await Promise.all([
      db.select({ month: monthExpr, total: cents, paid: paidCents, overdue: overdueCents, count: sql<number>`count(*)::int` })
        .from(schema.bills).where(where).groupBy(monthExpr),
      db.select({ categoryId: schema.bills.categoryId, total: cents, paid: paidCents, count: sql<number>`count(*)::int` })
        .from(schema.bills).where(where).groupBy(schema.bills.categoryId).orderBy(desc(cents)),
      db.select({ folderId: schema.bills.folderId, total: cents, count: sql<number>`count(*)::int` })
        .from(schema.bills).where(where).groupBy(schema.bills.folderId).orderBy(desc(cents)),
      db.select({ description: sql<string>`min(${schema.bills.description})`, total: cents, count: sql<number>`count(*)::int` })
        .from(schema.bills).where(where).groupBy(sql`lower(${schema.bills.description})`).orderBy(desc(cents)).limit(10),
      db.select({ total: cents }).from(schema.bills).where(base(q.type, `${q.year - 1}-01-01`, `${q.year - 1}-12-31`)),
      // o outro lado (pagar x receber) para o saldo mensal — só se puder ver
      req.org!.can(viewPerm(q.type === 'payable' ? 'receivable' : 'payable'))
        ? db.select({ month: monthExpr, total: cents }).from(schema.bills).where(base(q.type === 'payable' ? 'receivable' : 'payable')).groupBy(monthExpr)
        : Promise.resolve(null),
    ]);

    // gastos dentro das faturas de cartão (por categoria da compra), faturas que vencem no ano
    let cards: Array<{ categoryId: string | null; label: string; color: string; total: string; count: number }> | null = null;
    if (q.type === 'payable' && req.org!.can('cards.view')) {
      await ensureCardCategories(orgId);
      const ct = schema.cardTransactions;
      const c = sql<number>`coalesce(sum(round(${ct.amount} * 100)), 0)::bigint`;
      const rows = await db.select({ categoryId: ct.categoryId, label: schema.cardCategories.label, color: schema.cardCategories.color, total: c, count: sql<number>`count(*)::int` })
        .from(ct).innerJoin(schema.cardStatements, eq(schema.cardStatements.id, ct.statementId))
        .leftJoin(schema.cardCategories, eq(schema.cardCategories.id, ct.categoryId))
        .where(and(eq(ct.orgId, orgId), gte(schema.cardStatements.dueDate, from), lte(schema.cardStatements.dueDate, to)))
        .groupBy(ct.categoryId, schema.cardCategories.label, schema.cardCategories.color).orderBy(desc(c));
      cards = rows.filter((r) => Number(r.total) > 0).map((r) => ({ categoryId: r.categoryId, label: r.label ?? 'Sem categoria', color: r.color ?? 'slate', total: m(r.total), count: r.count }));
    }

    const mm = new Map(months.map((r) => [r.month, r]));
    const om = other ? new Map(other.map((r) => [r.month, Number(r.total)])) : null;
    const total = months.reduce((a, r) => a + Number(r.total), 0);
    const paid = months.reduce((a, r) => a + Number(r.paid), 0);
    const overdue = months.reduce((a, r) => a + Number(r.overdue), 0);
    // contas vencidas de anos anteriores ainda abertas (contexto para o ano corrente)
    const [olderOverdue] = await db.select({ total: cents, count: sql<number>`count(*)::int` }).from(schema.bills)
      .where(and(eq(schema.bills.orgId, orgId), eq(schema.bills.type, q.type), eq(schema.bills.status, 'pending'), lt(schema.bills.dueDate, from), vis));

    return {
      type: q.type, year: q.year, today,
      totals: { total: m(total), paid: m(paid), pending: m(total - paid), overdue: m(overdue), count: months.reduce((a, r) => a + r.count, 0), previousYear: m(prev[0]?.total ?? 0) },
      olderOverdue: { total: m(olderOverdue.total), count: olderOverdue.count },
      months: Array.from({ length: 12 }, (_, i) => {
        const r = mm.get(i + 1);
        const t = Number(r?.total ?? 0), p = Number(r?.paid ?? 0);
        return { month: i + 1, total: m(t), paid: m(p), pending: m(t - p), overdue: m(r?.overdue ?? 0), count: r?.count ?? 0, other: om ? m(om.get(i + 1) ?? 0) : null };
      }),
      byCategory: byCategory.map((r) => ({ categoryId: r.categoryId, total: m(r.total), paid: m(r.paid), count: r.count })),
      byFolder: byFolder.map((r) => ({ folderId: r.folderId, total: m(r.total), count: r.count })),
      top: top.map((r) => ({ description: r.description, total: m(r.total), count: r.count })),
      cards,
    };
  });
}
