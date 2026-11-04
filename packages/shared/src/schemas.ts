import { z } from 'zod';
import { COLOR_KEYS } from './colors.js';
import { ALL_PERMISSIONS, withRequired, type Permission } from './permissions.js';
import { documentError, formatDocument, normalizeDocument } from './document.js';
import { parseMoneyInput } from './money.js';
import { addDaysISO, addMonthsISO, addYearsISO } from './dates.js';

export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data inválida (AAAA-MM-DD)');

/** Valor monetário: aceita número ou string ("1.234,56", "1234.56"); normaliza para "1234.56". */
export const money = z.union([z.string(), z.number()]).transform((v, ctx) => {
  const r = parseMoneyInput(v);
  if (r === null) {
    ctx.addIssue({ code: 'custom', message: 'Valor inválido' });
    return z.NEVER;
  }
  return r;
});
export const positiveMoney = money.refine((v) => !v.startsWith('-') && v !== '0.00', 'Valor deve ser maior que zero');

const optText = (max: number) =>
  z.string().max(max).nullish().transform((v) => (v && v.trim() ? v.trim() : null));

export const BILL_TYPES = ['payable', 'receivable'] as const;
export type BillType = (typeof BILL_TYPES)[number];
export const RECURRENCE_TYPES = ['once', 'weekly', 'biweekly', 'monthly', 'yearly', 'installments'] as const;
export type RecurrenceType = (typeof RECURRENCE_TYPES)[number];
/** Tipos que repetem num intervalo fixo e podem não ter data para acabar. */
export const PERIODIC_TYPES = ['weekly', 'biweekly', 'monthly', 'yearly'] as const satisfies readonly RecurrenceType[];
export type PeriodicType = (typeof PERIODIC_TYPES)[number];
export const isPeriodic = (t: RecurrenceType): t is PeriodicType => (PERIODIC_TYPES as readonly string[]).includes(t);

/**
 * Data da i-ésima ocorrência a partir da base: semanal +7 dias, quinzenal +14, mensal/anual pelo
 * calendário (dia 31 vira o último dia do mês; `preferredDay` preserva o dia original).
 */
export function occurrenceDate(type: RecurrenceType, base: string, i: number, preferredDay?: number): string {
  if (type === 'weekly') return addDaysISO(base, 7 * i);
  if (type === 'biweekly') return addDaysISO(base, 14 * i);
  if (type === 'yearly') return addYearsISO(base, i, preferredDay);
  return addMonthsISO(base, i, preferredDay);
}
/** Máximo de ocorrências numa série com fim (parcelas/meses): 420 = 35 anos (consórcios e financiamentos longos). */
export const MAX_OCCURRENCES = 420;
export const ATTACHMENT_SLOTS = ['boleto', 'invoice', 'payment_proof'] as const;
export type AttachmentSlot = (typeof ATTACHMENT_SLOTS)[number];
export const ATTACHMENT_SLOT_LABEL: Record<AttachmentSlot, string> = {
  boleto: 'Boleto', invoice: 'Nota fiscal', payment_proof: 'Comprovante',
};
export const CATEGORY_KINDS = ['payable', 'receivable', 'both'] as const;

export const PAYMENT_METHODS = [
  'PIX', 'Boleto', 'DDA', 'Débito automático', 'Cartão de crédito', 'Cartão de débito',
  'Transferência', 'Dinheiro', 'Cheque',
] as const;

// ---------------------------------------------------------------- auth
/** Nome de usuário: 3–32 caracteres, letras minúsculas, números, ponto, hífen e sublinhado. */
export const usernameSchema = z.string().trim().toLowerCase()
  .min(3, 'Usuário: mínimo 3 caracteres').max(32, 'Usuário: máximo 32 caracteres')
  .regex(/^[a-z0-9][a-z0-9._-]*$/, 'Usuário: use letras sem acento, números, ponto, hífen ou sublinhado (começando por letra ou número)');

