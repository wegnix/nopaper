import type { FastifyInstance } from 'fastify';
import { and, eq, gt, inArray, or, sql, ne } from 'drizzle-orm';
import {
  billCreateSchema, billUpdateSchema, billListQuerySchema, paySchema, bulkPaySchema, restructureSchema,
  deleteModeSchema, BILL_TYPES, type BillType,
  billPerm, isPeriodic,
} from '@nopaper/shared';
import { z } from 'zod';
import { db, schema } from '../db/client.js';
import { parse } from '../lib/validate.js';
import { badRequest, forbidden } from '../lib/errors.js';
import { requireOrg } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import {
  loadBill, assertCategoryUsable, assertFolder, createBills, listBills, summary, serialize, serializeMany,
  attachmentsFor, viewPerm, createPerm, orgToday, seriesRows, headIdOf, deleteBillsWithFiles,
  planOccurrences, recurrenceDayFor, restrictedCategoryIds, type BillRow,
} from '../services/bills.js';

const typeLabel = (t: string) => (t === 'payable' ? 'conta a pagar' : 'conta a receber');

export default async function billRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireOrg);

  const isRestricted = async (orgId: string, categoryId: string) => (await restrictedCategoryIds(orgId)).includes(categoryId);

  app.get('/api/bills', async (req) => {
    const q = parse(billListQuerySchema, req.query);
    if (!req.org!.can(viewPerm(q.type))) throw forbidden();
    return { items: await listBills(req, q) };
  });

  app.get('/api/bills/summary', async (req) => {
    const q = parse(z.object({
      type: z.enum(BILL_TYPES), year: z.coerce.number().int(), month: z.coerce.number().int().min(1).max(12),
    }), req.query);
    if (!req.org!.can(viewPerm(q.type))) throw forbidden();
    return summary(req, q.type, q.year, q.month);
  });

  app.get<{ Params: { id: string } }>('/api/bills/:id', async (req) => {
    const b = await loadBill(req, req.params.id);
    const att = await attachmentsFor([b.id]);
    return serialize(b, att.get(b.id));
  });

  app.get<{ Params: { id: string } }>('/api/bills/:id/series', async (req) => {
    const b = await loadBill(req, req.params.id);
    return { items: await serializeMany(await seriesRows(db, b)) };
  });

  // -------------------------------------------------------------- criar
  app.post('/api/bills', async (req, reply) => {
    const body = parse(billCreateSchema, req.body);
    if (!req.org!.can(createPerm(body.type))) throw forbidden('Sem permissão para cadastrar');
    if (body.paidAt && !req.org!.can(billPerm(body.type, 'pay'))) throw forbidden('Sem permissão para cadastrar já como paga');
    const cat = await assertCategoryUsable(req, body.categoryId, body.type);
    await assertFolder(req, body.folderId);
    const rows = await db.transaction((tx) => createBills(tx, req.org!.id, req.user!.id, body));
    await audit(req, {
      action: `${body.type}.create`, entityType: 'bill', entityId: rows[0].id,
      description: `Criou ${typeLabel(body.type)} "${body.description}" (${body.recurrenceType}, ${rows.length} lançamento(s))`,
      details: { recurrenceType: body.recurrenceType, rows: rows.length, restricted: cat.isRestricted },
    });
    reply.code(201);
    return { headId: rows[0].id, items: await serializeMany(rows) };
  });

  // -------------------------------------------------------------- editar
  app.put<{ Params: { id: string } }>('/api/bills/:id', async (req) => {
    const body = parse(billUpdateSchema, req.body);
    const b = await loadBill(req, req.params.id, 'edit');
    const type = b.type as BillType;
    const touchesPayment = (body.status !== undefined && body.status !== b.status)
      || (b.status === 'paid' && ((body.paidAt !== undefined && body.paidAt !== b.paidAt) || (body.paidAmount !== undefined && body.paidAmount !== b.paidAmount)));
    if (touchesPayment && !req.org!.can(billPerm(type, 'pay'))) throw forbidden('Sem permissão para dar baixa ou mudar o pagamento');
    if (b.statementId && ((body.amount && body.amount !== b.amount) || (body.dueDate && body.dueDate !== b.dueDate))) {
      throw badRequest('O valor e o vencimento desta conta vêm da fatura do cartão. Ajuste os lançamentos na tela de Cartões.');
    }
    if (b.payrollEntryId && ((body.amount && body.amount !== b.amount) || (body.dueDate && body.dueDate !== b.dueDate))) {
      throw badRequest('O valor e o vencimento deste salário vêm da Folha de pagamento. Ajuste o lançamento lá.');
    }
    if (body.categoryId && body.categoryId !== b.categoryId) await assertCategoryUsable(req, body.categoryId, type);
    if (body.folderId) await assertFolder(req, body.folderId);
    const today = orgToday(req);

    const patch: Partial<BillRow> = {};
    const fields = ['description', 'categoryId', 'folderId', 'amount', 'dueDate', 'relatedPerson', 'notes', 'barcode', 'pixKey', 'paymentMethod'] as const;
    for (const f of fields) if (body[f] !== undefined) (patch as Record<string, unknown>)[f] = body[f];
    const targetStatus = body.status ?? b.status;
    if (targetStatus === 'paid') {
      patch.status = 'paid';
      patch.paidAt = body.paidAt ?? b.paidAt ?? today;
      patch.paidAmount = body.paidAmount ?? b.paidAmount ?? (patch.amount as string | undefined) ?? b.amount;
    } else {
      patch.status = 'pending'; patch.paidAt = null; patch.paidAmount = null;
    }

    const result = await db.transaction(async (tx) => {
      const [u] = await tx.update(schema.bills).set(patch).where(eq(schema.bills.id, b.id)).returning();
      let cascaded = 0;
      if (body.cascade && (b.parentId || b.recurrenceType !== 'once')) {
        const cascadable = ['description', 'categoryId', 'folderId', 'amount', 'relatedPerson', 'notes', 'pixKey', 'paymentMethod'] as const;
        const cpatch: Record<string, unknown> = {};
        for (const f of cascadable) if (body[f] !== undefined) cpatch[f] = body[f];
        if (Object.keys(cpatch).length) {
          const headId = headIdOf(b);
          const r = await tx.update(schema.bills).set(cpatch).where(and(
            or(eq(schema.bills.id, headId), eq(schema.bills.parentId, headId)),
            eq(schema.bills.status, 'pending'), ne(schema.bills.id, b.id),
            gt(schema.bills.dueDate, b.dueDate),
          )).returning({ id: schema.bills.id });
          cascaded = r.length;
        }
      }
      return { u, cascaded };
    });
    // antes → depois de cada campo alterado (aparece no modo detalhado da auditoria)
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const k of Object.keys(patch)) {
      const from = (b as Record<string, unknown>)[k], to = (patch as Record<string, unknown>)[k];
      if (JSON.stringify(from) !== JSON.stringify(to)) changes[k] = { from: from ?? null, to: to ?? null };
    }
    await audit(req, {
      action: `${type}.update`, entityType: 'bill', entityId: b.id,
      description: `Editou "${result.u.description}"${result.cascaded ? ` (+${result.cascaded} futuras)` : ''}`,
      details: { changes, cascaded: result.cascaded, restricted: await isRestricted(b.orgId, result.u.categoryId) },
    });
    const att = await attachmentsFor([b.id]);
    return { ...serialize(result.u, att.get(b.id)), cascaded: result.cascaded };
  });

  // -------------------------------------------------------------- pagar / reverter
  app.post<{ Params: { id: string } }>('/api/bills/:id/pay', async (req) => {
    const body = parse(paySchema, req.body ?? {});
    const b = await loadBill(req, req.params.id, 'pay');
    const [u] = await db.update(schema.bills).set({
      status: 'paid', paidAt: body.paidAt ?? orgToday(req), paidAmount: body.paidAmount ?? b.paidAmount ?? b.amount,
    }).where(eq(schema.bills.id, b.id)).returning();
    await audit(req, {
      action: `${b.type}.pay`, entityType: 'bill', entityId: b.id,
      description: `Marcou ${b.type === 'payable' ? 'paga' : 'recebida'} "${b.description}" em ${u.paidAt}`,
      details: { paidAt: u.paidAt, paidAmount: u.paidAmount, restricted: await isRestricted(b.orgId, b.categoryId) },
    });
    return serialize(u, (await attachmentsFor([b.id])).get(b.id));
  });

  app.post<{ Params: { id: string } }>('/api/bills/:id/unpay', async (req) => {
    const b = await loadBill(req, req.params.id, 'pay');
    const [u] = await db.update(schema.bills).set({ status: 'pending', paidAt: null, paidAmount: null }).where(eq(schema.bills.id, b.id)).returning();
    await audit(req, { action: `${b.type}.unpay`, entityType: 'bill', entityId: b.id, description: `Reverteu pagamento de "${b.description}"`, details: { restricted: await isRestricted(b.orgId, b.categoryId) } });
    return serialize(u, (await attachmentsFor([b.id])).get(b.id));
  });

  app.post('/api/bills/bulk-pay', async (req) => {
    const body = parse(bulkPaySchema, req.body);
    const paidAt = body.paidAt ?? orgToday(req);
    const hidden = req.org!.can('bills.view_restricted') ? [] : await restrictedCategoryIds(req.org!.id);
    const rows = await db.select().from(schema.bills).where(and(eq(schema.bills.orgId, req.org!.id), inArray(schema.bills.id, body.ids), eq(schema.bills.status, 'pending')));
    const allowed = rows.filter((r) => req.org!.can(billPerm(r.type as BillType, 'pay')) && !hidden.includes(r.categoryId));
    await db.transaction(async (tx) => {
      for (const r of allowed) {
        await tx.update(schema.bills).set({ status: 'paid', paidAt, paidAmount: r.paidAmount ?? r.amount }).where(eq(schema.bills.id, r.id));
      }
    });
    await audit(req, { action: 'bills.bulk_pay', entityType: 'bill', entityId: allowed.slice(0, 20).map((r) => r.id).join(','), description: `Pagamento em massa: ${allowed.length} de ${body.ids.length} contas`, details: { paidAt, ids: allowed.map((r) => r.id) } });
    return { updated: allowed.length };
  });

  // -------------------------------------------------------------- reestruturar recorrência
  app.post<{ Params: { id: string } }>('/api/bills/:id/restructure', async (req) => {
    const body = parse(restructureSchema, req.body);
    const b = await loadBill(req, req.params.id, 'edit');
    if (b.statementId) throw badRequest('Conta de fatura de cartão não pode virar recorrente');
    if (b.payrollEntryId) throw badRequest('Salário da folha não pode virar recorrente: o próximo mês é aberto na Folha de pagamento');
    if (b.parentId) throw badRequest('Edite a recorrência a partir da primeira ocorrência da série');
    if (b.status === 'paid') throw badRequest('Esta conta já está paga — reverta o pagamento antes de reestruturar');
    if (body.isIndefinite && !isPeriodic(body.recurrenceType)) throw badRequest('Repetição sem data para acabar só para semanal, quinzenal, mensal ou anual');
    const plan = planOccurrences({ ...body, amount: body.amount ?? b.amount });
    const out = await db.transaction(async (tx) => {
      const kids = await tx.select().from(schema.bills).where(eq(schema.bills.parentId, b.id));
      const paidPreserved = kids.filter((k) => k.status === 'paid').length;
      await deleteBillsWithFiles(tx, kids.filter((k) => k.status !== 'paid').map((k) => k.id));
      const [head] = await tx.update(schema.bills).set({
        recurrenceType: body.recurrenceType, dueDate: plan[0].dueDate, amount: plan[0].amount,
        installmentNumber: plan[0].installmentNumber, totalInstallments: plan[0].totalInstallments,
        isIndefinite: body.isIndefinite && body.recurrenceType !== 'once',
        recurrenceDay: recurrenceDayFor(body.recurrenceType, body.dueDate),
      }).where(eq(schema.bills.id, b.id)).returning();
      const created = plan.length > 1 ? await tx.insert(schema.bills).values(plan.slice(1).map((r) => ({
        orgId: b.orgId, type: b.type, parentId: b.id, description: b.description, categoryId: b.categoryId,
        folderId: b.folderId, recurrenceType: body.recurrenceType, relatedPerson: b.relatedPerson, notes: b.notes,
        pixKey: b.pixKey, paymentMethod: b.paymentMethod, createdBy: req.user!.id, recurrenceDay: head.recurrenceDay, ...r,
      }))).returning() : [];
      return { head, created: created.length, paidPreserved };
    });
    await audit(req, { action: `${b.type}.restructure`, entityType: 'bill', entityId: b.id, description: `Reestruturou recorrência de "${b.description}"`, details: { ...body, created: out.created, paidPreserved: out.paidPreserved, restricted: await isRestricted(b.orgId, b.categoryId) } });
    return { head: serialize(out.head), created: out.created, paidPreserved: out.paidPreserved };
  });

  app.post<{ Params: { id: string } }>('/api/bills/:id/recurrence/stop', async (req) => {
    const b = await loadBill(req, req.params.id, 'edit');
    const headId = headIdOf(b);
    const today = orgToday(req);
    const deleted = await db.transaction(async (tx) => {
      const rows = await tx.select({ id: schema.bills.id }).from(schema.bills).where(and(
        eq(schema.bills.parentId, headId), eq(schema.bills.status, 'pending'), sql`${schema.bills.dueDate} >= ${today}`,
        // preserva a ocorrência selecionada
        ne(schema.bills.id, b.id),
      ));
      const n = await deleteBillsWithFiles(tx, rows.map((r) => r.id));
      await tx.update(schema.bills).set({ isIndefinite: false }).where(eq(schema.bills.id, headId));
      return n;
    });
    await audit(req, { action: `${b.type}.recurrence_stop`, entityType: 'bill', entityId: headId, description: `Parou recorrência de "${b.description}" (${deleted} futuras apagadas)`, details: { deleted, restricted: await isRestricted(b.orgId, b.categoryId) } });
    return { deleted };
  });

  // -------------------------------------------------------------- apagar
  app.delete<{ Params: { id: string }; Querystring: { mode?: string } }>('/api/bills/:id', async (req) => {
    const mode = parse(deleteModeSchema, req.query.mode ?? 'one');
    const b = await loadBill(req, req.params.id, 'delete');
    if (b.statementId) throw badRequest('Esta conta é a fatura de um cartão. Apague os lançamentos na tela de Cartões.');
    if (b.payrollEntryId) throw badRequest('Este salário vem da Folha de pagamento. Tire o funcionário da folha do mês por lá.');
    const restricted = await isRestricted(b.orgId, b.categoryId);
    const res = await db.transaction(async (tx) => {
      const series = await seriesRows(tx, b);
      let ids: string[];
      let preservedPaid = 0;
      if (mode === 'series') ids = series.map((r) => r.id);
      else if (mode === 'forward') {
        const fwd = series.filter((r) => r.id !== b.id && (r.dueDate > b.dueDate || (r.dueDate === b.dueDate && r.createdAt > b.createdAt)));
        preservedPaid = fwd.filter((r) => r.status === 'paid').length;
        ids = [b.id, ...fwd.filter((r) => r.status !== 'paid').map((r) => r.id)];
      } else ids = [b.id];
      const headId = headIdOf(b);
      if (ids.includes(headId) && ids.length < series.length) {
        // cabeça vai embora mas sobram ocorrências: promove a próxima a cabeça
        const head = series.find((r) => r.id === headId)!;
        const survivors = series.filter((r) => !ids.includes(r.id));
        const [nh, ...rest] = survivors;
        await tx.update(schema.bills).set({ parentId: null, isIndefinite: mode === 'forward' ? false : head.isIndefinite }).where(eq(schema.bills.id, nh.id));
        if (rest.length) await tx.update(schema.bills).set({ parentId: nh.id }).where(inArray(schema.bills.id, rest.map((r) => r.id)));
      } else if (mode === 'forward') {
        await tx.update(schema.bills).set({ isIndefinite: false }).where(eq(schema.bills.id, headId));
      }
      const deleted = await deleteBillsWithFiles(tx, ids);
      return { deleted, preservedPaid };
    });
    await audit(req, { action: `${b.type}.delete`, entityType: 'bill', entityId: b.id, description: `Apagou "${b.description}" (${res.deleted} lançamento(s), modo ${mode})`, details: { snapshot: b, mode, ...res, restricted } });
    return { ok: true, ...res };
  });

}
