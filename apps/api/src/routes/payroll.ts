import type { FastifyInstance, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import {
  billPerm, defaultPayDate, employeeSchema, payrollEntryCreateSchema, payrollEntrySchema, payrollImportSchema,
  payrollPeriodCreateSchema, payrollPeriodUpdateSchema, payrollPrintSchema, payrollRubricOrderSchema, payrollRubricSchema, payrollSettingsSchema, personKey,
  refLabelPT, sumMoney, toCents, type Permission,
} from '@nopaper/shared';
import { db, schema } from '../db/client.js';
import { parse } from '../lib/validate.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { requirePerm } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { assertCategoryUsable, assertFolder, attachmentsFor, serialize } from '../services/bills.js';
import {
  assertCompany, assertEntryEditable, deleteEntries, ensurePayrollDefaults, getPayrollSettings, loadEmployee, loadEntry,
  loadPeriod, paidBillsCount, recomputeCosts, rubricsOf, savePayrollSettings, syncEntries, writeEntry,
} from '../services/payroll.js';

/** Violação de índice único (o drizzle embrulha o erro do pg em `cause`). */
const isUniqueViolation = (err: unknown) => {
  const e = err as { code?: string; cause?: { code?: string } };
  return e.code === '23505' || e.cause?.code === '23505';
};

const guard = (...p: Permission[]) => ({
  preHandler: [requirePerm(...p), async (req: FastifyRequest) => { assertCompany(req); }],
});
const view = guard('payroll.view');
const edit = guard('payroll.edit');
const manage = guard('payroll.manage');

const pendingEntryIds = async (cond: ReturnType<typeof eq>) => (await db.select({ id: schema.payrollEntries.id })
  .from(schema.payrollEntries).innerJoin(schema.bills, eq(schema.bills.id, schema.payrollEntries.billId))
  .where(and(cond, eq(schema.bills.status, 'pending')))).map((r) => r.id);

export default async function payrollRoutes(app: FastifyInstance) {
  // ------------------------------------------------------------ cadastro base (funcionários, rubricas, configuração)
  app.get('/api/payroll/meta', view, async (req) => {
    await ensurePayrollDefaults(req.org!.id);
    const [settings, rubrics, employees, usage] = await Promise.all([
      getPayrollSettings(req.org!.id),
      rubricsOf(req.org!.id),
      db.select().from(schema.employees).where(eq(schema.employees.orgId, req.org!.id)),
      db.select({ rubricId: schema.payrollEntryLines.rubricId, n: sql<number>`count(*)::int` }).from(schema.payrollEntryLines)
        .innerJoin(schema.payrollEntries, eq(schema.payrollEntries.id, schema.payrollEntryLines.entryId))
        .where(eq(schema.payrollEntries.orgId, req.org!.id)).groupBy(schema.payrollEntryLines.rubricId),
    ]);
    const empUsage = await db.select({ employeeId: schema.payrollEntries.employeeId, n: sql<number>`count(*)::int`, last: sql<string>`max(${schema.payrollPeriods.ref})` })
      .from(schema.payrollEntries).innerJoin(schema.payrollPeriods, eq(schema.payrollPeriods.id, schema.payrollEntries.periodId))
      .where(eq(schema.payrollEntries.orgId, req.org!.id)).groupBy(schema.payrollEntries.employeeId);
    const ru = new Map(usage.map((u) => [u.rubricId, u.n]));
    const eu = new Map(empUsage.map((u) => [u.employeeId, u]));
    return {
      settings,
      rubrics: rubrics.map((r) => ({ ...r, usage: ru.get(r.id) ?? 0 })),
      employees: employees.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR', { sensitivity: 'base' })).map((e) => ({ ...e, months: eu.get(e.id)?.n ?? 0, lastRef: eu.get(e.id)?.last ?? null })),
    };
  });

  app.put('/api/payroll/settings', manage, async (req) => {
    const body = parse(payrollSettingsSchema, req.body);
    if (!body.categoryId) throw badRequest('Escolha a categoria das contas de salário');
    await assertCategoryUsable(req, body.categoryId, 'payable');
    await assertFolder(req, body.folderId);
    const before = await getPayrollSettings(req.org!.id);
    await savePayrollSettings(req.org!.id, body);
    // contas pendentes passam a usar a categoria/pasta/forma de pagamento novas
    const ids = await pendingEntryIds(eq(schema.payrollEntries.orgId, req.org!.id));
    await db.transaction((tx) => syncEntries(tx, ids, req.user!.id));
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const k of Object.keys(body) as (keyof typeof body)[]) if (JSON.stringify(before[k] ?? null) !== JSON.stringify(body[k] ?? null)) changes[k] = { from: before[k] ?? null, to: body[k] ?? null };
    // regime/alíquotas novos: o custo gravado de todos os meses acompanha
    const recalculated = changes.costs ? await db.transaction((tx) => recomputeCosts(req.org!.id, tx)) : 0;
    await audit(req, { action: 'payroll.settings', entityType: 'payroll', description: 'Alterou a configuração da folha de pagamento', details: { changes, resynced: ids.length, recalculated } });
    return body;
  });

  /** Colunas da impressão (preferência do espaço; quem lança a folha pode mudar). */
  app.put('/api/payroll/settings/print', edit, async (req) => {
    const print = parse(payrollPrintSchema, req.body);
    const before = await getPayrollSettings(req.org!.id);
    const changes: Record<string, { from: string[]; to: string[] }> = {};
    for (const k of ['hidden', 'order'] as const) {
      if (JSON.stringify(before.print[k]) !== JSON.stringify(print[k])) changes[k] = { from: before.print[k], to: print[k] };
    }
    if (Object.keys(changes).length) {
      await savePayrollSettings(req.org!.id, { ...before, print });
      await audit(req, { action: 'payroll.settings.print', entityType: 'payroll', description: 'Alterou as colunas da impressão da folha', details: { changes } });
    }
    return print;
  });

  app.post('/api/payroll/employees', manage, async (req) => {
    const body = parse(employeeSchema, req.body);
    try {
      const [e] = await db.insert(schema.employees).values({ ...body, orgId: req.org!.id, createdBy: req.user!.id }).returning();
      await audit(req, { action: 'payroll.employee.create', entityType: 'employee', entityId: e.id, description: `Cadastrou o funcionário ${e.name}` });
      return e;
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict(`Já existe um funcionário chamado "${body.name}"`);
      throw err;
    }
  });

  app.put<{ Params: { id: string } }>('/api/payroll/employees/:id', manage, async (req) => {
    const body = parse(employeeSchema, req.body);
    const e = await loadEmployee(req.org!.id, req.params.id);
    let u;
    try {
      [u] = await db.update(schema.employees).set(body).where(eq(schema.employees.id, e.id)).returning();
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict(`Já existe um funcionário chamado "${body.name}"`);
      throw err;
    }
    // nome/PIX novos nas contas ainda pendentes
    if (u.name !== e.name || u.pixKey !== e.pixKey) {
      const ids = await pendingEntryIds(eq(schema.payrollEntries.employeeId, e.id));
      await db.transaction((tx) => syncEntries(tx, ids, req.user!.id));
    }
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const k of Object.keys(body) as (keyof typeof body)[]) {
      const from = (e as Record<string, unknown>)[k] ?? null, to = (u as Record<string, unknown>)[k] ?? null;
      if (JSON.stringify(from) !== JSON.stringify(to)) changes[k] = { from, to };
    }
    await audit(req, { action: 'payroll.employee.update', entityType: 'employee', entityId: e.id, description: `Editou o funcionário ${u.name}`, details: { changes } });
    return u;
  });

  app.delete<{ Params: { id: string } }>('/api/payroll/employees/:id', manage, async (req) => {
    const e = await loadEmployee(req.org!.id, req.params.id);
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.payrollEntries).where(eq(schema.payrollEntries.employeeId, e.id));
    if (n > 0) throw conflict(`${e.name} tem ${n} mês(es) na folha. Para manter o histórico, desative o funcionário (ou apague os lançamentos antes).`);
    await db.delete(schema.employees).where(eq(schema.employees.id, e.id));
    await audit(req, { action: 'payroll.employee.delete', entityType: 'employee', entityId: e.id, description: `Apagou o funcionário ${e.name}` });
    return { ok: true };
  });

  /** Histórico de um funcionário, mês a mês. */
  app.get<{ Params: { id: string } }>('/api/payroll/employees/:id/history', view, async (req) => {
    const e = await loadEmployee(req.org!.id, req.params.id);
    const rows = await db.select({
      ref: schema.payrollPeriods.ref, billsEnabled: schema.payrollPeriods.billsEnabled, paidAt: schema.bills.paidAt,
      payslipNet: schema.payrollEntries.payslipNet, total: schema.payrollEntries.total,
      offPayroll: schema.payrollEntries.offPayroll, companyCost: schema.payrollEntries.companyCost, billStatus: schema.bills.status,
    }).from(schema.payrollEntries)
      .innerJoin(schema.payrollPeriods, eq(schema.payrollPeriods.id, schema.payrollEntries.periodId))
      .leftJoin(schema.bills, eq(schema.bills.id, schema.payrollEntries.billId))
      .where(eq(schema.payrollEntries.employeeId, e.id)).orderBy(desc(schema.payrollPeriods.ref));
    return { items: rows };
  });

  app.post('/api/payroll/rubrics', manage, async (req) => {
    const body = parse(payrollRubricSchema, req.body);
    await ensurePayrollDefaults(req.org!.id);
    const [{ max }] = await db.select({ max: sql<number>`coalesce(max(${schema.payrollRubrics.sortOrder}), 0)::int` }).from(schema.payrollRubrics).where(eq(schema.payrollRubrics.orgId, req.org!.id));
    try {
      const [r] = await db.insert(schema.payrollRubrics).values({ ...body, kind: body.section === 'employer' ? 'earning' : body.kind, orgId: req.org!.id, sortOrder: max + 1 }).returning();
      await audit(req, { action: 'payroll.rubric.create', entityType: 'payroll_rubric', entityId: r.id, description: `Criou a rubrica ${r.name}` });
      return r;
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict(`Já existe uma rubrica chamada "${body.name}"`);
      throw err;
    }
  });

  /** Reordena as rubricas (vale para os lançamentos, a configuração e a impressão). */
  app.put('/api/payroll/rubrics/order', manage, async (req) => {
    const body = parse(payrollRubricOrderSchema, req.body);
    const rubrics = await rubricsOf(req.org!.id);
    const pos = new Map(body.ids.map((id, i) => [id, i]));
    const ordered = [...rubrics].sort((a, b) => (pos.get(a.id) ?? 1e6 + a.sortOrder) - (pos.get(b.id) ?? 1e6 + b.sortOrder));
    await db.transaction(async (tx) => {
      for (const [i, r] of ordered.entries()) {
        if (r.sortOrder !== i) await tx.update(schema.payrollRubrics).set({ sortOrder: i }).where(eq(schema.payrollRubrics.id, r.id));
      }
    });
    await audit(req, { action: 'payroll.rubric.reorder', entityType: 'payroll', description: 'Reordenou as rubricas da folha', details: { changes: { ordem: { from: rubrics.map((r) => r.name), to: ordered.map((r) => r.name) } } } });
    return { ok: true };
  });

  app.put<{ Params: { id: string } }>('/api/payroll/rubrics/:id', manage, async (req) => {
    const body = parse(payrollRubricSchema, req.body);
    const [r] = await db.select().from(schema.payrollRubrics).where(and(eq(schema.payrollRubrics.id, req.params.id), eq(schema.payrollRubrics.orgId, req.org!.id)));
    if (!r) throw notFound('Rubrica não encontrada');
    const kind = body.section === 'employer' ? 'earning' : body.kind;
    if (body.section !== r.section || kind !== r.kind) {
      const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.payrollEntryLines).where(eq(schema.payrollEntryLines.rubricId, r.id));
      if (n > 0) throw conflict('Esta rubrica já foi usada: mudar onde ela entra (holerite/extra/encargo) ou se soma/desconta alteraria meses já lançados. Crie uma rubrica nova.');
    }
    try {
      const [u] = await db.update(schema.payrollRubrics).set({ ...body, kind }).where(eq(schema.payrollRubrics.id, r.id)).returning();
      await audit(req, { action: 'payroll.rubric.update', entityType: 'payroll_rubric', entityId: r.id, description: `Editou a rubrica ${u.name}`, details: { changes: { name: { from: r.name, to: u.name }, active: { from: r.active, to: u.active }, fixed: { from: r.fixed, to: u.fixed } } } });
      return u;
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict(`Já existe uma rubrica chamada "${body.name}"`);
      throw err;
    }
  });

  app.delete<{ Params: { id: string } }>('/api/payroll/rubrics/:id', manage, async (req) => {
    const [r] = await db.select().from(schema.payrollRubrics).where(and(eq(schema.payrollRubrics.id, req.params.id), eq(schema.payrollRubrics.orgId, req.org!.id)));
    if (!r) throw notFound('Rubrica não encontrada');
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.payrollEntryLines).where(eq(schema.payrollEntryLines.rubricId, r.id));
    if (n > 0) throw conflict(`A rubrica "${r.name}" está em ${n} lançamento(s). Desative-a para não aparecer nos próximos meses.`);
    await db.delete(schema.payrollRubrics).where(eq(schema.payrollRubrics.id, r.id));
    await audit(req, { action: 'payroll.rubric.delete', entityType: 'payroll_rubric', entityId: r.id, description: `Apagou a rubrica ${r.name}` });
    return { ok: true };
  });

  // ------------------------------------------------------------ meses
  app.get('/api/payroll/periods', view, async (req) => {
    const rows = await db.select({
      id: schema.payrollPeriods.id, ref: schema.payrollPeriods.ref, payDate: schema.payrollPeriods.payDate,
      billsEnabled: schema.payrollPeriods.billsEnabled, imported: sql<boolean>`${schema.payrollPeriods.importBatchId} is not null`,
      employees: sql<number>`count(${schema.payrollEntries.id})::int`,
      total: sql<string>`coalesce(sum(${schema.payrollEntries.total}), 0)::text`,
      offPayroll: sql<string>`coalesce(sum(${schema.payrollEntries.offPayroll}), 0)::text`,
      payslipNet: sql<string>`coalesce(sum(${schema.payrollEntries.payslipNet}), 0)::text`,
      employerCost: sql<string>`coalesce(sum(${schema.payrollEntries.employerCost}), 0)::text`,
      companyCost: sql<string>`coalesce(sum(${schema.payrollEntries.companyCost}), 0)::text`,
      paid: sql<number>`count(*) filter (where ${schema.bills.status} = 'paid')::int`,
      bills: sql<number>`count(${schema.bills.id})::int`,
    }).from(schema.payrollPeriods)
      .leftJoin(schema.payrollEntries, eq(schema.payrollEntries.periodId, schema.payrollPeriods.id))
      .leftJoin(schema.bills, eq(schema.bills.id, schema.payrollEntries.billId))
      .where(eq(schema.payrollPeriods.orgId, req.org!.id))
      .groupBy(schema.payrollPeriods.id).orderBy(desc(schema.payrollPeriods.ref));
    return { items: rows };
  });

  /** Um mês (por ref AAAA-MM), com os lançamentos e as contas a pagar. Sem folha aberta: sugestão de data. */
  app.get<{ Params: { ref: string } }>('/api/payroll/month/:ref', view, async (req) => {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(req.params.ref)) throw badRequest('Mês inválido');
    const settings = await getPayrollSettings(req.org!.id);
    const [p] = await db.select().from(schema.payrollPeriods).where(and(eq(schema.payrollPeriods.orgId, req.org!.id), eq(schema.payrollPeriods.ref, req.params.ref)));
    if (!p) return { period: null, suggestedPayDate: defaultPayDate(req.params.ref, settings.payDay, settings.payMonth), entries: [] };
    const entries = await db.select().from(schema.payrollEntries).where(eq(schema.payrollEntries.periodId, p.id));
    const lines = entries.length ? await db.select().from(schema.payrollEntryLines).where(inArray(schema.payrollEntryLines.entryId, entries.map((e) => e.id))) : [];
    const billIds = entries.map((e) => e.billId).filter((x): x is string => !!x);
    const bills = billIds.length ? await db.select().from(schema.bills).where(inArray(schema.bills.id, billIds)) : [];
    const att = await attachmentsFor(billIds);
    const bmap = new Map(bills.map((b) => [b.id, serialize(b, att.get(b.id))]));
    return {
      period: p, suggestedPayDate: null,
      entries: entries.map((e) => ({
        ...e, lines: lines.filter((l) => l.entryId === e.id).map((l) => ({ rubricId: l.rubricId, amount: l.amount, note: l.note })),
        bill: e.billId ? bmap.get(e.billId) ?? null : null,
      })),
    };
  });

  app.post('/api/payroll/periods', edit, async (req) => {
    const body = parse(payrollPeriodCreateSchema, req.body);
    await ensurePayrollDefaults(req.org!.id);
    const settings = await getPayrollSettings(req.org!.id);
    if (!settings.categoryId) throw badRequest('Antes de abrir o mês, escolha em Configurar a categoria das contas de salário.', 'payroll_category');
    const out = await db.transaction(async (tx) => {
      const [exists] = await tx.select({ id: schema.payrollPeriods.id }).from(schema.payrollPeriods).where(and(eq(schema.payrollPeriods.orgId, req.org!.id), eq(schema.payrollPeriods.ref, body.ref)));
      if (exists) throw conflict(`A folha de ${refLabelPT(body.ref)} já existe`);
      const [p] = await tx.insert(schema.payrollPeriods).values({ orgId: req.org!.id, ref: body.ref, payDate: body.payDate, notes: body.notes, createdBy: req.user!.id }).returning();
      let created = 0;
      if (body.copyPrevious) {
        const rubrics = await rubricsOf(req.org!.id, tx);
        const fixed = new Set(rubrics.filter((r) => r.fixed && r.active).map((r) => r.id));
        const emps = await tx.select().from(schema.employees).where(and(eq(schema.employees.orgId, req.org!.id), eq(schema.employees.active, true)));
        for (const emp of emps) {
          // último lançamento anterior a este mês
          const [last] = await tx.select({ id: schema.payrollEntries.id, payslipNet: schema.payrollEntries.payslipNet }).from(schema.payrollEntries)
            .innerJoin(schema.payrollPeriods, eq(schema.payrollPeriods.id, schema.payrollEntries.periodId))
            .where(and(eq(schema.payrollEntries.employeeId, emp.id), sql`${schema.payrollPeriods.ref} < ${body.ref}`))
            .orderBy(desc(schema.payrollPeriods.ref)).limit(1);
          const lastLines = last ? await tx.select().from(schema.payrollEntryLines).where(eq(schema.payrollEntryLines.entryId, last.id)) : [];
          const keep = lastLines.filter((l) => fixed.has(l.rubricId));
          const detailed = lastLines.some((l) => rubrics.find((r) => r.id === l.rubricId)?.section === 'payslip');
          await writeEntry(tx, req.org!.id, req.user!.id, {
            periodId: p.id, employeeId: emp.id, payslipNet: detailed ? '0' : last?.payslipNet ?? '0',
            lines: keep.map((l) => ({ rubricId: l.rubricId, amount: l.amount, note: null })), notes: null,
          });
          created++;
        }
      }
      return { p, created };
    });
    await audit(req, { action: 'payroll.period.create', entityType: 'payroll_period', entityId: out.p.id, description: `Abriu a folha de ${refLabelPT(body.ref)} (${out.created} funcionário(s))`, details: { payDate: body.payDate, copyPrevious: body.copyPrevious } });
    return { period: out.p, created: out.created };
  });

  app.put<{ Params: { id: string } }>('/api/payroll/periods/:id', edit, async (req) => {
    const body = parse(payrollPeriodUpdateSchema, req.body);
    const p = await loadPeriod(req.org!.id, req.params.id);
    const [u] = await db.update(schema.payrollPeriods).set(body).where(eq(schema.payrollPeriods.id, p.id)).returning();
    if (u.payDate !== p.payDate) {
      const ids = await pendingEntryIds(eq(schema.payrollEntries.periodId, p.id));
      await db.transaction((tx) => syncEntries(tx, ids, req.user!.id));
    }
    await audit(req, { action: 'payroll.period.update', entityType: 'payroll_period', entityId: p.id, description: `Editou a folha de ${refLabelPT(p.ref)}`, details: { changes: { payDate: { from: p.payDate, to: u.payDate }, notes: { from: p.notes, to: u.notes } } } });
    return u;
  });

  /** Mês importado do histórico (sem contas): passa a gerar as contas a pagar. */
  app.post<{ Params: { id: string } }>('/api/payroll/periods/:id/enable-bills', edit, async (req) => {
    const p = await loadPeriod(req.org!.id, req.params.id);
    if (p.billsEnabled) return { ok: true, created: 0 };
    const settings = await getPayrollSettings(req.org!.id);
    if (!settings.categoryId) throw badRequest('Escolha em Configurar a categoria das contas de salário.', 'payroll_category');
    const ids = (await db.select({ id: schema.payrollEntries.id }).from(schema.payrollEntries).where(eq(schema.payrollEntries.periodId, p.id))).map((r) => r.id);
    await db.transaction(async (tx) => {
      await tx.update(schema.payrollPeriods).set({ billsEnabled: true }).where(eq(schema.payrollPeriods.id, p.id));
      await syncEntries(tx, ids, req.user!.id);
    });
    await audit(req, { action: 'payroll.period.enable_bills', entityType: 'payroll_period', entityId: p.id, description: `Gerou as contas a pagar da folha de ${refLabelPT(p.ref)}` });
    return { ok: true, created: ids.length };
  });

  app.delete<{ Params: { id: string } }>('/api/payroll/periods/:id', edit, async (req) => {
    const p = await loadPeriod(req.org!.id, req.params.id);
    const ids = (await db.select({ id: schema.payrollEntries.id }).from(schema.payrollEntries).where(eq(schema.payrollEntries.periodId, p.id))).map((r) => r.id);
    const paid = await paidBillsCount(db, ids);
    if (paid) throw conflict(`${paid} salário(s) deste mês já foram pagos. Reverta os pagamentos antes de apagar o mês.`);
    const [{ bills }] = await db.select({ bills: sql<number>`count(${schema.payrollEntries.billId})::int` }).from(schema.payrollEntries).where(eq(schema.payrollEntries.periodId, p.id));
    if (bills && !req.org!.can(billPerm('payable', 'delete'))) throw forbidden('Apagar o mês remove as contas a pagar dele, e você não tem permissão para apagar contas a pagar.');
    await db.transaction(async (tx) => {
      await deleteEntries(tx, ids);
      await tx.delete(schema.payrollPeriods).where(eq(schema.payrollPeriods.id, p.id));
    });
    await audit(req, { action: 'payroll.period.delete', entityType: 'payroll_period', entityId: p.id, description: `Apagou a folha de ${refLabelPT(p.ref)} (${ids.length} lançamento(s))`, details: { entries: ids.length, bills } });
    return { ok: true };
  });

  // ------------------------------------------------------------ lançamentos
  app.post('/api/payroll/entries', edit, async (req) => {
    const body = parse(payrollEntryCreateSchema, req.body);
    const p = await loadPeriod(req.org!.id, body.periodId);
    const emp = await loadEmployee(req.org!.id, body.employeeId);
    const [dup] = await db.select({ id: schema.payrollEntries.id }).from(schema.payrollEntries).where(and(eq(schema.payrollEntries.periodId, p.id), eq(schema.payrollEntries.employeeId, emp.id)));
    if (dup) throw conflict(`${emp.name} já está na folha de ${refLabelPT(p.ref)}`);
    const r = await db.transaction((tx) => writeEntry(tx, req.org!.id, req.user!.id, { periodId: p.id, employeeId: emp.id, payslipNet: body.payslipNet, payslipNetDeclared: body.payslipNetDeclared, lines: body.lines, notes: body.notes }));
    await audit(req, { action: 'payroll.entry.create', entityType: 'payroll_entry', entityId: r.id, description: `Lançou ${emp.name} na folha de ${refLabelPT(p.ref)} (${r.totals.total})`, details: { total: r.totals.total, offPayroll: r.totals.offPayroll } });
    return { id: r.id };
  });

  app.put<{ Params: { id: string } }>('/api/payroll/entries/:id', edit, async (req) => {
    const body = parse(payrollEntrySchema, req.body);
    const e = await loadEntry(req.org!.id, req.params.id);
    if (body.employeeId !== e.employeeId) throw badRequest('Não dá para trocar o funcionário de um lançamento: apague e lance de novo.');
    await assertEntryEditable(e);
    const p = await loadPeriod(req.org!.id, e.periodId);
    const emp = await loadEmployee(req.org!.id, e.employeeId);
    const beforeLines = await db.select().from(schema.payrollEntryLines).where(eq(schema.payrollEntryLines.entryId, e.id));
    const r = await db.transaction((tx) => writeEntry(tx, req.org!.id, req.user!.id, { entryId: e.id, periodId: e.periodId, employeeId: e.employeeId, payslipNet: body.payslipNet, payslipNetDeclared: body.payslipNetDeclared, lines: body.lines, notes: body.notes }));
    const rubrics = new Map((await rubricsOf(req.org!.id)).map((x) => [x.id, x.name]));
    const asText = (ls: Array<{ rubricId: string; amount: string }>) => Object.fromEntries(ls.filter((l) => toCents(l.amount)).map((l) => [rubrics.get(l.rubricId) ?? l.rubricId, l.amount]));
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    if (e.total !== r.totals.total) changes.total = { from: e.total, to: r.totals.total };
    if (e.payslipNet !== r.totals.payslipNet) changes.payslipNet = { from: e.payslipNet, to: r.totals.payslipNet };
    const declaredTo = r.totals.detailed ? body.payslipNetDeclared ?? null : null;
    if ((e.payslipNetDeclared ?? null) !== declaredTo) changes.payslipNetDeclared = { from: e.payslipNetDeclared, to: declaredTo };
    const lf = asText(beforeLines), lt = asText(body.lines);
    if (JSON.stringify(lf) !== JSON.stringify(lt)) changes.rubricas = { from: lf, to: lt };
    if ((e.notes ?? null) !== (body.notes ?? null)) changes.notes = { from: e.notes, to: body.notes };
    await audit(req, { action: 'payroll.entry.update', entityType: 'payroll_entry', entityId: e.id, description: `Editou ${emp.name} na folha de ${refLabelPT(p.ref)}`, details: { changes } });
    return { id: e.id };
  });

  /** Mês de um lançamento (link "abrir na folha" de Contas a pagar). */
  app.get<{ Params: { id: string } }>('/api/payroll/entries/:id/ref', view, async (req) => {
    const e = await loadEntry(req.org!.id, req.params.id);
    const p = await loadPeriod(req.org!.id, e.periodId);
    return { ref: p.ref, employeeId: e.employeeId };
  });

  app.delete<{ Params: { id: string } }>('/api/payroll/entries/:id', edit, async (req) => {
    const e = await loadEntry(req.org!.id, req.params.id);
    await assertEntryEditable(e);
    if (e.billId && !req.org!.can(billPerm('payable', 'delete'))) throw forbidden('Tirar o funcionário da folha apaga a conta a pagar dele, e você não tem permissão para apagar contas a pagar.');
    const p = await loadPeriod(req.org!.id, e.periodId);
    const emp = await loadEmployee(req.org!.id, e.employeeId);
    await db.transaction((tx) => deleteEntries(tx, [e.id]));
    await audit(req, { action: 'payroll.entry.delete', entityType: 'payroll_entry', entityId: e.id, description: `Tirou ${emp.name} da folha de ${refLabelPT(p.ref)}`, details: { snapshot: e } });
    return { ok: true };
  });

  // ------------------------------------------------------------ importação do histórico (planilha)
  app.post('/api/payroll/import', manage, async (req) => {
    const body = parse(payrollImportSchema, req.body);
    await ensurePayrollDefaults(req.org!.id);
    const orgId = req.org!.id;
    const out = await db.transaction(async (tx) => {
      const rubrics = await rubricsOf(orgId, tx);
      const rubricByName = new Map(rubrics.map((r) => [personKey(r.name), r]));
      for (const m of body.months) for (const e of m.entries) for (const l of e.lines) {
        if (!rubricByName.has(personKey(l.rubric))) throw badRequest(`Rubrica "${l.rubric}" não existe. Crie-a em Configurar ou renomeie a existente.`);
      }
      const existing = await tx.select({ ref: schema.payrollPeriods.ref }).from(schema.payrollPeriods).where(eq(schema.payrollPeriods.orgId, orgId));
      const taken = new Set(existing.map((x) => x.ref));
      const months = body.months.filter((m) => !taken.has(m.ref));
      if (!months.length) throw conflict('Todos esses meses já estão na folha. Nada para importar.');
      const batchId = randomUUID();
      const total = sumMoney(months.flatMap((m) => m.entries.map((e) => e.payslipNet)));
      await tx.insert(schema.importBatches).values({
        id: batchId, orgId, type: 'payroll', fileName: body.fileName, rowCount: months.reduce((a, m) => a + m.entries.length, 0), totalAmount: total, createdBy: req.user!.id,
      });
      // funcionários: casa pelo nome (sem acento/maiúsculas); cria os que faltam
      const emps = await tx.select().from(schema.employees).where(eq(schema.employees.orgId, orgId));
      const byKey = new Map(emps.map((e) => [personKey(e.name), e]));
      const lastRef = new Map<string, string>();
      for (const m of months) for (const e of m.entries) lastRef.set(personKey(e.name), m.ref > (lastRef.get(personKey(e.name)) ?? '') ? m.ref : lastRef.get(personKey(e.name))!);
      const latest = months.reduce((a, m) => (m.ref > a ? m.ref : a), '');
      let createdEmployees = 0;
      for (const [k, ref] of lastRef) {
        if (byKey.has(k)) continue;
        const name = months.flatMap((m) => m.entries).find((e) => personKey(e.name) === k)!.name;
        const [emp] = await tx.insert(schema.employees).values({ orgId, name, active: ref === latest, importBatchId: batchId, createdBy: req.user!.id }).returning();
        byKey.set(k, emp); createdEmployees++;
      }
      const settings = await getPayrollSettings(orgId, tx);
      let entries = 0;
      for (const m of months) {
        const [p] = await tx.insert(schema.payrollPeriods).values({
          orgId, ref: m.ref, payDate: m.payDate ?? defaultPayDate(m.ref, settings.payDay, settings.payMonth), billsEnabled: false, importBatchId: batchId, createdBy: req.user!.id,
        }).returning();
        for (const e of m.entries) {
          const emp = byKey.get(personKey(e.name))!;
          await writeEntry(tx, orgId, req.user!.id, {
            periodId: p.id, employeeId: emp.id, payslipNet: e.payslipNet, notes: e.notes,
            lines: e.lines.map((l) => ({ rubricId: rubricByName.get(personKey(l.rubric))!.id, amount: l.amount, note: l.note })),
          });
          entries++;
        }
      }
      return { batchId, months: months.length, skipped: body.months.length - months.length, entries, createdEmployees };
    });
    await audit(req, { action: 'payroll.import', entityType: 'import_batch', entityId: out.batchId, description: `Importou ${out.months} mês(es) da folha de "${body.fileName}" (${out.entries} lançamento(s), ${out.createdEmployees} funcionário(s) novos)`, details: out });
    return out;
  });

  app.get('/api/payroll/imports', manage, async (req) => {
    const rows = await db.select().from(schema.importBatches)
      .where(and(eq(schema.importBatches.orgId, req.org!.id), eq(schema.importBatches.type, 'payroll'), isNull(schema.importBatches.undoneAt)))
      .orderBy(desc(schema.importBatches.createdAt));
    const items = [];
    for (const b of rows) {
      const ps = await db.select({ ref: schema.payrollPeriods.ref }).from(schema.payrollPeriods).where(eq(schema.payrollPeriods.importBatchId, b.id)).orderBy(asc(schema.payrollPeriods.ref));
      items.push({ id: b.id, fileName: b.fileName, rowCount: b.rowCount, createdAt: b.createdAt, months: ps.length, from: ps[0]?.ref ?? null, to: ps.at(-1)?.ref ?? null });
    }
    return { items };
  });

  /** Desfaz: apaga os meses da importação (se nenhum gerou conta paga) e os funcionários criados por ela sem outros meses. */
  app.delete<{ Params: { id: string } }>('/api/payroll/imports/:id', manage, async (req) => {
    const [b] = await db.select().from(schema.importBatches).where(and(eq(schema.importBatches.id, req.params.id), eq(schema.importBatches.orgId, req.org!.id), eq(schema.importBatches.type, 'payroll')));
    if (!b || b.undoneAt) throw notFound('Importação não encontrada');
    const periods = await db.select({ id: schema.payrollPeriods.id }).from(schema.payrollPeriods).where(eq(schema.payrollPeriods.importBatchId, b.id));
    const pids = periods.map((p) => p.id);
    const ids = pids.length ? (await db.select({ id: schema.payrollEntries.id }).from(schema.payrollEntries).where(inArray(schema.payrollEntries.periodId, pids))).map((r) => r.id) : [];
    const paid = await paidBillsCount(db, ids);
    if (paid) throw conflict(`${paid} salário(s) desses meses já foram pagos em Contas a pagar. Reverta os pagamentos antes de desfazer.`);
    const [{ bills }] = ids.length ? await db.select({ bills: sql<number>`count(${schema.payrollEntries.billId})::int` }).from(schema.payrollEntries).where(inArray(schema.payrollEntries.id, ids)) : [{ bills: 0 }];
    if (bills && !req.org!.can(billPerm('payable', 'delete'))) throw forbidden('Desfazer remove contas a pagar geradas desses meses, e você não tem permissão para apagar contas a pagar.');
    const removedEmployees = await db.transaction(async (tx) => {
      await deleteEntries(tx, ids);
      if (pids.length) await tx.delete(schema.payrollPeriods).where(inArray(schema.payrollPeriods.id, pids));
      const orphans = await tx.select({ id: schema.employees.id }).from(schema.employees)
        .where(and(eq(schema.employees.importBatchId, b.id), sql`not exists (select 1 from payroll_entries pe where pe.employee_id = ${schema.employees.id})`));
      if (orphans.length) await tx.delete(schema.employees).where(inArray(schema.employees.id, orphans.map((o) => o.id)));
      await tx.update(schema.employees).set({ importBatchId: null }).where(and(eq(schema.employees.importBatchId, b.id), isNotNull(schema.employees.importBatchId)));
      await tx.update(schema.importBatches).set({ undoneAt: new Date() }).where(eq(schema.importBatches.id, b.id));
      return orphans.length;
    });
    await audit(req, { action: 'payroll.import_undo', entityType: 'import_batch', entityId: b.id, description: `Desfez a importação da folha "${b.fileName}" (${pids.length} mês(es))`, details: { months: pids.length, entries: ids.length, removedEmployees } });
    return { ok: true, months: pids.length, removedEmployees };
  });
}
