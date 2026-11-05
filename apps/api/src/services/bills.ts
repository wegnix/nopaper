import { and, asc, desc, eq, gte, inArray, lt, lte, or, sql, isNull, notInArray, type SQL } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import {
  addMonthsISO, addYearsISO, addDaysISO, todayISO, monthRange, parseISODate, toCents, fromCents,
  billPerm, isPeriodic, occurrenceDate, type BillAction, type BillType, type PeriodicType, type Permission, type RecurrenceType, type AttachmentSlot,
} from '@nopaper/shared';
import { db, schema, type DBOrTx } from '../db/client.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { deleteFile } from '../lib/storage.js';

export type BillRow = typeof schema.bills.$inferSelect;

/** Sem data para acabar: quantas ocorrências manter lançadas (≈ 6 meses para semanal/quinzenal). */
export const INDEFINITE = {
  weekly: { window: 26, threshold: 13, refill: 13 },
  biweekly: { window: 13, threshold: 7, refill: 6 },
  monthly: { window: 24, threshold: 12, refill: 12 },
  yearly: { window: 5, threshold: 3, refill: 3 },
} as const;

/** Dia do mês preservado nas repetições mensais/anuais (31 → último dia); semanal não usa. */
export const recurrenceDayFor = (type: RecurrenceType, dueDate: string) =>
  type === 'monthly' || type === 'yearly' ? parseISODate(dueDate).d : null;

export const viewPerm = (t: BillType): Permission => billPerm(t, 'view');
export const createPerm = (t: BillType): Permission => billPerm(t, 'create');

export function orgToday(req: FastifyRequest) {
  return todayISO(req.org?.timezone);
}

export async function restrictedCategoryIds(orgId: string, conn: DBOrTx = db): Promise<string[]> {
  const rows = await conn.select({ id: schema.categories.id }).from(schema.categories)
    .where(and(eq(schema.categories.orgId, orgId), eq(schema.categories.isRestricted, true)));
  return rows.map((r) => r.id);
}

/** Condição SQL que esconde contas de categorias restritas para quem não tem permissão. */
export async function visibilityCond(req: FastifyRequest): Promise<SQL | undefined> {
  if (req.org!.can('bills.view_restricted')) return undefined;
  const ids = await restrictedCategoryIds(req.org!.id);
  return ids.length ? notInArray(schema.bills.categoryId, ids) : undefined;
}

/** Busca uma conta respeitando org, tipo/permissão e restrição (404 se não puder ver). */
/** Carrega a conta do espaço e exige ao menos uma das ações (`need`) para o tipo dela. */
export async function loadBill(req: FastifyRequest, id: string, need: BillAction | BillAction[] = 'view', conn: DBOrTx = db): Promise<BillRow> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound('Conta não encontrada');
  const [b] = await conn.select().from(schema.bills).where(and(eq(schema.bills.id, id), eq(schema.bills.orgId, req.org!.id)));
  if (!b) throw notFound('Conta não encontrada');
  const t = b.type as BillType;
  if (!req.org!.can(viewPerm(t))) throw notFound('Conta não encontrada');
  const needs = Array.isArray(need) ? need : [need];
  if (!needs.some((a) => req.org!.can(billPerm(t, a)))) throw forbidden('Sem permissão para esta ação');
  if (!req.org!.can('bills.view_restricted')) {
    const ids = await restrictedCategoryIds(req.org!.id, conn);
    if (ids.includes(b.categoryId)) throw notFound('Conta não encontrada');
  }
  return b;
}

export async function assertCategoryUsable(req: FastifyRequest, categoryId: string, type: BillType, conn: DBOrTx = db) {
  const [c] = await conn.select().from(schema.categories).where(and(eq(schema.categories.id, categoryId), eq(schema.categories.orgId, req.org!.id)));
  if (!c) throw badRequest('Categoria inválida');
  if (c.isRestricted && !req.org!.can('bills.view_restricted')) throw forbidden('Categoria não permitida');
  if (c.kind !== 'both' && c.kind !== type) throw badRequest(`A categoria "${c.label}" não é de ${type === 'payable' ? 'contas a pagar' : 'contas a receber'}`);
  return c;
}