export const loginSchema = z.object({
  /** E-mail ou nome de usuário. */
  login: z.string().trim().toLowerCase().min(1, 'Informe e-mail ou usuário').max(255),
  password: z.string().min(1, 'Informe a senha'),
  totp: z.string().regex(/^\d{6}$/).optional(),
});
/** Perfil do espaço: define as pastas e categorias criadas junto com ele. */
export const orgKindSchema = z.enum(['personal', 'company']);
export type OrgKind = z.infer<typeof orgKindSchema>;
export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8, 'Mínimo 8 caracteres').max(200),
  /** 1º acesso do admin da instalação: perfil do espaço inicial (ver `needsInitialOrg`). */
  initialOrgKind: orgKindSchema.optional(),
  /** Nome do espaço inicial; vazio = `ADMIN_ORG_NAME` do .env. */
  initialOrgName: z.string().trim().max(120).optional()
    .refine((v) => !v || v.length >= 2, 'O nome do espaço precisa ter ao menos 2 caracteres'),
});
export const emailSchema = z.string().trim().toLowerCase().max(255).email('E-mail inválido');
export const profileSchema = z.object({
  name: z.string().trim().min(2).max(120),
  username: usernameSchema.optional(),
  /** Trocar o e-mail exige a senha atual (`currentPassword`). */
  email: emailSchema.optional(),
  currentPassword: z.string().max(200).optional(),
  telegramChatId: optText(64),
  preferences: z.record(z.string(), z.unknown()).optional(),
});

// ---------------------------------------------------------------- org / members / groups
/** CPF ou CNPJ (inclusive alfanumérico); vazio vira null; guardado já formatado. */
export const documentSchema = z.string().max(32).nullish()
  .transform((v) => (v && normalizeDocument(v) ? v : null))
  .superRefine((v, ctx) => { const e = documentError(v); if (e) ctx.addIssue({ code: 'custom', message: e }); })
  .transform((v) => (v ? formatDocument(v) : null));
export const orgCreateSchema = z.object({
  name: z.string().trim().min(2).max(120),
  kind: orgKindSchema.default('company'),
  document: documentSchema.optional(),
});
export const orgUpdateSchema = orgCreateSchema.partial().extend({
  timezone: z.string().max(64).optional(),
});
export const memberAddSchema = z.object({
  email: z.string().trim().toLowerCase().email('E-mail inválido'),
  name: z.string().trim().max(120).optional(),
  /** Para usuário novo; se vazio, é gerado a partir do e-mail. */
  username: usernameSchema.optional().or(z.literal('').transform(() => undefined)),
  password: z.string().min(8, 'Mínimo 8 caracteres').max(200).optional(),
  groupIds: z.array(z.string().uuid()).default([]),
});
export const memberUpdateSchema = z.object({
  groupIds: z.array(z.string().uuid()).optional(),
  active: z.boolean().optional(),
});
export const groupSchema = z.object({
  name: z.string().trim().min(1).max(64),
  description: optText(255),
  isAdmin: z.boolean().default(false),
  permissions: z.array(z.enum(ALL_PERMISSIONS as [string, ...string[]])).default([]).transform((p) => withRequired(p as Permission[])),
});

// ---------------------------------------------------------------- plataforma: usuários
export const platformUserUpdateSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  email: emailSchema.optional(),
  username: usernameSchema.optional(),
  active: z.boolean().optional(),
  isSuperadmin: z.boolean().optional(),
  canCreateOrgs: z.boolean().optional(),
});
export const platformUserCreateSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: emailSchema,
  username: usernameSchema.optional().or(z.literal('').transform(() => undefined)),
  password: z.string().min(8, 'Mínimo 8 caracteres').max(200),
  isSuperadmin: z.boolean().default(false),
  canCreateOrgs: z.boolean().default(false),
});
export const platformResetPasswordSchema = z.object({
  password: z.string().min(8, 'Mínimo 8 caracteres').max(200),
});

// ---------------------------------------------------------------- categories / folders
export const categoryCreateSchema = z.object({
  label: z.string().trim().min(1, 'Informe o nome').max(64),
  color: z.enum(COLOR_KEYS).default('slate'),
  kind: z.enum(CATEGORY_KINDS).default('both'),
  isRestricted: z.boolean().default(false),
});
export const categoryUpdateSchema = categoryCreateSchema.partial();

export const folderCreateSchema = z.object({
  label: z.string().trim().min(1, 'Informe o rótulo').max(32),
  name: z.string().trim().min(1, 'Informe o nome da pasta').max(64)
    .regex(/^[^/\\\x00-\x1f]+$/, 'Não use / \\ ou caracteres de controle'),
  color: z.enum(COLOR_KEYS).default('slate'),
});
export const folderUpdateSchema = folderCreateSchema.partial();

