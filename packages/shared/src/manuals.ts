import { z } from 'zod';
import type { Permission } from './permissions.js';

/**
 * Manuais do sistema: PDFs que o administrador da plataforma envia (Plataforma → Manuais) e que cada
 * pessoa abre pelo "?" do cabeçalho. Cada manual diz para quem aparece (`audiences`).
 */
export const MANUAL_MAX_MB = 50;

export const MANUAL_AUDIENCES = [
  { key: 'all', label: 'Todos', hint: 'Qualquer pessoa que entra no sistema' },
  { key: 'accountant', label: 'Contador', hint: 'Quem envia documentos pela área do contador' },
  { key: 'bills', label: 'Contas a pagar e a receber', hint: 'Quem vê as contas do espaço' },
  { key: 'cards', label: 'Cartões', hint: 'Quem vê os cartões' },
  { key: 'bank', label: 'Contas bancárias', hint: 'Quem vê as contas bancárias' },
  { key: 'payroll', label: 'Folha de pagamento', hint: 'Quem vê a folha' },
  { key: 'accounting', label: 'Documentos do contador', hint: 'Quem confere ou envia documentos ao contador' },
  { key: 'admin', label: 'Administradores do espaço', hint: 'Dono e grupos de administração' },
  { key: 'platform', label: 'Administradores da plataforma', hint: 'Só quem administra a plataforma' },
] as const;
export type ManualAudience = (typeof MANUAL_AUDIENCES)[number]['key'];
const KEYS = MANUAL_AUDIENCES.map((a) => a.key) as [ManualAudience, ...ManualAudience[]];
export const manualAudienceLabel = (k: string) => MANUAL_AUDIENCES.find((a) => a.key === k)?.label ?? k;

export interface ManualViewer { can(p: Permission): boolean; isAdmin: boolean; isSuperadmin: boolean }
const MATCH: Record<ManualAudience, (v: ManualViewer) => boolean> = {
  all: () => true,
  accountant: (v) => v.can('accounting.upload') && !v.can('accounting.review') && !v.can('accounting.send'),
  bills: (v) => v.can('payable.view') || v.can('receivable.view'),
  cards: (v) => v.can('cards.view'),
  bank: (v) => v.can('bank.view'),
  payroll: (v) => v.can('payroll.view'),
  accounting: (v) => v.can('accounting.review') || v.can('accounting.send'),
  admin: (v) => v.isAdmin,
  platform: (v) => v.isSuperadmin,
};
/** O manual aparece para a pessoa se ela se encaixa em algum dos públicos marcados. */
export const manualVisible = (audiences: readonly string[], v: ManualViewer) => audiences.some((a) => MATCH[a as ManualAudience]?.(v) ?? false);

export const manualSchema = z.object({
  title: z.string().trim().min(2, 'Dê um título ao manual').max(120),
  description: z.string().trim().max(300).nullish().transform((v) => (v ? v : null)),
  audiences: z.array(z.enum(KEYS)).min(1, 'Marque para quem o manual aparece').max(KEYS.length).transform((a) => [...new Set(a)]),
});
export type ManualInput = z.infer<typeof manualSchema>;

export interface ManualInfo { id: string; title: string; description: string | null; size: number; updatedAt: string }
export interface ManualAdminInfo extends ManualInfo { audiences: ManualAudience[]; originalName: string; updatedByName: string | null }