export async function assertFolder(req: FastifyRequest, folderId: string | null | undefined, conn: DBOrTx = db) {
  if (!folderId) return;
  const [f] = await conn.select({ id: schema.folders.id }).from(schema.folders).where(and(eq(schema.folders.id, folderId), eq(schema.folders.orgId, req.org!.id)));
  if (!f) throw badRequest('Pasta inválida');
}

// ------------------------------------------------------------------ planejamento de ocorrências
export interface PlanInput {
  recurrenceType: RecurrenceType;
  dueDate: string;
  amount?: string;
  isIndefinite: boolean;
  totalOccurrences?: number;
  installmentAmounts?: string[];
  installmentDueDates?: string[];
  firstInstallment?: number;
}
export interface PlannedRow { amount: string; dueDate: string; installmentNumber: number | null; totalInstallments: number | null }

export function planOccurrences(p: PlanInput): PlannedRow[] {
  const day = parseISODate(p.dueDate).d;
  const advance = (i: number) => occurrenceDate(p.recurrenceType === 'installments' ? 'monthly' : p.recurrenceType, p.dueDate, i, day);
  if (p.recurrenceType === 'once') {
    if (!p.amount) throw badRequest('Informe o valor');
    return [{ amount: p.amount, dueDate: p.dueDate, installmentNumber: null, totalInstallments: null }];
  }
  if (p.recurrenceType === 'installments') {
    let amounts = p.installmentAmounts;
    if (!amounts?.length) {
      if (!p.amount || !p.totalOccurrences) throw badRequest('Informe os valores das parcelas');
      amounts = Array(p.totalOccurrences).fill(p.amount);
    }
    // parcelas já pagas fora do sistema: numera a partir de `firstInstallment` (42/213 … 213/213)
    const first = p.firstInstallment ?? 1;
    const total = first - 1 + amounts.length;
    return amounts.map((amount, i) => ({
      amount, dueDate: p.installmentDueDates?.[i] ?? advance(i), installmentNumber: first + i, totalInstallments: total,
    }));
  }
  // semanal / quinzenal / mensal / anual
  let n: number;
  if (p.isIndefinite) n = INDEFINITE[p.recurrenceType as PeriodicType].window;
  else n = p.installmentAmounts?.length || p.installmentDueDates?.length || Math.max(1, p.totalOccurrences ?? 1);
  if (!p.isIndefinite && p.installmentDueDates && p.installmentDueDates.length !== n) throw badRequest('Quantidade de datas difere da quantidade de valores');
  const rows: PlannedRow[] = [];
  for (let i = 0; i < n; i++) {
    const amount = (!p.isIndefinite && p.installmentAmounts?.[i]) || p.amount;
    if (!amount) throw badRequest('Informe o valor');
    const dueDate = (!p.isIndefinite && p.installmentDueDates?.[i]) || advance(i);
    rows.push({ amount, dueDate, installmentNumber: null, totalInstallments: null });
  }
  return rows;
}

// ------------------------------------------------------------------ serialização
export type AttachmentSummary = { id: string; name: string; mime: string; size: number };

export async function attachmentsFor(billIds: string[], conn: DBOrTx = db) {
  const map = new Map<string, Partial<Record<AttachmentSlot, AttachmentSummary>>>();
  if (!billIds.length) return map;
  const rows = await conn.select({
    id: schema.attachments.id, billId: schema.attachments.billId, slot: schema.attachments.slot,
    name: schema.attachments.originalName, mime: schema.attachments.mime, size: schema.attachments.size,
  }).from(schema.attachments).where(inArray(schema.attachments.billId, billIds));
  for (const r of rows) {
    const cur = map.get(r.billId) ?? {};
    cur[r.slot as AttachmentSlot] = { id: r.id, name: r.name, mime: r.mime, size: r.size };
    map.set(r.billId, cur);
  }
  return map;
}