// ---------------------------------------------------------------- bills
export const billCreateSchema = z.object({
  type: z.enum(BILL_TYPES),
  description: z.string().trim().min(1, 'Informe a descrição').max(255),
  categoryId: z.string().uuid('Escolha a categoria'),
  folderId: z.string().uuid().nullish(),
  cardId: z.string().uuid().nullish(),
  amount: positiveMoney.optional(),
  dueDate: isoDate,
  recurrenceType: z.enum(RECURRENCE_TYPES).default('once'),
  isIndefinite: z.boolean().default(false),
  totalOccurrences: z.number().int().min(1).max(MAX_OCCURRENCES).optional(),
  installmentAmounts: z.array(positiveMoney).max(MAX_OCCURRENCES).optional(),
  installmentDueDates: z.array(isoDate).max(MAX_OCCURRENCES).optional(),
  /** Parcelado: número da 1ª parcela lançada (ex.: 42 numa série de 213 em que 41 já foram pagas). */
  firstInstallment: z.number().int().min(1).max(MAX_OCCURRENCES).optional(),
  relatedPerson: optText(128),
  notes: optText(2000),
  barcode: optText(120),
  pixKey: optText(600),
  paymentMethod: optText(64),
  /** Já criar como paga/recebida (útil em importação e lançamentos retroativos). */
  paidAt: isoDate.nullish(),
  paidAmount: money.nullish(),
});
export type BillCreateInput = z.input<typeof billCreateSchema>;

export const billUpdateSchema = z.object({
  description: z.string().trim().min(1).max(255).optional(),
  categoryId: z.string().uuid().optional(),
  folderId: z.string().uuid().nullable().optional(),
  amount: positiveMoney.optional(),
  dueDate: isoDate.optional(),
  relatedPerson: optText(128).optional(),
  notes: optText(2000).optional(),
  barcode: optText(120).optional(),
  pixKey: optText(600).optional(),
  paymentMethod: optText(64).optional(),
  paidAt: isoDate.nullable().optional(),
  paidAmount: money.nullable().optional(),
  status: z.enum(['pending', 'paid']).optional(),
  /** Propaga campos (exceto vencimento) para as ocorrências pendentes futuras da série. */
  cascade: z.boolean().default(false),
});

export const paySchema = z.object({
  paidAt: isoDate.optional(),
  paidAmount: money.optional(),
});
export const bulkPaySchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(500),
  paidAt: isoDate.optional(),
});
export const restructureSchema = z.object({
  recurrenceType: z.enum(RECURRENCE_TYPES),
  dueDate: isoDate,
  amount: positiveMoney.optional(),
  isIndefinite: z.boolean().default(false),
  totalOccurrences: z.number().int().min(1).max(MAX_OCCURRENCES).optional(),
  installmentAmounts: z.array(positiveMoney).max(MAX_OCCURRENCES).optional(),
  installmentDueDates: z.array(isoDate).max(MAX_OCCURRENCES).optional(),
  /** Parcelado: número da 1ª parcela lançada (ex.: 42 numa série de 213 em que 41 já foram pagas). */
  firstInstallment: z.number().int().min(1).max(MAX_OCCURRENCES).optional(),
});
export const deleteModeSchema = z.enum(['one', 'forward', 'series']);

export const billListQuerySchema = z.object({
  type: z.enum(BILL_TYPES),
  year: z.coerce.number().int().min(1900).max(2200).optional(),
  month: z.coerce.number().int().min(1).max(12).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  categoryId: z.string().uuid().optional(),
  folderId: z.union([z.string().uuid(), z.literal('none')]).optional(),
  status: z.enum(['pending', 'paid', 'overdue', 'due_soon']).optional(),
  search: z.string().trim().max(120).optional(),
});

export const exportSchema = z.object({
  type: z.enum(BILL_TYPES),
  year: z.number().int().min(1900).max(2200),
  month: z.number().int().min(1).max(12).nullable().default(null),
  includeSpreadsheet: z.boolean().default(true),
});

/** Sugere um nome de usuário a partir do e-mail (parte antes do @, sem acentos/símbolos). */
export function usernameFromEmail(email: string): string {
  const base = email.split('@')[0].normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '').replace(/^[._-]+/, '').slice(0, 28);
  return base.length >= 3 ? base : `${base}usr`.slice(0, 28);
}
