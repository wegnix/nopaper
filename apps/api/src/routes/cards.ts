import type { FastifyInstance } from 'fastify';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { billPerm, cardSchema, cardTxSchema, cardTxUpdateSchema, cycleForPurchase, cycleForRef, fromCents, toCents, todayISO } from '@nopaper/shared';
import { db, schema } from '../db/client.js';
import { parse } from '../lib/validate.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { requirePerm } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { assertCategoryUsable, assertFolder, attachmentsFor, deleteBillsWithFiles, serialize } from '../services/bills.js';
import {
  loadCard, ensureStatement, createPurchase, deleteTransactions, limitUsed, statementStatus, statementsOf, syncStatementBill,
} from '../services/cards.js';

const view = requirePerm('cards.view');
const edit = requirePerm('cards.edit');
const manage = requirePerm('cards.manage');

export default async function cardRoutes(app: FastifyInstance) {
  app.get('/api/cards', { preHandler: view }, async (req) => {
    const today = todayISO(req.org!.timezone);
    const rows = await db.select().from(schema.cards).where(eq(schema.cards.orgId, req.org!.id)).orderBy(asc(schema.cards.name));
    const items = [];
    for (const c of rows) {
      const cur = cycleForPurchase(today, c.closingDay, c.dueDay);
      const [st] = await db.select().from(schema.cardStatements).where(and(eq(schema.cardStatements.cardId, c.id), eq(schema.cardStatements.ref, cur.ref)));
      const [{ total }] = st
        ? await db.select({ total: sql<string>`coalesce(sum(${schema.cardTransactions.amount}),0)::text` }).from(schema.cardTransactions).where(eq(schema.cardTransactions.statementId, st.id))
        : [{ total: '0' }];
      items.push({ ...c, limitUsed: await limitUsed(c.id), currentRef: cur.ref, currentTotal: fromCents(toCents(total)), currentClosing: cur.closingDate, currentDue: cur.dueDate });
    }
    return { items };
  });

  app.post('/api/cards', { preHandler: manage }, async (req) => {
    const body = parse(cardSchema, req.body);
    await assertCategoryUsable(req, body.billCategoryId, 'payable');
    await assertFolder(req, body.billFolderId);
    const [c] = await db.insert(schema.cards).values({ ...body, orgId: req.org!.id, createdBy: req.user!.id }).returning();
    await audit(req, { action: 'card.create', entityType: 'card', entityId: c.id, description: `Cadastrou o cartão ${c.name}` });
    return c;
  });

  app.put<{ Params: { id: string } }>('/api/cards/:id', { preHandler: manage }, async (req) => {
    const body = parse(cardSchema, req.body);
    const c = await loadCard(req.org!.id, req.params.id);
    await assertCategoryUsable(req, body.billCategoryId, 'payable');
    await assertFolder(req, body.billFolderId);
    const [u] = await db.update(schema.cards).set(body).where(eq(schema.cards.id, c.id)).returning();
    // atualiza nome/categoria/pasta das contas das faturas ainda não pagas
    await db.transaction(async (tx) => {
      const sts = await tx.select({ id: schema.cardStatements.id }).from(schema.cardStatements).where(eq(schema.cardStatements.cardId, c.id));
      for (const s of sts) await syncStatementBill(tx, s.id, req.user!.id);
    });
    await audit(req, { action: 'card.update', entityType: 'card', entityId: c.id, details: body });
    return u;
  });

  /**
   * O que sai junto com o cartão: compras/parcelas, faturas e as contas a pagar dessas faturas.
   * Fatura já paga (com valor) bloqueia — é histórico financeiro: reverta o pagamento ou desative o cartão.
   */
  async function deletionImpact(cardId: string) {
    const [tx] = await db.select({ n: sql<number>`count(*)::int`, purchases: sql<number>`count(distinct ${schema.cardTransactions.groupId})::int` })
      .from(schema.cardTransactions).where(eq(schema.cardTransactions.cardId, cardId));
    const bills = await db.select({ id: schema.bills.id, status: schema.bills.status, amount: schema.bills.amount })
      .from(schema.cardStatements).innerJoin(schema.bills, eq(schema.bills.id, schema.cardStatements.billId))
      .where(eq(schema.cardStatements.cardId, cardId));
    const paid = bills.filter((b) => b.status === 'paid' && toCents(b.amount) > 0);
    const removable = bills.filter((b) => !paid.includes(b));
    const [{ files }] = removable.length
      ? await db.select({ files: sql<number>`count(*)::int` }).from(schema.attachments).where(inArray(schema.attachments.billId, removable.map((b) => b.id)))
      : [{ files: 0 }];
    return { transactions: tx.n, purchases: tx.purchases, paidStatements: paid.length, statementBills: removable.map((b) => b.id), attachments: files };
  }

  app.get<{ Params: { id: string } }>('/api/cards/:id/delete-impact', { preHandler: manage }, async (req) => {
    const c = await loadCard(req.org!.id, req.params.id);
    const i = await deletionImpact(c.id);
    return {
      transactions: i.transactions, purchases: i.purchases, paidStatements: i.paidStatements, statementBills: i.statementBills.length,
      attachments: i.attachments, canDeleteBills: req.org!.can(billPerm('payable', 'delete')),
    };
  });

  app.delete<{ Params: { id: string }; Querystring: { confirmName?: string } }>('/api/cards/:id', { preHandler: manage }, async (req) => {
    const c = await loadCard(req.org!.id, req.params.id);
    const i = await deletionImpact(c.id);
    if (i.paidStatements > 0) {
      throw conflict(`O cartão tem ${i.paidStatements} fatura(s) já paga(s). Para manter o histórico, desative o cartão em vez de apagar (ou reverta os pagamentos antes).`);
    }
    if (i.statementBills.length && !req.org!.can(billPerm('payable', 'delete'))) {
      throw forbidden('Apagar este cartão remove as contas a pagar das faturas dele, e você não tem permissão para apagar contas a pagar.');
    }
    // com lançamentos, exige o nome do cartão digitado (confirmação também no servidor)
    if (i.transactions > 0 && (req.query.confirmName ?? '').trim().toLowerCase() !== c.name.trim().toLowerCase()) {
      throw badRequest('Digite o nome do cartão para confirmar a exclusão', 'confirm_name');
    }
    await db.transaction(async (tx) => {
      await deleteBillsWithFiles(tx, i.statementBills);
      await tx.delete(schema.cards).where(eq(schema.cards.id, c.id)); // faturas e lançamentos saem em cascata
    });
    await audit(req, {
      action: 'card.delete', entityType: 'card', entityId: c.id,
      description: `Apagou o cartão ${c.name}${i.transactions ? ` (${i.purchases} compra(s), ${i.statementBills.length} fatura(s))` : ''}`,
      details: { transactions: i.transactions, purchases: i.purchases, statementBills: i.statementBills.length, attachments: i.attachments },
    });
    return { ok: true };
  });

  /** Fatura de um mês (ref = YYYY-MM do vencimento) com lançamentos. */
  app.get<{ Params: { id: string }; Querystring: { ref?: string } }>('/api/cards/:id/statement', { preHandler: view }, async (req) => {
    const c = await loadCard(req.org!.id, req.params.id);
    const today = todayISO(req.org!.timezone);
    const ref = req.query.ref && /^\d{4}-\d{2}$/.test(req.query.ref) ? req.query.ref : cycleForPurchase(today, c.closingDay, c.dueDay).ref;
    const all = await statementsOf(c.id);
    let st = all.find((s) => s.ref === ref);
    if (!st) {
      // fatura virtual (ainda sem lançamentos)
      const cyc = cycleForRef(ref, c.closingDay, c.dueDay);
      return { card: c, ref, statement: { id: null, ...cyc, billId: null }, status: statementStatus(cyc, undefined, today), total: '0.00', bill: null, items: [], refs: all.map((s) => s.ref) };
    }
    const items = await db.select().from(schema.cardTransactions).where(eq(schema.cardTransactions.statementId, st.id))
      .orderBy(asc(schema.cardTransactions.purchaseDate), asc(schema.cardTransactions.createdAt));
    const bill = st.billId ? (await db.select().from(schema.bills).where(eq(schema.bills.id, st.billId)))[0] : undefined;
    const total = fromCents(items.reduce((a, t) => a + toCents(t.amount), 0));
    return {
      card: c, ref, statement: st, status: statementStatus(st, bill, today), total,
      bill: bill ? serialize(bill, (await attachmentsFor([bill.id])).get(bill.id)) : null,
      items, refs: all.map((s) => s.ref),
    };
  });

  // ------------------------------------------------------------ lançamentos
  app.post('/api/card-transactions', { preHandler: edit }, async (req) => {
    const body = parse(cardTxSchema, req.body);
    const card = await loadCard(req.org!.id, body.cardId);
    await assertCategoryUsable(req, body.categoryId, 'payable');
    const r = await db.transaction((tx) => createPurchase(tx, card, req.user!.id, body));
    await audit(req, { action: 'card.tx.create', entityType: 'card_tx', entityId: r.groupId, description: `Lançou "${body.description}" no ${card.name} (${body.installments}x)`, details: body });
    return r;
  });

  app.put<{ Params: { id: string } }>('/api/card-transactions/:id', { preHandler: edit }, async (req) => {
    const body = parse(cardTxUpdateSchema, req.body);
    const [t] = await db.select().from(schema.cardTransactions).where(and(eq(schema.cardTransactions.id, req.params.id), eq(schema.cardTransactions.orgId, req.org!.id)));
    if (!t) throw notFound('Lançamento não encontrado');
    if (body.categoryId) await assertCategoryUsable(req, body.categoryId, 'payable');
    const card = await loadCard(req.org!.id, t.cardId);
    const structural = (body.amount !== undefined && body.amount !== t.totalAmount) || (body.purchaseDate !== undefined && body.purchaseDate !== t.purchaseDate) || (body.installments !== undefined && body.installments !== t.totalInstallments);
    await db.transaction(async (tx) => {
      if (structural) {
        // recria a compra inteira mantendo o group id
        const group = await tx.select().from(schema.cardTransactions).where(eq(schema.cardTransactions.groupId, t.groupId)).orderBy(asc(schema.cardTransactions.installmentNumber));
        const firstSt = (await tx.select().from(schema.cardStatements).where(eq(schema.cardStatements.id, group[0].statementId)))[0];
        await deleteTransactions(tx, group.map((g) => g.id), req.user!.id);
        await createPurchase(tx, card, req.user!.id, {
          description: body.description ?? t.description, categoryId: body.categoryId ?? t.categoryId,
          amount: body.amount ?? t.totalAmount, purchaseDate: body.purchaseDate ?? t.purchaseDate,
          installments: body.installments ?? t.totalInstallments, notes: body.notes ?? t.notes,
          firstRef: body.purchaseDate && body.purchaseDate !== t.purchaseDate ? null : firstSt.ref,
        }, t.groupId);
      } else {
        const patch = { description: body.description, categoryId: body.categoryId, notes: body.notes };
        const where = body.scope === 'group' ? eq(schema.cardTransactions.groupId, t.groupId) : eq(schema.cardTransactions.id, t.id);
        await tx.update(schema.cardTransactions).set(patch).where(where);
      }
    });
    await audit(req, { action: 'card.tx.update', entityType: 'card_tx', entityId: t.groupId, description: `Editou "${t.description}"`, details: body });
    return { ok: true };
  });

  app.delete<{ Params: { id: string }; Querystring: { scope?: string } }>('/api/card-transactions/:id', { preHandler: edit }, async (req) => {
    const scope = parse(z.enum(['one', 'group', 'forward']), req.query.scope ?? 'group');
    const [t] = await db.select().from(schema.cardTransactions).where(and(eq(schema.cardTransactions.id, req.params.id), eq(schema.cardTransactions.orgId, req.org!.id)));
    if (!t) throw notFound('Lançamento não encontrado');
    const n = await db.transaction(async (tx) => {
      const group = await tx.select().from(schema.cardTransactions).where(eq(schema.cardTransactions.groupId, t.groupId));
      const ids = scope === 'one' ? [t.id] : scope === 'forward' ? group.filter((g) => g.installmentNumber >= t.installmentNumber).map((g) => g.id) : group.map((g) => g.id);
      return deleteTransactions(tx, ids, req.user!.id);
    });
    await audit(req, { action: 'card.tx.delete', entityType: 'card_tx', entityId: t.groupId, description: `Apagou "${t.description}" (${n} parcela(s))` });
    return { deleted: n };
  });

  /** Move um lançamento para outra fatura (ex.: compra que o banco jogou para o mês seguinte). */
  app.post<{ Params: { id: string } }>('/api/card-transactions/:id/move', { preHandler: edit }, async (req) => {
    const { ref } = parse(z.object({ ref: z.string().regex(/^\d{4}-\d{2}$/) }), req.body);
    const [t] = await db.select().from(schema.cardTransactions).where(and(eq(schema.cardTransactions.id, req.params.id), eq(schema.cardTransactions.orgId, req.org!.id)));
    if (!t) throw notFound('Lançamento não encontrado');
    const card = await loadCard(req.org!.id, t.cardId);
    await db.transaction(async (tx) => {
      const st = await ensureStatement(tx, card, ref);
      await tx.update(schema.cardTransactions).set({ statementId: st.id }).where(eq(schema.cardTransactions.id, t.id));
      await syncStatementBill(tx, t.statementId, req.user!.id);
      await syncStatementBill(tx, st.id, req.user!.id);
    });
    return { ok: true };
  });
}