export function serialize(b: BillRow, att: Partial<Record<AttachmentSlot, AttachmentSummary>> = {}) {
  return {
    id: b.id, type: b.type, parentId: b.parentId, description: b.description,
    categoryId: b.categoryId, folderId: b.folderId, cardId: b.cardId, statementId: b.statementId, payrollEntryId: b.payrollEntryId,
    amount: b.amount, dueDate: b.dueDate, status: b.status, paidAt: b.paidAt, paidAmount: b.paidAmount,
    recurrenceType: b.recurrenceType, installmentNumber: b.installmentNumber, totalInstallments: b.totalInstallments,
    isIndefinite: b.isIndefinite, relatedPerson: b.relatedPerson, notes: b.notes, barcode: b.barcode,
    pixKey: b.pixKey, paymentMethod: b.paymentMethod, attachments: att,
    createdAt: b.createdAt, updatedAt: b.updatedAt,
  };
}

export async function serializeMany(rows: BillRow[], conn: DBOrTx = db) {
  const att = await attachmentsFor(rows.map((r) => r.id), conn);
  return rows.map((r) => serialize(r, att.get(r.id)));
}

// ------------------------------------------------------------------ criação
export interface CreateInput extends PlanInput {
  type: BillType;
  description: string;
  categoryId: string;
  folderId?: string | null;
  cardId?: string | null;
  relatedPerson?: string | null;
  notes?: string | null;
  barcode?: string | null;
  pixKey?: string | null;
  paymentMethod?: string | null;
  paidAt?: string | null;
  paidAmount?: string | null;
  importBatchId?: string | null;
  statementId?: string | null;
}

export async function createBills(tx: DBOrTx, orgId: string, userId: string | null, input: CreateInput) {
  if (input.isIndefinite && !isPeriodic(input.recurrenceType)) {
    throw badRequest('Repetição sem data para acabar só para semanal, quinzenal, mensal ou anual');
  }
  const plan = planOccurrences(input);
  const base = {
    orgId, type: input.type, description: input.description, categoryId: input.categoryId,
    folderId: input.folderId ?? null, cardId: input.cardId ?? null, statementId: input.statementId ?? null,
    recurrenceType: input.recurrenceType, relatedPerson: input.relatedPerson ?? null, notes: input.notes ?? null,
    pixKey: input.pixKey ?? null, paymentMethod: input.paymentMethod ?? null, createdBy: userId,
    importBatchId: input.importBatchId ?? null,
    recurrenceDay: recurrenceDayFor(input.recurrenceType, input.dueDate),
  };
  const paid = input.paidAt ? { status: 'paid', paidAt: input.paidAt, paidAmount: input.paidAmount ?? plan[0].amount } : {};
  const [head] = await tx.insert(schema.bills).values({
    ...base, ...plan[0], ...paid,
    // código de barras pertence a um boleto específico: só na 1ª ocorrência
    barcode: input.barcode ?? null,
    isIndefinite: input.isIndefinite && input.recurrenceType !== 'once',
  }).returning();
  const children = plan.length > 1
    ? await tx.insert(schema.bills).values(plan.slice(1).map((r) => ({ ...base, ...r, parentId: head.id }))).returning()
    : [];
  return [head, ...children];
}

// ------------------------------------------------------------------ listagem / KPIs
export interface ListFilters {
  type: BillType;
  year?: number; month?: number; from?: string; to?: string;
  categoryId?: string; folderId?: string; status?: 'pending' | 'paid' | 'overdue' | 'due_soon'; search?: string;
  days?: number[];
}

