import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import {
  addMonthsRef, cycleForPurchase, cycleForRef, splitInstallments, fromCents, toCents, MONTHS_PT_SHORT, todayISO,
} from '@nopaper/shared';
import { db, schema, type DBOrTx } from '../db/client.js';
import { HttpError, notFound } from '../lib/errors.js';
import { deleteBillsWithFiles } from './bills.js';

export type CardRow = typeof schema.cards.$inferSelect;
export type StatementRow = typeof schema.cardStatements.$inferSelect;

export async function loadCard(orgId: string, id: string, conn: DBOrTx = db) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound('Cartão não encontrado');
  const [c] = await conn.select().from(schema.cards).where(and(eq(schema.cards.id, id), eq(schema.cards.orgId, orgId)));
  if (!c) throw notFound('Cartão não encontrado');
  return c;
}

/** Garante a linha da fatura (cria se não existir). */
export async function ensureStatement(tx: DBOrTx, card: CardRow, ref: string): Promise<StatementRow> {
  const [found] = await tx.select().from(schema.cardStatements).where(and(eq(schema.cardStatements.cardId, card.id), eq(schema.cardStatements.ref, ref)));
  if (found) return found;
  const cyc = cycleForRef(ref, card.closingDay, card.dueDay);
  const [s] = await tx.insert(schema.cardStatements).values({
    orgId: card.orgId, cardId: card.id, ref, closingDate: cyc.closingDate, dueDate: cyc.dueDate,
  }).onConflictDoNothing().returning();
  if (s) return s;
  const [again] = await tx.select().from(schema.cardStatements).where(and(eq(schema.cardStatements.cardId, card.id), eq(schema.cardStatements.ref, ref)));
  return again;
}

const refLabel = (ref: string) => `${MONTHS_PT_SHORT[Number(ref.slice(5, 7)) - 1]}/${ref.slice(0, 4)}`;

/**
 * Recalcula o total da fatura e sincroniza a conta a pagar vinculada:
 * cria quando total > 0, atualiza valor/vencimento, remove quando zera (se ainda não paga).
 */
export async function syncStatementBill(tx: DBOrTx, statementId: string, userId: string | null, opts: { lockPaid?: boolean } = {}) {
  const [st] = await tx.select().from(schema.cardStatements).where(eq(schema.cardStatements.id, statementId));
  if (!st) return;
  const [card] = await tx.select().from(schema.cards).where(eq(schema.cards.id, st.cardId));
  const [{ total }] = await tx.select({ total: sql<string>`coalesce(sum(${schema.cardTransactions.amount}), 0)::text` })
    .from(schema.cardTransactions).where(eq(schema.cardTransactions.statementId, st.id));
  const amount = fromCents(toCents(total));
  const description = `Fatura ${card.name} ${refLabel(st.ref)}`;
  const bill = st.billId ? (await tx.select().from(schema.bills).where(eq(schema.bills.id, st.billId)))[0] : undefined;
  // fatura já paga é histórico: nada aqui muda o valor (nem a categoria) de uma conta paga. Quem
  // precisa corrigir um lançamento reverte o pagamento em Contas a pagar — o que exige essa permissão.
  if (bill?.status === 'paid') {
    // `lockPaid`: quem chama está mudando lançamentos (criar, editar, apagar, mover) — recusa.
    // Sem ele (ressincronizar ao editar o cartão) só não mexe, mesmo que o histórico não feche.
    if (opts.lockPaid && toCents(amount) !== toCents(bill.amount)) throw new HttpError(409, `A fatura ${refLabel(st.ref)} do ${card.name} já está paga. Para mudar os lançamentos dela, reverta o pagamento em Contas a pagar.`, 'statement_paid');
    return;
  }
  if (toCents(amount) <= 0) {
    if (bill) {
      await tx.update(schema.cardStatements).set({ billId: null }).where(eq(schema.cardStatements.id, st.id));
      await deleteBillsWithFiles(tx, [bill.id]); // leva os anexos junto (antes ficavam órfãos no disco)
    }
    return;
  }
  if (bill) {
    await tx.update(schema.bills).set({ amount, dueDate: st.dueDate, description, categoryId: card.billCategoryId, folderId: card.billFolderId })
      .where(eq(schema.bills.id, bill.id));
    return;
  }
  const [b] = await tx.insert(schema.bills).values({
    orgId: st.orgId, type: 'payable', description, categoryId: card.billCategoryId, folderId: card.billFolderId,
    cardId: card.id, statementId: st.id, amount, dueDate: st.dueDate, recurrenceType: 'once',
    paymentMethod: 'Cartão de crédito', createdBy: userId,
  }).returning();
  await tx.update(schema.cardStatements).set({ billId: b.id }).where(eq(schema.cardStatements.id, st.id));
}

