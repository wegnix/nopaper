import { z } from 'zod';

/**
 * Regras de senha de PDF do espaço. Muitas empresas mandam a fatura em PDF protegido, com a senha
 * tirada do CPF/CNPJ de quem recebe (Copel: os 4 primeiros dígitos). Com as regras, o NoPaper abre
 * esses arquivos sozinho ao anexar, lê o conteúdo e guarda a cópia sem senha.
 */
export const PDF_RULE_SOURCES = ['org_document', 'other_document', 'fixed'] as const;
export type PdfRuleSource = (typeof PDF_RULE_SOURCES)[number];
export const PDF_RULE_SOURCE_LABEL: Record<PdfRuleSource, string> = {
  org_document: 'CPF/CNPJ do espaço', other_document: 'Outro CPF/CNPJ', fixed: 'Senha fixa',
};
export const PDF_RULE_PARTS = ['first', 'last', 'all'] as const;
export type PdfRulePart = (typeof PDF_RULE_PARTS)[number];
export const PDF_RULES_MAX = 30;

export const pdfPasswordRuleSchema = z.object({
  /** Vazio = regra nova. */
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1, 'Dê um nome à regra (ex.: Copel)').max(60),
  source: z.enum(PDF_RULE_SOURCES),
  part: z.enum(PDF_RULE_PARTS).default('first'),
  /** Quantos dígitos pegar (primeiros/últimos). */
  length: z.number().int().min(1).max(14).default(4),
  /** Outro CPF/CNPJ ou a senha fixa. Em regra já gravada, vazio = manter o valor atual. */
  value: z.string().max(64).nullish(),
});
export type PdfPasswordRuleInput = z.infer<typeof pdfPasswordRuleSchema>;
export const pdfPasswordsSchema = z.object({ rules: z.array(pdfPasswordRuleSchema).max(PDF_RULES_MAX) });

/** Senha que a regra produz. `value` = o outro documento ou a senha fixa; documentos entram só com os dígitos/letras. */
export function pdfRulePassword(rule: Pick<PdfPasswordRuleInput, 'source' | 'part' | 'length'>, data: { orgDocument?: string | null; value?: string | null }): string | null {
  if (rule.source === 'fixed') return data.value ? data.value : null;
  const doc = (rule.source === 'org_document' ? data.orgDocument : data.value)?.replace(/[^0-9A-Za-z]/g, '') ?? '';
  if (!doc) return null;
  if (rule.part === 'all') return doc;
  if (doc.length < rule.length) return null;
  return rule.part === 'first' ? doc.slice(0, rule.length) : doc.slice(-rule.length);
}

/** "os 4 primeiros dígitos do CPF/CNPJ do espaço". */
export function describePdfRule(rule: Pick<PdfPasswordRuleInput, 'source' | 'part' | 'length'>): string {
  if (rule.source === 'fixed') return 'senha fixa';
  const whose = rule.source === 'org_document' ? 'do CPF/CNPJ do espaço' : 'de outro CPF/CNPJ';
  if (rule.part === 'all') return `todos os dígitos ${whose}`;
  const n = rule.length === 1 ? (rule.part === 'first' ? 'o 1º dígito' : 'o último dígito') : `os ${rule.length} ${rule.part === 'first' ? 'primeiros' : 'últimos'} dígitos`;
  return `${n} ${whose}`;
}