export async function listBills(req: FastifyRequest, f: ListFilters) {
  const today = orgToday(req);
  const conds: (SQL | undefined)[] = [eq(schema.bills.orgId, req.org!.id), eq(schema.bills.type, f.type), await visibilityCond(req)];
  // "Vencidas" lista todas as vencidas, de qualquer mês (o sistema anterior só olhava o mês aberto)
  if (f.status === 'overdue') {
    conds.push(eq(schema.bills.status, 'pending'), lt(schema.bills.dueDate, today));
  } else {
    const range = f.from && f.to ? { from: f.from, to: f.to } : f.year && f.month ? monthRange(f.year, f.month) : f.year ? { from: `${f.year}-01-01`, to: `${f.year}-12-31` } : null;
    if (range) conds.push(gte(schema.bills.dueDate, range.from), lte(schema.bills.dueDate, range.to));
    if (f.status === 'pending') conds.push(eq(schema.bills.status, 'pending'));
    if (f.status === 'paid') conds.push(eq(schema.bills.status, 'paid'));
    if (f.status === 'due_soon') conds.push(eq(schema.bills.status, 'pending'), gte(schema.bills.dueDate, today), lte(schema.bills.dueDate, addDaysISO(today, 7)));
  }
  if (f.categoryId) conds.push(eq(schema.bills.categoryId, f.categoryId));
  if (f.days?.length) conds.push(inArray(sql<number>`extract(day from ${schema.bills.dueDate})::int`, f.days));
  if (f.folderId === 'none') conds.push(isNull(schema.bills.folderId));
  else if (f.folderId) conds.push(eq(schema.bills.folderId, f.folderId));
  if (f.search) {
    const term = `%${f.search.toLowerCase()}%`;
    conds.push(or(
      sql`lower(${schema.bills.description}) like ${term}`,
      sql`lower(coalesce(${schema.bills.relatedPerson}, '')) like ${term}`,
      sql`lower(coalesce(${schema.bills.notes}, '')) like ${term}`,
      sql`lower(coalesce(${schema.bills.paymentMethod}, '')) like ${term}`,
    ));
  }
  // mesmo dia: ordem alfabética da descrição (a tela e a exportação seguem a mesma ordem)
  const rows = await db.select().from(schema.bills).where(and(...conds))
    .orderBy(asc(schema.bills.dueDate), sql`lower(${schema.bills.description})`, asc(schema.bills.createdAt)).limit(5000);
  return serializeMany(rows);
}

export async function summary(req: FastifyRequest, type: BillType, year: number, month: number) {
  const today = orgToday(req);
  const { from, to } = monthRange(year, month);
  const vis = await visibilityCond(req);
  const base = and(eq(schema.bills.orgId, req.org!.id), eq(schema.bills.type, type), vis);
  const [m] = await db.select({
    pendingTotal: sql<string>`coalesce(sum(${schema.bills.amount}) filter (where ${schema.bills.status} = 'pending'), 0)::text`,
    pendingCount: sql<number>`count(*) filter (where ${schema.bills.status} = 'pending')::int`,
    paidTotal: sql<string>`coalesce(sum(coalesce(${schema.bills.paidAmount}, ${schema.bills.amount})) filter (where ${schema.bills.status} = 'paid'), 0)::text`,
    paidCount: sql<number>`count(*) filter (where ${schema.bills.status} = 'paid')::int`,
    forecastTotal: sql<string>`coalesce(sum(${schema.bills.amount}), 0)::text`,
    categories: sql<number>`count(distinct ${schema.bills.categoryId})::int`,
  }).from(schema.bills).where(and(base, gte(schema.bills.dueDate, from), lte(schema.bills.dueDate, to)));
  const [o] = await db.select({
    total: sql<string>`coalesce(sum(${schema.bills.amount}), 0)::text`,
    count: sql<number>`count(*)::int`,
  }).from(schema.bills).where(and(base, eq(schema.bills.status, 'pending'), lt(schema.bills.dueDate, today)));
  const [s] = await db.select({
    total: sql<string>`coalesce(sum(${schema.bills.amount}), 0)::text`,
    count: sql<number>`count(*)::int`,
  }).from(schema.bills).where(and(base, eq(schema.bills.status, 'pending'), gte(schema.bills.dueDate, today), lte(schema.bills.dueDate, addDaysISO(today, 7))));
  const byCategory = await db.select({
    categoryId: schema.bills.categoryId,
    total: sql<string>`sum(${schema.bills.amount})::text`,
    paid: sql<string>`coalesce(sum(coalesce(${schema.bills.paidAmount}, ${schema.bills.amount})) filter (where ${schema.bills.status} = 'paid'), 0)::text`,
    count: sql<number>`count(*)::int`,
  }).from(schema.bills).where(and(base, gte(schema.bills.dueDate, from), lte(schema.bills.dueDate, to)))
    .groupBy(schema.bills.categoryId).orderBy(sql`sum(${schema.bills.amount}) desc`);
  return {
    year, month, today,
    pending: { total: fmt(m.pendingTotal), count: m.pendingCount },
    paid: { total: fmt(m.paidTotal), count: m.paidCount },
    forecast: { total: fmt(m.forecastTotal), count: m.pendingCount + m.paidCount },
    overdue: { total: fmt(o.total), count: o.count },
    dueSoon: { total: fmt(s.total), count: s.count },
    categoriesActive: m.categories,
    byCategory: byCategory.map((c) => ({ ...c, total: fmt(c.total), paid: fmt(c.paid) })),
  };
}
const fmt = (v: string) => fromCents(toCents(v));