export interface TxInput {
  description: string; categoryId: string; amount: string; purchaseDate: string; installments: number;
  firstRef?: string | null; notes?: string | null; importBatchId?: string | null;
  /** Compra que começou antes (fatura importada a partir da parcela n): cria só n..N, a partir de firstRef. */
  startInstallment?: number;
}

/** Cria a compra (e suas parcelas) nas faturas corretas; retorna ids das faturas afetadas. */
export async function createPurchase(tx: DBOrTx, card: CardRow, userId: string | null, input: TxInput, groupId: string = randomUUID()) {
  const first = input.firstRef ?? cycleForPurchase(input.purchaseDate, card.closingDay, card.dueDay).ref;
  const parts = splitInstallments(input.amount, input.installments);
  const touched = new Set<string>();
  const rows = [];
  const start = Math.min(Math.max(1, input.startInstallment ?? 1), parts.length) - 1;
  for (let i = start; i < parts.length; i++) {
    const st = await ensureStatement(tx, card, addMonthsRef(first, i - start));
    touched.add(st.id);
    rows.push({
      orgId: card.orgId, cardId: card.id, statementId: st.id, groupId, description: input.description,
      categoryId: input.categoryId, amount: parts[i], totalAmount: input.amount, purchaseDate: input.purchaseDate,
      installmentNumber: i + 1, totalInstallments: parts.length, notes: input.notes ?? null,
      importBatchId: input.importBatchId ?? null, createdBy: userId,
    });
  }
  await tx.insert(schema.cardTransactions).values(rows);
  for (const id of touched) await syncStatementBill(tx, id, userId, { lockPaid: true });
  return { groupId, statements: [...touched] };
}

export async function deleteTransactions(tx: DBOrTx, ids: string[], userId: string | null) {
  if (!ids.length) return 0;
  const rows = await tx.delete(schema.cardTransactions).where(inArray(schema.cardTransactions.id, ids)).returning({ statementId: schema.cardTransactions.statementId });
  for (const s of new Set(rows.map((r) => r.statementId))) await syncStatementBill(tx, s, userId, { lockPaid: true });
  return rows.length;
}

/** Limite usado = soma dos lançamentos em faturas cuja conta ainda não foi paga (inclui parcelas futuras). */
export async function limitUsed(cardId: string) {
  const [{ used }] = await db.select({
    used: sql<string>`coalesce(sum(${schema.cardTransactions.amount}), 0)::text`,
  }).from(schema.cardTransactions)
    .innerJoin(schema.cardStatements, eq(schema.cardStatements.id, schema.cardTransactions.statementId))
    .leftJoin(schema.bills, eq(schema.bills.id, schema.cardStatements.billId))
    .where(and(eq(schema.cardTransactions.cardId, cardId), sql`coalesce(${schema.bills.status}, 'pending') <> 'paid'`));
  return fromCents(Math.max(0, toCents(used)));
}

export function statementStatus(st: { closingDate: string }, bill: { status: string } | undefined, today = todayISO()) {
  if (bill?.status === 'paid') return 'paid' as const;
  if (today < st.closingDate) return 'open' as const;
  return 'closed' as const;
}

export async function statementsOf(cardId: string) {
  return db.select().from(schema.cardStatements).where(eq(schema.cardStatements.cardId, cardId)).orderBy(asc(schema.cardStatements.ref));
}

