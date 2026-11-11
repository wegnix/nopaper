import type { FastifyRequest } from 'fastify';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import {
  DEFAULT_PAYROLL_COMMISSIONS, DEFAULT_PAYROLL_COSTS, DEFAULT_PAYROLL_PAYSLIPS, DEFAULT_PAYROLL_RUBRICS, payrollSettingsSchema, payrollTotals, payslipCheck, refLabelPT, formatBRL, toCents, type PayrollSettings,
} from '@nopaper/shared';
import { db, schema } from '../db/client.js';
import type { DBOrTx } from '../db/client.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { deleteBillsWithFiles } from './bills.js';

export type EmployeeRow = typeof schema.employees.$inferSelect;
export type RubricRow = typeof schema.payrollRubrics.$inferSelect;
export type PeriodRow = typeof schema.payrollPeriods.$inferSelect;
export type EntryRow = typeof schema.payrollEntries.$inferSelect;

const SETTINGS_KEY = 'payroll';

/** A folha só existe em espaço do tipo Empresa. */
export function assertCompany(req: FastifyRequest) {
  if (req.org!.kind !== 'company') throw badRequest('A folha de pagamento só está disponível em espaços do tipo Empresa.', 'company_only');
}

/** Cria as rubricas padrão e a configuração no 1º acesso do espaço. */
export async function ensurePayrollDefaults(orgId: string) {
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.payrollRubrics).where(eq(schema.payrollRubrics.orgId, orgId));
  if (n === 0) {
    await db.insert(schema.payrollRubrics).values(DEFAULT_PAYROLL_RUBRICS.map((r, i) => ({
      orgId, name: r.name, section: r.section, kind: r.kind, fixed: !!r.fixed, sortOrder: i,
    }))).onConflictDoNothing();
  }
  // configuração anterior aos custos legais (v1.3): grava o padrão e recalcula o custo dos lançamentos
  const [row] = await db.select().from(schema.orgSettings).where(and(eq(schema.orgSettings.orgId, orgId), eq(schema.orgSettings.key, SETTINGS_KEY)));
  if (!row || !(row.value as { costs?: unknown })?.costs) {
    await savePayrollSettings(orgId, await getPayrollSettings(orgId));
    await recomputeCosts(orgId);
  }
}

/** Recalcula encargos/custo gravados de todos os lançamentos (mudou o regime ou as alíquotas). */
export async function recomputeCosts(orgId: string, conn: DBOrTx = db) {
  const settings = await getPayrollSettings(orgId, conn);
  const map = new Map((await rubricsOf(orgId, conn)).map((r) => [r.id, r]));
  const entries = await conn.select().from(schema.payrollEntries).where(eq(schema.payrollEntries.orgId, orgId));
  if (!entries.length) return 0;
  const ghosts = new Set((await conn.select({ id: schema.employees.id }).from(schema.employees)
    .where(and(eq(schema.employees.orgId, orgId), eq(schema.employees.payslipOnly, true)))).map((e) => e.id));
  const lines = await conn.select({ entryId: schema.payrollEntryLines.entryId, rubricId: schema.payrollEntryLines.rubricId, amount: schema.payrollEntryLines.amount })
    .from(schema.payrollEntryLines).innerJoin(schema.payrollEntries, eq(schema.payrollEntries.id, schema.payrollEntryLines.entryId))
    .where(eq(schema.payrollEntries.orgId, orgId));
  const byEntry = new Map<string, typeof lines>();
  for (const l of lines) byEntry.set(l.entryId, [...(byEntry.get(l.entryId) ?? []), l]);
  let n = 0;
  for (const e of entries) {
    if (ghosts.has(e.employeeId)) continue; // só holerite: custo sempre zero
    const t = payrollTotals(e.payslipNet, byEntry.get(e.id) ?? [], map, settings.costs);
    if (toCents(t.employerCost) !== toCents(e.employerCost) || toCents(t.companyCost) !== toCents(e.companyCost)) {
      await conn.update(schema.payrollEntries).set({ employerCost: t.employerCost, companyCost: t.companyCost }).where(eq(schema.payrollEntries.id, e.id));
      n++;
    }
  }
  return n;
}