// ------------------------------------------------------------------ série
export const headIdOf = (b: BillRow) => b.parentId ?? b.id;

export async function seriesRows(conn: DBOrTx, b: BillRow) {
  const headId = headIdOf(b);
  return conn.select().from(schema.bills)
    .where(and(eq(schema.bills.orgId, b.orgId), or(eq(schema.bills.id, headId), eq(schema.bills.parentId, headId))))
    .orderBy(asc(schema.bills.dueDate));
}

/** Apaga contas + arquivos físicos dos anexos (o sistema anterior deixava órfãos). */
export async function deleteBillsWithFiles(conn: DBOrTx, ids: string[]) {
  if (!ids.length) return 0;
  const files = await conn.select({ key: schema.attachments.storageKey }).from(schema.attachments).where(inArray(schema.attachments.billId, ids));
  // filhas apontando para cabeças apagadas viram órfãs (FK set null) — tratado por quem chama
  const deleted = await conn.delete(schema.bills).where(inArray(schema.bills.id, ids)).returning({ id: schema.bills.id });
  await Promise.all(files.map((f) => deleteFile(f.key)));
  return deleted.length;
}

// ------------------------------------------------------------------ recorrência indefinida
export async function extendIndefinite(conn: DBOrTx, head: BillRow, todayStr: string) {
  const type = head.recurrenceType as RecurrenceType;
  if (!head.isIndefinite || head.parentId || !isPeriodic(type)) return 0;
  const cfg = INDEFINITE[type];
  const [{ future, last }] = await conn.select({
    future: sql<number>`count(*) filter (where ${schema.bills.status} = 'pending' and ${schema.bills.dueDate} >= ${todayStr})::int`,
    last: sql<string>`max(${schema.bills.dueDate})::text`,
  }).from(schema.bills).where(or(eq(schema.bills.id, head.id), eq(schema.bills.parentId, head.id)));
  if (future >= cfg.threshold) return 0;
  const day = head.recurrenceDay ?? recurrenceDayFor(type, head.dueDate) ?? undefined;
  // modelo = ocorrência mais recente (reflete reajustes propagados para as futuras)
  const [tpl] = await conn.select().from(schema.bills)
    .where(or(eq(schema.bills.id, head.id), eq(schema.bills.parentId, head.id)))
    .orderBy(desc(schema.bills.dueDate)).limit(1);
  const src = tpl ?? head;
  const rows = [];
  for (let i = 1; i <= cfg.refill; i++) {
    const dueDate = occurrenceDate(type, last, i, day);
    rows.push({
      orgId: head.orgId, type: head.type, parentId: head.id, description: src.description,
      categoryId: src.categoryId, folderId: src.folderId, amount: src.amount, dueDate,
      recurrenceType: head.recurrenceType, recurrenceDay: head.recurrenceDay, relatedPerson: src.relatedPerson,
      notes: src.notes, pixKey: src.pixKey, paymentMethod: src.paymentMethod, createdBy: head.createdBy,
    });
  }
  await conn.insert(schema.bills).values(rows);
  return rows.length;
}

export async function extendAllIndefinite() {
  const heads = await db.select().from(schema.bills).where(and(eq(schema.bills.isIndefinite, true), isNull(schema.bills.parentId)));
  let created = 0, failed = 0;
  const tzByOrg = new Map<string, string>();
  for (const h of heads) {
    try {
      if (!tzByOrg.has(h.orgId)) {
        const [o] = await db.select({ tz: schema.organizations.timezone }).from(schema.organizations).where(eq(schema.organizations.id, h.orgId));
        tzByOrg.set(h.orgId, o?.tz ?? 'America/Sao_Paulo');
      }
      created += await extendIndefinite(db, h, todayISO(tzByOrg.get(h.orgId)));
    } catch {
      failed++;
    }
  }
  return { heads: heads.length, created, failed };
}

