/**
 * 13º salário na folha: um pagamento próprio por funcionário e parcela, dentro do mês da folha em que
 * é pago, com vencimento próprio (1ª parcela até 30/11, 2ª até 20/12, ou tudo de uma vez em dezembro).
 * Vira uma conta a pagar separada da do salário do mês.
 */
import { z } from 'zod';
import { money, isoDate } from './schemas.js';
import { addDaysISO } from './dates.js';
import { payslipDocKey } from './payslips.js';

export const THIRTEENTH_INSTALLMENTS = ['first', 'second', 'single'] as const;
export type ThirteenthInstallment = (typeof THIRTEENTH_INSTALLMENTS)[number];
export const THIRTEENTH_LABEL: Record<ThirteenthInstallment, string> = { first: '1ª parcela', second: '2ª parcela', single: 'Parcela única' };

/** Parcela do recibo pelo título lido do PDF ("13º Salário – 1ª parcela"); null = não é recibo de 13º. */
export function thirteenthInstallmentOf(title: string | null | undefined): ThirteenthInstallment | null {
  const k = payslipDocKey(title);
  if (!k.startsWith('13')) return null;
  if (/(^|-)1-parcela/.test(k)) return 'first';
  if (/(^|-)2-parcela/.test(k)) return 'second';
  return 'single';
}

/** Dia útil (seg–sex) igual ou anterior: o prazo legal cai no fim de semana → paga antes. */
const businessDayBefore = (d: string) => {
  const w = new Date(`${d}T12:00:00Z`).getUTCDay();
  return w === 0 ? addDaysISO(d, -2) : w === 6 ? addDaysISO(d, -1) : d;
};
/** Prazo legal: 1ª parcela até 30/11; 2ª (ou parcela única) até 20/12. */
export const thirteenthDeadline = (installment: ThirteenthInstallment, year: number) =>
  businessDayBefore(`${year}-${installment === 'first' ? '11-30' : '12-20'}`);

/**
 * Vencimento sugerido no mês da folha `ref`: o prazo legal se ele cair neste mês; senão (13º pago em
 * outro mês) a data de pagamento do mês.
 */
export function thirteenthDefaultPayDate(installment: ThirteenthInstallment, year: number, ref: string, monthPayDate: string) {
  const d = thirteenthDeadline(installment, year);
  return d.slice(0, 7) === ref ? d : monthPayDate;
}
/** Ano do 13º lançado na folha `ref` (folha de janeiro ainda costuma ser o 13º do ano anterior). */
export const thirteenthYearFor = (ref: string) => Number(ref.slice(0, 4)) - (ref.endsWith('-01') ? 1 : 0);

/** Parcela única não convive com 1ª/2ª no mesmo ano (e vice-versa). */
export function thirteenthClash(installment: ThirteenthInstallment, taken: ThirteenthInstallment[]): ThirteenthInstallment | null {
  for (const t of taken) {
    if (t === installment) return t;
    if ((t === 'single') !== (installment === 'single')) return t;
  }
  return null;
}

const amount = money.refine((v) => !v.startsWith('-'), 'Valor inválido');
const notes = z.string().max(1000).nullish().transform((v) => (v && v.trim() ? v.trim() : null));
export const thirteenthLineSchema = z.object({ name: z.string().trim().min(1).max(80), kind: z.enum(['earning', 'deduction']), amount });
export type ThirteenthLine = z.infer<typeof thirteenthLineSchema>;

/** Um pagamento de 13º (lançado à mão ou vindo do recibo do contador). */
export const thirteenthItemSchema = z.object({
  employeeId: z.string().uuid(),
  /** Matrícula do recibo (liga o funcionário ao holerite, como na importação de holerites). */
  code: z.string().trim().max(20).nullish(),
  installment: z.enum(THIRTEENTH_INSTALLMENTS),
  year: z.coerce.number().int().min(2000).max(2100),
  payDate: isoDate,
  /** Líquido do recibo. */
  net: amount,
  /** Valor a pagar (normalmente = líquido; diferente = combinado com a pessoa, a diferença é por fora). */
  amount,
  gross: amount.nullish(),
  fgts: amount.nullish(),
  lines: z.array(thirteenthLineSchema).max(40).default([]),
  notes,
});
export type ThirteenthItemInput = z.input<typeof thirteenthItemSchema>;

export const thirteenthApplySchema = z.object({
  /** Arquivo do contador (null = lançado à mão). */
  fileName: z.string().trim().max(200).nullish(),
  /** Documento da área do contador: fica como "lançado" depois. */
  docId: z.string().uuid().nullish(),
  items: z.array(thirteenthItemSchema).min(1, 'Nada para lançar').max(300),
});
export type ThirteenthApplyInput = z.input<typeof thirteenthApplySchema>;

export const thirteenthUpdateSchema = z.object({
  payDate: isoDate,
  net: amount,
  amount,
  notes,
});

/** Juntar a 1ª e a 2ª parcela numa conta só (por funcionário), com um vencimento. */
export const thirteenthJoinSchema = z.object({
  employeeIds: z.array(z.string().uuid()).min(1, 'Escolha ao menos um funcionário').max(300),
  payDate: isoDate,
});

export interface ThirteenthRow {
  id: string; periodId: string; employeeId: string; installment: ThirteenthInstallment; year: number; payDate: string;
  net: string; amount: string; gross: string | null; fgts: string | null; lines: ThirteenthLine[];
  source: 'pdf' | 'manual'; fileName: string | null; notes: string | null; billId: string | null;
  /** 1ª e 2ª parcela juntas numa conta só (as duas apontam para a mesma conta). */
  joined: boolean;
}