export async function getPayrollSettings(orgId: string, conn: DBOrTx = db): Promise<PayrollSettings> {
  const [row] = await conn.select().from(schema.orgSettings).where(and(eq(schema.orgSettings.orgId, orgId), eq(schema.orgSettings.key, SETTINGS_KEY)));
  if (row) return payrollSettingsSchema.parse(row.value);
  // padrão: categoria "Salário" e pasta "FUNCIONARIO" (estrutura do espaço Empresa), se existirem
  const [cat] = await conn.select({ id: schema.categories.id }).from(schema.categories)
    .where(and(eq(schema.categories.orgId, orgId), sql`lower(${schema.categories.label}) = 'salário'`, sql`${schema.categories.kind} <> 'receivable'`));
  const [folder] = await conn.select({ id: schema.folders.id }).from(schema.folders)
    .where(and(eq(schema.folders.orgId, orgId), sql`upper(${schema.folders.label}) = 'FUNCIONARIO'`));
  return { categoryId: cat?.id ?? null, folderId: folder?.id ?? null, payDay: 0, payMonth: 'next', paymentMethod: 'PIX', costs: DEFAULT_PAYROLL_COSTS, print: { hidden: [], order: [] }, commissions: DEFAULT_PAYROLL_COMMISSIONS, payslips: DEFAULT_PAYROLL_PAYSLIPS };
}

export async function savePayrollSettings(orgId: string, value: PayrollSettings) {
  await db.insert(schema.orgSettings).values({ orgId, key: SETTINGS_KEY, value })
    .onConflictDoUpdate({ target: [schema.orgSettings.orgId, schema.orgSettings.key], set: { value } });
}

export async function rubricsOf(orgId: string, conn: DBOrTx = db) {
  return conn.select().from(schema.payrollRubrics).where(eq(schema.payrollRubrics.orgId, orgId))
    .orderBy(asc(schema.payrollRubrics.sortOrder), asc(schema.payrollRubrics.name));
}

export async function loadEmployee(orgId: string, id: string, conn: DBOrTx = db) {
  const [e] = await conn.select().from(schema.employees).where(and(eq(schema.employees.id, id), eq(schema.employees.orgId, orgId)));
  if (!e) throw notFound('Funcionário não encontrado');
  return e;
}

export async function loadPeriod(orgId: string, id: string, conn: DBOrTx = db) {
  const [p] = await conn.select().from(schema.payrollPeriods).where(and(eq(schema.payrollPeriods.id, id), eq(schema.payrollPeriods.orgId, orgId)));
  if (!p) throw notFound('Mês da folha não encontrado');
  return p;
}

export async function loadEntry(orgId: string, id: string, conn: DBOrTx = db) {
  const [e] = await conn.select().from(schema.payrollEntries).where(and(eq(schema.payrollEntries.id, id), eq(schema.payrollEntries.orgId, orgId)));
  if (!e) throw notFound('Lançamento da folha não encontrado');
  return e;
}

/** Lançamento com conta já paga não muda: reverta o pagamento em Contas a pagar antes. */
export async function assertEntryEditable(entry: EntryRow, conn: DBOrTx = db) {
  if (!entry.billId) return;
  const [b] = await conn.select({ status: schema.bills.status }).from(schema.bills).where(eq(schema.bills.id, entry.billId));
  if (b?.status === 'paid') throw conflict('Este salário já foi pago. Para alterar, reverta o pagamento da conta em Contas a pagar (ou aqui, em “Reverter pagamento”).');
}

export interface LineInput { rubricId: string; amount: string; note?: string | null }

