import { z } from 'zod';
import { phoneSchema } from './payroll.js';

/** Unidades da federação, em ordem alfabética da sigla. */
export const BR_STATES = ['AC', 'AL', 'AM', 'AP', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MG', 'MS', 'MT', 'PA', 'PB', 'PE', 'PI', 'PR', 'RJ', 'RN', 'RO', 'RR', 'RS', 'SC', 'SE', 'SP', 'TO'] as const;

/** CEP com a máscara "00000-000" (aceita só os números). */
export function formatZipBR(v: string): string {
  const d = v.replace(/\D/g, '').slice(0, 8);
  return d.length > 5 ? `${d.slice(0, 5)}-${d.slice(5)}` : d;
}

const opt = (max: number) => z.string().max(max).nullish().transform((v) => (v && v.trim() ? v.trim() : null));

/**
 * Dados cadastrais da empresa (só espaços do perfil Empresa): inscrições, contato e endereço.
 * Todos opcionais; campo ausente no pedido não é alterado.
 */
export const orgDetailsSchema = z.object({
  stateRegistration: opt(32),
  cityRegistration: opt(32),
  phone: phoneSchema,
  whatsapp: phoneSchema,
  email: opt(160).refine((v) => !v || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), 'E-mail inválido').transform((v) => (v ? v.toLowerCase() : null)),
  website: opt(160),
  zipCode: opt(12).refine((v) => !v || v.replace(/\D/g, '').length === 8, 'CEP incompleto: são 8 números').transform((v) => (v ? formatZipBR(v) : null)),
  street: opt(160),
  streetNumber: opt(20),
  complement: opt(80),
  district: opt(80),
  city: opt(80),
  state: z.enum(BR_STATES).nullish().or(z.literal('').transform(() => null)).transform((v) => v ?? null),
}).partial();
export type OrgDetailsInput = z.infer<typeof orgDetailsSchema>;
export const ORG_DETAIL_FIELDS = ['stateRegistration', 'cityRegistration', 'phone', 'whatsapp', 'email', 'website', 'zipCode', 'street', 'streetNumber', 'complement', 'district', 'city', 'state'] as const;

/** O que os documentos mostram da empresa (campos de Dados do espaço; todos opcionais). */
export interface OrgIdentity {
  stateRegistration?: string | null; cityRegistration?: string | null;
  phone?: string | null; whatsapp?: string | null; email?: string | null; website?: string | null;
  zipCode?: string | null; street?: string | null; streetNumber?: string | null; complement?: string | null;
  district?: string | null; city?: string | null; state?: string | null;
}
const filled = (v: string | null | undefined) => (v && v.trim() ? v.trim() : null);

/** "Rua X, 123, Sala 2 - Centro - Cidade/UF - CEP 00000-000" (só o que estiver preenchido). */
export function orgAddressLine(o: OrgIdentity | null | undefined): string | null {
  if (!o) return null;
  const street = [filled(o.street), filled(o.streetNumber), filled(o.complement)].filter(Boolean).join(', ');
  const city = [filled(o.city), filled(o.state)].filter(Boolean).join('/');
  const zip = filled(o.zipCode);
  return [street, filled(o.district), city, zip && `CEP ${zip}`].filter(Boolean).join(' - ') || null;
}
/** "Tel. (43) 3242-0000 · WhatsApp (43) 99999-0000 · contato@empresa.com.br · www.empresa.com.br". */
export function orgContactLine(o: OrgIdentity | null | undefined): string | null {
  if (!o) return null;
  const phone = filled(o.phone), wa = filled(o.whatsapp);
  return [phone && `Tel. ${phone}`, wa && wa !== phone && `WhatsApp ${wa}`, filled(o.email), filled(o.website)].filter(Boolean).join(' · ') || null;
}
/** "IE 123.456 · IM 789". */
export function orgRegistrationsLine(o: OrgIdentity | null | undefined): string | null {
  if (!o) return null;
  const ie = filled(o.stateRegistration), im = filled(o.cityRegistration);
  return [ie && `IE ${ie}`, im && `IM ${im}`].filter(Boolean).join(' · ') || null;
}
