import { z } from 'zod';
import { MONTHS_PT_SHORT } from './dates.js';

/**
 * Área do contador: o contador (membro do espaço com `accounting.upload`) envia os PDFs do mês —
 * holerites, a mensalidade do escritório, guias de impostos e outros documentos. Quem tem
 * `accounting.review` recebe o aviso, confere e lança (conta a pagar com o boleto anexado, ou a
 * importação dos holerites na folha).
 */
/**
 * Tipos do que o contador envia. Na tela ele escolhe primeiro o GRUPO (`ACCOUNTING_GROUPS`) e depois o tipo.
 * `vacation` (relatório de férias) não é escolhido à mão: um envio em "Relatórios" que o sistema reconhece
 * como o relatório de férias é gravado com esse tipo e aparece em Folha → Férias.
 */
export const ACCOUNTING_KINDS = ['payslip', 'thirteenth', 'vacation_slip', 'payroll_report', 'vacation', 'das', 'darf', 'dae', 'state_tax', 'tax_other', 'office_fee', 'fee_other', 'other'] as const;
/** O que o espaço manda para o contador (sentido inverso): notas fiscais, termos assinados e outros arquivos. */
export const ACCOUNTING_CLIENT_KINDS = ['invoice', 'term', 'other'] as const;
export type AccountingKind = (typeof ACCOUNTING_KINDS)[number] | (typeof ACCOUNTING_CLIENT_KINDS)[number];
/** to_client = do contador para o espaço; to_accountant = do espaço para o contador. */
export const ACCOUNTING_DIRECTIONS = ['to_client', 'to_accountant'] as const;
export type AccountingDirection = (typeof ACCOUNTING_DIRECTIONS)[number];
export const ACCOUNTING_KIND_LABEL: Record<AccountingKind, string> = {
  payslip: 'Holerites', thirteenth: '13º salário', vacation_slip: 'Férias', payroll_report: 'Relatórios da folha', vacation: 'Relatório de férias',
  das: 'DAS', darf: 'DARF', dae: 'DAE', state_tax: 'GARE / DARE / GNRE', tax_other: 'Outros impostos',
  office_fee: 'Mensalidade do escritório', fee_other: 'Outros honorários',
  other: 'Outro documento', invoice: 'Notas fiscais', term: 'Termos',
};
export const ACCOUNTING_KIND_HINT: Record<AccountingKind, string> = {
  payslip: 'PDF com os holerites de todos (folha do mês)',
  thirteenth: 'Recibos do 13º salário (1ª e 2ª parcela)',
  vacation_slip: 'Recibos e avisos de férias dos funcionários',
  payroll_report: 'Relatório de férias, relação de cálculo, relação a pagar e outros',
  vacation: 'Períodos aquisitivos abertos de férias dos funcionários',
  das: 'Simples Nacional',
  darf: 'Tributos federais',
  dae: 'eSocial / arrecadação estadual',
  state_tax: 'Guias estaduais (ICMS e outros)',
  tax_other: 'Qualquer outra guia de imposto ou taxa',
  office_fee: 'Boleto ou recibo dos honorários do mês',
  fee_other: 'Serviços avulsos: abertura, alteração, certidões…',
  other: 'Qualquer documento que não se encaixa nos outros',
  invoice: 'Notas de compra, venda ou serviço',
  term: 'Termos assinados (aceite de assinatura eletrônica e outros)',
};

/** Grupos da tela de envio do contador: escolhe o grupo, depois o tipo. Grupo de um tipo só vai direto. */
export const ACCOUNTING_GROUPS = [
  { key: 'payroll', label: 'Folha de pagamento', hint: 'Holerites, 13º, férias e relatórios', kinds: ['payslip', 'thirteenth', 'vacation_slip', 'payroll_report'] },
  { key: 'taxes', label: 'Impostos', hint: 'DAS, DARF, DAE, guias estaduais e outros', kinds: ['das', 'darf', 'dae', 'state_tax', 'tax_other'] },
  { key: 'fees', label: 'Honorários', hint: 'Mensalidade do escritório e outros honorários', kinds: ['office_fee', 'fee_other'] },
  { key: 'other', label: 'Outros documentos', hint: 'O que não se encaixa nos outros grupos', kinds: ['other'] },
] as const satisfies ReadonlyArray<{ key: string; label: string; hint: string; kinds: ReadonlyArray<(typeof ACCOUNTING_KINDS)[number]> }>;
export type AccountingGroupKey = (typeof ACCOUNTING_GROUPS)[number]['key'];
export const accountingGroupOf = (k: AccountingKind): AccountingGroupKey | null =>
  k === 'vacation' ? 'payroll' : ACCOUNTING_GROUPS.find((g) => (g.kinds as readonly string[]).includes(k))?.key ?? null;

/** Tipos da folha: só existem em espaço Empresa, e não viram conta a pagar. */
export const accountingIsPayroll = (k: AccountingKind) => accountingGroupOf(k) === 'payroll';
/** Guias e boletos (impostos e honorários): viram conta a pagar. */
export const accountingIsPayable = (k: AccountingKind) => { const g = accountingGroupOf(k); return g === 'taxes' || g === 'fees' || k === 'invoice'; };
/** PDFs com recibos por funcionário (holerite, 13º, férias): podem ir para a assinatura eletrônica. */
export const accountingIsSlips = (k: AccountingKind) => k === 'payslip' || k === 'thirteenth' || k === 'vacation_slip';

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
  /** Relatório de férias: quantos períodos e a data base. */
  vacations?: number; vacationsBase?: string | null;
}

const refLabel = (r: string) => `${MONTHS_PT_SHORT[Number(r.slice(5, 7)) - 1]}/${r.slice(0, 4)}`;
/** Descrição sugerida para a conta a pagar: "DAS – Out/2026". */
export function accountingBillDescription(kind: AccountingKind, competence: string | null): string {
  const base = kind === 'office_fee' ? 'Honorários contabilidade' : kind === 'state_tax' ? 'Guia estadual' : kind === 'other' || accountingIsPayroll(kind) ? 'Documento do contador' : kind === 'tax_other' ? 'Imposto' : kind === 'fee_other' ? 'Honorários' : ACCOUNTING_KIND_LABEL[kind];
  return competence ? `${base} – ${refLabel(competence)}` : base;
}