/** Grava o lançamento (líquido + rubricas), recalcula os totais e sincroniza a conta a pagar. */
export async function writeEntry(tx: DBOrTx, orgId: string, userId: string | null, data: {
  entryId?: string; periodId: string; employeeId: string; payslipNet: string; payslipNetDeclared?: string | null; lines: LineInput[]; notes: string | null;
}) {
  const rubrics = await rubricsOf(orgId, tx);
  const map = new Map(rubrics.map((r) => [r.id, r]));
  const lines = data.lines.filter((l) => toCents(l.amount) !== 0);
  for (const l of lines) if (!map.has(l.rubricId)) throw badRequest('Rubrica inválida');
  const { costs } = await getPayrollSettings(orgId, tx);
  const [emp] = await tx.select({ payslipOnly: schema.employees.payslipOnly }).from(schema.employees).where(eq(schema.employees.id, data.employeeId));
  const t = payrollTotals(data.payslipNet, lines, map, costs, { payslipOnly: !!emp?.payslipOnly });
  // holerite detalhado: as rubricas têm de fechar com o valor líquido do holerite (sem furo)
  const declared = t.detailed ? data.payslipNetDeclared ?? null : null;
  const check = payslipCheck(declared, t.payslipNet);
  if (check.state === 'mismatch') {
    throw badRequest(`As rubricas do holerite somam ${formatBRL(t.payslipNet)}, mas o valor líquido do holerite é ${formatBRL(declared!)} (diferença de ${formatBRL(Math.abs(check.diff) / 100)}). Confira os valores antes de salvar.`, 'payslip_mismatch');
  }
  const values = {
    payslipNet: t.payslipNet, payslipNetDeclared: declared, total: t.total, offPayroll: t.offPayroll, employerCost: t.employerCost, companyCost: t.companyCost, notes: data.notes,
  };
  let entryId = data.entryId;
  if (entryId) {
    await tx.update(schema.payrollEntries).set(values).where(eq(schema.payrollEntries.id, entryId));
    await tx.delete(schema.payrollEntryLines).where(eq(schema.payrollEntryLines.entryId, entryId));
  } else {
    const [e] = await tx.insert(schema.payrollEntries).values({ ...values, orgId, periodId: data.periodId, employeeId: data.employeeId, createdBy: userId }).returning();
    entryId = e.id;
  }
  if (lines.length) await tx.insert(schema.payrollEntryLines).values(lines.map((l) => ({ entryId: entryId!, rubricId: l.rubricId, amount: l.amount, note: l.note ?? null })));
  await syncEntryBill(tx, entryId, userId);
  return { id: entryId, totals: t };
}

/**
 * A categoria das contas de salário é sempre restrita: sem isso, quem vê Contas a pagar veria o
 * salário de cada funcionário. Marca a categoria e os registros de auditoria das contas dela.
 */
export async function restrictPayrollCategory(tx: DBOrTx, orgId: string, categoryId: string) {
  const done = await tx.update(schema.categories).set({ isRestricted: true })
    .where(and(eq(schema.categories.id, categoryId), eq(schema.categories.orgId, orgId), eq(schema.categories.isRestricted, false))).returning({ id: schema.categories.id });
  if (!done.length) return false;
  await tx.execute(sql`
    update audit_logs a set details = coalesce(a.details, '{}'::jsonb) || '{"restricted": true}'::jsonb
    from bills b
    where a.org_id = ${orgId} and a.entity_type = 'bill' and a.entity_id = b.id::text and b.category_id = ${categoryId}
      and (a.details is null or jsonb_typeof(a.details) = 'object')`);
  return true;
}

/**
 * Mantém a conta a pagar do lançamento: cria quando o mês gera contas e o total > 0, atualiza
 * valor/vencimento/descrição enquanto pendente e apaga quando o total zera. Conta paga não é tocada.
 */
export async function syncEntryBill(tx: DBOrTx, entryId: string, userId: string | null) {
  const [e] = await tx.select().from(schema.payrollEntries).where(eq(schema.payrollEntries.id, entryId));
  if (!e) return;
  const [p] = await tx.select().from(schema.payrollPeriods).where(eq(schema.payrollPeriods.id, e.periodId));
  const [emp] = await tx.select().from(schema.employees).where(eq(schema.employees.id, e.employeeId));
  const bill = e.billId ? (await tx.select().from(schema.bills).where(eq(schema.bills.id, e.billId)))[0] : undefined;
  if (bill?.status === 'paid') return;
  if (!p.billsEnabled || toCents(e.total) <= 0) {
    if (bill) {
      await tx.update(schema.payrollEntries).set({ billId: null }).where(eq(schema.payrollEntries.id, e.id));
      await deleteBillsWithFiles(tx, [bill.id]); // leva os anexos junto (antes ficavam órfãos no disco)
    }
    return;
  }
  const settings = await getPayrollSettings(e.orgId, tx);
  if (!settings.categoryId) throw badRequest('Escolha a categoria das contas de salário em Folha de pagamento → Configurar.', 'payroll_category');
  // só a origem: a divisão do valor (holerite × extras) fica na Folha, não em Contas a pagar
  const notes = `Folha de pagamento ${refLabelPT(p.ref)}.`;
  const values = {
    description: `Salário ${emp.name} – ${refLabelPT(p.ref)}`.slice(0, 255), amount: e.total, dueDate: p.payDate,
    categoryId: settings.categoryId, folderId: settings.folderId ?? null, relatedPerson: emp.name.slice(0, 128),
    pixKey: emp.pixKey, paymentMethod: settings.paymentMethod ?? null, notes,
  };
  if (bill) {
    await tx.update(schema.bills).set(values).where(eq(schema.bills.id, bill.id));
    return;
  }
  const [b] = await tx.insert(schema.bills).values({
    ...values, orgId: e.orgId, type: 'payable', recurrenceType: 'once', payrollEntryId: e.id, createdBy: userId,
  }).returning();
  await tx.update(schema.payrollEntries).set({ billId: b.id }).where(eq(schema.payrollEntries.id, e.id));
}

