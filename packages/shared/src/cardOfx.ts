import { z } from 'zod';
import { money, isoDate } from './schemas.js';
import { fromCents, toCents } from './money.js';
import { cycleForPurchase, addMonthsRef } from './cards.js';
import type { OfxStatement } from './bank.js';

/**
 * Fatura do cartão em OFX (CCSTMTRS) → compras do NoPaper.
 *
 * No OFX do cartão, negativo = gasto e positivo = crédito; no NoPaper é o contrário (compra positiva,
 * estorno negativo). Parcelas vêm com "NN/NN" no texto (ex.: "AMAZON BRV  01/06  SAO PAULO") e a data
 * da compra original. O arquivo é uma fatura inteira: tudo entra na fatura escolhida na importação.
 */

export type CardOfxKind = 'purchase' | 'refund' | 'payment';
export interface CardOfxLine {
  fitId: string;
  date: string;
  /** Sinal do NoPaper: positivo = compra, negativo = estorno/crédito. */
  amount: string;
  /** Descrição limpa (sem cidade nem parcela). */
  description: string;
  /** Texto original do banco. */
  memo: string;
  installment: number | null;
  installments: number | null;
  kind: CardOfxKind;
}

const INSTALLMENT = /(?:^|\s)(\d{2})\/(\d{2})(?=\s|$)/;
const PAYMENT = /\b(PAGAMENTO|PAGTO|PGTO)\b/i;

/** "BRASIL PARAL*BrasilP  02/12   SAO PAULO" → descrição, parcela 2 de 12. */
export function parseCardMemo(memo: string): { description: string; installment: number | null; installments: number | null } {
  // "EC          *SHELLBO": espaços antes do "*" fazem parte do nome, não separam a cidade
  const raw = memo.slice(0, 600).trimEnd().replace(/\s+\*/g, '*');
  const m = INSTALLMENT.exec(raw);
  let n = m ? Number(m[1]) : null, total = m ? Number(m[2]) : null;
  if (n === null || total === null || total < 2 || n < 1 || n > total) n = total = null;
  const noInst = m && n ? raw.replace(m[0], '  ') : raw;
  // o banco separa estabelecimento e cidade com vários espaços
  const description = (noInst.split(/\s{2,}/).map((s) => s.trim()).find(Boolean) ?? raw.trim()).slice(0, 255) || 'Compra no cartão';
  return { description, installment: n, installments: total };
}

export function cardOfxLines(st: Pick<OfxStatement, 'transactions'>): CardOfxLine[] {
  return st.transactions.map((t) => {
    const raw = [t.name, t.memo].filter(Boolean).join('  ').trim();
    const memo = raw.replace(/\s+/g, ' ');
    const cents = -toCents(t.amount);
    const p = parseCardMemo(raw || 'Compra no cartão');
    const kind: CardOfxKind = cents >= 0 ? 'purchase' : PAYMENT.test(memo) ? 'payment' : 'refund';
    return { fitId: t.fitId, date: t.date, amount: fromCents(cents), memo, kind, ...p };
  });
}

/**
 * Fatura sugerida: a mais comum entre as compras (cada parcela n conta como a fatura da compra + n−1).
 * Pagamento da fatura anterior não conta.
 */
export function suggestCardRef(lines: CardOfxLine[], closingDay: number, dueDay: number): string | null {
  const count = new Map<string, number>();
  for (const l of lines) {
    if (l.kind === 'payment') continue;
    const ref = addMonthsRef(cycleForPurchase(l.date, closingDay, dueDay).ref, (l.installment ?? 1) - 1);
    count.set(ref, (count.get(ref) ?? 0) + 1);
  }
  return [...count.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? 1 : -1))[0]?.[0] ?? null;
}

export interface ExistingCardTx { id: string; amount: string; purchaseDate: string; installmentNumber: number; totalInstallments: number }
const dayNum = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 86400000;

/**
 * Lançamentos do arquivo que já estão na fatura (importação repetida, parcela criada por uma importação
 * anterior ou compra lançada à mão): mesmo valor, até 3 dias de diferença e, se for parcela, o mesmo número.
 * Devolve fitId → id do lançamento existente; cada lançamento existente serve para um só.
 */
export function matchExistingCardTx(lines: CardOfxLine[], existing: ExistingCardTx[]): Map<string, string> {
  const out = new Map<string, string>();
  const used = new Set<string>();
  const pairs: Array<{ fit: string; id: string; score: number }> = [];
  for (const l of lines) {
    if (l.kind === 'payment') continue;
    for (const e of existing) {
      if (toCents(e.amount) !== toCents(l.amount)) continue;
      const diff = Math.abs(dayNum(e.purchaseDate) - dayNum(l.date));
      if (diff > 3) continue;
      if (l.installment && (e.installmentNumber !== l.installment || e.totalInstallments !== l.installments)) continue;
      pairs.push({ fit: l.fitId, id: e.id, score: 10 - diff });
    }
  }
  pairs.sort((a, b) => b.score - a.score);
  for (const p of pairs) {
    if (out.has(p.fit) || used.has(p.id)) continue;
    out.set(p.fit, p.id); used.add(p.id);
  }
  return out;
}

/** Chaves para lembrar a categoria pelo histórico: descrição inteira e o estabelecimento antes do "*". */
export function cardDescKeys(description: string): string[] {
  const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9*]+/g, ' ').trim();
  const full = norm(description);
  const head = full.split('*')[0].trim();
  return [...new Set([full, head.length >= 3 ? `${head}*` : ''].filter(Boolean))];
}

export const cardOfxImportSchema = z.object({
  fileName: z.string().trim().min(1).max(200),
  ref: z.string().regex(/^\d{4}-\d{2}$/, 'Escolha a fatura'),
  /** Parcela n de N: cria também as parcelas seguintes nas próximas faturas. */
  futureInstallments: z.boolean().default(true),
  /** Conta do cartão no arquivo (ACCTID): o cartão guarda a da 1ª importação, para reconhecer as próximas. */
  accountId: z.string().trim().max(40).nullish(),
  items: z.array(z.object({
    fitId: z.string().min(1).max(120),
    date: isoDate,
    description: z.string().trim().min(1, 'Informe a descrição').max(255),
    amount: money.refine((v) => toCents(v) !== 0, 'Valor deve ser diferente de zero'),
    categoryId: z.string().uuid('Escolha a categoria de todos os lançamentos'),
    installment: z.number().int().min(1).max(99).nullable().default(null),
    installments: z.number().int().min(2).max(99).nullable().default(null),
    notes: z.string().max(1000).nullable().default(null),
  }).refine((i) => (i.installment === null) === (i.installments === null) && (i.installment ?? 0) <= (i.installments ?? 0), 'Parcela inválida'))
    .min(1, 'Marque ao menos um lançamento').max(1000, 'No máximo 1000 lançamentos por importação'),
});
export type CardOfxImportInput = z.infer<typeof cardOfxImportSchema>;
