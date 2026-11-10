import { z } from 'zod';
import { daysInMonth, parseISODate, toISODate } from './dates.js';
import { CARD_COLOR_KEYS } from './colors.js';
import { money, isoDate } from './schemas.js';
import { fromCents, toCents } from './money.js';

export const CARD_BRANDS = ['visa', 'mastercard', 'elo', 'amex', 'hipercard', 'other'] as const;
export type CardBrand = (typeof CARD_BRANDS)[number];
export const CARD_BRAND_LABEL: Record<CardBrand, string> = {
  visa: 'Visa', mastercard: 'Mastercard', elo: 'Elo', amex: 'American Express', hipercard: 'Hipercard', other: 'Outra',
};

export interface StatementCycle { ref: string; closingDate: string; dueDate: string }

const clampDate = (y: number, m: number, d: number) => toISODate(y, m, Math.min(d, daysInMonth(y, m)));
const shiftMonth = (y: number, m: number, n: number) => {
  const t = y * 12 + (m - 1) + n;
  return { y: Math.floor(t / 12), m: (t % 12) + 1 };
};

/** Ciclo da fatura com vencimento no mês `ref` (YYYY-MM). */
export function cycleForRef(ref: string, closingDay: number, dueDay: number): StatementCycle {
  const [y, m] = ref.split('-').map(Number);
  // vencimento depois do fechamento no mesmo mês? fecha no mesmo mês; senão fecha no mês anterior
  const c = dueDay > closingDay ? { y, m } : shiftMonth(y, m, -1);
  return { ref, closingDate: clampDate(c.y, c.m, closingDay), dueDate: clampDate(y, m, dueDay) };
}

/**
 * Em qual fatura cai uma compra. Compras feitas no dia do fechamento ou depois
 * entram na fatura seguinte ("melhor dia de compra").
 */
export function cycleForPurchase(purchaseDate: string, closingDay: number, dueDay: number): StatementCycle {
  const { y, m, d } = parseISODate(purchaseDate);
  const closingThisMonth = Math.min(closingDay, daysInMonth(y, m));
  const c = d >= closingThisMonth ? shiftMonth(y, m, 1) : { y, m };
  const due = dueDay > closingDay ? c : shiftMonth(c.y, c.m, 1);
  return cycleForRef(`${due.y}-${String(due.m).padStart(2, '0')}`, closingDay, dueDay);
}

export function addMonthsRef(ref: string, n: number) {
  const [y, m] = ref.split('-').map(Number);
  const r = shiftMonth(y, m, n);
  return `${r.y}-${String(r.m).padStart(2, '0')}`;
}

/** Divide o total em N parcelas; diferença de centavos vai na 1ª. */
export function splitInstallments(total: string, n: number): string[] {
  const c = toCents(total);
  const base = Math.trunc(c / n);
  const first = c - base * (n - 1);
  return Array.from({ length: n }, (_, i) => fromCents(i === 0 ? first : base));
}

export const cardSchema = z.object({
  name: z.string().trim().min(1, 'Informe o nome').max(64),
  brand: z.enum(CARD_BRANDS).default('other'),
  last4: z.string().regex(/^\d{4}$/, 'Informe os 4 últimos dígitos').nullish().or(z.literal('').transform(() => null)),
  color: z.enum(CARD_COLOR_KEYS).default('indigo'),
  limitAmount: money.nullish(),
  closingDay: z.number().int().min(1).max(31),
  dueDay: z.number().int().min(1).max(31),
  billCategoryId: z.string().uuid('Escolha a categoria da fatura'),
  billFolderId: z.string().uuid().nullish(),
  holder: z.string().trim().max(64).nullish(),
  active: z.boolean().default(true),
});

export const cardTxSchema = z.object({
  cardId: z.string().uuid(),
  description: z.string().trim().min(1, 'Informe a descrição').max(255),
  /** Categoria do cartão (card_categories), não a de contas a pagar. */
  categoryId: z.string().uuid('Escolha a categoria'),
  /** Valor total da compra (negativo = estorno). */
  amount: money.refine((v) => v !== '0.00', 'Valor deve ser diferente de zero'),
  purchaseDate: isoDate,
  installments: z.number().int().min(1).max(48).default(1),
  /** Força a fatura (YYYY-MM) da 1ª parcela; senão calcula pela data. */
  firstRef: z.string().regex(/^\d{4}-\d{2}$/).nullish(),
  notes: z.string().max(1000).nullish(),
});
export const cardTxUpdateSchema = z.object({
  description: z.string().trim().min(1).max(255).optional(),
  categoryId: z.string().uuid().optional(),
  /** Com categoryId: muda também as outras compras da mesma loja (todos os cartões do espaço). */
  applyToShop: z.boolean().default(false),
  notes: z.string().max(1000).nullish(),
  /** Mudar valor/data/parcelas recria o grupo inteiro. */
  amount: money.optional(),
  purchaseDate: isoDate.optional(),
  installments: z.number().int().min(1).max(48).optional(),
  scope: z.enum(['one', 'group']).default('group'),
});
