import { z } from 'zod';
import { MONTHS_PT_SHORT } from './dates.js';

/**
 * Área do contador: o contador (membro do espaço com `accounting.upload`) envia os PDFs do mês —
 * holerites, a mensalidade do escritório, guias de impostos e outros documentos. Quem tem
 * `accounting.review` recebe o aviso, confere e lança (conta a pagar com o boleto anexado, ou a
 * importação dos holerites na folha).
 */
export const ACCOUNTING_KINDS = ['payslip', 'office_fee', 'das', 'darf', 'dae', 'state_tax', 'other'] as const;
/** O que o espaço manda para o contador (sentido inverso): notas fiscais e outros arquivos. */
export const ACCOUNTING_CLIENT_KINDS = ['invoice', 'other'] as const;
export type AccountingKind = (typeof ACCOUNTING_KINDS)[number] | (typeof ACCOUNTING_CLIENT_KINDS)[number];
/** to_client = do contador para o espaço; to_accountant = do espaço para o contador. */
export const ACCOUNTING_DIRECTIONS = ['to_client', 'to_accountant'] as const;
export type AccountingDirection = (typeof ACCOUNTING_DIRECTIONS)[number];
export const ACCOUNTING_KIND_LABEL: Record<AccountingKind, string> = {
  payslip: 'Holerites', office_fee: 'Mensalidade do escritório', das: 'DAS', darf: 'DARF', dae: 'DAE',
  state_tax: 'GARE / DARE / GNRE', other: 'Outro documento', invoice: 'Notas fiscais',
};
export const ACCOUNTING_KIND_HINT: Record<AccountingKind, string> = {
  payslip: 'PDF com os holerites de todos (folha do mês)',
  office_fee: 'Boleto ou recibo dos honorários',
  das: 'Simples Nacional',
  darf: 'Tributos federais',
  dae: 'eSocial / arrecadação estadual',
  state_tax: 'Guias estaduais (ICMS e outros)',
  other: 'Qualquer outro PDF',
  invoice: 'Notas de compra, venda ou serviço',
};
/** Guias e boletos: viram conta a pagar. */
export const accountingIsPayable = (k: AccountingKind) => k !== 'payslip' && k !== 'other';

export const ACCOUNTING_STATUSES = ['new', 'done', 'dismissed'] as const;
export type AccountingStatus = (typeof ACCOUNTING_STATUSES)[number];
export const ACCOUNTING_STATUS_LABEL: Record<AccountingStatus, string> = { new: 'Novo', done: 'Lançado', dismissed: 'Dispensado' };

const ref = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Mês inválido (AAAA-MM)');
const text = (max: number) => z.string().max(max).nullish().transform((v) => (v && v.trim() ? v.trim() : null));

/** Campos que acompanham os arquivos no envio. */
export const accountingUploadSchema = z.object({
  kind: z.enum(ACCOUNTING_KINDS),
  /** Competência (mês a que o documento se refere). */
  competence: ref.nullish().or(z.literal('').transform(() => null)),
  note: text(500),
});

/** Campos do envio do espaço para o contador. */
export const accountingSendSchema = z.object({
  kind: z.enum(ACCOUNTING_CLIENT_KINDS).default('invoice'),
  competence: ref.nullish().or(z.literal('').transform(() => null)),
  note: text(500),
  /** Com mais de um contador no espaço: o id de um deles, ou "all" (todos). */
  recipientId: z.string().uuid().or(z.literal('all')).nullish().or(z.literal('').transform(() => null)),
});

export const accountingHandleSchema = z.object({
  status: z.enum(ACCOUNTING_STATUSES),
  /** Conta a pagar criada a partir do documento. */
  billId: z.string().uuid().nullish(),
  note: text(500),
});

/** O que foi lido do arquivo no envio (boleto/guia: valor, vencimento, código; holerites: quantos e de que mês). */
export interface AccountingDetected {
  amount?: string | null; dueDate?: string | null; barcode?: string | null; pix?: boolean;
  slips?: number; slipsRef?: string | null; company?: string | null;
}

const refLabel = (r: string) => `${MONTHS_PT_SHORT[Number(r.slice(5, 7)) - 1]}/${r.slice(0, 4)}`;
/** Descrição sugerida para a conta a pagar: "DAS – Out/2026". */
export function accountingBillDescription(kind: AccountingKind, competence: string | null): string {
  const base = kind === 'office_fee' ? 'Honorários contabilidade' : kind === 'state_tax' ? 'Guia estadual' : kind === 'other' || kind === 'payslip' ? 'Documento do contador' : ACCOUNTING_KIND_LABEL[kind];
  return competence ? `${base} – ${refLabel(competence)}` : base;
}