/**
 * Regrava os totais dos lançamentos em aberto de um funcionário (mudou o "só holerite" no cadastro).
 * Ficam como estão: salário já pago e meses do histórico importado.
 */
export async function rewriteOpenEntries(tx: DBOrTx, orgId: string, employeeId: string, userId: string | null) {
  const rows = await tx.select({ e: schema.payrollEntries, billStatus: schema.bills.status }).from(schema.payrollEntries)
    .innerJoin(schema.payrollPeriods, eq(schema.payrollPeriods.id, schema.payrollEntries.periodId))
    .leftJoin(schema.bills, eq(schema.bills.id, schema.payrollEntries.billId))
    .where(and(eq(schema.payrollEntries.employeeId, employeeId), eq(schema.payrollPeriods.billsEnabled, true)));
  let n = 0;
  for (const { e, billStatus } of rows) {
    if (billStatus === 'paid') continue;
    const lines = await tx.select().from(schema.payrollEntryLines).where(eq(schema.payrollEntryLines.entryId, e.id));
    const detailed = e.payslipNetDeclared !== null;
    await writeEntry(tx, orgId, userId, {
      entryId: e.id, periodId: e.periodId, employeeId, payslipNet: e.payslipNet, payslipNetDeclared: detailed ? e.payslipNetDeclared : null,
      lines: lines.map((l) => ({ rubricId: l.rubricId, amount: l.amount, note: l.note })), notes: e.notes,
    });
    n++;
  }
  return n;
}

/** Ressincroniza as contas de um conjunto de lançamentos (mudou o mês, o funcionário ou a configuração). */
export async function syncEntries(tx: DBOrTx, entryIds: string[], userId: string | null) {
  for (const id of entryIds) await syncEntryBill(tx, id, userId);
}

export async function entryIdsWhere(tx: DBOrTx, cond: ReturnType<typeof eq>) {
  return (await tx.select({ id: schema.payrollEntries.id }).from(schema.payrollEntries).where(cond)).map((r) => r.id);
}

/** Contas já pagas entre os lançamentos (bloqueiam apagar). */
export async function paidBillsCount(tx: DBOrTx, entryIds: string[]) {
  if (!entryIds.length) return 0;
  const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(schema.payrollEntries)
    .innerJoin(schema.bills, eq(schema.bills.id, schema.payrollEntries.billId))
    .where(and(inArray(schema.payrollEntries.id, entryIds), eq(schema.bills.status, 'paid')));
  return n;
}

/** Apaga lançamentos e as contas pendentes deles (anexos incluídos). */
export async function deleteEntries(tx: DBOrTx, entryIds: string[]) {
  if (!entryIds.length) return 0;
  const rows = await tx.select({ billId: schema.payrollEntries.billId }).from(schema.payrollEntries).where(inArray(schema.payrollEntries.id, entryIds));
  const billIds = rows.map((r) => r.billId).filter((x): x is string => !!x);
  await tx.update(schema.payrollEntries).set({ billId: null }).where(inArray(schema.payrollEntries.id, entryIds));
  await deleteBillsWithFiles(tx, billIds);
  await tx.delete(schema.payrollEntries).where(inArray(schema.payrollEntries.id, entryIds));
  return entryIds.length;
}
